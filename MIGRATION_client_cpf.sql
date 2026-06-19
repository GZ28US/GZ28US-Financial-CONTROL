-- Add an optional CPF column to clients (Brazilian taxpayer id).
-- Shown only for BRAZIL clients on the internal edit + client self-service forms.
-- Validated client-side when filled; stored masked (000.000.000-00) or NULL.
alter table public.clients add column if not exists cpf text;
