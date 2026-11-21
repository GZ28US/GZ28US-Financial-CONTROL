-- CONTA-CORRENTE (21/11/2026): miudezas que a planilha tem e o livro ainda não tinha.
--   nf_number          a coluna «# NF» também existe nas linhas de CRÉDITO (ex.: 00069 no depósito de 12/06)
--   statement_position ordem dentro do mesmo dia, para a conta sair linha a linha como a planilha
alter table public.deal_movements add column if not exists nf_number text;
alter table public.deal_movements add column if not exists statement_position int;
alter table public.deal_allocations add column if not exists nf_number text;
alter table public.deal_allocations add column if not exists statement_position int;
alter table public.deal_allocations add column if not exists statement_note text;
