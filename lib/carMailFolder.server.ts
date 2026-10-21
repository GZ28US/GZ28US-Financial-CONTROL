// lib/carMailFolder.server.ts — A PASTA DE E-MAIL DO CARRO, EM QUALQUER CAIXA (21/10/2026).
//
// LEI SAGRADA do Márcio (20/10/2026, ~22h40 Orlando, via Parts Chasing 2), que SUBSTITUI a de 05/10 («cada caixa só tem os
// carros da sua empresa»): «Every mailbox should have the folders GZ28US Rides and GZ28BR Rides, inside them, the car's folder,
// and the emails should be there, create the folder when there's not … save all emails reffered to a ride in its folder, if
// there's any, create it.» E ele escolheu (21/10): a pasta do carro nasce numa caixa SÓ quando há e-mail daquele carro nela.
//
//   • TODA caixa (as 8, Outlook e Gmail) tem as duas raízes: «GZ28US Rides» (US · SC · WV · PO) e «GZ28BR Rides» (BR · GM);
//   • dentro, UMA pasta por carro, com o nome do Dropbox: «<código> - <nome>»;
//   • o e-mail do carro fica NA CAIXA ONDE ELE ESTÁ — carro do US numa caixa do BR ganha «GZ28US Rides/US.0xx» ali mesmo.
// No Gmail a pasta é label aninhada: «GZ28US Rides/US.022 - Apocalypse».
// pastaDoCarro acha (ou cria, com `criar`) a raiz e a pasta do carro e devolve o id. Todo robô que arquiva e-mail de carro
// passa por aqui: lib/carMail.server.ts (AutoBook + mail-poll), /api/stream/mail-query (mkdir), a migração das «Rides» velhas.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Empresa = 'US' | 'BR'
export const RAIZ_DA_EMPRESA: Record<Empresa, string> = { US: 'GZ28US Rides', BR: 'GZ28BR Rides' }
export const empresaDoCodigo = (code: string): Empresa => (/^(BR|GM)\./i.test(String(code || '').trim()) ? 'BR' : 'US')
export const raizDoCodigo = (code: string) => RAIZ_DA_EMPRESA[empresaDoCodigo(code)]
const limpa = (s: string) => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
export const nomeDaPastaDoCarro = (c: { code: string; name?: string | null }) => `${limpa(c.code)}${limpa(c.name || '') ? ' - ' + limpa(c.name || '') : ''}`
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// O nome começa com ESTE código (US.030 não pega US.030.4)?
export const comecaComCodigo = (dn: string, code: string) => { const t = String(dn || '').trim(), c = limpa(code); return t === c || new RegExp(`^${esc(c)}(?![\\d.])`, 'i').test(t) }

export type CaixaDaPasta = { token: string; gmail: boolean }
const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const H = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

async function comFolego(url: string, init: RequestInit): Promise<Response> {
  let r = await fetch(url, init)
  for (let i = 0; i < 2 && (r.status === 429 || r.status === 503); i++) {
    await new Promise(ok => setTimeout(ok, Math.min(20, Math.max(1, Number(r.headers.get('retry-after')) || 3 * (i + 1))) * 1000))
    r = await fetch(url, init)
  }
  return r
}
async function lerTudo(token: string, url: string): Promise<any[]> {
  const out: any[] = []
  let next: string | null = url
  while (next) {
    const r: any = await comFolego(next, { headers: H(token) }).then(x => x.json()).catch(() => null)
    if (!Array.isArray(r?.value)) throw new Error('Graph: ' + JSON.stringify(r?.error || r || {}).slice(0, 160))
    out.push(...r.value)
    next = r['@odata.nextLink'] || null
  }
  return out
}

// Cache por token (uma rodada de robô): raiz → id, e (raiz id) → filhas.
const raizes = new Map<string, Map<string, string>>()
const filhas = new Map<string, { id: string; nome: string }[]>()
const labels = new Map<string, { id: string; name: string }[]>()
export const esqueceCachePastasDeCarro = () => { raizes.clear(); filhas.clear(); labels.clear() }

async function raizGraph(token: string, nome: string, criar: boolean): Promise<string | null> {
  let m = raizes.get(token)
  if (!m) {
    m = new Map()
    for (const f of await lerTudo(token, `${G}/me/mailFolders?$top=100&$select=id,displayName`)) m.set(String(f.displayName || '').trim().toLowerCase(), String(f.id))
    raizes.set(token, m)
  }
  const hit = m.get(nome.toLowerCase())
  if (hit || !criar) return hit || null
  const p = await comFolego(`${G}/me/mailFolders`, { method: 'POST', headers: H(token), body: JSON.stringify({ displayName: nome }) })
  const j: any = await p.json().catch(() => null)
  if (!p.ok || !j?.id) throw new Error(`criar a pasta «${nome}»: HTTP ${p.status} ${JSON.stringify(j?.error || {}).slice(0, 120)}`)
  m.set(nome.toLowerCase(), String(j.id))
  return String(j.id)
}
async function filhasGraph(token: string, raizId: string) {
  const k = token + '|' + raizId
  let l = filhas.get(k)
  if (!l) { l = (await lerTudo(token, `${G}/me/mailFolders/${encodeURIComponent(raizId)}/childFolders?$top=100&$select=id,displayName`)).map((f: any) => ({ id: String(f.id), nome: String(f.displayName || '') })); filhas.set(k, l) }
  return l
}
async function labelsGmail(token: string) {
  let l = labels.get(token)
  if (!l) {
    const r: any = await comFolego(`${GM}/labels`, { headers: H(token) }).then(x => x.json()).catch(() => null)
    if (!Array.isArray(r?.labels)) throw new Error('Gmail labels: ' + JSON.stringify(r?.error || r || {}).slice(0, 160))
    l = r.labels.filter((x: any) => x.type === 'user').map((x: any) => ({ id: String(x.id), name: String(x.name) }))
    labels.set(token, l!)
  }
  return l!
}
async function novaLabel(token: string, name: string): Promise<string> {
  const p = await comFolego(`${GM}/labels`, { method: 'POST', headers: H(token), body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) })
  const j: any = await p.json().catch(() => null)
  if (p.ok && j?.id) { (await labelsGmail(token)).push({ id: String(j.id), name }); return String(j.id) }
  if (p.status === 409) { labels.delete(token); const de = (await labelsGmail(token)).find(x => x.name.toLowerCase() === name.toLowerCase()); if (de) return de.id }
  throw new Error(`criar a label «${name}»: HTTP ${p.status} ${JSON.stringify(j?.error || {}).slice(0, 120)}`)
}

// A pasta do carro nesta caixa: a de nome exato; senão a que começa com o código (mesmo carro, grafia velha); senão, com
// `criar`, nasce «<raiz>/<código> - <nome>». Devolve null só quando não existe e `criar` é falso.
export async function pastaDoCarro(cx: CaixaDaPasta, car: { code: string; name?: string | null }, opts: { criar?: boolean } = {}): Promise<{ id: string; caminho: string; nasceu: boolean } | null> {
  const raiz = raizDoCodigo(car.code), alvo = nomeDaPastaDoCarro(car)
  if (cx.gmail) {
    const todas = await labelsGmail(cx.token)
    const dentro = todas.filter(l => l.name.toLowerCase().startsWith(raiz.toLowerCase() + '/') && !l.name.slice(raiz.length + 1).includes('/'))
    const exata = dentro.find(l => l.name.slice(raiz.length + 1).trim().toLowerCase() === alvo.toLowerCase())
    const dele = exata || dentro.find(l => comecaComCodigo(l.name.slice(raiz.length + 1), car.code))
    if (dele) return { id: dele.id, caminho: dele.name, nasceu: false }
    if (!opts.criar) return null
    if (!todas.some(l => l.name.toLowerCase() === raiz.toLowerCase())) await novaLabel(cx.token, raiz)
    return { id: await novaLabel(cx.token, `${raiz}/${alvo}`), caminho: `${raiz}/${alvo}`, nasceu: true }
  }
  const raizId = await raizGraph(cx.token, raiz, !!opts.criar)
  if (!raizId) return null
  const lista = await filhasGraph(cx.token, raizId)
  const exata = lista.find(f => f.nome.trim().toLowerCase() === alvo.toLowerCase())
  const dele = exata || lista.find(f => comecaComCodigo(f.nome, car.code))
  if (dele) return { id: dele.id, caminho: `${raiz}/${dele.nome}`, nasceu: false }
  if (!opts.criar) return null
  const p = await comFolego(`${G}/me/mailFolders/${encodeURIComponent(raizId)}/childFolders`, { method: 'POST', headers: H(cx.token), body: JSON.stringify({ displayName: alvo }) })
  const j: any = await p.json().catch(() => null)
  if (p.ok && j?.id) { lista.push({ id: String(j.id), nome: alvo }); return { id: String(j.id), caminho: `${raiz}/${alvo}`, nasceu: true } }
  if (p.status === 409) { filhas.delete(cx.token + '|' + raizId); const de = (await filhasGraph(cx.token, raizId)).find(f => f.nome.trim().toLowerCase() === alvo.toLowerCase()); if (de) return { id: de.id, caminho: `${raiz}/${de.nome}`, nasceu: false } }
  throw new Error(`criar «${raiz}/${alvo}»: HTTP ${p.status} ${JSON.stringify(j?.error || {}).slice(0, 120)}`)
}
