-- MARCA D'AGUA DO E-MAIL (Marcio, 02/set/2026):
--   "todos os emails processados devem ir pra sua pasta e marcados como processados"
--
-- O WhatsApp ja tinha isso (whatsapp_chats.processed_through/processed_at/processed_note):
-- processada e uma marca gravada, e mensagem posterior REABRE a conversa sozinha.
-- O e-mail nao tinha nada: "processado" significava apenas "saiu da inbox" — nao
-- distinguia ARQUIVEI de LANCEI NO APP, nao dizia quem fez nem quando, e a
-- informacao sumia se alguem movesse a mensagem de novo. Foi assim que dois
-- e-mails da HP Tuners sumiram da vista em 02/set e ninguem soube explicar onde
-- estavam nem por que.
create table if not exists mail_processed (
  id                 uuid primary key default gen_random_uuid(),
  account            text        not null,
  slot               int         not null,
  origin_message_id  text        not null,
  message_id         text,
  subject            text,
  from_addr          text,
  received_at        timestamptz,
  folder             text,
  action             text        not null,
  ref_table          text,
  ref_id             text,
  note               text,
  processed_at       timestamptz not null default now()
);

create unique index if not exists mail_processed_uniq
  on mail_processed (account, origin_message_id);

create index if not exists mail_processed_at_idx  on mail_processed (processed_at desc);
create index if not exists mail_processed_ref_idx on mail_processed (ref_table, ref_id);

alter table mail_processed enable row level security;
