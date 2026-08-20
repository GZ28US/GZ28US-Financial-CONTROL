-- ============================================================================
-- GZ28US — RIDES: ADMISSION MILEAGE  (v0.8.0)
-- ----------------------------------------------------------------------------
-- Milhagem com que o carro ENTROU na GZ28. DELIVERY MILES deixa de ser
-- checkbox e vira fato medido: admission_mileage < 100 = delivery miles =
-- pode ser exportado. >= 100 = usado = NÃO pode ser exportado, nem por nós
-- (GZ28 EXPORT) nem por terceiro (3RD PARTY EXPORT) — lei do 0km.
--
-- rides.is_brand_new (checkbox de ontem) fica APOSENTADA — a coluna
-- permanece por segurança até o deploy assentar; o app não a lê mais.
--
-- COMO RODAR: Supabase dashboard (fvgpkbpqacnqxtrjsmpi) → SQL Editor → Run.
-- ============================================================================

alter table public.rides add column if not exists admission_mileage numeric;

-- Aproveita o selo de ontem se você já marcou algum: 0km marcado vira 0 mi
-- (só onde admission_mileage ainda está vazio — não sobrescreve nada).
update public.rides set admission_mileage = 0
  where is_brand_new = true and admission_mileage is null;

-- ROLLBACK: alter table public.rides drop column if exists admission_mileage;
-- (limpeza futura, quando quiser: alter table public.rides drop column if exists is_brand_new;)
