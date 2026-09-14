-- VOLTA de MIGRATION_travessia_markup_por_linha_BR.sql. Recusa se alguma despesa já tiver us_markup_pct (apagar o campo mudaria o
-- valor que atravessou). Antes de rodar, tire us_markup_pct de lib/crossing.server.ts (COLUNAS_NOVAS) ou o motor recusa escrever.
begin;
do $$ begin
  if exists (select 1 from public.invoice_expenses where us_markup_pct is not null) then
    raise exception 'há despesas com us_markup_pct — a volta mudaria valores que atravessaram';
  end if;
end $$;
alter table public.invoice_expenses drop constraint if exists invoice_expenses_us_markup_pct_faixa;
alter table public.invoice_expenses drop column if exists us_markup_pct;
notify pgrst, 'reload schema';
commit;
