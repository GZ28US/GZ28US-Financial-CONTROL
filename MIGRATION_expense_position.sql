-- Manual reorder (▲▼) for invoice/quote EXPENSES. `position` is the manual order;
-- sortExpensesByDate keeps PAID expenses in date order on top, unpaid ones follow
-- this position. Pack expenses need no migration (they're a JSONB array). RUN THIS
-- before saving an invoice after reordering expenses.
ALTER TABLE invoice_expenses ADD COLUMN IF NOT EXISTS position int;
