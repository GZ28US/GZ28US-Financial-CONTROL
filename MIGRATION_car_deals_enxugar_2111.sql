-- ENXUGAR — lei do Márcio (21/11/2026): «Um sistema PERFEITO tem UM CAMPO pro INFO! Nunca a mesma info em 2 campos!»
-- O que dá para DERIVAR (join, soma, regra) não é coluna. Tabelas criadas hoje, sem código legado; cópia de tudo antes
-- em scratchpad/car-deals-backup-2111/. Volta: ROLLBACK_car_deals_enxugar_2111.sql.

-- A) CONTA-CORRENTE sem campo próprio: débito = a invoice; cliente e carro = os da invoice da alocação.
drop table if exists public.statement_charges;
alter table public.rides drop column if exists statement_name;                       -- nome para o cliente = model + color
alter table public.deal_movements
  drop column if exists client_id, drop column if exists statement_label, drop column if exists personal,
  drop column if exists nf_number, drop column if exists statement_position;         -- fica UM texto para o cliente: statement_note
alter table public.deal_allocations
  drop column if exists invoice_id, drop column if exists ride_id, drop column if exists statement_label,
  drop column if exists statement_code, drop column if exists car_name, drop column if exists source,
  drop column if exists br_invoice_id, drop column if exists br_payment_id, drop column if exists amount_brl,
  drop column if exists fx_rate, drop column if exists nf_number, drop column if exists statement_position,
  drop column if exists statement_note;
delete from public.app_settings where key = 'statement.auto_post';                   -- chave de uma rota que não existe

-- B) car_deals: carro e cliente vêm da invoice de compra; a aparência da planilha cabe num jsonb só
alter table public.car_deals add column if not exists sheet jsonb;
update public.car_deals set sheet = nullif(jsonb_strip_nulls(jsonb_build_object(
  'title', sheet_title, 'color_name', sheet_color_name, 'band_color', sheet_band_color,
  'band_text_color', sheet_band_text_color, 'headers', sheet_headers, 'notes', sheet_notes)), '{}'::jsonb)
 where sheet is null;
alter table public.car_deals
  drop column if exists ride_id, drop column if exists client_id, drop column if exists wa_chat_app,
  drop column if exists sheet_title, drop column if exists sheet_color_name, drop column if exists sheet_band_color,
  drop column if exists sheet_band_text_color, drop column if exists sheet_headers, drop column if exists sheet_notes;

-- C) deal_movements: taxa = R$ ÷ US$; o grupo vem da mensagem; quem/quando confirmou = status + updated_at
alter table public.deal_movements
  drop column if exists fx_rate, drop column if exists source_chat_id, drop column if exists confirmed_at,
  drop column if exists confirmed_by, drop column if exists bank_transaction_id;

-- D) deal_allocations: a cor do lote mora em sheet_style
update public.deal_allocations set sheet_style = coalesce(sheet_style, '{}'::jsonb) || jsonb_build_object('color', sheet_color) where sheet_color is not null;
set constraints all immediate;   -- o gatilho da soma (adiado) confere agora, senão o alter abaixo não passa
alter table public.deal_allocations drop column if exists sheet_color;

-- E) deal_obligations: DUE e PAID são contas (marco feito / data vencida / soma das alocações) — só «cancelada» é fato
alter table public.deal_obligations add column if not exists cancelled boolean not null default false;
update public.deal_obligations set cancelled = true where status = 'CANCELLED';
alter table public.deal_obligations drop column if exists status, drop column if exists note;
drop trigger if exists deal_milestones_fire on public.deal_milestones;               -- a data do vencimento deixou de ser gravada
drop function if exists public.deal_milestone_fires();

-- F) deal_milestones: a prova mora em deal_documents
alter table public.deal_milestones drop column if exists proof_url, drop column if exists note;

-- G) deal_documents: o nome sai do link; quem/quando = created_at
alter table public.deal_documents drop column if exists file_name, drop column if exists uploaded_by, drop column if exists movement_id;

-- H) deal_group_scans: remetente, grupo e hora estão em whatsapp_messages; o deal sai do grupo; o arquivo, do movimento
alter table public.deal_group_scans
  drop column if exists chat_id, drop column if exists deal_id, drop column if exists sent_at, drop column if exists author,
  drop column if exists pushname, drop column if exists file_url;
