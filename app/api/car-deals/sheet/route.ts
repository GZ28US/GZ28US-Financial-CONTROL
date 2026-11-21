import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { buildDealSheet, dealSheetPdf, dealSheetXlsx } from '@/lib/dealSheet.server'

// CAR DEALS — a planilha no layout do Tripa (21/11/2026). SÓ GERA: esta rota não manda nada a ninguém.
//   GET ?deal=<id>&format=json  → a grade (prévia na tela) + totais + hash do conteúdo
//   GET ?deal=<id>&format=xlsx  → o Excel
//   GET ?deal=<id>&format=pdf   → o PDF
// Entra tela logada (sessionHeaders) ou sessão/script com x-read-key.
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 })
  const dealId = req.nextUrl.searchParams.get('deal') || ''
  const format = (req.nextUrl.searchParams.get('format') || 'json').toLowerCase()
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return NextResponse.json({ error: 'deal id missing' }, { status: 400 })
  try {
    const sheet = await buildDealSheet(createClient(url, key, { auth: { persistSession: false } }), dealId)
    if (!sheet) return NextResponse.json({ error: 'deal not found' }, { status: 404 })
    if (format === 'xlsx' || format === 'pdf') {
      const buf = format === 'xlsx' ? await dealSheetXlsx(sheet) : dealSheetPdf(sheet)
      const name = `${sheet.fileName}.${format}`
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
          'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return NextResponse.json(sheet)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
