// SERVER-ONLY — FOLHA RECORRENTE DE STAFF (ordem do Márcio, 28/jul/2026:
// "he gets paid USD 500 every Friday, but I want the system to register the
// payments, showing them as paid and unpaid").
//
// O QUE MUDOU: antes, uma linha WEEKLY era uma TAXA e as páginas projetavam
// valor × dias÷7 pra sempre — número que ninguém conferia, sem data, sem
// comprovante. Agora:
//   • a taxa vive na SEASON  → seasons.pay_type ('DAILY'|'WEEKLY'|'MONTHLY'),
//     seasons.pay_rate e seasons.pay_weekday (0=dom … 5=sexta, padrão sexta);
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
  pay_weekday: number | null
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
      const dia = s.pay_weekday ?? 5
      if (today.getUTCDay() !== dia) continue
      periodo = hoje
    } else if (s.pay_type === 'DAILY') {
      periodo = hoje
    } else if (s.pay_type === 'MONTHLY') {
      // Mensal fecha no último dia do mês.
      const amanha = new Date(today); amanha.setUTCDate(amanha.getUTCDate() + 1)
      if (amanha.getUTCMonth() === today.getUTCMonth()) continue
      periodo = hoje
    }
    if (!periodo) continue

    const { data: dup } = await db.from('expenses').select('id')
      .eq('season_id', s.id).eq('type', s.pay_type).eq('expense_date', periodo).limit(1)
    if (dup?.length) continue

    const label = s.pay_type === 'WEEKLY' ? `Semanal (sexta ${periodo.slice(8, 10)}/${periodo.slice(5, 7)})`
      : s.pay_type === 'DAILY' ? `Diária ${periodo.slice(8, 10)}/${periodo.slice(5, 7)}`
      : `Mensal ${periodo.slice(5, 7)}/${periodo.slice(0, 4)}`
    const { error } = await db.from('expenses').insert({
      season_id: s.id, type: s.pay_type, amount: rate,
      expense_date: periodo, payment_date: null, source: 'GZ28US',
      description: `${label} — gerado pelo app, aguardando pagamento`,
    })
    if (!error) created.push(`${s.season_code || s.id.slice(0, 6)} ${periodo} $${rate}`)
  }
  return { created }
}
