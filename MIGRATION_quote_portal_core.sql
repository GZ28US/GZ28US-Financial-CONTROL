-- QUOTE → INVOICE PORTAL — CORE (06/11/2026, App Development 2; blueprint docs/REDESIGN-QUOTE-INVOICE-DESIGN-v3-2026-11-06.md §4).
-- Ordem do Márcio (06/11 ~04:30, via AutoBook GZ28US): o cliente aprova/assina o quote num link público e paga a 1ª parcela pelo
-- Stripe; o projeto nasce sozinho quando o dinheiro CONFIRMA. Lei da noite: NADA é enviado a ninguém — toda chave nasce false.
--
-- O que este arquivo cria (tudo aditivo; nenhuma linha existente muda de valor):
--   tabelas  invoice_terms · invoice_installments · invoice_revisions · quote_links (+ view quote_links_public) · quote_gate_fails
--            invoice_approvals · invoice_client_notes · invoice_events · payment_attempts · public_hits
--   colunas  invoice_incomes.installment_id/attempt_id/refund_id/payment_reference · invoice_expenses.payment_reference
--            invoice_notes.client_visible · clients.stripe_customer_ids · stripe_events.locked_at/attempts
--   gatilhos trg_incomes_no_quote (C-07) · trg_invoices_quote_flip (C-09, escopo V2) · trg_plan_row_no_delete · trg_incomes_plan_guard
--            trg_append_only · trg_lock_presented_lines (C-16) · trg_approval_binds_revision · trg_quote_links_is_test
--   funções  orlando_today/orlando_noon · live_revision · doc_event · alloc_ride_code · seed_terms · quote_send · quote_revision_supersede
--            quote_approve · attempt_open · income_settle · stripe_fee_row · book_payment · quote_hire · quote_void · quote_extend
--            quote_expire · quote_rotate_link · gate_unlock · gate_fail · public_hit · stripe_claim
--   e        fornecedor «Stripe», bucket privado client-docs, chaves app_settings (TODAS desligadas).
-- fixture_delete() mora em MIGRATION_quote_portal_fixture.sql (apaga linha de teste: pede as duas chaves do roda-sql).
--
-- ESCAPE DOS GATILHOS (GUC): um gatilho só abre quando a função SECURITY DEFINER que chama pôs `gz28.<x>` = um nonce uuid da rodada
-- E current_user é postgres/service_role. Os gatilhos NÃO são security definer, então current_user é quem escreveu: o app logado
-- (authenticated) nunca abre escape nenhum.

begin;

-- ── relógio ─────────────────────────────────────────────────────────────────
create or replace function public.orlando_today() returns date language sql stable
  as $$ select (now() at time zone 'America/New_York')::date $$;
create or replace function public.orlando_noon(d date) returns timestamptz language sql stable
  as $$ select (d + time '12:00') at time zone 'America/New_York' $$;

create or replace function public.gz28_escape(x text) returns boolean language sql stable
  as $$ select coalesce(current_setting('gz28.' || x, true), '') ~ '^[0-9a-f-]{36}$' and current_user in ('postgres', 'service_role') $$;

-- ── tabelas ─────────────────────────────────────────────────────────────────
create table if not exists public.invoice_terms (
  invoice_id uuid primary key references public.invoices(id) on delete cascade,
  valid_days int not null default 30,
  valid_until date,
  fee_policy text not null default 'ABSORB' check (fee_policy in ('ABSORB','GROSS_UP')),
  rails text[] not null check (rails <@ '{card,us_bank_account,ZELLE,WIRE,PIX_BR}'::text[]),
  language text not null check (language in ('en','pt')),
  consent_version text not null,
  estimate_at timestamptz, rate_basis text check (rate_basis in ('FLAT','HOURLY','BOTH')), hourly_rate numeric,
  guarantee_text text, alt_authorizer_name text, alt_authorizer_phone text, storage_charge_daily numeric, intended_payment_method text,
  parts_return_choice text check (parts_return_choice in ('RETURN','INSPECT','NONE')),
  disclosure_choice text check (disclosure_choice in ('REQUEST','LIMIT','WAIVE')), disclosure_limit numeric,
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_installments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  seq smallint not null,
  kind text not null check (kind in ('DEPOSIT','INSTALLMENT','BALANCE')),
  label_key text not null check (label_key in ('DEPOSIT','ARRIVAL','CONCLUSION','CUSTOM')),
  label text,
  pct numeric check (pct > 0 and pct <= 100),
  amount numeric check (amount > 0),
  due_rule text not null check (due_rule in ('ON_APPROVAL','ON_ARRIVAL','ON_CONCLUSION','DATE','NET_DAYS')),
  due_date date, net_days int,
  paid_to text not null check (paid_to in ('GZ28US','GZ28BR')),
  created_at timestamptz not null default now(),
  unique (invoice_id, seq),
  check ((pct is null) <> (amount is null)),
  check ((due_rule <> 'DATE' or due_date is not null) and (due_rule <> 'NET_DAYS' or net_days is not null)
         and (due_rule not in ('ON_ARRIVAL','ON_CONCLUSION') or label_key in ('ARRIVAL','CONCLUSION')))
);

create table if not exists public.invoice_revisions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  seq smallint not null,
  kind text not null check (kind in ('QUOTE','CHANGE_ORDER','LEGACY_BACKUP')),
  document jsonb not null,
  delta jsonb,
  sha256 text not null,
  presented_sha256 text not null,
  terms_sha256 text not null,
  grand_total numeric not null, fl_tax numeric not null, fl_tax_status text not null,
  pdf_path text, pdf_sha256 text,
  sent_at timestamptz,
  sent_channel text check (sent_channel in ('WHATSAPP','EMAIL','SMS','FACEBOOK','INSTAGRAM','COPY','RECORDED')),
  sent_to text, sent_by_app boolean not null default false,
  superseded_at timestamptz,
  created_by text, created_at timestamptz not null default now(),
  unique (invoice_id, seq)
);
create index if not exists invoice_revisions_live_idx on public.invoice_revisions (invoice_id, seq desc) where superseded_at is null;

create table if not exists public.quote_links (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  token text not null unique,
  gate text not null default 'NONE' check (gate in ('NONE','CONTACT')),
  gate_tier text check (gate_tier in ('PHONE4','EMAIL')),
  is_test boolean not null default false,
  created_at timestamptz not null default now(), created_by text,
  revoked_at timestamptz,
  rotated_from uuid references public.quote_links(id),
  first_viewed_at timestamptz, last_viewed_at timestamptz, view_count int not null default 0
);
create unique index if not exists quote_links_one_live_idx on public.quote_links (invoice_id) where revoked_at is null;

create table if not exists public.quote_gate_fails (
  link_id uuid not null references public.quote_links(id) on delete cascade,
  ip_hash text not null,
  fails int not null default 0,
  locked_until timestamptz,
  day date not null default ((now() at time zone 'America/New_York')::date),
  primary key (link_id, ip_hash)
);

create or replace view public.quote_links_public with (security_invoker = false) as
  select id, invoice_id, gate, gate_tier, is_test, created_at, revoked_at, first_viewed_at, last_viewed_at, view_count from public.quote_links;

create table if not exists public.invoice_approvals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  revision_id uuid not null unique references public.invoice_revisions(id),
  document_sha256 text not null,
  method text not null check (method in ('CLIENT_ESIGN','SHOP_PHONE','SHOP_IN_PERSON','SHOP_TEXT','SHOP_EMAIL','LEGACY_HIRING_DATE')),
  signer_name text not null,
  signer_contact text,
  link_id uuid references public.quote_links(id),
  consent_version text not null, consent_text_sha256 text not null, consents jsonb not null,
  attribution jsonb not null default '{}',
  signature_png_path text, ip inet, user_agent text, signed_at timestamptz not null default now(),
  recorded_by text, note text, evidence_url text, signed_pdf_path text, signed_pdf_sha256 text,
  check (method <> 'CLIENT_ESIGN' or (link_id is not null and recorded_by is null))
);

create table if not exists public.invoice_client_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  revision_id uuid references public.invoice_revisions(id) on delete set null,
  kind text not null check (kind in ('CHANGES','DECLINE')),
  text text not null check (length(text) <= 1000),
  reason text, hidden_at timestamptz, hidden_by text,
  ip inet, created_at timestamptz not null default now()
);

create table if not exists public.invoice_events (
  id bigint generated always as identity primary key,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  revision_id uuid references public.invoice_revisions(id) on delete set null,
  kind text not null check (kind in ('CREATED','SENT','REVISION_SUPERSEDED','REVISION_DROPPED','VIEWED','CHANGES_REQUESTED','DECLINED','DECLINE_WITHDRAWN',
    'RENEWAL_REQUESTED','SIGNED','GATE_RESET','GATE_CAP','LINK_COPIED','LINK_ROTATED','LANDING_NO_COOKIE',
    'CHECKOUT_OPENED','RAIL_UNAVAILABLE','DEPOSIT_AUTHORIZED','DEPOSIT_RECEIVED','DEPOSIT_FAILED','HIRED','INSTALLMENT_RECEIVED','PAYMENT_PROMISED',
    'PAYMENT_ANOMALY','REFUND_PENDING','REFUNDED','REFUND_FAILED','DISPUTE_OPENED','DISPUTE_UPDATED','DISPUTE_CLOSED','EXPIRED','EXTENDED','VOIDED',
    'CHANGE_ORDER_APPLIED','SIDE_EFFECT','NOTIFIED','NOTIFY_SKIPPED')),
  actor text not null check (actor in ('CLIENT','STAFF','STRIPE','SYSTEM')),
  actor_id text, ip inet, user_agent text,
  payload jsonb not null default '{}',
  at timestamptz not null default now()
);
create index if not exists invoice_events_inv_at_idx on public.invoice_events (invoice_id, at desc);
create index if not exists invoice_events_kind_at_idx on public.invoice_events (kind, at desc);

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  installment_id uuid references public.invoice_installments(id),
  seq smallint,
  revision_id uuid references public.invoice_revisions(id),
  income_id uuid references public.invoice_incomes(id) on delete set null,
  provider text not null check (provider in ('STRIPE','ZELLE','WIRE','CASH','CHECK','PIX_BR','OTHER')),
  rail text check (rail in ('card','us_bank_account','ZELLE','WIRE','PIX_BR')),
  status text not null check (status in ('OPEN','PROCESSING','SUCCEEDED','SUCCEEDED_UNBOOKED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','DISPUTED','VOIDED_TEST')),
  verification text check (verification in ('instant','microdeposits')),
  amount_cents bigint not null,
  currency text not null default 'usd',
  fee numeric, net numeric, method_type text, method_last4 text, account_holder_type text,
  checkout_session_id text unique, payment_intent_id text unique, charge_id text, balance_transaction_id text,
  refund_ids text[], dispute_id text, payout_id text,
  url text, expires_at timestamptz, livemode boolean not null default false,
  created_at timestamptz not null default now(), authorized_at timestamptz, succeeded_at timestamptz, failed_at timestamptz,
  failure_code text, created_by text,
  check (installment_id is not null or provider <> 'STRIPE')
);
create unique index if not exists payment_attempts_one_open_idx on public.payment_attempts (invoice_id, installment_id)
  where status in ('OPEN','PROCESSING') and installment_id is not null;
create index if not exists payment_attempts_charge_idx on public.payment_attempts (charge_id) where charge_id is not null;
create index if not exists payment_attempts_invoice_idx on public.payment_attempts (invoice_id, created_at desc);

create table if not exists public.public_hits (
  scope text not null check (scope in ('link','ip')),
  key text not null, route text not null, bucket timestamptz not null, n int not null default 0,
  primary key (scope, key, route, bucket)
);

-- ── colunas em tabelas que já existem (aditivas, anuláveis) ────────────────
alter table public.invoice_incomes add column if not exists installment_id uuid references public.invoice_installments(id) on delete set null;
alter table public.invoice_incomes add column if not exists attempt_id uuid references public.payment_attempts(id) on delete set null;
alter table public.invoice_incomes add column if not exists refund_id text unique;
alter table public.invoice_incomes add column if not exists payment_reference text;
alter table public.invoice_expenses add column if not exists payment_reference text;
alter table public.invoice_notes add column if not exists client_visible boolean not null default true;
alter table public.clients add column if not exists stripe_customer_ids jsonb;
alter table public.stripe_events add column if not exists locked_at timestamptz;
alter table public.stripe_events add column if not exists attempts int not null default 0;
create index if not exists invoice_incomes_installment_idx on public.invoice_incomes (installment_id) where installment_id is not null;
create unique index if not exists invoice_expenses_stripe_txn_uidx on public.invoice_expenses (order_number) where payment_method = 'STRIPE';

comment on column public.invoice_incomes.installment_id is 'QUOTE PORTAL 06/11/2026: a linha do PLANO (invoice_installments) que este dinheiro quita; estorno/disputa carregam a da linha revertida.';
comment on column public.invoice_incomes.payment_reference is 'stripe:<charge> · zelle:<conf> — referência, NÃO vínculo com o banco (bank: continua sendo o único vínculo).';

-- ── GRANTs (disciplina da coluna: o token NUNCA é legível por JWT) ─────────
alter table public.invoice_terms enable row level security;
alter table public.invoice_installments enable row level security;
alter table public.invoice_revisions enable row level security;
alter table public.quote_links enable row level security;
alter table public.quote_gate_fails enable row level security;
alter table public.invoice_approvals enable row level security;
alter table public.invoice_client_notes enable row level security;
alter table public.invoice_events enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.public_hits enable row level security;

revoke all on public.invoice_terms, public.invoice_installments, public.invoice_revisions, public.quote_links, public.quote_gate_fails,
  public.invoice_approvals, public.invoice_client_notes, public.invoice_events, public.payment_attempts, public.public_hits,
  public.quote_links_public from anon, authenticated;

grant select, insert, update, delete on public.invoice_terms to authenticated;
grant select, insert, update, delete on public.invoice_terms to service_role;
create policy invoice_terms_authenticated_all on public.invoice_terms for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.invoice_installments to authenticated;
grant select, insert, update, delete on public.invoice_installments to service_role;
create policy invoice_installments_authenticated_all on public.invoice_installments for all to authenticated using (true) with check (true);

grant select on public.invoice_revisions to authenticated;
grant select, insert, update, delete on public.invoice_revisions to service_role;
create policy invoice_revisions_authenticated_read on public.invoice_revisions for select to authenticated using (true);

grant select on public.invoice_approvals to authenticated;
grant select, insert, update, delete on public.invoice_approvals to service_role;
create policy invoice_approvals_authenticated_read on public.invoice_approvals for select to authenticated using (true);

grant select on public.invoice_events to authenticated;
grant select, insert, update, delete on public.invoice_events to service_role;
create policy invoice_events_authenticated_read on public.invoice_events for select to authenticated using (true);

grant select on public.invoice_client_notes to authenticated;
grant select, insert, update, delete on public.invoice_client_notes to service_role;
create policy invoice_client_notes_authenticated_read on public.invoice_client_notes for select to authenticated using (true);

-- quote_links: column-list GRANT sem `token`, e RLS sem policy para authenticated (cinto e suspensório)
grant select (id, invoice_id, gate, gate_tier, is_test, created_at, revoked_at, first_viewed_at, last_viewed_at, view_count) on public.quote_links to authenticated;
grant select, insert, update, delete on public.quote_links to service_role;
grant select on public.quote_links_public to authenticated;
grant select on public.quote_links_public to service_role;

-- payment_attempts: column-list GRANT sem `url` (a URL do Checkout é portadora: só via /api/doc/[id]/link)
grant select (id, invoice_id, installment_id, seq, revision_id, income_id, provider, rail, status, verification, amount_cents, currency, fee, net,
  method_type, method_last4, account_holder_type, checkout_session_id, payment_intent_id, charge_id, balance_transaction_id, refund_ids, dispute_id,
  payout_id, expires_at, livemode, created_at, authorized_at, succeeded_at, failed_at, failure_code, created_by) on public.payment_attempts to authenticated;
grant select, insert, update, delete on public.payment_attempts to service_role;
create policy payment_attempts_authenticated_read on public.payment_attempts for select to authenticated using (true);

-- internas: authenticated tem o grant (o freio do roda-sql pede) mas nenhuma policy → lê nada
grant select on public.quote_gate_fails to authenticated;
grant select, insert, update, delete on public.quote_gate_fails to service_role;
grant select on public.public_hits to authenticated;
grant select, insert, update, delete on public.public_hits to service_role;

-- ── funções de leitura ──────────────────────────────────────────────────────
create or replace function public.live_revision(p_invoice uuid) returns public.invoice_revisions
language sql stable security definer set search_path = public as $$
  select * from invoice_revisions
   where invoice_id = p_invoice and superseded_at is null and kind in ('QUOTE','CHANGE_ORDER')
   order by seq desc limit 1
$$;

create or replace function public.doc_event(p_invoice uuid, p_revision uuid, p_kind text, p_actor text, p_actor_id text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_test boolean;
begin
  select exists(select 1 from quote_links where invoice_id = p_invoice and is_test) into v_test;
  insert into invoice_events (invoice_id, revision_id, kind, actor, actor_id, payload)
  values (p_invoice, p_revision, p_kind, p_actor, p_actor_id,
          coalesce(p_payload, '{}'::jsonb) || case when v_test then '{"test":true}'::jsonb else '{}'::jsonb end);
end $$;

-- A-02: porta de lib/rideCodes.ts nextFreeCode — menor número livre da escala; US/SC/WV dividem a escala MAIN.
create or replace function public.alloc_ride_code(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare v_scale text; v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('ride_codes'));
  v_scale := case p_prefix when 'PO' then 'PO' when 'US.QT' then 'QT' when 'SHP' then 'SHP'
                           when 'US' then 'MAIN' when 'SC' then 'MAIN' when 'WV' then 'MAIN' end;
  if v_scale is null then raise exception 'alloc_ride_code: prefixo desconhecido %', p_prefix; end if;
  with used as (
    select (m)[2]::int as n,
           case (m)[1] when 'PO' then 'PO' when 'US.QT' then 'QT' when 'SHP' then 'SHP' else 'MAIN' end as scale
      from (select regexp_match(trim(project_code), '^(US\.QT|SHP|US|SC|WV|PO)\.(\d+)$') m from rides where project_code is not null) x
     where m is not null)
  select min(g) into v_n from generate_series(1, 100000) g
   where not exists (select 1 from used where used.scale = v_scale and used.n = g);
  return p_prefix || '.' || lpad(v_n::text, 3, '0');
end $$;

-- ── gatilhos ────────────────────────────────────────────────────────────────
create or replace function public.trg_incomes_no_quote_fn() returns trigger language plpgsql as $$
begin
  if public.gz28_escape('requote') or public.gz28_escape('test_cleanup') then return new; end if;
  if exists (select 1 from invoices where id = new.invoice_id and is_quote) then
    raise exception 'quote has no income (C-07): converta o quote antes de lançar dinheiro';
  end if;
  return new;
end $$;
create or replace trigger trg_incomes_no_quote before insert or update of invoice_id, amount, paid_at on public.invoice_incomes
  for each row execute function public.trg_incomes_no_quote_fn();

create or replace function public.trg_invoices_quote_flip_fn() returns trigger language plpgsql as $$
begin
  if old.is_quote is false and new.is_quote is true
     and not (public.gz28_escape('requote') or public.gz28_escape('test_cleanup')) then
    raise exception 'an invoice never goes back to quote (C-09)';
  end if;
  if ((old.hiring_date is not null and new.hiring_date is null) or (old.live_status = 'REALTIME' and new.live_status = 'INCOMPLETE'))
     and not public.gz28_escape('test_cleanup')
     and (exists (select 1 from invoice_approvals a where a.invoice_id = new.id)
          or exists (select 1 from invoice_incomes i where i.invoice_id = new.id and i.installment_id is not null)) then
    raise exception 'hired online (approval / payment plan): HIRING DATE and ONLINE stay — use /doc (C-09)';
  end if;
  return new;
end $$;
create or replace trigger trg_invoices_quote_flip before update of is_quote, hiring_date, live_status on public.invoices
  for each row execute function public.trg_invoices_quote_flip_fn();

create or replace function public.trg_plan_row_no_delete_fn() returns trigger language plpgsql as $$
begin
  if old.installment_id is not null and not public.gz28_escape('test_cleanup')
     and exists (select 1 from invoices where id = old.invoice_id and not is_quote) then
    raise exception 'payment-plan income cannot be deleted — settle or refund it in /doc';
  end if;
  return old;
end $$;
create or replace trigger trg_plan_row_no_delete before delete on public.invoice_incomes
  for each row execute function public.trg_plan_row_no_delete_fn();

create or replace function public.trg_incomes_plan_guard_fn() returns trigger language plpgsql as $$
begin
  if old.installment_id is null or public.gz28_escape('settle') or public.gz28_escape('test_cleanup') then return new; end if;
  if new.installment_id is distinct from old.installment_id or new.attempt_id is distinct from old.attempt_id
     or new.refund_id is distinct from old.refund_id then
    raise exception 'payment-plan income: installment/attempt/refund links are fixed';
  end if;
  if old.paid_at is null and new.paid_at is not null then
    raise exception 'payment-plan income is settled only by RECORD PAYMENT in /doc (income_settle)';
  end if;
  return new;
end $$;
create or replace trigger trg_incomes_plan_guard before update on public.invoice_incomes
  for each row execute function public.trg_incomes_plan_guard_fn();

create or replace function public.trg_append_only_fn() returns trigger language plpgsql as $$
declare v_free text[];
begin
  if tg_op = 'DELETE' then
    if public.gz28_escape('test_cleanup') then return old; end if;
    raise exception '% is append-only', tg_table_name;
  end if;
  v_free := case tg_table_name
    when 'invoice_revisions' then array['superseded_at','pdf_path','pdf_sha256']
    when 'invoice_approvals' then array['signed_pdf_path','signed_pdf_sha256']
    else array[]::text[] end;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) and not public.gz28_escape('test_cleanup') then
    raise exception '% is append-only (only % may change)', tg_table_name, v_free;
  end if;
  return new;
end $$;
create or replace trigger trg_append_only before update or delete on public.invoice_revisions for each row execute function public.trg_append_only_fn();
create or replace trigger trg_append_only before update or delete on public.invoice_approvals for each row execute function public.trg_append_only_fn();
create or replace trigger trg_append_only before update or delete on public.invoice_events for each row execute function public.trg_append_only_fn();

-- C-16: SENT = travado. Só as linhas congeladas na revisão viva; inserir é livre (C-38); cancel_status livre (estorno).
-- Cada ramo lê só os campos da SUA tabela (plpgsql resolve campo de registro na hora de executar a instrução).
create or replace function public.trg_lock_presented_lines_fn() returns trigger language plpgsql as $$
declare v_inv uuid; v_rev public.invoice_revisions; v_changed boolean := false;
begin
  if public.gz28_escape('change_order') or public.gz28_escape('test_cleanup') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name = 'invoices' then v_inv := old.id; else v_inv := old.invoice_id; end if;
  v_rev := public.live_revision(v_inv);
  if v_rev.id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name in ('invoice_items','invoice_services') then
    if not (v_rev.document -> 'lines' @> jsonb_build_array(jsonb_build_object('id', old.id::text))) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'locked by sent revision % — NEW REVISION in /doc (C-16)', v_rev.seq;
  end if;
  if tg_table_name = 'invoice_items' then
    v_changed := (new.description, new.unit_price::numeric, new.quantity::numeric, nullif(new.kit_group, ''), nullif(new.kit_name, ''))
       is distinct from (old.description, old.unit_price::numeric, old.quantity::numeric, nullif(old.kit_group, ''), nullif(old.kit_name, ''));
  elsif tg_table_name = 'invoice_services' then
    v_changed := (new.description, new.price::numeric) is distinct from (old.description, old.price::numeric);
  elsif tg_table_name = 'invoice_installments' then
    v_changed := (to_jsonb(new) - 'created_at') is distinct from (to_jsonb(old) - 'created_at');
  elsif tg_table_name = 'invoice_terms' then
    v_changed := (new.rails, new.fee_policy) is distinct from (old.rails, old.fee_policy);
  elsif tg_table_name = 'invoices' then
    v_changed := (coalesce(new.global_discount, 0), coalesce(nullif(new.fl_tax_override, ''), '-'))
       is distinct from (coalesce(old.global_discount, 0), coalesce(nullif(old.fl_tax_override, ''), '-'));
  end if;
  if v_changed then
    raise exception 'locked by sent revision % — NEW REVISION in /doc (C-16)', v_rev.seq;
  end if;
  return new;
end $$;
create or replace trigger trg_lock_presented_lines before update or delete on public.invoice_items for each row execute function public.trg_lock_presented_lines_fn();
create or replace trigger trg_lock_presented_lines before update or delete on public.invoice_services for each row execute function public.trg_lock_presented_lines_fn();
create or replace trigger trg_lock_presented_lines before update or delete on public.invoice_installments for each row execute function public.trg_lock_presented_lines_fn();
create or replace trigger trg_lock_presented_lines before update on public.invoice_terms for each row execute function public.trg_lock_presented_lines_fn();
create or replace trigger trg_lock_presented_lines before update of global_discount, fl_tax_override on public.invoices for each row execute function public.trg_lock_presented_lines_fn();

create or replace function public.trg_approval_binds_revision_fn() returns trigger language plpgsql as $$
declare v_rev public.invoice_revisions; v_live public.invoice_revisions; v_terms public.invoice_terms;
begin
  select * into v_rev from public.invoice_revisions where id = new.revision_id;
  if v_rev.id is null or v_rev.invoice_id <> new.invoice_id then raise exception 'approval: revision does not belong to this document'; end if;
  if v_rev.kind = 'LEGACY_BACKUP' then raise exception 'approval: a legacy backup cannot be signed'; end if;
  v_live := public.live_revision(new.invoice_id);
  if v_live.id is distinct from v_rev.id then raise exception 'approval: revision % is not the live revision (err_stale)', v_rev.seq; end if;
  if new.document_sha256 <> v_rev.sha256 then raise exception 'approval: document hash mismatch (err_stale)'; end if;
  select * into v_terms from public.invoice_terms where invoice_id = new.invoice_id;
  if v_terms.invoice_id is null or new.consent_version <> v_terms.consent_version then raise exception 'approval: consent version mismatch'; end if;
  if new.method = 'CLIENT_ESIGN' and (v_terms.valid_until is null or v_terms.valid_until < public.orlando_today()) then
    raise exception 'approval: quote expired';
  end if;
  return new;
end $$;
create or replace trigger trg_approval_binds_revision before insert on public.invoice_approvals for each row execute function public.trg_approval_binds_revision_fn();

create or replace function public.trg_quote_links_is_test_fn() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.is_test is distinct from old.is_test then raise exception 'quote_links.is_test is immutable'; end if;
    return new;
  end if;
  if new.is_test and not exists (
       select 1 from public.invoices v left join public.rides r on r.id = v.ride_id
         join public.clients c on c.id = coalesce(v.client_id, r.client_id)
        where v.id = new.invoice_id and c.name like 'GZ28 TEST%' and c.origin = 'PROJECT') then
    raise exception 'is_test link only on a GZ28 TEST client';
  end if;
  return new;
end $$;
create or replace trigger trg_quote_links_is_test before insert or update of is_test on public.quote_links for each row execute function public.trg_quote_links_is_test_fn();

-- ── estado: termos e plano (T0) ─────────────────────────────────────────────
create or replace function public.seed_terms(p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_country text; v_lang text; v_rails text[]; v_paid_to text; v_seeded_terms boolean := false; v_seeded_plan boolean := false;
begin
  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null then raise exception 'seed_terms: invoice % not found', p_invoice; end if;
  select upper(coalesce(c.country, '')) into v_country from clients c
   where c.id = coalesce(v_inv.client_id, (select client_id from rides where id = v_inv.ride_id));
  v_lang := case when v_country in ('BRAZIL','ANGOLA') then 'pt' else 'en' end;
  v_rails := case v_country when 'BRAZIL' then '{PIX_BR}'::text[] when 'ANGOLA' then '{card,WIRE}'::text[] else '{us_bank_account,card,ZELLE,WIRE}'::text[] end;
  v_paid_to := case when v_country = 'BRAZIL' then 'GZ28BR' else 'GZ28US' end;
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

-- ── SEND (T1): congela a revisão n; cunha o link uma vez ───────────────────
create or replace function public.quote_send(p_invoice uuid, p_actor text, p_channel text, p_sent_to text, p_valid_days int,
  p_document jsonb, p_sha256 text, p_presented_sha256 text, p_terms_sha256 text, p_grand numeric, p_fl_tax numeric, p_fl_status text,
  p_by_app boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv invoices; v_prev invoice_revisions; v_seq int; v_rev uuid; v_link quote_links; v_until date; v_sum bigint; v_missing int;
        v_client clients; v_gate text := 'NONE'; v_tier text; v_digits text; v_gate_default text;
begin
  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null then raise exception 'quote_send: invoice not found'; end if;
  if not v_inv.is_quote then raise exception 'quote_send: already an invoice — change orders arrive in M4'; end if;
  if not exists (select 1 from invoice_terms where invoice_id = p_invoice) then raise exception 'quote_send: no terms (seed_terms first)'; end if;
  if exists (select 1 from payment_attempts where invoice_id = p_invoice and status in ('OPEN','PROCESSING')) then
    raise exception 'quote_send: a payment is open (409)';
  end if;
  if exists (select 1 from invoice_approvals where invoice_id = p_invoice) then raise exception 'quote_send: already approved (409)'; end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 365 then raise exception 'quote_send: valid_days out of range'; end if;
  if round((p_document -> 'totals' ->> 'grand')::numeric, 2) <> round(p_grand, 2) then raise exception 'quote_send: grand mismatch'; end if;
  select coalesce(sum((e.v ->> 'amount_cents')::bigint), 0) into v_sum from jsonb_array_elements(p_document -> 'installments') as e(v);
  if v_sum <> round(p_grand * 100) then raise exception 'quote_send: plan cents % <> grand cents %', v_sum, round(p_grand * 100); end if;
  select count(*) into v_missing from jsonb_array_elements(p_document -> 'lines') as l(v)
   where not exists (select 1 from invoice_items i where i.id::text = l.v ->> 'id' and i.invoice_id = p_invoice)
     and not exists (select 1 from invoice_services s where s.id::text = l.v ->> 'id' and s.invoice_id = p_invoice);
  if v_missing > 0 then raise exception 'quote_send: % frozen line(s) do not exist', v_missing; end if;

  v_prev := live_revision(p_invoice);
  if v_prev.id is not null then
    update invoice_revisions set superseded_at = now() where id = v_prev.id;
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from invoice_revisions where invoice_id = p_invoice;
  v_until := orlando_today() + p_valid_days;
  insert into invoice_revisions (invoice_id, seq, kind, document, sha256, presented_sha256, terms_sha256, grand_total, fl_tax, fl_tax_status,
    sent_at, sent_channel, sent_to, sent_by_app, created_by)
  values (p_invoice, v_seq, 'QUOTE', p_document, p_sha256, p_presented_sha256, p_terms_sha256, p_grand, coalesce(p_fl_tax, 0), p_fl_status,
    case when p_channel = 'RECORDED' then null else now() end, p_channel, p_sent_to, coalesce(p_by_app, false), p_actor)
  returning id into v_rev;
  update invoice_terms set valid_days = p_valid_days, valid_until = v_until, updated_at = now() where invoice_id = p_invoice;

  select * into v_link from quote_links where invoice_id = p_invoice and revoked_at is null;
  if v_link.id is null then
    select * into v_client from clients where id = coalesce(v_inv.client_id, (select client_id from rides where id = v_inv.ride_id));
    select coalesce((select value #>> '{}' from app_settings where key = 'quote.gate_default'), 'CONTACT_25K') into v_gate_default;
    v_digits := regexp_replace(coalesce(v_client.phone, ''), '\D', '', 'g');
    if v_gate_default = 'CONTACT_25K' and p_grand >= 25000 then
      if length(v_digits) >= 4 then v_gate := 'CONTACT'; v_tier := 'PHONE4';
      elsif coalesce(v_client.email, '') like '%@%' then v_gate := 'CONTACT'; v_tier := 'EMAIL'; end if;
    end if;
    insert into quote_links (invoice_id, token, gate, gate_tier, created_by)
    values (p_invoice, rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '='), v_gate, v_tier, p_actor)
    returning * into v_link;
  end if;

  if v_prev.id is not null then
    perform doc_event(p_invoice, v_prev.id, 'REVISION_SUPERSEDED', 'STAFF', p_actor, jsonb_build_object('seq', v_prev.seq, 'by_send', true));
  end if;
  if p_channel <> 'RECORDED' then
    perform doc_event(p_invoice, v_rev, 'SENT', 'STAFF', p_actor, jsonb_build_object('seq', v_seq, 'channel', p_channel, 'by_app', coalesce(p_by_app, false)));
  end if;
  return jsonb_build_object('revision_id', v_rev, 'seq', v_seq, 'link_id', v_link.id, 'valid_until', v_until, 'gate', v_link.gate, 'gate_tier', v_link.gate_tier);
end $$;

create or replace function public.quote_revision_supersede(p_invoice uuid, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rev invoice_revisions;
begin
  perform 1 from invoices where id = p_invoice for update;
  if exists (select 1 from invoice_approvals where invoice_id = p_invoice) then raise exception 'new revision: already approved — change orders arrive in M4 (409)'; end if;
  if exists (select 1 from payment_attempts where invoice_id = p_invoice and status in ('OPEN','PROCESSING')) then raise exception 'new revision: a payment is open (409)'; end if;
  v_rev := live_revision(p_invoice);
  if v_rev.id is null then return jsonb_build_object('superseded', null); end if;
  update invoice_revisions set superseded_at = now() where id = v_rev.id;
  perform doc_event(p_invoice, v_rev.id, 'REVISION_SUPERSEDED', 'STAFF', p_actor, jsonb_build_object('seq', v_rev.seq));
  return jsonb_build_object('superseded', v_rev.seq);
end $$;

-- ── SIGN (T4/T4') ───────────────────────────────────────────────────────────
create or replace function public.quote_approve(p_invoice uuid, p_link uuid, p_revision uuid, p_sha256 text, p_terms_sha256 text,
  p_signer_name text, p_signer_contact text, p_consents jsonb, p_attribution jsonb, p_method text, p_recorded_by text,
  p_ip inet, p_user_agent text, p_note text, p_evidence_url text, p_signature_path text) returns uuid
language plpgsql security definer set search_path = public as $$
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
  return v_id;
end $$;

-- ── PAY (T5): uma tentativa por sessão do Checkout ──────────────────────────
create or replace function public.attempt_open(p_invoice uuid, p_link uuid, p_seq int, p_rail text, p_provider text, p_livemode boolean,
  p_actor text, p_amount_cents bigint) returns public.payment_attempts
language plpgsql security definer set search_path = public as $$
declare v_rev invoice_revisions; v_inst jsonb; v_inst_id uuid; v_att payment_attempts; v_cents bigint;
begin
  perform 1 from invoices where id = p_invoice for update;
  if p_link is not null and not exists (select 1 from quote_links where id = p_link and invoice_id = p_invoice and revoked_at is null) then
    raise exception 'attempt_open: link revoked';
  end if;
  if p_seq is not null then
    v_rev := live_revision(p_invoice);
    if v_rev.id is null then raise exception 'attempt_open: no live revision'; end if;
    if not exists (select 1 from invoice_approvals where revision_id = v_rev.id) then raise exception 'attempt_open: not approved'; end if;
    select e.v into v_inst from jsonb_array_elements(v_rev.document -> 'installments') as e(v) where (e.v ->> 'seq')::int = p_seq;
    if v_inst is null then raise exception 'attempt_open: installment % not in the approved revision', p_seq; end if;
    v_inst_id := (v_inst ->> 'id')::uuid;
    v_cents := coalesce(p_amount_cents, (v_inst ->> 'amount_cents')::bigint);
    select * into v_att from payment_attempts where invoice_id = p_invoice and installment_id = v_inst_id and status in ('OPEN','PROCESSING') for update;
    if v_att.id is not null then
      if v_att.status = 'PROCESSING' then raise exception 'attempt_open: a bank payment is clearing (409)'; end if;
      if v_att.provider = p_provider and coalesce(v_att.rail, '') = coalesce(p_rail, '')
         and (v_att.expires_at is null or v_att.expires_at > now() + interval '5 minutes') then
        return v_att;                                   -- a second tap returns the same session
      end if;
      update payment_attempts set status = 'EXPIRED' where id = v_att.id;   -- stale or other rail: a NEW row (new idempotency key)
    end if;
  else
    v_cents := p_amount_cents;
  end if;
  if v_cents is null or v_cents <= 0 then raise exception 'attempt_open: amount'; end if;
  insert into payment_attempts (invoice_id, installment_id, seq, revision_id, provider, rail, status, amount_cents, livemode, created_by)
  values (p_invoice, v_inst_id, p_seq, v_rev.id, p_provider, p_rail, 'OPEN', v_cents, coalesce(p_livemode, false), p_actor)
  returning * into v_att;
  return v_att;
end $$;

-- ── o carimbo do dinheiro numa linha do plano ───────────────────────────────
create or replace function public.income_settle(p_income uuid, p_money jsonb, p_attempt uuid, p_muted boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform set_config('gz28.settle', gen_random_uuid()::text, true);
  update invoice_incomes set
    paid_at = orlando_noon((p_money ->> 'paid_on')::date),
    amount = coalesce(round((p_money ->> 'amount_cents')::numeric / 100, 2), amount),
    source = coalesce(p_money ->> 'source', source),
    paid_to = coalesce(p_money ->> 'paid_to', paid_to),
    amount_brl = coalesce((p_money ->> 'amount_brl')::numeric, amount_brl),
    receipt_url = coalesce(p_money ->> 'receipt_url', receipt_url),
    receipt_kinds = coalesce(p_money -> 'receipt_kinds', receipt_kinds),
    attempt_id = coalesce(p_attempt, attempt_id),
    payment_reference = coalesce(p_money ->> 'payment_reference', payment_reference),
    reported_at = case when p_muted then now() else reported_at end,
    updated_at = now()
  where id = p_income and paid_at is null
  returning id into v_id;
  perform set_config('gz28.settle', '', true);
  if v_id is null then raise exception 'income_settle: income % not open', p_income; end if;
  return v_id;
end $$;

-- fee row (§7.4) — live money only; one per balance transaction
create or replace function public.stripe_fee_row(p_invoice uuid, p_money jsonb, p_label text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce((p_money ->> 'fee')::numeric, 0) <= 0 or (p_money ->> 'balance_transaction_id') is null then return; end if;
  if exists (select 1 from invoice_expenses where payment_method = 'STRIPE' and order_number = p_money ->> 'balance_transaction_id') then return; end if;
  insert into invoice_expenses (invoice_id, item, supplier, nature, price, quantity, payment_date, expense_date, paid_from, paid_to, source,
    payment_method, order_number, export_status, receipt_url, receipt_proves_payment, payment_reference, reported_at, created_at, updated_at)
  values (p_invoice, 'Stripe processing fee — ' || p_label, 'Stripe', 'MONEY', (p_money ->> 'fee')::numeric, 1,
    (p_money ->> 'paid_on')::date, (p_money ->> 'paid_on')::date, 'GZ28US', 'GZ28US', 'GZ28US', 'STRIPE', p_money ->> 'balance_transaction_id',
    'FRESH', '[]', true, p_money ->> 'payment_reference', null, now(), now());
end $$;

create or replace function public.attempt_mark_succeeded(p_attempt uuid, p_income uuid, p_money jsonb) returns void
language sql security definer set search_path = public as $$
  update payment_attempts set status = 'SUCCEEDED', income_id = p_income, succeeded_at = now(),
    checkout_session_id = coalesce(checkout_session_id, p_money ->> 'checkout_session_id'),
    payment_intent_id = coalesce(payment_intent_id, p_money ->> 'payment_intent_id'),
    charge_id = coalesce(p_money ->> 'charge_id', charge_id),
    balance_transaction_id = coalesce(p_money ->> 'balance_transaction_id', balance_transaction_id),
    fee = coalesce((p_money ->> 'fee')::numeric, fee), net = coalesce((p_money ->> 'net')::numeric, net),
    method_type = coalesce(p_money ->> 'method_type', method_type), method_last4 = coalesce(p_money ->> 'method_last4', method_last4),
    account_holder_type = coalesce(p_money ->> 'account_holder_type', account_holder_type)
  where id = p_attempt
$$;

-- ── HIRE: o projeto nasce (C-02, C-06, C-09, C-11, C-13, C-20) ─────────────
create or replace function public.quote_hire(p_invoice uuid, p_attempt uuid, p_money jsonb, p_muted boolean, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
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
    select coalesce(max(client_number), 0) + 1 into v_num from clients where is_quote = false and origin is not distinct from v_client.origin;
    update clients set client_number = v_num, is_quote = false, updated_at = now() where id = v_client.id;
    insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
    values ('quote-hire', 'clients', v_client.id::text, 'client_number', v_client.client_number::text, v_num::text, 'quote portal hire ' || p_attempt);
    if v_inv.ride_id is null then
      v_old_pad := lpad(coalesce(v_client.client_number, 0)::text, 3, '0'); v_new_pad := lpad(v_num::text, 3, '0');
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
end $$;

-- ── book_payment: o ÚNICO caminho do dinheiro recebido (§3.3) ──────────────
create or replace function public.book_payment(p_attempt uuid, p_money jsonb, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv_id uuid; v_inv invoices; v_att payment_attempts; v_link quote_links; v_muted boolean;
        v_target uuid; v_anomaly text; v_n int;
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
end $$;

-- ── staff: VOID · EXTEND · EXPIRE · ROTATE · gate ───────────────────────────
create or replace function public.quote_void(p_invoice uuid, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sessions text[];
begin
  perform 1 from invoices where id = p_invoice for update;
  update quote_links set revoked_at = now() where invoice_id = p_invoice and revoked_at is null;
  select array_agg(checkout_session_id) filter (where checkout_session_id is not null) into v_sessions
    from payment_attempts where invoice_id = p_invoice and status = 'OPEN';
  update payment_attempts set status = 'EXPIRED' where invoice_id = p_invoice and status = 'OPEN';
  perform doc_event(p_invoice, (live_revision(p_invoice)).id, 'VOIDED', 'STAFF', p_actor, '{}'::jsonb);
  return jsonb_build_object('sessions', coalesce(v_sessions, '{}'::text[]));
end $$;

create or replace function public.quote_extend(p_invoice uuid, p_days int, p_actor text) returns date
language plpgsql security definer set search_path = public as $$
declare v_until date;
begin
  perform 1 from invoices where id = p_invoice for update;
  if p_days not in (7, 15, 30) then raise exception 'extend: 7, 15 or 30 days'; end if;
  update invoice_terms set valid_until = greatest(coalesce(valid_until, orlando_today()), orlando_today()) + p_days, updated_at = now()
   where invoice_id = p_invoice returning valid_until into v_until;
  if v_until is null then raise exception 'extend: no terms'; end if;
  perform doc_event(p_invoice, (live_revision(p_invoice)).id, 'EXTENDED', 'STAFF', p_actor, jsonb_build_object('days', p_days, 'valid_until', v_until));
  return v_until;
end $$;

create or replace function public.quote_expire(p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rev invoice_revisions; v_sessions text[]; v_since timestamptz;
begin
  perform 1 from invoices where id = p_invoice for update;
  v_rev := live_revision(p_invoice);
  if v_rev.id is null or exists (select 1 from invoice_approvals where revision_id = v_rev.id)
     or not exists (select 1 from invoice_terms where invoice_id = p_invoice and valid_until < orlando_today()) then
    return jsonb_build_object('expired', false);
  end if;
  select greatest(v_rev.created_at, coalesce(max(at), v_rev.created_at)) into v_since from invoice_events where invoice_id = p_invoice and kind = 'EXTENDED';
  if exists (select 1 from invoice_events where invoice_id = p_invoice and kind = 'EXPIRED' and at >= v_since) then
    return jsonb_build_object('expired', false, 'already', true);
  end if;
  select array_agg(checkout_session_id) filter (where checkout_session_id is not null) into v_sessions
    from payment_attempts where invoice_id = p_invoice and status = 'OPEN';
  update payment_attempts set status = 'EXPIRED' where invoice_id = p_invoice and status = 'OPEN';
  perform doc_event(p_invoice, v_rev.id, 'EXPIRED', 'SYSTEM', null, '{}'::jsonb);
  return jsonb_build_object('expired', true, 'sessions', coalesce(v_sessions, '{}'::text[]));
end $$;

create or replace function public.quote_rotate_link(p_invoice uuid, p_actor text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_old quote_links; v_new uuid;
begin
  perform 1 from invoices where id = p_invoice for update;
  select * into v_old from quote_links where invoice_id = p_invoice and revoked_at is null;
  if v_old.id is null then raise exception 'rotate: no live link'; end if;
  update quote_links set revoked_at = now() where id = v_old.id;
  insert into quote_links (invoice_id, token, gate, gate_tier, is_test, created_by, rotated_from)
  values (p_invoice, rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '='), v_old.gate, v_old.gate_tier, v_old.is_test, p_actor, v_old.id)
  returning id into v_new;
  perform doc_event(p_invoice, (live_revision(p_invoice)).id, 'LINK_ROTATED', 'STAFF', p_actor, jsonb_build_object('old_link', v_old.id, 'new_link', v_new));
  return v_new;
end $$;

create or replace function public.gate_unlock(p_link uuid, p_actor text) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv uuid;
begin
  select invoice_id into v_inv from quote_links where id = p_link;
  if v_inv is null then raise exception 'gate_unlock: link not found'; end if;
  update quote_gate_fails set fails = 0, locked_until = null where link_id = p_link;
  perform doc_event(v_inv, (live_revision(v_inv)).id, 'GATE_RESET', 'STAFF', p_actor, '{}'::jsonb);
end $$;

-- gate fail: 5 → 15 min; 10, 15, … → 1 h; per-link daily cap 25 (returns the lock and whether the cap was hit)
create or replace function public.gate_fail(p_link uuid, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row quote_gate_fails; v_day_total int;
begin
  insert into quote_gate_fails (link_id, ip_hash, fails, day) values (p_link, p_ip_hash, 1, orlando_today())
  on conflict (link_id, ip_hash) do update set
    fails = case when quote_gate_fails.day <> orlando_today() then 1 else quote_gate_fails.fails + 1 end,
    day = orlando_today()
  returning * into v_row;
  if v_row.fails = 5 then
    update quote_gate_fails set locked_until = now() + interval '15 minutes' where link_id = p_link and ip_hash = p_ip_hash returning * into v_row;
  elsif v_row.fails >= 10 and v_row.fails % 5 = 0 then
    update quote_gate_fails set locked_until = now() + interval '1 hour' where link_id = p_link and ip_hash = p_ip_hash returning * into v_row;
  end if;
  select coalesce(sum(fails), 0) into v_day_total from quote_gate_fails where link_id = p_link and day = orlando_today();
  return jsonb_build_object('fails', v_row.fails, 'locked_until', v_row.locked_until, 'cap', v_day_total >= 25);
end $$;

-- limiter (two keys): returns the count in this bucket after the hit
create or replace function public.public_hit(p_scope text, p_key text, p_route text, p_bucket timestamptz) returns int
language sql security definer set search_path = public as $$
  insert into public_hits (scope, key, route, bucket, n) values (p_scope, p_key, p_route, p_bucket, 1)
  on conflict (scope, key, route, bucket) do update set n = public_hits.n + 1
  returning n
$$;

-- one fulfilment claim per Checkout Session (cs:<id>) shared by webhook and landing; RECEIVED/ERROR → PROCESSING (≤ 5 tries)
create or replace function public.stripe_claim(p_id text, p_type text, p_livemode boolean, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  insert into stripe_events (id, type, livemode, status, payload) values (p_id, p_type, coalesce(p_livemode, false), 'RECEIVED', coalesce(p_payload, '{}'::jsonb))
  on conflict (id) do nothing;
  update stripe_events set status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
   where id = p_id and status in ('RECEIVED', 'ERROR') and attempts < 5
  returning id into v_id;
  return v_id is not null;
end $$;

-- ── REVOKE / GRANT em toda função nova: só a service role executa ───────────
do $$
declare f text;
begin
  foreach f in array array[
    'orlando_today()', 'orlando_noon(date)', 'gz28_escape(text)', 'live_revision(uuid)', 'doc_event(uuid,uuid,text,text,text,jsonb)',
    'alloc_ride_code(text)', 'seed_terms(uuid)',
    'quote_send(uuid,text,text,text,int,jsonb,text,text,text,numeric,numeric,text,boolean)', 'quote_revision_supersede(uuid,text)',
    'quote_approve(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,text,text,inet,text,text,text,text)',
    'attempt_open(uuid,uuid,int,text,text,boolean,text,bigint)', 'income_settle(uuid,jsonb,uuid,boolean)', 'stripe_fee_row(uuid,jsonb,text)',
    'attempt_mark_succeeded(uuid,uuid,jsonb)', 'quote_hire(uuid,uuid,jsonb,boolean,text)', 'book_payment(uuid,jsonb,text)',
    'quote_void(uuid,text)', 'quote_extend(uuid,int,text)', 'quote_expire(uuid)', 'quote_rotate_link(uuid,text)', 'gate_unlock(uuid,text)',
    'gate_fail(uuid,text)', 'public_hit(text,text,text,timestamptz)', 'stripe_claim(text,text,boolean,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
-- Os gatilhos rodam como QUEM ESCREVEU (não definer) e chamam estas três: authenticated precisa de EXECUTE nelas — leituras puras.
grant execute on function public.orlando_today() to authenticated;
grant execute on function public.gz28_escape(text) to authenticated;
grant execute on function public.live_revision(uuid) to authenticated;

-- ── fornecedor, bucket, chaves (TODAS desligadas) ───────────────────────────
insert into public.suppliers (name, category)
select 'Stripe', 'SERVICES' where not exists (select 1 from public.suppliers where lower(name) = 'stripe');

insert into storage.buckets (id, name, public) values ('client-docs', 'client-docs', false) on conflict (id) do nothing;

insert into public.app_settings (key, value, note, updated_by) values
  ('qi_v2.actions', 'false', 'Staff actions on REAL documents in /doc (send, approve, deposit, void…). Test documents bypass it. OFF until Márcio.', 'migration 06/11/2026'),
  ('qi_v2.enabled', 'false', 'Header entry QUOTES v2 (M3).', 'migration 06/11/2026'),
  ('quote.hire_on', '"CLEARED"', 'The project is born when the money CLEARS (ACH shows deposit clearing). D-01.', 'migration 06/11/2026'),
  ('quote.gate_default', '"CONTACT_25K"', 'Identity gate on the public page: ON when the quote is >= US$ 25k and a contact exists. D-14.', 'migration 06/11/2026'),
  ('quote.rotate_at_hire', 'false', 'Rotate the public link when the project is born. D-18.', 'migration 06/11/2026'),
  ('payments.rails_enabled', '["card"]', 'Stripe rails offered on the public page (card; us_bank_account after the Dashboard ACH activation).', 'migration 06/11/2026'),
  ('payments.ach_verification', '"automatic"', 'ACH verification method (instant via Financial Connections, else microdeposits).', 'migration 06/11/2026'),
  ('stripe.customer_emails_checked', '{"test": true, "live": false}', 'Live sessions are refused until Márcio records the Dashboard «Customer emails» choice. D-06.', 'migration 06/11/2026'),
  ('stripe.endpoint_events', '["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired","charge.refunded","refund.updated","refund.failed","charge.dispute.created","charge.dispute.updated","charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated","charge.dispute.closed","payout.paid","payout.failed"]', 'Events the Control App endpoint must be subscribed to.', 'migration 06/11/2026'),
  ('deposit.manual_cap', '10000', 'CASH/OTHER manual deposits above this need a receipt.', 'migration 06/11/2026'),
  ('notify.test_targets', '[]', 'Where SEND TEST TO ME may go (M4).', 'migration 06/11/2026'),
  ('test.keep', 'false', 'Keep is_test hires past 2 h (housekeeping auto-cleanup).', 'migration 06/11/2026'),
  ('notify.client.quote_sent.whatsapp', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.quote_sent.email', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.signed_copy', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.deposit_clearing', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.deposit_received', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.deposit_failed', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.installment_due', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.quote_expiring', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.change_order', 'false', 'ROBOT — client. OFF.', 'migration 06/11/2026'),
  ('notify.client.stripe_receipt', 'false', 'Adds receipt_email to the Stripe PaymentIntent. OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_sent', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_viewed', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.changes_requested', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_declined', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.renewal_requested', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_signed', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_expiring', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.quote_unopened_48h', 'false', 'ROBOT — REPORTS group, quote flow (not money). OFF.', 'migration 06/11/2026'),
  ('notify.reports.deposit_clearing', 'false', 'ROBOT — REPORTS group, money. OFF.', 'migration 06/11/2026'),
  ('notify.reports.deposit_received', 'false', 'ROBOT — REPORTS group, money. OFF.', 'migration 06/11/2026'),
  ('notify.reports.installment_delayed', 'false', 'DELAYED robot includes payment-plan rows only when ON.', 'migration 06/11/2026'),
  ('notify.owner.payment_failed', 'false', 'ROBOT — owner alert. Live-switch precondition. OFF.', 'migration 06/11/2026'),
  ('notify.owner.refund', 'false', 'ROBOT — owner alert. OFF.', 'migration 06/11/2026'),
  ('notify.owner.dispute', 'false', 'ROBOT — owner alert. Live-switch precondition. OFF.', 'migration 06/11/2026'),
  ('notify.owner.payment_anomaly', 'false', 'ROBOT — owner alert. OFF.', 'migration 06/11/2026'),
  ('notify.owner.payout_unmatched', 'false', 'ROBOT — owner alert. OFF.', 'migration 06/11/2026'),
  ('notify.owner.gate_cap', 'false', 'ROBOT — owner alert. OFF.', 'migration 06/11/2026')
on conflict (key) do nothing;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('migration', 'schema', 'quote_portal_core', 'migration', null,'MIGRATION_quote_portal_core.sql', 'quote portal M1 step 2 — 06/11/2026');

commit;
