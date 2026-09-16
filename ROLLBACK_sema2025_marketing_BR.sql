-- VOLTA de MIGRATION_sema2025_marketing_BR.sql: os 17 espelhos voltam para as 085.N das seasons (invoice, mirror_src e
-- posição guardados na trilha 'sema2025-marketing') e a 085.N do marketing sai — junto com o Pending balance que o motor tenha criado
-- nela depois da migração (mirror_src 'pendente:US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'). Rodar JUNTO com ROLLBACK_sema2025_marketing_US.sql.
begin;
set local lock_timeout = '5s';
with t as (
  select d.table_name, d.row_id::uuid as id, split_part(d.old_value, '|', 1)::uuid as inv, split_part(d.old_value, '|', 2) as src, nullif(split_part(d.old_value, '|', 3), '')::int as pos
    from public.data_fixes d where d.check_key = 'sema2025-marketing' and d.field = 'invoice_id+mirror_src'
)
update public.invoice_expenses e set invoice_id = t.inv, mirror_src = t.src, position = t.pos from t where t.table_name = 'invoice_expenses' and e.id = t.id;
with t as (
  select d.table_name, d.row_id::uuid as id, split_part(d.old_value, '|', 1)::uuid as inv, split_part(d.old_value, '|', 2) as src, nullif(split_part(d.old_value, '|', 3), '')::int as pos
    from public.data_fixes d where d.check_key = 'sema2025-marketing' and d.field = 'invoice_id+mirror_src'
)
update public.invoice_parts p set invoice_id = t.inv, mirror_src = t.src, position = t.pos from t where t.table_name = 'invoice_parts' and p.id = t.id;
delete from public.invoice_payments where mirror_src = 'pendente:US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'
   and invoice_id in (select id from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06') and paid_at is null;
do $$ declare n int; begin
  select count(*) into n from public.invoice_expenses e join public.invoices i on i.id = e.invoice_id where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  if n <> 0 then raise exception 'a 085.N do marketing ainda tem % despesas (criadas depois da migração?) — não apago', n; end if;
  select count(*) into n from public.invoice_parts p join public.invoices i on i.id = p.invoice_id where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  if n <> 0 then raise exception 'a 085.N do marketing ainda tem % itens — não apago', n; end if;
  select count(*) into n from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  if n <> 0 then raise exception 'a 085.N do marketing ainda tem % pagamentos — não apago', n; end if;
end $$;
delete from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
commit;
