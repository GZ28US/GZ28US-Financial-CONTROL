-- ============================================================================
-- GZ28US — RIDES: selo BRAND NEW (0 KM)  (v0.6.2)
-- ----------------------------------------------------------------------------
-- Milhagem sozinha não prova carro novo: 0km chega com 9 mi, outro com 46 mi.
-- O selo é DECLARADO no ride (checkbox no edit); o DESTINY REVIEW usa a
-- declaração primeiro e o teto de 100 mi como conferência do EXPORT — só
-- carro 0km pode ser exportado ao Brasil (lei de importação de usados).
--   true  = 0 km / brand new
--   false = usado (declarado)
--   null  = ainda não informado (rides antigos até alguém salvar o edit)
--
-- COMO RODAR: Supabase dashboard (fvgpkbpqacnqxtrjsmpi) → SQL Editor → Run.
-- ============================================================================

alter table public.rides add column if not exists is_brand_new boolean;

-- ROLLBACK: alter table public.rides drop column if exists is_brand_new;
