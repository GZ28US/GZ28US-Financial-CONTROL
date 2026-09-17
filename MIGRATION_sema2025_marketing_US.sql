-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_sema2025_marketing_US.sql — SEMA 2025 sai das seasons e vira MARKETING (US)
-- Projeto: US fvgpkbpqacnqxtrjsmpi · gerado em 16/09/2026 pela sessão App development, a pedido da sessão Auto Book (APPDEV item 13).
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
-- VOLTA: ROLLBACK_sema2025_marketing_US.sql
begin;
set local lock_timeout = '5s';

-- 1) as 7 chaves ficam travadas por ~1 h (locked_at no futuro: o motor só limpa trava com mais de 10 minutos).
--    Se alguma já estiver travada, o insert falha e NADA roda — o motor está gravando aquela chave agora.
insert into public.crossing_locks (mirror_key, holder, locked_at) values
  ('US:fixed:1414abb3-37f3-4843-8267-2ab0d61f1c06', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:77d90d9d-755b-4c4b-942d-d67b3a7c967e', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:4866cd6c-326b-4a09-b75e-3fceacca5e98', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:e27b6e24-0d29-47a0-b15d-bcd7c20d0686', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:8d907c9a-9671-4007-98b7-c4270116977e', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:20b7168d-5389-4618-97ce-99364ca6b827', 'sema2025-marketing', now() + interval '50 minutes'),
  ('US:season:296f294a-c789-4914-95d7-445e4644d440', 'sema2025-marketing', now() + interval '50 minutes');

create temp table mapa_sema (staff_id uuid primary key, fixed_id uuid not null unique, amount numeric not null) on commit drop;
insert into mapa_sema values
    ('1d704922-ba39-4c5f-96ec-56e9386d92b2'::uuid, '76be3f23-af76-47a4-b1a7-6be187b2aa00'::uuid, 699.07::numeric),
    ('a9f50964-c0f1-4eed-b512-a037db7c844c'::uuid, 'b6701263-98ff-4248-8bfd-5cca8c4ac363'::uuid, 405.13::numeric),
    ('748db619-46d6-4ed8-b149-d79c8a14d424'::uuid, 'f7cc8b25-f137-48a0-ba29-56891e86d102'::uuid, 405.13::numeric),
    ('ba17956f-cb2f-4d4a-bc65-0eb7d7cfa717'::uuid, 'b0dfac6c-7992-4c63-8e65-11bdf6473a54'::uuid, 382.5::numeric),
    ('5f274224-69cc-479c-ae88-ee296baf2009'::uuid, '43a7296f-f8f5-4926-80e4-446ada52d1c0'::uuid, 405.13::numeric),
    ('cfbe30c1-1bb5-4ea4-a4dd-3a2c1e5782ab'::uuid, '0be76c2b-8cda-429b-bbe9-b380bf5048e4'::uuid, 183.24::numeric),
    ('401df2b4-4c0d-468a-85f2-a520aa466f43'::uuid, 'f42b142a-69ff-4ac7-882f-600224bb4206'::uuid, 383.49::numeric),
    ('c30109e3-c100-4ad1-876f-9b18d31c761c'::uuid, '7b6e2b3c-7575-4f1a-8f0c-37fe1d8fbcfb'::uuid, 699.07::numeric),
    ('0012cc9f-ac0f-4a2b-ab56-7ce8b8328c8d'::uuid, '2298de31-e509-4ee6-b241-f90f62e18dc0'::uuid, 183.24::numeric),
    ('706ea1c6-2a7c-467a-99eb-0987c2097395'::uuid, '9e01f2b8-5b2c-4c60-9bec-7bb48fd821a4'::uuid, 382.5::numeric),
    ('fb4dff1f-d498-4b6f-9f19-7ca2b40ce783'::uuid, '7d24fe6c-ec32-4cae-90f0-95f5e85188d1'::uuid, -382.5::numeric),
    ('2e5ace84-df6e-4ef8-80e2-db6bd97d9bbf'::uuid, 'e2e148a0-983b-46f5-92f5-2964c11e09dc'::uuid, 665.85::numeric),
    ('d1ea663b-d788-4857-9a1a-df75caa89f85'::uuid, '4a976512-3df3-4777-8205-765cff7b0924'::uuid, 405.11::numeric),
    ('1bddba69-70d1-438a-b166-fc111f6d2dc8'::uuid, '07d501ed-3a18-4ce1-bc78-0ce9c95b06cc'::uuid, 383.49::numeric),
    ('dc6b4205-ad72-4860-9244-70d7c596b48a'::uuid, 'ee12481f-30bd-483f-8deb-17353c3f3332'::uuid, 183.24::numeric),
    ('8d1f16e4-0557-4bcc-b337-37efeb9b0dbd'::uuid, '212d5466-8dab-4479-9e41-283bc8116194'::uuid, 382.5::numeric),
    ('aba5e64c-786e-4760-bdd9-99efb968c3cb'::uuid, '829dfb50-2268-46c3-be3a-f6b5e5b60fe5'::uuid, 405.13::numeric),
    ('f80dc922-46f1-4d4f-a1e3-b4c31b8a6f8d'::uuid, '3f5b1954-f8d0-4ec9-b43e-d2a35eaad463'::uuid, 405.13::numeric);

-- 2) conferência: as 18 existem, com o valor medido, pagas e PAID FROM GZ28BR; nenhum id novo já existe; o fornecedor é MARKETING.
do $$ declare n int; begin
  select count(*) into n from public.staff_expenses s join mapa_sema m on m.staff_id = s.id
   where s.amount = m.amount and s.payment_date is not null and upper(coalesce(s.paid_from, s.source, '')) = 'GZ28BR';
  if n <> 18 then raise exception 'esperava as 18 linhas de staff conferidas, achei %', n; end if;
  select count(*) into n from public.fixed_cost_expenses f join mapa_sema m on m.fixed_id = f.id;
  if n <> 0 then raise exception 'ids novos já existem em fixed_cost_expenses (%)', n; end if;
  select count(*) into n from public.fixed_cost_suppliers where id = '1414abb3-37f3-4843-8267-2ab0d61f1c06' and cost_type = 'MARKETING';
  if n <> 1 then raise exception 'fornecedor 1414abb3-37f3-4843-8267-2ab0d61f1c06 não é MARKETING'; end if;
end $$;

-- 3) trilha com a linha INTEIRA de staff (a volta reinsere daqui)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'sema2025-marketing', 'staff_expenses', s.id::text, 'DELETE', to_jsonb(s)::text, m.fixed_id::text,
       'SEMA 2025 → Marketing: staff_expenses movida para fixed_cost_expenses ' || m.fixed_id || ' — Márcio 16/09'
  from public.staff_expenses s join mapa_sema m on m.staff_id = s.id;

-- 4) as linhas de custo fixo (quem viajou fica no season_id e na descrição; já saíram no grupo → reported_at copiado)
insert into public.fixed_cost_expenses
  (id, supplier_id, type, description, amount, amount_brl, source, paid_from, paid_to, expense_date, payment_date,
   receipt_url, payment_method, order_number, season_id, reported_at)
select m.fixed_id, '1414abb3-37f3-4843-8267-2ab0d61f1c06', 'SINGLE',
       coalesce(nullif(s.description, ''), 'SEMA 2025') || ' · ' || coalesce(st.name, '?') || ' (SEASON ' || coalesce(se.season_code, '?') || ')'
         || coalesce(' · ' || nullif(s.supplier, ''), '') || coalesce(' · pago: ' || nullif(s.payment_method, ''), '')
         || ' — movida da season em 16/09/2026',
       s.amount, s.amount_brl, 'GZ28BR', 'GZ28BR', 'GZ28US', coalesce(s.expense_date, s.payment_date), s.payment_date,
       s.receipt_url, 'CARD', s.order_number, null, coalesce(s.reported_at, now())   -- season_id NULO: a FK de fixed_cost_expenses.season_id é fixed_cost_seasons (não seasons); quem viajou e a season ficam na descrição (Auto Book, 16/09 19:52)
  from public.staff_expenses s
  join mapa_sema m on m.staff_id = s.id
  left join public.seasons se on se.id = s.season_id
  left join public.staff st on st.id = se.staff_id;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'sema2025-marketing', 'fixed_cost_expenses', m.fixed_id::text, 'INSERT', m.staff_id::text, m.amount::text,
       'SEMA 2025 → Marketing: custo fixo novo (era staff_expenses ' || m.staff_id || ') — Márcio 16/09'
  from mapa_sema m;

-- 5) sai das seasons
delete from public.staff_expenses s using mapa_sema m where s.id = m.staff_id;

do $$ declare a int; b int; begin
  select count(*) into a from public.fixed_cost_expenses where supplier_id = '1414abb3-37f3-4843-8267-2ab0d61f1c06';
  select count(*) into b from public.staff_expenses s join public.data_fixes d on d.row_id = s.id::text and d.check_key = 'sema2025-marketing' and d.field = 'DELETE';
  if a <> 18 or b <> 0 then raise exception 'conferência final: % custos fixos no fornecedor (esperado 18), % staff restantes (esperado 0)', a, b; end if;
end $$;
commit;

select count(*) as linhas, sum(amount) as usd, sum(amount_brl) as brl_gravado from public.fixed_cost_expenses where supplier_id = '1414abb3-37f3-4843-8267-2ab0d61f1c06';
