-- TAX SHIELD v0.2.0 — apelidos de beneficiário (23/ago/2026). Idempotente.
-- O banco trunca nomes de jeitos diferentes ("Nathan D Perez" / "NATHAN PERE"):
-- aliases guarda os name_keys que são a MESMA pessoa/empresa, um por linha,
-- e o rastreador de 1099 soma tudo no beneficiário canônico.
alter table public.tax_contractors add column if not exists aliases text;
