import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

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

// Find LEGACY-format folders for a ride — "317 - HeartBeat" or "GZ28BR.317 - HeartBeat"
// (pre-system naming, no zone prefix). Adoption requires BOTH the number AND the
// name to match (name compared case/space/punctuation-insensitively), and still
// only fires when exactly ONE candidate matches — never guesses.
async function findLegacyFolders(token: string, root: string, zone: string, code: string, name: string): Promise<string[]> {
  const mNum = code.match(/^(?:US|BR|GM)\.(\d+)$/)
  if (!mNum) return []
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = norm(name)
  if (!want) return [] // no ride name — nothing to safely match against
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
      let rest: string | null = null
      if (e.name.startsWith(num + ' ')) rest = e.name.slice(num.length)
      else if (e.name.startsWith(alt + ' ')) rest = e.name.slice(alt.length)
      if (rest != null && norm(rest) === want) hits.push(e.name)
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
const SUBFOLDERS = ['HB Tuning', 'Purchases', 'Performance', 'Documentation']
// A pasta de triagem tem nome POR ZONA — Screening nos rides US, Volante nos BR —
// derivado do path, então qualquer um dos apps nomeia certo mexendo na outra zona.
async function ensureSubfolders(token: string, folderPath: string) {
  const subs = [...SUBFOLDERS, folderPath.startsWith(ROOTS.BR) ? 'Volante' : 'Screening']
  for (const sub of subs) {
    const r = await dbx(token, 'files/create_folder_v2', { path: `${folderPath}/${sub}`, autorename: false })
    if (!r.ok && !r.text.includes('conflict')) {
      console.error('[ride-folder] subfolder create failed', { path: `${folderPath}/${sub}`, err: r.text.slice(0, 200) })
    }
  }
}

// MAIL FOLDER SYNC — the gz28us@hotmail mailbox mirrors the ride archive under
// its "Rides" parent folder ("Rides/US.028 - GenesiZ"). Ride create/rename keeps
// that folder in step too (zone US only — BR cars have no mail-folder convention
// yet). Best-effort: a Graph hiccup never fails the Dropbox sync.
async function syncMailFolder(action: 'create' | 'rename', code: string, name: string, oldCode?: string) {
  try {
    const db = streamDb()
    const auth = await getMailAuth(db, 1)
    if (!auth?.refresh_token) return
    const token = await freshAccessToken(db, auth)
    if (!token) return
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const top = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders?$top=100', { headers: H }).then(r => r.json()).catch(() => null)
    const rides = (top?.value || []).find((f: any) => String(f.displayName).trim().toLowerCase() === 'rides')
    if (!rides) return
    const kids = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${rides.id}/childFolders?$top=200`, { headers: H }).then(r => r.json()).catch(() => null)
    const target = `${code}${name ? ' - ' + name : ''}`
    const byCode = (c: string) => (kids?.value || []).find((f: any) => {
      const dn = String(f.displayName || '')
      return dn === c || dn.startsWith(c + ' ')
    })
    const existing = byCode(code) || (action === 'rename' && oldCode ? byCode(oldCode) : null)
    if (existing) {
      if (existing.displayName !== target) {
        await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ displayName: target }),
        })
      }
      return
    }
    await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${rides.id}/childFolders`, {
      method: 'POST', headers: H, body: JSON.stringify({ displayName: target }),
    })
  } catch (err) {
    console.error('[ride-folder] mail folder sync failed', String(err).slice(0, 200))
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
    if (!code || !['create', 'rename', 'rename-file', 'retag', 'upload', 'find', 'mirror'].includes(action) || (!zone && action !== 'mirror')) {
      return NextResponse.json({ error: 'Bad request: need action create|rename|rename-file|retag|upload|find|mirror, zone US|BR (mirror: fromZone/toZone), code/newCode.' }, { status: 400 })
    }
    const root = zone ? ROOTS[zone] : ''
    const target = `${code}${name ? ' - ' + name : ''}`
    const token = await dbxAccessToken()

    // mirror: server-side copy of every file in one zone's ride subfolder into the
    // other zone's same-code ride folder (created if missing). Used when a GZ28US
    // car enters the BR system: its BoneStock TUNE + BuildSheet PDFs come along.
    if (action === 'mirror') {
      const fz = body.fromZone === 'US' ? 'US' : body.fromZone === 'BR' ? 'BR' : null
      const tz = body.toZone === 'US' ? 'US' : body.toZone === 'BR' ? 'BR' : null
      if (!fz || !tz || fz === tz) {
        return NextResponse.json({ error: 'Bad request: mirror needs distinct fromZone/toZone (US|BR).' }, { status: 400 })
      }
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      const srcFolder = await findFolderByCode(token, ROOTS[fz], code)
      if (!srcFolder) return NextResponse.json({ ok: true, result: 'no-source-folder', copied: [] })
      let dstFolder = await findFolderByCode(token, ROOTS[tz], code)
      if (!dstFolder) {
        dstFolder = target
        const c = await dbx(token, 'files/create_folder_v2', { path: `${ROOTS[tz]}/${dstFolder}`, autorename: false })
        if (!c.ok && !c.text.includes('conflict')) {
          return NextResponse.json({ error: 'mirror target create failed: ' + c.text.slice(0, 200) }, { status: 502 })
        }
      }
      await ensureSubfolders(token, `${ROOTS[tz]}/${dstFolder}`)
      const list = await dbx(token, 'files/list_folder', { path: `${ROOTS[fz]}/${srcFolder}/${sub}`, recursive: false, limit: 1000 })
      if (!list.ok) return NextResponse.json({ ok: true, result: 'no-source-subfolder', copied: [] })
      const copied: string[] = []
      for (const e of list.data.entries || []) {
        if (e['.tag'] !== 'file') continue
        const from_path = `${ROOTS[fz]}/${srcFolder}/${sub}/${e.name}`
        const to_path = `${ROOTS[tz]}/${dstFolder}/${sub}/${e.name}`
        let cp = await dbx(token, 'files/copy_v2', { from_path, to_path, autorename: false })
        if (!cp.ok && cp.text.includes('conflict')) {
          // Target already has the file — replace it with the source version.
          await dbx(token, 'files/delete_v2', { path: to_path })
          cp = await dbx(token, 'files/copy_v2', { from_path, to_path, autorename: false })
        }
        if (cp.ok) copied.push(e.name)
      }
      return NextResponse.json({ ok: true, result: 'mirrored', folder: dstFolder, copied })
    }
    // Every other action was validated to carry a zone.
    if (!zone) return NextResponse.json({ error: 'Bad request: zone required.' }, { status: 400 })

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
    // Renomeia UM arquivo dentro da subpasta do ride (ex.: o BuildSheet PDF quando o nome
    // do pack muda). `from` pode não existir (arquivo nunca gerado) — isso NÃO é erro:
    // devolve 'no-file' e o chamador decide se tenta um nome alternativo (Build.NN legado).
    // RETAG: o nome do carro dentro dos ARQUIVOS segue o ride (06/set/2026).
    // Roda DEPOIS do rename da pasta — procura a etiqueta "<CODIGO> - <Nome>"
    // que o app carimba no nome de todo arquivo que gera (BoneStock Tune,
    // BuildSheet PDF) e troca só ela, preservando prefixo e extensão. Varre a
    // HB Tuning do carro E a pasta plana do acervo, onde o nome do arquivo é a
    // única identidade que existe.
    if (action === 'retag') {
      const oldTag = sanitize(`${String(body.oldCode || '')}${body.oldName ? ' - ' + String(body.oldName) : ''}`)
      const newTag = sanitize(`${String(body.newCode || body.code || '')}${body.newName ? ' - ' + String(body.newName) : ''}`)
      if (!oldTag || !newTag) return NextResponse.json({ error: 'Bad request: retag needs oldCode/newCode.' }, { status: 400 })
      if (oldTag === newTag) return NextResponse.json({ ok: true, result: 'same-name', renamed: 0 })
      const dirs: string[] = []
      const repoName = sanitize(String(body.rootFolder || ''))
      if (repoName) dirs.push(`${root}/${repoName}`)
      // a pasta do carro já foi renomeada pelo action 'rename' — busca pelo código NOVO
      const folder = await findFolderByCode(token, root, sanitize(String(body.newCode || code)))
      if (folder) for (const sub of SUBFOLDERS) dirs.push(`${root}/${folder}/${sub}`)
      let renamed = 0
      const falhas: string[] = []
      for (const dir of dirs) {
        const list = await dbx(token, 'files/list_folder', { path: dir, recursive: false, limit: 2000 })
        if (!list.ok) continue   // pasta ausente não é erro: nada a renomear ali
        for (const e of (list.data?.entries || [])) {
          if (e['.tag'] !== 'file' || !String(e.name).includes(oldTag)) continue
          const to = String(e.name).split(oldTag).join(newTag)
          if (to === e.name) continue
          const mv = await dbx(token, 'files/move_v2', { from_path: `${dir}/${e.name}`, to_path: `${dir}/${to}`, autorename: false })
          if (mv.ok) renamed++
          else falhas.push(`${e.name}: ${JSON.stringify(mv.data?.error || {}).slice(0, 80)}`)
        }
      }
      return NextResponse.json({ ok: true, result: 'retagged', renamed, falhas })
    }

    if (action === 'rename-file') {
      const from = sanitize(String(body.from || ''))
      const to = sanitize(String(body.to || ''))
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      if (!from || !to) return NextResponse.json({ error: 'Bad request: rename-file needs from + to.' }, { status: 400 })
      if (from === to) return NextResponse.json({ ok: true, result: 'same-name' })
      const folder = await findFolderByCode(token, root, code)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder' })
      const mv = await dbx(token, 'files/move_v2', {
        from_path: `${root}/${folder}/${sub}/${from}`,
        to_path: `${root}/${folder}/${sub}/${to}`,
        autorename: false,
      })
      if (!mv.ok) {
        const tag = JSON.stringify(mv.data?.error || {})
        if (tag.includes('not_found')) return NextResponse.json({ ok: true, result: 'no-file' })
        if (tag.includes('conflict')) return NextResponse.json({ ok: true, result: 'conflict' })
        return NextResponse.json({ error: 'move failed: ' + mv.text.slice(0, 200) }, { status: 502 })
      }
      return NextResponse.json({ ok: true, result: 'renamed', path: `${folder}/${sub}/${to}` })
    }

    if (action === 'upload') {
      const filename = sanitize(String(body.filename || ''))
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      const b64 = String(body.contentBase64 || '')
      if (!filename || !b64) {
        return NextResponse.json({ error: 'Bad request: upload needs filename + contentBase64.' }, { status: 400 })
      }
      // rootFolder: grava numa pasta da RAIZ de Rides em vez de dentro do carro.
      // Nasceu para o BoneStock TuneRepository (06/set/2026), que é acervo da casa
      // inteira e não pertence a nenhum carro. Sem isto, o upload só sabia achar
      // pasta por código — e repositório não tem código.
      const rootFolder = sanitize(String(body.rootFolder || ''))
      if (rootFolder) {
        // idempotente: se já existe, o Dropbox devolve conflito e seguimos.
        await dbx(token, 'files/create_folder_v2', { path: `${root}/${rootFolder}`, autorename: false })
        const upR = await dbxUpload(token, `${root}/${rootFolder}/${filename}`, Buffer.from(b64, 'base64'))
        if (!upR.ok) return NextResponse.json({ error: 'upload failed: ' + upR.text.slice(0, 200) }, { status: 502 })
        return NextResponse.json({ ok: true, result: 'uploaded', path: `${rootFolder}/${filename}` })
      }
      const folder = await findFolderByCode(token, root, code)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder' })
      await ensureSubfolders(token, `${root}/${folder}`)
      const up = await dbxUpload(token, `${root}/${folder}/${sub}/${filename}`, Buffer.from(b64, 'base64'))
      if (!up.ok) return NextResponse.json({ error: 'upload failed: ' + up.text.slice(0, 200) }, { status: 502 })
      return NextResponse.json({ ok: true, result: 'uploaded', path: `${folder}/${sub}/${filename}` })
    }

    // Mail-folder mirror rides along with create/rename (US mailbox only).
    if (zone === 'US' && (action === 'create' || action === 'rename')) {
      await syncMailFolder(action, code, name, sanitize(String(body.oldCode || '')) || undefined)
    }

    if (action === 'create') {
      const existing = await findFolderByCode(token, root, code)
      if (existing) {
        await ensureSubfolders(token, `${root}/${existing}`)
        return NextResponse.json({ ok: true, result: 'already-exists', folder: existing })
      }
      // A legacy folder for this number ("317 - Name") gets ADOPTED: renamed to the
      // system format instead of duplicated. Only when exactly one candidate matches.
      const legacy = await findLegacyFolders(token, root, zone, code, name)
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
      const legacy = await findLegacyFolders(token, root, zone, code, name)
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
