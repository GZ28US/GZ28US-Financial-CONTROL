import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { bancosDoServidor, chaveDaInvoice, ErroTravessia, resumoAlvo, sincronizar } from '@/lib/crossing.server'

// ── APOSENTADA EM 14/SET/2026: O ESPELHO VELHO US → BR 085.N VIROU O MOTOR DA TRAVESSIA ─────
// Esta rota era o espelho de 25/ago: a cada save de invoice do US ela lia as despesas PAID FROM GZ28BR
// e reescrevia a 085.N do cliente BR.085 no banco do BR — APAGAVA e recriava os itens (invoice_parts)
// e o Pending balance, e recalculava o R$ de TODA linha pelo dólar do dia do save, por cima do valor
// gravado. Com o motor da travessia (lib/crossing.server.ts) isso vira briga: cada save desfaria o
// que o motor carimbou uma vez e ligou por mirror_src.
//
// O editor do US agora chama /api/crossing direto (lib/brShoppingMirror.ts). Esta rota fica de pé só
// para a ABA VELHA — tela aberta antes do deploy, com o JavaScript antigo, que ainda manda
// { usInvoiceId } para cá. Ela não escreve nada por conta própria: roda o motor para a chave daquela
// invoice e devolve o formato antigo, com o ponteiro br_invoice_id LIDO DO BANCO depois do motor.
// Nunca devolve null quando o banco tem ponteiro — a tela velha grava o que recebe em br_invoice_id.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const responder = (status: number, kind: string, error: string) => NextResponse.json({ ok: false, kind, error }, { status })
const STATUS: Record<ErroTravessia['kind'], number> = { 'bad-request': 400, 'service-key': 503, schema: 409, conflict: 409, db: 502, rate: 422 }

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return responder(401, 'auth', 'Sessão do app ausente ou vencida — entre de novo e salve outra vez.')
  const bancos = bancosDoServidor()
  if ('erro' in bancos) return responder(503, 'service-key', bancos.erro)
  const b = await req.json().catch(() => ({}))
  const usInvoiceId = String(b?.usInvoiceId || '').trim()
  if (!usInvoiceId) return responder(400, 'bad-request', 'usInvoiceId obrigatório.')
  try {
    const { key } = await chaveDaInvoice(bancos, 'US', usInvoiceId)
    const r = key ? await sincronizar(bancos, { keys: [key], limiteMs: 200_000, origem: 'editor' }) : null
    const erro = r?.chaves.find(c => c.resultado === 'erro')
    if (erro) return responder(502, 'db', erro.motivo || 'a travessia parou no meio da escrita')
    const { data: inv, error } = await bancos.us.from('invoices').select('br_invoice_id').eq('id', usInvoiceId).maybeSingle()
    if (error) return responder(502, 'db', 'Falha ao reler o ponteiro br_invoice_id: ' + error.message)
    const resumo = key && key.startsWith('US:') ? await resumoAlvo(bancos, key).catch(() => null) : null
    return NextResponse.json({
      ok: true,
      brInvoiceId: inv?.br_invoice_id ?? null,
      code: resumo?.codigo ?? null,
      totalBrl: resumo?.grand ?? 0,
      totalUsd: 0,
      deleted: false,
      keptPaid: false,
    })
  } catch (e) {
    if (e instanceof ErroTravessia) return responder(STATUS[e.kind], e.kind, e.message)
    return responder(502, 'db', e instanceof Error ? e.message : String(e))
  }
}
