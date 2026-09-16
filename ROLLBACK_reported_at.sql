-- VOLTA de MIGRATION_reported_at.sql: tira a coluna reported_at das 8 tabelas (as marcas antigas em stream_mail_moves e
-- expense_reports_sent nunca foram apagadas, então a rede antiga volta a funcionar com o código anterior) e a trilha do preenchimento.
begin;
alter table public.invoice_expenses drop column if exists reported_at;
alter table public.invoice_incomes drop column if exists reported_at;
alter table public.staff_expenses drop column if exists reported_at;
alter table public.assets drop column if exists reported_at;
alter table public.assets_expenses drop column if exists reported_at;
alter table public.inputs drop column if exists reported_at;
alter table public.inventory drop column if exists reported_at;
alter table public.fixed_cost_expenses drop column if exists reported_at;
delete from public.data_fixes where check_key = 'reported-at-backfill';
commit;
