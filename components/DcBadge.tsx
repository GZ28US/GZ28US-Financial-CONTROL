'use client'

// Selo do DATA CHECK: estágio + versão próprios (lib/dcVersion) — produto
// independente do FINANCIAL desde 20/ago/2026.
import { DC_STAGE, DC_VERSION } from '@/lib/dcVersion'

export default function DcBadge() {
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className="px-3 py-1 rounded-full text-xs font-bold bg-sky-950 text-sky-300 border border-sky-700">{DC_STAGE} · v{DC_VERSION}</span>
    </span>
  )
}
