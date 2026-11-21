import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { scanDealGroups } from '@/lib/dealRobot.server'

// CAR DEALS — o robô lê os comprovantes postados nos grupos COMPRA e cria movimentos PROPOSED (21/11/2026).
// Chave app_settings `car_deals.group_scan`: DESLIGADA = a rota volta na hora, sem ler nada nem gastar a Anthropic.
// O robô nunca aloca nem confirma, e não manda mensagem a ninguém.
//   ?dry=1 (só com a chave de leitura) lê e diz o que proporia, sem gravar — vale mesmo com a chave desligada.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 })
  const dry = req.nextUrl.searchParams.get('dry') === '1' && readKeyOk(req)
  const max = Math.min(40, Math.max(1, parseInt(req.nextUrl.searchParams.get('scans') || '15') || 15))
  try {
    const r = await scanDealGroups(createClient(url, key, { auth: { persistSession: false } }), { max, deadline: Date.now() + 270_000, dry, force: dry })
    return NextResponse.json({ ok: true, dry, ...r })
  } catch (e) {
    console.error('[car-deals robot]', e)
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
  }
}
