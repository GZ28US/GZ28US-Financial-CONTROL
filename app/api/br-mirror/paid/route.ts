import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'

// ── ESTE ARQUIVO ESCREVE NO BANCO DO BR, QUE NÃO FOI RENOMEADO (onda 2, 11/set/2026) ─
// Os cinco renames (invoice_payments→invoice_incomes, invoice_parts→invoice_items,
// goods→assets, good_expenses→assets_expenses, expenses→staff_expenses) valeram SÓ no
// banco do US. Aqui todo `br.from(...)` fala com o projeto Supabase do GZ28BR, onde os
// nomes velhos seguem vivos — e as duas tabelas que este arquivo toca (`invoices` e
// `invoice_expenses`) não mudam de nome em lugar nenhum. Nada a trocar neste arquivo.
//
// ── US shopping-invoice income PAID  ->  the BR invoice's GZ28US bills go PAID ──
// O servidor do espelho de lib/brPaidMirror.ts (a regra e o porquê moram lá).
// Linked by BR invoices.us_invoice_id -> US invoices.id: invoice que não é espelho
// de uma invoice do BR responde ok com mirrored:false — isso é resposta, não falha.
//
// Até 11/set isto rodava no navegador pelo cliente `supabaseBR` anon (a ponte
// respondia 503) e o RLS do BR devolvia [] — o PAID nunca chegou ao BR por aqui, e
// ninguém soube. Agora é a chave de serviço do BR, e cada UPDATE confere o erro.
//
// Corpo: { usInvoiceId, paidDate }  (paidDate YYYY-MM-DD, ou null para desmarcar)

export const dynamic = 'force-dynamic'

const falha = (status: number, kind: string, error: string) => NextResponse.json({ ok: false, kind, error }, { status })

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return falha(401, 'auth', 'Sessão do app ausente ou vencida — entre de novo.')
  const br = supabaseBRService()
  if (!br) return falha(503, 'service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o PAID não pode ser espelhado no BR.')

  const b = await req.json().catch(() => ({}))
  const usInvoiceId = String(b?.usInvoiceId || '').trim()
  if (!usInvoiceId) return falha(400, 'bad-request', 'usInvoiceId obrigatório.')
  const value = /^\d{4}-\d{2}-\d{2}$/.test(String(b?.paidDate || '')) ? String(b.paidDate) : null

  const { data, error } = await br.from('invoices').select('id').eq('us_invoice_id', usInvoiceId).limit(1)
  if (error) return falha(502, 'db', 'Falha ao procurar a invoice espelhada no BR: ' + error.message)
  const brInvoiceId = data?.[0]?.id
  if (!brInvoiceId) return NextResponse.json({ ok: true, mirrored: false }) // not a BR-mirrored invoice — nothing to do

  // Merchandise GZ28US paid for, then the Florida tax owed to the US unit.
  const merch = await br.from('invoice_expenses').update({ payment_date: value }).eq('invoice_id', brInvoiceId).eq('source', 'GZ28US').select('id')
  if (merch.error) return falha(502, 'db', 'Falha ao marcar as mercadorias do GZ28US no BR: ' + merch.error.message)
  const tax = await br.from('invoice_expenses').update({ payment_date: value }).eq('invoice_id', brInvoiceId).eq('supplier', 'GZ28US').select('id')
  if (tax.error) return falha(502, 'db', 'Mercadorias marcadas no BR, mas a linha do Florida tax não: ' + tax.error.message)

  return NextResponse.json({ ok: true, mirrored: true, brInvoiceId, paymentDate: value, merchandise: merch.data?.length || 0, floridaTax: tax.data?.length || 0 })
}
