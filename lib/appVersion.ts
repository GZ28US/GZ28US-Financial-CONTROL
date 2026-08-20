// Versão do CONTROL APP (núcleo) — invoices, rides, clientes, custos: o
// sistema maduro que roda a operação. Track separado dos produtos em
// desenvolvimento (FINANCIAL em lib/finVersion, DATA CHECK em lib/dcVersion)
// desde 20/ago/2026, por regra do Márcio: FINANCIAL versiona só o que muda
// as DEMONSTRAÇÕES; upgrade de invoice/ride é upgrade do APP.
// Era anterior: mudanças core de 19–20/ago (destinos, EXPORTED, trava do
// fechamento) ficaram registradas no changelog do FINANCIAL (v0.6–v0.9).
export const APP_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'STABLE'
export const APP_VERSION = '1.1.1'

export const APP_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '1.1.1', date: '2026-08-20', notes: 'Editor de invoice: ADD PENDING BALANCE sempre visível — cinza com NADA PENDENTE (e tooltip) quando os incomes já cobrem o grand total; botão que some parece botão que sumiu.' },
  { version: '1.1.0', date: '2026-08-20', notes: 'EXPECTED CONCLUSION DATE no invoice (MIGRATION_invoice_expected_conclusion.sql): a previsão ganha campo próprio, o banner PROMISED TO muda de casa e delivery/conclusion viram só fato. Selo de prazo no invoice: ATRASADA/ADIANTADA/NO PRAZO contra a previsão, EM ATRASO correndo quando ela vence sem conclusão.' },
  { version: '1.0.0', date: '2026-08-20', notes: 'Track de versão próprio pro núcleo do app (regra do Márcio): FINANCIAL versiona só demonstrações, DATA CHECK versiona a bancada, e upgrades de invoice/ride/etc. vivem aqui. Sistema em produção desde jun/2026.' },
]
