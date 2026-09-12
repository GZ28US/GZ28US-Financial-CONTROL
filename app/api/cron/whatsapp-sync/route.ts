import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { waDb, waSyncInstance } from '@/lib/waStore.server'

// WHATSAPP HUB — rede de segurança (cron 10/10min): o webhook é o caminho
// primário (tempo real); este sync atualiza o snapshot dos chats (nome, unread,
// last_at), relê os que mexeram (pega o que um webhook perdido deixou pra trás)
// e puxa 1 página do log da instância pra curar links de mídia. Idempotente —
// o UNIQUE (app, message_id) não deixa duplicar.
//
// Backfill manual (uma vez, depois do deploy):
//   GET /ca/api/cron/whatsapp-sync?key=<WHATSAPP_READ_KEY>&deep=1[&start=N]
// deep varre TODOS os chats (200 msgs cada) + 6 páginas do log; se estourar o
// tempo devolve nextStart — repetir com &start=<nextStart> até nextStart: null.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // PORTÃO ÚNICO (11/set/2026): a checagem à mão virou lib/apiAuth.server.ts, pra
  // troca de chave mexer num lugar só. Aceita o cron da Vercel (Bearer CRON_SECRET)
  // ou a chave de leitura no header x-read-key; `?key=` segue valendo enquanto os
  // scripts das sessões e o atalho do iPhone não migram (a chave na URL vai parar
  // em todo log de acesso). As duas comparações falham fechadas.
  if (!cronOk(req) && !readKeyOk(req, { allowQuery: true })) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'UltraMsg not configured' }, { status: 503 })

  const deep = req.nextUrl.searchParams.get('deep') === '1'
  const start = parseInt(req.nextUrl.searchParams.get('start') || '0') || 0

  try {
    const result = await waSyncInstance({ app: 'US', instance, token, db: waDb(), deep, start })
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...result })
  } catch (e) {
    console.error('[whatsapp-sync]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
