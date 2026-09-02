-- WHATSAPP HUB — transcrição dos áudios (02/set/2026)
-- Projeto: Supabase US (o espelho é um só e atende os dois números).
--
-- O áudio vira texto em COLUNA PRÓPRIA — nunca dentro do `body`.
-- `transcript_status` é a própria fila do worker:
--   NULL   = ainda não tentado  (é o que o cron pega)
--   done   = transcrito
--   empty  = provider devolveu vazio (áudio mudo / ruído)
--   error  = falhou; motivo em transcript_error. Reprocessar = voltar a NULL.

alter table whatsapp_messages add column if not exists transcript        text;
alter table whatsapp_messages add column if not exists transcript_status text;
alter table whatsapp_messages add column if not exists transcript_at     timestamptz;
alter table whatsapp_messages add column if not exists transcript_error  text;

-- A fila: só áudio, só o que tem mídia, só o que nunca foi tentado.
create index if not exists whatsapp_messages_transcribe_queue_idx
  on whatsapp_messages (sent_at desc)
  where type in ('ptt','audio') and media_url is not null and transcript_status is null;

-- Busca por conteúdo de áudio junto com o texto das mensagens.
create index if not exists whatsapp_messages_transcript_idx
  on whatsapp_messages using gin (to_tsvector('portuguese', coalesce(transcript,'')));
