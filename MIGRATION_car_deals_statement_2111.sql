-- CAR DEALS — ADENDO: CONTA-CORRENTE DO CLIENTE + DOCUMENTOS (Márcio 21/11/2026, via CC Sidney; spec, seções ADENDO A–F).
-- NÃO é um segundo livro: as três versões (GZ28 / cliente / contador) são três leituras de deal_movements + deal_allocations.
--   versão GZ28    = uma linha por ALOCAÇÃO (cada centavo com destino)
--   versão cliente = uma linha por MOVIMENTO
--   versão contador = a do cliente sem as linhas pessoais, no Excel dele
-- Uma conta-corrente por cliente, só no US; o que é do BR entra por referência (source 'BR', valor original em R$ + câmbio).

-- 1) o movimento sabe de quem é a conta-corrente e o que o CLIENTE lê (a nota interna nunca sai)
alter table public.deal_movements add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.deal_movements add column if not exists statement_label text;
alter table public.deal_movements add column if not exists statement_note text;
alter table public.deal_movements add column if not exists personal boolean not null default false;
create index if not exists deal_movements_client_idx on public.deal_movements (client_id, occurred_on);

-- 2) a alocação pode ser só de oficina (sem deal): aponta para a renda / invoice / carro
alter table public.deal_allocations alter column deal_id drop not null;
alter table public.deal_allocations add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
alter table public.deal_allocations add column if not exists ride_id uuid references public.rides(id) on delete set null;
alter table public.deal_allocations add column if not exists statement_label text;      -- «PAGAMENTO 4ª parcela da preparação (parcial)»
alter table public.deal_allocations add column if not exists statement_code text;       -- «Motor 20», «Compra 19»
alter table public.deal_allocations add column if not exists car_name text;             -- nome do carro para o cliente, quando o ride não é do US
alter table public.deal_allocations add column if not exists source text not null default 'US';
alter table public.deal_allocations add column if not exists br_invoice_id uuid;        -- referência ao app do BR (só leitura; nada é copiado)
alter table public.deal_allocations add column if not exists br_payment_id uuid;
alter table public.deal_allocations add column if not exists amount_brl numeric;
alter table public.deal_allocations add column if not exists fx_rate numeric;
do $$ begin
  alter table public.deal_allocations add constraint deal_allocations_source_chk check (source in ('US', 'BR'));
exception when duplicate_object then null; end $$;

-- 3) os débitos da conta-corrente: o que foi faturado
create table if not exists public.statement_charges (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  ride_id uuid references public.rides(id) on delete set null,
  charged_on date not null,
  car_name text,                                  -- sobrepõe rides.statement_name (carro do BR, ou linha sem carro)
  code text,                                      -- «Motor 20», «Compra 19»
  label text not null,                            -- «Preparação», «Envelopamento»
  amount_usd numeric not null,
  nf_number text,
  note text,                                      -- coluna OBS (o cliente lê)
  personal boolean not null default false,        -- linha pessoal: fora da versão do contador
  position int,
  source text not null default 'US' check (source in ('US', 'BR')),
  br_invoice_id uuid,
  amount_brl numeric,
  fx_rate numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists statement_charges_client_idx on public.statement_charges (client_id, charged_on);
create index if not exists statement_charges_invoice_idx on public.statement_charges (invoice_id);

-- 4) o nome do carro para o cliente: modelo + cor, nunca o apelido interno
alter table public.rides add column if not exists statement_name text;

-- 5) documentos do deal: proforma, contratos de câmbio, SWIFT, TÍTULO, BL — a prova fica no carro
create table if not exists public.deal_documents (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.car_deals(id) on delete cascade,
  kind text not null check (kind in ('TITLE', 'PROFORMA', 'FX_CONTRACT', 'SWIFT', 'PAYMENT_PROOF', 'BILL_OF_SALE', 'BL', 'EXPORT', 'OTHER')),
  label text,
  file_url text not null,
  file_name text,
  movement_id uuid references public.deal_movements(id) on delete set null,
  doc_date date,
  uploaded_by text,
  created_at timestamptz not null default now()
);
create index if not exists deal_documents_deal_idx on public.deal_documents (deal_id, kind);

-- 6) RLS + grants
do $$ declare t text; begin
  foreach t in array array['statement_charges', 'deal_documents'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'authenticated all') then
      execute format('create policy "authenticated all" on public.%I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;
grant select, insert, update, delete on public.statement_charges to authenticated;
grant select, insert, update, delete on public.statement_charges to service_role;
grant select, insert, update, delete on public.deal_documents to authenticated;
grant select, insert, update, delete on public.deal_documents to service_role;

-- 7) postagem da conta-corrente no grupo: nasce DESLIGADA
insert into public.app_settings (key, value, note)
values ('statement.auto_post', 'false'::jsonb, 'CONTA-CORRENTE: postar sozinho o xlsx/pdf no grupo do cliente quando a conta muda. Nasce DESLIGADA (21/11/2026); o Márcio aprova cada envio.')
on conflict (key) do nothing;
