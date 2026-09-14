-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_pacote_onda8_derruba_views_ponte.sql · US fvgpkbpqacnqxtrjsmpi
--
-- ONDA 8 DO PACOTE PAID FROM/TO: as 5 views-ponte do rename da onda 2 (expenses → staff_expenses, good_expenses → assets_expenses,
-- goods → assets, invoice_parts → invoice_items, invoice_payments → invoice_incomes) saem. Márcio, 14/09/2026 19:25 Orlando: «Agenda e
-- derruba» — medir de novo em 15/09 00:21 (24 h depois do reset do pg_stat_statements em 14/09 00:21) e, com ZERO uso pelo app, derrubar.
-- A TRAVA: conta as chamadas dos nomes velhos no pg_stat_statements por todo papel que não seja postgres/supabase_admin (Management
-- API, medições) — o app fala como service_role/authenticated/anon. Qualquer chamada = exception, nada muda.
-- Nenhuma view depende delas (pg_depend medido em 14/09 19:24). Sem CASCADE, de propósito.
-- VOLTA: ROLLBACK_pacote_onda8_derruba_views_ponte.sql (recria as 5 com a definição, security_invoker e grants de 14/09 19:24).
begin;
set local lock_timeout = '5s';
do $$ declare n bigint; exemplo text; begin
  with alvo(v) as (values ('expenses'), ('good_expenses'), ('goods'), ('invoice_parts'), ('invoice_payments'))
  select coalesce(sum(s.calls), 0), min(left(regexp_replace(s.query, '\s+', ' ', 'g'), 120)) into n, exemplo
    from pg_stat_statements s join pg_roles r on r.oid = s.userid join alvo a on s.query ~* ('(from|join|into|update)\s+("?public"?\.)?"?' || a.v || '"?(\s|$|\)|,)')
   where r.rolname not in ('postgres', 'supabase_admin');
  if n <> 0 then raise exception 'as views-ponte ainda são usadas pelo app (% chamadas, ex.: %) — NÃO derrubo', n, exemplo; end if;
end $$;
drop view if exists public.expenses;
drop view if exists public.good_expenses;
drop view if exists public.goods;
drop view if exists public.invoice_parts;
drop view if exists public.invoice_payments;
notify pgrst, 'reload schema';
commit;
select count(*) as views_ponte_restantes from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'v' and c.relname in ('expenses', 'good_expenses', 'goods', 'invoice_parts', 'invoice_payments');
