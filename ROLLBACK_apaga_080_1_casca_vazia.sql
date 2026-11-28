-- VOLTA de MIGRATION_apaga_080_1_casca_vazia.sql: recria a invoice 080.1 e o evento dela a partir da linha inteira em data_fixes
-- (check_key felipe-shopping-apagada-2811). Itens, service e renda são da volta da AutoBook BR (mesma check_key), depois desta.
do $$
declare v_key text := 'felipe-shopping-apagada-2811'; v_inv text := '07dbc673-742a-4bd5-baf7-dbae5b5ab721';
begin
  perform set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
  insert into invoices select (jsonb_populate_record(null::invoices, old_value::jsonb)).* from data_fixes
    where check_key = v_key and table_name = 'invoices' and row_id = v_inv order by created_at limit 1;
  insert into invoice_events select (jsonb_populate_record(null::invoice_events, old_value::jsonb)).* from data_fixes
    where check_key = v_key and table_name = 'invoice_events' and field = '(row deleted)';
  perform set_config('gz28.test_cleanup', '', true);
end $$;
