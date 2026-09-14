-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_travessia_trava.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi   (só o US: todo o motor roda no servidor do US e escreve nos dois bancos)
-- Rodar:  node scripts/roda-sql.mjs --projeto us --file MIGRATION_travessia_trava.sql --confirmo
--
-- A TRAVA POR CHAVE DA TRAVESSIA US ⇄ BR (revisão adversarial de 14/set/2026, achado 1).
-- As escritas de uma chave do motor (lib/crossing.server.ts) não são atômicas: a 085.N/006.N, depois as
-- despesas, depois os itens, depois as rendas e o Pending balance. Com o save do editor e o cron chamando o
-- motor, duas rodadas da MESMA chave podiam se entrelaçar. Antes da primeira escrita, o executarChave entra
-- aqui com a mirror_key (única); quem não entra pula a chave e a próxima rodada tenta. A trava sai no fim
-- da chave; a de uma rodada que morreu no meio (a Vercel corta em 300 s) vence em 10 minutos — o próprio
-- motor apaga a vencida antes de tentar.
--
-- ENQUANTO ESTA TABELA NÃO EXISTIR, O MOTOR NÃO GRAVA NADA: o plano (GET /api/crossing) funciona e acusa
-- «faltam: crossing_locks.mirror_key»; sincronizar/applyPlan recusam com erro de schema. Rode ANTES do deploy.
--
-- SÓ A CHAVE DE SERVIÇO ENTRA: RLS ligado e nenhuma policy — anon e authenticated não leem nem escrevem
-- (a chave de serviço passa por cima do RLS). Nada no navegador toca nesta tabela.
--
-- ADITIVO e IDEMPOTENTE: rodar duas vezes não muda nada.
-- VOLTA: ROLLBACK_travessia_trava.sql

begin;

set local lock_timeout = '5s';

create table if not exists public.crossing_locks (
  mirror_key text primary key,
  holder     text not null,
  locked_at  timestamptz not null default now()
);

comment on table public.crossing_locks is
  'TRAVESSIA US⇄BR (14/set/2026): trava por chave do motor lib/crossing.server.ts — uma linha enquanto uma rodada grava aquela mirror_key. Vence em 10 minutos. Só a chave de serviço.';
comment on column public.crossing_locks.holder is 'uuid aleatório da rodada que segura a trava — só ela a solta';

alter table public.crossing_locks enable row level security;

-- Nenhuma policy de propósito. Se alguma tiver sido criada à mão, a conferência abaixo recusa.
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'crossing_locks' and column_name in ('mirror_key', 'holder', 'locked_at');
  if n <> 3 then raise exception 'esperava as 3 colunas de crossing_locks, achei %', n; end if;

  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'crossing_locks' and c.relrowsecurity;
  if n <> 1 then raise exception 'crossing_locks ficou sem RLS'; end if;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'crossing_locks';
  if n <> 0 then raise exception 'crossing_locks tem % policy(ies) — a trava é só da chave de serviço', n; end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- ── VERIFICAÇÃO (só leitura, depois do commit) ────────────────────────────────
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'crossing_locks' order by ordinal_position;
select relrowsecurity as rls_ligado from pg_class where oid = 'public.crossing_locks'::regclass;
select count(*) as travas_agora from public.crossing_locks;
