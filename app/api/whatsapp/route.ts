import { NextRequest, NextResponse } from 'next/server'

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

export async function POST(req: NextRequest) {
  const t0 = Date.now()
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
    const to = payload.to || defaultTo
    const body = typeof payload.body === 'string' ? payload.body : ''
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

    if (!to) {
      console.error('[whatsapp] no destination')
      return NextResponse.json({ error: 'No destination group configured.' }, { status: 400 })
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
      return NextResponse.json({ error: 'UltraMsg send failed', status: res.status, detail: data, raw: rawText }, { status: 502 })
    }

    console.log('[whatsapp] success', { messageId: data?.id, elapsedMs: Date.now() - t0 })
    return NextResponse.json({ ok: true, result: data })
  } catch (err) {
    console.error('[whatsapp] route exception', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
