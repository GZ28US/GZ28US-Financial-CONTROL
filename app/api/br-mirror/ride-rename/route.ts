import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'

// COMMON cars live in BOTH apps under the SAME code (e.g. US.038). A rename in the
// US app renames the BR system too: code, name and the BR invoices that carry the
// code. Self-gating — if BR has no ride with the old code, nothing happens.
//
// Até 11/set a tela de edição do ride fazia isto direto pelo cliente `supabaseBR`
// anon (a ponte respondia 503): o RLS do BR devolvia null, o carro "não era comum"
// e o rename nunca chegou ao BR — nem a pasta BR do Dropbox era renomeada.
//
// O NOVO CÓDIGO E O NOME VÊM DO BANCO DO US, não do navegador: a tela grava o ride
// antes de chamar, e a rota confere o que ficou gravado. Do navegador só vem o id do
// ride e o código ANTIGO (que o banco do US já não tem mais).
//
// Corpo: { usRideId, oldCode }  →  { ok, common, rideRenamed?, brRideId?, renamedInvoices? }
// `common` (o carro existe no BR) e `rideRenamed` (o ride do BR recebeu o código
// novo) vão também na resposta de erro quando já se sabe. A tela renomeia a pasta
// BR do Dropbox só com `rideRenamed`: código duplicado no BR ou UPDATE recusado
// deixam o ride com o código velho, e a pasta não pode andar sozinha.

export const dynamic = 'force-dynamic'

const falha = (status: number, kind: string, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, kind, error, ...extra }, { status })

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return falha(401, 'auth', 'Sessão do app ausente ou vencida — entre de novo.')
  const br = supabaseBRService()
  if (!br) return falha(503, 'service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o banco do BR não pode ser consultado.')
  const usUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const usKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!usUrl || !usKey) return falha(503, 'service-key', 'SUPABASE_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o ride do US não pode ser lido.')
  const us = createClient(usUrl, usKey, { auth: { persistSession: false } })

  const b = await req.json().catch(() => ({}))
  const usRideId = String(b?.usRideId || '').trim()
  const oldCode = String(b?.oldCode || '').trim()
  if (!usRideId) return falha(400, 'bad-request', 'usRideId obrigatório.')

  const { data: ride, error: eRide } = await us.from('rides').select('project_code, project_name').eq('id', usRideId).maybeSingle()
  if (eRide) return falha(502, 'db', 'Falha ao ler o ride no banco do US: ' + eRide.message)
  if (!ride) return falha(404, 'not-found', `Ride ${usRideId} não existe no banco do US.`)
  const newCode = String(ride.project_code || '').trim()
  if (!oldCode || !newCode) return NextResponse.json({ ok: true, common: false })

  const { data: brRides, error: eBr } = await br.from('rides').select('id').eq('project_code', oldCode).limit(2)
  if (eBr) return falha(502, 'db', `Falha ao procurar ${oldCode} no banco do BR: ${eBr.message}`)
  if (!brRides?.length) return NextResponse.json({ ok: true, common: false })
  if (brRides.length > 1) return falha(409, 'conflict', `Há mais de um ride com o código ${oldCode} no BR — nada foi renomeado lá.`, { common: true, rideRenamed: false })

  const brRideId = String(brRides[0].id)
  const { error: eUpd } = await br.from('rides').update({ project_code: newCode, project_name: ride.project_name || null }).eq('id', brRideId)
  if (eUpd) return falha(502, 'db', `Falha ao renomear ${oldCode} no BR: ${eUpd.message}`, { common: true, rideRenamed: false })

  let renamedInvoices = 0
  if (oldCode !== newCode) {
    const { data: binvs, error: eInv } = await br.from('invoices').select('id, invoice_code').eq('ride_id', brRideId)
    if (eInv) return falha(502, 'db', `Ride renomeado no BR, mas as invoices dele não puderam ser lidas: ${eInv.message}`, { common: true, rideRenamed: true })
    const fails: string[] = []
    for (const inv of binvs || []) {
      if (inv.invoice_code?.startsWith(oldCode + '.')) {
        const { error } = await br.from('invoices').update({ invoice_code: newCode + inv.invoice_code.slice(oldCode.length) }).eq('id', inv.id)
        if (error) fails.push(`${inv.invoice_code}: ${error.message}`)
        else renamedInvoices++
      }
    }
    if (fails.length) {
      return falha(502, 'db', `Ride renomeado no BR, mas ${fails.length} invoice(s) não mudaram de código: ${fails.join(' | ')}`, { common: true, rideRenamed: true, renamedInvoices })
    }
  }
  return NextResponse.json({ ok: true, common: true, rideRenamed: true, brRideId, renamedInvoices })
}
