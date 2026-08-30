import { NextResponse } from 'next/server'
import { itemsDb, refreshItemTracking } from '@/lib/itemTracking.server'

// ── RASTREIO DOS ITENS, NA ORIGEM (Márcio, 29/ago/2026) ─────────────────────
//   "Tem rastreio, o app deve rastrear e atualizar o badge do item na pagina
//    dele, na origem, pra delivered, quando for entregue."
//
// Esta rota é o robô que cumpre essa frase. Ela NÃO toca no STREAM: lê as 5
// tabelas de item comprado (invoice_expenses, inputs, inventory, goods,
// good_expenses), pergunta à transportadora pelos números que ainda não
// chegaram e escreve a resposta NA PRÓPRIA LINHA — last_event, last_event_at,
// eta, shipped_at, delivered_at.
//
// ELA NÃO ESCREVE STATUS (Márcio, 30/ago/2026): "sem campo pra isso, e uma
// INTERPRETACAO, nao um campo. Assim a chance do app mostrar o status errado e
// zero." Antes esta rota gravava dois campos por entrega e podia mentir se
// falhasse no segundo; agora grava UM (delivered_at) e o badge segue sozinho.
//
// Duas travas que valem sempre:
//   • NUNCA DESFAZ UMA ENTREGA. delivered_at gravado não se apaga — e a consulta
//     nem traz linha entregue, então não há caminho de código para isso.
//   • picked_up NUNCA É RASTREADO. É ele que diz "peguei no balcão, não viaja" —
//     a consulta filtra picked_up = false.
// Toda escrita é registrada em data_fixes (check_key 'items-track').
//
// Agenda: vercel.json, de hora em hora aos :37 — longe do mail-poll (*/5) e do
// track-refresh do stream (:12), para nunca disputarem o mesmo minuto.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const r = await refreshItemTracking(itemsDb())
    return NextResponse.json({ ok: !r.error, ms: Date.now() - t0, ...r })
  } catch (e) {
    console.error('[items/track]', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
