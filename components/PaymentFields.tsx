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

export const PAYMENT_METHODS = ['CASH', 'ZELLE', 'WIRE', 'ACH', 'CARD', 'BANK ACCOUNT', 'CHECK', 'PAYPAL'] as const
export const PAID_FROM_OPTIONS = ['GZ28US', 'GZ28BR', 'RAFA', 'BETO'] as const
export const PAID_TO_OPTIONS = ['GZ28US', 'GZ28BR'] as const

export type PaymentInfo = {
  method: string
  paidFrom: string
  paidTo: string
  paid: boolean
  paymentDate: string // YYYY-MM-DD; meaningful when paid
}

export function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function defaultPayment(overrides?: Partial<PaymentInfo>): PaymentInfo {
  return { method: 'CASH', paidFrom: 'GZ28US', paidTo: 'GZ28US', paid: true, paymentDate: todayYmd(), ...overrides }
}

// Row → PaymentInfo (for edit pages). paid = payment_date present.
export function paymentFromRow(row: { payment_method?: string | null; paid_from?: string | null; paid_to?: string | null; payment_date?: string | null }): PaymentInfo {
  return {
    method: row.payment_method || 'CASH',
    paidFrom: row.paid_from || 'GZ28US',
    paidTo: row.paid_to || 'GZ28US',
    paid: !!row.payment_date,
    paymentDate: row.payment_date || todayYmd(),
  }
}

// PaymentInfo → DB columns. `expenseDate` (when given and valid) wins over the
// picker as the paid date ("lancei = paguei na data da despesa").
export function paymentToRow(p: PaymentInfo, expenseDate?: string | null) {
  const date = p.paid ? ((expenseDate && /^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) ? expenseDate : p.paymentDate) : null
  return {
    payment_method: p.method || null,
    paid_from: p.paidFrom || null,
    paid_to: p.paidTo || null,
    payment_date: date,
  }
}

const selectClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'

export default function PaymentFields({ value, onChange, hidePaidToggle }: {
  value: PaymentInfo
  onChange: (v: PaymentInfo) => void
  hidePaidToggle?: boolean
}) {
  const set = (patch: Partial<PaymentInfo>) => onChange({ ...value, ...patch })
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label className="block mb-2 text-lg font-bold">PAYMENT METHOD</label>
        <select value={value.method} onChange={(e) => set({ method: e.target.value })} className={selectClass}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          {value.method && !PAYMENT_METHODS.includes(value.method as any) && <option value={value.method}>{value.method}</option>}
        </select>
      </div>
      <div>
        <label className="block mb-2 text-lg font-bold">PAID FROM</label>
        <select value={value.paidFrom} onChange={(e) => set({ paidFrom: e.target.value })} className={selectClass}>
          {PAID_FROM_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          {value.paidFrom && !PAID_FROM_OPTIONS.includes(value.paidFrom as any) && <option value={value.paidFrom}>{value.paidFrom}</option>}
        </select>
      </div>
      <div>
        <label className="block mb-2 text-lg font-bold">PAID TO</label>
        <select value={value.paidTo} onChange={(e) => set({ paidTo: e.target.value })} className={selectClass}>
          {PAID_TO_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          {value.paidTo && !PAID_TO_OPTIONS.includes(value.paidTo as any) && <option value={value.paidTo}>{value.paidTo}</option>}
        </select>
      </div>
      {!hidePaidToggle && (
        <div className="sm:col-span-3 flex items-end gap-4 flex-wrap">
          <button
            type="button"
            onClick={() => set({ paid: !value.paid })}
            className={`px-6 py-4 rounded-2xl text-xl font-bold ${value.paid ? 'bg-green-700 hover:bg-green-600' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
          >
            {value.paid ? 'PAID ✓' : 'NOT PAID'}
          </button>
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
