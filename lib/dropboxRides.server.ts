// SERVER-ONLY — DROPBOX DAS PASTAS DE CARRO. Os ajudantes que viviam dentro de
// app/api/ride-folder/route.ts saíram para cá em 27/set/2026, para a rota nova
// /api/rides/renumber usar exatamente o mesmo código (um caminho só, pedido da
// AutoBook GZ28US aprovado pelo Márcio). O comportamento é o mesmo de antes.
//
// Zonas — os dois apps dividem UMA conta do Dropbox, então qualquer um mexe nas duas:
//   US -> /001 - GZ28US/GZ28US Rides
//   BR -> /000 - GZ28BR/GZ28BR Rides
// Env (segredos do servidor, na Vercel e no .env.local):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN

export const ROOTS: Record<string, string> = {
  US: '/001 - GZ28US/GZ28US Rides',
  BR: '/000 - GZ28BR/GZ28BR Rides',
}

// Windows-invalid filename characters can't exist in Dropbox names that need
// to sync to the PC; also collapse whitespace.
// O PONTO FINAL TAMBÉM NÃO EXISTE no Windows: uma pasta chamada "...Campo Grande."
// nasce no Dropbox mas chega ao PC como "...Campo Grande_", e aí nuvem e disco
// carregam nomes diferentes para sempre (visto na BR.539.1, 08/set/2026).
export const sanitize = (s: string) => (s || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')

export async function dbxAccessToken(): Promise<string> {
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

export async function dbx(token: string, endpoint: string, body: unknown): Promise<any> {
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
export const nomeNu = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
export async function findFolderByCode(token: string, root: string, code: string, name?: string): Promise<string | null> {
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

// Every ride folder carries these standard subfolders — ensured (idempotent) on
// every create/rename so old folders self-heal too.
// "Invoices" guarda uma pasta POR INVOICE do carro ("US.021.1 - <nome>"), e dentro
// dela os recibos das expenses daquela invoice. Purchases continua existindo para o
// que é do carro mas não se sabe de qual invoice (Márcio, 08/set/2026).
export const SUBFOLDERS = ['HB Tuning', 'Purchases', 'Performance', 'Documentation', 'Invoices']

// A pasta de triagem tem nome POR ZONA — Screening nos rides US, Volante nos BR —
// derivado do path, então qualquer um dos apps nomeia certo mexendo na outra zona.
export async function ensureSubfolders(token: string, folderPath: string) {
  const subs = [...SUBFOLDERS, folderPath.startsWith(ROOTS.BR) ? 'Volante' : 'Screening']
  for (const sub of subs) {
    const r = await dbx(token, 'files/create_folder_v2', { path: `${folderPath}/${sub}`, autorename: false })
    if (!r.ok && !r.text.includes('conflict')) {
      console.error('[ride-folder] subfolder create failed', { path: `${folderPath}/${sub}`, err: r.text.slice(0, 200) })
    }
  }
}

// ── NOVO (27/set/2026) — para a renumeração ─────────────────────────────────

// Existe algo exatamente neste caminho?
export async function pathExists(token: string, path: string): Promise<boolean> {
  const r = await dbx(token, 'files/get_metadata', { path })
  return r.ok
}

// O TOKEN DO CÓDIGO dentro de um nome: «US.042» casa em «US.042 - HellMonster»,
// «US.042.1 - Kit», «US.042 HellMonster BuildSheet.pdf» e «(US.049 + US.050)», mas
// nunca em «US.0421» nem em «XUS.042». Troca TODAS as ocorrências.
export function codeTokenRegex(code: string): RegExp {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c)
  return new RegExp(`(^|[^A-Za-z0-9])${esc}(?!\\d)`, 'g')
}
export function recodeName(name: string, oldCode: string, newCode: string): string {
  return name.replace(codeTokenRegex(oldCode), (_m, antes) => `${antes}${newCode}`)
}

// RECODE RECURSIVO: todo nome (subpasta ou arquivo, em qualquer profundidade) que
// carrega o código antigo passa a carregar o novo. Renomeia do mais fundo para o
// mais raso, para o caminho dos de cima continuar valendo. Colisão NÃO sobrescreve:
// vira falha relatada, e o arquivo fica com o nome velho para alguém decidir.
export async function recodeTree(token: string, folderPath: string, oldCode: string, newCode: string, dryRun = false): Promise<{ renamed: string[]; conflicts: string[]; failures: string[]; planned: number }> {
  const entries: { path: string; name: string; depth: number }[] = []
  let cursor: string | null = null
  do {
    const r: any = cursor
      ? await dbx(token, 'files/list_folder/continue', { cursor })
      : await dbx(token, 'files/list_folder', { path: folderPath, recursive: true, limit: 2000 })
    if (!r.ok) throw new Error('list_folder (recursivo) falhou em ' + folderPath + ': ' + r.text.slice(0, 200))
    for (const e of r.data.entries || []) {
      if (e['.tag'] !== 'file' && e['.tag'] !== 'folder') continue
      const name = String(e.name || '')
      if (recodeName(name, oldCode, newCode) === name) continue
      const path = String(e.path_display || '')
      entries.push({ path, name, depth: path.split('/').length })
    }
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  entries.sort((a, b) => b.depth - a.depth)
  const renamed: string[] = [], conflicts: string[] = [], failures: string[] = []
  if (dryRun) return { renamed, conflicts, failures, planned: entries.length }
  for (const e of entries) {
    const parent = e.path.slice(0, e.path.length - e.name.length - 1)
    const to = `${parent}/${recodeName(e.name, oldCode, newCode)}`
    const mv = await dbx(token, 'files/move_v2', { from_path: e.path, to_path: to, autorename: false })
    if (mv.ok) { renamed.push(`${e.name} → ${to.split('/').pop()}`); continue }
    const tag = JSON.stringify(mv.data?.error || {})
    if (tag.includes('conflict')) conflicts.push(`${e.path} → já existe ${to.split('/').pop()}`)
    else failures.push(`${e.path}: ${tag.slice(0, 120)}`)
  }
  return { renamed, conflicts, failures, planned: entries.length }
}
