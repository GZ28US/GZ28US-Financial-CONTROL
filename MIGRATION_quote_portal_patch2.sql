-- QUOTE PORTAL M4 (06/11/2026): quote_hire numbering never counts «GZ28 TEST» clients, and a test client keeps its number.
-- Found by the change-order harness: hiring a test document promoted the shared fixture client to real project #68 (real max = 67).
-- Also restores that fixture client (#9999, quote) and its preview invoice code (9999.84241), with a data_fixes trail.
begin;
CREATE OR REPLACE FUNCTION public.quote_hire(p_invoice uuid, p_attempt uuid, p_money jsonb, p_muted boolean, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_inv invoices; v_att payment_attempts; v_rev invoice_revisions; v_newer invoice_revisions; v_ride rides; v_client clients;
        v_old_code text; v_new_code text; v_paid_on date; r record; v_inst jsonb; v_income uuid; v_target uuid; v_num int; v_old_pad text; v_new_pad text;
        v_n int; v_amounts jsonb; v_label text; v_snapshot jsonb;
begin
  select * into v_inv from invoices where id = p_invoice;                     -- locked by book_payment
  if not v_inv.is_quote then raise exception 'quote_hire: not a quote'; end if;
  select * into v_att from payment_attempts where id = p_attempt;
  select * into v_rev from invoice_revisions where id = v_att.revision_id;
  if v_rev.id is null or not exists (select 1 from invoice_approvals where revision_id = v_rev.id) then
    raise exception 'quote_hire: no approval bound to the paid revision';
  end if;
  for v_newer in select * from invoice_revisions where invoice_id = p_invoice and seq > v_rev.seq and superseded_at is null loop
    update invoice_revisions set superseded_at = now() where id = v_newer.id;
    perform doc_event(p_invoice, v_newer.id, 'REVISION_DROPPED', 'SYSTEM', null, jsonb_build_object('seq', v_newer.seq));
  end loop;
  v_paid_on := (p_money ->> 'paid_on')::date;

  -- C-10: o quote original fica guardado (antes de qualquer mudança)
  select jsonb_build_object(
    'invoice', to_jsonb(v_inv),
    'parts', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from invoice_items i where i.invoice_id = p_invoice), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from invoice_services s where s.invoice_id = p_invoice), '[]'::jsonb),
    'payments', '[]'::jsonb,
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from invoice_notes n where n.invoice_id = p_invoice), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from invoice_expenses e where e.invoice_id = p_invoice), '[]'::jsonb),
    'source', 'quote_hire', 'revision_id', v_rev.id) into v_snapshot;
  insert into quote_backups (invoice_id, invoice_code, snapshot) values (p_invoice, v_inv.invoice_code, v_snapshot);

  perform pg_advisory_xact_lock(hashtext('ride_codes'));
  if v_inv.ride_id is not null then
    select * into v_ride from rides where id = v_inv.ride_id for update;
    if v_ride.is_quote then
      v_old_code := v_ride.project_code;
      v_new_code := alloc_ride_code('US');
      update rides set project_code = v_new_code, is_quote = false, updated_at = now() where id = v_ride.id;
      insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
      values ('quote-hire', 'rides', v_ride.id::text, 'project_code', v_old_code, v_new_code, 'quote portal hire ' || p_attempt);
      for r in select id, invoice_code from invoices where ride_id = v_ride.id and invoice_code like v_old_code || '.%' loop
        update invoices set invoice_code = v_new_code || substr(r.invoice_code, length(v_old_code) + 1), updated_at = now() where id = r.id;
        insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
        values ('quote-hire', 'invoices', r.id::text, 'invoice_code', r.invoice_code, v_new_code || substr(r.invoice_code, length(v_old_code) + 1),
                'quote portal hire ' || p_attempt);
      end loop;
    end if;
  end if;
  select * into v_client from clients where id = coalesce(v_inv.client_id, v_ride.client_id) for update;
  if v_client.id is not null and v_client.is_quote then
    if v_client.name like 'GZ28 TEST%' then
      v_num := v_client.client_number;   -- a TEST client keeps its own number: it never takes (or pushes) a real project number
    else
      select coalesce(max(client_number), 0) + 1 into v_num from clients where is_quote = false and origin is not distinct from v_client.origin
         and name not like 'GZ28 TEST%';
    end if;
    update clients set client_number = v_num, is_quote = false, updated_at = now() where id = v_client.id;
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    values ('quote-hire', 'clients', v_client.id::text, 'client_number', v_client.client_number::text, v_num::text, 'quote portal hire ' || p_attempt);
    if v_inv.ride_id is null then
      v_old_pad := lpad(coalesce(v_client.client_number, 0)::text, greatest(3, length(coalesce(v_client.client_number, 0)::text)), '0');
      v_new_pad := lpad(v_num::text, greatest(3, length(v_num::text)), '0');
      for r in select id, invoice_code from invoices where client_id = v_client.id and ride_id is null and invoice_code like v_old_pad || '.%' loop
        update invoices set invoice_code = v_new_pad || substr(r.invoice_code, length(v_old_pad) + 1), updated_at = now() where id = r.id;
        insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
        values ('quote-hire', 'invoices', r.id::text, 'invoice_code', r.invoice_code, v_new_pad || substr(r.invoice_code, length(v_old_pad) + 1),
                'quote portal hire ' || p_attempt);
      end loop;
    end if;
  end if;

  update invoices set is_quote = false, hiring_date = v_paid_on,
         client_hiring_date = case when ride_id is null then v_paid_on else client_hiring_date end,
         live_status = 'REALTIME', feed_status = 'REAL_TIME', updated_at = now()
   where id = p_invoice;

  -- o PLANO vira dinheiro (só num documento sem renda nenhuma)
  if exists (select 1 from invoice_incomes where invoice_id = p_invoice) then
    raise exception 'quote_hire: the quote already has incomes (C-07 broken upstream)';
  end if;
  v_n := jsonb_array_length(v_rev.document -> 'installments');
  v_amounts := '[]'::jsonb;
  for v_inst in select e.v from jsonb_array_elements(v_rev.document -> 'installments') as e(v) order by (e.v ->> 'seq')::int loop
    v_label := coalesce(v_inst ->> 'label_text', v_inst ->> 'label', v_inst ->> 'label_key');
    insert into invoice_incomes (invoice_id, amount, description, payment_date, date_label, paid_to, installment_id, paid_at, reported_at, created_at, updated_at)
    values (p_invoice, round((v_inst ->> 'amount_cents')::numeric / 100, 2), v_label,
      case v_inst ->> 'due_rule' when 'ON_APPROVAL' then v_paid_on when 'DATE' then (v_inst ->> 'due_date')::date
                                 when 'NET_DAYS' then v_paid_on + (v_inst ->> 'net_days')::int else null end,
      case v_inst ->> 'due_rule' when 'ON_ARRIVAL' then 'ARRIVAL' when 'ON_CONCLUSION' then 'CONCLUSION' else null end,
      v_inst ->> 'paid_to', (v_inst ->> 'id')::uuid, null, case when p_muted then now() end, now(), now())
    returning id into v_income;
    if (v_inst ->> 'seq')::int = v_att.seq then v_target := v_income; end if;
    v_amounts := v_amounts || to_jsonb(round((v_inst ->> 'amount_cents')::numeric / 100, 2));
  end loop;
  if v_target is null then raise exception 'quote_hire: paid seq % not in the plan', v_att.seq; end if;
  perform income_settle(v_target, p_money, p_attempt, p_muted);
  perform attempt_mark_succeeded(p_attempt, v_target, p_money);
  if not p_muted and coalesce((p_money ->> 'livemode')::boolean, false) then
    perform stripe_fee_row(p_invoice, p_money, 'installment ' || v_att.seq || '/' || v_n);
  end if;
  perform doc_event(p_invoice, v_rev.id, 'HIRED', 'SYSTEM', p_actor, jsonb_build_object('old_code', coalesce(v_old_code, v_inv.invoice_code),
    'new_code', v_new_code, 'invoice_code_before', v_inv.invoice_code, 'attempt_id', p_attempt, 'revision_id', v_rev.id,
    'plan', jsonb_build_object('n', v_n, 'amounts', v_amounts), 'client_number', v_num));
  perform doc_event(p_invoice, v_rev.id, 'DEPOSIT_RECEIVED', case when v_att.provider = 'STRIPE' then 'STRIPE' else 'STAFF' end, p_actor,
    jsonb_build_object('attempt_id', p_attempt, 'income_id', v_target, 'amount_cents', p_money ->> 'amount_cents', 'source', p_money ->> 'source', 'paid_on', v_paid_on));
  return jsonb_build_object('hired', true, 'old_code', v_old_code, 'new_code', v_new_code,
    'invoice_code', (select invoice_code from invoices where id = p_invoice), 'income_id', v_target, 'client_number', v_num);
end $function$;
update public.clients set client_number = 9999, is_quote = true, updated_at = now() where id = '3801471b-11d3-450c-9324-0a60d17aece1' and name like 'GZ28 TEST%' and client_number = 68;
update public.invoices set invoice_code = '9999.84241', updated_at = now() where id = '9780f946-f7f5-4e43-8f54-60238eae1308' and invoice_code = '068.84241';
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values
 ('quote-portal-test', 'clients', '3801471b-11d3-450c-9324-0a60d17aece1', 'client_number', '68', '9999', 'test client restored after the CO harness hire (patch2)'),
 ('quote-portal-test', 'invoices', '9780f946-f7f5-4e43-8f54-60238eae1308', 'invoice_code', '068.84241', '9999.84241', 'preview fixture code restored (patch2)');
commit;
