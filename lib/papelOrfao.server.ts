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
//   FORA DESTE BANCO — ninguém conhece esta invoice. Não é veredito, é a
//                      confissão de que a pergunta não foi respondida — a
//                      primeira medição marcou 29 invoices BR como suspeita só
//                      porque o app do US não enxergava o banco do BR, o que
//                      sozinho invalidaria a lista ([[nao-achei-onde-procurou]]).
//                      Hoje a varredura pergunta nos DOIS bancos quando a chave
//                      do BR está no ambiente (lib/supabaseBR.server.ts); sem
//                      ela, as invoices do BR caem aqui de novo — e `bancos` na
//                      resposta diz quais foram perguntados.
//
// Nenhuma das duas abre arquivo: `list_folder` já traz nome, data e
// `content_hash`. Ver [[fornecedor-sem-email-nao-tem-gatilho]].

import { token } from './dropboxRead.server'
import { leCaminho } from './dropboxHunt.server'
import { streamDb } from './stream.server'
import { supabaseBRService } from './supabaseBR.server'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  // Os nomes dos papéis daquela pasta. Sem eles a varredura devolve um número e
  // deixa a pessoa procurar no Dropbox — e quem vai conferir precisa saber O QUE
  // conferir, não quantos.
  arquivos: string[]
  // DE QUAL BANCO SAIU ESTE VEREDITO. Enquanto o BR estava fora do alcance, o
  // próprio veredito "INVOICE FORA DESTE BANCO" contava essa história — foi ele
  // que impediu 29 acusações falsas. Ligado o BR, esse veredito some e a
  // pergunta "onde você olhou?" ficaria sem resposta. Por isso vira campo:
  // ninguém devia ter de deduzir a fonte pelo prefixo do código.
  banco: 'US' | 'BR' | null
  veredito: 'RECIBO A COLAR' | 'SUSPEITA DE COMPRA NAO LANCADA' | 'INVOICE FORA DESTE BANCO'
}

export type VarreduraPapel = {
  vistos: number
  comNome: number
  foraDoPadrao: PapelSuspeito[]     // régua 1 — o nome não é o que o app escreve
  comSobra: InvoiceComSobra[]       // régua 2 — sobra papel para o que o banco conhece
  totais: { sobra: number; aColar: number; suspeitas: number; foraDesteBanco: number }
  // Quais bancos a varredura conseguiu perguntar nesta rodada. Sem a chave do
  // BR no ambiente, 'BR' fica de fora e as invoices de lá ficam sem veredito —
  // e é isso que a resposta tem de dizer, em vez de parecer completa.
  bancos: ('US' | 'BR')[]
  paginas: number
  truncou: boolean
}

type Conhecidas = {
  ids: Map<string, string>
  recibos: Map<string, Set<string>>
  semRecibo: Map<string, number>
  despesas: Map<string, number>
}

/** O que UM banco sabe das invoices cujos códigos vieram das pastas. */
async function oQueOBancoSabe(db: SupabaseClient, codigos: string[]): Promise<Conhecidas> {
  const r: Conhecidas = { ids: new Map(), recibos: new Map(), semRecibo: new Map(), despesas: new Map() }
  const codigoPorId = new Map<string, string>()
  for (let i = 0; i < codigos.length; i += 200) {
    const { data } = await db.from('invoices').select('id, invoice_code').in('invoice_code', codigos.slice(i, i + 200))
    for (const x of (data || []) as Record<string, unknown>[]) {
      r.ids.set(String(x.invoice_code), String(x.id))
      codigoPorId.set(String(x.id), String(x.invoice_code))
    }
  }
  const ids = [...r.ids.values()]
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from('invoice_expenses').select('invoice_id, receipt_url').in('invoice_id', ids.slice(i, i + 100))
    for (const x of (data || []) as Record<string, unknown>[]) {
      const cod = codigoPorId.get(String(x.invoice_id))
      if (!cod) continue
      const us = urlsDoRecibo(x.receipt_url)
      if (!r.recibos.has(cod)) r.recibos.set(cod, new Set())
      r.despesas.set(cod, (r.despesas.get(cod) || 0) + 1)
      if (!us.length) r.semRecibo.set(cod, (r.semRecibo.get(cod) || 0) + 1)
      for (const u of us) r.recibos.get(cod)!.add(u)
    }
  }
  return r
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
    totais: { sobra: 0, aColar: 0, suspeitas: 0, foraDesteBanco: 0 }, bancos: ['US'], paginas: 0, truncou: false,
  }
  // Papéis agrupados pela pasta da invoice — a régua de contagem precisa do total.
  const porInvoice = new Map<string, { rideCode: string; rideName: string; papeis: number; arquivos: string[] }>()

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
        const g = porInvoice.get(codigo) || { rideCode: lido.rideCode, rideName: lido.rideName, papeis: 0, arquivos: [] }
        g.papeis++
        if (g.arquivos.length < 40) g.arquivos.push(nome)
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

  // ── A SEGUNDA RÉGUA: O QUE OS BANCOS CONHECEM DAQUELA INVOICE ────────────
  // Primeiro o do US. O que ele não conhece vai para o do BR — sem adivinhar
  // pelo prefixo do código: quem responde é quem TEM a invoice. (GM.003.1, por
  // exemplo, mora no BR e não parece.)
  const codigos = [...porInvoice.keys()]
  const us = await oQueOBancoSabe(streamDb(), codigos)
  const faltam = codigos.filter((c) => !us.ids.has(c))
  const dbBR = supabaseBRService()
  if (dbBR) out.bancos.push("BR")
  const br = dbBR && faltam.length ? await oQueOBancoSabe(dbBR, faltam) : null
  const fonte = (cod: string): { banco: "US" | "BR" | null; c: Conhecidas | null } =>
    us.ids.has(cod) ? { banco: "US", c: us } : br?.ids.has(cod) ? { banco: "BR", c: br } : { banco: null, c: null }
  for (const [cod, g] of porInvoice) {
    const { banco, c } = fonte(cod)
    const nRec = c?.recibos.get(cod)?.size || 0
    const nSem = c?.semRecibo.get(cod) || 0
    const nDesp = c?.despesas.get(cod) || 0
    const sobra = g.papeis - nRec
    if (sobra <= 0) continue
    // ── PRIMEIRO: ALGUÉM CONHECE ESTA INVOICE? ──────────────────────────────
    // A varredura lê as pastas dos DOIS cofres (Rides US e BR). Enquanto só o
    // banco do US era alcançável, TODA invoice do BR caía aqui — e chamar isso
    // de "compra não lançada" seria transformar "não procurei no banco certo"
    // em acusação. Foram 29 assim na primeira medição, o que sozinho
    // invalidaria a lista. O negativo tem de dizer ONDE se procurou
    // ([[nao-achei-onde-procurou]]): daí este veredito, e daí o campo banco.
    if (!banco) {
      out.comSobra.push({ invoiceCode: cod, rideCode: g.rideCode, rideName: g.rideName, papeis: g.papeis, recibos: 0, despesas: 0, despesasSemRecibo: 0, sobra, arquivos: g.arquivos, banco: null, veredito: 'INVOICE FORA DESTE BANCO' })
      out.totais.foraDesteBanco += sobra
      continue
    }
    // Despesa sem recibo na invoice ⇒ o papel provavelmente é o vínculo que
    // falta, não uma compra perdida. Sem nenhuma, o papel não tem linha para
    // onde ir — e isso é dinheiro possivelmente fora do app.
    const veredito = nSem > 0 ? 'RECIBO A COLAR' as const : 'SUSPEITA DE COMPRA NAO LANCADA' as const
    out.comSobra.push({ invoiceCode: cod, rideCode: g.rideCode, rideName: g.rideName, papeis: g.papeis, recibos: nRec, despesas: nDesp, despesasSemRecibo: nSem, sobra, arquivos: g.arquivos, banco, veredito })
    out.totais.sobra += sobra
    if (veredito === 'RECIBO A COLAR') out.totais.aColar += sobra; else out.totais.suspeitas += sobra
  }
  const ordem = (v: string) => (v === 'SUSPEITA DE COMPRA NAO LANCADA' ? 0 : v === 'RECIBO A COLAR' ? 1 : 2)
  out.comSobra.sort((a, b) => ordem(a.veredito) - ordem(b.veredito) || b.sobra - a.sobra)
  return out
}
