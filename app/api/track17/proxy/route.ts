import { NextRequest, NextResponse } from 'next/server'

// O 17TRACK ATENDIDO POR UMA CONTA SÓ.
//
// ── POR QUE ISTO EXISTE (09/set/2026) ──────────────────────────────────────
// O rastreio do app BR nunca rodou: faltava `TRACK17_API_KEY` naquele projeto
// da Vercel. O conserto óbvio seria publicar a mesma chave lá — e aí a gente
// descobriu que a chave que funciona aqui não está em conta ligada a nenhuma
// das seis caixas de e-mail. Procurar a conta é caçada; copiar a chave é
// espalhar segredo. Nenhum dos dois é o certo.
//
// O certo é o BR PERGUNTAR AO US, que já tem a chave e já fala com o 17TRACK:
//
//   • UMA CONTA, UMA COTA. O 17TRACK cobra por rastreio registrado. Com duas
//     chaves paga-se o mesmo pacote duas vezes e ninguém sabe qual estourou.
//   • O SEGREDO NÃO SE MULTIPLICA. A chave continua num lugar só — esta rota
//     NUNCA a devolve, só o resultado da consulta.
//   • O CAMINHO JÁ EXISTIA. O app do BR já chama o do US com `GZ28US_READ_KEY`
//     (lib/financeiroBot.server.ts), que é a mesma `WHATSAPP_READ_KEY` daqui.
//
// SÓ DUAS OPERAÇÕES PASSAM, e a lista é fechada de propósito: `gettrackinfo`
// (perguntar onde está) e `register` (avisar ao 17TRACK que passe a seguir um
// número). Proxy que aceita caminho livre vira porta de qualquer coisa na conta
// de outro — aqui o que não está na lista não passa.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const T17 = 'https://api.17track.net/track/v2.2'
const PERMITIDAS = new Set(['gettrackinfo', 'register'])

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({} as Record<string, unknown>))
  const need = process.env.WHATSAPP_READ_KEY
  if (!need || String(b?.key || '') !== need) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const path = String(b?.path || '')
  if (!PERMITIDAS.has(path)) {
    return NextResponse.json({ error: `path não permitido: ${path || '(vazio)'}` }, { status: 400 })
  }
  if (!Array.isArray(b?.payload)) {
    return NextResponse.json({ error: 'payload tem de ser uma lista de rastreios' }, { status: 400 })
  }
  // Teto igual ao que o 17TRACK aceita por chamada — quem pede mais está
  // errado, e é melhor dizer isso do que deixar a transportadora recusar.
  if ((b.payload as unknown[]).length > 40) {
    return NextResponse.json({ error: 'no máximo 40 rastreios por chamada' }, { status: 400 })
  }

  const key = process.env.TRACK17_API_KEY
  // Sem chave AQUI a resposta é 503 e não 200: quem chamou precisa saber que
  // não foi consultado nada. Silêncio com cara de sucesso foi o defeito que
  // deixou o rastreio do BR parado por meses.
  if (!key) return NextResponse.json({ error: 'TRACK17_API_KEY missing no app US' }, { status: 503 })

  try {
    const r = await fetch(`${T17}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', '17token': key },
      body: JSON.stringify(b.payload),
    })
    const j = await r.json().catch(() => null)
    // A resposta do 17TRACK vai inteira, inclusive `code` != 0: quem chamou tem
    // a mesma leitura que teria com a chave na mão. O que não vai é a chave.
    return NextResponse.json({ ok: j?.code === 0, httpStatus: r.status, data: j }, { status: r.ok ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e).slice(0, 200) }, { status: 502 })
  }
}
