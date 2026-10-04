-- LOJA US — PEDIDO DE COTAÇÃO: o limite de 1 por cliente a cada 2 minutos mora AQUI (04/10/2026).
-- O HorsePower Builder (www.gz28us.com/shop) só fecha online o Demon 170; nos outros carros o cliente pede cotação
-- (POST /shop/api/quote-request), que avisa o grupo REPORTS. A revisão mostrou que o limite antigo (ler as wishlists
-- e depois gravar) não segurava: dois pedidos ao mesmo tempo passavam, e o cliente podia apagar a própria wishlist
-- para pedir de novo. Aqui o cliente não alcança (RLS ligado, sem policy: só a chave de serviço da loja) e o UNIQUE
-- (cliente, janela de 2 min) faz o banco recusar o segundo pedido da mesma janela — atômico.
--
-- E: um ride SHOP por chave da loja (garagem, placeholder do Demon 170, carro de cotação «car:<user>:<carro>»). Hoje
-- 3 rides SHOP, nenhuma chave repetida (conferido 04/10/2026). Com o UNIQUE, duas sincronizações ao mesmo tempo não
-- criam dois rides para o mesmo carro — a segunda leva erro e relê.
begin;

create table if not exists public.shop_quote_requests (
  id uuid primary key default gen_random_uuid(),
  shop_user_id text not null,            -- o login do cliente no projeto de clientes da loja
  bucket bigint not null,                -- janela de 2 minutos: floor(epoch em ms / 120000)
  car_key text not null,                 -- o carro do builder (lib/cars.ts da loja)
  build text not null,                   -- as peças pedidas
  wishlist_id text,                      -- a wishlist gravada para este pedido
  created_at timestamptz not null default now(),
  constraint shop_quote_requests_one_per_window unique (shop_user_id, bucket)
);
alter table public.shop_quote_requests enable row level security;
revoke all on public.shop_quote_requests from anon, authenticated;
-- Só a chave de serviço da loja (servidor) — nem anon nem authenticated (os logins do Control App) enxergam.
grant select, insert, update, delete on public.shop_quote_requests to service_role;

create unique index if not exists rides_shop_garage_id_unique
  on public.rides (shop_garage_id) where origin = 'SHOP' and shop_garage_id is not null;

commit;
