-- AUTO-BOOK — Phase A (BL 0.8.0, 3/set/2026, GO do João + Márcio). Cada linha
-- nova do Bank Link é entendida e REGISTRADA sozinha depois de todo sync; o
-- casamento vira só guarda contra duplicata. Plano validado por revisão
-- adversarial (35 agentes, 7 riscos confirmados — ver changelog BL 0.8.0).
-- Rode UMA vez no SQL Editor do projeto US, ANTES do deploy. Idempotente.

-- 1) Regras ficam espertas: casam por regex OU categoria do Plaid (pfc);
--    ganham origem (HUMAN | LEARNED), chave de comerciante, direção, teto de
--    valor e contadores; alvo novo TRANSFER (só regra HUMANA com regex).
alter table bank_merchant_rules
  add column if not exists pfc_primary text,
  add column if not exists pfc_detailed text,
  add column if not exists origin text not null default 'HUMAN',
  add column if not exists merchant_key text,
  add column if not exists direction text not null default 'OUT',
  add column if not exists amount_max numeric,
  add column if not exists hits integer not null default 0,
  add column if not exists last_hit_at timestamptz,
  add column if not exists last_taught_bank_id text,
  add column if not exists paused_reason text;
alter table bank_merchant_rules alter column pattern drop not null;
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_target_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_target_check check (target in ('FIXED_EXPENSE','INPUT','TRANSFER'));
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_origin_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_origin_check check (origin in ('HUMAN','LEARNED'));
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_direction_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_direction_check check (direction in ('OUT','IN','ANY'));
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_matcher_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_matcher_check check (pattern is not null or pfc_primary is not null or pfc_detailed is not null or merchant_key is not null);
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_transfer_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_transfer_check check (target <> 'TRANSFER' or (origin = 'HUMAN' and pattern is not null));
create unique index if not exists bank_merchant_rules_learned_uidx on bank_merchant_rules (merchant_key, coalesce(pfc_detailed, ''), direction) where origin = 'LEARNED';

-- 2) A linha do banco lembra QUAL regra disparou (DESFAZER pausa a aprendida).
alter table bank_transactions add column if not exists match_rule uuid references bank_merchant_rules (id) on delete set null;

-- 3) Uma rodada por vez (índice parcial único) + contagens/erros persistidos.
create table if not exists bank_auto_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null,
  status text not null default 'RUNNING' check (status in ('RUNNING','DONE','PARTIAL','ABORTED','ERROR','SKIPPED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb,
  errors jsonb,
  remaining integer,
  note text
);
create unique index if not exists bank_auto_runs_running_uidx on bank_auto_runs ((1)) where status = 'RUNNING';
alter table bank_auto_runs enable row level security;
do $$ begin
  create policy bar_read on bank_auto_runs for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- 4) Varredura de órfãos criados por regra ANTES desta versão (esperado: 0 linhas
--    — a tabela de regras nasceu vazia em 31/ago). Seguro rodar sempre.
delete from inputs
 where order_number like 'bank:%' and description like '%(regra · Bank Link)%'
   and not exists (select 1 from bank_transactions b where b.match_status = 'MATCHED' and b.matched_table = 'inputs' and b.matched_id::text = inputs.id::text);
delete from fixed_cost_expenses f
 where f.bank_transaction_id is not null and f.description like '%(regra · Bank Link)%'
   and not exists (select 1 from bank_transactions b where b.id = f.bank_transaction_id and b.match_status = 'MATCHED' and b.matched_table = 'fixed_cost_expenses' and b.matched_id::text = f.id::text);
