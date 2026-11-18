-- ROBO DO LOCKER LIGADO (Marcio, 17/11/2026, na sessao App Development 2, depois de ver o texto do ensaio: «do 1 and 2» /
-- «do what I asked for, I couldn't be more clear»). A partir daqui cada aviso novo de locker vai sozinho ao WhatsApp US da Chris.
-- Desligar: update public.app_settings set value = 'false'::jsonb where key = 'notify.chris.parcel_locker'.
update public.app_settings set value = 'true'::jsonb, updated_at = now(), updated_by = 'App Development 2 (ordem do Marcio 17/11/2026)'
 where key = 'notify.chris.parcel_locker';
