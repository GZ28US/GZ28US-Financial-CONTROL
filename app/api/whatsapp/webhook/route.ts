import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { waNormalize, waStore, waTouchChat, waDb } from '@/lib/waStore.server'

// ── WEBHOOK DO WHATSAPP (UltraMsg) — a porta de entrada do FINANCEIRO ─────────
// Ordem do Márcio (27/jul/2026): "the FINANCEIRO group is the MOST IMPORTANT
// group of the BR shop — scan it every 5 minutes or less, 24/7, com o PC
// desligado". O gargalo era a mídia: a API /chats/messages NÃO devolve o link
// das imagens/PDFs; só o webhook, no instante da chegada, entrega `media`.
//
// Então TODA mensagem que chega no grupo é gravada aqui em `financeiro_inbox`
// (texto + autor + link da mídia + timestamp), com status PENDING. O cron de 5
// min (lib/financeiroBot.server.ts) processa a fila: baixa o comprovante,
// entende o destino, lança no app, reporta nos dois grupos e reage ✅.
//
// Configurar na UltraMsg (Instance → Webhook) ou via /instance/settings:
//   https://www.gz28us.com/ca/api/whatsapp/webhook?key=<WHATSAPP_READ_KEY>
// Responde 200 sempre — webhook que falha vira tempestade de retry.

export const dynamic = 'force-dynamic'

const FINANCEIRO_GROUP = '120363165796147113@g.us'

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (need && req.nextUrl.searchParams.get('key') !== need) {
    return NextResponse.json({ error: 'bad key' }, { status: 401 })
  }
  const payload = await req.json().catch(() => null)
  const d = payload?.data || payload

  // WHATSAPP HUB (24/ago/2026): além do FINANCEIRO, TODA mensagem do número US
  // (recebida ou nossa) vira linha no espelho whatsapp_messages — o histórico
  // permanente que a UltraMsg não guarda. Best-effort: erro aqui nunca derruba
  // o webhook nem o fluxo do FINANCEIRO.
  try {
    const row = waNormalize(d, 'US', 'webhook')
    if (row) {
      const mirror = waDb()
      await waStore(mirror, [row])
      await waTouchChat(mirror, 'US', row.chat_id, row.sent_at)
    }
  } catch (e) {
    console.error('[whatsapp-webhook] mirror', e)
  }

  try {
    const chatId = String(d?.chatId || d?.from || '')
    // Só o FINANCEIRO por enquanto: é o grupo que vira dinheiro no app.
    if (chatId.includes(FINANCEIRO_GROUP.split('@')[0])) {
      const supabase = db()
      const msgId = String(d?.id || d?.msgId || '')
      const { data: dup } = await supabase.from('financeiro_inbox').select('id').eq('message_id', msgId).limit(1)
      if (!dup?.length) {
        await supabase.from('financeiro_inbox').insert({
          message_id: msgId,
          author: String(d?.pushname || d?.author || d?.from || '').slice(0, 120),
          from_me: !!d?.fromMe,
          type: String(d?.type || 'chat').slice(0, 24),
          body: String(d?.body || d?.caption || '').slice(0, 4000),
          media_url: d?.media ? String(d.media) : null,
          sent_at: d?.time ? new Date(Number(d.time) * 1000).toISOString() : new Date().toISOString(),
          status: 'PENDING',
        })
      }
    }
  } catch (e) {
    console.error('[whatsapp-webhook]', e)
  }
  return NextResponse.json({ received: true })
}
