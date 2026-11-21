import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireStaff } from '@/lib/auth.server'
import { postDealSheet } from '@/lib/dealRobot.server'

// CAR DEALS — postar a planilha (xlsx + pdf) nos destinos do deal (21/11/2026).
// SÓ GENTE LOGADA dispara esta rota (requireStaff: JWT de uma pessoa, conta-robô recusada). Dois modos:
//   { deal, auto: true }   chamado pela tela logo depois de um CONFIRM. Só manda com as DUAS chaves ligadas
//                          (app_settings car_deals.auto_post E car_deals.auto_post do deal) e nunca repete planilha igual.
//   { deal, auto: false }  o botão POST NOW da aba TRIPA SHEET, depois de a pessoa ver os destinos e confirmar.
// Quem fala com o WhatsApp é a rota /api/whatsapp, com a credencial de quem pediu: cada envio fica no wa_send_log.
export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 500 })
  const body = await req.json().catch(() => ({}))
  const dealId = String(body.deal || '')
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return NextResponse.json({ error: 'deal id missing' }, { status: 400 })
  const authorization = req.headers.get('authorization') || ''
  const origin = req.nextUrl.origin
  try {
    const r = await postDealSheet(createClient(url, key, { auth: { persistSession: false } }), dealId, {
      auto: body.auto === true, force: body.force === true,
      send: async (p) => {
        const res = await fetch(`${origin}/ca/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(p) })
        const j = await res.json().catch(() => ({}))
        return { ok: res.ok && !j.error, error: res.ok && !j.error ? null : String(j.error || `HTTP ${res.status}`).slice(0, 200) }
      },
    })
    return NextResponse.json({ ...r, by: staff.email })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
