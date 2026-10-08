-- 08/10/2026 (Parts & Packs): a loja lê a chave 'shop_inhouse_open' (1 = vende 🚗 IN-HOUSE) com a chave anon, igual à margem.
-- Antes a política só deixava o anon ler 'shop_us_margin_pct' — a chave nova lia sempre «fechado».
drop policy if exists "anon read" on public.shop_config;
create policy "anon read" on public.shop_config for select to anon
  using (key in ('shop_us_margin_pct', 'shop_inhouse_open'));
