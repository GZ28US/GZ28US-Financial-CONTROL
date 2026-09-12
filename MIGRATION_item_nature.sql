-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION_item_nature.sql · 04/set/2026
--
-- ATUALIZADO NA ONDA 6 DO PACOTE (11–12/set/2026): os nomes das cinco tabelas renomeadas
-- na onda 2 foram trocados aqui — goods→assets, good_expenses→assets_expenses,
-- expenses→staff_expenses (invoice_parts e invoice_payments não aparecem neste
-- arquivo). O array abaixo monta `alter table public.%I` POR NOME: com o nome velho,
-- um rerun mexeria na VIEW-PONTE em vez da tabela, e view não aceita `add column`.
-- ISTO NÃO É PARA RODAR AGORA: rodou em 04/set/2026 e fica como registro do degrau
-- que faltava no STREAM. Se algum dia alguém rodar de novo, quase tudo é idempotente
-- (add column if not exists, create index if not exists, update ... where nature is
-- null) — MENOS o nome da CHECK: o rename não renomeia constraint, então a tabela
-- `assets` ainda carrega a `goods_nature_check` da rodada de 04/set e o bloco tentaria
-- criar uma `assets_nature_check` idêntica ao lado. Mais uma razão para não rodar.
-- (O mesmo bloco, e o mesmo aviso, valem para RODAR_NO_US.sql.)
--
-- "O QUE É ESTA LINHA?" — a pergunta que faltava ANTES de "chegou?".
--
-- Ordem do Márcio: "veja os bought, tem um monte de coisa lá que não era pra ter
-- stream... não faz sentido nenhum uma wire estar como bought... matemos o
-- problema na raiz, não fazer remendo."
--
-- O DIAGNÓSTICO, medido: dos 501 BOUGHT (US$ 1.311.140,83), 197 linhas nunca vão
-- chegar de caminhão — e elas são 80% do DINHEIRO da aba. Só a categoria CARRO
-- (wire, parcela, depósito de dealer) são 33 linhas e US$ 967.418,02.
-- A cascata de lib/deliverStatus.ts só sabe perguntar "pagou?" — e responde certo.
-- Faltava o degrau anterior. Sem ele, TODO custo pago vira BOUGHT por construção:
-- wire de carro, tarifa de $30 do wire, imposto do Texas, licença da HP Tuners,
-- tune por e-mail, car wash, aluguel de empilhadeira.
--
-- POR QUE COLUNA NOVA E NÃO CAMPO EXISTENTE (lei "campo duplicado é câncer",
-- conferido pelos DADOS e não pelo nome):
--   part_id .................. 0 de 1.185 em invoice_expenses (o elo está morto)
--   part_number .............. só 40% das linhas que comprovadamente chegaram
--   category (inputs/inv/assets) é DESTINO: CONSUMPTION/APARTMENT/CATS/STOCK
--   source ................... é a EMPRESA (GZ28US/GZ28BR)
--   kit_group / kit_name ..... 0 linhas preenchidas
--   tax / extra .............. é o VALOR do encargo, não a natureza; e só existe
--                              em invoice_expenses
--   suppliers.is_car_dealer .. alcança 6 das 33 linhas de carro, e é sobre o
--                              FORNECEDOR, não sobre a LINHA
-- Nenhum responde "isso chega?". A pergunta não tem dono. Por isso a coluna.
--
-- E POR QUE NÃO "TABELA DE NATUREZA POR FORNECEDOR": o mesmo fornecedor vende
-- naturezas opostas — Kramer vende carro E cobra imposto, Texas Speed vende peça
-- E cobra frete, HHP vende tune E vende vela, Kong vende blower E cobra porting.
-- Fornecedor dá o PALPITE (default_nature, abaixo); a LINHA dá a resposta.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. A COLUNA NAS TABELAS DE ITEM ─────────────────────────────────────────
-- NULL de propósito: "ninguém disse ainda". NULL continua APARECENDO no STREAM,
-- marcado A CLASSIFICAR. O app não chuta — nem pra pôr, nem pra tirar.
do $$
declare t text;
begin
  foreach t in array array['invoice_expenses','inputs','inventory','assets','assets_expenses','staff_expenses']
  loop
    execute format('alter table public.%I add column if not exists nature text', t);
    execute format($f$
      do $inner$ begin
        if not exists (select 1 from pg_constraint where conname = %L) then
          alter table public.%I add constraint %I
            check (nature is null or nature in ('PART','SERVICE','DIGITAL','CHARGE','MONEY'));
        end if;
      end $inner$;
    $f$, t || '_nature_check', t, t || '_nature_check');
    -- o STREAM e o robô do rastreio filtram por aqui
    execute format('create index if not exists %I on public.%I (nature)', 'idx_' || t || '_nature', t);
  end loop;
end $$;

-- ── 2. O PALPITE DO FORNECEDOR ──────────────────────────────────────────────
-- Só pré-seleciona na tela e no card de classificação. NUNCA decide sozinho.
alter table public.suppliers add column if not exists default_nature text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'suppliers_default_nature_check') then
    alter table public.suppliers add constraint suppliers_default_nature_check
      check (default_nature is null or default_nature in ('PART','SERVICE','DIGITAL','CHARGE','MONEY'));
  end if;
end $$;

-- ── 3. O ÚNICO BACKFILL AUTOMÁTICO QUE SOBREVIVEU À REVISÃO ─────────────────
-- Três revisores derrubaram a regra "tem rastreio ⇒ é peça": rastreio prova que
-- uma CAIXA andou, inclusive pra FORA e inclusive quando o comprado é serviço —
-- 'Universal Credits' da HP Tuners TEM tracking, o 'Envio da PCM para a True
-- Street' é remessa SAINDO, 'Route Package Protection' é seguro de frete. E a
-- regra do picked_up carimbaria 293 linhas como PEÇA, entre elas combo do Steak
-- N Shake, jantar de buffet, cigarro Newport do Wawa e 8 abastecimentos.
-- Ambas foram descartadas. Sobra só esta, que é igualdade EXATA de descrição em
-- linha que o PRÓPRIO APP materializou (app/goods/page.tsx transforma o
-- tax/shipping do scan em linha literal):
update public.invoice_expenses set nature = 'CHARGE'
  where nature is null and btrim(item) in ('Sales Tax','Shipping','Shipping and handling');
update public.assets_expenses set nature = 'CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');
update public.inputs set nature = 'CHARGE'
  where nature is null and btrim(description) in ('Sales Tax','Shipping','Shipping and handling');

-- Tudo o mais fica NULL e vai para o card /adm/check (check_key='item-nature'),
-- agrupado por fornecedor: 48 grupos cobrem 80% das linhas e 25 grupos cobrem
-- 90% do dinheiro. É o "ensine as regras pro robô" do Márcio, e é finito.

-- ── 4. CONFERÊNCIA ──────────────────────────────────────────────────────────
select 'invoice_expenses' t, count(*) total, count(nature) classificadas from public.invoice_expenses
union all select 'inputs',          count(*), count(nature) from public.inputs
union all select 'inventory',       count(*), count(nature) from public.inventory
union all select 'assets',          count(*), count(nature) from public.assets
union all select 'assets_expenses', count(*), count(nature) from public.assets_expenses
union all select 'staff_expenses',  count(*), count(nature) from public.staff_expenses;
