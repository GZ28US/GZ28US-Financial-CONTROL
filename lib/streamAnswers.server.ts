// SERVER-ONLY — RESPOSTAS DO GRUPO VIRAM AÇÃO (ordem do Márcio, 27/jul/2026:
// "automatize a ação baseada na resposta da pergunta feita").
//
// O purchaseCapture pergunta no grupo REPORTS "*A que carro/invoice pertence?*"
// listando os pedidos capturados. Alguém responde ("Inputs", "MexicanGTR",
// "US.026.1", "BR.472 Pedro"...). Este módulo lê o grupo, casa cada resposta com
// a pergunta imediatamente anterior (pelos números de pedido que ela cita) e
// aplica o destino nas linhas do STREAM — inclusive corrigindo a coluna `app`
// quando o destino é um carro BR (lei: compra BR no STREAM BR).
//
// Idempotente: cada mensagem de resposta já processada fica registrada em
// stream_mail_moves (from_addr 'stream-answer').

import type { SupabaseClient } from '@supabase/supabase-js'

const SIGNATURE = 'Sent by GZ28US Control App®'
const PENDING_MARK = '❓ destino a definir'

type WaMsg = { id?: string; body?: string; fromMe?: boolean; time?: number }

async function fetchGroupMessages(limit = 40): Promise<WaMsg[]> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN, groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return []
  const url = `https://api.ultramsg.com/${instance}/chats/messages?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(groupId)}&limit=${limit}`
  const data = await fetch(url).then(r => r.json()).catch(() => null)
  return Array.isArray(data) ? data : []
}

async function replyToGroup(body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN, groupId = process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return
  await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
  }).catch(() => {})
}

// O destino que a resposta descreve. Resolve contra rides/invoices dos DOIS
// projetos (o US lê o BR pelo mesmo Supabase? não — só o que este app enxerga),
// mais os destinos fixos que não são carro.
export type Destination = { label: string; app: 'US' | 'BR' } | null

async function resolveDestination(db: SupabaseClient, answer: string): Promise<Destination> {
  const raw = answer.trim()
  if (!raw || raw.length > 120) return null
  const s = raw.toLowerCase()

  // Destinos fixos (não são carro).
  if (/^inputs?\b/.test(s) || /\binsumos?\b/.test(s)) return { label: 'INPUTS GZ28US', app: 'US' }
  if (/^goods?\b/.test(s) || /\bmercadorias?\b/.test(s)) return { label: 'GOODS GZ28US', app: 'US' }
  if (/pessoal|personal|casa/.test(s)) return { label: 'PESSOAL (Márcio)', app: 'US' }

  // Código de invoice (US.026.1 / BR.472.1 / 047.1) -> a invoice manda no destino.
  const invMatch = raw.match(/\b((?:US|BR)\.\d{3}(?:\.\d+)?|\d{3}\.\d+)\b/i)
  if (invMatch) {
    const code = invMatch[1].toUpperCase()
    const { data: inv } = await db.from('invoices').select('invoice_code, ride_id').ilike('invoice_code', `${code}%`).limit(1)
    if (inv?.length) {
      const { data: ride } = inv[0].ride_id
        ? await db.from('rides').select('project_code, project_name').eq('id', inv[0].ride_id).limit(1)
        : { data: null as any }
      const car = ride?.length ? ` · ${ride[0].project_name}` : ''
      const app = /^BR\./i.test(inv[0].invoice_code) ? 'BR' : 'US'
      return { label: `${inv[0].invoice_code}${car}`, app }
    }
  }

  // Nome do carro (MexicanGTR, Daytona, JailBreak...) — casa por project_name.
  const { data: rides } = await db.from('rides').select('project_code, project_name').limit(500)
  for (const r of rides || []) {
    const name = String(r.project_name || '').toLowerCase()
    if (name.length >= 4 && s.includes(name)) {
      const app = /^BR\./i.test(String(r.project_code)) ? 'BR' : 'US'
      return { label: `${r.project_code} · ${r.project_name}`, app }
    }
  }
  return null
}

export async function runStreamAnswers(db: SupabaseClient): Promise<{ applied: string[] }> {
  const applied: string[] = []
  const msgs = await fetchGroupMessages(40)
  if (!msgs.length) return { applied }

  const { data: seen } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'stream-answer')
  const seenSet = new Set((seen || []).map((r: any) => r.message_id))

  // Percorre em ordem cronológica: guarda a última pergunta (nossa, com os
  // pedidos citados) e aplica a PRIMEIRA resposta humana que vier depois.
  let pendingOrders: string[] = []
  for (const m of msgs) {
    const body = String(m.body || '')
    if (m.fromMe) {
      if (/COMPRA CAPTURADA/i.test(body) && /pertence/i.test(body)) {
        const line = body.match(/Pedido\(s\):\s*([^\n]+)/i)
        pendingOrders = line ? line[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : []
      }
      continue
    }
    if (!pendingOrders.length) continue
    const key = `sa:${m.id || `${m.time}-${body.slice(0, 20)}`}`
    if (seenSet.has(key)) { pendingOrders = []; continue }

    const dest = await resolveDestination(db, body)
    if (!dest) continue // resposta não reconhecida — deixa pendente pro humano

    for (const orderNo of pendingOrders) {
      const { data: rows } = await db.from('part_streams').select('id, item').eq('order_number', orderNo).limit(1)
      const row = rows?.[0]
      if (!row) continue
      const item = String(row.item || '').replace(new RegExp(`\\s*—\\s*${PENDING_MARK}`), '')
      await db.from('part_streams').update({ item, where_label: dest.label, app: dest.app }).eq('id', row.id)
      applied.push(`${orderNo} → ${dest.label}`)
    }
    await db.from('stream_mail_moves').insert({ message_id: key, subject: body.slice(0, 120), from_addr: 'stream-answer', folder_name: dest.label.slice(0, 60), state: 'APPLIED' })
    if (applied.length) {
      await replyToGroup(`✅ *DESTINO APLICADO*\n${applied.map(a => `• ${a}`).join('\n')}`)
    }
    pendingOrders = []
  }
  return { applied }
}
