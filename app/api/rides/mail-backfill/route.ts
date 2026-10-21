// /api/rides/mail-backfill — A VARREDURA: todo e-mail de carro, e a conversa dele, na pasta do carro (21/10/2026).
//
// LEI do Márcio (20/10/2026): «save all emails reffered to a ride in its folder, if there's any, create it. And tell App Develpment
// to check all the emails from a car thread and put them in the right folder, the car's folder.» Os robôs cuidam do e-mail NOVO
// (AutoBook / mail-poll, lib/carMail.server.ts); esta rota passa o que JÁ está nas caixas.
//   GET ?slot=N[&dryRun=1][&since=2023-01-01][&cursor=…][&budget=240]
// Para cada mensagem da caixa (da mais velha para a mais nova, para a carta do pedido vir antes das respostas), fora de Rascunhos,
// Lixeira, Spam, Caixa de saída e das próprias pastas de carro:
//   1. o pedido de algum carro aparece no assunto ou no começo do texto (o mesmo índice pedido → carro do robô) → a mensagem vai
//      para a pasta de cada carro (extras = cópia, último = move; no Gmail, a conversa inteira ganha a label e sai da inbox);
//   2. senão, se a CONVERSA dela já mora numa pasta de carro → vai para lá também.
// A pasta nasce quando falta (pastaDoCarro). Nada é apagado. Caixa grande vai em pedaços: a resposta traz `next` (cursor) até
// terminar. Dry run: só conta e lista exemplos.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken, mailProvider } from '@/lib/streamMail.server'
import { carregaIndiceCarros, carrosDaCarta, type CarroDaCarta } from '@/lib/carMail.server'
import { pastaDoCarro, RAIZ_DA_EMPRESA, esqueceCachePastasDeCarro } from '@/lib/carMailFolder.server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const H = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })

type Rel = { slot: number; account: string; dryRun: boolean; lidas: number; porPedido: number; porConversa: number; jaNoLugar: number; falhas: string[]; exemplos: string[]; next: string | null }

async function j(url: string, init: RequestInit = {}): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, init)
    // O Gmail avisa o limite por usuário com 403 (rateLimitExceeded / userRateLimitExceeded), não com 429.
    const body = await r.json().catch(() => null)
    const limite = r.status === 429 || r.status === 503 || (r.status === 403 && /rate ?limit/i.test(JSON.stringify(body?.error || '')))
    if (limite) { await new Promise(ok => setTimeout(ok, Math.min(30, Number(r.headers.get('retry-after')) || 5 * (i + 1)) * 1000)); continue }
    return { ok: r.ok, status: r.status, body }
  }
  return { ok: false, status: 429, body: null }
}

async function graph(token: string, idx: any, rel: Rel, since: string, cursor: string | null, fim: number) {
  const hd = H(token)
  // pastas que não se varrem: as bem-conhecidas e tudo debaixo das duas raízes de carro
  const fora = new Set<string>()
  for (const wk of ['drafts', 'deleteditems', 'junkemail', 'outbox', 'conversationhistory']) { const r = await j(`${G}/me/mailFolders/${wk}?$select=id`, { headers: hd }); if (r.ok && r.body?.id) fora.add(String(r.body.id)) }
  const conversaDe = new Map<string, string>()   // conversationId → id da pasta do carro
  const top = await j(`${G}/me/mailFolders?$top=100&$select=id,displayName`, { headers: hd })
  const pastasCarro = new Set<string>()
  for (const raizNome of Object.values(RAIZ_DA_EMPRESA)) {
    const raiz = (top.body?.value || []).find((f: any) => String(f.displayName).trim().toLowerCase() === raizNome.toLowerCase())
    if (!raiz) continue
    fora.add(String(raiz.id))
    let nx: string | null = `${G}/me/mailFolders/${raiz.id}/childFolders?$top=100&$select=id`
    while (nx) {
      const r = await j(nx, { headers: hd })
      for (const f of r.body?.value || []) {
        fora.add(String(f.id)); pastasCarro.add(String(f.id))
        let mx: string | null = `${G}/me/mailFolders/${f.id}/messages?$top=200&$select=conversationId`
        while (mx) { const m = await j(mx, { headers: hd }); for (const x of m.body?.value || []) if (x.conversationId) conversaDe.set(String(x.conversationId), String(f.id)); mx = m.body?.['@odata.nextLink'] || null }
      }
      nx = r.body?.['@odata.nextLink'] || null
    }
  }
  let next: string | null = cursor || `${G}/me/messages?$top=50&$orderby=receivedDateTime asc&$filter=${encodeURIComponent(`receivedDateTime ge ${since}T00:00:00Z`)}&$select=id,subject,bodyPreview,parentFolderId,conversationId,isDraft,receivedDateTime`
  while (next && Date.now() < fim) {
    const pg = await j(next, { headers: hd })
    if (!pg.ok) { rel.falhas.push(`listar: HTTP ${pg.status}`); break }
    for (const m of pg.body?.value || []) {
      rel.lidas++
      if (m.isDraft || fora.has(String(m.parentFolderId))) { if (pastasCarro.has(String(m.parentFolderId))) rel.jaNoLugar++; continue }
      const carros: CarroDaCarta[] = carrosDaCarta(idx, { subject: String(m.subject || ''), text: String(m.bodyPreview || '') })
      let destinos: string[] = [], rotulo = ''
      if (carros.length) {
        try {
          const ps = []
          for (const c of carros) ps.push(await pastaDoCarro({ token, gmail: false }, c, { criar: !rel.dryRun }))
          destinos = ps.map(p => p?.id || 'novo'); rotulo = ps.map((p, i) => p?.caminho || `${carros[i].code} (nasceria)`).join(' + ')
        } catch (e) { rel.falhas.push(`pasta de ${carros.map(c => c.code).join('+')}: ${String((e as Error).message).slice(0, 120)}`); continue }
        rel.porPedido++
      } else if (m.conversationId && conversaDe.has(String(m.conversationId))) {
        destinos = [conversaDe.get(String(m.conversationId))!]; rotulo = 'conversa'; rel.porConversa++
      } else continue
      if (rel.exemplos.length < 25) rel.exemplos.push(`${String(m.receivedDateTime).slice(0, 10)} «${String(m.subject || '').slice(0, 60)}» → ${rotulo}`)
      if (rel.dryRun) { if (m.conversationId && destinos[0] !== 'novo') conversaDe.set(String(m.conversationId), destinos[destinos.length - 1]); continue }
      let ok = true
      for (const d of destinos.slice(0, -1)) { const c = await j(`${G}/me/messages/${encodeURIComponent(m.id)}/copy`, { method: 'POST', headers: hd, body: JSON.stringify({ destinationId: d }) }); if (!c.ok) { ok = false; rel.falhas.push(`cópia «${String(m.subject).slice(0, 40)}»: HTTP ${c.status}`) } }
      const mv = await j(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, { method: 'POST', headers: hd, body: JSON.stringify({ destinationId: destinos[destinos.length - 1] }) })
      if (!mv.ok) { ok = false; rel.falhas.push(`mover «${String(m.subject).slice(0, 40)}»: HTTP ${mv.status}`) }
      if (ok && m.conversationId) conversaDe.set(String(m.conversationId), destinos[destinos.length - 1])
    }
    next = pg.body?.['@odata.nextLink'] || null
  }
  rel.next = next
}

async function gmail(token: string, idx: any, rel: Rel, since: string, cursor: string | null, fim: number) {
  const hd = H(token)
  const lab = await j(`${GM}/labels`, { headers: hd })
  const raizes = Object.values(RAIZ_DA_EMPRESA).map(r => r.toLowerCase() + '/')
  const deCarro = new Set<string>((lab.body?.labels || []).filter((l: any) => raizes.some(r => String(l.name).toLowerCase().startsWith(r))).map((l: any) => String(l.id)))
  const fio = new Set<string>()   // threads já resolvidas nesta passada
  const q = `after:${since.replace(/-/g, '/')} -in:drafts -in:trash -in:spam`
  let pageToken = cursor || ''
  do {
    const pg = await j(`${GM}/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: hd })
    if (!pg.ok) { rel.falhas.push(`listar: HTTP ${pg.status}`); break }
    for (const { id, threadId } of pg.body?.messages || []) {
      rel.lidas++
      if (fio.has(threadId)) continue
      const m = await j(`${GM}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`, { headers: hd })
      const labels: string[] = m.body?.labelIds || []
      if (labels.some(l => deCarro.has(l))) { rel.jaNoLugar++; fio.add(threadId); continue }
      const subject = String((m.body?.payload?.headers || []).find((h: any) => h.name === 'Subject')?.value || '')
      const carros = carrosDaCarta(idx, { subject, text: String(m.body?.snippet || '') })
      if (!carros.length) continue
      fio.add(threadId)
      let ids: string[] = [], rotulo = ''
      try { const ps = []; for (const c of carros) ps.push(await pastaDoCarro({ token, gmail: true }, c, { criar: !rel.dryRun })); ids = ps.map(p => p?.id || ''); rotulo = ps.map((p, i) => p?.caminho || `${carros[i].code} (nasceria)`).join(' + ') }
      catch (e) { rel.falhas.push(`label de ${carros.map(c => c.code).join('+')}: ${String((e as Error).message).slice(0, 120)}`); continue }
      rel.porPedido++
      if (rel.exemplos.length < 25) rel.exemplos.push(`«${subject.slice(0, 60)}» (conversa inteira) → ${rotulo}`)
      if (rel.dryRun) continue
      const r = await j(`${GM}/threads/${threadId}/modify`, { method: 'POST', headers: hd, body: JSON.stringify({ addLabelIds: ids.filter(Boolean), removeLabelIds: ['INBOX'] }) })
      if (!r.ok) rel.falhas.push(`thread «${subject.slice(0, 40)}»: HTTP ${r.status}`)
      for (const x of ids) deCarro.add(x)
    }
    pageToken = pg.body?.nextPageToken || ''
  } while (pageToken && Date.now() < fim)
  rel.next = pageToken || null
}

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sp = req.nextUrl.searchParams
  const slot = Number(sp.get('slot'))
  if (!slot) return NextResponse.json({ error: 'slot obrigatório' }, { status: 400 })
  const dryRun = sp.get('dryRun') === '1'
  const since = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('since') || '') ? String(sp.get('since')) : '2023-01-01'
  const cursor = sp.get('cursor') ? Buffer.from(String(sp.get('cursor')), 'base64url').toString('utf8') : null
  const fim = Date.now() + Math.min(270, Math.max(30, Number(sp.get('budget')) || 240)) * 1000
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth?.refresh_token) return NextResponse.json({ error: `caixa ${slot} sem conexão` }, { status: 404 })
  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'token não renovou' }, { status: 502 })
  const rel: Rel = { slot, account: String(auth.account || ''), dryRun, lidas: 0, porPedido: 0, porConversa: 0, jaNoLugar: 0, falhas: [], exemplos: [], next: null }
  esqueceCachePastasDeCarro()
  const erros: string[] = []
  const idx = await carregaIndiceCarros(db, erros)
  try {
    if (mailProvider(auth) === 'gmail') await gmail(token, idx, rel, since, cursor, fim)
    else await graph(token, idx, rel, since, cursor, fim)
  } catch (e) { rel.falhas.push(String((e as Error)?.message || e).slice(0, 200)) }
  return NextResponse.json({ ok: !rel.falhas.length && !erros.length, erros, ...rel, next: rel.next ? Buffer.from(rel.next, 'utf8').toString('base64url') : null })
}
