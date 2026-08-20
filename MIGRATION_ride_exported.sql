-- ============================================================================
-- GZ28US — RIDES: status EXPORTED  (v0.9.0)
-- ----------------------------------------------------------------------------
-- Fim do ciclo de um carro de exportação: embarcou. Num GZ28 EXPORT isso
-- significa que o carro NÃO ESTÁ MAIS no nome da GZ28US — vira ride da
-- GZ28BR. O custo do job sai do WIP do Balanço (trabalho entregue) e o
-- ride ganha o selo EXPORTED.
--
-- COMO RODAR: Supabase dashboard (fvgpkbpqacnqxtrjsmpi) → SQL Editor → Run.
-- ============================================================================

alter table public.rides add column if not exists exported boolean not null default false;

-- ROLLBACK: alter table public.rides drop column if exists exported;
