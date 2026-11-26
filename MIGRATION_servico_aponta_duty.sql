-- SERVIÇO → DUTY (26/11/2026). Márcio: «o número de horas nos services tem que aparecer o dobro do que é nas duties».
-- Só exibição (lib/serviceHours.ts): a hora vem de invoice_duties.estimated_seconds × 2. Sem coluna de horas no serviço.
alter table public.invoice_services add column if not exists duty_id uuid references public.invoice_duties(id) on delete set null;
create index if not exists invoice_services_duty_id_idx on public.invoice_services(duty_id);

-- Liga os serviços das duas invoices de 26/11 (US.032.9 BlackLight, US.003.6 Colossus) às suas duties pelo assunto.
with par(code, svc_like, duty_like) as (values
  ('US.032.9', 'Retirada da garrafa de nitro%', '01. %'),
  ('US.032.9', 'Calibração total%',             '02. %'),
  ('US.003.6', 'Montagem do VVT Limiter%',      '01. %'),
  ('US.003.6', 'Montagem do supercharger%',     '02. %'),
  ('US.003.6', 'Reabastecimento%',              '03. %'),
  ('US.003.6', 'Preparação do carro%',          '04. %'),
  ('US.003.6', 'Calibração total%',             '05. %'),
  ('US.003.6', 'Retirada dos turbos%',          '06. %'))
update public.invoice_services s set duty_id = d.id
  from par p join public.invoices i on i.invoice_code = p.code
  join public.invoice_duties d on d.invoice_id = i.id and d.description like p.duty_like
 where s.invoice_id = i.id and s.description like p.svc_like and s.duty_id is null;

select i.invoice_code, s.description, d.description as duty, d.estimated_seconds / 3600.0 * 2 as horas_mostradas
  from public.invoice_services s join public.invoices i on i.id = s.invoice_id left join public.invoice_duties d on d.id = s.duty_id
 where i.invoice_code in ('US.032.9', 'US.003.6') order by 1, 2;
