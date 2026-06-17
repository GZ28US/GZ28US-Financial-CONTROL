-- Per-invoice toggle for the SHOW PART NUMBERS button (ITEMS box, edit page).
-- When on, the part numbers (from the parts DB, matched by item) show in the
-- ITEMS listing on the edit, view, and print pages.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS show_part_numbers boolean DEFAULT false;
