-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_comprovante_entrada.sql · 17/out/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
-- Rodar:  node scripts/roda-sql.mjs --projeto us --file MIGRATION_comprovante_entrada.sql --confirmo
-- RODE ANTES DO DEPLOY: o motor da travessia (lib/crossing.server.ts) passa a exigir invoice_incomes.receipt_kinds.
--
-- O COMPROVANTE DE ENTRADA DE CADA LADO (Márcio, 17/10/2026):
--   «no espelho do BR os comprovantes anexados devem ser os de entrada nas contas do BR, no app do US, os comprovantes
--    devem ser os de entrada na conta do Regions» + «podem ficar os comprovantes do BR no app do US, de forma provisória,
--    até que hajam os comprovantes do US, quando existirem os comprovantes do US, o app automaticamente tem que
--    substitui-los». Modelo aprovado por ele em 17/10: troca SÓ quando a remessa chegou INTEIRA na Regions.
--
-- 1. invoice_incomes.receipt_kinds — o TIPO de cada arquivo do receipt_url (que continua o array JSON que as telas leem):
--      { "<url>": "NF" | "BR_ENTRY" | "REGIONS_ENTRY" }
--      NF ............ documento da venda (NF-e, invoice) — fica para sempre
--      BR_ENTRY ...... PIX/TED de entrada numa conta do BR — PROVISÓRIO na renda do US PAID TO GZ28BR; a direção 4 copia
--                      para o pagamento espelho na 085.N
--      REGIONS_ENTRY . wire/Zelle de entrada na Regions — o definitivo, posto pela troca automática (lib/remittance.server.ts)
--      Arquivo sem tipo nunca é mexido pelo app.
-- 2. remittances — a remessa BR→US como UM registro, com o câmbio REAL do negócio (ex.: Allan 16/10, R$ 157.779 a 5,28 =
--      US$ 29.882,39). completed_at = quando chegou inteira na Regions e a troca rodou.
-- 3. remittance_incomes — o elo da remessa com as rendas do US:
--      COVERS  = a renda PAID TO GZ28BR que o dinheiro da remessa cobre (US.019.4, US.022.4, US.022.2)
--      ARRIVAL = o pagamento do GZ28BR numa 006.N que É um pedaço da remessa (casado com a linha da Regions)
--
-- remittances / remittance_incomes: RLS ligado e nenhuma policy — só a chave de serviço (robôs e servidor).
-- ADITIVO e IDEMPOTENTE. VOLTA: ROLLBACK_comprovante_entrada.sql

begin;

set local lock_timeout = '5s';

alter table public.invoice_incomes add column if not exists receipt_kinds jsonb;
comment on column public.invoice_incomes.receipt_kinds is
  'Tipo de cada arquivo do receipt_url: {"<url>": "NF" | "BR_ENTRY" | "REGIONS_ENTRY"}. BR_ENTRY é provisório na renda PAID TO GZ28BR e sai sozinho quando a remessa chega inteira na Regions (Márcio 17/10/2026). Arquivo sem tipo nunca é mexido.';

create table if not exists public.remittances (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  remit_date   date not null,
  amount_brl   numeric(14,2),
  rate         numeric(10,4),
  amount_usd   numeric(14,2) not null check (amount_usd > 0),
  description  text,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
comment on table public.remittances is
  'Remessa BR→US (17/10/2026): um registro por envio, com o câmbio REAL do negócio. Ligada às rendas que cobre e aos pedaços que chegaram (remittance_incomes). completed_at = chegou inteira na Regions e o comprovante BR_ENTRY das rendas cobertas foi trocado pelo da Regions.';

create table if not exists public.remittance_incomes (
  remittance_id uuid not null references public.remittances(id) on delete restrict,
  income_id     uuid not null references public.invoice_incomes(id) on delete cascade,
  role          text not null check (role in ('COVERS', 'ARRIVAL')),
  created_at    timestamptz not null default now(),
  primary key (remittance_id, income_id, role)
);
create index if not exists remittance_incomes_income_idx on public.remittance_incomes (income_id);
comment on table public.remittance_incomes is
  'COVERS = renda do US PAID TO GZ28BR coberta pela remessa · ARRIVAL = pagamento do GZ28BR numa 006.N que é um pedaço da remessa (casado com a Regions).';

alter table public.remittances enable row level security;
alter table public.remittance_incomes enable row level security;
-- Só a chave de serviço (o servidor e os robôs): sem grant para authenticated/anon, e sem policy.
grant select, insert, update, delete on public.remittances to service_role;
grant select, insert, update, delete on public.remittance_incomes to service_role;

-- ── os 3 provisórios de 17/10 (AutoBook GZ28US, trilha comprovantes-us-x-br-1710): o tipo de cada arquivo ──
with alvo(id, kinds) as (values
  ('efa0064d-7d53-4124-83a2-e1c9bd7c1b8a'::uuid, '{"https://fvgpkbpqacnqxtrjsmpi.supabase.co/storage/v1/object/public/expense-receipts/incomes/2026-10/nfe-082-gz28-x-sidney-penna-kit-biturbo.pdf": "NF", "https://fvgpkbpqacnqxtrjsmpi.supabase.co/storage/v1/object/public/expense-receipts/incomes/2026-10/pix-sidney-tornado-us019-4-r97949.59.pdf": "BR_ENTRY"}'::jsonb),
  ('aabde492-7947-4166-b94c-15e3f1f28208'::uuid, '{"https://fvgpkbpqacnqxtrjsmpi.supabase.co/storage/v1/object/public/expense-receipts/incomes/2026-10/nfe-083-gz28-x-sidney-penna-kit-biturbo.pdf": "NF", "https://fvgpkbpqacnqxtrjsmpi.supabase.co/storage/v1/object/public/expense-receipts/incomes/2026-10/pix-sidney-apocalypse-us022-4-r124135.09.pdf": "BR_ENTRY"}'::jsonb),
  ('d238c386-7645-4b4b-a66e-b03f9e8ea31f'::uuid, '{"https://fvgpkbpqacnqxtrjsmpi.supabase.co/storage/v1/object/public/expense-receipts/incomes/2026-10/pix-pedro-morais-cambio-apocalypse-r25000.pdf": "BR_ENTRY"}'::jsonb)
), feito as (
  update public.invoice_incomes i set receipt_kinds = a.kinds
    from alvo a where i.id = a.id and i.receipt_kinds is null
  returning i.id, i.receipt_kinds
)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'comprovante-entrada-regions', 'invoice_incomes', f.id::text, 'receipt_kinds', null, f.receipt_kinds::text,
       'Tipo dos comprovantes (Márcio 17/10/2026): NF fica; PIX de entrada no C6 = BR_ENTRY provisório até a remessa chegar inteira na Regions'
  from feito f;

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_incomes' and column_name = 'receipt_kinds';
  if n <> 1 then raise exception 'invoice_incomes.receipt_kinds não existe'; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname in ('remittances', 'remittance_incomes') and c.relrowsecurity;
  if n <> 2 then raise exception 'remittances/remittance_incomes ficaram sem RLS'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename in ('remittances', 'remittance_incomes');
  if n <> 0 then raise exception 'remittances tem % policy(ies) — é só da chave de serviço', n; end if;
  select count(*) into n from public.invoice_incomes where receipt_kinds is not null
   and id in ('efa0064d-7d53-4124-83a2-e1c9bd7c1b8a', 'aabde492-7947-4166-b94c-15e3f1f28208', 'd238c386-7645-4b4b-a66e-b03f9e8ea31f');
  if n <> 3 then raise exception 'esperava os 3 provisórios tipados, achei %', n; end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- ── VERIFICAÇÃO (só leitura, depois do commit) ────────────────────────────────
select left(id::text, 8) id, receipt_kinds from public.invoice_incomes where receipt_kinds is not null;
select count(*) as trilha from public.data_fixes where check_key = 'comprovante-entrada-regions';
