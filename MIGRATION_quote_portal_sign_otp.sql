-- QUOTE PORTAL M4 — the signing code (OTP) before the e-signature (08/11/2026; blueprint §5.2 item (5), §16 M4).
-- Two things, nothing else:
--   1) the switch `quote_portal.sign_otp`, born FALSE (law of 06/11: nothing reaches anyone until Márcio turns it on himself).
--      `on conflict do nothing` — re-running never flips a value he already chose.
--   2) the code table `quote_sign_otps`: one row per portal link; the code only as an HMAC; tries / lock / resend clock; the
--      verification time the approval's attribution copies. Server only: RLS ON with NO policy → anon and authenticated read and
--      write nothing; anon has no grant at all; authenticated gets the bare SELECT grant the roda-sql brake asks for (same pattern
--      as quote_gate_fails), which the absent policy turns into zero rows.
begin;

insert into public.app_settings (key, value, note, updated_by) values
  ('quote_portal.sign_otp', 'false'::jsonb, 'BEHAVIOUR — before the e-signature the client types a 6-digit code sent on the same channel the quote went on (WhatsApp; e-mail when there is no phone). OFF.', 'migration 08/11/2026')
on conflict (key) do nothing;

create table if not exists public.quote_sign_otps (
  link_id uuid primary key references public.quote_links(id) on delete cascade,
  revision_id uuid not null references public.invoice_revisions(id) on delete cascade,
  channel text not null check (channel in ('WHATSAPP','EMAIL')),
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  last_sent_at timestamptz,
  sends int not null default 0,
  tries int not null default 0 check (tries between 0 and 5),
  locked_until timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quote_sign_otps enable row level security;
revoke all on public.quote_sign_otps from public, anon, authenticated;
grant select on public.quote_sign_otps to authenticated;                       -- no policy → reads nothing (roda-sql brake)
grant select, insert, update, delete on public.quote_sign_otps to service_role;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('quote-portal-m4', 'quote_sign_otps', 'table + quote_portal.sign_otp', 'migration', null, 'created (switch false)', 'MIGRATION_quote_portal_sign_otp.sql');
commit;
