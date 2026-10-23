-- ROLLBACK_intercompany_transfers.sql · 23/out/2026 — desfaz MIGRATION_intercompany_transfers.sql (US)
-- A trilha data_fixes (check_key intercompany-transfers-semente) fica: é história.
begin;
drop table if exists public.intercompany_transfers;
notify pgrst, 'reload schema';
commit;
