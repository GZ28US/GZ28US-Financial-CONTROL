-- MIGRATION_clients_grade.sql · 23/out/2026 — A NOTA DO CLIENTE (US e BR, mesmo SQL)
-- Márcio: «create a grade to each client in the apps» / «criou o campo notas pros clientes? urgente isso».
-- grade = nota 0–10 dada pela casa (interna: client_self_get NÃO devolve — o cliente nunca vê).
-- grade_note = o porquê da nota (texto livre). Coluna nova em clients, sem tabela nova (GRANTs de clients valem).
alter table public.clients add column if not exists grade smallint check (grade between 0 and 10);
alter table public.clients add column if not exists grade_note text;
alter table public.clients add column if not exists grade_at timestamptz;
notify pgrst, 'reload schema';
