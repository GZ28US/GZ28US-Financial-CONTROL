-- TRX DE VOLTA A 17% DE PERDA (Marcio, 21/11/2026: «volta pra 17%»). Passou por 18% (17/11) e 20% (21/11).
-- HellMonster US.037 e a unica TRX com puxadas. A roda medida NAO muda; o virabrequim e re-derivado:
-- bhp = whp / 0,83, bnm = wnm / 0,83.
update public.dyno_pulls
   set loss_pct = 17,
       bhp = round(whp / 0.83, 2),
       bnm = round(wnm / 0.83, 2)
 where ride_code = 'US.037' and loss_pct = 20 and whp is not null;
