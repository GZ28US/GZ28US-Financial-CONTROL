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
// Bateu tudo  → move pra Itens Excluídos (recuperável; nunca delete permanente) e
//               registra em `marketing_kills`.
// Travou      → NÃO apaga: incrementa `blocked` e deixa o e-mail onde está, pro humano.
//               Remetente que bloqueia demais é sinal de que não devia estar na lista.
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
// apague sempre os emails" · "Apagar sempre, automático". Entraram na lista, com a
// exceção preenchida, os três automáticos que faltavam (MIGRATION_hapvida_apaga_sempre):
// comunicacao@contato.hapvidandi.com.br, ccg@contato.comunicacaoccg.com.br e
// boleto.notredamesp@hapvida.com.br. É esse último que obriga a mudança: o boleto vem
// COM ANEXO nas 8 de 8 mensagens medidas em 11/set, e a trava de anexo o prenderia
// para sempre — a ordem "apagar sempre" viraria "bloquear sempre".
// Quem NÃO cede: conversa (In-Reply-To/References) e remetente protegido
// (lib/mailProtected.ts). Gente continua intocável — lucas.sena@hapvida.com.br, que é
// pessoa de verdade, não está e não entra na lista.

import type { SupabaseClient } from '@supabase/supabase-js'
import { mailProvider, maySweep, listGmailIds } from '@/lib/streamMail.server'
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

// TETO DE AÇÃO POR PASTA (11/set/2026), o freio que veio junto com a leitura da pasta
// inteira: LISTAR ficou completo e é barato (10 GETs), mas AGIR custa — cada mensagem
// de remetente listado gasta um GET de cabeçalho, um move e escrita no banco. Este cron
// roda de 5 em 5 minutos com maxDuration 60s; sem freio, uma pasta entupida mata a
// rodada no meio. 120 por pasta é o dobro do que o robô alcançava antes (60) e segura
// o caso do remetente que trava sempre — o pagoufacil acumulou 8.296 bloqueios
// reencontrando os mesmos e-mails. O que passar do teto cai na rodada seguinte.
const TOCADAS_MAX = 120

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
  const anexoTrava = (addr: string, temAnexo: boolean) => temAnexo && !dispensado(addr)

  const kill = async (account: string, addr: string, subj: string, folder: string) => {
    const row = listed.get(addr)!
    killed.push(`${account} · ${addr} — ${subj.slice(0, 50)}`)
    await db.from('marketing_kills').insert({ account, sender: addr, subject: subj.slice(0, 200), folder })
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
  for (const a of (auths || []) as Auth[]) {
    if (!a.refresh_token || !maySweep(a)) continue // caixa de arquivo não se limpa sozinha
    // ── Outlook (caixas Microsoft): caixa de entrada + lixo eletrônico ───────
    // Provedor pela LINHA (mailProvider), não pelo domínio da conta (04/set/2026).
    if (mailProvider(a) === 'graph') {
      const token = await msToken(db, a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      for (const folder of ['inbox', 'junkemail']) {
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
        // pastas = 6.000 no pior caso). O teto é por causa do relógio, não do Graph:
        // este cron roda de 5 em 5 minutos com maxDuration 60s, e listagem que não
        // acaba come o orçamento inteiro e mata a rodada no meio. 1.000 é ~12× a
        // maior pasta medida hoje (79); pasta maior que isso é sinal de faxina
        // atrasada, e o que sobrar cai na rodada seguinte.
        const PAGINAS_MAX = 10, POR_PAGINA = 100
        type Stub = { id: string; subject?: string; from?: { emailAddress?: { address?: string } }; hasAttachments?: boolean }
        const mensagens: Stub[] = []
        let proxima: string | null = `${G}/me/mailFolders/${folder}/messages?$top=${POR_PAGINA}&$select=id,subject,from,hasAttachments`
        for (let pagina = 0; proxima && pagina < PAGINAS_MAX; pagina++) {
          // O tipo da resposta é escrito à mão porque `proxima` sai de dentro dela:
          // sem isto o tsc acusa o laço de se definir em cima de si mesmo (TS7022).
          const r: { value?: Stub[]; '@odata.nextLink'?: string } | null =
            await fetch(proxima, { headers: H }).then(x => x.json()).catch(() => null)
          if (!r?.value) break // erro ou pasta que não existe nesta caixa: não insiste
          mensagens.push(...r.value)
          proxima = typeof r['@odata.nextLink'] === 'string' ? r['@odata.nextLink'] : null
        }
        // O SEGUNDO TETO — TOCADAS_MAX, lá em cima: ler a pasta inteira é barato,
        // agir é que custa.
        let tocadas = 0
        for (const m of mensagens) {
          const addr = String(m.from?.emailAddress?.address || '').toLowerCase()
          if (!listed.has(addr)) continue
          if (++tocadas > TOCADAS_MAX) break
          const subj = String(m.subject || '')
          if (anexoTrava(addr, !!m.hasAttachments) || palavraTrava(addr, subj)) { await block(a.account, addr, subj); continue }
          // Este robô só toca em remetente AUDITADO, mas auditoria é humana e
          // humano erra: a trava única responde antes de qualquer move.
          if (await barrado(db, 'marketing-kill', a.id ?? null, a.account, { id: m.id, subject: subj, from: addr, folder })) { await block(a.account, addr, subj); continue }
          const hd = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders,bodyPreview`, { headers: H }).then(x => x.json()).catch(() => null)
          const heads: { name?: string }[] = hd?.internetMessageHeaders || []
          const inReply = heads.some(x => /^(in-reply-to|references)$/i.test(String(x.name)))
          if (inReply || palavraTrava(addr, String(hd?.bodyPreview || ''))) { await block(a.account, addr, subj); continue }
          const mv = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: 'deleteditems' }) })
          if (mv.ok) await kill(a.account, addr, subj, folder)
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
      // Graph — o que passa disso nunca é visto. Aqui a busca já vem filtrada pelos
      // remetentes da lista, então 1.000 é folga grande; o `max` e o `maxPages` existem
      // só para a rodada não correr atrás de pageToken sem fim dentro dos 60s do cron.
      const list = await listGmailIds(token, { q, max: 1000, maxPages: 10 })
      // O mesmo teto de AÇÃO do Outlook, pelo mesmo motivo (60s de cron). Aqui a lista
      // já vem só com remetente da nossa lista, então o teto conta direto.
      let tocadas = 0
      for (const it of list.ids) {
        if (++tocadas > TOCADAS_MAX) break
        const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=In-Reply-To`, { headers: H }).then(x => x.json()).catch(() => null)
        const heads: { name: string; value: string }[] = msg?.payload?.headers || []
        const hv = (n: string) => String((heads.find(h => h.name.toLowerCase() === n) || { value: '' }).value || '')
        const addr = (hv('from').match(/<([^>]+)>/) || [null, hv('from')])[1].toLowerCase()
        if (!listed.has(addr)) continue
        const subj = hv('subject')
        const hasAtt = /"filename":"[^"]+"/.test(JSON.stringify(msg?.payload?.parts || []))
        if (hv('in-reply-to') || anexoTrava(addr, hasAtt) || palavraTrava(addr, subj, String(msg?.snippet || ''))) { await block(a.account, addr, subj); continue }
        const t = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}/trash`, { method: 'POST', headers: H })
        if (t.ok) await kill(a.account, addr, subj, 'INBOX')
        else await block(a.account, addr, subj)
      }
    }
  }
  return { killed, blocked }
}
