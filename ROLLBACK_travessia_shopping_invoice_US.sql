-- VOLTA ATRÁS DA MIGRATION_travessia_shopping_invoice_US.sql (14/set/2026).
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Tira as 5 colunas e os 6 índices da travessia. RECUSA se alguma coluna nova já tem valor: elo
-- gravado é trabalho do backfill ou do motor, e derrubar a coluna apagaria o elo sem trilha. Nesse
-- caso volte antes ROLLBACK_shopping_invoice_elos_US.sql (e o que o motor gravou, pela trilha
-- 'shopping-invoice-travessia' em data_fixes).

begin;

set local lock_timeout = '5s';

do $$
declare n int;
begin
  select (select count(*) from public.invoices where mirror_key is not null)
       + (select count(*) from public.invoice_expenses where mirror_src is not null)
       + (select count(*) from public.invoice_items where mirror_src is not null)
       + (select count(*) from public.invoice_incomes where mirror_src is not null or br_payment_id is not null)
    into n;
  if n <> 0 then
    raise exception 'há % linha(s) com elo da travessia gravado — volte antes o backfill/motor; nada foi derrubado', n;
  end if;
end $$;

drop index if exists public.invoices_client_invoice_code_uidx;
drop index if exists public.invoice_incomes_br_payment_id_idx;
drop index if exists public.invoice_incomes_mirror_src_uidx;
drop index if exists public.invoice_items_mirror_src_uidx;
drop index if exists public.invoice_expenses_mirror_src_uidx;
drop index if exists public.invoices_mirror_key_uidx;

alter table public.invoice_incomes drop column if exists br_payment_id;
alter table public.invoice_incomes drop column if exists mirror_src;
alter table public.invoice_items drop column if exists mirror_src;
alter table public.invoice_expenses drop column if exists mirror_src;
alter table public.invoices drop column if exists mirror_key;

notify pgrst, 'reload schema';

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and (table_name::text, column_name::text) in
     (('invoices', 'mirror_key'), ('invoice_expenses', 'mirror_src'), ('invoice_items', 'mirror_src'),
      ('invoice_incomes', 'mirror_src'), ('invoice_incomes', 'br_payment_id'));
  if n <> 0 then raise exception 'ainda sobraram % coluna(s) da travessia', n; end if;
end $$;

commit;

select table_name, column_name from information_schema.columns
 where table_schema = 'public' and column_name in ('mirror_key', 'mirror_src', 'br_payment_id');
