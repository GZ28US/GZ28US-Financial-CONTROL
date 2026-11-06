-- ROLLBACK de MIGRATION_quote_portal_fixture.sql (06/11/2026): tira a função de limpeza do teste.
begin;
drop function if exists public.fixture_delete(uuid, text);
commit;
