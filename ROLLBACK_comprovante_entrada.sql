-- ROLLBACK_comprovante_entrada.sql · 17/out/2026 — volta MIGRATION_comprovante_entrada.sql (projeto US)
-- Rodar:  node scripts/roda-sql.mjs --projeto us --file ROLLBACK_comprovante_entrada.sql --confirmo
-- ATENÇÃO: o motor da travessia exige invoice_incomes.receipt_kinds — reverta o código (lib/crossing.server.ts) ANTES.
-- Os comprovantes (receipt_url) não são tocados: a troca automática deixou cada valor antigo em data_fixes
-- (check_key 'comprovante-entrada-regions'), de onde se devolve à mão.

begin;
set local lock_timeout = '5s';
drop table if exists public.remittance_incomes;
drop table if exists public.remittances;
alter table public.invoice_incomes drop column if exists receipt_kinds;
notify pgrst, 'reload schema';
commit;
