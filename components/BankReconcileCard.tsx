'use client'

// Card «Conciliação bancária» (21/ago; «Banco sem casamento» até 22/ago). Desde BL 1.5.0 · DC 1.50.0 (10/set/2026) tem DOIS
// modos, porque o Data Checker é auditoria e o motor é do Bank Link (João × Márcio, 10/set: a discussão nasceu de um card que
// misturava o painel do motor com a lista de linhas, e mostrava igual uma Summit pendente, uma dúvida e uma coincidência):
//   mode="questions" (Data Checker): só o que o AUTO-LINK NÃO resolve sozinho. Cada linha chega da rota com UM estado e UMA
//     frase (lib/bankLineState.server.ts): PERGUNTA (conta), FORNECEDOR (conta uma vez por grupo) ou ESPERANDO (aparece
//     recolhido, não conta). Só candidato PAR (valor + nome, ou valor + tipo de compra) vira sugestão; coincidência de
//     centavos fica recolhida e pede confirmação para casar. Linha de DINHEIRO (wire, Zelle, depósito — DC 1.51.0): só o
//     NOME libera SIM/É ESTA e a pré-seleção; sem nome, a lista aparece sem nada marcado.
//   mode="engine" (Bank Link, /adm/bank): o AUTO-LINK — última rodada, PLANEJAR/APLICAR, RESTAURAR DIÁRIO, casadas a conferir
//     (sem as do balde, que têm a fila própria na mesma tela), lotes com DESFAZER, regras e apelidos.
// Lê e escreve por /api/bank/reconcile com o JWT da sessão (tabelas do banco são só-service-key). Depois de um MATCH recarrega:
// o servidor é quem sabe quais candidatos ainda valem (revisão de 21/ago). Revisão #21–#25: `busy` é um conjunto (nada fica
// clicável durante um lote), plano some quando os dados mudam, falha no APLICAR recarrega, contagem do pai vem do estado.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import { BL_STAGE, BL_VERSION } from '@/lib/blVersion'

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Nível do candidato (BL 1.5.0): PAR = valor + perto + nome ou tipo de compra; LONGE = valor + nome, longe; COINCIDENCIA = só valor.
type Tier = 'PAR' | 'LONGE' | 'COINCIDENCIA'
type Cand = { table: string; id: string; label: string; date: string | null; amount: number; undated: boolean; href?: string; detail?: string; score: number; dd: number | null; tier?: Tier; named?: boolean }   // named (DC 1.51.0): o nome da linha do banco bate no registro
// A DÚVIDA DO MOTOR, dita (BL 0.10.0): por que esta linha NÃO foi resolvida sozinha, com o candidato que ele viu.
type Doubt = { kind: string; reason: string; klass?: string; supplier?: string; cands?: { table: string; id: string; label: string; date: string | null; amount: number; href?: string; days?: number | null; exact?: boolean; named?: boolean }[] }
// CASAR COM AJUSTE (BL 1.1.0): a passagem da folha que casa com deriva (câmbio, par de passagens, pagador errado no papel).
type NearCand = { ids: string[]; amount: number; delta: number; pct: number; date: string; label: string; staff: string[]; paid_from: string[]; paid_from_mismatch: boolean; name_ok: boolean; exact: boolean; brl: number | null }
type LineState = { code: string; pile: 'PERGUNTA' | 'FORNECEDOR' | 'ESPERANDO'; ask: boolean; sentence: string; target?: { table: string; id: string; label: string } | null }
type Line = { id: string; date: string; amount: number; name: string; raw_name: string; pending: boolean; source: string; fee: boolean; money?: boolean; candidates: Cand[]; doubt?: Doubt | null; queued?: boolean; near?: NearCand[] | null; state?: LineState | null }
// PERGUNTAS POR FORNECEDOR: uma resposta = uma regra humana = todas as linhas do grupo, pra sempre.
type QGroup = { key: string; name: string; klass: string; n: number; total: number; sample: string[]; oldest: string; newest: string; line_ids: string[]; suggested: { supplier_id: string | null; company: string | null; cost_type: string | null; ambiguous: { id: string; company: string | null; cost_type: string | null }[] }; app_rows?: { id: string; date: string; amount: number; paid_from: string | null; staff: string; desc: string; linked: boolean }[]; near?: { line_id: string; date: string; amount: number; cands: NearCand[] }[]; near_error?: string }
type Questions = { suppliers: QGroup[]; money: { id: string; date: string; amount: number; name: string; klass: string; reason: string }[]; twins?: number; seasons?: { id: string; staff: string; label: string }[]; fixed_suppliers?: { id: string; company: string; cost_type: string }[]; link_migration?: boolean }
type QPick = { target: string; supplier_id: string; category: string; season_id: string; company: string; cost_type: string }
type AutoLine = { id: string; date: string; amount: number; name: string; raw_name?: string; engine: string; batch: string; note: string; source: string; backfilled: boolean; href?: string | null; status?: string; rule?: string | null }
type Batch = { batch: string; n: number; pending: number; fee: number; exact: number; name?: number; rule?: number; learn?: number; transfer?: number; bucket?: number; from: string; to: string; trigger?: string | null; started_at?: string | null }
type AutoRun = { id: string; trigger: string; status: string; started_at: string; finished_at: string | null; counts: Record<string, number> | null; errors: string[] | null; remaining: number | null }
type Auto = { pending: AutoLine[]; reviewed: number; batches: Batch[]; runs?: AutoRun[] }
type Plan = { fee_create: number; fee_match: number; exact: number; set?: number; ignore?: number; name: number; rule_create: number; rule_adopt?: number; learn?: number; transfer?: number; bucket?: number; by_klass?: Record<string, number>; seed?: string | null; total: number; hash: string; skipped: Record<string, number>; samples: { fee: string[]; exact: string[]; name: string[]; rule: string[]; transfer?: string[]; bucket?: string[] } }
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

const ENGINE_CHIP: Record<string, string> = { FEE: 'bg-teal-950 text-teal-300 border-teal-800', EXACT: 'bg-emerald-950 text-emerald-300 border-emerald-800', NAME: 'bg-sky-950 text-sky-300 border-sky-800', RULE: 'bg-purple-950 text-purple-300 border-purple-800', LEARN: 'bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800', TRANSFER: 'bg-blue-950 text-blue-300 border-blue-800', BUCKET: 'bg-amber-950 text-amber-300 border-amber-800', ADJUST: 'bg-lime-950 text-lime-300 border-lime-800', SET: 'bg-cyan-950 text-cyan-300 border-cyan-800', IGNORED: 'bg-gray-900 text-gray-400 border-gray-700' }
// Vocabulário das telas de supplies (fase B): SHOP nunca existiu ali.
const INPUT_CATS = ['CONSUMPTION', 'APARTMENT', 'CATS', 'TEAM']
const ORIGIN_BADGE: Record<string, [string, string]> = { LEARNED: ['APRENDIDA', 'bg-fuchsia-950 text-fuchsia-300'], DEFAULT: ['PADRÃO', 'bg-amber-950 text-amber-300'], HUMAN: ['HUMANA', 'bg-purple-950 text-purple-300'] }
// AUTO-LINK: rótulo humano da rodada — cron/webhook (automática) vs APLICAR.
const fmtNY = (iso?: string | null) => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : ''
const runLabel = (trigger?: string | null, at?: string | null) => (trigger && trigger !== 'human' ? 'AUTO · ' + trigger : 'APLICAR') + (at ? ' ' + fmtNY(at) : '')
const BATCH_KEYS = new Set(['plan', 'apply', 'review_all'])
// Estado da linha → cor do chip: pergunta colorida, espera cinza, «vai casar» verde.
const STATE_CHIP: Record<string, string> = {
  'É ESTA?': 'bg-amber-950 text-amber-300 border-amber-800', DISPUTA: 'bg-amber-950 text-amber-300 border-amber-800', QUASE: 'bg-orange-950 text-orange-300 border-orange-800',
  'NA FOLHA': 'bg-lime-950 text-lime-300 border-lime-800', DINHEIRO: 'bg-blue-950 text-blue-300 border-blue-800', 'QUEM É?': 'bg-purple-950 text-purple-300 border-purple-800',
  'SEM REGRA': 'bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800', 'AGENDADA≠': 'bg-orange-950 text-orange-300 border-orange-800', PARADA: 'bg-red-950 text-red-300 border-red-800', 'TO BOOK': 'bg-amber-950 text-amber-200 border-amber-700',
  PENDENTE: 'bg-gray-900 text-gray-400 border-gray-700', 'VAI CASAR': 'bg-emerald-950 text-emerald-300 border-emerald-800', MATURANDO: 'bg-gray-900 text-gray-400 border-gray-700',
  TETO: 'bg-gray-900 text-gray-400 border-gray-700', 'IRMÃ PENDENTE': 'bg-gray-900 text-gray-400 border-gray-700', DUPLICADA: 'bg-gray-900 text-gray-400 border-gray-700',
}
const isPar = (c: Cand) => !c.tier || c.tier === 'PAR'   // rota antiga sem nível: trata como antes
// DINHEIRO SEM NOME (DC 1.51.0): em wire, Zelle e depósito toda tabela «combina» — só o NOME libera SIM/É ESTA e a pré-seleção.
// Sem candidato com nome, a lista continua lá, mas nada vem marcado e o MATCH espera a escolha de gente.
const sayable = (l: Line, c: { named?: boolean }) => !l.money || c.named === true

export default function BankReconcileCard({ mode = 'questions', onCount }: { mode?: 'questions' | 'engine'; onCount?: (n: number, aConferir?: number, bucket?: number) => void }) {
  const engine = mode === 'engine'
  const [lines, setLines] = useState<Line[] | null>(null)
  const [totalNew, setTotalNew] = useState(0)
  const [auto, setAuto] = useState<Auto | null>(null)
  const [needsMigration, setNeedsMigration] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(80)
  const [inspect, setInspect] = useState<Set<string>>(new Set())   // linhas com o CONFERIR aberto
  const [coins, setCoins] = useState<Set<string>>(new Set())       // linhas com as coincidências de valor abertas
  const [pick, setPick] = useState<Record<string, string>>({})     // line id → "table:id"
  const [explain, setExplain] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [progress, setProgress] = useState('')
  const [engineFilter, setEngineFilter] = useState<'ALL' | 'FEE' | 'EXACT' | 'NAME' | 'RULE' | 'LEARN' | 'ADJUST' | 'SET'>('ALL')
  const [originFilter, setOriginFilter] = useState<'ALL' | 'HUMAN' | 'DEFAULT' | 'LEARNED'>('ALL')   // ⚙ (fase B)
  const [learnMsg, setLearnMsg] = useState<string | null>(null)   // "regra aprendida…" depois de um MATCH humano
  const [familyFilter, setFamilyFilter] = useState<string | null>(null)   // triagem por família
  const [triageNote, setTriageNote] = useState('')
  const [pileFilter, setPileFilter] = useState<string | null>(null)       // estado (É ESTA?, DINHEIRO…)
  const [waitOpen, setWaitOpen] = useState(false)
  const [waitAct, setWaitAct] = useState<Set<string>>(new Set())   // linhas ESPERANDO com «agir» aberto (revisão DC 1.50.0)
  const [grpOpen, setGrpOpen] = useState<Set<string>>(new Set())   // grupos QUEM É? com as linhas abertas
  // PERGUNTAS POR FORNECEDOR (BL 0.10.0): dúvidas agrupadas por fornecedor; erro = as linhas do grupo voltam pra lista linha a linha.
  const [questions, setQuestions] = useState<Questions | null>(null)
  const [qError, setQError] = useState(false)
  const [qOpen, setQOpen] = useState(true)
  const [qBusy, setQBusy] = useState<string | null>(null)
  const [qPick, setQPick] = useState<Record<string, QPick>>({})
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

  // ── o que conta ──
  // PERGUNTA conta por linha; FORNECEDOR conta UMA vez por grupo (se as perguntas por fornecedor não carregarem, as linhas
  // voltam pra lista e contam uma a uma — nunca somem); ESPERANDO aparece recolhido e não conta.
  const asked = useMemo(() => (lines || []).filter(l => l.state ? (l.state.ask && (l.state.pile === 'PERGUNTA' || (qError && l.state.pile === 'FORNECEDOR'))) : !l.pending), [lines, qError])
  const waiting = useMemo(() => (lines || []).filter(l => !!l.state && !l.state.ask), [lines])
  const supplierGroups = questions && !qError ? questions.suppliers.length : 0
  const askTotal = asked.length + supplierGroups
  const aConferir = (auto?.pending || []).filter(a => a.engine !== 'BUCKET').length
  // Enquanto as perguntas por fornecedor carregam, o número ainda não é verdade: nem ✓, nem contagem pro pai (revisão DC 1.50.0).
  const qLoading = !engine && !error && questions === null && !qError
  const lineById = useMemo(() => new Map((lines || []).map(l => [l.id, l])), [lines])

  // Contagem do pai sai do estado, nunca do closure do clique (revisão #25).
  useEffect(() => { if (lines && !qLoading) onCount?.(engine ? aConferir : askTotal, aConferir, 0) }, [lines, qLoading, engine, aConferir, askTotal, onCount])

  async function load() {
    setError(''); setPlan(null)   // plano é de um instante — dados novos, plano novo (revisão #22)
    try {
      // O painel do motor carrega leve (?engine=1: rodada e casadas a conferir, sem pool, plano e estados — revisão BL 1.5.0).
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile${engine ? '?engine=1' : ''}`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLines(d.lines); setTotalNew(d.total_new)
      if (!engine) loadQuestions()   // em paralelo — a lista principal não espera as perguntas
      setAuto(d.auto || null); setNeedsMigration(!!d.needs_migration)
      setPick(prev => {
        const p: Record<string, string> = {}
        for (const l of d.lines as Line[]) {
          const keep = prev[l.id] && l.candidates.some(c => c.table + ':' + c.id === prev[l.id] && isPar(c) && sayable(l, c)) ? prev[l.id] : null
          const first = l.candidates.find(c => isPar(c) && sayable(l, c))
          if (keep) p[l.id] = keep; else if (first) p[l.id] = first.table + ':' + first.id
        }
        return p
      })
    } catch (e) {
      setError(String((e as Error).message || e)); setLines([])
    }
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  async function loadQuestions() {
    try {
      const r = await fetch(`${BASE_PATH}/api/bank/reconcile?questions=1`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      const ok = r.ok && Array.isArray(d.suppliers)
      setQuestions(ok ? d : null); setQError(!ok)
    } catch { setQuestions(null); setQError(true) }
  }
  // Uma resposta por fornecedor: vira regra HUMANA e lança as linhas do grupo agora.
  // CASAR COM AJUSTE: a linha do banco casa com a passagem da folha; valor vira o do banco,
  // pagador vira GZ28US (o banco prova), elo na coluna. DESFAZER devolve tudo.
  const dlt = (c: NearCand) => (c.delta < 0 ? '−' : '+') + usd(Math.abs(c.delta))
  function adjustText(bankDate: string, bankAmt: number, c: NearCand): string {
    return 'CASAR COM AJUSTE: a linha do banco ' + formatShortDate(bankDate) + ' ' + usd(bankAmt) + ' casa com «' + c.label + '» (' + c.staff.join(', ') + ', ' + formatShortDate(c.date) + ', ' + usd(c.amount) + ').\n\nO app grava: valor → ' + usd(bankAmt) + ' (Δ ' + dlt(c) + (c.exact ? '' : ', ' + c.pct + '%') + ')' + (c.paid_from.some(p => p !== 'GZ28US') ? '; quem pagou ' + c.paid_from.join('/') + ' → GZ28US (o banco prova' + (c.paid_from_mismatch ? ' — sai da conta corrente/empréstimo' : '') + ')' : '') + (c.name_ok ? '' : '; NOME NÃO CONFIRMADO — só data e valor batem') + '.\nDESFAZER no Bank Link (AUTO-LINK → casadas a conferir, enquanto não tiver OK) devolve o que foi gravado: valor, pagador e elo.'
  }
  async function adjustMatch(bankId: string, bankDate: string, bankAmt: number, c: NearCand, ask = true) {
    if (anyBusy || qBusy) return
    if (ask && !confirm(adjustText(bankDate, bankAmt, c))) return
    lock(bankId)
    try { await post({ action: 'match_adjust', bank_id: bankId, ids: c.ids }); await load(); await loadQuestions() }
    catch (e) { const f = fail(e); if (f.status === 409) await load() }
    finally { unlock(bankId) }
  }
  // CASAR TODAS: só linhas com UM candidato, em sequência, sem repetir registro; para no 1º erro;
  // trava o card inteiro enquanto roda e diz no fim o que casou e o que pulou.
  const adjustPlan = (g: QGroup) => { const used = new Set<string>(); const go: { line_id: string; date: string; amount: number; c: NearCand }[] = []; let dup = 0; for (const t of (g.near || []).filter(n => n.cands.length === 1)) { const c = t.cands[0]; if (c.ids.some(i => used.has(i))) { dup++; continue } c.ids.forEach(i => used.add(i)); go.push({ line_id: t.line_id, date: t.date, amount: t.amount, c }) } return { go, dup } }
  async function adjustAll(g: QGroup) {
    const { go, dup } = adjustPlan(g)
    if (!go.length || !confirm('Casar ' + go.length + ' linha(s) de ' + g.name + ' com as passagens da folha, uma a uma (valor do banco, pagador GZ28US onde o banco prova)?' + (dup ? ' ' + dup + ' ficam de fora (mesmo registro da folha).' : '') + ' Cada uma pode ser desfeita no Bank Link (casadas a conferir) enquanto não tiver OK.')) return
    let n = 0, stop = ''
    lock('adjust_all'); setQBusy(g.key)
    try {
      for (const t of go) { try { await post({ action: 'match_adjust', bank_id: t.line_id, ids: t.c.ids }); n++ } catch (e) { stop = formatShortDate(t.date) + ' ' + usd(t.amount) + ': ' + fail(e).message; break } }
      await load(); await loadQuestions()
    } finally { unlock('adjust_all'); setQBusy(null) }
    alert(n + ' casada(s)' + (dup ? ' · ' + dup + ' pulada(s) (mesmo registro da folha)' : '') + (stop ? ' · parou em ' + stop : ''))
  }
  async function answerSupplier(g: QGroup, pk: QPick) {
    if (anyBusy || qBusy) return
    const dest = pk.target === 'FIXED' ? (pk.supplier_id === '__new__' ? 'novo prestador «' + pk.company.trim() + '»' : ((questions?.fixed_suppliers || []).find(x => x.id === pk.supplier_id)?.company || 'prestador')) : pk.target === 'SUPPLIES' ? 'insumo ' + pk.category : pk.target === 'BUCKET' ? 'balde (peça pra carro)' : pk.target === 'TRIP' ? 'viagem a trabalho' : pk.target === 'PERSONAL' ? 'PESSOAL (' + ((questions?.seasons || []).find(x => x.id === pk.season_id)?.label || 'season') + ')' : 'IGNORAR'
    if (!confirm(`${g.name}: ${g.n} linha(s) · ${usd(g.total)} → ${dest}.\n${pk.target === 'IGNORE' ? 'As linhas ficam IGNORADAS (nada é lançado).' : pk.target === 'PERSONAL' ? 'Cada linha vira despesa PESSOAL na season escolhida — não é custo da empresa.' : 'Cria a regra (vale pra sempre) e lança as linhas agora.'} Continuar?`)) return
    setQBusy(g.key)
    try {
      const d = await post({ action: 'answer_supplier', key: g.key, name: g.name, line_ids: g.line_ids, target: pk.target, supplier_id: pk.supplier_id && pk.supplier_id !== '__new__' ? pk.supplier_id : undefined, new_supplier: pk.supplier_id === '__new__' ? { company: pk.company.trim(), cost_type: pk.cost_type } : undefined, category: pk.category, season_id: pk.season_id || undefined })
      alert(`${g.name}: ${d.booked ?? 0} lançada(s)${d.rule ? ' · regra criada' : ''}${d.errors?.length ? ' · erros: ' + d.errors.slice(0, 3).join(' | ') : ''}`)
      await load()
    } catch (e) { fail(e) } finally { setQBusy(null) }
  }

  async function post(body: Record<string, unknown>) {
    const r = await fetch(`${BASE_PATH}/api/bank/reconcile`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    if (d && d.learned) { setLearnMsg(String(d.learned)); setTimeout(() => setLearnMsg(null), 15000) }   // memória de comerciante (BL 0.8.0)
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
      if (action === 'match' || action === 'reject_twin') await load()   // NÃO (gêmeo): o motor pode devolver outra dúvida — recarrega em vez de sumir
      else {
        setLines(prev => (prev || []).filter(x => x.id !== l.id)); setTotalNew(n => n - 1); setPlan(null)
        // linha de um grupo QUEM É? resolvida à mão sai do grupo (grupo vazio some) — a contagem fica honesta sem recarregar
        setQuestions(qs => qs ? { ...qs, suppliers: qs.suppliers.map(g => g.line_ids.includes(l.id) ? { ...g, n: g.n - 1, total: g.total - Math.abs(l.amount), line_ids: g.line_ids.filter(x => x !== l.id) } : g).filter(g => g.line_ids.length > 0) } : qs)
      }
    } catch (e) { if (fail(e).status === 409) await load() } finally { unlock(l.id) }
  }

  // TRIAGEM: explica TODAS as filtradas de uma vez (NEW → TO BOOK, com nota).
  async function triageApply() {
    const ids = visible.filter(l => !l.pending).map(l => l.id)
    const note = triageNote.trim()
    if (!ids.length || !note) return
    if (!confirm(`Explicar ${ids.length} linhas como "${note}"? Saem das perguntas e ficam em TO BOOK (a lançar), com a nota, por até 14 dias — depois voltam a perguntar; a que já tem registro parecido no app continua perguntando por ele. Nada é apagado — dá pra reverter linha a linha (DESTRIAR).`)) return
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
    if (!confirm(`Aplicar agora? ${plan.total} linhas: ${plan.fee_create} tarifas criadas, ${plan.fee_match} tarifas casadas, ${plan.exact} exatos, ${plan.set || 0} em série (SET), ${plan.ignore || 0} ignorados por regra, ${plan.name} por nome/apelido, ${plan.rule_create} criados por REGRA, ${plan.rule_adopt || 0} agendadas ADOTADAS (valor ajustado, não duplicadas), ${plan.learn || 0} por regra aprendida, ${plan.transfer || 0} transferências, ${plan.bucket || 0} caem no balde A ATRIBUIR (despesa real, sem dono ainda). DESFAZER LOTE devolve as linhas ao banco e apaga o que a rodada criou — é desfazer, não recusa: a rodada seguinte refaz o que tiver prova e relança o que uma regra ligada cobrir.`)) return
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
    if (anyBusy || !confirm(`Desfazer a rodada inteira? ${b.n} linhas voltam a ficar sem dono (o AUTO-LINK refaz o que tiver prova na próxima rodada; o resto vira pergunta no Data Checker). Tarifas (voltam sempre na próxima rodada), lançamentos criados por regra e compras do balde A ATRIBUIR (voltam enquanto a regra estiver ligada) são APAGADOS; agendadas adotadas voltam ao valor original; em registro que já existia, volta só o que a rodada escreveu.`)) return
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
    const needle = q.trim().toLowerCase()
    return asked.filter(l => (!pileFilter || (l.state?.code || 'PARADA') === pileFilter) && (!familyFilter || famOf(l) === familyFilter) && (!needle || l.name.toLowerCase().includes(needle) || l.raw_name.toLowerCase().includes(needle) || Math.abs(l.amount).toFixed(2).includes(needle) || l.date.includes(needle)))
  }, [asked, q, pileFilter, familyFilter])
  const countBy = (arr: Line[]) => { const m = new Map<string, number>(); for (const l of arr) { const k = l.state?.code || 'PARADA'; m.set(k, (m.get(k) || 0) + 1) } return [...m.entries()].sort((a, b) => b[1] - a[1]) }
  // filtro ativo nunca some (a ×0 ele continua ali pra ser desligado)
  const pileCounts = useMemo(() => { const c = countBy(asked); return pileFilter && !c.some(([k]) => k === pileFilter) ? [...c, [pileFilter, 0] as [string, number]] : c }, [asked, pileFilter])
  const waitCounts = useMemo(() => countBy(waiting), [waiting])
  const pendingReview = auto ? auto.pending.filter(a => a.engine !== 'BUCKET' && (engineFilter === 'ALL' || a.engine === engineFilter)) : []
  const lastRun = auto?.runs && auto.runs.length ? auto.runs[0] : null
  const clean = engine ? (!!auto && !error && aConferir === 0) : (!!lines && !qLoading && !error && askTotal === 0)
  const headNum = error ? '!' : (!lines || qLoading) ? '…' : engine ? (aConferir === 0 ? '✓' : aConferir) : (askTotal === 0 ? '✓' : askTotal)

  // UMA LINHA DO BANCO (revisão DC 1.50.0): a mesma linha, com os mesmos botões, nas perguntas linha a linha, dentro de um
  // grupo QUEM É? («ver as linhas») e no «agir» de quem espera o AUTO-LINK.
  const lineRow = (l: Line) => {
    const par = l.candidates.filter(isPar)
    const others = l.candidates.filter(c => !isPar(c))
    const sel = pick[l.id] || ''
    // Sem escolha explícita o <select> MOSTRA o primeiro PAR — cand acompanha o que o olho vê.
    // Dinheiro sem candidato com nome: nada pré-selecionado — o <select> mostra o convite vazio e o MATCH espera a escolha.
    const cand = par.find(c => c.table + ':' + c.id === sel) || (par[0] && sayable(l, par[0]) ? par[0] : undefined)
    const dis = anyBusy
    const st = l.state
    const twins = l.doubt && l.doubt.kind === 'TWIN' && l.doubt.cands ? l.doubt.cands : []
    const twin = twins[0] || null
    // SIM só onde a pergunta é «é esta?» — QUASE tem diferença de valor e SEM REGRA é registro longe (revisão DC 1.50.0).
    const canSay = !!st && (st.code === 'É ESTA?' || st.code === 'DISPUTA')
    const tg = st && st.target ? st.target : null   // VAI CASAR: o registro que o AUTO-LINK vai casar na próxima rodada
    const sentence = !st ? '' : qError && st.pile === 'FORNECEDOR' ? `«${l.name}» — quem é pra nós? As perguntas por fornecedor não carregaram: resolva esta linha aqui (MATCH, TRANSFER, IGNORE ou EXPLAIN) ou recarregue.` : st.sentence
    return (
      <div key={l.id} className="py-3 px-2">
        <div className="flex items-baseline gap-3 flex-wrap">
          <button onClick={() => setInspect(s => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })} className="text-gray-500 hover:text-white text-xs w-4 shrink-0" title="conferir as fontes">{inspect.has(l.id) ? '▾' : '▸'}</button>
          <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(l.date)}</span>
          <span className="flex-1 truncate text-sm min-w-[10rem]" title={l.raw_name}>{l.name}{l.fee && <span className="ml-2 text-[10px] font-bold text-teal-300">TARIFA</span>}{l.source === 'STATEMENT' && <span className="ml-2 text-xs text-gray-600">extrato</span>}</span>
          <span className={`tabular-nums font-bold text-sm shrink-0 ${l.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{l.amount > 0 ? '−' : '+'}{usd(l.amount)}</span>
          {st && <span title={l.doubt?.reason || ''} className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${STATE_CHIP[st.code] || 'border-gray-700 text-gray-400'}`}>{st.code}</span>}
          {canSay && twins.length === 1 && twin && twin.exact !== false && sayable(l, twin) && <button disabled={dis} onClick={() => act(l, 'match', { table: twin.table, row_id: twin.id })} className="bg-amber-800 hover:bg-amber-700 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title={`casa com: ${twin.label}`}>SIM, É ESSA</button>}
          {canSay && twins.length > 1 && twins.slice(0, 3).filter(c => c.exact !== false && sayable(l, c)).map(c => <button key={c.table + c.id} disabled={dis} onClick={() => act(l, 'match', { table: c.table, row_id: c.id })} className="bg-amber-800 hover:bg-amber-700 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0 max-w-[16rem] truncate" title={`casa com: ${c.label}`}>É ESTA: {c.label.replace(/^[A-ZÇÃÉÍÓ ]+ · /, '').slice(0, 40)}</button>)}
          {twins.length > 1 ? <button disabled={dis} onClick={() => { if (confirm(`NENHUM destes ${twins.length} registros? A linha guarda a recusa de todos e o AUTO-LINK decide na hora sem eles (regra ou balde) — ou mostra a próxima dúvida.`)) act(l, 'reject_twin', { cands: twins.map(c => c.table + ':' + c.id) }) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-600 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title="nenhum destes — o AUTO-LINK segue sem eles">NENHUMA</button>
            : twin && <button disabled={dis} onClick={() => { if (confirm('NÃO é esse registro? A linha guarda a recusa e o AUTO-LINK decide na hora sem ele (regra ou balde) — ou mostra a próxima dúvida.')) act(l, 'reject_twin', { cand: twin.table + ':' + twin.id }) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-600 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title="não é esse — o AUTO-LINK segue sem ele">NÃO</button>}
          {tg && <button disabled={dis} onClick={() => { if (confirm(`NÃO é «${tg.label}»? A linha guarda a recusa: o AUTO-LINK não casa com esse registro e decide na hora sem ele (regra ou balde) — ou vira pergunta.`)) act(l, 'reject_twin', { cand: tg.table + ':' + tg.id }) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-600 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title={`o AUTO-LINK vai casar com: ${tg.label}`}>NÃO É ESSA</button>}
          {l.near && l.near[0] && !l.pending && <button disabled={dis} onClick={() => adjustMatch(l.id, l.date, Math.abs(l.amount), l.near![0])} className="bg-lime-800 hover:bg-lime-700 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title={`folha: ${l.near[0].label} · ${l.near[0].staff.join(', ')} · ${formatShortDate(l.near[0].date)} ${usd(l.near[0].amount)}${l.near[0].paid_from_mismatch ? ' · app diz ' + l.near[0].paid_from.join('/') : ''}${l.near[0].name_ok ? '' : ' · nome não confirmado'}`}>CASAR COM AJUSTE {dlt(l.near[0])}</button>}
          {l.near && l.near[0] && !l.pending && <button disabled={dis} onClick={() => { if (confirm('NÃO é essa passagem da folha? A linha guarda a recusa (todas as linhas do candidato) e o AUTO-LINK segue sem ela.')) act(l, 'reject_twin', { cands: l.near![0].ids.map(i => 'expenses:' + i) }) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-600 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold shrink-0" title="não é essa passagem da folha">NÃO (folha)</button>}
        </div>
        {st && <p className="text-xs text-gray-300 mt-1 ml-7 max-w-3xl">{sentence}</p>}
        {/* CONFERIR (UX #1, João 25/ago): as fontes dos dois lados, com link pro registro real. */}
        {inspect.has(l.id) && (
          <div className="mt-2 ml-7 grid md:grid-cols-2 gap-3 bg-black/40 border border-gray-800 rounded-2xl p-3 text-xs">
            <div>
              <p className="font-bold text-gray-400 mb-1">🏦 O QUE O BANCO DIZ</p>
              <p className="text-gray-300">{l.raw_name}</p>
              <p className="text-gray-500 mt-1">{formatShortDate(l.date)} · {l.amount > 0 ? 'saiu' : 'entrou'} {usd(l.amount)} · {l.source === 'STATEMENT' ? 'importada do extrato em PDF' : 'feed do Plaid'}</p>
            </div>
            <div>
              <p className="font-bold text-gray-400 mb-1">📒 O QUE O APP TEM {cand ? '' : l.money && par.length ? '(dinheiro: nenhum registro com o nome da linha do banco — nada vem marcado)' : '(nenhum registro com nome ou tipo de compra batendo)'}</p>
              {cand ? (
                <>
                  <p className="text-gray-300">{cand.detail || cand.label}</p>
                  <p className="text-gray-500 mt-1">{cand.date ? 'data ' + formatShortDate(cand.date) : 'sem data'}{cand.dd != null ? ` · ${cand.dd} dia(s) do banco` : ''} · {usd(cand.amount)}</p>
                  {cand.href && <a href={`${BASE_PATH}${cand.href}`} target="_blank" rel="noreferrer" className="inline-block mt-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded-xl font-bold">ABRIR REGISTRO ↗</a>}
                </>
              ) : <p className="text-gray-500">{l.money && par.length ? 'os registros de mesmo valor estão na lista abaixo, sem marca — escolha se for um deles' : others.length ? 'só outros com o mesmo valor, sem nome nem tipo de compra perto (abaixo, recolhidos)' : 'nada com esse valor no app'} — TRANSFER, IGNORE ou EXPLAIN</p>}
            </div>
          </div>
        )}
        <div className="mt-2 ml-7 flex gap-2 flex-wrap items-center">
          {par.length > 0 ? (
            <select value={sel} onChange={e => setPick({ ...pick, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && cand && !dis && !l.pending) { e.preventDefault(); act(l, 'match', { table: cand.table, row_id: cand.id }) } }} className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs max-w-xl">
              {l.money && !par.some(c => sayable(l, c)) && <option value="">— dinheiro: nenhum registro tem o nome da linha do banco — escolha se for um deles —</option>}
              {par.map(c => <option key={c.table + c.id} value={c.table + ':' + c.id}>{c.label} — {c.date ? formatShortDate(c.date) : 'sem data'}{c.dd != null ? ` (${c.dd}d)` : ''}{c.undated ? ' · sem data de pagamento' : ''}</option>)}
            </select>
          ) : <span className="text-xs text-gray-600">nenhum registro do app bate com o nome ou o tipo de compra</span>}
          <button disabled={!cand || dis || l.pending} onClick={() => cand && act(l, 'match', { table: cand.table, row_id: cand.id })} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">{busy.has(l.id) ? '…' : 'MATCH'}</button>
          <button disabled={dis} onClick={() => act(l, 'transfer')} className="bg-blue-800 hover:bg-blue-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">TRANSFER</button>
          <button disabled={dis} onClick={() => { if (confirm('Ignorar esta linha do banco?')) act(l, 'ignore') }} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">IGNORE</button>
          <input value={explain[l.id] || ''} onChange={e => setExplain({ ...explain, [l.id]: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && (explain[l.id] || '').trim() && !dis) { e.preventDefault(); act(l, 'explain', { note: explain[l.id] }) } }} placeholder="o que foi? (EXPLAIN)" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs w-56" />
          <button disabled={!(explain[l.id] || '').trim() || dis} onClick={() => act(l, 'explain', { note: explain[l.id] })} className="bg-fuchsia-800 hover:bg-fuchsia-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">EXPLAIN</button>
          {others.length > 0 && <button onClick={() => setCoins(s => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n })} className="text-[11px] text-gray-500 hover:text-gray-300 underline">{coins.has(l.id) ? 'esconder os outros com o mesmo valor' : `+${others.length} outro(s) com o mesmo valor`}</button>}
        </div>
        {coins.has(l.id) && others.length > 0 && (
          <div className="mt-1 ml-7 space-y-1">
            {others.map(c => (
              <div key={c.table + c.id} className="flex items-center gap-2 text-[11px] text-gray-500 flex-wrap">
                <span className="truncate max-w-xl" title={c.detail || c.label}>{c.label}</span>
                <span>{c.date ? formatShortDate(c.date) : 'sem data'}{c.dd != null ? ` (${c.dd}d)` : ''}</span>
                <span className="text-gray-600">{c.tier === 'LONGE' ? 'mesmo valor e nome, mas longe no tempo — provavelmente outra compra' : 'só o valor bate — nem o nome nem o tipo de compra'}</span>
                <button disabled={dis} onClick={() => { if (confirm(`Casar com «${c.label}» mesmo assim? ${c.tier === 'LONGE' ? 'O nome bate, mas a data está longe.' : 'Nem o nome nem o tipo de compra batem — só o valor.'} Tem certeza?`)) act(l, 'match', { table: c.table, row_id: c.id }) }} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-2 py-0.5 rounded-xl font-bold">CASAR MESMO ASSIM</button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`border rounded-2xl overflow-hidden ${clean ? 'border-emerald-900/60' : error ? 'border-red-900' : 'border-gray-700'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-5 py-4 bg-gray-900 hover:bg-gray-800 flex items-center gap-4">
        <span className={`text-2xl font-bold tabular-nums w-14 shrink-0 ${error ? 'text-red-400' : clean ? 'text-emerald-400' : 'text-amber-300'}`}>{headNum}</span>
        <span className="flex-1">
          <span className="font-bold block">{engine ? 'AUTO-LINK — o motor do Bank Link' : 'CONCILIAÇÃO BANCÁRIA — o que o AUTO-LINK não resolve sozinho'}</span>
          <span className="text-xs text-gray-500">{error ? `erro: ${error}` : !lines ? 'carregando o banco…' : qLoading ? 'carregando as perguntas por fornecedor…' : engine
            ? `${lastRun ? 'última rodada ' + runLabel(lastRun.trigger, lastRun.started_at) + ' · ' + lastRun.status : 'nenhuma rodada registrada'} · ${aConferir} casada(s) a conferir · plano, regras e apelidos dentro`
            : `${asked.length} linha(s) perguntando · ${qError ? 'as perguntas por fornecedor não carregaram (as linhas estão na lista)' : supplierGroups + ' fornecedor(es) sem resposta'} · ${waiting.length} esperando o AUTO-LINK (não conta) · ${totalNew} sem dono no total`}</span>
        </span>
        <span className="text-gray-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-5 py-4 border-t border-gray-800 space-y-5">
          {error && <p className="text-red-400">{error} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}

          {engine ? (
            <>
              <p className="text-sm text-gray-400 max-w-3xl">O <b>AUTO-LINK</b> liga cada linha da Regions ao registro do app que já existe (tarifa, exato, nome, série) e lança por falta o que nunca manda e-mail (tarifa, combustível, balcão, regra). O que ele não resolve vira pergunta no Data Checker. <a href={`${BASE_PATH}/adm/check`} className="underline">Perguntas: Data Checker → CONCILIAÇÃO BANCÁRIA ↗</a></p>

              {/* ── AUTO-LINK: rodada, plano, aplicar ── */}
              <div className="bg-gray-950/60 border border-gray-800 rounded-2xl p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[16rem]">
                    <p className="font-bold">AUTO-LINK <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold border border-purple-700 bg-purple-950 text-purple-300" title="O AUTO-LINK é o motor do Bank Link">BANK LINK {BL_STAGE} · v{BL_VERSION}</span> <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold border border-teal-800 bg-teal-950 text-teal-300">FEE</span> <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-800 bg-emerald-950 text-emerald-300">EXACT</span></p>
                    <p className="text-xs text-gray-500 mt-1">FEE: tarifa da Regions vira custo fixo «Regions Bank» e casa. EXACT: centavos iguais + único + ≤3 dias + nome. NAME: ambíguo desempatado por apelido. SET: série igual dos dois lados. RULE/LEARN: regra (humana/aprendida) CRIA o lançamento ou ADOTA a agendada do mês. BUCKET: compra real sem dono vai pro balde A ATRIBUIR. TRANSFER: status por regra. Coincidência de centavos nunca segura o motor.</p>
                    {lastRun && (() => {
                      const r = lastRun; const c = r.counts || {}; const n = Object.values(c).reduce((s, v) => s + (v || 0), 0)
                      const stale = Date.now() - Date.parse(r.started_at) > 12 * 3600e3
                      const bad = stale || r.status === 'ERROR' || r.status === 'PARTIAL' || r.status === 'ABORTED'
                      return <p className={`text-xs mt-1 ${bad ? 'text-amber-300' : 'text-gray-400'}`}>AUTO-LINK · última rodada {runLabel(r.trigger, r.started_at)} · {r.status} · {n} registradas (FEE {(c.fee_create || 0) + (c.fee_match || 0)} · EXACT {c.exact || 0} · NAME {c.name || 0} · RULE {(c.rule_create || 0) + (c.rule_adopt || 0)} · LEARN {c.learn || 0} · TRANSFER {c.transfer || 0} · BUCKET {c.bucket || 0}) · {(r.errors || []).length} erros · {r.remaining ?? 0} restantes{stale ? ' · ⚠ mais de 12 h sem rodada' : ''}{(r.errors || []).length ? ' · ' + String(r.errors![0]).slice(0, 80) : ''}</p>
                    })()}
                    {learnMsg && <p className="text-xs mt-1 text-fuchsia-300 font-bold">memória de comerciante: {learnMsg}</p>}
                  </div>
                  {needsMigration ? (
                    /* Este aviso NÃO nomeia uma migration só (07/set/2026): `needs_migration` tem várias origens — o probe da v030,
                       o do bank_match_log, `doubtColumnMissing()` e qualquer erro que case com MIGRATION_RE. Instrução errada na
                       tela custa mais caro que aviso genérico. */
                    <p className="text-sm text-amber-300">O motor pediu uma <b>migration</b> e o card não sabe dizer qual daqui. Rode no SQL Editor a que estiver faltando, na raiz do projeto — <b>MIGRATION_bank_reconcile_v030.sql</b> (match_engine / match_batch / reviewed_at / backfill), <b>MIGRATION_auto_book_silence.sql</b> (doubt_answered) ou <b>MIGRATION_bank_match_log.sql</b>. O nome exato vem no campo <code>error</code> da resposta de <code>/api/bank/reconcile</code>.</p>
                  ) : (
                    <div className="flex gap-2 items-center">
                      {progress && <span className="text-xs text-emerald-300">{progress}</span>}
                      <button disabled={anyBusy} onClick={planRun} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-4 py-2 rounded-xl font-bold text-sm">{busy.has('plan') ? 'CALCULANDO…' : 'PLANEJAR'}</button>
                      {/* RESTAURAR DIÁRIO (31/ago): reencena o bank_match_log depois de um reset — idempotente, só age em linha NEW com registro no diário. */}
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
                    <p><b>{plan.total}</b> linhas casariam agora: <span className="text-teal-300">FEE {plan.fee_create + plan.fee_match}</span> ({plan.fee_create} tarifas a criar, {plan.fee_match} já lançadas) · <span className="text-emerald-300">EXACT {plan.exact}</span> · <span className="text-cyan-300">SET {plan.set || 0}</span> · <span className="text-gray-400">IGNORE {plan.ignore || 0}</span> · <span className="text-sky-300">NAME {plan.name || 0}</span> · <span className="text-purple-300">RULE {plan.rule_create || 0} a criar · {plan.rule_adopt || 0} agendadas a adotar</span> · <span className="text-fuchsia-300">LEARN {plan.learn || 0}</span> · <span className="text-blue-300">TRANSFER {plan.transfer || 0}</span> · <span className="text-amber-300">A ATRIBUIR {plan.bucket || 0}</span>{plan.total === 0 ? ' — nada certo o bastante; o resto é pergunta no Data Checker.' : ''}{plan.by_klass && Object.keys(plan.by_klass).length ? <span className="block text-xs text-gray-500 mt-1">balde por classe: {Object.entries(plan.by_klass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}</span> : null}{plan.seed ? <span className="block text-xs text-amber-300 mt-1">PADRÃO: {plan.seed}</span> : null}</p>
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
                {applied && <p className="mt-3 text-sm text-emerald-300">Aplicado: {applied.fee_create} tarifas criadas · {applied.fee_match} tarifas casadas · {applied.exact} exatos · {applied.name} por nome · {applied.rule_create} criados por regra · {applied.rule_adopt} agendadas adotadas · {applied.learn} por regra aprendida · {applied.transfer} transferências · {applied.bucket} no balde A ATRIBUIR.{applied.errors.length ? <span className="text-red-400"> Erros ({applied.errors.length}): {applied.errors.slice(0, 5).join(' | ')}{applied.errors.length > 5 ? ' …' : ''}</span> : ''}</p>}
              </div>

              {/* ── CASADAS A CONFERIR (ex-A CONFERIR): o que ainda pede OK — sem o balde, que tem a fila própria nesta tela ── */}
              {auto && (aConferir > 0 || auto.batches.length > 0) && (
                <div className="border border-gray-800 rounded-2xl p-4">
                  <div className="flex items-center gap-3 flex-wrap mb-3">
                    <p className="font-bold flex-1">CASADAS A CONFERIR <span className="text-amber-300">{aConferir}</span> <span className="text-xs text-gray-500 font-normal">· {auto.reviewed} já conferidas · casamento do motor nasce visto (o da rodada automática tem DESFAZER por 7 dias no card verde do Data Checker; o de APLICAR, da resposta em QUEM É? e do NÃO É ESSE, e o de mais de 7 dias, só DESFAZER LOTE); aqui fica o casado com ajuste (ADJUST) e o antigo ainda sem OK — casamento feito à mão (MATCH) nasce visto e não aparece aqui</span></p>
                    <div className="flex gap-1">
                      {(['ALL', 'FEE', 'EXACT', 'NAME', 'RULE', 'LEARN', 'ADJUST', 'SET'] as const).map(k => <button key={k} onClick={() => setEngineFilter(k)} className={`px-3 py-1 rounded-xl text-xs font-bold border ${engineFilter === k ? 'bg-gray-700 border-gray-500' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`}>{k === 'ALL' ? 'TODAS' : k}</button>)}
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
                  {pendingReview.length === 0 ? <p className={aConferir ? 'text-gray-500 text-sm' : 'text-emerald-400 text-sm font-bold'}>{aConferir ? 'Nada com esse filtro.' : 'Tudo conferido.'}</p> : (
                    <div className="divide-y divide-gray-800">
                      {pendingReview.slice(0, 150).map(a => (
                        <div key={a.id} className="py-2 flex items-center gap-3 flex-wrap">
                          <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(a.date)}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${ENGINE_CHIP[a.status === 'TRANSFER' ? 'TRANSFER' : a.status === 'IGNORED' ? 'IGNORED' : a.engine] || 'border-gray-700 text-gray-400'}`}>{a.status === 'TRANSFER' ? 'TRANSFER' : a.status === 'IGNORED' ? 'IGNORADA' : a.engine}</span>
                          <span className="text-sm truncate max-w-[18rem]" title={a.raw_name || a.name}>{a.name}</span>
                          <span className={`tabular-nums font-bold text-sm shrink-0 ${a.amount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{a.amount > 0 ? '−' : '+'}{usd(a.amount)}</span>
                          <span className="text-xs text-gray-400 flex-1 truncate min-w-[12rem]" title={a.note}>⇄ {a.note}{a.engine === 'ADJUST' ? <span className="ml-2 text-[10px] text-lime-300" title="valor e pagador ajustados pelo banco — DESFAZER devolve tudo">ajustada pelo banco</span> : a.backfilled ? <span className="ml-2 text-[10px] text-sky-300" title="a data de pagamento do app foi preenchida com a do banco">data preenchida</span> : null}</span>
                          {a.href && <a href={`${BASE_PATH}${a.href}`} target="_blank" rel="noreferrer" title="abre o registro que o motor escolheu, em aba nova" className="bg-gray-800 hover:bg-gray-700 border border-gray-600 px-3 py-1 rounded-xl font-bold text-xs">ABRIR ↗</a>}
                          <button disabled={batchBusy || busy.has(a.id)} onClick={() => review(a)} className="bg-green-700 hover:bg-green-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">OK</button>
                          <button disabled={batchBusy || busy.has(a.id)} onClick={() => undoLine(a)} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">DESFAZER</button>
                        </div>
                      ))}
                      {pendingReview.length > 150 && <p className="text-xs text-gray-500 pt-2">mostrando 150 de {pendingReview.length} — confira e recarregue</p>}
                    </div>
                  )}
                </div>
              )}

              {/* ── REGRAS & APELIDOS DO AUTO-LINK (BL 0.7.0) — semeadura humana ── */}
              <details className="border border-gray-800 rounded-2xl p-4" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadMgr() }}>
                <summary className="cursor-pointer font-bold text-sm">⚙ REGRAS & APELIDOS DO AUTO-LINK <span className="text-gray-500 font-normal">— PADRÃO semeado pelo app (desligou, nunca volta) · humana manda · aprendida do MATCH</span></summary>
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
            </>
          ) : (
            <>
              <p className="text-sm text-gray-400 max-w-3xl">Cada linha da Regions precisa de um dono no app. O <b>AUTO-LINK</b> (o motor do Bank Link) liga sozinho o que tem prova e lança por falta o que nunca manda e-mail; aqui fica só o que ele <b>não</b> resolve, e cada linha diz por quê numa frase. <a href={`${BASE_PATH}/adm/bank`} className="underline">Motor, regras e rodadas: AUTO-LINK no Bank Link ↗</a></p>
              {needsMigration && <p className="text-sm text-amber-300">O AUTO-LINK pediu uma migration — o aviso completo está no painel dele, no Bank Link.</p>}
              {learnMsg && <p className="text-xs text-fuchsia-300 font-bold">memória de comerciante: {learnMsg}</p>}

              {/* ── QUEM É? — PERGUNTAS POR FORNECEDOR (BL 0.10.0, lei do João de 4/set: silêncio é promessa de que está tudo
                  certo; o que o motor não resolve vira PERGUNTA com motivo — por FORNECEDOR, respondida uma vez) ── */}
              {questions && (questions.suppliers.length > 0 || questions.money.length > 0) && (
                <div id="perguntas" className="border border-purple-900/60 rounded-2xl p-4 scroll-mt-24">
                  <button onClick={() => setQOpen(o => !o)} className="w-full text-left font-bold">QUEM É? — PERGUNTAS POR FORNECEDOR <span className="text-purple-300">{questions.suppliers.length}</span> <span className="text-xs text-gray-500 font-normal">· {questions.suppliers.reduce((a, g) => a + g.n, 0)} linhas · {usd(questions.suppliers.reduce((a, g) => a + g.total, 0))} · uma resposta por fornecedor vira regra pra sempre</span> <span className="text-gray-500 ml-2">{qOpen ? '▴' : '▾'}</span></button>
                  {qOpen && questions.link_migration && <p className="text-amber-300 text-xs mt-2">Rode <b>MIGRATION_expenses_bank_link.sql</b> no SQL Editor — CASAR COM AJUSTE precisa do elo da folha (expenses.bank_transaction_id).</p>}
                  {qOpen && (
                    <div className="divide-y divide-gray-800 mt-2">
                      {questions.suppliers.length === 0 && <p className="text-emerald-400 text-sm font-bold py-2">Nenhuma pergunta por fornecedor — todo fornecedor tem resposta.</p>}
                      {questions.suppliers.map(g => {
                        const pk: QPick = qPick[g.key] || { target: g.suggested.supplier_id ? 'FIXED' : '', supplier_id: g.suggested.supplier_id || '', category: 'CONSUMPTION', season_id: '', company: '', cost_type: 'FIXED' }
                        const set = (patch: Partial<QPick>) => setQPick(m => ({ ...m, [g.key]: { ...pk, ...patch } }))
                        const ready = !!pk.target && !(pk.target === 'FIXED' && (!pk.supplier_id || (pk.supplier_id === '__new__' && !pk.company.trim()))) && !(pk.target === 'PERSONAL' && !pk.season_id)
                        return (
                          <div key={g.key} className="py-2 flex items-center gap-3 flex-wrap">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-purple-800 bg-purple-950 text-purple-300 shrink-0">{g.klass}</span>
                            <span className="min-w-[11rem] max-w-[16rem]"><span className="block font-bold truncate" title={g.name}>{g.name}</span><span className="block text-[10px] text-gray-500 truncate" title={g.sample.join(' · ')}>{g.sample[0]}</span></span>
                            <span className="text-xs text-gray-400 shrink-0">{g.n}× · {usd(g.total)} · {formatShortDate(g.oldest)}–{formatShortDate(g.newest)}</span>
                            {g.suggested.company && <span className="text-[10px] text-emerald-300 shrink-0" title="prestador vivo cujo nome bate">sugere {g.suggested.company}</span>}
                            {g.suggested.ambiguous.length > 0 && <span className="text-[10px] text-amber-300 shrink-0" title={g.suggested.ambiguous.map(a => a.company).join(' | ')}>{g.suggested.ambiguous.length} prestadores batem — escolha</span>}
                            {g.near && g.near.length > 0 && <span className="text-[10px] text-lime-300 shrink-0" title="a folha já tem estas compras com deriva — CASAR COM AJUSTE abaixo; a regra deixa essas de fora">{g.near.length} de {g.n} já na folha — case com ajuste</span>}
                            {g.near_error && <span className="text-[10px] text-amber-300 shrink-0" title={g.near_error}>folha não carregou — RESPONDER travado até recarregar</span>}
                            {g.app_rows && g.app_rows.length > 0 && !(g.near && g.near.length) && <span className="text-[10px] text-gray-500 shrink-0" title={g.app_rows.map(r => r.date + ' ' + usd(r.amount) + ' ' + r.staff).join(' | ')}>folha tem {g.app_rows.length} deste fornecedor (sem par)</span>}
                            <select value={pk.target} onChange={e => set({ target: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs">
                              <option value="">— quem é pra nós? —</option>
                              <option value="FIXED">custo de um prestador</option>
                              <option value="SUPPLIES">insumo (supply)</option>
                              <option value="BUCKET">peça pra carro (balde)</option>
                              <option value="TRIP">viagem a trabalho</option>
                              <option value="PERSONAL">pessoal (season)</option>
                              <option value="IGNORE">não é nosso — ignorar</option>
                            </select>
                            {pk.target === 'FIXED' && (
                              <select value={pk.supplier_id} onChange={e => set({ supplier_id: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[16rem]">
                                <option value="">— prestador —</option>
                                {(questions.fixed_suppliers || []).map(x => <option key={x.id} value={x.id}>{x.company} · {x.cost_type}</option>)}
                                <option value="__new__">+ novo prestador</option>
                              </select>
                            )}
                            {pk.target === 'FIXED' && pk.supplier_id === '__new__' && (<>
                              <input value={pk.company} onChange={e => set({ company: e.target.value })} placeholder="nome do prestador" className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs w-44" />
                              <select value={pk.cost_type} onChange={e => set({ cost_type: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs">{['FIXED', 'APP', 'FLEET', 'STAFF', 'MARKETING', 'ASSET'].map(c => <option key={c} value={c}>{c}</option>)}</select>
                            </>)}
                            {pk.target === 'SUPPLIES' && <select value={pk.category} onChange={e => set({ category: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs">{INPUT_CATS.map(c => <option key={c} value={c}>{c}</option>)}</select>}
                            {pk.target === 'PERSONAL' && <select value={pk.season_id} onChange={e => set({ season_id: e.target.value })} className="bg-gray-900 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[16rem]"><option value="">— de quem? —</option>{(questions.seasons || []).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select>}
                            <button disabled={anyBusy || !!qBusy || !ready || !!g.near_error} onClick={() => answerSupplier(g, pk)} className="bg-purple-800 hover:bg-purple-700 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs">{qBusy === g.key ? '…' : 'RESPONDER'}</button>
                            <button onClick={() => setGrpOpen(s => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n })} className="text-[11px] text-gray-400 hover:text-white underline shrink-0" title="as linhas deste fornecedor, cada uma com MATCH, TRANSFER, IGNORE e EXPLAIN — pra resolver uma sem responder o grupo">{grpOpen.has(g.key) ? 'esconder as linhas' : `ver as ${g.n} linha(s)`}</button>
                            {g.near && g.near.length > 0 && (
                              <div className="basis-full mt-1 space-y-1 pl-2 border-l border-lime-900">
                                {g.near.map(n => { const c = n.cands[0]; return (
                                  <div key={n.line_id} className="flex items-center gap-2 text-xs flex-wrap">
                                    <span className="text-gray-300">{formatShortDate(n.date)} · {usd(n.amount)}</span>
                                    <span className="text-gray-500">≈</span>
                                    <span className="text-gray-300 truncate max-w-[24rem]" title={c.label}>{formatShortDate(c.date)} · {usd(c.amount)} · {c.staff.join(', ')}{c.paid_from_mismatch ? ' · app diz ' + c.paid_from.join('/') : ''}{c.name_ok ? '' : ' · nome não confirmado'}</span>
                                    <span className={c.exact ? 'text-emerald-300' : 'text-amber-300'}>Δ {dlt(c)}{c.exact ? '' : ' (' + c.pct + '%)'}</span>
                                    <button disabled={anyBusy || !!qBusy} onClick={() => adjustMatch(n.line_id, n.date, n.amount, c)} className="bg-lime-800 hover:bg-lime-700 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold">CASAR COM AJUSTE</button>
                                    {n.cands.length > 1 && <span className="text-[10px] text-gray-500" title={n.cands.slice(1).map(x => x.label + ' Δ ' + dlt(x)).join(' | ')}>+{n.cands.length - 1} outro(s)</span>}
                                  </div>) })}
                                {adjustPlan(g).go.length > 1 && <button disabled={anyBusy || !!qBusy} onClick={() => adjustAll(g)} className="bg-lime-900 hover:bg-lime-800 border border-lime-800 disabled:opacity-40 px-2 py-0.5 rounded-xl text-[10px] font-bold">CASAR TODAS ({adjustPlan(g).go.length})</button>}
                              </div>
                            )}
                            {grpOpen.has(g.key) && (() => {
                              const gl = g.line_ids.map(id => lineById.get(id)).filter((x): x is Line => !!x)
                              return (
                                <div className="basis-full mt-1 pl-2 border-l border-purple-900 divide-y divide-gray-800">
                                  {gl.map(l => lineRow(l))}
                                  {gl.length < g.line_ids.length && <p className="text-[11px] text-gray-500 py-1">{g.line_ids.length - gl.length} linha(s) não vieram na lista (já decididas ou além do limite) — recarregue</p>}
                                </div>
                              )
                            })()}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── PERGUNTAS LINHA A LINHA: um estado e uma frase por linha; só candidato PAR vira sugestão ── */}
              <div>
                <p className="font-bold text-sm mb-2">PERGUNTAS LINHA A LINHA <span className="text-amber-300">{asked.length}</span> <span className="text-xs text-gray-500 font-normal">· cada uma diz por que o AUTO-LINK parou; sugestão só quando o nome ou o tipo de compra batem (dinheiro — wire, Zelle, depósito: só o nome) — coincidência de valor fica recolhida</span></p>
                <div className="flex gap-2 flex-wrap items-center mb-3">
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar por nome, valor ou data" className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm w-64" />
                  {pileCounts.map(([k, v]) => <button key={k} onClick={() => setPileFilter(pileFilter === k ? null : k)} className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${pileFilter === k ? 'bg-white text-black border-white' : (STATE_CHIP[k] || 'bg-gray-900 border-gray-700 text-gray-300')}`}>{k} ×{v}</button>)}
                  <button onClick={load} disabled={anyBusy} className="bg-gray-900 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-xl font-bold text-xs">↻</button>
                  <span className="text-xs text-gray-500 ml-auto">{visible.length} linha(s){visible.length > shown ? ` · mostrando ${shown}` : ''}</span>
                </div>
                {/* TRIAGEM POR FAMÍLIA (João, 25/ago): o grosso das perguntas é cartão do dia a dia — decide-se por família, não um a um. */}
                {(asked.length > 0 || familyFilter) && (() => {
                  const fams = new Map<string, { n: number; sum: number }>()
                  for (const l of asked) { if (l.pending || l.fee) continue; const f = famOf(l); if (!f) continue; const e = fams.get(f) || { n: 0, sum: 0 }; e.n++; e.sum += Math.abs(l.amount); fams.set(f, e) }
                  const top = [...fams.entries()].filter(([, e]) => e.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 14)
                  if (familyFilter && !top.some(([f]) => f === familyFilter)) top.push([familyFilter, fams.get(familyFilter) || { n: 0, sum: 0 }])   // filtro ativo nunca some
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
                          <span className="text-xs text-gray-500">não é ignorar: é &quot;sei o que foi — lanço depois&quot;, com a nota gravada</span>
                        </div>
                      )}
                    </div>
                  )
                })()}
                {!lines ? <p className="text-gray-500">Carregando o banco…</p> : visible.length === 0 ? <p className={error ? 'text-gray-500' : 'text-emerald-400 font-bold'}>{error ? 'Sem dados.' : asked.length ? 'Nada com esse filtro.' : 'Nenhuma pergunta linha a linha — o AUTO-LINK cuida do resto.'}</p> : (
                  <div className="divide-y divide-gray-800">
                    {visible.slice(0, shown).map(l => lineRow(l))}
                    {visible.length > shown && <button onClick={() => setShown(s => s + 100)} className="mt-3 w-full bg-gray-800 hover:bg-gray-700 border border-gray-700 px-4 py-2 rounded-xl font-bold text-sm">MOSTRAR MAIS ({visible.length - shown} restantes)</button>}
                  </div>
                )}
              </div>

              {/* ── ESPERANDO O AUTO-LINK: não precisa de gente, mas aparece com a frase (silêncio é promessa) ── */}
              <div className="border border-gray-800 rounded-2xl p-4">
                <button onClick={() => setWaitOpen(o => !o)} className="w-full text-left font-bold text-sm">ESPERANDO O AUTO-LINK <span className="text-gray-400">{waiting.length}</span> <span className="text-xs text-gray-500 font-normal">· não conta como pendência: {waitCounts.map(([k, v]) => `${k} ${v}`).join(' · ') || 'nada'}</span> <span className="text-gray-500 ml-2">{waitOpen ? '▴' : '▾'}</span></button>
                {waitOpen && (
                  <div className="divide-y divide-gray-900 mt-2 max-h-[32rem] overflow-y-auto">
                    {waiting.slice(0, 300).map(l => waitAct.has(l.id) ? (
                      <div key={l.id} className="bg-black/20">
                        {lineRow(l)}
                        <button onClick={() => setWaitAct(s => { const n = new Set(s); n.delete(l.id); return n })} className="text-[11px] text-gray-500 hover:text-white underline ml-9 mb-2">fechar</button>
                      </div>
                    ) : (
                      <div key={l.id} className="py-2 px-1">
                        <div className="flex items-baseline gap-3">
                          <span className="text-gray-500 text-xs w-20 shrink-0">{formatShortDate(l.date)}</span>
                          <span className="flex-1 truncate text-sm text-gray-300" title={l.raw_name}>{l.name}</span>
                          <span className={`tabular-nums text-sm shrink-0 ${l.amount > 0 ? 'text-red-300' : 'text-emerald-300'}`}>{l.amount > 0 ? '−' : '+'}{usd(l.amount)}</span>
                          {l.state && <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${STATE_CHIP[l.state.code] || 'border-gray-700 text-gray-400'}`}>{l.state.code}</span>}
                          {!l.pending && <button onClick={() => setWaitAct(s => new Set(s).add(l.id))} className="text-[11px] text-gray-400 hover:text-white underline shrink-0" title="agir antes do AUTO-LINK: MATCH, TRANSFER, IGNORE, EXPLAIN — e NÃO É ESSA pro casamento previsto">agir ▸</button>}
                        </div>
                        {l.state && <p className="text-xs text-gray-500 mt-0.5 ml-[5.75rem]">{l.state.sentence}</p>}
                      </div>
                    ))}
                    {waiting.length > 300 && <p className="text-xs text-gray-500 pt-2">mostrando 300 de {waiting.length}</p>}
                  </div>
                )}
              </div>

              {/* ── TO BOOK (João, 31/ago): só a fila da triagem, com nota ── */}
              <div className="border border-gray-800 rounded-2xl p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={async () => { const v = !tobookOpen; setTobookOpen(v); if (v && tobook == null) await loadTobook() }} className="bg-amber-900 hover:bg-amber-800 border border-amber-700 px-4 py-2 rounded-xl font-bold text-sm">
                    TO BOOK{tobook != null ? ` (${tobook.length})` : ''} {tobookOpen ? '▴' : '▾'}
                  </button>
                  <span className="text-xs text-gray-500">linhas marcadas na TRIAGEM como &quot;a lançar&quot; — lance no app e o AUTO-LINK casa na próxima rodada; com mais de 14 dias desde a marcação viram pergunta (e a que já tem registro parecido no app pergunta por ele)</span>
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
