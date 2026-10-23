-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_intercompany_transfers.sql · 23/out/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
-- Rodar:  node scripts/roda-sql.mjs --projeto us --file MIGRATION_intercompany_transfers.sql --confirmo
--
-- A CONTA CORRENTE BR↔US SEM ESPELHO (Márcio, 23/10/2026: «UPDATE THE APP TO ALL THESE MODS WE DECIDED, let's make this BR vs
-- US flow PERFECT»). O modelo:
--   · cada despesa mora no app dela, com PAID BY (quem pagou);  cada renda com RECEIVED BY (conta onde o dinheiro caiu);
--   · o dinheiro que uma empresa MANDA para a outra (Allan, cheque, saque no cartão, wire) é uma TRANSFERÊNCIA — este registro;
--   · o saldo «quanto o BR deve ao US» é CALCULADO desses fatos (lib/intercompanyLedger.server.ts), nunca copiado.
--   As shopping invoices 006.N (US) e 085.N (BR) viram HISTÓRICO só-leitura; o motor de espelho (lib/crossing.server.ts) para de
--   gravar. Nada do histórico é apagado.
--
-- intercompany_transfers — UMA linha por envio: o que SAIU (moeda, valor, data, comprovante), o que CHEGOU (idem), a linha da
--   Regions casada (bank_transaction_id), as rendas que a remessa cobre (covers) e a origem legada (legacy: remessa / rendas 006.N
--   que a representavam). rate = sent ÷ arrived, calculado na leitura. fx_diff_usd = ganho/perda de câmbio declarado ao fechar.
--
-- SEMENTE (nada inventado): as 14 remessas de `remittances` + toda renda PAGA de 006.N que NÃO é espelho da direção 2 (as entradas
--   de dinheiro do BR na Regions: wires do Allan, saques Chase, «Business Adv Fundamentals»). Renda em invoice de CARRO do cliente
--   GZ28BR (PO.002.1, peças vendidas) NÃO é transferência e fica fora. Sem R$ gravado → needs_review (a AutoBook cava o lado BR).
--
-- GRANTS (lei de 20/10/2026: tabela nova leva os 3). RLS ligado; policy só para authenticated (as rotas usam a chave de serviço).
-- ADITIVO e IDEMPOTENTE. VOLTA: ROLLBACK_intercompany_transfers.sql

begin;

set local lock_timeout = '5s';

create table if not exists public.intercompany_transfers (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  direction         text not null check (direction in ('BR_TO_US', 'US_TO_BR')),
  via               text,
  sent_on           date,
  sent_amount       numeric(14,2),
  sent_currency     text check (sent_currency in ('BRL', 'USD')),
  sent_receipts     jsonb not null default '[]'::jsonb,
  arrived_on        date,
  arrived_amount    numeric(14,2),
  arrived_currency  text check (arrived_currency in ('BRL', 'USD')),
  arrived_receipts  jsonb not null default '[]'::jsonb,
  bank_transaction_id uuid,
  covers            jsonb not null default '[]'::jsonb,
  legacy            jsonb not null default '{}'::jsonb,
  description       text,
  status            text not null default 'SENT' check (status in ('SENT', 'ARRIVED', 'RECONCILED')),
  fx_diff_usd       numeric(14,2) not null default 0,
  needs_review      boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.intercompany_transfers is
  'Transferência de dinheiro entre GZ28BR e GZ28US (23/10/2026): o que saiu, o que chegou, comprovantes, linha da Regions, rendas cobertas. O saldo BR↔US é calculado (lib/intercompanyLedger.server.ts); nada aqui é cópia.';

grant select on public.intercompany_transfers to anon;
grant select, insert, update, delete on public.intercompany_transfers to authenticated;
grant select, insert, update, delete on public.intercompany_transfers to service_role;
alter table public.intercompany_transfers enable row level security;
do $pol$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'intercompany_transfers' and policyname = 'intercompany_transfers_authenticated') then
    create policy intercompany_transfers_authenticated on public.intercompany_transfers for all to authenticated using (true) with check (true);
  end if;
end $pol$;

-- ── SEMENTE 1: as remessas ───────────────────────────────────────────────────
with arr as (
  select ri.remittance_id, max(coalesce(i.payment_date, (i.paid_at at time zone 'America/New_York')::date)) as arrived_on,
         bool_and(i.paid_at is not null) as all_paid, jsonb_agg(i.id) as income_ids
    from public.remittance_incomes ri join public.invoice_incomes i on i.id = ri.income_id
   where ri.role = 'ARRIVAL' group by ri.remittance_id
), cov as (
  select ri.remittance_id, jsonb_agg(jsonb_build_object('app', 'US', 'table', 'invoice_incomes', 'id', ri.income_id)) as covers
    from public.remittance_incomes ri where ri.role = 'COVERS' group by ri.remittance_id
), nova as (
  insert into public.intercompany_transfers (code, direction, via, sent_on, sent_amount, sent_currency, arrived_on, arrived_amount, arrived_currency, covers, legacy, description, status, needs_review)
  select r.code, 'BR_TO_US',
         case when r.code ilike '%CHEQUE%' then 'CHEQUE' else 'ALLAN' end,
         r.remit_date, r.amount_brl, 'BRL',
         a.arrived_on, r.amount_usd, 'USD',
         coalesce(c.covers, '[]'::jsonb),
         jsonb_build_object('remittance_code', r.code, 'remittance_id', r.id, 'arrival_income_ids', coalesce(a.income_ids, '[]'::jsonb)),
         r.description,
         case when r.completed_at is not null then 'RECONCILED' when a.all_paid then 'ARRIVED' else 'SENT' end,
         r.amount_brl is null
    from public.remittances r left join arr a on a.remittance_id = r.id left join cov c on c.remittance_id = r.id
   where not exists (select 1 from public.intercompany_transfers t where t.code = r.code)
  returning id, code
)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'intercompany-transfers-semente', 'intercompany_transfers', n.id::text, '(criada)', null, n.code,
       'Semente 23/10/2026: remessa de `remittances` virou transferência (modelo sem espelho)'
  from nova n;

-- ── SEMENTE 2: toda renda PAGA de 006.N que não é espelho da direção 2 nem já está numa remessa ───────────────────────
with cand as (
  select i.id, i.invoice_id, i.amount, i.amount_brl, coalesce(i.payment_date, (i.paid_at at time zone 'America/New_York')::date) as dia, i.description,
         case when i.receipt_url is null or i.receipt_url = '' then '[]'::jsonb
              when left(i.receipt_url, 1) = '[' then i.receipt_url::jsonb
              else jsonb_build_array(i.receipt_url) end as receipts,
         v.invoice_code
    from public.invoice_incomes i join public.invoices v on v.id = i.invoice_id
   where v.client_id = '97c4a91e-d1c2-48ca-9d05-8662fe324f27' and v.is_quote = false and v.ride_id is null
     and i.paid_at is not null
     and coalesce(i.mirror_src, '') not like 'BR:%' and coalesce(i.mirror_src, '') not like 'pendente:%'
     and i.id not in (select income_id from public.remittance_incomes where role = 'ARRIVAL')
), nova as (
  insert into public.intercompany_transfers (code, direction, via, sent_on, sent_amount, sent_currency, arrived_on, arrived_amount, arrived_currency, arrived_receipts, legacy, description, status, needs_review)
  select 'TR-' || to_char(c.dia, 'YYYY-MM-DD') || '-' || left(c.id::text, 8), 'BR_TO_US',
         case when c.description ilike '%saque%' or c.description ilike '%chase%' then 'CASH'
              when c.description ilike '%zelle%' then 'ZELLE' else 'WIRE' end,
         c.dia, c.amount_brl, case when c.amount_brl is not null then 'BRL' end,
         c.dia, c.amount, 'USD',
         c.receipts,
         jsonb_build_object('income_ids', jsonb_build_array(c.id), 'invoice_code', c.invoice_code),
         coalesce(c.description, '') || ' (renda da ' || c.invoice_code || ' no modelo antigo)',
         'ARRIVED', c.amount_brl is null
    from cand c
   where not exists (select 1 from public.intercompany_transfers t where t.legacy->'income_ids' @> to_jsonb(array[c.id]))
  returning id, code
)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'intercompany-transfers-semente', 'intercompany_transfers', n.id::text, '(criada)', null, n.code,
       'Semente 23/10/2026: renda paga de 006.N (entrada de dinheiro do BR na Regions) virou transferência'
  from nova n;

do $$
declare n int; m int;
begin
  select count(*) into n from information_schema.tables where table_schema = 'public' and table_name = 'intercompany_transfers';
  if n <> 1 then raise exception 'intercompany_transfers não existe'; end if;
  select count(*) into n from public.intercompany_transfers where legacy ? 'remittance_code';
  select count(*) into m from public.remittances;
  if n <> m then raise exception 'esperava % transferências das remessas, achei %', m, n; end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- ── VERIFICAÇÃO (só leitura) ──────────────────────────────────────────────────
select status, via, count(*), sum(arrived_amount) usd, sum(sent_amount) brl, sum(case when needs_review then 1 else 0 end) review
  from public.intercompany_transfers group by 1, 2 order by 1, 2;
