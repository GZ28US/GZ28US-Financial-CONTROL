// SERVER-ONLY — INBOX ZERO NET (ordem do Márcio, 26/jul/2026): "minhas caixas de
// e-mail vazias é SEMPRE a 1ª prioridade, checar de 5 em 5 minutos, automatizado."
// Roda no mail-poll depois dos sweeps específicos (spam/marketing/apps/organizer):
// tudo que sobrar na caixa de entrada com mais de 15 min de idade ganha destino
// por regra; sem regra → pasta "TRIAGEM (Claudinha)" + report no grupo pedindo o
// destino (é assim que o app "pergunta em caso de dúvida" com o PC desligado).
// Cobre slot 1 (gz28us@hotmail), slot 2 (galpaoz28@hotmail) e slot 4 (Gmail).

import type { SupabaseClient } from '@supabase/supabase-js'

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}` })
const SIGNATURE = 'Sent by GZ28US Control App®'
const GRACE_MIN = 15

async function report(body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN, groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

async function msToken(db: SupabaseClient, account: string): Promise<string | null> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('account', account).limit(1)
  const auth = data?.[0]
  if (!auth?.refresh_token) return null
  const tk = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access' }),
  }).then(r => r.json()).catch(() => null)
  if (!tk?.access_token) return null
  if (tk.refresh_token && tk.refresh_token !== auth.refresh_token) {
    await db.from('stream_mail_auth').update({ refresh_token: tk.refresh_token }).eq('id', auth.id)
  }
  return tk.access_token
}

// Regras por conta: retorno = nome de pasta ('Pai/Filha' aponta subpasta), 'DELETE',
// 'KEEP' (fica na caixa de entrada, intocado), ou null (→ TRIAGEM).
// Mantidas alinhadas às decisões do Márcio de 26/jul.
// LEI (Márcio, 30/jul/2026, caso EchoSign/Progressive): pedido de ASSINATURA
// eletrônica NUNCA sai da caixa de entrada — ele precisa ver e assinar.
const ESIGN_FROM = /echosign|adobesign|docusign|hellosign|sign\.dropbox|pandadoc|esign@/i
const ESIGN_SUBJ = /signature requested|review and sign|aguarda(ndo)? sua assinatura|assinatura pendente/i
function ruleSlot1(subj: string, from: string): string | null {
  if (ESIGN_FROM.test(from) || ESIGN_SUBJ.test(subj)) return 'KEEP'
  if (/verification code|c[óo]digo de verifica/i.test(subj)) return 'DELETE'
  if (/united\.com|latam|delta\.com|aa\.com|copaair|voegol|azul/i.test(from)) return 'Businesses/Trips'
  if (/delivery attempted|out for delivery|delivered/i.test(subj)) return 'Shopping'
  if (/order (receipt|confirm)|receipt #|USD$/i.test(subj)) return 'Shopping'
  if (/sign.?in confirmation|new device|security alert/i.test(subj)) return 'Arquivo Morto'
  return null
}
function ruleSlot2(subj: string, from: string): string | null {
  if (ESIGN_FROM.test(from) || ESIGN_SUBJ.test(subj)) return 'KEEP'
  if (/pre.o do seu voo monitorado|Suas lembran.as desse dia|aniversari/i.test(subj)) return 'DELETE'
  if (/rockauto/i.test(from) || /sent a message about|sent a question about|Order to Ship|Order Confirmation|Inventory Update/i.test(subj)) return '01 - Compras'
  if (/aguarda sua assinatura|Assinatura Eletr.nica|NFS-e|Nota Fiscal|Boleto|DEPOSITO IDENTIFICADO|Compromisso Mensal|ADIANTAMENTO SALARIAL|Simples Nacional|Contrato Social/i.test(subj)) return 'Documentos'
  if (/Solicita..o de pe/i.test(subj)) return '05 - Orçamentos'
  if (/check-?in|sua reserva|seu voo|flight to/i.test(subj)) return '033 - Viagens'
  if (/Typhon|Typhoon|configura..es/i.test(subj)) return '02 - Tuning Files'
  return null
}

async function zeroGraph(db: SupabaseClient, account: string, rule: (s: string, f: string) => string | null, out: string[]): Promise<void> {
  const token = await msToken(db, account)
  if (!token) return
  const top = await fetch(`${G}/me/mailFolders?$top=200`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
  if (!top?.value) return
  // Mapa inclui as FILHAS como 'Pai/Filha' — regras podem apontar subpastas
  // (bug 27/jul: 'Trips' na verdade é 'Businesses/Trips' e o e-mail da United
  // ficou parado na inbox porque o lookup só via o nível de cima).
  const folders: Record<string, string> = {}
  for (const f of top.value) {
    folders[f.displayName] = f.id
    if (f.childFolderCount > 0) {
      const ch = await fetch(`${G}/me/mailFolders/${f.id}/childFolders?$top=100`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
      for (const c of ch?.value || []) folders[`${f.displayName}/${c.displayName}`] = c.id
    }
  }
  if (!folders['TRIAGEM (Claudinha)']) {
    const c = await fetch(`${G}/me/mailFolders`, { method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'TRIAGEM (Claudinha)' }) }).then(r => r.json())
    if (c?.id) folders['TRIAGEM (Claudinha)'] = c.id
  }
  // LIXO ELETRÔNICO TAMBÉM É VARRIDO (ordem do Márcio, 28/jul/2026: 'tem email
  // nas pastas de lixo eletrônico, também tem que ser vistos e processados').
  // O filtro da Microsoft erra e joga fornecedor, banco e cliente no junk — o que
  // cai lá e tem regra volta pro lugar certo; o resto vai pra TRIAGEM.
  const boxes = ['inbox', 'junkemail']
  const msgs: any[] = []
  for (const box of boxes) {
    const r = await fetch(`${G}/me/mailFolders/${box}/messages?$top=25&$select=id,subject,from,receivedDateTime`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    for (const m of r?.value || []) msgs.push(m)
  }
  const cutoff = Date.now() - GRACE_MIN * 60_000
  const triaged: string[] = []
  for (const m of msgs) {
    if (new Date(m.receivedDateTime).getTime() > cutoff) continue // recente demais — outros sweeps ainda vão agir
    const dest = rule(String(m.subject || ''), String(m.from?.emailAddress?.address || '')) || 'TRIAGEM (Claudinha)'
    if (dest === 'KEEP') continue // ação do Márcio pendente — fica na caixa, intocado
    if (dest === 'DELETE') {
      await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}`, { method: 'DELETE', headers: gh(token) })
      out.push(`${account}: DELETE ${String(m.subject).slice(0, 40)}`)
      continue
    }
    const folderId = folders[dest]
    if (!folderId) continue
    await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, {
      method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: folderId }),
    })
    out.push(`${account}: ${dest} ← ${String(m.subject).slice(0, 40)}`)
    if (dest === 'TRIAGEM (Claudinha)') triaged.push(String(m.subject || '(sem assunto)').slice(0, 60))
  }
  // Sem report no grupo (ordem do Márcio, 27/jul): o que cair na TRIAGEM é
  // levantado pela Claudinha diretamente com ele no chat, não pelo WhatsApp.
  void triaged
}

async function zeroGmail(db: SupabaseClient, out: string[]): Promise<void> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('account', 'gz28us@gmail.com').limit(1)
  const auth = data?.[0]
  if (!auth?.refresh_token || !process.env.GOOGLE_CLIENT_ID) return
  const tk = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: auth.refresh_token, grant_type: 'refresh_token' }),
  }).then(r => r.json()).catch(() => null)
  if (!tk?.access_token) return
  const ghg = { Authorization: `Bearer ${tk.access_token}`, 'Content-Type': 'application/json' }
  // No Gmail a mesma lei vale pro SPAM (28/jul): o que o filtro do Google jogou
  // no lixo eletrônico é lido e processado igual ao que chega na caixa.
  const list = { messages: [] as any[] }
  for (const lbl of ['INBOX', 'SPAM']) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${lbl}&maxResults=25`, { headers: ghg }).then(r => r.json()).catch(() => null)
    for (const m of r?.messages || []) list.messages.push(m)
  }
  const ids: string[] = []
  const cutoff = Date.now() - GRACE_MIN * 60_000
  for (const m of list?.messages || []) {
    const full = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers: ghg }).then(r => r.json()).catch(() => null)
    if (!full || Number(full.internalDate) >= cutoff) continue
    const hdr = (n: string) => String(full.payload?.headers?.find((h: any) => h.name === n)?.value || '')
    // Mesma lei do 30/jul: pedido de assinatura eletrônica fica na caixa.
    if (ESIGN_FROM.test(hdr('From')) || ESIGN_SUBJ.test(hdr('Subject'))) continue
    ids.push(m.id)
  }
  if (ids.length) {
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', { method: 'POST', headers: ghg, body: JSON.stringify({ ids, removeLabelIds: ['INBOX'] }) })
    out.push(`gmail: arquivados ${ids.length}`)
  }
}

export async function runInboxZero(db: SupabaseClient): Promise<{ actions: string[] }> {
  const out: string[] = []
  try { await zeroGraph(db, 'gz28us@hotmail.com', ruleSlot1, out) } catch (e) { console.error('[inbox-zero s1]', e) }
  try { await zeroGraph(db, 'galpaoz28@hotmail.com', ruleSlot2, out) } catch (e) { console.error('[inbox-zero s2]', e) }
  try { await zeroGmail(db, out) } catch (e) { console.error('[inbox-zero s4]', e) }
  return { actions: out }
}
