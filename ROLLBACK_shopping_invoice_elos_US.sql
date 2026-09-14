-- VOLTA ATRÁS DO BACKFILL_shopping_invoice_elos_US.sql (14/set/2026).
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Lê a trilha 'shopping-invoice-elos' em data_fixes: devolve a NULL só o campo que o backfill escreveu (old_value
-- nulo) e só se ele ainda tem o valor que o backfill pôs — elo que alguém trocou depois fica. A trilha não é
-- apagada: cada volta ganha um registro próprio com check_key 'shopping-invoice-elos-volta'.

begin;

set local lock_timeout = '5s';
lock table public.invoice_expenses in share row exclusive mode;

create temp table volta on commit drop as
  select f.row_id, f.field, f.new_value
    from public.data_fixes f where f.check_key = 'shopping-invoice-elos' and f.table_name = 'invoice_expenses'
     and f.field in ('br_expense_id', 'mirror_src') and f.old_value is null;

do $$
declare n int;
begin
  select count(*) into n from volta;
  if n = 0 then raise exception 'a trilha shopping-invoice-elos está vazia — o backfill não rodou (ou já voltou)'; end if;
end $$;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'shopping-invoice-elos-volta', 'invoice_expenses', e.id::text, v.field, v.new_value, null, 'volta dos elos de 14/set'
  from volta v join public.invoice_expenses e on e.id::text = v.row_id
 where (v.field = 'br_expense_id' and e.br_expense_id::text = v.new_value) or (v.field = 'mirror_src' and e.mirror_src = v.new_value);

update public.invoice_expenses e set br_expense_id = null from volta v where v.field = 'br_expense_id' and e.id::text = v.row_id and e.br_expense_id::text = v.new_value;
update public.invoice_expenses e set mirror_src = null from volta v where v.field = 'mirror_src' and e.id::text = v.row_id and e.mirror_src = v.new_value;

commit;

select count(*) filter (where br_expense_id is not null) com_br_expense_id, count(*) filter (where mirror_src is not null) com_mirror_src from public.invoice_expenses;
