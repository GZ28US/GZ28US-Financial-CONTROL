-- BANK LINK v0.3.0 — motores automáticos de conciliação (22/ago/2026)
-- Rodar no SQL Editor do Supabase (projeto GZ28US). Idempotente.
--
-- bank_transactions: quem casou (motor ou humano), em que rodada, e se o Márcio
-- já conferiu. Linha casada por humano fica com match_engine NULL.
alter table public.bank_transactions add column if not exists match_engine text;        -- 'FEE' | 'EXACT' | null (humano)
alter table public.bank_transactions add column if not exists match_batch uuid;         -- rodada do motor (DESFAZER LOTE)
alter table public.bank_transactions add column if not exists reviewed_at timestamptz;  -- null = A CONFERIR
create index if not exists bank_transactions_engine_idx on public.bank_transactions (match_engine, reviewed_at) where match_engine is not null;
-- O que o MATCH escreveu no app ([{t,id,f,v}]) — DESFAZER reverte só isso (revisão #6).
alter table public.bank_transactions add column if not exists backfill jsonb;
-- Uma linha do app só pode estar casada com UMA linha do banco (revisão #13; hoje 0 conflitos).
create unique index if not exists bank_transactions_matched_uidx on public.bank_transactions (matched_table, matched_id) where matched_id is not null;

-- fixed_cost_expenses: tarifa criada pelo motor FEE aponta pra linha do banco que
-- a originou — DESFAZER apaga exatamente essa linha e nenhuma outra.
alter table public.fixed_cost_expenses add column if not exists bank_transaction_id uuid references public.bank_transactions (id) on delete set null;
create unique index if not exists fixed_cost_expenses_bank_tx_uidx on public.fixed_cost_expenses (bank_transaction_id) where bank_transaction_id is not null;
