import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { evaluateDuties, sendNudges } from '@/lib/staffDutyWatch.server'

// DUTY WATCH (cron 30/30min): timer esquecido / duties simultâneas / virada de
// noite → aviso no WhatsApp da própria pessoa, um por duty por dia, escalação
// pro grupo se ninguém pausar. Regras e janelas em lib/dutyWatch.server.ts.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const incidents = await evaluateDuties(db)
    const sent = await sendNudges(db, incidents)
    return NextResponse.json({ ok: true, at: new Date().toISOString(), incidents: incidents.length, ...sent })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
