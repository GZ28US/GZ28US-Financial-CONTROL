import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, exchangeCode } from '@/lib/streamMail.server'

// Mail hookup, step 2 — Microsoft redirects here after consent. The code is
// exchanged (PKCE, no secret) and the refresh token is stored straight into
// stream_mail_auth: it never travels through a chat, a file or an env var.
// Multi-account (2026-07-24): the state's "N." prefix picks the row, and the
// connected mailbox is discovered via Graph /me and recorded on the row.

export const dynamic = 'force-dynamic'

// Tudo que entra na página é escapado (11/set/2026): `error_description` vem da
// URL e `account` vem da própria caixa. Sem isto, um link com
// ?error_description=<script> rodava script na origem do app — a mesma onde mora
// a sessão do admin.
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
  const errDesc = req.nextUrl.searchParams.get('error_description')
  if (!code) return page('Mail hookup failed', errDesc || 'No code returned', false)

  const parts = (state || '').split('.')
  const slot = Math.max(1, parseInt(parts[0] || '1') || 1)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth?.client_id || !auth.pkce_verifier) return page('Mail hookup failed', `No pending auth — start at ${CONNECT}`, false)
  if (!state || state !== auth.oauth_state) return page('Mail hookup failed', `State mismatch — start again at ${CONNECT}`, false)
  // State sem o terceiro pedaço (`replace|keep`) foi cunhado pelo GET anônimo de
  // antes do portão — por qualquer um. Morre aqui, antes de trocar o code.
  const intent = parts[2]
  if (intent !== 'replace' && intent !== 'keep') {
    await setMailAuth(db, { pkce_verifier: null, oauth_state: null }, slot)
    return page('Mail hookup failed', `This link came from the old, unauthenticated flow — start again at ${CONNECT}`, false)
  }
  // Quarto pedaço = hora em que o POST logado cunhou (base 36). Conexão
  // abandonada não fica viva na linha: passou de 30 min, morre (11/set/2026).
  const cunhadoEm = parseInt(parts[3] || '', 36)
  if (!Number.isFinite(cunhadoEm) || Date.now() - cunhadoEm > STATE_TTL_MS) {
    await setMailAuth(db, { pkce_verifier: null, oauth_state: null }, slot)
    return page('Mail hookup failed', `This connection link expired (older than 30 minutes) — start again at ${CONNECT}`, false)
  }

  const res = await exchangeCode(auth.client_id, code, auth.pkce_verifier)
  if (!res?.refresh_token) return page('Mail hookup failed', res?.error_description || 'Token exchange failed', false)

  // Which mailbox did we just connect? Ask Graph — never assume. /me comes back
  // empty without a User.Read scope on consumer accounts, so fall back to the
  // recipients of the inbox's own messages (mail addressed to the account).
  let account: string | null = null
  try {
    const gh = { Authorization: `Bearer ${res.access_token}` }
    const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail', { headers: gh })).json()
    account = me?.mail || me?.userPrincipalName || null
    if (!account) {
      const inb = await (await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=5&$select=toRecipients', { headers: gh })).json()
      const addrs = (inb?.value || []).flatMap((m: any) => (m.toRecipients || []).map((r: any) => String(r.emailAddress?.address || '').toLowerCase()))
      account = addrs.find((x: string) => x.includes('@hotmail') || x.includes('@outlook') || x.includes('@gz28')) || addrs[0] || null
    }
  } catch { /* best-effort */ }

  // A CAIXA DO SLOT NÃO TROCA DE CONTA SEM ORDEM (11/set/2026). Slot com dono
  // (token vivo ou conta gravada) só recebe token de OUTRA conta quando o admin
  // marcou "Replace existing account" ao começar — a marca vem no state, que só o
  // POST logado grava. Conta desconhecida de qualquer lado conta como outra: com
  // token de e-mail, dúvida falha fechada. Reconectar a MESMA conta (renovar
  // token, reconsentir escopo novo) e ligar slot vazio seguem como sempre.
  const mesmaConta = !!conta(auth.account) && conta(auth.account) === conta(account)
  const trocaDeConta = (!!auth.refresh_token || !!auth.account) && !mesmaConta
  if (trocaDeConta && intent !== 'replace') {
    await setMailAuth(db, { pkce_verifier: null, oauth_state: null }, slot)
    return page('Mailbox NOT connected', `Slot ${slot} already holds ${auth.account || 'a mailbox we could not identify'}, and you signed in as ${account || 'an account we could not identify'}. Nothing was saved. To put this account in slot ${slot}, start again at ${CONNECT} and tick "Replace existing account".`, false)
  }

  // CAIXA NOVA NÃO NASCE VARRIDA (04/set/2026): conectar a gz28shopping ligou
  // nela, no mesmo minuto, o sweep de marketing — que ia mandar para o lixo os
  // avisos de compra de um arquivo de 12 mil e-mails. Quem acabou de chegar entra
  // com a faxina DESLIGADA; ligar é decisão de gente, caixa por caixa.
  // Conta que entra no slot por TROCA também acabou de chegar (11/set/2026).
  const primeiraVez = !auth.refresh_token || trocaDeConta
  await setMailAuth(db, { refresh_token: res.refresh_token, account, pkce_verifier: null, oauth_state: null, ...(primeiraVez ? { auto_sweep: false } : {}) }, slot)
  const trocou = trocaDeConta && auth.account ? ` — substituiu ${auth.account}` : ''
  return page('Mailbox connected', `${account || 'A conta'} está conectada (slot ${slot})${trocou}. Pode fechar esta aba.`, true)
}
