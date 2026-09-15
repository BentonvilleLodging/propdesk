-- ============================================================
-- Day Planner — Property Visit Log
-- Run once in your Supabase SQL editor:
-- https://supabase.com/dashboard/project/wljtpxqdmxszplngdwsc/sql
-- ============================================================

create table if not exists dp_visit_log (
  id               bigint generated always as identity primary key,

  -- Guesty listing identifier (ties visit to a specific property)
  listing_id       text not null,

  -- The checkout date this visit was for (YYYY-MM-DD).
  -- A property is considered "already visited" for a given checkout date
  -- if a row exists here with matching listing_id + checkout_date.
  checkout_date    date not null,

  -- When the property manager tapped "Mark as Visited"
  visited_at       timestamptz not null default now(),

  -- Denormalised for display (no join needed)
  property_name    text,
  property_address text,

  -- Optional: who was checking out / checking in
  out_guest        text,
  in_guest         text,

  -- What kind of stop this was
  visit_type       text check (visit_type in ('turnover','checkin','checkout','no_activity','other'))
);

-- Unique constraint: one visit log entry per listing per checkout date.
-- Re-tapping "Mark as Visited" on the same day is a no-op (upsert).
create unique index if not exists dp_visit_log_unique
  on dp_visit_log (listing_id, checkout_date);

-- RLS — allow the anon/publishable key full access (matches rest of app)
alter table dp_visit_log enable row level security;

create policy "allow_all_dp_visit_log" on dp_visit_log
  for all using (true) with check (true);

-- Index for the common query: "which listings were visited since date X?"
create index if not exists dp_visit_log_listing_date
  on dp_visit_log (listing_id, checkout_date desc);
