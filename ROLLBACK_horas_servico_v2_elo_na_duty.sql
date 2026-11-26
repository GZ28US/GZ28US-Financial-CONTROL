-- ROLLBACK de MIGRATION_horas_servico_v2_elo_na_duty.sql: devolve a coluna v1 invoice_services.duty_id a partir do elo da duty
-- (a coluna v1 só existiu em 26/11/2026, com 8 elos — todos foram para invoice_duties.service_id antes do drop).
begin;
alter table public.invoice_services add column if not exists duty_id uuid references public.invoice_duties(id) on delete set null;
create index if not exists invoice_services_duty_id_idx on public.invoice_services(duty_id);
update public.invoice_services s set duty_id = d.id from public.invoice_duties d where d.service_id = s.id and s.duty_id is null;
commit;
