'use client'

// Selo da seção FINANCIAL: estágio + versão (lib/finVersion) ao lado do aviso
// de desenvolvimento. Um componente só para as quatro telas mostrarem o mesmo.
import { FIN_STAGE, FIN_VERSION } from '@/lib/finVersion'

export default function FinBadge() {
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-950 text-purple-300 border border-purple-700">{FIN_STAGE} · v{FIN_VERSION}</span>
      <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>
    </span>
  )
}
