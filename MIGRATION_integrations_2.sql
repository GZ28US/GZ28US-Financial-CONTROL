-- SOCIAL LINK — step 2 (09/11/2026, Orlando). Márcio via App Development 2: «do all worth it» → Google Business Profile, Google Calendar,
-- Google Ads + Meta Ads (read), eBay / PayPal orders (read pipeline, the BOOKING stays AutoBook's), UPS / FedEx / USPS tracking.
-- 1) social_auth learns two OAuth platforms: GOOGLE (one consent on gz28us@gmail.com = Business Profile + Calendar + Ads) and EBAY
--    (buyer purchase history). PayPal and the carriers use the APP's own client credentials — no row, env only.
-- 2) four switches, born FALSE (on conflict do nothing never flips his choice). Nothing here writes to any platform.
begin;

alter table public.social_auth drop constraint if exists social_auth_platform_check;
alter table public.social_auth add constraint social_auth_platform_check check (platform in ('META','YOUTUBE','TIKTOK','GOOGLE','EBAY'));
alter table public.social_auth drop constraint if exists social_auth_kind_check;
alter table public.social_auth add constraint social_auth_kind_check check (kind in ('META_USER','FB_PAGE','IG_ACCOUNT','YT_CHANNEL','TT_ACCOUNT','GOOGLE_ACCOUNT','EBAY_USER'));
alter table public.social_oauth_states drop constraint if exists social_oauth_states_platform_check;
alter table public.social_oauth_states add constraint social_oauth_states_platform_check check (platform in ('META','YOUTUBE','TIKTOK','GOOGLE','EBAY'));

insert into public.app_settings (key, value, note, updated_by) values
  ('social.google.enabled',  'false'::jsonb, 'INTEGRATIONS — Google on gz28us@gmail.com: Business Profile (reviews, hours, insights), Calendar, Google Ads — connect + READ only. OFF.', 'migration 09/11/2026'),
  ('social.ebay.enabled',    'false'::jsonb, 'INTEGRATIONS — eBay buyer purchase history (orders, tracking) — connect + READ only; booking stays with AutoBook. OFF.', 'migration 09/11/2026'),
  ('paypal.read.enabled',    'false'::jsonb, 'INTEGRATIONS — PayPal Transaction Search (purchases, refunds) with the app''s own credentials — READ only. OFF.', 'migration 09/11/2026'),
  ('carriers.track.enabled', 'false'::jsonb, 'INTEGRATIONS — UPS / FedEx / USPS tracking with the app''s own credentials — READ only (labels are not built; each label will need Márcio''s OK). OFF.', 'migration 09/11/2026')
on conflict (key) do nothing;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('social-link-2', 'social_auth', 'platforms GOOGLE + EBAY, 4 switches', 'migration', null, 'created (switches false)', 'MIGRATION_integrations_2.sql');
commit;
