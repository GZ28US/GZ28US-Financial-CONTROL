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

// ── O DIALETO DA CASA É O DO APP DO US ───────────────────────────────────────
// A tela de dyno do ride US fala UMA língua: potência corrigida STD, torque em lb·ft,
// UM número por célula. Ela não discute fator de correção com o cliente — a casa já
// assumiu STD, converte a folha estrangeira NA ENTRADA e imprime o resultado.
// A tela do BR é outro contrato: lá o cliente discute fator, então ela mostra as duas
// verdades lado a lado (o que a máquina mediu e o que a folha declara corrigido), com
// cv e kgf·m. Aquela tabela de 10 colunas é do app do BR e lá está certa.
// Este placar assina o contrato do US — são dois contratos, não duas formatações.
const KGFM_TO_LBFT = 9.80665 / 1.3558179 // kgf·m → lb·ft
const SAE_TO_STD = 1.04

type DynoPull = {
  id: string; ride_code: string | null; pack: string | null
  whp: number | null; wnm: number | null; loss_pct: number | null
  correction_factor: number | null; bhp: number | null; bnm: number | null
  pull_date: string | null; dyno: string | null; origin: string | null
  document_url: string | null
  // `foreign` NÃO vem do banco: é o carimbo que toLocalDialect põe na passada que ELE
  // converteu. É o único selo do dialeto do US que atravessa pra cá, e é um selo de
  // honestidade — diz que aquele número não é o que a folha imprimiu, é o que a
  // conversão fez com ele.
  foreign?: boolean
}

// CÓPIA DELIBERADA, palavra por palavra, da tela de dyno do ride US
// (app/rides/[id]/performance/[build]/page.tsx, linhas 57-72). O original vive em escopo
// de módulo de um arquivo 'use client' e não é exportado — então aqui se replica o CORPO,
// não se inventa fórmula. Só a assinatura foi re-tipada contra o DynoPull deste arquivo.
// Se um dia aquele arquivo mudar a conta, esta muda junto: no minuto em que as duas
// divergirem, o placar passa a mentir sobre a página do carro.
//
// O QUE ELA FAZ, e por quê:
//   origem US → passa direto, byte a byte. O que está gravado é o que a tela do carro
//               mostra, e é o que este placar mostra. Sem recálculo, sem palpite. Se o
//               bhp gravado divergisse de whp/(1−perda), a tela mostraria o GRAVADO — e
//               a lei manda o placar mostrar o mesmo, não "consertar" pelas costas.
//   origem BR → a folha da Servitec grava roda CRUA, torque em kgf·m e fator SAE. Sobe
//               pro corrigido STD (fator × 1,04), converte o torque pra lb·ft e RE-DERIVA
//               o motor a partir do número já convertido. Os bhp/bnm gravados da linha BR
//               são descartados de propósito: foram calculados na régua de lá.
//
// DUAS HERANÇAS ACEITAS DE OLHOS ABERTOS — corrigir AQUI e não lá faria o placar
// discordar da página do carro, que é exatamente o pecado que esta página existe pra
// não cometer. O conserto, se um dia for preciso, é nos dois arquivos:
//   · fator NULO em linha BR vira 1,04 — o app ASSUME folha SAE e sobe 4%. Isso é
//     suposição, não leitura. Hoje não dispara (as 24 linhas BR têm fator gravado), e o
//     rodapé denuncia na hora se um dia disparar.
//   · fator ZERO em linha BR zeraria a linha inteira e jogaria o carro pro último lugar
//     com 0.00. Hoje o menor fator do banco é 1,00 (BR.501).
function toLocalDialect(p: DynoPull): DynoPull {
  if (p.origin !== 'BR') return p
  const r2 = (x: number) => Math.round(x * 100) / 100
  const denom = p.loss_pct != null && p.loss_pct < 100 ? 1 - p.loss_pct / 100 : null
  const cf = (p.correction_factor ?? 1) * SAE_TO_STD
  const whp = p.whp != null ? r2(p.whp * cf) : null
  const wnm = p.wnm != null ? r2(p.wnm * cf * KGFM_TO_LBFT) : null
  return {
    ...p,
    whp, wnm,
    bhp: whp != null && denom != null ? r2(whp / denom) : null,
    bnm: wnm != null && denom != null ? r2(wnm / denom) : null,
    foreign: true,
  }
}

// O MESMO FORMATO DA CÉLULA DA TELA DO CARRO: duas casas e a unidade colada no número.
// O cabeçalho já declara a unidade e isso repete o sufixo 60 vezes — mas a tela do ride
// faz assim, e a lei aqui é concordar com ela, não economizar caractere.
const num = (x: number | null, unit: string) => (x == null ? '—' : `${x.toFixed(2)} ${unit}`)

function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Uma linha por CARRO: a melhor passada dele. `rideId` só existe para carro US —
// o ride do carro BR mora no banco do BR e não tem página neste app (ver load()).
type Entry = { code: string; name: string; rideId: string | null; pull: DynoPull }

export default function PerformancePage() {
  const [tab, setTab] = useState<Tab>('DYNO')
  // ABRE NA CASA (Márcio, 28/ago/2026: "a exibição padrão no US é só US e no BR só BR,
  // o usuário alterna os filtros se quiser"). O banco de passadas é um só e serve os dois
  // apps — mas quem entra aqui está na oficina de Orlando e quer ver a frota daqui
  // primeiro. ALL e BR continuam a um clique.
  const [scope, setScope] = useState<Scope>('US')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  // LEITURA QUE FALHA NÃO É LISTA VAZIA. supabase-js não estoura em erro de HTTP:
  // RLS, sessão-ponte caída ou rede ruim devolvem { data: null, error }, e sem
  // isto a tela afirmaria "nenhuma passada registrada" — mentira com cara de fato.
  const [err, setErr] = useState<string | null>(null)
  const [namesWarn, setNamesWarn] = useState(false)
  const [totalPulls, setTotalPulls] = useState(0)
  // CARRO NÃO SOME CALADO. No dialeto do US o bhp de uma passada BR vira null quando a
  // perda não está gravada (ou é >= 100%) — e num placar ordenado por bhp isso apagaria
  // o carro inteiro da tela sem uma palavra. Guardo aqui os códigos que TÊM passada
  // ranqueável e mesmo assim não deram número, pra o rodapé dizer quantos e por quê.
  const [unranked, setUnranked] = useState<string[]>([])

  async function load() {
    try {
      setErr(null)
      setNamesWarn(false)
      setUnranked([])
      // dyno_pulls mora SÓ no banco do US — as passadas dos carros BR estão aqui também.
      // loss_pct e correction_factor continuam no select mesmo sem coluna de fator na
      // tela: sem eles a passada BR não se converte. document_url é a FOLHA — a prova do
      // número, e a única saída pra quem quiser conferir uma linha sem fator declarado.
      const { data: raw, error } = await supabase
        .from('dyno_pulls')
        .select('id, ride_code, pack, whp, wnm, loss_pct, correction_factor, bhp, bnm, pull_date, dyno, origin, document_url')
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

      // A melhor passada do carro é a de maior BHP — hp de MOTOR, ordem do Márcio. É o
      // número que a página do carro estampa na coluna BHP, e é o que o mercado compara.
      // whp premiaria quem tem menos perda na transmissão, não quem tem mais motor.
      const best = new Map<string, Entry>()
      const withPulls = new Set<string>()
      for (const p of pulls) {
        const code = String(p.ride_code)
        withPulls.add(code)
        if (p.bhp == null) continue
        const cur = best.get(code)
        if (cur && (cur.pull.bhp ?? 0) >= p.bhp) continue
        best.set(code, { code, name: names.get(code) || '', rideId: usIds.get(code) || null, pull: p })
      }
      // O carro que tem passada e mesmo assim não deu bhp fica de fora da tabela — mas
      // não do conhecimento da página: o rodapé conta quantos são.
      setUnranked([...withPulls].filter((c) => !best.has(c)).sort())

      // Empate desempata pelo código, para a ordem não depender do que o Postgres
      // devolveu primeiro — placar tem de sair igual em toda visita.
      setEntries([...best.values()].sort((a, b) =>
        ((b.pull.bhp ?? 0) - (a.pull.bhp ?? 0)) || a.code.localeCompare(b.code)))
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
  // ── O QUE ESTA PÁGINA PODE E NÃO PODE AFIRMAR SOBRE CORREÇÃO ─────────────────
  // No dialeto do US não existe coluna de fator pra virar traço, nem metade "sem
  // correção" pra apagar. Então a ressalva migra pro TEXTO, e ela é diferente conforme
  // quem gravou a folha:
  //   · folha sem fator, origem US (as do DynoJet daqui — o scan ainda não lê o fator):
  //     o número é impresso exatamente como foi gravado. Ninguém sabe se aquela folha já
  //     saiu corrigida. A página NÃO carimba "STD" em cima disso.
  //   · folha sem fator, origem BR: pior — a conversão ASSUMIU SAE e somou 4%. Aí não é
  //     desconhecimento, é suposição declarada, e tem de ser dita com outras palavras.
  // Os dois contadores olham só o que está NA TELA (`shown`): rodapé que conta linha
  // fora do escopo está contando o que o leitor não pode ver.
  const noCf = shown.filter((e) => e.pull.correction_factor == null).length
  const assumedCf = shown.filter((e) => e.pull.correction_factor == null && e.pull.origin === 'BR').length
  const unrankedShown = unranked.filter((c) => scope === 'ALL' || c.startsWith(`${scope}.`))
  // Quantas linhas na tela não são leitura direta, e sim conversão feita aqui na entrada.
  const foreignShown = shown.filter((e) => e.pull.foreign).length

  // Pódio discreto: a posição ganha cor, a linha ganha um fundo de leve. Sem cor
  // gritante — os quatro números da linha é que têm de ser lidos.
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
              {settled
                ? `${shown.length} ${shown.length === 1 ? 'car' : 'cars'} · best pull of each`
                : err ? 'read failed' : 'reading the dyno bank…'}
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
            // TRÊS VAZIOS DIFERENTES, E ELES NÃO SIGNIFICAM A MESMA COISA. O pior é o
            // primeiro: RLS que filtra LINHA devolve HTTP 200 com [] e error nulo, então
            // a query "deu certo" e não veio nada. Dizer "nenhum carro correu" nesse caso
            // é a mentira mais fácil desta página — a tabela tem 47 linhas.
            <div className="text-2xl text-gray-400 space-y-2">
              {totalPulls === 0 ? (
                <>
                  <p className="text-amber-300 font-bold">The dyno bank came back with nothing at all.</p>
                  <p className="text-lg">That is either a genuinely empty table or a read that was silently filtered — it is NOT a statement that no car has ever run.</p>
                  <button onClick={() => { setLoading(true); load() }} className="mt-2 bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-2xl font-bold text-base">TRY AGAIN</button>
                </>
              ) : entries.length === 0 ? (
                <p>No ranked pull yet — every pull on file is a baseline (BoneStock / Stock), and a baseline is where the car started, not a result.</p>
              ) : (
                <p>No dyno pull on file for {scope === 'ALL' ? 'any car' : `${scope} cars`} yet — baselines (BoneStock / Stock) don&apos;t count as a result.</p>
              )}
              {unrankedShown.length > 0 && (
                <p className="text-base text-amber-400/80">
                  {unrankedShown.length} {unrankedShown.length === 1 ? 'car has a pull that' : 'cars have pulls that'} couldn&apos;t be ranked — no transmission loss on file, so engine hp can&apos;t be worked out ({unrankedShown.join(', ')}).
                </p>
              )}
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 overflow-x-auto">
              {/* AS COLUNAS SÃO AS DA TELA DE DYNO DO RIDE US, na ordem dela: PACK, WHP,
                  WTQ (lb·ft), BHP, BTQ (lb·ft), DATE, DYNO, DOC — inclusive DATE ANTES de
                  DYNO. Na frente entram as duas colunas que só o placar tem, porque só
                  aqui existe comparação entre carros: a posição e o CARRO. */}
              <table className="w-full text-left whitespace-nowrap">
                <thead>
                  <tr className="text-gray-400 text-sm border-b border-gray-700">
                    <th className="py-2 pr-4 font-bold">#</th>
                    <th className="py-2 pr-4 font-bold">CAR</th>
                    <th className="py-2 pr-4 font-bold">PACK</th>
                    <th className="py-2 pr-4 font-bold">WHP</th>
                    <th className="py-2 pr-4 font-bold">WTQ (lb·ft)</th>
                    <th className="py-2 pr-4 font-bold">BHP</th>
                    <th className="py-2 pr-4 font-bold">BTQ (lb·ft)</th>
                    <th className="py-2 pr-4 font-bold">DATE</th>
                    <th className="py-2 pr-4 font-bold">DYNO</th>
                    <th className="py-2 pr-4 font-bold">DOC</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e, i) => {
                    const p = e.pull
                    // Carro BR não tem página de ride NESTE app (o ride mora no banco do
                    // BR): a linha existe no placar, mas não leva a lugar nenhum.
                    const clickable = !!e.rideId
                    // O ASTERISCO É A ÚNICA RESSALVA QUE CABE NO DIALETO DO US. Sem coluna
                    // de fator, marcar a folha sem fator vira nota de rodapé clássica:
                    // sinal discreto no número RANQUEADO (o bhp, que é sobre o que o placar
                    // faz afirmação) + legenda embaixo. Não inventa coluna, não inventa
                    // número, e nunca imprime 1.000 como se fosse fator declarado.
                    const cfOff = p.correction_factor == null
                    const whyCf = cfOff && p.origin === 'BR'
                      ? 'No correction factor on this BR sheet — the conversion to STD assumed an SAE sheet (+4%). That is an assumption, not a reading.'
                      : 'No correction factor on file for this sheet — the figures are printed exactly as recorded. Whether the sheet already came out corrected is not known here. Open DOC to read it.'
                    return (
                      <tr
                        key={e.code}
                        onClick={() => { if (e.rideId) window.location.href = `${BASE_PATH}/rides/${e.rideId}` }}
                        className={`border-b border-gray-800 text-sm ${podium(i)} ${clickable ? 'cursor-pointer hover:bg-gray-800/60' : ''}`}
                      >
                        <td className={`py-3 pr-4 text-2xl font-bold ${posColor(i)}`}>{i + 1}</td>
                        <td className="py-3 pr-4">
                          <span className="font-bold text-base">{e.name || e.code}</span>
                          {e.name ? <span className="ml-2 text-xs text-gray-500">{e.code}</span> : null}
                        </td>
                        {/* O SELO 🇧🇷 BR vive na célula do PACK, igual à tela do carro, e diz
                            o que ela diz: este número foi CONVERTIDO, não é o que a folha
                            imprimiu. O selo antigo dizia outra coisa (onde a passada foi
                            medida) — isso a coluna DYNO já conta, e dois selos na mesma
                            célula só confundem qual dos dois fala do número. */}
                        <td className="py-3 pr-4 text-gray-300">
                          {p.pack || '—'}
                          {p.foreign ? <span className="ml-2 text-xs font-normal text-green-400" title="Recorded in the BR app — converted to STD / lb·ft">🇧🇷 BR</span> : null}
                        </td>
                        <td className="py-3 pr-4">{num(p.whp, 'whp')}</td>
                        <td className="py-3 pr-4">{num(p.wnm, 'lb·ft')}</td>
                        <td className="py-3 pr-4 font-bold">
                          {num(p.bhp, 'bhp')}
                          {cfOff ? <span className="ml-1 text-xs font-normal text-amber-400/80" title={whyCf}>*</span> : null}
                        </td>
                        <td className="py-3 pr-4">{num(p.bnm, 'lb·ft')}</td>
                        <td className="py-3 pr-4 text-gray-400">{fmtDate(p.pull_date)}</td>
                        <td className="py-3 pr-4">{p.dyno || '—'}</td>
                        {/* A FOLHA é a prova do número — e para as linhas sem fator declarado
                            é o único jeito de qualquer um conferir o que esta página não
                            pode afirmar. O clique no link não pode virar navegação pro ride:
                            a linha inteira é clicável. */}
                        <td className="py-3 pr-4">
                          {p.document_url
                            ? <a href={p.document_url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a>
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {/* A FRASE PERDEU O CARIMBO "(STD)" DE PROPÓSITO. Ela era a única afirmação
                  de correção que sobrava na página, e era falsa para toda linha vinda de
                  folha sem fator — as do DynoJet daqui. O que a página PODE afirmar é o
                  que ela de fato faz: ordena pelo BHP, o mesmo número que a tabela do
                  carro estampa. Quem corrigiu o quê, os avisos abaixo dizem. */}
              <p className="text-xs text-gray-500 mt-4">
                Ranked by ENGINE hp (BHP), in this app&apos;s dialect: corrected STD, torque in lb·ft. Baselines are excluded.
              </p>
              {/* A FRASE "O MESMO NÚMERO DA PÁGINA DO CARRO" SÓ VALE PRA CASA. Ela era
                  redonda demais: dos 15 carros, 9 são BR e não têm página de ride NESTE
                  app — a única tabela de dyno deles é a do app do BR, e lá o número é
                  outro (o BR.492 tem 1296,48 bhp gravado e aqui estampa 1348,33, +4%,
                  porque a régua de lá é SAE e a daqui é STD). Prometer identidade sobre
                  60% das linhas seria mentira; o selo 🇧🇷 e esta linha dizem a verdade. */}
              {foreignShown > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  A US car reads here exactly as on its own dyno page in this app. The {foreignShown} 🇧🇷 {foreignShown === 1 ? 'row was' : 'rows were'} recorded in the BR app and converted on the way in — that car reads differently over there, on the BR ruler.
                </p>
              )}
              {/* O placar não esconde o que não sabe: quantas linhas vieram de folha
                  sem fator declarado, e o que exatamente isso deixa em aberto.
                  Só entram aqui as que foram impressas COMO GRAVADAS — a linha BR sem
                  fator não é essa história, é a de baixo, e contá-la nas duas faria os
                  dois parágrafos se contradizerem. */}
              {noCf - assumedCf > 0 && (
                <p className="text-xs text-amber-400/80 mt-1">
                  * {noCf - assumedCf} of these {noCf - assumedCf === 1 ? 'sheets carries' : 'sheets carry'} no correction factor on file — printed exactly as recorded. Whether those sheets already came out corrected isn&apos;t known here; open DOC to read them.
                </p>
              )}
              {/* Caso diferente e pior: aqui a página não desconhece, ela SUPÕE. */}
              {assumedCf > 0 && (
                <p className="text-xs text-amber-400/80 mt-1">
                  {assumedCf} of {assumedCf === 1 ? 'those was' : 'those were'} recorded in the BR app with no factor either — converted assuming an SAE sheet (+4%). That is an assumption, not a reading.
                </p>
              )}
              {/* Carro que tem passada e não entrou: dito em voz alta, nunca sumido. */}
              {unrankedShown.length > 0 && (
                <p className="text-xs text-amber-400/80 mt-1">
                  {unrankedShown.length} {unrankedShown.length === 1 ? 'car has pulls' : 'cars have pulls'} on file but no engine figure could be worked out (no crank&nbsp;→&nbsp;wheel loss recorded), so {unrankedShown.length === 1 ? 'it is' : 'they are'} not ranked here: {unrankedShown.join(', ')}.
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
