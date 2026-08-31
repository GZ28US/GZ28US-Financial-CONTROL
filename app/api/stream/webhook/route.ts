import { NextResponse } from 'next/server'

// ═══ STREAM LEGADO MORTO, NÃO APAGADO (Márcio, 30/ago/2026): "quero ele totalmente morto, sem mais nenhuma ação... como se tivesse sido apagado." ═══
// Esta rota existia SÓ para o quadro velho (webhook de push do 17TRACK para part_streams). Ela responde 410 Gone em
// vez de sumir: URL órfã não quebra nada, e quem chamar entende o porquê.
// Se o 17TRACK ainda estiver com este webhook configurado, ele recebe 410 e nada é gravado.
// O código legado segue no repo (lib/stream*.server.ts), inerte.

export const dynamic = 'force-dynamic'

const dead = () => NextResponse.json({
  ok: false, gone: true,
  reason: 'STREAM legado morto em 30/ago/2026 por ordem do dono — sem nenhuma ação. O status dos itens vive na origem (deliver badge) e o rastreio novo é /api/items/track.',
}, { status: 410 })

export async function GET() { return dead() }
export async function POST() { return dead() }
