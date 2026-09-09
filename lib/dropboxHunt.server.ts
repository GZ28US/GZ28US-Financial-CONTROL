// SERVER-ONLY — A PASTA DA INVOICE É O PRIMEIRO LUGAR DE CAÇA.
//
// ── POR QUE ESTE ARQUIVO EXISTE (Márcio, 08/set/2026) ───────────────────────
//   "o primeiro lugar que o robô tem que caçar é nas pastas das invoices"
//   "ensine isso ao robô"
//
// O robô perguntava "entra em qual carro?" olhando só o HISTÓRICO do fornecedor
// (`candidatosPara`). Isso é estatística: "as compras anteriores da Summit foram
// parar no US.010, no US.034 e no US.002". Mas quando o PDF da compra é salvo
// dentro da pasta DAQUELA invoice, a pergunta JÁ FOI RESPONDIDA — com a mão, no
// disco, por gente. Ler a pasta não é adivinhar: é obedecer.
//
// O CASO QUE VIROU LEI (08/set/2026, 19h40 Orlando): 16 velas NGK R7437-9 na
// Summit, US$ 876,64. O histórico da Summit apontava TRÊS carros — US.010
// HellKing, US.034 Lucifer, US.002 WhiteDevil — e nenhum era o certo. A pasta
// apontava UM: `US.042 - SublimeHell/Invoices/US.042.2 .../Summit - SparkPlugs.pdf`,
// salvo às 19h40, um minuto ANTES de o e-mail da Summit chegar. A estatística
// erraria; a pasta acertou.
//
// ── A PREMISSA QUE ESTAVA ERRADA NO CÓDIGO ─────────────────────────────────
// `autoBookMail.server.ts` dizia, com todas as letras, que não dava:
//     "a pasta Purchases do carro no Dropbox NAO foi conferida — o robo nao alcanca"
// Não é verdade desde que existe `app/api/ride-folder/route.ts`: o app tem
// DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN na Vercel e já
// cria e renomeia pasta de carro pela API. Quem alcança para escrever alcança
// para ler. O ponto cego era suposição, não limite.

export type PastaForca = 'ORDEM' | 'RECENTE' | 'FORNECEDOR'

export type PastaHit = {
  path: string          // caminho completo no Dropbox, como ele guarda
  file: string          // só o nome do arquivo
  rideCode: string      // US.042
  rideName: string      // SublimeHell
  invoiceCode: string | null   // US.042.2 quando o arquivo está na pasta da invoice
  modified: string      // server_modified, ISO
  forca: PastaForca
}

const ROOTS = ['/001 - GZ28US/GZ28US Rides', '/000 - GZ28BR/GZ28BR Rides']

// O relógio da evidência: um arquivo salvo perto do e-mail é a mão do Márcio
// respondendo a pergunta antes de ela ser feita. 12h cobre o dia de trabalho
// inteiro sem deixar um recibo de mês passado se disfarçar de resposta.
const JANELA_MS = 12 * 3600e3

async function token(): Promise<string> {
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
  if (!j.access_token) throw new Error('Dropbox auth falhou: ' + JSON.stringify(j).slice(0, 200))
  return j.access_token
}

// Busca por NOME DE ARQUIVO. `filename` (e não o modo que lê o conteúdo) porque
// o que importa aqui é o que a pessoa escreveu no nome e em que pasta salvou —
// e porque busca de conteúdo é lenta e paga por indexação.
async function busca(tk: string, root: string, query: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      options: { path: root, max_results: 100, file_status: 'active', filename_only: true },
    }),
  })
  if (!res.ok) throw new Error(`Dropbox search ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return (j.matches || []).map((m: Record<string, unknown>) =>
    ((m.metadata as Record<string, unknown>)?.metadata || {}) as Record<string, unknown>)
}

// ── DE ONDE O ARQUIVO ESTÁ SE LÊ DE QUEM ELE É ─────────────────────────────
// Duas formas valem, e a segunda é mais fraca de propósito:
//   .../GZ28US Rides/US.042 - SublimeHell/Invoices/US.042.2 - Pack/arquivo.pdf
//        → carro E invoice (a pessoa escolheu a invoice)
//   .../GZ28US Rides/US.002 - WhiteDevil/Purchases/arquivo.pdf
//        → só o carro (ainda falta dizer qual invoice)
// O código da invoice também é aceito vindo do NOME do arquivo, porque a
// convenção da casa carrega ele ali ("US.042.2 SublimeHell - Summit 430475.pdf")
// e às vezes o arquivo está em Purchases com o nome já certo.
export function leCaminho(path: string): { rideCode: string; rideName: string; invoiceCode: string | null; file: string } | null {
  const seg = path.split('/').filter(Boolean)
  const i = seg.findIndex(s => /^(GZ28US|GZ28BR) Rides$/i.test(s))
  if (i < 0 || !seg[i + 1]) return null
  const mr = seg[i + 1].match(/^([A-Za-z]{2}\.\d+)\s*-?\s*(.*)$/)
  if (!mr) return null
  const file = seg[seg.length - 1]
  let invoiceCode: string | null = null
  for (const s of seg.slice(i + 2)) {
    const mi = s.match(/^([A-Za-z]{2}\.\d+\.\d+)/)
    if (mi) { invoiceCode = mi[1].toUpperCase(); break }
  }
  return { rideCode: mr[1].toUpperCase(), rideName: mr[2].trim(), invoiceCode, file }
}

// O termo de busca do fornecedor: a primeira palavra que valha busca. "Summit
// Racing Equipment" inteiro não acha "Summit - SparkPlugs.pdf"; "Summit" acha
// os dois. Palavra curta demais (HP, T1) vira as duas primeiras juntas, senão a
// busca devolve meia pasta.
export function termoFornecedor(vendor: string): string | null {
  const p = String(vendor || '').trim().split(/\s+/).filter(Boolean)
  if (!p.length) return null
  if (p[0].length >= 4) return p[0]
  return p.slice(0, 2).join(' ').trim() || null
}

// QUEM NOMEIA A PASTA É O CADASTRO — então quem procura nela tem de falar a
// mesma língua (achado da sessão PESCA/AutoBook, 09/set/2026).
//
// O caso: ele comprou na HHP às 11h36, salvou o PDF na pasta às 11h39, e o robô
// das 12h00 respondeu "nenhum arquivo". O arquivo estava lá havia 21 minutos. O
// robô procurou por `Highhorseperformance` (o remetente do e-mail) e por
// `High Horse Performan…` (o PayPal trunca); a pasta se chama `HHP`, que é o
// nome do CADASTRO — porque é a rota que a nomeia, com o nome curado.
//
// A lei [[fornecedor-nome-curado]] diz "cura na escrita, busca usa o cru", e ela
// continua certa para o BANCO. A pasta é o caso oposto: lá o nome JÁ nasceu
// curado, então procurar só pelo cru é procurar pelo nome que ninguém escreveu.
// Busca-se com os dois — e com cada apelido do cadastro, que é onde moram
// "High Horse Performance, Inc." e "HHP Racing".
//
// Teto de 4 termos: cada um custa duas chamadas ao Dropbox (uma por cofre), e
// fornecedor com dez apelidos não justifica vinte buscas.
export async function termosDeBusca(vendor: string): Promise<string[]> {
  const termos = new Set<string>()
  const cru = termoFornecedor(vendor)
  if (cru) termos.add(cru)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !String(vendor || '').trim()) return [...termos]
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const { supplierDirectoryFrom, matchSupplier } = await import('./supplierMatch')
    const db = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await db.from('suppliers').select('name, aliases, is_dealership')
    const achado = matchSupplier(vendor, supplierDirectoryFrom(data || []))
    if (achado) {
      const t = termoFornecedor(achado.name)
      if (t) termos.add(t)
      const linha = (data || []).find((s: { name?: string }) => s.name === achado.name)
      for (const a of String(linha?.aliases || '').split(/[\n,]/)) {
        // Apelido longo é PROSA, não apelido — o campo virou bloco de notas em
        // várias linhas. Mesma régua de 40 caracteres do supplierDirectoryFrom.
        const limpo = a.trim()
        if (!limpo || limpo.length > 40) continue
        const t2 = termoFornecedor(limpo)
        if (t2) termos.add(t2)
      }
    }
  } catch { /* sem cadastro a busca segue com o cru, que é melhor que nada */ }
  return [...termos].slice(0, 4)
}

// ── A CAÇA ─────────────────────────────────────────────────────────────────
// Devolve as pastas que já responderam a pergunta, da evidência mais forte para
// a mais fraca:
//   ORDEM      — o número do pedido está no nome do arquivo. Não tem como ser
//                coincidência: alguém guardou ESTA compra ali.
//   RECENTE    — o nome casa com o fornecedor e o arquivo foi salvo dentro da
//                janela do e-mail. É a mão da pessoa, agora.
//   FORNECEDOR — o nome casa com o fornecedor, mas de outra época. Vale como
//                pista de para onde as compras dele costumam ir, nada além.
export async function cacaNaPasta(
  args: { vendor?: string | null; order?: string | null; quando?: string | null },
): Promise<PastaHit[]> {
  if (!process.env.DROPBOX_REFRESH_TOKEN) return []
  const tk = await token()
  const hits = new Map<string, PastaHit>()
  const t0 = Date.parse(String(args.quando || '')) || Date.now()

  const guarda = (md: Record<string, unknown>, forca: PastaForca) => {
    const path = String(md.path_display || md.path_lower || '')
    if (!path) return
    const lido = leCaminho(path)
    if (!lido) return
    // ── QUAL RELÓGIO (erro medido em 08/set/2026, 20h07) ────────────────────
    // `server_modified` é a hora em que o DROPBOX tocou no arquivo — sobe toda
    // vez que o cliente de desktop re-sincroniza a pasta. Na primeira prova em
    // produção, três recibos da Summit de julho e agosto apareceram com
    // "20h3x de hoje" e viraram RECENTE por causa de uma ressincronização.
    // `client_modified` é a hora do arquivo NO CLIENTE no momento do upload, e
    // não muda quando o Dropbox re-desce a pasta: é o carimbo da mão de quem
    // salvou. Ele manda; `server_modified` só cobre o caso de vir vazio.
    const modified = String(md.client_modified || md.server_modified || '')
    // Recência promove: o mesmo arquivo achado pelo fornecedor vira RECENTE se
    // foi salvo junto com o e-mail.
    const perto = modified && Math.abs(Date.parse(modified) - t0) <= JANELA_MS
    const f: PastaForca = forca === 'ORDEM' ? 'ORDEM' : perto ? 'RECENTE' : 'FORNECEDOR'
    const antes = hits.get(path)
    if (antes && peso(antes.forca) >= peso(f)) return
    hits.set(path, { path, file: lido.file, rideCode: lido.rideCode, rideName: lido.rideName, invoiceCode: lido.invoiceCode, modified, forca: f })
  }

  const ordem = String(args.order || '').trim()
  // Os termos saem UMA vez, antes do laço: são os mesmos nos dois cofres.
  const termos = await termosDeBusca(args.vendor || '')
  for (const root of ROOTS) {
    // O pedido primeiro: é a evidência que não admite dúvida.
    if (ordem.length >= 4) {
      try { for (const md of await busca(tk, root, ordem)) guarda(md, 'ORDEM') } catch { /* uma raiz fora do ar não cala a outra */ }
    }
    // O fornecedor vai com TODOS os nomes que ele tem — o do e-mail e os do
    // cadastro. A pasta foi nomeada com o curado; procurar só pelo cru foi o
    // que fez a compra da HHP virar dúvida com o arquivo já salvo.
    for (const termo of termos) {
      try { for (const md of await busca(tk, root, termo)) guarda(md, 'FORNECEDOR') } catch { /* idem */ }
    }
  }
  return [...hits.values()].sort((a, b) =>
    peso(b.forca) - peso(a.forca) || (a.modified < b.modified ? 1 : -1))
}

function peso(f: PastaForca): number { return f === 'ORDEM' ? 3 : f === 'RECENTE' ? 2 : 1 }

// A pasta respondeu SEM AMBIGUIDADE? O ANDAR MAIS FORTE PRESENTE DECIDE — e é
// só ele que fala. Quem tem ORDEM não perde para RECENTE, nem que apareçam dez.
//
// ERRO MEDIDO NA PRIMEIRA PROVA EM PRODUÇÃO (08/set/2026, 20h07 Orlando): a
// caça achou 7 arquivos da Summit. O certo veio em 1º, por ORDEM
// (US.042.2 SublimeHell, pedido 430475 no nome). Mas eu tratava ORDEM e RECENTE
// no mesmo balde de "forte", e três arquivos antigos empataram com ele —
// resultado: "nenhuma resposta única", justamente quando havia uma, provada
// pelo número do pedido. Peneirar por andar conserta: com ORDEM na mesa,
// RECENTE nem é consultado.
export function respostaUnica(hits: PastaHit[]): PastaHit | null {
  for (const andar of ['ORDEM', 'RECENTE'] as const) {
    const nivel = hits.filter(h => h.forca === andar && h.invoiceCode)
    if (!nivel.length) continue
    return new Set(nivel.map(h => h.invoiceCode)).size === 1 ? nivel[0] : null
  }
  return null
}
