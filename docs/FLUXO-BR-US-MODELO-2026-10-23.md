# A CONTA CORRENTE BR ↔ US — o modelo sem espelho (23/10/2026)

**Ordem do Márcio (23/10/2026):** «there is no PAID TO feature anymore, if it's a BR expense, it should be in BR app, if it's an US expense, it should be in the US app. the only difference will be the paid from thing» · «to incomes the PAID TO exists, and it's right, it's the opposite of the paid from in expenses» · «UPDATE THE APP TO ALL THESE MODS WE DECIDED, let's make this BR vs US flow PERFECT».

## 1. As três regras

| Fato | Onde mora | Campo que cruza | Efeito na conta |
|---|---|---|---|
| Despesa | no app da empresa DONA da despesa | **PAID BY** = quem pagou (GZ28US / GZ28BR) | a outra pagou → crédito dela |
| Renda | no app da empresa DONA da renda | **RECEIVED BY** = conta onde o dinheiro caiu | caiu na outra → débito dela |
| Transferência | `intercompany_transfers` (banco do US, lido pelos dois) | direção BR→US ou US→BR | BR→US abate o que o BR deve; US→BR aumenta |

**BR deve ao US = Σ (débitos do BR) − Σ (créditos do BR)**, em US$. Nada é copiado de um app para o outro. PAID TO sumiu da despesa; na renda o campo chama RECEIVED BY (coluna `paid_to` no banco, sem migração).

## 2. O que compõe o saldo (lib/intercompanyLedger.server.ts)

1. **App US, despesa PAID BY GZ28BR** (invoice_expenses, staff_expenses, assets, assets_expenses, inputs, inventory comprado, fixed_cost_expenses) → **US OWES** (crédito do BR). Só com `payment_date` (o dia em que o dinheiro do BR saiu). US$ = valor da linha; R$ = `amount_brl` gravado, senão US$ × bid real do dia.
2. **App US, renda RECEIVED BY GZ28BR** (invoice_incomes com `paid_at`) → **BR OWES**. R$ = `amount_brl` gravado, senão bid do dia.
3. **App BR, despesa PAID BY GZ28US** (invoice_expenses, expenses da folha, fixed_cost_expenses; REGIONS conta como GZ28US) → **BR OWES**, no `expense_date` (o dia em que o US pagou). US$ = `amount_usd` × qtd (+ tax/extra pelo fator da linha), senão R$ ÷ bid do dia.
4. **App BR, renda RECEIVED BY GZ28US** (invoice_payments com `paid_at`) → **US OWES**. US$ = `amount_usd`, senão R$ ÷ bid.
5. **Transferências**: BR→US → **US OWES**; US→BR → **BR OWES**. US$ = a perna em dólar; R$ = a perna em real; câmbio real = razão. Uma transferência SENT (saiu, não chegou) **não conta** até chegar (Márcio, 20/10: «quando o Allan mandar o comprovante … zera a operação»); fica na lista de pontas soltas. `fx_diff_usd` declarado ao fechar vira lançamento próprio.

**Fora da conta (e listado como tal):** quotes; as shopping invoices 006.N/085.N (histórico); invoice BUCKET; linha estornada; despesa do US sem data de pagamento; linha PAID BY GZ28BR com PAID TO GZ28BR dentro do app US; as 3 linhas «Crédito com GZ28US — FL tax» (crédito a decidir).

**Câmbio:** `fx_usd_brl_daily` (bid real, sem +0,20 e sem IOF). Sem cotação e sem valor gravado: US$ 0 e ponta solta — nunca número inventado.

## 3. As pontas soltas (a conta é perfeita quando a lista está vazia)

| Ponta | O que é | Quem resolve |
|---|---|---|
| SEM_DATA | linha PAID BY outra empresa sem data de pagamento | AutoBook do app |
| SEM_CAMBIO | dia sem bid | cron (AwesomeAPI) / AutoBook |
| CREDITO_A_DECIDIR | FL tax cobrada errada, crédito do BR | Márcio |
| RENDA_NO_BR_SEM_REMESSA | renda do US recebida no BR há 30+ dias sem transferência que a cubra | AutoBook US (cria a transferência com o Allan) |
| TRANSFERENCIA_EM_TRANSITO | saiu do BR, não chegou na Regions — fora do número até chegar | AutoBook US / cron |
| TRANSFERENCIA_A_REVISAR | falta uma perna ou o comprovante | AutoBook BR (lado R$) / US (lado US$) |
| TRANSFERENCIA_SEM_REGIONS | chegou sem linha da Regions casada | cron casa sozinho (mesmo valor, ±5 dias, linha NEW); ambíguo fica |

## 4. O que mudou no app (US `90e2685`, `<fase B>`; BR `8df0c31`)

- **GZ-FLOW** (`/gz-flow`): saldo, totais por tipo, as 2 eras, extrato mensal com saldo corrente, transferências (lista + cadastro/edição), todas as linhas com filtro, «não está no número» com o motivo, e o **Legacy check** (`/api/intercompany/reconcile`): a conta nova × o espelho velho, centavo por centavo.
- **Rotas:** `GET /api/intercompany/ledger`, `GET /api/intercompany/reconcile`, `GET|POST /api/intercompany/transfers` (create/update com trilha `data_fixes` check_key `intercompany-transfers`; nunca apaga).
- **`/api/crossing/balance`** devolve `brOwesUs` = a conta calculada (Balanço «Conta corrente GZ28BR» e card do Data Checker seguem), com o espelho antigo em `legacy` só para conferência.
- **DFC** (lib/financials.ts): a linha FUND_BR passa a ler a conta (despesa do BR paga pelo US = −, renda do BR recebida na Regions = +, transferência chegada = ±); a renda das 006.N sai do caixa (era a transferência com outro nome).
- **Motor do espelho** (`lib/crossing.server.ts`): `ESPELHO_ENCERRADO = true` — planeja (para o Legacy check), **não grava** em nenhum caso. `/api/br-mirror/paid` desligado. No BR, `/api/invoice/crossing` responde «espelho encerrado» sem chamar o US.
- **Cron `/api/cron/crossing`** (de hora em hora): casa transferências BR→US com a linha NEW da Regions (lib/intercompanyBank.server.ts) e loga o saldo e as pontas soltas.
- **`intercompany_transfers`** (MIGRATION_intercompany_transfers.sql, com os 3 GRANTs): semente = 14 remessas + 15 entradas de dinheiro do BR nas 006.N (saques Chase, wires, Zelle). 22 já casadas com a Regions pela renda legada.
- Os «Pending balance» do motor (placeholders) saíram, linha inteira na trilha (`espelho-encerrado-pendente`).

## 5. A conferência de 23/10 (02:50 Orlando)

Espelho (encerrado): **US$ 82.267,34**. Conta calculada: **US$ 54.833,06**. Diferença **27.434,28**, explicada inteira:
- **A +682,86** — itens/serviços lançados à mão nas 006.N (600 Palleting & Shipping, 63,81 tie down, 27,54 pigtail, −8,49 refund…).
- **B +300,39** — US$ 300 de ARRIVAL numa invoice de carro (US.022.4) + 0,39 de arredondamento. (A 1ª conferência trazia aqui +33.844,52 de duas «remessas» SENT: a REM-2026-07-02-T130K era EXPECTATIVA — o R$ 130k foi TED do Sidney ENTRANDO no BR, achado pela AutoBook BR no C6 — e foi anulada; o cheque de 20/10 é fato, mas transferência em trânsito não conta até chegar.)
- **C −7.093,10** — linha estornada do US que o espelho ainda cobrava (085.42, TSP Hemi 2kHP US$ 8.032,48) menos as despesas novas sem espelho (Alcatraz US.015.3 e 2 voos PESSOAL do SEMA 2025).
- **D 0,00**.

## 6. Como lançar daqui pra frente

- Compra do US para carro do BR, paga pela Regions → **linha no app BR**, PAID BY GZ28US, `amount_usd` = o que o BR deve ao US (com o markup acordado, se houver), comprovante. Nada no app US.
- Conta do US paga com dinheiro do BR (salário, hotel, passagem, peça de carro do US, custo fixo) → **linha no app US**, PAID BY GZ28BR, `amount_brl` = o R$ real quando houver, comprovante.
- Cliente do US que paga em R$ no C6 → renda na invoice do US, RECEIVED BY GZ28BR, `amount_brl`, PIX anexado (fica lá: prova o cliente).
- Cliente do BR que paga na Regions → renda na invoice do BR, RECEIVED BY GZ28US, `amount_usd`, comprovante da Regions.
- Dinheiro mandado ao Allan / cheque / saque → **transferência** no GZ-FLOW: saiu (R$, data, PIX), chegou (US$, data, Regions), `covers` = as rendas que ela quita. A Regions casa sozinha.
- 2025 (20/08 → SEMA → 10/11, antes da Regions): **tudo do US foi pago pelo BR** → app US, PAID BY GZ28BR (exceção: aluguel pago com dinheiro do Humberto).
