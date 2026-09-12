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
// pendente!" sem contrato, valor nem vencimento — cobrança suspeita; os boletos de
// verdade vêm de @hapvida.com.br, que NÃO está na lista. Como "fatura" e "boleto" são
// marcadores transacionais, o remetente vivia travado (8.296 bloqueios em 10/set) e o
// e-mail ficava parado na caixa. Com a coluna preenchida, SÓ a trava de PALAVRA deixa
// de valer para aquele endereço exato; anexo, conversa (In-Reply-To/References) e
// remetente protegido continuam barrando. Preencher é decisão dele, linha a linha —
// nunca por volume.

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
  // A trava de PALAVRA, com a exceção por remetente do topo do arquivo: para quem tem
  // `hard_stop_waived_at`, e só para aquele endereço, palavra transacional não trava.
  const palavraTrava = (addr: string, ...textos: string[]) =>
    !listed.get(addr)?.hard_stop_waived_at && textos.some(t => HARD_STOP.test(t))

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
  for (const a of (auths || []) as Auth[]) {
    if (!a.refresh_token || !maySweep(a)) continue // caixa de arquivo não se limpa sozinha
    // ── Outlook (caixas Microsoft): caixa de entrada + lixo eletrônico ───────
    // Provedor pela LINHA (mailProvider), não pelo domínio da conta (04/set/2026).
    if (mailProvider(a) === 'graph') {
      const token = await msToken(db, a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      for (const folder of ['inbox', 'junkemail']) {
        const r = await fetch(`${G}/me/mailFolders/${folder}/messages?$top=60&$select=id,subject,from,hasAttachments`, { headers: H }).then(x => x.json()).catch(() => null)
        for (const m of r?.value || []) {
          const addr = String(m.from?.emailAddress?.address || '').toLowerCase()
          if (!listed.has(addr)) continue
          const subj = String(m.subject || '')
          if (m.hasAttachments || palavraTrava(addr, subj)) { await block(a.account, addr, subj); continue }
          // Este robô só toca em remetente AUDITADO, mas auditoria é humana e
          // humano erra: a trava única responde antes de qualquer move.
          if (await barrado(db, 'marketing-kill', a.id ?? null, a.account, { id: m.id, subject: subj, from: addr, folder })) { await block(a.account, addr, subj); continue }
          const hd = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders,bodyPreview`, { headers: H }).then(x => x.json()).catch(() => null)
          const heads: { name?: string }[] = hd?.internetMessageHeaders || []
          const inReply = heads.some(x => /^(in-reply-to|references)$/i.test(String(x.name)))
          if (inReply || palavraTrava(addr, String(hd?.bodyPreview || ''))) { await block(a.account, addr, subj); continue }
          const mv = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: 'deleteditems' }) })
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
      const list = await listGmailIds(token, { q, max: 50 })
      for (const it of list.ids) {
        const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=In-Reply-To`, { headers: H }).then(x => x.json()).catch(() => null)
        const heads: { name: string; value: string }[] = msg?.payload?.headers || []
        const hv = (n: string) => String((heads.find(h => h.name.toLowerCase() === n) || { value: '' }).value || '')
        const addr = (hv('from').match(/<([^>]+)>/) || [null, hv('from')])[1].toLowerCase()
        if (!listed.has(addr)) continue
        const subj = hv('subject')
        const hasAtt = /"filename":"[^"]+"/.test(JSON.stringify(msg?.payload?.parts || []))
        if (hv('in-reply-to') || hasAtt || palavraTrava(addr, subj, String(msg?.snippet || ''))) { await block(a.account, addr, subj); continue }
        // TRAVA ÚNICA TAMBÉM NO GMAIL (Márcio, 11/set: "entra"). Este era o ÚNICO
        // robô que apagava sem chamar `barrado()` — o ramo Outlook logo acima
        // chama desde 08/set, e spam-sweep, marketing-sweep e inbox-zero também.
        // Fica COLADA no trash, como manda lib/mailProtected.ts: é a checagem
        // junto da ação que sobrevive a refatoração. Barrou → conta como travado
        // (o remetente ganha `blocked`, igual ao Outlook) e o e-mail fica onde está.
        if (await barrado(db, 'marketing-kill', a.id ?? null, a.account, { id: it.id, subject: subj, from: addr, folder: 'INBOX' })) { await block(a.account, addr, subj); continue }
        const t = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}/trash`, { method: 'POST', headers: H })
        if (t.ok) await kill(a.account, addr, subj, 'INBOX', 'trash')
        else await block(a.account, addr, subj)
      }
    }
  }
  return { killed, blocked }
}
