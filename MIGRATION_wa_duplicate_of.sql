-- ═══════════════════════════════════════════════════════════════════════════
-- A REPETIÇÃO VIRA DADO, NÃO REGRA QUE CADA LEITOR PRECISA LEMBRAR
--
--   "o app tem que identificar se é repetido"  — Márcio, 09/set/2026
--
-- ── O QUE FOI MEDIDO ───────────────────────────────────────────────────────
--   FINANCEIRO  794 linhas · 494 message_id · 300 excedentes (38%)
--   COMPRAS     354 linhas · 354 message_id ·   0
--   espelho todo (20.000 recentes) · 268 chats · 44 com os dois rótulos · 680
--
-- A causa NÃO é escritor em duplicidade: `whatsapp_messages` já tem unicidade
-- em (app, message_id), e nos pares o que muda é sempre `app`, nunca `via`.
-- É o MESMO recado visto por DUAS LINHAS TELEFÔNICAS — os dois números estão
-- dentro do grupo FINANCEIRO, e cada instância espelha o que enxerga. O
-- `message_id` é idêntico porque a mensagem é uma só.
--
-- Por isso NÃO se colapsa por message_id: o rótulo `app` é o que diz por qual
-- número responder, e report BR sai pela instância BR. As duas linhas ficam.
--
-- O que entra é a MARCA: `duplicate_of` aponta para a primeira linha que viu
-- aquela mensagem. NULL = esta é a canônica. Quem lê pergunta a um campo só —
-- `where duplicate_of is null` — em vez de reconstruir a regra.
--
-- Quem carimba é um GATILHO, não o app: assim nenhum escritor futuro pode
-- esquecer. É a mesma pergunta que o `content_hash` responde nos arquivos do
-- Dropbox ("isto que estou vendo já é uma coisa que eu tenho?"), só que aqui a
-- identidade já vem pronta do WhatsApp.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. A MARCA. Sem FOREIGN KEY de propósito: `id` pode ser int4 e a marca é
--    bigint; e uma linha canônica apagada não deve derrubar a repetida junto.
alter table public.whatsapp_messages
  add column if not exists duplicate_of bigint;

comment on column public.whatsapp_messages.duplicate_of is
  'A mesma mensagem vista por outra instância: aponta para a linha canônica (o menor id do par chat_id+message_id). NULL = esta é a canônica. Carimbado pelo gatilho wa_marca_repetida.';

-- 2. QUEM LÊ, LÊ RÁPIDO.
create index if not exists whatsapp_messages_canonica_idx
  on public.whatsapp_messages (chat_id, sent_at desc)
  where duplicate_of is null;

create index if not exists whatsapp_messages_identidade_idx
  on public.whatsapp_messages (chat_id, message_id, id);

-- 3. O RETROATIVO. Sem isto o campo mentiria nas linhas velhas — e campo em
--    que não se confia não serve de trava.
with canonica as (
  select chat_id, message_id, min(id) as id_canonica
    from public.whatsapp_messages
   group by chat_id, message_id
)
update public.whatsapp_messages m
   set duplicate_of = c.id_canonica
  from canonica c
 where m.chat_id = c.chat_id
   and m.message_id = c.message_id
   and m.id <> c.id_canonica
   and m.duplicate_of is distinct from c.id_canonica;

-- 4. O GATILHO. A linha nova já nasce sabendo que é segunda visão.
create or replace function public.wa_marca_repetida() returns trigger
language plpgsql as $$
begin
  select id into new.duplicate_of
    from public.whatsapp_messages
   where chat_id = new.chat_id
     and message_id = new.message_id
   order by id asc
   limit 1;
  return new;
end;
$$;

drop trigger if exists wa_marca_repetida on public.whatsapp_messages;
create trigger wa_marca_repetida
  before insert on public.whatsapp_messages
  for each row execute function public.wa_marca_repetida();

-- 5. A CONFERÊNCIA — tem de sobrar UMA canônica por mensagem.
select
  count(*)                                            as linhas,
  count(*) filter (where duplicate_of is null)        as canonicas,
  count(*) filter (where duplicate_of is not null)    as repetidas,
  count(distinct (chat_id || '|' || message_id))      as mensagens_reais
from public.whatsapp_messages;
