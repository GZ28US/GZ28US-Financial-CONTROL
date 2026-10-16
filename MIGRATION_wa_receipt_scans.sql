-- O RECIBO DO GRUPO CASA A LINHA DA REGIONS (16/10/2026) — lib/receiptHunt.server.ts
-- Projeto: Supabase US. Uma linha por FOTO dos grupos «🇺🇸GZ28US Time 🇺🇸» e «GZ28US - STAFF» (espelho whatsapp_messages).
--
-- status:
--   RECEIPT      recibo lido, esperando a linha da Regions
--   NOT_RECEIPT  foto que não é recibo (carro, peça, caixa…)
--   ERROR        leitura falhou (tenta até 3 vezes)
--   BOOKED       lançado no destino da legenda e casado com a linha (bank_id, booked_table, booked_id)
--   CASH_BOOKED  devolução em dinheiro lançada como crédito CASH (gaveta)
--   ASK          o robô não teve certeza — motivo em reason; aparece na linha do Bank Link
--   TWIN         a linha já tinha registro no app; o robô não duplica
--   DUPLICATE    o mesmo recibo postado de novo
create table if not exists public.wa_receipt_scans (
  message_id   text primary key,          -- whatsapp_messages.message_id (app US)
  chat_id      text not null,
  sent_at      timestamptz not null,
  author       text,
  pushname     text,
  caption      text,
  status       text not null,
  store        text,
  receipt_date date,
  receipt_time text,
  charged      numeric(12,2),
  cash_refund  numeric(12,2),
  card_refund  numeric(12,2),
  card_last4   text,
  tender       text,
  items        jsonb,
  raw          jsonb,
  file_url     text,                       -- cópia durável no bucket expense-receipts
  bank_id      text,
  booked_table text,
  booked_id    text,
  reason       text,
  tries        int not null default 1,
  scanned_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index if not exists wa_receipt_scans_status_idx on public.wa_receipt_scans (status, sent_at desc);
create index if not exists wa_receipt_scans_bank_idx on public.wa_receipt_scans (bank_id) where bank_id is not null;

alter table public.wa_receipt_scans enable row level security;   -- sem policies: só a service role
grant select, insert, update, delete on public.wa_receipt_scans to service_role;
