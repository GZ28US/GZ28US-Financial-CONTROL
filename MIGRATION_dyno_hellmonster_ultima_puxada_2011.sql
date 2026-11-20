-- HellMonster US.037 — a puxada gravada em 20/11/2026 saiu com os números da puxada de 19/11 (833,55 whp), porque a folha
-- trazia as duas sobrepostas e o scan lia a mais alta. A folha de 20/11 15:25 diz: 827,05 whp · 830,17 lb·ft · CF STD 1,03.
-- (Márcio, 20/11: «o certo é escolher o último, o de 827whp».) Perda 18% fixa da TRX: bhp = roda ÷ 0,82.
update public.dyno_pulls
   set whp = 827.05, wnm = 830.17, bhp = 1008.60, bnm = 1012.40, pull_date = '2026-11-20', correction_factor = 1.03
 where id = '4e89f926-1299-4f18-b317-6492899031fa' and whp = 833.55;
