-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — MIGRATION_rls_anon_exposure_11set.sql (US fvgpkbpqacnqxtrjsmpi, 11/set/2026)
-- Devolve o estado MEDIDO em 11/set/2026: REABRE a chave anon pública nas 8 tabelas.
-- Rode só se uma tela ou robô quebrou por causa da migration. A trava 0 da ida garantiu
-- que as políticas eram permissive using(true); as de ALL voltam com with check (true).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- auto_book_mail*: estavam com RLS desligado e sem política nenhuma.
alter table public.auto_book_mail       disable row level security;
alter table public.auto_book_mail_rules disable row level security;
alter table public.auto_book_mail_runs  disable row level security;

-- invoice_duties: volta a porta de public (a invoice_duties_authenticated_all nunca saiu).
drop policy if exists "Allow all invoice_duties" on public.invoice_duties;
create policy "Allow all invoice_duties" on public.invoice_duties
  for all to public using (true) with check (true);

-- part_streams / part_stream_items: voltam as portas anon (as "auth all" nunca saíram).
drop policy if exists "part_streams anon all" on public.part_streams;
create policy "part_streams anon all" on public.part_streams
  for all to anon using (true) with check (true);

drop policy if exists "part_stream_items anon all" on public.part_stream_items;
create policy "part_stream_items anon all" on public.part_stream_items
  for all to anon using (true) with check (true);

-- supplier_orders: SELECT de novo para anon + authenticated.
drop policy if exists supplier_orders_select on public.supplier_orders;
create policy supplier_orders_select on public.supplier_orders
  for select to anon, authenticated using (true);

-- shop_config: anon volta a ler a tabela inteira ("authenticated all" nunca saiu).
drop policy if exists "anon read" on public.shop_config;
create policy "anon read" on public.shop_config
  for select to anon using (true);

commit;
