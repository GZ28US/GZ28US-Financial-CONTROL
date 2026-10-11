-- TITAN 11/10/2026 — dois pedidos novos feitos ao Gabriel (grupo GZ28US & Titan, 16h43 Orlando), ambos TO BE PAID.
-- BORLA (6 carros US): o SO 014748587 era o pedido VELHO (6+1 com os kits do BR, CNPJ Galpao Z28) — Márcio: «that's NOT this order».
-- O pedido novo (5x 140648 + 1x 140669, só US, GZ28 V8 SpeedShop USA LLC) ainda não tem número: order_number fica VAZIO até a Titan devolver.
-- FUELTECH (US.024.2 WhiteSnake): 4 linhas já TO BE PAID; só ganham pagador e nota de status.
-- Pagador = GZ28US (billing na LLC, decisão dele 11/10). payment_method CASH era o default do editor, não um fato: fica vazio até pagar.
-- check_key da trilha: titan-pedidos-us-11out

-- ── trilha ANTES de mexer ────────────────────────────────────────────────────
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'order_number', ie.order_number, null,
       'BORLA: SO 014748587 é o pedido VELHO (kits BR) — pedido novo só US sem número ainda (Márcio 11/10)'
  from invoice_expenses ie where ie.order_number = '014748587';

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'part_number', ie.part_number, 'BOR 140648',
       'BORLA: part number na coluna própria'
  from invoice_expenses ie where ie.order_number = '014748587' and ie.part_number is null;

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'paid_from', ie.paid_from, 'GZ28US',
       'TITAN 11/10: pagador é o GZ28US (billing GZ28 V8 SpeedShop USA LLC)'
  from invoice_expenses ie
 where ie.paid_from is null
   and (ie.order_number = '014748587' or ie.id in ('5084f3a2-6b01-4747-b878-6d6b3ef7d42d','6ec3c7cd-a31a-4d84-8be1-6737b94b5b72','af49b14b-5196-4b0c-ac32-d4a27aded49d','a76b4807-d783-430c-bd65-5ea3fd605f05'));

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'source', ie.source, 'GZ28US',
       'TITAN 11/10: source = GZ28US (igual ao default do editor)'
  from invoice_expenses ie
 where ie.source is null
   and (ie.order_number = '014748587' or ie.id in ('5084f3a2-6b01-4747-b878-6d6b3ef7d42d','6ec3c7cd-a31a-4d84-8be1-6737b94b5b72','af49b14b-5196-4b0c-ac32-d4a27aded49d','a76b4807-d783-430c-bd65-5ea3fd605f05'));

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'payment_method', ie.payment_method, null,
       'BORLA: CASH era default do editor; linha não paga — método entra com o pagamento (link da Titan)'
  from invoice_expenses ie where ie.order_number = '014748587' and ie.payment_method = 'CASH';

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'titan-pedidos-us-11out', 'invoice_expenses', ie.id::text, 'last_event', ie.last_event,
       case when ie.order_number = '014748587'
            then '11/10 PEDIDO NOVO só carros US feito à Titan (grupo WA 16h43) — aguardando invoice + link de pagamento; nº do pedido vem da Titan'
            else '11/10 pedido feito à Titan (grupo WA 16h43) — PAGAR E RETIRAR seg 12/10 logo cedo; aguardando invoice + link de pagamento' end,
       'TITAN 11/10: estado do pedido na linha'
  from invoice_expenses ie
 where ie.order_number = '014748587' or ie.id in ('5084f3a2-6b01-4747-b878-6d6b3ef7d42d','6ec3c7cd-a31a-4d84-8be1-6737b94b5b72','af49b14b-5196-4b0c-ac32-d4a27aded49d','a76b4807-d783-430c-bd65-5ea3fd605f05');

-- ── FUELTECH (US.024.2) ──────────────────────────────────────────────────────
update invoice_expenses set
  paid_from = coalesce(paid_from, 'GZ28US'),
  source = coalesce(source, 'GZ28US'),
  last_event = '11/10 pedido feito à Titan (grupo WA 16h43) — PAGAR E RETIRAR seg 12/10 logo cedo; aguardando invoice + link de pagamento',
  last_event_at = now(),
  updated_at = now()
where id in ('5084f3a2-6b01-4747-b878-6d6b3ef7d42d','6ec3c7cd-a31a-4d84-8be1-6737b94b5b72','af49b14b-5196-4b0c-ac32-d4a27aded49d','a76b4807-d783-430c-bd65-5ea3fd605f05')
  and payment_date is null;

-- ── BORLA (6 carros US) — por último, porque o filtro é o order_number velho ──
update invoice_expenses set
  part_number = coalesce(part_number, 'BOR 140648'),
  paid_from = coalesce(paid_from, 'GZ28US'),
  source = coalesce(source, 'GZ28US'),
  payment_method = case when payment_method = 'CASH' then null else payment_method end,
  last_event = '11/10 PEDIDO NOVO só carros US feito à Titan (grupo WA 16h43) — aguardando invoice + link de pagamento; nº do pedido vem da Titan',
  last_event_at = now(),
  order_number = null,
  updated_at = now()
where order_number = '014748587' and payment_date is null;
