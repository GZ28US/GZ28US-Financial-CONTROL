-- ROLLBACK of MIGRATION_social_auth.sql — drops the two tables and the four switches. The rows are encrypted OAuth tokens: after the
-- drop the accounts are simply disconnected (reconnecting = pressing CONNECT again at /ca/social/connect). Revoke on the platform side
-- too if the goal is to cut access for good (Meta: Business Integrations; Google: myaccount.google.com/permissions; TikTok: Manage apps).
begin;
drop table if exists public.social_oauth_states;
drop table if exists public.social_auth;
delete from public.app_settings where key in ('social.meta.enabled','social.youtube.enabled','social.tiktok.enabled','social.publish.enabled');
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('social-link-1', 'social_auth', 'tables social_auth + social_oauth_states + 4 switches', 'migration', 'created', null, 'ROLLBACK_social_auth.sql');
commit;
