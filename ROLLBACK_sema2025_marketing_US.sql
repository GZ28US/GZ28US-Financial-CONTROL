-- VOLTA de MIGRATION_sema2025_marketing_US.sql: as 18 linhas voltam para staff_expenses (a linha inteira guardada na trilha
-- 'sema2025-marketing'), os custos fixos criados saem e as travas saem. Rodar JUNTO com ROLLBACK_sema2025_marketing_BR.sql.
begin;
set local lock_timeout = '5s';
insert into public.staff_expenses
select (jsonb_populate_record(null::public.staff_expenses, d.old_value::jsonb)).*
  from public.data_fixes d
 where d.check_key = 'sema2025-marketing' and d.table_name = 'staff_expenses' and d.field = 'DELETE'
   and not exists (select 1 from public.staff_expenses x where x.id::text = d.row_id);
delete from public.fixed_cost_expenses f
 using public.data_fixes d
 where d.check_key = 'sema2025-marketing' and d.table_name = 'fixed_cost_expenses' and d.field = 'INSERT' and f.id::text = d.row_id;
delete from public.crossing_locks where holder = 'sema2025-marketing';
commit;
