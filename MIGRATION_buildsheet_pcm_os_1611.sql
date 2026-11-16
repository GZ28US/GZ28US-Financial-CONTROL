-- BUILD SHEET: PCM OS (Marcio, 16/11/2026: «inclua na BuildSheet dos carros o OS da PCM»)
-- O numero do sistema operacional que esta gravado na PCM do carro (ex.: o OS que o HP Tuners mostra na leitura).
-- ride_build_sheets mora SO no banco US — o app BR escreve nele por supabaseUS. Roda uma vez, no US, e vale pros dois apps.
alter table public.ride_build_sheets
  add column if not exists pcm_os text;   -- campo aberto de uma linha (kind 'text', line: true)
