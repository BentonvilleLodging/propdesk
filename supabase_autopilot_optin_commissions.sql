-- PropDesk — Nov 2026
--   1. Autopilot owner opt-ins (Lakeside Hideaway) + per-listing pricing profile
--   2. Commission % from the property's package: Essentials 15%, Full Set 25% of the accommodation fare
--   3. Removed listings (Old Campbell Cove): archived, deleted, and blocked from re-syncing

-- ── 1. Autopilot opt-in ─────────────────────────────────────────────────
-- Auto-apply = Guesty "Black Cabins" tag OR autopilot_opt_in here. Only the server (service role)
-- or a migration may opt a listing in; staff sessions cannot flip it from the browser.
alter table public.listing_registry add column if not exists autopilot_opt_in      boolean not null default false;
alter table public.listing_registry add column if not exists autopilot_opt_in_at   timestamptz;
alter table public.listing_registry add column if not exists autopilot_opt_in_note text;
alter table public.listing_registry add column if not exists autopilot_profile     text not null default 'standard';
do $$ begin
  alter table public.listing_registry add constraint listing_registry_autopilot_profile_chk check (autopilot_profile in ('standard', 'large_home'));
exception when duplicate_object then null; end $$;

create or replace function private.guard_autopilot_columns() returns trigger language plpgsql as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and (new.autopilot_opt_in is distinct from old.autopilot_opt_in or new.autopilot_profile is distinct from old.autopilot_profile
          or new.autopilot_opt_in_at is distinct from old.autopilot_opt_in_at or new.autopilot_opt_in_note is distinct from old.autopilot_opt_in_note) then
    raise exception 'Autopilot opt-in can only be changed by an admin';
  end if;
  return new;
end $$;
drop trigger if exists guard_autopilot_columns on public.listing_registry;
create trigger guard_autopilot_columns before update on public.listing_registry for each row execute function private.guard_autopilot_columns();

update public.listing_registry
   set autopilot_opt_in = true, autopilot_opt_in_at = now(), autopilot_profile = 'large_home', auto_apply = true,
       autopilot_opt_in_note = 'Owner opted in Nov 2026: automatic date price + min-stay changes like the Black Cabins. Large-home profile (3 BR / sleeps 8, Beaver Lake).'
 where nickname = 'Lakeside Hideaway';

-- ── 2. Package-based commissions ────────────────────────────────────────
create table if not exists public.management_packages (
  package          text primary key,                 -- matches properties.business_model
  commission_pct   numeric not null check (commission_pct > 0 and commission_pct < 1),
  commission_basis text not null default 'accommodation_fare',
  updated_at       timestamptz not null default now()
);
insert into public.management_packages (package, commission_pct) values ('Essentials', 0.15), ('Full Set', 0.25)
on conflict (package) do update set commission_pct = excluded.commission_pct, updated_at = now();
alter table public.management_packages enable row level security;
drop policy if exists staff_read_management_packages on public.management_packages;
create policy staff_read_management_packages on public.management_packages for select to authenticated using (public.is_staff());
revoke insert, update, delete, truncate on public.management_packages from authenticated, anon;

alter table public.listing_fee_config add column if not exists package text;

-- Property for a Guesty listing: linked by listing_id, else an exact name match with an unlinked property.
create or replace function private.package_for_listing(p_listing_id text, p_nickname text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select business_model from properties where listing_id = p_listing_id and business_model is not null limit 1),
    (select business_model from properties where listing_id is null and business_model is not null
        and lower(btrim(name)) = lower(btrim(p_nickname)) limit 1));
$$;

-- Recompute every listing's commission % from its package. Listings with no package keep their
-- current % and stay fee_confirmed = false (the daily recap flags them).
create or replace function public.refresh_package_commissions() returns integer
language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  update listing_fee_config f
     set package = x.pkg, mgmt_fee_pct = mp.commission_pct, fee_confirmed = true,
         notes = format('%s package: %s%% of accommodation fare', x.pkg, round(mp.commission_pct * 100)), updated_at = now()
    from (select listing_id, private.package_for_listing(listing_id, listing_nickname) pkg from listing_fee_config) x
    join management_packages mp on mp.package = x.pkg
   where f.listing_id = x.listing_id
     and (f.package is distinct from x.pkg or f.mgmt_fee_pct is distinct from mp.commission_pct or f.fee_confirmed is distinct from true);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.refresh_package_commissions() from public, anon, authenticated;

create or replace function private.trg_refresh_package_commissions() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin perform public.refresh_package_commissions(); return null; end $$;

drop trigger if exists refresh_commissions_on_properties on public.properties;
create trigger refresh_commissions_on_properties after insert or update of business_model, listing_id, name or delete on public.properties
  for each statement execute function private.trg_refresh_package_commissions();
drop trigger if exists refresh_commissions_on_packages on public.management_packages;
create trigger refresh_commissions_on_packages after insert or update or delete on public.management_packages
  for each statement execute function private.trg_refresh_package_commissions();
drop trigger if exists refresh_commissions_on_fee_insert on public.listing_fee_config;
create trigger refresh_commissions_on_fee_insert after insert on public.listing_fee_config
  for each statement execute function private.trg_refresh_package_commissions();

-- Commission base = nightly accommodation fare (after discounts; excludes cleaning, taxes, guest
-- fees; channel fees NOT deducted). Re-base existing reservations to match the sync.
update public.booking_reservations set commissionable_rev = round(fare_accommodation, 2)
 where fare_accommodation is not null and commissionable_rev is distinct from round(fare_accommodation, 2);

select public.refresh_package_commissions();

-- Per-reservation commission for reporting (staff-only via the base tables' RLS).
create or replace view public.reservation_commissions with (security_invoker = true) as
select b.reservation_id, b.listing_id, b.listing_nickname, b.status, b.source, b.created_at_guesty, b.check_in, b.check_out, b.nights,
       b.fare_accommodation, b.commissionable_rev, f.package, f.mgmt_fee_pct, f.fee_confirmed,
       round(b.commissionable_rev * f.mgmt_fee_pct, 2) as commission
  from public.booking_reservations b
  left join public.listing_fee_config f on f.listing_id = b.listing_id;
revoke all on public.reservation_commissions from anon;

-- ── 3. Removed listings ─────────────────────────────────────────────────
create table if not exists public.removed_listings (
  listing_id text primary key,
  nickname   text,
  reason     text,
  removed_at timestamptz not null default now()
);
alter table public.removed_listings enable row level security;
drop policy if exists staff_read_removed_listings on public.removed_listings;
create policy staff_read_removed_listings on public.removed_listings for select to authenticated using (public.is_staff());
revoke insert, update, delete, truncate on public.removed_listings from authenticated, anon;

-- Rows are archived here (not readable from the app) before they are deleted, so a removal can be undone.
create table if not exists private.removed_listing_archive (
  id          bigint generated always as identity primary key,
  listing_id  text not null,
  table_name  text not null,
  row_data    jsonb not null,
  archived_at timestamptz not null default now()
);

create or replace function private.remove_listing(p_listing_id text, p_nickname text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t text; n int; out jsonb := '{}'::jsonb;
begin
  insert into removed_listings (listing_id, nickname, reason) values (p_listing_id, p_nickname, p_reason)
  on conflict (listing_id) do update set reason = excluded.reason;
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'listing_id' and tb.table_type = 'BASE TABLE' and c.table_name <> 'removed_listings'
  loop
    execute format('insert into private.removed_listing_archive (listing_id, table_name, row_data) select $1, %L, to_jsonb(x) from public.%I x where x.listing_id::text = $1', t, t) using p_listing_id;
    execute format('delete from public.%I where listing_id::text = $1', t) using p_listing_id;
    get diagnostics n = row_count;
    if n > 0 then out := out || jsonb_build_object(t, n); end if;
  end loop;
  return out;
end $$;
revoke all on function private.remove_listing(text, text, text) from public, anon, authenticated;

select private.remove_listing(listing_id, nickname, 'No longer managed by BLC (Nov 2026)')
  from public.listing_registry where nickname = 'OldCampbellCove';
