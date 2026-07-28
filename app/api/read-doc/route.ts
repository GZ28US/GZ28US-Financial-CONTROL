import { NextRequest, NextResponse } from 'next/server'

// LEITOR DE DOCUMENTO — pergunta livre sobre um PDF ou imagem, respondida pela
// visão da Anthropic com a chave que já vive no servidor.
//
// Nasceu do extrato do Regions (28/jul/2026): o PDF do banco perde o alinhamento
// no texto puro e a coluna de valor desgruda da linha, então "quanto foi pago ao
// Iskas Corp em 03/06" não sai de grep nenhum. O /api/scan-receipt não serve:
// o prompt dele é fixo para recibo de compra.
//
// POST { key, base64, mediaType, question }
//   → { answer: "<texto do modelo>" }
// Serve para qualquer documento do negócio: extrato, contrato, carta, apólice.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  const body = await req.json().catch(() => ({}))
  if (need && body.key !== need) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 })
  const { base64, mediaType, question } = body as { base64?: string; mediaType?: string; question?: string }
  if (!base64 || !mediaType || !question) return NextResponse.json({ error: 'base64, mediaType and question are required' }, { status: 400 })

  const isPDF = mediaType === 'application/pdf'
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          isPDF
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: question },
        ],
      }],
    }),
  })
  if (!r.ok) return NextResponse.json({ error: `anthropic ${r.status}`, detail: (await r.text()).slice(0, 400) }, { status: 502 })
  const data = await r.json()
  return NextResponse.json({ answer: String(data?.content?.[0]?.text || '') })
}
