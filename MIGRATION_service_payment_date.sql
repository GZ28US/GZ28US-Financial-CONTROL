-- PAID/PENDING toggle on SERVICES (mirrors ITEMS). Stores the date a service line
-- was marked paid; null = not paid yet. RUN THIS BEFORE toggling a service paid.
ALTER TABLE invoice_services ADD COLUMN IF NOT EXISTS payment_date date;
