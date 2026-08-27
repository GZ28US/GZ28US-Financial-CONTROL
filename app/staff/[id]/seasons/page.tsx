'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { formatUSD } from '@/lib/utils'
import { usdBrlSpot, usdOf } from '@/lib/fx'

type Season = {
  id: string
  season_code: string
  date_entry: string | null
  date_conclusion: string | null
  pay_type: string | null
  pay_rate: number | null
  pay_currency: string | null
  pay_day: number | null
  hours_per_day: number | null
  days_per_week: number | null
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// A taxa da season em uma linha legível. Ela sempre existiu no banco e nunca
// aparecia na tela (Márcio, 26/ago/2026) — dava para olhar a season inteira sem
// descobrir quanto a pessoa ganha.
// SEMPRE EM DÓLAR (Márcio, 26/ago/2026: "sempre mostrando tudo em USD"). Uma
// taxa em reais é a ÂNCORA do cálculo — o valor fixo do contrato — mas o que se
// lê na tela é o dólar do comercial de hoje, e ele muda todo dia. O R$ vai no
// tooltip, que é onde o número imutável continua consultável.
function payLabel(s: Season, spot: number | null): string | null {
  if (!s.pay_type || !s.pay_rate) return null
  const emReais = (s.pay_currency || 'USD') === 'BRL'
  const rate = Number(s.pay_rate)
  if (emReais && !(spot && spot > 0)) return null
  const usd = emReais ? rate / (spot as number) : rate
  const valor = `US$ ${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (s.pay_type === 'DAILY') return `${valor} a day`
  if (s.pay_type === 'WEEKLY') return `${valor} every ${WEEKDAY[s.pay_day ?? 5]}`
  return `${valor} on day ${s.pay_day ?? 'last'} of the month`
}

// O número que NÃO muda: o contrato, na moeda em que foi fechado.
function payAnchor(s: Season): string {
  if (!s.pay_rate) return ''
  const moeda = (s.pay_currency || 'USD') === 'BRL' ? 'R$' : 'US$'
  return `Anchored at ${moeda} ${Number(s.pay_rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type Expense = {
  id: string
  season_id: string
  type: string
  amount: number
  expense_date: string | null
  payment_date: string | null
  amount_brl: number | null
  created_at: string | null
}

type StaffMember = {
  id: string
  name: string
}

const hoje = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }

// Uma linha é PREVISÃO enquanto não foi paga E ainda está no futuro. Linha
// vencida e não paga NÃO é previsão: é dívida, e conta como custo real.
const ehPrevisao = (e: Expense) =>
  !e.payment_date && !!e.expense_date && new Date(e.expense_date + 'T00:00:00') > hoje()

// Total da season = SOMA DOS PAGAMENTOS REAIS (ordem do Márcio, 28/jul/2026).
// FUTURO FICA DE FORA (Márcio, 26/ago/2026: "como pode um cara que ganha
// R$ 15k/mês ter estes números?"). O robô da folha e o Future Flow gravam as
// mensalidades dos próximos 6 meses como linhas de expense; somá-las aqui
// fazia o ACTUAL de um mês virar meio ano de salário.
function calculateSeasonTotal(expenses: Expense[], season: Season, spot: number | null): number {
  return expenses
    .filter(e => e.season_id === season.id && !ehPrevisao(e))
    .reduce((sum, e) => sum + usdOf(e, spot), 0)
}

// O que ainda vai vencer — mostrado à parte, nunca somado ao realizado.
function seasonUpcoming(expenses: Expense[], season: Season, spot: number | null): number {
  return expenses
    .filter(e => e.season_id === season.id && ehPrevisao(e))
    .reduce((sum, e) => sum + usdOf(e, spot), 0)
}

// CUSTO DIÁRIO/SEMANAL/MENSAL.
//
// Quando a season TEM taxa, o custo sai da TAXA — é o número exato, e é o que
// o rótulo promete. Antes isto era (soma de todas as linhas ÷ dias corridos),
// que com o Future Flow ligado dividia 7 meses de salário futuro por 47 dias
// vividos: o Jeff, de R$ 15.000/mês, aparecia custando US$ 13.339,69/mês.
//
// Sem taxa cadastrada, cai no observado (o que saiu ÷ dias), que é o melhor
// que dá para dizer de uma season antiga.
//
// MOEDA (Márcio, 26/ago/2026): "se o membro tiver seu valor definido em R$,
// esta é a âncora... dinâmico até ser pago". A taxa é o exemplo puro de valor
// EM ABERTO — ela nunca foi paga, é uma recorrência. Então o dólar dela segue
// o câmbio COMERCIAL DE HOJE, e se move sozinho a cada abertura da tela.
// Sem cotação disponível, os números saem em R$ mesmo — nunca com câmbio velho
// disfarçado de atual.
function seasonCost(expenses: Expense[], season: Season, days: number, spot: number | null) {
  const rate = Number(season.pay_rate) || 0
  const moeda = season.pay_currency || 'USD'
  let mensal = 0
  if (rate > 0) {
    if (season.pay_type === 'MONTHLY') mensal = rate
    else if (season.pay_type === 'WEEKLY') mensal = rate * 52 / 12
    else if (season.pay_type === 'DAILY' && Number(season.days_per_week) > 0) mensal = rate * Number(season.days_per_week) * 52 / 12
  }
  if (mensal > 0) {
    let valor = mensal
    let cur = moeda
    if (moeda === 'BRL' && spot && spot > 0) { valor = mensal / spot; cur = 'USD' }
    // CUSTO DA HORA — só existe com a JORNADA gravada (hours_per_day ×
    // days_per_week). É o número que precifica as duties de um pack, então ele
    // abre o quadro. Sem jornada não se estima: a linha simplesmente não aparece.
    const horasMes = (Number(season.hours_per_day) || 0) * (Number(season.days_per_week) || 0) * 52 / 12
    const hourly = horasMes > 0 ? valor / horasMes : null
    return { hourly, daily: valor * 12 / 365, weekly: valor * 12 / 52, monthly: valor, currency: cur, fromRate: true, live: moeda === 'BRL' }
  }
  const total = calculateSeasonTotal(expenses, season, spot)
  const d = days > 0 ? total / days : 0
  return { hourly: null as number | null, daily: d, weekly: d * 7, monthly: d * 30, currency: 'USD', fromRate: false, live: false }
}

// Days worked in the season (entry -> conclusion, or entry -> today if still open).
function seasonDays(season: Season): number {
  if (!season.date_entry) return 0
  const start = new Date(season.date_entry + 'T00:00:00')
  const end = season.date_conclusion ? new Date(season.date_conclusion + 'T00:00:00') : new Date()
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
}

export default function SeasonsPage() {
  const params = useParams()
  const staffId = String(params.id)

  const [staff, setStaff] = useState<StaffMember | null>(null)
  const [seasons, setSeasons] = useState<Season[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Cotação comercial de hoje. Enquanto não chega, os valores ancorados em
  // reais aparecem na última foto gravada; quando chega, a tela se corrige.
  const [spot, setSpot] = useState<number | null>(null)

  useEffect(() => {
    loadStaff()
    loadSeasons()
    usdBrlSpot().then(setSpot)
  }, [])

  async function loadStaff() {
    const { data } = await supabase
      .from('staff')
      .select('id, name')
      .eq('id', staffId)
      .single()

    setStaff(data || null)
  }

  async function renumberSeasons() {
    const { data } = await supabase
      .from('seasons')
      .select('id, date_entry, date_conclusion')
      .eq('staff_id', staffId)

    if (!data) return

    // Unknown-entry seasons number by their conclusion date (chronological slot).
    data.sort((a, b) => ((a.date_entry || a.date_conclusion || '9999') as string).localeCompare(b.date_entry || b.date_conclusion || '9999'))

    for (let i = 0; i < data.length; i++) {
      const code = `US.${String(i + 1).padStart(3, '0')}`
      await supabase
        .from('seasons')
        .update({ season_code: code })
        .eq('id', data[i].id)
    }
  }

  async function loadSeasons() {
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('*')
      .eq('staff_id', staffId)

    // Most recent first. A season with unknown date_entry (historical gap) sorts
    // by its conclusion date, so it lands in its true chronological slot instead
    // of floating to the top (Postgres puts NULLs first on DESC).
    const sorted = [...(seasonData || [])].sort((a, b) =>
      ((b.date_entry || b.date_conclusion || '') as string).localeCompare(a.date_entry || a.date_conclusion || '')
    )
    setSeasons(sorted)

    if (seasonData && seasonData.length > 0) {
      const seasonIds = seasonData.map(s => s.id)
      const { data: expenseData } = await supabase
        .from('expenses')
        .select('id, season_id, type, amount, expense_date, payment_date, amount_brl, created_at')
        .in('season_id', seasonIds)

      setExpenses(expenseData || [])
    }

    setLoading(false)
  }

  async function removeSeason(id: string) {
    const { error } = await supabase
      .from('seasons')
      .delete()
      .eq('id', id)

    if (error) {
      alert(error.message)
      return
    }

    setConfirmId(null)
    await renumberSeasons()
    loadSeasons()
  }

  function formatDate(date: string | null) {
    if (!date) return '-'
    return new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    })
  }

  const globalTotal = seasons.reduce((sum, season) => sum + calculateSeasonTotal(expenses, season, spot), 0)
  const hasActive = seasons.some(s => !s.date_conclusion)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Season</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this season? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button
                onClick={() => setConfirmId(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                CANCEL
              </button>
              <button
                onClick={() => removeSeason(confirmId)}
                className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                REMOVE
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold">
            {staff?.name} — SEASONS ({seasons.length})
          </h1>
        </div>

        <div className="flex gap-4">
          <Link
            href="/staff"
            className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold"
          >
            BACK
          </Link>
          <Link
            href={`/staff/${staffId}/seasons/create`}
            className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
          >
            ADD NEW SEASON
          </Link>
        </div>
      </div>

      {seasons.length > 0 && (
        <div className="bg-red-700 rounded-3xl p-6 mb-8 max-w-sm">
          <p className="text-xl font-bold">GLOBAL EXPENSES TOTAL</p>
          <p className="text-5xl font-bold">{formatUSD(globalTotal)}</p>
          {hasActive && (
            <p className="text-sm mt-2 opacity-80">Running — updated daily until conclusion</p>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : seasons.length === 0 ? (
        <p className="text-2xl text-gray-400">No seasons yet.</p>
      ) : (
        <div className="space-y-5">
          {seasons.map((season) => {
            const total = calculateSeasonTotal(expenses, season, spot)
            const isConcluded = !!season.date_conclusion
            const totalLabel = isConcluded ? 'FINAL EXPENSES TOTAL' : 'ACTUAL EXPENSES TOTAL'
            const days = seasonDays(season)
            const upcoming = seasonUpcoming(expenses, season, spot)
            const cost = seasonCost(expenses, season, days, spot)

            return (
              <div
                key={season.id}
                className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between gap-6"
              >
                <div>
                  <h2 className="text-2xl font-bold">{season.season_code}</h2>
                  <p className="text-lg text-gray-400">Entry: {formatDate(season.date_entry)}</p>
                  <p className="text-lg text-gray-400">Conclusion: {formatDate(season.date_conclusion)}</p>
                  <p className="text-lg text-gray-400">Days: {days}</p>
                  {/* Só a TAXA. Quem paga não se deduz da moeda (Márcio, 26/ago/2026):
                      uma taxa em reais pode ser paga por qualquer uma das empresas, e o
                      pagador só existe no PAID FROM do pagamento em si. */}
                  {payLabel(season, spot) ? (
                    <p className="text-lg font-bold text-green-400" title={payAnchor(season)}>{payLabel(season, spot)}</p>
                  ) : !season.date_conclusion ? (
                    <p className="text-lg font-bold text-amber-400">No pay rate set</p>
                  ) : null}
                </div>

                <div className="text-center">
                  <div className="bg-red-700 rounded-2xl px-6 py-4">
                    <p className="text-sm font-bold">{totalLabel}</p>
                    <p className="text-3xl font-bold">{formatUSD(total)}</p>
                  </div>
                  {/* Previsão andando ao lado do realizado, nunca somada nele. */}
                  {upcoming > 0 && (
                    <p className="mt-2 text-sm text-gray-400">+ {formatUSD(upcoming)} still to come</p>
                  )}
                </div>

                <div className="bg-gray-800 rounded-2xl px-5 py-4 text-sm min-w-[200px]">
                  {cost.hourly != null && (
                    <div className="flex justify-between gap-6 pb-2 mb-2 border-b border-gray-700"><span className="text-gray-400 font-bold">HOURLY COST</span><span className="font-bold">{cost.currency === 'USD' ? formatUSD(cost.hourly as number) : '—'}</span></div>
                  )}
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">DAILY COST</span><span className="font-bold">{cost.currency === 'USD' ? formatUSD(cost.daily as number) : '—'}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">WEEKLY COST</span><span className="font-bold">{cost.currency === 'USD' ? formatUSD(cost.weekly as number) : '—'}</span></div>
                  <div className="flex justify-between gap-6"><span className="text-gray-400 font-bold">MONTHLY COST</span><span className="font-bold">{cost.currency === 'USD' ? formatUSD(cost.monthly as number) : '—'}</span></div>
                  <p className="mt-2 text-xs text-gray-500">
                    {cost.fromRate ? 'from the pay rate' : 'observed — no pay rate set'}
                    {cost.live ? (spot ? ` · US$ 1 = R$ ${spot.toFixed(4)} today` : ' · today’s dollar rate unavailable') : ''}
                  </p>
                </div>

                <div className="flex gap-3 flex-wrap">
                  <Link
                    href={`/staff/${staffId}/seasons/edit/${season.id}`}
                    className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    EDIT
                  </Link>

                  <button
                    onClick={() => setConfirmId(season.id)}
                    className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    REMOVE
                  </button>

                  <Link
                    href={`/staff/${staffId}/seasons/${season.id}/expenses`}
                    className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold"
                  >
                    EXPENSES
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}