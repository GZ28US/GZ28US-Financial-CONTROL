-- Volta do MIGRATION_car_deals_parte_cliente_2111.sql (CLIENT → SIDNEY). Só faz sentido com o código anterior.
alter table public.deal_movements drop constraint if exists deal_movements_from_party_check;
alter table public.deal_movements drop constraint if exists deal_movements_to_party_check;
alter table public.deal_obligations drop constraint if exists deal_obligations_from_party_check;
alter table public.deal_obligations drop constraint if exists deal_obligations_to_party_check;
update public.deal_movements set from_party = 'SIDNEY' where from_party = 'CLIENT';
update public.deal_movements set to_party = 'SIDNEY' where to_party = 'CLIENT';
update public.deal_obligations set from_party = 'SIDNEY' where from_party = 'CLIENT';
update public.deal_obligations set to_party = 'SIDNEY' where to_party = 'CLIENT';
