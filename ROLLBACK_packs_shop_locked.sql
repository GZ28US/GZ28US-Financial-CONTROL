-- ROLLBACK de MIGRATION_packs_shop_locked.sql (04/10/2026): tira a trava de banco e a marca GZ28 SHOP LOCKED dos packs.
-- Os packs ficam como estão, só voltam a ser editáveis pelo app. Rodar com --confirmo --eu-sei-que-apaga.
begin;
drop trigger if exists packs_shop_lock_guard on public.packs;
drop function if exists public.packs_shop_lock_guard();
alter table public.packs drop column if exists shop_locked;
commit;
