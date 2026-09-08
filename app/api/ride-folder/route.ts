import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { supplierDirectoryFrom, matchSupplier } from '@/lib/supplierMatch'
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

export const maxDuration = 60

const ROOTS: Record<string, string> = {
  US: '/001 - GZ28US/GZ28US Rides',
  BR: '/000 - GZ28BR/GZ28BR Rides',
}

// Windows-invalid filename characters can't exist in Dropbox names that need
// to sync to the PC; also collapse whitespace.
// O PONTO FINAL TAMBÉM NÃO EXISTE no Windows: uma pasta chamada "...Campo Grande."
// nasce no Dropbox mas chega ao PC como "...Campo Grande_", e aí nuvem e disco
// carregam nomes diferentes para sempre (visto na BR.539.1, 08/set/2026).
const sanitize = (s: string) => (s || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')

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

// Uma pasta só é do carro quando o CÓDIGO **e** o NOME batem.
// O caso que ensinou (06/set/2026): o Badillac era US.030, virou US.036, e a pasta
// velha "US.030 - Badillac" ficou para trás com o número colado. Procurando só pelo
// número, o app achou ela e gravou o BoneStock e a BuildSheet do DRACULA — o US.030
// de verdade — dentro da pasta do Badillac; o Dracula ficou sem os seus.
// Nome que contradiz o ride não serve: é melhor criar a pasta certa do que escrever
// na pasta de outro carro. Sem `name`, o número volta a mandar (chamadas antigas).
const nomeNu = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
async function findFolderByCode(token: string, root: string, code: string, name?: string): Promise<string | null> {
  const alvo = nomeNu(name || '')
  let soCodigo: string | null = null
  let cursor: string | null = null
  do {
    const r: any = cursor
      ? await dbx(token, 'files/list_folder/continue', { cursor })
      : await dbx(token, 'files/list_folder', { path: root, recursive: false, limit: 1000 })
    if (!r.ok) throw new Error('list_folder failed: ' + r.text.slice(0, 200))
    for (const e of r.data.entries || []) {
      if (e['.tag'] !== 'folder') continue
      if (e.name === code) return e.name                       // "US.030" pelado: é dele
      if (!e.name.startsWith(code + ' ')) continue
      const dela = nomeNu(e.name.slice(code.length).replace(/^\s*-\s*/, ''))
      if (alvo && dela === alvo) return e.name                 // código E nome batem
      if (!soCodigo) soCodigo = e.name                         // só o número bate — suspeita
    }
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  return alvo ? null : soCodigo
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
      // O caminho viaja em CABEÇALHO HTTP, que é ISO-8859-1: "ç" e "ã" chegariam
      // como bytes inválidos e o arquivo nasceria numa pasta de nome quebrado
      // (aconteceu com "Atualização GZ28" em 08/set/2026 — duas pastas, a certa
      // vazia e a torta com os arquivos dentro). A receita da Dropbox é escapar
      // tudo que passa de ASCII como \uXXXX; o JSON continua válido do outro lado.
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false, mute: true })
        .replace(/[^ -~]/g, (c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
      'Content-Type': 'application/octet-stream',
    },
    body: bytes as unknown as BodyInit,
  })
  const text = await res.text()
  return { ok: res.ok, text }
}

// Every ride folder carries these standard subfolders — ensured (idempotent) on
// every create/rename so old folders self-heal too.
// As três etiquetas de OS que o app carimba no nome do tune. "BoneStock" só fica
// no carro que não teve atualização de OS (lei do Márcio, 06/set/2026).
const OS_TAGS = ['BoneStock', 'Demon170 Converted Stock', 'Other OS Converted Stock']
// "Invoices" guarda uma pasta POR INVOICE do carro ("US.021.1 - <nome>"), e dentro
// dela os recibos das expenses daquela invoice. Purchases continua existindo para o
// que é do carro mas não se sabe de qual invoice (Márcio, 08/set/2026).
const SUBFOLDERS = ['HB Tuning', 'Purchases', 'Performance', 'Documentation', 'Invoices']
// A pasta de uma invoice: código + nome (o `service` da invoice; sem ele, o nome do
// carro). É o mesmo formato da pasta do ride, um nível abaixo.
const invoiceFolderName = (code: string, name: string) => sanitize(`${code}${name ? ' - ' + name : ''}`)
// O RECIBO PODE ESTAR EM VÁRIAS LINHAS. O scan grava a mesma URL no grupo de
// compra inteiro, e o campo nasceu como URL crua e virou lista JSON — as duas
// formas convivem no banco. Aqui as duas viram a mesma coisa: uma lista de URLs.
function parseReceiptUrls(v: unknown): string[] {
  if (!v) return []
  const bruto = Array.isArray(v) ? v.map(String) : (() => {
    const s = String(v).trim()
    if (!s || s === '[]') return []
    if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : [] } catch { return [] } }
    return [s]
  })()
  return bruto.map(s => s.trim()).filter(s => /^https?:\/\//.test(s))
}

// O Dropbox identifica CONTEÚDO por um hash próprio: SHA-256 de cada bloco de
// 4 MiB, concatenados, SHA-256 de novo. É ele que responde "este arquivo já é o
// mesmo documento?" sem baixar nada. Dele saem as duas garantias desta rota:
// não reenviar o que já está lá, e só apagar da Purchases o que já está salvo
// IDÊNTICO no lugar certo (ordem do Márcio, 08/set/2026).
function dropboxHash(buf: Buffer): string {
  const BLOCO = 4 * 1024 * 1024
  const partes: Buffer[] = []
  for (let i = 0; i < buf.length; i += BLOCO) partes.push(createHash('sha256').update(buf.subarray(i, i + BLOCO)).digest())
  return createHash('sha256').update(Buffer.concat(partes)).digest('hex')
}

// Lista rasa que não explode quando a pasta ainda não existe.
async function listaArquivos(token: string, path: string): Promise<{ name: string; hash: string }[]> {
  const out: { name: string; hash: string }[] = []
  let cursor: string | null = null
  do {
    const r: any = cursor
      ? await dbx(token, 'files/list_folder/continue', { cursor })
      : await dbx(token, 'files/list_folder', { path, recursive: false, limit: 2000 })
    if (!r.ok) return out
    for (const e of r.data.entries || []) if (e['.tag'] === 'file') out.push({ name: e.name, hash: e.content_hash || '' })
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  return out
}

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
    if ((!code && action !== 'invoice-receipts') || !['create', 'rename', 'rename-file', 'retag', 'retag-os', 'upload', 'find', 'mirror', 'invoice-folder', 'invoice-receipts'].includes(action) || (!zone && action !== 'mirror')) {
      return NextResponse.json({ error: 'Bad request: need action create|rename|rename-file|retag|retag-os|upload|find|mirror, zone US|BR (mirror: fromZone/toZone), code/newCode.' }, { status: 400 })
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
      const srcFolder = await findFolderByCode(token, ROOTS[fz], code, name)
      if (!srcFolder) return NextResponse.json({ ok: true, result: 'no-source-folder', copied: [] })
      let dstFolder = await findFolderByCode(token, ROOTS[tz], code, name)
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
      const folder = await findFolderByCode(token, root, code, name)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder', files: [] })
      const r = await dbx(token, 'files/list_folder', { path: `${root}/${folder}/${sub}`, recursive: false, limit: 1000 })
      if (!r.ok) return NextResponse.json({ ok: true, result: 'no-subfolder', files: [] })
      const files = (r.data.entries || [])
        .filter((e: any) => e['.tag'] === 'file' && (!match || String(e.name).toLowerCase().includes(match)))
        .map((e: any) => e.name)
      return NextResponse.json({ ok: true, result: 'found', files })
    }

    // upload: drop a file into the ride folder's subfolder (default HB Tuning),
    // overwriting any previous version. Se a pasta do carro não existir, ela nasce:
    // arquivo salvo é arquivo que tem que estar em algum lugar certo.
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
      const folder = await findFolderByCode(token, root, sanitize(String(body.newCode || code)), name)
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
          if (mv.ok) { renamed++; continue }
          // COLISÃO: o nome novo já existe. Acontece com BuildSheet do MESMO pack
          // gerada antes e depois de um rename — as duas viram o mesmo nome. NÃO
          // sobrescrever: a sheet anterior fica na pasta (lei do Márcio). Desempata
          // pela data do próprio arquivo, para que TODOS fiquem com o nome atual do
          // carro e nenhum se perca.
          if (JSON.stringify(mv.data?.error || {}).includes('conflict')) {
            const dia = String(e.client_modified || e.server_modified || '').slice(0, 10)
            const ponto = to.lastIndexOf('.')
            const datado = dia && ponto > 0 ? `${to.slice(0, ponto)} ${dia}${to.slice(ponto)}` : ''
            if (datado) {
              const mv2 = await dbx(token, 'files/move_v2', { from_path: `${dir}/${e.name}`, to_path: `${dir}/${datado}`, autorename: false })
              if (mv2.ok) { renamed++; continue }
            }
          }
          falhas.push(`${e.name}: ${JSON.stringify(mv.data?.error || {}).slice(0, 80)}`)
        }
      }
      return NextResponse.json({ ok: true, result: 'retagged', renamed, falhas })
    }

    // RETAG-OS: o nome do TUNE segue o OS do módulo (06/set/2026).
    // "BoneStock" só fica no carro que não teve atualização de OS; convertido pro
    // OS do Demon 170 é "Demon170 Converted Stock", qualquer outro é "Other OS
    // Converted Stock". Antes, o nome só nascia no upload — mudar o OS na ficha
    // deixava o arquivo mentindo (o caso do Dracula). Aqui a etiqueta de OS é
    // trocada nos arquivos que JÁ estão no Dropbox, na pasta do carro e no acervo.
    if (action === 'retag-os') {
      const novo = sanitize(String(body.osTag || ''))
      if (!OS_TAGS.includes(novo)) {
        return NextResponse.json({ error: 'Bad request: retag-os needs osTag = ' + OS_TAGS.join(' | ') }, { status: 400 })
      }
      // Sem NOME o carro não se identifica: a etiqueta viraria só o número e
      // findFolderByCode cairia na busca frouxa — foi assim que o tune do Dracula
      // foi parar na pasta do Badillac. Sem nome, não mexe em nada.
      if (!name) return NextResponse.json({ ok: true, result: 'no-name', renamed: 0 })
      const etiqueta = sanitize(`${code} - ${name}`)
      const dirs: string[] = []
      const repoName = sanitize(String(body.rootFolder || ''))
      if (repoName) dirs.push(`${root}/${repoName}`)
      const folder = await findFolderByCode(token, root, code, name)
      if (folder) for (const sub of SUBFOLDERS) dirs.push(`${root}/${folder}/${sub}`)
      // "<prefixo> <CÓDIGO> - <Nome> <ETIQUETA DE OS> Tune.<ext>". O (.*) guloso
      // casa a ÚLTIMA ocorrência da etiqueta, que é onde ela mora — o prefixo do
      // arquivo pode conter as mesmas palavras.
      // O sufixo de data é opcional e PRESERVADO: quem ganhou data num desempate
      // de colisão continua sendo re-etiquetado, em vez de ficar congelado com a
      // etiqueta velha para sempre.
      const re = new RegExp(`^(.*) (${OS_TAGS.join('|')}) Tune( \\d{4}-\\d{2}-\\d{2})?(\\.[A-Za-z0-9]+)$`)
      let renamed = 0
      const falhas: string[] = []
      for (const dir of dirs) {
        const list = await dbx(token, 'files/list_folder', { path: dir, recursive: false, limit: 2000 })
        if (!list.ok) continue   // pasta ausente não é erro: nada a renomear ali
        for (const e of (list.data?.entries || [])) {
          if (e['.tag'] !== 'file') continue
          const nome = String(e.name)
          // O acervo é plano e guarda o tune de TODO carro: só mexe no deste.
          if (!nome.includes(etiqueta + ' ')) continue
          const m = nome.match(re)
          if (!m || m[2] === novo) continue
          const to = `${m[1]} ${novo} Tune${m[3] || ''}${m[4]}`
          const mv = await dbx(token, 'files/move_v2', { from_path: `${dir}/${nome}`, to_path: `${dir}/${to}`, autorename: false })
          if (mv.ok) { renamed++; continue }
          // COLISÃO: já existe um tune com o OS novo. São leituras diferentes do
          // módulo e nenhuma se perde — a que chega desempata pela própria data.
          // m[3] = já tem data de um desempate anterior. Datar de novo só faz o
          // nome crescer; nesse caso a colisão vira falha relatada.
          if (!m[3] && JSON.stringify(mv.data?.error || {}).includes('conflict')) {
            const dia = String(e.client_modified || e.server_modified || '').slice(0, 10)
            const ponto = to.lastIndexOf('.')
            const datado = dia && ponto > 0 ? `${to.slice(0, ponto)} ${dia}${to.slice(ponto)}` : ''
            if (datado) {
              const mv2 = await dbx(token, 'files/move_v2', { from_path: `${dir}/${nome}`, to_path: `${dir}/${datado}`, autorename: false })
              if (mv2.ok) { renamed++; continue }
            }
          }
          falhas.push(`${nome}: ${JSON.stringify(mv.data?.error || {}).slice(0, 80)}`)
        }
      }
      return NextResponse.json({ ok: true, result: 'retagged-os', renamed, falhas })
    }

    // RECIBOS DA INVOICE (Márcio, 08/set/2026). "TODAS as invoices de expenses
    // desta invoice, devidamente nomeadas, com o [cod invoice] [ride] - [supplier]
    // [order #]". A tela manda só o invoiceId — código, carro, fornecedor e pedido
    // saem do banco, que é quem sabe a verdade de agora. Por isso renomear a
    // invoice ou renumerar o carro conserta os arquivos: é só chamar de novo.
    // dryRun devolve o plano sem tocar em nada.
    if (action === 'invoice-receipts') {
      const invoiceId = String(body.invoiceId || '')
      if (!invoiceId) return NextResponse.json({ error: 'Bad request: invoice-receipts needs invoiceId.' }, { status: 400 })
      const dry = !!body.dryRun
      const sUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!sUrl || !sKey) return NextResponse.json({ error: 'no service key' }, { status: 500 })
      const db = createClient(sUrl, sKey, { auth: { persistSession: false } })

      const { data: inv } = await db.from('invoices').select('id, invoice_code, service, ride_id, is_quote').eq('id', invoiceId).maybeSingle()
      if (!inv) return NextResponse.json({ ok: true, result: 'no-invoice' })
      // Quote não tem pasta (o carro dela também não tem) e invoice sem carro não
      // tem onde morar — as duas saem em silêncio, não são erro.
      if (inv.is_quote || !inv.ride_id) return NextResponse.json({ ok: true, result: 'quote-or-no-ride' })
      const { data: ride } = await db.from('rides').select('project_code, project_name').eq('id', inv.ride_id).maybeSingle()
      if (!ride?.project_code) return NextResponse.json({ ok: true, result: 'no-ride' })

      const rCode = sanitize(String(ride.project_code))
      const rName = sanitize(String(ride.project_name || ''))
      let folder = await findFolderByCode(token, root, rCode, rName)
      if (!folder) {
        // PASTA COM O NOME VELHO ("178 - SigSauer", sem prefixo de zona): número
        // E nome têm de bater, e só serve resposta única — recibo não entra em
        // pasta escolhida no chute. Aqui só se ESCREVE nela; adotar (renomear) é
        // trabalho do create/rename, não do sincronizador de recibo.
        const legado = await findLegacyFolders(token, root, zone || '', rCode, rName)
        if (legado.length === 1) folder = legado[0]
      }
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder' })
      const invCode = sanitize(String(inv.invoice_code || ''))
      const invName = sanitize(String(inv.service || '').trim() || String(ride.project_name || ''))
      const destino = `${root}/${folder}/Invoices/${invoiceFolderName(invCode, invName)}`

      // O NOME NO ARQUIVO É O DO CADASTRO (lei de 04/set/2026). A linha antiga
      // guarda a grafia crua do recibo — "Titan Motorsports, 11370 Boggy Creek
      // Rd. Orlando FL 32824" — e ela viraria nome de arquivo e caminho de 230
      // caracteres. Sem cadastro que case, fica a grafia crua: inventar é pior.
      const { data: sups } = await db.from('suppliers').select('name, aliases, is_dealership')
      const dir = supplierDirectoryFrom(sups || [])
      const curado = (n: string) => (n ? (matchSupplier(n, dir)?.name || n) : n)

      const { data: exps } = await db.from('invoice_expenses').select('supplier, order_number, receipt_url').eq('invoice_id', invoiceId)
      const porUrl = new Map<string, { supplier: string; order: string }>()
      for (const e of exps || []) {
        for (const u of parseReceiptUrls((e as any).receipt_url)) {
          const at = porUrl.get(u) || { supplier: '', order: '' }
          if (!at.supplier) at.supplier = curado(String((e as any).supplier || '').trim())
          if (!at.order) at.order = String((e as any).order_number || '').trim()
          porUrl.set(u, at)
        }
      }
      if (!porUrl.size) return NextResponse.json({ ok: true, result: 'no-receipts', folder: destino })

      // O NOME. Ordenado pela URL para o desempate de homônimos ser sempre o
      // mesmo — rodar de novo não pode renomear o que já está certo.
      const carro = sanitize(String(ride.project_name || ''))
      const usados = new Map<string, number>()
      const esperados: { url: string; nome: string }[] = []
      for (const u of [...porUrl.keys()].sort()) {
        const { supplier, order } = porUrl.get(u)!
        const ext = ((u.split('?')[0].split('/').pop() || '').split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'pdf'
        const base = sanitize(`${invCode}${carro ? ' ' + carro : ''} - ${supplier || 'Receipt'}${order ? ' ' + order : ''}`)
        const n = (usados.get(base) || 0) + 1
        usados.set(base, n)
        esperados.push({ url: u, nome: `${base}${n > 1 ? ' (' + n + ')' : ''}.${ext}` })
      }

      const jaLa = await listaArquivos(token, destino)
      const hashDe = new Map(jaLa.map(f => [f.name, f.hash]))

      // ATALHO DO CASO COMUM. A URL de um recibo é imutável (o nome no storage
      // leva timestamp + aleatório), então nome esperado presente e nada
      // sobrando na pasta querem dizer "nada mudou". Sem isto, todo SAVE
      // baixaria os recibos inteiros da invoice só para calcular hash.
      const nomesEsperados = new Set(esperados.map(e => e.nome))
      const faltando = esperados.some(e => !hashDe.has(e.nome))
      const sobrando = jaLa.some(f => !nomesEsperados.has(f.name))
      if (!faltando && !sobrando) {
        return NextResponse.json({ ok: true, result: 'unchanged', folder: destino, uploaded: [], unchanged: esperados.map(e => e.nome), renamedAway: [], purchasesCleared: [], failed: [], pending: 0 })
      }
      const enviados: string[] = [], iguais: string[] = [], falhos: string[] = []
      const hashesCertos = new Set<string>()
      let restam = 0
      for (const { url, nome } of esperados) {
        // Já está lá com o mesmo conteúdo? Não baixa, não sobe: o caso comum é
        // este, e é ele que faz a rota ser barata de chamar em todo save.
        const bytes = await fetch(url).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
        if (!bytes) { falhos.push(nome); continue }
        const buf = Buffer.from(bytes)
        const h = dropboxHash(buf)
        hashesCertos.add(h)
        if (hashDe.get(nome) === h) { iguais.push(nome); continue }
        if (dry) { enviados.push(nome); continue }
        if (enviados.length >= 25) { restam++; continue }   // teto por chamada; chamar de novo continua
        await dbx(token, 'files/create_folder_v2', { path: destino, autorename: false })
        const up = await dbxUpload(token, `${destino}/${nome}`, buf)
        if (up.ok) enviados.push(nome); else falhos.push(nome)
      }

      // SOBRAS DO NOME VELHO. Arquivo nesta pasta que não é nenhum dos esperados,
      // mas cujo CONTEÚDO é de um deles, é o mesmo documento com o nome de antes
      // do renome — morre. O que não bate hash nenhum fica: pode ser papel que o
      // Márcio pôs à mão, e isso não se apaga por dedução.
      const removidos: string[] = []
      const nomesCertos = new Set(esperados.map(e => e.nome))
      for (const f of jaLa) {
        if (nomesCertos.has(f.name) || !hashesCertos.has(f.hash)) continue
        if (!dry) await dbx(token, 'files/delete_v2', { path: `${destino}/${f.name}` })
        removidos.push(f.name)
      }

      // PURCHASES: "só deixe nas pastas purchases o que vc não encontrar de qual
      // invoice é". O que já está salvo IDÊNTICO na pasta da invoice sai de lá —
      // e a régua é o hash, nunca o nome.
      const daPurchases: string[] = []
      const pur = `${root}/${folder}/Purchases`
      for (const f of await listaArquivos(token, pur)) {
        if (!hashesCertos.has(f.hash)) continue
        if (!dry) await dbx(token, 'files/delete_v2', { path: `${pur}/${f.name}` })
        daPurchases.push(f.name)
      }

      return NextResponse.json({
        ok: true, result: dry ? 'plan' : 'synced', folder: destino,
        uploaded: enviados, unchanged: iguais, renamedAway: removidos,
        purchasesCleared: daPurchases, failed: falhos, pending: restam,
      })
    }

    // INVOICE-FOLDER: garante "Invoices/<código> - <nome>" dentro do carro, e a
    // renomeia quando o código ou o nome da invoice mudam. Chamada no nascimento da
    // invoice e a cada save dela — é o que mantém a pasta viva junto com o dado.
    if (action === 'invoice-folder') {
      const invCode = sanitize(String(body.invoiceCode || ''))
      const invName = sanitize(String(body.invoiceName || ''))
      if (!invCode) return NextResponse.json({ error: 'Bad request: invoice-folder needs invoiceCode.' }, { status: 400 })
      const folder = await findFolderByCode(token, root, code, name)
      if (!folder) return NextResponse.json({ ok: true, result: 'no-folder' })
      const base = `${root}/${folder}/Invoices`
      await dbx(token, 'files/create_folder_v2', { path: base, autorename: false })
      const alvo = invoiceFolderName(invCode, invName)

      // Já existe uma pasta desta invoice com OUTRO nome? Renomeia em vez de criar
      // uma segunda — o código da invoice é a identidade, o nome é etiqueta.
      const velhoCode = sanitize(String(body.oldInvoiceCode || '')) || invCode
      const lista = await dbx(token, 'files/list_folder', { path: base, recursive: false, limit: 2000 })
      const atual = (lista.data?.entries || []).find((e: any) =>
        e['.tag'] === 'folder' && (e.name === velhoCode || e.name.startsWith(velhoCode + ' ')))
      if (atual && atual.name !== alvo) {
        const mv = await dbx(token, 'files/move_v2', { from_path: `${base}/${atual.name}`, to_path: `${base}/${alvo}`, autorename: false })
        if (mv.ok) return NextResponse.json({ ok: true, result: 'renamed', from: atual.name, folder: alvo })
      }
      if (atual) return NextResponse.json({ ok: true, result: 'already-exists', folder: alvo })
      const c = await dbx(token, 'files/create_folder_v2', { path: `${base}/${alvo}`, autorename: false })
      if (!c.ok && !c.text.includes('conflict')) {
        return NextResponse.json({ error: 'invoice folder create failed: ' + c.text.slice(0, 200) }, { status: 502 })
      }
      return NextResponse.json({ ok: true, result: 'created', folder: alvo })
    }

    if (action === 'rename-file') {
      const from = sanitize(String(body.from || ''))
      const to = sanitize(String(body.to || ''))
      const sub = sanitize(String(body.subfolder || 'HB Tuning'))
      if (!from || !to) return NextResponse.json({ error: 'Bad request: rename-file needs from + to.' }, { status: 400 })
      if (from === to) return NextResponse.json({ ok: true, result: 'same-name' })
      const folder = await findFolderByCode(token, root, code, name)
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
      let folder = await findFolderByCode(token, root, code, name)
      if (!folder) {
        // A pasta do carro pode não existir (ou a que existe é de outro carro com
        // o número velho). O arquivo não pode se perder: cria a pasta certa.
        await dbx(token, 'files/create_folder_v2', { path: `${root}/${target}`, autorename: false })
        folder = target
      }
      await ensureSubfolders(token, `${root}/${folder}`)
      // RECIBO DE EXPENSE: cai em "Invoices/<código> - <nome>", não solto no carro.
      // O sanitize come a barra, então o caminho aninhado vem em campo próprio.
      const invFolder = invoiceFolderName(sanitize(String(body.invoiceCode || '')), sanitize(String(body.invoiceName || '')))
      if (invFolder) {
        const destino = `${root}/${folder}/Invoices/${invFolder}`
        await dbx(token, 'files/create_folder_v2', { path: destino, autorename: false })
        const upI = await dbxUpload(token, `${destino}/${filename}`, Buffer.from(b64, 'base64'))
        if (!upI.ok) return NextResponse.json({ error: 'upload failed: ' + upI.text.slice(0, 200) }, { status: 502 })
        return NextResponse.json({ ok: true, result: 'uploaded', path: `${folder}/Invoices/${invFolder}/${filename}` })
      }
      const up = await dbxUpload(token, `${root}/${folder}/${sub}/${filename}`, Buffer.from(b64, 'base64'))
      if (!up.ok) return NextResponse.json({ error: 'upload failed: ' + up.text.slice(0, 200) }, { status: 502 })
      return NextResponse.json({ ok: true, result: 'uploaded', path: `${folder}/${sub}/${filename}` })
    }

    // Mail-folder mirror rides along with create/rename (US mailbox only).
    if (zone === 'US' && (action === 'create' || action === 'rename')) {
      await syncMailFolder(action, code, name, sanitize(String(body.oldCode || '')) || undefined)
    }

    if (action === 'create') {
      const existing = await findFolderByCode(token, root, code, name)
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
    const oldName = sanitize(String(body.oldName || ''))
    // Com o nome velho em mãos a pasta se identifica sozinha. Sem ele, procura a
    // pasta que já está com o nome novo (renomear seria à toa) e só então cede ao
    // número. Assim o rename de um carro nunca renomeia a pasta de outro.
    const from = oldCode
      ? (await findFolderByCode(token, root, oldCode, oldName || undefined))
        || (oldName ? null : await findFolderByCode(token, root, oldCode))
      : null
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
