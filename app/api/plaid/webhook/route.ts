import { NextRequest, NextResponse, after } from 'next/server'
import { bankDb, syncBankItem } from '@/lib/plaid.server'
import { autoBook } from '@/lib/bankReconcile.server'

// O Plaid avisa aqui quando o banco posta transação nova (PC fechado, ninguém
// clicou em nada). O corpo só diz QUAL conexão mexeu; a resposta é sincronizar
// aquela conexão — o sync por cursor é idempotente, então um webhook forjado ou
// repetido no máximo dispara uma sincronização à toa, nunca duplica dinheiro.
// AUTO-BOOK (BL 0.8.0): quando o sync trouxe linha nova, o motor automático
// roda em SEGUNDO PLANO (after) com 35 s de orçamento e a trava de rodada única
// em bank_auto_runs — um webhook forjado só provoca uma rodada sobre estado
// determinístico; o chamador não molda dinheiro. O 6/6h do cron é a casa real.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const type = String(body.webhook_type || '')
  const itemId = String(body.item_id || '')
  if (type !== 'TRANSACTIONS' || !itemId) return NextResponse.json({ ok: true, ignored: type || 'no-type' })
  const db = bankDb()
  const { data: item } = await db.from('bank_accounts').select('*').eq('plaid_item_id', itemId).maybeSingle()
  if (!item || item.status !== 'ACTIVE') return NextResponse.json({ ok: true, ignored: 'unknown-or-inactive item' })
  try {
    const r = await syncBankItem(db, item)
    if ((r.added || 0) > 0 || (r.modified || 0) > 0) after(() => autoBook(db, { trigger: 'webhook', deadlineMs: 35_000 }))
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) })
  }
}
