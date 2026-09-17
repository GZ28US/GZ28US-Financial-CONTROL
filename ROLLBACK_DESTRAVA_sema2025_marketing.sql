-- VOLTA de DESTRAVA_sema2025_marketing.sql: recoloca as 7 travas da migração SEMA 2025 → Marketing por mais 50 minutos. Projeto: US.
begin;
insert into public.crossing_locks (mirror_key, holder, locked_at) values
  ('US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:77d90d9d-755b-4c4b-942d-d67b3a7c967e', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:4866cd6c-326b-4a09-b75e-3fceacca5e98', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:e27b6e24-0d29-47a0-b15d-bcd7c20d0686', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:8d907c9a-9671-4007-98b7-c4270116977e', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:20b7168d-5389-4618-97ce-99364ca6b827', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:296f294a-c789-4914-95d7-445e4644d440', 'sema2025-marketing', now() + interval '50 minutes');
commit;
select count(*) as travas from public.crossing_locks where holder = 'sema2025-marketing';
