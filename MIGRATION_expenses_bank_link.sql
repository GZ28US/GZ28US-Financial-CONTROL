-- CASAR COM AJUSTE (BL 1.1.0, 8/set/2026). Rode UMA vez no SQL Editor do projeto US. Idempotente.
--
-- A passagem da season (tabela expenses) casada com a linha do banco leva o elo numa
-- coluna PRÓPRIA — payment_reference é campo de gente (id do PayPal, PNR) e não pode
-- ser sobrescrito pelo motor. Mesma forma que fixed_cost_expenses.bank_transaction_id.
-- Antes da migration o app segue vivo: o pool e as varreduras ignoram a coluna e o card
-- avisa «rode a migration» em vez de cair.
alter table public.expenses add column if not exists bank_transaction_id uuid references public.bank_transactions (id) on delete set null;
create index if not exists expenses_bank_transaction_idx on public.expenses (bank_transaction_id) where bank_transaction_id is not null;
comment on column public.expenses.bank_transaction_id is 'Bank Link: linha do banco que pagou esta despesa (CASAR COM AJUSTE) — DESFAZER solta';

-- Conferência (só leitura):
--   select count(*) from public.expenses where bank_transaction_id is not null;
