-- CAR DEALS — etapa 1 (Márcio, 21/11/2026, pedido vindo da sessão CC Sidney; spec em docs/SPEC-CAR-DEALS-2026-11-21.md).
-- Compra de carro separada das invoices de oficina + livro Tripa Trading / Sidney / GZ28.
-- Regra de ouro: UMA movimentação = um dinheiro real, lançado uma vez; a ALOCAÇÃO é separada da referência fiscal.
-- Rendas e despesas NÃO mudam de tabela (invoice_incomes / invoice_expenses): o financeiro não se mexe.

-- 1) invoices.kind -------------------------------------------------------------------------------------------------------
alter table public.invoices add column if not exists kind text not null default 'SERVICE';
do $$ begin
  alter table public.invoices add constraint invoices_kind_chk check (kind in ('SERVICE', 'CAR_PURCHASE'));
exception when duplicate_object then null; end $$;

-- backfill: as 7 compras do Sidney, com trilha
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'car-deals-kind', 'invoices', id::text, 'kind', kind, 'CAR_PURCHASE', invoice_code || ' — compra de carro sai da lista de serviço (CAR DEALS, 21/11/2026)'
  from public.invoices
 where invoice_code in ('US.019.1', 'US.030.1', 'US.031.1', 'US.032.1', 'US.040.1', 'US.042.2', 'US.050.1') and kind <> 'CAR_PURCHASE';
update public.invoices set kind = 'CAR_PURCHASE'
 where invoice_code in ('US.019.1', 'US.030.1', 'US.031.1', 'US.032.1', 'US.040.1', 'US.042.2', 'US.050.1') and kind <> 'CAR_PURCHASE';

-- 2) car_deals -----------------------------------------------------------------------------------------------------------
create table if not exists public.car_deals (
  id uuid primary key default gen_random_uuid(),
  deal_no text,                                   -- o «Compra 15» do Tripa
  ride_id uuid references public.rides(id) on delete set null,
  purchase_invoice_id uuid unique references public.invoices(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  exporter text,                                  -- TRIPA_TRADING; null = sem exportador
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED', 'CANCELLED')),
  declared_value_usd numeric,                     -- valor de proforma
  wa_chat_id text,                                -- grupo COMPRA do deal
  wa_chat_app text check (wa_chat_app in ('us', 'br')),
  -- audiência da planilha: [{ "chat_id": "...", "app": "us", "label": "...", "view": "TRIPA" | "SIDNEY" | "GZ28" }]
  post_targets jsonb not null default '[]'::jsonb,
  auto_post boolean not null default false,       -- nasce DESLIGADO; a chave geral mora em app_settings
  last_post_hash text,
  -- planilha no layout do Tripa
  sheet_title text,                               -- «SIDNEY  15»
  sheet_color_name text,                          -- «Preto»
  sheet_band_color text,                          -- cor da faixa (#000000)
  sheet_band_text_color text,
  sheet_headers jsonb,                            -- 7 títulos da linha 1 (variante da Compra 16)
  sheet_notes jsonb,                              -- notas livres da tela: [{ "row": 5, "col": "F", "text": "...", "color": "#E8231A", "bold": true }]
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists car_deals_ride_idx on public.car_deals (ride_id);

-- 3) deal_charges: as linhas de custo da tela ----------------------------------------------------------------------------
create table if not exists public.deal_charges (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.car_deals(id) on delete cascade,
  position int not null default 0,
  label text not null,                            -- «SRT HELLCAT», «EMC N 17», «Frete P/ Miami»
  amount_usd numeric,
  text_value text,                                -- «Não vai ter», «Confirmar»
  created_at timestamptz not null default now()
);
create index if not exists deal_charges_deal_idx on public.deal_charges (deal_id, position);

-- 4) deal_milestones -----------------------------------------------------------------------------------------------------
create table if not exists public.deal_milestones (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.car_deals(id) on delete cascade,
  kind text not null check (kind in ('PURCHASED', 'DEALER_PAID', 'TITLE_RECEIVED', 'DELIVERED_MIAMI', 'EXPORTED', 'ARRIVED_BR', 'NATIONALIZED')),
  done_at date,
  proof_url text,
  note text,
  created_at timestamptz not null default now(),
  unique (deal_id, kind)
);

-- 5) deal_obligations: quem deve a quem, com DATA ou CONDIÇÃO --------------------------------------------------------------
create table if not exists public.deal_obligations (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.car_deals(id) on delete cascade,
  from_party text not null check (from_party in ('SIDNEY', 'TRIPA_TRADING', 'GZ28US', 'DEALER')),
  to_party text not null check (to_party in ('SIDNEY', 'TRIPA_TRADING', 'GZ28US', 'DEALER')),
  label text not null,
  amount_usd numeric not null,
  due_date date,
  trigger_milestone text check (trigger_milestone in ('PURCHASED', 'DEALER_PAID', 'TITLE_RECEIVED', 'DELIVERED_MIAMI', 'EXPORTED', 'ARRIVED_BR', 'NATIONALIZED')),
  trigger_offset_days int not null default 0,
  status text not null default 'OPEN' check (status in ('OPEN', 'DUE', 'PAID', 'CANCELLED')),
  note text,
  created_at timestamptz not null default now(),
  check (from_party <> to_party)
);
create index if not exists deal_obligations_deal_idx on public.deal_obligations (deal_id);

-- 6) deal_movements: o livro (dinheiro real, uma vez) -----------------------------------------------------------------------
create table if not exists public.deal_movements (
  id uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  kind text not null check (kind in ('FX_CONTRACT', 'PIX', 'WIRE', 'ZELLE', 'STRIPE', 'CASH', 'OFFSET')),
  from_party text not null check (from_party in ('SIDNEY', 'TRIPA_TRADING', 'GZ28US', 'DEALER')),
  to_party text not null check (to_party in ('SIDNEY', 'TRIPA_TRADING', 'GZ28US', 'DEALER')),
  amount_usd numeric not null,
  amount_brl numeric,
  fx_rate numeric,
  counterparty_label text,                        -- o «Planer 08/06» da tela
  payer_label text,                               -- Sidney / JP / JV
  fiscal_ref text,                                -- nº da proforma / contrato de câmbio — NÃO é a alocação
  receipt_urls jsonb not null default '[]'::jsonb,
  source_chat_id text,
  source_message_id text,                         -- mensagem do grupo que originou a proposta
  bank_transaction_id text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'CONFIRMED')),
  confirmed_at timestamptz,
  confirmed_by text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deal_movements_date_idx on public.deal_movements (occurred_on);
create unique index if not exists deal_movements_source_msg_uq on public.deal_movements (source_message_id) where source_message_id is not null;

-- 7) deal_allocations: o rateio entre deals ------------------------------------------------------------------------------
create table if not exists public.deal_allocations (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references public.deal_movements(id) on delete cascade,
  deal_id uuid not null references public.car_deals(id) on delete cascade,
  obligation_id uuid references public.deal_obligations(id) on delete set null,
  amount_usd numeric not null,
  -- ligação com o que já existe (não duplica renda/despesa): o pedaço do movimento que virou renda ou despesa da invoice
  invoice_income_id uuid references public.invoice_incomes(id) on delete set null,
  invoice_expense_id uuid references public.invoice_expenses(id) on delete set null,
  sheet_color text,                               -- cor do lote na tela do Tripa
  sheet_position int,
  sheet_style jsonb,                              -- miudezas da tela (negrito, centralizado…)
  note text,
  created_at timestamptz not null default now()
);
create index if not exists deal_allocations_mov_idx on public.deal_allocations (movement_id);
create index if not exists deal_allocations_deal_idx on public.deal_allocations (deal_id);

-- 8) soma das alocações = valor do movimento (vale para movimento CONFIRMED; conferido no fim da transação) -----------------
create or replace function public.deal_movement_sum_check() returns trigger language plpgsql as $$
declare mid uuid; mv record; total numeric;
begin
  if tg_table_name = 'deal_movements' then mid := new.id;
  elsif tg_op = 'DELETE' then mid := old.movement_id;
  else mid := new.movement_id; end if;
  select * into mv from public.deal_movements where id = mid;
  if not found or mv.status <> 'CONFIRMED' then return null; end if;
  select coalesce(sum(amount_usd), 0) into total from public.deal_allocations where movement_id = mid;
  if round(total, 2) <> round(mv.amount_usd, 2) then
    raise exception 'CAR DEALS: movimento % confirmado com alocações somando % (o movimento vale %). Aloque tudo antes de confirmar; para realocar, volte o movimento para PROPOSED.', mid, total, mv.amount_usd;
  end if;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'deal_movements_sum_chk') then
    create constraint trigger deal_movements_sum_chk after insert or update on public.deal_movements
      deferrable initially deferred for each row execute function public.deal_movement_sum_check();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'deal_allocations_sum_chk') then
    create constraint trigger deal_allocations_sum_chk after insert or update or delete on public.deal_allocations
      deferrable initially deferred for each row execute function public.deal_movement_sum_check();
  end if;
end $$;

-- 9) marcar o marco torna DUE a obrigação condicionada a ele ----------------------------------------------------------------
create or replace function public.deal_milestone_fires() returns trigger language plpgsql as $$
begin
  if new.done_at is not null then
    update public.deal_obligations
       set status = 'DUE', due_date = new.done_at + trigger_offset_days
     where deal_id = new.deal_id and trigger_milestone = new.kind and status = 'OPEN';
  elsif tg_op = 'UPDATE' and old.done_at is not null then
    update public.deal_obligations
       set status = 'OPEN', due_date = null
     where deal_id = new.deal_id and trigger_milestone = new.kind and status = 'DUE';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'deal_milestones_fire') then
    create trigger deal_milestones_fire after insert or update of done_at on public.deal_milestones
      for each row execute function public.deal_milestone_fires();
  end if;
end $$;

-- 10) RLS + grants (lei de 30/10: tabela nova precisa de grant) ---------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['car_deals', 'deal_charges', 'deal_milestones', 'deal_obligations', 'deal_movements', 'deal_allocations'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'authenticated all') then
      execute format('create policy "authenticated all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;
grant select, insert, update, delete on public.car_deals to authenticated;
grant select, insert, update, delete on public.car_deals to service_role;
grant select, insert, update, delete on public.deal_charges to authenticated;
grant select, insert, update, delete on public.deal_charges to service_role;
grant select, insert, update, delete on public.deal_milestones to authenticated;
grant select, insert, update, delete on public.deal_milestones to service_role;
grant select, insert, update, delete on public.deal_obligations to authenticated;
grant select, insert, update, delete on public.deal_obligations to service_role;
grant select, insert, update, delete on public.deal_movements to authenticated;
grant select, insert, update, delete on public.deal_movements to service_role;
grant select, insert, update, delete on public.deal_allocations to authenticated;
grant select, insert, update, delete on public.deal_allocations to service_role;

-- 11) chave do robô de postagem: nasce DESLIGADA --------------------------------------------------------------------------
insert into public.app_settings (key, value, note)
values ('car_deals.auto_post', 'false'::jsonb, 'CAR DEALS: postar sozinho a planilha (xlsx + pdf) no grupo do deal e no privado do Tripa quando um movimento é confirmado. Nasce DESLIGADA (21/11/2026); só o Márcio liga.')
on conflict (key) do nothing;
