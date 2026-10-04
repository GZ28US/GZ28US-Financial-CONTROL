-- CAR GROUPS — grupos de compatibilidade de build (Márcio, 04/10/2026, pedido vindo da sessão Parts & Packs).
-- «in this page [/ca/packs/new], once the user already picked the manufacturer, I want the app to offer the groups (if there
-- is any) before the brand». Grupo = carros que recebem o MESMO build. Clicar num grupo no cadastro do pack põe todos os
-- carros dele em «CARS THIS PACKAGE FITS» de uma vez (decisão dele: adiciona os carros; o pack NÃO fica preso ao grupo).
-- Mora no banco do US, ao lado de packs (o BR lê pelo mesmo caminho — lib/supabaseUS). Mesma segurança de packs: RLS ligado,
-- tudo para authenticated; anon não entra. `cars` tem o mesmo formato de packs.cars ({manufacturer, brand, model, version, years[]}).
begin;

create table if not exists public.car_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  manufacturer text not null,
  cars jsonb not null default '[]'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.car_groups enable row level security;
create policy car_groups_authenticated_all on public.car_groups for all to authenticated using (true) with check (true);
revoke all on public.car_groups from anon;
grant select, insert, update, delete on public.car_groups to authenticated;
grant select, insert, update, delete on public.car_groups to service_role;

-- Os 3 primeiros grupos dele (carros e anos conferidos contra o catálogo do app em 04/10/2026). Só entram com a tabela vazia.
insert into public.car_groups (name, manufacturer, cars, position)
select v.name, 'MOPAR', v.cars::jsonb, v.position
from (values
  ('Challenger & Charger 707/717 HP', '[{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT HellCat WideBody 6.2","years":[2018,2019,2020,2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHARGER","version":"SRT HellCat WideBody 6.2","years":[2020,2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT HellCat 6.2","years":[2015,2016,2017,2018,2019,2020,2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHARGER","version":"SRT HellCat 6.2","years":[2015,2016,2017,2018,2019]}]', 1),
  ('Challenger & Charger 797/807/840 HP', '[{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT Demon 6.2","years":[2018]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT HellCat RedEye SuperStock 6.2","years":[2020,2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT HellCat RedEye WideBody 6.2","years":[2019,2020,2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHARGER","version":"SRT HellCat RedEye WideBody 6.2","years":[2021,2022,2023]},{"manufacturer":"MOPAR","brand":"DODGE","model":"CHALLENGER","version":"SRT HellCat RedEye 6.2","years":[2019,2020,2021,2022,2023]}]', 2),
  ('RAM TRX', '[{"manufacturer":"MOPAR","brand":"RAM","model":"1500","version":"TRX SRT 6.2 SC","years":[2027]},{"manufacturer":"MOPAR","brand":"RAM","model":"1500","version":"TRX 6.2 SC","years":[2021,2022,2023,2024]}]', 3)
) as v(name, cars, position)
where not exists (select 1 from public.car_groups);

commit;
