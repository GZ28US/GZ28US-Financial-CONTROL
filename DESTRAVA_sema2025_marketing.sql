-- Tira as 7 travas da migração SEMA 2025 → Marketing (depois de conferir o GET /ca/api/crossing). Projeto: US.
begin;
delete from public.crossing_locks where holder = 'sema2025-marketing';
commit;
select count(*) as travas_restantes from public.crossing_locks where holder = 'sema2025-marketing';
