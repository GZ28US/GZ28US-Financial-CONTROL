-- SOCIAL LINK — step 1 (09/11/2026, Orlando). Márcio, 08/11: «i want to link deeply all the apps we need to link, all of them,
-- I want Claude and the app to have deep access to them all» → YouTube, Instagram, Facebook, TikTok, Meta Business Suite.
-- Same shape as stream_mail_auth (one row per connected account) with three differences learned the hard way there:
--   • tokens are stored ENCRYPTED by the app (AES-256-GCM, key SOCIAL_TOKEN_KEY in Vercel env only) — the column never holds
--     a usable token on its own;
--   • the OAuth state lives in its own short-lived table (single use, 30 min), never in the token row;
--   • every platform is born behind its own switch, FALSE. A missing row is OFF. `on conflict do nothing` never flips his choice.
-- Server only: RLS ON with NO policy (anon/authenticated read nothing); authenticated gets the bare SELECT grant the roda-sql
-- brake asks for, which the absent policy turns into zero rows; service_role does the work.
begin;

insert into public.app_settings (key, value, note, updated_by) values
  ('social.meta.enabled',    'false'::jsonb, 'SOCIAL LINK — Facebook Page + Instagram + Messenger/IG DMs + Business Suite assets (Meta Graph API): the connect button and the read routes. OFF.', 'migration 09/11/2026'),
  ('social.youtube.enabled', 'false'::jsonb, 'SOCIAL LINK — YouTube channel @gz28us (YouTube Data API v3 + Analytics): the connect button and the read routes. OFF.', 'migration 09/11/2026'),
  ('social.tiktok.enabled',  'false'::jsonb, 'SOCIAL LINK — TikTok @gz28.v8.speedshop (Login Kit + Display + Content Posting): the connect button and the read routes. OFF.', 'migration 09/11/2026'),
  ('social.publish.enabled', 'false'::jsonb, 'SOCIAL LINK — any WRITE to a social account (post, reply, DM). Even ON, every write still needs Márcio''s order. OFF.', 'migration 09/11/2026')
on conflict (key) do nothing;

create table if not exists public.social_auth (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('META','YOUTUBE','TIKTOK')),
  kind text not null check (kind in ('META_USER','FB_PAGE','IG_ACCOUNT','YT_CHANNEL','TT_ACCOUNT')),
  external_id text not null,
  account text,                                  -- handle / name, for people
  access_token_enc text,                         -- 'v1:<iv>.<tag>.<ct>' (lib/socialCrypto.server.ts)
  refresh_token_enc text,
  access_expires_at timestamptz,                 -- null = does not expire (Meta page token)
  refresh_expires_at timestamptz,
  scopes text[] not null default '{}',
  parent_id bigint references public.social_auth(id) on delete set null,   -- IG account → the FB page whose token it uses
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'CONNECTED' check (status in ('CONNECTED','EXPIRED','REVOKED','ERROR')),
  last_error text,
  last_ok_at timestamptz,
  last_refresh_at timestamptz,
  connected_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, kind, external_id)
);
alter table public.social_auth enable row level security;
revoke all on public.social_auth from public, anon, authenticated;
grant select on public.social_auth to authenticated;                          -- no policy → reads nothing (roda-sql brake)
grant select, insert, update, delete on public.social_auth to service_role;

create table if not exists public.social_oauth_states (
  state text primary key check (length(state) >= 32),
  platform text not null check (platform in ('META','YOUTUBE','TIKTOK')),
  pkce_verifier text,
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
alter table public.social_oauth_states enable row level security;
revoke all on public.social_oauth_states from public, anon, authenticated;
grant select on public.social_oauth_states to authenticated;                  -- no policy → reads nothing (roda-sql brake)
grant select, insert, update, delete on public.social_oauth_states to service_role;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('social-link-1', 'social_auth', 'tables social_auth + social_oauth_states + 4 switches', 'migration', null, 'created (switches false)', 'MIGRATION_social_auth.sql');
commit;
