-- PARTS UNTANGLE — origem, estado e forma em campos separados (24/ago/2026,
-- decisão João+Márcio: "untangle, let's make it perfect"). Idempotente.
-- ⚠️ RODAR SÓ DEPOIS do deploy que tolera os dois formatos (o app já está no ar).
--
-- Antes: source_type misturava ORIGEM (SCAN/HUNT/MANUAL/INVOICE), ESTADO
-- (LOCKED) e FORMA (KIT). Depois: source_type = só origem; cadeado = locked_at/
-- locked_by; kit = is_kit. Nada se perde — o LOCKED vira locked_at com autor
-- 'legacy', o KIT vira is_kit.

-- 1) Estado sai do source_type
update public.parts_database
   set locked_at = coalesce(locked_at, updated_at, created_at, now()),
       locked_by = coalesce(locked_by, 'legacy (era source_type LOCKED)')
 where source_type = 'LOCKED';
update public.parts_database set source_type = 'MANUAL' where source_type = 'LOCKED';

-- 2) Forma sai do source_type
update public.parts_database set is_kit = true where source_type = 'KIT';
update public.parts_database set source_type = 'MANUAL' where source_type = 'KIT';

-- 3) Órfãs ganham origem
update public.parts_database set source_type = 'MANUAL' where source_type is null;

-- 4) Vocabulário fechado daqui pra frente
alter table public.parts_database drop constraint if exists parts_database_source_type_check;
alter table public.parts_database add constraint parts_database_source_type_check
  check (source_type in ('SCAN', 'HUNT', 'MANUAL', 'INVOICE'));

-- 5) Categorias existentes normalizadas (mapa determinístico; as 650 vazias
--    entram pelo card do Data Checker com sugestão + martelo humano)
update public.parts_database set category = 'WHEELS & TIRES' where category in ('Wheels', 'Tires');
update public.parts_database set category = 'ENGINE'         where category in ('Engine', 'Air Intake');
update public.parts_database set category = 'FUEL SYSTEM'    where category in ('Fuel System', 'FUEL');
update public.parts_database set category = 'EXHAUST'        where category in ('Exhaust');
