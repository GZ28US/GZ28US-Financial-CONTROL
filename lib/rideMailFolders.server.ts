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
