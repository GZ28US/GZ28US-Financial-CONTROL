'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { supabaseBR } from '@/lib/supabaseBR'
import { BASE_PATH, isBaselineName } from '@/lib/utils'

// O placar da casa: quem é o carro mais forte que já passou por aqui, US e BR na
// mesma tabela. As outras provas (arrancada, retomada) ainda não têm registro
// nenhum no app — as abas existem para não parecer que a página está incompleta.
const TABS = ['DYNO', '1/4 MILE', '1/8 MILE', '100-200'] as const
type Tab = typeof TABS[number]

// FILTRO PELO DONO DO CARRO, NÃO PELO DINAMÔMETRO. `dyno_pulls.origin` diz onde a
// passada foi MEDIDA — o Alcatraz é US.015 e foi medido na ArteCarros, origin 'BR'.
// Quem manda aqui é o prefixo do project_code, que é a identidade do carro.
const SCOPES = ['ALL', 'US', 'BR'] as const
type Scope = typeof SCOPES[number]

const HP_TO_CV = 1.01387
const KGFM_TO_LBFT = 9.80665 / 1.3558179 // kgf·m → lb·ft
const SAE_TO_STD = 1.04

function numOrNull(v: string): number | null { const n = parseFloat(v); return isFinite(n) ? n : null }
function r2(x: number) { return Math.round(x * 100) / 100 }

// ── A MESMA CONTA DA TELA DO RIDE ────────────────────────────────────────────
// computeDyno / toLocalDialect / calcFromPull são cópias literais do que a tela de
// passadas do ride roda (app/rides/[id]/performance/[build]/page.tsx, e a gêmea no
// app do BR). Elas vivem em escopo de módulo dentro daquele arquivo 'use client' e
// não são exportadas — então aqui se replica a CHAMADA, não a fórmula: nenhum
// número deste ranking pode discordar do número que aparece na página do carro.
type DynoCalc = {
  loss: number
  sae: number
  net: { whp: number | null; wkgfm: number | null; hp: number | null; kgf: number | null }
  corr: { whp: number | null; wkgfm: number | null; hp: number | null; cv: number | null; kgfm: number | null }
}
function computeDyno(whpS: string, wkgfmS: string, lossS: string, corrS: string): DynoCalc {
  const W = numOrNull(whpS)
  const K = numOrNull(wkgfmS)
  const L = lossS === '' ? 0 : (numOrNull(lossS) ?? 0)
  const C = corrS === '' ? 1 : (numOrNull(corrS) ?? 1)
  const denom = 1 - L / 100
  const ok = denom > 0
  const netHp = (W != null && ok) ? r2(W / denom) : null
  const netKgf = (K != null && ok) ? r2(K / denom) : null
  const cWhp = W != null ? r2(W * C) : null
  const cWkgfm = K != null ? r2(K * C) : null
  const cHp = (cWhp != null && ok) ? r2(cWhp / denom) : null
  const cCv = cHp != null ? r2(cHp * HP_TO_CV) : null
  const cKgfm = (cWkgfm != null && ok) ? r2(cWkgfm / denom) : null
  return {
    loss: L, sae: C,
    net: { whp: W != null ? r2(W) : null, wkgfm: K != null ? r2(K) : null, hp: netHp, kgf: netKgf },
    corr: { whp: cWhp, wkgfm: cWkgfm, hp: cHp, cv: cCv, kgfm: cKgfm },
  }
}

type DynoPull = {
  id: string; ride_code: string | null; pack: string | null
  whp: number | null; wnm: number | null; loss_pct: number | null
  correction_factor: number | null; bhp: number | null; bnm: number | null
  pull_date: string | null; dyno: string | null; origin: string | null
}

// PADRÃO STD (Márcio, 28/ago/2026): a casa fala STD nos dois apps. O banco, porém,
// guarda coisas diferentes conforme quem gravou:
//   origem US → whp já CORRIGIDO, fator impresso na folha já em STD
//   origem BR → whp CRU, fator em SAE (é o que a folha da Servitec imprime)
// Para os dois caírem na mesma régua: o US volta ao cru (÷ fator) e mantém o fator;
// o BR mantém o cru e converte o fator, SAE × 1,04 = STD. Daí o corrigido de ambos
// sai da mesma conta lá em computeDyno (cru × fator ÷ perda).
// Torque: o US grava lb·ft e esta tabela mostra kgf·m — conversão de UNIDADE,
// independente do padrão de correção.
// Sem fator gravado não dá para separar cru de corrigido: a linha fica como está,
// em vez de receber número inventado (é o caso das folhas do DynoJet daqui).
function toLocalDialect(p: DynoPull): DynoPull {
  const r4 = (x: number) => Math.round(x * 10000) / 10000
  const cf = p.correction_factor && p.correction_factor > 0 ? p.correction_factor : null

  if (p.origin === 'US') {
    const un = (v: number) => cf ? v / cf : v
    return {
      ...p,
      whp: p.whp != null ? r2(un(p.whp)) : null,
      wnm: p.wnm != null ? r2(un(p.wnm) / KGFM_TO_LBFT) : null,
      bhp: p.bhp != null ? r2(un(p.bhp)) : null,
      bnm: p.bnm != null ? r2(un(p.bnm) / KGFM_TO_LBFT) : null,
      correction_factor: cf,
    }
  }

  if (!cf) return p
  return { ...p, correction_factor: r4(cf * SAE_TO_STD) }
}

function calcFromPull(p: DynoPull): DynoCalc {
  return computeDyno(
    p.whp != null ? String(p.whp) : '',
    p.wnm != null ? String(p.wnm) : '',
    p.loss_pct != null ? String(p.loss_pct) : '',
    p.correction_factor != null ? String(p.correction_factor) : '',
  )
}

const fp = (x: number | null) => (x == null ? '—' : x.toFixed(1)) // power
const ft = (x: number | null) => (x == null ? '—' : x.toFixed(2)) // torque

function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Uma linha por CARRO: a melhor passada dele. `rideId` só existe para carro US —
// o ride do carro BR mora no banco do BR e não tem página neste app (ver load()).
type Entry = { code: string; name: string; rideId: string | null; pull: DynoPull; calc: DynoCalc }

export default function PerformancePage() {
  const [tab, setTab] = useState<Tab>('DYNO')
  const [scope, setScope] = useState<Scope>('ALL')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  // LEITURA QUE FALHA NÃO É LISTA VAZIA. supabase-js não estoura em erro de HTTP:
  // RLS, sessão-ponte caída ou rede ruim devolvem { data: null, error }, e sem
  // isto a tela afirmaria "nenhuma passada registrada" — mentira com cara de fato.
  const [err, setErr] = useState<string | null>(null)
  const [namesWarn, setNamesWarn] = useState(false)
  const [totalPulls, setTotalPulls] = useState(0)

  async function load() {
    try {
      setErr(null)
      setNamesWarn(false)
      // dyno_pulls mora SÓ no banco do US — as passadas dos carros BR estão aqui também.
      const { data: raw, error } = await supabase
        .from('dyno_pulls')
        .select('id, ride_code, pack, whp, wnm, loss_pct, correction_factor, bhp, bnm, pull_date, dyno, origin')
      if (error) throw new Error(error.message)
      setTotalPulls((raw || []).length)

      // A linha de base não é conquista: BoneStock/Stock/Prediction dizem de onde o
      // carro PARTIU, não onde ele chegou — fora do ranking.
      const pulls = ((raw || []) as DynoPull[])
        .filter((p) => p.ride_code && !isBaselineName(p.pack))
        .map(toLocalDialect)

      const codes = [...new Set(pulls.map((p) => String(p.ride_code)))]
      const usCodes = codes.filter((c) => c.startsWith('US.'))
      const brCodes = codes.filter((c) => c.startsWith('BR.'))

      // O apelido do carro exige os DOIS bancos: o app US só guarda rides US. Se a
      // ponte BR falhar (RLS devolve [] mudo), a linha ainda existe — mostra o código
      // sozinho, que é o que se sabe de verdade.
      const empty = { data: [] as { id: string; project_code: string; project_name: string | null }[], error: null as { message: string } | null }
      const [us, br] = await Promise.all([
        usCodes.length
          ? supabase.from('rides').select('id, project_code, project_name').in('project_code', usCodes)
          : Promise.resolve(empty),
        brCodes.length
          ? supabaseBR.from('rides').select('id, project_code, project_name').in('project_code', brCodes)
          : Promise.resolve(empty),
      ])
      if (us.error) throw new Error(us.error.message)
      // A ponte BR só traz APELIDO: se cair, o placar continua de pé com o código do
      // carro — mas a tela avisa, para ninguém achar que o carro perdeu o nome.
      const usRides = us.data
      const brRides = br.data
      if (br.error || (brCodes.length && !(br.data || []).length)) setNamesWarn(true)

      const names = new Map<string, string>()
      const usIds = new Map<string, string>()
      for (const r of (usRides || []) as { id: string; project_code: string; project_name: string | null }[]) {
        names.set(r.project_code, r.project_name || '')
        usIds.set(r.project_code, r.id)
      }
      for (const r of (brRides || []) as { id: string; project_code: string; project_name: string | null }[]) {
        names.set(r.project_code, r.project_name || '')
      }

      // A melhor passada do carro é a de maior hp de MOTOR CORRIGIDO — é o número que
      // a página do carro estampa e o que o mercado chama de bhp. whp premiaria quem
      // tem menos perda na transmissão, não quem tem mais motor.
      const best = new Map<string, Entry>()
      for (const p of pulls) {
        const code = String(p.ride_code)
        const calc = calcFromPull(p)
        if (calc.corr.hp == null) continue
        const cur = best.get(code)
        if (cur && (cur.calc.corr.hp ?? 0) >= calc.corr.hp) continue
        best.set(code, { code, name: names.get(code) || '', rideId: usIds.get(code) || null, pull: p, calc })
      }

      // Empate desempata pelo código, para a ordem não depender do que o Postgres
      // devolveu primeiro — placar tem de sair igual em toda visita.
      setEntries([...best.values()].sort((a, b) =>
        ((b.calc.corr.hp ?? 0) - (a.calc.corr.hp ?? 0)) || a.code.localeCompare(b.code)))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const shown = entries.filter((e) => scope === 'ALL' || e.code.startsWith(`${scope}.`))
  const countFor = (s: Scope) => entries.filter((e) => s === 'ALL' || e.code.startsWith(`${s}.`)).length
  const settled = !loading && !err
  const noCf = shown.filter((e) => e.pull.correction_factor == null).length

  // Pódio discreto: a posição ganha cor, a linha ganha um fundo de leve. Sem cor
  // gritante — a tabela tem 10 números por linha e eles é que têm de ser lidos.
  const podium = (i: number) =>
    i === 0 ? 'bg-amber-500/10 border-l-4 border-l-amber-400'
    : i === 1 ? 'bg-gray-400/10 border-l-4 border-l-gray-400'
    : i === 2 ? 'bg-orange-800/15 border-l-4 border-l-orange-700'
    : 'border-l-4 border-l-transparent'
  const posColor = (i: number) =>
    i === 0 ? 'text-amber-300' : i === 1 ? 'text-gray-300' : i === 2 ? 'text-orange-400' : 'text-gray-500'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h1 className="text-4xl font-bold">PERFORMANCE</h1>
      </div>

      {/* Abas das provas, mesmo chip das abas de performance do ride. */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            title={t === 'DYNO' ? undefined : 'No runs recorded in the app yet'}
            className={`px-5 py-3 rounded-2xl font-bold ${tab === t ? 'bg-white text-black' : `bg-gray-800 hover:bg-gray-700 text-gray-200${t === 'DYNO' ? '' : ' opacity-50'}`}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'DYNO' ? (
        <>
          <div className="flex items-center gap-2 mb-8 flex-wrap">
            {SCOPES.map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-4 py-2 rounded-full font-bold ${scope === s ? 'bg-purple-700' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                {s} <span className="opacity-60">{settled ? countFor(s) : '—'}</span>
              </button>
            ))}
            {/* Contador só depois de ler o banco: enquanto carrega, "0 cars" seria
                um resultado, e resultado nenhum foi apurado ainda. */}
            <span className="ml-2 text-lg text-gray-400">
              {settled ? `${shown.length} ${shown.length === 1 ? 'car' : 'cars'} · best pull of each` : 'reading the dyno bank…'}
            </span>
          </div>

          {loading ? (
            <p className="text-2xl text-gray-400">Loading...</p>
          ) : err ? (
            // Falha de leitura NÃO é lista vazia — e a tela tem de dizer qual dos dois é.
            <div className="bg-red-900/20 border border-red-700 rounded-3xl p-6">
              <p className="text-2xl font-bold text-red-300">Couldn&apos;t read the dyno bank.</p>
              <p className="text-lg text-gray-300 mt-2">This is NOT an empty list — the ranking is unknown right now.</p>
              <p className="text-sm text-gray-500 mt-2 break-all">{err}</p>
              <button onClick={() => { setLoading(true); load() }} className="mt-4 bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-2xl font-bold">TRY AGAIN</button>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-2xl text-gray-400">
              {entries.length === 0 && totalPulls > 0
                ? 'No ranked pull yet — every pull on file is a baseline (BoneStock / Stock), and a baseline is where the car started, not a result.'
                : `No dyno pull on file for ${scope === 'ALL' ? 'any car' : `${scope} cars`} yet — baselines (BoneStock / Stock) don't count as a result.`}
            </p>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 overflow-x-auto">
              <table className="w-full text-left whitespace-nowrap">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-700">
                    <th rowSpan={3} className="py-2 px-2 font-bold align-bottom">#</th>
                    <th rowSpan={3} className="py-2 px-2 font-bold align-bottom">CAR</th>
                    <th rowSpan={3} className="py-2 px-2 font-bold align-bottom">PACK</th>
                    <th colSpan={4} className="py-1 px-2 font-bold text-center text-red-300 bg-red-900/30 border-l border-gray-700">No Correction (net)</th>
                    <th colSpan={6} className="py-1 px-2 font-bold text-center text-blue-300 bg-blue-900/30 border-l border-gray-700">Corrected (STD standard)</th>
                    <th rowSpan={3} className="py-2 px-2 font-bold align-bottom border-l border-gray-700">DYNO</th>
                    <th rowSpan={3} className="py-2 px-2 font-bold align-bottom">DATE</th>
                  </tr>
                  <tr className="text-gray-400 text-xs border-b border-gray-700">
                    <th colSpan={2} className="py-1 px-2 text-center border-l border-gray-700">WHEELS</th>
                    <th colSpan={2} className="py-1 px-2 text-center">ENGINE</th>
                    <th rowSpan={2} className="py-1 px-2 text-center align-bottom border-l border-gray-700">STD</th>
                    <th colSpan={2} className="py-1 px-2 text-center">WHEELS</th>
                    <th colSpan={3} className="py-1 px-2 text-center">ENGINE</th>
                  </tr>
                  <tr className="text-gray-500 text-xs border-b border-gray-700">
                    <th className="py-1 px-2 border-l border-gray-700">whp</th>
                    <th className="py-1 px-2">wkgfm</th>
                    <th className="py-1 px-2">hp</th>
                    <th className="py-1 px-2">kgf</th>
                    <th className="py-1 px-2 border-l border-gray-700">whp</th>
                    <th className="py-1 px-2">wkgfm</th>
                    <th className="py-1 px-2">hp</th>
                    <th className="py-1 px-2">cv</th>
                    <th className="py-1 px-2">kgfm</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e, i) => {
                    const c = e.calc
                    // Carro BR não tem página de ride NESTE app (o ride mora no banco do
                    // BR): a linha existe no placar, mas não leva a lugar nenhum.
                    const clickable = !!e.rideId
                    // SEM FATOR NA FOLHA, METADE DA LINHA É DESCONHECIDA — e qual metade
                    // depende de quem gravou a passada:
                    //   US grava o número JÁ CORRIGIDO → o "sem correção" é que não se sabe
                    //   BR grava o número CRU          → o "corrigido" é que não se sabe
                    // Antes as duas metades repetiam o mesmo número e o fator saía 1.000,
                    // como se a folha declarasse ar padrão. Traço é a verdade; 1.000 não é.
                    const cfOff = e.pull.correction_factor == null
                    const netOff = cfOff && e.pull.origin === 'US'
                    const corrOff = cfOff && e.pull.origin !== 'US'
                    const whyNet = 'No correction factor on file — this sheet prints corrected power, so the net figure can\'t be recovered.'
                    const whyCorr = 'No correction factor on file — shown uncorrected.'
                    const dim = corrOff ? ' text-gray-500' : ''
                    return (
                      <tr
                        key={e.code}
                        onClick={() => { if (e.rideId) window.location.href = `${BASE_PATH}/rides/${e.rideId}` }}
                        className={`border-b border-gray-800 text-sm ${podium(i)} ${clickable ? 'cursor-pointer hover:bg-gray-800/60' : ''}`}
                      >
                        <td className={`py-3 px-2 text-2xl font-bold ${posColor(i)}`}>{i + 1}</td>
                        <td className="py-3 px-2">
                          <span className="font-bold text-base">{e.name || e.code}</span>
                          {e.name ? <span className="ml-2 text-xs text-gray-500">{e.code}</span> : null}
                          {e.pull.origin && !e.code.startsWith(`${e.pull.origin}.`) ? (
                            <span
                              className="ml-2 text-xs text-gray-500"
                              title={`Pull recorded on a ${e.pull.origin} dyno — the car itself is ${e.code.slice(0, 2)}`}
                            >
                              {e.pull.origin === 'BR' ? '🇧🇷' : '🇺🇸'}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-3 px-2 text-gray-300">{e.pull.pack || '—'}</td>
                        {/* Sem correção */}
                        <td title={netOff ? whyNet : undefined} className="py-3 px-2 border-l border-gray-800 font-bold text-red-300">{netOff ? '—' : fp(c.net.whp)}</td>
                        <td title={netOff ? whyNet : undefined} className="py-3 px-2 font-bold text-red-300">{netOff ? '—' : ft(c.net.wkgfm)}</td>
                        <td title={netOff ? whyNet : undefined} className="py-3 px-2 text-gray-300">{netOff ? '—' : fp(c.net.hp)}</td>
                        <td title={netOff ? whyNet : undefined} className="py-3 px-2 text-gray-300">{netOff ? '—' : ft(c.net.kgf)}</td>
                        {/* Corrigido (STD) */}
                        <td title={cfOff ? 'No correction factor on file.' : undefined} className="py-3 px-2 border-l border-gray-800 text-gray-400">{cfOff ? '—' : c.sae.toFixed(3)}</td>
                        <td title={corrOff ? whyCorr : undefined} className={`py-3 px-2${dim}`}>{fp(c.corr.whp)}</td>
                        <td title={corrOff ? whyCorr : undefined} className={`py-3 px-2${dim}`}>{ft(c.corr.wkgfm)}</td>
                        <td title={corrOff ? whyCorr : undefined} className={`py-3 px-2 font-bold ${corrOff ? 'text-gray-500' : 'text-gray-300'}`}>{fp(c.corr.hp)}</td>
                        <td title={corrOff ? whyCorr : undefined} className={`py-3 px-2 font-bold ${corrOff ? 'text-gray-500' : 'text-blue-300'}`}>{fp(c.corr.cv)}</td>
                        <td title={corrOff ? whyCorr : undefined} className={`py-3 px-2 font-bold ${corrOff ? 'text-gray-500' : 'text-blue-300'}`}>{ft(c.corr.kgfm)}</td>
                        <td className="py-3 px-2 border-l border-gray-800 text-gray-400">{e.pull.dyno || '—'}</td>
                        <td className="py-3 px-2 text-gray-400">{fmtDate(e.pull.pull_date)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-4">
                Ranked by corrected ENGINE hp (STD) — the same figure the car&apos;s own dyno table shows. Baselines are excluded.
              </p>
              {/* O placar não esconde o que não sabe: quantas linhas vieram de folha
                  sem fator declarado, e o que isso deixa em aberto. */}
              {noCf > 0 && (
                <p className="text-xs text-amber-400/80 mt-1">
                  {noCf} of these {noCf === 1 ? 'sheets carries' : 'sheets carry'} no correction factor on file — the dashes mark what can&apos;t be worked out from it.
                </p>
              )}
              {namesWarn && (
                <p className="text-xs text-amber-400/80 mt-1">
                  BR car names couldn&apos;t be read (cross-bank bridge) — those rows show the code only. The figures are unaffected.
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        // Prova sem registro nenhum: nem tabela, nem coluna, nem estimativa. Dizer isso
        // é mais honesto do que uma tabela vazia, que parece bug.
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
          <p className="text-2xl text-gray-400">
            {tab} runs aren&apos;t recorded in the app yet — there is no data to rank. Only dyno pulls are on file so far.
          </p>
        </div>
      )}
    </main>
  )
}
