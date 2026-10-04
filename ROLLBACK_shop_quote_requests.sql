-- ROLLBACK de MIGRATION_shop_quote_requests.sql (04/10/2026). Tira o índice único dos rides SHOP e a tabela do
-- limite de pedidos de cotação da loja. A tabela só guarda o registro dos pedidos (as cotações ficam nas wishlists
-- do cliente e nas SHOP quotes do app). Rodar com --confirmo --eu-sei-que-apaga.
begin;
drop index if exists public.rides_shop_garage_id_unique;
drop table if exists public.shop_quote_requests;
commit;
