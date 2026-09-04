'use client'

// Card "Conciliação bancária" do Data Checker (21/ago; "Banco sem casamento" até 22/ago): cada linha NEW do
// banco com os candidatos do app. MATCH casa (e backfilla a data do app),
// TRANSFER/IGNORE tiram da fila, EXPLAIN guarda "o que foi" (QUEUED). Lê e
// escreve por /api/bank/reconcile com o JWT da sessão (tabelas do banco são
// só-service-key). Depois de um MATCH recarrega a lista: o servidor é quem
// sabe quais candidatos ainda valem (revisão de 21/ago).
//
// v0.3.0 (22/ago): MOTORES — PLANEJAR mostra a seco o que FEE (tarifas da
// Regions) e EXACT (centavos + único dos dois lados + ≤3d + nome) casariam;
// APLICAR roda o plano MOSTRADO (hash) em fatias até acabar. O que o motor
// casou fica em A CONFERIR: OK / DESFAZER por linha, DESFAZER LOTE por
// rodada, OK TODAS só pras tarifas. Enter no seletor de candidato = MATCH.
// Revisão #21–#25: `busy` é um conjunto (nada fica clicável durante um lote),
// plano some quando os dados mudam, falha no APLICAR recarrega, contagem do
// pai vem do estado e não do closure.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import { BL_STAGE, BL_VERSION } from '@/lib/blVersion'
import BucketQueue from '@/components/BucketQueue'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; href?: string; detail?: string; score: number; dd: number | null }
type Line = { id: string; date: string; amount: number; name: string; raw_name: string; pending: boolean; source: string; fee: boolean; candidates: Cand[] }
type AutoLine = { id: string; date: string; amount: number; name: string; raw_name?: string; engine: string; batch: string; note: string; source: string; backfilled: boolean; href?: string | null; status?: string; rule?: string | null }
type Batch = { batch: string; n: number; pending: number; fee: number; exact: number; name?: number; rule?: number; learn?: number; transfer?: number; bucket?: number; from: string; to: string; trigger?: string | null; started_at?: string | null }
type AutoRun = { id: string; trigger: string; status: string; started_at: string; finished_at: string | null; counts: Record<string, number> | null; errors: string[] | null; remaining: number | null }
type Auto = { pending: AutoLine[]; reviewed: number; batches: Batch[]; runs?: AutoRun[] }
type Plan = { fee_create: number; fee_match: number; exact: number; name: number; rule_create: number; rule_adopt?: number; learn?: number; transfer?: number; bucket?: number; by_klass?: Record<string, number>; seed?: string | null; total: number; hash: string; skipped: Record<string, number>; samples: { fee: string[]; exact: string[]; name: string[]; rule: string[]; transfer?: string[]; bucket?: string[] } }
type Applied = { fee_create: number; fee_match: number; exact: number; name: number; rule_create: number; rule_adopt: number; learn: number; transfer: number; bucket: number; errors: string[] }

export async function sessionHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }
}

// TRIAGEM POR FAMÍLIA (João, 25/ago): o ruído de cartão do dia a dia nunca terá
// linha no app — agrupa por família curada e decide em massa. Sem família = fora
// dos chips (o "CARD PURCHASE" genérico mistura lojas — esse fica pro filtro de texto).
const FAMILIES: [RegExp, string][] = [
  [/TEMU/, 'TEMU'], [/AMAZON|AMZN/, 'AMAZON'], [/EBAY/, 'EBAY'],
  [/BP#|WAWA|RACETRAC|CIRCLE ?K|7-ELEVEN|SHELL|CHEVRON|SUNOCO|EXXON|MOBIL/, 'COMBUSTÍVEL'],
  [/MCDONALD|BURGER|WENDY|CHICK|TACO|SUBWAY|DUNKIN|STARBUCKS|POLLO|KFC|PIZZA|RESTAURANT|CAFE|CHIPOTLE|CULVER|PANERA|IHOP|DENNY/, 'COMIDA'],
  [/PUBLIX|WAL-?MART|ALDI|SAMSCLUB|SAM ?S CLUB|COSTCO|WINN|TARGET|DOLLAR/, 'MERCADO'],
  [/PAYPAL/, 'PAYPAL'], [/APPLE/, 'APPLE'], [/ANTHROPIC/, 'ANTHROPIC'],
  [/AUTOZONE|O ?REILLY|ADVANCE AUTO|NAPA|HARBOR FREIGHT|HOME DEPOT|LOWE/, 'AUTO/FERRAMENTA'],
  [/ROSS |MARSHALL|BURLINGTON|TJ ?MAXX|NIKE|ADIDAS/, 'ROUPA/VAREJO'],
  [/UBER|LYFT/, 'UBER/LYFT'], [/PIN PURCHASE/, 'PIN PURCHASE'],
]
const famOf = (l: { name: string; raw_name: string }) => { const s = (l.name + ' ' + l.raw_name).toUpperCase(); for (const [re, f] of FAMILIES) if (re.test(s)) return f; return null }

const ENGINE_CHIP: Record<string, string> = { FEE: 'bg-teal-950 text-teal-300 border-teal-800', EXACT: 'bg-emerald-950 text-emerald-300 border-emerald-800', NAME: 'bg-sky-950 text-sky-300 border-sky-800', RULE: 'bg-purple-950 text-purple-300 border-purple-800', LEARN: 'bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800', TRANSFER: 'bg-blue-950 text-blue-300 border-blue-800', BUCKET: 'bg-amber-950 text-amber-300 border-amber-800' }
// Vocabulário das telas de supplies (fase B): SHOP nunca existiu ali.
const INPUT_CATS = ['CONSUMPTION', 'APARTMENT', 'CATS', 'TEAM']
const ORIGIN_BADGE: Record<string, [string, string]> = { LEARNED: ['APRENDIDA', 'bg-fuchsia-950 text-fuchsia-300'], DEFAULT: ['PADRÃO', 'bg-amber-950 text-amber-300'], HUMAN: ['HUMANA', 'bg-purple-950 text-purple-300'] }
// AUTO-BOOK (BL 0.8.0): rótulo humano da rodada — cron/webhook (automática) vs APLICAR.
const fmtNY = (iso?: string | null) => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : ''
const runLabel = (trigger?: string | null, at?: string | null) => (trigger && trigger !== 'human' ? 'AUTO · ' + trigger : 'APLICAR') + (at ? ' ' + fmtNY(at) : '')
const BATCH_KEYS = new Set(['plan', 'apply', 'review_all'])

export default function BankReconcileCard({ onCount }: { onCount?: (n: number, aConferir?: number, bucket?: number) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [totalNew, setTotalNew] = useState(0)
  const [auto, setAuto] = useState<Auto | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [onlyCand, setOnlyCand] = useState(false)
  const [hideFee, setHideFee] = useState(true)
  const [shown, setShown] = useState(80)
  const [inspect, setInspect] = useState<Set<string>>(new Set())   // linhas com o CONFERIR aberto
  const [pick, setPick] = useState<Record<string, string>>({})     // line id → "table:id"
  const [explain, setExplain] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [progress, setProgress] = useState('')
  const [engineFilter, setEngineFilter] = useState<'ALL' | 'FEE' | 'EXACT' | 'NAME' | 'RULE' | 'LEARN' | 'BUCKET'>('ALL')
  const [originFilter, setOriginFilter] = useState<'ALL' | 'HUMAN' | 'DEFAULT' | 'LEARNED'>('ALL')   // ⚙ (fase B)
  const [bucketN, setBucketN] = useState(0)
  const [learnMsg, setLearnMsg] = useState<string | null>(null)   // "regra aprendida…" depois de um MATCH humano
  const [familyFilter, setFamilyFilter] = useState<string | null>(null)   // triagem por família
  const [triageNote, setTriageNote] = useState('')
  // TO BOOK (João, 31/ago): ver SÓ a fila da triagem, com nota e destriagem.
  const [tobook, setTobook] = useState<{ id: string; date: string; amount: number; name: string; note: string }[] | null>(null)
  const [tobookOpen, setTobookOpen] = useState(false)
  // REGRAS & APELIDOS (BL 0.7.0): semeadura humana das tabelas do motor.
  const [rules, setRules] = useState<any[]>([])
  const [aliases, setAliases] = useState<any[]>([])
  const [sups, setSups] = useState<{ id: string; label: string }[]>([])
  const [mgrLoaded, setMgrLoaded] = useState(false)
  const [nr, setNr] = useState({ pattern: '', target: 'FIXED_EXPENSE', supplier_id: '', category: 'CONSUMPTION', label: '', pfc_primary: '', pfc_detailed: '', direction: 'OUT' })
  const [na, setNa] = useState({ pattern: '', words: '' })

  async function loadTobook() {
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile?queued=1`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (r.ok) setTobook(d.queued || [])
    } catch { setTobook([]) }
  }
  async function loadMgr(force = false) {
    if (mgrLoaded && !force) return
    setMgrLoaded(true)
    const [r1, r2, r3] = await Promise.all([
      supabase.from('bank_merchant_rules').select('*').order('created_at'),
      supabase.from('bank_aliases').select('*').order('created_at'),
      supabase.from('fixed_cost_suppliers').select('id, company, description, cost_type').order('company'),
    ])
    setRules(r1.data || []); setAliases(r2.data || [])
    setSups((r3.data || []).map((s: any) => ({ id: s.id, label: `${s.company || s.description || '—'} · ${s.cost_type || 'FIXED'}` })))
  }

  const lock = (k: string) => setBusy(s => new Set(s).add(k))
  const unlock = (k: string) => setBusy(s => { const n = new Set(s); n.delete(k); return n })
  const batchBusy = [...busy].some(k => BATCH_KEYS.has(k) || k.startsWith('undo_'))
  const anyBusy = busy.size > 0

  // Contagem do pai sai do estado, nunca do closure do clique (revisão #25).
  // A CONFERIR do pai exclui as linhas do balde (a atribuição é o OK delas — fase B).
  useEffect(() => { if (lines) onCount?.(totalNew, (auto?.pending || []).filter(a => a.engine !== 'BUCKET').length, bucketN) }, [totalNew, lines, auto, onCount, bucketN])

  async function load() {
    setError(''); setPlan(null)   // plano é de um instante — dados novos, plano novo (revisão #22)
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLines(d.lines); setTotalNew(d.total_new)
      setAuto(d.auto || null); setNeedsMigration(!!d.needs_migration)
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

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    if (d && d.learned) { setLearnMsg(String(d.learned)); setTimeout(() => setLearnMsg(null), 8000) }   // memória de comerciante (BL 0.8.0)
    if (!r.ok) throw Object.assign(new Error(d.error || `Falhou (${r.status})`), { status: r.status, needs_migration: !!d.needs_migration })
    return d
  }
  const fail = (e: unknown) => {
    const err = e as Error & { status?: number; needs_migration?: boolean }
    if (err.needs_migration) setNeedsMigration(true)
    alert(err.status ? err.message : 'Sem resposta do servidor — confira antes de repetir. ' + err.message)
    return err
  }

  async function act(l: Line, action: string, extra: Record<string, unknown> = {}) {
    if (anyBusy) return
    lock(l.id)
    try {
      await post({ action, bank_id: l.id, ...extra })
      // MATCH tira um candidato do jogo pra TODAS as outras linhas — só o servidor sabe
      // quais ainda valem, então recarrega. Demais ações só somem com a linha.
      if (action === 'match') await load()
      else { setLines(prev => (prev || []).filter(x => x.id !== l.id)); setTotalNew(n => n - 1); setPlan(null) }
    } catch (e) { if (fail(e).status === 409) await load() } finally { unlock(l.id) }
  }

  // TRIAGEM: explica TODAS as filtradas de uma vez (NEW → TO BOOK, com nota).
  async function triageApply() {
    const ids = visible.filter(l => !l.pending).map(l => l.id)
    const note = triageNote.trim()
    if (!ids.length || !note) return
    if (!confirm(`Explicar ${ids.length} linhas como "${note}"? Saem do SEM CASAMENTO e ficam em TO BOOK (a lançar), com a nota. Nada é apagado — dá pra reverter linha a linha.`)) return
    lock('triage')
    try {
      const d2 = await post({ action: 'bulk_explain', ids, note })
      alert(`${d2.n} linhas explicadas → TO BOOK.`)
      setFamilyFilter(null); setTriageNote(''); await load()
    } catch (e) { fail(e) } finally { unlock('triage') }
  }

  // ── motores ──
  async function planRun() {
    if (anyBusy) return
    lock('plan'); setApplied(null)
    try { const d = await post({ action: 'auto', plan: true }); setPlan(d.plan); setPlanOpen(true) }
    catch (e) { fail(e) } finally { unlock('plan') }
  }
  async function applyRun() {
    if (anyBusy || !plan) return
    if (!confirm(`Aplicar agora? ${plan.total} linhas: ${plan.fee_create} tarifas criadas, ${plan.fee_match} tarifas casadas, ${plan.exact} exatos, ${plan.name} por nome/apelido, ${plan.rule_create} criados por REGRA, ${plan.rule_adopt || 0} agendadas ADOTADAS (valor ajustado, não duplicadas), ${plan.learn || 0} por regra aprendida, ${plan.transfer || 0} transferências, ${plan.bucket || 0} caem no balde A ATRIBUIR (despesa real, sem dono ainda). Tudo fica em A CONFERIR e pode ser desfeito.`)) return
    lock('apply')
    const acc: Applied = { fee_create: 0, fee_match: 0, exact: 0, name: 0, rule_create: 0, rule_adopt: 0, learn: 0, transfer: 0, bucket: 0, errors: [] }
    try {
      // Primeira fatia valida o hash do plano mostrado; as seguintes continuam o mesmo lote.
      let d = await post({ action: 'auto', hash: plan.hash })
      let batch: string = d.applied.batch
      for (let guard = 0; ; guard++) {
        acc.fee_create += d.applied.fee_create; acc.fee_match += d.applied.fee_match; acc.exact += d.applied.exact; acc.name += d.applied.name || 0; acc.rule_create += d.applied.rule_create || 0; acc.rule_adopt += d.applied.rule_adopt || 0; acc.learn += d.applied.learn || 0; acc.transfer += d.applied.transfer || 0; acc.bucket += d.applied.bucket || 0; acc.errors.push(...d.applied.errors)
        setProgress(`${acc.fee_create + acc.fee_match + acc.exact + acc.name + acc.rule_create + acc.rule_adopt + acc.transfer + acc.bucket} de ${plan.total} aplicadas…`)
        if (!d.applied.remaining || d.applied.errors.length || guard > 20) break
        d = await post({ action: 'auto', batch })
        batch = d.applied.batch
      }
      setApplied(acc)
    } catch (e) { fail(e); setApplied(acc) }
    finally { setProgress(''); unlock('apply'); await load() }   // sempre recarrega: o servidor pode ter aplicado parte (revisão #23)
  }
  async function review(a: AutoLine) {
    if (batchBusy) return
    lock(a.id)
    try { await post({ action: 'review', bank_id: a.id }); setAuto(prev => prev ? { ...prev, reviewed: prev.reviewed + 1, pending: prev.pending.filter(x => x.id !== a.id) } : prev) }
    catch (e) { fail(e) } finally { unlock(a.id) }
  }
  async function undoLine(a: AutoLine) {
    if (batchBusy) return
    lock(a.id)
    try { await post({ action: 'unmatch', bank_id: a.id }); await load() }
    catch (e) { fail(e); await load() } finally { unlock(a.id) }
  }
  async function reviewAllFees() {
    if (anyBusy || !confirm('Marcar TODAS as tarifas casadas pelo motor como conferidas?')) return
    lock('review_all')
    try { await post({ action: 'review_all' }); await load() }
    catch (e) { fail(e) } finally { unlock('review_all') }
  }
  async function undoBatch(b: Batch) {
    if (anyBusy || !confirm(`Desfazer a rodada inteira (${b.n} linhas voltam pra sem casamento; tarifas, lançamentos criados por regra e compras do balde A ATRIBUIR são APAGADOS — o dinheiro fica sem lançamento até a próxima rodada; agendadas adotadas voltam ao valor original)?`)) return
    lock('undo_' + b.batch)
    try {
      // Em fatias de 200 (rodadas da fase B têm centenas de linhas): repete enquanto sobrar.
      let undone = 0; const errs: string[] = []
      for (let guard = 0; guard < 30; guard++) { const d = await post({ action: 'undo_batch', batch: b.batch }); undone += d.undone || 0; errs.push(...(d.errors || [])); setProgress(`${undone} desfeitas…`); if (!d.remaining || !d.undone) break }
      if (errs.length) alert('Desfeitas ' + undone + ', com erro: ' + errs.slice(0, 8).join(' | '))
    }
    catch (e) { fail(e) } finally { setProgress(''); unlock('undo_' + b.batch); await load() }
  }

  const visible = useMemo(() => {
    if (!lines) return []
    const needle = q.trim().toLowerCase()
    return lines.filter(l => (!onlyCand || l.candidates.length > 0) && (!hideFee || !l.fee) && (!familyFilter || famOf(l) === familyFilter) && (!needle || l.name.toLowerCase().includes(needle) || l.raw_name.toLowerCase().includes(needle) || Math.abs(l.amount).toFixed(2).includes(needle) || l.date.includes(needle)))
  }, [lines, q, onlyCand, hideFee, familyFilter])
  const withCand = lines ? lines.filter(l => l.candidates.length > 0).length : 0
  const feeLines = lines ? lines.filter(l => l.fee).length : 0
  const pendingReview = auto ? auto.pending.filter(a => engineFilter === 'ALL' || a.engine === engineFilter) : []
  const clean = !!lines && !error && totalNew === 0 && !(auto && auto.pending.length)

  return (
    <div className={`border rounded-2xl overflow-hidden ${clean ? 'border-emerald-900/60' : error ? 'border-red-900' : 'border-gray-700'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
        <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${error ? 'text-red-400' : clean ? 'text-emerald-400' : 'text-amber-300'}`}>{error ? '!' : lines ? (totalNew === 0 ? '✓' : totalNew) : '…'}</span>
        <span className="flex-1">
          <span className="font-bold block">CONCILIAÇÃO BANCÁRIA — linhas da Regions × lançamentos do app</span>
          <span className="text-xs text-gray-500">{error ? `erro: ${error}` : lines ? `cada linha do banco precisa de um dono no app · ${withCand} com candidato · ${feeLines} tarifas (motor)${auto && auto.pending.length ? ` · ${auto.pending.length} a conferir` : ''}` : 'carregando o banco…'}</span>
        </span>
        <span className="text-gray-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-5 py-4 border-t border-gray-800 space-y-5">
          {error && <p className="text-red-400">{error} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}

          {/* ── MOTORES ── */}
          <div className="bg-gray-950/60 border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[16rem]">
                <p className="font-bold">MOTORES AUTOMÁTICOS <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold border border-purple-700 bg-purple-950 text-purple-300" title="Os motores vivem no Bank Link — esta é a versão que casa as linhas">BANK LINK {BL_STAGE} · v{BL_VERSION}</span> <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold border border-teal-800 bg-teal-950 text-teal-300">FEE</span> <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-800 bg-emerald-950 text-emerald-300">EXACT</span></p>
                <p className="text-xs text-gray-500 mt-1">FEE: tarifa da Regions vira custo fixo "Regions Bank" e casa. EXACT: centavos iguais + único + ≤3 dias + nome. NAME: ambíguo desempatado por apelido. RULE/LEARN: regra (humana/aprendida) CRIA o lançamento ou ADOTA a agendada do mês. TRANSFER: status por regra. Só o certo; o resto fica como sugestão abaixo.</p>
                {/* AUTO-BOOK (BL 0.8.0): a última rodada automática, com contagens, erros e o que sobrou. */}
                {auto?.runs && auto.runs.length > 0 && (() => {
                  const r = auto.runs![0]; const c = r.counts || {}; const n = Object.values(c).reduce((s, v) => s + (v || 0), 0)
                  const stale = Date.now() - Date.parse(r.started_at) > 12 * 3600e3
                  const bad = stale || r.status === 'ERROR' || r.status === 'PARTIAL' || r.status === 'ABORTED'
                  return <p className={`text-xs mt-1 ${bad ? 'text-amber-300' : 'text-gray-400'}`}>AUTO-BOOK · última rodada {runLabel(r.trigger, r.started_at)} · {r.status} · {n} registradas (FEE {(c.fee_create || 0) + (c.fee_match || 0)} · EXACT {c.exact || 0} · NAME {c.name || 0} · RULE {(c.rule_create || 0) + (c.rule_adopt || 0)} · LEARN {c.learn || 0} · TRANSFER {c.transfer || 0} · BUCKET {c.bucket || 0}) · {(r.errors || []).length} erros · {r.remaining ?? 0} restantes{stale ? ' · ⚠ mais de 12 h sem rodada' : ''}{(r.errors || []).length ? ' · ' + String(r.errors![0]).slice(0, 80) : ''}</p>
                })()}
                {learnMsg && <p className="text-xs mt-1 text-fuchsia-300 font-bold">memória de comerciante: {learnMsg}</p>}
              </div>
              {needsMigration ? (
                <p className="text-sm text-amber-300">Rode <b>MIGRATION_bank_reconcile_v030.sql</b> (raiz do projeto) no SQL Editor — os motores precisam das colunas match_engine / match_batch / reviewed_at / backfill.</p>
              ) : (
                <div className="flex gap-2 items-center">
                  {progress && <span className="text-xs text-emerald-300">{progress}</span>}
                  <button disabled={anyBusy} onClick={planRun} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">{busy.has('plan') ? 'CALCULANDO…' : 'PLANEJAR'}</button>
                  {/* RESTAURAR DIÁRIO (31/ago): reencena o bank_match_log depois de um
                      reset — idempotente, só age em linha NEW com registro no diário. */}
                  <button disabled={anyBusy} title="Reencena o diário de casamentos (bank_match_log) nas linhas NEW — use depois de um reset" onClick={async () => {
                    if (!confirm('Reencenar o diário de casamentos nas linhas NEW? (idempotente — nada é sobrescrito)')) return
                    try {
                      const d = await post({ action: 'restore_log' })
                      alert(`DIÁRIO RESTAURADO ✅\ncasadas: ${d.matched} · status: ${d.statused} · alvos sumidos: ${d.gone} · erros: ${d.errors}`)
                      await load()
                    } catch (e) { alert('RESTAURAR falhou — ' + String((e as Error).message || e)) }
                  }} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">RESTAURAR DIÁRIO</button>
                  {plan && plan.total > 0 && <button disabled={anyBusy} onClick={applyRun} className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">{busy.has('apply') ? 'APLICANDO…' : `APLICAR ${plan.total}`}</button>}
                </div>
              )}
            </div>
            {plan && (
              <div className="mt-3 text-sm">
                <p><b>{plan.total}</b> linhas casariam agora: <span className="text-teal-300">FEE {plan.fee_create + plan.fee_match}</span> ({plan.fee_create} tarifas a criar, {plan.fee_match} já lançadas) · <span className="text-emerald-300">EXACT {plan.exact}</span> · <span className="text-sky-300">NAME {plan.name || 0}</span> · <span className="text-purple-300">RULE {plan.rule_create || 0} a criar · {plan.rule_adopt || 0} agendadas a adotar</span> · <span className="text-fuchsia-300">LEARN {plan.learn || 0}</span> · <span className="text-blue-300">TRANSFER {plan.transfer || 0}</span> · <span className="text-amber-300">A ATRIBUIR {plan.bucket || 0}</span>{plan.total === 0 ? ' — nada certo o bastante; siga pelas sugestões.' : ''}{plan.by_klass && Object.keys(plan.by_klass).length ? <span className="block text-xs text-gray-500 mt-1">balde por classe: {Object.entries(plan.by_klass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}</span> : null}{plan.seed ? <span className="block text-xs text-amber-300 mt-1">PADRÃO: {plan.seed}</span> : null}</p>
                <button onClick={() => setPlanOpen(o => !o)} className="text-xs text-gray-400 underline mt-1">{planOpen ? 'esconder' : 'ver'} amostra e motivos de recusa</button>
                {planOpen && (
                  <div className="mt-2 grid md:grid-cols-2 gap-3 text-xs text-gray-400">
                    <div>
                      <p className="font-bold text-gray-300 mb-1">Amostra EXACT</p>
                      {plan.samples.exact.length ? plan.samples.exact.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>) : <p>—</p>}
                      <p className="font-bold text-gray-300 mt-2 mb-1">Amostra FEE</p>
                      {plan.samples.fee.length ? plan.samples.fee.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>) : <p>—</p>}
                      {(plan.samples.name || []).length > 0 && (<><p className="font-bold text-gray-300 mt-2 mb-1">Amostra NAME (desempate por apelido)</p>{plan.samples.name.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>)}</>)}
                      {(plan.samples.rule || []).length > 0 && (<><p className="font-bold text-gray-300 mt-2 mb-1">Amostra RULE / LEARN (criação ou adoção por regra)</p>{plan.samples.rule.map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>)}</>)}
                      {(plan.samples.transfer || []).length > 0 && (<><p className="font-bold text-gray-300 mt-2 mb-1">Amostra TRANSFER (status por regra, sem lançamento)</p>{(plan.samples.transfer || []).map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>)}</>)}
                      {(plan.samples.bucket || []).length > 0 && (<><p className="font-bold text-amber-300 mt-2 mb-1">Amostra A ATRIBUIR (balde: despesa real, dono depois)</p>{(plan.samples.bucket || []).map((s, i) => <p key={i} className="truncate" title={s}>{s}</p>)}</>)}
                    </div>
                    <div>
                      <p className="font-bold text-gray-300 mb-1">Por que o resto NÃO casa sozinho</p>
                      {Object.entries(plan.skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => <p key={k}>{k}: <b>{v}</b></p>)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {applied && <p className="mt-3 text-sm text-emerald-300">Aplicado: {applied.fee_create} tarifas criadas · {applied.fee_match} tarifas casadas · {applied.exact} exatos · {applied.name} por nome · {applied.rule_create} criados por regra · {applied.rule_adopt} agendadas adotadas · {applied.learn} por regra aprendida · {applied.transfer} transferências · {applied.bucket} no balde A ATRIBUIR.{applied.errors.length ? <span className="text-red-400"> Erros ({applied.errors.length}): {applied.errors.slice(0, 5).join(' | ')}{applied.errors.length > 5 ? ' …' : ''}</span> : ''} Confira abaixo.</p>}
          </div>

          {/* ── A ATRIBUIR (fase B): a fila do balde ── */}
          {!needsMigration && <BucketQueue embedded onCount={(n) => setBucketN(n)} />}

          {/* ── TO BOOK (João, 31/ago): só a fila da triagem, com nota ── */}
          <div className="border border-gray-800 rounded-2xl p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={async () => { const v = !tobookOpen; setTobookOpen(v); if (v && tobook == null) await loadTobook() }} className="bg-amber-900 hover:bg-amber-800 border border-amber-700 px-4 py-2 rounded-xl font-bold text-sm">
                TO BOOK{tobook != null ? ` (${tobook.length})` : ''} {tobookOpen ? '▴' : '▾'}
              </button>
              <span className="text-xs text-gray-500">linhas marcadas na TRIAGEM como &quot;a lançar&quot; — lance no app e o motor casa na próxima rodada</span>
            </div>
            {tobookOpen && tobook != null && (
              <div className="mt-3 space-y-1 max-h-96 overflow-y-auto text-sm">
                {tobook.length === 0 && <p className="text-gray-500">fila vazia — nada marcado como TO BOOK.</p>}
                {tobook.map(t => (
                  <div key={t.id} className="flex items-center gap-3 border-b border-gray-900 py-1">
                    <span className="text-gray-500 shrink-0">{formatShortDate(t.date)}</span>
                    <span className="flex-1 truncate" title={t.name}>{t.name}</span>
                    <span className="text-xs text-amber-300 truncate max-w-[16rem]" title={t.note}>{t.note}</span>
                    <span className="font-bold tabular-nums shrink-0">{t.amount > 0 ? '−' : '+'}${Math.abs(t.amount).toFixed(2)}</span>
                    <button disabled={anyBusy} onClick={async () => { lock(t.id); try { await post({ action: 'unqueue', bank_id: t.id }); setTobook(p => (p || []).filter(x => x.id !== t.id)); await load() } catch (e) { fail(e) } finally { unlock(t.id) } }} className="text-red-300 hover:text-red-200 text-xs font-bold disabled:opacity-40">DESTRIAR</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── REGRAS & APELIDOS DO MOTOR (BL 0.7.0) — semeadura humana ── */}
          <details className="border border-gray-800 rounded-2xl p-4" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadMgr() }}>
            <summary className="cursor-pointer font-bold text-sm">⚙ REGRAS & APELIDOS DO MOTOR <span className="text-gray-500 font-normal">— PADRÃO semeado pelo app (desligou, nunca volta) · humana manda · aprendida do MATCH</span></summary>
            <div className="mt-3 grid md:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-bold text-purple-300 mb-2">REGRAS <span className="text-gray-500 font-normal">(linha sem lançamento → o motor CRIA/ADOTA e casa, marca TRANSFER ou manda pro balde · precedência: regex humana &gt; pfc/classe humana &gt; aprendida &gt; PADRÃO)</span></p>
                <div className="flex gap-1 flex-wrap mb-2 items-center">
                  {(['ALL', 'HUMAN', 'DEFAULT', 'LEARNED'] as const).map(k => <button key={k} onClick={() => setOriginFilter(k)} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${originFilter === k ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{k === 'ALL' ? 'TODAS' : ORIGIN_BADGE[k][0]} {k === 'ALL' ? rules.length : rules.filter(r => (r.origin || 'HUMAN') === k).length}</button>)}
                  <button disabled={anyBusy} title="semeia as regras PADRÃO que faltam (chave estável; desligada nunca renasce)" onClick={async () => { lock('seed'); try { const d = await post({ action: 'seed_defaults' }); alert(`PADRÃO: ${(d.inserted || []).length} novas · ${(d.skipped || []).length} puladas/desligadas${(d.skipped || []).length ? '\n' + d.skipped.join('\n') : ''}`); await loadMgr(true) } catch (e) { fail(e) } finally { unlock('seed') } }} className="ml-auto bg-amber-900 hover:bg-amber-800 border border-amber-700 disabled:opacity-40 px-3 py-1 rounded-xl text-[10px] font-bold">{busy.has('seed') ? '…' : '↻ SEMEAR PADRÕES'}</button>
                </div>
                {[...rules].filter(r => originFilter === 'ALL' || (r.origin || 'HUMAN') === originFilter).sort((a, b) => { const o = (x: any) => x.origin === 'LEARNED' ? 1 : x.origin === 'DEFAULT' ? 2 : 0; return o(a) - o(b) || ((a.priority ?? 100) - (b.priority ?? 100)) || String(a.created_at || '').localeCompare(String(b.created_at || '')) }).map(r => (
                  <div key={r.id} className="flex items-center gap-2 border-b border-gray-900 py-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${(ORIGIN_BADGE[r.origin || 'HUMAN'] || ORIGIN_BADGE.HUMAN)[1]}`}>{(ORIGIN_BADGE[r.origin || 'HUMAN'] || ORIGIN_BADGE.HUMAN)[0]}</span>
                    <code className="text-xs bg-gray-900 rounded px-1.5 py-0.5 truncate max-w-[16rem]" title={[r.klass && 'classe ' + r.klass, r.pattern && 'regex ' + r.pattern, r.merchant_key && 'comerciante ' + r.merchant_key, r.pfc_primary && 'pfc ' + r.pfc_primary, r.pfc_detailed && r.pfc_detailed, r.key && r.key].filter(Boolean).join(' · ')}>{r.klass ? r.klass + (r.pattern ? ' + ' + r.pattern : '') : (r.pattern || r.pfc_detailed || r.pfc_primary || r.merchant_key || '?')}</code>
                    <span className="flex-1 text-xs text-gray-400 truncate">→ {r.target === 'TRANSFER' ? 'TRANSFER (status)' : r.target === 'BUCKET' ? 'BALDE (compras a atribuir)' : r.target === 'INPUT' ? 'SUPPLY ' + (r.category || 'CONSUMPTION') : 'despesa · ' + (sups.find(s => s.id === r.supplier_id)?.label || 'fornecedor?')}{r.label ? ' · ' + r.label : ''}{r.hits ? ` · ${r.hits}×` : ''}{r.amount_max ? ` · teto ${usd(Number(r.amount_max))}` : ''}{r.paused_reason ? ` · ${r.paused_reason}` : ''}</span>
                    <button onClick={async () => { const { error } = await supabase.from('bank_merchant_rules').update({ active: !r.active, paused_reason: r.active ? (r.origin === 'DEFAULT' ? 'desligada pelo dono' : r.paused_reason) : null }).eq('id', r.id); if (error) { alert(error.message); return } setRules(p => p.map(x => x.id === r.id ? { ...x, active: !r.active, paused_reason: r.active ? (r.origin === 'DEFAULT' ? 'desligada pelo dono' : x.paused_reason) : null } : x)) }} className={`text-xs font-bold ${r.active ? 'text-emerald-300' : r.origin === 'LEARNED' ? 'text-fuchsia-300' : 'text-gray-500'}`}>{r.origin === 'DEFAULT' ? (r.active ? 'LIGADA' : 'DESLIGADA') : r.active ? 'ATIVA' : r.origin === 'LEARNED' ? 'PROMOVER' : 'PAUSADA'}</button>
                    {/* PADRÃO não se apaga: a linha desligada é a lápide que impede o app de semear de novo. */}
                    {r.origin !== 'DEFAULT' && <button onClick={async () => { if (!confirm('Apagar a regra?')) return; await supabase.from('bank_merchant_rules').delete().eq('id', r.id); setRules(p => p.filter(x => x.id !== r.id)) }} className="text-red-400 text-xs font-bold">✕</button>}
                  </div>
                ))}
                <div className="flex gap-2 flex-wrap mt-2 items-center">
                  <input value={nr.pattern} onChange={e => setNr({ ...nr, pattern: e.target.value })} placeholder={nr.target === 'TRANSFER' ? 'regex no beneficiário — ex. ZELLE DEBIT TO HERALDO' : 'regex — ex. RACETRAC|WAWA (opcional se tiver pfc)'} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs flex-1 min-w-[160px]" />
                  <select value={nr.target} onChange={e => setNr({ ...nr, target: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1.5 text-xs">
                    <option value="FIXED_EXPENSE">despesa de fornecedor</option>
                    <option value="INPUT">supply (categoria)</option>
                    <option value="TRANSFER">transferência (sem lançamento)</option>
                    <option value="BUCKET">balde — compras a atribuir</option>
                  </select>
                  {nr.target === 'FIXED_EXPENSE' && (
                    <select value={nr.supplier_id} onChange={e => setNr({ ...nr, supplier_id: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1.5 text-xs max-w-[14rem]">
                      <option value="">— fornecedor —</option>
                      {sups.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  )}
                  {nr.target === 'INPUT' && (
                    <select value={nr.category} onChange={e => setNr({ ...nr, category: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1.5 text-xs">
                      {INPUT_CATS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  {nr.target === 'TRANSFER' ? (
                    <select value={nr.direction} onChange={e => setNr({ ...nr, direction: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1.5 text-xs" title="direção: só saídas, só entradas ou ambas">
                      <option value="OUT">saídas</option><option value="IN">entradas</option><option value="ANY">ambas</option>
                    </select>
                  ) : (
                    <input value={nr.pfc_primary} onChange={e => setNr({ ...nr, pfc_primary: e.target.value.toUpperCase() })} placeholder="pfc do Plaid — ex. TRANSPORTATION" list="cc-pfc" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-52" title="categoria do Plaid (personal_finance_category.primary): uma regra cobre todos os postos/mercados" />
                  )}
                  <datalist id="cc-pfc">{['TRANSPORTATION', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES', 'RENT_AND_UTILITIES', 'ENTERTAINMENT', 'TRAVEL', 'HOME_IMPROVEMENT', 'MEDICAL', 'BANK_FEES', 'TRANSFER_OUT', 'TRANSFER_IN', 'LOAN_PAYMENTS', 'PERSONAL_CARE', 'GOVERNMENT_AND_NON_PROFIT'].map(p => <option key={p} value={p} />)}</datalist>
                  {nr.target !== 'TRANSFER' && <input value={nr.pfc_detailed} onChange={e => setNr({ ...nr, pfc_detailed: e.target.value.toUpperCase() })} placeholder="pfc detalhado — ex. TRANSPORTATION_GAS" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-52" />}
                  <input value={nr.label} onChange={e => setNr({ ...nr, label: e.target.value })} placeholder="rótulo (ex. combustível frota)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-44" />
                  <button onClick={async () => {
                    const hasMatcher = nr.pattern.trim() || nr.pfc_primary.trim() || nr.pfc_detailed.trim()
                    if (nr.target === 'TRANSFER' && !nr.pattern.trim()) { alert('TRANSFER exige regex (regra humana)'); return }
                    if (!hasMatcher || (nr.target === 'FIXED_EXPENSE' && !nr.supplier_id)) { alert('padrão (regex ou pfc) e destino obrigatórios'); return }
                    const row = { pattern: nr.pattern.trim() || null, target: nr.target, supplier_id: nr.target === 'FIXED_EXPENSE' ? nr.supplier_id : null, category: nr.target === 'INPUT' ? nr.category : null, label: nr.label.trim() || null, active: true, origin: 'HUMAN', pfc_primary: nr.target === 'TRANSFER' ? null : (nr.pfc_primary.trim() || null), pfc_detailed: nr.target === 'TRANSFER' ? null : (nr.pfc_detailed.trim() || null), direction: nr.target === 'TRANSFER' ? nr.direction : 'OUT' }
                    const { data, error } = await supabase.from('bank_merchant_rules').insert(row).select('*').single()
                    if (error) alert(error.message + (/origin|pfc_|direction/.test(error.message) ? ' — rode MIGRATION_auto_book.sql' : '')); else { setRules(p => [...p, data]); setNr({ pattern: '', target: nr.target, supplier_id: '', category: 'CONSUMPTION', label: '', pfc_primary: '', pfc_detailed: '', direction: 'OUT' }) }
                  }} className="bg-purple-800 hover:bg-purple-700 px-3 py-1.5 rounded-xl text-xs font-bold">+ REGRA</button>
                </div>
                {learnMsg && <p className="mt-2 text-xs text-fuchsia-300">memória de comerciante: {learnMsg}</p>}
              </div>
              <div>
                <p className="font-bold text-sky-300 mb-2">APELIDOS <span className="text-gray-500 font-normal">(como o banco escreve ⇄ como o app chama — desempata os ambíguos)</span></p>
                {aliases.map(a => (
                  <div key={a.id} className="flex items-center gap-2 border-b border-gray-900 py-1">
                    <code className="text-xs bg-gray-900 rounded px-1.5 py-0.5">{a.pattern}</code>
                    <span className="flex-1 text-xs text-gray-400 truncate">⇄ {a.words}</span>
                    <button onClick={async () => { if (!confirm('Apagar o apelido?')) return; await supabase.from('bank_aliases').delete().eq('id', a.id); setAliases(p => p.filter(x => x.id !== a.id)) }} className="text-red-400 text-xs font-bold">✕</button>
                  </div>
                ))}
                <div className="flex gap-2 flex-wrap mt-2">
                  <input value={na.pattern} onChange={e => setNa({ ...na, pattern: e.target.value })} placeholder="banco escreve (regex) — ex. DELAWAR" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs flex-1 min-w-[140px]" />
                  <input value={na.words} onChange={e => setNa({ ...na, words: e.target.value })} placeholder="app chama (vírgulas) — ex. high horse, hhp" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs flex-1 min-w-[160px]" />
                  <button onClick={async () => {
                    if (!na.pattern.trim() || !na.words.trim()) { alert('padrão e palavras obrigatórios'); return }
                    const { data, error } = await supabase.from('bank_aliases').insert({ pattern: na.pattern.trim(), words: na.words.trim() }).select('*').single()
                    if (error) alert(error.message); else { setAliases(p => [...p, data]); setNa({ pattern: '', words: '' }) }
                  }} className="bg-sky-800 hover:bg-sky-700 px-3 py-1.5 rounded-xl text-xs font-bold">+ APELIDO</button>
                </div>
              </div>
            </div>
          </details>

          {/* ── A CONFERIR ── */}
          {auto && (auto.pending.length > 0 || auto.batches.length > 0) && (
            <div className="border border-gray-800 rounded-2xl p-4">
              <div className="flex items-center gap-3 flex-wrap mb-3">
                <p className="font-bold flex-1">A CONFERIR <span className="text-amber-300">{auto.pending.length}</span> <span className="text-xs text-gray-500 font-normal">· {auto.reviewed} já conferidas</span></p>
                <div className="flex gap-1">
                  {(['ALL', 'FEE', 'EXACT', 'NAME', 'RULE', 'LEARN', 'BUCKET'] as const).map(k => <button key={k} onClick={() => setEngineFilter(k)} className={`px-3 py-1 rounded-xl text-xs font-bold border ${engineFilter === k ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{k === 'ALL' ? 'TODAS' : k}</button>)}
                </div>
                {auto.pending.some(a => a.engine === 'FEE') && <button disabled={anyBusy} onClick={reviewAllFees} className="bg-teal-800 hover:bg-teal-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">{busy.has('review_all') ? '…' : 'OK TODAS AS TARIFAS'}</button>}
              </div>
              {auto.batches.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-3 text-xs text-gray-400">
                  {auto.batches.map(b => (
                    <span key={b.batch} className="inline-flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-1">
                      {runLabel(b.trigger, b.started_at)} · linhas {formatShortDate(b.from)}–{formatShortDate(b.to)} · {b.n} ({b.fee} FEE · {b.exact} EXACT{b.name ? ` · ${b.name} NAME` : ''}{b.rule ? ` · ${b.rule} RULE` : ''}{b.learn ? ` · ${b.learn} LEARN` : ''}{b.transfer ? ` · ${b.transfer} TRANSFER` : ''}{b.bucket ? ` · ${b.bucket} A ATRIBUIR` : ''}){b.pending ? ` · ${b.pending} a conferir` : ' · conferida'}
                      <button disabled={anyBusy} onClick={() => undoBatch(b)} className="text-red-300 hover:text-red-200 font-bold disabled:opacity-40">{busy.has('undo_' + b.batch) ? '…' : 'DESFAZER LOTE'}</button>
                    </span>
                  ))}
                </div>
              )}
              {pendingReview.length === 0 ? <p className="text-emerald-400 text-sm font-bold">Tudo conferido.</p> : (
                <div className="divide-y divide-gray-800">
                  {pendingReview.slice(0, 150).map(a => (
                    <div key={a.id} className="py-2 flex items-center gap-3 flex-wrap">
                      <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(a.date)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${ENGINE_CHIP[a.status === 'TRANSFER' ? 'TRANSFER' : a.engine] || 'border-gray-700 text-gray-400'}`}>{a.status === 'TRANSFER' ? 'TRANSFER' : a.engine}</span>
                      <span className="text-sm truncate max-w-[18rem]" title={a.raw_name || a.name}>{a.name}</span>
                      <span className={`tabular-nums font-bold text-sm shrink-0 ${a.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{a.amount > 0 ? '−' : '+'}{usd(a.amount)}</span>
                      <span className="text-xs text-gray-400 flex-1 truncate min-w-[12rem]" title={a.note}>⇄ {a.note}{a.backfilled ? <span className="ml-2 text-[10px] text-sky-300" title="a data de pagamento do app foi preenchida com a do banco">data preenchida</span> : null}</span>
                      {a.href && <a href={`${BASE_PATH}${a.href}`} target="_blank" rel="noreferrer" title="abre o registro que o motor escolheu, em aba nova" className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded-xl font-bold text-xs">ABRIR ↗</a>}
                      {a.engine === 'BUCKET'
                        ? <a href="#a-atribuir" onClick={() => document.getElementById('a-atribuir')?.scrollIntoView({ behavior: 'smooth' })} className="bg-amber-900 hover:bg-amber-800 border border-amber-700 px-3 py-1 rounded-xl font-bold text-xs" title="linha do balde: o OK é dizer o dono na fila A ATRIBUIR">ATRIBUIR ↓</a>
                        : <button disabled={batchBusy || busy.has(a.id)} onClick={() => review(a)} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">OK</button>}
                      <button disabled={batchBusy || busy.has(a.id)} onClick={() => undoLine(a)} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">DESFAZER</button>
                    </div>
                  ))}
                  {pendingReview.length > 150 && <p className="text-xs text-gray-500 pt-2">mostrando 150 de {pendingReview.length} — confira e recarregue</p>}
                </div>
              )}
            </div>
          )}

          {/* ── SEM CASAMENTO (humano) ── */}
          <div>
            <p className="text-sm text-gray-400 mb-3 max-w-3xl">Cada linha do banco ou já existe no app (MATCH — Enter no seletor também casa; a data de pagamento do app é preenchida com a do banco se faltava), ou é transferência/ignorável, ou falta no app: EXPLAIN guarda o que foi pra lançar depois.</p>
            <div className="flex gap-3 flex-wrap items-center mb-3">
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar por nome, valor ou data" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-72" />
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer"><input type="checkbox" checked={onlyCand} onChange={e => setOnlyCand(e.target.checked)} className="w-4 h-4" /> só com candidato</label>
              <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer"><input type="checkbox" checked={hideFee} onChange={e => setHideFee(e.target.checked)} className="w-4 h-4" /> esconder tarifas ({feeLines} — o motor FEE cuida)</label>
              <button onClick={load} disabled={anyBusy} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">↻</button>
              <span className="text-xs text-gray-500 ml-auto">{visible.length} linhas{visible.length > shown ? ` · mostrando ${shown}` : ''}</span>
            </div>
            {/* TRIAGEM POR FAMÍLIA (João, 25/ago): o grosso do SEM CASAMENTO é cartão
                do dia a dia sem linha no app — decide-se por família, não um a um. */}
            {lines && lines.length > 0 && (() => {
              const fams = new Map<string, { n: number; sum: number }>()
              for (const l of lines) { if (l.pending || l.fee) continue; const f = famOf(l); if (!f) continue; const e = fams.get(f) || { n: 0, sum: 0 }; e.n++; e.sum += Math.abs(l.amount); fams.set(f, e) }
              const top = [...fams.entries()].filter(([, e]) => e.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 14)
              if (!top.length) return null
              return (
                <div className="mb-3">
                  <div className="flex gap-2 flex-wrap items-center">
                    <span className="text-xs font-bold text-gray-500">TRIAGEM POR FAMÍLIA:</span>
                    {top.map(([f, e]) => (
                      <button key={f} onClick={() => { setFamilyFilter(familyFilter === f ? null : f); setTriageNote(f === familyFilter ? '' : f.charAt(0) + f.slice(1).toLowerCase()) }} className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${familyFilter === f ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800'}`}>{f} ×{e.n} · {usd(e.sum)}</button>
                    ))}
                  </div>
                  {familyFilter && (
                    <div className="flex gap-2 flex-wrap items-center mt-2">
                      <input value={triageNote} onChange={e => setTriageNote(e.target.value)} placeholder="o que foi (vira a nota do TO BOOK)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-sm w-72" />
                      <button disabled={anyBusy || !triageNote.trim() || !visible.some(l => !l.pending)} onClick={triageApply} className="bg-purple-800 hover:bg-purple-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">EXPLICAR AS {visible.filter(l => !l.pending).length} FILTRADAS → TO BOOK</button>
                      <span className="text-xs text-gray-500">não é ignorar: é "sei o que foi — lanço depois", com a nota gravada</span>
                    </div>
                  )}
                </div>
              )
            })()}
            {!lines ? <p className="text-gray-500">Carregando o banco…</p> : visible.length === 0 ? <p className={error ? 'text-gray-500' : 'text-emerald-400 font-bold'}>{error ? 'Sem dados.' : 'Nada pendente aqui.'}</p> : (
              <div className="divide-y divide-gray-800">
                {visible.slice(0, shown).map(l => {
                  const sel = pick[l.id] || ''
                  // Sem escolha explícita o <select> MOSTRA o primeiro — cand acompanha o que o olho vê.
                  const cand = l.candidates.find(c => c.table + ':' + c.id === sel) || l.candidates[0]
                  const dis = anyBusy
                  return (
                    <div key={l.id} className="py-3 px-2">
                      <div className="flex items-baseline gap-3">
                        <button onClick={() => setInspect(s => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })} className="text-gray-500 hover:text-white text-xs w-4 shrink-0" title="conferir as fontes">{inspect.has(l.id) ? '▾' : '▸'}</button>
                        <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(l.date)}</span>
                        <span className="flex-1 truncate text-sm" title={l.raw_name}>{l.name}{l.pending && <span className="ml-2 text-xs text-amber-400" title="ainda não postou — o Plaid troca o id ao postar; MATCH só depois">PENDING</span>}{l.fee && <span className="ml-2 text-[10px] font-bold text-teal-300">TARIFA</span>}{l.source === 'STATEMENT' && <span className="ml-2 text-xs text-gray-600">extrato</span>}</span>
                        <span className={`tabular-nums font-bold text-sm shrink-0 ${l.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{l.amount > 0 ? '−' : '+'}{usd(l.amount)}</span>
                      </div>
                      {/* CONFERIR (UX #1, João 25/ago): as fontes dos dois lados, com link pro registro real. */}
                      {inspect.has(l.id) && (
                        <div className="mt-2 grid md:grid-cols-2 gap-3 bg-black/40 border border-gray-800 rounded-2xl p-3 text-xs">
                          <div>
                            <p className="font-bold text-gray-400 mb-1">🏦 O QUE O BANCO DIZ</p>
                            <p className="text-gray-300">{l.raw_name}</p>
                            <p className="text-gray-500 mt-1">{formatShortDate(l.date)} · {l.amount > 0 ? 'saiu' : 'entrou'} {usd(l.amount)} · {l.source === 'STATEMENT' ? 'importada do extrato em PDF' : 'feed do Plaid'}{l.pending ? ' · ainda PENDENTE (não postou)' : ''}</p>
                          </div>
                          <div>
                            <p className="font-bold text-gray-400 mb-1">📒 O QUE O APP TEM {cand ? '' : '(nenhum candidato)'}</p>
                            {cand ? (
                              <>
                                <p className="text-gray-300">{cand.detail || cand.label}</p>
                                <p className="text-gray-500 mt-1">{cand.date ? 'data ' + formatShortDate(cand.date) : 'sem data'}{cand.dd != null ? ` · ${cand.dd} dia(s) do banco` : ''} · {usd(cand.amount)}</p>
                                {cand.href && <a href={`${BASE_PATH}${cand.href}`} target="_blank" rel="noreferrer" className="inline-block mt-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded-xl font-bold">ABRIR REGISTRO ↗</a>}
                              </>
                            ) : <p className="text-gray-500">nada com esse valor no app — TRANSFER, IGNORE ou EXPLAIN</p>}
                          </div>
                        </div>
                      )}
                      <div className="mt-2 flex gap-2 flex-wrap items-center">
                        {l.candidates.length > 0 ? (
                          <select value={sel} onChange={e => setPick({ ...pick, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && cand && !dis && !l.pending) { e.preventDefault(); act(l, 'match', { table: cand.table, row_id: cand.id }) } }} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs max-w-xl">
                            {l.candidates.map(c => <option key={c.table + c.id} value={c.table + ':' + c.id}>{c.label} — {c.date ? formatShortDate(c.date) : 'sem data'}{c.dd != null ? ` (${c.dd}d)` : ''}{c.undated ? ' · sem payment date' : ''}</option>)}
                          </select>
                        ) : <span className="text-xs text-gray-600">sem candidato no app</span>}
                        <button disabled={!cand || dis || l.pending} title={l.pending ? 'espere a linha postar' : ''} onClick={() => cand && act(l, 'match', { table: cand.table, row_id: cand.id })} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">{busy.has(l.id) ? '…' : 'MATCH'}</button>
                        <button disabled={dis} onClick={() => act(l, 'transfer')} className="bg-blue-800 hover:bg-blue-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">TRANSFER</button>
                        <button disabled={dis} onClick={() => { if (confirm('Ignorar esta linha do banco?')) act(l, 'ignore') }} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">IGNORE</button>
                        <input value={explain[l.id] || ''} onChange={e => setExplain({ ...explain, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && (explain[l.id] || '').trim() && !dis) { e.preventDefault(); act(l, 'explain', { note: explain[l.id] }) } }} placeholder="o que foi? (EXPLAIN)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-56" />
                        <button disabled={!(explain[l.id] || '').trim() || dis} onClick={() => act(l, 'explain', { note: explain[l.id] })} className="bg-fuchsia-800 hover:bg-fuchsia-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">EXPLAIN</button>
                      </div>
                    </div>
                  )
                })}
                {visible.length > shown && <button onClick={() => setShown(s => s + 100)} className="mt-3 w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">MOSTRAR MAIS ({visible.length - shown} restantes)</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
