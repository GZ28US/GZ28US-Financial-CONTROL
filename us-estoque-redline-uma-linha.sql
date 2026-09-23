-- ESTOQUE: as 24 linhas do óleo Red Line 5W40 viram UMA, com quantidade 24.
-- Márcio, 23/09/2026: «several lines of the same item with 1 as quantity, the right way
-- is one row with the proper quantity» e «comprado BULK e vendido individualmente tem que
-- guardar no inventory individualmente na quantidade certa».
--
-- POR QUE A TELA NÃO RESOLVEU: o agrupamento do FROM STOCK (commit c423565) junta linhas
-- iguais, e estas NÃO são iguais — cada descrição termina com «— frasco N/24», de 1 a 24.
-- Para o app são 24 peças diferentes. O conserto tem de ser no DADO.
--
-- A UNIDADE JÁ ESTAVA CERTA: quarto a US$ 17,32 (não caixa a US$ 207,84). O que estava
-- errado era a forma — 24 linhas de quantidade 1 em vez de uma linha de 24.
--
-- CONFERIDO ANTES DE APAGAR: nenhuma das 24 é referenciada em inventory_sales (0),
-- part_stream_items (0) nem data_fixes (0). O casamento com o banco é por purchase_group,
-- que continua o mesmo e único. Valor total intocado: 24 × 17,32 = US$ 415,68.
begin;

-- 1) TRILHA: a linha inteira das 24, em JSON, para a volta existir de verdade.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'estoque-bulk-uma-linha', 'inventory', id::text, 'LINHA INTEIRA',
       json_build_object(
         'description', description, 'category', category, 'quantity', quantity,
         'unit_price', unit_price, 'purchase_date', purchase_date, 'supplier', supplier,
         'notes', notes, 'purchase_group', purchase_group, 'source_type', source_type,
         'source', source, 'payment_method', payment_method, 'paid_from', paid_from,
         'paid_to', paid_to, 'payment_date', payment_date, 'order_number', order_number,
         'receipt_url', receipt_url, 'nature', nature, 'reported_at', reported_at
       )::text,
       'consolidadas em 1 linha de quantidade 24',
       'Red Line 5W40 — 24 frascos soltos viram 1 linha'
from inventory
where description ilike 'Red Line 5W40 Motor Oil — quart%frasco%/24';

-- 2) A LINHA QUE FICA: a do frasco 1/24, sem o sufixo e com a quantidade cheia.
update inventory set
  description = 'Red Line 5W40 Motor Oil — quart (AutoZone part 15404, SKU-001688573)',
  quantity = 24,
  updated_at = now()
where id = (
  select id from inventory
  where description ilike 'Red Line 5W40 Motor Oil — quart%frasco%/24'
  order by description, id
  limit 1
);

-- 3) AS OUTRAS 23 SAEM. A que ficou já não casa com «frasco», então não é atingida.
delete from inventory
where description ilike 'Red Line 5W40 Motor Oil — quart%frasco%/24';

commit;
