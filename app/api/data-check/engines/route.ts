import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { enginesAudit } from '@/lib/enginesAudit.server'

// OS DOIS MOTORES CONCORDAM? (DC 1.49.0) — sinal do card: o robô de e-mail (AUTO-BOOK) e o motor do Bank Link,
// lado a lado, SÓ LEITURA. Nunca escreve nas tabelas de nenhum dos dois; quem age é o card, pelas rotas de sempre.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const audit = await enginesAudit(bankDb())
    return NextResponse.json({ ok: true, ...audit })
  } catch (e) {
    const msg = String((e as Error).message || e)
    // Tabelas do robô ainda sem migration = sinal, não erro de página.
    return NextResponse.json({ error: msg.slice(0, 300), needs_migration: /auto_book_mail/.test(msg) && /does not exist|relation|schema cache|PGRST205|42P01/.test(msg) }, { status: 500 })
  }
}
