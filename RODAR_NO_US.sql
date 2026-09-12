-- ══ COLE ISTO NO EDITOR SQL DO PROJETO **US** — uma vez só ══════════════════
-- ATENÇÃO (11/set/2026): ISTO JÁ RODOU e NÃO é para rodar agora. Fica aqui só como
-- registro do degrau zero do STREAM. Os nomes das tabelas foram atualizados para
-- depois dos cinco renames da onda 2 (goods→assets, good_expenses→assets_expenses,
-- expenses→staff_expenses) porque tudo aqui é idempotente (add column if not exists,
-- create index if not exists) e, se algum dia alguém rodar de novo, tem de bater com
-- o banco de hoje — com o nome velho ele estouraria, ou pior, mexeria na VIEW-PONTE.
-- RESSALVA (conferida na onda 6): "tudo idempotente" vale menos o NOME DA CHECK — o
-- rename não renomeia constraint, então `assets` ainda carrega a `goods_nature_check`
-- da primeira rodada e um rerun criaria uma `assets_nature_check` idêntica ao lado.
-- Mais uma razão para não rodar. O mesmo bloco e a mesma ressalva estão em
-- MIGRATION_item_nature.sql, que é de onde este trecho veio.
-- (1) o degrau zero do STREAM  (2) o elo da linha do espelho

do $$
declare t text;
begin
  foreach t in array array['invoice_expenses','inputs','inventory','assets','assets_expenses','staff_expenses']
  loop
    execute format('alter table public.%I add column if not exists nature text', t);
    execute format($f$
      do $inner$ begin
        if not exists (select 1 from pg_constraint where conname = %L) then
          alter table public.%I add constraint %I
            check (nature is null or nature in ('PART','SERVICE','DIGITAL','CHARGE','MONEY'));
        end if;
      end $inner$;
    $f$, t || '_nature_check', t, t || '_nature_check');
    execute format('create index if not exists %I on public.%I (nature)', 'idx_' || t || '_nature', t);
  end loop;
end $$;

alter table public.suppliers add column if not exists default_nature text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'suppliers_default_nature_check') then
    alter table public.suppliers add constraint suppliers_default_nature_check
      check (default_nature is null or default_nature in ('PART','SERVICE','DIGITAL','CHARGE','MONEY'));
  end if;
end $$;

alter table public.invoice_expenses add column if not exists br_expense_id uuid;
create index if not exists idx_invoice_expenses_br_expense_id
  on public.invoice_expenses (br_expense_id) where br_expense_id is not null;

update public.invoice_expenses set nature='CHARGE'
  where nature is null and btrim(item) in ('Sales Tax','Shipping','Shipping and handling');
update public.assets_expenses set nature='CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');
update public.inputs set nature='CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');

select 'pronto' ok, count(*) linhas, count(nature) classificadas from public.invoice_expenses;
