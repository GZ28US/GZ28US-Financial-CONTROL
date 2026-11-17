-- PARCEL LOCKER ROBOT (Marcio, 17/11/2026, via Messaging ROUNDS: «independent of in whose's name it is, send always the instructions
-- with code, supplier and what it is to chris at her us phone. that should be automatic, done by the robot»).
-- Uma linha por e-mail de locker lido (Parcel Pending / Quadient e parecidos): o que o robo leu, o que montou e o que fez.
-- E o registro que faltava: quem pergunta «a Chris foi avisada do L24?» le aqui.
create table if not exists public.parcel_locker_notices (
  id            uuid primary key default gen_random_uuid(),
  slot          int  not null,
  account       text not null,
  message_id    text not null,
  received_at   timestamptz,
  subject       text,
  service       text,              -- Parcel Pending, ...
  is_reminder   boolean not null default false,
  unit          text,
  location      text,
  box           text,              -- L 24
  code          text,              -- pickup code
  carrier       text,              -- DELIVERED BY
  fee_text      text,              -- $3.00 per day after 2 days
  deadline_at   timestamptz,       -- quando a taxa comeca
  parcel_key    text,              -- box|code: o mesmo pacote avisado em 2 caixas, ou no REMINDER, e um so
  item_text     text,              -- o que o robo achou que e
  match_via     text,              -- de onde saiu o item (e-mail, tabela)
  wa_to         text,
  wa_body       text,
  status        text not null,     -- SENT | PREVIEW (chave desligada) | DUPLICATE | STALE | NOT_PARSED | FAILED
  wa_result     text,
  filed         boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account, message_id)
);
create index if not exists parcel_locker_notices_key on public.parcel_locker_notices (parcel_key, created_at desc);

alter table public.parcel_locker_notices enable row level security;
grant select on public.parcel_locker_notices to anon;
grant select, insert, update, delete on public.parcel_locker_notices to authenticated;
grant select, insert, update, delete on public.parcel_locker_notices to service_role;
create policy parcel_locker_notices_auth on public.parcel_locker_notices for all to authenticated using (true) with check (true);

-- A chave nasce DESLIGADA (lei de 06/11/2026: toda notificacao automatica nova nasce OFF em app_settings).
-- Desligada, o robo le, monta a mensagem e grava como PREVIEW — nao manda nem arquiva nada.
insert into public.app_settings (key, value, updated_by, note)
values ('notify.chris.parcel_locker', 'false'::jsonb, 'App Development 2',
        'Robo do locker: aviso automatico no WhatsApp da Chris a cada encomenda no locker. true = manda sozinho, sem rascunho.')
on conflict (key) do nothing;
