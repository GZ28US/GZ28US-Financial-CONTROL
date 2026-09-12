-- VOLTA ATRÁS DA ONDA 9 (a regra dos campos). Lê a trilha da própria onda em data_fixes
-- (check_key 'pacote-paid-from-to', rótulo começando com 'onda 9 ·'): nenhum VALOR é
-- reconstruído de memória. Rodar inteiro, numa transação só.
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Serve com QUALQUER código no ar: o código da onda 9 não lê paid_from dessas tabelas, e
-- devolver uma coluna não quebra quem não a pede; o código de antes volta a achá-la.
--
-- A expressão da GERADA com a perna do CLIENT vai escrita aqui, e NÃO executada a partir do
-- texto guardado na trilha: data_fixes é gravável pela tela logada, e rodar como `postgres` um
-- DDL montado com texto de tabela seria entregar o banco a quem escrevesse nela. A trilha
-- confere; não comanda.
--
-- ⚠ Rode ANTES do ROLLBACK da onda 1, nunca depois: aquele apaga toda a trilha
--   'pacote-paid-from-to', inclusive a desta onda, e aí esta volta não teria de onde ler.
-- ⚠ A ordem das colunas não volta a ser a de antes (paid_from e base_tributavel vão pro fim
--   da tabela). O app lê por nome; não muda nada.

begin;

set local lock_timeout = '5s';
lock table public.invoice_items, public.invoice_incomes in access exclusive mode;

-- ── TRAVA: a onda 9 rodou e a trilha dela está inteira ──────────────────────────────────────
do $$
declare n int; expr text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('invoice_items', 'invoice_incomes') and column_name = 'paid_from';
  if n <> 0 then raise exception 'paid_from ainda existe em % tabela(s) — a onda 9 não rodou (ou já voltou)', n; end if;

  select pg_get_expr(d.adbin, d.adrelid) into expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel' and a.attgenerated = 's';
  if expr is null or expr ~* 'client' then raise exception 'base_tributavel não está como a onda 9 deixou: %', coalesce(expr, '(não achei a gerada)'); end if;

  select count(*) into n from data_fixes
   where check_key = 'pacote-paid-from-to' and label like 'onda 9 ·%' and table_name = 'invoice_items' and row_id = '(coluna gerada)' and old_value ~* 'client';
  if n <> 1 then raise exception 'trilha da GERADA da onda 9: esperava 1 linha, achei %', n; end if;

  select count(*) into n from data_fixes
   where check_key = 'pacote-paid-from-to' and label like 'onda 9 ·%' and table_name = 'invoice_incomes' and field = 'paid_from';
  if n = 0 then raise exception 'a trilha do paid_from das rendas sumiu — sem ela os 23 valores não voltam'; end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v' and c.relname in ('invoice_parts', 'invoice_payments');
  if n <> 2 then raise exception 'esperava as duas pontes de pé, achei %', n; end if;
end $$;

create temp table onda9_volta_itens on commit drop as
  select id, base_tributavel, total from public.invoice_items;

-- ── 1. as pontes caem (voltam no passo 5) ───────────────────────────────────────────────────
drop view public.invoice_parts;
drop view public.invoice_payments;

-- ── 2. invoice_items: paid_from volta (vazio em todas, como estava), com o índice, e a GERADA
--       volta com a perna do CLIENT — a expressão medida no PREVOO_pacote_catalogo.sql ─────────
alter table public.invoice_items add column paid_from text;
create index invoice_parts_paid_from_idx on public.invoice_items using btree (paid_from);
alter table public.invoice_items drop column base_tributavel;
alter table public.invoice_items add column base_tributavel numeric
  generated always as (
    case when upper(coalesce(paid_from, '')) = 'CLIENT' then 0::numeric
         else coalesce(unit_price, 0) * coalesce(quantity, 1) end
  ) stored;

-- ── 3. invoice_incomes: paid_from volta com os valores da trilha; a descrição volta ao que era,
--       só onde ninguém a mexeu depois da onda ────────────────────────────────────────────────
alter table public.invoice_incomes add column paid_from text;

update public.invoice_incomes i set paid_from = f.old_value
  from data_fixes f
 where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
   and f.table_name = 'invoice_incomes' and f.field = 'paid_from' and f.row_id = i.id::text;

update public.invoice_incomes i set description = f.old_value, updated_at = now()
  from data_fixes f
 where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
   and f.table_name = 'invoice_incomes' and f.field = 'description' and f.row_id = i.id::text
   and i.description is not distinct from f.new_value;

-- ── 4. o seguro do Jeferson volta a paid_to GZ28BR (US$ 89,09 voltam a ficar fora da conta
--       corrente) — só se ainda estiver como a onda deixou ──────────────────────────────────
update public.staff_expenses e set paid_to = f.old_value, updated_at = now()
  from data_fixes f
 where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%'
   and f.table_name = 'staff_expenses' and f.field = 'paid_to' and f.row_id = e.id::text
   and e.paid_to = f.new_value;

-- ── 5. as pontes voltam, com o texto e as permissões da onda 2 ──────────────────────────────
create view public.invoice_parts    with (security_invoker = true) as select * from public.invoice_items;
create view public.invoice_payments with (security_invoker = true) as select * from public.invoice_incomes;

comment on view public.invoice_payments is 'PONTE (11/set/2026): nome velho de invoice_incomes, enquanto BR e loja não sobem. Cai na onda 5 do pacote.';
comment on view public.invoice_parts    is 'PONTE (11/set/2026): nome velho de invoice_items. Cai na onda 5 do pacote.';

revoke all on public.invoice_parts, public.invoice_payments from anon;
grant select, insert, update, delete on public.invoice_parts, public.invoice_payments to authenticated, service_role;

notify pgrst, 'reload schema';

-- ── CONFERÊNCIA ─────────────────────────────────────────────────────────────────────────────
do $$
declare n int; s numeric; s0 numeric; expr text; ponte text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('invoice_items', 'invoice_incomes', 'invoice_parts', 'invoice_payments') and column_name = 'paid_from';
  if n <> 4 then raise exception 'paid_from devia estar nas 2 tabelas e nas 2 pontes, está em %', n; end if;

  select pg_get_expr(d.adbin, d.adrelid) into expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.invoice_items'::regclass and a.attname = 'base_tributavel' and a.attgenerated = 's';
  if expr is null or expr !~* 'client' or expr !~* 'paid_from' then raise exception 'a GERADA não voltou com a perna do CLIENT: %', coalesce(expr, '(sumiu)'); end if;

  -- a base não mexe um centavo, linha a linha (paid_from volta vazio nos itens)
  select count(*) into n from invoice_items i join onda9_volta_itens b on b.id = i.id
   where i.base_tributavel = b.base_tributavel and i.total is not distinct from b.total;
  if n <> (select count(*) from onda9_volta_itens) or n <> (select count(*) from invoice_items) then raise exception 'base_tributavel/total mudaram em alguma linha na volta (% iguais)', n; end if;
  select coalesce(sum(base_tributavel), 0) into s from invoice_items;
  select coalesce(sum(base_tributavel), 0) into s0 from onda9_volta_itens;
  if s <> s0 then raise exception 'soma de base_tributavel mudou na volta: % → %', s0, s; end if;

  -- os valores de paid_from das rendas voltaram, um por um
  select count(*) into n from data_fixes f join invoice_incomes i on i.id::text = f.row_id
   where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%' and f.table_name = 'invoice_incomes' and f.field = 'paid_from'
     and i.paid_from is distinct from f.old_value;
  if n <> 0 then raise exception '% renda(s) não recuperaram o paid_from da trilha', n; end if;
  -- (renda apagada depois da onda não tem para onde voltar: conta só as que ainda existem)
  select count(*) into n from invoice_incomes where paid_from is not null;
  if n <> (select count(*) from data_fixes f join invoice_incomes i on i.id::text = f.row_id
            where f.check_key = 'pacote-paid-from-to' and f.label like 'onda 9 ·%' and f.table_name = 'invoice_incomes' and f.field = 'paid_from') then
    raise exception 'rendas com paid_from (%) não batem com a trilha', n;
  end if;

  -- pontes: view, security_invoker, anon fora, tela logada e servidor dentro
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v' and c.relname in ('invoice_parts', 'invoice_payments')
     and 'security_invoker=true' = any(coalesce(c.reloptions, '{}'));
  if n <> 2 then raise exception 'as pontes não voltaram com security_invoker (achei %)', n; end if;
  foreach ponte in array array['public.invoice_parts', 'public.invoice_payments'] loop
    if has_table_privilege('anon', ponte, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'a ponte % ficou aberta pra anon', ponte;
    end if;
    if not (has_table_privilege('authenticated', ponte, 'SELECT') and has_table_privilege('authenticated', ponte, 'INSERT')
        and has_table_privilege('authenticated', ponte, 'UPDATE') and has_table_privilege('authenticated', ponte, 'DELETE')
        and has_table_privilege('service_role', ponte, 'SELECT') and has_table_privilege('service_role', ponte, 'INSERT')
        and has_table_privilege('service_role', ponte, 'UPDATE') and has_table_privilege('service_role', ponte, 'DELETE')) then
      raise exception 'a ponte % ficou sem permissão para authenticated/service_role', ponte;
    end if;
  end loop;
end $$;

-- ── 6. a trilha da onda 9 some por último — ela foi a prova do que voltou. Confira antes:
--    select * from data_fixes where check_key = 'pacote-paid-from-to' and label like 'onda 9 ·%' order by fixed_at;
delete from data_fixes where check_key = 'pacote-paid-from-to' and label like 'onda 9 ·%';

commit;
