/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'
import { requireUser, sendKeyOk } from '@/lib/apiAuth.server'
import { clientSpeaksPortuguese } from '@/lib/utils'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { maskEmail } from '@/lib/quotePublic.server'
import { buildPortalMail, isPortalMailKind, PORTAL_MAIL_KINDS } from '@/lib/quoteMail.server'

// Client e-mails sent BY THE APP (Graph, gz28us@hotmail.com) as real HTML with
// a clickable button — the old mailto: composer produced plain text with a dead
// link (31/jul, Johnny/NiteKing case). The route is locked to TEMPLATES: the
// body is built server-side from the database; no arbitrary content ever goes
// through (this is not an open relay).
//
// POST { kind: 'car-photo' | 'client-form', id }
//   car-photo   → id = ride id   (link to /rides/self/<id>)
//   client-form → id = client id (link to /clients/self/<id>)
// POST { kind: 'invoice-pdf', id: invoiceId, pdfUrl, filename }
//   → quote/invoice PDF ATTACHED (fetched server-side, ONLY from our own
//     public invoice-pdfs bucket) + button link; recipient = the invoice's
//     client on file. Born from the Johnny/NiteKing dead-link quote (31/jul).
//
// QUOTE PORTAL (M2, 06/11/2026): POST { kind: 'quote-link'|'quote-signed'|'deposit-receipt'|'installment-due'|'quote-expiring'|'change-order',
//   id: invoiceId, attempt_id? } — recipient, link and PDF all resolved from the database (lib/quoteMail.server.ts), never from the
//   request. Gated: quote_portal.enabled (real) or notify.test_targets (test); robot kinds need their notify.client.* key; only
//   quote-link from a HUMAN staff tap is unkeyed (SEND BY APP). Every send is an invoice_events NOTIFIED row.
//
// PORTÃO (13/set/2026): a rota manda e-mail da caixa da empresa para o cliente de
// qualquer id — respondia a pedido anônimo. Agora só tela logada (sessionHeaders)
// ou quem tem a chave de ENVIO no header x-send-key.

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const SITE = 'https://www.gz28us.com/ca'

function emailHtml(o: { first: string; isPT: boolean; kind: 'car-photo' | 'client-form'; link: string }): { subject: string; html: string } {
  const btn = (label: string) =>
    `<p style="margin:28px 0"><a href="${o.link}" style="background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:10px;display:inline-block">${label}</a></p>`
  const fallback = o.isPT
    ? `<p style="font-size:12px;color:#666">Se o botão não abrir, copie este endereço no navegador:<br/><a href="${o.link}">${o.link}</a></p>`
    : `<p style="font-size:12px;color:#666">If the button doesn't open, copy this address into your browser:<br/><a href="${o.link}">${o.link}</a></p>`
  const signature = `<p style="margin-top:32px">${o.isPT ? 'Obrigado!' : 'Thank you!'}<br/><b>GZ28 V8 SpeedShop</b><br/>11320 Space Blvd, Orlando, FL 32837<br/>(321) 315-0973</p>`
  const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5">${inner}${fallback}${signature}</div>`
  const hi = `<p>${o.isPT ? 'Oi' : 'Hi'}${o.first ? ` ${o.first}` : ''}! 👋</p>`

  if (o.kind === 'car-photo') {
    return o.isPT
      ? { subject: 'Sua foto do carro — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>Queremos a sua foto favorita do seu carro para o registro na <b>GZ28 V8 SpeedShop</b>. É só tocar no botão, escolher a foto e enviar:</p>${btn('ENVIAR FOTO')}`) }
      : { subject: 'Your car photo — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>We'd love your favorite picture of your car for your record at <b>GZ28 V8 SpeedShop</b>. Just tap the button, choose the photo and send:</p>${btn('SEND PHOTO')}`) }
  }
  return o.isPT
    ? { subject: 'Complete seu cadastro — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>Para agilizar seu atendimento na <b>GZ28 V8 SpeedShop</b>, preencha seus dados no botão abaixo e toque em <b>SALVAR</b>:</p>${btn('PREENCHER MEUS DADOS')}`) }
    : { subject: 'Complete your details — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>To speed up your service at <b>GZ28 V8 SpeedShop</b>, please fill in your details at the button below and tap <b>SAVE</b>:</p>${btn('FILL IN MY DETAILS')}`) }
}

const PDF_PREFIX = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/invoice-pdfs/`

export async function POST(req: NextRequest) {
  if (!sendKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => null)
  if (isPortalMailKind(b?.kind)) return portalMail(req, b)
  const kind = b?.kind as 'car-photo' | 'client-form' | 'invoice-pdf'
  const id = String(b?.id || '')
  if (!['car-photo', 'client-form', 'invoice-pdf'].includes(kind) || !id) {
    return NextResponse.json({ error: `kind (car-photo|client-form|invoice-pdf|${PORTAL_MAIL_KINDS.join('|')}) and id required` }, { status: 400 })
  }

  const db = streamDb()

  if (kind === 'invoice-pdf') {
    const pdfUrl = String(b?.pdfUrl || '')
    if (!pdfUrl.startsWith(PDF_PREFIX)) return NextResponse.json({ error: 'pdfUrl must be an invoice-pdfs bucket URL' }, { status: 400 })
    const { data: inv } = await db.from('invoices').select('invoice_code, is_quote, client_id, ride_id').eq('id', id).maybeSingle()
    if (!inv) return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
    let clientId = inv.client_id
    if (!clientId && inv.ride_id) {
      const { data: ride } = await db.from('rides').select('client_id').eq('id', inv.ride_id).maybeSingle()
      clientId = ride?.client_id
    }
    const { data: c } = clientId
      ? await db.from('clients').select('name, email, country').eq('id', clientId).maybeSingle()
      : { data: null }
    if (!c?.email) return NextResponse.json({ error: 'client has no email on file' }, { status: 400 })

    // Portuguese for a Portuguese-speaking client (BRAZIL, ANGOLA).
    const isPT = clientSpeaksPortuguese(c.country)
    const noun = inv.is_quote ? (isPT ? 'orçamento' : 'quote') : (isPT ? 'fatura' : 'invoice')
    const first = (c.name || '').split(' ')[0]
    const filename = String(b?.filename || `${inv.invoice_code}.pdf`).replace(/[^\w.\- ]/g, '')
    const subject = filename.replace(/\.pdf$/i, '')
    const btnLabel = inv.is_quote ? (isPT ? 'VER MEU ORÇAMENTO' : 'VIEW YOUR QUOTE') : (isPT ? 'VER MINHA FATURA' : 'VIEW YOUR INVOICE')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5">` +
      `<p>${isPT ? 'Olá' : 'Hello'}${first ? ` ${first}` : ''},</p>` +
      (isPT
        ? `<p>Seu ${noun} <b>${inv.invoice_code}</b> está anexado a este e-mail em PDF — e você também pode abri-lo aqui:</p>`
        : `<p>Your ${noun} <b>${inv.invoice_code}</b> is attached to this email as a PDF — and you can also open it right here:</p>`) +
      `<p style="margin:28px 0"><a href="${pdfUrl}" style="background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:10px;display:inline-block">${btnLabel}</a></p>` +
      `<p>${isPT ? 'Qualquer dúvida, estamos à disposição.' : "Any questions, we're at your service."}</p>` +
      `<p style="margin-top:32px">${isPT ? 'Obrigado,' : 'Thank you,'}<br/><b>GZ28 V8 SpeedShop</b><br/>11320 Space Blvd, Orlando, FL 32837<br/>(321) 315-0973</p></div>`

    const pdf = await fetch(pdfUrl)
    if (!pdf.ok) return NextResponse.json({ error: `pdf fetch failed (${pdf.status})` }, { status: 502 })
    const base64 = Buffer.from(await pdf.arrayBuffer()).toString('base64')

    const auth2 = await getMailAuth(db, 1)
    if (!auth2?.refresh_token) return NextResponse.json({ error: 'mailbox not connected' }, { status: 502 })
    const token2 = await freshAccessToken(db, auth2)
    if (!token2) return NextResponse.json({ error: 'mail token refresh failed' }, { status: 502 })
    const r2 = await fetch(`${G}/me/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: c.email } }],
          attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: filename, contentType: 'application/pdf', contentBytes: base64 }],
        },
        saveToSentItems: true,
      }),
    })
    if (!r2.ok) return NextResponse.json({ error: (await r2.text()).slice(0, 300) }, { status: 502 })
    return NextResponse.json({ ok: true, to: c.email, subject, attached: filename })
  }
  let clientRow: { name: string | null; email: string | null; country: string | null } | null = null
  let link = ''
  if (kind === 'car-photo') {
    const { data: ride } = await db.from('rides').select('id, client_id').eq('id', id).maybeSingle()
    if (!ride) return NextResponse.json({ error: 'ride not found' }, { status: 404 })
    if (ride.client_id) {
      const { data: c } = await db.from('clients').select('name, email, country').eq('id', ride.client_id).maybeSingle()
      clientRow = c
    }
    link = `${SITE}/rides/self/${ride.id}`
  } else {
    const { data: c } = await db.from('clients').select('id, name, email, country').eq('id', id).maybeSingle()
    if (!c) return NextResponse.json({ error: 'client not found' }, { status: 404 })
    clientRow = c
    link = `${SITE}/clients/self/${c.id}`
  }
  if (!clientRow?.email) return NextResponse.json({ error: 'client has no email on file' }, { status: 400 })

  const { subject, html } = emailHtml({
    first: (clientRow.name || '').split(' ')[0],
    isPT: clientSpeaksPortuguese(clientRow.country),
    kind, link,
  })

  const auth = await getMailAuth(db, 1)
  if (!auth?.refresh_token) return NextResponse.json({ error: 'mailbox not connected' }, { status: 502 })
  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ error: 'mail token refresh failed' }, { status: 502 })

  const r = await fetch(`${G}/me/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: clientRow.email } }],
      },
      saveToSentItems: true,
    }),
  })
  if (!r.ok) return NextResponse.json({ error: (await r.text()).slice(0, 300) }, { status: 502 })
  return NextResponse.json({ ok: true, to: clientRow.email, subject })
}

async function portalMail(req: NextRequest, b: any) {
  const staff = await requireStaff(req)   // a human JWT (machine accounts refused); the send key is a machine caller
  const id = String(b?.id || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id (invoice uuid) required' }, { status: 400 })
  const db = serviceDb()
  const m = await buildPortalMail(db, b.kind, id, { human: !!staff, attemptId: b?.attempt_id ? String(b.attempt_id) : null })
  if ('error' in m) return NextResponse.json({ error: m.error }, { status: m.status })
  const mdb = streamDb()
  const auth = await getMailAuth(mdb, 1)
  if (!auth?.refresh_token) return NextResponse.json({ error: 'mailbox not connected' }, { status: 502 })
  const token = await freshAccessToken(mdb, auth)
  if (!token) return NextResponse.json({ error: 'mail token refresh failed' }, { status: 502 })
  const r = await fetch(`${G}/me/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject: m.subject, body: { contentType: 'HTML', content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }],
      attachments: m.attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: 'application/pdf', contentBytes: a.base64 })) }, saveToSentItems: true }),
  })
  if (!r.ok) return NextResponse.json({ error: (await r.text()).slice(0, 300) }, { status: 502 })
  await db.rpc('doc_event', { p_invoice: m.invoiceId, p_revision: m.revisionId, p_kind: 'NOTIFIED', p_actor: staff ? 'STAFF' : 'SYSTEM', p_actor_id: staff?.email || 'send-key',
    p_payload: { kind: b.kind, channel: 'EMAIL', to: maskEmail(m.to), by_app: !!staff, attachments: m.attachments.map(a => a.name) } })
  return NextResponse.json({ ok: true, to: maskEmail(m.to), subject: m.subject, attached: m.attachments.map(a => a.name) })
}
