-- QUOTE PORTAL M5 — stripe_payouts (06/11/2026; blueprint §7.5, v1 §4.1). One row per Stripe payout (po_…), written by the webhook
-- (payout.paid / payout.failed) and by the staff SYNC (/api/stripe/payouts/sync — reads Stripe, never moves money). `members` is the
-- Bank Link MIXED member set of that payout (incomes + fee/dispute-fee expenses + refund/dispute negative incomes), `unresolved_amount`
-- what the payout carries that is NOT the Control App's (shop charges on the shared account, Stripe adjustments) — a payout with
-- unresolved ≠ 0 never auto-matches; the human decides. `bank_transaction_id` is set when the Regions credit is matched.
begin;
create table if not exists public.stripe_payouts (
  id text primary key,
  amount numeric not null,
  currency text not null default 'usd',
  arrival_date date not null,
  status text not null,
  livemode boolean not null,
  balance_transactions jsonb not null default '[]',
  members jsonb not null default '[]',
  members_net numeric not null default 0,
  unresolved_amount numeric not null default 0,
  bank_transaction_id uuid,
  matched_at timestamptz,
  failure_code text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists stripe_payouts_open_idx on public.stripe_payouts (arrival_date) where bank_transaction_id is null;
alter table public.stripe_payouts enable row level security;
revoke all on public.stripe_payouts from public, anon, authenticated;
grant select on public.stripe_payouts to authenticated;
grant select, insert, update, delete on public.stripe_payouts to service_role;
create policy stripe_payouts_authenticated_read on public.stripe_payouts for select to authenticated using (true);
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m5', 'stripe_payouts', 'table', 'migration', null, 'created', 'MIGRATION_quote_portal_payouts.sql');
commit;
