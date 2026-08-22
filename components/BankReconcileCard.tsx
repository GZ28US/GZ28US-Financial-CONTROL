'use client'

// Card "Banco sem casamento" do Data Checker (21/ago): cada linha NEW do
// banco com os candidatos do app. MATCH casa (e backfilla a data do app),
// TRANSFER/IGNORE tiram da fila, EXPLAIN guarda "o que foi" (QUEUED). Lê e
// escreve por /api/bank/reconcile com o JWT da sessão (tabelas do banco são
// só-service-key). Depois de um MATCH recarrega a lista: o servidor é quem
// sabe quais candidatos ainda valem (revisão de 21/ago).
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; score: number; dd: number | null }
type Line = { id: string; date: string; amount: number; name: string; raw_name: string; pending: boolean; source: string; candidates: Cand[] }

export async function sessionHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }
}

export default function BankReconcileCard({ onCount }: { onCount?: (n: number) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [totalNew, setTotalNew] = useState(0)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [onlyCand, setOnlyCand] = useState(false)
  const [shown, setShown] = useState(80)
  const [pick, setPick] = useState<Record<string, string>>({})     // line id → "table:id"
  const [explain, setExplain] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setError('')
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLines(d.lines); setTotalNew(d.total_new); onCount?.(d.total_new)
      setPick(prev => {
        const p: Record<string, string> = {}
        for (const l of d.lines as Line[]) {
          const keep = prev[l.id] && l.candidates.some(c => c.table + ':' + c.id === prev[l.id]) ? prev[l.id] : null
          if (keep) p[l.id] = keep; else if (l.candidates[0]) p[l.id] = l.candidates[0].table + ':' + l.candidates[0].id
        }
        return p
      })
    } catch (e) {
      setError(String((e as Error).message || e)); setLines([])
    }
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  async function act(l: Line, action: string, extra: Record<string, unknown> = {}) {
    setBusy(l.id)
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action, bank_id: l.id, ...extra }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { alert(d.error || `Falhou (${r.status})`); if (r.status === 409) await load(); return }
      // MATCH tira um candidato do jogo pra TODAS as outras linhas — só o servidor sabe
      // quais ainda valem, então recarrega. Demais ações só somem com a linha.
      if (action === 'match') await load()
      else { setLines(prev => (prev || []).filter(x => x.id !== l.id)); setTotalNew(n => n - 1); onCount?.(totalNew - 1) }
    } catch (e) {
      alert('Sem resposta do servidor — confira a linha antes de repetir. ' + String((e as Error).message || e))
    } finally { setBusy(null) }
  }

  const visible = useMemo(() => {
    if (!lines) return []
    const needle = q.trim().toLowerCase()
    return lines.filter(l => (!onlyCand || l.candidates.length > 0) && (!needle || l.name.toLowerCase().includes(needle) || l.raw_name.toLowerCase().includes(needle) || Math.abs(l.amount).toFixed(2).includes(needle) || l.date.includes(needle)))
  }, [lines, q, onlyCand])
  const withCand = lines ? lines.filter(l => l.candidates.length > 0).length : 0
  const clean = !!lines && !error && totalNew === 0

  return (
    <div className={`border rounded-2xl overflow-hidden ${clean ? 'border-emerald-900/60' : error ? 'border-red-900' : 'border-gray-700'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
        <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${error ? 'text-red-400' : clean ? 'text-emerald-400' : 'text-amber-300'}`}>{error ? '!' : lines ? (totalNew === 0 ? '✓' : totalNew) : '…'}</span>
        <span className="flex-1">
          <span className="font-bold block">Banco sem casamento — linhas da Regions sem par no app</span>
          <span className="text-xs text-gray-500">{error ? `erro: ${error}` : lines ? `trava: conciliação do DFC com o extrato · ${withCand} com candidato automático` : 'carregando o banco…'}</span>
        </span>
        <span className="text-gray-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-5 py-4 border-t border-gray-800">
          <p className="text-sm text-gray-400 mb-3 max-w-3xl">Cada linha do banco ou já existe no app (MATCH — e a data de pagamento do app é preenchida com a do banco se faltava), ou é transferência/ignorável, ou falta no app: EXPLAIN guarda o que foi pra lançar depois.</p>
          {error && <p className="text-red-400 mb-3">{error} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}
          <div className="flex gap-3 flex-wrap items-center mb-3">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar por nome, valor ou data" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-72" />
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer"><input type="checkbox" checked={onlyCand} onChange={e => setOnlyCand(e.target.checked)} className="w-4 h-4" /> só com candidato</label>
            <button onClick={load} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-3 py-1.5 rounded-xl font-bold text-xs">↻</button>
            <span className="text-xs text-gray-500 ml-auto">{visible.length} linhas{visible.length > shown ? ` · mostrando ${shown}` : ''}</span>
          </div>
          {!lines ? <p className="text-gray-500">Carregando o banco…</p> : visible.length === 0 ? <p className={error ? 'text-gray-500' : 'text-emerald-400 font-bold'}>{error ? 'Sem dados.' : 'Nada pendente aqui.'}</p> : (
            <div className="divide-y divide-gray-800">
              {visible.slice(0, shown).map(l => {
                const sel = pick[l.id] || ''
                const cand = l.candidates.find(c => c.table + ':' + c.id === sel)
                return (
                  <div key={l.id} className="py-3 px-2">
                    <div className="flex items-baseline gap-3">
                      <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(l.date)}</span>
                      <span className="flex-1 truncate text-sm" title={l.raw_name}>{l.name}{l.pending && <span className="ml-2 text-xs text-amber-400">PENDING</span>}{l.source === 'STATEMENT' && <span className="ml-2 text-xs text-gray-600">extrato</span>}</span>
                      <span className={`tabular-nums font-bold text-sm shrink-0 ${l.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{l.amount > 0 ? '−' : '+'}{usd(l.amount)}</span>
                    </div>
                    <div className="mt-2 flex gap-2 flex-wrap items-center">
                      {l.candidates.length > 0 ? (
                        <select value={sel} onChange={e => setPick({ ...pick, [l.id]: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs max-w-xl">
                          {l.candidates.map(c => <option key={c.table + c.id} value={c.table + ':' + c.id}>{c.label} — {c.date ? formatShortDate(c.date) : 'sem data'}{c.dd != null ? ` (${c.dd}d)` : ''}{c.undated ? ' · sem payment date' : ''}</option>)}
                        </select>
                      ) : <span className="text-xs text-gray-600">sem candidato no app</span>}
                      <button disabled={!cand || busy === l.id} onClick={() => cand && act(l, 'match', { table: cand.table, row_id: cand.id })} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">MATCH</button>
                      <button disabled={busy === l.id} onClick={() => act(l, 'transfer')} className="bg-blue-800 hover:bg-blue-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">TRANSFER</button>
                      <button disabled={busy === l.id} onClick={() => { if (confirm('Ignorar esta linha do banco?')) act(l, 'ignore') }} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">IGNORE</button>
                      <input value={explain[l.id] || ''} onChange={e => setExplain({ ...explain, [l.id]: e.target.value })} placeholder="o que foi? (EXPLAIN)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-56" />
                      <button disabled={!(explain[l.id] || '').trim() || busy === l.id} onClick={() => act(l, 'explain', { note: explain[l.id] })} className="bg-fuchsia-800 hover:bg-fuchsia-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">EXPLAIN</button>
                    </div>
                  </div>
                )
              })}
              {visible.length > shown && <button onClick={() => setShown(s => s + 100)} className="mt-3 w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">MOSTRAR MAIS ({visible.length - shown} restantes)</button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
