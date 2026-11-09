-- ROLLBACK of MIGRATION_integrations_2.sql — removes the GOOGLE / EBAY rows (disconnects them), puts the step-1 checks back and drops the
-- four switches. Revoke on the platform side too if access must end for good (myaccount.google.com/permissions; eBay: Account → Permissions).
begin;
delete from public.social_auth where platform in ('GOOGLE','EBAY');
delete from public.social_oauth_states where platform in ('GOOGLE','EBAY');
alter table public.social_auth drop constraint if exists social_auth_platform_check;
alter table public.social_auth add constraint social_auth_platform_check check (platform in ('META','YOUTUBE','TIKTOK'));
alter table public.social_auth drop constraint if exists social_auth_kind_check;
alter table public.social_auth add constraint social_auth_kind_check check (kind in ('META_USER','FB_PAGE','IG_ACCOUNT','YT_CHANNEL','TT_ACCOUNT'));
alter table public.social_oauth_states drop constraint if exists social_oauth_states_platform_check;
alter table public.social_oauth_states add constraint social_oauth_states_platform_check check (platform in ('META','YOUTUBE','TIKTOK'));
delete from public.app_settings where key in ('social.google.enabled','social.ebay.enabled','paypal.read.enabled','carriers.track.enabled');
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('social-link-2', 'social_auth', 'platforms GOOGLE + EBAY, 4 switches', 'migration', 'created', null, 'ROLLBACK_integrations_2.sql');
commit;
