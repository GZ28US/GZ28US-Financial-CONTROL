import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { evaluateDuties, MAX_HOURS } from '@/lib/staffDutyWatch.server'

// Sinal do DUTY WATCH pro Data Checker (card STAFF): os incidentes de AGORA,
// sem mandar aviso nenhum (quem avisa é o cron). Sessão obrigatória.
export const maxDuration = 30

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const incidents = await evaluateDuties(db)
    // avisos já mandados hoje (pra tela dizer "avisado às…")
    const keys = incidents.map(i => i.key)
    const { data: nudges } = keys.length
      ? await db.from('data_fixes').select('row_id, fixed_at, new_value').eq('check_key', 'duty-nudge').in('row_id', [...keys, ...keys.map(k => k + ':esc')])
      : { data: [] as { row_id: string; fixed_at: string; new_value: string }[] }
    return NextResponse.json({
      ok: true, max_hours: MAX_HOURS,
      incidents: incidents.map(i => ({ ...i, phone: undefined, nudged: (nudges || []).find(n => n.row_id === i.key)?.fixed_at || null, escalated: (nudges || []).some(n => n.row_id === i.key + ':esc') })),
    })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
