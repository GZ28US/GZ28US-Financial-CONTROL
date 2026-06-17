-- Run in the Supabase SQL editor for this app's project.
--
-- Some suppliers give the dealer price via a CODE applied at checkout (after
-- logging in with our account) rather than a public % off — e.g. HallTech uses
-- "DLR20". This stores that code on the supplier record. Safe to run repeatedly.

ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS discount_code text;
