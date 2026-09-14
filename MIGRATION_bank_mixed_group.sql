-- CASAMENTO MISTO (BL 1.6.0, 13/set/2026 — Márcio). Projeto US fvgpkbpqacnqxtrjsmpi. Idempotente. SÓ ADICIONA: nenhum dado muda.
--
-- UMA linha do banco casa com registros de TABELAS DIFERENTES (o posto que vendeu gasolina PESSOAL e gelo da oficina num
-- cupom só — Wawa 5205, 10/set: $115,44 = staff_expenses PESSOAL $90,15 + inputs $25,29). Não existe coluna em comum nos
-- registros (purchase_group mora em 4 tabelas; expense_group é só da folha), então os membros moram na LINHA DO BANCO:
--   matched_table   = 'mixed_group'
--   matched_id      = o id da própria linha (a convenção do expense_group)
--   matched_members = [{"table": "<tabela>", "id": "<uuid>"}, …]   (2 a 10; a rota match_mixed valida)
-- Toda escrita que devolve a linha a sem casamento limpa a coluna junto.
--
-- ORDEM: rode ESTA migration ANTES do deploy do código da BL 1.6.0. O código lê a coluna com rede (sem ela, lê sem ela);
-- a ação match_mixed exige a coluna e responde «rode a migration» enquanto ela não existir.

alter table public.bank_transactions add column if not exists matched_members jsonb;

comment on column public.bank_transactions.matched_members is
  'Bank Link · CASAMENTO MISTO (BL 1.6.0): membros [{table,id}] quando matched_table = ''mixed_group'' (matched_id = id da própria linha). Nulo em qualquer outro casamento. DESFAZER limpa.';

-- Conferência (só leitura):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'matched_members';
--   select count(*) from public.bank_transactions where matched_members is not null;   -- 0 logo depois de rodar
