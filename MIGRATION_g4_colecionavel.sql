-- G4 v2 — classe COLECIONÁVEL (João, 25/ago/2026): Demon 170 é produção de UM
-- ano; o CHASSI não perde valor (provável valorização — que fica FORA dos
-- livros até ser realizada na venda: conservadorismo), mas os EXPERIMENTOS
-- gastos nele são consumidos e depreciam. Rode UMA vez no SQL Editor (US).
update rides set asset_class = 'COLECIONAVEL' where project_code = 'US.170';  -- Devil170: chassi ao custo, mods depreciam (60m)
