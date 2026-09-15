-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_body_style_precedentes.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi   (o BR tem a sua, com a contagem dele)
--
-- A CARROCERIA SAI DA VERSÃO E DA EDIÇÃO NOS RIDES QUE JÁ EXISTIAM. Márcio (14/09/2026):
-- «prefiro o body separado». O catálogo (lib/carData.ts, branch corvette-c5) já tirou a
-- carroceria dos nomes; aqui os rides gravados com o nome antigo ganham rides.body_style
-- e a versão/edição nova:
--   Porsche 911   'Turbo Coupe/Cabriolet 3.6 H6'                → 'Turbo 3.6 H6'          + Coupe/Cabriolet
--   BMW M5        'E60 Sedan' · 'E61 Touring' · 'F10 Sedan'     → 'E60' · 'E61' · 'F10'   + Sedan/Touring
--   S63 AMG       'V222 Sedan' · 'C217 Coupe' · 'A217 Cabriolet' → só o chassi            + Sedan/Coupe/Cabriolet
--   CTS-V         edição 'Coupe' / 'Wagon'                       → edição vazia            + Coupe/Wagon
--   Eclipse       edição 'Spyder'                                → edição vazia            + Spyder
--   Firebird      edição 'GTA Notchback'                         → edição vazia            + Notchback
-- Edição VAZIA não diz carroceria (pode ser o sedã do CTS-V ou só um campo não
-- preenchido) — esses rides ficam como estão; a tela pede o BODY na próxima edição.
--
-- MEDIDO em 14/09/2026 22:34 Orlando (roda-sql --pergunta): 0 ride(s) neste app.
--   (nenhum — o US não tem 911, M5, S63 AMG, Eclipse Spyder, GTA Notchback nem CTS-V Coupe/Wagon; o único CTS-V,
--    US.036, está sem edição, e edição vazia não diz carroceria — fica como está)
-- Fora dos rides, NADA guarda esses nomes: packs.cars / packs.model, duty_events.car_label,
-- supplier_orders.car_label e quote_backups.snapshot deram 0 no US; duty_events e
-- quote_backups deram 0 no BR. No código dos 2 apps só lib/carData.ts os cita.
--
-- ⚠ ORDEM: depois de MIGRATION_rides_body_style.sql (precisa da coluna) e junto do deploy
--   do catálogo novo. FALHA FECHADA: contagem diferente da medida, ride diferente do medido,
--   body_style já preenchido ou regra casando duas vezes → nada é escrito.
-- TRILHA: data_fixes, check_key 'body-style-precedentes' (campo antigo e body_style, um
-- registro por campo, gravado ANTES do UPDATE).
-- VOLTA: ROLLBACK_body_style_precedentes.sql

begin;

set local lock_timeout = '5s';
lock table public.rides in share row exclusive mode;

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'rides' and column_name = 'body_style') then
    raise exception 'rides.body_style não existe — rode antes MIGRATION_rides_body_style.sql; nada foi escrito';
  end if;
  if exists (select 1 from public.data_fixes where check_key = 'body-style-precedentes') then
    raise exception 'a trilha body-style-precedentes já existe — esta migration já rodou; nada foi escrito';
  end if;
end $$;

-- O DE → PARA do catálogo. campo = a coluna que carregava a carroceria.
create temp table de_para (model text not null, campo text not null, de text not null, para text, body text not null,
  primary key (model, campo, de)) on commit drop;
insert into de_para (model, campo, de, para, body) values
  ('911', 'version', 'Turbo Coupe 3.6 H6', 'Turbo 3.6 H6', 'Coupe'),
  ('911', 'version', 'Turbo Cabriolet 3.6 H6', 'Turbo 3.6 H6', 'Cabriolet'),
  ('M5', 'version', 'E60 Sedan 5.0 V10', 'E60 5.0 V10', 'Sedan'),
  ('M5', 'version', 'E61 Touring 5.0 V10', 'E61 5.0 V10', 'Touring'),
  ('M5', 'version', 'F10 Sedan 4.4 TT V8', 'F10 4.4 TT V8', 'Sedan'),
  ('S63 AMG', 'version', 'V222 Sedan 5.5 TT V8 4MATIC', 'V222 5.5 TT V8 4MATIC', 'Sedan'),
  ('S63 AMG', 'version', 'V222 Sedan 4.0 TT V8 4MATIC+', 'V222 4.0 TT V8 4MATIC+', 'Sedan'),
  ('S63 AMG', 'version', 'C217 Coupe 5.5 TT V8 4MATIC', 'C217 5.5 TT V8 4MATIC', 'Coupe'),
  ('S63 AMG', 'version', 'C217 Coupe 4.0 TT V8 4MATIC+', 'C217 4.0 TT V8 4MATIC+', 'Coupe'),
  ('S63 AMG', 'version', 'A217 Cabriolet 5.5 TT V8 4MATIC', 'A217 5.5 TT V8 4MATIC', 'Cabriolet'),
  ('S63 AMG', 'version', 'A217 Cabriolet 4.0 TT V8 4MATIC+', 'A217 4.0 TT V8 4MATIC+', 'Cabriolet'),
  ('CTS-V', 'special_edition', 'Coupe', null, 'Coupe'),
  ('CTS-V', 'special_edition', 'Wagon', null, 'Wagon'),
  ('ECLIPSE', 'special_edition', 'Spyder', null, 'Spyder'),
  ('FIREBIRD', 'special_edition', 'GTA Notchback', null, 'Notchback');

-- Os rides medidos.
create temp table medidos (id uuid primary key, code text not null, campo text not null, de text not null) on commit drop;
-- (nenhum ride medido neste app)

create temp table plano on commit drop as
  select r.id, r.project_code, d.campo, d.de, d.para, d.body, r.body_style as body_antes
    from public.rides r
    join de_para d on d.model = r.model
     and ((d.campo = 'version' and r.version = d.de) or (d.campo = 'special_edition' and r.special_edition = d.de));

do $$
declare n int;
begin
  select count(*) into n from plano;
  if n <> 0 then raise exception 'esperava 0 ride(s) com carroceria na versão/edição (medido 14/09 22:34 Orlando), achei % — nada escrito; meça de novo', n; end if;
  select count(*) into n from plano p join medidos m on m.id = p.id and m.campo = p.campo and m.de = p.de;
  if n <> 0 then raise exception 'os rides não são os medidos (% de 0 batem) — nada escrito', n; end if;
  select count(*) into n from plano where body_antes is not null;
  if n <> 0 then raise exception '% ride(s) já têm body_style — nada escrito', n; end if;
  select count(*) into n from (select id from plano group by id having count(*) > 1) x;
  if n <> 0 then raise exception '% ride(s) casaram com mais de uma regra — nada escrito', n; end if;
end $$;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'body-style-precedentes', 'rides', p.id::text, p.campo, p.de, p.para,
       'carroceria sai da ' || case when p.campo = 'version' then 'versão' else 'edição especial' end || ' · ' || p.project_code || ' (14/set)'
  from plano p;
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'body-style-precedentes', 'rides', p.id::text, 'body_style', null, p.body,
       'carroceria ganha campo próprio · ' || p.project_code || ' (14/set)'
  from plano p;

update public.rides r set version = p.para, body_style = p.body
  from plano p where r.id = p.id and p.campo = 'version' and r.version = p.de and r.body_style is null;
update public.rides r set special_edition = null, body_style = p.body
  from plano p where r.id = p.id and p.campo = 'special_edition' and r.special_edition = p.de and r.body_style is null;

do $$
declare n int;
begin
  select count(*) into n from plano p join public.rides r on r.id = p.id and r.body_style = p.body
     and ((p.campo = 'version' and r.version = p.para) or (p.campo = 'special_edition' and r.special_edition is null));
  if n <> 0 then raise exception 'depois da escrita só % de 0 ride(s) ficaram certos', n; end if;
  select count(*) into n from public.rides r join de_para d on d.model = r.model
     and ((d.campo = 'version' and r.version = d.de) or (d.campo = 'special_edition' and r.special_edition = d.de));
  if n <> 0 then raise exception 'ainda sobraram % ride(s) com o nome antigo', n; end if;
end $$;

commit;

-- ── VERIFICAÇÃO (só leitura) ──
select r.project_code, r.year, r.model, r.version, r.special_edition, r.body_style
  from public.rides r where r.id::text in (select row_id from public.data_fixes where check_key = 'body-style-precedentes')
 order by r.project_code;
select field, count(*) from public.data_fixes where check_key = 'body-style-precedentes' group by field;
