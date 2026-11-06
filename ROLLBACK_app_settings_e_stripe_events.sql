-- Desfaz MIGRATION_app_settings_e_stripe_events.sql (06/11/2026). Só se NENHUMA rota do portal estiver no ar.
drop table if exists public.stripe_events;
drop policy if exists app_settings_authenticated_all on public.app_settings;
drop table if exists public.app_settings;
