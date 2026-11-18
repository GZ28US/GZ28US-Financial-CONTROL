-- PARTS DB: MAO DE OBRA DA PECA (Marcio, 17/11/2026, via CC Sidney: «a m.o das pecas deve morar no parts db tambem, sem campo duplicado»).
-- Dois fatos por peca, nenhum copia do outro (medido: no kit de freio 1520HCKIT, US$ 500 em 5 h da ~US$ 641/h pela regra
-- (lucro da peca + m.o.) / horas — o preco NAO sai das horas, e um numero que ele define):
--   labor_hours = horas para instalar UMA unidade;  labor_price = o que o CLIENTE paga pela instalacao de UMA unidade (USD).
-- Nulo = peca sem mao de obra cadastrada. Os packs seguem com a mao de obra propria deles (decisao dele, 17/11: opcao 1) —
-- a da peca vale quando a peca e vendida sozinha. Tabela compartilhada: o app BR le a mesma coluna por supabaseUS.
alter table public.parts_database
  add column if not exists labor_hours numeric,
  add column if not exists labor_price numeric;
