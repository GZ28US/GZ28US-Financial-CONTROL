-- Volta do MIGRATION_car_deals_prova_unica_2111.sql: recria deal_movements.receipt_urls a partir de deal_documents.
alter table public.deal_movements add column if not exists receipt_urls jsonb not null default '[]'::jsonb;
update public.deal_movements m set receipt_urls = coalesce((select jsonb_agg(d.file_url order by d.created_at) from public.deal_documents d where d.movement_id = m.id), '[]'::jsonb);
