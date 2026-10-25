// SERVER-ONLY — PASTAS DE E-MAIL DO CARRO seguem o código (27/set/2026).
// Pedido da AutoBook GZ28US, aprovado pelo Márcio («everything»): na renumeração, as
// pastas «Rides/<código> - <nome>» (e as irmãs em Purchases e na raiz, como
// «Purchases/US.049 - Demon Preto» e «US.040 - HellMonster») mudam de código nas caixas
// 1 e 2 (Outlook/Graph) e 4 (Gmail, onde pasta é label).
//
// O que mudou em relação ao syncMailFolder antigo do /api/ride-folder:
//   • casa CÓDIGO **e** NOME — renomear o Badillac US.036→US.033 com a pasta
//     «US.033 - DemonRango» ainda lá relabelava a pasta do DemonRango;
//   • procura em TODA a árvore, paginando (o antigo lia só 200 filhas de «Rides»);
//   • colisão não sobrescreve: vira conflito relatado.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken, mailProvider, listMailAuths } from '@/lib/streamMail.server'
import { RAIZ_DA_EMPRESA, raizDoCodigo, comecaComCodigo, pastaDoCarro } from '@/lib/carMailFolder.server'

const nomeNu = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => String.fromCharCode(92) + c)

// «US.042 - HellMonster» é deste carro? Código exato no começo E nome igual (ou o código pelado).
function daPasta(displayName: string, oldCode: string, oldName: string): boolean {
  const dn = String(displayName || '').trim()
  if (dn === oldCode) return true
  const m = dn.match(new RegExp(`^${esc(oldCode)}(?!\\d)\\s*-?\\s*(.*)$`))
  if (!m) return false
  return !!oldName && nomeNu(m[1]) === nomeNu(oldName)
}
function nomeNovo(displayName: string, oldCode: string, newCode: string, oldName: string, newName: string): string {
  if (newName && nomeNu(newName) !== nomeNu(oldName)) return `${newCode} - ${newName}`
  return newCode + String(displayName).trim().slice(oldCode.length)
}

export type MailSlotReport = {
  slot: number; account: string; provider: string
  renamed: string[]; conflicts: string[]; errors: string[]; planned: string[]
}

async function graphAll(token: string): Promise<{ id: string; displayName: string; parentId: string | null; path: string; itens: number }[]> {
  const H = { Authorization: `Bearer ${token}` }
  const out: { id: string; displayName: string; parentId: string | null; path: string; itens: number }[] = []
  const lerTodas = async (url: string) => {
    const itens: any[] = []
    let next: string | null = url
    while (next) {
      const r: any = await fetch(next, { headers: H }).then(x => x.json()).catch(() => null)
      if (!r?.value) throw new Error('Graph mailFolders falhou: ' + JSON.stringify(r?.error || r || {}).slice(0, 160))
      itens.push(...r.value)
      next = r['@odata.nextLink'] || null
    }
    return itens
  }
  const sel = '$top=100&$select=id,displayName,childFolderCount,parentFolderId,totalItemCount'
  let fila: { id: string; displayName: string; childFolderCount: number; path: string }[] =
    (await lerTodas(`https://graph.microsoft.com/v1.0/me/mailFolders?${sel}`)).map((f: any) => ({ ...f, path: f.displayName }))
  for (const f of fila) out.push({ id: f.id, displayName: f.displayName, parentId: null, path: f.path, itens: Number((f as any).totalItemCount) || 0 })
  for (let nivel = 0; nivel < 4 && fila.length; nivel++) {
    const prox: typeof fila = []
    for (const f of fila) {
      if (!(f.childFolderCount > 0)) continue
      const kids = await lerTodas(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${sel}`)
      for (const k of kids) {
        const path = `${f.path}/${k.displayName}`
        out.push({ id: k.id, displayName: k.displayName, parentId: f.id, path, itens: Number(k.totalItemCount) || 0 })
        prox.push({ ...k, path })
      }
    }
    fila = prox
  }
  return out
}

export async function renameRideMailFolders(
  db: SupabaseClient, a: { oldCode: string; oldName: string; newCode: string; newName: string; slots?: number[]; dryRun?: boolean },
): Promise<MailSlotReport[]> {
  const slots = a.slots || (await listMailAuths(db)).map(x => Number(x.id)).filter(Boolean)   // LEI de 20/10/2026: as 8 caixas
  const out: MailSlotReport[] = []
  for (const slot of slots) {
    const rep: MailSlotReport = { slot, account: '', provider: '', renamed: [], conflicts: [], errors: [], planned: [] }
    out.push(rep)
    try {
      const auth = await getMailAuth(db, slot)
      if (!auth?.refresh_token) { rep.errors.push('caixa sem conexão (refresh_token)'); continue }
      rep.account = String(auth.account || '')
      rep.provider = mailProvider(auth)
      const token = await freshAccessToken(db, auth)
      if (!token) { rep.errors.push('token não renovou'); continue }

      if (rep.provider === 'gmail') {
        const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const r: any = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: H }).then(x => x.json()).catch(() => null)
        if (!Array.isArray(r?.labels)) { rep.errors.push('Gmail labels falhou: ' + JSON.stringify(r?.error || r || {}).slice(0, 160)); continue }
        const nomes = new Set<string>(r.labels.map((l: any) => String(l.name)))
        for (const l of r.labels) {
          if (l.type !== 'user') continue
          const full = String(l.name)
          const cut = full.lastIndexOf('/')
          const parent = cut >= 0 ? full.slice(0, cut + 1) : ''
          const leaf = full.slice(parent.length)
          if (!daPasta(leaf, a.oldCode, a.oldName)) continue
          // RAIZ não se mexe (25/out/2026, Rides tuning): a caixa 7 tem as pastas do João na raiz com a numeração
          // VELHA, à espera do Márcio — igual ao ensureRideMailFolders: só relata.
          if (!parent) { rep.planned.push(`${full} — na raiz da caixa, não mexida`); continue }
          const to = parent + nomeNovo(leaf, a.oldCode, a.newCode, a.oldName, a.newName)
          if (to === full) continue
          rep.planned.push(`${full} → ${to}`)
          if (nomes.has(to)) { rep.conflicts.push(`${full}: já existe a label ${to}`); continue }
          if (a.dryRun) continue
          const p = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: to }) })
          if (p.ok) { rep.renamed.push(`${full} → ${to}`); nomes.add(to) } else rep.errors.push(`${full}: HTTP ${p.status} ${(await p.text()).slice(0, 120)}`)
        }
        continue
      }

      const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const todas = await graphAll(token)
      const irmas = new Map<string, Set<string>>()
      for (const f of todas) {
        const k = f.parentId || '(raiz)'
        if (!irmas.has(k)) irmas.set(k, new Set())
        irmas.get(k)!.add(String(f.displayName))
      }
      for (const f of todas) {
        if (!daPasta(f.displayName, a.oldCode, a.oldName)) continue
        if (!f.parentId) { rep.planned.push(`${f.path} — na raiz da caixa, não mexida`); continue }   // RAIZ não se mexe (caixa 7)
        const to = nomeNovo(f.displayName, a.oldCode, a.newCode, a.oldName, a.newName)
        if (to === f.displayName) continue
        const dePath = f.path
        const paraPath = f.path.slice(0, f.path.length - f.displayName.length) + to
        rep.planned.push(`${dePath} → ${paraPath}`)
        if (irmas.get(f.parentId || '(raiz)')?.has(to)) { rep.conflicts.push(`${dePath}: já existe ${paraPath}`); continue }
        if (a.dryRun) continue
        const p = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: H, body: JSON.stringify({ displayName: to }) })
        if (p.ok) { rep.renamed.push(`${dePath} → ${paraPath}`); irmas.get(f.parentId || '(raiz)')?.add(to) } else rep.errors.push(`${dePath}: HTTP ${p.status} ${(await p.text()).slice(0, 120)}`)
      }
    } catch (e) {
      rep.errors.push(String((e as Error)?.message || e).slice(0, 200))
    }
  }
  return out
}

// ── A PASTA DE E-MAIL DO CARRO É SAGRADA (Márcio, 05/out/2026) ──────────────────────────────────────────────────
// «the email folder must be treated as an app or dropbox rule, it's sacred, all the folders there must be 100% synced
// with the app» · «that is sacred, must be perfect». Achado da sessão Staff Cronogram 2: o syncMailFolder do
// /api/ride-folder criava «Rides/<código> - <nome>» só na caixa 1, e carro que virava real por renumeração (quote
// promovida) nunca ganhava pasta. Medido em 05/out: caixa 1 faltava 1 dos 53 carros; caixas 2 e 4 faltavam 47.
//
// ensureRideMailFolders garante, nas caixas 1, 2 (Outlook) e 4 (Gmail, label aninhada), UMA pasta por carro dentro de
// «Rides», com o nome do Dropbox. Idempotente e conservadora:
//   • já existe com o nome certo → nada;
//   • existe a pasta DESTE carro com grafia velha (mesmo código e mesmo nome sem pontuação, ou só o código) → renomeia;
//   • existe pasta com o MESMO código e OUTRO nome → conflito relatado, nada é criado (pode ser o carro antigo do código —
//     quem decide é gente); com `prev` (rename vindo da tela) a pasta do nome antigo é a deste carro e é renomeada;
//   • não existe → cria.
// Nunca apaga, nunca move mensagem. `misplaced`, `extras` e `foreign` só RELATAM (pasta do carro na raiz; pasta com cara
// de código em Rides que não é de nenhum carro passado; pasta de carro da OUTRA empresa) — limpar é decisão do Márcio.
//
// ── CADA CAIXA SÓ CARREGA OS CARROS DA SUA EMPRESA (Márcio, 05/out/2026, horas depois da regra acima) ─────────────
// «gz28 both hotmail and gmais should have US cars / galpaoz28 and gz28br should have BR cars / all by the app».
// A primeira aplicação tinha posto os 53 carros do US também na caixa 2 (galpaoz28) — errado. Agora:
//   • carro do US (US · SC · WV · PO) → caixas 1 (gz28us@hotmail) e 4 (gz28us@gmail);
//   • carro do BR (BR · GM)           → caixas 2 (galpaoz28@hotmail) e 3 (gz28br@hotmail).
// A empresa do carro é o CÓDIGO, não o banco onde a linha mora: US.004 ShakeDown existe nos dois apps e é do US.
// Carro passado para uma caixa da outra empresa é simplesmente ignorado ali — nunca nasce pasta fora de casa.
export type Empresa = 'US' | 'BR'
export const CAIXAS_DA_EMPRESA: Record<Empresa, number[]> = { US: [1, 4], BR: [2, 3] }
export const empresaDoCodigo = (code: string): Empresa => (/^(BR|GM)\./i.test(String(code || '').trim()) ? 'BR' : 'US')
export const empresaDaCaixa = (slot: number): Empresa | null => (CAIXAS_DA_EMPRESA.US.includes(slot) ? 'US' : CAIXAS_DA_EMPRESA.BR.includes(slot) ? 'BR' : null)
// Nome de pasta que começa com código de carro (a mesma régua vale para o mkdir do /api/stream/mail-query).
export const CARA_DE_CODIGO = /^(US\.QT|BR\.QT|US|SC|WV|PO|SHP|BR|GM)\.\d/
export type RideMailCar = { code: string; name: string; prev?: { code?: string; name?: string } }
export type EnsureSlotReport = {
  slot: number; account: string; provider: string
  company: Empresa | null
  ok: number; created: string[]; renamed: string[]; conflicts: string[]; misplaced: string[]; extras: string[]; foreign: string[]; errors: string[]
}
const limpa = (s: string) => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
const alvoDe = (c: RideMailCar) => `${limpa(c.code)}${limpa(c.name) ? ' - ' + limpa(c.name) : ''}`
// O nome começa com ESTE código (e não com US.030.4 quando o código é US.030)?
const temCodigo = (dn: string, code: string) => new RegExp(`^${esc(code)}(?![\\d.])`).test(String(dn || '').trim()) || String(dn || '').trim() === code
// Graph e Gmail devolvem 429/503 quando a rajada é grande (a primeira carga do BR são ~185 pastas por caixa): espera o
// que o servidor pedir (teto de 20 s) e tenta de novo, duas vezes. Erro de verdade passa direto.
async function comFolego(url: string, init: RequestInit): Promise<Response> {
  let r = await fetch(url, init)
  for (let i = 0; i < 2 && (r.status === 429 || r.status === 503); i++) {
    const espera = Math.min(20, Math.max(1, Number(r.headers.get('retry-after')) || 3 * (i + 1)))
    await new Promise(ok => setTimeout(ok, espera * 1000))
    r = await fetch(url, init)
  }
  return r
}

// ── LEI DE 20/10/2026: «GZ28US Rides» E «GZ28BR Rides» EM TODA CAIXA (substitui as regras de 05/10 acima) ─────────────
// Márcio: «Every mailbox should have the folders GZ28US Rides and GZ28BR Rides, inside them, the car's folder, and the emails
// should be there, create the folder when there's not». E (21/10): a pasta do carro nasce numa caixa SÓ quando há e-mail dele ali
// — quem cria é o robô que arquiva (lib/carMailFolder.server.ts, pastaDoCarro). Esta função, que o cron de hora em hora e os
// ganchos de criar/renomear carro chamam, faz o resto, em TODAS as caixas conectadas:
//   1. as duas raízes existem (nascem se faltar);
//   2. a «Rides» VELHA é migrada: cada «Rides/<código> - <nome>» vai para a raiz da empresa do código, com as mensagens. Se a raiz
//      nova já tem a pasta daquele código (o robô criou antes da migração), as MENSAGENS passam uma a uma e a casca velha sai;
//   3. a «Rides» velha vazia sai;
//   4. o nome da pasta de cada carro passado acompanha o app (mesmo código, grafia velha do mesmo carro, ou o `prev` do rename).
// Nunca apaga mensagem. Pasta de carro na RAIZ da caixa (a caixa 7 tem as do João com numeração VELHA) não é mexida: só relatada.
export async function ensureRideMailFolders(
  db: SupabaseClient, cars: RideMailCar[], opts: { slots?: number[]; dryRun?: boolean; audit?: boolean } = {},
): Promise<EnsureSlotReport[]> {
  const slots = opts.slots || (await listMailAuths(db)).map(a => Number(a.id)).filter(Boolean)
  const out: EnsureSlotReport[] = slots.map(slot => ({ slot, account: '', provider: '', company: null, ok: 0, created: [], renamed: [], conflicts: [], misplaced: [], extras: [], foreign: [], errors: [] }))
  await Promise.all(out.map(async rep => {
    try {
      const auth = await getMailAuth(db, rep.slot)
      if (!auth?.refresh_token) { rep.errors.push('caixa sem conexão (refresh_token)'); return }
      rep.account = String(auth.account || '')
      rep.provider = mailProvider(auth)
      const token = await freshAccessToken(db, auth)
      if (!token) { rep.errors.push('token não renovou'); return }
      if (rep.provider === 'gmail') await migraGmail(token, cars, rep, !!opts.dryRun)
      else await migraGraph(token, cars, rep, !!opts.dryRun)
    } catch (e) {
      rep.errors.push(String((e as Error)?.message || e).slice(0, 200))
    }
  }))
  return out
}

const ehDele = (nome: string, car: RideMailCar) => {
  const code = limpa(car.code)
  if (daPasta(nome, code, limpa(car.name))) return true
  if (!car.prev) return false
  const pc = limpa(car.prev.code || '') || code, pn = car.prev.name != null ? limpa(car.prev.name) : ''
  return pn ? daPasta(nome, pc, pn) : temCodigo(nome, pc)
}

async function migraGraph(token: string, cars: RideMailCar[], rep: EnsureSlotReport, dryRun: boolean) {
  const HG = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const G0 = 'https://graph.microsoft.com/v1.0'
  const todas = await graphAll(token)
  const raizId: Record<string, string> = {}
  for (const nome of Object.values(RAIZ_DA_EMPRESA)) {
    const f = todas.find(x => !x.parentId && x.displayName.trim().toLowerCase() === nome.toLowerCase())
    if (f) { raizId[nome] = f.id; continue }
    if (dryRun) { rep.created.push(`${nome} (seria criada)`); continue }
    const p = await comFolego(`${G0}/me/mailFolders`, { method: 'POST', headers: HG, body: JSON.stringify({ displayName: nome }) })
    const j: any = await p.json().catch(() => null)
    if (!p.ok || !j?.id) { rep.errors.push(`criar «${nome}»: HTTP ${p.status}`); return }
    raizId[nome] = String(j.id); rep.created.push(nome)
  }
  const filhasDe = (id: string) => todas.filter(x => x.parentId === id)
  // 2. a «Rides» velha
  const velha = todas.find(x => !x.parentId && x.displayName.trim().toLowerCase() === 'rides')
  if (velha) {
    for (const f of filhasDe(velha.id)) {
      const nome = f.displayName.trim()
      if (!CARA_DE_CODIGO.test(nome)) { rep.extras.push(`Rides/${nome} — não é pasta de carro, ficou`); continue }
      const raiz = raizDoCodigo(nome.split(' ')[0]), rid = raizId[raiz]
      const code = nome.split(/\s/)[0]
      const ja = rid ? filhasDe(rid).find(x => comecaComCodigo(x.displayName, code)) : undefined
      // VAZIA (sem mensagem, sem subpasta): não migra — sai. A pasta do carro só existe onde há e-mail dele (Márcio, 21/10/2026).
      if (!f.itens && !filhasDe(f.id).length) {
        if (!dryRun) { const d = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: HG }); if (!d.ok) { rep.errors.push(`remover Rides/${nome} (vazia): HTTP ${d.status}`); continue } f.parentId = '__movida' }
        rep.renamed.push(`Rides/${nome} (vazia) removida`)
        continue
      }
      if (dryRun) { rep.renamed.push(`Rides/${nome} → ${raiz}/${ja ? ja.displayName + ' (fundir ' + f.itens + ' msg)' : nome}`); continue }
      if (!rid) continue
      if (!ja) {
        const p = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}/move`, { method: 'POST', headers: HG, body: JSON.stringify({ destinationId: rid }) })
        const j: any = await p.json().catch(() => null)
        if (!p.ok || !j?.id) { rep.errors.push(`mover Rides/${nome}: HTTP ${p.status} ${JSON.stringify(j?.error || {}).slice(0, 100)}`); continue }
        todas.push({ id: String(j.id), displayName: nome, parentId: rid, path: `${raiz}/${nome}`, itens: f.itens })
        f.parentId = '__movida'
        rep.renamed.push(`Rides/${nome} → ${raiz}/${nome}`)
        continue
      }
      // fundir: as mensagens passam uma a uma (a pasta nova já existe)
      let movidas = 0, falhas = 0
      let next: string | null = `${G0}/me/mailFolders/${encodeURIComponent(f.id)}/messages?$top=50&$select=id`
      const ids: string[] = []
      while (next) { const r: any = await comFolego(next, { headers: HG }).then(x => x.json()).catch(() => null); ids.push(...(r?.value || []).map((m: any) => String(m.id))); next = r?.['@odata.nextLink'] || null }
      for (const id of ids) { const mv = await comFolego(`${G0}/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: HG, body: JSON.stringify({ destinationId: ja.id }) }); if (mv.ok) movidas++; else falhas++ }
      if (falhas) { rep.errors.push(`fundir Rides/${nome} em ${raiz}/${ja.displayName}: ${falhas} mensagem(ns) não passaram — a pasta velha ficou`); continue }
      const info: any = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}?$select=totalItemCount,childFolderCount`, { headers: HG }).then(x => x.json()).catch(() => null)
      if (info && !info.totalItemCount && !info.childFolderCount) { await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: HG }); f.parentId = '__movida' }
      rep.renamed.push(`Rides/${nome} → fundida em ${raiz}/${ja.displayName} (${movidas} msg)`)
    }
    // 3. a casca velha
    if (!dryRun && !filhasDe(velha.id).length) {
      const info: any = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(velha.id)}?$select=totalItemCount,childFolderCount`, { headers: HG }).then(x => x.json()).catch(() => null)
      if (info && !info.totalItemCount && !info.childFolderCount) { const d = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(velha.id)}`, { method: 'DELETE', headers: HG }); if (d.ok) rep.renamed.push('Rides (velha, vazia) removida') }
      else if (info) rep.extras.push(`Rides (velha) ainda tem ${info.totalItemCount} msg soltas — ficou`)
    }
  }
  // 4. o nome acompanha o app
  for (const car of cars) {
    const rid = raizId[raizDoCodigo(car.code)]
    if (!rid) continue
    const alvo = alvoDe(car), irmas = filhasDe(rid)
    if (irmas.some(x => x.displayName.trim() === alvo)) { rep.ok++; continue }
    const minha = irmas.find(x => ehDele(x.displayName, car))
    if (!minha) continue   // sem pasta nesta caixa: nasce quando chegar e-mail do carro
    if (irmas.some(x => x.id !== minha.id && x.displayName.trim().toLowerCase() === alvo.toLowerCase())) { rep.conflicts.push(`${minha.displayName}: já existe «${alvo}»`); continue }
    if (!dryRun) {
      const p = await fetch(`${G0}/me/mailFolders/${encodeURIComponent(minha.id)}`, { method: 'PATCH', headers: HG, body: JSON.stringify({ displayName: alvo }) })
      if (!p.ok) { rep.errors.push(`renomear ${minha.displayName}: HTTP ${p.status}`); continue }
    }
    rep.renamed.push(`${raizDoCodigo(car.code)}/${minha.displayName} → ${alvo}`)
  }
  for (const f of todas) if (!f.parentId && CARA_DE_CODIGO.test(f.displayName.trim())) rep.misplaced.push(`«${f.displayName}» na raiz da caixa (${f.itens} msg) — não mexida`)
}

async function migraGmail(token: string, cars: RideMailCar[], rep: EnsureSlotReport, dryRun: boolean) {
  const HG = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const GM0 = 'https://gmail.googleapis.com/gmail/v1/users/me'
  const r: any = await fetch(`${GM0}/labels`, { headers: HG }).then(x => x.json()).catch(() => null)
  if (!Array.isArray(r?.labels)) { rep.errors.push('Gmail labels: ' + JSON.stringify(r?.error || r || {}).slice(0, 160)); return }
  const user: { id: string; name: string }[] = r.labels.filter((l: any) => l.type === 'user').map((l: any) => ({ id: String(l.id), name: String(l.name) }))
  const criaLabel = async (name: string) => {
    const p = await comFolego(`${GM0}/labels`, { method: 'POST', headers: HG, body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) })
    const j: any = await p.json().catch(() => null)
    if (!p.ok || !j?.id) throw new Error(`criar a label «${name}»: HTTP ${p.status}`)
    user.push({ id: String(j.id), name }); return String(j.id)
  }
  for (const nome of Object.values(RAIZ_DA_EMPRESA)) {
    if (user.some(l => l.name.toLowerCase() === nome.toLowerCase())) continue
    if (dryRun) rep.created.push(`${nome} (seria criada)`); else { await criaLabel(nome); rep.created.push(nome) }
  }
  const dentro = (raiz: string) => user.filter(l => l.name.toLowerCase().startsWith(raiz.toLowerCase() + '/') && !l.name.slice(raiz.length + 1).includes('/'))
  // 2. «Rides/…» velhas
  for (const l of user.filter(x => x.name.toLowerCase().startsWith('rides/') && !x.name.slice(6).includes('/'))) {
    const nome = l.name.slice(6).trim()
    if (!CARA_DE_CODIGO.test(nome)) { rep.extras.push(`${l.name} — não é pasta de carro, ficou`); continue }
    const raiz = raizDoCodigo(nome.split(' ')[0]), code = nome.split(/\s/)[0]
    const ja = dentro(raiz).find(x => comecaComCodigo(x.name.slice(raiz.length + 1), code))
    const det: any = await fetch(`${GM0}/labels/${encodeURIComponent(l.id)}`, { headers: HG }).then(x => x.json()).catch(() => null)
    if (det && !Number(det.messagesTotal)) {
      if (!dryRun) { const d = await fetch(`${GM0}/labels/${encodeURIComponent(l.id)}`, { method: 'DELETE', headers: HG }); if (!d.ok) { rep.errors.push(`remover ${l.name} (vazia): HTTP ${d.status}`); continue } }
      l.name = '__removida'; rep.renamed.push(`Rides/${nome} (vazia) removida`); continue
    }
    if (dryRun) { rep.renamed.push(`${l.name} → ${raiz}/${ja ? ja.name.slice(raiz.length + 1) + ' (fundir)' : nome}`); continue }
    if (!ja) {
      const p = await fetch(`${GM0}/labels/${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: HG, body: JSON.stringify({ name: `${raiz}/${nome}` }) })
      if (!p.ok) { rep.errors.push(`renomear ${l.name}: HTTP ${p.status}`); continue }
      l.name = `${raiz}/${nome}`; rep.renamed.push(`Rides/${nome} → ${raiz}/${nome}`); continue
    }
    const ids: string[] = []
    let pageToken = ''
    do {
      const q: any = await fetch(`${GM0}/messages?labelIds=${encodeURIComponent(l.id)}&maxResults=500${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: HG }).then(x => x.json()).catch(() => null)
      ids.push(...(q?.messages || []).map((m: any) => String(m.id))); pageToken = q?.nextPageToken || ''
    } while (pageToken)
    for (let i = 0; i < ids.length; i += 1000) {
      const b = await fetch(`${GM0}/messages/batchModify`, { method: 'POST', headers: HG, body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds: [ja.id], removeLabelIds: [l.id] }) })
      if (!b.ok) { rep.errors.push(`fundir ${l.name}: HTTP ${b.status} — a label velha ficou`); ids.length = 0; break }
    }
    if (!rep.errors.some(e => e.startsWith(`fundir ${l.name}`))) { await fetch(`${GM0}/labels/${encodeURIComponent(l.id)}`, { method: 'DELETE', headers: HG }); rep.renamed.push(`${l.name} → fundida em ${ja.name} (${ids.length} msg)`) }
  }
  // 3. a label «Rides» velha, sem filhas
  const pai = user.find(x => x.name.toLowerCase() === 'rides')
  if (pai && !dryRun && !user.some(x => x.name.toLowerCase().startsWith('rides/'))) {
    const info: any = await fetch(`${GM0}/labels/${encodeURIComponent(pai.id)}`, { headers: HG }).then(x => x.json()).catch(() => null)
    if (info && !Number(info.messagesTotal)) { const d = await fetch(`${GM0}/labels/${encodeURIComponent(pai.id)}`, { method: 'DELETE', headers: HG }); if (d.ok) rep.renamed.push('Rides (velha, vazia) removida') }
  }
  // 4. o nome acompanha o app
  for (const car of cars) {
    const raiz = raizDoCodigo(car.code), alvo = alvoDe(car), irmas = dentro(raiz)
    if (irmas.some(x => x.name.slice(raiz.length + 1).trim() === alvo)) { rep.ok++; continue }
    const minha = irmas.find(x => ehDele(x.name.slice(raiz.length + 1), car))
    if (!minha) continue
    if (!dryRun) {
      const p = await fetch(`${GM0}/labels/${encodeURIComponent(minha.id)}`, { method: 'PATCH', headers: HG, body: JSON.stringify({ name: `${raiz}/${alvo}` }) })
      if (!p.ok) { rep.errors.push(`renomear ${minha.name}: HTTP ${p.status}`); continue }
    }
    rep.renamed.push(`${minha.name} → ${raiz}/${alvo}`)
  }
}

// ── E-MAIL DE CARRO NA CAIXA DA OUTRA EMPRESA VOLTA PARA CASA (Márcio, 05/out/2026: «Remove empty, move the mail») ──
// Sobra da época em que qualquer caixa guardava qualquer carro: «Rides/BR.538 - RussianRoulette» com 14 mensagens na
// gz28us@hotmail, «Rides/US.038 - SublimeHell» com 4 na galpaoz28. E-mail não MUDA de conta por «move» — o Graph só move
// dentro da mesma caixa. Então, para cada mensagem de uma pasta `foreign`:
//   1. nasce uma CÓPIA na pasta do mesmo carro, na caixa principal da empresa dele (US → 1, BR → 2): mesmo remetente,
//      destinatários, corpo, anexos, data de envio e de chegada, lida/não lida — e NÃO como rascunho (PR_MESSAGE_FLAGS);
//   2. a cópia é conferida (existe, não é rascunho, anexos todos lá);
//   3. só então o ORIGINAL sai da pasta do carro para o «Arquivo morto» (Archive) da caixa de origem. NADA É APAGADO: o
//      original, com os cabeçalhos de internet que a cópia não carrega, continua existindo — importa em caso de disputa;
//   4. pasta esvaziada (ou que já estava vazia) é removida.
// Idempotente: a cópia leva a marca GZ28Origem (id de internet do original); rodar de novo não duplica — acha a cópia,
// e só termina o passo 3. Mensagem com anexo que não dá para copiar inteiro (anexo-item, link de nuvem, > 3 MB) NÃO é
// tocada: fica onde está e vai para `failed`. Só roda quando chamado (POST action=repatriate) — o cron não faz isto.
export const CAIXA_PRINCIPAL: Record<Empresa, number> = { US: 1, BR: 2 }
const MARCA_ORIGEM = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name GZ28Origem'
const GRAPH = 'https://graph.microsoft.com/v1.0'
export type RepatriateFolderReport = {
  from: string; to: string; total: number
  copied: number; alreadyThere: number; archived: number; folderRemoved: boolean
  failed: string[]; note: string
  plan?: { subject: string; received: string; attachments: string[] }[]
}

async function graphJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; j: any }> {
  const r = await comFolego(url, init)
  const j: any = await r.json().catch(() => null)
  return { ok: r.ok, status: r.status, j }
}

const tipo = (a: any) => String(a?.['@odata.type'] || '').split('.').pop() || 'anexo'
const ENDERECO = /^[^\s@<>"]+@[^\s@<>"]+$/
const comEndereco = (l: any) => (Array.isArray(l) ? l : []).filter((x: any) => ENDERECO.test(String(x?.emailAddress?.address || '').trim()))
const kb = (a: any) => Math.round(Number(a?.size) / 1024)

// A CÓPIA CONFERIDA, mensagem por mensagem (saiu de dentro do repatriateRideMail em 20/10/2026 para servir também ao mergeMailFolder):
// cópia no destino com data, remetente e anexos (marca GZ28Origem = idempotente), conferida, e só então o original vai para o Arquivo
// morto da caixa de ORIGEM. Devolve quantas ainda cabem nesta chamada (o limite).
async function copiarMensagens(a: { HO: Record<string, string>; HD: Record<string, string>; origemId: string; destinoId: string; rep: RepatriateFolderReport; dryRun: boolean; restam: number }): Promise<number> {
  const { HO, HD, rep } = a
  let restam = a.restam
  const opts = { dryRun: a.dryRun }
  const pasta = { id: a.origemId }, destino = { id: a.destinoId }
        // As mensagens da pasta (todas as páginas), mais antigas primeiro.
        const msgs: any[] = []
        let next: string | null = `${GRAPH}/me/mailFolders/${encodeURIComponent(pasta.id)}/messages?$top=25&$orderby=receivedDateTime asc&$select=id,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,body,receivedDateTime,sentDateTime,internetMessageId,importance,isRead,isDraft,categories`
        while (next) {
          const r: { ok: boolean; status: number; j: any } = await graphJson(next, { headers: HO })
          if (!r.ok) throw new Error('listar mensagens: HTTP ' + r.status)
          msgs.push(...(r.j.value || []))
          next = r.j['@odata.nextLink'] || null
        }
        if (opts.dryRun) rep.plan = []
        for (const m of msgs) {
          if (restam <= 0) { rep.note = 'limite desta chamada atingido — rode de novo para o resto'; break }
          const rotulo = `«${String(m.subject || '(sem assunto)').slice(0, 60)}» ${String(m.receivedDateTime || '').slice(0, 10)}`
          try {
            if (m.isDraft) { rep.failed.push(`${rotulo}: é rascunho — fica onde está`); continue }
            // Anexos: só arquivo de até 3 MB vai inteiro pela API simples. O resto não se copia pela metade.
            const la = await graphJson(`${GRAPH}/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`, { headers: HO })
            if (!la.ok) throw new Error('listar anexos: HTTP ' + la.status)
            const anexos: any[] = la.j.value || []
            const ruim = anexos.find(a => a['@odata.type'] !== '#microsoft.graph.fileAttachment' || Number(a.size) > 3 * 1024 * 1024)
            if (opts.dryRun) rep.plan!.push({ subject: String(m.subject || ''), received: String(m.receivedDateTime || ''), attachments: anexos.map(a => `${a.name} · ${kb(a)} KB · ${tipo(a)}`) })
            if (ruim) { rep.failed.push(`${rotulo}: anexo «${ruim.name}» não dá para copiar inteiro (${tipo(ruim)}, ${kb(ruim)} KB) — a mensagem fica onde está`); continue }
            if (opts.dryRun) continue

            const origem = String(m.internetMessageId || m.id)
            const filtro = `singleValueExtendedProperties/Any(ep: ep/id eq '${MARCA_ORIGEM}' and ep/value eq '${origem.replace(/'/g, "''")}')`
            const ja = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(destino.id)}/messages?$select=id,isDraft&$top=1&$filter=${encodeURIComponent(filtro)}`, { headers: HD })
            if (!ja.ok) throw new Error(`procurar a cópia no destino: HTTP ${ja.status} ${JSON.stringify(ja.j?.error || {}).slice(0, 140)}`)
            let copiaId = String(ja.j.value?.[0]?.id || '')
            if (copiaId) rep.alreadyThere++
            else {
              const corpo: any = {
                subject: m.subject ?? '', body: m.body, importance: m.importance || 'normal', categories: m.categories || [],
                // participante sem endereço (FedEx manda reply-to só com nome) faz o Graph recusar a mensagem inteira
                toRecipients: comEndereco(m.toRecipients), ccRecipients: comEndereco(m.ccRecipients), bccRecipients: comEndereco(m.bccRecipients), replyTo: comEndereco(m.replyTo),
                singleValueExtendedProperties: [
                  { id: 'Integer 0x0E07', value: '1' },                        // PR_MESSAGE_FLAGS = lida, e NÃO «não enviada» (rascunho)
                  { id: MARCA_ORIGEM, value: origem },
                  ...(m.receivedDateTime ? [{ id: 'SystemTime 0x0E06', value: m.receivedDateTime }] : []),   // PR_MESSAGE_DELIVERY_TIME
                  ...(m.sentDateTime ? [{ id: 'SystemTime 0x0039', value: m.sentDateTime }] : []),           // PR_CLIENT_SUBMIT_TIME
                ],
              }
              if (m.from?.emailAddress?.address) corpo.from = m.from
              if (m.sender?.emailAddress?.address) corpo.sender = m.sender
              let cr = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(destino.id)}/messages`, { method: 'POST', headers: HD, body: JSON.stringify(corpo) })
              // O Exchange às vezes recusa o reply-to mesmo com endereço (FedEx): reply-to é conveniência, não conteúdo — vai sem ele.
              if (cr.status === 400 && /ReplyTo/i.test(String(cr.j?.error?.message || ''))) { delete corpo.replyTo; cr = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(destino.id)}/messages`, { method: 'POST', headers: HD, body: JSON.stringify(corpo) }) }
              if (!cr.ok || !cr.j?.id) throw new Error(`criar a cópia: HTTP ${cr.status} ${JSON.stringify(cr.j?.error || {}).slice(0, 160)} · de ${JSON.stringify(m.from?.emailAddress || null)} · reply-to ${JSON.stringify(m.replyTo || []).slice(0, 160)}`)
              copiaId = String(cr.j.id)
              const desfaz = async (porque: string): Promise<never> => { await comFolego(`${GRAPH}/me/messages/${encodeURIComponent(copiaId)}`, { method: 'DELETE', headers: HD }); throw new Error(porque + ' — cópia desfeita, original intacto') }
              if (cr.j.isDraft) await desfaz('a cópia nasceu como rascunho')
              for (const a of anexos) {
                const ga = await graphJson(`${GRAPH}/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`, { headers: HO })
                if (!ga.ok || !ga.j?.contentBytes) await desfaz(`ler o anexo «${a.name}»: HTTP ${ga.status}`)
                const pa = await graphJson(`${GRAPH}/me/messages/${encodeURIComponent(copiaId)}/attachments`, { method: 'POST', headers: HD, body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: ga.j.name, contentType: ga.j.contentType, contentBytes: ga.j.contentBytes, isInline: !!ga.j.isInline, ...(ga.j.contentId ? { contentId: ga.j.contentId } : {}) }) })
                if (!pa.ok) await desfaz(`gravar o anexo «${a.name}»: HTTP ${pa.status} ${JSON.stringify(pa.j?.error || {}).slice(0, 120)}`)
              }
              if (m.isRead === false) await comFolego(`${GRAPH}/me/messages/${encodeURIComponent(copiaId)}`, { method: 'PATCH', headers: HD, body: JSON.stringify({ isRead: false }) })
              rep.copied++
            }
            // Confere a cópia antes de mexer no original: existe, não é rascunho, anexos todos lá.
            const cf = await graphJson(`${GRAPH}/me/messages/${encodeURIComponent(copiaId)}?$select=id,isDraft,subject&$expand=attachments($select=id)`, { headers: HD })
            if (!cf.ok || cf.j.isDraft || (cf.j.attachments || []).length !== anexos.length) { rep.failed.push(`${rotulo}: a cópia não conferiu (HTTP ${cf.status}, rascunho ${!!cf.j?.isDraft}, anexos ${(cf.j?.attachments || []).length}/${anexos.length}) — original intacto`); continue }
            const mv = await graphJson(`${GRAPH}/me/messages/${encodeURIComponent(m.id)}/move`, { method: 'POST', headers: HO, body: JSON.stringify({ destinationId: 'archive' }) })
            if (!mv.ok) { rep.failed.push(`${rotulo}: cópia feita, mas o original não foi para o Arquivo morto (HTTP ${mv.status}) — continua na pasta`); continue }
            rep.archived++
            restam--
          } catch (e) {
            rep.failed.push(`${rotulo}: ${String((e as Error)?.message || e).slice(0, 220)}`)
          }
        }
  return restam
}

export async function repatriateRideMail(
  db: SupabaseClient, frotas: Record<Empresa, RideMailCar[]>, opts: { dryRun?: boolean; folder?: string; limit?: number } = {},
): Promise<RepatriateFolderReport[]> {
  const out: RepatriateFolderReport[] = []
  const tokens = new Map<number, { token: string; account: string; provider: string } | null>()
  const caixa = async (slot: number) => {
    if (tokens.has(slot)) return tokens.get(slot)!
    const auth = await getMailAuth(db, slot)
    const token = auth?.refresh_token ? await freshAccessToken(db, auth) : null
    const v = auth && token ? { token, account: String(auth.account || ''), provider: mailProvider(auth) } : null
    tokens.set(slot, v)
    return v
  }
  const arvores = new Map<number, Awaited<ReturnType<typeof graphAll>>>()
  const arvore = async (slot: number, token: string) => { if (!arvores.has(slot)) arvores.set(slot, await graphAll(token)); return arvores.get(slot)! }
  const filhasDeRides = (todas: Awaited<ReturnType<typeof graphAll>>) => {
    const pai = todas.find(f => !f.parentId && String(f.displayName).trim().toLowerCase() === 'rides')
    return pai ? todas.filter(f => f.parentId === pai.id) : []
  }
  let restam = opts.limit && opts.limit > 0 ? opts.limit : Infinity

  for (const slotOrigem of [...CAIXAS_DA_EMPRESA.US, ...CAIXAS_DA_EMPRESA.BR]) {
    const casa = empresaDaCaixa(slotOrigem)!
    const o = await caixa(slotOrigem)
    if (!o) { out.push({ from: `caixa ${slotOrigem}`, to: '', total: 0, copied: 0, alreadyThere: 0, archived: 0, folderRemoved: false, failed: ['caixa sem conexão'], note: '' }); continue }
    if (o.provider === 'gmail') continue   // Gmail como origem ainda não é atendido; a auditoria (`foreign`) continua acusando se aparecer
    const HO = { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }
    const deFora = filhasDeRides(await arvore(slotOrigem, o.token)).filter(f => CARA_DE_CODIGO.test(f.displayName.trim()) && empresaDoCodigo(f.displayName) !== casa)
    const removeSeVazia = async (id: string) => {
      const info = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(id)}?$select=id,totalItemCount,childFolderCount`, { headers: HO })
      if (!info.ok || info.j.totalItemCount || info.j.childFolderCount) return false
      return (await comFolego(`${GRAPH}/me/mailFolders/${encodeURIComponent(id)}`, { method: 'DELETE', headers: HO })).ok
    }
    for (const pasta of deFora) {
      if (opts.folder && pasta.displayName.trim() !== opts.folder.trim()) continue
      const dono = empresaDoCodigo(pasta.displayName)
      const rep: RepatriateFolderReport = { from: `${o.account} · Rides/${pasta.displayName}`, to: '', total: pasta.itens, copied: 0, alreadyThere: 0, archived: 0, folderRemoved: false, failed: [], note: '' }
      out.push(rep)
      try {
        // Pasta vazia de carro de fora: só a casca. Sai.
        if (!pasta.itens) {
          if (!opts.dryRun) rep.folderRemoved = await removeSeVazia(pasta.id)
          rep.note = 'vazia' + (opts.dryRun ? ' — seria removida' : rep.folderRemoved ? ' — removida' : ' — não saiu')
          continue
        }
        // O carro desta pasta: mesmo código E mesmo nome. Código de um, nome de outro = não é dele; gente decide.
        const car = frotas[dono].find(c => daPasta(pasta.displayName, limpa(c.code), limpa(c.name)))
        if (!car) { rep.note = `nenhum carro do ${dono} com este código e este nome — nada feito`; continue }
        const slotDestino = CAIXA_PRINCIPAL[dono]
        const d = await caixa(slotDestino)
        if (!d || d.provider === 'gmail') { rep.failed.push(`caixa ${slotDestino} (destino) sem conexão`); continue }
        const HD = { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }
        const alvo = alvoDe(car)
        const destino = filhasDeRides(await arvore(slotDestino, d.token)).find(f => f.displayName.trim() === alvo)
        rep.to = `${d.account} · Rides/${alvo}`
        if (!destino) { rep.failed.push('a pasta do carro ainda não existe na caixa de destino — rode a sincronização primeiro'); continue }

        restam = await copiarMensagens({ HO, HD, origemId: pasta.id, destinoId: destino.id, rep, dryRun: !!opts.dryRun, restam })
        if (!opts.dryRun && !rep.failed.length && !rep.note) rep.folderRemoved = await removeSeVazia(pasta.id)
      } catch (e) {
        rep.failed.push(String((e as Error)?.message || e).slice(0, 220))
      }
    }
  }
  return out
}


// FUNDIR UMA PASTA DE E-MAIL EM OUTRA, ENTRE CAIXAS (20/10/2026 — Márcio, caso Mustard → SpeedLight BR.512: «merge … delete the old one,
// all around, emails, everywhere»). O repatriate só cobre pasta de carro de fora nas caixas 1/2/3/4; este pega QUALQUER pasta (pelo
// caminho, ex.: «Arquivo Morto/108 - Mustard») de QUALQUER caixa Outlook e funde numa pasta de destino (ex.: «Rides/BR.512 - SpeedLight»)
// de outra caixa — o mesmo rito: cópia conferida, original no Arquivo morto da origem, casca vazia removida. Nada é apagado.
export async function mergeMailFolder(
  db: SupabaseClient, a: { fromSlot: number; fromPath: string; toSlot: number; toPath: string }, opts: { dryRun?: boolean; limit?: number } = {},
): Promise<RepatriateFolderReport> {
  const conecta = async (slot: number) => {
    const auth = await getMailAuth(db, slot)
    const token = auth?.refresh_token ? await freshAccessToken(db, auth) : null
    return auth && token ? { token, account: String(auth.account || ''), provider: mailProvider(auth) } : null
  }
  const igual = (x: string, y: string) => x.trim().replace(/\s*\/\s*/g, '/').toLowerCase() === y.trim().replace(/\s*\/\s*/g, '/').toLowerCase()
  const rep: RepatriateFolderReport = { from: `caixa ${a.fromSlot} · ${a.fromPath}`, to: `caixa ${a.toSlot} · ${a.toPath}`, total: 0, copied: 0, alreadyThere: 0, archived: 0, folderRemoved: false, failed: [], note: '' }
  try {
    const o = await conecta(a.fromSlot), d = await conecta(a.toSlot)
    if (!o) { rep.failed.push(`caixa ${a.fromSlot} sem conexão`); return rep }
    if (!d) { rep.failed.push(`caixa ${a.toSlot} sem conexão`); return rep }
    if (o.provider === 'gmail' || d.provider === 'gmail') { rep.failed.push('Gmail ainda não é atendido por esta fusão (só Outlook)'); return rep }
    rep.from = `${o.account} · ${a.fromPath}`; rep.to = `${d.account} · ${a.toPath}`
    const origem = (await graphAll(o.token)).filter(f => igual(f.path, a.fromPath))
    const destino = (await graphAll(d.token)).filter(f => igual(f.path, a.toPath))
    if (origem.length !== 1) { rep.failed.push(`pasta de origem «${a.fromPath}»: ${origem.length} encontrada(s) — precisa ser exatamente 1`); return rep }
    if (destino.length !== 1) { rep.failed.push(`pasta de destino «${a.toPath}»: ${destino.length} encontrada(s) — precisa ser exatamente 1`); return rep }
    if (a.fromSlot === a.toSlot && origem[0].id === destino[0].id) { rep.failed.push('origem e destino são a mesma pasta'); return rep }
    rep.total = origem[0].itens
    const HO = { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }
    const HD = { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }
    if (rep.total) await copiarMensagens({ HO, HD, origemId: origem[0].id, destinoId: destino[0].id, rep, dryRun: !!opts.dryRun, restam: opts.limit && opts.limit > 0 ? opts.limit : Infinity })
    if (!opts.dryRun && !rep.failed.length && !rep.note) {
      const info = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(origem[0].id)}?$select=id,totalItemCount,childFolderCount`, { headers: HO })
      if (info.ok && !info.j.totalItemCount && !info.j.childFolderCount) rep.folderRemoved = (await comFolego(`${GRAPH}/me/mailFolders/${encodeURIComponent(origem[0].id)}`, { method: 'DELETE', headers: HO })).ok
      else rep.note = 'a pasta de origem ainda tem itens ou subpastas — ficou'
    }
  } catch (e) {
    rep.failed.push(String((e as Error)?.message || e).slice(0, 220))
  }
  return rep
}

// ── PASTAS DE CARRO ANTIGAS, PELO NOME (21/10/2026 — Márcio: caixa 7 «Migrate by car name») ─────────────────────────────
// A caixa 7 (gz28tuning) tem as pastas do João na RAIZ com a numeração VELHA («US.002 - Colossus» é a US.003 de hoje, «166 -
// GhostRider») e ~150 do BR em «Arquivo Morto/NNN - Nome». O NÚMERO não serve; o NOME serve: cada pasta é casada com o carro de
// hoje pelo nome atual (e, se nenhum bater, pelos nomes antigos que o app do BR guarda em former_names). Exatamente UM carro →
// as mensagens vão para «GZ28US Rides|GZ28BR Rides/<código atual> - <nome atual>» (a pasta inteira se a do carro ainda não existe;
// senão uma a uma) e a casca vazia sai. Zero ou mais de um carro → só relata. Nada é apagado.
export type FrotaComNomes = { code: string; name: string; former: string[] }[]
export async function migrarPastasPorNome(db: SupabaseClient, frota: FrotaComNomes, a: { slot: number; dryRun?: boolean }) {
  const rel = { slot: a.slot, account: '', movidas: [] as string[], semCarro: [] as string[], ambiguas: [] as string[], erros: [] as string[] }
  const auth = await getMailAuth(db, a.slot)
  if (!auth?.refresh_token) { rel.erros.push('caixa sem conexão'); return rel }
  rel.account = String(auth.account || '')
  if (mailProvider(auth) === 'gmail') { rel.erros.push('Gmail não atendido aqui'); return rel }
  const token = await freshAccessToken(db, auth)
  if (!token) { rel.erros.push('token não renovou'); return rel }
  const HG = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const G0 = 'https://graph.microsoft.com/v1.0'
  const todas = await graphAll(token)
  const arq: any = await comFolego(`${G0}/me/mailFolders/archive?$select=id`, { headers: HG }).then(x => x.json()).catch(() => null)
  const raizesCarro = new Set(todas.filter(f => !f.parentId && Object.values(RAIZ_DA_EMPRESA).some(r => r.toLowerCase() === f.displayName.trim().toLowerCase())).map(f => f.id))
  const candidatas = todas.filter(f => (!f.parentId || (arq?.id && f.parentId === arq.id)) && !raizesCarro.has(f.id))
  const NOME = /^\s*(?:[A-Za-z]{2,3}\.)?(?:\d{1,4}|X{2,3})\s*-\s*(.+?)\s*$/
  const porNome = (nome: string) => frota.filter(c => nomeNu(c.name) === nomeNu(nome))
  const porAntigo = (nome: string) => frota.filter(c => c.former.some(f => nomeNu(f) === nomeNu(nome)))
  // 1º o plano inteiro: DUAS pastas velhas para o MESMO carro (números antigos diferentes, mesmo nome — podem ser dois carros que
  // usaram o nome) não se fundem por palpite: vão para «ambiguas», com as duas.
  const plano: { f: (typeof candidatas)[number]; onde: string; car: FrotaComNomes[number] }[] = []
  for (const f of candidatas) {
    const m = f.displayName.match(NOME)
    if (!m) continue
    const nome = m[1], onde = f.parentId ? `Arquivo Morto/${f.displayName}` : f.displayName
    let cars = porNome(nome)
    if (!cars.length) cars = porAntigo(nome)
    if (!cars.length) { rel.semCarro.push(`${onde} (${f.itens} msg)`); continue }
    if (cars.length > 1) { rel.ambiguas.push(`${onde} → ${cars.map(c => c.code).join(' / ')}`); continue }
    plano.push({ f, onde, car: cars[0] })
  }
  const vezes = new Map<string, number>()
  for (const x of plano) vezes.set(x.car.code, (vezes.get(x.car.code) || 0) + 1)
  for (const x of plano) if ((vezes.get(x.car.code) || 0) > 1) rel.ambiguas.push(`${x.onde} → ${x.car.code} (mais de uma pasta velha para o mesmo carro: ${plano.filter(y => y.car.code === x.car.code).map(y => y.onde).join(' + ')})`)
  for (const { f, onde, car } of plano.filter(x => (vezes.get(x.car.code) || 0) === 1)) {
    const alvo = `${raizDoCodigo(car.code)}/${alvoDe(car)}`
    if (a.dryRun) { rel.movidas.push(`${onde} (${f.itens} msg) → ${alvo}`); continue }
    try {
      const ja = await pastaDoCarro({ token, gmail: false }, car, { criar: false })
      if (!ja) {
        // a pasta inteira muda de pai e ganha o nome atual
        const raizId = (await pastaDoCarro({ token, gmail: false }, car, { criar: true }))!.id
        // pastaDoCarro criou a pasta do carro; mover as mensagens para ela (mantém a regra de uma pasta por carro)
        await moverMensagens(G0, HG, f.id, raizId, rel, onde)
      } else await moverMensagens(G0, HG, f.id, ja.id, rel, onde)
      const info: any = await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}?$select=totalItemCount,childFolderCount`, { headers: HG }).then(x => x.json()).catch(() => null)
      if (info && !info.totalItemCount && !info.childFolderCount) await comFolego(`${G0}/me/mailFolders/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: HG })
      rel.movidas.push(`${onde} (${f.itens} msg) → ${alvo}${info?.totalItemCount ? ` — ficaram ${info.totalItemCount}` : ''}`)
    } catch (e) { rel.erros.push(`${onde}: ${String((e as Error)?.message || e).slice(0, 160)}`) }
  }
  return rel
}
async function moverMensagens(G0: string, HG: Record<string, string>, de: string, para: string, rel: { erros: string[] }, onde: string) {
  const ids: string[] = []
  let next: string | null = `${G0}/me/mailFolders/${encodeURIComponent(de)}/messages?$top=100&$select=id`
  while (next) { const r: any = await comFolego(next, { headers: HG }).then(x => x.json()).catch(() => null); ids.push(...(r?.value || []).map((m: any) => String(m.id))); next = r?.['@odata.nextLink'] || null }
  let falhas = 0
  for (const id of ids) { const mv = await comFolego(`${G0}/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: HG, body: JSON.stringify({ destinationId: para }) }); if (!mv.ok) falhas++ }
  if (falhas) rel.erros.push(`${onde}: ${falhas} mensagem(ns) não passaram`)
}
