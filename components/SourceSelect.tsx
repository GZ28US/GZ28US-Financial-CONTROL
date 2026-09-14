'use client'

// The SOURCE of an expense = who paid for it. US app: GZ28US (default) or GZ28BR.
// A legacy/unknown stored value is kept selectable so older records aren't lost.
export const EXPENSE_SOURCES = ['GZ28US', 'GZ28BR']
export const DEFAULT_SOURCE = 'GZ28US'

// Map a scanned payer name (e.g. a PIX "pagador") to one of EXPENSE_SOURCES;
// falls back to the default when nothing matches.
export function matchSource(payer: string | null | undefined): string {
  const p = (payer || '').toLowerCase()
  if (p) for (const s of EXPENSE_SOURCES) {
    if (s.toLowerCase().split(/\s+/).some(w => w.length >= 3 && p.includes(w))) return s
  }
  return DEFAULT_SOURCE
}

// O SELETOR <SourceSelect> SAIU em 14/set/2026 (onda 10 do pacote PAID FROM/TO). Ele gravava só o
// SOURCE legado e mostrava GZ28US no lugar do vazio — em SUPPLIES era um segundo PAID FROM ao lado
// do bloco de pagamento (lei «campo duplicado: nunca»), e na despesa extra de asset e nos diálogos
// de compra o paid_from, que é quem manda, ficava de fora. Pagador à mostra agora é só o bloco
// (components/PaymentFields) ou o PaidFromSelect de lá, pela régua de lib/payerRule.ts. Aqui ficam
// as constantes do SOURCE, que ainda é gravado como espelho e lido como pagador reserva (whoPaid).
