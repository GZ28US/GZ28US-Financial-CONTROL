-- 09/11/2026 (pedido D do AutoBook US): a mesma trava que a invoice_expenses tem desde 30/ago.
-- receipt_proves_payment=false = o documento anexado é CONTA/FOLIO a pagar, não comprovante: o robô «recibo = pago»
-- (lib/expenseReportNet enforceReceiptPaid) não dá baixa. Só ADICIONA uma coluna (nula = comportamento de sempre).
alter table public.fixed_cost_expenses add column if not exists receipt_proves_payment boolean;
comment on column public.fixed_cost_expenses.receipt_proves_payment is 'false = anexo é conta/folio a pagar, não comprovante; enforceReceiptPaid não marca pago (09/11/2026)';
