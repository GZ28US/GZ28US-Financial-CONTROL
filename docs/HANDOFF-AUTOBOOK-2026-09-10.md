# HANDOFF · AUTO-BOOK — o que a sessão do João mediu e desenhou para LANÇAMENTO

**Para:** a sessão do Márcio (AutoBook)
**De:** o Claude da sessão do João (Data Checker, Bank Link, Financials), a pedido do João
**Data:** 10/09/2026 · código lido em HEAD `10fc4b8` do US (os números de linha citados são dessa versão — `git show 10fc4b8:<arquivo>`; o commit da DC 1.51.0 · BL 1.5.1, que traz este documento, desloca vários) · produção lida só com SELECT em 10/09/2026

> **Informação, não ordem.** Nada aqui foi escrito no banco nem no código, e nada no código do AutoBook foi tocado. O Márcio decide o que usar, quando e como. As regras citadas são as do livro dele (`lib/autoBookLivro.ts`, pelo `id`). Todo número traz a data da medição. Valores em dólar no formato do app ($1,440.90).

---

## Resumo em oito linhas

1. **A divisão combinada (10/09, noite):** o AUTO-BOOK lança tudo; o AUTO-LINK (motor do Bank Link) só casa e audita; o Data Checker audita — mostra a prova e pergunta, e os checks novos não escrevem.
2. **O que o AUTO-LINK cria hoje** (medido 10/09): 859 lançamentos, $160,648.07 — balde 387 ($136,495.52, **nenhum** atribuído a carro ainda), regras 374 ($22,041.60), tarifas 98 ($2,110.95). Nos últimos 90 dias: 212 linhas, $39,609.68 — **47 de quem manda e-mail** ($21,081.20), **154 de quem nunca manda** ($10,505.31), 11 incertas ($8,023.17). §1
3. **Desligar a criação por categoria já existe** (⚙ REGRAS & APELIDOS, no Bank Link). A tarifa bancária (motor FEE) **não tem botão**. §1.3
4. **Wires** (medido 10/09): 20 abertos, $812,736.17. 11 têm par certo (nome + taxa de $23 + até 1 dia), $402,550. A taxa de $23 está no custo do carro **e** na tarifa mensal da Regions: $207 contados duas vezes hoje, $276 quando a tarifa de setembro postar. A régua do nome está pronta para reuso (§2.6). A regra 8.13 ainda não diz se a taxa é custo do carro ou tarifa do banco (§2.7).
5. **Datas (regra 4.8)** (medido 10/09): a autorização do cartão vem em 100% das linhas do Plaid desde 26/05. Quem digita a data usa a autorização em 77,0% dos casos e a data postada em 1,0%. A especificação do `payDateOf` e as armadilhas encontradas estão no §3.
6. **Duplicidade** (medido 10/09): 15 cobranças no balde repetem pedidos já lançados em várias linhas ($15,133.91), e 19 cobranças no balde têm estorno no banco ($1,170.74). Proposta de regra de soma por pedido para as regras 5.x. §4
7. **Dados para acertar com o Márcio**, sem mexer: Cesar Tellez (006.25 × 006.34 × BR.180.1), 006.12, US.030.1, o «SALDO em aberto» da US.050.1 e a transferência de $38,197.50 de hoje. §5
8. **O que a sessão do João vai vigiar:** cinco auditorias só de leitura e a correção da integridade do DESFAZER. §6

---

## 1. Contexto e divisão combinada

### 1.1 A decisão

| quem | papel a partir de 10/09/2026 | onde mora |
|---|---|---|
| **AUTO-BOOK** (robô de e-mail do Márcio) | **lança** todo gasto e toda receita | `lib/autoBookMail.server.ts`, livro em `lib/autoBookLivro.ts` |
| **AUTO-LINK** (motor do Bank Link) | só **casa** a linha do banco com o registro e **audita** | `lib/bankReconcile.server.ts`, `app/api/bank/reconcile/route.ts` |
| **Data Checker** | **audita**: mostra a prova, pergunta a gente e não escreve nos checks novos | `app/adm/check/page.tsx`, módulos `lib/*Audit*.server.ts` |

A meta do João são demonstrativos perfeitos (DRE, DFC e Balanço: `app/adm/financials/**`, `lib/financials.ts`). Um ponto no livro vai mudar de sentido: a **13.5** (`lib/autoBookLivro.ts:491-494`) diz que o AUTO-LINK «só lança quando ninguém lançou». Pela divisão nova, o AUTO-LINK deixa de lançar. O texto é do Márcio e cabe a ele atualizar.

A passagem é **gradual**: o motor continua criando o que cria hoje até cada categoria ter dono no AUTO-BOOK. Os lançamentos que ele já criou — **847 registros** na medição da tarde de 10/09 (balde 381, regra 368, tarifa 98) e **859 linhas** na da noite — são dinheiro real que saiu da Regions e **ficam**.

### 1.2 O que o AUTO-LINK cria hoje (medido 10/09/2026)

**Desde sempre** (linhas MATCHED com motor criador):

| motor | linhas | $ | onde cria |
|---|---|---|---|
| BUCKET (balde «A ATRIBUIR») | 387 | $136,495.52 | `invoice_expenses` na invoice `A ATRIBUIR` (origin BUCKET) — **as 387 continuam lá, nenhuma foi atribuída a carro** |
| RULE (regra PADRÃO/humana) | 374 | $22,041.60 | `fixed_cost_expenses` 222 · `inputs` 152 (1 adoção de agendada) |
| FEE (tarifa) | 98 | $2,110.95 | `fixed_cost_expenses` 97 · 1 casou com tarifa já lançada numa invoice |
| LEARN | 0 | — | — |

**Últimos 90 dias** (12/06 a 10/09/2026): 212 linhas, $39,609.68.

| motor | jun (a partir de 12) | jul | ago | set (até 10) |
|---|---|---|---|---|
| RULE (cria) | 6 · $365.31 | 25 · $977.10 | 44 · $1,711.73 | 11 · $236.13 |
| RULE (adotou agendada) | — | — | 1 · $11.99 | — |
| BUCKET | 8 · $706.59 | 33 · $12,575.80 | 31 · $21,586.86 | 2 · $260.58 |
| FEE | 11 · $170.90 | 19 · $354.79 | 15 · $475.48 | 6 · $176.42 |

**Por regra × classe** (90 dias; classe = `classify`, `lib/bankReconcile.server.ts:523`). A coluna «e-mail?» segue a regra **B.1** (loja que não manda e-mail nunca dispara o robô) e a **5.3** (assinaturas).

| regra (chave · rótulo) | motor → destino | classe | linhas | $ | quem é | e-mail? |
|---|---|---|---|---|---|---|
| `def:auto-parts` · peça → balde | BUCKET | AUTO_PARTS | 29 | $27,602.50 | AutoZone ×14, Delawar/HHP ×5, Tirerac ×2, PayPal/HHP ×2, Advance ×2 | misto: 18 no balcão · 7 online da lista · 4 online fora da lista |
| `def:misc-retail` · varejo → balde | BUCKET | MISC_RETAIL | 4 | $2,140.70 | Corvette Store, Zanvis, Bei Jing Feng Yu, Acer Racing | misto |
| `def:services` · serviço → balde | BUCKET | SERVICES | 2 | $1,715.28 | Amo Promo, Raydn | misto |
| `def:fuel` · combustível da frota | RULE → fixo (Frota) | FUEL | 41 | $1,603.27 | RaceTrac ×14, BP ×12, Wawa ×10, Shell ×3, Sam's ×2 | **nunca** |
| `def:marketplace` · Amazon/eBay → balde | BUCKET | MARKETPLACE | 23 | $1,290.70 | Amazon ×16, eBay ×7 | **manda** |
| `def:superstore` · Walmart/Target | RULE → insumo (até o teto) / BUCKET (acima) | SUPERSTORE | 11 | $1,256.13 | Walmart ×11 | 7 no balcão · 4 online |
| (sem regra) motor FEE | FEE → tarifa em /costs/bank | BANK_FEE / TRANSFER | 51 | $1,177.59 | Wire Incoming Fee ×28, International Service Assessment ×16, Monthly Fee ×3, Analysis Charge ×3, OUT F ×1 | **nunca** |
| `def:grocery` · mercado | RULE → insumo | GROCERY | 21 | $852.41 | Aldi ×15, Seabra ×4, Publix, Bravo | **nunca** |
| `def:saas-other` · assinatura sem fornecedor → balde | BUCKET | SAAS | 4 | $709.52 | Amazon Prime ×2, HP Tuners, Microsoft | manda (cobrança) |
| `def:auto-service` · serviço automotivo → balde | BUCKET | AUTO_SERVICE | 2 | $544.70 | PayPal/HHP, Discount Tire | misto |
| `def:temu` · Temu → balde | BUCKET | TEMU | 8 | $374.75 | Temu ×8 | **manda** |
| `def:saas:anthropic` / `supabase` / `apple` | RULE → fixo (APPS) | SAAS | 1 / 1 / 2 | $102.58 / $44.03 / $21.98 | — | manda (cobrança) |
| `def:hardware-small` · ferragem miúda | RULE → insumo | HARDWARE | 4 | $71.67 | South Orange Ace ×4 | nunca |
| `def:discount` · Dollar Tree e cia | RULE → insumo | DISCOUNT_VARIETY | 7 | $70.33 | Dollar Tree ×5, Family Dollar ×2 | nunca |
| `def:postage` · frete → balde | BUCKET | POSTAGE | 1 | $31.54 | UPS | nunca |

**Por categoria de e-mail × mês** (90 dias):

| categoria | linhas | $ | jun | jul | ago | set |
|---|---|---|---|---|---|---|
| NUNCA · tarifa do banco | 51 | $1,177.59 | 11 · $170.90 | 19 · $354.79 | 15 · $475.48 | 6 · $176.42 |
| NUNCA · bomba e pedágio (B.1) | 41 | $1,603.27 | 3 · $249.92 | 18 · $580.14 | 17 · $688.67 | 3 · $84.54 |
| NUNCA · mercado e conveniência (B.1) | 28 | $922.74 | 1 · $2.82 | 2 · $139.67 | 19 · $692.77 | 6 · $87.48 |
| NUNCA · compra no balcão, canal «in store» (B.1) | 34 | $6,801.71 | 1 · $304.23 | 8 · $4,378.60 | 21 · $1,794.19 | 4 · $324.69 |
| MANDA · vendedor online da lista `DOM_VENDOR` | 39 | $20,203.09 | 7 · $402.36 | 19 · $3,289.44 | 13 · $16,511.29 | — |
| MANDA · cobrança recorrente ou assinatura (5.3) | 8 | $878.11 | 2 · $112.57 | 3 · $694.36 | 3 · $71.18 | — |
| TALVEZ · online, fora da lista | 11 | $8,023.17 | — | 8 · $4,470.69 | 3 · $3,552.48 | — |

Como a categoria foi decidida: pela classe do motor, pelo canal que o Plaid manda (`raw.payment_channel`) e pela lista de domínios do robô (`DOM_VENDOR`, `lib/autoBookMail.server.ts:156-166`). É um mapa, não um veredito. O banco corta nomes (por exemplo «Tirerac» é Tire Rack, que está na lista) e as linhas de extrato não trazem canal.

**Leitura:** as 47 linhas ($21,081.20) de quem manda e-mail são candidatas naturais às primeiras categorias passadas ao AUTO-BOOK. As 154 linhas ($10,505.31) de quem nunca manda não têm gatilho de e-mail — pela B.1 são «à mão», e a **6.11** (fotos nos grupos do time) é o outro sinal que existe hoje.

**O ponto que já liga os dois robôs:** a PESCA do Márcio adota a linha do balde em vez de inserir uma segunda (`lib/purchaseQueue.server.ts:258-284`). Ela exige mesmo valor, família do fornecedor e `payment_date ≥ hoje−10` (:261-263).

### 1.3 Como desligar a criação por categoria hoje

- **Onde:** Bank Link (`/adm/bank`), painel **⚙ REGRAS & APELIDOS DO AUTO-LINK**, botão LIGADA/DESLIGADA de cada regra (`components/BankReconcileCard.tsx:571`). O botão grava `bank_merchant_rules.active = false` com `paused_reason` «desligada pelo dono», direto do navegador e **sem trilha em `data_fixes`**.
- **Regra PADRÃO vira lápide:** ela não se apaga (`BankReconcileCard.tsx:572-573`), e a linha desligada impede a semeadura de recriá-la (`seedDefaultRules` pula chave existente, `lib/bankReconcile.server.ts:1715`). O motor só carrega regra ativa (:1758).
- **Inventário** (medido 10/09): 38 regras — 37 PADRÃO ligadas (insumo 7, custo fixo 17, balde 13), **0 desligadas**, 1 humana (moradia Orlando Palms) e 0 aprendidas.
- **FEE não tem regra nem botão.** Toda linha que `isFee` reconhece (até $300, por `FEE_RE` ou categoria `BANK_FEES`, `lib/bankReconcile.server.ts:410-411`) vai ao motor de tarifa **antes** de qualquer regra (:798-803). Tirar a tarifa do AUTO-LINK exige mudar código.
- **O que acontece com a linha depois de desligar:** sem regra, ela cai no skip «sem candidato» (:834) e vira dúvida (`kindOf`, :700-706) no card «Conciliação bancária» do Data Checker. A linha não some calada, e continua pergunta até alguém — ou o AUTO-BOOK — dar dono.

---

## 2. Wires e a taxa de $23

### 2.1 O regime da taxa (medido 10/09/2026)

- **91 saídas** com WIRE no nome: 62 são linhas de taxa (53 «Wire Transfer Incoming Fee» de $15 e 9 «WIRE TRANSFER DOMESTIC OUT F» de $30) e **29 são wires**. Há também 53 wires de entrada.
- **Até 15/06/2026:** toda saída tinha a sua linha «DOMESTIC OUT F» de **$30** no mesmo dia. São 9 linhas, todas casadas pelo FEE; a última é de 15/06.
- **Desde 17/06/2026:** nenhuma linha própria. A Regions cobra **$23 por wire dentro da ANALYSIS CHARGE do mês**, sobre uma base de **$24**, postada no mês seguinte:

| mês da tarifa | postada | valor | conta | status |
|---|---|---|---|---|
| nov/2025 a mai/2026 | dia 9 a 11 do mês seguinte | $24.00 | 24 + 0 × 23 | casada FEE |
| jun/2026 | 09/07 | $93.00 | 24 + 3 × 23 | casada FEE |
| jul/2026 | 10/08 | $231.00 | 24 + 9 × 23 | casada FEE |
| ago/2026 | 09/09 | $116.00 | 24 + 4 × 23 | casada FEE |
| set/2026 | não postou | $116.00 esperado | 24 + 4 × 23 (até 10/09) | — |

- «DOMESTIC OUT F» **não** contém a palavra «FEE»; só `FEE_RE` reconhece a linha (`lib/bankReconcile.server.ts:410`).
- **O teto de $300 do `isFee`** (:411): num mês com 13 wires ou mais, a tarifa passa de $300 (24 + 13 × 23 = $323) e o FEE deixa de lançá-la sozinho.

### 2.2 Os wires abertos e os registros do app (medido 10/09/2026)

Há **20 wires abertos**, todos NEW e postados, nenhum QUEUED e nenhum recusado, somando $812,736.17. Pela régua final (§2.6), **11 têm par certo ($402,550)** e **9 não têm par ($410,186.17)**.

| # | data | wire | beneficiário no banco | registro do app | total | taxa | dias | o nome bate em | card hoje |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 09/07 | $35,000 | PARK PLACE MOT | US.170.1 · Park Place Motors LTD · «Demon 170 2nd Payment» | $35,023 | $23 | 0 | PARK, PLACE (3×3 resolvido pelo nome) | É ESTA? |
| 2 | 10/07 | $35,000 | LRA AUTO SALES | US.032.1 · LRA Auto Sales · «HellRaisin SuperStock 2nd Payment» | $35,023 | $23 | 0 | LRA, AUTO, SALES | É ESTA? |
| 3 | 10/07 | $35,000 | KR TX CHRYS LL | US.031.1 · KR TX CHRYS LLC · «Joker 2nd Payment» | $35,023 | $23 | 0 | KR, TX, CHRYS | É ESTA? |
| 4 | 17/07 | $20,000 | PARK PLACE MOT | US.170.1 · «Demon 170 Go Mango» | $20,023 | $23 | 0 | PARK, PLACE | É ESTA? (oferece o SALDO da US.050.1, §5.4) |
| 5 | 20/07 | $5,000 | ARIZONA MOTORS | US.042.1 · Arizona Motors Snowflake · «Deposit» | $5,023 | $23 | 0 | ARIZONA, MOTORS | DINHEIRO |
| 6 | 31/07 | $59,500 | PARK PLACE MOT | US.170.1 · «Go Mango Last Payment» | $59,523 | $23 | 0 | PARK, PLACE | DINHEIRO |
| 7 | 07/08 | $23,050 | JOSEPH SALVAGG | US.045.1 · R & A Automotive, Inc. · «#0283 1st Installment» | $23,073 | $23 | 1 | vendedor JOSEPH + SALVAGG… | DINHEIRO |
| 8 | 07/08 | $35,000 | LRA AUTO SALES | US.032.1 · «HellRaisin SuperStock FINAL Payment» | $35,023 | $23 | 1 | LRA, AUTO, SALES | DINHEIRO |
| 9 | 12/08 | $35,000 | KR TX CHRYS LL | US.031.1 · «Final Payment Charger RedEye» | $35,023 | $23 | 0 | KR, TX, CHRYS | DINHEIRO |
| 10 | 03/09 | $20,000 | SURF CITY AUTO | US.049.1 · Huntington Beach CDJR · «Pitch Black 1o pagamento» | $20,023 | $23 | 0 | SURF, CITY, AUTO (só no texto do item) | É ESTA? (oferece o SALDO da US.050.1) |
| 11 | 04/09 | $100,000 | SURF CITY AUTO | US.049.1 · «Pitch Black 2o pagamento» | $100,023 | $23 | 0 | SURF, CITY, AUTO | DINHEIRO |

Os 11 registros têm `paid_from` GZ28US, quantidade 1 e `extra` = 23. («card hoje» = antes do Data Checker 1.51.0; com ele, linha de dinheiro sem nome no registro deixa de oferecer SIM ou pré-seleção.)

**Por que ninguém forma esses pares hoje:**
- O casamento exato aceita só valor ao centavo (`rank`, `lib/bankReconcile.server.ts:390`).
- O WIRE + TAXA do Data Checker só olhava registro **sem** `paid_from` (`app/adm/check/page.tsx:754-756`, :816 em `10fc4b8`), por isso pegava 0 de 20.
- O `match_wire` só era chamado por esse ramo do Data Checker; a DC 1.51.0 tirou dele o casamento certo, e hoje nada na tela chama o `match_wire`.

### 2.3 A taxa contada duas vezes (medido 10/09/2026)

Em cada par, os $23 estão no `extra` do registro do carro (custo do carro no DRE) **e** na ANALYSIS CHARGE que o FEE lançou em /costs/bank.

| pares | tarifa do mês | contado duas vezes |
|---|---|---|
| julho: 6 (itens 1–6) | postada 10/08, casada FEE | $138 |
| agosto: 3 (itens 7–9) | postada 09/09, casada FEE | $69 |
| **hoje** | | **$207** |
| setembro: itens 10–11 e o wire dividido de 08/09 (§2.4) | ainda não postou | +$69 quando postar → **$276** |

O módulo de auditoria da sessão do João chega aos mesmos números (§6.1: $276 no total, dos quais $69 esperam a tarifa de setembro).

Casos que **não** estão em dobro:
- **Os 6 wires já casados por `match_wire` (ADJUST)** — US.019.1 Kramer ×4 com taxa de $30 e US.030.1 Highline ×2 com taxa de $23 — tiveram a taxa tirada do preço.
- **US.047.1** Joseph Salvaggio «Demon 170 #1428 Deposit»: preço $4,977 + `extra` $23 = $5,000, casado EXACT com o wire de $5,000 de 21/08. O total é o que saiu para o vendedor; só a divisão entre preço e `extra` não confere.

**Novo hoje** (medido 10/09): há uma linha **pendente** «TRANSFER OF FUNDS» de **$38,197.50** em 10/09, categoria Plaid `TRANSFER_OUT_ACCOUNT_TRANSFER`, NEW. O valor é igual ao total **com** os $23 do registro US.050.1 «2 x Demon 170 Purchase» (Surf City Auto Group Inc, $38,174.50 + `extra` $23, datado 10/09). Se for esse pagamento, aqui os $23 não aparecem como taxa separada. O motor nunca casa linha pendente. Fica a pergunta.

### 2.4 Os 9 wires sem par (medido 10/09/2026)

- **08/09 · $100,000 · SURF CITY AUTO — dividido em dois registros.** US.049.1 «Pitch Black 3o pagamento, QUITAÇÃO» ($19,084.75 + $23 = $19,107.75) e US.050.1 «TorRed 3o pagamento, PARCIAL» ($80,915.25), ambos de 08/09, somam **$100,023**. O `match_wire` aceita um registro só (`app/api/bank/reconcile/route.ts:578-586`).
- **27/07 · $100,000 e 28/07 · $46,095 · ARIZONA MOTORS** somam $146,095. O registro US.042.1 «Arizona Motors · Car Purchase» tem **$143,095** (24/07, sem taxa dentro): **faltam $3,000** no app. O depósito de $5,000 de 20/07 é o par nº 5.
- **15/06 · KR TX CHRYS e 18/06 · LRA AUTO SALES, $35,000 cada:** os registros não têm taxa (US.031.1 Kramer AutoPlex, 15/06; US.032.1 LRA Enterprises, 18/06). Cada registro cabe nos dois wires dentro de ±3 dias, e o card mostra É ESTA? e DISPUTA. O wire de 15/06 tem OUT F própria de $30; a taxa do de 18/06 está na tarifa de junho.
- **Foss Motors** (26/02 · $5,000 e 04/03 · $85,268.54) e **Precision Dist** (07/05 · $2,832.63): as três são linhas de extrato, cada uma com OUT F de $30. **Nenhum registro** com esses nomes nas 12 tabelas pesquisadas (`invoice_expenses`, `expenses`, `fixed_cost_expenses`, `fixed_cost_suppliers`, `goods`, `good_expenses`, `inputs`, `inventory`, `invoice_parts`, `invoice_payments`, `suppliers`, `financing_events`).
- **24/07 · $990 · FLORIDA REVIEW:** não há registro de $990. **O nome, porém, existe** em `expenses`, em duas linhas «Tradução juramentada … visto O-1A (Florida Review, Zelle conf. …)»: **$90 em 24/07** e **$50 em 31/07**, pagas por Zelle. As duas linhas «ZELLE DEBIT TO FLORIDA REVI» ($90 em 24/07 e $50 em 31/07) também estão NEW. O único valor que encaixa em `invoice_expenses` é US.022.2 MTA «ZF9HP90 Rebuild», $1,050: diferença de $60 (a taxa seria $23) e nenhum nome em comum, então é quase certamente coincidência. Isto corrige a leitura anterior do dia, que dizia que nenhum registro mencionava Florida Review.

### 2.5 O cadastro fragmentado (medido 10/09/2026)

- **Kramer:** o cadastro tem **três** fornecedores separados — «Kramer Chrysler Dodge Jeep Ram» (apelidos Kramer, Kramer Autoplex, kramerautoplex.com), «KR TX CHRYS LLC» e «KR CHRYS LLC», estes dois sem apelido. Nas linhas aparecem **quatro** grafias: «Kramer AutoPlex» (US.019.1, US.031.1), «Kramer Chrysler Dodge Jeep Ram» (US.031.1, US.048.1), «KR TX CHRYS LLC» (US.031.1) e «KR CHRYS LLC» (US.010.1).
- **Surf City:** as linhas usam «Huntington Beach Chrysler Dodge Jeep Ram» (US.049.1, US.050.1; cadastro sem apelido) e «Surf City Auto Group Inc» (US.050.1, sem cadastro). O banco escreve «SURF CITY AUTO».
- **Salvaggio:** «R & A Automotive, Inc.» (vendedor Joseph A. Salvaggio) e um cadastro separado «Joseph Salvaggio», usado na US.047.1.
- **A própria empresa como fornecedor:** US.030.1 «GZ28 V8 SPEEDSHOP USA LLC» ×2 = $111,500 (a compra da Highline); 006.12 «GZ28US» ×18 = $4,101.76; 006.34 «GZ28US» ×1 = $1,534.55 (§5).
- **`bank_aliases`: 0 linhas.** A estrutura existe (`loadDbAliases`, `lib/bankReconcile.server.ts:280`; painel APELIDOS em `components/BankReconcileCard.tsx:616-633`).
- **Efeito:** pela régua final, os 6 wires históricos casados por ADJUST não passariam de «provável», sem nome, porque as linhas foram digitadas «Kramer AutoPlex» ou com a própria empresa. Está ligado à regra **8.4** (fornecedor entra com o nome do cadastro).

### 2.6 A régua final do nome — código pronto para reaproveitar

Esta régua saiu da revisão adversarial de 10/09. Resultado medido: 0 falsos em 28 pares reais e em 18 beneficiários sintéticos, e 11 pares certos nos 20 wires abertos. Ela depende de `normSup`, `supplierDirectoryFrom` e `matchSupplier` (`lib/supplierMatch.ts`). A Regions escreve «WIRE TRANSFER » + o beneficiário **cortado em 14 caracteres**, então só a última palavra pode vir truncada.

```ts
// RÉGUA FINAL DO NOME DO WIRE (sessão do João, 10/09/2026). Só leitura: decide se o beneficiário do banco é o fornecedor do registro.
import { normSup } from './supplierMatch'

// Palavra genérica não identifica ninguém: marca de carro, forma jurídica, estado, palavras comuns.
export const WIRE_GENERIC = new Set(['AUTO', 'AUTOS', 'SALES', 'MOTOR', 'MOTORS', 'MOT', 'MOTORSPORT', 'MOTORSPORTS', 'AUTOMOTIVE',
  'LLC', 'LL', 'INC', 'LTD', 'CORP', 'CO', 'GROUP', 'CITY', 'CENTER', 'CENTRAL', 'DODGE', 'CHRYSLER', 'JEEP', 'RAM', 'CDJR', 'FORD',
  'CHEVROLET', 'CHEVY', 'TOYOTA', 'RACING', 'PERFORMANCE', 'PARTS', 'SPEED', 'SHOP', 'SERVICE', 'SERVICES', 'SUPPLY', 'DIST',
  'DISTRIBUTORS', 'ENTERPRISES', 'HOLDINGS', 'INTERNATIONAL', 'INTL', 'USA', 'AMERICA', 'AMERICAN', 'CAR', 'CARS', 'DEALER', 'FINANCE',
  'FINANCIAL', 'CAPITAL', 'BANK', 'TITLE', 'THE', 'AND', 'OF', 'GZ28', 'V8', 'SPEEDSHOP', 'TX', 'FL', 'CA', 'AZ', 'MA', 'NA', 'HIGH',
  'BEST', 'FIRST', 'TOP', 'NEW', 'PRO', 'GREAT', 'BIG', 'ALL', 'ONE'])

export type WireReg = { id: string; name: string; aliases: string | null; seller: string | null }   // linha de `suppliers`

const payeeOf = (bankName: string) => String(bankName || '').replace(/^\s*wire transfer\s*/i, '').trim()
const toks = (s: string) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)

export function wireNameHit(bankName: string, row: { supplier?: string | null; item?: string | null }, reg: WireReg | null): { hit: boolean; hits: string[] } {
  const payee = payeeOf(bankName)
  const wt = toks(payee).filter(t => t.length >= 2)
  const truncated = payee.length >= 14                      // a Regions corta em 14: só a ÚLTIMA palavra pode estar pela metade
  // Apelido limpo como o supplierDirectoryFrom: corta em « — », tira aspas/colchetes, descarta prosa com «:», domínio e pedaço > 40.
  const aliasPieces = reg?.aliases
    ? String(reg.aliases).split(/[\n,]/).map(x => x.split(' — ')[0].replace(/["[\]]/g, ''))
        .filter(p => normSup(p).length <= 40 && !/:/.test(p) && !/\.(com|net|org)\b/i.test(p))
    : []
  const main = toks([row.supplier, row.item, reg?.name, ...aliasPieces].join(' '))
  const seller = toks(String(reg?.seller || '').replace(/\([^)]*\)/g, ' '))   // «Andrew Johnson (sales - MAIN)» → só o nome
  const hitIn = (words: string[]) => {
    const set = new Set(words)
    return wt.map((t, i) => {
      if (set.has(t)) return t
      if (!(i === wt.length - 1 && truncated && t.length >= 5)) return null   // prefixo só na última palavra, com 5+ letras
      const comp = words.find(w => w.length > t.length && w.startsWith(t) && !WIRE_GENERIC.has(w)) || words.find(w => w.length > t.length && w.startsWith(t))
      return comp ? (WIRE_GENERIC.has(comp) ? comp : t) + '…' : null         // completar em palavra genérica conta como genérica
    }).filter(Boolean) as string[]
  }
  const judge = (h: string[]) => { const d = h.filter(x => !WIRE_GENERIC.has(x.replace('…', ''))); return d.length > 0 && (d.some(x => x.replace('…', '').length >= 4) || h.length >= 2) }
  const hm = hitIn(main), hs = hitIn(seller)
  const sellerOk = hs.filter(x => !WIRE_GENERIC.has(x.replace('…', ''))).length >= 2   // pessoa só vale com nome E sobrenome
  return { hit: judge(hm) || sellerOk, hits: [...hm, ...(sellerOk ? hs.map(x => 'seller:' + x) : [])] }
}

// Taxa esperada de um wire de SAÍDA, pelo regime medido na Regions (§2.1).
export const WIRE_FEE_FLAT_SINCE = '2026-06-17', WIRE_FEE_FLAT = 23
export function wireExpectedFee(wireDate: string, outFeeLines: { date: string; amount: number }[]): number | null {
  const d = (a: string, b: string) => Math.abs(Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5))
  const f = outFeeLines.filter(x => d(x.date, wireDate) <= 1)                 // linhas «WIRE TRANSFER DOMESTIC OUT F»
  if (f.length === 1) return Math.round(Number(f[0].amount) * 100) / 100     // até 15/06/2026: $30 na linha própria
  return wireDate.slice(0, 10) >= WIRE_FEE_FLAT_SINCE ? WIRE_FEE_FLAT : null  // desde 17/06/2026: $23 dentro da ANALYSIS CHARGE
}
```

**Como o par é julgado** (o mesmo julgamento que produziu os 11 pares):
1. **Diferença:** registro − wire entre $0.01 e $60.
2. **Data:** a do registro a no máximo 1 dia da postada. Nos wires, autorização = postada em 23 de 23 saídas (§3.1).
3. **Recusa:** o par não pode estar recusado em `doubt_answered`.
4. **De onde sai a taxa:** `extra` ≥ taxa, ou quantidade 1.
5. **Unicidade:** montar o grafo wire × registro e aceitar componente 1×1, ou k×k em que o nome forma um casamento perfeito (cada wire nomeia exatamente um registro e vice-versa).
6. **Classificação:**
   - **CERTO** = nome bate e diferença = `wireExpectedFee`.
   - **PROVÁVEL** = diferença = taxa esperada, sem nome.
   - **Nome bate com outra diferença:** não é taxa, é pergunta.

### 2.7 A pergunta de doutrina: regra 8.13

- **O que o código faz hoje.** O comentário do `match_wire` (`app/api/bank/reconcile/route.ts:573-576`) diz: «a taxa é tarifa bancária, não custo do carro — o FEE cuida da linha da taxa». O `match_wire` tira a taxa do `extra` ou do preço, e ela fica só em /costs/bank. O motor FEE diz o mesmo (`lib/bankReconcile.server.ts:1295-1300`): «o preço cobre a tarifa ANTES, na montagem da invoice».
- **O que diz a regra 8.13** (`lib/autoBookLivro.ts:335-337`): compra, documentação e custos de carro de patrimônio ou de cliente vão **na invoice do próprio carro**, e o dinheiro sai uma vez e é lançado uma vez.
- **Leitura A — taxa é custo do carro:** os $23 ficam no `extra` do registro. A tarifa mensal lançada pelo FEE precisa então descontar $23 × wires (ou ser anotada), senão o dobro do §2.3 continua.
- **Leitura B — taxa é tarifa do banco:** o registro vai ao valor do wire e a tarifa fica inteira em /costs/bank.
- **Efeito na cobrança do cliente:** o IMPORT de ITEMS no editor da invoice soma `tax` e `extra` à base por unidade — «so they ride into ITEMS and the client repays them» (`app/rides/[id]/invoices/edit/[invoiceId]/page.tsx:1448-1451`). Na leitura A, os $23 entram no ITEM e o cliente paga por eles. Na leitura B, isso só acontece se o preço já cobrir a tarifa na montagem.

---

## 3. Datas — regra 4.8

A **4.8** (`lib/autoBookLivro.ts:176-179`): a data do pagamento é o dia em que pagamos e vem do recibo ou do e-mail do vendedor; a data do extrato é a do processamento. A **8.7** (FURO, :318-321): a linha do robô deveria nascer com a data do pagamento e com quem pagou.

### 3.1 O que o banco manda (medido 10/09/2026)

- **Cobertura de `authorized_date`:** 951 de 951 linhas do Plaid (**100%**, de 26/05 a 10/09/2026) e **0** de 908 linhas de extrato (10/11/2025 a 22/05/2026). Por mês: nov a abr 0%; mai 28 de 231; jun a set 100%.
- **Nunca depois da postada:** 0 linhas com autorização posterior.
- **Saídas postadas com autorização (860):** 268 no mesmo dia · 335 com 1 dia · 133 com 2 · 79 com 3 · 45 com 4 a 7 · 0 acima. Mediana **1** dia, máximo **6**; 68,8% têm as duas datas diferentes.

| tipo (saídas) | linhas | mesmo dia | mediana | máx |
|---|---|---|---|---|
| WIRE | 23 | 23 | 0 | 0 |
| PAYPAL | 38 | 38 | 0 | 0 |
| ACH / transferência | 4 | 4 | 0 | 0 |
| CHEQUE | 2 | 2 | 0 | 0 |
| ZELLE | 39 | 27 | 0 | 4 |
| TARIFA | 60 | 43 | 0 | 4 (a tarifa internacional segue a compra) |
| AMAZON | 66 | 0 | 2 | 6 |
| cartão no balcão | 344 | 118 | 1 | 5 |
| cartão online | 283 | 13 | 1 | 6 |

- **Entradas (77):** 56 no mesmo dia; wires de entrada 32 de 32 no mesmo dia; máximo de 13 dias, que é o crédito DELAWAR de −$5,349.65 (autorizado 06/08, postado 19/08).

### 3.2 Como gente data (medido 10/09/2026)

- **Amostra:** registros casados (EXACT, NAME ou SET) cuja data **já existia** antes do casamento, em linhas onde a autorização difere da postada — 209 registros diretos.
- **Resultado:** `payment_date` = autorização em **161 (77,0%)**, = data postada em **2 (1,0%)**, nenhuma das duas em 46 (22,0%). Nesses 46 a data é em geral 1 a 2 dias antes da autorização: é a data do pedido online (TEMU, eBay, HHP/DELAWAR, Summit, HP Tuners).
- **Medição anterior do mesmo dia**, com grupos incluídos (261 registros): 74,7% / 0,8% / 24,5%.
- **Viés:** o EXACT só aceita até 3 dias da postada (`lib/bankReconcile.server.ts:887-888`), então registros datados 4 ou mais dias antes ficam fora da amostra.
- **O motor hoje grava a data POSTADA** em tudo que cria ou preenche: `lib/bankReconcile.server.ts:1029-1035`, :1309, :1333/:1368/:1395, :1499 e `route.ts:602`, :727, :948, :966, :988, :999, :1029, :1034. O comentário «UMA DATA (lei do Márcio)» está em :1331-1333.
- **Efeito medido:** 175 registros criados pelo motor ($28,095.96) têm a data postada onde a autorização foi outro dia; 9 deles ($311.89) mudariam de mês e 0 de ano.

### 3.3 `payDateOf` — especificação para quem for gravar a data do pagamento

```ts
// DATA DO PAGAMENTO a partir da linha do banco (regra 4.8) — só quando o documento não disse.
// Ordem da prova: documento (recibo, e-mail do vendedor, aviso do Zelle pelo nº de confirmação) > autorização do cartão > data postada.
// Calcular UMA vez e gravar o MESMO valor no registro, no backfill (v) e na trilha (data_fixes.new_value): nada re-deriva a data
// depois, porque o Plaid «modified» reescreve date e raw no lugar (lib/plaid.server.ts:85-93).
export const AUTH_LAG_MAX_DAYS = 10   // medido 10/09/2026: saída máx 6 d; a única acima de 10 é um crédito (13 d)

type BankLineLike = {
  date: string; name?: string | null; plaid_id?: string | null; check_number?: string | null
  authorized_date?: string | null                   // alias do newLines: authorized_date:raw->>authorized_date
  raw?: { authorized_date?: string | null } | null  // quem lê select('*')
}
const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)
const daysFromTo = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 864e5)

export function payDateOf(l: BankLineLike, docDate?: string | null): { date: string; source: 'DOCUMENTO' | 'AUTORIZACAO' | 'POSTADA' } {
  if (isYmd(docDate)) return { date: docDate.slice(0, 10), source: 'DOCUMENTO' }
  const posted = String(l.date || '').slice(0, 10)
  const name = String(l.name || '')
  // Sem autorização de cartão por natureza — a data que vale é a postada: extrato importado (sem raw), cheque (a postada é a
  // compensação: se houver data de gente, ela manda), wire, Zelle, transferência/ACH, tarifa do banco.
  const nonCard = String(l.plaid_id || '').startsWith('stmt:') || !!l.check_number
    || /WIRE TRANSFER|ZELLE|TRANSFER OF FUNDS|INST XFER|ECHECK|\bACH\b|WEB PMTS|DEPOSIT|ANALYSIS CHARGE|\bFEE\b/i.test(name)
  const auth = String(l.authorized_date ?? l.raw?.authorized_date ?? '').slice(0, 10)
  if (!nonCard && isYmd(auth) && isYmd(posted)) {
    const lag = daysFromTo(auth, posted)
    if (lag >= 0 && lag <= AUTH_LAG_MAX_DAYS) return { date: auth, source: 'AUTORIZACAO' }
  }
  return { date: posted, source: 'POSTADA' }
}

// Para COMPARAR (não gravar): distância do registro à linha = a menor entre a postada e a autorização.
export const distanceToLine = (recordDate: string, l: BankLineLike) =>
  Math.min(Math.abs(daysFromTo(recordDate, l.date)), Math.abs(daysFromTo(recordDate, payDateOf(l).date)))
```

Pontos em aberto na especificação:
- **Hotel, aluguel de carro e bomba de combustível:** a autorização é o dia do bloqueio ou do check-in, não o do recibo. Esses casos pedem documento.
- **Hoje em Orlando:** o «hoje» de qualquer data escrita sai do fuso `America/New_York`, nunca de `toISOString().slice(0, 10)`.

### 3.4 Armadilhas encontradas (código em HEAD `10fc4b8`)

1. **`enforceReceiptPaid` pode sobrescrever uma data** (regra **10.10**, `lib/expenseReportNet.server.ts`). O SELECT pega só `payment_date` vazio, mas os três UPDATE filtram **só por id**, sem `.is('payment_date', null)`: `expenses` :94, `invoice_expenses` :126, `fixed_cost_expenses` :134. Uma data escrita entre a leitura e a escrita — por um casamento do banco ou, amanhã, pela 8.7 — é trocada.
   - A data usada é `expense_date` ou, na falta dela, **o dia UTC de `created_at`** (:85-88).
2. **Custo fixo com comprovante recebe a data de vencimento como pagamento** (:130-134). Medido 10/09: 114 contas fixas pagas com comprovante; 108 têm `payment_date` = `expense_date`; das ligadas a linha do banco, **0** estão a mais de 3 dias dela. Hoje não há vítima medida.
3. **Datas cortadas em UTC** (depois das 20:00 em Orlando viram o dia seguinte — O RELÓGIO):
   - `zelleWatch`: `hit.when = String(m.receivedDateTime …).slice(0, 10)` (`lib/zelleWatch.server.ts:235`) vira `paid_at` (:258);
   - `lancar`: `const data = String(msg.received || new Date().toISOString()).slice(0, 10)` (`lib/autoBookMail.server.ts:712`) vira `expense_date`/`purchase_date` (:580-582);
   - editor da invoice: `todayStr()` UTC (`app/rides/[id]/invoices/edit/[invoiceId]/page.tsx:185`);
   - `enforceReceiptPaid`: o fallback `created_at` (acima).
4. **`paid_at` em quatro convenções** (medido 10/09, 162 receitas com `paid_at`; a coluna volta com `+00:00`, isto é, timestamptz):

   | convenção | linhas | quem grava |
   |---|---|---|
   | meio-dia UTC | 126 | editor, `page.tsx:2063` |
   | meia-noite UTC, data sem hora | 21 | — (em Orlando aparece como o dia anterior) |
   | outra hora | 10 | inclui o «CONFIRMAR BAIXA» do Data Checker, que grava o agora (`app/adm/check/page.tsx:2134`) |
   | meio-dia de Orlando (`T16:00Z`) | 5 | `zelleWatch` :258 e o `paidAtFor` do motor (`lib/bankReconcile.server.ts:37`) |

   A regra **A.5** manda meio-dia de Orlando.
5. **Regra 13.1 e o portão `isRecentMoney`** (`lib/expenseReportNet.server.ts:157`, usado em :201, :225, :241): exige a data do dinheiro nos últimos 3 dias. Registro que ganha a data depois — casamento do banco após 1 a 5 dias de atraso do feed, ou data pela autorização — **nunca** gera report. Isto pesa quando a 8.7 passar a gravar a data na hora.
6. **1099 pelo ano da data postada** (`app/api/tax/1099/route.ts:50`): pagamento autorizado em dezembro e postado em janeiro diverge do registro datado pela 4.8. O primeiro caso possível é dez/2026.
7. **DESFAZER que re-deriva a data:** o ramo antigo do `writeUnmatch` (`lib/bankReconcile.server.ts:1160-1178`) apaga `payment_date`/`paid_at` iguais à data do banco quando o backfill é NULL — no `purchase_group`, apaga o grupo inteiro. Uma data que gente ou o robô digitar pela 4.8 e que coincida com a postada seria apagada. Medido 10/09: **33 linhas / 46 registros expostos**. A correção entra na BL 1.5.1 (§6.2).
8. **Estado da 8.7 hoje.** `lancar` grava `supplier`, `order_number`, `source` e a data do e-mail. `payment_date` e `paid_from` só entram se vierem no `target` (`lib/autoBookMail.server.ts:578-582`). Medido 10/09:
   - os 6 lançamentos BOOKED da fila (todos por resposta humana, `POST /api/auto-book` → `lancar`, `app/api/auto-book/route.ts:99`) **têm hoje** `payment_date` e `paid_from` GZ28US;
   - dois deles apontam para o **mesmo** insumo `5e8bae91`: eBay «eBay Commerce» $10.42 sem pedido e eBay 19-15117-47199 $9.69.

---

## 4. Duplicidade

### 4.1 Pedido em várias linhas × uma cobrança (medido 10/09/2026)

O balde tem 387 linhas ($136,495.52). **15 cobranças no balde repetem compras que gente já lançou em várias linhas**, somando **$15,133.91** — o custo entra duas vezes no DRE (a linha do balde é CPV) e no DFC.

| cobrança no balde | data | a mesma compra no app | prova |
|---|---|---|---|
| $3,517.84 PayPal «GZ28 V8 SPEEDS DELAWARE» | 12/08 | pedido HHP 382528 em 6 linhas (US.032.4 + US.031.4) | pedido inteiro |
| $3,262.25 Delawar | 10/08 | pedido 382349 em 4 linhas de ESTOQUE | parte do pedido |
| $2,264.66 Delawar | 13/08 | pedido 382525 em 8 linhas (US.022.2) | pedido inteiro |
| $2,178.05 Delawar | 12/08 | pedido 382420 em 9 linhas (US.010.1) | pedido inteiro |
| $1,104.39 Delawar | 12/08 | pedido 382415 em 7 linhas (US.035.2) | pedido inteiro |
| $678.21 HP Tuners | 06/07 | pedido 1896483 em 7 linhas (US.035.1, US.030.3, US.031.3 e mais 4) | pedido inteiro |
| $599.98 Acer Racing | 12/08 | pedido 581403 em 2 linhas (US.003.2 + US.002.2) | pedido inteiro |
| $517.39 AutoZone | 22/07 | nota de 16 linhas de 21/07 (029.2) | fornecedor + dia |
| $425.70 Discount Tire | 03/08 | pedido 5083839498 em 2 linhas (US.026.1) | pedido inteiro |
| $213.90 HP Tuners | 11/03 | pedido 1770405 (US.017.1 + ESTOQUE) | pedido inteiro |
| $152.65 eBay | 10/08 | pedido 16-14991-78064 (US.030.3 + US.001.1) | pedido inteiro |
| $99.06 Titan | 06/05 | 2 linhas de 05/05 (US.022.1 + ESTOQUE) | fornecedor + dia |
| $90.64 AutoZone | 10/07 | 6 linhas de 09/07 (006.20) | fornecedor + dia |
| $18.70 AutoZone | 19/08 | pedido 1581935 (006.32) | pedido inteiro |
| $10.49 Temu | 31/08 | PO-211-20534559923832437 (SUPPLIES) | pedido inteiro |

- **Por que acontece:** o motor só monta candidato de várias linhas a partir de `purchase_group`, nunca de `order_number` (`lib/bankReconcile.server.ts:232-247`), e as guardas antes de criar comparam uma linha só (:829 e :847).
- **Três cobranças ainda NEW cairiam no mesmo buraco** se fossem lançadas por falta (réplica de 10/09):
  - PayPal $5,298.75 de 12/08 = pedido HHP 382529 em 006.18 ($2,653.35) + 006.19 ($2,645.40);
  - Temu $22.60 de 01/09 = dois insumos do mesmo PO;
  - DELAWAR $5,349.65 (§4.2).

### 4.2 Estorno — cobrança e crédito do mesmo valor (medido 10/09/2026)

- **DELAWAR 5533:** cobrança de **$5,349.65** (autorizada 12/08, postada 13/08, NEW) e crédito de **−$5,349.65** (autorizado 06/08, postado 19/08, NEW). Nenhum registro no app tem esse valor. O dinheiro voltou e nenhum dos dois lados tem dono. O crédito foi autorizado **antes** da cobrança.
- **Já no balde:** 19 cobranças ($1,170.74) têm, de 0 a 30 dias depois, um crédito do mesmo valor e do mesmo comerciante que ninguém casou. Todas de fev a mai/2026: Amazon ×13, AutoZone ×3, eBay ×2, Walmart.com ×1 ($471.67). O balde registra custo de dinheiro que voltou.
- **No livro:** a **8.10** (estorno é linha NEGATIVA espelhando a original, com a data do e-mail do estorno) e a **3.4** (estorno só conta quando o vendedor afirma que devolveu) são exatamente a peça que falta nesses casos.

### 4.3 O que as regras 5.x podem reaproveitar

- **5.1 e 5.2** — `pedidosConhecidos` e `formasDoPedido` (`lib/autoBookMail.server.ts:290-311`) já normalizam o pedido: só letras e números, sem zeros à esquerda com 5+ caracteres. O módulo da sessão do João usa a mesma forma e trata código de invoice («US.022.1») escrito em `order_number` como «sem pedido».
- **5.5** — `achaNoApp` (:457-475) confere o total **linha a linha** (`|total − valor| < $0,02`). Compra digitada em 2 ou mais linhas não é achada pelo valor. A proposta é somar as linhas antes de dizer «não existe», nesta ordem de força:
  - **PEDIDO:** as linhas livres do mesmo pedido normalizado somam o valor (±$0,02); pedido de 7 a 9 linhas conta igual.
  - **PEDIDO PARTE:** um destino do pedido (estoque, supplies, uma invoice) fecha sozinho, e só uma combinação de destinos fecha.
  - **DIA:** sem pedido, **todas** as linhas livres do mesmo fornecedor no mesmo dia somam o valor.
  - **DIA PARTE:** 2 a 6 linhas de um grupo de até 8 fecham, e é a **única** combinação que fecha. Na nota AutoZone 02484201271, de 16 linhas, **seis** combinações diferentes davam os $185.56 de uma cobrança de 31/07 — por isso a unicidade.
- **5.4** — `temLinhaPorPerto` (:519-537) é fraca de propósito, e segue fazendo sentido.
- **Estorno antes de lançar:** crédito do mesmo valor e comerciante no banco, de 0 a 30 dias depois, ou e-mail de estorno (3.4) → lançar a linha negativa (8.10) em vez de um custo novo.
- **8.8 e 8.9** (compra real apaga despesas não pagas contidas nela) pedem «casamento forte». A soma por pedido acima é esse casamento forte.

---

## 5. Dados para acertar com o Márcio (nada foi mexido)

### 5.1 Cesar Tellez — 006.25 × 006.34 × BR.180.1 (medido 10/09/2026)

| | 006.25 | 006.34 |
|---|---|---|
| invoice | origin GZ28BR, criada 24/07 por script, **sem elo** com invoice BR | origin PROJECT, **espelho vivo** do BR.180.1, recriada 27/08 |
| despesa | `613610e8` · «Cesar Tellez (PayPal)» · $1,440.90 · PayPal 37Y4419829942071E · pedido 7460289 · com comprovante | `b9f92186` · fornecedor «GZ28US» · **$1,534.55** · sem pedido nem comprovante |
| quem pagou (gravado) | `paid_from` **GZ28BR**, `source` vazio | `paid_from` vazio, `source` GZ28US |
| ITEM | base $1,440.90 · preço $1,584.99 | base $1,534.55 · preço **$1,688.01** |
| pendência da GZ28BR | $1,584.99, venceu 23/08, não paga | $1,688.01, venceu 23/08, não paga |

- **O banco:** linha `095cdf47` «Cesar t 4829 Visa Direct CA 95131 9785», **$1,440.90**, autorizada **24/07**, postada 27/07, **NEW**. Foi o cartão final 9785 da Regions: PayPal $1,400 + taxa de $40.90 (2,9% + $0,30).
- **Efeito hoje:**
  - custo US lançado $2,975.45 contra $1,440.90 real;
  - a receber da BR $3,273.00 contra $1,584.99;
  - a conta corrente GZ28BR lê «a BR pagou conta nossa» (`lib/financials.ts:163-181`), o contrário do que houve;
  - o AUTO-LINK tira a linha do pool por ser paga por fora (`brPaid`, `lib/bankReconcile.server.ts:176`), e ela fica NEW;
  - «Quem pagou?» do Data Checker só lista linha sem `paid_from` (`app/adm/check/page.tsx:816`).
- **De onde vem o $1,534.55:**
  - a linha BR foi gravada na convenção antiga «+10% + FL Tax», total = custo × 1,10 × 1,065 (`lib/brPaidMirror.ts:18-26`) → `amount_usd` 1688.01;
  - o editor BR tira só os 10% (`G = 1.10` e `usdPrice … / G` no app BR, `app/rides/[id]/invoices/edit/[invoiceId]/page.tsx:3052`, :3064) → 1534.55;
  - o espelho copia o fornecedor como veio (app BR, `lib/usShoppingMirror.ts:143`), e o FL tax do espelho já é 0 (:17);
  - o comentário do BR em :3039 ainda fala em «re-applies Florida 6.5%».
- **Sem trilha:** o `paid_from` GZ28BR foi escrito depois de 24/08/2026 23:37:53 UTC (o EXACT casou esse par duas vezes antes, e ele pula GZ28BR), sem linha em `data_fixes`. O editor da invoice está descartado, porque `source` segue vazio. Só os logs do Supabase dizem quem escreveu.

**Ordem sugerida** (a do estudo de 10/09; decisão do Márcio):
1. **App do BR primeiro:** linha `4bf9b31e` do BR.180.1. Fornecedor «GZ28US» → «Cesar Tellez»; tirar « — via GZ28US (+10% + FL Tax)» do item; `amount_usd` 1688.01 → 1584.99; preço R$ 8.922,65 → R$ 8.378,10 (mesma taxa da linha, 5,285899) ou pela taxa do dono; manter `source` e `paid_from` GZ28US; salvar. O espelho reaproveita a 006.34 pelo `us_invoice_id` e a reconstrói: ITEM e pendência refeitos, despesas sem `br_expense_id` trocadas (app BR, `lib/usShoppingMirror.ts:101-112`, :171-206).
2. **App do US:** na despesa reconstruída da 006.34, `paid_from` GZ28US e forma PAYPAL; copiar comprovante e pedido 7460289 da `613610e8`; ligar a linha `095cdf47` no Bank Link.
3. **Aposentar a 006.25** pela tela: invoice `91def8f2`, despesa `613610e8`, ITEM e pendência.

**Cuidados:**
- **Não abrir e salvar a 006.25 no editor US** enquanto o `paid_from` for GZ28BR. O editor espelha no BR toda despesa com `(paid_from || source) === 'GZ28BR'` (`app/rides/[id]/invoices/edit/[invoiceId]/page.tsx:2647`) e criaria uma 085.N falsa.
- **Apagar só a 006.34 não resolve:** enquanto o BR.180.1 apontar para ela, o próximo save do BR cria a 006.N seguinte (app BR, `lib/usShoppingMirror.ts:120-123`).
- **Paliativo mínimo, se nada disso andar agora:** `613610e8.paid_from` → GZ28US, com trilha em `data_fixes` que diga que foi gente (ex.: rótulo «MANUAL · Regions 095cdf47 · Cesar Tellez»; «CERTO (Regions)» é o rótulo da prova da máquina e não serve pra edição à mão). Um DESFAZER do casamento não mexe nesse campo: ele só limpa o `paid_from` que o próprio casamento gravou como prova.

### 5.2 006.12 (medido 10/09/2026)

18 das 19 linhas têm fornecedor «GZ28US», somando **$4,101.76**, todas criadas em 18/08/2026 (espelho do BR.181.1). Os vendedores reais estão no texto do item: Wiseco, Texas Speed, TSP, ARP, Cometic, ACL, GM. O fornecedor circular esconde o vendedor (regra 8.4). A inflação pela convenção antiga não foi conferida linha a linha aqui.

### 5.3 US.030.1 e outros com a própria empresa como fornecedor (medido 10/09/2026)

- **US.030.1:** duas linhas com «GZ28 V8 SPEEDSHOP USA LLC» — «VIN 2C3CDZL91MH657802 Challenger SuperStock 2021 Purchase» $100,000 (17/06) e «Final Dealer Payment» $11,500 (18/06). Os wires foram para «HIGHLINE MOTOR» (casados ADJUST, taxa de $23 cada), e o cadastro não tem Highline.
- **Custo fixo:** «ReelShort — período de teste» $14.99 (28/08), também com fornecedor GZ28US.

### 5.4 US.050.1 — «SALDO em aberto» sem data (medido 10/09/2026)

«Demon 170 TorRed (stock CL37676) - SALDO em aberto do carro» · $20,000 · `payment_date` vazio · `paid_from` GZ28US · criada 05/09.

- **O risco:** o motor oferece essa linha como «candidato sem data … SIM preenche a data com a do banco» para **qualquer** saída de $20,000. Hoje isso acontece no wire de 17/07 para a Park Place e no de 03/09 para a Surf City (card É ESTA?). Um clique marca o saldo da Surf City como pago por outro vendedor. Com o Data Checker 1.51.0 a tela deixa de oferecer esse SIM em linha de dinheiro sem nome; a linha segue na lista, sem nada marcado.
- **Pergunta:** saldo em aberto ou parcela prevista é previsão, não despesa — deve existir como linha de gasto?

### 5.5 Outros casos do dia

- **$38,197.50 «TRANSFER OF FUNDS»,** pendente, de 10/09 = total com `extra` da US.050.1 «2 x Demon 170 Purchase» (§2.3).
- **Wire de $990 para Florida Review** sem registro, com duas traduções pagas por Zelle já lançadas em `expenses` (§2.4).
- **Arizona Motors:** $3,000 a mais no banco do que no registro (§2.4).
- **Foss Motors ×2 e Precision Dist:** $93,101.17 sem registro nenhum (§2.4).

---

## 6. O que a sessão do João vai fazer (auditoria)

### 6.1 Checks novos do Data Checker — todos só leitura

São módulos de servidor no molde de `lib/enginesAudit.server.ts`: nenhum insert, update, delete ou rpc (conferido). Cada item traz referências (tabela, id, link) e a evidência em uma frase. A decisão é sempre de gente; correção de lançamento é assunto do AUTO-BOOK e do Márcio. Rodados na produção em 10/09/2026 sobre cópias de HEAD `10fc4b8`. Entram no repositório no commit do Data Checker 1.51.0: `lib/auditWires.server.ts`, `lib/auditBucketOrders.server.ts`, `lib/auditPayer.server.ts`, `lib/auditDiscount.server.ts`, `lib/closeScore.server.ts` e a rota `/api/data-check/audit` (só leitura).

| check (módulo) | o que vigia | hoje (10/09) |
|---|---|---|
| **O WIRE TEM DONO?** (`auditWires`) | wire sem dono; taxa dentro do custo **e** na tarifa; wire dividido em registros; soma diferente; wire sem registro; o regime da ANALYSIS CHARGE mês a mês | 19 itens: 11 PAR (wires $402,550) · 1 DIVIDIDO (08/09) — taxa em dobro $276 no total (11 PAR $253 + DIVIDIDO $23), dos quais $69 esperam a tarifa de setembro: $207 hoje, como no §2.3 · 1 SOMA_DIFERENTE (Arizona, $3,000) · 4 SEM_REGISTRO ($94,091.17: Foss ×2, Precision, Florida Review) · 2 EXATO (15/06 e 18/06). Regime ok de nov/2025 a ago/2026; set espera $116. O módulo ainda não procura o nome em `expenses` (Florida Review, §2.4) — ajuste do lado do João |
| **BALDE EM DOBRO** (`auditBucketOrders`) | cobrança no balde que já estava lançada em várias linhas (PEDIDO > PEDIDO PARTE > DIA > DIA PARTE); cobrança no balde já estornada no banco | 15 DUPLICADO_PEDIDO · $15,133.91 · 19 ESTORNADO · $1,170.74 |
| **QUEM PAGOU DE VERDADE?** (`auditPayer`) | pagador GZ28BR ou sócio com saída da Regions ao centavo a ≤3 dias; mesma compra cobrada duas vezes da GZ28BR; fornecedor = a própria GZ28 | 1 PAGO_REGIONS (Tellez, $1,440.90) · 1 COBRADO_DUAS_VEZES (006.25 × 006.34) · 22 FORNECEDOR_GZ28 ($117,151.30 em linhas; defeito de cadastro — vale $0 no impacto e no placar) |
| **Desconto só no campo: a linha ficou a preço de lista** (`auditDiscount`) | linha com `item_discount` gravada a preço de lista (regra 7.7) | 335 linhas com desconto (121 reais, 214 de orçamento): 0 BRUTA · 1 BRUTA_PROVÁVEL ($17.88, polia Kong da US.040.3) · 86 LÍQUIDA · 34 SEM_PROVA — rodado de novo no repositório em 10/09, mesmo resultado. As linhas O&J Woo199927 estão gravadas líquidas hoje ($15.56 × 2 + $9.44 × 7 = $97.20): por isso 0 BRUTA não contradiz a medição da sessão do Márcio, feita antes do conserto |
| **PLACAR DO FECHAMENTO** (`closeScore`) | por mês: linhas da Regions sem dono, balde sem carro, pago no app sem linha no banco, recebido sem linha, extrato que prova o mês | 11 meses (nov/2025 a set/2026), **0 fecháveis**; extrato provado até 30/06/2026; 607 linhas abertas (saídas $1,055,356.48 · entradas $1,537,620.34); balde $136,495.52 |

O Data Checker já audita o AUTO-BOOK desde a DC 1.49.0, no card «Os dois motores concordam?» (`lib/enginesAudit.server.ts`, regra **13.6**): robô vivo, caixa sem token, fila de dúvidas parada, lançado sem cobrança no banco, DUPLA entre motores, compra online sem e-mail e dúvida cuja compra já está no balde.

### 6.2 A correção da integridade do DESFAZER (BL 1.5.1, no mesmo commit)

1. **O casamento sempre registra o que escreveu.** O claim grava `backfill: pre` (até a BL 1.5.0 gravava `null` — `lib/bankReconcile.server.ts:997` em `10fc4b8` — e só salvava se houvesse algo, :1037). As datas preenchidas entram depois, e numa falha no meio o que já foi escrito é salvo antes de relançar.
2. **DESFAZER nunca apaga data por igualdade.** Sem registro (backfill NULL), o `writeUnmatch` não escreve e grava na trilha «não revertido — confira» (a tela ainda não mostra). Até a BL 1.5.0 o ramo antigo (:1160-1178 em `10fc4b8`) apagava a data que coincidia com a do banco. Medido 10/09: 33 linhas / 46 registros expostos — em 9 dessas linhas a data tinha sido escrita pelo próprio motor (25–26/08), e agora ela fica.
3. **Memória de recusa com juízo.** `refuse` passa a ser obrigatório: o DESFAZER de casamento da máquina (nota «AUTO ·», mesmo já visto) e do WIRE + TAXA grava «NÃO É ESSE», e o DESFAZER LOTE, que é rollback, não grava. Até a BL 1.5.0 só gravava quando a linha não tinha sido vista (:1208 em `10fc4b8`).
4. **Adoção de agendada:**
   - a adoção automática ganha a nota «AUTO ·», e o card verde desfaz;
   - o ADOTAR feito por gente cai em CASADAS A CONFERIR;
   - uma agendada recusada não é adotada de novo (`buildPlan`, rota `adopt_scheduled`, `driftRows`), e a recusa não vira lançamento novo nem deixa outra agendada «certa»: com agendada recusada na janela, a linha vira pergunta;
   - o valor anterior volta fiel (valor nulo, forma de pagamento prevista).

**Por que interessa ao AUTO-BOOK:** quando a linha do robô nascer com data e pagador (8.7) e o AUTO-LINK só ligar, o que o motor escreve num registro do robô se reduz ao elo e, se estiver vazia, à data. A correção garante que nenhum DESFAZER apague uma data que o robô gravou.

---

## Pontos de encontro com o livro (resumo por regra)

| regra | ponto |
|---|---|
| **13.5** | o texto «só lança quando ninguém lançou» muda de sentido com a divisão de 10/09 (§1.1) |
| **B.1 · 6.11** | 154 linhas em 90 dias ($10,505.31) sem gatilho de e-mail: combustível, mercado, balcão, tarifas (§1.2) |
| **5.3** | assinaturas que o motor lança por regra PADRÃO: 8 linhas em 90 dias (§1.2) |
| **8.13** | taxa do wire: custo do carro ou tarifa do banco; $207 em dobro hoje, $276 com a tarifa de setembro (§2.3, §2.7) |
| **8.4** | cadastro fragmentado: Kramer ×3, Surf City sem cadastro, GZ28US como fornecedor (§2.5, §5) |
| **4.8 · 8.6 · 8.7** | autorização do cartão como prova quando não há documento; especificação do `payDateOf`; cortes UTC (§3) |
| **10.10** | UPDATE sem `.is('payment_date', null)` e data de vencimento como pagamento (§3.4) |
| **13.1** | portão de 3 dias silencia registro que ganha a data depois (§3.4) |
| **A.5** | `paid_at` em quatro convenções; só 5 de 162 no meio-dia de Orlando (§3.4) |
| **5.1 · 5.2 · 5.5 · 8.8** | soma por pedido antes de dizer «não existe» (§4.3) |
| **3.4 · 8.10** | estorno: DELAWAR $5,349.65 e 19 estornos já no balde (§4.2) |
| **A.8** | 53 wires de entrada; o caçador de receita por wire ainda não existe (§2.1) |

---

## Proveniência

- As medições foram feitas pela sessão do João em 10/09/2026, só com SELECT, com scripts locais daquela sessão (fora do repositório — a sessão do Márcio não os alcança). Se algum for útil, peça no `RECADOS.md` que a sessão do João o coloca no repositório.
- Código citado: US em HEAD `10fc4b8`. Os módulos de auditoria e a correção do DESFAZER estão no commit do Data Checker 1.51.0 · BL 1.5.1.
- A régua do nome do wire (§2.6) e o `payDateOf` (§3.3) estão aqui como código pronto para reuso. Nenhum dos dois foi ligado a escritor nenhum: gravar data e decidir a taxa é do AUTO-BOOK.
