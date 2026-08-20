// Versão da seção FINANCIAL — UM lugar só. Todo patch bumpa FIN_VERSION e
// acrescenta uma linha no topo do changelog (o hub lista, o PDF carimba).
// Quando as demonstrações merecerem, troca FIN_STAGE para 'BETA' aqui e o
// selo muda em todas as telas e relatórios de uma vez.
export const FIN_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const FIN_VERSION = '0.5.3'

export const FIN_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.5.3', date: '2026-08-20', notes: 'EMPRÉSTIMOS: DatePicker sempre em linha própria (estava espremido em meia coluna) e formulário de evento recolhido atrás de um + ADD EVENT por contrato — o card mostra só cabeçalho, saldo devedor e histórico até você querer lançar.' },
  { version: '0.5.2', date: '2026-08-20', notes: 'LEDGERS redesenhado no idioma do app (padrão costs/fixed/new): formulário empilhado com input grande, DatePicker inteiro, valor com prefixo $, botão verde de salvar, listas em card com selo colorido por tipo.' },
  { version: '0.5.1', date: '2026-08-20', notes: 'LEDGERS: seletor de data em modo compacto com duas colunas de largura — os três selects do DatePicker transbordavam a célula e cobriam os campos vizinhos.' },
  { version: '0.5.0', date: '2026-08-20', notes: 'Fase 2 — LEDGERS: capital dos sócios, empréstimos (contratos + recebeu/amortizou/juros) e saldos de caixa por conta, com tela própria e migration (MIGRATION_financial_ledgers.sql). DFC ganha a seção de financiamento completa; DRE ganha o resultado financeiro; Balanço ganha caixa, dívida, capital e o residual do patrimônio; DATA CHECK vigia saldo envelhecido.' },
  { version: '0.4.1', date: '2026-08-19', notes: 'Revisão adversarial (27 agentes, 4 lentes): 9 correções — filhas de QUOTE fora de tudo (eram $206k de fornecedores-fantasma no Balanço), paginação com ORDER BY estável, caixa na data real do recebimento (paid_at), custos ASSET na DRE, good_expenses acima do piso capitalizam, inputs sem categoria não somem, intercompany só conta o pago, carro OWN/TOOL não gera A/R nem FL tax, margem com guarda de zero.' },
  { version: '0.4.0', date: '2026-08-19', notes: 'DATA CHECK: checklist do que trava as demonstrações — invoices sem conclusion date, rides sem CAR DESTINY, pagamentos sem data, jobs legados sem linhas, fornecedores sem tipo, recebimentos vencidos sem baixa — com contagem, impacto em $ e link direto pro conserto.' },
  { version: '0.3.0', date: '2026-08-19', notes: 'Selo ALPHA + versionamento com changelog; versão carimbada nas telas e no rodapé dos PDFs.' },
  { version: '0.2.0', date: '2026-08-19', notes: 'Interface gráfica: KPIs e gráfico entradas×saídas com acumulado (DFC), cascata receita→EBITDA e abertura do OPEX (DRE), composição do ativo e do passivo (Balanço); download de PDF vetorial nas três telas.' },
  { version: '0.1.0', date: '2026-08-19', notes: 'Seção FINANCIAL no ADM: DFC método direto com drill até a linha de origem, DRE acumulada as-booked, Balanço parcial com gaps na cara; dataset único em lib/financials.' },
]
