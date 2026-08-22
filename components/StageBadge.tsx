'use client'

// Selo ÚNICO dos produtos em construção (regra do Márcio, 21/ago): mesma cor
// pra ALPHA e BETA em todos os fronts — roxo com estágio · versão, mais o
// EM DESENVOLVIMENTO em âmbar. STABLE dispensa o aviso. FinBadge/DcBadge/BlBadge
// são só atalhos que passam o estágio e a versão do seu lib/*Version.
export default function StageBadge({ stage, version }: { stage: string; version: string }) {
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-950 text-purple-300 border border-purple-700">{stage} · v{version}</span>
      {stage !== 'STABLE' && <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>}
    </span>
  )
}
