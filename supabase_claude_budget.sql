-- Claude API weekly budget (hard cap: 2 Messages API requests per week).
-- Week = Monday 00:00 → Sunday 23:59 America/Chicago.
--
-- Every Claude request made by a Netlify Function must first call
-- claude_budget_reserve() (service key only). The reservation is atomic (advisory lock),
-- so two buttons pressed at once can never both get the last slot.
--
-- Slot policy:
--   • 'weekly'  — the Monday portfolio analysis (cron). Always allowed while slots remain.
--   • 'manual'  — anything a staff member starts (copy rewrite, owner report, re-run).
--                 Until this week's weekly run has happened, one slot is held back for it,
--                 so manual use can never starve the scheduled analysis.
-- A request the API rejects before running the model (HTTP 4xx except 429) is "refunded"
-- because nothing was billed; anything that reached the model counts.

create table if not exists public.claude_api_calls (
  id          bigint generated always as identity primary key,
  week_start  date        not null,
  kind        text        not null check (kind in ('weekly', 'manual')),
  purpose     text        not null,
  status      text        not null default 'reserved' check (status in ('reserved', 'ok', 'error', 'refunded')),
  model       text,
  usage       jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz
);
create index if not exists claude_api_calls_week_idx on public.claude_api_calls (week_start);

alter table public.claude_api_calls enable row level security;
drop policy if exists staff_read_claude_api_calls on public.claude_api_calls;
create policy staff_read_claude_api_calls on public.claude_api_calls for select to authenticated using (public.is_staff());
revoke all on public.claude_api_calls from anon;
revoke insert, update, delete on public.claude_api_calls from authenticated;

create or replace function public.claude_week_start() returns date
language sql stable as $$ select date_trunc('week', now() at time zone 'America/Chicago')::date $$;

create or replace function public.claude_budget_reserve(p_kind text, p_purpose text, p_model text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c_limit   constant int := 2;          -- ← the weekly cap
  ws        date := public.claude_week_start();
  used      int;
  weekly_ok boolean;
  allowed   int;
  new_id    bigint;
begin
  perform pg_advisory_xact_lock(hashtext('claude_api_budget'));
  select count(*) into used from claude_api_calls where week_start = ws and status <> 'refunded';
  select exists(select 1 from claude_api_calls where week_start = ws and kind = 'weekly' and status <> 'refunded') into weekly_ok;
  allowed := case when p_kind = 'manual' and not weekly_ok then c_limit - 1 else c_limit end;
  if used >= allowed then
    return jsonb_build_object('ok', false, 'used', used, 'limit', c_limit, 'week_start', ws,
      'reason', case when used >= c_limit then 'Weekly Claude limit reached (' || c_limit || ' calls). Resets Monday.'
                     else 'The last Claude call this week is held for the Monday analysis.' end);
  end if;
  insert into claude_api_calls (week_start, kind, purpose, model) values (ws, p_kind, p_purpose, p_model) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'used', used + 1, 'limit', c_limit, 'week_start', ws);
end $$;

create or replace function public.claude_budget_settle(p_id bigint, p_status text, p_usage jsonb default null, p_error text default null)
returns void
language sql security definer set search_path = public as $$
  update claude_api_calls set status = p_status, usage = coalesce(p_usage, usage), error = left(p_error, 500), settled_at = now() where id = p_id;
$$;

-- Read-only status for the PropDesk UI (staff only).
create or replace function public.claude_budget_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c_limit   constant int := 2;
  ws        date := public.claude_week_start();
  used      int;
  weekly_ok boolean;
begin
  if not public.is_staff() then return null; end if;
  select count(*) into used from claude_api_calls where week_start = ws and status <> 'refunded';
  select exists(select 1 from claude_api_calls where week_start = ws and kind = 'weekly' and status <> 'refunded') into weekly_ok;
  return jsonb_build_object(
    'limit', c_limit, 'used', used, 'remaining', greatest(c_limit - used, 0),
    'weekly_done', weekly_ok,
    'manual_available', used < (case when weekly_ok then c_limit else c_limit - 1 end),
    'week_start', ws, 'resets', ws + 7,
    'calls', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'purpose', purpose, 'status', status, 'at', created_at) order by created_at)
                       from claude_api_calls where week_start = ws and status <> 'refunded'), '[]'::jsonb));
end $$;

revoke all on function public.claude_budget_reserve(text, text, text) from public, anon, authenticated;
revoke all on function public.claude_budget_settle(bigint, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.claude_budget_status() from public, anon;
grant execute on function public.claude_budget_status() to authenticated;
