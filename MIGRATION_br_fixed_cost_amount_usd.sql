-- TRAVESSIA: CUSTO FIXO DO BR PAGO PELO GZ28US → 006.N (18/10/2026) — lib/crossing.server.ts, planejarFixoBR (mirror_key 'BR:fixed:<supplier_id>')
-- Projeto: Supabase BR.
--
-- O espelho da direção 3 (custo fixo do US pago pelo GZ28BR → 085.N por fornecedor): custo fixo do BR PAID FROM GZ28US vira uma
-- 006.N por fornecedor. amount_usd = o US$ que o BR deve ao US por esta linha, COM os 10% da casa US — a mesma regra de
-- invoice_expenses.amount_usd do BR na direção 1: despesa no US = amount_usd ÷ 1,10 (o que a Regions pagou), item = amount_usd.
-- Valor gravado prevalece; o motor nunca deriva o US$ do R$. Caso que abriu: UltraMsg da instância do BR (006.9), AutoBook GZ28US 18/10.
alter table public.fixed_cost_expenses add column if not exists amount_usd numeric(14,2);
comment on column public.fixed_cost_expenses.amount_usd is 'US$ que o BR deve ao GZ28US por esta linha (com os 10% da casa US). Linha PAID FROM GZ28US: atravessa para a 006.N do fornecedor (despesa = amount_usd / 1,10; item = amount_usd).';
notify pgrst, 'reload schema';
