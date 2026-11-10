-- SEED_TERMS no app US = quote US NORMAL (Márcio 10/11/2026, via Parts Chasing, caso US.QT.076.1 Alex Aguiar: «esquece qualquer
-- vínculo ao BR nesta quote, quote do US normal»). Cliente do BRASIL era semeado com idioma pt, rails {PIX_BR} e plano paid_to GZ28BR.
-- Agora: idioma en, rails padrão US (Angola segue {card,WIRE}), paid_to sempre GZ28US. Só quote NOVA; termos já gravados não mudam.
create or replace function public.seed_terms(p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_country text; v_lang text; v_rails text[]; v_paid_to text; v_seeded_terms boolean := false; v_seeded_plan boolean := false;
begin
  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null then raise exception 'seed_terms: invoice % not found', p_invoice; end if;
  select upper(coalesce(c.country, '')) into v_country from clients c
   where c.id = coalesce(v_inv.client_id, (select client_id from rides where id = v_inv.ride_id));
  v_lang := 'en';                                         -- app US: English, whatever the client's country
  v_rails := case v_country when 'ANGOLA' then '{card,WIRE}'::text[] else '{us_bank_account,card,ZELLE,WIRE}'::text[] end;
  v_paid_to := 'GZ28US';                                  -- app US: never GZ28BR
  if not exists (select 1 from invoice_terms where invoice_id = p_invoice) then
    insert into invoice_terms (invoice_id, rails, language, consent_version)
    values (p_invoice, v_rails, v_lang, 'terms-' || v_lang || '-v1-2026-11');
    v_seeded_terms := true;
  end if;
  if not exists (select 1 from invoice_installments where invoice_id = p_invoice)
     and not (v_inv.is_quote is false and exists (select 1 from invoice_incomes where invoice_id = p_invoice)) then
    insert into invoice_installments (invoice_id, seq, kind, label_key, pct, due_rule, paid_to) values
      (p_invoice, 1, 'DEPOSIT', 'DEPOSIT', 50, 'ON_APPROVAL', v_paid_to),
      (p_invoice, 2, 'BALANCE', 'CONCLUSION', 50, 'ON_CONCLUSION', v_paid_to);
    v_seeded_plan := true;
  end if;
  if v_seeded_terms or v_seeded_plan then
    perform doc_event(p_invoice, null, 'CREATED', 'SYSTEM', null, jsonb_build_object('terms', v_seeded_terms, 'plan', v_seeded_plan, 'language', v_lang));
  end if;
  return jsonb_build_object('terms', v_seeded_terms, 'plan', v_seeded_plan);
end $$;
