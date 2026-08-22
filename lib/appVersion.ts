// Diário de bordo do CONTROL APP (núcleo) — invoices, rides, clientes,
// custos: o sistema maduro que roda a operação. SEM número de versão e SEM
// selo, por regra do Márcio (20/ago): retro-versionar 1.094 commits desde
// mai/2026 seria ficção — o git é a história real; só FINANCIAL
// (lib/finVersion) e DATA CHECK (lib/dcVersion) carregam selo, por serem
// produtos em construção. Upgrade do núcleo ganha uma linha datada aqui.
export const APP_CHANGELOG: { date: string; notes: string }[] = [
  { date: '2026-08-21', notes: 'BANK: a lista mostrava só as 60 transações mais recentes (parava em 17/ago com 277 só em agosto) — agora 300 por padrão com SHOW ALL e contador "mostrando X de N".' },
  { date: '2026-08-21', notes: 'BANK: histórico completo — link token pede 730 dias (máximo do Plaid; o original pedia 90, por isso a Regions começava em 26/mai) e o card da conexão ganha FULL HISTORY — 24 MONTHS, que reabre o Link em update mode na mesma conexão; o passado chega pelo webhook HISTORICAL_UPDATE.' },
  { date: '2026-08-21', notes: 'Invoice: trava do fechamento (data de hoje oferecida) e selo ATRASADA/EM ATRASO passam a usar o relógio de Orlando com fuso fixo — antes seguiam o fuso do navegador, o que quebraria no Brasil.' },
  { date: '2026-08-20', notes: 'Editor de invoice: ADD PENDING BALANCE sempre visível — cinza com NADA PENDENTE (e tooltip) quando os incomes já cobrem o grand total; botão que some parece botão que sumiu.' },
  { date: '2026-08-20', notes: 'EXPECTED CONCLUSION DATE no invoice (MIGRATION_invoice_expected_conclusion.sql): a previsão ganha campo próprio, o banner PROMISED TO muda de casa e delivery/conclusion viram só fato. Selo de prazo no invoice: ATRASADA/ADIANTADA/NO PRAZO contra a previsão, EM ATRASO correndo quando ela vence sem conclusão.' },
  { date: '2026-08-20', notes: 'Diário de bordo criado: upgrades do núcleo saem do changelog do FINANCIAL (que versiona só demonstrações). Em produção desde mai/2026 — 1.094 commits até aqui; história completa no git.' },
]
