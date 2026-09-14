-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_invoice_items_cancel_status.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- O ITEM COBRADO TAMBÉM PODE SER ESTORNADO. Decisão do Márcio (14/09/2026), sobre o pedido HHP 382526 — cobrado na
-- Regions em 13/08 (US$ 5.349,65) e estornado inteiro em 19/08 (PayPal 1HY11455CN7150914) —, cujas peças continuam na
-- shopping invoice 006.27 (4 despesas já REFUNDED, 4 itens cobrando US$ 2.354,11 do GZ28BR):
--   «deixe nas invoices como estornado, e faça os controles financeiros.»
--
-- As 6 tabelas de item COMPRADO já têm cancel_status (null | CANCELLED | REFUNDED) desde 30/ago/2026. invoice_items — a
-- linha que COBRA o cliente — não tinha: a despesa estornada saía da história, mas o item continuava cobrando. Esta
-- migration dá ao item o mesmo campo, com a mesma trava.
--
-- QUEM LÊ: lib/estorno.ts (foraDoDinheiro) — a régua única de "conta ou não conta" das telas de invoice, das demonstrações
-- (lib/financials.ts), da conta US ⇄ BR (lib/crossingBalance.ts) e do motor da travessia (lib/crossing.server.ts).
-- QUEM ESCREVE: o editor de invoice (EDIT do item → CANCELLED?), só este campo.
--
-- ⚠ ORDEM: roda ANTES do deploy do branch estorno-controles. As telas pedem invoice_items.cancel_status pelo nome no
--   select; sem a coluna o PostgREST devolve 400 e as listas de invoice, a home, o DRE/DFC/Balanço e a travessia param.
--
-- Só ADITIVO e idempotente (rodar duas vezes não muda nada). Coluna nula: todos os 800+ itens continuam vivos.
-- As views-ponte (invoice_parts, select * de antes da onda 2) não enxergam a coluna nova — ninguém escreve por elas.
-- VOLTA: ROLLBACK_invoice_items_cancel_status.sql (recusa se algum item já estiver marcado).

begin;

set local lock_timeout = '5s';

alter table public.invoice_items add column if not exists cancel_status text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_items_cancel_status_chk') then
    alter table public.invoice_items add constraint invoice_items_cancel_status_chk
      check (cancel_status is null or cancel_status in ('CANCELLED', 'REFUNDED'));
  end if;
end $$;

comment on column public.invoice_items.cancel_status is
  'ESTORNO (14/set/2026, Márcio: «deixe nas invoices como estornado, e faça os controles financeiros»): null = item vivo; CANCELLED = cancelado, aguardando estorno; REFUNDED = estornado. O item FICA na invoice, riscado, e sai de todo total (grand total, pending balance, DRE/DFC/Balanço, conta US⇄BR). Régua única em lib/estorno.ts.';

notify pgrst, 'reload schema';

-- ── CONFERÊNCIA: se faltar qualquer peça, tudo volta atrás ────────────────────
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'cancel_status' and data_type = 'text';
  if n <> 1 then raise exception 'invoice_items.cancel_status não ficou (achei % coluna)', n; end if;
  select count(*) into n from pg_constraint
   where conname = 'invoice_items_cancel_status_chk' and conrelid = 'public.invoice_items'::regclass;
  if n <> 1 then raise exception 'a trava invoice_items_cancel_status_chk não ficou (achei %)', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura, depois do commit) ────────────────────────────────
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'cancel_status';
select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'invoice_items_cancel_status_chk';
select count(*) itens, count(cancel_status) itens_marcados from public.invoice_items;
