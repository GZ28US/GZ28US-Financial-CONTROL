-- O R$ REAL DO CUSTO FIXO PAGO PELO BR (Márcio, 16/09/2026, pela sessão Auto Book: «o que for de Vegas, ponha em Marketing,
-- SEMA 2025, assim como tudo que envolve o SEMA 2025, tem que estar lá, tudo»).
-- O custo fixo de MARKETING passa a aceitar PAID FROM GZ28BR (lib/payerRule.ts · fixed_cost_marketing), e a linha paga pelo BR
-- atravessa para uma 085.N por fornecedor (lib/crossing.server.ts · chave US:fixed:<supplier_id>). O R$ que o BR pagou de
-- verdade (fatura C6) mora aqui e PREVALECE na travessia, como em staff_expenses.amount_brl — sem ele o motor carimba o R$
-- pela regra do app ((bid + 0,20) × 1,0638). Coluna nova e vazia: nenhuma linha muda. VOLTA: ROLLBACK_fixed_cost_amount_brl.sql
begin;
set local lock_timeout = '5s';
alter table public.fixed_cost_expenses add column if not exists amount_brl numeric;
comment on column public.fixed_cost_expenses.amount_brl is 'R$ real pago pelo GZ28BR (PAID FROM GZ28BR, só custo de MARKETING). Prevalece na travessia para a 085.N; vazio = o motor carimba pela regra do app. (16/09/2026)';
commit;
select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'fixed_cost_expenses' and column_name = 'amount_brl';
