import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { evaluateDuties, sendNudges } from '@/lib/staffDutyWatch.server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'

// DUTY WATCH (cron 30/30min): timer esquecido / duties simultâneas / virada de
// noite → aviso no WhatsApp da própria pessoa, um por duty por dia, escalação
// pro grupo se ninguém pausar. Regras e janelas em lib/dutyWatch.server.ts.
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // PORTÃO (11/set/2026): a comparação antiga (`auth !== 'Bearer ' + CRON_SECRET`) deixava entrar quem
  // mandasse "Bearer undefined" se a variável sumisse do ambiente. Agora falha fechada: cron da Vercel
  // (Bearer CRON_SECRET) ou chave de leitura.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    const incidents = await evaluateDuties(db)
    const sent = await sendNudges(db, incidents)
    return NextResponse.json({ ok: true, at: new Date().toISOString(), incidents: incidents.length, ...sent })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300) }, { status: 500 })
  }
}
