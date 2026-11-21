-- Volta do MIGRATION_enxugar_fl_tax_refund_date_2111.sql. A coluna estava vazia em todas as linhas: recriar é voltar ao que era.
alter table public.invoices add column if not exists fl_tax_refund_date date;
