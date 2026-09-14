-- VOLTA de MIGRATION_cotacao_usd_brl_diaria.sql. A tabela é só cache de cotação pública (nenhum dado do app mora nela):
-- apagar não perde nada — o motor volta a pedir tudo à AwesomeAPI.
begin;
drop table if exists public.fx_usd_brl_daily;
notify pgrst, 'reload schema';
commit;
