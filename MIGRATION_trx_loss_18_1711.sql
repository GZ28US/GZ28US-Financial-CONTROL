-- TRX = 18% DE PERDA (Marcio, 17/11/2026: «na trx, use 18% de loss, mesmo que a medicao bonestock passe de 700bhp»).
-- HellMonster US.037 e a unica TRX com puxadas (8, todas medidas, com folha). Estavam a 17% — a perda DEDUZIDA da potencia de
-- fabrica (582,99 whp / 702 hp). A roda medida NAO muda; o virabrequim e re-derivado: bhp = whp / 0,82, bnm = wnm / 0,82.
-- Antes: BoneStock 702,40 bhp · melhor puxada 986,70 bhp.  Depois: 710,96 bhp · 998,73 bhp.
-- Voltar: update ... set loss_pct = 17, bhp = round(whp / 0.83, 2), bnm = round(wnm / 0.83, 2) where ride_code = 'US.037'.
update public.dyno_pulls
   set loss_pct = 18,
       bhp = round(whp / 0.82, 2),
       bnm = round(wnm / 0.82, 2)
 where ride_code = 'US.037' and loss_pct = 17 and whp is not null;
