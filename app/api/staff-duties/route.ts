import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { evaluateDuties, evaluateHistory, MAX_HOURS } from '@/lib/staffDutyWatch.server'

// Sinal do DUTY WATCH pro Data Checker (card STAFF): os incidentes de AGORA,
// sem mandar aviso nenhum (quem avisa é o cron). Sessão obrigatória.
export const maxDuration = 30

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const [incidents, history] = await Promise.all([evaluateDuties(db), evaluateHistory(db)])
    // avisos já mandados hoje (pra tela dizer "avisado às…")
    const keys = incidents.map(i => i.key)
    const { data: nudges } = keys.length
      ? await db.from('data_fixes').select('row_id, fixed_at, new_value').eq('check_key', 'duty-nudge').in('row_id', [...keys, ...keys.map(k => k + ':esc')])
      : { data: [] as { row_id: string; fixed_at: string; new_value: string }[] }
    return NextResponse.json({
      ok: true, max_hours: MAX_HOURS,
      incidents: incidents.map(i => ({ ...i, phone: undefined, nudged: (nudges || []).find(n => n.row_id === i.key)?.fixed_at || null, escalated: (nudges || []).some(n => n.row_id === i.key + ':esc') })),
      history,
    })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}

// APARAR um segmento absurdo: o fim de verdade entra (hora de Orlando), o
// EXCESSO bancado sai do invoice_duties.time_seconds (limitado ao que o
// segmento de fato bancou), trilha em data_fixes (duty-trim) e duty_event
// TRIMMED pra história. Idempotente: segmento já aparado devolve 409.
export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  if (String(b.action) !== 'trim') return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const dutyId = String(b.duty_id || ''), segStart = String(b.seg_start || ''), segEnd = String(b.seg_end || '')
  const newEndLocal = String(b.new_end_local || '')   // 'YYYY-MM-DDTHH:mm' na hora de Orlando
  if (!dutyId || !segStart || !segEnd || !/^d{4}-d{2}-d{2}Td{2}:d{2}/.test(newEndLocal)) return NextResponse.json({ error: 'dados incompletos' }, { status: 400 })
  // Orlando está em EDT (-04:00) no período coberto; a trilha guarda o instante exato.
  const newEnd = new Date(newEndLocal + ':00-04:00').toISOString()
  if (!(newEnd > segStart && newEnd < segEnd)) return NextResponse.json({ error: 'o fim aparado tem que ficar DENTRO do segmento' }, { status: 400 })
  try {
    const db = bankDb()
    const key = dutyId + ':' + segStart
    const { data: prev } = await db.from('data_fixes').select('id').eq('check_key', 'duty-trim').eq('row_id', key).limit(1)
    if (prev && prev.length) return NextResponse.json({ error: 'segmento já aparado — recarregue' }, { status: 409 })
    const wallS = (Date.parse(segEnd) - Date.parse(segStart)) / 1e3
    const contribution = b.banked_end != null && b.banked_start != null ? Math.max(0, Number(b.banked_end) - Number(b.banked_start)) : wallS
    const keptS = (Date.parse(newEnd) - Date.parse(segStart)) / 1e3
    const delta = Math.round(Math.max(0, Math.min(contribution, wallS) - keptS))
    const { data: duty, error: dErr } = await db.from('invoice_duties').select('id, staff_id, description, time_seconds').eq('id', dutyId).maybeSingle()
    if (dErr || !duty) return NextResponse.json({ error: dErr?.message || 'duty não encontrada' }, { status: 404 })
    const newTotal = Math.max(0, Math.round(Number(duty.time_seconds) || 0) - delta)
    const { error: uErr } = await db.from('invoice_duties').update({ time_seconds: newTotal }).eq('id', dutyId)
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    await db.from('duty_events').insert({
      duty_id: dutyId, staff_id: duty.staff_id, action: 'TRIMMED', at: new Date().toISOString(), seconds_banked: newTotal,
      description: ('aparado pelo Data Checker: segmento ' + segStart.slice(0, 16) + ' terminava ' + segEnd.slice(0, 16) + ', fim real ' + newEnd.slice(0, 16) + ' (−' + Math.round(delta / 36) / 100 + 'h)').slice(0, 500), source: 'DATA_CHECKER',
    }).then(() => undefined, () => undefined)
    await db.from('data_fixes').insert({
      check_key: 'duty-trim', table_name: 'invoice_duties', row_id: key, field: 'time_seconds',
      old_value: String(duty.time_seconds ?? ''), new_value: String(newTotal), label: (String(duty.description || 'duty').slice(0, 80) + ' · fim real ' + newEnd.slice(0, 16) + ' · −' + Math.round(delta / 36) / 100 + 'h').slice(0, 200),
    })
    return NextResponse.json({ ok: true, removed_seconds: delta, new_total_seconds: newTotal })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
