-- BL 0.7.0 (31/ago/2026, GO do João): o motor fica esperto onde os números
-- mandaram — 289 ambíguos (desempate por APELIDO) e ~360 sem-gêmeo de famílias
-- conhecidas (REGRAS DE CRIAÇÃO: combustível→FLEET, mercado→TEAM, assinatura→
-- fornecedor APP). As duas tabelas são semeadas PELOS HUMANOS no card do Bank
-- Link — dinheiro se lança por regra humana, nunca por chute do motor.
-- Rode UMA vez no SQL Editor do projeto US.

-- Apelidos: como o banco escreve ⇄ como o app chama (soma-se aos hard-coded).
-- words = lista separada por vírgula; not_pattern veta rótulos com a palavra
-- em outro sentido (bomba de combustível não é posto).
create table if not exists bank_aliases (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  words text not null,
  not_pattern text,
  created_at timestamptz not null default now()
);

-- Regras de criação: linha NEW sem candidato cujo nome casa com pattern vira
-- lançamento criado pelo motor (sempre via PLANEJAR/APLICAR — o humano vê antes):
--   target FIXED_EXPENSE -> fixed_cost_expenses no supplier_id (bucket do fornecedor)
--   target INPUT         -> supplies/inputs na category (SHOP/TEAM/APARTMENT/CATS)
create table if not exists bank_merchant_rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  target text not null check (target in ('FIXED_EXPENSE','INPUT')),
  supplier_id uuid,
  category text,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table bank_aliases enable row level security;
alter table bank_merchant_rules enable row level security;
do $$ begin
  create policy ba_all on bank_aliases for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy bmr_all on bank_merchant_rules for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
