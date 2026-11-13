-- SOCIAL INBOX + OUTBOX — Facebook / Instagram a fundo (Márcio, 11/11/2026 via FaceBook ROUND: «i want the app fully connected to
-- facebook, do it, as deep as possible» · 13/11: «faça a conexão do Facebook»).
--   social_items           tudo que chega ou sai nas contas: mensagem (TODAS as pastas do Messenger, inclusive spam/other), comentário,
--                          menção, lead. Uma linha por coisa, nunca repetida (platform + kind + external_id).
--   social_outbox          toda ESCRITA nasce aqui como RASCUNHO: responder mensagem/comentário, ocultar/apagar comentário, publicar.
--                          Só sai depois de APROVADA por um humano logado na tela — e só com social.publish.enabled ligado.
--   social_webhook_events  o que a Meta empurrar pelo webhook, cru, para auditoria (o webhook só entrega de quem não tem papel no app
--                          quando o app estiver Live; até lá quem alimenta o inbox é a leitura periódica).
-- Chaves novas, nascem FALSE: social.inbox.enabled (a leitura periódica). Nada aqui manda nada a ninguém.
-- Servidor apenas: RLS ligada SEM policy (anon/authenticated não leem nada); a tela passa pelas rotas, com login.
begin;

insert into public.app_settings (key, value, note, updated_by) values
  ('social.inbox.enabled', 'false'::jsonb, 'SOCIAL INBOX — leitura periódica (15 min) de mensagens (todas as pastas), comentários, menções e leads do Facebook/Instagram para social_items. Só LÊ. OFF.', 'migration 13/11/2026')
on conflict (key) do nothing;
insert into public.app_settings (key, value, note, updated_by) values
  ('social.meta.leads.enabled', 'false'::jsonb, 'LEAD ADS — quando ligado, o CONNECT da Meta pede também leads_retrieval + pages_manage_ads (acrescentar antes no app da Meta, em Use cases → Customize) e o inbox passa a ler os leads dos formulários. OFF.', 'migration 13/11/2026')
on conflict (key) do nothing;

create table if not exists public.social_items (
  id bigint generated always as identity primary key,
  platform text not null check (platform in ('FACEBOOK', 'INSTAGRAM')),
  kind text not null check (kind in ('MESSAGE', 'COMMENT', 'MENTION', 'LEAD')),
  external_id text not null,
  account_id bigint references public.social_auth(id) on delete set null,   -- a página / conta IG nossa
  thread_id text,               -- conversa (mensagem) · post/mídia (comentário) · formulário (lead)
  thread_title text,            -- com quem é a conversa · começo do post
  parent_id text,               -- comentário-pai, quando é resposta
  folder text,                  -- só mensagem: inbox | other | spam | page_done | instagram
  from_id text,                 -- PSID / IGSID / id de quem escreveu (é para ele que a resposta vai)
  from_name text,
  from_me boolean not null default false,
  body text,
  attachments integer not null default 0,
  permalink text,
  hidden boolean not null default false,
  happened_at timestamptz not null,
  source text not null default 'POLL' check (source in ('POLL', 'WEBHOOK')),
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  seen_at timestamptz,          -- um humano viu na tela (null = NOVO)
  seen_by text,
  gone_at timestamptz,          -- apagado lá (comentário removido)
  unique (platform, kind, external_id)
);
create index if not exists social_items_when_idx on public.social_items (happened_at desc);
create index if not exists social_items_thread_idx on public.social_items (thread_id, happened_at);
create index if not exists social_items_new_idx on public.social_items (first_seen_at desc) where seen_at is null and not from_me;
alter table public.social_items enable row level security;
revoke all on public.social_items from public, anon, authenticated;
grant select on public.social_items to authenticated;                         -- sem policy → não lê nada (freio do roda-sql)
grant select, insert, update, delete on public.social_items to service_role;

create table if not exists public.social_outbox (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.social_auth(id) on delete cascade,
  platform text not null check (platform in ('FACEBOOK', 'INSTAGRAM')),
  action text not null check (action in ('MESSAGE_REPLY', 'COMMENT_REPLY', 'COMMENT_HIDE', 'COMMENT_UNHIDE', 'COMMENT_DELETE', 'POST_PUBLISH')),
  target_id text,               -- PSID/IGSID (mensagem) · id do comentário · null (publicar)
  item_id bigint references public.social_items(id) on delete set null,       -- a que isto responde
  body text,
  link text,                    -- só POST_PUBLISH
  context text,                 -- a quem / sobre o quê, para quem aprova ler sem abrir mais nada
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SENT', 'FAILED', 'CANCELLED')),
  created_by text not null,     -- e-mail do humano, ou 'session' (Claude por chave de leitura)
  created_at timestamptz not null default now(),
  approved_by text,             -- SEMPRE um e-mail de humano logado
  approved_at timestamptz,
  sent_at timestamptz,
  result jsonb,
  error text
);
create index if not exists social_outbox_status_idx on public.social_outbox (status, created_at desc);
alter table public.social_outbox enable row level security;
revoke all on public.social_outbox from public, anon, authenticated;
grant select on public.social_outbox to authenticated;
grant select, insert, update, delete on public.social_outbox to service_role;

create table if not exists public.social_webhook_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  object text,
  signature_ok boolean not null,
  raw jsonb not null
);
create index if not exists social_webhook_events_when_idx on public.social_webhook_events (received_at desc);
alter table public.social_webhook_events enable row level security;
revoke all on public.social_webhook_events from public, anon, authenticated;
grant select on public.social_webhook_events to authenticated;
grant select, insert, update, delete on public.social_webhook_events to service_role;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
values ('social-inbox-1', 'social_items', 'tables social_items + social_outbox + social_webhook_events + switch social.inbox.enabled', 'migration', null, 'created (switch false)', 'MIGRATION_social_inbox.sql');

commit;
