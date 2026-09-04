-- AUTO-BOOK — Fase B (BL 0.9.0, 4/set/2026, GO do João + Márcio). O balde
-- «Compras a atribuir», regras PADRÃO semeadas pelo app, classe do classificador,
-- piso até a abertura da conta. Rode UMA vez no SQL Editor do projeto US, ANTES
-- do deploy. Idempotente: rode quantas vezes quiser.
--
-- ANTES de rodar, confira (só leitura) se invoices/invoice_expenses/inputs têm
-- CHECK que barre os valores usados aqui (origin 'BUCKET', live_status
-- 'INCOMPLETE', category 'CONSUMPTION'):
--   select conrelid::regclass, conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('public.invoices'::regclass,'public.invoice_expenses'::regclass,'public.inputs'::regclass) and contype = 'c';
-- O bloco DO abaixo falha alto se invoices tiver CHECK em origin sem BUCKET.

-- 1) Regras: origem DEFAULT (semeada pelo app), chave estável (desligada nunca
--    renasce), classe do classificador, prioridade, alvo BUCKET.
alter table bank_merchant_rules
  add column if not exists key text,
  add column if not exists klass text,
  add column if not exists priority integer not null default 100;
create unique index if not exists bank_merchant_rules_key_uidx on bank_merchant_rules (key) where key is not null;
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_origin_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_origin_check check (origin in ('HUMAN','LEARNED','DEFAULT'));
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_target_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_target_check check (target in ('FIXED_EXPENSE','INPUT','TRANSFER','BUCKET'));
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_matcher_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_matcher_check
  check (pattern is not null or pfc_primary is not null or pfc_detailed is not null or merchant_key is not null or klass is not null);
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_default_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_default_check check (origin <> 'DEFAULT' or key is not null);
alter table bank_merchant_rules drop constraint if exists bank_merchant_rules_bucket_check;
alter table bank_merchant_rules add constraint bank_merchant_rules_bucket_check check (target <> 'BUCKET' or (supplier_id is null and category is null));
-- transfer_check fica como está: PADRÃO nunca mira TRANSFER.
-- Vocabulário: SHOP nunca existiu nas telas de supplies (CONSUMPTION/STOCK/APARTMENT/CATS).
update bank_merchant_rules set category = 'CONSUMPTION' where target = 'INPUT' and category = 'SHOP';

-- 2) O balde: UMA pseudo-invoice, origin BUCKET. Falha alto se invoices tiver
--    CHECK em origin sem o valor BUCKET.
do $$ declare c text; begin
  select string_agg(conname, ', ') into c from pg_constraint
   where conrelid = 'public.invoices'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%origin%' and pg_get_constraintdef(oid) not ilike '%BUCKET%';
  if c is not null then raise exception 'invoices tem CHECK em origin sem BUCKET (%). Amplie antes de seguir.', c; end if;
end $$;
do $$ declare c text; begin
  select string_agg(conname, ', ') into c from pg_constraint
   where conrelid = 'public.invoices'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%live_status%' and pg_get_constraintdef(oid) not ilike '%INCOMPLETE%';
  if c is not null then raise exception 'invoices tem CHECK em live_status sem INCOMPLETE (%). Amplie antes de seguir.', c; end if;
end $$;
create unique index if not exists invoices_bucket_uidx on invoices ((1)) where origin = 'BUCKET';
insert into invoices (invoice_code, origin, is_quote, live_status, feed_status, import_margin, ride_id, client_id)
select 'A ATRIBUIR', 'BUCKET', false, 'INCOMPLETE', 'INCOMPLETE', 0, null, null
 where not exists (select 1 from invoices where origin = 'BUCKET');
-- Invariantes (auto-cura): sem carro, sem cliente, nunca quote, nunca report-ready.
update invoices set ride_id = null, client_id = null, is_quote = false, live_status = 'INCOMPLETE', invoice_code = 'A ATRIBUIR'
 where origin = 'BUCKET' and (ride_id is not null or client_id is not null or is_quote or live_status is distinct from 'INCOMPLETE' or invoice_code is distinct from 'A ATRIBUIR');
-- Guarda contra o REMOVE em cascata (FK invoice_expenses.invoice_id ON DELETE CASCADE):
-- apagar a pseudo-invoice apagaria TODO o balde e deixaria as linhas do banco
-- apontando pro nada.
create or replace function public.guard_bucket_invoice() returns trigger language plpgsql as $$
begin
  if old.origin = 'BUCKET' then raise exception 'invoice A ATRIBUIR (BUCKET) não pode ser apagada'; end if;
  return old;
end $$;
drop trigger if exists invoices_guard_bucket on invoices;
create trigger invoices_guard_bucket before delete on invoices for each row execute function public.guard_bucket_invoice();

-- 2b) Fornecedor da frota (combustível/pedágio) é UM só — o motor cria se faltar;
--     duas linhas dividiriam o combustível em silêncio.
create unique index if not exists fixed_cost_suppliers_fleet_fuel_uidx on fixed_cost_suppliers ((1)) where cost_type = 'FLEET' and lower(company) like 'frota — combust%';

-- 3) Elo linha ⇄ banco = purchase_group (uuid da linha do banco). Índices pra
--    fila, órfãos, DESFAZER e a linha do DRE.
create index if not exists invoice_expenses_purchase_group_idx on invoice_expenses (purchase_group) where purchase_group is not null;
create index if not exists inputs_purchase_group_idx on inputs (purchase_group) where purchase_group is not null;
create index if not exists inventory_purchase_group_idx on inventory (purchase_group) where purchase_group is not null;
create index if not exists invoice_expenses_bucket_idx on invoice_expenses (invoice_id, payment_date);
create index if not exists bank_transactions_bucket_idx on bank_transactions (match_engine, reviewed_at) where match_engine = 'BUCKET';

-- 4) Órfãos do balde: NÃO se apaga por SQL (sem trilha). O motor purga no início de
--    cada rodada, com 10 min de carência e registro em data_fixes (purgeBucketOrphans);
--    o card AUTO-BOOK mostra cada um com PURGAR. Conferência (só leitura):
--   select e.id, e.item, e.price from invoice_expenses e join invoices i on i.id = e.invoice_id
--    where i.origin = 'BUCKET' and not exists (select 1 from bank_transactions b where b.match_status = 'MATCHED'
--      and ((b.matched_table = 'invoice_expenses' and b.matched_id::text = e.id::text)
--        or (b.matched_table = 'purchase_group' and b.matched_id::text = e.purchase_group::text)));

-- 5) Conferência (só leitura):
--   select count(*) from invoices where origin = 'BUCKET';          -- 1
--   select count(*) from bank_merchant_rules where origin = 'DEFAULT'; -- 0 até o app semear
