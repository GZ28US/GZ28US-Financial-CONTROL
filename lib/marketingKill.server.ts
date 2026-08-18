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
//   2. E a mensagem tem de passar em 3 travas de conteúdo — sem anexo, com
//      List-Unsubscribe, sem estar dentro de conversa (In-Reply-To/References) e sem
//      NENHUM marcador transacional (nº de pedido/rastreio, valor aprovado, código,
//      cancelamento, candidatura, reserva…).
// Bateu tudo  → move pra Itens Excluídos (recuperável; nunca delete permanente) e
//               registra em `marketing_kills`.
// Travou      → NÃO apaga: incrementa `blocked` e deixa o e-mail onde está, pro humano.
//               Remetente que bloqueia demais é sinal de que não devia estar na lista.

import type { SupabaseClient } from '@supabase/supabase-js'

const G = 'https://graph.microsoft.com/v1.0'

// Marcadores que não aparecem em publicidade pura e aparecem em tudo que é real.
const HARD_STOP = /#\s?\d{4,}|\bPO-\d|1Z[0-9A-Z]{10,}|\b\d{10,22}\b|aprovad|approved|charged|suspens|cancel|c[oó]digo|verification code|senha|password|2fa|refund|estorno|reembolso|invoice|fatura|boleto|nota fiscal|contrato|assinad|signature|signed|candidat|vaga de|check-?in|reserva confirmada|itiner|shipped|entregue|delivered|tracking|rastreio/i

type Auth = { id: number; account: string; client_id: string; refresh_token: string }
type Row = { email: string; hits?: number; blocked?: number }

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
    // ── Outlook (slots 1-3): caixa de entrada + lixo eletrônico ──────────────
    if (/hotmail\.com$/i.test(a.account)) {
      const token = await msToken(db, a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      for (const folder of ['inbox', 'junkemail']) {
        const r = await fetch(`${G}/me/mailFolders/${folder}/messages?$top=60&$select=id,subject,from,hasAttachments`, { headers: H }).then(x => x.json()).catch(() => null)
        for (const m of r?.value || []) {
          const addr = String(m.from?.emailAddress?.address || '').toLowerCase()
          if (!listed.has(addr)) continue
          const subj = String(m.subject || '')
          if (m.hasAttachments || HARD_STOP.test(subj)) { await block(a.account, addr, subj); continue }
          const hd = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders,bodyPreview`, { headers: H }).then(x => x.json()).catch(() => null)
          const heads: { name?: string }[] = hd?.internetMessageHeaders || []
          const unsub = heads.some(x => /^list-unsubscribe$/i.test(String(x.name)))
          const inReply = heads.some(x => /^(in-reply-to|references)$/i.test(String(x.name)))
          if (!unsub || inReply || HARD_STOP.test(String(hd?.bodyPreview || ''))) { await block(a.account, addr, subj); continue }
          const mv = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: 'deleteditems' }) })
          if (mv.ok) await kill(a.account, addr, subj, folder)
          else await block(a.account, addr, subj)
        }
      }
      continue
    }
    // ── Gmail (slot 4) ──────────────────────────────────────────────────────
    if (/gmail\.com$/i.test(a.account)) {
      const token = await gmailToken(a)
      if (!token) continue
      const H = { Authorization: `Bearer ${token}` }
      const q = 'in:inbox (' + [...listed.keys()].map(e => 'from:' + e).join(' OR ') + ')'
      const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`, { headers: H }).then(x => x.json()).catch(() => null)
      for (const it of list?.messages || []) {
        const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=In-Reply-To`, { headers: H }).then(x => x.json()).catch(() => null)
        const heads: { name: string; value: string }[] = msg?.payload?.headers || []
        const hv = (n: string) => String((heads.find(h => h.name.toLowerCase() === n) || { value: '' }).value || '')
        const addr = (hv('from').match(/<([^>]+)>/) || [null, hv('from')])[1].toLowerCase()
        if (!listed.has(addr)) continue
        const subj = hv('subject')
        const hasAtt = /"filename":"[^"]+"/.test(JSON.stringify(msg?.payload?.parts || []))
        if (!hv('list-unsubscribe') || hv('in-reply-to') || hasAtt || HARD_STOP.test(subj) || HARD_STOP.test(String(msg?.snippet || ''))) { await block(a.account, addr, subj); continue }
        const t = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${it.id}/trash`, { method: 'POST', headers: H })
        if (t.ok) await kill(a.account, addr, subj, 'INBOX')
        else await block(a.account, addr, subj)
      }
    }
  }
  return { killed, blocked }
}
