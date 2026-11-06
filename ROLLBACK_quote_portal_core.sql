-- ROLLBACK de MIGRATION_quote_portal_core.sql (06/11/2026). Só rodar se o portal for abandonado: apaga as tabelas novas (com o que tiverem).
-- Ordem: gatilhos → funções → colunas em tabelas existentes → tabelas novas. Chaves app_settings e o bucket ficam (inofensivos).
begin;
drop trigger if exists trg_incomes_no_quote on public.invoice_incomes;
drop trigger if exists trg_plan_row_no_delete on public.invoice_incomes;
drop trigger if exists trg_incomes_plan_guard on public.invoice_incomes;
drop trigger if exists trg_invoices_quote_flip on public.invoices;
drop trigger if exists trg_lock_presented_lines on public.invoices;
drop trigger if exists trg_lock_presented_lines on public.invoice_items;
drop trigger if exists trg_lock_presented_lines on public.invoice_services;
drop function if exists public.book_payment(uuid,jsonb,text), public.quote_hire(uuid,uuid,jsonb,boolean,text), public.attempt_mark_succeeded(uuid,uuid,jsonb),
  public.stripe_fee_row(uuid,jsonb,text), public.income_settle(uuid,jsonb,uuid,boolean), public.attempt_open(uuid,uuid,int,text,text,boolean,text,bigint),
  public.quote_approve(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,text,text,inet,text,text,text,text), public.quote_revision_supersede(uuid,text),
  public.quote_send(uuid,text,text,text,int,jsonb,text,text,text,numeric,numeric,text,boolean), public.seed_terms(uuid), public.alloc_ride_code(text),
  public.quote_void(uuid,text), public.quote_extend(uuid,int,text), public.quote_expire(uuid), public.quote_rotate_link(uuid,text), public.gate_unlock(uuid,text),
  public.gate_fail(uuid,text), public.public_hit(text,text,text,timestamptz), public.stripe_claim(text,text,boolean,jsonb), public.doc_event(uuid,uuid,text,text,text,jsonb);
alter table public.invoice_incomes drop column if exists attempt_id, drop column if exists installment_id, drop column if exists refund_id, drop column if exists payment_reference;
alter table public.invoice_expenses drop column if exists payment_reference;
alter table public.invoice_notes drop column if exists client_visible;
alter table public.clients drop column if exists stripe_customer_ids;
alter table public.stripe_events drop column if exists locked_at, drop column if exists attempts;
drop index if exists public.invoice_expenses_stripe_txn_uidx;
drop table if exists public.payment_attempts, public.invoice_events, public.invoice_client_notes, public.invoice_approvals, public.quote_gate_fails,
  public.public_hits;
drop view if exists public.quote_links_public;
drop table if exists public.quote_links, public.invoice_revisions, public.invoice_installments, public.invoice_terms;
drop function if exists public.live_revision(uuid), public.trg_incomes_no_quote_fn(), public.trg_invoices_quote_flip_fn(), public.trg_plan_row_no_delete_fn(),
  public.trg_incomes_plan_guard_fn(), public.trg_append_only_fn(), public.trg_lock_presented_lines_fn(), public.trg_approval_binds_revision_fn(),
  public.trg_quote_links_is_test_fn(), public.gz28_escape(text), public.orlando_noon(date), public.orlando_today();
commit;
