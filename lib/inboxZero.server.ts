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

// ── VIP MAIL ALERT (LEI do Márcio, 04/ago/2026 — caso Celina: resposta da
// negociação SEMA ficou 8h na TRIAGEM sem ninguém avisar). E-mail de contraparte
// ATIVA dispara aviso IMEDIATO no WhatsApp pessoal do Márcio, a cada poll de
// 5 min, com o PC desligado. Cursor em whatsapp_polling_state ('vip-mail-alert')
// garante que cada mensagem alerta uma única vez.
const VIP_FROM = /celinak|@sema\.org|performanceracing\.com|kooksheaders|guerra\.law|kravitz|montway\.com|autotagsandtitle|venterraliving|esusu\.org|treperformance|titanmotorsports|stripe\.com|refunds@united|highhorseperformance\.com|kramerautoplex\.com|joesal67@gmail\.com/i
// 31/ago/2026: grupo REPORTS, nunca o número da própria instância — a UltraMsg
// recusa mensagem pro próprio número e o envio morre calado. Ver zelleWatch.
const MARCIO_US = '120363425950692194@g.us'

async function alertOne(from: string, subject: string, account: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return
  const body = `📨 *VIP MAIL*\nDe: ${from}\nAssunto: ${subject}\nCaixa: ${account}\n\n${SIGNATURE}`
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: MARCIO_US, body }),
    })
  } catch { /* best-effort */ }
}

export async function alertVipMail(db: SupabaseClient): Promise<{ alerted: string[] }> {
  const runStart = new Date().toISOString()
  const { data } = await db.from('whatsapp_polling_state').select('*').eq('id', 'vip-mail-alert').limit(1)
  // Cursor = ISO do último run; primeira execução olha só os últimos 15 min.
  const cursor = data?.[0]?.last_message_id || new Date(Date.now() - 15 * 60_000).toISOString()
  const alerted: string[] = []
  for (const account of ['gz28us@hotmail.com', 'galpaoz28@hotmail.com']) {
    const token = await msToken(db, account)
    if (!token) continue
    const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=25&$select=subject,from,receivedDateTime`
    const res = await fetch(url, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    for (const m of res?.value || []) {
      const from = m.from?.emailAddress?.address || ''
      if (!VIP_FROM.test(from)) continue
      await alertOne(from, String(m.subject || '(sem assunto)').slice(0, 120), account)
      alerted.push(`${account}: ${from}`)
    }
  }
  await db.from('whatsapp_polling_state').upsert({ id: 'vip-mail-alert', last_message_id: runStart, updated_at: runStart })
  return { alerted }
}

// Regras por conta: retorno = nome de pasta ('Pai/Filha' aponta subpasta), 'DELETE',
// 'KEEP' (fica na caixa de entrada, intocado), ou null (→ TRIAGEM).
// Mantidas alinhadas às decisões do Márcio de 26/jul.
// LEI (Márcio, 30/jul/2026, caso EchoSign/Progressive): pedido de ASSINATURA
// eletrônica NUNCA sai da caixa de entrada — ele precisa ver e assinar.
const ESIGN_FROM = /echosign|adobesign|docusign|hellosign|sign\.dropbox|pandadoc|esign@/i
const ESIGN_SUBJ = /signature requested|review and sign|aguarda(ndo)? sua assinatura|assinatura pendente/i
// Despachante (Auto Tags / Jordan, caso 30/jul: quote do RAMbo achado nos Itens
// Excluídos): o thread da frota fica na caixa de entrada, intocado, sempre.
const DESPACHANTE_FROM = /autotagsandtitle/i
// K&G / O-1A (caso 03/ago: pacote ASSINATURA FORMULÁRIOS varrido da caixa): tudo
// dos advogados de imigração fica na caixa de entrada até o Márcio dar destino.
const KG_FROM = /guerra\.law|kravitz/i
function ruleSlot1(subj: string, from: string): string | null {
  if (ESIGN_FROM.test(from) || ESIGN_SUBJ.test(subj)) return 'KEEP'
  if (DESPACHANTE_FROM.test(from)) return 'KEEP'
  if (KG_FROM.test(from)) return 'KEEP'
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
  for (const m of msgs) {
    if (new Date(m.receivedDateTime).getTime() > cutoff) continue // recente demais — outros sweeps ainda vão agir
    // LEI (Márcio, 04/ago/2026): e-mail SEM regra = NÃO PROCESSADO ⇒ FICA NA
    // INBOX à vista, como pendência. Nada de TRIAGEM escondendo trabalho —
    // foi assim que a resposta da Celina dormiu 8h sem ninguém ver.
    const dest = rule(String(m.subject || ''), String(m.from?.emailAddress?.address || ''))
    if (dest === null || dest === 'KEEP') continue // fica na caixa, intocado, até ser processado
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
  }
}

// Gmail (slot 4) — LEI (Márcio, 04/ago/2026): e-mail NÃO PROCESSADO fica na
// inbox, à vista. O arquivamento em massa de "sobras" que existia aqui foi
// DESLIGADO — quem tira e-mail da caixa do Gmail é o sweep que o processa de
// verdade (purchase-capture, APPS, spam), nunca uma limpeza cega.

// ── COLAPSO DE THREADS (LEI SACRED, Márcio 04/ago/2026, caso LUMA): thread
// aberto mantém SÓ O ÚLTIMO e-mail na inbox; os anteriores vão pra pasta onde a
// conversa já mora (outros e-mails do mesmo conversationId fora de inbox/sent/
// lixo). Thread sem lar conhecido não é tocado — a sessão dá o destino primeiro.
async function collapseThreads(db: SupabaseClient, account: string, out: string[]): Promise<void> {
  const token = await msToken(db, account)
  if (!token) return
  // ids das pastas "não-lar" (well-known) — e-mail que mora nelas não define destino
  const nonHome = new Set<string>()
  for (const wk of ['inbox', 'sentitems', 'deleteditems', 'junkemail', 'drafts']) {
    const f = await fetch(`${G}/me/mailFolders/${wk}`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    if (f?.id) nonHome.add(f.id)
  }
  const r = await fetch(`${G}/me/mailFolders/inbox/messages?$top=100&$select=id,subject,conversationId,receivedDateTime`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
  const byConv = new Map<string, any[]>()
  for (const m of r?.value || []) {
    if (!m.conversationId) continue
    const arr = byConv.get(m.conversationId) || []
    arr.push(m); byConv.set(m.conversationId, arr)
  }
  for (const [convId, msgs] of byConv) {
    if (msgs.length < 2) continue
    msgs.sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)))
    const older = msgs.slice(1) // o mais novo NUNCA sai daqui
    // lar da conversa = pasta (fora das well-known) onde já há e-mails deste thread
    const conv = await fetch(`${G}/me/messages?$filter=conversationId eq '${convId.replace(/'/g, "''")}'&$select=id,parentFolderId&$top=50`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    const homes: Record<string, number> = {}
    for (const m of conv?.value || []) {
      if (!m.parentFolderId || nonHome.has(m.parentFolderId)) continue
      homes[m.parentFolderId] = (homes[m.parentFolderId] || 0) + 1
    }
    const home = Object.entries(homes).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!home) continue // sem lar conhecido — sessão decide primeiro
    for (const m of older) {
      const mv = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, {
        method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: home }),
      })
      if (mv.ok) out.push(`${account}: THREAD↓ ${String(m.subject).slice(0, 40)}`)
    }
  }
}

// ── ENVIADOS TAMBÉM SE PROCESSAM (LEI, Márcio 04/ago/2026): "PROCESS means all
// emails, not only the incoming ones!" — todo e-mail ENVIADO vai pra pasta do
// caso do seu thread (o lar do conversationId), igual fizemos à mão na sessão.
// Enviado cujo thread ainda não tem lar fica no Sent até a sessão dar o destino.
async function collapseSent(db: SupabaseClient, account: string, out: string[]): Promise<void> {
  const token = await msToken(db, account)
  if (!token) return
  const nonHome = new Set<string>()
  for (const wk of ['inbox', 'sentitems', 'deleteditems', 'junkemail', 'drafts']) {
    const f = await fetch(`${G}/me/mailFolders/${wk}`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    if (f?.id) nonHome.add(f.id)
  }
  const cutoff = new Date(Date.now() - GRACE_MIN * 60_000).toISOString()
  const r = await fetch(`${G}/me/mailFolders/sentitems/messages?$top=100&$select=id,subject,conversationId,sentDateTime`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
  for (const m of r?.value || []) {
    if (!m.conversationId || String(m.sentDateTime) > cutoff) continue // 15 min de respiro
    const conv = await fetch(`${G}/me/messages?$filter=conversationId eq '${m.conversationId.replace(/'/g, "''")}'&$select=id,parentFolderId&$top=50`, { headers: gh(token) }).then(r => r.json()).catch(() => null)
    const homes: Record<string, number> = {}
    for (const c of conv?.value || []) {
      if (!c.parentFolderId || nonHome.has(c.parentFolderId)) continue
      homes[c.parentFolderId] = (homes[c.parentFolderId] || 0) + 1
    }
    const home = Object.entries(homes).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!home) continue
    const mv = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}/move`, {
      method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: home }),
    })
    if (mv.ok) out.push(`${account}: SENT↓ ${String(m.subject).slice(0, 40)}`)
  }
}

export async function runInboxZero(db: SupabaseClient): Promise<{ actions: string[] }> {
  const out: string[] = []
  try { await zeroGraph(db, 'gz28us@hotmail.com', ruleSlot1, out) } catch (e) { console.error('[inbox-zero s1]', e) }
  try { await zeroGraph(db, 'galpaoz28@hotmail.com', ruleSlot2, out) } catch (e) { console.error('[inbox-zero s2]', e) }
  try { await collapseThreads(db, 'gz28us@hotmail.com', out) } catch (e) { console.error('[thread-collapse s1]', e) }
  try { await collapseThreads(db, 'galpaoz28@hotmail.com', out) } catch (e) { console.error('[thread-collapse s2]', e) }
  try { await collapseSent(db, 'gz28us@hotmail.com', out) } catch (e) { console.error('[sent-collapse s1]', e) }
  try { await collapseSent(db, 'galpaoz28@hotmail.com', out) } catch (e) { console.error('[sent-collapse s2]', e) }
  return { actions: out }
}
