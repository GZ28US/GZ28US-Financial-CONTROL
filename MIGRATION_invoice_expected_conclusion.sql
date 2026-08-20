-- ============================================================================
-- GZ28US — INVOICES: EXPECTED CONCLUSION DATE  (FIN v0.10.0)
-- ----------------------------------------------------------------------------
-- Ideia do Márcio (20/ago): a PREVISÃO ganha campo próprio. Até aqui o
-- delivery_date fazia papel duplo — promessa enquanto a invoice está aberta
-- (banner PROMISED TO) e fato depois. Agora:
--   expected_conclusion_date  PREVISÃO de conclusão (promessa ao cliente;
--                             projeção pro FUTURE flow; régua do ATRASADA/
--                             ADIANTADA)
--   conclusion_date           FATO: trabalho terminou
--   delivery_date             FATO: carro saiu da GZ28US
--
-- A migração move a promessa pra casa nova: invoice ABERTA (sem conclusão)
-- com delivery_date era promessa — copia pra expected e limpa o delivery.
--
-- COMO RODAR: Supabase dashboard (fvgpkbpqacnqxtrjsmpi) → SQL Editor → Run.
-- ============================================================================

begin;

alter table public.invoices add column if not exists expected_conclusion_date date;

-- Promessas atuais mudam de casa (só onde expected ainda está vazio).
update public.invoices
   set expected_conclusion_date = delivery_date
 where conclusion_date is null
   and delivery_date is not null
   and expected_conclusion_date is null;

-- E saem do delivery_date, que vira campo de FATO.
update public.invoices
   set delivery_date = null
 where conclusion_date is null
   and delivery_date is not null
   and delivery_date = expected_conclusion_date;

commit;

-- ROLLBACK:
--   update public.invoices set delivery_date = expected_conclusion_date
--     where conclusion_date is null and delivery_date is null and expected_conclusion_date is not null;
--   alter table public.invoices drop column if exists expected_conclusion_date;
