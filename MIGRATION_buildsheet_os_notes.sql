-- BUILD SHEET: OS Update + NOTES (Marcio, 06/set/2026)
-- ride_build_sheets mora SO no banco US — o app BR escreve nele por supabaseUS.
-- Entao esta migration roda uma vez, no US, e vale pros dois apps.
alter table public.ride_build_sheets
  add column if not exists os_update text,   -- Stock / texto livre (kind 'so')
  add column if not exists notes     text;   -- campo aberto (kind 'text')
