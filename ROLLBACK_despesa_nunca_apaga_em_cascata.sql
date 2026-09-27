-- Desfaz MIGRATION_despesa_nunca_apaga_em_cascata.sql: devolve ON DELETE CASCADE só às FKs que a
-- migration trocou (lidas da trilha despesa-nunca-apaga-em-cascata em data_fixes).
begin;
do $$
declare r record; d text;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join data_fixes f on f.check_key = 'despesa-nunca-apaga-em-cascata' and f.table_name = c.conrelid::regclass::text and f.row_id = c.conname
    where c.contype = 'f' and c.confdeltype = 'r'
  loop
    d := replace(r.def, 'ON DELETE RESTRICT', 'ON DELETE CASCADE');
    execute format('alter table %s drop constraint %I, add constraint %I %s', r.tbl, r.conname, r.conname, d);
  end loop;
end $$;
commit;
