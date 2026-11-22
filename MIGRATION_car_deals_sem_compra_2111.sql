-- CAR DEALS — carro que o exportador vendeu ao cliente SEM compra do GZ28 (CC Sidney, 21/11/2026: Compras 12, 23 e 24).
-- Sem invoice CAR_PURCHASE não havia de onde tirar o carro do deal. UMA fonte só, nunca as duas (lei «uma info, um campo»):
--   purchase_invoice_id  quando o GZ28 comprou o carro (carro e cliente = os da invoice), OU
--   ride_id              quando não há invoice de compra (cliente = o do ride).
alter table public.car_deals add column if not exists ride_id uuid references public.rides(id) on delete set null;
do $$ begin
  alter table public.car_deals add constraint car_deals_uma_fonte_chk check ((purchase_invoice_id is null) <> (ride_id is null));
exception when duplicate_object then null; end $$;
create index if not exists car_deals_ride_idx on public.car_deals (ride_id);
