-- ENXUGAR, tabela antiga (OK do Márcio em 21/11/2026: «do what you have to do»).
-- invoices.fl_tax_refund_date: NUNCA preenchida (0 de 216 linhas, conferido antes de rodar), sem nenhuma referência no
-- código do US, do BR nem da loja (gz28shop-us), sem view, função ou índice em cima. Sai.
-- FICAM (conferido): invoices.shop_wishlist_id / shop_order_id e rides.shop_garage_id — vazias hoje, mas são as chaves
-- que o site da loja (gz28shop-us/lib/opsWrite.ts, stripe-webhook) lê e grava, com índice único; não são duplicata.
alter table public.invoices drop column if exists fl_tax_refund_date;
