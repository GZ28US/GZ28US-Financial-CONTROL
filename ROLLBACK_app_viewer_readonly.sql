-- ROLLBACK of MIGRATION_app_viewer_readonly.sql (10/11/2026)
drop event trigger if exists viewer_guard_on_create;
drop function if exists public.viewer_guard_on_create();
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop policy if exists viewer_no_read on public.%I', r.tablename);
    execute format('drop policy if exists viewer_no_insert on public.%I', r.tablename);
    execute format('drop policy if exists viewer_no_update on public.%I', r.tablename);
    execute format('drop policy if exists viewer_no_delete on public.%I', r.tablename);
  end loop;
end $$;
drop policy if exists viewer_no_read on storage.objects;
drop policy if exists viewer_no_insert on storage.objects;
drop policy if exists viewer_no_update on storage.objects;
drop policy if exists viewer_no_delete on storage.objects;
drop function if exists public.apply_viewer_guard(text);
drop function if exists public.my_app_role();
drop function if exists public.is_blocked_viewer();
drop function if exists public.is_app_viewer();
drop table if exists public.app_viewer_invites;
drop table if exists public.app_viewers;
