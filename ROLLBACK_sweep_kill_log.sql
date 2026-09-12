-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — MIGRATION_sweep_kill_log.sql (US fvgpkbpqacnqxtrjsmpi, 11/set/2026)
-- Devolve `marketing_kills` ao que era em 11/set: id, account, sender, subject,
-- folder, killed_at. As 397 linhas antigas e as novas CONTINUAM na tabela; o que
-- se perde é só quem moveu e para onde.
--
-- ⚠️ RODE O CÓDIGO DE VOLTA ANTES. Com as colunas fora e o código novo no ar, o
-- insert do `registrarFaxina` passa a falhar — e ele engole o erro de propósito
-- (log nunca derruba a faxina), então os robôs seguiriam apagando e NENHUMA
-- linha seria gravada, nem a do marketing kill, que hoje grava.
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
