-- DESPESA NUNCA SOME EM CASCATA (Márcio, 27/09/2026: «yes, don't delete any expense, never, at least
-- without asking me to, asking me how to do it»). Toda FK que apagava linhas de gasto junto com o
-- pai (staff, season, invoice, fornecedor de custo fixo, season de custo fixo, bem/asset) passa de
-- ON DELETE CASCADE para ON DELETE RESTRICT: apagar um pai que ainda tem despesa FALHA, e a decisão
-- de como fazer volta para ele. A definição de cada FK é copiada do banco e só a regra de delete muda.
-- Trilha em data_fixes (despesa-nunca-apaga-em-cascata); ROLLBACK ao lado devolve o CASCADE.
begin;
do $$
declare r record; d text;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f' and c.confdeltype = 'c' and c.connamespace = 'public'::regnamespace
      and c.conrelid::regclass::text in ('staff_expenses','fixed_cost_expenses','assets_expenses','invoice_expenses')
  loop
    d := replace(r.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT');
    execute format('alter table %s drop constraint %I, add constraint %I %s', r.tbl, r.conname, r.conname, d);
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    values ('despesa-nunca-apaga-em-cascata', r.tbl, r.conname, 'on delete', 'CASCADE', 'RESTRICT', r.def);
  end loop;
end $$;
commit;

select string_agg(c.conrelid::regclass::text || '.' || c.conname || ' = ' ||
       case c.confdeltype when 'r' then 'RESTRICT' when 'c' then 'CASCADE' when 'a' then 'NO ACTION' when 'n' then 'SET NULL' else c.confdeltype::text end, E'\n') as fks
from pg_constraint c
where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conrelid::regclass::text in ('staff_expenses','fixed_cost_expenses','assets_expenses','invoice_expenses');
