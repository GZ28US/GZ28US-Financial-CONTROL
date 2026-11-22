-- CAR DEALS — a parte «SIDNEY» vira «CLIENT» = o cliente do deal (Márcio, 21/11/2026, via CC Sidney: «todos os carros que
-- envolvem o GZ28 e o Tripa têm que estar nesta área do app» — carros do próprio Tripa, Viper do Maurício…). Sem coluna
-- nova: quem é o cliente sai da invoice de compra (ou do ride).
alter table public.deal_movements drop constraint if exists deal_movements_from_party_check;
alter table public.deal_movements drop constraint if exists deal_movements_to_party_check;
alter table public.deal_obligations drop constraint if exists deal_obligations_from_party_check;
alter table public.deal_obligations drop constraint if exists deal_obligations_to_party_check;
update public.deal_movements set from_party = 'CLIENT' where from_party = 'SIDNEY';
update public.deal_movements set to_party = 'CLIENT' where to_party = 'SIDNEY';
update public.deal_obligations set from_party = 'CLIENT' where from_party = 'SIDNEY';
update public.deal_obligations set to_party = 'CLIENT' where to_party = 'SIDNEY';
set constraints all immediate;
alter table public.deal_movements add constraint deal_movements_from_party_check check (from_party in ('CLIENT', 'TRIPA_TRADING', 'GZ28US', 'DEALER'));
alter table public.deal_movements add constraint deal_movements_to_party_check check (to_party in ('CLIENT', 'TRIPA_TRADING', 'GZ28US', 'DEALER'));
alter table public.deal_obligations add constraint deal_obligations_from_party_check check (from_party in ('CLIENT', 'TRIPA_TRADING', 'GZ28US', 'DEALER'));
alter table public.deal_obligations add constraint deal_obligations_to_party_check check (to_party in ('CLIENT', 'TRIPA_TRADING', 'GZ28US', 'DEALER'));
