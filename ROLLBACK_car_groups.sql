-- ROLLBACK de MIGRATION_car_groups.sql (04/10/2026). Tira a tabela dos grupos de compatibilidade de build. Os packs não
-- dependem dela (guardam os carros, não o grupo). Rodar com --confirmo --eu-sei-que-apaga.
begin;
drop table if exists public.car_groups;
commit;
