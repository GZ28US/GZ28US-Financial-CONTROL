-- PERFORMANCE NASCE COM A INVOICE DO PACK VALIDADO (18/10/2026) — lib/packPerformance.server.ts, /api/performance/seed-pack
-- Projeto: Supabase US.
--
-- Márcio (18/10/2026, via Parts & Packs): «para os packs shop locked, que já estiverem validados, quando uma invoice de um carro for
-- aberta já com este pack, o app já deve criar em performance, o BoneStock, o Pack novo e a build sheet. OBS: O BoneStock não deve ter
-- BuildSheet, uma vez que é BoneStock, não tem nenhuma mod.»
--   packs.validated_by  — a PROVA da validação («SublimeHell US.038 · 1256 bhp»). Vazio = não validado: a invoice não cria nada.
--   packs.build_sheet   — o modelo da Build Sheet do pack: as mesmas chaves de ride_build_sheets (power_source, headers, injectors…).
--                         Quem preenche é a sessão Parts & Packs (dona do conteúdo dos packs).
--   invoices.pack_id    — o pack com que a invoice nasceu (antes só o NOME ia para invoices.service).
alter table public.packs    add column if not exists validated_by text;
alter table public.packs    add column if not exists build_sheet jsonb;
alter table public.invoices add column if not exists pack_id uuid references public.packs(id) on delete set null;
comment on column public.packs.validated_by is 'Prova da validação do pack (carro + potência medida). Preenchido = pack VALIDADO: invoice aberta com ele cria BoneStock + build do pack + build sheet em performance.';
comment on column public.packs.build_sheet  is 'Modelo da Build Sheet do pack — chaves de ride_build_sheets (power_source, intake, headers, injectors, cam, pulley_size, fuel…). Copiado para o build do pack.';
comment on column public.invoices.pack_id   is 'Pack com que a invoice foi aberta (new invoice → applyPack).';
notify pgrst, 'reload schema';
