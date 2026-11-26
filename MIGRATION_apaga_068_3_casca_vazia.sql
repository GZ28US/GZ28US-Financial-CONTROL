-- 068.3 (Alex Aguiar) — apaga a invoice-casca (Márcio 25/11/2026: «não usamos a invoice do retrovisor separado, volte ele pra
-- invoice principal, deixe ela como foi assinada, e apague a nova» · confirmado na App Dev: «pode apagar»).
-- A AutoBook US já devolveu item, despesa e pagamento à 068.1. Sobrou: a invoice, 1 parcela e 1 renda ZERADA presa à parcela.
-- A renda de plano só sai com o escape da trava trg_plan_row_no_delete, ligado SÓ nesta transação. Cada linha apagada fica
-- inteira em data_fixes (old_value). Se a casca não estiver vazia, ou o valor da renda não for 0, nada é apagado.
do $$
declare v_inv uuid := '92c5f8b5-199b-44ac-bdc2-0a34a106fb5d'; v_inc uuid := 'b26d627e-8b6a-4c44-ba18-8e0b79839647'; v_ins uuid := 'c724040d-1cfa-43d0-a5a5-e87d4ddd4ce3';
        v_key text := 'alex-068-3-volta-pra-068-1-2511'; v_n int;
begin
  if not exists (select 1 from invoices where id = v_inv and invoice_code = '068.3') then raise exception '068.3 nao encontrada'; end if;
  if exists (select 1 from invoice_items where invoice_id = v_inv) or exists (select 1 from invoice_services where invoice_id = v_inv)
     or exists (select 1 from invoice_expenses where invoice_id = v_inv) or exists (select 1 from invoice_revisions where invoice_id = v_inv)
     or exists (select 1 from invoice_approvals where invoice_id = v_inv) then raise exception '068.3 nao esta vazia'; end if;
  select count(*) into v_n from invoice_incomes where invoice_id = v_inv;
  if v_n <> 1 or not exists (select 1 from invoice_incomes where id = v_inc and invoice_id = v_inv and coalesce(amount, 0) = 0) then raise exception '068.3: renda inesperada'; end if;
  select count(*) into v_n from invoice_installments where invoice_id = v_inv;
  if v_n <> 1 then raise exception '068.3: parcelas inesperadas'; end if;

  insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select v_key, 'invoice_incomes', id::text, '(row deleted)', to_jsonb(t)::text, null, '068.3 · Alex Aguiar — renda zerada da casca' from invoice_incomes t where id = v_inc;
  insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select v_key, 'invoice_installments', id::text, '(row deleted)', to_jsonb(t)::text, null, '068.3 · Alex Aguiar — parcela da casca' from invoice_installments t where id = v_ins;
  insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select v_key, 'invoices', id::text, '(row deleted)', to_jsonb(t)::text, null, '068.3 · Alex Aguiar — invoice-casca apagada' from invoices t where id = v_inv;

  perform set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
  delete from invoice_incomes where id = v_inc;
  delete from invoice_installments where id = v_ins;
  delete from invoices where id = v_inv;
  perform set_config('gz28.test_cleanup', '', true);
end $$;
