import { NextRequest } from 'next/server'
import { socialDb, takeState, callbackUrl, upsertRow, resultPage, metaDebug, platformOn, GRAPH } from '@/lib/social.server'

// SOCIAL LINK · META step 2 (09/11/2026). code → short user token → LONG-LIVED user token (60 days) → /me/accounts gives one PAGE
// token per page (those do not expire) and each page's linked Instagram Business account. Rows: META_USER, FB_PAGE per page,
// IG_ACCOUNT per linked IG (parent = its page). Tokens are sealed before they touch the table; nothing is printed.
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (u: URL | string): Promise<any> => (await fetch(u)).json().catch(() => ({}))

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  if (!(await platformOn('META'))) return resultPage('Meta NOT connected', 'social.meta.enabled is OFF.', false)
  const db = socialDb()
  const st = await takeState(db, 'META', sp.get('state'))
  if (!st) return resultPage('Meta NOT connected', 'This link is unknown, used or older than 30 minutes — start again at /ca/social/connect.', false)
  const code = sp.get('code')
  if (!code) return resultPage('Meta NOT connected', sp.get('error_description') || sp.get('error') || 'No code returned', false)

  const id = process.env.META_APP_ID!, secret = process.env.META_APP_SECRET!
  const t1 = new URL(`${GRAPH}/oauth/access_token`)
  t1.searchParams.set('client_id', id); t1.searchParams.set('client_secret', secret)
  t1.searchParams.set('redirect_uri', callbackUrl(req.nextUrl.origin, 'META')); t1.searchParams.set('code', code)
  const short = await j(t1)
  if (!short?.access_token) return resultPage('Meta NOT connected', short?.error?.message || 'code exchange failed', false)
  const t2 = new URL(`${GRAPH}/oauth/access_token`)
  t2.searchParams.set('grant_type', 'fb_exchange_token'); t2.searchParams.set('client_id', id)
  t2.searchParams.set('client_secret', secret); t2.searchParams.set('fb_exchange_token', short.access_token)
  const long = await j(t2)
  const userToken: string = long?.access_token || short.access_token

  const me = await j(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`)
  if (!me?.id) return resultPage('Meta NOT connected', me?.error?.message || 'could not read /me', false)
  const dbg = await metaDebug(userToken)
  const userRow = await upsertRow(db, {
    platform: 'META', kind: 'META_USER', external_id: me.id, account: me.name, access_token: userToken,
    access_expires_at: dbg.expires_at ? new Date(dbg.expires_at * 1000).toISOString() : null,
    scopes: dbg.scopes, connected_by: st.by, meta: { granted_scopes: dbg.scopes },
  })

  const lines: string[] = [`user ${me.name}`]
  let next: string | null = `${GRAPH}/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username,name}&limit=50&access_token=${encodeURIComponent(userToken)}`
  let pages = 0
  while (next) {
    const pg = await j(next)
    if (pg?.error) return resultPage('Meta partly connected', `user saved, but the page list failed: ${pg.error.message}`, false)
    for (const p of pg?.data || []) {
      pages++
      const pageId = await upsertRow(db, {
        platform: 'META', kind: 'FB_PAGE', external_id: p.id, account: p.name, access_token: p.access_token, access_expires_at: null,
        scopes: dbg.scopes, parent_id: userRow, connected_by: st.by, meta: { tasks: p.tasks || [] },
      })
      lines.push(`page ${p.name}`)
      const ig = p.instagram_business_account
      if (ig?.id) {
        await upsertRow(db, {
          platform: 'META', kind: 'IG_ACCOUNT', external_id: ig.id, account: ig.username ? `@${ig.username}` : ig.name, access_token: null,
          access_expires_at: null, scopes: dbg.scopes, parent_id: pageId, connected_by: st.by, meta: { page_id: p.id },
        })
        lines.push(`instagram @${ig.username}`)
      }
    }
    next = pg?.paging?.next || null
  }
  const missing = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'].filter(s => !dbg.scopes.includes(s))
  return resultPage(pages ? 'Meta connected' : 'Meta connected — but no pages',
    `${lines.join('\n')}${missing.length ? `\n\nNot granted: ${missing.join(', ')}` : ''}\n\nYou can close this tab.`, pages > 0)
}
