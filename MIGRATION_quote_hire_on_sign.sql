-- QUOTE → INVOICE AT THE SIGNATURE (Márcio, 11/11/2026: «whenever a client signs/agree to a quote, the app should send me an email
-- with this report... That'd be the official report that the quote has been approved and hired. At this point, it must become a
-- real invoice, with the hiring date. do it.»).
-- Until today the hire happened with the FIRST MONEY (book_payment → quote_hire). Now the approval itself hires:
--   • quote_hire_signed(): the hire without money — backup, real ride/client/invoice codes, is_quote=false, hiring_date = the
--     Orlando day of the approval, and the PLAN becomes open (unpaid) invoice_incomes. Event HIRED {by: 'SIGNATURE'}.
--   • quote_approve(): same as before + calls quote_hire_signed() in the SAME transaction (a change order never hires).
--   • money that arrives later walks book_payment step 3 («já é invoice») and settles the installment's open income.
--   • quote_hire() stays as it was (nothing calls it for a new signature; 0 signed-and-still-quote documents on 11/11).
-- Also fixes the AutoBook finding of 11/11: a ride-less quote whose code carries the «US.QT.» prefix (US.QT.076.1) was not
-- recoded (the loop only matched '076.%'). Here both forms are recoded: US.QT.076.1 / 076.1 → 068.1.
begin;

create or replace function public.quote_hire_signed(p_invoice uuid, p_revision uuid, p_actor text) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare v_inv invoices; v_rev invoice_revisions; v_ride rides; v_client clients;
        v_old_code text; v_new_code text; v_on date; r record; v_inst jsonb; v_num int; v_old_pad text; v_new_pad text; v_new text;
        v_n int; v_amounts jsonb; v_label text; v_snapshot jsonb; v_muted boolean;
begin
  select * into v_inv from invoices where id = p_invoice;                     -- locked by quote_approve
  if not v_inv.is_quote then return jsonb_build_object('hired', false, 'reason', 'not a quote'); end if;
  select * into v_rev from invoice_revisions where id = p_revision and invoice_id = p_invoice;
  if v_rev.id is null or not exists (select 1 from invoice_approvals where revision_id = v_rev.id) then
    raise exception 'quote_hire_signed: no approval bound to the revision';
  end if;
  if v_rev.kind = 'CHANGE_ORDER' then return jsonb_build_object('hired', false, 'reason', 'change order'); end if;
  v_on := (now() at time zone 'America/New_York')::date;
  v_muted := exists (select 1 from quote_links where invoice_id = p_invoice and is_test);

  -- C-10: the original quote is kept (before any change)
  select jsonb_build_object(
    'invoice', to_jsonb(v_inv),
    'parts', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from invoice_items i where i.invoice_id = p_invoice), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from invoice_services s where s.invoice_id = p_invoice), '[]'::jsonb),
    'payments', '[]'::jsonb,
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from invoice_notes n where n.invoice_id = p_invoice), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from invoice_expenses e where e.invoice_id = p_invoice), '[]'::jsonb),
    'source', 'quote_hire_signed', 'revision_id', v_rev.id) into v_snapshot;
  insert into quote_backups (invoice_id, invoice_code, snapshot) values (p_invoice, v_inv.invoice_code, v_snapshot);

  perform pg_advisory_xact_lock(hashtext('ride_codes'));
  if v_inv.ride_id is not null then
    select * into v_ride from rides where id = v_inv.ride_id for update;
    if v_ride.is_quote then
      v_old_code := v_ride.project_code;
      v_new_code := alloc_ride_code('US');
      update rides set project_code = v_new_code, is_quote = false, updated_at = now() where id = v_ride.id;
      insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
      values ('quote-hire', 'rides', v_ride.id::text, 'project_code', v_old_code, v_new_code, 'quote hired at signature ' || p_revision);
      for r in select id, invoice_code from invoices where ride_id = v_ride.id and invoice_code like v_old_code || '.%' loop
        update invoices set invoice_code = v_new_code || substr(r.invoice_code, length(v_old_code) + 1), updated_at = now() where id = r.id;
        insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
        values ('quote-hire', 'invoices', r.id::text, 'invoice_code', r.invoice_code, v_new_code || substr(r.invoice_code, length(v_old_code) + 1),
                'quote hired at signature ' || p_revision);
      end loop;
    end if;
  end if;
  select * into v_client from clients where id = coalesce(v_inv.client_id, v_ride.client_id) for update;
  if v_client.id is not null and v_client.is_quote then
    if v_client.name like 'GZ28 TEST%' then
      v_num := v_client.client_number;   -- a TEST client keeps its own number
    else
      select coalesce(max(client_number), 0) + 1 into v_num from clients where is_quote = false and origin is not distinct from v_client.origin
         and name not like 'GZ28 TEST%';
    end if;
    update clients set client_number = v_num, is_quote = false, updated_at = now() where id = v_client.id;
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    values ('quote-hire', 'clients', v_client.id::text, 'client_number', v_client.client_number::text, v_num::text, 'quote hired at signature ' || p_revision);
    if v_inv.ride_id is null then
      v_old_pad := lpad(coalesce(v_client.client_number, 0)::text, greatest(3, length(coalesce(v_client.client_number, 0)::text)), '0');
      v_new_pad := lpad(v_num::text, greatest(3, length(v_num::text)), '0');
      -- both forms: «076.1» and «US.QT.076.1» (AutoBook, 11/11) → «068.1»
      for r in select id, invoice_code from invoices where client_id = v_client.id and ride_id is null
                and (invoice_code like v_old_pad || '.%' or invoice_code like 'US.QT.' || v_old_pad || '.%') loop
        v_new := v_new_pad || substr(r.invoice_code, position(v_old_pad || '.' in r.invoice_code) + length(v_old_pad));
        update invoices set invoice_code = v_new, updated_at = now() where id = r.id;
        insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
        values ('quote-hire', 'invoices', r.id::text, 'invoice_code', r.invoice_code, v_new, 'quote hired at signature ' || p_revision);
      end loop;
    end if;
  end if;

  update invoices set is_quote = false, hiring_date = v_on,
         client_hiring_date = case when ride_id is null then v_on else client_hiring_date end,
         live_status = 'REALTIME', feed_status = 'REAL_TIME', updated_at = now()
   where id = p_invoice;

  -- the PLAN becomes open receivables (only on a document with no income at all)
  v_n := coalesce(jsonb_array_length(v_rev.document -> 'installments'), 0);
  v_amounts := '[]'::jsonb;
  if not exists (select 1 from invoice_incomes where invoice_id = p_invoice) then
    for v_inst in select e.v from jsonb_array_elements(v_rev.document -> 'installments') as e(v) order by (e.v ->> 'seq')::int loop
      v_label := coalesce(v_inst ->> 'label_text', v_inst ->> 'label', v_inst ->> 'label_key');
      insert into invoice_incomes (invoice_id, amount, description, payment_date, date_label, paid_to, installment_id, paid_at, reported_at, created_at, updated_at)
      values (p_invoice, round((v_inst ->> 'amount_cents')::numeric / 100, 2), v_label,
        case v_inst ->> 'due_rule' when 'ON_APPROVAL' then v_on when 'DATE' then (v_inst ->> 'due_date')::date
                                   when 'NET_DAYS' then v_on + (v_inst ->> 'net_days')::int else null end,
        case v_inst ->> 'due_rule' when 'ON_ARRIVAL' then 'ARRIVAL' when 'ON_CONCLUSION' then 'CONCLUSION' else null end,
        v_inst ->> 'paid_to', (v_inst ->> 'id')::uuid, null, case when v_muted then now() end, now(), now());
      v_amounts := v_amounts || to_jsonb(round((v_inst ->> 'amount_cents')::numeric / 100, 2));
    end loop;
  end if;
  perform doc_event(p_invoice, v_rev.id, 'HIRED', 'SYSTEM', p_actor, jsonb_build_object('by', 'SIGNATURE', 'hiring_date', v_on,
    'old_code', coalesce(v_old_code, v_inv.invoice_code), 'new_code', v_new_code, 'invoice_code_before', v_inv.invoice_code,
    'invoice_code', (select invoice_code from invoices where id = p_invoice), 'revision_id', v_rev.id,
    'plan', jsonb_build_object('n', v_n, 'amounts', v_amounts), 'client_number', v_num));
  return jsonb_build_object('hired', true, 'old_code', v_old_code, 'new_code', v_new_code,
    'invoice_code', (select invoice_code from invoices where id = p_invoice), 'client_number', v_num, 'hiring_date', v_on);
end $function$;

revoke all on function public.quote_hire_signed(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.quote_hire_signed(uuid,uuid,text) to service_role;

create or replace function public.quote_approve(p_invoice uuid, p_link uuid, p_revision uuid, p_sha256 text, p_terms_sha256 text, p_signer_name text, p_signer_contact text, p_consents jsonb, p_attribution jsonb, p_method text, p_recorded_by text, p_ip inet, p_user_agent text, p_note text, p_evidence_url text, p_signature_path text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_rev invoice_revisions; v_terms invoice_terms; v_link quote_links; v_id uuid;
begin
  perform 1 from invoices where id = p_invoice for update;
  v_rev := live_revision(p_invoice);
  if v_rev.id is null or v_rev.id <> p_revision then raise exception 'err_stale: revision is not live'; end if;
  if v_rev.sha256 <> p_sha256 then raise exception 'err_stale: document changed'; end if;
  if v_rev.terms_sha256 <> p_terms_sha256 then raise exception 'err_stale: terms changed'; end if;
  if exists (select 1 from invoice_approvals where revision_id = p_revision) then raise exception 'already approved'; end if;
  select * into v_terms from invoice_terms where invoice_id = p_invoice;
  if p_method = 'CLIENT_ESIGN' then
    select * into v_link from quote_links where id = p_link and invoice_id = p_invoice;
    if v_link.id is null or v_link.revoked_at is not null then raise exception 'link revoked'; end if;
    if p_recorded_by is not null then raise exception 'client e-sign has no recorder'; end if;
  elsif p_recorded_by is null or coalesce(trim(p_note), '') = '' then
    raise exception 'shop-recorded approval needs recorded_by and a note';
  end if;
  insert into invoice_approvals (invoice_id, revision_id, document_sha256, method, signer_name, signer_contact, link_id, consent_version,
    consent_text_sha256, consents, attribution, signature_png_path, ip, user_agent, recorded_by, note, evidence_url)
  values (p_invoice, p_revision, p_sha256, p_method, p_signer_name, coalesce(p_signer_contact, v_rev.sent_to), p_link, v_terms.consent_version,
    p_terms_sha256, coalesce(p_consents, '{}'::jsonb), coalesce(p_attribution, '{}'::jsonb), p_signature_path, p_ip, p_user_agent, p_recorded_by, p_note, p_evidence_url)
  returning id into v_id;
  update invoice_terms set
    disclosure_choice = coalesce(p_consents ->> 'estimate', disclosure_choice),
    disclosure_limit = coalesce((p_consents ->> 'limit_amount')::numeric, disclosure_limit),
    parts_return_choice = coalesce(p_consents ->> 'parts_return', parts_return_choice),
    updated_at = now()
   where invoice_id = p_invoice;
  perform doc_event(p_invoice, p_revision, 'SIGNED', case when p_method = 'CLIENT_ESIGN' then 'CLIENT' else 'STAFF' end,
    coalesce(p_recorded_by, 'client'), jsonb_build_object('approval_id', v_id, 'method', p_method, 'seq', v_rev.seq,
      'gate_tier', p_attribution ->> 'gate_tier'));
  -- 11/11/2026: THE APPROVAL HIRES (same transaction). A change order, or a document that is already an invoice, returns hired=false.
  perform quote_hire_signed(p_invoice, p_revision, coalesce(p_recorded_by, 'client'));
  return v_id;
end $function$;

commit;
