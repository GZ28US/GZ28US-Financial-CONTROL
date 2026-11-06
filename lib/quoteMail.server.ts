/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the quote-portal kinds of /api/mail/client (06/11/2026; blueprint M2 §8.1 C-69). Builds the message ONLY from the
// database: the recipient is the client on file, the link is the document's live portal link, the attachment is the frozen
// revision / signed copy / receipt from the private bucket (never a caller-supplied path or URL). This file SENDS NOTHING —
// it returns {to, subject, html, attachments} and the route sends. Every kind is refused unless:
//   • the document is real and `quote_portal.enabled` is ON, or it is a test document and the recipient is in `notify.test_targets`;
//   • robot kinds: their `notify.client.*` key is ON. `quote-link` from a HUMAN staff tap (SEND BY APP) is the one unkeyed kind
//     (blueprint U2-02 / memory never-send-unauthorized 18/10 exception); from a machine caller it needs notify.client.quote_sent.email.
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadDocState, publicUrl, firstName } from './quoteDoc.server'
import { clientRevisionPdf, attemptReceiptPdf } from './docFiles.server'
import { settingOn, readSetting } from './appSettings.server'
import { moneyCents, type Lang } from './quoteStrings'
import { fmtDay } from './orlando'

export const PORTAL_MAIL_KINDS = ['quote-link', 'quote-signed', 'deposit-receipt', 'installment-due', 'quote-expiring', 'change-order'] as const
export type PortalMailKind = typeof PORTAL_MAIL_KINDS[number]
export const isPortalMailKind = (k: unknown): k is PortalMailKind => PORTAL_MAIL_KINDS.includes(k as PortalMailKind)
const KEY: Record<PortalMailKind, string> = {
  'quote-link': 'notify.client.quote_sent.email', 'quote-signed': 'notify.client.signed_copy', 'deposit-receipt': 'notify.client.deposit_received',
  'installment-due': 'notify.client.installment_due', 'quote-expiring': 'notify.client.quote_expiring', 'change-order': 'notify.client.change_order',
}
export type PortalMail = { to: string; subject: string; html: string; attachments: { name: string; base64: string }[]; invoiceId: string; revisionId: string | null; isTest: boolean }
type Fail = { error: string; status: number }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Pure: the copy of each kind, EN/PT. Exported for the local harness.
export function portalMailCopy(kind: PortalMailKind, lang: Lang, v: { first: string; code: string; car: string; link: string; amount?: string; until?: string; seq?: number | null }) {
  const pt = lang === 'pt'
  const btn = (label: string) => `<p style="margin:28px 0"><a href="${esc(v.link)}" style="background:#b91c1c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:10px;display:inline-block">${esc(label)}</a></p>`
  const hi = `<p>${pt ? 'Olá' : 'Hello'}${v.first ? ' ' + esc(v.first) : ''},</p>`
  const what = `<b>${esc(v.code)}</b>${v.car ? ' · ' + esc(v.car) : ''}`
  const C: Record<PortalMailKind, { subject: string; body: string; button: string }> = {
    'quote-link': pt
      ? { subject: `Seu orçamento ${v.code} — GZ28 V8 SpeedShop`, body: `<p>Seu orçamento ${what} está pronto. No link você lê tudo, aprova e assina, e paga a 1ª parcela no mesmo lugar.${v.until ? ` Válido até ${esc(v.until)}.` : ''}</p>`, button: 'VER MEU ORÇAMENTO' }
      : { subject: `Your quote ${v.code} — GZ28 V8 SpeedShop`, body: `<p>Your quote ${what} is ready. On the link you can read everything, approve and sign, and pay the 1st installment in the same place.${v.until ? ` Valid until ${esc(v.until)}.` : ''}</p>`, button: 'VIEW MY QUOTE' },
    'quote-signed': pt
      ? { subject: `Cópia assinada — ${v.code}`, body: `<p>Obrigado! Sua aprovação de ${what} foi registrada. A cópia assinada está anexada em PDF.</p>`, button: 'ABRIR MEU DOCUMENTO' }
      : { subject: `Your signed copy — ${v.code}`, body: `<p>Thank you! Your approval of ${what} is on record. The signed copy is attached as a PDF.</p>`, button: 'OPEN MY DOCUMENT' },
    'deposit-receipt': pt
      ? { subject: `Recibo ${v.amount || ''} — ${v.code}`.replace('  ', ' '), body: `<p>Recebemos ${v.amount ? '<b>' + esc(v.amount) + '</b>' : 'seu pagamento'}${v.seq ? ` (parcela ${v.seq})` : ''} de ${what}. O recibo está anexado em PDF.</p>`, button: 'VER MEU DOCUMENTO' }
      : { subject: `Receipt ${v.amount || ''} — ${v.code}`.replace('  ', ' '), body: `<p>We received ${v.amount ? '<b>' + esc(v.amount) + '</b>' : 'your payment'}${v.seq ? ` (installment ${v.seq})` : ''} for ${what}. The receipt is attached as a PDF.</p>`, button: 'VIEW MY DOCUMENT' },
    'installment-due': pt
      ? { subject: `Parcela ${v.seq ?? ''} de ${v.code}`.replace('  ', ' '), body: `<p>A parcela ${v.seq ?? ''}${v.amount ? ' de <b>' + esc(v.amount) + '</b>' : ''} de ${what} está disponível para pagamento no link.</p>`, button: 'PAGAR PELO LINK' }
      : { subject: `Installment ${v.seq ?? ''} of ${v.code}`.replace('  ', ' '), body: `<p>Installment ${v.seq ?? ''}${v.amount ? ' of <b>' + esc(v.amount) + '</b>' : ''} for ${what} is ready to pay on the link.</p>`, button: 'PAY ON THE LINK' },
    'quote-expiring': pt
      ? { subject: `Seu orçamento ${v.code} vence${v.until ? ' em ' + v.until : ' em breve'}`, body: `<p>O orçamento ${what} vale até <b>${esc(v.until || '—')}</b>. Se quiser seguir, é só abrir e aprovar; se precisar de mais tempo, peça pelo link.</p>`, button: 'VER MEU ORÇAMENTO' }
      : { subject: `Your quote ${v.code} expires${v.until ? ' on ' + v.until : ' soon'}`, body: `<p>Quote ${what} is valid until <b>${esc(v.until || '—')}</b>. To go ahead, just open and approve it; if you need more time, ask on the link.</p>`, button: 'VIEW MY QUOTE' },
    'change-order': pt
      ? { subject: `Alteração no seu projeto — ${v.code}`, body: `<p>Preparamos uma alteração em ${what}${v.seq ? ` (versão ${v.seq})` : ''}. Abra o link para ver o que muda e aprovar.</p>`, button: 'VER A ALTERAÇÃO' }
      : { subject: `A change to your project — ${v.code}`, body: `<p>We prepared a change to ${what}${v.seq ? ` (version ${v.seq})` : ''}. Open the link to see what changes and approve it.</p>`, button: 'SEE THE CHANGE' },
  }
  const c = C[kind]
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:560px;line-height:1.5">${hi}${c.body}${btn(c.button)}` +
    `<p style="font-size:12px;color:#666">${pt ? 'Se o botão não abrir, copie este endereço no navegador:' : "If the button doesn't open, copy this address into your browser:"}<br/><a href="${esc(v.link)}">${esc(v.link)}</a></p>` +
    `<p style="margin-top:32px">${pt ? 'Obrigado,' : 'Thank you,'}<br/><b>GZ28 V8 SpeedShop</b><br/>11320 Space Blvd, Orlando, FL 32837<br/>(321) 315-0973</p></div>`
  return { subject: c.subject, html }
}

export async function buildPortalMail(db: SupabaseClient, kind: PortalMailKind, invoiceId: string, o: { human: boolean; attemptId?: string | null }): Promise<PortalMail | Fail> {
  const s = await loadDocState(db, invoiceId)
  if (!s) return { error: 'document not found', status: 404 }
  const link = s.liveLink
  if (!link) return { error: 'no live portal link — SEND in /doc first', status: 409 }
  const isTest = !!link.is_test
  // recipient: the client on file — never from the request
  const c = s.bundle.client
  const to = String(c?.email || '').trim()
  if (!to) return { error: 'client has no email on file', status: 400 }
  // the gates (all keys are OFF until the owner flips them)
  if (isTest) {
    const targets = (await readSetting<string[]>('notify.test_targets')) || []
    if (!Array.isArray(targets) || !targets.map(t => String(t).toLowerCase()).includes(to.toLowerCase())) return { error: 'test document: recipient not in notify.test_targets', status: 403 }
  } else if (!(await settingOn('quote_portal.enabled'))) return { error: 'quote_portal.enabled is OFF', status: 403 }
  if (!(kind === 'quote-link' && o.human) && !(await settingOn(KEY[kind]))) return { error: `${KEY[kind]} is OFF`, status: 403 }

  const lang = (s.terms?.language || 'en') as Lang
  const rev = s.live
  const { data: tok } = await db.from('quote_links').select('token').eq('id', link.id).maybeSingle()
  if (!tok?.token) return { error: 'link token unreadable', status: 500 }
  const v = { first: firstName(c?.name), code: rev?.document?.header?.display_code || s.bundle.invoice.invoice_code || '', car: rev?.document?.header?.car || '', link: publicUrl(tok.token), until: s.terms?.valid_until ? fmtDay(s.terms.valid_until, lang) : undefined } as Parameters<typeof portalMailCopy>[2]
  const attachments: { name: string; base64: string }[] = []
  if (kind === 'quote-link' || kind === 'quote-signed' || kind === 'change-order') {
    if (!rev) return { error: 'no live revision', status: 409 }
    if (kind === 'quote-signed' && !s.approvals.some((a: any) => a.revision_id === rev.id)) return { error: 'not signed', status: 409 }
    const pdf = await clientRevisionPdf(db, s)
    if (pdf) attachments.push({ name: pdf.name, base64: pdf.buf.toString('base64') })
    v.seq = rev.seq
  }
  if (kind === 'deposit-receipt') {
    const a = o.attemptId ? s.attempts.find((x: any) => x.id === o.attemptId && x.status === 'SUCCEEDED') : [...s.attempts].reverse().find((x: any) => x.status === 'SUCCEEDED')
    if (!a) return { error: 'no succeeded payment', status: 409 }
    const r = await attemptReceiptPdf(db, s, a.id)
    if (r) attachments.push({ name: r.name, base64: r.buf.toString('base64') })
    v.amount = moneyCents(Number(a.amount_cents), lang); v.seq = a.seq ?? null
  }
  if (kind === 'installment-due') {
    const paid = s.stage.paidBySeq || {}
    const next = ((rev?.document?.installments || []) as any[]).find(i => !paid[i.seq])
    if (!next) return { error: 'no unpaid installment', status: 409 }
    v.amount = moneyCents(Number(next.amount_cents), lang); v.seq = Number(next.seq)
  }
  if (kind === 'quote-expiring' && !s.terms?.valid_until) return { error: 'no valid_until', status: 409 }
  const { subject, html } = portalMailCopy(kind, lang, v)
  return { to, subject, html, attachments, invoiceId, revisionId: rev?.id || null, isTest }
}
