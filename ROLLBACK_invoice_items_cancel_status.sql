-- VOLTA ATRÁS DA MIGRATION_invoice_items_cancel_status.sql (14/set/2026).
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Tira invoice_items.cancel_status e a trava. RECUSA se algum item já estiver marcado: derrubar a coluna faria o item
-- estornado voltar a cobrar em silêncio (grand total, pending balance e a conta US⇄BR subiriam sem trilha).
-- Nesse caso desmarque antes, com trilha em data_fixes, e só então rode esta volta.
-- ⚠ Antes de rodar, volte o código que pede invoice_items.cancel_status no select (branch estorno-controles) — sem a
--   coluna o PostgREST devolve 400 nas telas que a pedem.

begin;

set local lock_timeout = '5s';

do $$
declare n int;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'cancel_status') then
    execute 'select count(*) from public.invoice_items where cancel_status is not null' into n;
    if n <> 0 then
      raise exception 'há % item(ns) marcado(s) CANCELLED/REFUNDED — desmarque com trilha antes; nada foi derrubado', n;
    end if;
  end if;
end $$;

alter table public.invoice_items drop constraint if exists invoice_items_cancel_status_chk;
alter table public.invoice_items drop column if exists cancel_status;

notify pgrst, 'reload schema';

commit;

select count(*) sobrou_coluna from information_schema.columns
 where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'cancel_status';
