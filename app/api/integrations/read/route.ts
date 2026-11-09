import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { settingOn } from '@/lib/appSettings.server'
import { nyStart, nyEnd } from '@/lib/nyDay'

// INTEGRATIONS — READ ONLY, app credentials (09/11/2026). No user OAuth here: PayPal and the carriers issue client-credential tokens
// to the APP (keys in Vercel env only, fetched per call, never stored, never returned).
//   GET /ca/api/integrations/read?what=paypal_transactions[&since=YYYY-MM-DD&until=YYYY-MM-DD][&after=<page>]   (≤ 31 days per call)
//   GET /ca/api/integrations/read?what=track&carrier=ups|fedex|usps&id=<tracking number>
// Who: x-read-key header or a logged-in screen. Labels are NOT here — buying a label costs money and will need Márcio's OK each time.
// The data feeds AutoBook (which books it) and STREAM (which tracks); this route only reads.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TRACKING = /^[A-Za-z0-9]{8,40}$/
const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
const missing = (...e: string[]) => e.filter(x => !process.env[x])

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sp = req.nextUrl.searchParams
  const what = sp.get('what')

  if (what === 'paypal_transactions') {
    if (!(await settingOn('paypal.read.enabled'))) return NextResponse.json({ error: 'paypal.read.enabled is OFF' }, { status: 403 })
    const m = missing('PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET')
    if (m.length) return NextResponse.json({ error: `not configured in Vercel: ${m.join(', ')}` }, { status: 503 })
    const since = sp.get('since') || fmt(new Date(Date.now() - 30 * 864e5)), until = sp.get('until') || fmt(new Date())
    if (!DAY.test(since) || !DAY.test(until)) return NextResponse.json({ error: 'dates are YYYY-MM-DD' }, { status: 400 })
    const page = /^\d{1,4}$/.test(sp.get('after') || '') ? sp.get('after')! : '1'
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')
    const t = await (await fetch('https://api-m.paypal.com/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json().catch(() => ({}))
    if (!t?.access_token) return NextResponse.json({ error: t?.error_description || 'PayPal token failed' }, { status: 502 })
    const u = new URL('https://api-m.paypal.com/v1/reporting/transactions')
    // PayPal wants full timestamps; the day is Orlando's.
    u.searchParams.set('start_date', nyStart(since).toISOString().replace('.000Z', 'Z'))
    u.searchParams.set('end_date', nyEnd(until).toISOString().replace('.000Z', 'Z'))
    u.searchParams.set('fields', 'all'); u.searchParams.set('page_size', '500'); u.searchParams.set('page', page)
    const r = await fetch(u, { headers: { Authorization: `Bearer ${t.access_token}` } })
    return NextResponse.json({ what, since, until, data: await r.json().catch(() => ({})) }, { status: r.ok ? 200 : 502 })
  }

  if (what === 'track') {
    if (!(await settingOn('carriers.track.enabled'))) return NextResponse.json({ error: 'carriers.track.enabled is OFF' }, { status: 403 })
    const carrier = sp.get('carrier'), id = sp.get('id') || ''
    if (!TRACKING.test(id)) return NextResponse.json({ error: 'bad tracking number' }, { status: 400 })
    if (carrier === 'ups') {
      const m = missing('UPS_CLIENT_ID', 'UPS_CLIENT_SECRET'); if (m.length) return NextResponse.json({ error: `not configured: ${m.join(', ')}` }, { status: 503 })
      const basic = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64')
      const t = await (await fetch('https://onlinetools.ups.com/security/v1/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json().catch(() => ({}))
      if (!t?.access_token) return NextResponse.json({ error: 'UPS token failed', detail: t?.response?.errors }, { status: 502 })
      const r = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${id}?locale=en_US&returnSignature=false`, { headers: { Authorization: `Bearer ${t.access_token}`, transId: crypto.randomUUID().slice(0, 32), transactionSrc: 'gz28us' } })
      return NextResponse.json({ what, carrier, id, data: await r.json().catch(() => ({})) }, { status: r.ok ? 200 : 502 })
    }
    if (carrier === 'fedex') {
      const m = missing('FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET'); if (m.length) return NextResponse.json({ error: `not configured: ${m.join(', ')}` }, { status: 503 })
      const t = await (await fetch('https://apis.fedex.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.FEDEX_CLIENT_ID!, client_secret: process.env.FEDEX_CLIENT_SECRET! }) })).json().catch(() => ({}))
      if (!t?.access_token) return NextResponse.json({ error: 'FedEx token failed' }, { status: 502 })
      const r = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', { method: 'POST', headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' }, body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: id } }] }) })
      return NextResponse.json({ what, carrier, id, data: await r.json().catch(() => ({})) }, { status: r.ok ? 200 : 502 })
    }
    if (carrier === 'usps') {
      const m = missing('USPS_CLIENT_ID', 'USPS_CLIENT_SECRET'); if (m.length) return NextResponse.json({ error: `not configured: ${m.join(', ')}` }, { status: 503 })
      const t = await (await fetch('https://apis.usps.com/oauth2/v3/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: process.env.USPS_CLIENT_ID, client_secret: process.env.USPS_CLIENT_SECRET }) })).json().catch(() => ({}))
      if (!t?.access_token) return NextResponse.json({ error: 'USPS token failed' }, { status: 502 })
      const r = await fetch(`https://apis.usps.com/tracking/v3/tracking/${id}?expand=DETAIL`, { headers: { Authorization: `Bearer ${t.access_token}` } })
      return NextResponse.json({ what, carrier, id, data: await r.json().catch(() => ({})) }, { status: r.ok ? 200 : 502 })
    }
    return NextResponse.json({ error: 'carrier = ups | fedex | usps' }, { status: 400 })
  }

  return NextResponse.json({ error: 'unknown what', whats: ['paypal_transactions', 'track'] }, { status: 400 })
}
