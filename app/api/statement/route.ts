import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { loadSchedule, statementFor, statementPdf, statementXlsx } from '@/lib/statement.server'
import { leakingRows, type StatementView } from '@/lib/statement'

// CONTA-CORRENTE DO CLIENTE (21/11/2026). SÓ GERA: esta rota não manda nada a ninguém.
//   GET ?client=<id>&view=GZ28|CLIENT|ACCOUNTANT[&ride=<id>]&format=json|xlsx|pdf
// Entra tela logada (sessionHeaders) ou sessão/script com x-read-key.
export const runtime = 'nodejs'
export const maxDuration = 120

const dayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 })
  const sp = req.nextUrl.searchParams
  const clientId = sp.get('client') || '', rideId = sp.get('ride') || undefined
  const v = String(sp.get('view') || 'GZ28').toUpperCase()
  const view: StatementView = v === 'CLIENT' ? 'CLIENT' : v === 'ACCOUNTANT' ? 'ACCOUNTANT' : 'GZ28'
  const format = String(sp.get('format') || 'json').toLowerCase()
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return NextResponse.json({ error: 'client id missing' }, { status: 400 })
  try {
    const db = createClient(url, key, { auth: { persistSession: false } })
    const { data, statement } = await statementFor(db, clientId, view, rideId)
    if (!data.client) return NextResponse.json({ error: 'client not found' }, { status: 404 })
    const asOf = dayNY(), clientName = String(data.client.name || '')
    // TRAVA: arquivo para cliente ou contador não sai com linha que cite o exportador — corrija o texto na invoice primeiro
    const leaks = view === 'GZ28' ? [] : leakingRows(statement.rows)
    if (leaks.length && (format === 'xlsx' || format === 'pdf')) {
      return NextResponse.json({ error: `${leaks.length} line(s) of the ${view} version mention the exporter (Tripa / Edison / Tamiami / EMC). Fix the text on the invoice before generating the file.`, leaks: leaks.map(r => ({ date: r.date, code: r.code, item: r.item })) }, { status: 409 })
    }
    if (format === 'xlsx' || format === 'pdf') {
      const buf = format === 'xlsx' ? await statementXlsx(statement, { asOf, view, clientName }) : statementPdf(statement, { asOf, view, clientName })
      const name = `Conta Corrente ${asOf.slice(8, 10)}-${asOf.slice(5, 7)}-${asOf.slice(2, 4)}${view === 'GZ28' ? ' (GZ28)' : view === 'CLIENT' ? ' (cliente)' : ''}.${format}`
      return new NextResponse(new Uint8Array(buf), { headers: {
        'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
        'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store',
      } })
    }
    return NextResponse.json({ client: data.client, view, asOf, ...statement, leaks: leaks.map(r => r.key), schedule: await loadSchedule(db, data), counts: { invoices: data.invoices.length, incomes: data.incomes.length, movements: data.movements.length, allocations: data.allocations.length } })
  } catch (err) {
    return NextResponse.json({ error: String((err as Error)?.message || err) }, { status: 500 })
  }
}
