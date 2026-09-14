-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — MIGRATION_bank_mixed_group.sql (US fvgpkbpqacnqxtrjsmpi, 13/set/2026)
-- Tira a coluna bank_transactions.matched_members (os membros do CASAMENTO MISTO, BL 1.6.0).
--
-- ⚠️ RECUSA se ainda existir linha com matched_table = 'mixed_group' (qualquer status): sem a coluna, a linha
-- ficaria apontando pra um grupo sem membros — o pool devolveria os registros como livres e o DESFAZER não
-- saberia o que soltar. DESFAÇA esses casamentos no Bank Link (ação unmatch) antes de rodar isto.
-- ⚠️ O código da BL 1.6.0 segue vivo sem a coluna (lê sem ela); só o match_mixed passa a pedir a migration.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
declare n int;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'matched_members') then
    select count(*) into n from public.bank_transactions where matched_table = 'mixed_group';
    if n > 0 then
      raise exception 'ainda há % linha(s) com matched_table = mixed_group — desfaça no Bank Link antes do rollback', n;
    end if;
  end if;
end $$;

alter table public.bank_transactions drop column if exists matched_members;

commit;

-- CONFERÊNCIA: a coluna saiu.
select count(*) as matched_members_existe
  from information_schema.columns
 where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'matched_members';
