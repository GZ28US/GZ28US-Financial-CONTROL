-- ══ RESULTADO, RODADO EM 11/09/2026 21:27 ORLANDO (Management API, Chrome do Márcio) ══
--
-- 1. COLUNAS GERADAS de invoice_parts (as duas, STORED):
--    base_tributavel =
--        CASE WHEN upper(COALESCE(paid_from, '')) = 'CLIENT' THEN 0::numeric
--             ELSE COALESCE(unit_price, 0) * COALESCE(quantity, 1) END
--    total = unit_price * quantity
--    → tirar a perna do CLIENT deixa base_tributavel = COALESCE(unit_price,0)*COALESCE(quantity,1),
--      que é o valor que as 804 linhas já têm (paid_from é NULO em 804/804). Recriar a gerada
--      ANTES de dropar paid_from; NUNCA "drop column ... cascade" (levaria a gerada junto e
--      lib/financials.ts:191 passaria a somar zero, sem erro na tela).
--
-- 2. VIEWS que dependem das 5 tabelas: NENHUMA.
-- 3. FUNÇÕES que citam os nomes no corpo: NENHUMA (nem as RPCs SECURITY DEFINER do RLS fase 1).
-- 4. TRIGGERS nessas tabelas: NENHUM.
--    → o rename não deixa nada apontando pra nome que sumiu dentro do banco.
--
-- 5. CHAVES ESTRANGEIRAS (7) — todas sobrevivem ao rename (a FK aponta por OID; só o NOME da
--    constraint continua velho, o que é cosmético):
--      expense_reports_sent.expense_id -> expenses(id) ON DELETE CASCADE
--      staff_flights.expense_id        -> expenses(id)
--      expenses.bank_transaction_id    -> bank_transactions(id) ON DELETE SET NULL
--      expenses.season_id              -> seasons(id) ON DELETE CASCADE
--      good_expenses.good_id           -> goods(id) ON DELETE CASCADE
--      invoice_parts.invoice_id        -> invoices(id) ON DELETE CASCADE
--      invoice_payments.invoice_id     -> invoices(id) ON DELETE CASCADE
--
-- 6. RLS: ligado nas 5, force=false. Uma política por tabela, sempre a mesma forma:
--      <tabela>_authenticated_all · {authenticated} · ALL
--    → o RENAME leva a política junto com o nome velho dentro dela: renomear a política
--      depois (alter policy ... rename to) para o arquivo supabase/rls_phase1.sql voltar a valer.
--
-- 7. DEFAULTS que importam: expenses.origin = 'GZ28US' · goods.quantity = 1 · goods.unit_price = 0
--    · good_expenses.amount = 0 · invoice_parts.quantity = 1 · picked_up = false (goods,
--    good_expenses, expenses). Nenhum default cita nome de tabela.
--
-- ═════════════════════════════════════════════════════════════════════════════

-- PRÉ-VOO DO PACOTE PAID FROM/TO — SÓ SELECT, não muda NADA no banco.
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Por que existe: o PostgREST (o caminho que eu uso de fora) não enxerga o
-- pg_catalog, então há quatro coisas do banco que NENHUM grep e NENHUMA medição
-- pela API revelam — e as quatro podem quebrar o rename em silêncio:
--   (1) a expressão exata da coluna GERADA invoice_parts.base_tributavel, que
--       depende de paid_from: dropar a coluna sem recriar a gerada zera a base de
--       imposto de TODA invoice, sem erro na tela;
--   (2) VIEW que dependa das 6 tabelas (view não aparece em grep de código);
--   (3) FUNÇÃO ou TRIGGER que cite os nomes no corpo — inclusive as RPCs
--       SECURITY DEFINER que a página pública das duties usa;
--   (4) FK, índice e política de cada tabela, para conferir depois do rename.
--
-- Rode bloco a bloco e me mande o resultado (ou deixe o painel aberto que eu leio).

-- ── 1. A COLUNA GERADA ───────────────────────────────────────────────────────
select c.relname as tabela, a.attname as coluna,
       pg_get_expr(d.adbin, d.adrelid) as expressao,
       a.attgenerated as gerada
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public'
  and c.relname in ('invoice_parts','invoice_payments','invoice_expenses','goods','good_expenses','expenses','inputs','inventory','fixed_cost_expenses')
  and a.attgenerated <> ''
order by 1, 2;

-- ── 2. VIEWS QUE DEPENDEM DAS 6 TABELAS ──────────────────────────────────────
select distinct dependente.relname as view_name, fonte.relname as tabela_lida
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class dependente on dependente.oid = r.ev_class
join pg_class fonte on fonte.oid = d.refobjid
join pg_namespace n on n.oid = fonte.relnamespace
where n.nspname = 'public'
  and dependente.relkind in ('v','m')
  and fonte.relname in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
  and dependente.relname <> fonte.relname
order by 1, 2;

-- ── 3. FUNÇÕES E TRIGGERS QUE CITAM OS NOMES NO CORPO ────────────────────────
select p.proname as funcao, p.prosecdef as security_definer,
       (select string_agg(t, ', ') from unnest(array['invoice_parts','invoice_payments','goods','good_expenses','expenses']) t
         where p.prosrc ~* ('\m' || t || '\M')) as cita
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ~* '\m(invoice_parts|invoice_payments|goods|good_expenses|expenses)\M'
order by 1;

select c.relname as tabela, t.tgname as trigger_name, p.proname as funcao, t.tgenabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
  and c.relname in ('invoice_parts','invoice_payments','invoice_expenses','goods','good_expenses','expenses','inputs','inventory','fixed_cost_expenses')
order by 1, 2;

-- ── 4. CHAVES ESTRANGEIRAS QUE APONTAM PARA AS 5 (e as que saem delas) ───────
select con.conname, origem.relname as tabela_origem, destino.relname as tabela_destino, pg_get_constraintdef(con.oid) as definicao
from pg_constraint con
join pg_class origem on origem.oid = con.conrelid
join pg_class destino on destino.oid = con.confrelid
join pg_namespace n on n.oid = origem.relnamespace
where n.nspname = 'public' and con.contype = 'f'
  and (destino.relname in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
       or origem.relname in ('invoice_parts','invoice_payments','goods','good_expenses','expenses'))
order by 2, 1;

-- ── 5. ÍNDICES, POLÍTICAS E RLS DE CADA UMA (para conferir depois) ───────────
select tablename, indexname from pg_indexes
where schemaname = 'public' and tablename in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
order by 1, 2;

select schemaname, tablename, policyname, roles::text, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
order by 2, 3;

select c.relname as tabela, c.relrowsecurity as rls_ligado, c.relforcerowsecurity as rls_forcado
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
order by 1;

-- ── 6. SEQUÊNCIAS E DEFAULTS QUE CARREGAM O NOME DA TABELA ───────────────────
select c.relname as tabela, a.attname as coluna, pg_get_expr(d.adbin, d.adrelid) as default_expr
from pg_attrdef d
join pg_class c on c.oid = d.adrelid
join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('invoice_parts','invoice_payments','goods','good_expenses','expenses')
  and pg_get_expr(d.adbin, d.adrelid) ~* '(invoice_parts|invoice_payments|goods|good_expenses|expenses)'
order by 1, 2;
