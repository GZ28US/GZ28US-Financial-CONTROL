-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_travessia_markup_por_linha_BR.sql · 14/set/2026 · Projeto: BR saaowriaptbvfoqoykrh
--
-- MARKUP DA TRAVESSIA POR LINHA. A lei do 10% US: despesa do BR paga com dinheiro do GZ28US atravessa para a 006.N com +10%
-- (o amount_usd do BR já leva o 10%; o US divide por 1,10). Exceção decidida pelo Márcio em 14/09/2026: os gastos do BR pagos
-- com o dinheiro da VENDA da MasterPiece (BR.484, US$ 41.000 do Celso, que caiu na Regions em 10/04) atravessam SEM os 10%
-- — «Sem os 10% aqui». Em vez de texto na linha, um campo:
--   invoice_expenses.us_markup_pct numeric — vazio = a lei (10%); 0 = custo exato; outro valor = aquele %.
-- Com us_markup_pct = 0, o amount_usd da linha é o CUSTO (sem ×1,10) e o motor não divide.
-- VOLTA: ROLLBACK_travessia_markup_por_linha_BR.sql (recusa se alguma linha já tiver valor).
begin;
set local lock_timeout = '5s';
alter table public.invoice_expenses add column if not exists us_markup_pct numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_expenses_us_markup_pct_faixa') then
    alter table public.invoice_expenses add constraint invoice_expenses_us_markup_pct_faixa check (us_markup_pct is null or (us_markup_pct >= 0 and us_markup_pct <= 100));
  end if;
end $$;
comment on column public.invoice_expenses.us_markup_pct is
  'TRAVESSIA US⇄BR (14/set/2026): markup do GZ28US nesta despesa paga com dinheiro do US. Vazio = lei do 10%; 0 = custo exato (ex.: gastos pagos com a venda da MasterPiece). Lido por lib/crossing.server.ts do US.';
notify pgrst, 'reload schema';
commit;
select column_name, data_type from information_schema.columns where table_name = 'invoice_expenses' and column_name = 'us_markup_pct';
