-- PropDesk Search Health AGENT (Mon + Thu).
--
-- Each run = deterministic triage (no Claude) + ONE Claude request that investigates the
-- flagged listings and proposes date-specific PRICE / MIN-STAY changes.
--   • Listings tagged "Black Cabins" in Guesty → applied to PriceLabs automatically (undoable).
--   • Every other listing → pricing_proposals 'pending' until a person approves.
-- Both weekly Claude slots are reserved for the two scheduled runs.

create table if not exists public.agent_runs (
  id            bigint generated always as identity primary key,
  kind          text not null default 'scheduled',        -- scheduled | manual
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  status        text not null default 'running' check (status in ('running', 'done', 'failed')),
  flagged       jsonb not null default '[]'::jsonb,      -- [{listing_id, name, auto, flags[]}]
  summary       text,                                   -- Claude's portfolio summary for this run
  applied       jsonb not null default '[]'::jsonb,      -- [{listing_id, name, edit_id, changes[]}]
  pending       jsonb not null default '[]'::jsonb,      -- [{listing_id, name, proposal_ids[], changes[]}]
  rejected      jsonb not null default '[]'::jsonb,      -- actions the guardrails refused, with reason
  recommendations jsonb not null default '[]'::jsonb,    -- [{listing_id, name, summary, top_actions[]}]
  usage         jsonb,
  error         text
);
create index if not exists agent_runs_started_idx on public.agent_runs (started_at desc);

alter table public.pricing_proposals  add column if not exists source text not null default 'autopilot';
alter table public.pricing_proposals  add column if not exists agent_run_id bigint;
alter table public.autopilot_overrides add column if not exists source text not null default 'autopilot';

alter table public.agent_runs enable row level security;
drop policy if exists staff_read_agent_runs on public.agent_runs;
create policy staff_read_agent_runs on public.agent_runs for select to authenticated using (public.is_staff());
revoke insert, update, delete on public.agent_runs from authenticated;
revoke all on public.agent_runs from anon;

-- ── Budget: hold both weekly slots for the Mon + Thu runs ──────────────────
create or replace function public.claude_budget_reserve(p_kind text, p_purpose text, p_model text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c_limit     constant int := 2;   -- ← the weekly cap
  c_scheduled constant int := 2;   -- ← scheduled runs per week (Mon + Thu)
  ws          date := public.claude_week_start();
  used        int;
  sched_used  int;
  allowed     int;
  new_id      bigint;
begin
  perform pg_advisory_xact_lock(hashtext('claude_api_budget'));
  select count(*) into used from claude_api_calls where week_start = ws and status <> 'refunded';
  select count(*) into sched_used from claude_api_calls where week_start = ws and kind = 'weekly' and status <> 'refunded';
  allowed := case when p_kind = 'weekly' then c_limit
                  else c_limit - greatest(c_scheduled - sched_used, 0) end;
  if used >= allowed or (p_kind = 'weekly' and sched_used >= c_scheduled) then
    return jsonb_build_object('ok', false, 'used', used, 'limit', c_limit, 'week_start', ws,
      'reason', case when used >= c_limit then 'Weekly Claude limit reached (' || c_limit || ' calls). Resets Monday.'
                     else 'Both weekly Claude calls are held for the Monday and Thursday agent runs.' end);
  end if;
  insert into claude_api_calls (week_start, kind, purpose, model) values (ws, p_kind, p_purpose, p_model) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'used', used + 1, 'limit', c_limit, 'week_start', ws);
end $$;

create or replace function public.claude_budget_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c_limit     constant int := 2;
  c_scheduled constant int := 2;
  ws          date := public.claude_week_start();
  used        int;
  sched_used  int;
begin
  if not public.is_staff() then return null; end if;
  select count(*) into used from claude_api_calls where week_start = ws and status <> 'refunded';
  select count(*) into sched_used from claude_api_calls where week_start = ws and kind = 'weekly' and status <> 'refunded';
  return jsonb_build_object(
    'limit', c_limit, 'used', used, 'remaining', greatest(c_limit - used, 0),
    'scheduled', c_scheduled, 'scheduled_done', sched_used, 'weekly_done', sched_used >= c_scheduled,
    'manual_available', used < c_limit - greatest(c_scheduled - sched_used, 0),
    'week_start', ws, 'resets', ws + 7,
    'calls', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'purpose', purpose, 'status', status, 'at', created_at) order by created_at)
                       from claude_api_calls where week_start = ws and status <> 'refunded'), '[]'::jsonb));
end $$;

revoke all on function public.claude_budget_reserve(text, text, text) from public, anon, authenticated;
revoke all on function public.claude_budget_status() from public, anon;
grant execute on function public.claude_budget_status() to authenticated;
