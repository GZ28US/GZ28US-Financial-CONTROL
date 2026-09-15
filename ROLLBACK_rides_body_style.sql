-- VOLTA ATRÁS DA MIGRATION_rides_body_style.sql (14/set/2026).
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Tira rides.body_style. RECUSA se algum ride já tiver carroceria gravada: derrubar a
-- coluna apagaria em silêncio o que foi escolhido na tela. Nesse caso, zere antes com
-- trilha (ou não volte).
-- ⚠ Antes de rodar, volte o código que manda body_style no insert/update dos rides
--   (branch corvette-c5) — sem a coluna nenhum ride salva.

begin;

set local lock_timeout = '5s';

do $$
declare n int;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'rides' and column_name = 'body_style') then
    execute 'select count(*) from public.rides where body_style is not null' into n;
    if n <> 0 then
      raise exception 'há % ride(s) com body_style preenchido — nada foi derrubado', n;
    end if;
  end if;
end $$;

alter table public.rides drop column if exists body_style;

notify pgrst, 'reload schema';

commit;

select count(*) sobrou_coluna from information_schema.columns
 where table_schema = 'public' and table_name = 'rides' and column_name = 'body_style';
