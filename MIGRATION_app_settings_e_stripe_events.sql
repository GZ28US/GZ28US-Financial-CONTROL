-- FUNDAÇÃO DO QUOTE → INVOICE NOVO (06/11/2026, ordem do Márcio via AutoBook GZ28US) — projeto Supabase US.
-- Duas tabelas que não dependem do blueprint:
--
-- 1) app_settings — a chave que o Márcio liga de manhã. Toda rota/página nova do portal do cliente e TODA notificação
--    automática nova nasce DESLIGADA atrás de uma chave daqui (lei de 06/11: «don't send anything to anyone… without my
--    approval»). Lida no servidor por lib/appSettings.server.ts; a tela logada pode ler/escrever (authenticated).
--    Formato: key text + value jsonb (true/false, número, texto) — o mesmo desenho do shop_config, que é da LOJA e fica lá.
--
-- 2) stripe_events — cada evento que o Stripe entrega ao webhook do Control App (/ca/api/stripe/webhook), pelo id do evento
--    (evt_…): a chave de idempotência. Reenvio do mesmo evento não processa duas vezes (lei C-88 do mapa: «idempotent by
--    business key»). Só a service role escreve/lê; RLS ligado sem policy.

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  note       text,                                   -- o que a chave faz, em inglês (app US)
  updated_at timestamptz not null default now(),
  updated_by text                                    -- quem mexeu (e-mail da sessão ou 'migration')
);
alter table public.app_settings enable row level security;
create policy app_settings_authenticated_all on public.app_settings for all to authenticated using (true) with check (true);
grant select on public.app_settings to anon;                                    -- RLS sem policy anon: devolve nada
grant select, insert, update, delete on public.app_settings to authenticated;
grant select, insert, update, delete on public.app_settings to service_role;

insert into public.app_settings (key, value, note, updated_by) values
  ('quote_portal.enabled', 'false'::jsonb, 'Client quote portal (public link, approve/e-sign, Stripe deposit). OFF until Márcio switches it on.', 'migration 06/11/2026')
on conflict (key) do nothing;

create table if not exists public.stripe_events (
  id           text primary key,                      -- evt_… (Stripe event id)
  type         text not null,                         -- checkout.session.completed, …
  livemode     boolean not null default false,
  ref          text,                                  -- business key the handler resolved (invoice id, session id…)
  status       text not null default 'RECEIVED',      -- RECEIVED · DONE · IGNORED · ERROR
  error        text,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists stripe_events_type_idx on public.stripe_events (type, received_at desc);
create index if not exists stripe_events_ref_idx on public.stripe_events (ref) where ref is not null;
alter table public.stripe_events enable row level security;                     -- sem policies: só a service role
grant select on public.stripe_events to anon;                                   -- RLS sem policy: devolve nada
grant select, insert, update, delete on public.stripe_events to authenticated;  -- idem (sem policy, nada passa)
grant select, insert, update, delete on public.stripe_events to service_role;
