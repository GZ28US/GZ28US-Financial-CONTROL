import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sincronizarEspelhoCliente } from '@/lib/clientPaidMirror.server'
import { requireUser } from '@/lib/auth.server'

// PAID FROM CLIENT — o gatilho do espelho.
//
// Fica no SERVIDOR, e não dentro do save da tela, pela lição de 09/set: metade
// do app não passa por tela nenhuma. Os robôs do AutoBook, o e-mail de hora em
// hora e qualquer PATCH no PostgREST escrevem direto no banco — se o gatilho
// morasse só no save, metade das despesas do cliente nunca ganharia o espelho,
// exatamente como aconteceu com os recibos que não chegavam na pasta.
//
// A tela chama isto ao salvar (resposta imediata) e o cron varre de duas em
// duas horas (rede de segurança para quem não passa pela tela). Idempotente:
// rodar duas vezes não duplica — o índice único em `mirror_expense_id` garante.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const cron = (req.headers.get('authorization') || '') === `Bearer ${process.env.CRON_SECRET}`
  // Rota que ESCREVE não fica aberta: usuário logado ou o cron, mais nada.
  if (!cron && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const invoiceId = String(b?.invoiceId || '')
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId obrigatório' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Quote não tem espelho: ela ainda não é dinheiro de ninguém.
  const { data: inv } = await db.from('invoices').select('id, is_quote').eq('id', invoiceId).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'invoice não existe' }, { status: 404 })
  if (inv.is_quote) return NextResponse.json({ ok: true, result: 'quote — sem espelho' })

  const r = await sincronizarEspelhoCliente(db, invoiceId)
  if (r.erros.length) console.error('[client-mirror]', invoiceId, r.erros.join(' | '))
  return NextResponse.json({ ok: r.erros.length === 0, cron, ...r })
}
