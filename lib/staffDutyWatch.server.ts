// STAFF DUTY WATCH (23/ago/2026, ideia do Márcio via João — 'staff' no nome
// porque lib/dutyWatch.server.ts já é o watch do IMPOSTO de importação): o app percebe sozinho o
// timer de duty esquecido — e AVISA a própria pessoa no WhatsApp antes de virar
// hora inflada. Regras (constantes abaixo; 10h é do Márcio):
//   LONG      duty rodando há mais de MAX_HOURS
//   OVERLAP   mesma pessoa com 2+ duties rodando ao mesmo tempo
//   OVERNIGHT duty que virou a noite ligada (começou antes de hoje, Orlando)
// Aviso: DM no WhatsApp do funcionário (staff.phone via UltraMsg; sem telefone,
// vai pro grupo GZ28US - STAFF), UM por duty por dia (dedupe na trilha
// data_fixes, check_key 'duty-nudge'); sem resposta em ESCALATE_MIN, um aviso
// no grupo. Janela de avisos QUIET_START–QUIET_END (o card do Data Checker
// mostra o incidente sempre, aviso ou não). Fonte: invoice_duties
// (time_started_at ≠ null e done = false ⇒ rodando agora).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_HOURS = 10          // Márcio, 23/ago
export const ESCALATE_MIN = 60
export const QUIET_START = 7         // avisos só entre 07:00 e 22:00 de Orlando
export const QUIET_END = 22
const STAFF_GROUP_ID = '120363400165413030@g.us'   // GZ28US - STAFF (mesmo do relatório diário)

export type DutyIncident = {
  key: string; kind: 'LONG' | 'OVERLAP' | 'OVERNIGHT'
  duty_id: string; staff_id: string | null; staff_name: string; phone: string | null
  label: string; car: string; hours: number; started_at: string
}

const nowOrlando = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const r1 = (v: number) => Math.round(v * 10) / 10

export async function evaluateDuties(db: SupabaseClient): Promise<DutyIncident[]> {
  const { data: running, error } = await db.from('invoice_duties')
    .select('id, invoice_id, staff_id, description, time_started_at, time_seconds')
    .not('time_started_at', 'is', null).eq('done', false).limit(500)
  if (error) throw new Error('invoice_duties: ' + error.message)
  if (!running || !running.length) return []
  const [{ data: staff }, { data: invoices }] = await Promise.all([
    db.from('staff').select('id, name, phone'),
    db.from('invoices').select('id, invoice_code, ride_id'),
  ])
  const { data: rides } = await db.from('rides').select('id, project_name').in('id', (invoices || []).map((i: any) => i.ride_id).filter(Boolean))
  const staffBy = new Map((staff || []).map((s: any) => [s.id, s]))
  const invBy = new Map((invoices || []).map((i: any) => [i.id, i]))
  const rideBy = new Map((rides || []).map((r: any) => [r.id, r]))
  const today = todayNY()
  const out: DutyIncident[] = []
  const mk = (d: any, kind: DutyIncident['kind']): DutyIncident => {
    const s = staffBy.get(d.staff_id)
    const inv = invBy.get(d.invoice_id)
    const car = inv ? [inv.invoice_code, rideBy.get(inv.ride_id)?.project_name].filter(Boolean).join(' ') : ''
    const hours = r1((Date.now() - Date.parse(d.time_started_at)) / 36e5)
    return {
      key: `${kind}:${d.id}:${today}`, kind, duty_id: d.id, staff_id: d.staff_id || null,
      staff_name: s?.name || 'sem responsável', phone: s?.phone || null,
      label: String(d.description || 'duty').slice(0, 120), car, hours, started_at: d.time_started_at,
    }
  }
  const byStaff = new Map<string, any[]>()
  for (const d of running) {
    const startedDay = new Date(d.time_started_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const hours = (Date.now() - Date.parse(d.time_started_at)) / 36e5
    if (startedDay < today) out.push(mk(d, 'OVERNIGHT'))
    else if (hours >= MAX_HOURS) out.push(mk(d, 'LONG'))
    if (d.staff_id) byStaff.set(d.staff_id, [...(byStaff.get(d.staff_id) || []), d])
  }
  byStaff.forEach(list => { if (list.length > 1) for (const d of list) out.push(mk(d, 'OVERLAP')) })
  return out
}

async function sendWhats(to: string, body: string): Promise<string | null> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return 'no ultramsg env'
  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, to, body }).toString(),
  })
  return r.ok ? null : `ultramsg ${r.status}`
}
const phoneChat = (phone: string | null) => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 10 ? `${d.length === 10 ? '1' + d : d}@c.us` : null }

function message(i: DutyIncident): string {
  const car = i.car ? ` (${i.car})` : ''
  if (i.kind === 'OVERLAP') return `⏱️ ${i.staff_name}, você tem mais de uma duty rodando AO MESMO TEMPO — "${i.label}"${car} é uma delas. Pause a que não está ativa na tela DUTIES.`
  if (i.kind === 'OVERNIGHT') return `⏱️ ${i.staff_name}, a duty "${i.label}"${car} virou a noite LIGADA (${i.hours}h). Esqueceu de pausar? Abra DUTIES e pause/finalize — o tempo inflado bagunça o relatório.`
  return `⏱️ ${i.staff_name}, a duty "${i.label}"${car} está rodando há ${i.hours}h (limite ${MAX_HOURS}h). Se ainda está no serviço, segue firme e ignore; se esqueceu, pausa lá em DUTIES.`
}

// ── HISTÓRICO (caso Jeferson, 23/ago): segmento FECHADO acima do limite ainda é
// hora inflada no carro — e "compensar não ligando o timer depois" transforma um
// registro errado em vários (o total até fecha, mas o custo por carro/dia mente).
// O card acusa os dois: o segmento absurdo (com FIX de aparar) e os dias mudos
// que vieram depois. O aparo tira do invoice_duties.time_seconds só o EXCESSO
// bancado no segmento (Marcelo teve 78h de relógio mas só 8h bancadas — o
// desconto respeita o que de fato entrou na conta), grava trilha em data_fixes
// (check_key 'duty-trim') e um duty_event TRIMMED pra história ficar legível.
export type AbsurdSegment = { key: string; duty_id: string; staff_id: string | null; staff_name: string; label: string; car: string; start: string; end: string; wall_h: number; banked_start: number | null; banked_end: number | null }
export type SilentComp = { key: string; staff_name: string; after: string; days: string[]; label: string }
export async function evaluateHistory(db: SupabaseClient): Promise<{ absurd: AbsurdSegment[]; comps: SilentComp[] }> {
  const ev: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('duty_events').select('duty_id, staff_id, staff_name, action, at, seconds_banked, description, car_label').order('at').range(from, from + 999)
    if (error) throw new Error('duty_events: ' + error.message)
    ev.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const open = new Map<string, any>()
  const segs: AbsurdSegment[] = []
  for (const e of ev) {
    if (e.action === 'STARTED' || e.action === 'RESUMED') { if (!open.has(e.duty_id)) open.set(e.duty_id, e) }
    else if (e.action === 'PAUSED' || e.action === 'DONE') {
      const s = open.get(e.duty_id)
      if (s) {
        const wall = (Date.parse(e.at) - Date.parse(s.at)) / 36e5
        if (wall > MAX_HOURS) segs.push({
          key: e.duty_id + ':' + s.at, duty_id: e.duty_id, staff_id: s.staff_id || e.staff_id || null,
          staff_name: s.staff_name || e.staff_name || 'sem responsável', label: String(s.description || e.description || 'duty').slice(0, 120),
          car: s.car_label || e.car_label || '', start: s.at, end: e.at, wall_h: Math.round(wall * 10) / 10,
          banked_start: Number.isFinite(Number(s.seconds_banked)) ? Number(s.seconds_banked) : null,
          banked_end: Number.isFinite(Number(e.seconds_banked)) ? Number(e.seconds_banked) : null,
        })
        open.delete(e.duty_id)
      }
    }
  }
  // já aparados saem da lista (trilha data_fixes é a memória do aparo)
  const keys = segs.map(s => s.key)
  const { data: trims } = keys.length ? await db.from('data_fixes').select('row_id').eq('check_key', 'duty-trim').in('row_id', keys) : { data: [] as { row_id: string }[] }
  const trimmed = new Set((trims || []).map(t => t.row_id))
  const absurd = segs.filter(s => !trimmed.has(s.key))
  // compensação silenciosa: nos 5 dias seguintes ao estouro (menos domingo), a
  // pessoa tem 2+ dias SEM NENHUM evento? Trabalho sem registro na certa.
  const byStaffDay = new Set(ev.map(e => (e.staff_id || e.staff_name) + '|' + dayOf(e.at)))
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const comps: SilentComp[] = []
  for (const s of segs) {
    const sk = s.staff_id || s.staff_name
    const quiet: string[] = []
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.parse(s.end) + i * 864e5)
      const day = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      if (day >= today) break
      if (d.getUTCDay() === 0) continue
      if (!byStaffDay.has(sk + '|' + day)) quiet.push(day)
    }
    if (quiet.length >= 2) comps.push({ key: 'COMP:' + s.key, staff_name: s.staff_name, after: s.end.slice(0, 10), days: quiet, label: s.label })
  }
  return { absurd, comps }
}

// Um aviso por incidente-dia; escalação pro grupo se seguir rodando ESCALATE_MIN
// depois do aviso. Dedupe e trilha na data_fixes (check_key 'duty-nudge').
export async function sendNudges(db: SupabaseClient, incidents: DutyIncident[]): Promise<{ nudged: number; escalated: number; skipped: number; errors: string[] }> {
  const res = { nudged: 0, escalated: 0, skipped: 0, errors: [] as string[] }
  const hour = nowOrlando().getHours()
  if (hour < QUIET_START || hour >= QUIET_END) { res.skipped = incidents.length; return res }
  for (const i of incidents) {
    const { data: prev } = await db.from('data_fixes').select('id, fixed_at').eq('check_key', 'duty-nudge').eq('row_id', i.key).limit(1)
    if (!prev || !prev.length) {
      const to = phoneChat(i.phone) || STAFF_GROUP_ID
      const err = await sendWhats(to, message(i))
      if (err) { res.errors.push(`${i.staff_name}: ${err}`); continue }
      await db.from('data_fixes').insert({ check_key: 'duty-nudge', table_name: 'invoice_duties', row_id: i.key, field: i.kind, old_value: null, new_value: 'AVISADO', label: `${i.staff_name} · ${i.label} · ${i.hours}h${phoneChat(i.phone) ? '' : ' · (sem telefone — grupo)'}`.slice(0, 200) }).then(() => undefined, () => undefined)
      res.nudged++
      continue
    }
    // já avisado — escala se passou ESCALATE_MIN e ainda está na lista (= segue rodando)
    const { data: esc } = await db.from('data_fixes').select('id').eq('check_key', 'duty-nudge').eq('row_id', i.key + ':esc').limit(1)
    if (esc && esc.length) { res.skipped++; continue }
    if (Date.now() - Date.parse(prev[0].fixed_at) < ESCALATE_MIN * 60e3) { res.skipped++; continue }
    const err = await sendWhats(STAFF_GROUP_ID, `⚠️ Sem resposta: ${message(i)}`)
    if (err) { res.errors.push(`esc ${i.staff_name}: ${err}`); continue }
    await db.from('data_fixes').insert({ check_key: 'duty-nudge', table_name: 'invoice_duties', row_id: i.key + ':esc', field: i.kind, old_value: 'AVISADO', new_value: 'ESCALADO', label: `${i.staff_name} · ${i.label} · escalado pro grupo`.slice(0, 200) }).then(() => undefined, () => undefined)
    res.escalated++
  }
  return res
}
