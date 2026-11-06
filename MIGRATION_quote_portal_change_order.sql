-- QUOTE PORTAL M4 — CHANGE ORDERS (06/11/2026; blueprint §3.2 T13/T14, §3.5; v1 T13/T14). Two functions, nothing else changes.
--
-- change_order_send(): on a HIRED, SIGNED document, freezes revision n+1 kind CHANGE_ORDER — the approved revision's lines with the
--   staff's delta (lines inserted after the signature, repriced / removed frozen lines), the new totals by law, and the plan in cents
--   (paid installments keep their cents; the LAST UNPAID installment absorbs the difference, C-27/C-32). The approved revision stays
--   as it is (it is still the money — lib/money.ts reads the newest APPROVED revision); live_revision() now returns the CO, so the
--   lock trigger follows the CO's lines and the client's link shows the CO's APPROVE card. A newer CO replaces an unapproved one.
-- change_order_apply(): after the CO is approved (client e-sign on the link, or a shop-recorded approval inside the §559.909 band),
--   writes the CO to the live rows under the gz28.change_order escape: frozen lines take the CO's description/price/quantity, lines
--   the CO removed are DELETED (full row kept in data_fixes; an estornado item — cancel_status set — is never deleted, it already left the money), plan rows take the CO's cents; every older revision is superseded;
--   event CHANGE_ORDER_APPLIED. Idempotent (a second call returns {applied:false, reason:'already applied'}).
begin;

create or replace function public.change_order_send(p_invoice uuid, p_actor text, p_document jsonb, p_sha256 text, p_presented_sha256 text,
  p_terms_sha256 text, p_grand numeric, p_fl_tax numeric, p_fl_status text, p_delta jsonb, p_valid_days int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_live invoice_revisions; v_appr invoice_revisions; v_seq int; v_rev uuid; v_sum bigint; v_missing int; v_until date;
begin
  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null then raise exception 'change_order: invoice not found'; end if;
  if v_inv.is_quote then raise exception 'change_order: still a quote — use NEW REVISION before the signature (409)'; end if;
  if exists (select 1 from payment_attempts where invoice_id = p_invoice and status in ('OPEN','PROCESSING')) then
    raise exception 'change_order: a payment is open (409)';
  end if;
  select r.* into v_appr from invoice_revisions r where r.invoice_id = p_invoice and r.kind in ('QUOTE','CHANGE_ORDER')
     and exists (select 1 from invoice_approvals a where a.revision_id = r.id) order by r.seq desc limit 1;
  if v_appr.id is null then raise exception 'change_order: no approved revision to change (409)'; end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 365 then raise exception 'change_order: valid_days out of range'; end if;
  if p_document ->> 'kind' <> 'CHANGE_ORDER' then raise exception 'change_order: document kind'; end if;
  if round((p_document -> 'totals' ->> 'grand')::numeric, 2) <> round(p_grand, 2) then raise exception 'change_order: grand mismatch'; end if;
  select coalesce(sum((e.v ->> 'amount_cents')::bigint), 0) into v_sum from jsonb_array_elements(p_document -> 'installments') as e(v);
  if v_sum <> round(p_grand * 100) then raise exception 'change_order: plan cents % <> grand cents %', v_sum, round(p_grand * 100); end if;
  if exists (select 1 from jsonb_array_elements(p_document -> 'installments') as e(v) where (e.v ->> 'amount_cents')::bigint <= 0) then
    raise exception 'change_order: an installment would be zero or negative';
  end if;
  select count(*) into v_missing from jsonb_array_elements(p_document -> 'lines') as l(v)
   where not exists (select 1 from invoice_items i where i.id::text = l.v ->> 'id' and i.invoice_id = p_invoice)
     and not exists (select 1 from invoice_services s where s.id::text = l.v ->> 'id' and s.invoice_id = p_invoice);
  if v_missing > 0 then raise exception 'change_order: % line(s) do not exist', v_missing; end if;

  v_live := live_revision(p_invoice);
  if v_live.id is not null and v_live.kind = 'CHANGE_ORDER' and not exists (select 1 from invoice_approvals where revision_id = v_live.id) then
    update invoice_revisions set superseded_at = now() where id = v_live.id;          -- a newer CO replaces the unapproved one
    perform doc_event(p_invoice, v_live.id, 'REVISION_SUPERSEDED', 'STAFF', p_actor, jsonb_build_object('seq', v_live.seq, 'by_change_order', true));
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from invoice_revisions where invoice_id = p_invoice;
  v_until := orlando_today() + p_valid_days;
  insert into invoice_revisions (invoice_id, seq, kind, document, delta, sha256, presented_sha256, terms_sha256, grand_total, fl_tax, fl_tax_status,
    sent_at, sent_channel, sent_to, sent_by_app, created_by)
  values (p_invoice, v_seq, 'CHANGE_ORDER', p_document, p_delta, p_sha256, p_presented_sha256, p_terms_sha256, p_grand, coalesce(p_fl_tax, 0), p_fl_status,
    now(), 'COPY', null, false, p_actor)
  returning id into v_rev;
  update invoice_terms set valid_days = p_valid_days, valid_until = v_until, updated_at = now() where invoice_id = p_invoice;
  perform doc_event(p_invoice, v_rev, 'SENT', 'STAFF', p_actor, jsonb_build_object('seq', v_seq, 'kind', 'CHANGE_ORDER', 'channel', 'COPY',
    'grand_before', v_appr.grand_total, 'grand_after', p_grand));
  return jsonb_build_object('revision_id', v_rev, 'seq', v_seq, 'valid_until', v_until, 'approved_seq', v_appr.seq);
end $$;

create or replace function public.change_order_apply(p_revision uuid, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rev invoice_revisions; v_prev invoice_revisions; v_l jsonb; v_n int; v_n_items int := 0; v_n_svc int := 0; v_n_del int := 0; v_n_plan int := 0;
begin
  select * into v_rev from invoice_revisions where id = p_revision;
  if v_rev.id is null or v_rev.kind <> 'CHANGE_ORDER' then raise exception 'change_order_apply: not a change order'; end if;
  perform 1 from invoices where id = v_rev.invoice_id for update;
  if not exists (select 1 from invoice_approvals where revision_id = v_rev.id) then raise exception 'change_order_apply: not approved (409)'; end if;
  if exists (select 1 from invoice_events where invoice_id = v_rev.invoice_id and revision_id = v_rev.id and kind = 'CHANGE_ORDER_APPLIED') then
    return jsonb_build_object('applied', false, 'reason', 'already applied');
  end if;
  if v_rev.superseded_at is not null then raise exception 'change_order_apply: revision superseded (409)'; end if;
  select r.* into v_prev from invoice_revisions r where r.invoice_id = v_rev.invoice_id and r.seq < v_rev.seq and r.kind in ('QUOTE','CHANGE_ORDER')
     and exists (select 1 from invoice_approvals a where a.revision_id = r.id) order by r.seq desc limit 1;

  perform set_config('gz28.change_order', gen_random_uuid()::text, true);
  -- 1. lines the CO keeps: take its description / price / quantity
  for v_l in select * from jsonb_array_elements(v_rev.document -> 'lines') loop
    if v_l ->> 'kind' = 'item' then
      update invoice_items set description = v_l ->> 'description', unit_price = (v_l ->> 'unit_price')::numeric, quantity = (v_l ->> 'quantity')::numeric
       where id = (v_l ->> 'id')::uuid and invoice_id = v_rev.invoice_id
         and (description, unit_price::numeric, quantity::numeric) is distinct from (v_l ->> 'description', (v_l ->> 'unit_price')::numeric, (v_l ->> 'quantity')::numeric);
      if found then v_n_items := v_n_items + 1; end if;
    else
      update invoice_services set description = v_l ->> 'description', price = (v_l ->> 'unit_price')::numeric
       where id = (v_l ->> 'id')::uuid and invoice_id = v_rev.invoice_id
         and (description, price::numeric) is distinct from (v_l ->> 'description', (v_l ->> 'unit_price')::numeric);
      if found then v_n_svc := v_n_svc + 1; end if;
    end if;
  end loop;
  -- 2. lines the previous approved revision had and the CO removed: trail the whole row, then delete
  if v_prev.id is not null then
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select 'change-order', t.tbl, t.id, 'rows', t.j, null, 'CO rev ' || v_rev.seq || ' removed · ' || p_actor from (
      select 'invoice_items' tbl, i.id::text id, to_jsonb(i)::text j from invoice_items i
       where i.invoice_id = v_rev.invoice_id and i.cancel_status is null   -- an estornado line STAYS on the invoice (lib/estorno.ts law)
         and exists (select 1 from jsonb_array_elements(v_prev.document -> 'lines') p(v) where p.v ->> 'id' = i.id::text)
         and not exists (select 1 from jsonb_array_elements(v_rev.document -> 'lines') c(v) where c.v ->> 'id' = i.id::text)
      union all
      select 'invoice_services', s.id::text, to_jsonb(s)::text from invoice_services s
       where s.invoice_id = v_rev.invoice_id
         and exists (select 1 from jsonb_array_elements(v_prev.document -> 'lines') p(v) where p.v ->> 'id' = s.id::text)
         and not exists (select 1 from jsonb_array_elements(v_rev.document -> 'lines') c(v) where c.v ->> 'id' = s.id::text)
    ) t;
    delete from invoice_items i where i.invoice_id = v_rev.invoice_id and i.cancel_status is null
       and exists (select 1 from jsonb_array_elements(v_prev.document -> 'lines') p(v) where p.v ->> 'id' = i.id::text)
       and not exists (select 1 from jsonb_array_elements(v_rev.document -> 'lines') c(v) where c.v ->> 'id' = i.id::text);
    get diagnostics v_n_del = row_count;
    delete from invoice_services s where s.invoice_id = v_rev.invoice_id
       and exists (select 1 from jsonb_array_elements(v_prev.document -> 'lines') p(v) where p.v ->> 'id' = s.id::text)
       and not exists (select 1 from jsonb_array_elements(v_rev.document -> 'lines') c(v) where c.v ->> 'id' = s.id::text);
    get diagnostics v_n = row_count; v_n_del := v_n_del + v_n;
  end if;
  -- 3. the plan takes the CO's cents (fixed amounts from now on)
  for v_l in select * from jsonb_array_elements(v_rev.document -> 'installments') loop
    update invoice_installments set amount = round((v_l ->> 'amount_cents')::numeric / 100, 2), pct = null
     where id = (v_l ->> 'id')::uuid and invoice_id = v_rev.invoice_id
       and (amount is distinct from round((v_l ->> 'amount_cents')::numeric / 100, 2) or pct is not null);
    if found then v_n_plan := v_n_plan + 1; end if;
  end loop;
  -- 4. every older revision is history now; the CO is the live (and approved) one
  update invoice_revisions set superseded_at = now() where invoice_id = v_rev.invoice_id and seq < v_rev.seq and superseded_at is null and kind in ('QUOTE','CHANGE_ORDER');
  perform set_config('gz28.change_order', '', true);
  perform doc_event(v_rev.invoice_id, v_rev.id, 'CHANGE_ORDER_APPLIED', 'STAFF', p_actor, jsonb_build_object('seq', v_rev.seq,
    'items', v_n_items, 'services', v_n_svc, 'removed_lines', v_n_del, 'plan_rows', v_n_plan, 'delta', v_rev.delta));
  return jsonb_build_object('applied', true, 'seq', v_rev.seq, 'items', v_n_items, 'services', v_n_svc, 'removed_lines', v_n_del, 'plan_rows', v_n_plan);
end $$;

revoke all on function public.change_order_send(uuid, text, jsonb, text, text, text, numeric, numeric, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.change_order_send(uuid, text, jsonb, text, text, text, numeric, numeric, text, jsonb, int) to service_role;
revoke all on function public.change_order_apply(uuid, text) from public, anon, authenticated;
grant execute on function public.change_order_apply(uuid, text) to service_role;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m4', 'functions', 'change_order_send,change_order_apply', 'migration', null, 'created', 'MIGRATION_quote_portal_change_order.sql');
commit;
