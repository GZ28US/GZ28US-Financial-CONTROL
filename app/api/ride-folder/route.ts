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

// Find LEGACY-format folders for a code — "317 - Name" or "GZ28BR.317 - Name"
// (pre-system naming, no zone prefix). Returns ALL candidates: adoption only
// happens when exactly ONE matches, so duplicated legacy numbers (e.g.
// "005 - Flash" + "005 - Thor") are never guessed.
async function findLegacyFolders(token: string, root: string, zone: string, code: string): Promise<string[]> {
  const mNum = code.match(/^(?:US|BR|GM)\.(\d+)$/)
  if (!mNum) return []
  const num = mNum[1]
  const alt = `GZ28${zone}.${num}`
  const hits: string[] = []
  let cursor: string | null = null
  do {
    const r: any = cursor
      ? await dbx(token, 'files/list_folder/continue', { cursor })
      : await dbx(token, 'files/list_folder', { path: root, recursive: false, limit: 1000 })
    if (!r.ok) return []
    for (const e of r.data.entries || []) {
      if (e['.tag'] !== 'folder') continue
      if (e.name === num || e.name.startsWith(num + ' ') || e.name === alt || e.name.startsWith(alt + ' ')) hits.push(e.name)
    }
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  return hits
}

// Upload a small file into a ride folder (content endpoint, overwrite mode) —
// used to mirror the BUILD SHEET PDF into the car's HB Tuning folder.
async function dbxUpload(token: string, path: string, bytes: Buffer): Promise<{ ok: boolean; text: string }> {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false, mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: bytes as unknown as BodyInit,
  })
  const text = await res.text()
  return { ok: res.ok, text }
}

// Every ride folder carries these standard subfolders — ensured (idempotent) on
// every create/rename so old folders self-heal too.
const SUBFOLDERS = ['HB Tuning']
async function ensureSubfolders(token: string, folderPath: string) {
  for (const sub of SUBFOLDERS) {
    const r = await dbx(token, 'files/create_folder_v2', { path: `${folderPath}/${sub}`, autorename: false })
    if (!r.ok && !r.text.includes('conflict')) {
      console.error('[ride-folder] subfolder create failed', { path: `${folderPath}/${sub}`, err: r.text.slice(0, 200) })
    }
  }
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
    if (!zone || !code || !['create', 'rename', 'upload', 'find'].includes(action)) {
      return NextResponse.json({ error: 'Bad request: need action create|rename|upload|find, zone US|BR, code/newCode.' }, { status: 400 })
    }
    const root = ROOTS[zone]
    const target = `${code}${name ? ' - ' + name : ''}`
    const token = await dbxAccessToken()

    // find: list the files in the ride folder's subfolder (default HB Tuning),
    // optionally filtered by a case-insensitive name match. Used for status display.
    if (action === 'find') {
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      const match = String(body.match || '').toLowerCase()
      const folder = await findFolderByCode(token, root, code)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder', files: [] })
      const r = await dbx(token, 'files/list_folder', { path: `${root}/${folder}/${sub}`, recursive: false, limit: 1000 })
      if (!r.ok) return NextResponse.json({ ok: true, result: 'no-subfolder', files: [] })
      const files = (r.data.entries || [])
        .filter((e: any) => e['.tag'] === 'file' && (!match || String(e.name).toLowerCase().includes(match)))
        .map((e: any) => e.name)
      return NextResponse.json({ ok: true, result: 'found', files })
    }

    // upload: drop a file into the ride folder's subfolder (default HB Tuning),
    // overwriting any previous version. No self-heal folder creation — the file
    // only lands where the car's folder actually exists (common cars: both zones).
    if (action === 'upload') {
      const filename = sanitize(String(body.filename || ''))
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      const b64 = String(body.contentBase64 || '')
      if (!filename || !b64) {
        return NextResponse.json({ error: 'Bad request: upload needs filename + contentBase64.' }, { status: 400 })
      }
      const folder = await findFolderByCode(token, root, code)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder' })
      await ensureSubfolders(token, `${root}/${folder}`)
      const up = await dbxUpload(token, `${root}/${folder}/${sub}/${filename}`, Buffer.from(b64, 'base64'))
      if (!up.ok) return NextResponse.json({ error: 'upload failed: ' + up.text.slice(0, 200) }, { status: 502 })
      return NextResponse.json({ ok: true, result: 'uploaded', path: `${folder}/${sub}/${filename}` })
    }

    if (action === 'create') {
      const existing = await findFolderByCode(token, root, code)
      if (existing) {
        await ensureSubfolders(token, `${root}/${existing}`)
        return NextResponse.json({ ok: true, result: 'already-exists', folder: existing })
      }
      // A legacy folder for this number ("317 - Name") gets ADOPTED: renamed to the
      // system format instead of duplicated. Only when exactly one candidate matches.
      const legacy = await findLegacyFolders(token, root, zone, code)
      if (legacy.length === 1) {
        const mv = await dbx(token, 'files/move_v2', { from_path: `${root}/${legacy[0]}`, to_path: `${root}/${target}`, autorename: false })
        if (mv.ok) {
          await ensureSubfolders(token, `${root}/${target}`)
          return NextResponse.json({ ok: true, result: 'adopted-legacy', from: legacy[0], folder: target })
        }
        // Adoption failed — fall through to a plain create so the ride still gets a folder.
      }
      const r = await dbx(token, 'files/create_folder_v2', { path: `${root}/${target}`, autorename: false })
      if (!r.ok && !r.text.includes('conflict')) {
        return NextResponse.json({ error: 'create failed: ' + r.text.slice(0, 200) }, { status: 502 })
      }
      await ensureSubfolders(token, `${root}/${target}`)
      return NextResponse.json({ ok: true, result: 'created', folder: target })
    }

    // rename / renumber
    const oldCode = sanitize(String(body.oldCode || ''))
    const from = oldCode ? await findFolderByCode(token, root, oldCode) : null
    if (!from) {
      // Self-heal: no folder for the old code — adopt a legacy folder for the NEW code
      // if exactly one exists, else just create the new one.
      const legacy = await findLegacyFolders(token, root, zone, code)
      if (legacy.length === 1) {
        const mv = await dbx(token, 'files/move_v2', { from_path: `${root}/${legacy[0]}`, to_path: `${root}/${target}`, autorename: false })
        if (mv.ok) {
          await ensureSubfolders(token, `${root}/${target}`)
          return NextResponse.json({ ok: true, result: 'adopted-legacy', from: legacy[0], folder: target })
        }
      }
      const r = await dbx(token, 'files/create_folder_v2', { path: `${root}/${target}`, autorename: false })
      if (!r.ok && !r.text.includes('conflict')) {
        return NextResponse.json({ error: 'create-on-rename failed: ' + r.text.slice(0, 200) }, { status: 502 })
      }
      await ensureSubfolders(token, `${root}/${target}`)
      return NextResponse.json({ ok: true, result: 'created (no old folder found)', folder: target })
    }
    if (from === target) {
      await ensureSubfolders(token, `${root}/${target}`)
      return NextResponse.json({ ok: true, result: 'unchanged', folder: target })
    }
    const mv = await dbx(token, 'files/move_v2', { from_path: `${root}/${from}`, to_path: `${root}/${target}`, autorename: false })
    if (!mv.ok) {
      if (mv.text.includes('conflict')) return NextResponse.json({ ok: true, result: 'target-exists', folder: target })
      return NextResponse.json({ error: 'rename failed: ' + mv.text.slice(0, 200) }, { status: 502 })
    }
    await ensureSubfolders(token, `${root}/${target}`)
    return NextResponse.json({ ok: true, result: 'renamed', from, folder: target })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
