-- APP VIEWER = READ-ONLY USER (10/11/2026, Márcio via Processos & Legais 2 — Drummond Advisors, fechamento contábil 2025).
-- «ele pode entrar em absolutamente todas as telas, inclusive nas de edição, mas não consegue editar nada».
--
-- The block lives in the DATABASE, not in the buttons: the screens write straight to Supabase with the user's JWT, so
-- every public table gets RESTRICTIVE policies (they AND with the existing permissive ones) that refuse INSERT / UPDATE /
-- DELETE to a viewer, and refuse even SELECT to a blocked viewer. Same for storage.objects (uploads, overwrites, deletes).
-- Who is a viewer = a row in app_viewers (by e-mail). Revoke = blocked_at set; the account can no longer read anything.
-- The API gate (lib/auth.server requireUser/requireStaff) reads the same table and refuses every non-GET for a viewer.
-- Accounts are created by the invited person on /ca/join/<token> (one invite per e-mail, single use, 7 days; no/bad token = 404).
-- The server route inserts the viewer row
-- BEFORE creating the auth user — there is no instant in which that account has full access.

create table if not exists public.app_viewers (
  email       text primary key check (email = lower(email)),
  label       text,
  invite_id   uuid,
  user_id     uuid,
  created_at  timestamptz not null default now(),
  blocked_at  timestamptz,
  last_seen_at timestamptz
);
alter table public.app_viewers enable row level security;

create table if not exists public.app_viewer_invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  label       text not null,
  email       text not null check (email = lower(email)),   -- ONE invite per person: the account can only be created with this e-mail
  max_uses    int  not null default 1,
  uses        int  not null default 0,
  expires_at  timestamptz not null default now() + interval '7 days',
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.app_viewer_invites enable row level security;
-- no permissive policy and no grant to anon/authenticated: only the service role (server) reads/writes them.
-- grants as the runner requires (30/10 rule); RLS with NO permissive policy keeps anon/authenticated at zero rows anyway
grant select on public.app_viewers to anon;
grant select, insert, update, delete on public.app_viewers to authenticated;
grant select on public.app_viewer_invites to anon;
grant select, insert, update, delete on public.app_viewer_invites to authenticated;
grant select, insert, update, delete on public.app_viewers to service_role;
grant select, insert, update, delete on public.app_viewer_invites to service_role;

create or replace function public.is_app_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_viewers v where v.email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
create or replace function public.is_blocked_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_viewers v where v.email = lower(coalesce(auth.jwt() ->> 'email', '')) and v.blocked_at is not null)
$$;
-- what the screen asks after login: 'viewer' | 'blocked' | null
create or replace function public.my_app_role() returns text
language sql stable security definer set search_path = public as $$
  select case when v.blocked_at is not null then 'blocked' else 'viewer' end
  from public.app_viewers v where v.email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;
revoke all on function public.is_app_viewer(), public.is_blocked_viewer(), public.my_app_role() from public, anon;
grant execute on function public.is_app_viewer(), public.is_blocked_viewer(), public.my_app_role() to authenticated;

-- the guard, applied to one table (also used for every table created later: see the event trigger below)
create or replace function public.apply_viewer_guard(t text) returns void
language plpgsql security definer set search_path = public as $$
begin
  execute format('drop policy if exists viewer_no_read on public.%I', t);
  execute format('drop policy if exists viewer_no_insert on public.%I', t);
  execute format('drop policy if exists viewer_no_update on public.%I', t);
  execute format('drop policy if exists viewer_no_delete on public.%I', t);
  execute format('create policy viewer_no_read on public.%I as restrictive for select to authenticated using (not public.is_blocked_viewer())', t);
  execute format('create policy viewer_no_insert on public.%I as restrictive for insert to authenticated with check (not public.is_app_viewer())', t);
  execute format('create policy viewer_no_update on public.%I as restrictive for update to authenticated using (not public.is_app_viewer()) with check (not public.is_app_viewer())', t);
  execute format('create policy viewer_no_delete on public.%I as restrictive for delete to authenticated using (not public.is_app_viewer())', t);
end $$;
revoke all on function public.apply_viewer_guard(text) from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    perform public.apply_viewer_guard(r.tablename);
  end loop;
end $$;

-- storage: a viewer uploads, overwrites and deletes nothing; a blocked viewer opens nothing
drop policy if exists viewer_no_read on storage.objects;
drop policy if exists viewer_no_insert on storage.objects;
drop policy if exists viewer_no_update on storage.objects;
drop policy if exists viewer_no_delete on storage.objects;
create policy viewer_no_read   on storage.objects as restrictive for select to authenticated using (not public.is_blocked_viewer());
create policy viewer_no_insert on storage.objects as restrictive for insert to authenticated with check (not public.is_app_viewer());
create policy viewer_no_update on storage.objects as restrictive for update to authenticated using (not public.is_app_viewer()) with check (not public.is_app_viewer());
create policy viewer_no_delete on storage.objects as restrictive for delete to authenticated using (not public.is_app_viewer());

-- 12 SECURITY DEFINER functions are executable by authenticated and bypass RLS. All but live_revision are ALSO executable
-- by anon (the /ca self-forms and duty_take) — open to anyone holding a form link already, not a viewer-only door.
-- live_revision only reads.

-- tables created from now on get the guard by themselves
create or replace function public.viewer_guard_on_create() returns event_trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' and schema_name = 'public' loop
    perform public.apply_viewer_guard(split_part(r.object_identity, '.', 2));
  end loop;
end $$;
drop event trigger if exists viewer_guard_on_create;
create event trigger viewer_guard_on_create on ddl_command_end when tag in ('CREATE TABLE') execute function public.viewer_guard_on_create();
