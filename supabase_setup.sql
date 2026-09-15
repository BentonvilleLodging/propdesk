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
