-- ROLLBACK of MIGRATION_quote_portal_legacy_backup.sql — removes ONLY the backfilled LEGACY_BACKUP rows.
-- invoice_revisions is append-only: the delete passes through the test_cleanup escape (postgres/service_role only).
begin;
select set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
delete from public.invoice_revisions where kind = 'LEGACY_BACKUP' and created_by = 'legacy-backfill';
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values ('quote-portal-legacy', 'invoice_revisions', 'all', 'migration', 'LEGACY_BACKUP', null, 'rollback do backfill');
commit;
