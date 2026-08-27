-- MIGRATION — PASSAGEM DO STAFF + MENSAGEM DE BOAS-VINDAS (Márcio, 27/ago/2026:
-- "foi comprada a passagem, tem que ter msg de boas-vindas pro membro no Staff,
--  passando todos os dados da passagem dele, em especial o localizador da
--  companhia aérea").
--
-- POR QUE UMA TABELA, e não colunas na expense: uma season JÁ É uma viagem real,
-- e uma viagem tem ida e (mais tarde) volta. Além disso os dados do voo estavam
-- enfiados no texto da descrição da expense — o que quebra a lei de jamais
-- guardar dado como texto. Ninguém consegue mandar um localizador que está no
-- meio de um parágrafo.
--
-- POR QUE `timestamp` SEM FUSO nos horários: horário de voo é sempre LOCAL do
-- aeroporto. O voo do Eliel sai 12:25 em Campinas e chega 20:30 em Orlando —
-- são dois fusos diferentes, e converter para UTC estragaria os dois. Guardamos
-- exatamente o que está no bilhete e mostramos exatamente isso.

begin;

create table if not exists public.staff_flights (
  id               uuid primary key default gen_random_uuid(),
  staff_id         uuid not null references public.staff(id)    on delete cascade,
  season_id        uuid          references public.seasons(id)  on delete set null,
  -- a expense da passagem, que é onde o dinheiro foi lançado
  expense_id       uuid          references public.expenses(id) on delete set null,

  -- INBOUND = vem trabalhar. OUTBOUND = volta pra casa.
  direction        text not null default 'INBOUND',

  -- O QUE O MEMBRO PRECISA NO BALCÃO: o localizador é da COMPANHIA (PNR, 6
  -- caracteres). A referência da agência é outro número e não serve no check-in
  -- — por isso são dois campos, nunca um só.
  locator          text,
  booking_ref      text,

  airline          text,
  flight_number    text,
  operated_by      text,   -- voo de código compartilhado: quem opera de verdade

  from_airport     text,
  from_city        text,
  to_airport       text,
  to_city          text,
  departure_local  timestamp,   -- hora local NA ORIGEM
  arrival_local    timestamp,   -- hora local NO DESTINO

  baggage_included boolean,
  duration_minutes int,   -- a duracao vem do bilhete; nao da pra calcular, sao dois fusos

  -- carimbo da boas-vindas: o app não manda a mesma mensagem duas vezes sozinho
  welcome_sent_at  timestamptz,

  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists staff_flights_staff_idx  on public.staff_flights (staff_id);
create index if not exists staff_flights_season_idx on public.staff_flights (season_id);

-- Mesmo padrão das outras tabelas (RLS Phase 1): anon não toca, authenticated sim.
alter table public.staff_flights enable row level security;
drop policy if exists staff_flights_authenticated_all on public.staff_flights;
create policy staff_flights_authenticated_all on public.staff_flights
  for all to authenticated using (true) with check (true);

commit;

-- ----------------------------------------------------------------------------
-- O voo do Eliel (US.012), direto do e-ticket da BudgetAir BUSA-36857155.
-- Fica amarrado à expense de US$ 382,90 que já está lançada e paga na season.
-- ----------------------------------------------------------------------------
insert into public.staff_flights (
  staff_id, season_id, expense_id, direction,
  locator, booking_ref, airline, flight_number, operated_by,
  from_city, from_airport, to_city, to_airport,
  departure_local, arrival_local, duration_minutes, baggage_included
)
select s.id, se.id, e.id, 'INBOUND',
       'XW7LKT', 'BUSA-36857155', 'Azul', 'AD9730', 'EuroAtlantic',
       'Campinas', 'VCP', 'Orlando', 'MCO',
       timestamp '2026-08-29 12:25', timestamp '2026-08-29 20:30', 545, false
  from public.staff s
  join public.seasons  se on se.staff_id = s.id and se.season_code = 'US.001'
  left join public.expenses e on e.season_id = se.id and e.order_number = 'BUSA-36857155'
 where s.staff_code = 'US.012'
   and not exists (select 1 from public.staff_flights f where f.season_id = se.id);
