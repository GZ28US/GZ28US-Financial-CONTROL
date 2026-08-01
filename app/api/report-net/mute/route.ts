import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// REPORT-NET MUTE (incidente 31/jul/2026): quando o usuário responde NÃO no
// diálogo de report do editor, a escolha precisa valer também para a rede de
// segurança (expenseReportNet), que revarre tudo no cron. Este endpoint grava a
// marca de "já tratado" (ern:<kind>:<id>) no dedup da rede — a UI é a dona da
// decisão; a rede só cobre o que nunca passou por um diálogo.
// Chamado no fechamento do diálogo para TODAS as linhas listadas (enviadas ou
// recusadas) — enviar de novo nunca acontece, silenciar é respeitado.

const KEY_RE = /^(ie|ip|se):[0-9a-f-]{36}$/

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) return NextResponse.json({ ok: false, error: 'missing env' }, { status: 500 })
  const body = await req.json().catch(() => null)
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown) => typeof k === 'string' && KEY_RE.test(k)) : []
  if (keys.length === 0) return NextResponse.json({ ok: true, muted: 0 })
  const db = createClient(url, service)
  let muted = 0
  for (const k of keys) {
    const { error } = await db.from('stream_mail_moves').insert({
      message_id: `ern:${k}`,
      subject: 'muted by editor dialog',
      from_addr: 'expense-report-net',
      folder_name: 'reported',
      state: 'REPORTED',
    })
    if (!error) muted++
    // conflito (já marcada) é sucesso silencioso — idempotente por natureza
  }
  return NextResponse.json({ ok: true, muted })
}
