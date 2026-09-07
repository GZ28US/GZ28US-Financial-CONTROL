-- AUTO-BOOK — «SILENCE MEANS RIGHT» (BL 0.10.0, 4/set/2026, lei do João). Rode UMA vez
-- no SQL Editor do projeto US. Idempotente.
--
-- Uma coluna só: a resposta humana a uma dúvida de GÊMEO («não, não é esta compra»)
-- precisa morar na linha do banco, senão o motor pergunta de novo a cada rodada.
alter table bank_transactions add column if not exists doubt_answered jsonb;
comment on column bank_transactions.doubt_answered is 'AUTO-BOOK: {cands:["tabela:id", ...], at} — o humano disse que estes candidatos NÃO são esta compra; o motor não os oferece de novo';

-- Índice pra fila de perguntas (linhas NEW/QUEUED são o universo das dúvidas).
create index if not exists bank_transactions_open_idx on bank_transactions (match_status, date) where match_status in ('NEW', 'QUEUED');

-- Conferência (só leitura):
--   select count(*) from bank_transactions where match_status in ('NEW','QUEUED');
