-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_sema2025_item7_BR.sql — SÓ COM O OK DO MÁRCIO (muda dinheiro no BR). Projeto: BR.
-- APPDEV item 7: 4 espelhos das TEAM-2025-SEMA ainda valem US$ 486,15 / R$ 2.860,40 no BR, mas a linha do US vale
-- 405,13 (405,11) desde o rateio refeito com a Chris. Aqui o espelho passa a valer o US$ do US, com o R$ pela MESMA régua das
-- duas irmãs que já estão certas (bid 5,3309 de 09/11/2025 + 0,20) × 1,0638 = 5.883771 → 405,13 = R$ 2.383,69.
-- Efeito: a conta «BR deve ao US» sobe US$ 324.1 (o BR cobra menos do US).
-- Rodar DEPOIS das duas migrações do SEMA 2025 (as linhas já estão na 085.N do marketing). VOLTA: trilha 'sema2025-item7'.
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
-- Humberto Gonçalves (US.004): US$ 486.15 → 405.13 · R$ 2860.4 → 2383.69
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values
 ('sema2025-item7', 'invoice_expenses', 'bf22d41b-8f35-4d23-b1d9-98224169f81b', 'price|amount_usd', '2860.4|486.15', '2383.69|405.13', 'item 7: espelho da TEAM-2025-SEMA ao US$ do US (Humberto Gonçalves) — Márcio'),
 ('sema2025-item7', 'invoice_parts', '8b30df78-2a64-4af5-a06c-574821594531', 'unit_price|base_cost|unit_price_usd', '2860.4|2860.4|486.15', '2383.69|2383.69|405.13', 'item 7: item da TEAM-2025-SEMA ao US$ do US (Humberto Gonçalves) — Márcio');
update public.invoice_expenses set price = 2383.69, amount_usd = 405.13 where id = 'bf22d41b-8f35-4d23-b1d9-98224169f81b' and amount_usd = 486.15 and price = 2860.4;
update public.invoice_parts set unit_price = 2383.69, base_cost = 2383.69, unit_price_usd = 405.13 where id = '8b30df78-2a64-4af5-a06c-574821594531' and unit_price_usd = 486.15;
-- João Luca França Campos (US.001): US$ 486.15 → 405.13 · R$ 2860.4 → 2383.69
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values
 ('sema2025-item7', 'invoice_expenses', 'ebd5ab1d-6aa5-4580-9eda-05ff9cec46f3', 'price|amount_usd', '2860.4|486.15', '2383.69|405.13', 'item 7: espelho da TEAM-2025-SEMA ao US$ do US (João Luca França Campos) — Márcio'),
 ('sema2025-item7', 'invoice_parts', 'aa64e1b6-6360-4398-91aa-53b04d2233fe', 'unit_price|base_cost|unit_price_usd', '2860.4|2860.4|486.15', '2383.69|2383.69|405.13', 'item 7: item da TEAM-2025-SEMA ao US$ do US (João Luca França Campos) — Márcio');
update public.invoice_expenses set price = 2383.69, amount_usd = 405.13 where id = 'ebd5ab1d-6aa5-4580-9eda-05ff9cec46f3' and amount_usd = 486.15 and price = 2860.4;
update public.invoice_parts set unit_price = 2383.69, base_cost = 2383.69, unit_price_usd = 405.13 where id = 'aa64e1b6-6360-4398-91aa-53b04d2233fe' and unit_price_usd = 486.15;
-- Guilherme Rodrigues Fernandes Martins (US.001): US$ 486.15 → 405.13 · R$ 2860.4 → 2383.69
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values
 ('sema2025-item7', 'invoice_expenses', 'a3e37a3c-e98e-48ca-9dda-0e051f35a46f', 'price|amount_usd', '2860.4|486.15', '2383.69|405.13', 'item 7: espelho da TEAM-2025-SEMA ao US$ do US (Guilherme Rodrigues Fernandes Martins) — Márcio'),
 ('sema2025-item7', 'invoice_parts', '25297cb1-38a8-4d7f-8869-40c31aafa26f', 'unit_price|base_cost|unit_price_usd', '2860.4|2860.4|486.15', '2383.69|2383.69|405.13', 'item 7: item da TEAM-2025-SEMA ao US$ do US (Guilherme Rodrigues Fernandes Martins) — Márcio');
update public.invoice_expenses set price = 2383.69, amount_usd = 405.13 where id = 'a3e37a3c-e98e-48ca-9dda-0e051f35a46f' and amount_usd = 486.15 and price = 2860.4;
update public.invoice_parts set unit_price = 2383.69, base_cost = 2383.69, unit_price_usd = 405.13 where id = '25297cb1-38a8-4d7f-8869-40c31aafa26f' and unit_price_usd = 486.15;
-- Luiz Agostinho (US.001): US$ 486.15 → 405.11 · R$ 2860.4 → 2383.57
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label) values
 ('sema2025-item7', 'invoice_expenses', '4f590564-bc78-40ad-8a1d-86b50fc36620', 'price|amount_usd', '2860.4|486.15', '2383.57|405.11', 'item 7: espelho da TEAM-2025-SEMA ao US$ do US (Luiz Agostinho) — Márcio'),
 ('sema2025-item7', 'invoice_parts', 'c2772139-0d4e-4c5b-96dc-9f0c4c9a00b7', 'unit_price|base_cost|unit_price_usd', '2860.4|2860.4|486.15', '2383.57|2383.57|405.11', 'item 7: item da TEAM-2025-SEMA ao US$ do US (Luiz Agostinho) — Márcio');
update public.invoice_expenses set price = 2383.57, amount_usd = 405.11 where id = '4f590564-bc78-40ad-8a1d-86b50fc36620' and amount_usd = 486.15 and price = 2860.4;
update public.invoice_parts set unit_price = 2383.57, base_cost = 2383.57, unit_price_usd = 405.11 where id = 'c2772139-0d4e-4c5b-96dc-9f0c4c9a00b7' and unit_price_usd = 486.15;
commit;
