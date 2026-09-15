-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_rides_body_style.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi   (o BR tem a MESMA migration no repo dele)
--
-- CARROCERIA GANHA CAMPO PRÓPRIO. Márcio (14/09/2026): «crie um campo novo pra body:
-- Convertible, HardTop, etc., for the cars that have these options» e «prefiro o body
-- separado». Até aqui a carroceria ou não existia (um Corvette 1998 conversível era
-- igual a um cupê) ou vinha costurada na versão/edição especial (Porsche 'Turbo
-- Cabriolet', CTS-V 'Wagon', Eclipse 'Spyder') — os precedentes migram depois, em
-- MIGRATION_body_style_precedentes.sql.
--
-- QUEM LÊ E ESCREVE: app/rides/new, app/rides/edit/[id] (seletor BODY quando o
-- catálogo tem 2+ carrocerias; com 1 só, grava sozinho) e app/rides/[id] (linha BODY).
-- O catálogo é lib/carData.ts → bodyStylesFor(ano, marca, modelo, versão, edição).
--
-- ⚠ ORDEM: roda ANTES do deploy do branch corvette-c5. As telas de criar/editar ride
--   mandam body_style no insert/update; sem a coluna o PostgREST devolve erro e NENHUM
--   ride novo salva (a cotação do Corvette 1998 de 15/09 depende disso).
--
-- Só ADITIVO e idempotente (rodar duas vezes não muda nada). Coluna nula: todos os
-- rides existentes continuam como estão.
-- VOLTA: ROLLBACK_rides_body_style.sql (recusa se algum ride já tiver carroceria).

begin;

set local lock_timeout = '5s';

alter table public.rides add column if not exists body_style text;

comment on column public.rides.body_style is
  'CARROCERIA do carro (14/set/2026, Márcio: «prefiro o body separado»): Coupe, Convertible, Hardtop, Cabriolet, Spyder, Sedan, Wagon… — nome do fabricante, em inglês. Carroceria NÃO vai em version nem em special_edition. Catálogo em lib/carData.ts (bodyStylesFor); null = o catálogo não conhece opções para o carro.';

notify pgrst, 'reload schema';

commit;

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'rides' and column_name = 'body_style';
