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

export async function POST(req: NextRequest) {
  try {
    const instance = process.env.ULTRAMSG_INSTANCE
    const token = process.env.ULTRAMSG_TOKEN
    const defaultTo = process.env.ULTRAMSG_GROUP_ID

    if (!instance || !token) {
      return NextResponse.json({ error: 'WhatsApp not configured (missing instance or token).' }, { status: 500 })
    }

    const payload = await req.json().catch(() => ({}))
    const to = payload.to || defaultTo
    const body = typeof payload.body === 'string' ? payload.body : ''
    const documentUrl = payload.documentUrl as string | undefined
    const imageUrl = payload.imageUrl as string | undefined
    const filename = (payload.filename as string | undefined) || 'document'

    if (!to) {
      return NextResponse.json({ error: 'No destination group configured.' }, { status: 400 })
    }

    const base = `https://api.ultramsg.com/${instance}`

    // Decide which UltraMsg endpoint to use based on what was passed.
    let endpoint: string
    let fields: Record<string, string>

    if (imageUrl) {
      endpoint = `${base}/messages/image`
      fields = { token, to, image: imageUrl, caption: body }
    } else if (documentUrl) {
      endpoint = `${base}/messages/document`
      fields = { token, to, document: documentUrl, filename, caption: body }
    } else {
      endpoint = `${base}/messages/chat`
      fields = { token, to, body }
    }

    const form = new URLSearchParams()
    Object.entries(fields).forEach(([k, v]) => form.append(k, v ?? ''))

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    const data = await res.json().catch(() => ({}))

    // UltraMsg returns { sent: "true", ... } on success, or { error: ... }.
    const ok = res.ok && (data.sent === 'true' || data.sent === true || !data.error)
    if (!ok) {
      return NextResponse.json({ error: 'UltraMsg send failed', detail: data }, { status: 502 })
    }

    return NextResponse.json({ ok: true, result: data })
  } catch (err) {
    console.error('whatsapp route error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}