-- ONDA 9 DO PACOTE PAID FROM/TO — A REGRA DOS CAMPOS NO BANCO.
-- Decisões do Márcio registradas em memory/paid-from-to-por-tabela.md. Escrita em 12/set/2026.
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- O QUE MUDA
--   1. invoice_items.paid_from SAI. "Items não tem porque, é só uma referência de markup" — e o
--      CLIENT, único motivo da coluna, saiu do app US em 11/set. A GERADA base_tributavel
--      dependia dela e é recriada ANTES, sem a perna do CLIENT.
--   2. invoice_incomes.paid_from SAI (item 8: "renda não tem PAID FROM, quem paga é o cliente").
--      Os valores ficam guardados em data_fixes; nome de gente vai pro texto da linha antes.
--   3. O seguro do Jeferson (staff_expenses c4e88edb) passa a PAID TO GZ28US — a regra
--      aplicada, e ela MOVE US$ 89,09 na conta corrente entre as empresas. Rótulo próprio.
--   4. Nenhum CHECK. "Qualquer empresa pode pagar pra qualquer empresa, o importante é o Flow
--      reportar": cadeado de domínio no banco fecharia essa porta para sempre.
--
-- O QUE NÃO MUDA, DE PROPÓSITO
--   · PAID TO vazio FICA VAZIO nas quatro tabelas de despesa (medido: invoice_expenses 1.133,
--     assets 30, assets_expenses 9, staff_expenses 56). Preencher agora apagaria a diferença
--     entre "é GZ28US" e "ninguém olhou" — e a conta corrente já lê vazio como conta do US.
--     Só linha NOVA nasce preenchida (é trabalho das telas, onda 10).
--   · Vocabulário do PAID TO nas quatro: medido ZERO valor fora de GZ28US/GZ28BR. Não há o
--     que normalizar além do seguro do Jeferson — a trava abaixo para tudo se isso mudar.
--   · As 5 linhas de TAXA sem data (3× Food US$ 20, Labor US$ 100, Monthly US$ 2.250) não
--     entram aqui: viram pergunta no Data Checker.
--   · A coluna GERADA `total` (unit_price * quantity) não é tocada.
--   · mirror_expense_id (items e incomes) fica: não é desta onda.
--
-- ⚠ ORDEM DE SUBIDA: SÓ RODE DEPOIS DO DEPLOY DO CÓDIGO DA ONDA 9 NO US. Antes dele, o app no ar
--   ainda pede a coluna em dois lugares, e os dois quebram a partir do commit:
--     · lib/closeScore.server.ts — select explícito de invoice_incomes.paid_from (o placar do
--       fechamento do Data Checker passaria a dar erro);
--     · app/rides/[id]/invoices/new/page.tsx — a DUPLICATA de invoice copiava paid_from das
--       rendas num insert em LISTA; o postgrest-js monta `?columns=` com a chave mesmo vazia e o
--       PostgREST recusaria a duplicata inteira.
--   O BR (lib/usShoppingMirror.ts) e a LOJA (gz28shop-us, lib/opsWrite.ts) escrevem items e
--   incomes no banco do US e NENHUM dos dois manda paid_from (conferido no código em 12/set).
--
-- ⚠ AS PONTES. As views-ponte invoice_parts e invoice_payments foram criadas com `select *`, e o
--   Postgres grava a lista de colunas na hora de criar: a ponte DEPENDE de paid_from e de
--   base_tributavel (pg_depend, deptype 'n', medido). Com ela de pé, o DROP COLUMN sem cascade é
--   RECUSADO — e com cascade a ponte sumiria calada, junto com a GERADA. Aqui: as duas pontes
--   caem, as colunas mudam, as pontes voltam com o mesmo `select *` (agora sem paid_from),
--   security_invoker, sem anon — tudo na mesma transação, ninguém vê o meio.
--
-- ⚠ NUNCA `drop column ... cascade`. Levaria junto, sem perguntar, a GERADA base_tributavel e as
--   duas pontes. Medido no código em 12/set: o único leitor de base_tributavel é lib/financials.ts,
--   que pede a coluna pelo nome e ESTOURA sem ela (fetchAll lança o erro) — Balanço, DFC, DRE e
--   o Data Checker (os quatro chamam loadFinancials) fora do ar; e qualquer leitura futura por
--   `select *` que somasse `base_tributavel` veria undefined = zero, calada.
--
-- MEDIDO ANTES (REST com a chave de serviço + catálogo, 12/09/2026 entre 16:24 e 16:48 Orlando)
--   · Postgres 17.6.
--   · invoice_items: 804 linhas · paid_from NULO em 804 · base_tributavel = unit_price × quantity
--     em 804 de 804 · SOMA base_tributavel = 2134693.0300 (exata, numeric; a REST em texto deu o
--     mesmo número) · soma de `total` = 2134693.04 (total é numeric(10,2) e arredonda por linha;
--     base_tributavel é numeric sem escala — por isso a nova nasce `numeric`, e não (10,2): senão
--     2 linhas com mais de 2 casas mudariam a soma).
--   · base_tributavel = CASE WHEN upper(COALESCE(paid_from,'')) = 'CLIENT' THEN 0 ELSE
--     COALESCE(unit_price,0) * COALESCE(quantity,1) END, STORED, tipo numeric, posição 16.
--   · Índice invoice_parts_paid_from_idx em invoice_items(paid_from) — cai sozinho com a coluna
--     (dependência automática); o ROLLBACK recria.
--   · Nenhuma função, trigger, política ou publicação cita paid_from/base_tributavel dessas duas
--     tabelas. As políticas são `true / true`. Só as duas pontes e o índice dependem das colunas.
--   · invoice_incomes: 220 linhas · paid_from: 22 'GZ28US' · 1 'MARTEZ TOMMIE' · 197 NULO.
--     A linha do Martez (82a4c0be, US$ 1.000) já traz o nome na descrição: «Zelle from MARTEZ
--     TOMMIE — conf 5845980617 (Regions •9336)». Nada a anexar hoje; o passo fica escrito para
--     qualquer nome que apareça até rodar.
--   · staff_expenses c4e88edb: US$ 89,09, paid_from GZ28BR, paid_to GZ28BR — a ÚNICA com
--     paid_to GZ28BR nas quatro tabelas de despesa.
--
-- VOLTA: ROLLBACK_pacote_onda9_regra_dos_campos.sql (lê a trilha desta onda em data_fixes).
-- ⚠ O ROLLBACK da onda 1 apaga TODA a trilha 'pacote-paid-from-to' — inclusive a desta onda.
--   Se um dia as duas precisarem voltar, volte a 9 PRIMEIRO.

begin;

-- Se alguma leitura longa segurar a tabela, desiste em 5 s em vez de enfileirar o app inteiro atrás.
set local lock_timeout = '5s';

-- Ninguém escreve item nem renda entre a foto de antes e a conferência de depois.
lock table public.invoice_items, public.invoice_incomes in access exclusive mode;

-- ── TRAVAS: o banco tem de estar como foi medido. Se mudou, MEÇA DE NOVO e troque o número;
--    não afrouxe a trava. ─────────────────────────────────────────────────────────────────────
do $$
declare n int; s numeric; expr text;
begin
  -- estrutura: ainda não rodou
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('invoice_items', 'invoice_incomes') and column_name = 'paid_from';
  if n <> 2 then raise exception 'esperava paid_from em invoice_items E invoice_incomes, achei % — esta migration já rodou?', n; end if;

  select pg_get_expr(d.adbin, d.adrelid) into expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel' and a.attgenerated = 's';
  if expr is null or expr !~* 'client' then raise exception 'base_tributavel não é a GERADA medida (com a perna do CLIENT): %', coalesce(expr, '(não achei a gerada)'); end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v' and c.relname in ('invoice_parts', 'invoice_payments');
  if n <> 2 then raise exception 'esperava as duas pontes (invoice_parts, invoice_payments) como VIEW, achei %', n; end if;

  -- invoice_items
  select count(*) into n from invoice_items;
  if n <> 804 then raise exception 'invoice_items: esperava 804 linhas, achei % — meça de novo (soma e contagem) e atualize as travas', n; end if;
  select count(*) into n from invoice_items where paid_from is not null;
  if n <> 0 then raise exception 'invoice_items: % linha(s) com paid_from preenchido — a coluna só sai vazia', n; end if;
  select count(*) into n from invoice_items where base_tributavel is distinct from coalesce(unit_price, 0) * coalesce(quantity, 1);
  if n <> 0 then raise exception 'invoice_items: % linha(s) com base_tributavel diferente de unit_price × quantity — alguma linha é do CLIENT?', n; end if;
  select coalesce(sum(base_tributavel), 0) into s from invoice_items;
  if s <> 2134693.03 then raise exception 'invoice_items: soma de base_tributavel esperada 2134693.03, achei %', s; end if;

  -- invoice_incomes
  select count(*) into n from invoice_incomes;
  if n <> 220 then raise exception 'invoice_incomes: esperava 220 linhas, achei %', n; end if;
  select count(*) into n from invoice_incomes where paid_from = 'GZ28US';
  if n <> 22 then raise exception 'invoice_incomes: esperava 22 paid_from GZ28US, achei %', n; end if;
  select count(*) into n from invoice_incomes where paid_from = 'MARTEZ TOMMIE';
  if n <> 1 then raise exception 'invoice_incomes: esperava 1 paid_from MARTEZ TOMMIE, achei %', n; end if;
  select count(*) into n from invoice_incomes where paid_from is null;
  if n <> 197 then raise exception 'invoice_incomes: esperava 197 paid_from NULO, achei % (vazio '''' conta como preenchido)', n; end if;

  -- o seguro do Jeferson, exatamente como medido
  select count(*) into n from staff_expenses
   where id = 'c4e88edb-f69b-43b5-b25a-71e6bca62e93' and paid_to = 'GZ28BR' and paid_from = 'GZ28BR' and amount = 89.09;
  if n <> 1 then raise exception 'seguro do Jeferson (c4e88edb): esperava US$ 89,09 com paid_from e paid_to GZ28BR, achei % linha(s)', n; end if;

  -- PAID TO das quatro tabelas de despesa: só a casa, e só UM GZ28BR (o do Jeferson)
  select count(*) into n from (
    select paid_to from invoice_expenses union all select paid_to from assets
    union all select paid_to from assets_expenses union all select paid_to from staff_expenses) t
   where paid_to is not null and paid_to not in ('GZ28US', 'GZ28BR');
  if n <> 0 then raise exception 'PAID TO fora de GZ28US/GZ28BR em % linha(s) de despesa — normalizar pede olhar o nome antes (regra de 07/set), não entra às cegas aqui', n; end if;
  select count(*) into n from (
    select paid_to from invoice_expenses union all select paid_to from assets
    union all select paid_to from assets_expenses union all select paid_to from staff_expenses) t
   where paid_to = 'GZ28BR';
  if n <> 1 then raise exception 'PAID TO GZ28BR nas despesas: esperava só o seguro do Jeferson (1), achei % — cada uma move dinheiro e pede rótulo próprio', n; end if;
end $$;

-- ── A FOTO DE ANTES, linha a linha (some sozinha no commit) ─────────────────────────────────
create temp table onda9_itens_antes on commit drop as
  select id, base_tributavel, total from public.invoice_items;
create temp table onda9_rendas_antes on commit drop as
  select id, amount, paid_to, paid_at, paid_from from public.invoice_incomes;

-- ── TRILHA 1 · a expressão da GERADA, como estava (o depois é gravado lá embaixo, do catálogo) ──
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'invoice_items', '(coluna gerada)', 'base_tributavel',
       pg_get_expr(d.adbin, d.adrelid), null,
       'onda 9 · item 1 do pacote: a GERADA base_tributavel perde a perna do CLIENT (o CLIENT saiu do app US em 11/set e paid_from estava vazio nos 804 itens). Recriada ANTES do drop de invoice_items.paid_from, nunca por CASCADE; valor idêntico em 804 de 804 linhas, soma 2134693.03'
  from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
 where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel';

-- ── TRILHA 2 · o PAID FROM de cada renda que tinha um, antes de a coluna cair ────────────────
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'invoice_incomes', i.id::text, 'paid_from', i.paid_from, null,
       case when upper(btrim(i.paid_from)) in ('GZ28US', 'GZ28BR')
            then 'onda 9 · item 8 do pacote: PAID FROM da renda sai com a coluna (renda não tem PAID FROM, quem paga é o cliente). Guardado para a volta; não move dinheiro — Balanço, DFC e GZ-FLOW leem só o paid_to da renda'
            when position(upper(btrim(i.paid_from)) in upper(coalesce(i.description, '') || ' ' || coalesce(i.source, ''))) > 0
            then 'onda 9 · item 8 do pacote: PAID FROM da renda sai com a coluna. NOME DE GENTE («' || btrim(i.paid_from) || '»): já está no texto da linha, nada a anexar'
            else 'onda 9 · item 8 do pacote: PAID FROM da renda sai com a coluna. NOME DE GENTE («' || btrim(i.paid_from) || '»): era o único lugar do nome — anexado à descrição como « · pago por …», o formato do conserto de 07/set'
       end
  from public.invoice_incomes i
 where i.paid_from is not null;

-- ── NOME DE GENTE VAI PRO TEXTO DA LINHA ─────────────────────────────────────────────────────
-- O mesmo cuidado de 07/set/2026 com os 12 nomes que só moravam no paid_to ("· pago a X" no fim
-- da descrição, só quando o nome não aparecia em outro campo da linha). Aqui o nome é de quem
-- MANDOU o dinheiro, então o verbo vira "pago por". Medido hoje: zero linhas — o do Martez já
-- está na descrição. A trilha é gravada primeiro e o UPDATE aplica exatamente o que ela diz.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'invoice_incomes', i.id::text, 'description', i.description,
       case when coalesce(btrim(i.description), '') = '' then 'pago por ' || btrim(i.paid_from)
            else i.description || ' · pago por ' || btrim(i.paid_from) end,
       'onda 9 · item 8 do pacote: o nome que só existia no PAID FROM da renda (' || btrim(i.paid_from) || ') vai pra descrição antes de a coluna cair'
  from public.invoice_incomes i
 where i.paid_from is not null and btrim(i.paid_from) <> ''
   and upper(btrim(i.paid_from)) not in ('GZ28US', 'GZ28BR')
   and position(upper(btrim(i.paid_from)) in upper(coalesce(i.description, '') || ' ' || coalesce(i.source, ''))) = 0;

update public.invoice_incomes i set description = f.new_value, updated_at = now()
  from data_fixes f
 where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
   and f.table_name = 'invoice_incomes' and f.field = 'description' and f.row_id = i.id::text;

-- ── 1. AS PONTES CAEM (voltam no passo 5, nesta mesma transação) ─────────────────────────────
-- Sem `if exists` e sem cascade: a trava garantiu que existem, e nada depende delas (medido).
drop view public.invoice_parts;
drop view public.invoice_payments;

-- ── 2. A GERADA SEM A PERNA DO CLIENT — ANTES do drop de paid_from ───────────────────────────
-- Tipo `numeric` sem escala, igual ao de hoje. A nova vai pro fim da lista de colunas; o app lê
-- pelo nome (PostgREST), a ordem não muda nada.
alter table public.invoice_items drop column base_tributavel;
alter table public.invoice_items add column base_tributavel numeric
  generated always as (coalesce(unit_price, 0) * coalesce(quantity, 1)) stored;

-- ── 3. OS DOIS paid_from SAEM — sem cascade: se sobrou dependente, o Postgres recusa e tudo volta
alter table public.invoice_items drop column paid_from;
alter table public.invoice_incomes drop column paid_from;

-- ── 4. A REGRA NAS DESPESAS: PAID TO é sempre GZ28US — e isto MOVE DINHEIRO ──────────────────
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'staff_expenses', e.id::text, 'paid_to', e.paid_to, 'GZ28US',
       'onda 9 · REGRA, NÃO CONSERTO — ESTA LINHA MOVE US$ 89,09 NA CONTA CORRENTE ENTRE AS EMPRESAS. Seguro viagem Universal Assistance do Jeferson Ferreira (Seguros Promo pedido 1186818, R$ 459,88 via PIX), pago pelo GZ28BR. Com paid_to GZ28BR a linha era «interna do BR» (o BR pagou conta do BR) e ficava FORA da conta corrente. A regra do pacote diz que o PAID TO de staff_expenses é SEMPRE GZ28US: agora ela é o GZ28BR pagando conta do GZ28US, e o GZ28US passa a DEVER US$ 89,09 a mais ao GZ28BR — o saldo que o BR deve ao US cai US$ 89,09 (Balanço, card Conta corrente GZ28BR e GZ-FLOW)'
  from public.staff_expenses e
 where e.id = 'c4e88edb-f69b-43b5-b25a-71e6bca62e93' and e.paid_to = 'GZ28BR';

update public.staff_expenses set paid_to = 'GZ28US', updated_at = now()
 where id = 'c4e88edb-f69b-43b5-b25a-71e6bca62e93' and paid_to = 'GZ28BR';

-- ── 5. AS PONTES VOLTAM — mesmo desenho da onda 2 ────────────────────────────────────────────
-- security_invoker = true é OBRIGATÓRIO (sem ele a view roda como dona e fura o RLS), e a chave
-- pública fica de fora (o default privilege do Supabase daria tudo a ela na view recém-criada).
create view public.invoice_parts    with (security_invoker = true) as select * from public.invoice_items;
create view public.invoice_payments with (security_invoker = true) as select * from public.invoice_incomes;

comment on view public.invoice_parts    is 'PONTE (11/set/2026; recriada na onda 9 do pacote, já sem paid_from): nome velho de invoice_items. Cai na onda das pontes.';
comment on view public.invoice_payments is 'PONTE (11/set/2026; recriada na onda 9 do pacote, já sem paid_from): nome velho de invoice_incomes. Cai na onda das pontes.';

revoke all on public.invoice_parts, public.invoice_payments from anon;
grant select, insert, update, delete on public.invoice_parts, public.invoice_payments to authenticated, service_role;

-- ── 6. A trilha da GERADA ganha o DEPOIS, lido do catálogo (não digitado) ───────────────────
update data_fixes f set new_value = (
  select pg_get_expr(d.adbin, d.adrelid)
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel')
 where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
   and f.table_name = 'invoice_items' and f.row_id = '(coluna gerada)' and f.field = 'base_tributavel';

-- ── 7. O PostgREST esquece paid_from (sai no commit) ────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── CONFERÊNCIA DEPOIS: se qualquer uma falhar, tudo volta atrás ─────────────────────────────
do $$
declare n int; s numeric; s0 numeric; expr text; typ text; priv text; papel name; ponte text;
begin
  -- A GERADA nova: existe, é STORED, numeric, sem CLIENT e sem paid_from
  select pg_get_expr(d.adbin, d.adrelid), format_type(a.atttypid, a.atttypmod) into expr, typ
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel' and a.attgenerated = 's';
  if expr is null then raise exception 'base_tributavel não existe mais como GERADA'; end if;
  if expr ~* 'client' or expr ~* 'paid_from' then raise exception 'a GERADA ainda cita CLIENT/paid_from: %', expr; end if;
  if typ <> 'numeric' then raise exception 'base_tributavel mudou de tipo: % (era numeric)', typ; end if;

  -- `total` intocada
  select pg_get_expr(d.adbin, d.adrelid) into expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'total' and a.attgenerated = 's';
  if expr is distinct from '(unit_price * quantity)' then raise exception 'a GERADA total mudou: %', coalesce(expr, '(sumiu)'); end if;

  -- paid_from sumiu das duas tabelas e das duas pontes
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('invoice_items', 'invoice_incomes', 'invoice_parts', 'invoice_payments') and column_name = 'paid_from';
  if n <> 0 then raise exception 'paid_from ainda aparece em % objeto(s)', n; end if;

  -- ITEMS: 804 de 804 com base = unit_price × quantity
  select count(*) into n from invoice_items where base_tributavel = coalesce(unit_price, 0) * coalesce(quantity, 1);
  if n <> 804 or n <> (select count(*) from onda9_itens_antes) then raise exception 'base_tributavel = unit_price × quantity em % linha(s), esperava 804 de 804', n; end if;
  -- linha a linha, idêntica à foto de antes (base E total)
  select count(*) into n from invoice_items i join onda9_itens_antes b on b.id = i.id
   where i.base_tributavel = b.base_tributavel and i.total is not distinct from b.total;
  if n <> 804 then raise exception 'só % de 804 itens ficaram com base_tributavel e total idênticos aos de antes', n; end if;
  -- a soma, idêntica à foto E ao número medido pela REST
  select coalesce(sum(base_tributavel), 0) into s from invoice_items;
  select coalesce(sum(base_tributavel), 0) into s0 from onda9_itens_antes;
  if s <> s0 or s <> 2134693.03 then raise exception 'soma de base_tributavel mudou: antes %, agora % (medido pela REST: 2134693.03)', s0, s; end if;

  -- RENDAS: nenhuma linha, valor, paid_to ou baixa mudou
  select count(*) into n from invoice_incomes i join onda9_rendas_antes b on b.id = i.id
   where i.amount = b.amount and i.paid_to is not distinct from b.paid_to and i.paid_at is not distinct from b.paid_at;
  if n <> 220 or n <> (select count(*) from onda9_rendas_antes) then raise exception 'rendas: só % de 220 ficaram com amount/paid_to/paid_at iguais', n; end if;

  -- a trilha do paid_from das rendas bate com a foto, valor por valor
  select count(*) into n from data_fixes f
   where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%' and f.table_name = 'invoice_incomes' and f.field = 'paid_from';
  if n <> 23 then raise exception 'trilha do paid_from das rendas: esperava 23 (22 GZ28US + 1 MARTEZ TOMMIE), achei %', n; end if;
  select count(*) into n from onda9_rendas_antes b join data_fixes f
      on f.row_id = b.id::text and f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
     and f.table_name = 'invoice_incomes' and f.field = 'paid_from' and f.old_value = b.paid_from;
  if n <> (select count(*) from onda9_rendas_antes where paid_from is not null) then raise exception 'a trilha do paid_from não bate com a foto: % de % valores', n, (select count(*) from onda9_rendas_antes where paid_from is not null); end if;
  select count(*) into n from data_fixes f
   where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%' and f.table_name = 'invoice_incomes' and f.field = 'paid_from' and f.old_value = 'GZ28US';
  if n <> 22 then raise exception 'trilha: esperava 22 GZ28US, achei %', n; end if;

  -- todo nome de gente que saiu do paid_from está no texto da linha
  select count(*) into n from data_fixes f join invoice_incomes i on i.id::text = f.row_id
   where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%' and f.table_name = 'invoice_incomes' and f.field = 'paid_from'
     and upper(btrim(f.old_value)) not in ('GZ28US', 'GZ28BR')
     and position(upper(btrim(f.old_value)) in upper(coalesce(i.description, '') || ' ' || coalesce(i.source, ''))) = 0;
  if n <> 0 then raise exception '% nome(s) de gente sumiram com a coluna sem ir pro texto da linha', n; end if;
  select count(*) into n from invoice_incomes where id = '82a4c0be-4aae-428c-a330-35d5f03f5962' and description ilike '%MARTEZ TOMMIE%';
  if n <> 1 then raise exception 'a renda do Martez (82a4c0be) perdeu o nome na descrição'; end if;

  -- o seguro do Jeferson: GZ28US, com o rótulo próprio na trilha, e nenhum GZ28BR sobrando no PAID TO das despesas
  select count(*) into n from staff_expenses
   where id = 'c4e88edb-f69b-43b5-b25a-71e6bca62e93' and paid_to = 'GZ28US' and paid_from = 'GZ28BR' and amount = 89.09;
  if n <> 1 then raise exception 'o seguro do Jeferson não ficou paid_from GZ28BR → paid_to GZ28US (US$ 89,09)'; end if;
  select count(*) into n from data_fixes
   where check_key = 'pacote-paid-from-to' and label like 'onda 9 · REGRA, NÃO CONSERTO — ESTA LINHA MOVE US$ 89,09%'
     and table_name = 'staff_expenses' and row_id = 'c4e88edb-f69b-43b5-b25a-71e6bca62e93' and field = 'paid_to' and old_value = 'GZ28BR' and new_value = 'GZ28US';
  if n <> 1 then raise exception 'falta o rótulo próprio do seguro do Jeferson na trilha (achei %)', n; end if;
  select count(*) into n from (
    select paid_to from invoice_expenses union all select paid_to from assets
    union all select paid_to from assets_expenses union all select paid_to from staff_expenses) t
   where paid_to = 'GZ28BR';
  if n <> 0 then raise exception 'ainda há % PAID TO GZ28BR nas despesas', n; end if;

  -- a trilha da GERADA tem o antes (com CLIENT) e o depois (sem)
  select count(*) into n from data_fixes
   where check_key = 'pacote-paid-from-to' and label like 'onda 9 ·%' and table_name = 'invoice_items' and row_id = '(coluna gerada)'
     and old_value ~* 'client' and new_value is not null and new_value !~* 'client';
  if n <> 1 then raise exception 'a trilha da GERADA não tem antes e depois (achei %)', n; end if;

  -- AS PONTES: existem, são view, security_invoker, enxergam o mesmo que a tabela
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v' and c.relname in ('invoice_parts', 'invoice_payments')
     and 'security_invoker=true' = any(coalesce(c.reloptions, '{}'));
  if n <> 2 then raise exception 'as duas pontes não voltaram como VIEW com security_invoker=true (achei %)', n; end if;
  if (select count(*) from invoice_items)   <> (select count(*) from invoice_parts)    then raise exception 'invoice_items x ponte invoice_parts: contagem diferente'; end if;
  if (select count(*) from invoice_incomes) <> (select count(*) from invoice_payments) then raise exception 'invoice_incomes x ponte invoice_payments: contagem diferente'; end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_parts' and column_name = 'base_tributavel';
  if n <> 1 then raise exception 'a ponte invoice_parts não enxerga base_tributavel'; end if;

  -- a chave pública NÃO entra pela ponte; tela logada e servidor entram
  foreach ponte in array array['public.invoice_parts', 'public.invoice_payments'] loop
    if has_table_privilege('anon', ponte, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'a ponte % ficou aberta pra anon', ponte;
    end if;
    foreach papel in array array['authenticated', 'service_role']::name[] loop
      foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if not has_table_privilege(papel, ponte, priv) then
          raise exception 'a ponte % ficou sem % para %', ponte, priv, papel;
        end if;
      end loop;
    end loop;
  end loop;

  -- RLS das tabelas-base continua ligado
  select count(*) into n from pg_class where oid in ('public.invoice_items'::regclass, 'public.invoice_incomes'::regclass) and relrowsecurity;
  if n <> 2 then raise exception 'o RLS de invoice_items/invoice_incomes não está ligado nas duas'; end if;
end $$;

commit;
