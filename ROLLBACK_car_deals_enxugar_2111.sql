-- Volta do MIGRATION_car_deals_enxugar_2111.sql: recria as COLUNAS (vazias). Os valores de antes estão, linha a linha,
-- em scratchpad/car-deals-backup-2111/*.txt (json por tabela); sheet (jsonb) e sheet_style.color guardam a aparência.
alter table public.car_deals add column if not exists ride_id uuid, add column if not exists client_id uuid, add column if not exists wa_chat_app text,
  add column if not exists sheet_title text, add column if not exists sheet_color_name text, add column if not exists sheet_band_color text,
  add column if not exists sheet_band_text_color text, add column if not exists sheet_headers jsonb, add column if not exists sheet_notes jsonb;
update public.car_deals d set ride_id = i.ride_id, client_id = i.client_id, wa_chat_app = 'us',
  sheet_title = d.sheet->>'title', sheet_color_name = d.sheet->>'color_name', sheet_band_color = d.sheet->>'band_color',
  sheet_band_text_color = d.sheet->>'band_text_color', sheet_headers = d.sheet->'headers', sheet_notes = d.sheet->'notes'
  from public.invoices i where i.id = d.purchase_invoice_id;
alter table public.deal_movements add column if not exists fx_rate numeric, add column if not exists source_chat_id text,
  add column if not exists confirmed_at timestamptz, add column if not exists confirmed_by text, add column if not exists bank_transaction_id text;
update public.deal_movements set fx_rate = round(amount_brl / nullif(amount_usd, 0), 2) where amount_brl is not null;
alter table public.deal_allocations add column if not exists sheet_color text;
update public.deal_allocations set sheet_color = sheet_style->>'color' where sheet_style ? 'color';
alter table public.deal_obligations add column if not exists status text not null default 'OPEN', add column if not exists note text;
update public.deal_obligations set status = 'CANCELLED' where cancelled;
