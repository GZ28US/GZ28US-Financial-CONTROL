-- PARTIAL PAYMENT KEEPS THE REMAINDER OPEN (Márcio, 11/11/2026: «fix the other two too» — AutoBook's finding on Alex Aguiar 068.1).
-- book_payment() = the live definition of 11/11 + one block before income_settle: paying less than the open income splits it —
-- the paid part is settled, the rest stays as an open row of the same installment. Nothing else changes.
begin;
CREATE OR REPLACE FUNCTION public.book_payment(p_attempt uuid, p_money jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_inv_id uuid; v_inv invoices; v_att payment_attempts; v_link quote_links; v_muted boolean;
        v_target uuid; v_anomaly text; v_n int; v_open numeric; v_pay numeric;
begin
  select invoice_id into v_inv_id from payment_attempts where id = p_attempt;
  if v_inv_id is null then raise exception 'book_payment: attempt % not found', p_attempt; end if;
  select * into v_inv from invoices where id = v_inv_id for update;
  perform pg_advisory_xact_lock(hashtext('attempt:' || p_attempt));
  select * into v_att from payment_attempts where id = p_attempt for update;
  select * into v_link from quote_links where invoice_id = v_inv_id order by (revoked_at is null) desc, created_at desc limit 1;

  -- 1a. repetição benigna (mesma sessão/PI) × replay de verdade
  if v_att.status = 'SUCCEEDED' and v_att.income_id is not null
     and ((p_money ->> 'checkout_session_id') is not null and v_att.checkout_session_id = (p_money ->> 'checkout_session_id')
          or (p_money ->> 'payment_intent_id') is not null and v_att.payment_intent_id = (p_money ->> 'payment_intent_id')) then
    return jsonb_build_object('income_id', v_att.income_id, 'repeat', true);
  end if;
  if v_att.status in ('SUCCEEDED','SUCCEEDED_UNBOOKED') then
    perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', 'replay', 'attempt_id', p_attempt,
      'session', p_money ->> 'checkout_session_id'));
    return jsonb_build_object('anomaly', 'replay');
  end if;
  if not (v_att.status in ('OPEN','PROCESSING') or (v_att.status = 'EXPIRED' and coalesce(p_money ->> 'payment_status', '') = 'paid')) then
    perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', 'attempt_status', 'status', v_att.status, 'attempt_id', p_attempt));
    return jsonb_build_object('anomaly', 'attempt_status');
  end if;
  if v_att.status = 'EXPIRED' then v_anomaly := 'booked_after_expiry'; end if;

  -- 1b. recusas que ESCREVEM e devolvem (nunca raise: um raise desfaria o rastro)
  if v_link.id is not null and v_link.revoked_at is not null then
    v_anomaly := 'voided';
  elsif v_att.provider = 'STRIPE' and coalesce((p_money ->> 'livemode')::boolean, false) = false and not coalesce(v_link.is_test, false) then
    v_anomaly := 'test_money_on_live_doc';
  elsif lower(coalesce(p_money ->> 'currency', 'usd')) <> 'usd' then
    v_anomaly := 'currency';
  end if;
  if v_anomaly in ('voided', 'test_money_on_live_doc', 'currency') then
    update payment_attempts set status = 'SUCCEEDED_UNBOOKED', succeeded_at = now(),
      checkout_session_id = coalesce(checkout_session_id, p_money ->> 'checkout_session_id'),
      payment_intent_id = coalesce(payment_intent_id, p_money ->> 'payment_intent_id'), charge_id = coalesce(p_money ->> 'charge_id', charge_id)
     where id = p_attempt;
    perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', v_anomaly, 'attempt_id', p_attempt,
      'amount_cents', p_money ->> 'amount_cents'));
    return jsonb_build_object('anomaly', v_anomaly, 'unbooked', true);
  end if;
  v_muted := coalesce(v_link.is_test, false);
  if v_anomaly is not null then
    perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', v_anomaly, 'attempt_id', p_attempt));
  end if;
  if (p_money ->> 'amount_cents') is not null and (p_money ->> 'amount_cents')::bigint <> v_att.amount_cents then
    perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', 'amount_mismatch', 'attempt_id', p_attempt,
      'expected', v_att.amount_cents, 'received', p_money ->> 'amount_cents'));
  end if;

  -- 2. quote → a contratação
  if v_inv.is_quote then
    return quote_hire(v_inv_id, p_attempt, p_money, v_muted, p_actor) || jsonb_build_object('anomaly', v_anomaly);
  end if;

  -- 3. já é invoice (HIRING DATE legado, RECORD DEPOSIT, SHOP, parcela seguinte)
  if v_att.installment_id is null then
    v_target := (p_money ->> 'income_id')::uuid;
    if v_target is not null and not exists (select 1 from invoice_incomes where id = v_target and invoice_id = v_inv_id and paid_at is null) then
      raise exception 'book_payment: income % is not an open income of this invoice', v_target;
    end if;
    if v_target is null then
      insert into invoice_incomes (invoice_id, amount, description, payment_date, paid_to, paid_at, reported_at, created_at, updated_at)
      values (v_inv_id, round((p_money ->> 'amount_cents')::numeric / 100, 2), coalesce(p_money ->> 'description', 'Payment'),
              (p_money ->> 'paid_on')::date, coalesce(p_money ->> 'paid_to', 'GZ28US'), null, case when v_muted then now() end, now(), now())
      returning id into v_target;
    end if;
  else
    if not exists (select 1 from invoice_incomes where invoice_id = v_inv_id) then
      -- materializa o plano agora (documento sem renda nenhuma) — quantias da revisão aprovada
      insert into invoice_incomes (invoice_id, amount, description, payment_date, date_label, paid_to, installment_id, reported_at, created_at, updated_at)
      select v_inv_id, round((e.v ->> 'amount_cents')::numeric / 100, 2), coalesce(e.v ->> 'label_text', e.v ->> 'label', e.v ->> 'label_key'),
             case e.v ->> 'due_rule' when 'DATE' then (e.v ->> 'due_date')::date else null end,
             case e.v ->> 'due_rule' when 'ON_ARRIVAL' then 'ARRIVAL' when 'ON_CONCLUSION' then 'CONCLUSION' else null end,
             e.v ->> 'paid_to', (e.v ->> 'id')::uuid, case when v_muted then now() end, now(), now()
        from invoice_revisions rv, jsonb_array_elements(rv.document -> 'installments') as e(v) where rv.id = v_att.revision_id;
    end if;
    select id into v_target from invoice_incomes where invoice_id = v_inv_id and installment_id = v_att.installment_id and paid_at is null
     order by created_at limit 1;
    if v_target is null then
      select i.id into v_target from invoice_incomes i join invoice_installments s on s.id = i.installment_id
       where i.invoice_id = v_inv_id and i.paid_at is null and i.amount > 0 order by s.seq limit 1;
      v_anomaly := coalesce(v_anomaly, 'applied_to_next');
      if v_target is null then
        insert into invoice_incomes (invoice_id, amount, description, payment_date, paid_to, reported_at, created_at, updated_at)
        values (v_inv_id, round((p_money ->> 'amount_cents')::numeric / 100, 2), 'Overpayment — hold', (p_money ->> 'paid_on')::date,
                coalesce(p_money ->> 'paid_to', 'GZ28US'), case when v_muted then now() end, now(), now())
        returning id into v_target;
        v_anomaly := 'overpayment_hold';
      end if;
      perform doc_event(v_inv_id, v_att.revision_id, 'PAYMENT_ANOMALY', 'STRIPE', p_actor, jsonb_build_object('anomaly', v_anomaly, 'attempt_id', p_attempt, 'income_id', v_target));
    end if;
  end if;
  -- 11/11/2026 PARTIAL PAYMENT (AutoBook: a full payment that came as two Zelles, 2,000.00 + 120.05, had no clean path — the first
  -- one overwrote the installment's amount and the second fell into «Overpayment — hold»). Paying LESS than the open income keeps
  -- the REMAINDER open: a new unpaid row with the same installment / label / due date. The next payment of that installment finds it.
  select amount into v_open from invoice_incomes where id = v_target;
  v_pay := round((p_money ->> 'amount_cents')::numeric / 100, 2);
  if v_pay is not null and v_pay > 0 and v_open - v_pay > 0.01 then
    insert into invoice_incomes (invoice_id, amount, description, payment_date, date_label, paid_to, installment_id, reported_at, created_at, updated_at)
    select invoice_id, v_open - v_pay, description, payment_date, date_label, paid_to, installment_id, case when v_muted then now() end, now(), now()
      from invoice_incomes where id = v_target;
    perform doc_event(v_inv_id, v_att.revision_id, 'SIDE_EFFECT', 'SYSTEM', p_actor, jsonb_build_object('step', 'partial-payment', 'status', 'done', 'attempt_id', p_attempt,
      'income_id', v_target, 'paid', v_pay, 'remainder', v_open - v_pay));
  end if;
  perform income_settle(v_target, p_money, p_attempt, v_muted);
  perform attempt_mark_succeeded(p_attempt, v_target, p_money);
  if not v_muted and coalesce((p_money ->> 'livemode')::boolean, false) then
    select count(*) into v_n from invoice_installments where invoice_id = v_inv_id;
    perform stripe_fee_row(v_inv_id, p_money, 'installment ' || coalesce(v_att.seq::text, '?') || '/' || v_n);
  end if;
  perform doc_event(v_inv_id, v_att.revision_id, 'INSTALLMENT_RECEIVED', case when v_att.provider = 'STRIPE' then 'STRIPE' else 'STAFF' end, p_actor,
    jsonb_build_object('attempt_id', p_attempt, 'income_id', v_target, 'seq', v_att.seq, 'amount_cents', p_money ->> 'amount_cents', 'source', p_money ->> 'source'));
  if v_target is null then raise exception 'book_payment: nothing booked'; end if;
  return jsonb_build_object('income_id', v_target, 'anomaly', v_anomaly);
end $function$;
commit;
