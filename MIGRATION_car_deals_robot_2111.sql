-- CAR DEALS — etapa 4: o robô dos grupos (21/11/2026; spec docs/SPEC-CAR-DEALS-2026-11-21.md §6).
-- Uma linha por documento/foto lido nos grupos COMPRA ligados a um deal (car_deals.wa_chat_id). Serve de memória
-- («já li esta mensagem») e de trilha: o que o robô leu e o que fez com isso. O robô NUNCA aloca nem confirma.
--   PROPOSED     comprovante lido → virou deal_movements PROPOSED (movement_id)
--   NOT_PAYMENT  não é comprovante de pagamento (foto do carro, título, BL…)
--   ERROR        leitura falhou (tenta até 3 vezes)
create table if not exists public.deal_group_scans (
  message_id  text primary key,           -- whatsapp_messages.message_id
  chat_id     text not null,
  deal_id     uuid references public.car_deals(id) on delete set null,
  sent_at     timestamptz not null,
  author      text,
  pushname    text,
  status      text not null check (status in ('PROPOSED', 'NOT_PAYMENT', 'ERROR')),
  movement_id uuid references public.deal_movements(id) on delete set null,
  raw         jsonb,
  file_url    text,
  reason      text,
  tries       int not null default 1,
  scanned_at  timestamptz not null default now()
);
create index if not exists deal_group_scans_deal_idx on public.deal_group_scans (deal_id, sent_at desc);
alter table public.deal_group_scans enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_group_scans' and policyname = 'authenticated read') then
    create policy "authenticated read" on public.deal_group_scans for select to authenticated using (true);
  end if;
end $$;
grant select on public.deal_group_scans to authenticated;
grant select, insert, update, delete on public.deal_group_scans to service_role;

-- A leitura dos grupos nasce DESLIGADA (gasta a chave da Anthropic e cria propostas); só o Márcio liga.
insert into public.app_settings (key, value, note)
values ('car_deals.group_scan', 'false'::jsonb, 'CAR DEALS: ler os comprovantes postados nos grupos COMPRA e criar movimentos PROPOSED (nunca aloca nem confirma). Nasce DESLIGADA (21/11/2026); só o Márcio liga.')
on conflict (key) do nothing;
