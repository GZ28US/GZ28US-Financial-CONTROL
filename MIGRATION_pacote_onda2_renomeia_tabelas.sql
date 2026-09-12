-- ONDA 2 DO PACOTE PAID FROM/TO (11/set/2026) — OS RENAMES, COM VIEW-PONTE.
-- Decisão do Márcio (memory/paid-from-to-por-tabela.md): "estamos falando dos nomes
-- das tabelas". Cinco renames:
--     invoice_payments → invoice_incomes
--     invoice_parts    → invoice_items
--     goods            → assets
--     good_expenses    → assets_expenses
--     expenses         → staff_expenses
--
-- POR QUE TEM VIEW-PONTE. Três aplicações escrevem nessas tabelas e sobem em
-- momentos diferentes: o Control App do US (Vercel, push no master), o Control App
-- do BR (outro projeto) e a LOJA (C:\Users\gz28u\gz28shop-us, que nem remote git
-- tem — sobe por `vercel --prod` rodado da pasta). Sem ponte, existe uma janela em
-- que um deles escreve num nome que não existe mais — e a loja é o pior caso: o
-- insert dela não confere erro e o chamador engole, então pedido PAGO no Stripe
-- viraria invoice sem ITENS e sem RENDA, calado. Com a ponte, o banco muda AGORA e
-- cada app sobe no seu tempo, sem um minuto de app quebrado. A ponte é andaime:
-- cai na onda 5, depois de 48h sem ninguém usar os nomes velhos.
--
-- security_invoker = true é OBRIGATÓRIO: sem ele a view roda como dona e ignora o
-- RLS, reabrindo justamente as portas que fecharam em 11/set. E a ponte NÃO é dada
-- pra chave anon — o RLS fase 1 tirou essas tabelas da anon e assim fica.
--
-- PRÉ-VOO CONFERIDO (PREVOO_pacote_catalogo.sql, 11/set 21:27 Orlando): nenhuma
-- view, nenhuma função e nenhum trigger citam essas tabelas; as 7 FKs sobrevivem ao
-- rename; RLS ligado nas 5, uma política <tabela>_authenticated_all cada.
--
-- Projeto: US  fvgpkbpqacnqxtrjsmpi

begin;

-- ── TRAVA: as 5 existem com o nome velho e nenhuma com o nome novo ──────────────
do $$
declare n int;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 5 then raise exception 'esperava as 5 tabelas com o nome velho, achei %', n; end if;

  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public'
     and c.relname in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');
  if n <> 0 then raise exception 'algum nome NOVO já existe (% objetos) — esta migration já rodou?', n; end if;
end $$;

-- ── 1. OS RENAMES ──────────────────────────────────────────────────────────────
-- Índices, constraints, FKs, sequências e políticas vão junto automaticamente (o
-- Postgres aponta por OID). Só o NOME das constraints e políticas fica velho — a
-- política a gente renomeia abaixo, porque supabase/rls_phase1.sql a monta por nome.
alter table public.invoice_payments rename to invoice_incomes;
alter table public.invoice_parts    rename to invoice_items;
alter table public.goods            rename to assets;
alter table public.good_expenses    rename to assets_expenses;
alter table public.expenses         rename to staff_expenses;

-- ── 2. AS POLÍTICAS VOLTAM A SE CHAMAR COMO A TABELA ───────────────────────────
alter policy "invoice_payments_authenticated_all" on public.invoice_incomes  rename to "invoice_incomes_authenticated_all";
alter policy "invoice_parts_authenticated_all"    on public.invoice_items    rename to "invoice_items_authenticated_all";
alter policy "goods_authenticated_all"            on public.assets           rename to "assets_authenticated_all";
alter policy "good_expenses_authenticated_all"    on public.assets_expenses  rename to "assets_expenses_authenticated_all";
alter policy "expenses_authenticated_all"         on public.staff_expenses   rename to "staff_expenses_authenticated_all";

-- ── 3. AS VIEWS-PONTE, COM O NOME VELHO ────────────────────────────────────────
create view public.invoice_payments with (security_invoker = true) as select * from public.invoice_incomes;
create view public.invoice_parts    with (security_invoker = true) as select * from public.invoice_items;
create view public.goods            with (security_invoker = true) as select * from public.assets;
create view public.good_expenses    with (security_invoker = true) as select * from public.assets_expenses;
create view public.expenses         with (security_invoker = true) as select * from public.staff_expenses;

comment on view public.invoice_payments is 'PONTE (11/set/2026): nome velho de invoice_incomes, enquanto BR e loja não sobem. Cai na onda 5 do pacote.';
comment on view public.invoice_parts    is 'PONTE (11/set/2026): nome velho de invoice_items. Cai na onda 5 do pacote.';
comment on view public.goods            is 'PONTE (11/set/2026): nome velho de assets. Cai na onda 5 do pacote.';
comment on view public.good_expenses    is 'PONTE (11/set/2026): nome velho de assets_expenses. Cai na onda 5 do pacote.';
comment on view public.expenses         is 'PONTE (11/set/2026): nome velho de staff_expenses. Cai na onda 5 do pacote.';

-- A chave pública NÃO entra pela ponte (o RLS fase 1 tirou essas tabelas da anon, e
-- o default privilege do Supabase daria acesso à view recém-criada se a gente
-- deixasse). Quem escreve pela ponte é tela logada (authenticated, com o RLS da
-- tabela-base valendo por causa do security_invoker) e servidor (service_role).
revoke all on public.invoice_payments, public.invoice_parts, public.goods, public.good_expenses, public.expenses from anon;
grant select, insert, update, delete on public.invoice_payments, public.invoice_parts, public.goods, public.good_expenses, public.expenses to authenticated, service_role;

-- ── 4. OS NOMES DE TABELA GUARDADOS COMO DADO ──────────────────────────────────
-- Cinco colunas guardam o nome da tabela como VALOR, e o código faz db.from(<valor>):
-- bank_transactions.matched_table e bank_match_log.matched_table (o Bank Link resolve
-- o ponteiro em app/api/bank/reconcile/route.ts), mail_processed.ref_table e
-- auto_book_mail.booked_table (o AutoBook). Sem isto, 500+ linhas do extrato viram
-- "ponteiro morto" e o DESFAZER quebra.
-- O prefixo 'BR:' aponta para o banco do BR, que NÃO é renomeado: fica intocado.
update bank_transactions set matched_table = case matched_table
  when 'invoice_payments' then 'invoice_incomes' when 'invoice_parts' then 'invoice_items'
  when 'goods' then 'assets' when 'good_expenses' then 'assets_expenses' when 'expenses' then 'staff_expenses' end
where matched_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');

update bank_match_log set matched_table = case matched_table
  when 'invoice_payments' then 'invoice_incomes' when 'invoice_parts' then 'invoice_items'
  when 'goods' then 'assets' when 'good_expenses' then 'assets_expenses' when 'expenses' then 'staff_expenses' end
where matched_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');

update mail_processed set ref_table = case ref_table
  when 'invoice_payments' then 'invoice_incomes' when 'invoice_parts' then 'invoice_items'
  when 'goods' then 'assets' when 'good_expenses' then 'assets_expenses' when 'expenses' then 'staff_expenses' end
where ref_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');

update auto_book_mail set booked_table = case booked_table
  when 'invoice_payments' then 'invoice_incomes' when 'invoice_parts' then 'invoice_items'
  when 'goods' then 'assets' when 'good_expenses' then 'assets_expenses' when 'expenses' then 'staff_expenses' end
where booked_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');

-- data_fixes.table_name é LOG HISTÓRICO e NÃO se reescreve: é o registro do que foi
-- consertado, com o nome que a tabela tinha na hora. Quem lê esse log para montar um
-- DESFAZER (app/adm/check/page.tsx) passa a traduzir pelo mapa no código.

-- ── 5. O PostgREST reaprende o esquema ─────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── CONFERÊNCIA: as 5 novas são TABELA, as 5 velhas são VIEW, nada perdeu linha ──
do $$
declare n int;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('invoice_incomes','invoice_items','assets','assets_expenses','staff_expenses');
  if n <> 5 then raise exception 'as 5 tabelas novas não estão todas lá: %', n; end if;

  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'v'
     and c.relname in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 5 then raise exception 'as 5 pontes não estão todas lá: %', n; end if;

  -- a ponte tem de enxergar a mesma coisa que a tabela (conta feita como service_role,
  -- que não passa pelo RLS — é comparação de conteúdo, não de permissão)
  if (select count(*) from invoice_incomes) <> (select count(*) from invoice_payments) then raise exception 'invoice_incomes x ponte: contagem diferente'; end if;
  if (select count(*) from invoice_items)   <> (select count(*) from invoice_parts)    then raise exception 'invoice_items x ponte: contagem diferente'; end if;
  if (select count(*) from assets)          <> (select count(*) from goods)            then raise exception 'assets x ponte: contagem diferente'; end if;
  if (select count(*) from assets_expenses) <> (select count(*) from good_expenses)    then raise exception 'assets_expenses x ponte: contagem diferente'; end if;
  if (select count(*) from staff_expenses)  <> (select count(*) from expenses)         then raise exception 'staff_expenses x ponte: contagem diferente'; end if;

  select count(*) into n from bank_transactions where matched_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 0 then raise exception 'sobrou ponteiro velho em bank_transactions: %', n; end if;
  select count(*) into n from bank_match_log where matched_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 0 then raise exception 'sobrou ponteiro velho em bank_match_log: %', n; end if;
  select count(*) into n from mail_processed where ref_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 0 then raise exception 'sobrou ponteiro velho em mail_processed: %', n; end if;
  select count(*) into n from auto_book_mail where booked_table in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 0 then raise exception 'sobrou ponteiro velho em auto_book_mail: %', n; end if;
  select count(*) into n from auto_book_mail where booked_table = 'BR:invoice_expenses';
  if n <> 1 then raise exception 'o ponteiro BR:invoice_expenses deveria estar intacto (1), achei %', n; end if;

  -- a chave pública não pode ver a ponte
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('invoice_payments','invoice_parts','goods','good_expenses','expenses');
  if n <> 0 then raise exception 'a ponte ficou aberta pra anon em % permissões', n; end if;
end $$;

commit;
