-- ═══════════════════════════════════════════════════════════════════════════
-- A CHAVE ANON PÚBLICA SAI DE ONDE NINGUÉM DE FORA LÊ — BANCO DO US (11/set/2026)
-- Projeto US fvgpkbpqacnqxtrjsmpi. Uma transação só; idempotente.
-- Rollback exato: ROLLBACK_rls_anon_exposure_11set.sql.
--
-- POR QUE: a chave anon do US está no bundle público do /ca, da /shop e do app BR
-- (lib/supabaseUS.ts). A auditoria de 11/set (Management API: relrowsecurity +
-- pg_policies) achou 8 tabelas abertas para ela. Medido com a chave anon × a de
-- serviço em 11/set/2026 16:01 Orlando — a anon viu TUDO:
--   auto_book_mail 20/20 · auto_book_mail_rules 0/0 · auto_book_mail_runs 114/114
--       → RLS DESLIGADO: lê e GRAVA (inclusive regra BOOK, que o cron de hora em hora aplica)
--   invoice_duties 267/267 → "Allow all invoice_duties" para public, ALL — sobra de antes
--       do Phase 1 (o rls_phase1.sql criou a authenticated e nunca tirou esta)
--   part_streams 209/209 · part_stream_items 8/8 → "<tabela> anon all", ALL (lê e grava)
--   supplier_orders 165/165 → supplier_orders_select para anon + authenticated, SELECT
--   shop_config 1/1 → "anon read", SELECT
--
-- QUEM LÊ CADA UMA (grep nos DOIS apps + gz28shop-us + memória; revisado por um cético —
-- lição do rls-pending: o Phase 1 olhou só o US e quebrou o BR):
--   auto_book_mail*  só servidor: cron/auto-book, api/auto-book, data-check/engines e
--                    data-check/audit, todos com a chave de serviço → RLS ligado, SEM política.
--   invoice_duties   telas logadas (duties, invoices, packs) = authenticated; crons = serviço;
--                    a página pública /duties/self só chama as RPCs SECURITY DEFINER
--                    duties_self_load / duty_self_update → sai a de public, fica a authenticated.
--   part_streams*    só servidor (motor do e-mail, conciliação do banco) → saem as anon,
--                    ficam as "auth all".
--   supplier_orders  tela logada do US; tela logada do BR pelo supabaseUS com a sessão da
--                    ponte BR→US (funcionando) → SELECT só para authenticated.
--   shop_config      a LOJA PÚBLICA lê a margem com a chave anon (gz28shop-us: api/admin,
--                    api/checkout, lib/opsWrite; margem 15). Tirar faria a loja cobrar
--                    MAP × 1,00, calada → FICA, presa à linha shop_us_margin_pct.
--
-- NÃO MEXE: políticas authenticated (o app é "logado pode tudo"); invoice_duties do BR
-- (arquivo próprio no repo do BR); grants da anon (iguais às demais tabelas).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 0) TRAVAS — se algo estiver diferente do medido, PARA e nada é aplicado.
do $$
declare r record;
begin
  -- 0a) as políticas que saem ou mudam são permissive using(true): o rollback volta exato
  for r in
    select tablename::text as t, policyname::text as p, permissive, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (tablename::text, policyname::text) in (
             ('invoice_duties',    'Allow all invoice_duties'),
             ('part_streams',      'part_streams anon all'),
             ('part_stream_items', 'part_stream_items anon all'),
             ('supplier_orders',   'supplier_orders_select'),
             ('shop_config',       'anon read'))
  loop
    if r.permissive <> 'PERMISSIVE'
       or not (coalesce(r.qual, 'true') = 'true'
               or (r.t = 'shop_config' and r.qual = '(key = ''shop_us_margin_pct''::text)'))
       or coalesce(r.with_check, 'true') <> 'true' then
      raise exception 'Política "%" em % não é permissive using(true) (qual=%, with_check=%). Nada aplicado.',
        r.p, r.t, r.qual, r.with_check;
    end if;
  end loop;

  -- 0b) a porta dos logados em invoice_duties precisa existir antes de fechar a pública
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'invoice_duties'
                    and policyname = 'invoice_duties_authenticated_all') then
    raise exception 'invoice_duties sem invoice_duties_authenticated_all — as telas logadas perderiam as duties. Nada aplicado.';
  end if;

  -- 0c) a página pública /duties/self vive das RPCs SECURITY DEFINER; FORCE RLS as quebraria
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('duties_self_load', 'duty_self_update') and p.prosecdef) < 2 then
    raise exception 'duties_self_load/duty_self_update ausentes ou sem SECURITY DEFINER. Nada aplicado.';
  end if;
  if (select relforcerowsecurity from pg_class where oid = 'public.invoice_duties'::regclass) then
    raise exception 'invoice_duties com FORCE ROW LEVEL SECURITY — as RPCs perderiam as linhas. Nada aplicado.';
  end if;
end $$;

-- 1) AUTO-BOOK do e-mail: RLS ligado, nenhuma política (só a chave de serviço entra).
alter table public.auto_book_mail       enable row level security;
alter table public.auto_book_mail_rules enable row level security;
alter table public.auto_book_mail_runs  enable row level security;

-- 2) invoice_duties: sai a porta de public; a invoice_duties_authenticated_all fica.
drop policy if exists "Allow all invoice_duties" on public.invoice_duties;

-- 3) part_streams / part_stream_items: saem as portas anon; as "auth all" ficam.
drop policy if exists "part_streams anon all"      on public.part_streams;
drop policy if exists "part_stream_items anon all" on public.part_stream_items;

-- 4) supplier_orders: leitura só para quem está logado (US direto, BR pela ponte).
drop policy if exists supplier_orders_select on public.supplier_orders;
create policy supplier_orders_select on public.supplier_orders
  for select to authenticated using (true);

-- 5) shop_config: a loja pública continua lendo a margem — e só a margem.
drop policy if exists "anon read" on public.shop_config;
create policy "anon read" on public.shop_config
  for select to anon using (key = 'shop_us_margin_pct');

-- 6) CONFERE ANTES DO COMMIT — qualquer falha desfaz a transação inteira.
do $$
declare n int;
begin
  select count(*) into n
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('auto_book_mail','auto_book_mail_rules','auto_book_mail_runs','invoice_duties',
                       'part_streams','part_stream_items','supplier_orders','shop_config')
     and not c.relrowsecurity;
  if n > 0 then raise exception 'RLS ainda desligado em % das 8 tabelas', n; end if;

  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('auto_book_mail','auto_book_mail_rules','auto_book_mail_runs','invoice_duties',
                       'part_streams','part_stream_items','supplier_orders','shop_config')
     and roles && array['anon','public']::name[]
     and not (tablename = 'shop_config' and policyname = 'anon read');
  if n > 0 then raise exception 'Ainda há % política(s) para anon/public nessas tabelas', n; end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'part_streams' and policyname = 'part_streams auth all')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'part_stream_items' and policyname = 'part_stream_items auth all')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shop_config' and policyname = 'authenticated all') then
    raise exception 'Uma política authenticated que devia ficar não está lá';
  end if;
end $$;

commit;

-- Conferência (só leitura):
--   select relname, relrowsecurity from pg_class
--    where relname in ('auto_book_mail','auto_book_mail_rules','auto_book_mail_runs','invoice_duties',
--                      'part_streams','part_stream_items','supplier_orders','shop_config');
--   select tablename, policyname, roles, cmd, qual from pg_policies
--    where tablename in ('auto_book_mail','auto_book_mail_rules','auto_book_mail_runs','invoice_duties',
--                        'part_streams','part_stream_items','supplier_orders','shop_config') order by 1, 2;
