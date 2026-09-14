-- ════════════════════════════════════════════════════════════════════════════
-- BACKFILL_shopping_invoice_elos_US.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
-- ⚠ RODE DEPOIS DE MIGRATION_travessia_shopping_invoice_US.sql (precisa de invoice_expenses.mirror_src).
--
-- O RISCO MAIS URGENTE DA TRAVESSIA: só 1 das despesas das 006.N tem br_expense_id. O editor do BR
-- (lib/usShoppingMirror.ts, no save) casa a linha do US pelo br_expense_id; sem ele, APAGA a despesa do US
-- e grava outra — id novo, e o ponteiro do extrato (bank_transactions) fica apontando para o nada.
-- Aqui cada despesa da 006.N ganha o elo com a linha do BR que ela espelha: br_expense_id (onde está vazio)
-- e mirror_src = 'BR:invoice_expenses:<id>'. NENHUM valor muda: preço, datas, pagador e texto ficam.
--
-- O CASAMENTO (medido pela REST com a chave de serviço em 14/09/2026 01:08 Orlando, pelo motor lib/crossing.server.ts):
--   · elo já gravado (br_expense_id) → par;
--   · senão, VALOR EXATO: US$ da linha do BR (amount_usd × qtd + tax/extra em R$ ÷ fator da própria linha)
--     = custo do US × 1,10 (±0,02), com UM candidato de cada lado; empate só se desfaz pelo texto único;
--   · senão, classe (b): US$ do BR = custo cru (±0,02), mesmo critério — a identidade é exata, o valor do
--     BR é que está errado (correção proposta à parte, NÃO aqui).
-- Pares: 58 (49 custo × 1,10 · 9 classe (b)) · 1 já tinham br_expense_id (ganham só o mirror_src).
-- Pares dentro de invoice que o motor ainda trava por conflito (o elo da LINHA é exato mesmo assim): 006.2 ⇄ BR.496.1, 006.12 ⇄ BR.181.1, 006.13 ⇄ BR.502.1, 006.16 ⇄ BR.496.1, 006.18 ⇄ BR.1001.1, 006.19 ⇄ US.006.1, 006.26 ⇄ BR.472.1, 006.28 ⇄ BR.1009.1.
-- Ponteiros de banco em despesas das 006.N: 15; ficam protegidos por este elo: 10.
--
-- TRILHA: data_fixes, check_key 'shopping-invoice-elos', um registro por campo escrito, gravado ANTES do UPDATE.
-- FALHA FECHADA: se qualquer linha não estiver exatamente como foi medida (custo ao centavo, elo vazio ou
-- igual), NADA é escrito — meça de novo e gere este arquivo outra vez (.claude-scratch/gera-backfill-elos.cjs).
-- IDEMPOTENTE: rodar de novo não escreve nada (só preenche o que está vazio).
-- VOLTA: ROLLBACK_shopping_invoice_elos_US.sql
--
-- SEM PAR (não recebem elo), com o motivo:
--   · 006.8 · 0640a5e8-428b-4458-becd-31f92d073560 · US$ 198.82 · Billet Rear Main Seal Housing Cover / Block Suppor — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 287070a9-ee01-4ef8-89ec-d80a1c1e9e6b · US$ 87.89 · ARP Side bolts Ford Modular Engine with Windsor 4. — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 342ff4ed-1911-4e2c-b958-58c63921c2c8 · US$ 54.41 · Billet Cylinder Head Dowels 4.6 /5.0 / 5.4 Ford Mo — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 3a964177-a6af-480a-9126-2c090764342d · US$ 167.43 · 2007-14 Shelby GT500 Timing Chain Guides — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 4b456a72-d979-4a43-ba4d-75682dfd5dc0 · US$ 193.59 · ARP 4.6 / 5.4 Camshaft Sprocket retaining bolts 4V — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 606daeca-8a57-4840-b3e1-bd9c819458b2 · US$ 54.41 · Front Cover Gasket Kit 5.4/5.8 4V ALL — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 6e7162cf-e349-427d-94b6-5e6b4eb913fb · US$ 66.96 · ARP Crankshaft Bolt / Balancer Bolt 5.4 & 5.8 GT50 — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · 9bb1bb97-e975-49fe-8ff0-9636658f20c0 · US$ 266.84 · 2007-14 Shelby GT500 Cast Iron Primary Timing Chai — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · a94648db-eedd-44c8-99b2-db05ee37f41d · US$ 66.96 · 4.6 / 5.4 Valve Cover Gasket kit Ford Mustang Cobr — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · afc08e95-7ed8-4cd4-b75d-31aed3becd57 · US$ 295.99 · Ebay Purchase — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · b9345764-1be4-4745-bbdd-4ebead702f0a · US$ 1197.17 · MMR / Manley 2007-2014 GT500 / Ford GT Valve Sprin — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · bb8d6654-056d-4622-8f55-50b8c3517b6c · US$ 2261.44 · Manley Billet I BEAM Connecting Rods For ALL 5.4 / — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.8 · d55e047e-807d-48ef-90c0-7d97d26912ed · US$ 399.75 · 2007-2010 GT500 / 5.4 Iron Block ARP Main studs ki — nenhuma linha do BR com custo × 1,10 (nem custo cru) igual
--   · 006.9 · 1 despesa(s) · US$ 390 — sem invoice do BR de origem (lançada direto no US)
--   · 006.1 · 2 despesa(s) · US$ 663.81 — sem invoice do BR de origem (lançada direto no US)
--   · 006.4 · 1 despesa(s) · US$ 25.02 — sem invoice do BR de origem (lançada direto no US)
--   · 006.25 · 1 despesa(s) · US$ 1440.9 — sem invoice do BR de origem (lançada direto no US)
--   · US.014.1 · 24 despesa(s) · US$ 3518.52 — invoice de CARRO no cliente GZ28BR (fora deste passo)
--   · 006.6 · 1 despesa(s) · US$ 851.36 — sem invoice do BR de origem (lançada direto no US)
--   · 006.7 · 1 despesa(s) · US$ 235.89 — sem invoice do BR de origem (lançada direto no US)
--   · 006.10 · 1 despesa(s) · US$ 2242.11 — sem invoice do BR de origem (lançada direto no US)

begin;

set local lock_timeout = '5s';
lock table public.invoice_expenses in share row exclusive mode;

create temp table elos_us (us_id uuid primary key, br_id uuid not null unique, custo numeric not null, doc text not null, classe text not null, item text) on commit drop;
insert into elos_us (us_id, br_id, custo, doc, classe, item) values
  ('371bc8a6-5f5d-4b4e-97f0-7b74f78f5b93', 'dd870256-d694-475b-9e7f-38c58dd15d8b', 96.65, '006.2 ⇄ BR.496.1', 'custo x 1,10', 'Dodge 2018+ Smart Access Cable'),
  ('f0541966-fe98-4c94-be1a-0959986e17b6', '62fc87dc-f89f-49b7-8034-dc812f0f4211', 977.33, '006.2 ⇄ BR.496.1', 'custo x 1,10', 'Dodge PCM Services'),
  ('e655e31b-9a0e-4079-8510-60cb6d8b63d7', '54d12e1e-f8ae-49ad-886b-01e959d13d3f', 99.98, '006.3 ⇄ BR.485.1', 'custo x 1,10', 'Universal Credits'),
  ('0bcdf798-5497-4e7c-9ae5-d5b6cde5b1d5', 'c0781db6-eece-4c82-9f99-42150cf7fd5b', 1525.62, '006.5 ⇄ BR.509.1', 'custo x 1,10', 'GM E68 ECM Service (Global B)'),
  ('bc4f343b-7c55-4667-b903-b0a4c549fa85', '9fb0294a-4b42-4b21-8f63-9a8b80e78323', 1411.95, '006.11 ⇄ BR.479.1', 'custo x 1,10', 'Injector Dynamics 1728cc/min fuel injector, 34mm, 14mm orange o-ring'),
  ('cfd6e662-93e1-414b-b9e4-f911a547bfe5', '8877444e-5053-4de4-bcb6-7afb2ac5766f', 93.7, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'ACL Connecting Rod Bearing Set for Standard Clearance, Chamfered'),
  ('d5eeeec5-3617-43f8-9cde-b66a5ddd853f', '2e2448b6-53ef-4c5b-911f-d519785ea740', 145.07, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'ACL LS Main Bearing Set — .001in Extra Clearance, Chamfered (ACL-5M7298HX-STD, s'),
  ('44597925-3809-45a5-9cfc-97cf612e8137', '601aeee7-0d89-4069-973d-6609beaf27f7', 350.02, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'ARP 6.2L LT1 Head Stud Kit Without Corner Bolts'),
  ('c524c8cf-1e6a-47d2-80c5-bf4cc899807c', 'a5bef20a-a648-42a2-b24e-cd381df9e338', 206.69, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'ARP 6.2L LT1 Main Stud Kit'),
  ('41374d7e-1515-4bd9-bdc9-27ebe496a2f8', '5f12cb6a-1c79-4467-a39b-ba4ed4daa4a6', 2027.12, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Borla ATAK 3" Cat-Back Exhaust System w/ Dual Mode Valves (NPP) — Chevrolet Cama'),
  ('5674a2c7-f307-4ed3-9dc9-8859019db554', '58fea51f-6e54-4e7a-8d82-84a2c13ec7c9', 226.46, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Cometic MLX LT1/LT4 Gen-V Small Block V8 .051in MLX Cylinder Head Gasket, 4.100i'),
  ('5f820216-a200-4cdb-915f-462d6677ebe0', '6e5eeb4e-9502-4502-a676-419135c8881c', 13.01, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Genuine GM Parts Gen V LT Engine Valley Cover Gasket'),
  ('7fa0daaa-c198-4d1d-8016-924fb677d44d', '1b9e820e-db7e-411c-a8e0-0ff6689b545c', 18.06, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Genuine GM Parts Gen V LT Front Crank Seal'),
  ('39bb2226-137c-4a04-9c72-721716f21f35', '5715d630-1ff3-48ff-9b5c-7a174f5e6459', 11.39, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Genuine GM Parts Gen V LT Water Pump Gasket - Sold Individually'),
  ('5b937b89-3a9a-423f-8193-d3bf58e124c4', 'ab9ad791-dd35-493a-af35-81137ab7453e', 27.86, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'GM LS Rear Main Seal'),
  ('c28215f1-09a0-445c-823f-4bf98921a0fb', '40e9be1e-63a3-4822-8875-00de00578b38', 20.02, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'GM LS2/LS3/LS7/L98 Lifter Trays'),
  ('6eeadf2a-1b13-409d-88cd-3abc3f5212f2', '9a9e7b8e-158d-4c2f-b3e7-1ce3a9f9f7aa', 135.16, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'GM/Delphi Replacement LS7 Style Lifters, Set of 16'),
  ('14841dbc-a137-48a1-8908-a9c7efc6a1ed', '74591385-1215-4a5c-8a4a-d3525356437f', 23.78, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Sac City Corvette LT Oil Restrictor (Aluminum Barbell)'),
  ('b390dc5f-2299-43e2-8f83-591ad39490e8', '6ba43d31-6101-40b6-b2f4-66d7c0114f61', 806.47, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Texas Speed & Performance LT1/L86 6.2L 3-Bolt Cam Kit'),
  ('06bda5ac-6691-4d75-9a91-2fc9023dff7f', '0b1ab903-e6a4-4848-87d3-37a7a47fbeee', 274.74, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Texas Speed Gen 5 LT Timing Cover - Wet Sump, VVT Delete KIT'),
  ('01b96659-eb79-4847-8d60-054671d039ac', '27a95fa3-4e08-4c64-bf7b-3f0e6d54ae68', 29.12, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'TSP Exhaust Manifold Gasket, Each, 2014+ 5.3/6.2L DI Engines'),
  ('9e1367a9-3ff9-4441-93b3-cb78dd2be676', '15d13911-3cc5-4be4-84ed-cbe300fa5427', 21.94, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'TSP LS Camshaft Retainer Plate and Bolts Kit'),
  ('2e56a298-e26f-413b-9535-2ac8888ce364', '1f87d6a2-041c-41b7-a508-470bfa014b53', 604.35, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'TSP Super I-Beam 6.125in Connecting Rod Set with ARP L19 Bolts, Set of 8'),
  ('f118aa47-f5d4-44ee-9ae6-b089f20702e0', 'a473d5a1-16ca-4e5c-84c2-d016aa0c9b7e', 1093.92, '006.12 ⇄ BR.181.1', 'custo x 1,10', 'Wiseco 6.2L LT1/LT4/L86 -12cc Dished Piston Set for 3.622in Stroke, 4.07in Bore'),
  ('069c92c3-51a4-4020-b9cc-44a4d3511c23', '3801d17d-12d6-4847-b345-f3b4079617db', 206.59, '006.13 ⇄ BR.502.1', 'custo x 1,10', 'MOPAR 68238603AA Coil Pack for 06-24 5.7/6.1/6.2/6.4L HEMI'),
  ('1c25536d-910a-4989-864f-c9c9fea02e18', '4ed47868-5d18-4dcf-ba50-1cd96a65aecc', 1485.71, '006.14 ⇄ BR.168.1', 'custo x 1,10', 'Injector Dynamics 1340cc/min high impedance fuel injector, 48mm, 14mm adaptor. S'),
  ('bb1c817c-a114-430f-aab8-3e0684ceb19f', '0af1557e-382f-4f97-a142-0a5675554170', 600, '006.15 ⇄ BR.492.1', 'custo x 1,10', 'Tune'),
  ('2f53f39e-c74e-40d6-b22c-5f5bb77d6116', 'b7a6a03d-1175-43a0-8336-160c90622c36', 149.97, '006.16 ⇄ BR.496.1', 'custo x 1,10', 'Universal Credits'),
  ('bf565648-07b0-4f0b-9275-e0f2c05a5d52', '8f5e1250-d5be-4d33-98a3-afda22062c53', 6900, '006.17 ⇄ BR.527.1', 'custo x 1,10', 'Whipple Chevy Camaro ZL1 / Cadillac CTS-V LT4 2016-2024 Gen 6 3.0L Supercharger '),
  ('a76fd8f9-fab2-4203-aab6-1b0b1353cf68', 'fcfe79ea-0b2a-407c-8b8e-f6465486dfc4', 924.08, '006.18 ⇄ BR.1001.1', 'classe (b)', '2015-2023 Dodge Challenger / Demon Style Wide Body Kit (2 kits por $1.848,15 — d'),
  ('62de19ca-c76e-4a4b-90d1-95f722eedf44', 'f1c6a4b7-e5c6-4245-9a28-4d29d165650b', 2653.35, '006.18 ⇄ BR.1001.1', 'classe (b)', 'MOPAR 77072552AC Widebody Fender Flare Kit for 15-23 Challenger — kit ORIGINAL D'),
  ('f9c438da-34d6-43b4-a2a8-3a23285c219e', '184f9c53-c4d5-46dc-b642-91d70b9b633b', 924.07, '006.19 ⇄ US.006.1', 'classe (b)', '2015-2023 Dodge Challenger / Demon Style Wide Body Kit (2 kits por $1.848,15 — d'),
  ('9df53a16-56e3-425b-b20a-06fe939bc852', '4ed48d7f-c0ab-4d73-a636-04c0855bade6', 2645.4, '006.19 ⇄ US.006.1', 'classe (b)', 'MOPAR 77072552AC Widebody Fender Flare Kit for 15-23 Challenger — kit ORIGINAL D'),
  ('4bf61bbe-0b3f-44aa-bae6-a217ebb33e66', 'd8eff741-b4a5-465e-a22e-bfa87b2fb5e2', 36.09, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'DLG PREMIUM TRA Duralast Gold Transmission Filter'),
  ('463a4640-f1f8-47fd-822e-54707def7e76', '5377dbb9-08ad-4a23-bd7a-efbb5542ddf1', 13.49, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'DURALAST FUEL Duralast Fuel Filter'),
  ('7435149e-7577-49a4-b9d1-0a3e7d603c15', '7c3b2a58-aa9d-401c-a0c0-2012c5fb799d', 7.19, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'DURALAST SEAL Duralast Differential Pinion Seal'),
  ('3bc037dc-2adf-4fc1-9540-62e4ed3a31cf', 'ad06587f-ec87-4bc8-b5ce-9ff92b1f038f', 5.71, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'OIL SEAL SET ACDelco Oil Seal Set'),
  ('85991bf8-646b-49f9-abbe-0bcec91a4af1', 'd2bc0491-08c1-4746-876f-210737bddb28', 6.39, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'SPIN-ON XL STP Extended Life Oil Filter'),
  ('f56c529e-c0b3-4415-9fd9-915839f23a32', 'd044e56d-a9bc-4b09-bb2c-6fa343446013', 21.77, '006.20 ⇄ BR.529.1', 'custo x 1,10', 'STP AIR FILTER STP Air Filter'),
  ('904bee2e-8d3b-42cd-a2f8-dae91c99085f', 'd83c0658-2fec-4fa6-b1ac-b512e737c06d', 851.36, '006.21 ⇄ BR.511.1', 'custo x 1,10', 'Injector Dynamics ID1050-XDS high impedance fuel injector, Set of 8'),
  ('b47a4072-4016-4d35-82c3-2cb8da821731', '174e7917-251e-4cdb-9d68-258f71bd4d78', 433, '006.22 ⇄ US.038.1', 'custo x 1,10', 'HEMI 392 Complete Intake Manifold'),
  ('f91d5b5e-7a25-425c-9068-f553b6551c08', 'f955e527-7834-47d9-872a-a435cdb5daaf', 369, '006.24 ⇄ 047.1', 'custo x 1,10', 'Authentic Genuine GM Bosch 42lb 42# fuel injectors 08-13 Corvette 10-15 Camaro S'),
  ('a3c9c2a6-c84e-482a-9509-273daa197cae', '29677ea2-e627-447b-bf61-a467a8af14e6', 558.95, '006.26 ⇄ BR.472.1', 'classe (b)', 'COMP Cams 20-746-9 — Camshaft XE Hyd. Roller 265/273 .506"'),
  ('ad1c66c0-0950-4dba-9782-7128fd0f63a6', 'af32b767-b990-4a89-9ea4-0a05c0c3a8d0', 288.95, '006.26 ⇄ BR.472.1', 'classe (b)', 'COMP Cams 26918-16 — Valve Springs beehive 372 lb/in (16)'),
  ('4b40e6c8-78e3-4647-8da6-ad98d8af470b', 'bdbcf914-2389-4cc6-8f98-eb1f45d03911', 43.95, '006.26 ⇄ BR.472.1', 'classe (b)', 'COMP Cams 648-16 — Race Valve Locks 7° 11/32" (32)'),
  ('226676d9-410c-401c-91fe-b8a8531d07ae', '4715c4fb-6720-4716-a953-1c804c87fc06', 90.95, '006.26 ⇄ BR.472.1', 'classe (b)', 'COMP Cams 787-16 — Steel Valve Spring Retainers 7° (16)'),
  ('4c2a702a-9906-489a-9f89-b735ac9644e4', '7bb9733d-807f-4288-bd3e-1b853ff8cb13', 203.95, '006.26 ⇄ BR.472.1', 'classe (b)', 'COMP Cams 7940-16 — Hi-Tech Pushrods chromoly 5/16" 7.200" (16)'),
  ('f0237fca-554b-4262-9347-51c03548412b', 'a0ded241-88a4-454d-bcbb-675e62f2f420', 367.1, '006.27 ⇄ BR.1010.1', 'custo x 1,10', 'Eibach E10-27-004-01-22 Pro-Kit for 15-23 Challenger (recomprar)'),
  ('429068df-afb0-4ac9-8660-60607774a249', 'a83450c4-d1a9-426c-8e58-9b99df72c2ea', 61.29, '006.27 ⇄ BR.1010.1', 'custo x 1,10', 'For 2008-2022 2023 Dodge Challenger R/T SRT SXT Black Hood Pin Kit 2214260'),
  ('de078cda-af97-4d80-9a5b-72351e3f46b7', '6e14874b-b3f0-411a-92a4-61f33ca1e3be', 1718.48, '006.27 ⇄ BR.1010.1', 'custo x 1,10', 'HHP by Kooks 3101H610 2" x 3" Headers & Competition Only Connection Kit — 06-23 '),
  ('2881243b-202a-4153-a3d6-68aa5508e055', '54f9921a-29d1-424c-8b1e-6e93bf536422', 27.25, '006.27 ⇄ BR.1010.1', 'custo x 1,10', 'MOPAR 05038098AA Left Exhaust Manifold Gasket (recomprar)'),
  ('3f6c11e4-6545-4ccc-a749-d2afb83108f3', '651b6526-da24-45b4-9a43-0e89c144d0bb', 27.25, '006.27 ⇄ BR.1010.1', 'custo x 1,10', 'MOPAR 05038099AA Right Exhaust Manifold Gasket (recomprar)'),
  ('4b90aea6-813b-4d0a-9334-53824fc0b661', 'd9176d70-c658-44ee-8030-791fa18ae35e', 61.29, '006.28 ⇄ BR.1009.1', 'custo x 1,10', 'For 2008-2022 2023 Dodge Challenger R/T SRT SXT Black Hood Pin Kit 2214260'),
  ('d8b64c2d-016d-41b7-9435-b25b4211210e', '5feee1fe-91ce-4737-93af-59d2b1fadaa3', 9.71, '006.32 ⇄ BR.403.1', 'custo x 1,10', 'DLG SEAL'),
  ('8c272009-8414-46c5-b73b-451ce5bddc78', 'fb07ff2a-4a2f-44ab-8bd2-b37a8efff145', 8.99, '006.32 ⇄ BR.403.1', 'custo x 1,10', 'DLG SEAL'),
  ('48457d59-dea4-4fbc-a43b-acbd38c0558c', 'fe71b3fd-37d4-4c4a-b66a-9a6ac461ad01', 60.01, '006.33 ⇄ BR.417.1', 'custo x 1,10', 'Emblema de paralama "Hell Hulk" verde limão'),
  ('b9f92186-0d4f-4163-9f5d-4673d5f3c637', '4bf9b31e-7f19-417f-bb0a-b554fdbc2ab0', 1534.55, '006.34 ⇄ BR.180.1', 'custo x 1,10', 'Chopper Valvetrain — Cesar Tellez (PayPal 37Y4419829942071E, $1,400.00 + fee $40'),
  ('bc45f2fe-dcf6-4436-a31b-73a5309ecaea', '20dc8e72-9dd9-4912-b44a-b35693b22fff', 851.36, '006.35 ⇄ BR.386.1', 'custo x 1,10', 'Injector Dynamics ID1050-XDS high impedance fuel injector, Set of 8');

do $$
declare n int; esperado int;
begin
  select count(*) into esperado from elos_us;
  if esperado <> 58 then raise exception 'esperava 58 pares, a tabela tem %', esperado; end if;
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'invoice_expenses' and column_name = 'mirror_src';
  if n <> 1 then raise exception 'invoice_expenses.mirror_src não existe — rode antes MIGRATION_travessia_shopping_invoice_US.sql'; end if;
  -- cada linha como foi medida: existe, custo igual ao centavo, elo vazio ou já o mesmo
  select count(*) into n from elos_us x join public.invoice_expenses e on e.id = x.us_id
   where round(e.price * coalesce(nullif(e.quantity, 0), 1) + coalesce(e.tax, 0) + coalesce(e.extra, 0), 2) = x.custo
     and (e.br_expense_id is null or e.br_expense_id = x.br_id)
     and (e.mirror_src is null or e.mirror_src = 'BR:invoice_expenses:' || x.br_id);
  if n <> esperado then raise exception 'só % de % despesas estão como foram medidas (custo ou elo mudou) — nada escrito; meça de novo', n, esperado; end if;
  -- a linha do BR não está ligada a OUTRA despesa do US
  select count(*) into n from public.invoice_expenses e join elos_us x
      on (e.br_expense_id = x.br_id or e.mirror_src = 'BR:invoice_expenses:' || x.br_id) and e.id <> x.us_id;
  if n <> 0 then raise exception '% linha(s) do BR já estão ligadas a outra despesa do US — nada escrito', n; end if;
end $$;

-- trilha antes da escrita (só do que muda)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'shopping-invoice-elos', 'invoice_expenses', e.id::text, 'br_expense_id', null, x.br_id::text,
       left('elos 14/set · ' || x.doc || ' · ' || x.classe || ' · ' || coalesce(x.item, ''), 500)
  from elos_us x join public.invoice_expenses e on e.id = x.us_id where e.br_expense_id is null;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'shopping-invoice-elos', 'invoice_expenses', e.id::text, 'mirror_src', null, 'BR:invoice_expenses:' || x.br_id,
       left('elos 14/set · ' || x.doc || ' · ' || x.classe || ' · ' || coalesce(x.item, ''), 500)
  from elos_us x join public.invoice_expenses e on e.id = x.us_id where e.mirror_src is null;

update public.invoice_expenses e set br_expense_id = x.br_id from elos_us x where e.id = x.us_id and e.br_expense_id is null;
update public.invoice_expenses e set mirror_src = 'BR:invoice_expenses:' || x.br_id from elos_us x where e.id = x.us_id and e.mirror_src is null;

do $$
declare n int;
begin
  select count(*) into n from elos_us x join public.invoice_expenses e on e.id = x.us_id and e.br_expense_id = x.br_id and e.mirror_src = 'BR:invoice_expenses:' || x.br_id;
  if n <> 58 then raise exception 'depois da escrita só % de 58 despesas ficaram com os dois elos', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura) ──
select i.invoice_code, count(*) despesas, count(e.br_expense_id) com_br_expense_id, count(e.mirror_src) com_mirror_src
  from public.invoice_expenses e join public.invoices i on i.id = e.invoice_id
  where i.client_id = '97c4a91e-d1c2-48ca-9d05-8662fe324f27' group by i.invoice_code order by i.invoice_code;
select field, count(*) from public.data_fixes where check_key = 'shopping-invoice-elos' group by field;
