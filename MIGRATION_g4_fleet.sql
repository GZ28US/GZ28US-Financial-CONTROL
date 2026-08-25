-- G4 NASCE — classe de ativo da frota própria (João classificou carro a carro,
-- 25/ago/2026). Rode UMA vez no SQL Editor do Supabase (projeto US).
-- Classes: TRABALHO e DESENVOLVIMENTO depreciam (linear, por linha de custo,
-- da data de cada gasto); MONUMENTO (a alma — GENEZIZ) e RESERVA ficam ao custo.
alter table rides add column if not exists asset_class text;
alter table rides add column if not exists asset_life_months int;

update rides set asset_class = 'DESENVOLVIMENTO', asset_life_months = 60 where project_code = 'US.170';  -- Devil170: laboratório (e marketing de quebra)
update rides set asset_class = 'RESERVA'                                where project_code = 'US.037';  -- HellBull: ativo em carteira
update rides set asset_class = 'RESERVA'                                where project_code = 'US.014';  -- RAM170: ativo em carteira
update rides set asset_class = 'MONUMENTO'                              where project_code = 'US.028';  -- GENEZIZ: a alma da oficina
update rides set asset_class = 'TRABALHO', asset_life_months = 60       where project_code = 'US.011';  -- RAMbo: transporte/serviço
update rides set asset_class = 'TRABALHO', asset_life_months = 120      where project_code = 'US.043';  -- Trailer: 10 anos
