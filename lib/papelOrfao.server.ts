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
// O que sobra como sinal é o PAPEL NA PASTA, e ele já existe: ele salva o PDF
// da compra dentro da pasta da invoice. O fluxo normal é "e-mail procurando
// invoice"; este é o inverso — "papel procurando lançamento".
//
// ── A RÉGUA, E ELA JÁ ESTAVA LÁ ────────────────────────────────────────────
// Todo recibo que o app arquiva sai com o nome que a rota `invoice-receipts`
// escreve, lendo o banco: `<código da invoice> <carro> - <fornecedor> <pedido>`
// (app/api/ride-folder/route.ts). Papel que ninguém lançou não tem linha no
// banco para nomear, então **fica com o nome que veio da loja** — e sobrevive a
// toda arrumação de pasta, porque a limpeza só apaga o que bate `content_hash`
// com um recibo do banco ([[pasta-por-invoice]]).
//
// Foi exatamente o que aconteceu: `AutoZone - Fluids.pdf` atravessou duas
// rodadas de arrumação da pasta da US.001.2 e só sumiu quando a compra foi
// lançada — aí a rota renomeou e apagou o velho na primeira chamada.
//
// Então o teste é barato e não precisa baixar nada: **arquivo dentro de uma
// pasta de invoice cujo nome NÃO começa com o código daquela invoice é suspeito
// de compra não lançada.** O `content_hash` vem de graça na listagem e serve de
// desempate para quem quiser conferir depois.
//
// Cobre AutoZone, compra de balcão, loja física, serviço fechado por telefone —
// tudo que nunca vai gerar e-mail. Ver [[fornecedor-sem-email-nao-tem-gatilho]].

import { token } from './dropboxRead.server'
import { leCaminho } from './dropboxHunt.server'

const ROOTS = ['/001 - GZ28US/GZ28US Rides', '/000 - GZ28BR/GZ28BR Rides']

// Arquivos que não são recibo de compra e não devem virar suspeita: o buildsheet
// do carro, a planilha de trabalho, o que o Dropbox mesmo cria.
const IGNORAR = /^(\.|~\$|desktop\.ini$|icon\r?$)|\.(ini|tmp|db|part)$/i

export type PapelOrfao = {
  path: string
  file: string
  rideCode: string
  rideName: string
  invoiceCode: string
  modified: string      // client_modified — o carimbo da mão de quem salvou
  hash: string          // content_hash, de graça na listagem
  bytes: number
}

export type VarreduraPapel = {
  vistos: number        // arquivos dentro de pastas de invoice
  comNome: number       // já nomeados pelo app (têm lançamento)
  orfaos: PapelOrfao[]
  paginas: number
  truncou: boolean      // o orçamento de páginas acabou antes da árvore
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

/**
 * Varre as pastas `Invoices/` dos dois cofres e devolve o papel que ninguém
 * lançou.
 *
 * Não baixa arquivo nenhum: só `list_folder`, que já traz nome, data e
 * `content_hash`. `maxPaginas` existe porque a árvore de Rides tem mídia dentro
 * (fotos e vídeo dos carros) e uma varredura sem teto estouraria os 60s da
 * função — quando o teto é atingido, `truncou` sai true em vez de a resposta
 * mentir que acabou.
 */
export async function papeisOrfaos(maxPaginas = 40): Promise<VarreduraPapel> {
  const tk = await token()
  const out: VarreduraPapel = { vistos: 0, comNome: 0, orfaos: [], paginas: 0, truncou: false }

  for (const root of ROOTS) {
    let cursor = ''
    let more = true
    while (more) {
      if (out.paginas >= maxPaginas) { out.truncou = true; return out }
      const r = cursor
        ? await lista(tk, { cursor }, true)
        : await lista(tk, { path: root, recursive: true, limit: 2000, include_deleted: false, include_media_info: false })
      out.paginas++
      cursor = r.cursor; more = r.more
      for (const e of r.entries) {
        if (e['.tag'] !== 'file') continue
        const path = String(e.path_display || e.path_lower || '')
        // Só interessa o que está DENTRO de uma pasta de invoice.
        if (!/\/Invoices\//i.test(path)) continue
        const nome = String(e.name || path.split('/').pop() || '')
        if (IGNORAR.test(nome)) continue
        const lido = leCaminho(path)
        // O código da invoice tem de vir da PASTA, não do nome do arquivo — é
        // justamente o nome que está sob suspeita aqui.
        const daPasta = path.split('/').slice(0, -1).map(s => s.match(/^([A-Za-z]{2}\.\d+\.\d+)/)?.[1]).filter(Boolean).pop()
        if (!lido || !daPasta) continue
        out.vistos++
        const codigo = daPasta.toUpperCase()
        // Nome escrito pelo app começa com o código da invoice. Qualquer outro
        // nome é o que veio da loja — papel que o banco nunca nomeou.
        if (nome.toUpperCase().startsWith(codigo)) { out.comNome++; continue }
        out.orfaos.push({
          path, file: nome,
          rideCode: lido.rideCode, rideName: lido.rideName, invoiceCode: codigo,
          modified: String(e.client_modified || e.server_modified || ''),
          hash: String(e.content_hash || ''),
          bytes: Number(e.size) || 0,
        })
      }
    }
  }
  out.orfaos.sort((a, b) => (a.modified < b.modified ? 1 : -1))
  return out
}
