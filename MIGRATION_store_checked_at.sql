-- RASTREIO CEGO (LIVRO 13.10, Márcio, 19/10/2026): «o robô tem que entrar na Amazon e checar a order,
-- mas não pode "abandonar" o caso, info is power».
-- Compra paga com número de PEDIDO e sem número de RASTREIO é «cega»: o 17TRACK não tem o que perguntar,
-- quem sabe dela é a loja. «Cego» NÃO vira coluna (é derivado dos fatos, como o badge — lib/deliverStatus.ts
-- isBlindTracking); o que se guarda é QUANDO o robô olhou a página do pedido. A leitura em si mora nas
-- colunas que já existem: last_event (o que a loja dizia), eta, delivered_at.
-- Coluna em tabela que já existe: não precisa de GRANT novo (os grants da tabela cobrem a coluna).
begin;
alter table invoice_expenses add column if not exists store_checked_at timestamptz;
alter table inputs           add column if not exists store_checked_at timestamptz;
alter table inventory        add column if not exists store_checked_at timestamptz;
alter table assets           add column if not exists store_checked_at timestamptz;
alter table assets_expenses  add column if not exists store_checked_at timestamptz;
alter table staff_expenses   add column if not exists store_checked_at timestamptz;

comment on column invoice_expenses.store_checked_at is 'RASTREIO CEGO (LIVRO 13.10): quando o robô leu a página do pedido na loja (Amazon/eBay/Temu). Escrito por /api/items/store-check.';
commit;
