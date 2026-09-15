-- VOLTA ATRÁS DA MIGRATION_body_style_precedentes.sql (14/set/2026).
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
--
-- Lê a trilha 'body-style-precedentes' em data_fixes e devolve cada ride ao nome antigo
-- (versão com a carroceria dentro, ou a edição 'Coupe'/'Wagon'/'Spyder'/'GTA Notchback') e
-- body_style a NULL — só onde o ride AINDA tem o que a migration gravou (quem foi editado
-- depois fica, e a volta avisa quantos). A trilha não é apagada: a volta ganha registros
-- próprios com check_key 'body-style-precedentes-volta'.
-- ⚠ Voltar os nomes sem voltar o catálogo (lib/carData.ts) deixa esses rides com versão
--   fora da lista — a tela ainda mostra (ensureIncluded), mas o seletor de edição/cores
--   perde a referência. Volte os dois juntos.

begin;

set local lock_timeout = '5s';
lock table public.rides in share row exclusive mode;

create temp table volta on commit drop as
  select c.row_id, c.field as campo, c.old_value as de, c.new_value as para, b.new_value as body
    from public.data_fixes c
    join public.data_fixes b on b.check_key = c.check_key and b.row_id = c.row_id and b.field = 'body_style'
   where c.check_key = 'body-style-precedentes' and c.table_name = 'rides' and c.field in ('version', 'special_edition');

create temp table ainda on commit drop as
  select v.* from volta v join public.rides r on r.id::text = v.row_id and r.body_style = v.body
     and ((v.campo = 'version' and r.version = v.para) or (v.campo = 'special_edition' and r.special_edition is null));

do $$
declare n int; m int;
begin
  if not exists (select 1 from public.data_fixes where check_key = 'body-style-precedentes') then
    raise exception 'a trilha body-style-precedentes não existe — a migration não rodou; nada a voltar';
  end if;
  if exists (select 1 from public.data_fixes where check_key = 'body-style-precedentes-volta') then
    raise exception 'a volta já rodou (trilha body-style-precedentes-volta existe)';
  end if;
  select count(*) into n from volta;
  select count(*) into m from ainda;
  if m <> n then raise notice '% de % ride(s) foram editados depois da migration e ficam como estão', n - m, n; end if;
end $$;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'body-style-precedentes-volta', 'rides', a.row_id, a.campo, a.para, a.de, 'volta da carroceria (14/set)' from ainda a;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'body-style-precedentes-volta', 'rides', a.row_id, 'body_style', a.body, null, 'volta da carroceria (14/set)' from ainda a;

update public.rides r set version = a.de, body_style = null
  from ainda a where r.id::text = a.row_id and a.campo = 'version';
update public.rides r set special_edition = a.de, body_style = null
  from ainda a where r.id::text = a.row_id and a.campo = 'special_edition';

commit;

select r.project_code, r.year, r.model, r.version, r.special_edition, r.body_style
  from public.rides r where r.id::text in (select row_id from public.data_fixes where check_key = 'body-style-precedentes')
 order by r.project_code;
