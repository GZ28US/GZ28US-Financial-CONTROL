-- REPORTED OU NÃO, NA PRÓPRIA LINHA (Márcio, 16/09/2026 ~18:45 Orlando): «o app está mandando report de expense que já havia
-- mandado, crie uma coluna no banco pras expenses e incomes as marcando como REPORTED ou NÃO, pra nunca mais acontecer isso. O App
-- não reporta mais coisa que já reportou.»
--
-- reported_at timestamptz nas 8 tabelas de dinheiro do US. NULL = NÃO reportada; com data = REPORTED (o balão saiu, ou a linha
-- foi tratada em silêncio de propósito — retroativo, recusa no diálogo do editor). Nenhum robô nem tela reporta linha com data.
-- Até hoje o «já reportei» morava FORA da linha (stream_mail_moves 'ern:<tipo>:<id>' e expense_reports_sent, este só por DIA),
-- e três furos repetiam balão: o cron de staff reportava de novo, a cada 7 dias, toda linha semanal da season (17/08, a enxurrada;
-- 14/09, a semana paga em 14/08); linha recriada ganha id novo e sai de novo; e o Zelle já anunciado sai outra vez quando a
-- despesa é lançada (Raydn 003598: US$ 329,56 no ZELLE ENVIADO de 15/09 e de novo no EXPENSE PAID de US$ 408,81 em 16/09).
--
-- PREENCHIMENTO (nenhum valor de dinheiro muda; só a coluna nova):
--   1. as marcas da rede ern:ie / ern:ip / ern:se → invoice_expenses / invoice_incomes / staff_expenses (data da marca);
--   2. expense_reports_sent (o cron de staff) → staff_expenses (primeiro envio);
--   3. histórico das três tabelas da rede: linha PAGA que ninguém mexe desde antes da rede existir (updated_at < 26/07 16:00 UTC)
--      → created_at. A rede nunca olhou para elas e o dinheiro é antigo. Fora: QUOTE e o balde A ATRIBUIR (origin BUCKET) —
--      a compra do balde ainda vai ganhar dono e o balão da atribuição (Bank Link) tem de poder sair;
--   4. assets, assets_expenses, inputs, inventory e fixed_cost_expenses só reportam pela TELA, no salvamento: toda linha PAGA que
--      já existe foi tratada quando nasceu → created_at. Linha sem pagamento fica NULL.
-- Trilha: data_fixes check_key 'reported-at-backfill', uma linha por tabela com a contagem. VOLTA: ROLLBACK_reported_at.sql
begin;
set local lock_timeout = '5s';
alter table public.invoice_expenses add column if not exists reported_at timestamptz;
alter table public.invoice_incomes add column if not exists reported_at timestamptz;
alter table public.staff_expenses add column if not exists reported_at timestamptz;
alter table public.assets add column if not exists reported_at timestamptz;
alter table public.assets_expenses add column if not exists reported_at timestamptz;
alter table public.inputs add column if not exists reported_at timestamptz;
alter table public.inventory add column if not exists reported_at timestamptz;
alter table public.fixed_cost_expenses add column if not exists reported_at timestamptz;
comment on column public.invoice_expenses.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.invoice_incomes.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.staff_expenses.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.assets.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.assets_expenses.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.inputs.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.inventory.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';
comment on column public.fixed_cost_expenses.reported_at is 'REPORTED: quando o report desta linha saiu no grupo REPORTS (ou ela foi tratada em silêncio de propósito). NULL = NÃO reportada. Nenhum robô nem tela reporta linha com data (Márcio, 16/09/2026).';

-- 1) as marcas da rede
with m as (
  select substr(message_id, 8)::uuid as id, min(created_at) as em from public.stream_mail_moves
   where from_addr = 'expense-report-net' and message_id ~ '^ern:ie:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' group by 1
), u as (update public.invoice_expenses x set reported_at = m.em from m where x.id = m.id and x.reported_at is null returning x.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'invoice_expenses', 'marcas-ern-ie', 'reported_at', null, count(*)::text, 'invoice_expenses: reported_at da marca ern:ie da rede de reports (stream_mail_moves)' from u;
with m as (
  select substr(message_id, 8)::uuid as id, min(created_at) as em from public.stream_mail_moves
   where from_addr = 'expense-report-net' and message_id ~ '^ern:ip:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' group by 1
), u as (update public.invoice_incomes x set reported_at = m.em from m where x.id = m.id and x.reported_at is null returning x.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'invoice_incomes', 'marcas-ern-ip', 'reported_at', null, count(*)::text, 'invoice_incomes: reported_at da marca ern:ip da rede de reports (stream_mail_moves)' from u;
with m as (
  select substr(message_id, 8)::uuid as id, min(created_at) as em from public.stream_mail_moves
   where from_addr = 'expense-report-net' and message_id ~ '^ern:se:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' group by 1
), u as (update public.staff_expenses x set reported_at = m.em from m where x.id = m.id and x.reported_at is null returning x.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'staff_expenses', 'marcas-ern-se', 'reported_at', null, count(*)::text, 'staff_expenses: reported_at da marca ern:se da rede de reports (stream_mail_moves)' from u;

-- 2) o cron de staff
with x as (select expense_id, min(sent_at) as em from public.expense_reports_sent group by 1),
u as (update public.staff_expenses s set reported_at = x.em from x where s.id = x.expense_id and s.reported_at is null returning s.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'staff_expenses', 'expense_reports_sent', 'reported_at', null, count(*)::text, 'staff_expenses: reported_at do primeiro envio do cron recurring-expense-reports' from u;

-- 3) histórico das tabelas da rede
with u as (update public.invoice_expenses e set reported_at = e.created_at
  where e.reported_at is null and e.payment_date is not null and e.updated_at < '2026-07-26T16:00:00Z'
    and exists (select 1 from public.invoices i where i.id = e.invoice_id and coalesce(i.is_quote, false) = false and coalesce(i.origin, '') <> 'BUCKET')
  returning e.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'invoice_expenses', 'historico', 'reported_at', null, count(*)::text, 'invoice_expenses pagas antes da rede (updated_at < 26/07), sem quote e sem balde: created_at' from u;
with u as (update public.invoice_incomes p set reported_at = p.created_at
  where p.reported_at is null and p.paid_at is not null and p.updated_at < '2026-07-26T16:00:00Z'
    and exists (select 1 from public.invoices i where i.id = p.invoice_id and coalesce(i.is_quote, false) = false)
  returning p.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'invoice_incomes', 'historico', 'reported_at', null, count(*)::text, 'invoice_incomes recebidas antes da rede (updated_at < 26/07), sem quote: created_at' from u;
with u as (update public.staff_expenses s set reported_at = s.created_at
  where s.reported_at is null and s.payment_date is not null and s.updated_at < '2026-07-26T16:00:00Z'
  returning s.id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'staff_expenses', 'historico', 'reported_at', null, count(*)::text, 'staff_expenses pagas antes da rede (updated_at < 26/07): created_at' from u;

-- 4) tabelas que só reportam pela tela
with u as (update public.assets set reported_at = created_at where reported_at is null and payment_date is not null returning id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'assets', 'pagas-existentes', 'reported_at', null, count(*)::text, 'assets: linha paga que já existia foi tratada pela tela quando nasceu: created_at' from u;
with u as (update public.assets_expenses set reported_at = created_at where reported_at is null and payment_date is not null returning id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'assets_expenses', 'pagas-existentes', 'reported_at', null, count(*)::text, 'assets_expenses: linha paga que já existia foi tratada pela tela quando nasceu: created_at' from u;
with u as (update public.inputs set reported_at = created_at where reported_at is null and payment_date is not null returning id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'inputs', 'pagas-existentes', 'reported_at', null, count(*)::text, 'inputs: linha paga que já existia foi tratada pela tela quando nasceu: created_at' from u;
with u as (update public.inventory set reported_at = created_at where reported_at is null and payment_date is not null returning id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'inventory', 'pagas-existentes', 'reported_at', null, count(*)::text, 'inventory: linha paga que já existia foi tratada pela tela quando nasceu: created_at' from u;
with u as (update public.fixed_cost_expenses set reported_at = created_at where reported_at is null and payment_date is not null returning id)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'reported-at-backfill', 'fixed_cost_expenses', 'pagas-existentes', 'reported_at', null, count(*)::text, 'fixed_cost_expenses: linha paga que já existia foi tratada pela tela quando nasceu: created_at' from u;
commit;
select table_name, row_id, new_value as linhas from public.data_fixes where check_key = 'reported-at-backfill' order by table_name, row_id;
