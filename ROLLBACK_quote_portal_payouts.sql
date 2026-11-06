-- ROLLBACK of MIGRATION_quote_portal_payouts.sql — drops the table (its rows are a mirror of Stripe; the SYNC rebuilds them).
begin;
drop table if exists public.stripe_payouts;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m5', 'stripe_payouts', 'table', 'migration', 'created', null, 'ROLLBACK_quote_portal_payouts.sql');
commit;
