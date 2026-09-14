-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK_travessia_trava.sql · 14/set/2026
-- Projeto: US  fvgpkbpqacnqxtrjsmpi
-- Rodar:  node scripts/roda-sql.mjs --projeto us --file ROLLBACK_travessia_trava.sql --confirmo
--
-- Desfaz MIGRATION_travessia_trava.sql: tira a tabela public.crossing_locks.
-- ⚠ Sem ela o motor da travessia volta a RECUSAR toda escrita (erro de schema) — é o jeito certo de parar o
--   motor de vez; para só pausar editor e cron, prefira TRAVESSIA_PAUSADA=1 no ambiente da Vercel.
-- RECUSA se houver trava VIVA (menos de 10 minutos): uma rodada está gravando agora — espere e rode de novo.
-- IDEMPOTENTE: sem a tabela, não faz nada.

begin;

set local lock_timeout = '5s';

do $$
declare n int;
begin
  if to_regclass('public.crossing_locks') is null then
    raise notice 'crossing_locks já não existe — nada a desfazer';
    return;
  end if;
  execute 'select count(*) from public.crossing_locks where locked_at > now() - interval ''10 minutes''' into n;
  if n <> 0 then
    raise exception 'há % trava(s) viva(s) em crossing_locks — uma rodada da travessia está gravando; espere 10 minutos', n;
  end if;
  execute 'drop table public.crossing_locks';
end $$;

notify pgrst, 'reload schema';

commit;

-- ── VERIFICAÇÃO (só leitura) ─────────────────────────────────────────────────
select to_regclass('public.crossing_locks') as crossing_locks_depois;   -- null = saiu
