-- PropDesk — Nov 2026: per-listing minimum-stay policy for the pricing autopilot + AI agent
--   listing_registry.min_stay_policy (jsonb), e.g. 69 Rath:
--     { "fixed": { "fri": 2, "sat": 2 }, "flex": { "days": ["mon","tue","wed"], "min": 1 } }
--   Fixed nights are ALWAYS that minimum; flex nights may drop to `min` to fill the week
--   (see netlify/lib/autopilot-rules.js → normalizeMsPolicy). Admin-only, like the opt-in.
alter table public.listing_registry add column if not exists min_stay_policy jsonb;

create or replace function private.guard_autopilot_columns() returns trigger language plpgsql as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and (new.autopilot_opt_in is distinct from old.autopilot_opt_in or new.autopilot_profile is distinct from old.autopilot_profile
          or new.autopilot_opt_in_at is distinct from old.autopilot_opt_in_at or new.autopilot_opt_in_note is distinct from old.autopilot_opt_in_note
          or new.min_stay_policy is distinct from old.min_stay_policy) then
    raise exception 'Autopilot settings can only be changed by an admin';
  end if;
  return new;
end $$;

-- 69 Rath (Highlands Lakeside Retreat, 5 BR / sleeps 12): Fri & Sat always 2 nights; Mon–Wed may drop to 1.
update public.listing_registry
   set min_stay_policy = '{"fixed":{"fri":2,"sat":2},"flex":{"days":["mon","tue","wed"],"min":1}}'::jsonb,
       autopilot_profile = 'large_home'
 where listing_id = '688930de3bc0a600106c9db1';

-- Autopilot opt-in for 69 Rath — run ONLY once the owner has confirmed (owner-managed listing):
-- update public.listing_registry
--    set autopilot_opt_in = true, autopilot_opt_in_at = now(), auto_apply = true,
--        autopilot_opt_in_note = 'Owner opted in Nov 2026: automatic date price + min-stay changes. Large-home profile (5 BR / sleeps 12). Min stay: Fri & Sat always 2, Mon–Wed down to 1.'
--  where listing_id = '688930de3bc0a600106c9db1';
