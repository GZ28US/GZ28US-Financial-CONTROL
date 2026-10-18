-- TRAVESSIA: MARKUP POR LINHA NO CUSTO FIXO DO BR PAGO PELO GZ28US (18/10/2026) — lib/crossing.server.ts, planejarFixoBR
-- Projeto: Supabase BR. A mesma régua de invoice_expenses.us_markup_pct: vazio = a lei do 10% US; 0 = custo exato; outro = aquele %.
-- Caso que abriu: The Tuning School (62375248), metade do GZ28BR US$ 1.500 — Márcio 18/10: «US$ 1,500» (sem os 10%, como a folha em 14/09).
alter table public.fixed_cost_expenses add column if not exists us_markup_pct numeric(6,2);
comment on column public.fixed_cost_expenses.us_markup_pct is 'Markup do GZ28US sobre esta linha paga pelo GZ28US: vazio = 10% (lei US); 0 = custo exato; outro = aquele %. amount_usd já inclui este markup.';
notify pgrst, 'reload schema';
