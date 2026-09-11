import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, mailProvider } from '@/lib/streamMail.server'

// Gmail hookup, step 2 — Google redirects here after consent. The code is
// exchanged (client_id + client_secret, server-side only) and the refresh token
// is stored straight into the stream_mail_auth row named by the state's "N."
// prefix (04/set/2026 — before that, always slot 4): it never travels through
// a chat, a file or a screenshot. Mirrors mail-callback (Microsoft).

export const dynamic = 'force-dynamic'

// Tudo que entra na página é escapado (11/set/2026) — `error` vem da URL e
// `account` vem da caixa; mesma lei do mail-callback.
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const page = (title: string, body: string, ok: boolean) => new NextResponse(
  `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
   <body style="background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
   <div style="text-align:center"><p style="font-size:64px;margin:0">${ok ? '✅' : '❌'}</p>
   <h1>${esc(title)}</h1><p style="color:#9ca3af;font-size:18px">${esc(body)}</p></div>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
)

const CONNECT = '/ca/stream/connect'
const STATE_TTL_MS = 30 * 60 * 1000
const conta = (s: string | null | undefined) => String(s || '').toLowerCase()

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const errDesc = req.nextUrl.searchParams.get('error')
  if (!code) return page('Gmail hookup failed', errDesc || 'No code returned', false)

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return page('Gmail hookup failed', 'GOOGLE_CLIENT_ID/SECRET not configured', false)

  const parts = (state || '').split('.')
  const slot = Math.max(1, parseInt(parts[0] || '4') || 4)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!state || state !== auth?.oauth_state) return page('Gmail hookup failed', `State mismatch — start again at ${CONNECT}`, false)
  // State sem o terceiro pedaço (`replace|keep`) foi cunhado pelo GET anônimo de
  // antes do portão — por qualquer um. Morre aqui, antes de trocar o code.
  const intent = parts[2]
  if (intent !== 'replace' && intent !== 'keep') {
    await setMailAuth(db, { oauth_state: null, pkce_verifier: null }, slot)
    return page('Gmail hookup failed', `This link came from the old, unauthenticated flow — start again at ${CONNECT}`, false)
  }
  // Quarto pedaço = hora em que o POST logado cunhou (base 36). O Google não usa
  // PKCE aqui, então o state é a única amarra: conexão abandonada não pode ficar
  // viva na linha — passou de 30 min, morre (11/set/2026).
  const cunhadoEm = parseInt(parts[3] || '', 36)
  if (!Number.isFinite(cunhadoEm) || Date.now() - cunhadoEm > STATE_TTL_MS) {
    await setMailAuth(db, { oauth_state: null, pkce_verifier: null }, slot)
    return page('Gmail hookup failed', `This connection link expired (older than 30 minutes) — start again at ${CONNECT}`, false)
  }

  const redirect = `${req.nextUrl.origin}/ca/api/stream/gmail-callback`
  const res = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  })).json()
  if (!res?.refresh_token) return page('Gmail hookup failed', res?.error_description || res?.error || 'Token exchange failed (no refresh token)', false)

  // Which mailbox did we just connect? Ask Gmail — never assume.
  let account: string | null = null
  try {
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${res.access_token}` } })).json()
    account = prof?.emailAddress || null
  } catch { /* best-effort */ }

  // ONDE gravar: na linha que o state nomeia — A NÃO SER que ela já seja OUTRA
  // caixa Google viva. Caso real de 04/set/2026 01:02 (Orlando): o link foi
  // aberto sem ?slot (default 4 = gz28us@gmail.com) para conectar o
  // gz28speedshop@gmail.com; se o consentimento tivesse ido até o fim, o token
  // novo sobrescreveria o do gz28us@gmail e aquela caixa morreria muda. Regra:
  // conta que já tem linha volta para a própria linha; conta nova em slot
  // ocupado por outra vai para o primeiro slot livre. Reconectar a MESMA conta
  // no mesmo slot continua funcionando como sempre.
  //
  // 11/set/2026: "ocupado" passou a incluir a conta GRAVADA sem token vivo e a
  // conta desconhecida (de qualquer lado), e só o "Replace existing account"
  // marcado no começo — que vem no state — deixa a conta nova entrar no lugar da
  // outra. Sem conta identificada não há própria linha para achar: sem replace,
  // recusa e não grava nada.
  const target = await routeToSlot(db, slot, auth, account, intent === 'replace')
  if (target === null) {
    await setMailAuth(db, { oauth_state: null, pkce_verifier: null }, slot)
    return page('Gmail NOT connected', `Slot ${slot} already holds ${auth?.account || 'a mailbox we could not identify'}, and ${account ? `${account} could not be placed in a slot of its own (the slot list did not load — try again)` : 'the Google account you signed in with could not be identified'}. Nothing was saved. To put it in slot ${slot} anyway, start again at ${CONNECT} and tick "Replace existing account".`, false)
  }
  // A "própria linha" achada pelo e-mail pode ser uma caixa MICROSOFT viva: conta
  // Microsoft pessoal pode ter login @gmail.com (ver mailProvider). Gravar ali o
  // client_id do Google mataria aquela caixa muda — e esse caminho não passa pelo
  // `replace`. Recusa e não grava nada (11/set/2026).
  if (target !== slot) {
    const alvo = await getMailAuth(db, target)
    if (alvo?.refresh_token && mailProvider(alvo) !== 'gmail') {
      await setMailAuth(db, { oauth_state: null, pkce_verifier: null }, slot)
      return page('Gmail NOT connected', `${account} already lives in slot ${target}, and that slot is a connected Microsoft mailbox. Nothing was saved.`, false)
    }
  }
  if (target !== slot) await setMailAuth(db, { oauth_state: null, pkce_verifier: null }, slot)
  // Caixa nova não nasce varrida — mesma lei do mail-callback (04/set/2026).
  // Conta que entra no slot por TROCA também acabou de chegar (11/set/2026).
  const trocou = target === slot && ocupadaPorOutra(auth, account)
  const primeiraVez = target !== slot || !auth?.refresh_token || trocou
  await setMailAuth(db, { client_id: clientId, refresh_token: res.refresh_token, account, oauth_state: null, pkce_verifier: null, ...(primeiraVez ? { auto_sweep: false } : {}) }, target)
  const moved = target !== slot ? ` — slot ${slot} já era ${auth?.account || 'outra caixa'}, então foi para o slot ${target}` : ''
  const replaced = trocou && auth?.account ? ` — substituiu ${auth.account}` : ''
  return page('Gmail conectado', `${account || 'A conta'} está conectada (slot ${target})${moved}${replaced}. Pode fechar esta aba.`, true)
}

type SlotRow = { refresh_token?: string | null; account?: string | null } | null

// Slot "de outra conta": tem dono (token vivo ou conta gravada) e não dá para
// provar que é a MESMA conta que acabou de consentir.
function ocupadaPorOutra(current: SlotRow, account: string | null): boolean {
  const mesma = !!conta(current?.account) && conta(current?.account) === conta(account)
  return (!!current?.refresh_token || !!current?.account) && !mesma
}

// null = recusar: slot de outra conta e (a) conta que consentiu desconhecida sem
// replace, ou (b) a lista de slots não veio — com `rows` vazio o "slot novo" daria
// 1, a caixa Microsoft do STREAM, e o token do Google cairia por cima dela.
async function routeToSlot(db: ReturnType<typeof streamDb>, slot: number, current: SlotRow, account: string | null, replace: boolean): Promise<number | null> {
  if (!ocupadaPorOutra(current, account)) return slot
  if (!account) return replace ? slot : null
  const same = (a: string | null | undefined) => String(a || '').toLowerCase() === account.toLowerCase()
  const { data, error } = await db.from('stream_mail_auth').select('id, account').order('id')
  if (error || !data?.length) return null
  const rows = data as { id: number; account: string | null }[]
  const mine = rows.find(r => same(r.account))
  if (mine) return mine.id
  // Conta nova: com replace entra no lugar da outra; sem replace, slot novo.
  if (replace) return slot
  return rows.reduce((m, r) => Math.max(m, r.id), 0) + 1
}
