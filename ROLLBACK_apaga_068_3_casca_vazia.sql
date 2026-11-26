-- VOLTA de MIGRATION_apaga_068_3_casca_vazia.sql: recria a invoice 068.3, a parcela e a renda zerada a partir da linha inteira
-- guardada em data_fixes (check_key alex-068-3-volta-pra-068-1-2511, field '(row deleted)'). Ordem: invoice, parcela, renda.
do $$
declare v_key text := 'alex-068-3-volta-pra-068-1-2511';
begin
  perform set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
  insert into invoices select (jsonb_populate_record(null::invoices, old_value::jsonb)).* from data_fixes where check_key = v_key and table_name = 'invoices' and field = '(row deleted)';
  insert into invoice_installments select (jsonb_populate_record(null::invoice_installments, old_value::jsonb)).* from data_fixes where check_key = v_key and table_name = 'invoice_installments' and field = '(row deleted)';
  insert into invoice_incomes select (jsonb_populate_record(null::invoice_incomes, old_value::jsonb)).* from data_fixes where check_key = v_key and table_name = 'invoice_incomes' and field = '(row deleted)';
  perform set_config('gz28.test_cleanup', '', true);
end $$;
