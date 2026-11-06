/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb, loadDocState } from '@/lib/quoteDoc.server'
import { actionRank } from '@/lib/quoteStage'

// ACTION NEEDED INDEX + CODE RESOLVER (06/11/2026; blueprint §2.2 /doc). GET /ca/api/doc/index[?code=US.QT.028.1]
//   ?code → { id } (live code first; then a "formerly" match from the HIRED event's old code)
//   none  → every document with a portal revision, ordered by what needs the owner first, plus the open quotes without one.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'staff only' }, { status: 403 })
  const db = serviceDb()
  const code = (req.nextUrl.searchParams.get('code') || '').trim()
  if (code) {
    const { data: live } = await db.from('invoices').select('id, invoice_code').ilike('invoice_code', code).limit(1)
    if (live?.length) return NextResponse.json({ id: live[0].id, code: live[0].invoice_code })
    const { data: ev } = await db.from('invoice_events').select('invoice_id, at, payload').eq('kind', 'HIRED').order('at', { ascending: false }).limit(500)
    const hit = (ev || []).find(e => String(e.payload?.invoice_code_before || '').toUpperCase() === code.toUpperCase())
    if (hit) return NextResponse.json({ id: hit.invoice_id, formerly: code, hired_at: hit.at })
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const { data: revs } = await db.from('invoice_revisions').select('invoice_id').neq('kind', 'LEGACY_BACKUP')
  const ids = [...new Set((revs || []).map(r => r.invoice_id))]
  const docs = []
  for (const id of ids) {
    const s = await loadDocState(db, id)
    if (!s) continue
    // sort key (U2-05): staff/system writes + every FIRST-of-kind client event; repeated VIEWED beacons never reorder
    const seen = new Set<string>()
    const keyEvents = s.events.filter(e => { if (e.actor !== 'CLIENT') return e.kind !== 'SIDE_EFFECT' && e.kind !== 'NOTIFY_SKIPPED'; if (seen.has(e.kind)) return false; seen.add(e.kind); return true })
    const last = keyEvents[keyEvents.length - 1]
    const sent = [...s.events].reverse().find(e => e.kind === 'SENT')
    const exp = s.terms?.valid_until || null
    const daysLeft = exp ? Math.round((Date.parse(exp + 'T12:00:00Z') - Date.now()) / 86400e3) : null
    docs.push({ id, code: s.bundle.invoice.invoice_code, rev: s.live?.seq || null, service: s.bundle.invoice.service, client: s.bundle.client?.name || '',
      client_number: s.bundle.client?.client_number || null, car: s.bundle.ride?.project_name || '', grand: s.bundle.money.grand, stage: s.stage.stage, sub: s.stage.sub,
      rank: actionRank(s.stage), last_kind: last?.kind || null, last_at: last?.at || null, is_test: s.isTest, channel: sent?.payload?.channel || null, sent_at: sent?.at || null,
      first_viewed_at: s.liveLink?.first_viewed_at || null, last_viewed_at: s.liveLink?.last_viewed_at || null, signed_at: s.approvalOnLive?.signed_at || null,
      language: s.terms?.language || 'en', rails: s.terms?.rails || [], days_left: daysLeft, received: s.bundle.received })
  }
  docs.sort((a, b) => a.rank - b.rank || String(b.last_at || '').localeCompare(String(a.last_at || '')))
  const { data: quotes } = await db.from('invoices').select('id, invoice_code, service, updated_at, live_status, rides(project_name, clients(name)), clients(name)')
    .eq('is_quote', true).order('updated_at', { ascending: false }).limit(200)
  const withRev = new Set(ids)
  const drafts = (quotes || []).filter(q => !withRev.has(q.id)).map((q: any) => ({ id: q.id, code: q.invoice_code, service: q.service,
    client: q.clients?.name || q.rides?.clients?.name || '', car: q.rides?.project_name || '', updated_at: q.updated_at, live_status: q.live_status }))
  return NextResponse.json({ docs, drafts })
}
