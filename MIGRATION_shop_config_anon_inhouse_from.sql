-- shop_inhouse_from (02/11/2026): a loja lê com anon; a policy listava só margem e in-house open
drop policy if exists "anon read" on public.shop_config;
create policy "anon read" on public.shop_config for select to anon
  using (key = any (array['shop_us_margin_pct','shop_inhouse_open','shop_inhouse_from']));
select policyname, qual from pg_policies where tablename='shop_config' and policyname='anon read';
