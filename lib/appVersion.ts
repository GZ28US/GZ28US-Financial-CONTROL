// Diário de bordo do CONTROL APP (núcleo) — invoices, rides, clientes,
// custos: o sistema maduro que roda a operação. SEM número de versão e SEM
// selo, por regra do Márcio (20/ago): retro-versionar 1.094 commits desde
// mai/2026 seria ficção — o git é a história real; só FINANCIAL
// (lib/finVersion) e DATA CHECK (lib/dcVersion) carregam selo, por serem
// produtos em construção. Upgrade do núcleo ganha uma linha datada aqui.
export const APP_CHANGELOG: { date: string; notes: string }[] = [
  { date: '2026-08-24', notes: 'Untangle do catálogo: source_type volta a ser só ORIGEM (SCAN/HUNT/MANUAL/INVOICE, com constraint); o cadeado vive em locked_at/locked_by e o kit em is_kit — badge e isLockedPart atualizados (tolerantes ao legado até a migration), TRAVAR/DESTRAVAR não altera mais a origem, kit novo nasce MANUAL+is_kit. Categoria ganha vocabulário fechado de 13 valores (lib/partsMeta).' },
  { date: '2026-08-24', notes: 'Identidade de peças no núcleo (pré-P1 do Crew Chief): STREAM e INPUTS/NEW ganham o PART PICKER — a entrada escolhe a peça do catálogo e já nasce linkada (part_id), preenchendo nome/fornecedor; e a página PARTS ganha TRAVAR/DESTRAVAR com trilha (parts-lock): travar = "dados conferidos", congela; destravar exige confirmação e fica registrado com autor. O cadeado que o Márcio inventou pra se proteger dele mesmo, agora com recibo.' },
  { date: '2026-08-21', notes: 'Invoice: trava do fechamento (data de hoje oferecida) e selo ATRASADA/EM ATRASO passam a usar o relógio de Orlando com fuso fixo — antes seguiam o fuso do navegador, o que quebraria no Brasil.' },
  { date: '2026-08-20', notes: 'Editor de invoice: ADD PENDING BALANCE sempre visível — cinza com NADA PENDENTE (e tooltip) quando os incomes já cobrem o grand total; botão que some parece botão que sumiu.' },
  { date: '2026-08-20', notes: 'EXPECTED CONCLUSION DATE no invoice (MIGRATION_invoice_expected_conclusion.sql): a previsão ganha campo próprio, o banner PROMISED TO muda de casa e delivery/conclusion viram só fato. Selo de prazo no invoice: ATRASADA/ADIANTADA/NO PRAZO contra a previsão, EM ATRASO correndo quando ela vence sem conclusão.' },
  { date: '2026-08-20', notes: 'Diário de bordo criado: upgrades do núcleo saem do changelog do FINANCIAL (que versiona só demonstrações). Em produção desde mai/2026 — 1.094 commits até aqui; história completa no git.' },
]
