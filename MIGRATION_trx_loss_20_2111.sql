-- TRX = 20% DE PERDA (Marcio, 21/11/2026: «use 20% of loss to the TRX»). Era 18% desde 17/11.
-- HellMonster US.037 e a unica TRX com puxadas. A roda medida NAO muda; o virabrequim e re-derivado:
-- bhp = whp / 0,80, bnm = wnm / 0,80. Pega tambem a linha de 17/11 que tinha ficado a 17%.
-- Voltar: update ... set loss_pct = 18, bhp = round(whp / 0.82, 2), bnm = round(wnm / 0.82, 2) where ride_code = 'US.037' and loss_pct = 20.
update public.dyno_pulls
   set loss_pct = 20,
       bhp = round(whp / 0.80, 2),
       bnm = round(wnm / 0.80, 2)
 where ride_code = 'US.037' and loss_pct in (17, 18) and whp is not null;
