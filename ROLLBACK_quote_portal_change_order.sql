-- ROLLBACK of MIGRATION_quote_portal_change_order.sql — drops the two functions (no data, no tables).
begin;
drop function if exists public.change_order_send(uuid, text, jsonb, text, text, text, numeric, numeric, text, jsonb, int);
drop function if exists public.change_order_apply(uuid, text);
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m4', 'functions', 'change_order_send,change_order_apply', 'migration', 'created', null, 'ROLLBACK_quote_portal_change_order.sql');
commit;
