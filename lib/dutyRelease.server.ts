// lib/dutyRelease.server.ts — A DUTY DESTRAVA SOZINHA QUANDO A PEÇA CHEGA (17/10/2026).
//
// Márcio (17/10/2026, via Staff Cronogram 2): «à medida que as coisas vão chegando, vá desbloqueando a duty e levando pra cima
// na ordem de prioridade equivalente. Ponha isso pra rodar, crie um robô no app, se preciso, pra ser automático, sem precisar
// de nós aqui.»
//
// O bloqueio é DADO, não texto (MIGRATION_duty_release.sql): uma duty STANDBY carrega
//   blocked_by_expenses — linhas de invoice_expenses que precisam CHEGAR (delivered_at preenchido pelo 17TRACK, ou picked_up)
//   blocked_by_duties   — duties que precisam estar done
//   release_priority    — para onde ela vai quando destravar ('0'..'4', a prioridade equivalente do carro)
// Roda junto do STAFF DUTY WATCH (cron 30/30 min). Tudo chegou → priority ← release_priority, released_at, bloqueios limpos
// (os antigos ficam na trilha data_fixes 'duty-release'). Idempotente: o UPDATE só pega duty ainda STANDBY.
// Linha-bloqueio que SUMIU (placeholder trocado pela compra real, linha apagada) não libera nada: vira release_issue, que a
// tela mostra, até alguém religar a linha nova.
// Aviso «🔓 DUTY LIBERADA» no grupo GZ28US - STAFF, no formato dos avisos de duty (nome em negrito, sem @menção — Márcio
// 01/ago/2026), só entre 07:00 e 22:00 de Orlando; liberação fora da janela avisa na primeira rodada da manhã.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js'
import { enviaUltra } from '@/lib/waSend.server'
import { QUIET_START, QUIET_END } from '@/lib/staffDutyWatch.server'

const STAFF_GROUP_ID = '120363400165413030@g.us'   // GZ28US - STAFF
const SIGNATURE = '\n\nSent by GZ28US Control App®'
const hourNY = () => parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10) % 24

export type ReleaseSummary = { checked: number; released: number; notified: number; issues: number; errors: string[] }

const arrived = (e: any) => !!e && (!!e.delivered_at || e.picked_up === true)
const short = (s: unknown, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

export async function releaseDuties(db: SupabaseClient): Promise<ReleaseSummary> {
  const sum: ReleaseSummary = { checked: 0, released: 0, notified: 0, issues: 0, errors: [] }
  const { data: blocked, error } = await db.from('invoice_duties')
    .select('id, invoice_id, staff_id, description, priority, release_priority, blocked_by_expenses, blocked_by_duties, release_issue')
    .eq('done', false).eq('priority', 'STANDBY').or('blocked_by_expenses.not.is.null,blocked_by_duties.not.is.null').limit(500)
  if (error) { sum.errors.push('invoice_duties: ' + error.message); return sum }
  const rows = (blocked || []).filter((d: any) => (d.blocked_by_expenses?.length || 0) + (d.blocked_by_duties?.length || 0) > 0)
  sum.checked = rows.length
  if (rows.length) {
    const expIds = [...new Set(rows.flatMap((d: any) => d.blocked_by_expenses || []))].map(String)
    const dutyIds = [...new Set(rows.flatMap((d: any) => d.blocked_by_duties || []))].map(String)
    const expOf = new Map<string, any>(), dutyOf = new Map<string, any>()
    for (let i = 0; i < expIds.length; i += 200) {
      const { data, error: e } = await db.from('invoice_expenses').select('id, item, delivered_at, picked_up').in('id', expIds.slice(i, i + 200))
      if (e) { sum.errors.push('invoice_expenses: ' + e.message); return sum }
      for (const r of data || []) expOf.set(String(r.id), r)
    }
    for (let i = 0; i < dutyIds.length; i += 200) {
      const { data, error: e } = await db.from('invoice_duties').select('id, description, done').in('id', dutyIds.slice(i, i + 200))
      if (e) { sum.errors.push('invoice_duties (bloqueio): ' + e.message); return sum }
      for (const r of data || []) dutyOf.set(String(r.id), r)
    }
    for (const d of rows as any[]) {
      if (!d.release_priority) { await setIssue(db, d, 'sem release_priority — o robô não sabe para onde ela vai'); sum.issues++; continue }
      const exps = (d.blocked_by_expenses || []).map(String), duts = (d.blocked_by_duties || []).map(String)
      const gone = [...exps.filter((id: string) => !expOf.has(id)).map((id: string) => 'linha ' + id.slice(0, 8)), ...duts.filter((id: string) => !dutyOf.has(id)).map((id: string) => 'duty ' + id.slice(0, 8))]
      if (gone.length) { await setIssue(db, d, 'bloqueio aponta para registro que sumiu (' + gone.join(', ') + ') — religue a linha nova'); sum.issues++; continue }
      if (d.release_issue) await setIssue(db, d, null)
      if (!exps.every((id: string) => arrived(expOf.get(id))) || !duts.every((id: string) => dutyOf.get(id)?.done === true)) continue
      const { data: upd, error: e } = await db.from('invoice_duties')
        .update({ priority: d.release_priority, released_at: new Date().toISOString(), release_notified_at: null, blocked_by_expenses: null, blocked_by_duties: null, release_issue: null })
        .eq('id', d.id).eq('priority', 'STANDBY').eq('done', false).select('id')
      if (e) { sum.errors.push('liberar ' + String(d.id).slice(0, 8) + ': ' + e.message); continue }
      if (!upd || !upd.length) continue
      const what = [...exps.map((id: string) => short(expOf.get(id)?.item, 50)), ...duts.map((id: string) => 'duty «' + short(String(dutyOf.get(id)?.description || '').replace(/^\s*\d+[.)]\s*/, ''), 40) + '» feita')]
      await db.from('data_fixes').insert({
        check_key: 'duty-release', table_name: 'invoice_duties', row_id: String(d.id), field: 'priority', old_value: 'STANDBY', new_value: String(d.release_priority),
        label: ('DUTY LIBERADA · ' + short(d.description, 60) + ' · chegou: ' + what.join(' + ') + ' · bloqueios eram ' + JSON.stringify({ expenses: exps, duties: duts })).slice(0, 500),
      }).then(() => undefined, () => undefined)
      sum.released++
    }
  }
  sum.notified = await notifyReleased(db, sum.errors)
  return sum
}

async function setIssue(db: SupabaseClient, d: any, issue: string | null) {
  if ((d.release_issue || null) === issue) return
  await db.from('invoice_duties').update({ release_issue: issue }).eq('id', d.id)
}

// O aviso de cada liberação ainda não avisada — só na janela do dia; fora dela espera a manhã.
async function notifyReleased(db: SupabaseClient, errors: string[]): Promise<number> {
  const h = hourNY()
  if (h < QUIET_START || h >= QUIET_END) return 0
  const { data: pend, error } = await db.from('invoice_duties').select('id, invoice_id, staff_id, description, priority, released_at')
    .not('released_at', 'is', null).is('release_notified_at', null).limit(50)
  if (error) { errors.push('aviso: ' + error.message); return 0 }
  if (!pend || !pend.length) return 0
  const invIds = [...new Set(pend.map((d: any) => d.invoice_id).filter(Boolean))]
  const staffIds = [...new Set(pend.map((d: any) => d.staff_id).filter(Boolean))]
  const [{ data: invs }, { data: staff }] = await Promise.all([
    invIds.length ? db.from('invoices').select('id, rides(project_name)').in('id', invIds) : Promise.resolve({ data: [] as any[] }),
    staffIds.length ? db.from('staff').select('id, name').in('id', staffIds) : Promise.resolve({ data: [] as any[] }),
  ])
  const carOf = new Map<string, string>((invs || []).map((i: any) => [String(i.id), String(i.rides?.project_name || '')]))
  const nameOf = new Map<string, string>((staff || []).map((s: any) => [String(s.id), String(s.name || '')]))
  let n = 0
  for (const d of pend as any[]) {
    // O que destravou mora na trilha da liberação.
    const { data: fx } = await db.from('data_fixes').select('label').eq('check_key', 'duty-release').eq('row_id', String(d.id)).order('created_at', { ascending: false }).limit(1)
    const got = String(fx?.[0]?.label || '').match(/· chegou: (.*?) · bloqueios eram/)?.[1] || ''
    const car = carOf.get(String(d.invoice_id)) || ''
    const desc = String(d.description || '').replace(/^\s*\d+[.)]\s*/, '')
    const lines = ['🔓 DUTY LIBERADA', `👤 *${nameOf.get(String(d.staff_id)) || 'Unassigned'}*`, `${car ? car + ' - ' : ''}${desc}`, `Prioridade: P${d.priority}`]
    if (got) lines.push(`Chegou: ${got}`)
    const r = await enviaUltra(STAFF_GROUP_ID, lines.join('\n') + SIGNATURE)
    if (!r.httpOk) { errors.push('aviso ' + String(d.id).slice(0, 8) + ': ' + (r.error || 'ultramsg ' + r.status)); continue }
    await db.from('invoice_duties').update({ release_notified_at: new Date().toISOString() }).eq('id', d.id).is('release_notified_at', null)
    n++
  }
  return n
}
