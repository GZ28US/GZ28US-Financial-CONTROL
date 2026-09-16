-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_sema2025_marketing_BR.sql — os 17 espelhos mudam para a 085.N do MARKETING (BR)
-- Projeto: BR saaowriaptbvfoqoykrh · gerado em 16/09/2026 pela sessão App development, a pedido da sessão Auto Book (APPDEV item 13).
--
-- Márcio, 16/09: «o que for de Vegas, ponha em Marketing, SEMA 2025, assim como tudo que envolve o SEMA 2025, tem que
-- estar lá, tudo». 18 linhas de staff_expenses PAID FROM GZ28BR (US$ 6.576,45: TEAM-2025-SEMA 2.430,76 + voos que tocam
-- LAS 4.145,69) saem das seasons e viram custo fixo do fornecedor de MARKETING 1414abb3-37f3-4843-8267-2ab0d61f1c06
-- («SEMA Show 2025 — Las Vegas»). Os 2 voos do Nivaldo (384b65ad, b9c99142) FICAM na season.
-- No BR, os 17 espelhos (despesa + item) MUDAM de 085.N — da 085.N da season para a 085.N nova do marketing, com a
-- mirror_src nova. NADA é recriado: o R$ já carimbado fica como está e a conta BR × US não pisca.
--
-- ORDEM (fora do minuto :47, quando roda o cron da travessia):
--   1. MIGRATION_sema2025_marketing_US.sql  — trava as 7 chaves por ~1 h (crossing_locks), copia as 18 linhas para
--      fixed_cost_expenses (ids fixos, gerados antes) e apaga as de staff_expenses (a linha inteira fica na trilha).
--   2. MIGRATION_sema2025_marketing_BR.sql  — cria a 085.N do marketing e move os 17 espelhos para ela.
--   3. GET /ca/api/crossing — conferir: a chave US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06 tem de ADOTAR as linhas (pares por mirror_src);
--      as seasons só ajustam o Pending balance. «espelho órfão» ou «sem origem» = PARAR.
--   4. DESTRAVA_sema2025_marketing.sql — tira as 7 travas (ou esperar vencerem).
-- Se o passo 2 falhar, as travas seguram o motor: rodar as duas VOLTAS antes de elas vencerem.
-- Trilha: data_fixes check_key 'sema2025-marketing' nos dois bancos.
-- ════════════════════════════════════════════════════════════════════════════
-- Rodar DEPOIS da MIGRATION_sema2025_marketing_US.sql. VOLTA: ROLLBACK_sema2025_marketing_BR.sql
-- A 085.N nova nasce como o motor a criaria (lib/crossing.server.ts · criar_invoice): cliente «GZ28 V8 SpeedShop USA LLC»,
-- mirror_key US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06, REALTIME, sem FL tax, usd_rate 5.5309 (bid de 09/11/2025 + 0,20), próximo número da série.
-- Sai das 085.N das seasons: 085.16, 085.18, 085.19, 085.45, 085.48, 085.50.
begin;
set local lock_timeout = '5s';

create temp table move_sema (tabela text not null, id uuid primary key, invoice_antes uuid not null, src_antes text not null, src_novo text not null) on commit drop;
insert into move_sema values
    ('invoice_expenses', '73e2deef-5ddc-4a4b-a41c-50f64f79d4cc'::uuid, '8eabc716-107a-45f9-ac50-1b957a6f4d21'::uuid, 'US:staff_expenses:1d704922-ba39-4c5f-96ec-56e9386d92b2', 'US:fixed_cost_expenses:76be3f23-af76-47a4-b1a7-6be187b2aa00'),
    ('invoice_parts', 'a9290890-37dc-4980-961c-6af9cf00da6f'::uuid, '8eabc716-107a-45f9-ac50-1b957a6f4d21'::uuid, 'US:staff_expenses:1d704922-ba39-4c5f-96ec-56e9386d92b2', 'US:fixed_cost_expenses:76be3f23-af76-47a4-b1a7-6be187b2aa00'),
    ('invoice_expenses', 'bf22d41b-8f35-4d23-b1d9-98224169f81b'::uuid, '8eabc716-107a-45f9-ac50-1b957a6f4d21'::uuid, 'US:staff_expenses:a9f50964-c0f1-4eed-b512-a037db7c844c', 'US:fixed_cost_expenses:b6701263-98ff-4248-8bfd-5cca8c4ac363'),
    ('invoice_parts', '8b30df78-2a64-4af5-a06c-574821594531'::uuid, '8eabc716-107a-45f9-ac50-1b957a6f4d21'::uuid, 'US:staff_expenses:a9f50964-c0f1-4eed-b512-a037db7c844c', 'US:fixed_cost_expenses:b6701263-98ff-4248-8bfd-5cca8c4ac363'),
    ('invoice_expenses', 'ebd5ab1d-6aa5-4580-9eda-05ff9cec46f3'::uuid, 'a4ad7407-8e7a-401e-ad48-dbc421067fd3'::uuid, 'US:staff_expenses:748db619-46d6-4ed8-b149-d79c8a14d424', 'US:fixed_cost_expenses:f7cc8b25-f137-48a0-ba29-56891e86d102'),
    ('invoice_parts', 'aa64e1b6-6360-4398-91aa-53b04d2233fe'::uuid, 'a4ad7407-8e7a-401e-ad48-dbc421067fd3'::uuid, 'US:staff_expenses:748db619-46d6-4ed8-b149-d79c8a14d424', 'US:fixed_cost_expenses:f7cc8b25-f137-48a0-ba29-56891e86d102'),
    ('invoice_expenses', '4857b1b3-d238-42c2-b019-9a4bd089773b'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:ba17956f-cb2f-4d4a-bc65-0eb7d7cfa717', 'US:fixed_cost_expenses:b0dfac6c-7992-4c63-8e65-11bdf6473a54'),
    ('invoice_parts', 'ae6ca863-630c-4ef0-bd4d-8355ce73d1f3'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:ba17956f-cb2f-4d4a-bc65-0eb7d7cfa717', 'US:fixed_cost_expenses:b0dfac6c-7992-4c63-8e65-11bdf6473a54'),
    ('invoice_expenses', 'a3e37a3c-e98e-48ca-9dda-0e051f35a46f'::uuid, '3be1d322-c949-4100-b7c6-63329a6401a5'::uuid, 'US:staff_expenses:5f274224-69cc-479c-ae88-ee296baf2009', 'US:fixed_cost_expenses:43a7296f-f8f5-4926-80e4-446ada52d1c0'),
    ('invoice_parts', '25297cb1-38a8-4d7f-8869-40c31aafa26f'::uuid, '3be1d322-c949-4100-b7c6-63329a6401a5'::uuid, 'US:staff_expenses:5f274224-69cc-479c-ae88-ee296baf2009', 'US:fixed_cost_expenses:43a7296f-f8f5-4926-80e4-446ada52d1c0'),
    ('invoice_expenses', 'f8d216dc-9df7-4acc-b996-1e61585b5bf4'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:401df2b4-4c0d-468a-85f2-a520aa466f43', 'US:fixed_cost_expenses:f42b142a-69ff-4ac7-882f-600224bb4206'),
    ('invoice_parts', '5cb7e6e5-8444-4268-89fd-991585564175'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:401df2b4-4c0d-468a-85f2-a520aa466f43', 'US:fixed_cost_expenses:f42b142a-69ff-4ac7-882f-600224bb4206'),
    ('invoice_expenses', 'c0361718-dd23-497d-b62e-666c9d68f7cf'::uuid, 'a4ad7407-8e7a-401e-ad48-dbc421067fd3'::uuid, 'US:staff_expenses:c30109e3-c100-4ad1-876f-9b18d31c761c', 'US:fixed_cost_expenses:7b6e2b3c-7575-4f1a-8f0c-37fe1d8fbcfb'),
    ('invoice_parts', '06e28871-e851-4184-8b43-a9373cdd312a'::uuid, 'a4ad7407-8e7a-401e-ad48-dbc421067fd3'::uuid, 'US:staff_expenses:c30109e3-c100-4ad1-876f-9b18d31c761c', 'US:fixed_cost_expenses:7b6e2b3c-7575-4f1a-8f0c-37fe1d8fbcfb'),
    ('invoice_expenses', '68155966-4cec-4893-b2b0-70778ccfbaec'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:0012cc9f-ac0f-4a2b-ab56-7ce8b8328c8d', 'US:fixed_cost_expenses:2298de31-e509-4ee6-b241-f90f62e18dc0'),
    ('invoice_parts', 'cfed147f-bf05-4433-8644-c8afbbf1b7e4'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:0012cc9f-ac0f-4a2b-ab56-7ce8b8328c8d', 'US:fixed_cost_expenses:2298de31-e509-4ee6-b241-f90f62e18dc0'),
    ('invoice_expenses', '5489ca5d-60a5-47c1-a6e9-9ef5aa6b867c'::uuid, '3be1d322-c949-4100-b7c6-63329a6401a5'::uuid, 'US:staff_expenses:706ea1c6-2a7c-467a-99eb-0987c2097395', 'US:fixed_cost_expenses:9e01f2b8-5b2c-4c60-9bec-7bb48fd821a4'),
    ('invoice_parts', '16f0a17d-a721-4df4-8c6d-ad4ac7f5ed32'::uuid, '3be1d322-c949-4100-b7c6-63329a6401a5'::uuid, 'US:staff_expenses:706ea1c6-2a7c-467a-99eb-0987c2097395', 'US:fixed_cost_expenses:9e01f2b8-5b2c-4c60-9bec-7bb48fd821a4'),
    ('invoice_expenses', '78c86520-c9a9-4057-8f34-a518a4a5867e'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:fb4dff1f-d498-4b6f-9f19-7ca2b40ce783', 'US:fixed_cost_expenses:7d24fe6c-ec32-4cae-90f0-95f5e85188d1'),
    ('invoice_parts', '5b405eb7-6d5e-46c9-902b-de5dc144fe64'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:fb4dff1f-d498-4b6f-9f19-7ca2b40ce783', 'US:fixed_cost_expenses:7d24fe6c-ec32-4cae-90f0-95f5e85188d1'),
    ('invoice_expenses', '01701a42-7f7a-4fce-94ed-32974fa4d627'::uuid, '74fd866d-312f-4377-9582-bbdef4acb6c2'::uuid, 'US:staff_expenses:2e5ace84-df6e-4ef8-80e2-db6bd97d9bbf', 'US:fixed_cost_expenses:e2e148a0-983b-46f5-92f5-2964c11e09dc'),
    ('invoice_parts', '7b12cb0a-fda1-42ef-b9ed-2906408efce7'::uuid, '74fd866d-312f-4377-9582-bbdef4acb6c2'::uuid, 'US:staff_expenses:2e5ace84-df6e-4ef8-80e2-db6bd97d9bbf', 'US:fixed_cost_expenses:e2e148a0-983b-46f5-92f5-2964c11e09dc'),
    ('invoice_expenses', '4f590564-bc78-40ad-8a1d-86b50fc36620'::uuid, '74fd866d-312f-4377-9582-bbdef4acb6c2'::uuid, 'US:staff_expenses:d1ea663b-d788-4857-9a1a-df75caa89f85', 'US:fixed_cost_expenses:4a976512-3df3-4777-8205-765cff7b0924'),
    ('invoice_parts', 'c2772139-0d4e-4c5b-96dc-9f0c4c9a00b7'::uuid, '74fd866d-312f-4377-9582-bbdef4acb6c2'::uuid, 'US:staff_expenses:d1ea663b-d788-4857-9a1a-df75caa89f85', 'US:fixed_cost_expenses:4a976512-3df3-4777-8205-765cff7b0924'),
    ('invoice_expenses', 'e21b2bb0-3dee-4083-af0f-7d14c31e121d'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:1bddba69-70d1-438a-b166-fc111f6d2dc8', 'US:fixed_cost_expenses:07d501ed-3a18-4ce1-bc78-0ce9c95b06cc'),
    ('invoice_parts', 'b01675d3-718d-4069-bdec-33b62864a80c'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:1bddba69-70d1-438a-b166-fc111f6d2dc8', 'US:fixed_cost_expenses:07d501ed-3a18-4ce1-bc78-0ce9c95b06cc'),
    ('invoice_expenses', '01fd9ad5-abb9-489a-9f51-614ac3d694dc'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:dc6b4205-ad72-4860-9244-70d7c596b48a', 'US:fixed_cost_expenses:ee12481f-30bd-483f-8deb-17353c3f3332'),
    ('invoice_parts', 'a413573b-545e-46fe-ab58-8607f793cd5b'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:dc6b4205-ad72-4860-9244-70d7c596b48a', 'US:fixed_cost_expenses:ee12481f-30bd-483f-8deb-17353c3f3332'),
    ('invoice_expenses', '2722e0dc-782c-44f3-8ca8-d76e05fde152'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:8d1f16e4-0557-4bcc-b337-37efeb9b0dbd', 'US:fixed_cost_expenses:212d5466-8dab-4479-9e41-283bc8116194'),
    ('invoice_parts', '6fa952ce-62a0-4080-8fa2-be290d43feb5'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:8d1f16e4-0557-4bcc-b337-37efeb9b0dbd', 'US:fixed_cost_expenses:212d5466-8dab-4479-9e41-283bc8116194'),
    ('invoice_expenses', '49433b37-e1b3-4ca1-940a-dd083e643252'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:aba5e64c-786e-4760-bdd9-99efb968c3cb', 'US:fixed_cost_expenses:829dfb50-2268-46c3-be3a-f6b5e5b60fe5'),
    ('invoice_parts', 'ca8cfebe-68a3-4362-a5a3-75d4d91b58b4'::uuid, '2a6e2d5a-d262-4263-818b-0c5550eaa0ae'::uuid, 'US:staff_expenses:aba5e64c-786e-4760-bdd9-99efb968c3cb', 'US:fixed_cost_expenses:829dfb50-2268-46c3-be3a-f6b5e5b60fe5'),
    ('invoice_expenses', 'd4677213-5b2c-45cf-9c60-6bdb945a31ba'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:f80dc922-46f1-4d4f-a1e3-b4c31b8a6f8d', 'US:fixed_cost_expenses:3f5b1954-f8d0-4ec9-b43e-d2a35eaad463'),
    ('invoice_parts', '005716a1-e754-4d62-aa55-8dc9501e9abf'::uuid, '67819663-47bf-4c3d-bcb7-3b62941f3085'::uuid, 'US:staff_expenses:f80dc922-46f1-4d4f-a1e3-b4c31b8a6f8d', 'US:fixed_cost_expenses:3f5b1954-f8d0-4ec9-b43e-d2a35eaad463');

do $$ declare n int; begin
  select count(*) into n from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  if n <> 0 then raise exception 'a 085.N do marketing já existe (%)', n; end if;
  select count(*) into n from public.invoice_expenses e join move_sema m on m.id = e.id and m.tabela = 'invoice_expenses'
   where e.invoice_id = m.invoice_antes and e.mirror_src = m.src_antes;
  if n <> 17 then raise exception 'esperava 17 despesas espelho no lugar, achei %', n; end if;
  select count(*) into n from public.invoice_parts p join move_sema m on m.id = p.id and m.tabela = 'invoice_parts'
   where p.invoice_id = m.invoice_antes and p.mirror_src = m.src_antes;
  if n <> 17 then raise exception 'esperava 17 itens espelho no lugar, achei %', n; end if;
end $$;

-- 1) a 085.N do marketing
with prox as (
  select '085.' || (coalesce(max((substring(invoice_code from '^085\.(\d+)$'))::int), 0) + 1) as codigo
    from public.invoices where client_id = '6d4264bc-9357-4190-94d8-bdc3a254d5bd'
), nova as (
  insert into public.invoices (client_id, ride_id, is_quote, live_status, feed_status, global_discount, service, florida_taxes, import_margin, usd_rate, mirror_key, invoice_code)
  select '6d4264bc-9357-4190-94d8-bdc3a254d5bd', null, false, 'REALTIME', 'REAL_TIME', null, 'GZ28US Marketing — SEMA Show 2025 — Las Vegas (30/10–09/11/2025): viagem e estadia do time', 0, 0, 5.5309, 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06', codigo from prox
  returning id, invoice_code
)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'sema2025-marketing', 'invoices', id::text, '(invoice criada)', null, invoice_code, 'SEMA 2025 → Marketing: 085.N do fornecedor 1414abb3-37f3-4843-8267-2ab0d61f1c06 — Márcio 16/09' from nova;

-- 2) trilha e mudança dos espelhos (invoice e mirror_src); a posição é renumerada na 085.N nova por data e nome
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'sema2025-marketing', m.tabela, m.id::text, 'invoice_id+mirror_src', m.invoice_antes || '|' || m.src_antes || '|' || coalesce(x.position::text, ''), m.src_novo,
       'SEMA 2025 → Marketing: espelho mudou da 085.N da season para a 085.N do marketing — Márcio 16/09'
  from move_sema m
  left join (select id, position from public.invoice_expenses union all select id, position from public.invoice_parts) x on x.id = m.id;

update public.invoice_expenses e
   set invoice_id = (select id from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'), mirror_src = m.src_novo
  from move_sema m where m.tabela = 'invoice_expenses' and e.id = m.id;
update public.invoice_parts p
   set invoice_id = (select id from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'), mirror_src = m.src_novo
  from move_sema m where m.tabela = 'invoice_parts' and p.id = m.id;

with alvo as (select id from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'),
ord as (select e.id, row_number() over (order by e.payment_date, e.item, e.id) as pos from public.invoice_expenses e, alvo where e.invoice_id = alvo.id)
update public.invoice_expenses e set position = ord.pos from ord where e.id = ord.id;
with alvo as (select id from public.invoices where mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06'),
ord as (select p.id, row_number() over (order by p.payment_date, p.description, p.id) as pos from public.invoice_parts p, alvo where p.invoice_id = alvo.id)
update public.invoice_parts p set position = ord.pos from ord where p.id = ord.id;

do $$ declare a int; b int; begin
  select count(*) into a from public.invoice_expenses e join public.invoices i on i.id = e.invoice_id where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  select count(*) into b from public.invoice_parts p join public.invoices i on i.id = p.invoice_id where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06';
  if a <> 17 or b <> 17 then raise exception 'conferência final: % despesas e % itens na 085.N do marketing (esperado 17 e 17)', a, b; end if;
end $$;
commit;

select i.invoice_code, count(e.*) as despesas, sum(e.price * coalesce(e.quantity, 1)) as brl, sum(e.amount_usd * coalesce(e.quantity, 1)) as usd
  from public.invoices i join public.invoice_expenses e on e.invoice_id = i.id
 where i.mirror_key = 'US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06' group by 1;
