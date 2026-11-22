-- CAR DEALS — o câmbio aparece na planilha do carro em que foi OFICIALMENTE computado (Márcio, 21/11/2026: «o $ tem que
-- estar na planilha dele onde oficialmente foi computado; se foi realocado, use o padrão dele de controle pra dizer pra
-- onde e por quê foi realocado»). official_deal_id = o carro cuja fatura/proforma o contrato de câmbio cita. É informação
-- nova — não deriva de nada (fiscal_ref é o texto do contrato; a alocação diz para onde o dinheiro FOI).
alter table public.deal_movements add column if not exists official_deal_id uuid references public.car_deals(id) on delete set null;
create index if not exists deal_movements_official_idx on public.deal_movements (official_deal_id);
