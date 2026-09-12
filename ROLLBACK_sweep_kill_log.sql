-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — MIGRATION_sweep_kill_log.sql (US fvgpkbpqacnqxtrjsmpi, 11/set/2026)
-- Devolve `marketing_kills` ao que era em 11/set: id, account, sender, subject,
-- folder, killed_at. TODAS as linhas continuam na tabela — as 398 medidas às
-- 21:28 de 11/set e as que entrarem depois; o que se perde é só quem moveu e
-- para onde.
--
-- ⚠️ RODE O CÓDIGO DE VOLTA ANTES. Com as colunas fora e o código novo no ar, o
-- insert do `registrarFaxina` falha, e log nunca derruba a faxina: os robôs
-- seguem movendo e-mail. O marketing kill AINDA grava (a rede dele repete o
-- insert no formato antigo quando o erro cita `robot`/`moved_to`), mas os dois
-- sweeps param de deixar linha — de propósito, para não gravar linha sem robô
-- que um backfill futuro batizaria de marketing-kill. Enquanto durar, cada
-- resposta do mail-poll traz `spamLogFalhou`/`marketingLogFalhou` maiores que
-- zero: é o aviso de que a faxina está andando sem rastro.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

drop index if exists public.marketing_kills_robot_idx;

alter table public.marketing_kills
  drop column if exists robot,
  drop column if exists moved_to;

commit;

-- CONFERÊNCIA: as seis colunas originais, e a contagem intacta.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'marketing_kills'
 order by ordinal_position;

select count(*) as linhas from public.marketing_kills;
