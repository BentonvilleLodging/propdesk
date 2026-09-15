-- Run in Supabase SQL Editor
-- https://supabase.com/dashboard/project/wljtpxqdmxszplngdwsc/sql

create table if not exists push_subscriptions (
  id          bigserial primary key,
  endpoint    text not null unique,
  keys_p256dh text not null,
  keys_auth   text not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table push_subscriptions enable row level security;

create policy "allow_all_push_subscriptions" on push_subscriptions
  for all using (true) with check (true);

-- Index for fast upsert lookups
create index if not exists push_subscriptions_endpoint_idx on push_subscriptions (endpoint);
