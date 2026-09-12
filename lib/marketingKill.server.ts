// SERVER-ONLY — MARKETING KILL (ordem do Márcio, 18/ago/2026: "quero que nosso app
// limpe os e-mails de marketing de 5 em 5 minutos… INFALÍVEL, e não apague nada que
// não seja marketing de jeito nenhum").
//
// Diagnóstico que gerou esta feature: o sweep antigo (sweepMarketing) pula tudo que
// bata em SAFE_SUBJECT — lista que inclui "cart" e "confirm" —, então "In cart: Was
// $34.64" e "Please Confirm Your 2026 Gift!" da Temu ficaram 27h imortais na inbox.
//
// Desenho novo, em DUAS camadas (assim a lista NÃO precisa ser perfeita):
//   1. o REMETENTE tem de estar em `marketing_senders` (auditado, ativo);
//   2. E a mensagem tem de passar nas travas de conteúdo — sem anexo, sem estar
//      dentro de conversa (In-Reply-To/References) e sem NENHUM marcador
//      transacional (nº de pedido/rastreio, valor aprovado, código, cancelamento,
//      candidatura, reserva…) nem no assunto nem no preview.
//
// O `List-Unsubscribe` ERA obrigatório e SAIU em 25/ago/2026 (ordem dele: "some com
// eles"). Motivo: remetente brasileiro em geral não manda esse cabeçalho — Nubank
// dispara por SendGrid e Mecanizou por Mailgun, e nenhum dos dois o inclui (conferido
// nos 57 e 61 cabeçalhos que o Graph devolveu). O resultado era um matador que
// encontrava o e-mail toda passada e nunca podia apagar: 523 bloqueios no Mecanizou,
// 1.158 no radiumauto, 2.609 no amenify. Para remetente que ELE já curou na lista, a
// identidade do remetente já é a prova; o cabeçalho virou bônus, não requisito.
// Bateu tudo  → move pra Itens Excluídos (Outlook) ou pra Lixeira (Gmail) —
//               recuperável, nunca delete permanente — e registra em
//               `marketing_kills`, que desde 11/set diz também QUAL ROBÔ moveu e
//               PARA ONDE (`robot`/`moved_to`): a mesma tabela é o rastro dos três
//               robôs que MOVEM e-mail, com o spam-sweep e o marketing-sweep. O
//               inbox-zero, que apaga DE VEZ, não escreve nela — ausência de linha
//               não é prova de que ninguém encostou (ver `registrarFaxina`).
// Travou      → NÃO apaga: incrementa `blocked` e deixa o e-mail onde está, pro humano.
//               Remetente que bloqueia demais é sinal de que não devia estar na lista.
//
// TRAVA ÚNICA NOS DOIS RAMOS (Márcio, 11/set/2026: "entra"). O `barrado()` de
// `lib/mailProtected.server.ts` roda colado no move tanto no Outlook quanto no
// Gmail. Até 11/set só o Outlook chamava, e este era o ÚNICO robô que apagava sem
// a trava — despachante, advogado, VIP e pedido de assinatura estavam protegidos
// nas caixas Microsoft e desprotegidos nas duas caixas Google. Sobra uma
// assimetria CONHECIDA entre os ramos: o Outlook trava conversa por In-Reply-To
// OU References e o Gmail só por In-Reply-To. Fechá-la é aperto novo, sem medida
// de quanta mensagem carrega References sem In-Reply-To, e não estava no que ele
// aprovou — fica como está até ele decidir.
//
// EXCEÇÃO POR REMETENTE — `hard_stop_waived_at` (10/set/2026). Ordem do Márcio:
// "apague a HPVida sempre". contato@pagoufacil.com.br manda "Sua fatura Hapvida está
// pendente!" sem contrato, valor nem vencimento — cobrança suspeita. Como "fatura" e
// "boleto" são marcadores transacionais, o remetente vivia travado (8.296 bloqueios em
// 10/set) e o e-mail ficava parado na caixa. Preencher é decisão dele, linha a linha —
// nunca por volume.
//
// 11/set/2026 — A EXCEÇÃO PASSA A DERRUBAR TAMBÉM A TRAVA DE ANEXO. Ordem dele:
// "HP Vida é coisa do BR, a Chris paga por lá, não estamos registrando isso ainda,
// apague sempre os emails" · "Apagar sempre, automático". Quem obriga a mudança é
// boleto.notredamesp@hapvida.com.br: o boleto vem COM ANEXO nas 8 de 8 mensagens
// medidas em 11/set, e a trava de anexo o prenderia para sempre — a ordem "apagar
// sempre" viraria "bloquear sempre". Esse endereço e mais dois
// (comunicacao@contato.hapvidandi.com.br e ccg@contato.comunicacaoccg.com.br) só
// entram na lista pela MIGRATION_hapvida_apaga_sempre.sql, que é passo de gente e
// pode não ter rodado ainda.
//
// ESTE CÓDIGO, SOZINHO, JÁ MUDA COMPORTAMENTO NO DEPLOY — não espera a migration.
// contato@pagoufacil.com.br está dispensado desde 10/set 17:03 (Orlando). Medido em
// 11/set 21:25 (Orlando, leitura direta da tabela): depois da dispensa de PALAVRA o
// `blocked` dele ainda andou de 8.296 para 8.308, com last_blocked_subject "HAPVIDA:
// atenção ao vencimento do seu boleto hoje!". Com a palavra já dispensada, esses 12
// bloqueios só podem ser ANEXO, conversa ou move que falhou — e boleto com PDF é a
// explicação óbvia. Ou seja: no minuto em que isto subir, e-mail dele com anexo que
// hoje fica parado na caixa passa a ir sozinho para os Itens Excluídos. É o que ele
// pediu, mas começa ANTES do SQL, e desfazer isso não é apagar as três linhas da
// migration: é zerar o `hard_stop_waived_at` do pagoufacil.
//
// QUEM NÃO CEDE — E NÃO É IGUAL NOS DOIS RAMOS:
//   • Outlook (Graph): remetente protegido (barrado, lib/mailProtected.server.ts) e
//     conversa, lendo In-Reply-To E References nos cabeçalhos. Três travas de pé.
//   • Gmail: remetente protegido (barrado) TAMBÉM — entrou em 11/set, no mesmo
//     pacote (ver TRAVA ÚNICA lá em cima) — e conversa só por In-Reply-To:
//     `References` não é pedido nos metadataHeaders. Duas travas de pé, não três.
//     Essa última assimetria fica de pé de propósito: fechá-la é aperto novo, sem
//     medida, e hoje não há exposição viva (as mensagens da Hapvida estão todas na
//     caixa 2, que é Graph) — mas a próxima linha que ele mandar dispensar pode ser
//     de caixa Google.
// Gente continua intocável pelo motivo mais simples do mundo, e não por proteção
// especial: lucas.sena@hapvida.com.br NÃO está em marketing_senders, e o robô só
// toca em quem está na lista.

import type { SupabaseClient } from '@supabase/supabase-js'
import { mailProvider, maySweep, listGmailIds, registrarFaxina } from '@/lib/streamMail.server'
import { barrado } from './mailProtected.server'

const G = 'https://graph.microsoft.com/v1.0'

// Marcadores que não aparecem em publicidade pura e aparecem em tudo que é real.
//
// FRONTEIRA DE PALAVRA É OBRIGATÓRIA AQUI (26/ago/2026). Sem ela a trava morde
// o MEIO das palavras, e numa oficina isso desarma o matador inteiro:
//   signed   → rede·SIGNED, de·SIGNED        charged → super·CHARGED, turbo·CHARGED
//   suspens  → SUSPENS·ion, SUSPENS·ão
// Ou seja: toda propaganda de supercharger, suspensão ou peça "redesigned" ficava
// imune — justo o marketing que mais chega aqui. Foi assim que o radiumauto
// ("Redesigned Universal Coolant Expansion Tank") acumulou 1.158 bloqueios: o
// mesmo e-mail reencontrado e re-travado a cada passada de 5 minutos.
// `suspens` virou alvo estreito ("suspended"/"conta suspensa"), porque suspensão
// é PEÇA no nosso vocabulário, não sinal de conta bloqueada.
// +nº de pedido com hífen (111-9605878-5792209), que escapava da trava numérica.
const HARD_STOP = /#\s?\d{4,}|\bPO-\d|1Z[0-9A-Z]{10,}|\b\d{10,22}\b|\b\d{3}-\d{7}-\d{7}\b|\baprovad|\bapproved\b|\bcharged\b|\bsuspended\b|conta suspensa|account suspension|cancel|c[oó]digo|verification code|senha|password|2fa|refund|estorno|reembolso|invoice|fatura|boleto|nota fiscal|contrato|\bassinad|\bsignature\b|\bsigned\b|candidat|vaga de|check-?in|reserva confirmada|itiner|shipped|entregue|delivered|tracking|rastreio/i

// OS DOIS FREIOS (11/set/2026), que vieram junto com a leitura da pasta inteira.
// LISTAR ficou completo e é barato; AGIR é que custa — cada mensagem de remetente
// listado gasta um GET de cabeçalho, um move e uma escrita no banco.
//
// TOCADAS_MAX é POR PASTA, não por rodada: 120 mensagens de remetente listado em cada
// pasta de cada caixa. Ele é o dobro do alcance antigo (60) e segura o caso do
// remetente que trava sempre (o pagoufacil acumulou 8.296 bloqueios reencontrando os
// mesmos e-mails), mas NÃO segura o relógio: medido em stream_mail_auth em 11/set são
// 5 caixas em faxina — 3 Outlook × 2 pastas + 2 Gmail = 8 unidades de varredura —, e
// 8 × 120 autoriza 960 mensagens tocadas numa rodada, muito mais do que cabe em 60s.
// Quem segura o relógio é o freio de baixo.
//
// ORCAMENTO_MS é o freio DA RODADA. O cron roda de 5 em 5 minutos com maxDuration 60s
// (app/api/cron/marketing-kill/route.ts) e a Vercel corta a função no meio se passar —
// inclusive no meio de um move. 45s deixa folga para a mensagem em curso (3 chamadas)
// e para a resposta. Estourou, a rodada para LIMPA, diz no log quais caixas ficaram de
// fora, e o que sobrou cai na rodada seguinte, cinco minutos depois.
const TOCADAS_MAX = 120
const ORCAMENTO_MS = 45_000

// auto_sweep é OBRIGATÓRIO no tipo de propósito: se alguém trocar o select('*')
// por uma lista de colunas e esquecer dele, o tsc quebra em vez de o robô voltar
// a varrer caixa proibida em silêncio.
type Auth = { id: number; account: string; client_id: string; refresh_token: string; auto_sweep: boolean | null }
type Row = { email: string; hits?: number; blocked?: number; hard_stop_waived_at?: string | null }

async function msToken(db: SupabaseClient, a: Auth): Promise<string | null> {
  const tk = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: a.client_id, grant_type: 'refresh_token', refresh_token: a.refresh_token, scope: 'offline_access Mail.ReadWrite Mail.Send' }),
  }).then(r => r.json()).catch(() => null)
  if (!tk?.access_token) return null
  if (tk.refresh_token && tk.refresh_token !== a.refresh_token) await db.from('stream_mail_auth').update({ refresh_token: tk.refresh_token }).eq('id', a.id)
  return tk.access_token
}

async function gmailToken(a: Auth): Promise<string | null> {
  const cid = process.env.GOOGLE_CLIENT_ID, cs = process.env.GOOGLE_CLIENT_SECRET
  if (!cid || !cs) return null
  const tk = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: cs, grant_type: 'refresh_token', refresh_token: a.refresh_token }),
  }).then(r => r.json()).catch(() => null)
  return tk?.access_token || null
}

export async function runMarketingKill(db: SupabaseClient): Promise<{ killed: string[]; blocked: string[] }> {
  const killed: string[] = [], blocked: string[] = []
  // O relógio da rodada — ver ORCAMENTO_MS lá em cima. Medido antes de cada caixa,
  // de cada pasta e de cada mensagem, que são os três lugares onde dá para parar sem
  // deixar trabalho pela metade.
  const t0 = Date.now()
  const semTempo = () => Date.now() - t0 > ORCAMENTO_MS
  const { data: senders } = await db.from('marketing_senders').select('*').eq('active', true)
  if (!senders?.length) return { killed, blocked }
  const listed = new Map<string, Row>((senders as Row[]).map(s => [String(s.email).toLowerCase(), s]))
  // A exceção por remetente do topo do arquivo, num lugar só: quem tem
  // `hard_stop_waived_at` é "apagar sempre", e só aquele endereço exato.
  const dispensado = (addr: string) => !!listed.get(addr)?.hard_stop_waived_at
  // A trava de PALAVRA: para o dispensado, palavra transacional não trava.
  const palavraTrava = (addr: string, ...textos: string[]) =>
    !dispensado(addr) && textos.some(t => HARD_STOP.test(t))
  // A trava de ANEXO, que cede desde 11/set/2026 pelo mesmo motivo: o boleto da
  // Notredame vem com PDF em 8 de 8, e sem isto "apagar sempre" virava bloquear
  // sempre. Para quem NÃO é dispensado, anexo continua barrando — é ele que separa
  // a propaganda do documento de verdade.
  // ISTO MORDE NO DEPLOY, não quando a migration rodar: contato@pagoufacil.com.br já
  // está dispensado desde 10/set e seus e-mails com anexo — hoje só bloqueados —
  // passam a ir para os Itens Excluídos na primeira rodada depois da subida. Ver o
  // cabeçalho do arquivo, com a medida.
  const anexoTrava = (addr: string, temAnexo: boolean) => temAnexo && !dispensado(addr)

  // `destino` entrou em 11/set: a mesma tabela passou a registrar os três robôs
  // que MOVEM (aqui, spam-sweep e marketing-sweep), e cada provedor manda pra um
  // lugar — Itens Excluídos no Outlook, Lixeira no Gmail. Quem escreve a linha é o
  // `registrarFaxina` de streamMail.server.ts, pra tabela ter um escritor só.
  const kill = async (account: string, addr: string, subj: string, folder: string, destino: string) => {
    const row = listed.get(addr)!
    killed.push(`${account} · ${addr} — ${subj.slice(0, 50)}`)
    await registrarFaxina(db, 'marketing-kill', account, { sender: addr, subject: subj, folder, movedTo: destino })
    row.hits = (row.hits || 0) + 1
    await db.from('marketing_senders').update({ hits: row.hits, last_hit: new Date().toISOString(), last_subject: subj.slice(0, 200) }).eq('email', addr)
  }
  const block = async (account: string, addr: string, subj: string) => {
    const row = listed.get(addr)!
    blocked.push(`${account} · ${addr} — ${subj.slice(0, 50)}`)
    row.blocked = (row.blocked || 0) + 1
    await db.from('marketing_senders').update({ blocked: row.blocked, last_blocked_subject: subj.slice(0, 200) }).eq('email', addr)
  }

  const { data: auths } = await db.from('stream_mail_auth').select('*')
  const fila = ((auths || []) as Auth[]).filter(a => a.refresh_token && maySweep(a)) // caixa de arquivo não se limpa sozinha
  // A ORDEM DAS CAIXAS GIRA A CADA RODADA (11/set/2026). O PostgREST devolve
  // stream_mail_auth na ordem física da tabela — medida em 11/set: galpaoz28,
  // gz28us@gmail, gz28speedshop, gz28br, gz28shopping, gz28us@hotmail —, e
  // gz28us@hotmail.com, a segunda que mais mata, cai SEMPRE em último. Varrendo
  // sempre na mesma ordem, quem perde quando o orçamento estoura é sempre a mesma
  // caixa, calada, rodada após rodada. O giro é o relógio e nada mais: a cada fatia de
  // 5 minutos (o passo do cron) a fila começa numa caixa diferente, sem estado no
  // banco, então nenhuma caixa é a última duas rodadas seguidas.
  const giro = fila.length ? Math.floor(Date.now() / 300_000) % fila.length : 0
  const ordem = [...fila.slice(giro), ...fila.slice(0, giro)]
  for (let i = 0; i < ordem.length; i++) {
    const a = ordem[i]
    if (semTempo()) { console.warn(`[marketing-kill] ${ORCAMENTO_MS / 1000}s: rodada encerrada; ficaram sem varredura ${ordem.slice(i).map(x => x.account).join(', ')}`); break }
    // ── Outlook (caixas Microsoft): caixa de entrada + lixo eletrônico ───────
    // Provedor pela LINHA (mailProvider), não pelo domínio da conta (04/set/2026).
    if (mailProvider(a) === 'graph') {
      const token = await msToken(db, a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      for (const folder of ['inbox', 'junkemail']) {
        if (semTempo()) { console.warn(`[marketing-kill] tempo: ${a.account}/${folder} não foi varrida nesta rodada`); break }
        // A PASTA INTEIRA, PÁGINA POR PÁGINA (11/set/2026). Antes eram só as 60 mais
        // novas, e 60 é pouco para pasta que acumula: em 11/set o Lixo Eletrônico da
        // caixa 2 tinha 79 mensagens e as 5 do pagoufacil que faltavam estavam nas
        // posições 67–73 — fora do alcance. O `blocked` dele não subia desde 10/set,
        // e "não bloqueia" parecia "não tem", quando era "nunca chegou lá".
        //
        // JUNTA TODAS AS PÁGINAS ANTES DE MEXER EM UMA. O nextLink do Graph para
        // mensagens é $skip=N: mover um e-mail para os Itens Excluídos no meio da
        // varredura encurta a pasta e a página seguinte pula o mesmo tanto de
        // mensagens. Lendo primeiro e agindo depois, o pulo não existe.
        //
        // TETO: 10 páginas de 100 = 1.000 mensagens por pasta (3 caixas Outlook × 2
        // pastas = 6.000 no pior caso). É teto de tamanho, não de relógio — quem
        // segura o relógio é o ORCAMENTO_MS, conferido a cada página e antes de cada
        // mensagem. 1.000 é ~12× a maior pasta medida hoje (79); pasta maior que isso
        // é sinal de faxina atrasada, o log avisa e o resto cai na rodada seguinte.
        const PAGINAS_MAX = 10, POR_PAGINA = 100
        // `id` é OPCIONAL no tipo porque a resposta vem de x.json(), que é `any`:
        // escrever `id: string` seria promessa, não prova — ver a conferência lá
        // embaixo, antes de tocar na mensagem.
        type Stub = { id?: string; subject?: string; from?: { emailAddress?: { address?: string } }; hasAttachments?: boolean }
        const mensagens: Stub[] = []
        let falhou = false
        let proxima: string | null = `${G}/me/mailFolders/${folder}/messages?$top=${POR_PAGINA}&$select=id,subject,from,hasAttachments`
        for (let pagina = 0; proxima && pagina < PAGINAS_MAX && !semTempo(); pagina++) {
          // O tipo da resposta é escrito à mão porque `proxima` sai de dentro dela:
          // sem isto o tsc acusa o laço de se definir em cima de si mesmo (TS7022).
          const r: { value?: Stub[]; '@odata.nextLink'?: string } | null =
            await fetch(proxima, { headers: H }).then(x => x.json()).catch(() => null)
          if (!r?.value) {
            // PARADA COM RECIBO (11/set/2026). Throttling do Graph (429), token
            // vencido no meio da paginação ou resposta fora do formato param a
            // varredura desta pasta. Calado, isso é exatamente o veneno que esta
            // fatia existe para matar: pasta que parou na página 1 fica igual a
            // pasta lida inteira, e "não bloqueia" volta a parecer "não tem".
            console.warn(`[marketing-kill] ${a.account}/${folder}: listagem parou na página ${pagina + 1}; a pasta NÃO foi lida inteira nesta rodada`)
            falhou = true
            break
          }
          mensagens.push(...r.value)
          proxima = typeof r['@odata.nextLink'] === 'string' ? r['@odata.nextLink'] : null
        }
        // Sobrou pasta para trás? Diga por quê — cada motivo tem conserto diferente.
        if (!falhou && proxima) console.warn(`[marketing-kill] ${a.account}/${folder}: leitura incompleta (${mensagens.length} lidas) por ${semTempo() ? 'tempo da rodada' : `teto de ${PAGINAS_MAX} páginas`}; o resto fica para a rodada seguinte`)
        // O SEGUNDO TETO — TOCADAS_MAX, lá em cima: ler a pasta inteira é barato,
        // agir é que custa. E o freio da rodada (ORCAMENTO_MS) responde antes dele,
        // porque a mensagem que começa aos 59s termina cortada pela Vercel.
        let tocadas = 0
        for (const m of mensagens) {
          const addr = String(m.from?.emailAddress?.address || '').toLowerCase()
          if (!listed.has(addr)) continue
          // O id vem de x.json(), que é `any`. Sem esta conferência, item sem id
          // viraria a string "undefined" na URL do move: o move dá 404, a mensagem
          // entra como BLOQUEADA e engorda justo o contador que a gente lê como
          // "remetente que não devia estar na lista". Some do diagnóstico, não da caixa.
          const id = typeof m.id === 'string' ? m.id : ''
          if (!id) { console.warn(`[marketing-kill] ${a.account}/${folder}: item de ${addr} veio sem id na listagem; pulado`); continue }
          if (semTempo()) { console.warn(`[marketing-kill] ${a.account}/${folder}: tempo da rodada estourou depois de ${tocadas} tocadas; a cauda cai na rodada seguinte`); break }
          if (++tocadas > TOCADAS_MAX) { console.warn(`[marketing-kill] ${a.account}/${folder}: teto de ${TOCADAS_MAX} tocadas atingido; ficou cauda de remetente listado nesta pasta`); break }
          const subj = String(m.subject || '')
          if (anexoTrava(addr, !!m.hasAttachments) || palavraTrava(addr, subj)) { await block(a.account, addr, subj); continue }
          // Este robô só toca em remetente AUDITADO, mas auditoria é humana e
          // humano erra: a trava única responde antes de qualquer move.
          if (await barrado(db, 'marketing-kill', a.id ?? null, a.account, { id, subject: subj, from: addr, folder })) { await block(a.account, addr, subj); continue }
          const hd = await fetch(`${G}/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders,bodyPreview`, { headers: H }).then(x => x.json()).catch(() => null)
          const heads: { name?: string }[] = hd?.internetMessageHeaders || []
          const inReply = heads.some(x => /^(in-reply-to|references)$/i.test(String(x.name)))
          if (inReply || palavraTrava(addr, String(hd?.bodyPreview || ''))) { await block(a.account, addr, subj); continue }
          const mv = await fetch(`${G}/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: 'deleteditems' }) })
          if (mv.ok) await kill(a.account, addr, subj, folder, 'deleteditems')
          else await block(a.account, addr, subj)
        }
      }
      continue
    }
    // ── Gmail (qualquer caixa Google) ───────────────────────────────────────
    {
      const token = await gmailToken(a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      const q = 'in:inbox (' + [...listed.keys()].map(e => 'from:' + e).join(' OR ') + ')'
      // Página por página (10/set/2026) — ver listGmailIds: página curta não é fim de lista.
      // MESMO TETO DO OUTLOOK (11/set/2026): eram 50, e 50 é a mesma armadilha das 60 do
      // Graph — o que passa disso nunca era visto. Aqui, ao contrário do Graph, a busca
      // já vem filtrada por `from:` da nossa lista: TODO id listado é id em que se vai
      // mexer, então pedir mais do que o teto de ação é pagar listagem para jogar fora.
      // Por isso a lista pede exatamente TOCADAS_MAX, numa página só — e o
      // `nextPageToken` que voltar é o recibo de que ficou cauda para a próxima rodada.
      const list = await listGmailIds(token, { q, max: TOCADAS_MAX, maxPages: 1 })
      // Lista incompleta com recibo, igual ao vizinho fetchRecentGmail: sem isto, erro
      // do Gmail no meio da listagem some, e o robô devolve ok:true dizendo que varreu.
      if (list.error) console.error(`[marketing-kill] ${a.account}: lista incompleta —`, list.error)
      if (list.nextPageToken) console.warn(`[marketing-kill] ${a.account}: mais de ${TOCADAS_MAX} mensagens de remetente listado na caixa de entrada; a cauda cai na rodada seguinte`)
      let tocadas = 0
      for (const it of list.ids) {
        if (semTempo()) { console.warn(`[marketing-kill] ${a.account}: tempo da rodada estourou depois de ${tocadas} tocadas`); break }
        // Cinto: a lista já vem no teto, mas o teto de AÇÃO mora aqui, do lado do move.
        if (++tocadas > TOCADAS_MAX) break
        const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=In-Reply-To`, { headers: H }).then(x => x.json()).catch(() => null)
        const heads: { name: string; value: string }[] = msg?.payload?.headers || []
        const hv = (n: string) => String((heads.find(h => h.name.toLowerCase() === n) || { value: '' }).value || '')
        const addr = (hv('from').match(/<([^>]+)>/) || [null, hv('from')])[1].toLowerCase()
        if (!listed.has(addr)) continue
        const subj = hv('subject')
        const hasAtt = /"filename":"[^"]+"/.test(JSON.stringify(msg?.payload?.parts || []))
        // AS DUAS TRAVAS DO GMAIL, juntas (11/set/2026 — as duas fatias do pacote
        // caíram neste mesmo ponto). A primeira linha é a peneira de conteúdo:
        // conversa (In-Reply-To), ANEXO — e `anexoTrava` é onde a exceção por
        // remetente dispensa o anexo, que é o que deixa o boleto da Hapvida ser
        // apagado — e palavra proibida no assunto ou no trecho.
        if (hv('in-reply-to') || anexoTrava(addr, hasAtt) || palavraTrava(addr, subj, String(msg?.snippet || ''))) { await block(a.account, addr, subj); continue }
        // A segunda é a TRAVA ÚNICA (Márcio, 11/set: "entra"). Este era o ÚNICO robô
        // que apagava sem chamar `barrado()` — o ramo Outlook logo acima chama desde
        // 08/set, e spam-sweep, marketing-sweep e inbox-zero também. Fica COLADA no
        // trash, como manda lib/mailProtected.ts: é a checagem junto da ação que
        // sobrevive a refatoração. Barrou → conta como travado (o remetente ganha
        // `blocked`, igual ao Outlook) e o e-mail fica onde está.
        if (await barrado(db, 'marketing-kill', a.id ?? null, a.account, { id: it.id, subject: subj, from: addr, folder: 'INBOX' })) { await block(a.account, addr, subj); continue }
        const t = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}/trash`, { method: 'POST', headers: H })
        if (t.ok) await kill(a.account, addr, subj, 'INBOX', 'trash')
        else await block(a.account, addr, subj)
      }
    }
  }
  return { killed, blocked }
}
