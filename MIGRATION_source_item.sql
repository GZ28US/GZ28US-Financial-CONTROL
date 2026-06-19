-- Stable link between an imported ITEM and the EXPENSE it came from.
-- Lets removing a renamed item correctly flip its source expense to REMOVED
-- (matching no longer relies on the editable description). Pack parts are JSONB
-- and need no migration. RUN THIS BEFORE saving any quote/invoice on the new build.
ALTER TABLE invoice_parts ADD COLUMN IF NOT EXISTS source_item text;
