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
import { getMailAuth, freshAccessToken, mailProvider } from '@/lib/streamMail.server'

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

async function graphAll(token: string): Promise<{ id: string; displayName: string; parentId: string | null; path: string }[]> {
  const H = { Authorization: `Bearer ${token}` }
  const out: { id: string; displayName: string; parentId: string | null; path: string }[] = []
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
  const sel = '$top=100&$select=id,displayName,childFolderCount,parentFolderId'
  let fila: { id: string; displayName: string; childFolderCount: number; path: string }[] =
    (await lerTodas(`https://graph.microsoft.com/v1.0/me/mailFolders?${sel}`)).map((f: any) => ({ ...f, path: f.displayName }))
  for (const f of fila) out.push({ id: f.id, displayName: f.displayName, parentId: null, path: f.path })
  for (let nivel = 0; nivel < 4 && fila.length; nivel++) {
    const prox: typeof fila = []
    for (const f of fila) {
      if (!(f.childFolderCount > 0)) continue
      const kids = await lerTodas(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${sel}`)
      for (const k of kids) {
        const path = `${f.path}/${k.displayName}`
        out.push({ id: k.id, displayName: k.displayName, parentId: f.id, path })
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
  const slots = a.slots || [1, 2, 4]
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
// Nunca apaga, nunca move mensagem. `misplaced` e `extras` só RELATAM (pasta do carro na raiz; pasta com cara de código
// em Rides que não é de nenhum carro passado) — limpar é decisão do Márcio.
export type RideMailCar = { code: string; name: string; prev?: { code?: string; name?: string } }
export type EnsureSlotReport = {
  slot: number; account: string; provider: string
  ok: number; created: string[]; renamed: string[]; conflicts: string[]; misplaced: string[]; extras: string[]; errors: string[]
}
const limpa = (s: string) => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
const alvoDe = (c: RideMailCar) => `${limpa(c.code)}${limpa(c.name) ? ' - ' + limpa(c.name) : ''}`
// O nome começa com ESTE código (e não com US.030.4 quando o código é US.030)?
const temCodigo = (dn: string, code: string) => new RegExp(`^${esc(code)}(?![\\d.])`).test(String(dn || '').trim()) || String(dn || '').trim() === code
const CARA_DE_CODIGO = /^(US\.QT|US|SC|WV|PO|SHP)\.\d/

export async function ensureRideMailFolders(
  db: SupabaseClient, cars: RideMailCar[], opts: { slots?: number[]; dryRun?: boolean; audit?: boolean } = {},
): Promise<EnsureSlotReport[]> {
  const slots = opts.slots || [1, 2, 4]
  const out: EnsureSlotReport[] = []
  for (const slot of slots) {
    const rep: EnsureSlotReport = { slot, account: '', provider: '', ok: 0, created: [], renamed: [], conflicts: [], misplaced: [], extras: [], errors: [] }
    out.push(rep)
    try {
      const auth = await getMailAuth(db, slot)
      if (!auth?.refresh_token) { rep.errors.push('caixa sem conexão (refresh_token)'); continue }
      rep.account = String(auth.account || '')
      rep.provider = mailProvider(auth)
      const token = await freshAccessToken(db, auth)
      if (!token) { rep.errors.push('token não renovou'); continue }
      const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      // As duas caixas falam línguas diferentes; daqui para baixo é uma só: `irmas` = as pastas dentro de Rides.
      let irmas: { id: string; nome: string }[] = []
      let raiz: { id: string; nome: string }[] = []
      let trazer: (id: string, nome: string) => Promise<string | null>   // pasta da raiz → dentro de Rides, já com o nome certo
      let criar: (nome: string) => Promise<string | null>          // devolve o erro, ou null
      let renomear: (id: string, nome: string) => Promise<string | null>

      if (rep.provider === 'gmail') {
        const r: any = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: H }).then(x => x.json()).catch(() => null)
        if (!Array.isArray(r?.labels)) { rep.errors.push('Gmail labels falhou: ' + JSON.stringify(r?.error || r || {}).slice(0, 160)); continue }
        const user = r.labels.filter((l: any) => l.type === 'user')
        const novaLabel = async (name: string) => {
          const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { method: 'POST', headers: H, body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) })
          return p.ok ? null : `HTTP ${p.status} ${(await p.text()).slice(0, 120)}`
        }
        const pai = user.find((l: any) => String(l.name).toLowerCase() === 'rides')
        const prefixo = (pai ? String(pai.name) : 'Rides') + '/'
        if (!pai && !opts.dryRun) { const e = await novaLabel('Rides'); if (e) { rep.errors.push('criar a label Rides: ' + e); continue } }
        irmas = user.filter((l: any) => String(l.name).toLowerCase().startsWith('rides/') && !String(l.name).slice(6).includes('/')).map((l: any) => ({ id: String(l.id), nome: String(l.name).slice(6) }))
        raiz = user.filter((l: any) => !String(l.name).includes('/')).map((l: any) => ({ id: String(l.id), nome: String(l.name) }))
        criar = nome => novaLabel(prefixo + nome)
        renomear = async (id, nome) => {
          const p = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(id)}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: prefixo + nome }) })
          return p.ok ? null : `HTTP ${p.status} ${(await p.text()).slice(0, 120)}`
        }
        trazer = renomear   // no Gmail, mudar o nome da label para «Rides/…» É mover — as mensagens vão junto
      } else {
        const todas = await graphAll(token)
        let paiId = todas.find(f => !f.parentId && String(f.displayName).trim().toLowerCase() === 'rides')?.id || ''
        if (!paiId) {
          if (opts.dryRun) rep.conflicts.push('a caixa não tem a pasta «Rides» — seria criada')
          else {
            const p = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders', { method: 'POST', headers: H, body: JSON.stringify({ displayName: 'Rides' }) })
            const j: any = await p.json().catch(() => null)
            if (!p.ok || !j?.id) { rep.errors.push('criar a pasta Rides: HTTP ' + p.status); continue }
            paiId = String(j.id)
          }
        }
        const pid = paiId
        irmas = pid ? todas.filter(f => f.parentId === pid).map(f => ({ id: f.id, nome: String(f.displayName) })) : []
        raiz = todas.filter(f => !f.parentId).map(f => ({ id: f.id, nome: String(f.displayName) }))
        criar = async nome => {
          const p = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(pid)}/childFolders`, { method: 'POST', headers: H, body: JSON.stringify({ displayName: nome }) })
          return p.ok ? null : `HTTP ${p.status} ${(await p.text()).slice(0, 120)}`
        }
        renomear = async (id, nome) => {
          const p = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: H, body: JSON.stringify({ displayName: nome }) })
          return p.ok ? null : `HTTP ${p.status} ${(await p.text()).slice(0, 120)}`
        }
        // A pasta inteira muda de pai (as mensagens vão junto); o id muda no move, então o nome é acertado no id novo.
        trazer = async (id, nome) => {
          const p = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(id)}/move`, { method: 'POST', headers: H, body: JSON.stringify({ destinationId: pid }) })
          const j: any = await p.json().catch(() => null)
          if (!p.ok || !j?.id) return `mover: HTTP ${p.status} ${JSON.stringify(j?.error || {}).slice(0, 120)}`
          return String(j.displayName || '').trim() === nome ? null : renomear(String(j.id), nome)
        }
      }

      const donas = new Set<string>()   // ids das pastas que são de algum carro (para o relatório de extras)
      for (const car of cars) {
        const code = limpa(car.code), alvo = alvoDe(car)
        if (!code) continue
        const exata = irmas.find(f => f.nome.trim() === alvo)
        if (exata) { rep.ok++; donas.add(exata.id); continue }
        const prevCode = limpa(car.prev?.code || '') || code
        const prevName = car.prev?.name != null ? limpa(car.prev.name) : ''
        // a pasta DESTE carro com outra grafia — ou, vindo de um rename da tela, a do código/nome anteriores
        const minha = irmas.find(f => daPasta(f.nome, code, limpa(car.name)))
          || (car.prev ? irmas.find(f => (prevName ? daPasta(f.nome, prevCode, prevName) : temCodigo(f.nome, prevCode))) : undefined)
        if (minha) {
          donas.add(minha.id)
          const de = minha.nome
          if (irmas.some(f => f.id !== minha.id && f.nome.trim() === alvo)) { rep.conflicts.push(`${de}: já existe «${alvo}»`); continue }
          if (!opts.dryRun) { const e = await renomear(minha.id, alvo); if (e) { rep.errors.push(`renomear ${de}: ${e}`); continue } minha.nome = alvo }
          rep.renamed.push(`Rides/${de} → Rides/${alvo}`)
          continue
        }
        const ocupada = irmas.filter(f => temCodigo(f.nome, code))
        if (ocupada.length) {
          rep.conflicts.push(`${alvo}: o código já tem pasta com outro nome (${ocupada.map(f => '«' + f.nome + '»').join(', ')}) — nada criado`)
          for (const f of ocupada) donas.add(f.id)
          continue
        }
        // A pasta deste carro existe, mas solta na RAIZ da caixa (o mkdir antigo criava lá): ela ENTRA em Rides com as
        // mensagens — criar uma segunda, vazia, deixaria o e-mail do carro partido em duas.
        const solta = raiz.find(f => daPasta(f.nome, code, limpa(car.name)))
        if (solta) {
          if (!opts.dryRun) { const e = await trazer(solta.id, alvo); if (e) { rep.errors.push(`trazer «${solta.nome}» da raiz: ${e}`); continue } irmas.push({ id: 'novo:' + alvo, nome: alvo }) }
          rep.renamed.push(`${solta.nome} (raiz) → Rides/${alvo}`)
          raiz = raiz.filter(f => f.id !== solta.id)
          continue
        }
        if (!opts.dryRun) { const e = await criar(alvo); if (e) { rep.errors.push(`criar ${alvo}: ${e}`); continue } irmas.push({ id: 'novo:' + alvo, nome: alvo }) }
        rep.created.push(`Rides/${alvo}`)
      }
      // Só relato: pasta do carro perdida na RAIZ, e (na auditoria da frota inteira) pasta com cara de código que não é de carro nenhum.
      for (const car of cars) { const code = limpa(car.code); for (const f of raiz) if (code && daPasta(f.nome, code, limpa(car.name))) rep.misplaced.push(`«${f.nome}» está na raiz, e o carro já tem pasta em Rides`) }
      if (opts.audit) for (const f of irmas) if (!donas.has(f.id) && !f.id.startsWith('novo:') && CARA_DE_CODIGO.test(f.nome.trim())) rep.extras.push(`Rides/${f.nome}`)
    } catch (e) {
      rep.errors.push(String((e as Error)?.message || e).slice(0, 200))
    }
  }
  return out
}
