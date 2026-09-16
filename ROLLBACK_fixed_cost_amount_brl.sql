-- VOLTA de MIGRATION_fixed_cost_amount_brl.sql: tira a coluna (só rodar antes de haver R$ gravado nela, ou guardando os valores).
begin;
alter table public.fixed_cost_expenses drop column if exists amount_brl;
commit;
