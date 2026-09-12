-- VOLTA ATRÁS DA ONDA 1 (11/set/2026). Lê a própria trilha do data_fixes: nada é
-- reconstruído de memória. Rodar inteiro, numa transação só.
-- Projeto: US  fvgpkbpqacnqxtrjsmpi

begin;

-- 1) O FIC1650 volta com a linha inteira que foi guardada.
insert into inventory
select (jsonb_populate_record(null::inventory, d.old_value::jsonb)).*
from data_fixes d
where d.check_key = 'pacote-paid-from-to' and d.table_name = 'inventory' and d.field = '(linha inteira)'
  and not exists (select 1 from inventory i where i.id = '1f41ece1-a099-4137-83d8-8b33610d00a5');

-- 2) Os campos voltam ao que estavam, um por um, pela trilha.
update fixed_cost_suppliers s set cost_type = d.old_value, updated_at = now()
from data_fixes d
where d.check_key = 'pacote-paid-from-to' and d.table_name = 'fixed_cost_suppliers' and d.field = 'cost_type'
  and s.id::text = d.row_id;

update expenses e set origin = d.old_value, updated_at = now()
from data_fixes d
where d.check_key = 'pacote-paid-from-to' and d.table_name = 'expenses' and d.field = 'origin'
  and e.id::text = d.row_id;

update expenses e set paid_to = d.old_value, updated_at = now()
from data_fixes d
where d.check_key = 'pacote-paid-from-to' and d.table_name = 'expenses' and d.field = 'paid_to'
  and e.id::text = d.row_id;

update fixed_cost_expenses f set paid_from = d.old_value
from data_fixes d
where d.check_key = 'pacote-paid-from-to' and d.table_name = 'fixed_cost_expenses' and d.field = 'paid_from'
  and f.id::text = d.row_id;

-- 3) A trilha some por último — ela é a prova do que foi desfeito. Confira antes:
--    select * from data_fixes where check_key = 'pacote-paid-from-to' order by fixed_at;
delete from data_fixes where check_key = 'pacote-paid-from-to';

commit;
