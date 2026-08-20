-- ============================================================================
-- GZ28US — FASE 2 DAS DEMONSTRAÇÕES: os três livros que faltam
-- ----------------------------------------------------------------------------
-- O Balanço não fecha porque capital, empréstimos e caixa não têm registro
-- (gaps G2/G3/G5 do blueprint). O DFC prova: variação líquida acumulada
-- negativa a partir do zero — dinheiro entrou por algum lugar que o app não
-- vê. Estas três tabelas são esse lugar.
--
--   capital_events  G2 — aporte e retirada de sócio (a retirada formal;
--                        expenses origin=PERSONAL continua valendo pro miúdo)
--   financing       G3 — contratos (K&G Financing etc.) + eventos:
--                        DISBURSEMENT (entra caixa, sobe dívida),
--                        PAYMENT (sai caixa, desce dívida),
--                        INTEREST (sai caixa, dívida igual — vira despesa na DRE)
--   cash_balances   G5 — saldo de fim de mês por conta (MANUAL até o Plaid
--                        assumir; a conciliação compara variação calculada × real)
--
-- COMO RODAR: Supabase dashboard (projeto fvgpkbpqacnqxtrjsmpi) → SQL Editor →
-- colar e executar. Idempotente (IF NOT EXISTS / drop policy if exists).
-- RLS igual ao resto do app (rls_phase1): tudo só para `authenticated`.
-- ============================================================================

begin;

create table if not exists public.capital_events (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  kind        text not null check (kind in ('CONTRIBUTION', 'DRAW')),
  member      text not null,                    -- quem aportou/retirou (ex.: 'Márcio')
  amount      numeric not null check (amount > 0),
  method      text,                             -- WIRE / ZELLE / CASH / CHECK…
  description text,
  receipt_url text,
  created_at  timestamptz not null default now()
);

create table if not exists public.financing (
  id          uuid primary key default gen_random_uuid(),
  lender      text not null,                    -- ex.: 'K&G FINANCING, INC.'
  description text,
  start_date  date,
  rate_apr    numeric,                          -- % ao ano, informativo
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAID')),
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.financing_events (
  id           uuid primary key default gen_random_uuid(),
  financing_id uuid not null references public.financing(id) on delete cascade,
  event_date   date not null,
  kind         text not null check (kind in ('DISBURSEMENT', 'PAYMENT', 'INTEREST')),
  amount       numeric not null check (amount > 0),
  description  text,
  receipt_url  text,
  created_at   timestamptz not null default now()
);

create table if not exists public.cash_balances (
  id           uuid primary key default gen_random_uuid(),
  balance_date date not null,
  account      text not null,                   -- ex.: 'Regions •9336'
  balance      numeric not null,
  source       text not null default 'MANUAL' check (source in ('MANUAL', 'PLAID')),
  notes        text,
  created_at   timestamptz not null default now(),
  unique (balance_date, account)               -- um saldo por conta por data
);

-- RLS no padrão do app: authenticated faz tudo, anon nada.
do $$
declare t text;
begin
  foreach t in array array['capital_events', 'financing', 'financing_events', 'cash_balances'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_authenticated_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true);',
      t || '_authenticated_all', t);
  end loop;
end $$;

commit;

-- ROLLBACK (se precisar):
--   drop table if exists public.financing_events;
--   drop table if exists public.financing;
--   drop table if exists public.capital_events;
--   drop table if exists public.cash_balances;
