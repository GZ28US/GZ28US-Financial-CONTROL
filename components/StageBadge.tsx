'use client'

// Selo dos produtos em construção (Márcio, 21–22/ago): ALPHA é roxo em todos os
// fronts (Financial Hub e Bank Link iguais); BETA mantém o azul que o Data Checker
// sempre teve. Ambos levam EM DESENVOLVIMENTO em âmbar; STABLE dispensa o aviso.
// FinBadge/DcBadge/BlBadge são só atalhos que passam estágio e versão do lib/*Version.
export const STAGE_CLASS: Record<string, string> = {
  ALPHA: 'bg-purple-950 text-purple-300 border-purple-700',
  BETA: 'bg-sky-950 text-sky-300 border-sky-700',
  STABLE: 'bg-emerald-950 text-emerald-300 border-emerald-700',
}
export default function StageBadge({ stage, version }: { stage: string; version: string }) {
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className={`px-3 py-1 rounded-full text-xs font-bold border ${STAGE_CLASS[stage] || STAGE_CLASS.ALPHA}`}>{stage} · v{version}</span>
      {stage !== 'STABLE' && <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>}
    </span>
  )
}
