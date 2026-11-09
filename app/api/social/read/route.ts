import { NextRequest, NextResponse } from 'next/server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'
import { socialDb, rowsOf, accessToken, platformOn, GRAPH, SWITCH, type Platform, type SocialRow, type Kind } from '@/lib/social.server'

// SOCIAL LINK — READ ONLY (09/11/2026). How the app and Claude read the brand accounts: posts, comments, DMs, insights, profile.
// GET /ca/api/social/read?what=<name>[&account=<row id | external id | @handle>][&id=<post/media/video id>][&metric=a,b][&period=day]
//      [&since=YYYY-MM-DD&until=YYYY-MM-DD][&after=<cursor>]
// Who: a logged-in screen (requireUser) or a reading session/script (x-read-key header — never in the URL).
// Every `what` is a FIXED request shape below — the caller fills only validated ids/cursors, so this route cannot be turned into a
// generic proxy that writes. Nothing here posts, replies or sends. The platform's switch must be ON.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Spec = { platform: Platform; kind: Kind; needsId?: boolean }
const WHAT: Record<string, Spec> = {
  fb_page: { platform: 'META', kind: 'FB_PAGE' },
  fb_posts: { platform: 'META', kind: 'FB_PAGE' },
  fb_comments: { platform: 'META', kind: 'FB_PAGE', needsId: true },
  fb_insights: { platform: 'META', kind: 'FB_PAGE' },
  fb_conversations: { platform: 'META', kind: 'FB_PAGE' },
  ig_profile: { platform: 'META', kind: 'IG_ACCOUNT' },
  ig_media: { platform: 'META', kind: 'IG_ACCOUNT' },
  ig_comments: { platform: 'META', kind: 'IG_ACCOUNT', needsId: true },
  ig_insights: { platform: 'META', kind: 'IG_ACCOUNT' },
  ig_conversations: { platform: 'META', kind: 'IG_ACCOUNT' },
  meta_businesses: { platform: 'META', kind: 'META_USER' },
  yt_channel: { platform: 'YOUTUBE', kind: 'YT_CHANNEL' },
  yt_videos: { platform: 'YOUTUBE', kind: 'YT_CHANNEL' },
  yt_video: { platform: 'YOUTUBE', kind: 'YT_CHANNEL', needsId: true },
  yt_comments: { platform: 'YOUTUBE', kind: 'YT_CHANNEL' },
  yt_analytics: { platform: 'YOUTUBE', kind: 'YT_CHANNEL' },
  tt_profile: { platform: 'TIKTOK', kind: 'TT_ACCOUNT' },
  tt_videos: { platform: 'TIKTOK', kind: 'TT_ACCOUNT' },
}

const ID = /^[A-Za-z0-9_.:-]{1,120}$/
const METRIC = /^[a-z_,]{1,400}$/
const CURSOR = /^[A-Za-z0-9_=%-]{1,600}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const PERIODS = new Set(['day', 'week', 'days_28', 'month', 'lifetime', 'total_over_range'])

function pickRow(rows: SocialRow[], kind: Kind, account: string | null): SocialRow | undefined {
  const of = rows.filter(r => r.kind === kind)
  if (!account) return of[0]
  const a = account.toLowerCase()
  return of.find(r => String(r.id) === account || r.external_id === account || String(r.account || '').toLowerCase() === a || String(r.account || '').toLowerCase() === `@${a}`)
}

const MSG_FIELDS = 'id,updated_time,participants,messages.limit(10){message,from,to,created_time}'

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sp = req.nextUrl.searchParams
  const what = sp.get('what') || ''
  const spec = WHAT[what]
  if (!spec) return NextResponse.json({ error: 'unknown what', whats: Object.keys(WHAT) }, { status: 400 })
  if (!(await platformOn(spec.platform))) return NextResponse.json({ error: `${SWITCH[spec.platform]} is OFF` }, { status: 403 })

  const id = sp.get('id'), metric = sp.get('metric'), period = sp.get('period'), after = sp.get('after')
  const since = sp.get('since'), until = sp.get('until')
  if (spec.needsId && !id) return NextResponse.json({ error: `${what} needs &id=` }, { status: 400 })
  if (id && !ID.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 })
  if (metric && !METRIC.test(metric)) return NextResponse.json({ error: 'bad metric' }, { status: 400 })
  if (period && !PERIODS.has(period)) return NextResponse.json({ error: 'bad period' }, { status: 400 })
  if (after && !CURSOR.test(after)) return NextResponse.json({ error: 'bad cursor' }, { status: 400 })
  if ((since && !DAY.test(since)) || (until && !DAY.test(until))) return NextResponse.json({ error: 'dates are YYYY-MM-DD' }, { status: 400 })

  const db = socialDb()
  const rows = await rowsOf(db, spec.platform)
  const row = pickRow(rows, spec.kind, sp.get('account'))
  if (!row) return NextResponse.json({ error: `no connected ${spec.kind}`, accounts: rows.filter(r => r.kind === spec.kind).map(r => ({ id: r.id, account: r.account })) }, { status: 404 })

  let token: string
  try { token = await accessToken(db, row) } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 }) }

  const out = await call(what, row, rows, token, { id, metric, period, after, since, until })
  return NextResponse.json({ what, account: { id: row.id, kind: row.kind, account: row.account, external_id: row.external_id }, ...out }, { status: out.status })
}

type P = { id: string | null; metric: string | null; period: string | null; after: string | null; since: string | null; until: string | null }

async function call(what: string, row: SocialRow, rows: SocialRow[], token: string, p: P): Promise<{ status: number; data: unknown }> {
  // ── META (Graph) ──
  if (row.platform === 'META') {
    const pageOfIg = row.kind === 'IG_ACCOUNT' ? rows.find(r => r.id === row.parent_id)?.external_id : undefined
    const G: Record<string, () => [string, Record<string, string>]> = {
      fb_page: () => [row.external_id, { fields: 'id,name,username,link,fan_count,followers_count,about,website,category' }],
      fb_posts: () => [`${row.external_id}/posts`, { fields: 'id,message,created_time,permalink_url,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)', limit: '25' }],
      fb_comments: () => [`${p.id}/comments`, { fields: 'id,message,from,created_time,like_count,comment_count', limit: '50', order: 'reverse_chronological' }],
      fb_insights: () => [`${row.external_id}/insights`, { metric: p.metric || 'page_impressions_unique,page_post_engagements,page_follows', period: p.period || 'day' }],
      fb_conversations: () => [`${row.external_id}/conversations`, { platform: 'messenger', fields: MSG_FIELDS, limit: '25' }],
      ig_profile: () => [row.external_id, { fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url' }],
      ig_media: () => [`${row.external_id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count', limit: '25' }],
      ig_comments: () => [`${p.id}/comments`, { fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}', limit: '50' }],
      ig_insights: () => [`${row.external_id}/insights`, { metric: p.metric || 'reach,follower_count,profile_views', period: p.period || 'day', ...(p.metric && /total_value|views|accounts_engaged|total_interactions/.test(p.metric) ? { metric_type: 'total_value' } : {}) }],
      ig_conversations: () => [`${pageOfIg}/conversations`, { platform: 'instagram', fields: MSG_FIELDS, limit: '25' }],
      meta_businesses: () => ['me/businesses', { fields: 'id,name,verification_status' }],
    }
    const [path, q] = G[what]()
    const u = new URL(`${GRAPH}/${path}`)
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
    if (p.after) u.searchParams.set('after', p.after)
    if (p.since) u.searchParams.set('since', p.since)
    if (p.until) u.searchParams.set('until', p.until)
    u.searchParams.set('access_token', token)
    const r = await fetch(u)
    const j = await r.json().catch(() => ({}))
    return { status: r.ok ? 200 : 502, data: strip(j) }
  }

  // ── YOUTUBE ──
  if (row.platform === 'YOUTUBE') {
    const H = { Authorization: `Bearer ${token}` }
    const Y = 'https://www.googleapis.com/youtube/v3'
    let u: URL
    if (what === 'yt_channel') u = new URL(`${Y}/channels?part=snippet,statistics,brandingSettings,contentDetails&mine=true`)
    else if (what === 'yt_videos') {
      const uploads = String(row.meta?.uploads || '') || `UU${row.external_id.slice(2)}`
      u = new URL(`${Y}/playlistItems?part=snippet,contentDetails&maxResults=50`)
      u.searchParams.set('playlistId', uploads)
      if (p.after) u.searchParams.set('pageToken', p.after)
    } else if (what === 'yt_video') {
      u = new URL(`${Y}/videos?part=snippet,statistics,status,contentDetails`)
      u.searchParams.set('id', p.id!)
    } else if (what === 'yt_comments') {
      u = new URL(`${Y}/commentThreads?part=snippet,replies&maxResults=50&order=time`)
      if (p.id) u.searchParams.set('videoId', p.id); else u.searchParams.set('allThreadsRelatedToChannelId', row.external_id)
      if (p.after) u.searchParams.set('pageToken', p.after)
    } else {
      const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
      u = new URL('https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&dimensions=day&sort=day')
      u.searchParams.set('startDate', p.since || fmt(new Date(Date.now() - 28 * 864e5)))
      u.searchParams.set('endDate', p.until || fmt(new Date()))
      u.searchParams.set('metrics', p.metric || 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares')
    }
    const r = await fetch(u, { headers: H })
    return { status: r.ok ? 200 : 502, data: await r.json().catch(() => ({})) }
  }

  // ── TIKTOK ──
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  if (what === 'tt_profile') {
    const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count', { headers: H })
    return { status: r.ok ? 200 : 502, data: await r.json().catch(() => ({})) }
  }
  const r = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count', {
    method: 'POST', headers: H, body: JSON.stringify({ max_count: 20, ...(p.after && /^\d+$/.test(p.after) ? { cursor: Number(p.after) } : {}) }),
  })
  return { status: r.ok ? 200 : 502, data: await r.json().catch(() => ({})) }
}

// Graph echoes the token inside `paging.next/previous` URLs — never hand those back. Keep only the cursors.
function strip(j: unknown): unknown {
  if (!j || typeof j !== 'object') return j
  const o = j as Record<string, unknown>
  const pg = o.paging as Record<string, unknown> | undefined
  if (pg) o.paging = { cursors: pg.cursors, has_next: !!pg.next }
  for (const v of Object.values(o)) if (v && typeof v === 'object') strip(v)
  if (Array.isArray(o.data)) for (const it of o.data) strip(it)
  return o
}
