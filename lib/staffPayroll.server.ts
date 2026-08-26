// SERVER-ONLY — FOLHA RECORRENTE DE STAFF (ordem do Márcio, 28/jul/2026:
// "he gets paid USD 500 every Friday, but I want the system to register the
// payments, showing them as paid and unpaid").
//
// O QUE MUDOU: antes, uma linha WEEKLY era uma TAXA e as páginas projetavam
// valor × dias÷7 pra sempre — número que ninguém conferia, sem data, sem
// comprovante. Agora:
//   • a taxa vive na SEASON  → seasons.pay_type ('DAILY'|'WEEKLY'|'MONTHLY'),
//     seasons.pay_rate, seasons.pay_currency e seasons.pay_day;
//
// pay_day é UM campo só, e o pay_type diz o que ele significa: dia da semana
// (0=dom … 5=sexta, padrão sexta) quando WEEKLY, dia do mês (1–31) quando
// MONTHLY. Era pay_weekday e só sabia semana — o Jeff recebe todo dia 28
// (Márcio, 26/ago/2026) e o mensal fechava no último dia do mês, sempre.
//
// MOEDA: a taxa pode estar em BRL (o Jeff ganha R$ 15.000/mês, pagos pelo
// GZ28BR). Neste app o total é sempre USD, então a linha guarda os DOIS: o
// valor real em amount_brl e o dólar do dia em amount. É a mesma lei das
// invoices — a moeda do recibo manda, o USD é projeção.
//   • cada pagamento é uma LINHA em expenses, com expense_date do período,
//     `payment_date` vazio enquanto não foi pago e `paid_via` (CASH/ZELLE/…).
//
// Este job roda no cron: no dia do pagamento, cria a linha EM ABERTO de cada
// season ativa. A partir daí o valor aparece como pendente até alguém dar baixa
// — e a baixa entra sozinha quando o e-mail do banco chega (Zelle → Regions).
// Idempotente: nunca cria duas linhas pro mesmo período.

import type { SupabaseClient } from '@supabase/supabase-js'

type Season = {
  id: string
  season_code: string | null
  staff_id: string
  date_entry: string | null
  date_conclusion: string | null
  pay_type: string | null
  pay_rate: number | null
  pay_currency: string | null
  pay_day: number | null
}

// Cotação comercial do dia. Se a fonte cair, NÃO inventa câmbio: devolve null e
// a linha não nasce — melhor faltar do que nascer com um número fabricado.
async function usdPerBrl(): Promise<number | null> {
  try {
    const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL')
    const j: any = await r.json()
    const spot = parseFloat(j?.USDBRL?.bid) || 0
    return spot > 0 ? spot : null
  } catch { return null }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
// Hoje no fuso da empresa (Orlando) — o dia de pagamento é o de lá, não o UTC.
function todayET(): Date {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  return new Date(s + 'T00:00:00Z')
}

export async function runStaffPayroll(db: SupabaseClient): Promise<{ created: string[] }> {
  const created: string[] = []
  const { data } = await db.from('seasons').select('*').is('date_conclusion', null).not('pay_type', 'is', null)
  const seasons = (data as Season[]) || []
  if (!seasons.length) return { created }

  const today = todayET()
  const hoje = ymd(today)

  for (const s of seasons) {
    const rate = Number(s.pay_rate) || 0
    if (rate <= 0) continue
    // A season só paga a partir do dia em que ela começou.
    if (s.date_entry && hoje < s.date_entry) continue

    let periodo: string | null = null
    if (s.pay_type === 'WEEKLY') {
      const dia = s.pay_day ?? 5
      if (today.getUTCDay() !== dia) continue
      periodo = hoje
    } else if (s.pay_type === 'DAILY') {
      periodo = hoje
    } else if (s.pay_type === 'MONTHLY') {
      // Paga no dia escolhido do mês; sem escolha, no último dia (como sempre foi).
      // Mês curto não engole o pagamento: dia 31 em fevereiro cai no dia 28/29.
      const ultimo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate()
      const alvo = s.pay_day ? Math.min(s.pay_day, ultimo) : ultimo
      if (today.getUTCDate() !== alvo) continue
      periodo = hoje
    }
    if (!periodo) continue

    const { data: dup } = await db.from('expenses').select('id')
      .eq('season_id', s.id).eq('type', s.pay_type).eq('expense_date', periodo).limit(1)
    if (dup?.length) continue

    const label = s.pay_type === 'WEEKLY' ? `Semanal (sexta ${periodo.slice(8, 10)}/${periodo.slice(5, 7)})`
      : s.pay_type === 'DAILY' ? `Diária ${periodo.slice(8, 10)}/${periodo.slice(5, 7)}`
      : `Mensal ${periodo.slice(5, 7)}/${periodo.slice(0, 4)}`

    // Taxa em reais: quem paga é o GZ28BR — real não sai de conta americana,
    // do mesmo jeito que não existe Zelle no Brasil.
    const emBRL = (s.pay_currency || 'USD') === 'BRL'
    let usd = rate
    let brl: number | null = null
    let nota = ''
    if (emBRL) {
      const spot = await usdPerBrl()
      if (!spot) continue
      brl = rate
      usd = Number((rate / spot).toFixed(2))
      nota = ` · R$ ${rate.toFixed(2)} a ${spot.toFixed(4)}`
    }
    const { error } = await db.from('expenses').insert({
      season_id: s.id, type: s.pay_type, amount: usd, amount_brl: brl,
      expense_date: periodo, payment_date: null, source: emBRL ? 'GZ28BR' : 'GZ28US',
      description: `${label}${nota} — gerado pelo app, aguardando pagamento`,
    })
    if (!error) created.push(`${s.season_code || s.id.slice(0, 6)} ${periodo} $${usd}`)
  }
  return { created }
}
