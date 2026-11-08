-- ROLLBACK of MIGRATION_quote_portal_sign_otp.sql — drops the code table (its rows are short-lived codes and passes; nothing to keep)
-- and removes the switch. Without the row the app reads the switch as OFF, so the sign path is exactly the pre-OTP one.
begin;
drop table if exists public.quote_sign_otps;
delete from public.app_settings where key = 'quote_portal.sign_otp';
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m4', 'quote_sign_otps', 'table + quote_portal.sign_otp', 'migration', 'created', null, 'ROLLBACK_quote_portal_sign_otp.sql');
commit;
