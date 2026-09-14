-- VOLTA ATRÁS DA MIGRATION_travessia_shopping_invoice_BR.sql (14/set/2026).
-- Projeto: BR  saaowriaptbvfoqoykrh
--
-- Tira as 6 colunas e os 6 índices da travessia. RECUSA se alguma coluna nova já tem valor — inclusive
-- invoice_payments.amount_usd: US$ carimbado é valor gravado, e derrubar a coluna o apagaria sem trilha.
-- Volte antes ROLLBACK_shopping_invoice_elos_BR.sql (e o que o motor gravou, pela trilha
-- 'shopping-invoice-travessia' em data_fixes do BR).

begin;

set local lock_timeout = '5s';

do $$
declare n int;
begin
  select (select count(*) from public.invoices where mirror_key is not null)
       + (select count(*) from public.invoice_expenses where mirror_src is not null)
       + (select count(*) from public.invoice_parts where mirror_src is not null)
       + (select count(*) from public.invoice_payments where mirror_src is not null or amount_usd is not null or us_income_id is not null)
    into n;
  if n <> 0 then
    raise exception 'há % linha(s) com elo ou US$ da travessia gravado — volte antes o backfill/motor; nada foi derrubado', n;
  end if;
end $$;

drop index if exists public.invoices_client_invoice_code_uidx;
drop index if exists public.invoice_payments_us_income_id_idx;
drop index if exists public.invoice_payments_mirror_src_uidx;
drop index if exists public.invoice_parts_mirror_src_uidx;
drop index if exists public.invoice_expenses_mirror_src_uidx;
drop index if exists public.invoices_mirror_key_uidx;

alter table public.invoice_payments drop column if exists us_income_id;
alter table public.invoice_payments drop column if exists amount_usd;
alter table public.invoice_payments drop column if exists mirror_src;
alter table public.invoice_parts drop column if exists mirror_src;
alter table public.invoice_expenses drop column if exists mirror_src;
alter table public.invoices drop column if exists mirror_key;

notify pgrst, 'reload schema';

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and (table_name::text, column_name::text) in
     (('invoices', 'mirror_key'), ('invoice_expenses', 'mirror_src'), ('invoice_parts', 'mirror_src'),
      ('invoice_payments', 'mirror_src'), ('invoice_payments', 'amount_usd'), ('invoice_payments', 'us_income_id'));
  if n <> 0 then raise exception 'ainda sobraram % coluna(s) da travessia', n; end if;
end $$;

commit;

select table_name, column_name from information_schema.columns
 where table_schema = 'public' and column_name in ('mirror_key', 'mirror_src', 'amount_usd', 'us_income_id')
   and table_name in ('invoices', 'invoice_expenses', 'invoice_parts', 'invoice_payments');
