import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'

// Client e-mails sent BY THE APP (Graph, gz28us@hotmail.com) as real HTML with
// a clickable button — the old mailto: composer produced plain text with a dead
// link (31/jul, Johnny/NiteKing case). The route is locked to TEMPLATES: the
// body is built server-side from the database; no arbitrary content ever goes
// through (this is not an open relay).
//
// POST { kind: 'car-photo' | 'client-form', id }
//   car-photo   → id = ride id   (link to /rides/self/<id>)
//   client-form → id = client id (link to /clients/self/<id>)

export const dynamic = 'force-dynamic'

const G = 'https://graph.microsoft.com/v1.0'
const SITE = 'https://www.gz28us.com/ca'

function emailHtml(o: { first: string; isBR: boolean; kind: 'car-photo' | 'client-form'; link: string }): { subject: string; html: string } {
  const btn = (label: string) =>
    `<p style="margin:28px 0"><a href="${o.link}" style="background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:10px;display:inline-block">${label}</a></p>`
  const fallback = o.isBR
    ? `<p style="font-size:12px;color:#666">Se o botão não abrir, copie este endereço no navegador:<br/><a href="${o.link}">${o.link}</a></p>`
    : `<p style="font-size:12px;color:#666">If the button doesn't open, copy this address into your browser:<br/><a href="${o.link}">${o.link}</a></p>`
  const signature = `<p style="margin-top:32px">${o.isBR ? 'Obrigado!' : 'Thank you!'}<br/><b>GZ28 V8 SpeedShop</b><br/>11320 Space Blvd, Orlando, FL 32837<br/>(321) 315-0973</p>`
  const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5">${inner}${fallback}${signature}</div>`
  const hi = `<p>${o.isBR ? 'Oi' : 'Hi'}${o.first ? ` ${o.first}` : ''}! 👋</p>`

  if (o.kind === 'car-photo') {
    return o.isBR
      ? { subject: 'Sua foto do carro — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>Queremos a sua foto favorita do seu carro para o registro na <b>GZ28 V8 SpeedShop</b>. É só tocar no botão, escolher a foto e enviar:</p>${btn('ENVIAR FOTO')}`) }
      : { subject: 'Your car photo — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>We'd love your favorite picture of your car for your record at <b>GZ28 V8 SpeedShop</b>. Just tap the button, choose the photo and send:</p>${btn('SEND PHOTO')}`) }
  }
  return o.isBR
    ? { subject: 'Complete seu cadastro — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>Para agilizar seu atendimento na <b>GZ28 V8 SpeedShop</b>, preencha seus dados no botão abaixo e toque em <b>SALVAR</b>:</p>${btn('PREENCHER MEUS DADOS')}`) }
    : { subject: 'Complete your details — GZ28 V8 SpeedShop', html: wrap(`${hi}<p>To speed up your service at <b>GZ28 V8 SpeedShop</b>, please fill in your details at the button below and tap <b>SAVE</b>:</p>${btn('FILL IN MY DETAILS')}`) }
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  const kind = b?.kind as 'car-photo' | 'client-form'
  const id = String(b?.id || '')
  if (!['car-photo', 'client-form'].includes(kind) || !id) {
    return NextResponse.json({ error: 'kind (car-photo|client-form) and id required' }, { status: 400 })
  }

  const db = streamDb()
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
    isBR: clientRow.country === 'BRAZIL',
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
