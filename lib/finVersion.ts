// Versão da seção FINANCIAL — UM lugar só. Todo patch bumpa FIN_VERSION e
// acrescenta uma linha no topo do changelog (o hub lista, o PDF carimba).
// Quando as demonstrações merecerem, troca FIN_STAGE para 'BETA' aqui e o
// selo muda em todas as telas e relatórios de uma vez.
export const FIN_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const FIN_VERSION = '0.3.0'

export const FIN_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.3.0', date: '2026-08-19', notes: 'Selo ALPHA + versionamento com changelog; versão carimbada nas telas e no rodapé dos PDFs.' },
  { version: '0.2.0', date: '2026-08-19', notes: 'Interface gráfica: KPIs e gráfico entradas×saídas com acumulado (DFC), cascata receita→EBITDA e abertura do OPEX (DRE), composição do ativo e do passivo (Balanço); download de PDF vetorial nas três telas.' },
  { version: '0.1.0', date: '2026-08-19', notes: 'Seção FINANCIAL no ADM: DFC método direto com drill até a linha de origem, DRE acumulada as-booked, Balanço parcial com gaps na cara; dataset único em lib/financials.' },
]
