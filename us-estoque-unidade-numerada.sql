-- ESTOQUE: toda peça partida em «unidade N/M» volta a ser UMA linha com a quantidade.
-- Márcio, 23/09/2026: «seguem várias linhas com 1 unidade só, corrija isso logo».
--
-- POR QUE ESTE ARQUIVO É GERAL e o anterior não era: em 23/09 eu consolidei SÓ o Red
-- Line 5W40 — consertei o caso, não a classe. O 5W50 estava com o mesmo defeito, do
-- mesmo pedido, e ele viu. Aqui o alvo é o PADRÃO: qualquer descrição terminada em
-- «N/M» (frasco 1/24, item 3 de 8 escrito como 3/8), agrupada por peça + fornecedor +
-- preço + pedido + data.
--
-- TRAVAS, porque merge errado some com histórico:
--   · só entra linha SEM nota de uso (notes sem «Used») e com quantity > 0 — linha
--     gasta ou já usada em carro fica fora;
--   · só entra grupo com MAIS DE UMA linha;
--   · preço, pedido e data diferentes NÃO se juntam (é compra diferente).
-- Foi essa trava que salvou os Injector Dynamics 2600cc: 3 linhas do mesmo pedido
-- 122017, mas com DOIS preços (2.242,11 e 2.255,19) e uma delas com quantity 0 e nota
-- «Used 1 in US.016 — DarkAngel». São 3 jogos de verdade, não um partido em 3.
--
-- Medido antes de rodar: 24 linhas numeradas, todas do Red Line 5W50 quart (AutoZone
-- part 11604), quantity 1, sem uso, mesmo purchase_group, zero vendas em inventory_sales.
begin;

-- 1) TRILHA: a linha inteira de tudo que vai sumir ou mudar.
insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'estoque-unidade-numerada', 'inventory', id::text, 'LINHA INTEIRA',
       json_build_object(
         'description', description, 'category', category, 'quantity', quantity,
         'unit_price', unit_price, 'purchase_date', purchase_date, 'supplier', supplier,
         'notes', notes, 'purchase_group', purchase_group, 'source_type', source_type,
         'source', source, 'payment_method', payment_method, 'paid_from', paid_from,
         'paid_to', paid_to, 'payment_date', payment_date, 'order_number', order_number,
         'receipt_url', receipt_url, 'nature', nature, 'reported_at', reported_at
       )::text,
       'consolidada por unidade numerada',
       left('UNIDADE NUMERADA · ' || description, 200)
from inventory
where description ~ '\d+\s*/\s*\d+\s*$'
  and coalesce(quantity, 0) > 0
  and coalesce(notes, '') not ilike '%Used%';

-- 2) A linha que FICA de cada grupo recebe a soma e perde o sufixo numerado.
with alvo as (
  select id,
         regexp_replace(description, '\s*[—-]\s*\w+\s*\d+\s*/\s*\d+\s*$', '') as base,
         supplier, unit_price, order_number, purchase_date, quantity
  from inventory
  where description ~ '\d+\s*/\s*\d+\s*$'
    and coalesce(quantity, 0) > 0
    and coalesce(notes, '') not ilike '%Used%'
), grupo as (
  select base, supplier, unit_price, order_number, purchase_date,
         sum(quantity) as total, count(*) as linhas,
         (array_agg(id order by id))[1] as fica
  from alvo
  group by base, supplier, unit_price, order_number, purchase_date
  having count(*) > 1
)
update inventory i
   set description = g.base, quantity = g.total, updated_at = now()
  from grupo g
 where i.id = g.fica;

-- 3) As demais saem. A que ficou já não casa com «N/M», então não é atingida.
delete from inventory
where description ~ '\d+\s*/\s*\d+\s*$'
  and coalesce(quantity, 0) > 0
  and coalesce(notes, '') not ilike '%Used%';

commit;
