-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_travessia_shopping_invoice_BR.sql · 14/set/2026
-- Projeto: BR  saaowriaptbvfoqoykrh          (a do US é MIGRATION_travessia_shopping_invoice_US.sql)
-- Rodar pelo roda-sql do US:  node scripts/roda-sql.mjs --projeto br --file MIGRATION_travessia_shopping_invoice_BR.sql
--
-- A MESMA PEÇA DO LADO BRASILEIRO. O motor (lib/crossing.server.ts, no US) escreve as 085.N do
-- cliente «GZ28 V8 SpeedShop USA LLC» (6d4264bc) e precisa achar, no banco do BR, o que já gravou:
--   · o lote de 24/08 criou 085.1–085.10 (R$ 444.096,83 / US$ 80.024,33) com 69 linhas — NENHUMA
--     com us_expense_id (medido em 14/set). O próximo save de US.001.1 no editor do US apagaria e
--     recriaria as 17 linhas da 085.2;
--   · as direções 2 e 4 são RENDA, e a renda do BR não tem US$ nem elo: a de BR.537.1 (R$ 7.510,79,
--     New Times Agency, caiu na Regions) só vira dólar pela conta de alguém.
--
-- AQUI NÃO HOUVE RENAME: as tabelas continuam invoice_parts e invoice_payments.
--
-- O QUE ENTRA (só ADITIVO, idempotente):
--   1. invoices.mirror_key text, ÚNICA — 'US:invoice:<id>', 'US:season:<id>', 'US:assets:AAAA-MM'.
--   2. mirror_src text, ÚNICA, em invoice_expenses, invoice_parts e invoice_payments:
--        'US:invoice_expenses:<id>' · 'US:assets:<id>' · 'US:assets_expenses:<id>' · 'US:staff_expenses:<id>'
--        'US:invoice_incomes:<id>' (renda do US que caiu no BR) · 'pendente:US:invoice:<id>' (o Pending balance)
--   3. invoice_payments.amount_usd numeric — o US$ da renda. Gravado prevalece; onde falta, o motor
--      CARIMBA uma vez pela regra do app (e hoje trava BR.537.1: a regra dá US$ 1.317,92, a usd_rate
--      da invoice dá US$ 1.402,00 — pergunta aberta ao Márcio).
--   4. invoice_payments.us_income_id uuid — o elo da renda (direção 4), irmão do us_expense_id.
--   5. ÚNICO (client_id, invoice_code) — MEDIDO em 14/set/2026 00:34 (Orlando): ZERO repetidos nas 108.
--
-- VOLTA: ROLLBACK_travessia_shopping_invoice_BR.sql (recusa se já houver elo ou US$ gravado).
-- DEPOIS DESTA: BACKFILL_shopping_invoice_elos_BR.sql (os elos das 69 linhas das 085.N).

begin;

set local lock_timeout = '5s';

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
  'TRAVESSIA US⇄BR (14/set/2026): a origem desta shopping invoice no app do US — ''US:invoice:<id>'', ''US:season:<id>'' ou ''US:assets:AAAA-MM''. Única. Escrita por lib/crossing.server.ts do US.';

-- ── 2. mirror_src nas linhas ──────────────────────────────────────────────────
alter table public.invoice_expenses add column if not exists mirror_src text;
create unique index if not exists invoice_expenses_mirror_src_uidx on public.invoice_expenses (mirror_src);
comment on column public.invoice_expenses.mirror_src is
  'TRAVESSIA US⇄BR: a linha de origem no US — ''US:<tabela>:<id>'' (invoice_expenses, assets, assets_expenses, staff_expenses). Única.';

alter table public.invoice_parts add column if not exists mirror_src text;
create unique index if not exists invoice_parts_mirror_src_uidx on public.invoice_parts (mirror_src);
comment on column public.invoice_parts.mirror_src is
  'TRAVESSIA US⇄BR: o item cobrado ao GZ28US pela mesma linha de origem, sem markup. Única.';

alter table public.invoice_payments add column if not exists mirror_src text;
create unique index if not exists invoice_payments_mirror_src_uidx on public.invoice_payments (mirror_src);
comment on column public.invoice_payments.mirror_src is
  'TRAVESSIA US⇄BR: ''US:invoice_incomes:<id>'' (renda do US que caiu no BR) ou ''pendente:US:...'' (o Pending balance da 085.N). Única.';

-- ── 3. invoice_payments.amount_usd ────────────────────────────────────────────
alter table public.invoice_payments add column if not exists amount_usd numeric;
comment on column public.invoice_payments.amount_usd is
  'TRAVESSIA US⇄BR: o US$ desta renda. Valor gravado prevalece e nunca é recalculado; onde falta, carimbado UMA vez pela regra do app (bid do dia + R$ 0,20) × 1,0638, com trilha em data_fixes.';

-- ── 4. invoice_payments.us_income_id ──────────────────────────────────────────
alter table public.invoice_payments add column if not exists us_income_id uuid;
create index if not exists invoice_payments_us_income_id_idx on public.invoice_payments (us_income_id) where us_income_id is not null;
comment on column public.invoice_payments.us_income_id is
  'TRAVESSIA US⇄BR: id da renda do US (invoice_incomes, PAID TO GZ28BR) que este pagamento espelha. Sem FK: mora em outro projeto.';

-- ── 5. numeração sem código repetido ──────────────────────────────────────────
create unique index if not exists invoices_client_invoice_code_uidx on public.invoices (client_id, invoice_code);

notify pgrst, 'reload schema';

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and (table_name::text, column_name::text) in
     (('invoices', 'mirror_key'), ('invoice_expenses', 'mirror_src'), ('invoice_parts', 'mirror_src'),
      ('invoice_payments', 'mirror_src'), ('invoice_payments', 'amount_usd'), ('invoice_payments', 'us_income_id'));
  if n <> 6 then raise exception 'esperava as 6 colunas novas, achei %', n; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname in
     ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_parts_mirror_src_uidx',
      'invoice_payments_mirror_src_uidx', 'invoice_payments_us_income_id_idx', 'invoices_client_invoice_code_uidx');
  if n <> 6 then raise exception 'esperava os 6 índices novos, achei %', n; end if;

  select count(*) into n from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname in ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_parts_mirror_src_uidx',
                       'invoice_payments_mirror_src_uidx', 'invoices_client_invoice_code_uidx') and i.indisunique;
  if n <> 5 then raise exception 'os 5 índices únicos não ficaram únicos (achei %)', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura, depois do commit) ────────────────────────────────
select table_name, column_name, data_type from information_schema.columns
 where table_schema = 'public' and column_name in ('mirror_key', 'mirror_src', 'amount_usd', 'us_income_id')
   and table_name in ('invoices', 'invoice_expenses', 'invoice_parts', 'invoice_payments')
 order by table_name, column_name;
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and indexname in
   ('invoices_mirror_key_uidx', 'invoice_expenses_mirror_src_uidx', 'invoice_parts_mirror_src_uidx',
    'invoice_payments_mirror_src_uidx', 'invoice_payments_us_income_id_idx', 'invoices_client_invoice_code_uidx')
 order by indexname;
select (select count(mirror_key) from public.invoices) invoices_com_mirror_key,
       (select count(mirror_src) from public.invoice_expenses) despesas_com_mirror_src,
       (select count(mirror_src) from public.invoice_parts) itens_com_mirror_src,
       (select count(mirror_src) from public.invoice_payments) pagamentos_com_mirror_src,
       (select count(amount_usd) from public.invoice_payments) pagamentos_com_amount_usd,
       (select count(us_income_id) from public.invoice_payments) pagamentos_com_us_income_id;
