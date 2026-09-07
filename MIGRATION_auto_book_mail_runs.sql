-- AUTO-BOOK / E-MAIL — A PROVA DE VIDA DA RODADA (07/set/2026). Idempotente.
--
-- POR QUE: o cron de hora em hora nao deixava rastro nenhum. Fila vazia significava
-- as DUAS coisas ao mesmo tempo — "rodou e nao achou nada" e "nunca rodou" — e nao
-- havia como distinguir. Nesta casa isso ja aconteceu: o mail-poll morreu calado no
-- teto de tempo e ficou 4 dias sem rodar sem ninguem perceber, porque a ausencia de
-- resultado parecia resultado. Silencio do app e promessa de que esta tudo certo;
-- promessa sem lastro e mentira.
--
-- O formato copia `bank_auto_runs` de proposito (trigger/status/started_at/
-- finished_at/counts/errors): a casa ja sabe ler essa forma na tela do Bank Link, e
-- inventar outra so criaria um segundo dialeto pro mesmo fato.
-- Tabela PROPRIA, e nao linha em bank_auto_runs, porque aquela e o livro do motor do
-- BANCO — escrever nela quebraria a contagem "ultima rodada" da outra frente.

create table if not exists auto_book_mail_runs (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null default 'cron',   -- cron | human
  status      text not null default 'RUNNING',-- RUNNING | DONE | ERROR
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  horas       int,                            -- janela varrida nesta passada
  counts      jsonb,                          -- lidos, com_dinheiro, perguntas, lancados, ja_tem_linha, ignorados, duvidas_app
  caixas      jsonb,                          -- o que cada caixa devolveu (e qual falhou)
  errors      jsonb
);
comment on table auto_book_mail_runs is 'AUTO-BOOK e-mail: uma linha por rodada do cron. Existe para distinguir "rodou e nao achou nada" de "nao rodou" — sem ela, fila vazia mente.';
create index if not exists auto_book_mail_runs_recent_idx on auto_book_mail_runs (started_at desc);

-- Conferencia (so leitura):
--   select started_at, status, counts from auto_book_mail_runs order by started_at desc limit 5;
