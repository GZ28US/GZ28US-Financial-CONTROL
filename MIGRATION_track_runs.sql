-- TRACK RUNS (Márcio, 10/10/2026): «now let's build the 1/8, 1/4 and 100-200 pages … the Alcatraz performance receipts,
-- that when scanned, builds the pulls … follow the same standards of the dyno page».
-- Uma tabela, como a dyno_pulls (banco US, compartilhada entre os apps): cada linha é UMA passada.
--   kind DRAG = timeslip de arrancada. A MESMA passada alimenta a aba 1/8 (parcial de 201 m) e a 1/4 (402 m) — nada
--               se duplica. Tempos em segundos; velocidades SEMPRE em km/h (métrico canônico); o app US mostra mph.
--   kind ROLL = relatório 100-200 km/h (Dragy e afins), com as parciais 100-110 … 100-200 em `splits`.
create table if not exists track_runs (
  id uuid primary key default gen_random_uuid(),
  ride_code text not null,
  build_no integer not null default 1,
  origin text not null default 'US',
  kind text not null check (kind in ('DRAG', 'ROLL')),
  pack text,
  run_date date,
  run_time text,                 -- hora da passada como impressa (hh:mm:ss), no fuso de onde correu
  track text,                    -- pista / sistema de cronometragem
  device text,                   -- aparelho (Dragy DRG69 …) no ROLL
  driver text,
  lane text,
  category text,
  -- DRAG
  reaction_s numeric,
  t60ft_s numeric,
  t100m_s numeric,               -- 100 m ≈ 330 ft
  t201m_s numeric,               -- 1/8 milha
  v201m_kmh numeric,
  t302m_s numeric,               -- ≈ 1000 ft
  t402m_s numeric,               -- 1/4 milha
  v402m_kmh numeric,
  total_s numeric,               -- «Soma» = reação + ET
  -- ROLL 100-200 km/h
  t100_200_s numeric,
  splits jsonb,                  -- [{"to":110,"s":0.47}, …]
  distance_m numeric,
  slope_pct numeric,
  temp_c numeric,
  altitude_m numeric,
  density_alt_m numeric,
  valid boolean,
  document_url text,
  created_at timestamptz not null default now()
);
create index if not exists track_runs_ride on track_runs (ride_code, build_no);

alter table track_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'track_runs' and policyname = 'authenticated all') then
    create policy "authenticated all" on track_runs for all to authenticated using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on track_runs to authenticated, service_role;
