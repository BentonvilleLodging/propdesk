-- PropDesk RLS lockdown: only signed-in team members (public.team_members) can access data.
-- staff  = full access to everything
-- cleaner = cleaning-team view only (property cards, late checkouts, cleaned log, cleaner notes)
-- Netlify Functions use SUPABASE_SERVICE_KEY (bypasses RLS).

-- Staff-only tables: convert existing allow-all policies
alter policy allow_all_airbnb_insights_import on public.airbnb_insights_import to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_airbnb_performance_import on public.airbnb_performance_import to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_calendar_gap_snapshots on public.calendar_gap_snapshots to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy open on public.contract_charges to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_daily_recommendations on public.daily_recommendations to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_dp_visit_log on public.dp_visit_log to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_employees on public.employees to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_events on public.events to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_guesty_review_snapshots on public.guesty_review_snapshots to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_listing_completeness_snapshots on public.listing_completeness_snapshots to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_pricelabs_daily on public.pricelabs_daily to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy open on public.prop_charges to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy open on public.properties to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_push_subscriptions on public.push_subscriptions to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_recommendation_completions on public.recommendation_completions to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_recurring_invoices on public.recurring_invoices to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_time_entries on public.time_entries to authenticated using (public.is_staff()) with check (public.is_staff());
alter policy allow_all_todos on public.todos to authenticated using (public.is_staff()) with check (public.is_staff());

-- app_cache: staff can read run-status keys, never the Guesty API tokens
alter policy allow_all_app_cache on public.app_cache to authenticated
  using (public.is_staff() and key not like 'guesty%') with check (public.is_staff() and key not like 'guesty%');

-- Shared staff + cleaning team tables
alter policy allow_all_property_cards on public.property_cards to authenticated using (public.is_staff()) with check (public.is_staff());
create policy team_read_property_cards on public.property_cards for select to authenticated using (public.is_team());

alter policy allow_all_approved_late_checkouts on public.approved_late_checkouts to authenticated using (public.is_staff()) with check (public.is_staff());
create policy team_read_late_checkouts on public.approved_late_checkouts for select to authenticated using (public.is_team());
create policy team_update_late_checkouts on public.approved_late_checkouts for update to authenticated using (public.is_team()) with check (public.is_team());

alter policy allow_all_cleaned_log on public.cleaned_log to authenticated using (public.is_staff()) with check (public.is_staff());
create policy team_read_cleaned_log on public.cleaned_log for select to authenticated using (public.is_team());
create policy team_insert_cleaned_log on public.cleaned_log for insert to authenticated with check (public.is_team());

alter policy allow_all_cleaner_notes on public.cleaner_notes to authenticated using (public.is_staff()) with check (public.is_staff());
create policy team_read_cleaner_notes on public.cleaner_notes for select to authenticated using (public.is_team());
create policy team_insert_cleaner_notes on public.cleaner_notes for insert to authenticated with check (public.is_team());

-- Legacy credential table: no client access at all
alter policy "allow public read" on public.staff_credentials to authenticated using (false);
alter policy "allow all" on public.staff_credentials to authenticated using (false) with check (false);

-- Recap pipeline tables: staff read-only (writes via service key / ingest RPC)
create policy staff_read_booking_reservations on public.booking_reservations for select to authenticated using (public.is_staff());
create policy staff_read_web_traffic on public.web_traffic_daily for select to authenticated using (public.is_staff());
create policy staff_read_fee_config on public.listing_fee_config for select to authenticated using (public.is_staff());
create policy staff_update_fee_config on public.listing_fee_config for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_read_daily_recaps on public.daily_recaps for select to authenticated using (public.is_staff());

-- Belt and braces: the anon role gets no table privileges at all
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
