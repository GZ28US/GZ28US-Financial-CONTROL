-- ONDA 1 DO PACOTE PAID FROM/TO (11/set/2026) — SÓ CONSERTO DE DADO.
-- Decisões do Márcio de 10–11/set, registradas em memory/paid-from-to-por-tabela.md
-- (itens 2, 4, 6 e 7). Nenhum rename de tabela e nenhuma coluna apagada aqui:
-- isto roda ANTES, sozinho, para que o dinheiro já esteja certo quando o resto subir.
--
-- Tudo numa transação, com trava antes e conferência depois: se qualquer conta não
-- bater, a transação inteira volta atrás e nada muda.
--
-- Projeto: US  fvgpkbpqacnqxtrjsmpi

begin;

-- ── TRAVAS: o banco tem de estar como foi medido em 11/set, 20:45 Orlando ────────
do $$
declare n int;
begin
  select count(*) into n from inventory where id = '1f41ece1-a099-4137-83d8-8b33610d00a5';
  if n <> 1 then raise exception 'FIC1650: esperava 1 linha no inventory, achei %', n; end if;

  select count(*) into n from inventory where paid_from = 'GZ28BR';
  if n <> 1 then raise exception 'inventory pago pelo BR: esperava 1, achei % — medir de novo antes de rodar', n; end if;

  select count(*) into n from fixed_cost_suppliers where id = 'c4df96f1-66c0-4f99-8092-cc442c7c9172' and cost_type = 'ASSET';
  if n <> 1 then raise exception 'booth do SEMA: esperava 1 fornecedor fixo ASSET, achei %', n; end if;

  select count(*) into n from fixed_cost_suppliers where cost_type = 'ASSET';
  if n <> 1 then raise exception 'ASSET nos custos fixos: esperava só o booth, achei % — a categoria não pode sair com outra linha usando', n; end if;

  select count(*) into n from expenses where origin = 'GZ28BR';
  if n <> 1 then raise exception 'staff_expenses com origin GZ28BR: esperava 1, achei %', n; end if;
end $$;

-- ── ITEM 2 · FIC1650 SAI DO APP ("tire este item do app") ────────────────────────
-- A linha inteira fica guardada em data_fixes ANTES de sumir: é dinheiro (US$ 1.523,04,
-- HHP Racing, pedido 370635, pago 06/mar/2026) e some sem lançar nada na tabela BR vs US.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'inventory', i.id::text, '(linha inteira)',
       to_jsonb(i)::text, null,
       'FIC1650 · HHP Racing · pedido 370635 · US$ 1.523,04 — item 2 do pacote: sai do app, sem lançar na tabela BR vs US'
from inventory i where i.id = '1f41ece1-a099-4137-83d8-8b33610d00a5';

delete from inventory where id = '1f41ece1-a099-4137-83d8-8b33610d00a5';

-- ── ITEM 4 · O BOOTH DO SEMA VIRA MARKETING, E O ASSET SAI DOS COSTS ─────────────
-- "assets" passa a ser só o patrimônio (a tabela ex-goods). O único ASSET dos COSTS
-- é o booth, e booth de feira é marketing.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'fixed_cost_suppliers', id::text, 'cost_type', cost_type, 'MARKETING',
       'SEMA Show 2026 — Booth 24617 · item 4 do pacote: ASSET vira MARKETING e a categoria ASSET sai dos COSTS'
from fixed_cost_suppliers where id = 'c4df96f1-66c0-4f99-8092-cc442c7c9172';

update fixed_cost_suppliers set cost_type = 'MARKETING', updated_at = now()
where id = 'c4df96f1-66c0-4f99-8092-cc442c7c9172';

-- ── ITEM 6 · origin de staff_expenses: só empresa (GZ28US) ou pessoal (PERSONAL) ──
-- origin = de quem é o CUSTO; quem PAGOU é o paid_from, que continua GZ28BR nesta linha
-- (seguro de viagem do Jeferson, custo da empresa que o BR pagou — o BR vira credor).
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'expenses', id::text, 'origin', origin, 'GZ28US',
       'item 6 do pacote: origin só GZ28US ou PERSONAL; quem pagou segue no paid_from'
from expenses where origin = 'GZ28BR';

update expenses set origin = 'GZ28US', updated_at = now() where origin = 'GZ28BR';

-- ── ITEM 7 · valor gravado que virou outro (banco/pessoa no lugar da empresa) ─────
-- PAID FROM não é instrumento de pagamento nem beneficiário: é a empresa que pagou.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'fixed_cost_expenses', id::text, 'paid_from', paid_from, 'GZ28US',
       'item 7 do pacote: instrumento de pagamento no campo da empresa'
from fixed_cost_expenses where paid_from in ('Regions •9336', 'GZ28US (Stripe)');

update fixed_cost_expenses set paid_from = 'GZ28US'
where paid_from in ('Regions •9336', 'GZ28US (Stripe)');

-- SÓ o nome de FORNECEDOR no campo da empresa. A outra linha fora do padrão
-- (seguro do Jeferson, paid_to = 'GZ28BR') NÃO entra aqui de propósito: mudá-la é
-- aplicar a REGRA nova ("nas staff_expenses o PAID TO é sempre GZ28US"), e isso
-- move US$ 89,09 de dívida do BR — dinheiro não anda dentro de uma migration
-- chamada "só conserto de dado". Ela vai na onda da regra, com rótulo próprio.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'pacote-paid-from-to', 'expenses', id::text, 'paid_to', paid_to, 'GZ28US',
       'item 7 do pacote: nome de fornecedor no campo da empresa (Kravitz & Guerra é quem recebeu, não uma casa nossa)'
from expenses where paid_to is not null and paid_to not in ('GZ28US', 'GZ28BR');

update expenses set paid_to = 'GZ28US', updated_at = now()
where paid_to is not null and paid_to not in ('GZ28US', 'GZ28BR');

-- ── CONFERÊNCIA DEPOIS: se qualquer uma falhar, tudo volta atrás ─────────────────
do $$
declare n int;
begin
  select count(*) into n from inventory where id = '1f41ece1-a099-4137-83d8-8b33610d00a5';
  if n <> 0 then raise exception 'FIC1650 não saiu'; end if;

  select count(*) into n from inventory where paid_from = 'GZ28BR';
  if n <> 0 then raise exception 'ainda há inventory pago pelo BR: %', n; end if;

  select count(*) into n from fixed_cost_suppliers where cost_type = 'ASSET';
  if n <> 0 then raise exception 'ainda há ASSET nos custos fixos: %', n; end if;

  select count(*) into n from expenses where origin not in ('GZ28US', 'PERSONAL');
  if n <> 0 then raise exception 'origin fora de GZ28US/PERSONAL: %', n; end if;

  select count(*) into n from expenses where paid_to is not null and paid_to not in ('GZ28US', 'GZ28BR');
  if n <> 0 then raise exception 'PAID TO de staff_expenses com nome que não é casa nossa: %', n; end if;

  select count(*) into n from expenses where paid_to = 'GZ28BR';
  if n <> 1 then raise exception 'esperava a única linha GZ28BR (seguro do Jeferson) intacta, achei %', n; end if;

  select count(*) into n from fixed_cost_expenses where paid_from is not null and paid_from <> 'GZ28US';
  if n <> 0 then raise exception 'PAID FROM de custo fixo fora do GZ28US: %', n; end if;

  select count(*) into n from data_fixes where check_key = 'pacote-paid-from-to';
  if n < 7 then raise exception 'trilha curta demais em data_fixes: % linhas (esperado: 1 FIC1650 + 1 booth + 1 origin + 3 custo fixo + 1 Kravitz)', n; end if;
end $$;

commit;
