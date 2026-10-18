-- TRAVESSIA: SUPPLIES E ESTOQUE PAGOS PELO GZ28BR (18/10/2026) — lib/crossing.server.ts, grupo 'supplies' (US:supplies:<AAAA-MM>)
-- Projeto: Supabase US.
--
-- Márcio, 17/10/2026: «tudo que está gasto pro GZ28US aí, é paid from GZ28BR, vai diminuir a dívida» · 18/10/2026 (AutoBook
-- GZ28US): «Sim, liberar nas telas». inputs e inventory (comprado) passam a ter PAID FROM GZ28BR (modo 'house_choice' em
-- lib/payerRule.ts) e atravessam para uma 085.N por mês. amount_brl = o R$ REAL da linha (total), que prevalece sobre a
-- cotação do app — como em invoice_expenses, staff_expenses e fixed_cost_expenses.
alter table public.inputs    add column if not exists amount_brl numeric(14,2);
alter table public.inventory add column if not exists amount_brl numeric(14,2);
comment on column public.inputs.amount_brl    is 'R$ real da linha (total). Linha PAID FROM GZ28BR: prevalece sobre a cotação na travessia (085.N de SUPPLIES do mês).';
comment on column public.inventory.amount_brl is 'R$ real da linha (total). Linha PAID FROM GZ28BR: prevalece sobre a cotação na travessia (085.N de SUPPLIES do mês).';
