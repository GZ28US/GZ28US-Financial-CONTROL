// SERVER-ONLY — SOCIAL INBOX + OUTBOX (13/11/2026). Márcio, 11/11 via FaceBook ROUND: «i want the app fully connected to facebook,
// do it, as deep as possible» · 13/11: «faça a conexão do Facebook».
//
// LEITURA (pollMeta): para cada página conectada e para a conta IG ligada a ela —
//   • Messenger em TODAS as pastas (inbox · other · spam · page_done): um lead já ficou perdido no SPAM;
//   • DMs do Instagram (pela página);
//   • comentários nos posts da página e nas mídias do IG (com as respostas);
//   • menções: posts em que a página foi marcada e mídias em que o @ do IG foi marcado.
// Tudo vira linha em social_items, uma por coisa (upsert por platform+kind+external_id). O que é NOVO fica com seen_at nulo.
// Cada pedaço falha sozinho: o erro vai para o resultado da rodada, o resto continua.
//
// ESCRITA (sendOutbox): só executa uma linha de social_outbox que um HUMANO LOGADO aprovou, e só com social.publish.enabled ligado.
// Rascunho → aprovação → envio. Não existe caminho de envio que não passe por aqui.
import type { SupabaseClient } from '@supabase/supabase-js'
import { GRAPH, rowsOf, accessToken, PUBLISH_SWITCH, type SocialRow } from './social.server'
import { settingOn } from './appSettings.server'

export const INBOX_SWITCH = 'social.inbox.enabled'
export const FOLDERS = ['inbox', 'other', 'spam', 'page_done'] as const

type Item = {
  platform: 'FACEBOOK' | 'INSTAGRAM'; kind: 'MESSAGE' | 'COMMENT' | 'MENTION' | 'LEAD'; external_id: string; account_id: number
  thread_id?: string | null; thread_title?: string | null; parent_id?: string | null; folder?: string | null
  from_id?: string | null; from_name?: string | null; from_me?: boolean; body?: string | null; attachments?: number
  permalink?: string | null; hidden?: boolean; happened_at: string; raw?: unknown
}
/* eslint-disable @typescript-eslint/no-explicit-any */

async function graph(path: string, token: string, q: Record<string, string>): Promise<{ ok: boolean; data: any; error?: string }> {
  const u = new URL(`${GRAPH}/${path}`)
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  u.searchParams.set('access_token', token)
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j?.error) return { ok: false, data: null, error: String(j?.error?.message || `HTTP ${r.status}`).slice(0, 300) }
    return { ok: true, data: j }
  } catch (e) { return { ok: false, data: null, error: String((e as Error)?.name || e) } }
}

const iso = (s: unknown) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString() }
const cut = (s: unknown, n: number) => (s == null ? null : String(s).slice(0, n))

/** Uma rodada de leitura. Devolve o que entrou de novo e os erros de cada pedaço. */
export async function pollMeta(db: SupabaseClient): Promise<{ accounts: number; fetched: number; fresh: number; byKind: Record<string, number>; errors: string[] }> {
  const out = { accounts: 0, fetched: 0, fresh: 0, byKind: {} as Record<string, number>, errors: [] as string[] }
  const rows = await rowsOf(db, 'META')
  const pages = rows.filter(r => r.kind === 'FB_PAGE' && r.status === 'CONNECTED')
  const items: Item[] = []

  for (const page of pages) {
    out.accounts++
    let token: string
    try { token = await accessToken(db, page) } catch (e) { out.errors.push(`${page.account}: ${String((e as Error)?.message || e)}`); continue }
    const ig = rows.find(r => r.kind === 'IG_ACCOUNT' && r.parent_id === page.id && r.status === 'CONNECTED')
    const nome = page.account || page.external_id
    const MSG = 'id,updated_time,unread_count,participants,messages.limit(15){id,message,from,created_time,attachments.limit(5){id,mime_type,name}}'

    // conversas: Messenger pasta a pasta + Instagram
    const conversas = async (conta: SocialRow, plataforma: 'FACEBOOK' | 'INSTAGRAM', pasta: string, minhaId: string) => {
      // Instagram de conta grande recusa o pedido cheio («Please reduce the amount of data») — 13/11/2026, conta de 78,7k: pede menos por vez
      const q: Record<string, string> = plataforma === 'FACEBOOK' ? { platform: 'messenger', fields: MSG, limit: '25' } : { platform: 'instagram', fields: MSG.replace('messages.limit(15)', 'messages.limit(5)'), limit: '8' }
      if (plataforma === 'FACEBOOK') q.folder = pasta
      const r = await graph(`${page.external_id}/conversations`, token, q)
      if (!r.ok) { out.errors.push(`${nome} · ${plataforma === 'FACEBOOK' ? 'messenger ' + pasta : 'instagram DMs'}: ${r.error}`); return }
      for (const c of r.data?.data || []) {
        const outro = (c.participants?.data || []).find((p: any) => String(p.id) !== String(page.external_id) && String(p.id) !== minhaId)
        for (const m of c.messages?.data || []) {
          const meu = String(m.from?.id || '') === String(page.external_id) || String(m.from?.id || '') === minhaId
          items.push({
            platform: plataforma, kind: 'MESSAGE', external_id: String(m.id), account_id: conta.id, thread_id: String(c.id),
            thread_title: cut(outro?.name || outro?.username || outro?.id, 200), folder: pasta,
            from_id: cut(meu ? (outro?.id ?? null) : m.from?.id, 100), from_name: cut(m.from?.name || m.from?.username, 200), from_me: meu,
            body: cut(m.message, 8000), attachments: (m.attachments?.data || []).length, happened_at: iso(m.created_time), raw: m,
          })
        }
      }
    }
    for (const pasta of FOLDERS) await conversas(page, 'FACEBOOK', pasta, page.external_id)
    if (ig) await conversas(ig, 'INSTAGRAM', 'instagram', ig.external_id)

    // comentários nos posts da página
    const feed = await graph(`${page.external_id}/posts`, token, { limit: '15', fields: 'id,message,created_time,permalink_url,comments.limit(50).order(reverse_chronological){id,message,from,created_time,permalink_url,is_hidden,parent{id},attachment}' })
    if (!feed.ok) out.errors.push(`${nome} · post comments: ${feed.error}`)
    for (const p of feed.data?.data || []) for (const c of p.comments?.data || []) {
      const meu = String(c.from?.id || '') === String(page.external_id)
      items.push({
        platform: 'FACEBOOK', kind: 'COMMENT', external_id: String(c.id), account_id: page.id, thread_id: String(p.id), thread_title: cut(p.message, 200),
        parent_id: c.parent?.id ? String(c.parent.id) : null, from_id: cut(c.from?.id, 100), from_name: cut(c.from?.name, 200), from_me: meu,
        body: cut(c.message, 8000), attachments: c.attachment ? 1 : 0, permalink: cut(c.permalink_url || p.permalink_url, 500), hidden: !!c.is_hidden, happened_at: iso(c.created_time), raw: c,
      })
    }
    // menções: posts de terceiros que marcaram a página
    const tagged = await graph(`${page.external_id}/tagged`, token, { limit: '25', fields: 'id,message,from,created_time,permalink_url' })
    if (!tagged.ok) out.errors.push(`${nome} · mentions: ${tagged.error}`)
    for (const t of tagged.data?.data || []) items.push({
      platform: 'FACEBOOK', kind: 'MENTION', external_id: String(t.id), account_id: page.id, thread_id: String(t.id), thread_title: cut(t.message, 200),
      from_id: cut(t.from?.id, 100), from_name: cut(t.from?.name, 200), body: cut(t.message, 8000), permalink: cut(t.permalink_url, 500), happened_at: iso(t.created_time), raw: t,
    })

    // LEAD ADS: só quando a página consentiu leads_retrieval (social.meta.leads.enabled + reconexão)
    if ((page.scopes || []).includes('leads_retrieval')) {
      const forms = await graph(`${page.external_id}/leadgen_forms`, token, { fields: 'id,name,status', limit: '50' })
      if (!forms.ok) out.errors.push(`${nome} · lead forms: ${forms.error}`)
      for (const fm of forms.data?.data || []) {
        const leads = await graph(`${fm.id}/leads`, token, { fields: 'id,created_time,field_data,ad_name,campaign_name', limit: '50' })
        if (!leads.ok) { out.errors.push(`${nome} · leads of «${fm.name}»: ${leads.error}`); continue }
        for (const l of leads.data?.data || []) {
          const campos: Record<string, string> = {}; for (const c of l.field_data || []) campos[String(c.name)] = (c.values || []).join(', ')
          const quem = campos.full_name || [campos.first_name, campos.last_name].filter(Boolean).join(' ') || campos.email || campos.phone_number || 'lead'
          items.push({
            platform: 'FACEBOOK', kind: 'LEAD', external_id: String(l.id), account_id: page.id, thread_id: String(fm.id), thread_title: cut(fm.name, 200), from_name: cut(quem, 200),
            body: cut(Object.entries(campos).map(([k, v]) => `${k}: ${v}`).join('\n') + (l.campaign_name || l.ad_name ? `\n— ${[l.campaign_name, l.ad_name].filter(Boolean).join(' · ')}` : ''), 8000),
            happened_at: iso(l.created_time), raw: l,
          })
        }
      }
    }

    if (ig) {
      const eu = String(ig.account || '').replace(/^@/, '').toLowerCase()
      const media = await graph(`${ig.external_id}/media`, token, { limit: '15', fields: 'id,caption,permalink,timestamp,comments.limit(50){id,text,username,timestamp,hidden,from,replies.limit(25){id,text,username,timestamp,hidden,from}}' })
      if (!media.ok) out.errors.push(`${ig.account} · media comments: ${media.error}`)
      for (const m of media.data?.data || []) for (const c of m.comments?.data || []) {
        const um = (x: any, pai: string | null) => items.push({
          platform: 'INSTAGRAM', kind: 'COMMENT', external_id: String(x.id), account_id: ig.id, thread_id: String(m.id), thread_title: cut(m.caption, 200), parent_id: pai,
          from_id: cut(x.from?.id, 100), from_name: cut(x.username ? '@' + x.username : x.from?.username, 200), from_me: String(x.username || '').toLowerCase() === eu,
          body: cut(x.text, 8000), permalink: cut(m.permalink, 500), hidden: !!x.hidden, happened_at: iso(x.timestamp), raw: x,
        })
        um(c, null)
        for (const rp of c.replies?.data || []) um(rp, String(c.id))
      }
      const tags = await graph(`${ig.external_id}/tags`, token, { limit: '25', fields: 'id,caption,permalink,timestamp,username' })
      if (!tags.ok) out.errors.push(`${ig.account} · mentions: ${tags.error}`)
      for (const t of tags.data?.data || []) items.push({
        platform: 'INSTAGRAM', kind: 'MENTION', external_id: String(t.id), account_id: ig.id, thread_id: String(t.id), thread_title: cut(t.caption, 200),
        from_name: cut(t.username ? '@' + t.username : null, 200), body: cut(t.caption, 8000), permalink: cut(t.permalink, 500), happened_at: iso(t.timestamp), raw: t,
      })
    }
  }

  out.fetched = items.length
  const r = await saveItems(db, items, 'POLL')
  out.fresh = r.fresh; out.byKind = r.byKind
  if (r.error) out.errors.push(r.error)
  return out
}

// NOVO é o que acabou de acontecer. O que NÓS escrevemos nasce visto; e o que tem mais de 30 dias também (a primeira leitura traz
// histórico desde 2016 — isso é arquivo, não novidade).
const DIAS_NOVO = 30
const velho = (x: Item) => x.from_me ? { seen_at: new Date().toISOString(), seen_by: 'own' } : Date.now() - Date.parse(x.happened_at) > DIAS_NOVO * 864e5 ? { seen_at: new Date().toISOString(), seen_by: 'history' } : { seen_at: null, seen_by: null }

/** Grava sem duplicar. Linha que já existe só atualiza o que MUDA lá fora (pasta, oculto, texto); seen_at nunca é mexido aqui. */
export async function saveItems(db: SupabaseClient, items: Item[], source: 'POLL' | 'WEBHOOK'): Promise<{ fresh: number; byKind: Record<string, number>; error?: string }> {
  const byKind: Record<string, number> = {}
  if (!items.length) return { fresh: 0, byKind }
  const uniq = new Map<string, Item>(); for (const i of items) uniq.set(`${i.platform}|${i.kind}|${i.external_id}`, i)
  const all = [...uniq.values()]
  const tem = new Set<string>()
  for (let i = 0; i < all.length; i += 200) {
    const lote = all.slice(i, i + 200)
    const { data, error } = await db.from('social_items').select('platform, kind, external_id').in('external_id', lote.map(x => x.external_id))
    if (error) return { fresh: 0, byKind, error: error.message }
    for (const x of data || []) tem.add(`${x.platform}|${x.kind}|${x.external_id}`)
  }
  const novos = all.filter(i => !tem.has(`${i.platform}|${i.kind}|${i.external_id}`))
  const velhos = all.filter(i => tem.has(`${i.platform}|${i.kind}|${i.external_id}`))
  for (let i = 0; i < novos.length; i += 200) {
    // o que NÓS escrevemos não é novidade: nasce já visto
    // linha COMPLETA: num insert em lote, coluna ausente em uma linha vira NULL em todas (e hidden/from_me/attachments são NOT NULL)
    const lote = novos.slice(i, i + 200).map(x => ({ thread_id: null, thread_title: null, parent_id: null, folder: null, from_id: null, from_name: null, body: null, permalink: null, raw: null, ...x, from_me: !!x.from_me, hidden: !!x.hidden, attachments: x.attachments || 0, source, ...velho(x) }))
    const { error } = await db.from('social_items').upsert(lote, { onConflict: 'platform,kind,external_id', ignoreDuplicates: true })
    if (error) return { fresh: 0, byKind, error: error.message }
  }
  for (const v of velhos) await db.from('social_items').update({ folder: v.folder ?? null, hidden: !!v.hidden, body: v.body ?? null, gone_at: null }).eq('platform', v.platform).eq('kind', v.kind).eq('external_id', v.external_id)
  for (const n of novos) if (!n.from_me) byKind[`${n.platform}:${n.kind}`] = (byKind[`${n.platform}:${n.kind}`] || 0) + 1
  return { fresh: novos.filter(n => !n.from_me).length, byKind }
}

// ── ESCRITA ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type OutboxRow = {
  id: number; account_id: number; platform: 'FACEBOOK' | 'INSTAGRAM'; action: string; target_id: string | null; item_id: number | null
  body: string | null; link: string | null; context: string | null; status: string; created_by: string; approved_by: string | null
}

/** Executa UMA linha aprovada. `approvedBy` é o e-mail do humano logado que clicou — sem ele, não sai. */
export async function sendOutbox(db: SupabaseClient, id: number, approvedBy: string): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  if (!approvedBy || !approvedBy.includes('@')) return { ok: false, error: 'only a logged-in person can approve a send' }
  if (!(await settingOn(PUBLISH_SWITCH))) return { ok: false, error: `${PUBLISH_SWITCH} is OFF — turn it on at /ca/social/connect` }
  // a linha é TOMADA antes de sair: dois cliques não mandam duas vezes
  const { data: got, error: e0 } = await db.from('social_outbox').update({ approved_by: approvedBy, approved_at: new Date().toISOString() }).eq('id', id).eq('status', 'DRAFT').is('approved_at', null).select('*').maybeSingle()
  if (e0) return { ok: false, error: e0.message }
  if (!got) return { ok: false, error: 'this draft was already sent, cancelled or is being sent' }
  const o = got as OutboxRow
  const falha = async (error: string) => { await db.from('social_outbox').update({ status: 'FAILED', error: error.slice(0, 500) }).eq('id', id); return { ok: false, error } }

  const rows = await rowsOf(db, 'META')
  const conta = rows.find(r => r.id === o.account_id)
  if (!conta) return falha('account not connected any more')
  const page = conta.kind === 'IG_ACCOUNT' ? rows.find(r => r.id === conta.parent_id) : conta
  if (!page) return falha('the Instagram account has no page row')
  let token: string
  try { token = await accessToken(db, conta) } catch (e) { return falha(String((e as Error)?.message || e)) }

  const texto = (o.body || '').trim()
  let method = 'POST', path = '', body: Record<string, unknown> = {}
  switch (o.action) {
    case 'MESSAGE_REPLY':
      if (!o.target_id || !texto) return falha('message reply needs a recipient and a text')
      path = `${page.external_id}/messages`; body = { recipient: { id: o.target_id }, messaging_type: 'RESPONSE', message: { text: texto } }; break
    case 'COMMENT_REPLY':
      if (!o.target_id || !texto) return falha('comment reply needs the comment and a text')
      path = o.platform === 'INSTAGRAM' ? `${o.target_id}/replies` : `${o.target_id}/comments`; body = { message: texto }; break
    case 'COMMENT_HIDE': case 'COMMENT_UNHIDE':
      if (!o.target_id) return falha('needs the comment')
      path = o.target_id; body = o.platform === 'INSTAGRAM' ? { hide: o.action === 'COMMENT_HIDE' } : { is_hidden: o.action === 'COMMENT_HIDE' }; break
    case 'COMMENT_DELETE':
      if (!o.target_id) return falha('needs the comment')
      method = 'DELETE'; path = o.target_id; break
    case 'POST_PUBLISH':
      if (o.platform !== 'FACEBOOK') return falha('publishing from here is Facebook page only (Instagram needs a media file)')
      if (!texto && !o.link) return falha('a post needs a text or a link')
      path = `${page.external_id}/feed`; body = { ...(texto ? { message: texto } : {}), ...(o.link ? { link: o.link } : {}) }; break
    default: return falha('unknown action')
  }
  try {
    const r = await fetch(`${GRAPH}/${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: method === 'DELETE' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j?.error) return falha(String(j?.error?.message || `HTTP ${r.status}`))
    await db.from('social_outbox').update({ status: 'SENT', sent_at: new Date().toISOString(), result: j, error: null }).eq('id', id)
    // o inbox acompanha o que acabou de mudar lá fora
    if (o.item_id && (o.action === 'COMMENT_HIDE' || o.action === 'COMMENT_UNHIDE')) await db.from('social_items').update({ hidden: o.action === 'COMMENT_HIDE' }).eq('id', o.item_id)
    if (o.item_id && o.action === 'COMMENT_DELETE') await db.from('social_items').update({ gone_at: new Date().toISOString() }).eq('id', o.item_id)
    return { ok: true, result: j }
  } catch (e) { return falha(String((e as Error)?.message || e)) }
}
