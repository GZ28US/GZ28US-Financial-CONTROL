-- VOLTA ATRÁS DA ONDA 2 (os renames). Derruba a ponte, devolve os nomes velhos às
-- tabelas, devolve o nome das políticas e desfaz os ponteiros gravados como dado.
-- Rodar inteiro, numa transação só.
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- ⚠ Só serve enquanto o código ainda não depender dos nomes novos. Depois do deploy
--   do app com os nomes novos, voltar aqui exige reverter o deploy ANTES.

begin;

drop view if exists public.invoice_payments;
drop view if exists public.invoice_parts;
drop view if exists public.goods;
drop view if exists public.good_expenses;
drop view if exists public.expenses;

alter table public.invoice_incomes  rename to invoice_payments;
alter table public.invoice_items    rename to invoice_parts;
alter table public.assets           rename to goods;
alter table public.assets_expenses  rename to good_expenses;
alter table public.staff_expenses   rename to expenses;

alter policy "invoice_incomes_authenticated_all"  on public.invoice_payments rename to "invoice_payments_authenticated_all";
alter policy "invoice_items_authenticated_all"    on public.invoice_parts    rename to "invoice_parts_authenticated_all";
alter policy "assets_authenticated_all"           on public.goods            rename to "goods_authenticated_all";
alter policy "assets_expenses_authenticated_all"  on public.good_expenses    rename to "good_expenses_authenticated_all";
alter policy "staff_expenses_authenticated_all"   on public.expenses         rename to "expenses_authenticated_all";

update bank_transactions set matched_table = case matched_table
  when 'invoice_incomes' then 'invoice_payments' when 'invoice_items' then 'invoice_parts'
  when 'assets' then 'goods' when 'assets_expenses' then 'good_expenses' when 'staff_expenses' then 'expenses' end
where matched_table in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');

update bank_match_log set matched_table = case matched_table
  when 'invoice_incomes' then 'invoice_payments' when 'invoice_items' then 'invoice_parts'
  when 'assets' then 'goods' when 'assets_expenses' then 'good_expenses' when 'staff_expenses' then 'expenses' end
where matched_table in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');

update mail_processed set ref_table = case ref_table
  when 'invoice_incomes' then 'invoice_payments' when 'invoice_items' then 'invoice_parts'
  when 'assets' then 'goods' when 'assets_expenses' then 'good_expenses' when 'staff_expenses' then 'expenses' end
where ref_table in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');

update auto_book_mail set booked_table = case booked_table
  when 'invoice_incomes' then 'invoice_payments' when 'invoice_items' then 'invoice_parts'
  when 'assets' then 'goods' when 'assets_expenses' then 'good_expenses' when 'staff_expenses' then 'expenses' end
where booked_table in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');

notify pgrst, 'reload schema';

commit;
