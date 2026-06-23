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

export default function SourceSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select value={value || DEFAULT_SOURCE} onChange={(e) => onChange(e.target.value)} className={className}>
      {EXPENSE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
      {value && !EXPENSE_SOURCES.includes(value) && <option value={value}>{value}</option>}
    </select>
  )
}
