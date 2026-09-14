-- ════════════════════════════════════════════════════════════════════════════
-- BACKFILL_shopping_invoice_elos_BR.sql · 14/set/2026
-- Projeto: BR  saaowriaptbvfoqoykrh   (rodar pelo roda-sql do US: --projeto br)
-- ⚠ RODE DEPOIS DE MIGRATION_travessia_shopping_invoice_BR.sql (precisa de invoice_expenses.mirror_src).
--
-- O MESMO RISCO DO OUTRO LADO: as linhas das 085.N (lote de 24/08) não têm us_expense_id. O espelho do US
-- (app/api/br-mirror/shopping) casa pelo us_expense_id; sem ele, o próximo save da invoice do US APAGA as
-- linhas da 085.N e grava outras. Aqui cada linha da 085.N ganha o elo com a despesa do US que ela espelha:
-- us_expense_id (onde está vazio) e mirror_src = 'US:invoice_expenses:<id>'. NENHUM valor muda.
--
-- O CASAMENTO (medido em 14/09/2026 01:08 Orlando, pelo motor): US$ da linha do BR (amount_usd × qtd + tax/extra em R$
-- ÷ fator da linha) = custo da despesa do US (±0,02), um candidato de cada lado, empate só pelo texto único.
-- Pares: 68. As guardas conferem price, amount_usd, quantity, tax e extra EXATOS como foram lidos.
-- TRILHA: data_fixes (do BR), check_key 'shopping-invoice-elos'. FALHA FECHADA e IDEMPOTENTE como a do US.
-- VOLTA: ROLLBACK_shopping_invoice_elos_BR.sql
--
-- SEM PAR (não recebem elo), com o motivo:
--   · 085.6 · 427fe418-05c0-41bb-ac0a-ce01fb81a9b0 · US$ 5606.13 · kit motor — nenhuma linha PAID FROM GZ28BR do US com este valor

begin;

set local lock_timeout = '5s';
lock table public.invoice_expenses in share row exclusive mode;

create temp table elos_br (br_id uuid primary key, us_id uuid not null unique, price numeric, amount_usd numeric, quantity numeric, tax numeric, extra numeric, doc text not null, item text) on commit drop;
insert into elos_br (br_id, us_id, price, amount_usd, quantity, tax, extra, doc, item) values
  ('272a4ff4-1537-4dcc-ae79-6bdcdc1b3143', 'c5584dab-1d66-4fae-99c7-f564eaac8317', 317.4, 60, 1, 0, 35.44, '085.1 ⇄ US.009.1', 'Automotive V-Ribbed Belts (Heavy Duty)'),
  ('d3b84bfa-e144-4e49-84de-5fec6d962e64', 'f8582e11-167e-4829-a887-de8967dde5df', 386.17, 73, 1, 0, 43.11, '085.1 ⇄ US.009.1', 'Automotive V-Ribbed Belts (Heavy Duty)'),
  ('dd542c68-2ab9-41d7-b066-4d69f6fbfe8e', 'f1bc1666-5e0f-4656-83ce-05dfd1e88320', 15462.54, 2670.56, 1, 0, 0, '085.1 ⇄ US.009.1', 'TexasSpeed - Kit Comando'),
  ('b4ffb534-5f02-4e2b-9291-41b535eac8e3', 'd36277ba-c96a-4b83-9c09-37bc5d8bd3dd', 2841.02, 516.55, 1, 0, 0, '085.2 ⇄ US.001.1', '10 x licencas HP Tuners'),
  ('7b24eea6-7195-4e68-9274-bcd64aeb8ee5', 'bbd805ae-d083-4dfd-a53b-02bc73fbe1cd', 1635.58, 294.7, 1, 0, 0, '085.2 ⇄ US.001.1', '6 licenças HP Tuner'),
  ('c1046d08-ae28-4425-8225-76a137c42ad2', '2eb87992-9f09-4378-ae01-e6423f0b4493', 1124.64, 198, 1, 0, 0, '085.2 ⇄ US.001.1', 'Borla ATAK'),
  ('5b15c2e5-ec68-4ca1-9805-8a69b026a7bf', '4da4a08e-7f5d-4cbb-a5d5-3261ad6d5b05', 458.32, 83.33, 1, 0, 0, '085.2 ⇄ US.001.1', 'car wash'),
  ('c4d3d96d-6da3-4328-9270-31f7213ab3c8', '91261d1b-434f-4247-9564-ca3e6d2914eb', 3560.38, 643.83, 1, 0, 0, '085.2 ⇄ US.001.1', 'cc Beto'),
  ('bba7a03f-6fe5-4a97-a4a7-56bee81ba5aa', '2dbc6078-fe88-4e4c-8fd1-fd5e25aa8559', 8057.13, 1428.57, 1, 0, 0, '085.2 ⇄ US.001.1', 'Coletores + MidPipes Mutante'),
  ('e8df2355-5b36-4d71-9fcc-3d5b4c21c1c1', '56dec08d-6d20-4521-8e32-cb02a025e98d', 1991.77, 353.15, 1, 0, 0, '085.2 ⇄ US.001.1', 'Desbloqueio ECU + SmartCable'),
  ('0389af5a-6466-4e05-95c9-f94296f5270b', 'ae50bcea-ef60-46da-9a47-e08c2132e81e', 3801.74, 670.5, 1, 0, 0, '085.2 ⇄ US.001.1', 'ENTRADA Z1250sc GoldenEye Pack'),
  ('486971e4-df2c-472b-97df-3de8b2c0f218', '95c13f1d-3cfa-491c-82f2-5b3f2db1f185', 3727.98, 670.5, 1, 0, 0, '085.2 ⇄ US.001.1', 'FINAL Z1250sc GoldenEye Pack'),
  ('5584376a-92e1-46f8-9773-5efe7bc5e2c1', '062ade9a-2f32-47ab-98f9-b939fe6174e8', 97.48, 17.47, 1, 0, 0, '085.2 ⇄ US.001.1', 'flex sensor'),
  ('245a55be-cd5c-4dda-baf4-6731f98e5896', 'ad8c1c00-0b90-46d3-9500-032fc997ffe2', 334.57, 60.5, 1, 0, 0, '085.2 ⇄ US.001.1', 'front seal'),
  ('c8cadd6f-414e-4122-a667-6f23a08c8047', '7c99f8e3-29b2-40d7-9829-b6fe8b2249d5', 139.41, 25.21, 1, 0, 0, '085.2 ⇄ US.001.1', 'fuel'),
  ('91f1a8c1-8ff5-4448-ba7b-d129d2b38b5f', '6494218e-3b13-4052-828b-d42bc2ba6246', 23271.32, 4126.12, 1, 0, 0, '085.2 ⇄ US.001.1', 'global Titan purchase'),
  ('a657240e-e789-45ec-809f-dec510e46a1b', 'a685582d-cdfb-4429-a370-310c5da805ee', 1880.66, 339.47, 1, 0, 0, '085.2 ⇄ US.001.1', 'polia e cubo GripTec de 2.80in'),
  ('56b0c669-8b86-46fe-8644-349c84751430', 'd49c2ea1-3db7-4140-af15-5ab94bc3dfc8', 1886.96, 341.84, 1, 0, 0, '085.2 ⇄ US.001.1', 'retentor, esticador e correia'),
  ('624f222b-d215-4e63-9693-86a7a7315810', '0423b6a6-d0b4-40a6-ac07-83c37534069c', 392.9, 69.54, 1, 0, 0, '085.2 ⇄ US.001.1', 'Sport Springs - Mopar HOOD-PIN'),
  ('56fd7d35-f78d-470f-acaf-54d075f7e36c', 'd9cac33b-45e1-474a-adac-76b12944e384', 267.84, 48, 1, 0, 0, '085.2 ⇄ US.001.1', 'wrapping'),
  ('e026c30e-7be7-4451-9e6b-d3cbf6b4e816', 'aab9bcac-f979-47b9-b7b5-d09eb392f9bc', 1124.64, 198, 1, 0, 0, '085.3 ⇄ US.002.1', 'Borla ATAK'),
  ('46cf3581-725a-43d3-9c24-66891bb3cc4c', 'da3a7cc5-8b13-44a4-8107-b154d8c14717', 5651.53, 1027.55, 1, 0, 0, '085.3 ⇄ US.002.1', 'ENTRADA Z1500sc HellKing Pack'),
  ('e7b947e1-9e79-4388-aaba-9e0066674cc2', 'd8953e39-5235-4dc9-9f69-25d95253a98d', 5314.67, 952.45, 1, 0, 0, '085.3 ⇄ US.002.1', 'FINAL Z1500sc HellKing Pack'),
  ('c9ea9540-b323-40db-ab0e-45e9283779e1', 'b45a8476-6a8a-474a-a184-f46733b2a812', 141.36, 25.02, 1, 0, 0, '085.3 ⇄ US.002.1', 'Mopar HOOD-PIN'),
  ('512591bf-bbb2-4667-a13d-5bc8808765ea', '292c4c33-786a-45aa-8374-699d83bef236', 267.84, 48, 1, 0, 0, '085.3 ⇄ US.002.1', 'wrapping'),
  ('0e00c351-6d52-490c-9432-47466fa05918', 'ee8309c9-0e1f-48c4-b0f3-292b406231c5', 495.73, 89, 1, 4.51, 0, '085.4 ⇄ US.010.1', 'Dodge 2018+ Smart Access Cable'),
  ('1f61b60c-6620-4c84-b077-90c6c38374f8', '29a18bd6-37fa-46a3-a8ca-e2382d785c5b', 1392.44, 249.99, 1, 12.64, 0, '085.4 ⇄ US.010.1', 'Dodge PCM Services'),
  ('b88aa26d-43e8-4b92-8155-f99c616932a7', '51fae8ef-5087-44c3-9aa8-c437f902fcd0', 25785.6, 4740, 1, 0, 0, '085.4 ⇄ US.010.1', 'HellKing''s HEADs & Cam Kit Pack'),
  ('751017a0-f05f-4d94-b450-4bfba20706b9', '0f0e202f-f8d5-456c-8c2b-dfbcfb0f35ea', 5110.56, 936, 1, 0, 0, '085.4 ⇄ US.010.1', 'Impostos GZ28BR'),
  ('c4a5850f-2a7a-49f1-89fb-ae4ceb0f1f59', '877aa88f-74de-45a5-b8c7-f9b6fa8a1f2e', 16412.71, 3005.99, 1, 0, 0, '085.4 ⇄ US.010.1', 'Impostos GZ28BR'),
  ('eea5abb1-ed1b-4d63-98f1-75c2985ddf6d', 'dc05183d-95f4-4ff4-9c07-5e58d84bb1f8', 7265.54, 1345.47, 1, 0, 0, '085.4 ⇄ US.010.1', 'SuperCharger Porting'),
  ('53932f36-3195-4296-917d-25574ae6fa79', 'd414e336-4d38-4e98-8215-b34f080a31a7', 528.93, 97.95, 1, 0, 0, '085.4 ⇄ US.010.1', 'Suporte Cabo ParaQuedas'),
  ('127d3608-b1f2-4cad-8932-e6e26a6de9bd', 'a7e94517-1e4b-4568-b02b-13bd0636a9d2', 278.44, 49.99, 6, 15.09, 0, '085.4 ⇄ US.010.1', 'Universal Credits'),
  ('e69aaa36-18b7-441f-9791-9fedce6541b1', '0c0d7a0a-c22d-4fce-a278-c9205d76d63b', 660, 125, 1, 0, 0, '085.5 ⇄ US.029.1', 'Bagagem despachada 23kg (Azul AD8706 VCP-MCO 25/jul, Christina) — retorno do int'),
  ('510074e8-d44d-4da5-839a-819a47f6f646', 'e7122019-4294-45c4-b2b8-1766de96ee86', 1124.64, 198, 1, 0, 0, '085.6 ⇄ US.003.1', 'Borla ATAK'),
  ('c7c94bb8-8406-44b4-9186-4b7016315ac2', '7dce7ea9-81af-409a-b784-2f70d7914081', 458.32, 83.33, 1, 0, 0, '085.6 ⇄ US.003.1', 'car wash'),
  ('43cfb2c0-fc18-4ec6-923f-f9cd7cfe0117', '759611f7-99ec-4a2b-b46a-9b5189f35c70', 2100.79, 379.89, 1, 0, 0, '085.6 ⇄ US.003.1', 'Desbloqueio ECU + SmartCable'),
  ('4bc2b525-ad7e-40eb-b212-37c4d906e0c6', '0a58b4b1-263f-4977-bf29-5277560d0184', 845.6, 152.36, 1, 0, 0, '085.6 ⇄ US.003.1', 'envio ECU'),
  ('70b7fedf-4182-45af-b2fc-8304ee314f37', '4a9efbb4-973b-405b-ba62-dc144f7bcf90', 8004, 1450, 1, 0, 0, '085.6 ⇄ US.003.1', 'kit turbo Hellion'),
  ('6587a96c-2f7e-4292-878c-f6834059a6bb', '0a08091d-8da1-4df7-845a-b7a23bd07bdd', 28560.42, 5173.99, 1, 0, 0, '085.6 ⇄ US.003.1', 'kit turbo Hellion + IOF'),
  ('e5ed6535-a021-4569-af27-2977b6786f71', '31cc664e-e0bc-4bb3-88e3-f2bfd34b87cf', 28559.32, 5173.79, 1, 0, 0, '085.6 ⇄ US.003.1', 'kit turbo Hellion + IOF'),
  ('9658d0be-fc8c-494d-8f24-9ce16b5b8032', 'e9d9b2b5-1277-4f07-a43e-abfeb4656610', 46129.2, 8356.74, 1, 0, 0, '085.6 ⇄ US.003.1', 'kit turbo Hellion + IOF'),
  ('7ca53d4a-982c-4d59-ad08-52033a46a3aa', '562226d7-39af-4ebb-b85c-72411c68d315', 970.64, 174.89, 1, 0, 0, '085.6 ⇄ US.003.1', 'LongHorn (Guinchada)'),
  ('dcf729ed-0ee6-4956-a280-9dbbe1c97f8b', '4a9818f0-518c-4082-8054-4b6e17935025', 141.36, 25.02, 1, 0, 0, '085.6 ⇄ US.003.1', 'Mopar HOOD-PIN'),
  ('4ab2a220-f7b5-4489-bc5e-d5b9b7d5cc07', '655844cf-8bbc-419a-ab2b-827ada84492b', 273.78, 49.33, 1, 0, 0, '085.6 ⇄ US.003.1', 'parafuso do comando ARP'),
  ('2fa69776-7ff7-4d49-884b-a4e5369bb671', 'd77cb178-d582-4299-84fa-ab47a20a2fff', 132.96, 24, 1, 0, 0, '085.6 ⇄ US.003.1', 'wrapping'),
  ('7be832e0-33c1-4334-af2d-10fd86dde25f', 'e519f9fd-910e-487b-a71d-5203d35d3c0c', 15345.75, 2775, 1, 0, 0, '085.6 ⇄ US.003.1', 'Z1800tt Colossus Pack'),
  ('2d796760-4158-4b12-8718-8f4d12449123', 'ea204d6e-0498-4dd4-b5a4-58c15e824ccb', 1109.78, 199.96, 1, 0, 0, '085.7 ⇄ US.004.1', '4 licencas HP Tuner'),
  ('79cde663-651b-4e4c-81e4-70f7f79965cf', '76c5ff08-0492-4ce3-9d15-7871da7f54d9', 1185.82, 209.88, 1, 0, 0, '085.7 ⇄ US.004.1', 'Borla ATAK'),
  ('9882dd76-51f9-4684-8f2e-0d6d3ba1e34c', 'c6658647-6e9a-4cab-a438-0b6d79ab3112', 458.32, 83.33, 1, 0, 0, '085.7 ⇄ US.004.1', 'car wash'),
  ('1d9c1dbc-d8ca-4d23-8001-75d05dbc8636', '5073eb41-50fe-4889-9459-c533ab163a1b', 30313.25, 5481.6, 1, 0, 0, '085.7 ⇄ US.004.1', 'compra Titan'),
  ('8800cf27-a279-4a09-843b-9d69639b1856', '1c0dc10d-91cf-4e77-99cb-d4f791e87c79', 2290.8, 415, 1, 0, 0, '085.7 ⇄ US.004.1', 'Desbloqueio ECU + SmartCable'),
  ('adb7fed1-e99c-4951-b6c1-650d3d829368', '7d6bc502-bf74-4421-aa34-da77521c654a', 2100.79, 379.89, 1, 0, 0, '085.7 ⇄ US.004.1', 'Desbloqueio ECU + SmartCable'),
  ('2ba696bb-defa-4758-ad3b-73d33c78d211', '6ec8bab4-e4ab-496c-8fe3-5ca9d277c643', 713.29, 128.29, 1, 0, 0, '085.7 ⇄ US.004.1', 'envio ECU'),
  ('b95518c6-8b93-4b51-a74b-1c258feb3663', '0620e936-6161-4d40-9489-ea0b5f0e0cc5', 4152.42, 752.25, 1, 0, 0, '085.7 ⇄ US.004.1', 'Z600na Shaker Pack'),
  ('c6153ad5-19ad-41ea-8566-6be3f822a972', '1902e9dc-41d7-4df2-81ba-ae515eb3c3d6', 1293.62, 228.96, 1, 0, 0, '085.8 ⇄ US.005.1', 'Borla ATAK - Mopar HOOD-PIN'),
  ('99191f71-c5af-4742-a778-e3384f87f1f2', '2421c54b-5811-4c1d-8840-87fe8985d353', 458.32, 83.33, 1, 0, 0, '085.8 ⇄ US.005.1', 'car wash'),
  ('6ba0aa67-8111-4433-a5c4-34d3b3309d23', '422832ea-4f32-4ac6-9432-814a55f07839', 3982.68, 717.6, 1, 0, 0, '085.8 ⇄ US.005.1', 'damper ATI'),
  ('e922aa68-1c71-4d9d-b569-d38ba4eb07f8', 'd7de8c48-8d02-47b8-9ed9-8b792c593a89', 95.81, 17.42, 1, 0, 0, '085.8 ⇄ US.005.1', 'fueling'),
  ('b3a58beb-2732-451d-a4f1-7f12a28dbdac', '9452e3b6-b8bd-4c42-b92e-2b63f74b7c8b', 12018.47, 2165.49, 1, 0, 0, '085.8 ⇄ US.005.1', 'headers + conection pipes'),
  ('03b685fc-2fe4-4f4a-a99d-7e8c7b4e4d30', '159058cb-719f-41bc-8f4e-f4a37e98558b', 1733.77, 315.23, 1, 0, 0, '085.8 ⇄ US.005.1', 'HP Tuners licences'),
  ('f61bb9cd-0037-4562-88a6-940d463d1dcd', '68b6ba73-079d-479a-b9ad-da8c12d9a78a', 48176.23, 8664.79, 1, 0, 0, '085.8 ⇄ US.005.1', 'kit ProCharger'),
  ('a500c226-2b9f-4b5b-b550-677c0f69d4a8', '2a85819a-48a0-4f11-ac85-967261d46e9e', 6756.48, 1224, 1, 0, 0, '085.8 ⇄ US.005.1', 'Z750pc Whistler Pack'),
  ('b579c5eb-668e-4a0d-baed-a4d24d4cc6e8', '3f78aff8-aaea-40b2-bb6b-d5ce4dcb5b6a', 1327.19, 234.9, 1, 0, 0, '085.9 ⇄ US.006.1', 'Borla ATAK - Mopar HOOD-PIN'),
  ('529d60b1-7a5c-43d1-9972-734b6c27d061', '4a4bf303-1a20-4ee2-a259-b2e4708a13ab', 458.32, 83.33, 1, 0, 0, '085.9 ⇄ US.006.1', 'car wash'),
  ('c87decfc-98f4-4963-a328-d99004a85d1b', '6d536f85-5ccd-42d6-b445-2b0a7a3c6430', 273.5, 50, 1, 0, 0, '085.10 ⇄ US.008.1', 'extra luggage Sidney'),
  ('e6736e7a-c644-4bcf-bcb9-5269f15cf0ee', 'd26551ec-d98c-46bf-a5ad-f8c3969c7da3', 15872.1, 2770, 1, 0, 0, '085.10 ⇄ US.008.1', 'Frankstein'),
  ('8d77bbba-f7ce-46c0-85e6-890a62c75aa5', '070b6772-81a9-4a4f-a97d-57cc6449a45f', 1996.28, 344.78, 1, 0, 0, '085.10 ⇄ US.008.1', 'HP Tuners - ECU Unlock');

do $$
declare n int; esperado int;
begin
  select count(*) into esperado from elos_br;
  if esperado <> 68 then raise exception 'esperava 68 pares, a tabela tem %', esperado; end if;
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'invoice_expenses' and column_name = 'mirror_src';
  if n <> 1 then raise exception 'invoice_expenses.mirror_src não existe — rode antes MIGRATION_travessia_shopping_invoice_BR.sql'; end if;
  select count(*) into n from elos_br x join public.invoice_expenses e on e.id = x.br_id
   where e.price is not distinct from x.price and e.amount_usd is not distinct from x.amount_usd and e.quantity is not distinct from x.quantity
     and e.tax is not distinct from x.tax and e.extra is not distinct from x.extra
     and (e.us_expense_id is null or e.us_expense_id = x.us_id)
     and (e.mirror_src is null or e.mirror_src = 'US:invoice_expenses:' || x.us_id)
     and e.invoice_id in (select id from public.invoices where client_id = '6d4264bc-9357-4190-94d8-bdc3a254d5bd');
  if n <> esperado then raise exception 'só % de % linhas da 085.N estão como foram medidas — nada escrito; meça de novo', n, esperado; end if;
  select count(*) into n from public.invoice_expenses e join elos_br x
      on (e.us_expense_id = x.us_id or e.mirror_src = 'US:invoice_expenses:' || x.us_id) and e.id <> x.br_id;
  if n <> 0 then raise exception '% despesa(s) do US já estão ligadas a outra linha do BR — nada escrito', n; end if;
end $$;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'shopping-invoice-elos', 'invoice_expenses', e.id::text, 'us_expense_id', null, x.us_id::text, left('elos 14/set · ' || x.doc || ' · ' || coalesce(x.item, ''), 500)
  from elos_br x join public.invoice_expenses e on e.id = x.br_id where e.us_expense_id is null;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'shopping-invoice-elos', 'invoice_expenses', e.id::text, 'mirror_src', null, 'US:invoice_expenses:' || x.us_id, left('elos 14/set · ' || x.doc || ' · ' || coalesce(x.item, ''), 500)
  from elos_br x join public.invoice_expenses e on e.id = x.br_id where e.mirror_src is null;

update public.invoice_expenses e set us_expense_id = x.us_id from elos_br x where e.id = x.br_id and e.us_expense_id is null;
update public.invoice_expenses e set mirror_src = 'US:invoice_expenses:' || x.us_id from elos_br x where e.id = x.br_id and e.mirror_src is null;

do $$
declare n int;
begin
  select count(*) into n from elos_br x join public.invoice_expenses e on e.id = x.br_id and e.us_expense_id = x.us_id and e.mirror_src = 'US:invoice_expenses:' || x.us_id;
  if n <> 68 then raise exception 'depois da escrita só % de 68 linhas ficaram com os dois elos', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura) ──
select i.invoice_code, count(*) linhas, count(e.us_expense_id) com_us_expense_id, count(e.mirror_src) com_mirror_src
  from public.invoice_expenses e join public.invoices i on i.id = e.invoice_id
  where i.client_id = '6d4264bc-9357-4190-94d8-bdc3a254d5bd' group by i.invoice_code order by i.invoice_code;
select field, count(*) from public.data_fixes where check_key = 'shopping-invoice-elos' group by field;
