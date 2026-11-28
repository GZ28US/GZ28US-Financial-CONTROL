-- 080.1 (Eduardo Simon Pereira · shopping do Defender/Edu, criada em 27/11/2026) — apaga a invoice-casca.
-- Márcio 28/11/2026 via AutoBook BR: «apague a que criamos hj». A AutoBook BR já tirou renda, 2 itens e o service
-- (linhas inteiras em data_fixes, check_key felipe-shopping-apagada-2811, incluindo a invoice). Sobrou a invoice + 1 invoice_event,
-- e o evento é append-only: o escape gz28.test_cleanup fica ligado SÓ nesta transação. O cliente #80 fica.
-- Se a casca não estiver vazia, nada é apagado. O evento fica inteiro em data_fixes (old_value).
do $$
declare v_inv uuid := '07dbc673-742a-4bd5-baf7-dbae5b5ab721'; v_key text := 'felipe-shopping-apagada-2811'; v_n int;
begin
  if not exists (select 1 from invoices where id = v_inv and invoice_code = '080.1') then raise exception '080.1 nao encontrada'; end if;
  if exists (select 1 from invoice_items where invoice_id = v_inv) or exists (select 1 from invoice_services where invoice_id = v_inv)
     or exists (select 1 from invoice_incomes where invoice_id = v_inv) or exists (select 1 from invoice_installments where invoice_id = v_inv)
     or exists (select 1 from invoice_expenses where invoice_id = v_inv) or exists (select 1 from invoice_duties where invoice_id = v_inv)
     or exists (select 1 from invoice_revisions where invoice_id = v_inv) or exists (select 1 from invoice_approvals where invoice_id = v_inv)
     or exists (select 1 from payment_attempts where invoice_id = v_inv) or exists (select 1 from car_deals where purchase_invoice_id = v_inv)
    then raise exception '080.1 nao esta vazia'; end if;
  select count(*) into v_n from invoice_events where invoice_id = v_inv;
  if v_n > 1 then raise exception '080.1: eventos inesperados (%)', v_n; end if;

  insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select v_key, 'invoice_events', id::text, '(row deleted)', to_jsonb(t)::text, null, '080.1 · Eduardo Simon Pereira — evento da casca' from invoice_events t where invoice_id = v_inv;
  if not exists (select 1 from data_fixes where check_key = v_key and table_name = 'invoices' and row_id = v_inv::text) then
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
      select v_key, 'invoices', id::text, '(row deleted)', to_jsonb(t)::text, null, '080.1 · Eduardo Simon Pereira — invoice-casca apagada' from invoices t where id = v_inv;
  end if;

  perform set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
  delete from invoice_events where invoice_id = v_inv;
  delete from invoices where id = v_inv;
  perform set_config('gz28.test_cleanup', '', true);
end $$;
