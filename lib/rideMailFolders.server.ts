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
  const slots = a.slots || [1, 2, 3, 4]
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

export async function ensureRideMailFolders(
  db: SupabaseClient, cars: RideMailCar[], opts: { slots?: number[]; dryRun?: boolean; audit?: boolean } = {},
): Promise<EnsureSlotReport[]> {
  // Sem `slots`: as caixas das empresas dos carros passados. Com `slots`: só essas — e cada uma só vê os carros dela.
  const todos = cars
  const slots = opts.slots || (['US', 'BR'] as Empresa[]).filter(e => todos.some(c => empresaDoCodigo(c.code) === e)).flatMap(e => CAIXAS_DA_EMPRESA[e])
  const out: EnsureSlotReport[] = slots.map(slot => ({ slot, account: '', provider: '', company: empresaDaCaixa(slot), ok: 0, created: [], renamed: [], conflicts: [], misplaced: [], extras: [], foreign: [], errors: [] }))
  // Uma caixa não espera a outra (contas diferentes, limites diferentes): a carga inteira cabe no tempo da rota.
  await Promise.all(out.map(async rep => {
    const slot = rep.slot
    const cars = rep.company ? todos.filter(c => empresaDoCodigo(c.code) === rep.company) : todos
    try {
      const auth = await getMailAuth(db, slot)
      if (!auth?.refresh_token) { rep.errors.push('caixa sem conexão (refresh_token)'); return }
      rep.account = String(auth.account || '')
      rep.provider = mailProvider(auth)
      const token = await freshAccessToken(db, auth)
      if (!token) { rep.errors.push('token não renovou'); return }
      const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const contagem = new Map<string, number>()   // id da pasta → mensagens (só o Graph conta na listagem)

      // As duas caixas falam línguas diferentes; daqui para baixo é uma só: `irmas` = as pastas dentro de Rides.
      let irmas: { id: string; nome: string }[] = []
      let raiz: { id: string; nome: string }[] = []
      let trazer: (id: string, nome: string) => Promise<string | null>   // pasta da raiz → dentro de Rides, já com o nome certo
      let criar: (nome: string) => Promise<string | null>          // devolve o erro, ou null
      let renomear: (id: string, nome: string) => Promise<string | null>

      if (rep.provider === 'gmail') {
        const r: any = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: H }).then(x => x.json()).catch(() => null)
        if (!Array.isArray(r?.labels)) { rep.errors.push('Gmail labels falhou: ' + JSON.stringify(r?.error || r || {}).slice(0, 160)); return }
        const user = r.labels.filter((l: any) => l.type === 'user')
        const novaLabel = async (name: string) => {
          const p = await comFolego('https://gmail.googleapis.com/gmail/v1/users/me/labels', { method: 'POST', headers: H, body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }) })
          return p.ok ? null : `HTTP ${p.status} ${(await p.text()).slice(0, 120)}`
        }
        const pai = user.find((l: any) => String(l.name).toLowerCase() === 'rides')
        const prefixo = (pai ? String(pai.name) : 'Rides') + '/'
        if (!pai && !opts.dryRun) { const e = await novaLabel('Rides'); if (e) { rep.errors.push('criar a label Rides: ' + e); return } }
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
            if (!p.ok || !j?.id) { rep.errors.push('criar a pasta Rides: HTTP ' + p.status); return }
            paiId = String(j.id)
          }
        }
        const pid = paiId
        irmas = pid ? todas.filter(f => f.parentId === pid).map(f => ({ id: f.id, nome: String(f.displayName) })) : []
        raiz = todas.filter(f => !f.parentId).map(f => ({ id: f.id, nome: String(f.displayName) }))
        for (const f of todas) contagem.set(f.id, f.itens)
        criar = async nome => {
          const p = await comFolego(`https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(pid)}/childFolders`, { method: 'POST', headers: H, body: JSON.stringify({ displayName: nome }) })
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
      // Na auditoria da frota inteira: pasta com cara de código que não é de carro nenhum desta caixa. Se o código é da
      // OUTRA empresa, é `foreign` (está na caixa errada — com quantas mensagens, quando a caixa conta); senão, `extras`.
      if (opts.audit) {
        const sobra = (f: { id: string; nome: string }, onde: string) => {
          const n = contagem.get(f.id)
          const linha = `${onde}${f.nome}${n == null ? '' : n ? ` (${n} msg)` : ' (vazia)'}`
          if (rep.company && empresaDoCodigo(f.nome) !== rep.company) rep.foreign.push(linha); else if (onde) rep.extras.push(linha)
        }
        for (const f of irmas) if (!donas.has(f.id) && !f.id.startsWith('novo:') && CARA_DE_CODIGO.test(f.nome.trim())) sobra(f, 'Rides/')
        for (const f of raiz) if (CARA_DE_CODIGO.test(f.nome.trim())) sobra(f, '')
      }
    } catch (e) {
      rep.errors.push(String((e as Error)?.message || e).slice(0, 200))
    }
  }))
  return out
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
  const tipo = (a: any) => String(a?.['@odata.type'] || '').split('.').pop() || 'anexo'
  const kb = (a: any) => Math.round(Number(a?.size) / 1024)
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
                toRecipients: m.toRecipients || [], ccRecipients: m.ccRecipients || [], bccRecipients: m.bccRecipients || [], replyTo: m.replyTo || [],
                singleValueExtendedProperties: [
                  { id: 'Integer 0x0E07', value: '1' },                        // PR_MESSAGE_FLAGS = lida, e NÃO «não enviada» (rascunho)
                  { id: MARCA_ORIGEM, value: origem },
                  ...(m.receivedDateTime ? [{ id: 'SystemTime 0x0E06', value: m.receivedDateTime }] : []),   // PR_MESSAGE_DELIVERY_TIME
                  ...(m.sentDateTime ? [{ id: 'SystemTime 0x0039', value: m.sentDateTime }] : []),           // PR_CLIENT_SUBMIT_TIME
                ],
              }
              if (m.from?.emailAddress?.address) corpo.from = m.from
              if (m.sender?.emailAddress?.address) corpo.sender = m.sender
              const cr = await graphJson(`${GRAPH}/me/mailFolders/${encodeURIComponent(destino.id)}/messages`, { method: 'POST', headers: HD, body: JSON.stringify(corpo) })
              if (!cr.ok || !cr.j?.id) throw new Error(`criar a cópia: HTTP ${cr.status} ${JSON.stringify(cr.j?.error || {}).slice(0, 160)}`)
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
        if (!opts.dryRun && !rep.failed.length && !rep.note) rep.folderRemoved = await removeSeVazia(pasta.id)
      } catch (e) {
        rep.failed.push(String((e as Error)?.message || e).slice(0, 220))
      }
    }
  }
  return out
}
