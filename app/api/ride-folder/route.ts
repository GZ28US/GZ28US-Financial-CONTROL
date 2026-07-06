import { NextRequest, NextResponse } from 'next/server'

// RIDE FOLDER SYNC — keeps the physical Dropbox ride folders in step with the
// system: every ride create / rename / renumber updates the folder via the
// Dropbox API (cloud-side; the desktop client mirrors it to the PC).
//
// Zones — both apps share ONE Dropbox account, so either app can manage both:
//   US -> /001 - GZ28US/GZ28US Rides
//   BR -> /000 - GZ28BR/GZ28BR Rides
//
// Env (server-side secrets, set in Vercel + .env.local):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
//
// Body:
//   { action: 'create', zone: 'US'|'BR', code: 'BR.527', name: 'CarName' }
//   { action: 'rename', zone, oldCode: 'BR.750', newCode: 'US.038', name: 'CarName' }
// Rename finds the existing folder by its CODE prefix (folder names may carry
// older nicknames); if none exists it self-heals by creating the folder.

export const maxDuration = 30

const ROOTS: Record<string, string> = {
  US: '/001 - GZ28US/GZ28US Rides',
  BR: '/000 - GZ28BR/GZ28BR Rides',
}

// Windows-invalid filename characters can't exist in Dropbox names that need
// to sync to the PC; also collapse whitespace.
const sanitize = (s: string) => (s || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()

async function dbxAccessToken(): Promise<string> {
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN || '',
      client_id: process.env.DROPBOX_APP_KEY || '',
      client_secret: process.env.DROPBOX_APP_SECRET || '',
    }).toString(),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error('Dropbox auth failed: ' + JSON.stringify(j).slice(0, 200))
  return j.access_token
}

async function dbx(token: string, endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = {}
  try { data = JSON.parse(text) } catch { /* not json */ }
  return { ok: res.ok, status: res.status, data, text }
}

// Find the folder whose name starts with "<code> " (e.g. "BR.469 - SilverBullet")
// — folder nicknames may differ from the system name, the CODE is the key.
async function findFolderByCode(token: string, root: string, code: string): Promise<string | null> {
  let cursor: string | null = null
  do {
    const r: any = cursor
      ? await dbx(token, 'files/list_folder/continue', { cursor })
      : await dbx(token, 'files/list_folder', { path: root, recursive: false, limit: 1000 })
    if (!r.ok) throw new Error('list_folder failed: ' + r.text.slice(0, 200))
    for (const e of r.data.entries || []) {
      if (e['.tag'] === 'folder' && (e.name === code || e.name.startsWith(code + ' '))) return e.name
    }
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  return null
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.DROPBOX_REFRESH_TOKEN || !process.env.DROPBOX_APP_KEY) {
      return NextResponse.json({ error: 'Dropbox folder sync not configured (missing DROPBOX_* env vars).' }, { status: 501 })
    }
    const body = await req.json().catch(() => ({}))
    const zone = body.zone === 'US' ? 'US' : body.zone === 'BR' ? 'BR' : null
    const action = body.action
    const code = sanitize(String(body.code || body.newCode || ''))
    const name = sanitize(String(body.name || ''))
    if (!zone || !code || !['create', 'rename'].includes(action)) {
      return NextResponse.json({ error: 'Bad request: need action create|rename, zone US|BR, code/newCode.' }, { status: 400 })
    }
    const root = ROOTS[zone]
    const target = `${code}${name ? ' - ' + name : ''}`
    const token = await dbxAccessToken()

    if (action === 'create') {
      const existing = await findFolderByCode(token, root, code)
      if (existing) return NextResponse.json({ ok: true, result: 'already-exists', folder: existing })
      const r = await dbx(token, 'files/create_folder_v2', { path: `${root}/${target}`, autorename: false })
      if (!r.ok && !r.text.includes('conflict')) {
        return NextResponse.json({ error: 'create failed: ' + r.text.slice(0, 200) }, { status: 502 })
      }
      return NextResponse.json({ ok: true, result: 'created', folder: target })
    }

    // rename / renumber
    const oldCode = sanitize(String(body.oldCode || ''))
    const from = oldCode ? await findFolderByCode(token, root, oldCode) : null
    if (!from) {
      // Self-heal: no folder for the old code — just create the new one.
      const r = await dbx(token, 'files/create_folder_v2', { path: `${root}/${target}`, autorename: false })
      if (!r.ok && !r.text.includes('conflict')) {
        return NextResponse.json({ error: 'create-on-rename failed: ' + r.text.slice(0, 200) }, { status: 502 })
      }
      return NextResponse.json({ ok: true, result: 'created (no old folder found)', folder: target })
    }
    if (from === target) return NextResponse.json({ ok: true, result: 'unchanged', folder: target })
    const mv = await dbx(token, 'files/move_v2', { from_path: `${root}/${from}`, to_path: `${root}/${target}`, autorename: false })
    if (!mv.ok) {
      if (mv.text.includes('conflict')) return NextResponse.json({ ok: true, result: 'target-exists', folder: target })
      return NextResponse.json({ error: 'rename failed: ' + mv.text.slice(0, 200) }, { status: 502 })
    }
    return NextResponse.json({ ok: true, result: 'renamed', from, folder: target })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
