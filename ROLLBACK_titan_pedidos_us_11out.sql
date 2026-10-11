-- Desfaz titan-pedidos-us-11out lendo a própria trilha (old_value). last_event_at/updated_at não voltam (só carimbo).
update invoice_expenses ie set order_number = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='order_number' and f.row_id = ie.id::text;
update invoice_expenses ie set part_number = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='part_number' and f.row_id = ie.id::text;
update invoice_expenses ie set paid_from = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='paid_from' and f.row_id = ie.id::text;
update invoice_expenses ie set source = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='source' and f.row_id = ie.id::text;
update invoice_expenses ie set payment_method = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='payment_method' and f.row_id = ie.id::text;
update invoice_expenses ie set last_event = f.old_value from data_fixes f where f.check_key='titan-pedidos-us-11out' and f.field='last_event' and f.row_id = ie.id::text;
