'use client'

import { useEffect } from 'react'

// The ONE SEND TO chooser used everywhere in the app. It is ALWAYS the same four
// options — Supplier · Report Group · Both · Skip — with Skip as the default (Esc /
// backdrop click = Skip = don't send). The dialog only PICKS a target and hands it
// back via onChoose; each caller decides what actually gets sent (a payment proof, a
// registration link, a report…). Keep this the single source of truth for every SEND
// TO box in the system so they never drift apart.
export type SendTarget = 'supplier' | 'group' | 'both' | 'skip'

export default function SendToDialog({
  open,
  onChoose,
  title = 'SEND TO',
  subtitle = 'Who do you want to send to?',
  supplierLabel = 'SUPPLIER',
  supplierHint,
  groupHint,
  busy = false,
  status = '',
}: {
  open: boolean
  onChoose: (t: SendTarget) => void
  title?: string
  subtitle?: string
  supplierLabel?: string
  supplierHint?: string
  groupHint?: string
  busy?: boolean
  status?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onChoose('skip') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onChoose])

  if (!open) return null
  const btn = 'disabled:opacity-60 px-6 py-4 rounded-2xl text-lg font-bold text-left'
  const hint = 'block text-sm font-normal opacity-80'
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50" onClick={() => onChoose('skip')}>
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold mb-1">{title}</h2>
        <p className="text-gray-400 mb-5">{subtitle}</p>
        <div className="grid grid-cols-1 gap-3">
          <button onClick={() => onChoose('supplier')} disabled={busy} className={`bg-emerald-700 hover:bg-emerald-600 ${btn}`}>
            👤 {supplierLabel}{supplierHint && <span className={hint}>{supplierHint}</span>}
          </button>
          <button onClick={() => onChoose('group')} disabled={busy} className={`bg-blue-700 hover:bg-blue-600 ${btn}`}>
            📣 REPORT GROUP{groupHint && <span className={hint}>{groupHint}</span>}
          </button>
          <button onClick={() => onChoose('both')} disabled={busy} className={`bg-purple-700 hover:bg-purple-600 ${btn}`}>
            👥 BOTH
          </button>
          <button onClick={() => onChoose('skip')} disabled={busy} className={`bg-gray-700 hover:bg-gray-600 ring-2 ring-gray-500 ${btn}`}>
            ⏭️ SKIP<span className={hint}>Default — don&apos;t send</span>
          </button>
        </div>
        {status && <p className="mt-4 text-center text-gray-300">{status}</p>}
      </div>
    </div>
  )
}
