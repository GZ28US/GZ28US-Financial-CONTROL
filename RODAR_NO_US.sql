-- ══ COLE ISTO NO EDITOR SQL DO PROJETO **US** — uma vez só ══════════════════
-- (1) o degrau zero do STREAM  (2) o elo da linha do espelho

do $$
declare t text;
begin
  foreach t in array array['invoice_expenses','inputs','inventory','goods','good_expenses','expenses']
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
update public.good_expenses set nature='CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');
update public.inputs set nature='CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');

select 'pronto' ok, count(*) linhas, count(nature) classificadas from public.invoice_expenses;
