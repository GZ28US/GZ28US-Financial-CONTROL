-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_mirror_line_link.sql · 04/set/2026
-- O ESPELHO PASSA A CONHECER A LINHA, NÃO SÓ A INVOICE.
--
-- O DEFEITO (medido hoje, não é hipótese): a cada save de uma shopping invoice o
-- espelho APAGA todas as invoice_expenses da invoice espelhada e RECRIA só com o
-- que ele possui (item, preço, qtd, tax, extra, datas, source, order_number).
-- Tudo o mais que alguém escreveu DO LADO ESPELHO evapora, calado.
--
--   BR -> US: 24 invoices espelhadas, 68 linhas no US, e 23 delas (US$ 12.271,43)
--             carregam fato que o espelho não recria:
--             13 receipt_url · 9 last_event · 8 picked_up · 7 part_number
--             5 tracking_number · 5 carrier · 5 shipped_at · 5 delivered_at
--             4 cancel_status · 2 eta · 4 receipt_proves_payment=false
--   US -> BR: 10 invoices, 69 linhas, 0 em risco HOJE (ninguém digitou lá ainda)
--
-- Exemplo real: o MOPAR 77072552AC Widebody Fender Flare Kit (pedido HHP 382529)
-- tem rastreio 631902038, carrier Roadrunner, delivered_at de 04/set e o PDF da
-- nota anexado. Some inteiro e volta em branco — e cai de DELIVERED para BOUGHT,
-- que é exatamente o incidente de 30/ago.
--
-- E A PIOR DELAS: 4 linhas têm receipt_proves_payment = false. É o escudo criado
-- em 30/ago depois de o robô carimbar US$ 5.050 da TAG Motorsports como pagos.
-- Recriada, a linha volta ao default `true` — e o robô estampa PAGO de novo, sem
-- ninguém pedir. O bug se reabre sozinho.
--
-- POR QUE COLUNA, E POR QUE ESTA: o app JÁ tem o idioma do espelho no nível de
-- cima — invoices.br_invoice_id (US) e invoices.us_invoice_id (BR). O que falta é
-- o mesmo elo uma camada abaixo. Sem ele, o espelho não tem como saber qual linha
-- de lá corresponde a qual linha daqui, e por isso apaga tudo e recria.
-- Casar por texto do item seria adivinhação, e casar por posição é pior ainda:
-- item reordenado grudaria o rastreio de uma peça em outra.
--
-- Conferido antes de propor (lei "campo duplicado é câncer"): invoice_expenses
-- NÃO tem nenhuma coluna de elo de espelho, nos dois bancos.
--
-- ┌─ RODE ESTE BLOCO NO PROJETO **US** ────────────────────────────────────────┐
--   A linha do US que é ESPELHO de uma linha do BR guarda a origem:
alter table public.invoice_expenses add column if not exists br_expense_id uuid;
create index if not exists idx_invoice_expenses_br_expense_id
  on public.invoice_expenses (br_expense_id) where br_expense_id is not null;
-- └───────────────────────────────────────────────────────────────────────────┘

-- ┌─ RODE ESTE BLOCO NO PROJETO **BR** ────────────────────────────────────────┐
--   A linha do BR que é ESPELHO de uma linha do US guarda a origem:
-- alter table public.invoice_expenses add column if not exists us_expense_id uuid;
-- create index if not exists idx_invoice_expenses_us_expense_id
--   on public.invoice_expenses (us_expense_id) where us_expense_id is not null;
-- └───────────────────────────────────────────────────────────────────────────┘

-- SEM CHAVE ESTRANGEIRA de propósito: a linha de origem mora em OUTRO banco
-- Supabase. O elo é lógico, e o código trata o id órfão como "linha nova".

-- ── CONFERÊNCIA (no US) ─────────────────────────────────────────────────────
select count(*) total, count(br_expense_id) com_elo from public.invoice_expenses;
