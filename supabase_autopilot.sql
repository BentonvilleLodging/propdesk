-- PropDesk pricing / min-stay autopilot.
--
-- RULE: only date-specific PRICE and MINIMUM-STAY changes are ever made automatically, and
-- only for listings carrying the "Black Cabins" tag in Guesty (auto_apply = true). Every
-- other listing's proposals wait as 'pending' until a staff member approves them.

alter table public.listing_registry add column if not exists guesty_tags text[];
alter table public.listing_registry add column if not exists auto_apply boolean not null default false;

create table if not exists public.pricing_proposals (
  id                 bigint generated always as identity primary key,
  listing_id         text not null,
  stay_date          date not null,
  run_date           date not null,
  kind               text not null check (kind in ('set', 'remove')),   -- set = add/update override, remove = take ours off
  original_price     numeric,          -- price before any autopilot override (drop cap is measured from here)
  current_price      numeric,          -- price on the calendar at proposal time
  proposed_price     numeric,          -- null = leave price alone
  current_min_stay   integer,
  proposed_min_stay  integer,          -- null = leave min stay alone
  reasons            jsonb not null default '[]'::jsonb,
  evidence           jsonb,
  auto               boolean not null default false,
  status             text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'superseded', 'expired', 'failed', 'reverted')),
  decided_by         text,
  decided_at         timestamptz,
  applied_at         timestamptz,
  edit_id            bigint,
  error              text,
  created_at         timestamptz not null default now()
);
create index if not exists pricing_proposals_status_idx on public.pricing_proposals (status, listing_id, stay_date);

-- Which dates currently carry an override that the autopilot put there (so it never touches
-- overrides the team set by hand, and so drops are measured from the original price).
create table if not exists public.autopilot_overrides (
  listing_id      text not null,
  stay_date       date not null,
  original_price  numeric,
  price           numeric,
  min_stay        integer,
  proposal_id     bigint,
  active          boolean not null default true,
  outcome         text,                -- booked | unbooked (filled after the date passes)
  updated_at      timestamptz not null default now(),
  primary key (listing_id, stay_date)
);

create table if not exists public.autopilot_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  summary      jsonb,
  error        text
);

alter table public.pricing_proposals  enable row level security;
alter table public.autopilot_overrides enable row level security;
alter table public.autopilot_runs     enable row level security;
drop policy if exists staff_read_pricing_proposals on public.pricing_proposals;
drop policy if exists staff_read_autopilot_overrides on public.autopilot_overrides;
drop policy if exists staff_read_autopilot_runs on public.autopilot_runs;
create policy staff_read_pricing_proposals  on public.pricing_proposals  for select to authenticated using (public.is_staff());
create policy staff_read_autopilot_overrides on public.autopilot_overrides for select to authenticated using (public.is_staff());
create policy staff_read_autopilot_runs     on public.autopilot_runs     for select to authenticated using (public.is_staff());
-- Approvals go through the pricing-approvals Netlify Function (it pushes to PriceLabs), never direct writes.
revoke insert, update, delete on public.pricing_proposals, public.autopilot_overrides, public.autopilot_runs from authenticated;
revoke all on public.pricing_proposals, public.autopilot_overrides, public.autopilot_runs from anon;
