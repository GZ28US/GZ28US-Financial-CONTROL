-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_cotacao_usd_brl_diaria.sql · 14/set/2026 · Projeto: US fvgpkbpqacnqxtrjsmpi
--
-- O BID DIÁRIO USD-BRL GUARDADO NO BANCO. O motor da travessia (lib/crossing.server.ts) carimba o câmbio pela regra do app
-- — (bid do dia + R$ 0,20) × 1,0638 — onde falta valor gravado. Em produção, 14/set 10:21 e 10:24, a AwesomeAPI devolveu
-- HTTP 429 para o IP compartilhado da Vercel e 39 datas ficaram sem cotação (128 conflitos). Dia fechado nunca muda de
-- cotação: fica guardado aqui e o motor só pede à API o que falta.
--
-- dia  = o dia em America/Sao_Paulo do registro de timestamp mais tarde da AwesomeAPI (json/daily/USD-BRL) — a MESMA régua
--        de carregarCotacoes. bid null = dia lido sem pregão (fim de semana, feriado).
-- Só dia FECHADO entra (o de hoje ainda muda). Linha gravada não é reescrita (upsert ignoreDuplicates).
-- RLS ligado e nenhuma policy: só a chave de serviço lê e grava.
-- VOLTA: ROLLBACK_cotacao_usd_brl_diaria.sql
begin;
set local lock_timeout = '5s';

create table if not exists public.fx_usd_brl_daily (
  dia        date primary key,
  bid        numeric,
  ts         bigint,
  fonte      text not null default 'AwesomeAPI json/daily/USD-BRL',
  gravado_em timestamptz not null default now(),
  constraint fx_usd_brl_daily_bid_positivo check (bid is null or bid > 0)
);
comment on table public.fx_usd_brl_daily is
  'TRAVESSIA US⇄BR (14/set/2026): bid diário USD-BRL da AwesomeAPI por dia de São Paulo (fechamento). bid null = sem pregão. Só dia fechado. Lido e gravado por lib/crossing.server.ts.';

alter table public.fx_usd_brl_daily enable row level security;

do $$
declare n int;
begin
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'fx_usd_brl_daily';
  if n <> 0 then raise exception 'fx_usd_brl_daily tem % policy(ies) — é só da chave de serviço', n; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'fx_usd_brl_daily' and c.relrowsecurity;
  if n <> 1 then raise exception 'fx_usd_brl_daily ficou sem RLS'; end if;
end $$;

notify pgrst, 'reload schema';
commit;

select count(*) as dias_guardados from public.fx_usd_brl_daily;
