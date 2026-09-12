-- AUTO-BOOK / E-MAIL — A FILA DA DÚVIDA E A REGRA APRENDIDA (07/set/2026).
-- Rode UMA vez no SQL Editor do projeto US. Idempotente.
--
-- POR QUE: o motor de e-mail (lib/mailToItem.server.ts) já escreve FATOS na linha
-- que existe — rastreio, entrega, estorno. O que ele NÃO tinha era onde guardar o
-- que não sabe resolver: a compra que chegou por e-mail e não casa com linha
-- nenhuma virava uma string dentro da resposta HTTP do cron e morria ali. Medido:
-- `semLinha` nunca foi lido por ninguém desde 31/ago.
-- Lei do dono (06/set/2026): "o robô faz o round de 1 em 1 hora e deixa pra mim só
-- o que ele tiver dúvida". Dúvida precisa de LUGAR, senão vira silêncio — e
-- silêncio do app é promessa de que está tudo certo (mesma lei do lado do banco,
-- MIGRATION_auto_book_silence.sql).
--
-- DUAS tabelas, duas funções distintas:
--   auto_book_mail        — a PERGUNTA (uma linha por e-mail com dinheiro sem destino)
--   auto_book_mail_rules  — a RESPOSTA que vira automação (responder uma vez = nunca mais perguntar)

create table if not exists auto_book_mail (
  id            uuid primary key default gen_random_uuid(),
  message_key   text not null unique,     -- slot|received|from|assunto — o Graph/Gmail não devolve id nesta varredura
  slot          int,
  account       text,
  received_at   timestamptz,
  from_addr     text,
  subject       text,
  kind          text not null default 'PURCHASE',   -- PURCHASE | REFUND | CHARGE
  vendor        text,
  order_number  text,
  currency      text default 'USD',
  amount        numeric,
  extracted     jsonb,                    -- tudo que o parser conseguiu ler do e-mail
  question      text,                     -- a ÚNICA pergunta a fazer ao humano
  cands         jsonb,                    -- destinos sugeridos [{table,ref,label,n,last}]
  status        text not null default 'DOUBT',      -- DOUBT | BOOKED | IGNORED | DUPLICATE (2ª carta da mesma compra, 11/set/2026 — Livro 5.9; o robô escreve, gente não responde)
  answer        jsonb,
  answered_at   timestamptz,
  booked_table  text,
  booked_id     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table auto_book_mail is 'AUTO-BOOK e-mail: fila da dúvida. Uma linha = um e-mail com dinheiro que o robô não soube lançar sozinho. Status é o estado da PERGUNTA, nunca o do item (esse é derivado).';
create index if not exists auto_book_mail_open_idx on auto_book_mail (status, received_at desc) where status = 'DOUBT';
create index if not exists auto_book_mail_order_idx on auto_book_mail (order_number);

create table if not exists auto_book_mail_rules (
  id            uuid primary key default gen_random_uuid(),
  label         text,
  match_from    text,          -- casa em from_addr (substring, minúsculas)
  match_subject text,          -- casa no assunto (substring, minúsculas)
  match_vendor  text,          -- casa no fornecedor derivado
  action        text not null default 'ASK',   -- BOOK | IGNORE | ASK
  target        jsonb,         -- BOOK: {table, invoice_id|season_id, ...campos fixos}
  note          text,
  hits          int not null default 0,
  last_hit_at   timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
comment on table auto_book_mail_rules is 'AUTO-BOOK e-mail: a resposta humana virada automação. Responder uma dúvida com learn=true escreve aqui e o mesmo caso nunca mais é perguntado.';

-- Conferência (só leitura):
--   select status, count(*) from auto_book_mail group by 1;
--   select label, action, hits, last_hit_at from auto_book_mail_rules order by hits desc;
