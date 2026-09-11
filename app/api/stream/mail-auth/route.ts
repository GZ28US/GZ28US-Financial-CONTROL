import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, pkcePair, authUrl, mailProvider } from '@/lib/streamMail.server'
import { requireUser } from '@/lib/apiAuth.server'

// Mail hookup, step 1 — a SIGNED-IN admin starts it at /ca/stream/connect, then
// signs in with the target mailbox and consents. PKCE verifier + state are
// minted here, stashed in stream_mail_auth, and checked by the callback. No
// client secret exists anywhere: the Azure app is a public client.
//
// Multi-account (2026-07-24): slot N picks the stream_mail_auth row —
//   1 (default) = gz28us@hotmail.com (the STREAM watcher's box)
//   2 = galpaoz28@hotmail.com · 3 = gz28br@hotmail.com · ...
// The state carries the slot so the callback stores the token in the right row.
//
// PORTÃO (11/set/2026). Até aqui um GET anônimo gravava estado OAuth em qualquer
// slot e mandava para a tela da Microsoft, e o callback guardava o token de QUEM
// consentisse — por cima da caixa que já estava no slot. Um estranho trocava a
// caixa da empresa pela dele, e os robôs passavam a ler (e a varrer) a de fora.
// Agora quem começa é POST com a sessão do admin (requireUser), e a resposta é
// { url }: a tela faz o redirecionamento. Tem de ser assim porque a sessão mora
// no localStorage — um GET de navegador não carrega prova nenhuma de quem é.
//
// O state ganhou um terceiro pedaço, `N.<nonce>.replace|keep`: é a escolha
// EXPLÍCITA do admin de trocar a conta que já está no slot. O callback só troca
// quando ela vem, e ninguém de fora forja o `replace`: o state só é gravado por
// este POST, e o callback exige que o recebido seja igual ao da linha.
// Quarto pedaço, `.<hora em base 36>`: a hora em que o POST cunhou. O callback
// recusa state com mais de 30 min — link de conexão abandonado não fica vivo
// para sempre na linha esperando alguém consentir com a conta errada.

export const dynamic = 'force-dynamic'

// GET não liga mais nada — só aponta a tela, com o slot do link antigo (inclusive
// o do aviso de reconsentimento do inboxRules) já preenchido lá.
export async function GET(req: NextRequest) {
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get('slot') || '1') || 1)
  const href = `/ca/stream/connect?provider=outlook&slot=${slot}`
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Connect a mailbox</title>
     <body style="background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
     <div style="text-align:center"><h1>This link no longer connects a mailbox</h1>
     <p style="color:#9ca3af;font-size:18px">Sign in to the app and use <a style="color:#60a5fa" href="${href}">/ca/stream/connect</a>.</p></div>`,
    { status: 405, headers: { 'Content-Type': 'text/html; charset=utf-8', Allow: 'POST' } },
  )
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const slot = Math.max(1, parseInt(String(b?.slot ?? '1')) || 1)
  // Só `true` de verdade troca a conta do slot — qualquer outra coisa é manter.
  const replace = b?.replace === true
  const db = streamDb()
  // client_id lives on row 1 (the original hookup) and is shared by every slot.
  const base = await getMailAuth(db, 1)
  if (!base?.client_id) {
    return NextResponse.json({ error: 'client_id not configured in stream_mail_auth yet' }, { status: 503 })
  }
  // Slot que já é uma caixa Google conectada não pode virar Microsoft por
  // engano: o client_id da Azure sobrescreveria o do Google e a caixa morreria
  // muda (04/set/2026 — espelho da guarda do gmail-auth). Vale mesmo com replace:
  // o client_id é gravado AQUI, antes do consentimento.
  const existing = await getMailAuth(db, slot)
  if (existing?.refresh_token && mailProvider(existing) === 'gmail') {
    return NextResponse.json({ error: `slot ${slot} is a Google mailbox (${existing.account || '?'}) — choose Gmail for this slot or pick another slot` }, { status: 409 })
  }
  const { verifier, challenge } = pkcePair()
  const state = `${slot}.${pkcePair().verifier.slice(0, 24)}.${replace ? 'replace' : 'keep'}.${Date.now().toString(36)}`
  await setMailAuth(db, { client_id: base.client_id, pkce_verifier: verifier, oauth_state: state }, slot)
  return NextResponse.json({ url: authUrl(base.client_id, challenge, state) })
}
