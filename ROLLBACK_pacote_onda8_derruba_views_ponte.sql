-- VOLTA de MIGRATION_pacote_onda8_derruba_views_ponte.sql: recria as 5 views-ponte exatamente como estavam em 14/09/2026 19:24 Orlando
-- (definição de pg_get_viewdef, security_invoker=true, grants só para authenticated e service_role — anon sem grant, como na onda 6).
begin;
create or replace view public.expenses with (security_invoker = true) as
SELECT id,
    season_id,
    type,
    amount,
    expense_date,
    created_at,
    updated_at,
    description,
    source,
    origin,
    receipt_url,
    payment_date,
    paid_via,
    supplier,
    payment_method,
    paid_from,
    paid_to,
    order_number,
    amount_brl,
    payment_reference,
    tracking_number,
    carrier,
    eta,
    shipped_at,
    delivered_at,
    last_event,
    last_event_at,
    picked_up,
    cancel_status,
    nature,
    bank_transaction_id
   FROM staff_expenses;
revoke all on public.expenses from anon;
grant select, insert, update, delete, truncate, references, trigger on public.expenses to authenticated, service_role;
create or replace view public.good_expenses with (security_invoker = true) as
SELECT id,
    good_id,
    description,
    amount,
    expense_date,
    created_at,
    receipt_url,
    supplier,
    source,
    payment_method,
    paid_from,
    paid_to,
    payment_date,
    order_number,
    tracking_number,
    carrier,
    eta,
    shipped_at,
    delivered_at,
    last_event,
    last_event_at,
    picked_up,
    cancel_status,
    nature
   FROM assets_expenses;
revoke all on public.good_expenses from anon;
grant select, insert, update, delete, truncate, references, trigger on public.good_expenses to authenticated, service_role;
create or replace view public.goods with (security_invoker = true) as
SELECT id,
    description,
    quantity,
    unit_price,
    purchase_date,
    created_at,
    updated_at,
    receipt_url,
    supplier,
    purchase_group,
    source,
    payment_method,
    paid_from,
    paid_to,
    payment_date,
    order_number,
    category,
    tracking_number,
    carrier,
    eta,
    shipped_at,
    delivered_at,
    last_event,
    last_event_at,
    picked_up,
    cancel_status,
    nature
   FROM assets;
revoke all on public.goods from anon;
grant select, insert, update, delete, truncate, references, trigger on public.goods to authenticated, service_role;
create or replace view public.invoice_parts with (security_invoker = true) as
SELECT id,
    invoice_id,
    description,
    unit_price,
    quantity,
    total,
    created_at,
    updated_at,
    base_cost,
    "position",
    payment_date,
    kit_group,
    kit_name,
    source_item,
    mirror_expense_id,
    base_tributavel
   FROM invoice_items;
revoke all on public.invoice_parts from anon;
grant select, insert, update, delete, truncate, references, trigger on public.invoice_parts to authenticated, service_role;
create or replace view public.invoice_payments with (security_invoker = true) as
SELECT id,
    invoice_id,
    amount,
    payment_date,
    source,
    created_at,
    updated_at,
    receipt_url,
    description,
    paid_at,
    delayed_alert_sent_at,
    paid_to,
    amount_brl,
    date_label,
    mirror_expense_id
   FROM invoice_incomes;
revoke all on public.invoice_payments from anon;
grant select, insert, update, delete, truncate, references, trigger on public.invoice_payments to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
