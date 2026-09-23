-- DESFAZ a consolidação do Red Line 5W40: a linha única de 24 volta a ser as 24 linhas
-- de quantidade 1, reconstruídas da trilha `estoque-bulk-uma-linha` em data_fixes.
-- Só rodar se o Márcio quiser as 24 linhas de volta.
begin;

-- 1) A linha consolidada sai (ela é uma das 24 da trilha e voltaria duplicada).
delete from inventory
where description = 'Red Line 5W40 Motor Oil — quart (AutoZone part 15404, SKU-001688573)'
  and quantity = 24;

-- 2) As 24 voltam exatamente como estavam, pelo JSON guardado.
insert into inventory (
  description, category, quantity, unit_price, purchase_date, supplier, notes,
  purchase_group, source_type, source, payment_method, paid_from, paid_to,
  payment_date, order_number, receipt_url, nature, reported_at
)
select
  j->>'description', j->>'category', (j->>'quantity')::numeric, (j->>'unit_price')::numeric,
  nullif(j->>'purchase_date','')::date, j->>'supplier', j->>'notes',
  nullif(j->>'purchase_group','')::uuid, j->>'source_type', j->>'source',
  j->>'payment_method', j->>'paid_from', j->>'paid_to',
  nullif(j->>'payment_date','')::date, j->>'order_number', j->>'receipt_url',
  j->>'nature', nullif(j->>'reported_at','')::timestamptz
from (
  select old_value::json as j
  from data_fixes
  where check_key = 'estoque-bulk-uma-linha' and table_name = 'inventory' and field = 'LINHA INTEIRA'
) t;

commit;
