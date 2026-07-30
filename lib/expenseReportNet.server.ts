// SERVER-ONLY — EXPENSE REPORT SAFETY NET (ordem do Márcio, 26/jul/2026):
// "NUNCA pode passar nenhuma expense sem report no grupo." Toda linha nova de
// invoice_expenses / invoice_payments / expenses (staff) — venha da UI, de
// scripts ou de qualquer automação — é reportada no grupo REPORTS. Dedup em
// stream_mail_moves (message_id = 'ern:<uuid>', sem FK). Para não duplicar o
// report que a própria UI já mandou, consulta o log de ENVIADAS do UltraMsg:
// se uma mensagem recente já carrega o mesmo valor formatado, só marca como
// reportada. Roda no mail-poll (cron 5min) — PC desligado incluso.

import type { SupabaseClient } from '@supabase/supabase-js'

// Só linhas criadas após a entrada da rede — histórico não é re-reportado.
const EPOCH = '2026-07-26T16:00:00Z'
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SIGNATURE = 'Sent by GZ28US Control App®'

async function sendReport(body: string): Promise<boolean> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  const groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return false
  try {
    const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
    })
    return r.ok
  } catch { return false }
}

// Últimas mensagens ENVIADAS pela instância (dedup contra o report da própria UI).
async function recentSentBodies(): Promise<string[]> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return []
  try {
    const r = await fetch(`https://api.ultramsg.com/${instance}/messages?token=${token}&page=1&limit=60&status=sent`)
    const j = await r.json().catch(() => null)
    const list = Array.isArray(j) ? j : (j?.messages || [])
    return list.map((m: any) => String(m.body || ''))
  } catch { return [] }
}

export async function runExpenseReportNet(db: SupabaseClient): Promise<{ reported: string[] }> {
  const out: string[] = []
  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'expense-report-net')
  const seenSet = new Set((seen || []).map((r: any) => r.message_id))
  const mark = async (key: string, label: string) =>
    db.from('stream_mail_moves').insert({ message_id: key, subject: label.slice(0, 120), from_addr: 'expense-report-net', folder_name: 'reported', state: 'REPORTED' })

  const sent = await recentSentBodies()
  const alreadySent = (amount: number) => sent.some((b) => b.includes(usd(amount)))

  // 1) invoice_expenses — regra do Márcio (30/jul): reporta SÓ QUANDO PAGA
  // (payment_date preenchido), nunca no cadastro nem na exclusão. Linhas não
  // pagas ficam SEM marca — quando forem pagas, o report sai naquele momento.
  // Quotes nunca reportam (lei das quotes + enchente US.044.2).
  const { data: ie } = await db.from('invoice_expenses')
    .select('id, item, price, payment_date, created_at, invoices(invoice_code, is_quote)')
    .gte('created_at', EPOCH).not('payment_date', 'is', null).order('created_at')
  for (const e of (ie || []) as any[]) {
    const key = `ern:ie:${e.id}`
    if (seenSet.has(key)) continue
    if (e.invoices?.is_quote) continue
    const label = `EXPENSE ${e.invoices?.invoice_code || '—'} ${usd(e.price)}`
    if (!alreadySent(Number(e.price))) {
      await sendReport([`*EXPENSE PAID* ${e.invoices?.invoice_code || '—'}`, `${e.payment_date || ''} — *${usd(e.price)}*`, String(e.item || '').slice(0, 160)].join('\n'))
      out.push(label)
    }
    await mark(key, label)
  }

  // 2) invoice_payments (incomes) — mesma regra: só quando o dinheiro ENTROU
  // (payment_date preenchido); previsões não reportam; quotes nunca reportam.
  const { data: ip } = await db.from('invoice_payments')
    .select('id, amount, payment_date, description, created_at, invoices(invoice_code, is_quote)')
    .gte('created_at', EPOCH).not('payment_date', 'is', null).order('created_at')
  for (const p of (ip || []) as any[]) {
    const key = `ern:ip:${p.id}`
    if (seenSet.has(key)) continue
    if (p.invoices?.is_quote) continue
    const label = `INCOME ${p.invoices?.invoice_code || '—'} ${usd(p.amount)}`
    if (!alreadySent(Number(p.amount))) {
      await sendReport([`*INCOME* ${p.invoices?.invoice_code || '—'}`, `${p.payment_date || ''} — *${usd(p.amount)}*`, String(p.description || '').slice(0, 160)].join('\n'))
      out.push(label)
    }
    await mark(key, label)
  }

  // 3) expenses (staff seasons) — mesma regra: reporta só quando PAGA.
  const { data: se } = await db.from('expenses')
    .select('id, amount, payment_date, description, created_at, seasons(season_code, staff(name))')
    .gte('created_at', EPOCH).not('payment_date', 'is', null).order('created_at')
  for (const s of (se || []) as any[]) {
    const key = `ern:se:${s.id}`
    if (seenSet.has(key)) continue
    const who = s.seasons?.staff?.name || '—'
    const label = `EXPENSE STAFF ${s.seasons?.season_code || ''} ${usd(s.amount)}`
    if (!alreadySent(Number(s.amount))) {
      await sendReport([`*EXPENSE PAID — STAFF* ${s.seasons?.season_code || '—'} — ${who}`, `${s.payment_date || ''} — *${usd(s.amount)}*`, String(s.description || '').slice(0, 160)].join('\n'))
      out.push(label)
    }
    await mark(key, label)
  }

  return { reported: out }
}
