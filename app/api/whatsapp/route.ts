import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { waSelfBlockReason } from '@/lib/waSelfGuard.server'

// WA SEND LOG (31/ago/2026, caso Gui): o aviso de duty morreu calado e ninguém
// soube. TODA tentativa de envio — sucesso e falha — fica em wa_send_log; o
// Data Checker fiscaliza as falhas. Log NUNCA derruba o envio: erro é engolido.
async function logSend(row: { destination: string | null; group_name: string | null; kind: string; body_head: string; ok: boolean; error: string | null; http_status: number | null; ultra_id: string | null }) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return
    const db = createClient(url, key, { auth: { persistSession: false } })
    await db.from('wa_send_log').insert(row)
  } catch { /* nunca derruba o envio */ }
}

// Every message — internal report or message to a client — ends with this
// registered signature line. Centralized here so it's guaranteed on EVERY message
// that goes through this route, no matter which page built it.
const SIGNATURE = 'Sent by GZ28US Control App®'

// Append the signature as the last line, after stripping the legacy footer some
// report builders still add, and without double-adding it.
function withSignature(raw: string): string {
  const text = (raw || '').replace(/\n*Sent by GZ28(US)? Control App®?\s*$/i, '').trimEnd()
  if (text.endsWith(SIGNATURE)) return text
  return text ? `${text}\n\n${SIGNATURE}` : SIGNATURE
}

// UltraMsg requires the `to` in chat format: <digits>@c.us for a person or
// <id>@g.us for a group. A bare phone number (just digits) is rejected with
// "Wrong 'to' format". So: pass through anything that already has an @ (groups,
// or an already-formatted contact), and turn a bare number into <digits>@c.us.
function normalizeTo(raw: string | null | undefined): string {
  const v = String(raw || '').trim()
  if (!v) return ''
  if (v.includes('@')) return v
  const digits = v.replace(/\D/g, '')
  return digits ? `${digits}@c.us` : ''
}

// Sends WhatsApp messages through UltraMsg to the reports group.
// Secrets live in environment variables, never in the code:
//   ULTRAMSG_INSTANCE  e.g. instance174454
//   ULTRAMSG_TOKEN     the instance token
//   ULTRAMSG_GROUP_ID  e.g. 120363425950692194@g.us
//
// Body accepted (JSON):
//   { body: string }                       -> sends a text message
//   { body: string, documentUrl: string,   -> sends a document with caption
//     filename?: string }
//   { body: string, imageUrl: string }     -> sends an image with caption
//
// Optionally override the destination with { to: "...@g.us" }.
//
// All logs are prefixed with [whatsapp] so they're easy to grep in Vercel
// function logs. We log env-var presence (not the actual values), the chosen
// endpoint, destination, upstream HTTP status, and the upstream response body
// — enough to diagnose mis-configured env vars, group ID changes, token
// rejections, and stalled networks without exposing the token in logs.
//
// IMPORTANT — UltraMsg API field naming (per https://docs.ultramsg.com):
//   - /messages/chat      -> the message text goes in `body`
//   - /messages/image     -> the caption text goes in `caption`
//   - /messages/document  -> the caption text goes in `caption`
// So image/document captions must be sent as `caption`, NOT `body`. Sending the
// text only in `body` to those endpoints makes UltraMsg deliver the file with
// no caption (the file arrives "bare") — which is why receipt-attached reports
// lost their text. We send `caption` for media and, for safety against older
// validation, also include `body` with the same text.

// Resolve a group destination by its display NAME on the instance (e.g.
// "GZ28US - STAFF") via UltraMsg's GET /groups. Cached per lambda instance so
// repeated sends don't re-list the groups every time.
const groupIdCache: Record<string, string> = {}
async function resolveGroupByName(base: string, token: string, name: string): Promise<string> {
  const key = name.trim().toLowerCase()
  if (!key) return ''
  if (groupIdCache[key]) return groupIdCache[key]
  try {
    const res = await fetch(`${base}/groups?token=${encodeURIComponent(token)}`)
    const raw = await res.text()
    let list: any[] = []
    try { const j = JSON.parse(raw); list = Array.isArray(j) ? j : (Array.isArray(j?.groups) ? j.groups : []) } catch { /* not JSON */ }
    const hit = list.find((g: any) => String(g.name || '').trim().toLowerCase() === key)
    if (hit?.id) { groupIdCache[key] = String(hit.id); return groupIdCache[key] }
    console.error('[whatsapp] group not found by name', { name, groupsSeen: list.length })
  } catch (e) {
    console.error('[whatsapp] groups lookup failed', e)
  }
  return ''
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  // Hoisted pro catch conseguir logar a exceção com contexto.
  let logCtx = { destination: null as string | null, group_name: null as string | null, kind: 'chat', body_head: '' }
  try {
    const instance = process.env.ULTRAMSG_INSTANCE
    const token = process.env.ULTRAMSG_TOKEN
    const defaultTo = process.env.ULTRAMSG_GROUP_ID

    console.log('[whatsapp] called', {
      hasInstance: !!instance,
      instanceLen: instance?.length || 0,
      hasToken: !!token,
      tokenLen: token?.length || 0,
      hasGroup: !!defaultTo,
      groupLen: defaultTo?.length || 0,
    })

    if (!instance || !token) {
      console.error('[whatsapp] missing env vars', { hasInstance: !!instance, hasToken: !!token })
      return NextResponse.json({ error: 'WhatsApp not configured (missing instance or token).' }, { status: 500 })
    }

    const payload = await req.json().catch(() => ({}))
    let to = normalizeTo(payload.to || defaultTo)
    // toGroupName targets a group by its NAME (resolved to its chat id).
    const toGroupName = typeof payload.toGroupName === 'string' ? payload.toGroupName.trim() : ''
    if (toGroupName) {
      const gid = await resolveGroupByName(`https://api.ultramsg.com/${instance}`, token, toGroupName)
      if (!gid) {
        await logSend({ destination: null, group_name: toGroupName, kind: 'chat', body_head: String(payload.body || '').slice(0, 160), ok: false, error: `group "${toGroupName}" not found on instance`, http_status: 404, ultra_id: null })
        return NextResponse.json({ error: `WhatsApp group "${toGroupName}" not found on this instance.` }, { status: 404 })
      }
      to = normalizeTo(gid)
    }
    // personal: true -> a message in Márcio's own voice (no app signature).
    const rawBody = typeof payload.body === 'string' ? payload.body : ''
    const body = payload.personal === true ? rawBody : withSignature(rawBody)
    const documentUrl = payload.documentUrl as string | undefined
    const imageUrl = payload.imageUrl as string | undefined
    const filename = (payload.filename as string | undefined) || 'document'

    console.log('[whatsapp] payload', {
      to,
      bodyLen: body.length,
      hasDocument: !!documentUrl,
      hasImage: !!imageUrl,
      filename: documentUrl ? filename : undefined,
    })

    logCtx = { destination: to || null, group_name: toGroupName || null, kind: imageUrl ? 'image' : documentUrl ? 'document' : 'chat', body_head: body.slice(0, 160) }
    if (!to) {
      console.error('[whatsapp] no destination')
      await logSend({ ...logCtx, ok: false, error: 'no destination configured', http_status: 400, ultra_id: null })
      return NextResponse.json({ error: 'No destination group configured.' }, { status: 400 })
    }

    // TRAVA DO "NUNCA PRA MIM MESMO" (31/ago/2026): a UltraMsg descarta em
    // silêncio o que é endereçado ao número da própria instância. Aqui a
    // tentativa é RECUSADA na cara, com log — melhor um 400 barulhento do que
    // outro aviso morrendo calado. Ver lib/waSelfGuard.server.ts.
    const selfBlock = waSelfBlockReason(to)
    if (selfBlock) {
      console.error('[whatsapp] BLOQUEADO —', selfBlock)
      await logSend({ ...logCtx, ok: false, error: `self-send bloqueado: ${selfBlock}`, http_status: 400, ultra_id: null })
      return NextResponse.json({ error: selfBlock, blocked: 'self-send' }, { status: 400 })
    }

    const base = `https://api.ultramsg.com/${instance}`

    // Decide which UltraMsg endpoint to use based on what was passed.
    // chat -> text in `body`; image/document -> text in `caption`.
    let endpoint: string
    let fields: Record<string, string>

    if (imageUrl) {
      endpoint = `${base}/messages/image`
      fields = { token, to, image: imageUrl, caption: body, body }
    } else if (documentUrl) {
      endpoint = `${base}/messages/document`
      fields = { token, to, document: documentUrl, filename, caption: body, body }
    } else {
      endpoint = `${base}/messages/chat`
      fields = { token, to, body }
    }

    const form = new URLSearchParams()
    Object.entries(fields).forEach(([k, v]) => form.append(k, v ?? ''))

    console.log('[whatsapp] -> ultramsg', { endpoint, to })

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    // Capture raw text first so we can log it even when it isn't valid JSON.
    const rawText = await res.text()
    let data: any = {}
    try { data = JSON.parse(rawText) } catch { /* not JSON */ }

    console.log('[whatsapp] <- ultramsg', {
      status: res.status,
      ok: res.ok,
      sent: data?.sent,
      error: data?.error,
      messageId: data?.id,
      rawLen: rawText.length,
      rawPreview: rawText.slice(0, 300),
      elapsedMs: Date.now() - t0,
    })

    // UltraMsg returns { sent: "true", id: ... } on a real send. Require that
    // explicitly — a 200 with { sent: "false" } (instance offline, bad number,
    // unreachable document URL, etc.) is NOT a success even without an `error`.
    const sentOk = data.sent === 'true' || data.sent === true
    const ok = res.ok && (sentOk || (!!data.id && !data.error))
    if (!ok) {
      console.error('[whatsapp] send failed', { status: res.status, rawPreview: rawText.slice(0, 500) })
      await logSend({ ...logCtx, ok: false, error: ('ultramsg: ' + rawText).slice(0, 400), http_status: res.status, ultra_id: null })
      return NextResponse.json({ error: 'UltraMsg send failed', status: res.status, detail: data, raw: rawText }, { status: 502 })
    }

    console.log('[whatsapp] success', { messageId: data?.id, elapsedMs: Date.now() - t0 })
    await logSend({ ...logCtx, ok: true, error: null, http_status: res.status, ultra_id: data?.id != null ? String(data.id) : null })
    return NextResponse.json({ ok: true, result: data })
  } catch (err) {
    console.error('[whatsapp] route exception', err)
    await logSend({ ...logCtx, ok: false, error: ('exception: ' + String(err)).slice(0, 400), http_status: null, ultra_id: null })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
