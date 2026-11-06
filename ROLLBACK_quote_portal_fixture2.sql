-- ROLLBACK of MIGRATION_quote_portal_fixture2.sql: restore the stricter guard (test link required).
-- QUOTE PORTAL — fixture_delete() (06/11/2026, blueprint §4.3 #19, RO-07). Apaga UM documento de TESTE do portal, e só de teste:
-- exige quote_links.is_test no documento (o gatilho trg_quote_links_is_test só deixa is_test num cliente «GZ28 TEST%»).
-- Antes de apagar, grava em data_fixes o JSON INTEIRO de cada linha (label = p_label). Ordem de FK: approvals → events → notas do
-- cliente → attempts → incomes → revisions → itens/serviços/notas/expenses → plano/termos/gate/links → backups → invoice → cliente
-- de teste (se não tiver mais nada). Abre o escape gz28.test_cleanup só dentro desta transação (nonce). Não toca em nada real.
begin;
create or replace function public.fixture_delete(p_invoice uuid, p_label text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_client uuid; v_counts jsonb := '{}'::jsonb; v_n int; v_lbl text := coalesce(nullif(p_label, ''), 'quote-portal-test');
begin
  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null then return jsonb_build_object('deleted', false, 'reason', 'not found'); end if;
  if not exists (select 1 from quote_links where invoice_id = p_invoice and is_test) then
    raise exception 'fixture_delete: % is not a TEST document — refused', v_inv.invoice_code;
  end if;
  v_client := coalesce(v_inv.client_id, (select client_id from rides where id = v_inv.ride_id));
  if v_inv.ride_id is not null then raise exception 'fixture_delete: test documents never have a car — refused'; end if;
  perform set_config('gz28.test_cleanup', gen_random_uuid()::text, true);
  update payment_attempts set status = 'VOIDED_TEST' where invoice_id = p_invoice;
  update quote_links set revoked_at = coalesce(revoked_at, now()) where invoice_id = p_invoice;

  insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
  select 'quote-portal-test', t.tbl, p_invoice::text, 'rows', t.j::text, null, v_lbl from (
    select 'invoices' tbl, (select jsonb_agg(to_jsonb(x)) from invoices x where x.id = p_invoice) j union all
    select 'invoice_approvals', (select jsonb_agg(to_jsonb(x)) from invoice_approvals x where x.invoice_id = p_invoice) union all
    select 'invoice_events', (select jsonb_agg(to_jsonb(x)) from invoice_events x where x.invoice_id = p_invoice) union all
    select 'invoice_client_notes', (select jsonb_agg(to_jsonb(x)) from invoice_client_notes x where x.invoice_id = p_invoice) union all
    select 'payment_attempts', (select jsonb_agg(to_jsonb(x) - 'url') from payment_attempts x where x.invoice_id = p_invoice) union all
    select 'invoice_incomes', (select jsonb_agg(to_jsonb(x)) from invoice_incomes x where x.invoice_id = p_invoice) union all
    select 'invoice_revisions', (select jsonb_agg(to_jsonb(x)) from invoice_revisions x where x.invoice_id = p_invoice) union all
    select 'invoice_items', (select jsonb_agg(to_jsonb(x)) from invoice_items x where x.invoice_id = p_invoice) union all
    select 'invoice_services', (select jsonb_agg(to_jsonb(x)) from invoice_services x where x.invoice_id = p_invoice) union all
    select 'invoice_notes', (select jsonb_agg(to_jsonb(x)) from invoice_notes x where x.invoice_id = p_invoice) union all
    select 'invoice_expenses', (select jsonb_agg(to_jsonb(x)) from invoice_expenses x where x.invoice_id = p_invoice) union all
    select 'invoice_installments', (select jsonb_agg(to_jsonb(x)) from invoice_installments x where x.invoice_id = p_invoice) union all
    select 'invoice_terms', (select jsonb_agg(to_jsonb(x)) from invoice_terms x where x.invoice_id = p_invoice) union all
    select 'quote_links', (select jsonb_agg(to_jsonb(x) - 'token') from quote_links x where x.invoice_id = p_invoice)
  ) t where t.j is not null;

  delete from invoice_approvals where invoice_id = p_invoice;
  delete from invoice_events where invoice_id = p_invoice;
  delete from invoice_client_notes where invoice_id = p_invoice;
  update invoice_incomes set attempt_id = null where invoice_id = p_invoice;
  delete from payment_attempts where invoice_id = p_invoice;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('attempts', v_n);
  delete from invoice_incomes where invoice_id = p_invoice;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('incomes', v_n);
  delete from invoice_revisions where invoice_id = p_invoice;
  delete from invoice_items where invoice_id = p_invoice;
  delete from invoice_services where invoice_id = p_invoice;
  delete from invoice_notes where invoice_id = p_invoice;
  delete from invoice_expenses where invoice_id = p_invoice;
  delete from invoice_installments where invoice_id = p_invoice;
  delete from invoice_terms where invoice_id = p_invoice;
  delete from quote_gate_fails where link_id in (select id from quote_links where invoice_id = p_invoice);
  update quote_links set rotated_from = null where invoice_id = p_invoice;
  delete from quote_links where invoice_id = p_invoice;
  delete from quote_backups where invoice_id = p_invoice;
  delete from invoices where id = p_invoice;
  if v_client is not null and not exists (select 1 from invoices where client_id = v_client)
     and not exists (select 1 from rides where client_id = v_client)
     and exists (select 1 from clients where id = v_client and name like 'GZ28 TEST%') then
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    select 'quote-portal-test', 'clients', v_client::text, 'rows', to_jsonb(c)::text, null, v_lbl from clients c where c.id = v_client;
    delete from clients where id = v_client;
    v_counts := v_counts || jsonb_build_object('client', true);
  end if;
  perform set_config('gz28.test_cleanup', '', true);
  return jsonb_build_object('deleted', true, 'code', v_inv.invoice_code) || v_counts;
end $$;
revoke all on function public.fixture_delete(uuid, text) from public, anon, authenticated;
grant execute on function public.fixture_delete(uuid, text) to service_role;
commit;
