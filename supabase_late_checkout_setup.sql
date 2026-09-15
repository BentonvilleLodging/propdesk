-- Run this once in your Supabase SQL editor
-- https://supabase.com/dashboard/project/wljtpxqdmxszplngdwsc/sql

create table if not exists app_cache (
  key        text primary key,
  value      text not null,
  expires_at timestamptz not null,
  updated_at timestamptz default now()
);

-- Allow the anon/public role to read and upsert (the function uses the anon key)
alter table app_cache enable row level security;

create policy "allow_all_app_cache" on app_cache
  for all using (true) with check (true);

-- ============================================================
-- Approved Late Checkouts table
-- Run this in your Supabase SQL editor:
-- https://supabase.com/dashboard/project/wljtpxqdmxszplngdwsc/sql
-- ============================================================

create table if not exists approved_late_checkouts (
  id                     bigint generated always as identity primary key,
  property_name          text not null,
  checkout_date          date not null,
  approved_checkout_time time not null,
  time_display           text,          -- human-readable e.g. "11:00 AM"
  notes                  text,
  acknowledged           boolean not null default false,
  created_at             timestamptz default now()
);

-- Enable RLS and allow public read/write (matches cleaner_notes pattern)
alter table approved_late_checkouts enable row level security;

create policy "allow_all_approved_late_checkouts" on approved_late_checkouts
  for all using (true) with check (true);

-- Optional: enable realtime replication for the fast-path listener
-- alter publication supabase_realtime add table approved_late_checkouts;
