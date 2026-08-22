'use client'

// Selo do BANK LINK: estágio + versão próprios (lib/blVersion).
import { BL_STAGE, BL_VERSION } from '@/lib/blVersion'

export default function BlBadge() {
  return (
    <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300 border border-amber-700">{BL_STAGE} · v{BL_VERSION}</span>
  )
}
