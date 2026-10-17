-- TRAVESSIA: R$ GRAVADO E DESPESA DO BR A PAGAR (17/10/2026) — lib/crossing.server.ts, direção 3
-- Projeto: Supabase US.
--
-- O caso: o imposto da NF-e 083 (Apocalypse US.022.4) e 082 (Tornado US.019.4). Márcio, 17/10/2026: «o US tem que pagar este $
-- do imposto pro BR, é obrigação, e pagou, se o BR vai pagar ou não o governo, isso não pode mudar o US vs BR flow, isto é outra
-- conta». A linha do US é PAID FROM GZ28BR, PAGA (payment_date) — entra na 085.N como item e baixa a dívida do BR com o US.
--
-- amount_brl  — o R$ REAL da linha (total da linha, não unitário), como em staff_expenses / fixed_cost_expenses: prevalece na
--               travessia sobre a cotação do app. Ex.: R$ 14.772,08 = 11,90% de R$ 124.135,09 (a carga do Simples na nota).
-- br_due_date — quando preenchido, a despesa ESPELHO no BR nasce A PAGAR: sem payment_date, com este vencimento (o DAS de
--               outubro vence 20/11/2026). A baixa dela é só no BR e não mexe no flow US × BR.
alter table public.invoice_expenses add column if not exists amount_brl  numeric(14,2);
alter table public.invoice_expenses add column if not exists br_due_date date;
comment on column public.invoice_expenses.amount_brl  is 'R$ real da linha (total). Na travessia (085.N) prevalece sobre a cotação do app.';
comment on column public.invoice_expenses.br_due_date is 'Linha PAID FROM GZ28BR: a despesa espelho no BR nasce A PAGAR com este vencimento (ex.: DAS). Não mexe no flow US × BR.';
