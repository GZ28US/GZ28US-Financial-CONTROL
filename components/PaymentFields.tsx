'use client'

import DatePicker from '@/components/DatePicker'

// ── UNIVERSAL PAYMENT BLOCK (Márcio, 01/ago/2026) ────────────────────────────
// Every expense/income enrollment area of the system shows THE SAME payment
// fields, in this order: PAYMENT METHOD → PAID FROM → PAID TO → PAID toggle
// (+ PAYMENT DATE). Semantics (dele, com exemplo da American Airlines):
//   PAID FROM = quem pagou (de onde saiu o dinheiro)
//   PAID TO   = de quem é a conta (não confundir com SUPPLIER!)
//   SUPPLIER  = quem recebeu o dinheiro — campo próprio, fora deste bloco
// Quando PAID FROM ≠ PAID TO (ex.: GZ28BR paga conta do GZ28US), a linha entra
// no GZ28US vs GZ28BR FLOW (abate/gera dívida entre as oficinas).
// Default: PAID ON — "when I add an expense, it means it's paid".
// Desde 12/set/2026 a ORDEM continua a mesma, mas nem todo campo aparece: quem
// decide é a tabela (PAYER_RULE, logo abaixo) — nas despesas só PAID FROM, nas
// incomes só PAID TO, e em SUPPLIES / ESTOQUE / CUSTO FIXO nenhum dos dois.

// 'GZ28US Regions DebitCard' (Márcio, 19/ago/2026): o cartão de débito da LLC é
// forma de pagamento própria, SEM número — o final do cartão muda quando o banco
// reemite; o nome não. 'CARD' fica para cartões que não são o débito da Regions.
export const PAYMENT_METHODS = ['CASH', 'ZELLE', 'GZ28US Regions DebitCard', 'WIRE', 'ACH', 'CARD', 'BANK ACCOUNT', 'CHECK', 'PAYPAL'] as const
// Dinheiro que cai numa conta BRASILEIRA se move por meios brasileiros — não
// existe ACH nem Zelle no Brasil, nem PIX nos EUA. Quando PAID TO = GZ28BR, o
// formulário troca a lista (Márcio, 26/ago/2026). São os métodos que de fato
// aparecem nos recebimentos do app do BR.
export const PAYMENT_METHODS_BR = ['PIX', 'TED', 'CASH', 'CHEQUE', 'CARD'] as const
export const methodsFor = (paidTo: string | null | undefined): readonly string[] =>
  paidTo === 'GZ28BR' ? PAYMENT_METHODS_BR : PAYMENT_METHODS

// DOIS PAGADORES NO APP US, e só (Márcio, 11/set/2026: «no app do US não é pra ter a
// opção do CLIENT, tire»). Saíram CLIENT — o cliente pagando o fornecedor direto é
// regra do app do BR —, RAFA (apelido da conta corrente da BR, nunca usado) e os
// sócios BETO e HERALDO: conta paga do bolso de sócio *"não teve, e quando tiver, vão
// ficar em outra área do app"*. Nenhuma linha do banco usava nenhum dos quatro.
// Valor legado fora desta lista continua aparecendo no seletor como opção-fantasma
// (logo abaixo, no <select>) — a tela nunca esconde o que está gravado.
export const PAID_FROM_OPTIONS = ['GZ28US', 'GZ28BR'] as const
export const PAID_TO_OPTIONS = ['GZ28US', 'GZ28BR'] as const

// ── QUEM PAGA E QUEM RECEBE, TABELA POR TABELA (Márcio, 11/set/2026) ─────────
// A régua dele: tabela que é movimentação de dinheiro grava os dois campos, no mínimo
// com GZ28US escondido («isso é movimentação de $, então tem que ter GZ28US escondido
// pra paid to e paid from»). ESCOLHA só existe em cinco tabelas («nenhuma outra do app»):
//   · nas despesas (invoice_expenses, assets, assets_expenses, staff_expenses) o PAID
//     FROM escolhe GZ28US ou GZ28BR, e o PAID TO fica «SEMPRE como GZ28US, pra todas,
//     só não mostre na tela»;
//   · nas incomes é ao contrário: o PAID TO escolhe e o PAID FROM SAI — renda não tem
//     quem-pagou, e a coluna cai no banco numa onda própria. 'none' = nunca vai no payload.
// Em inputs, inventory e fixed_cost_expenses não há escolha: os dois são GZ28US, escondidos.
// SEM CHECK no banco, de propósito: «qualquer empresa pode pagar pra qualquer empresa, o
// importante é o Flow reportar» — um cadeado fecharia essa porta para sempre; a regra
// mora aqui, e a tela e a gravação leem a MESMA linha desta tabela (por isso o
// componente e o paymentToRow pedem o nome da tabela, e não dois booleanos soltos que
// uma página poderia esconder de um lado e esquecer do outro).
// invoice_items não aparece: «não existe movimentação financeira no ITEMS».
export type PayerMode = 'choice' | 'house' | 'none'
export const HOUSE_PAYER = 'GZ28US'
export const PAYER_RULE = {
  invoice_expenses: { paidFrom: 'choice', paidTo: 'house' },
  invoice_incomes: { paidFrom: 'none', paidTo: 'choice' },
  assets: { paidFrom: 'choice', paidTo: 'house' },
  assets_expenses: { paidFrom: 'choice', paidTo: 'house' },
  staff_expenses: { paidFrom: 'choice', paidTo: 'house' },
  inputs: { paidFrom: 'house', paidTo: 'house' },
  inventory: { paidFrom: 'house', paidTo: 'house' },
  fixed_cost_expenses: { paidFrom: 'house', paidTo: 'house' },
} as const satisfies Record<string, { paidFrom: PayerMode; paidTo: PayerMode }>
export type PayerTable = keyof typeof PAYER_RULE

export type PaymentInfo = {
  method: string
  paidFrom: string
  paidTo: string
  paid: boolean
  paymentDate: string // YYYY-MM-DD; meaningful when paid
  // Como a linha estava ANTES do formulário: null = linha nova (defaultPayment);
  // true/false = linha do banco com ou sem payment_date (paymentFromRow). É o que
  // decide quando o campo escondido grava — ver hiddenPayerBorn.
  wasPaid: boolean | null
}

// ESCONDIDO GRAVA — na hora em que o pagador nasce, e só nela.
// Campo escondido que não grava é pior que campo à mostra. Mas campo escondido que
// reescreve linha velha a cada salvamento apaga a diferença entre «é GZ28US» e
// «ninguém olhou» — medido em 12/set/2026: PAID TO vazio em 1.133 invoice_expenses (764
// de invoice real), 30 assets, 9 assets_expenses e 56 staff_expenses, e o DFC já lê vazio
// como GZ28US — e moveria calado o que foi gravado diferente de propósito (o seguro de
// viagem do Jeferson, PAID TO GZ28BR, US$ 89,09). Então:
//   · linha NOVA → GZ28US, sempre, paga ou não;
//   · linha que já existe e cujo pagamento é registrado NESTE salvamento (estava sem
//     payment_date e sai com) → GZ28US: «o paid_from nasce na hora do pagamento»;
//   · fora isso → a chave nem vai no payload, e o banco fica com o que tem.
export function hiddenPayerBorn(wasPaid: boolean | null, paidNow: boolean): boolean {
  return wasPaid === null || (!wasPaid && paidNow)
}

// Só as colunas de pagador, pela régua da tabela. `paidNow` = o registro sai deste
// salvamento com payment_date. Use direto nos modais que montam o update à mão
// (RECORD PAYMENT); os formulários comuns passam pelo paymentToRow, que chama isto.
export function payerToRow(p: PaymentInfo, table: PayerTable, paidNow: boolean): { paid_from?: string | null; paid_to?: string | null } {
  const rule: { paidFrom: PayerMode; paidTo: PayerMode } = PAYER_RULE[table]
  const born = hiddenPayerBorn(p.wasPaid, paidNow)
  const out: { paid_from?: string | null; paid_to?: string | null } = {}
  if (rule.paidFrom === 'choice') out.paid_from = p.paidFrom || null
  else if (rule.paidFrom === 'house' && born) out.paid_from = HOUSE_PAYER
  if (rule.paidTo === 'choice') out.paid_to = p.paidTo || null
  else if (rule.paidTo === 'house' && born) out.paid_to = HOUSE_PAYER
  return out
}

export function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function defaultPayment(overrides?: Partial<PaymentInfo>): PaymentInfo {
  return { method: 'CASH', paidFrom: 'GZ28US', paidTo: 'GZ28US', paid: true, paymentDate: todayYmd(), wasPaid: null, ...overrides }
}

// Row → PaymentInfo (for edit pages). paid = payment_date present.
// Caso Drácula (João, 25/ago): linha EXISTENTE com paid_from NULL aparecia como
// "GZ28US" no formulário — parecia preenchida (o Data Checker dizia que não, e o
// Data Checker estava certo) e qualquer salvamento gravava o default fabricado.
// Editar mostra a VERDADE: vazio = "— quem pagou? —" (o default GZ28US continua
// só no defaultPayment, pra lançamento NOVO).
export function paymentFromRow(row: { payment_method?: string | null; paid_from?: string | null; paid_to?: string | null; payment_date?: string | null }): PaymentInfo {
  return {
    method: row.payment_method || 'CASH',
    paidFrom: row.paid_from || '',
    paidTo: row.paid_to || '',
    paid: !!row.payment_date,
    paymentDate: row.payment_date || todayYmd(),
    wasPaid: !!row.payment_date,
  }
}

// PaymentInfo → DB columns. `expenseDate` (when given and valid) wins over the
// picker as the paid date ("lancei = paguei na data da despesa").
// Os pagadores saem pela régua da tabela (payerToRow): escolha grava o que a tela
// mostra; escondido grava GZ28US quando o pagador nasce e, fora disso, não entra.
// Quem precisa de linha SEM pagamento passa `paid: false` — nunca anula o
// payment_date depois, senão a régua já teria decidido achando que pagou.
export function paymentToRow(p: PaymentInfo, table: PayerTable, expenseDate?: string | null) {
  const date = p.paid ? ((expenseDate && /^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) ? expenseDate : p.paymentDate) : null
  return {
    payment_method: p.method || null,
    ...payerToRow(p, table, date !== null),
    payment_date: date,
  }
}

const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
// Classes inteiras escritas à mão: o Tailwind só gera o que acha LITERAL no código.
const GRID_COLS: Record<number, string> = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }

export default function PaymentFields({ value, onChange, table, hidePaidToggle }: {
  value: PaymentInfo
  onChange: (v: PaymentInfo) => void
  table: PayerTable
  hidePaidToggle?: boolean
}) {
  const set = (patch: Partial<PaymentInfo>) => onChange({ ...value, ...patch })
  const rule: { paidFrom: PayerMode; paidTo: PayerMode } = PAYER_RULE[table]
  const showFrom = rule.paidFrom === 'choice'
  const showTo = rule.paidTo === 'choice'
  // A tela nunca esconde o que está gravado FORA da régua: campo escondido com valor
  // que não é GZ28US (nem vazio) ganha uma linha dizendo o que está lá e o que o
  // salvamento faz com ele — o mesmo espírito da opção-fantasma dos seletores.
  const offRule = (mode: PayerMode, stored: string, label: string) => (
    mode === 'house' && stored && stored !== HOUSE_PAYER
      ? (
        <p className="sm:col-span-full text-sm text-amber-300">
          {label} gravado nesta linha: {stored} — fora da régua desta tabela (aqui é sempre {HOUSE_PAYER}).{' '}
          {value.wasPaid ? 'O campo não aparece e este salvamento não mexe nele.' : `Se este salvamento registrar o pagamento, vira ${HOUSE_PAYER}.`}
        </p>
      )
      : null
  )
  return (
    <div className={`grid grid-cols-1 ${GRID_COLS[1 + Number(showFrom) + Number(showTo)]} gap-4`}>
      <div>
        <label className="block mb-2 text-lg font-bold">PAYMENT METHOD</label>
        <select value={value.method} onChange={(e) => set({ method: e.target.value })} className={selectClass}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          {value.method && !PAYMENT_METHODS.includes(value.method as any) && <option value={value.method}>{value.method}</option>}
        </select>
      </div>
      {showFrom && (
        <div>
          <label className="block mb-2 text-lg font-bold">PAID FROM</label>
          <select value={value.paidFrom} onChange={(e) => set({ paidFrom: e.target.value })} className={selectClass + (!value.paidFrom ? ' border-amber-500 text-amber-300' : '')}>
            {!value.paidFrom && <option value="">— quem pagou? —</option>}
            {PAID_FROM_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            {value.paidFrom && !PAID_FROM_OPTIONS.includes(value.paidFrom as any) && <option value={value.paidFrom}>{value.paidFrom}</option>}
          </select>
        </div>
      )}
      {showTo && (
        <div>
          <label className="block mb-2 text-lg font-bold">PAID TO</label>
          <select value={value.paidTo} onChange={(e) => set({ paidTo: e.target.value })} className={selectClass + (!value.paidTo ? ' border-amber-500 text-amber-300' : '')}>
            {!value.paidTo && <option value="">— de quem é a conta? —</option>}
            {PAID_TO_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            {value.paidTo && !PAID_TO_OPTIONS.includes(value.paidTo as any) && <option value={value.paidTo}>{value.paidTo}</option>}
          </select>
        </div>
      )}
      {offRule(rule.paidFrom, value.paidFrom, 'PAID FROM')}
      {offRule(rule.paidTo, value.paidTo, 'PAID TO')}
      {!hidePaidToggle && (
        <div className="sm:col-span-full flex items-start gap-4 flex-wrap">
          {/* Invisible label keeps the button on the same line as the date selects
              (the DatePicker carries its own label + a "Clear date" line below). */}
          <div>
            <label className="block mb-2 text-lg font-bold">&nbsp;</label>
            <button
              type="button"
              onClick={() => set({ paid: !value.paid })}
              className={`px-6 py-4 rounded-2xl text-xl font-bold ${value.paid ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
            >
              {value.paid ? 'PAID ✓' : 'NOT PAID'}
            </button>
          </div>
          {value.paid && (
            <div className="flex-1 min-w-[14rem]">
              <DatePicker label="PAYMENT DATE" value={value.paymentDate} onChange={(d) => set({ paymentDate: d })} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
