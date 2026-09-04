'use client'

// A FILA «A ATRIBUIR» (AUTO-BOOK fase B, BL 0.9.0, João + Márcio, 4/set/2026).
// O motor já lançou a compra no dia do banco (caixa e DRE certos) numa
// pseudo-invoice A ATRIBUIR — o balde, conta de suspensão. Aqui o humano só diz
// o DONO, um clique: CARRO move a despesa pra invoice (mesmo id, sem duplicar),
// ESTOQUE vira inventário, SUPPLIES vira insumo, FIXO vira custo fixo do
// fornecedor; DIVIDIR reparte um PayPal em várias. SUPPLIES e FIXO ensinam uma
// regra. DESATRIBUIR volta pro balde; DESFAZER devolve a linha ao banco sem
// lançamento. Tudo por /api/bank/reconcile (JWT da sessão). O balde tem que
// zerar toda semana — o card do Data Checker cobra o que passou de 7 dias.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
async function headers(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }
}

type Sug = { kind: 'CAR'; invoice_id: string; code: string; car: string; why: string; score: number } | { kind: 'TWIN'; table: string; id: string; label: string; days: number }
type Row = { row_id: string; bank_id: string | null; date: string; amount: number; name: string; raw_name: string; source: string; supplier: string; item: string; klass: string | null; via: string | null; mcc: string | null; age_days: number | null; batch: string | null; trigger: string | null; started_at: string | null; orphan: boolean; suggestions: Sug[] }
type Inv = { id: string; code: string; ride_id: string; ride_code: string; ride_name: string; closed: boolean }
type Sup = { id: string; company: string; cost_type: string }
type Attributed = { bank_id: string; date: string; amount: number; name: string; dest: string; label: string; href: string; reviewed_at: string }
type Data = { total: number; balance: number; older_7d: number; rows: Row[]; attributed: Attributed[]; invoices: Inv[]; fixed_suppliers: Sup[]; needs_migration?: boolean; error?: string; invariants: any }
type Part = { amount: string; dest: 'CAR' | 'STOCK' | 'SUPPLIES' | 'FIXO'; invoice_id: string; supplier_id: string; category: string; item: string }

// Classe → rótulo e cor (casa com o classificador do motor).
const KLASS: Record<string, [string, string]> = {
  AUTO_PARTS: ['AUTO PEÇAS', 'bg-orange-950 text-orange-300 border-orange-800'], AUTO_SERVICE: ['SERVIÇO AUTO', 'bg-rose-950 text-rose-300 border-rose-800'],
  MARKETPLACE: ['MARKETPLACE', 'bg-yellow-950 text-yellow-300 border-yellow-800'], TEMU: ['TEMU', 'bg-yellow-950 text-yellow-300 border-yellow-800'],
  PAYPAL: ['PAYPAL', 'bg-indigo-950 text-indigo-300 border-indigo-800'], SQUARE: ['SQUARE', 'bg-indigo-950 text-indigo-300 border-indigo-800'],
  HARDWARE: ['FERRAMENTA', 'bg-lime-950 text-lime-300 border-lime-800'], HOME_SUPPLY: ['CASA/OFICINA', 'bg-lime-950 text-lime-300 border-lime-800'],
  POSTAGE: ['FRETE', 'bg-gray-800 text-gray-300 border-gray-700'], MISC_RETAIL: ['VAREJO', 'bg-gray-800 text-gray-300 border-gray-700'], SERVICES: ['SERVIÇO', 'bg-gray-800 text-gray-300 border-gray-700'],
  SAAS: ['ASSINATURA', 'bg-purple-950 text-purple-300 border-purple-800'], UNKNOWN: ['SEM CLASSE', 'bg-gray-900 text-gray-500 border-gray-800'],
}
const klassLabel = (k: string | null) => (k && KLASS[k]) ? KLASS[k][0] : (k || '—')
const klassCls = (k: string | null) => (k && KLASS[k]) ? KLASS[k][1] : 'bg-gray-800 text-gray-300 border-gray-700'
const CATS = ['CONSUMPTION', 'APARTMENT', 'CATS', 'TEAM']
const BTN = 'px-3 py-1 rounded-xl font-bold text-xs disabled:opacity-40'

export default function BucketQueue({ onCount, embedded }: { onCount?: (n: number, balance: number, older7: number) => void; embedded?: boolean }) {
  const [d, setD] = useState<Data | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(!embedded)
  const [tab, setTab] = useState<'FILA' | 'ATRIBUIDAS'>('FILA')
  const [q, setQ] = useState('')
  const [klassF, setKlassF] = useState<string | null>(null)
  const [srcF, setSrcF] = useState<'ALL' | 'PLAID' | 'STATEMENT'>('ALL')
  const [shown, setShown] = useState(60)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [pick, setPick] = useState<Record<string, string>>({})       // row_id → invoice_id
  const [invMode, setInvMode] = useState<Record<string, 'SUG' | 'ABERTAS' | 'FECHADAS'>>({})
  const [fixOpen, setFixOpen] = useState<Record<string, string>>({}) // row_id → supplier_id ('' = painel aberto sem escolha)
  const [catPick, setCatPick] = useState<Record<string, string>>({})
  const [split, setSplit] = useState<Record<string, Part[]>>({})
  const [bulkInv, setBulkInv] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const lock = (k: string) => setBusy(s => new Set(s).add(k))
  const unlock = (k: string) => setBusy(s => { const n = new Set(s); n.delete(k); return n })
  const anyBusy = busy.size > 0

  async function load() {
    setErr('')
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile?bucket=1`, { headers: await headers() })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setD(j)
      setPick(prev => { const p: Record<string, string> = {}; for (const row of j.rows as Row[]) { const s = row.suggestions.find(x => x.kind === 'CAR') as any; p[row.row_id] = prev[row.row_id] || (s ? s.invoice_id : '') } return p })
    } catch (e) { setErr(String((e as Error).message || e)); setD(null) }
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d) onCount?.(d.total, d.balance, d.older_7d) }, [d, onCount])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const go = () => { if (window.location.hash === '#a-atribuir') { setOpen(true); setTimeout(() => document.getElementById('a-atribuir')?.scrollIntoView({ behavior: 'smooth' }), 300) } }
    go(); window.addEventListener('hashchange', go); return () => window.removeEventListener('hashchange', go)
  }, [])

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await headers(), body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `Falhou (${r.status})`)
    if (j.learned) { setMsg('memória de comerciante: ' + j.learned); setTimeout(() => setMsg(null), 8000) }
    return j
  }
  const fail = (e: unknown) => alert(String((e as Error).message || e))

  async function assign(row: Row, dest: 'CAR' | 'STOCK' | 'SUPPLIES' | 'FIXO', extra: Record<string, unknown> = {}) {
    if (anyBusy || !row.bank_id) return
    if (dest === 'CAR') {
      const chosen = String(extra.invoice_id || pick[row.row_id] || '')
      if (!extra.invoice_id && !invOptions(row).some(o => o.id === chosen)) { alert('escolha o carro na lista mostrada (troque pra «abertas» pra ver todos)'); return }
      const inv = d?.invoices.find(i => i.id === chosen)
      if (!inv) { alert('escolha o carro (invoice) primeiro'); return }
      if (inv.closed && !confirm('Invoice FECHADA: o custo entra no período já reconhecido. Continuar?')) return
      extra = { ...extra, invoice_id: inv.id, force_closed: inv.closed }
    }
    lock(row.row_id)
    try {
      const j = await post({ action: 'assign', bank_id: row.bank_id, dest, ...extra })
      await load()
      if (j.reported) { setMsg('balão EXPENSE PAID enviado ao grupo'); setTimeout(() => setMsg(null), 6000) }
    } catch (e) { fail(e); await load() } finally { unlock(row.row_id) }
  }
  async function undo(row: Row) {
    if (anyBusy || !row.bank_id || !confirm('DESFAZER: a linha volta pro banco SEM lançamento (o motor recria na próxima rodada se a regra ainda valer). Continuar?')) return
    lock(row.row_id)
    try { await post({ action: 'unmatch', bank_id: row.bank_id }); await load() } catch (e) { fail(e); await load() } finally { unlock(row.row_id) }
  }
  async function unassign(a: Attributed) {
    if (anyBusy || !confirm('DESATRIBUIR: a compra volta pro balde (o dinheiro continua lançado). Continuar?')) return
    lock(a.bank_id)
    try { await post({ action: 'unassign', bank_id: a.bank_id }); await load() } catch (e) { fail(e); await load() } finally { unlock(a.bank_id) }
  }
  async function rematch(row: Row, tw: Extract<Sug, { kind: 'TWIN' }>) {
    if (anyBusy || !row.bank_id || !confirm(`TROCAR: desfaz a linha do balde e casa a linha do banco com o registro que já existe (${tw.label}). Continuar?`)) return
    lock(row.row_id)
    try { await post({ action: 'rematch', bank_id: row.bank_id, table: tw.table, row_id: tw.id }); await load() } catch (e) { fail(e); await load() } finally { unlock(row.row_id) }
  }
  async function bulk(dest: 'CAR' | 'STOCK' | 'SUPPLIES') {
    // Gêmeo (JÁ LANÇADO) e órfã ficam de fora da ação em massa — decisão linha a linha.
    const eligible = visible.filter(r => r.bank_id && !r.suggestions.some(s => s.kind === 'TWIN'))
    const ids = eligible.map(r => r.bank_id as string)
    if (!ids.length || anyBusy) return
    const inv = dest === 'CAR' ? d?.invoices.find(i => i.id === bulkInv) : null
    if (dest === 'CAR' && !inv) { alert('escolha o carro (invoice) pra ação em massa'); return }
    if (inv?.closed && !confirm('Invoice FECHADA: o custo entra no período já reconhecido. Continuar?')) return
    const total = eligible.reduce((s, r) => s + r.amount, 0)
    const left = visible.length - eligible.length
    if (!confirm(`${ids.length} compras filtradas → ${dest === 'CAR' ? 'CARRO ' + inv!.code + ' ' + inv!.ride_code : dest === 'STOCK' ? 'ESTOQUE' : 'SUPPLIES CONSUMPTION'} · ${usd(total)}${left ? ` · ${left} com gêmeo/órfã ficam de fora` : ''}. Continuar?`)) return
    lock('bulk')
    try { const j = await post({ action: 'assign_bulk', ids, dest, invoice_id: inv?.id, force_closed: !!inv?.closed, category: 'CONSUMPTION' }); alert(`${j.n} atribuídas${j.errors?.length ? ' · erros: ' + j.errors.slice(0, 5).join(' | ') : ''}`); await load() }
    catch (e) { fail(e); await load() } finally { unlock('bulk') }
  }
  async function confirmSplit(row: Row) {
    const parts = split[row.row_id] || []
    if (anyBusy || !row.bank_id) return
    if (parts.some(p => p.dest === 'CAR' && d?.invoices.find(i => i.id === p.invoice_id)?.closed) && !confirm('Uma parte vai pra invoice FECHADA: o custo entra no período já reconhecido. Continuar?')) return
    const body = parts.map(p => ({ dest: p.dest, amount: Math.round(parseFloat(p.amount || '0') * 100) / 100, invoice_id: p.dest === 'CAR' ? p.invoice_id : undefined, supplier_id: p.dest === 'FIXO' ? p.supplier_id : undefined, category: p.dest === 'SUPPLIES' ? (p.category || 'CONSUMPTION') : undefined, item: p.item || undefined, force_closed: p.dest === 'CAR' ? !!d?.invoices.find(i => i.id === p.invoice_id)?.closed : undefined }))
    lock(row.row_id)
    try { await post({ action: 'assign', bank_id: row.bank_id, dest: 'SPLIT', parts: body }); setSplit(s => { const n = { ...s }; delete n[row.row_id]; return n }); await load() }
    catch (e) { fail(e) } finally { unlock(row.row_id) }
  }

  const rows = d?.rows || []
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter(r => (!klassF || r.klass === klassF) && (srcF === 'ALL' || r.source === srcF) && (!needle || (r.name + ' ' + r.raw_name + ' ' + r.supplier + ' ' + r.item).toLowerCase().includes(needle) || Math.abs(r.amount).toFixed(2).includes(needle) || String(r.date).includes(needle)))
  }, [rows, q, klassF, srcF])
  const klasses = useMemo(() => { const m = new Map<string, number>(); for (const r of rows) { const k = r.klass || 'UNKNOWN'; m.set(k, (m.get(k) || 0) + 1) } return [...m.entries()].sort((a, b) => b[1] - a[1]) }, [rows])
  const remainder = (row: Row) => Math.round((row.amount - (split[row.row_id] || []).reduce((s, p) => s + (parseFloat(p.amount || '0') || 0), 0)) * 100) / 100
  const invOptions = (row: Row) => {
    const mode = invMode[row.row_id] || 'SUG'
    const sug = row.suggestions.filter(s => s.kind === 'CAR') as Extract<Sug, { kind: 'CAR' }>[]
    if (mode === 'SUG' && sug.length) return sug.map(s => ({ id: s.invoice_id, label: `${s.car} · ${s.code} — ${s.why}` }))
    return (d?.invoices || []).filter(i => mode === 'FECHADAS' ? i.closed : !i.closed).map(i => ({ id: i.id, label: `${i.ride_code} ${i.ride_name} · ${i.code}${i.closed ? ' (FECHADA)' : ''}` }))
  }

  const head = (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Título é o único gatilho de abrir/fechar (botão dentro de botão quebrava as abas — revisão 3). */}
      <button type="button" onClick={() => { if (embedded) setOpen(o => !o) }} className={`font-bold flex-1 text-left ${embedded ? 'cursor-pointer' : 'cursor-default'}`}>A ATRIBUIR <span className="text-amber-300">{d ? d.total : '…'}</span>{d ? <span className="text-xs text-gray-500 font-normal"> · balde {usd(d.balance)} · {d.older_7d} com mais de 7 dias</span> : null}{embedded ? <span className="text-gray-500 ml-2">{open ? '▴' : '▾'}</span> : null}</button>
      <div className="flex gap-1">
        <button onClick={() => setTab('FILA')} className={`px-3 py-1 rounded-xl text-xs font-bold border ${tab === 'FILA' ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>A ATRIBUIR</button>
        <button onClick={() => setTab('ATRIBUIDAS')} className={`px-3 py-1 rounded-xl text-xs font-bold border ${tab === 'ATRIBUIDAS' ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>ATRIBUÍDAS{d ? ` (${d.attributed.length})` : ''}</button>
      </div>
      <button onClick={load} disabled={anyBusy} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">↻</button>
    </div>
  )

  const body = (
    <div className="mt-3 space-y-3 text-sm">
      {err && <p className="text-red-400">{err} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}
      {d?.needs_migration && <p className="text-amber-300">Rode <b>MIGRATION_auto_book_phase_b.sql</b> no SQL Editor — o balde precisa da invoice A ATRIBUIR{d.error ? ' · ' + d.error : ''}.</p>}
      {msg && <p className="text-xs text-fuchsia-300 font-bold">{msg}</p>}
      <p className="text-xs text-gray-500 max-w-4xl">O motor já lançou a compra no dia do banco (caixa e DRE certos). Aqui você só diz o DONO: CARRO move a despesa pra invoice, ESTOQUE vira inventário, SUPPLIES vira insumo, FIXO vira custo fixo do fornecedor; DIVIDIR reparte um PayPal em várias. SUPPLIES e FIXO ensinam uma regra. DESFAZER devolve a linha ao banco sem lançamento.</p>
      {tab === 'ATRIBUIDAS' ? (
        <div className="divide-y divide-gray-800">
          {(d?.attributed || []).length === 0 && <p className="text-gray-500">nenhuma atribuição nos últimos 60 dias.</p>}
          {(d?.attributed || []).map(a => (
            <div key={a.bank_id} className="py-2 flex items-center gap-3 flex-wrap">
              <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(a.date)}</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-800 bg-emerald-950 text-emerald-300 shrink-0">{a.dest === 'CAR' ? 'CARRO' : a.dest === 'STOCK' ? 'ESTOQUE' : a.dest === 'SPLIT' ? 'DIVIDIDA' : a.dest}</span>
              <span className="truncate max-w-[18rem]" title={a.name}>{a.name}</span>
              <span className="tabular-nums font-bold text-red-400 shrink-0">−{usd(a.amount)}</span>
              <span className="text-xs text-gray-400 flex-1 truncate min-w-[12rem]" title={a.label}>{a.label}</span>
              {a.href && !a.href.includes('#a-atribuir') && <a href={`${BASE_PATH}${a.href}`} target="_blank" rel="noreferrer" className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded-xl font-bold text-xs">ABRIR ↗</a>}
              <button disabled={anyBusy} onClick={() => unassign(a)} className={`bg-gray-700 hover:bg-gray-600 ${BTN}`}>{busy.has(a.bank_id) ? '…' : 'DESATRIBUIR'}</button>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap items-center">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar por loja, item, valor ou data" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-64" />
            {(['ALL', 'PLAID', 'STATEMENT'] as const).map(s => <button key={s} onClick={() => setSrcF(s)} className={`px-2 py-1 rounded-xl text-[10px] font-bold border ${srcF === s ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{s === 'ALL' ? 'TODAS' : s === 'PLAID' ? 'PLAID' : 'EXTRATO'}</button>)}
            <span className="text-gray-700">|</span>
            {klasses.map(([k, n]) => <button key={k} onClick={() => setKlassF(klassF === k ? null : k)} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${klassF === k ? 'bg-white text-black border-white' : klassCls(k)}`}>{klassLabel(k)} {n}</button>)}
            <span className="text-xs text-gray-500 ml-auto">{visible.length} linhas{visible.length > shown ? ` · mostrando ${shown}` : ''}</span>
          </div>
          {visible.length > 0 && (
            <div className="flex gap-2 flex-wrap items-center bg-gray-950/60 border border-gray-800 rounded-2xl px-3 py-2 text-xs">
              <span className="text-gray-400"><b>{visible.length}</b> filtradas →</span>
              <button disabled={anyBusy} onClick={() => bulk('STOCK')} className={`bg-sky-800 hover:bg-sky-700 ${BTN}`}>ESTOQUE</button>
              <button disabled={anyBusy} onClick={() => bulk('SUPPLIES')} className={`bg-purple-800 hover:bg-purple-700 ${BTN}`}>SUPPLIES</button>
              <select value={bulkInv} onChange={e => setBulkInv(e.target.value)} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[16rem]">
                <option value="">— carro —</option>
                {(d?.invoices || []).map(i => <option key={i.id} value={i.id}>{i.ride_code} {i.ride_name} · {i.code}{i.closed ? ' (FECHADA)' : ''}</option>)}
              </select>
              <button disabled={anyBusy || !bulkInv} onClick={() => bulk('CAR')} className={`bg-green-700 hover:bg-green-600 ${BTN}`}>{busy.has('bulk') ? '…' : 'CARRO'}</button>
            </div>
          )}
          {d && rows.length === 0 && !err && <p className="text-emerald-400 font-bold">Balde vazio — toda compra tem dono.</p>}
          <div className="divide-y divide-gray-800">
            {visible.slice(0, shown).map(row => {
              const twin = row.suggestions.find(s => s.kind === 'TWIN') as Extract<Sug, { kind: 'TWIN' }> | undefined
              const cars = row.suggestions.filter(s => s.kind === 'CAR') as Extract<Sug, { kind: 'CAR' }>[]
              const b = busy.has(row.row_id)
              const parts = split[row.row_id]
              return (
                <div key={row.row_id} className="py-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(row.date)}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${klassCls(row.klass)}`} title={`${row.via || ''}${row.mcc ? ' · MCC ' + row.mcc : ''}`}>{klassLabel(row.klass)}</span>
                    <span className="min-w-[10rem] max-w-[18rem]">
                      <span className="block truncate font-bold" title={row.supplier}>{row.supplier || row.name}</span>
                      <span className="block truncate text-[10px] text-gray-500" title={row.raw_name}>{row.raw_name || row.name}</span>
                    </span>
                    <span className="tabular-nums font-bold text-red-400 shrink-0">−{usd(row.amount)}</span>
                    {(row.age_days || 0) > 7 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-800 shrink-0">{row.age_days} d</span>}
                    {row.orphan && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950 text-red-300 border border-red-800 shrink-0" title="sem linha do banco apontando — o Data Checker purga">ÓRFÃ</span>}
                    {twin && <button disabled={anyBusy} onClick={() => rematch(row, twin)} className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950 text-red-300 border border-red-800 shrink-0" title={twin.label}>JÁ LANÇADO em {twin.label.slice(0, 40)} — TROCAR</button>}
                    <span className="flex gap-1 flex-wrap">
                      {cars.slice(0, 3).map(s => <button key={s.invoice_id} disabled={anyBusy} onClick={() => setPick(p => ({ ...p, [row.row_id]: s.invoice_id }))} title={s.why} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${pick[row.row_id] === s.invoice_id ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{s.car || s.code}</button>)}
                    </span>
                    <select value={pick[row.row_id] || ''} onChange={e => setPick(p => ({ ...p, [row.row_id]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') assign(row, 'CAR') }} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[15rem]">
                      <option value="">— carro —</option>
                      {invOptions(row).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <select value={invMode[row.row_id] || 'SUG'} onChange={e => setInvMode(m => ({ ...m, [row.row_id]: e.target.value as any }))} className="bg-gray-900 border border-gray-700 rounded-xl px-1 py-1 text-[10px]" title="lista: sugeridas · todas abertas · fechadas (reabre o período)">
                      <option value="SUG">sugeridas</option><option value="ABERTAS">abertas</option><option value="FECHADAS">fechadas</option>
                    </select>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => assign(row, 'CAR')} className={`bg-green-700 hover:bg-green-600 ${BTN}`}>{b ? '…' : 'CARRO'}</button>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => assign(row, 'STOCK')} className={`bg-sky-800 hover:bg-sky-700 ${BTN}`}>ESTOQUE</button>
                    <select value={catPick[row.row_id] || 'CONSUMPTION'} onChange={e => setCatPick(m => ({ ...m, [row.row_id]: e.target.value }))} className="bg-gray-900 border border-gray-700 rounded-xl px-1 py-1 text-[10px]" title="categoria do insumo">{CATS.map(c => <option key={c} value={c}>{c}</option>)}</select>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => assign(row, 'SUPPLIES', { category: catPick[row.row_id] || 'CONSUMPTION' })} className={`bg-purple-800 hover:bg-purple-700 ${BTN}`}>SUPPLIES</button>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => setFixOpen(f => { const n = { ...f }; if (row.row_id in n) delete n[row.row_id]; else n[row.row_id] = ''; return n })} className={`bg-gray-800 hover:bg-gray-700 border border-gray-600 ${BTN}`}>FIXO</button>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => setSplit(s => { const n = { ...s }; if (n[row.row_id]) delete n[row.row_id]; else n[row.row_id] = [{ amount: row.amount.toFixed(2), dest: 'CAR', invoice_id: pick[row.row_id] || '', supplier_id: '', category: 'CONSUMPTION', item: '' }]; return n })} className={`bg-gray-800 hover:bg-gray-700 border border-gray-600 ${BTN}`}>DIVIDIR</button>
                    <button disabled={anyBusy || !row.bank_id} onClick={() => undo(row)} className={`bg-gray-700 hover:bg-gray-600 ${BTN}`}>DESFAZER</button>
                  </div>
                  {row.row_id in fixOpen && (
                    <div className="mt-2 ml-24 flex gap-2 items-center flex-wrap text-xs">
                      <span className="text-gray-400">custo fixo do fornecedor:</span>
                      <select value={fixOpen[row.row_id]} onChange={e => setFixOpen(f => ({ ...f, [row.row_id]: e.target.value }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[18rem]">
                        <option value="">— fornecedor —</option>
                        {(d?.fixed_suppliers || []).map(s => <option key={s.id} value={s.id}>{s.company} · {s.cost_type}</option>)}
                      </select>
                      <button disabled={anyBusy || !fixOpen[row.row_id]} onClick={() => assign(row, 'FIXO', { supplier_id: fixOpen[row.row_id] })} className={`bg-gray-700 hover:bg-gray-600 ${BTN}`}>CONFIRMAR FIXO</button>
                    </div>
                  )}
                  {parts && (
                    <div className="mt-2 ml-24 bg-gray-950/60 border border-gray-800 rounded-2xl p-3 text-xs space-y-2">
                      <p className="font-bold text-gray-300">DIVIDIR {usd(row.amount)} em partes <span className="text-gray-500 font-normal">— resto {usd(remainder(row))} · partes vão pra CARRO, ESTOQUE ou SUPPLIES (FIXO é a linha inteira)</span></p>
                      {parts.map((p, i) => (
                        <div key={i} className="flex gap-2 items-center flex-wrap">
                          <input value={p.amount} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, amount: e.target.value } : x) }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 w-24 tabular-nums" />
                          <select value={p.dest} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, dest: e.target.value as Part['dest'] } : x) }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1">
                            <option value="CAR">CARRO</option><option value="STOCK">ESTOQUE</option><option value="SUPPLIES">SUPPLIES</option>
                          </select>
                          {p.dest === 'CAR' && <select value={p.invoice_id} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, invoice_id: e.target.value } : x) }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 max-w-[16rem]"><option value="">— carro —</option>{(d?.invoices || []).map(v => <option key={v.id} value={v.id}>{v.ride_code} {v.ride_name} · {v.code}{v.closed ? ' (FECHADA)' : ''}</option>)}</select>}
                          {p.dest === 'FIXO' && <select value={p.supplier_id} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, supplier_id: e.target.value } : x) }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 max-w-[16rem]"><option value="">— fornecedor —</option>{(d?.fixed_suppliers || []).map(v => <option key={v.id} value={v.id}>{v.company}</option>)}</select>}
                          {p.dest === 'SUPPLIES' && <select value={p.category} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, category: e.target.value } : x) }))} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1">{CATS.map(c => <option key={c} value={c}>{c}</option>)}</select>}
                          <input value={p.item} onChange={e => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].map((x, j) => j === i ? { ...x, item: e.target.value } : x) }))} placeholder="item (opcional)" className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 w-48" />
                          <button onClick={() => setSplit(s => ({ ...s, [row.row_id]: s[row.row_id].filter((_, j) => j !== i) }))} className="text-red-400 font-bold">✕</button>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <button onClick={() => setSplit(s => ({ ...s, [row.row_id]: [...s[row.row_id], { amount: Math.max(0, remainder(row)).toFixed(2), dest: 'CAR', invoice_id: '', supplier_id: '', category: 'CONSUMPTION', item: '' }] }))} className={`bg-gray-800 hover:bg-gray-700 border border-gray-600 ${BTN}`}>+ PARTE</button>
                        <button disabled={anyBusy || Math.abs(remainder(row)) >= 0.005 || parts.length < 2 || parts.some(p => (p.dest === 'CAR' && !p.invoice_id) || (p.dest === 'FIXO' && !p.supplier_id))} onClick={() => confirmSplit(row)} className={`bg-green-700 hover:bg-green-600 ${BTN}`}>CONFIRMAR DIVISÃO</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {visible.length > shown && <button onClick={() => setShown(s => s + 100)} className="text-xs text-gray-400 underline">mostrar mais</button>}
        </>
      )}
    </div>
  )

  if (embedded) {
    return (
      <div id="a-atribuir" className="border border-amber-900/60 rounded-2xl p-4">
        {head}
        {open && body}
      </div>
    )
  }
  return (
    <div id="a-atribuir" className="bg-gray-900 border border-gray-800 rounded-3xl p-6 mb-8">
      {head}
      {body}
    </div>
  )
}
