import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── DUTIES DO DIA — report automático (Márcio, 01/ago/2026) ──────────────────
// "às 4am de cada dia, este report automático." Todo dia às 4am de Orlando
// (cron 8 UTC, PC desligado) o grupo GZ28US - STAFF recebe o resumo do dia
// anterior lido do duty_events: por membro → por carro → tarefas com tempos,
// resumo no fim e o rodapé fixo de lembretes. SEMPRE em PT-BR (a equipe é
// brasileira) — formato aprovado no chat de 01/ago.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STAFF_GROUP_ID = '120363400165413030@g.us' // GZ28US - STAFF (id estável)
const TZ_OFFSET_MS = 4 * 3600 * 1000 // Orlando EDT (UTC-4)

const WEEKDAYS = ['domingo', '2ª feira', '3ª feira', '4ª feira', '5ª feira', '6ª feira', 'sábado']
const FOOTER = '⚠️ *LEMBRETES DA EQUIPE*\n' +
  '• Precisa fazer uma tarefa que não está no sistema? Peça pro Dema adicionar — assim você trabalha com o cronômetro contando.\n' +
  '• Nunca esqueça de dar START / PAUSE / FINISH em toda tarefa — senão seu trabalho não fica registrado, ou o tempo sai errado.'

const fmtDur = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m` }
const localDay = (iso: string) => new Date(new Date(iso).getTime() - TZ_OFFSET_MS).toISOString().slice(0, 10)

type Ev = { action: string; at: string; seconds_banked: number | null; description: string | null; car_label: string | null; staff_name: string | null; _delta?: number }

// Tempo por tarefa no dia = delta do seconds_banked (acumulado) a cada
// PAUSED/DONE — por isso os eventos anteriores ao dia também entram no cálculo.
export function computeDeltas(events: Ev[]) {
  const lastBank: Record<string, number> = {}
  for (const e of events) {
    const k = `${e.staff_name || ''}|${e.description || ''}`
    if ((e.action === 'PAUSED' || e.action === 'DONE') && e.seconds_banked != null) {
      e._delta = Math.max(0, e.seconds_banked - (lastBank[k] || 0))
      lastBank[k] = Math.max(lastBank[k] || 0, e.seconds_banked)
    }
  }
}

export function buildDayReport(events: Ev[], day: string, header: string): string {
  const dow = WEEKDAYS[new Date(day + 'T12:00:00Z').getUTCDay()]
  const [y, mo, d] = day.split('-')
  const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  let body = `📋 *${header} — ${d}/${MONTHS[Number(mo) - 1]}/${y} (${dow})*\n`
  const out: Record<string, Record<string, Record<string, { secs: number; done: boolean }>>> = {}
  for (const e of events) {
    if (localDay(e.at) !== day) continue
    const st = e.staff_name || '?'
    const car = (e.car_label || '—').split(' — ').pop() as string
    out[st] = out[st] || {}
    out[st][car] = out[st][car] || {}
    const t = out[st][car][e.description || '?'] = out[st][car][e.description || '?'] || { secs: 0, done: false }
    if (e._delta) t.secs += e._delta
    if (e.action === 'DONE') t.done = true
  }
  if (!Object.keys(out).length) {
    body += '\nNenhuma tarefa registrada neste dia.'
  } else {
    for (const [st, cars] of Object.entries(out)) {
      let n = 0, tot = 0, sec = `\n👤 *${st}*\n`
      for (const [car, tasks] of Object.entries(cars)) {
        const carTot = Object.values(tasks).reduce((s, t) => s + t.secs, 0)
        sec += `🚗 *${car}*${carTot ? ` — ⏱ ${fmtDur(carTot)}` : ' — (sem cronômetro)'}\n`
        for (const [k, v] of Object.entries(tasks)) {
          n++; tot += v.secs
          sec += `${v.done ? '✅ ' : '▶ '}${k}${v.secs ? ` — ${fmtDur(v.secs)}` : ''}${v.done ? '' : ' (continua)'}\n`
        }
      }
      sec += `*${n}${n > 1 ? ' tarefas' : ' tarefa'}, ${fmtDur(tot)} trabalhadas*\n`
      body += sec
    }
  }
  return body + '\n\n' + FOOTER + '\n\nSent by GZ28US Control App®'
}

async function sendToGroup(body: string) {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return 'no ultramsg env'
  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, to: STAFF_GROUP_ID, body }).toString(),
  })
  return r.ok ? null : `ultramsg ${r.status}`
}

export async function GET(_req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })
  // "Ontem" no relógio de Orlando.
  const day = new Date(Date.now() - TZ_OFFSET_MS - 24 * 3600 * 1000).toISOString().slice(0, 10)
  const { data: events, error } = await db.from('duty_events')
    .select('action, at, seconds_banked, description, car_label, staff_name')
    .lt('at', new Date(new Date(day + 'T00:00:00Z').getTime() + TZ_OFFSET_MS + 24 * 3600 * 1000).toISOString())
    .order('at')
    .limit(5000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const evs = (events || []) as Ev[]
  computeDeltas(evs)
  const body = buildDayReport(evs, day, 'DUTIES DO DIA')
  const err = await sendToGroup(body)
  return NextResponse.json({ ok: !err, day, error: err || undefined })
}
