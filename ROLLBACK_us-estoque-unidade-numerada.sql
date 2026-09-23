-- DESFAZ a consolidação por unidade numerada: as linhas «N/M» voltam exatamente como
-- estavam, reconstruídas da trilha `estoque-unidade-numerada` em data_fixes.
begin;

-- 1) As linhas consolidadas saem (cada uma é uma das originais e voltaria duplicada).
delete from inventory i
where exists (
  select 1 from data_fixes d
  where d.check_key = 'estoque-unidade-numerada'
    and d.table_name = 'inventory'
    and d.row_id = i.id::text
);

-- 2) Todas voltam do JSON guardado.
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
  where check_key = 'estoque-unidade-numerada' and table_name = 'inventory' and field = 'LINHA INTEIRA'
) t;

commit;
