-- fx_usd_brl_daily (PTAX do dia): leitura para usuário autenticado (o app BR lê pela ponte supabaseUS para estimar em R$
-- a linha que só tem US$ — 26/out/2026). Só leitura; quem grava continua sendo o servidor.
drop policy if exists "authenticated read" on public.fx_usd_brl_daily;
create policy "authenticated read" on public.fx_usd_brl_daily for select to authenticated using (true);
grant select on public.fx_usd_brl_daily to authenticated;
