-- ROLLBACK de MIGRATION_parts_shop_locked.sql (04/10/2026): tira a trava de banco e a marca GZ28 SHOP LOCKED do Parts DB.
-- As peças ficam como estão, só voltam a ser editáveis pelo app. Rodar com --confirmo --eu-sei-que-apaga.
begin;
drop trigger if exists parts_shop_lock_guard on public.parts_database;
drop function if exists public.parts_shop_lock_guard();
alter table public.parts_database drop column if exists shop_locked;
commit;
