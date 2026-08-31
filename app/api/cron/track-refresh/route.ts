import { NextResponse } from 'next/server'

// ═══ STREAM LEGADO MORTO, NÃO APAGADO (Márcio, 30/ago/2026): "quero ele totalmente morto, sem mais nenhuma ação... como se tivesse sido apagado." ═══
// Esta rota existia SÓ para o quadro velho (refresh horário do 17TRACK sobre part_streams). Ela responde 410 Gone em
// vez de sumir: URL órfã não quebra nada, e quem chamar entende o porquê.
// O rastreio dos itens roda em /api/items/track (cron :37), sobre a linha do item.
// O código legado segue no repo (lib/stream*.server.ts), inerte.

export const dynamic = 'force-dynamic'

const dead = () => NextResponse.json({
  ok: false, gone: true,
  reason: 'STREAM legado morto em 30/ago/2026 por ordem do dono — sem nenhuma ação. O status dos itens vive na origem (deliver badge) e o rastreio novo é /api/items/track.',
}, { status: 410 })

export async function GET() { return dead() }
export async function POST() { return dead() }
