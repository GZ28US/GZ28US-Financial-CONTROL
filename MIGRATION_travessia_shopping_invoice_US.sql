-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_travessia_shopping_invoice_US.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi          (a do BR é MIGRATION_travessia_shopping_invoice_BR.sql)
--
-- A TRAVESSIA US ⇄ BR GANHA ENDEREÇO NO BANCO. Lei sagrada de 13/set (memory/shopping-invoice-toda-
-- travessia-us-br.md): todo dinheiro que cruza as empresas vira shopping invoice no app do OUTRO.
-- O motor é lib/crossing.server.ts; ele só é idempotente se a invoice e a linha espelhadas
-- disserem, NO BANCO, de onde vieram. Hoje não dizem:
--   · a 006.N é achada pelo ponteiro do BR (us_invoice_id) ou pelo TEXTO do service — medido em
--     14/set: 006.16 só pelo texto, e três BR (US.004.1, US.005.1, US.006.2) com ponteiro morto;
--   · só 1 das 79 despesas das 006.N tem br_expense_id. Um re-save de invoice antiga no editor do
--     BR apaga e recria as despesas do US e deixa órfãos 15 ponteiros de banco (US$ 21.819,99);
--   · renda não tem elo nenhum com a renda do outro lado.
--
-- O QUE ENTRA (só ADITIVO, idempotente — rodar duas vezes não muda nada):
--   1. invoices.mirror_key text, ÚNICA. Quem é a origem desta shopping invoice:
--        'BR:invoice:<id da invoice do BR>'   → a 006.N das direções 1 + 2
--      (no BR: 'US:invoice:<id>', 'US:season:<id>', 'US:assets:AAAA-MM').
--   2. mirror_src text, ÚNICA, nas três tabelas de linha que o motor escreve no US:
--        invoice_expenses · invoice_items → 'BR:invoice_expenses:<id da linha do BR>'
--        invoice_incomes                  → 'BR:invoice_payments:<id>'  ou  'pendente:BR:invoice:<id>'
--      Uma linha de origem = uma linha espelho. É por ela que o motor acha o que já gravou.
--   3. invoice_incomes.br_payment_id uuid — o elo da renda (direção 2), irmão do br_expense_id.
--      SEM chave estrangeira, de propósito: a origem mora em OUTRO projeto Supabase.
--   4. ÚNICO (client_id, invoice_code) — a numeração 006.N lê o maior número e soma um; duas
--      gravações ao mesmo tempo dariam o mesmo código. Com o índice, a segunda ESTOURA em vez de
--      duplicar. MEDIDO em 14/set/2026 00:34 (Orlando): ZERO pares repetidos nas 145 invoices.
--      ⚠ Se algum fluxo do app criar invoice com código repetido no mesmo cliente, ele passa a
--      receber erro 23505 — que é exatamente o que se quer saber.
--
-- NULL não colide em índice único do Postgres: as milhares de linhas sem elo continuam valendo.
-- As views-ponte invoice_parts / invoice_payments (select * de antes) não enxergam as colunas
-- novas — e ninguém escreve elo por elas. Nenhum código no ar lê estas colunas antes do motor.
--
-- VOLTA: ROLLBACK_travessia_shopping_invoice_US.sql (recusa se já houver elo gravado).
-- DEPOIS DESTA: BACKFILL_shopping_invoice_elos_US.sql (os elos das despesas das 006.N).

begin;

set local lock_timeout = '5s';

-- ── TRAVA: nenhuma duplicata de (client_id, invoice_code) ─────────────────────
do $$
declare n int; exemplo text;
begin
  select count(*), min(client_id::text || ' · ' || invoice_code) into n, exemplo
    from (select client_id, invoice_code from public.invoices where client_id is not null
          group by 1, 2 having count(*) > 1) t;
  if n <> 0 then
    raise exception 'há % par(es) (client_id, invoice_code) repetidos (ex.: %) — o índice único não entra; meça e resolva antes', n, exemplo;
  end if;
end $$;

-- ── 1. invoices.mirror_key ────────────────────────────────────────────────────
alter table public.invoices add column if not exists mirror_key text;
create unique index if not exists invoices_mirror_key_uidx on public.invoices (mirror_key);
comment on column public.invoices.mirror_key is
  'TRAVESSIA US⇄BR (14/set/2026): a origem desta shopping invoice no outro app — ''BR:invoice:<id>'' na 006.N. Única. Escrita por lib/crossing.server.ts.';

-- ── 2. mirror_src nas linhas ──────────────────────────────────────────────────
alter table public.invoice_expenses add column if not exists mirror_src text;
create unique index if not exists invoice_expenses_mirror_src_uidx on public.invoice_expenses (mirror_src);
comment on column public.invoice_expenses.mirror_src is
  'TRAVESSIA US⇄BR: a linha de origem no outro app — ''BR:invoice_expenses:<id>''. Única: uma origem, um espelho.';

alter table public.invoice_items add column if not exists mirror_src text;
create unique index if not exists invoice_items_mirror_src_uidx on public.invoice_items (mirror_src);
comment on column public.invoice_items.mirror_src is
  'TRAVESSIA US⇄BR: o item cobrado ao GZ28BR pela linha ''BR:invoice_expenses:<id>'' (US$ gravado no BR, já com o +10%). Única.';

alter table public.invoice_incomes add column if not exists mirror_src text;
create unique index if not exists invoice_incomes_mirror_src_uidx on public.invoice_incomes (mirror_src);
comment on column public.invoice_incomes.mirror_src is
  'TRAVESSIA US⇄BR: ''BR:invoice_payments:<id>'' (renda do BR que caiu no US) ou ''pendente:BR:invoice:<id>'' (o Pending balance da 006.N). Única.';

-- ── 3. invoice_incomes.br_payment_id ──────────────────────────────────────────
alter table public.invoice_incomes add column if not exists br_payment_id uuid;
create index if not exists invoice_incomes_br_payment_id_idx on public.invoice_incomes (br_payment_id) where br_payment_id is not null;
comment on column public.invoice_incomes.br_payment_id is
  'TRAVESSIA US⇄BR: id da renda do BR (invoice_payments, PAID TO GZ28US) que esta renda espelha. Sem FK: mora em outro projeto.';

-- ── 4. numeração sem código repetido ──────────────────────────────────────────
create unique index if not exists invoices_client_invoice_code_uidx on public.invoices (client_id, invoice_code);

notify pgrst, 'reload schema';

-- ── CONFERÊNCIA: se faltar qualquer peça, tudo volta atrás ────────────────────
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and (table_name::text, column_name::text) in
     (('invoices', 'mirror_key'), ('invoice_expenses', 'mirror_src'), ('invoice_items', 'mirror_src'),
      ('invoice_incomes', 'mirror_src'), ('invoice_incomes', 'br_payment_id'));
  if n <> 5 then raise exception 'esperava as 5 colunas novas, achei %', n; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname in
     ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_items_mirror_src_uidx',
      'invoice_incomes_mirror_src_uidx', 'invoice_incomes_br_payment_id_idx', 'invoices_client_invoice_code_uidx');
  if n <> 6 then raise exception 'esperava os 6 índices novos, achei %', n; end if;

  select count(*) into n from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname in ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_items_mirror_src_uidx',
                       'invoice_incomes_mirror_src_uidx', 'invoices_client_invoice_code_uidx') and i.indisunique;
  if n <> 5 then raise exception 'os 5 índices únicos não ficaram únicos (achei %)', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura, depois do commit) ────────────────────────────────
select table_name, column_name, data_type from information_schema.columns
 where table_schema = 'public' and column_name in ('mirror_key', 'mirror_src', 'br_payment_id')
 order by table_name, column_name;
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and indexname in
   ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_items_mirror_src_uidx',
    'invoice_incomes_mirror_src_uidx', 'invoice_incomes_br_payment_id_idx', 'invoices_client_invoice_code_uidx')
 order by indexname;
select (select count(mirror_key) from public.invoices) invoices_com_mirror_key,
       (select count(mirror_src) from public.invoice_expenses) despesas_com_mirror_src,
       (select count(mirror_src) from public.invoice_items) itens_com_mirror_src,
       (select count(mirror_src) from public.invoice_incomes) rendas_com_mirror_src,
       (select count(br_payment_id) from public.invoice_incomes) rendas_com_br_payment_id;
