// PAPEL PROCURANDO LANÇAMENTO — o gatilho que sobra quando não há e-mail.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 09/set/2026) ───────────────────────
//   "AutoZone não manda email, logo, não há este trigger pras compras dele,
//    faça manualmente agora."
//
// O AutoBook inteiro é disparado por e-mail. Loja que confirma o pedido só na
// tela — sem confirmação, sem recibo por e-mail — é invisível para ele PARA
// SEMPRE. Não é bug: é ausência de gatilho, e nenhum conserto de extração de
// e-mail tapa esse buraco, porque nada nunca chega.
//
// O que sobra como sinal é o PAPEL NA PASTA: ele salva o PDF da compra dentro
// da pasta da invoice. O fluxo normal é "e-mail procurando invoice"; este é o
// inverso — "papel procurando lançamento".
//
// ── DUAS RÉGUAS, PORQUE UMA SÓ MENTE (v2, 09/set/2026) ─────────────────────
// A primeira versão olhava só o NOME: todo recibo que o app arquiva sai batizado
// pela rota `invoice-receipts`, lendo o banco (`<código> <carro> - <fornecedor>
// <pedido>`), então papel sem lançamento fica com o nome que veio da loja. Foi
// assim que `AutoZone - Fluids.pdf` atravessou duas arrumações de pasta e só
// sumiu quando a compra foi lançada.
//
// Só que a régua do nome tem um ponto cego, achado pela sessão PESCA/AutoBook:
// a migração de 08/set moveu 116 papéis "que só existiam no Dropbox" usando
// PREFIXO + NOME ORIGINAL. Eles passam no teste do nome e continuam podendo ser
// compra não lançada. Com essa régua sozinha a varredura dizia "0 órfãos" com
// 279 papéis sem recibo correspondente no banco — e varredura que diz zero
// quando não é zero é pior que varredura nenhuma.
//
// A segunda régua é de CONTAGEM, e não custa download nenhum: papéis na pasta
// contra URLs distintas de recibo daquela invoice no banco. O que sobra tem dois
// destinos possíveis, e a diferença entre eles é o que importa:
//
//   RECIBO A COLAR   — sobra papel E a invoice tem despesa SEM `receipt_url`.
//                      O dinheiro já está no app; o que falta é o vínculo
//                      ([[printable-invoice-law]] quer o documento nos dois
//                      lugares). Aqui o papel é a cura, não o alarme.
//   SUSPEITA         — sobra papel e TODA despesa já tem recibo. Então ou o
//                      papel não é recibo (lista de peças, orçamento) ou é
//                      COMPRA QUE NUNCA VIROU LINHA. É aqui que mora dinheiro
//                      fora do app.
//   FORA DESTE BANCO — a pasta é de um carro do BR, e o banco deste app é o do
//                      US. Não é veredito, é a confissão de que a pergunta não
//                      foi feita no lugar certo — a primeira medição marcou 29
//                      invoices BR como suspeita só por isso, o que sozinho
//                      invalidaria a lista ([[nao-achei-onde-procurou]]).
//
// Nenhuma das duas abre arquivo: `list_folder` já traz nome, data e
// `content_hash`. Ver [[fornecedor-sem-email-nao-tem-gatilho]].

import { token } from './dropboxRead.server'
import { leCaminho } from './dropboxHunt.server'
import { streamDb } from './stream.server'

const ROOTS = ['/001 - GZ28US/GZ28US Rides', '/000 - GZ28BR/GZ28BR Rides']

// Arquivos que não são papel de compra: o que o sistema operacional cria e o
// que o editor deixa para trás.
const IGNORAR = /^(\.|~\$)|^desktop\.ini$|\.(ini|tmp|db|part)$/i

export type PapelSuspeito = {
  path: string
  file: string
  rideCode: string
  rideName: string
  invoiceCode: string
  modified: string      // client_modified — o carimbo da mão de quem salvou
  hash: string          // content_hash, de graça na listagem
  bytes: number
  foraDoPadrao: boolean // o nome NÃO começa com o código da invoice
}

export type InvoiceComSobra = {
  invoiceCode: string
  rideCode: string
  rideName: string
  papeis: number            // arquivos na pasta da invoice
  recibos: number           // URLs distintas de recibo nas despesas dela
  despesas: number          // linhas de despesa da invoice NESTE banco
  despesasSemRecibo: number
  sobra: number             // papeis - recibos, quando positivo
  veredito: 'RECIBO A COLAR' | 'SUSPEITA DE COMPRA NAO LANCADA' | 'INVOICE FORA DESTE BANCO'
}

export type VarreduraPapel = {
  vistos: number
  comNome: number
  foraDoPadrao: PapelSuspeito[]     // régua 1 — o nome não é o que o app escreve
  comSobra: InvoiceComSobra[]       // régua 2 — sobra papel para o que o banco conhece
  totais: { sobra: number; aColar: number; suspeitas: number; foraDesteBanco: number }
  paginas: number
  truncou: boolean
}

async function lista(tk: string, body: unknown, cont = false): Promise<{ entries: Record<string, unknown>[]; cursor: string; more: boolean }> {
  const url = `https://api.dropboxapi.com/2/files/list_folder${cont ? '/continue' : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`list_folder ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { entries: j.entries || [], cursor: String(j.cursor || ''), more: !!j.has_more }
}

/** Um `receipt_url` pode ser texto, JSON de array, ou array — mesma leitura da rota que arquiva. */
function urlsDoRecibo(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String).filter(Boolean) : [] } catch { /* texto puro */ } }
  return [s]
}

/**
 * Varre as pastas `Invoices/` dos dois cofres e devolve o papel que o banco não
 * explica.
 *
 * Não baixa arquivo nenhum. `maxPaginas` existe porque a árvore de Rides tem
 * mídia dentro (fotos e vídeo dos carros) e uma varredura sem teto estouraria os
 * 60s da função — batido o teto, `truncou` sai true em vez de a resposta mentir
 * que acabou.
 */
export async function papeisOrfaos(maxPaginas = 40): Promise<VarreduraPapel> {
  const tk = await token()
  const out: VarreduraPapel = {
    vistos: 0, comNome: 0, foraDoPadrao: [], comSobra: [],
    totais: { sobra: 0, aColar: 0, suspeitas: 0, foraDesteBanco: 0 }, paginas: 0, truncou: false,
  }
  // Papéis agrupados pela pasta da invoice — a régua de contagem precisa do total.
  const porInvoice = new Map<string, { rideCode: string; rideName: string; papeis: number }>()

  for (const root of ROOTS) {
    let cursor = ''
    let more = true
    while (more) {
      if (out.paginas >= maxPaginas) { out.truncou = true; more = false; break }
      const r = cursor
        ? await lista(tk, { cursor }, true)
        : await lista(tk, { path: root, recursive: true, limit: 2000, include_deleted: false, include_media_info: false })
      out.paginas++
      cursor = r.cursor; more = r.more
      for (const e of r.entries) {
        if (e['.tag'] !== 'file') continue
        const path = String(e.path_display || e.path_lower || '')
        if (!/\/Invoices\//i.test(path)) continue          // só o que está DENTRO de pasta de invoice
        const nome = String(e.name || path.split('/').pop() || '')
        if (IGNORAR.test(nome)) continue
        const lido = leCaminho(path)
        // O código da invoice sai da PASTA, nunca do nome do arquivo — é
        // justamente o nome que está sob suspeita aqui.
        const daPasta = path.split('/').slice(0, -1)
          .map(s => s.match(/^([A-Za-z]{2}\.\d+\.\d+)/)?.[1]).filter(Boolean).pop()
        if (!lido || !daPasta) continue
        const codigo = daPasta.toUpperCase()
        out.vistos++
        const g = porInvoice.get(codigo) || { rideCode: lido.rideCode, rideName: lido.rideName, papeis: 0 }
        g.papeis++
        porInvoice.set(codigo, g)
        if (nome.toUpperCase().startsWith(codigo)) { out.comNome++; continue }
        out.foraDoPadrao.push({
          path, file: nome,
          rideCode: lido.rideCode, rideName: lido.rideName, invoiceCode: codigo,
          modified: String(e.client_modified || e.server_modified || ''),
          hash: String(e.content_hash || ''),
          bytes: Number(e.size) || 0,
          foraDoPadrao: true,
        })
      }
    }
  }
  out.foraDoPadrao.sort((a, b) => (a.modified < b.modified ? 1 : -1))
  if (!porInvoice.size) return out

  // ── A SEGUNDA RÉGUA: O QUE O BANCO CONHECE DAQUELA INVOICE ────────────────
  const db = streamDb()
  const codigos = [...porInvoice.keys()]
  const idPorCodigo = new Map<string, string>()
  const codigoPorId = new Map<string, string>()
  for (let i = 0; i < codigos.length; i += 200) {
    const { data } = await db.from('invoices').select('id, invoice_code').in('invoice_code', codigos.slice(i, i + 200))
    for (const r of (data || []) as Record<string, unknown>[]) {
      idPorCodigo.set(String(r.invoice_code), String(r.id))
      codigoPorId.set(String(r.id), String(r.invoice_code))
    }
  }
  const ids = [...idPorCodigo.values()]
  const recibos = new Map<string, Set<string>>()   // código → URLs distintas
  const semRecibo = new Map<string, number>()      // código → despesas sem recibo
  const despesas = new Map<string, number>()       // código → linhas de despesa
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from('invoice_expenses').select('invoice_id, receipt_url').in('invoice_id', ids.slice(i, i + 100))
    for (const r of (data || []) as Record<string, unknown>[]) {
      const cod = codigoPorId.get(String(r.invoice_id))
      if (!cod) continue
      const us = urlsDoRecibo(r.receipt_url)
      if (!recibos.has(cod)) recibos.set(cod, new Set())
      despesas.set(cod, (despesas.get(cod) || 0) + 1)
      if (!us.length) semRecibo.set(cod, (semRecibo.get(cod) || 0) + 1)
      for (const u of us) recibos.get(cod)!.add(u)
    }
  }

  for (const [cod, g] of porInvoice) {
    const nRec = recibos.get(cod)?.size || 0
    const nSem = semRecibo.get(cod) || 0
    const nDesp = despesas.get(cod) || 0
    const sobra = g.papeis - nRec
    if (sobra <= 0) continue
    // ── PRIMEIRO: EU CONHEÇO ESTA INVOICE? ──────────────────────────────────
    // A varredura lê as pastas dos DOIS cofres (Rides US e BR), mas o banco
    // deste app é só o do US. Invoice do BR não está aqui — e chamar isso de
    // "compra não lançada" seria transformar "não procurei no banco certo" em
    // acusação. Na primeira medição foram 29 invoices BR marcadas como suspeita
    // por esse motivo, o que sozinho invalidaria a lista.
    // O negativo tem de dizer ONDE se procurou ([[nao-achei-onde-procurou]]).
    if (!idPorCodigo.has(cod)) {
      out.comSobra.push({ invoiceCode: cod, rideCode: g.rideCode, rideName: g.rideName, papeis: g.papeis, recibos: 0, despesas: 0, despesasSemRecibo: 0, sobra, veredito: 'INVOICE FORA DESTE BANCO' })
      out.totais.foraDesteBanco += sobra
      continue
    }
    // Despesa sem recibo na invoice ⇒ o papel provavelmente é o vínculo que
    // falta, não uma compra perdida. Sem nenhuma, o papel não tem linha para
    // onde ir — e isso é dinheiro possivelmente fora do app.
    const veredito = nSem > 0 ? 'RECIBO A COLAR' as const : 'SUSPEITA DE COMPRA NAO LANCADA' as const
    out.comSobra.push({ invoiceCode: cod, rideCode: g.rideCode, rideName: g.rideName, papeis: g.papeis, recibos: nRec, despesas: nDesp, despesasSemRecibo: nSem, sobra, veredito })
    out.totais.sobra += sobra
    if (veredito === 'RECIBO A COLAR') out.totais.aColar += sobra; else out.totais.suspeitas += sobra
  }
  const ordem = (v: string) => (v === 'SUSPEITA DE COMPRA NAO LANCADA' ? 0 : v === 'RECIBO A COLAR' ? 1 : 2)
  out.comSobra.sort((a, b) => ordem(a.veredito) - ordem(b.veredito) || b.sobra - a.sobra)
  return out
}
