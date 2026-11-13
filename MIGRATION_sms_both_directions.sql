-- SMS NOS DOIS SENTIDOS (Márcio, 11–12/11/2026: «i'd like to full connect the app with my SMS messages» · «yes»).
-- sms_messages só guardava o que CHEGAVA (atalho do iOS). O histórico do backup do iPhone traz também o que ele MANDOU.
-- Só acrescenta colunas; as 408 linhas do atalho ficam como estão (from_me = false).
--   from_me      true = mensagem que o Márcio mandou
--   guid         identificador da mensagem no iPhone — a importação é idempotente por ele
--   service      SMS | iMessage | RCS
--   author       quem escreveu (mensagem recebida); `sender` passa a ser a CONVERSA (o outro lado; grupo = id do chat)
--   attachments  quantos anexos a mensagem tinha (os arquivos não são importados)
begin;
alter table sms_messages
  add column if not exists from_me boolean not null default false,
  add column if not exists guid text,
  add column if not exists service text,
  add column if not exists author text,
  add column if not exists attachments integer not null default 0;
create unique index if not exists sms_messages_guid_key on sms_messages (guid);
create index if not exists sms_messages_sender_idx on sms_messages (sender, received_at desc);
commit;
