/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — the CONSEQUENCES of a hire (06/11/2026; blueprint §3.4). The money and the flags already committed inside
// book_payment()/quote_hire(); this ladder runs AFTER (Next `after()`), each step logged as invoice_events SIDE_EFFECT
// {step, status, reason}. docs-housekeeping retries the ones that failed. A TEST document (quote_links.is_test) skips every step
// that touches the outside world (Dropbox, e-mail folders, the BR database). Nothing here messages anyone.
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceDb } from './quoteDoc.server'
import { selfCallHeaders } from './apiAuth.server'
import { supabaseBRService } from './supabaseBR.server'

const SELF = () => process.env.GZ28_SELF_URL || 'https://www.gz28us.com/ca'

async function step(db: SupabaseClient, invoiceId: string, name: string, fn: () => Promise<string>) {
  let status = 'done', reason = ''
  try { reason = await fn() } catch (e) { status = 'failed'; reason = String((e as Error)?.message || e).slice(0, 300) }
  await db.rpc('doc_event', { p_invoice: invoiceId, p_revision: null, p_kind: 'SIDE_EFFECT', p_actor: 'SYSTEM', p_actor_id: null,
    p_payload: { step: name, status, reason } })
  return status === 'done'
}
async function post(path: string, body: unknown) {
  const r = await fetch(SELF() + path, { method: 'POST', headers: selfCallHeaders(), body: JSON.stringify(body) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 200)}`)
  return t.slice(0, 200)
}

export async function afterHire(invoiceId: string, hire: Record<string, any>, only?: string[]) {
  const db = serviceDb()
  const { data: links } = await db.from('quote_links').select('is_test').eq('invoice_id', invoiceId)
  const isTest = (links || []).some(l => l.is_test)
  const { data: inv } = await db.from('invoices').select('id, invoice_code, service, ride_id').eq('id', invoiceId).maybeSingle()
  if (!inv) return
  const { data: ride } = inv.ride_id ? await db.from('rides').select('id, project_code, project_name').eq('id', inv.ride_id).maybeSingle() : { data: null }
  const want = (s: string) => !only || only.includes(s)
  const skip = async (s: string) => db.rpc('doc_event', { p_invoice: invoiceId, p_revision: null, p_kind: 'SIDE_EFFECT', p_actor: 'SYSTEM', p_actor_id: null,
    p_payload: { step: s, status: 'skipped', reason: 'test' } })
  const newCode = hire.new_code as string | null
  // M4 switchboard: the deposit's messages decide by their keys (all OFF → NOTIFY_SKIPPED events, nothing sent)
  // 11/11/2026: a hire born at the SIGNATURE has no money yet — the deposit's messages wait for the payment (afterPayment below).
  if (!hire.signed) try { const { notifyAll } = await import('./notify.server'); await notifyAll(db, ['notify.client.deposit_received', 'notify.reports.deposit_received'], { invoiceId, attemptId: hire.attempt_id || null }) } catch (e) { console.error('[hire notify]', (e as Error).message) }
  if (isTest) { for (const s of ['1-ride-folder', '2-invoice-folders', '2s-shopping-folder', '3b-br-mirror', '4-seed-pack', '5-dropbox-docs']) if (want(s)) await skip(s); return }
  if (ride && newCode && want('1-ride-folder')) {
    // create also syncs the car's e-mail folders (ride-folder → syncMailFolder → ensureRideMailFolders) = step 3
    await step(db, invoiceId, '1-ride-folder', () => post('/api/ride-folder', { action: 'create', zone: 'US', code: newCode, name: ride.project_name || '' }))
  }
  if (ride && want('2-invoice-folders')) {
    const { data: invs } = await db.from('invoices').select('id, invoice_code, service').eq('ride_id', ride.id)
    await step(db, invoiceId, '2-invoice-folders', async () => {
      const out: string[] = []
      for (const i of invs || []) {
        await post('/api/ride-folder', { action: 'invoice-folder', zone: 'US', code: ride.project_code, name: ride.project_name || '', invoiceCode: i.invoice_code,
          invoiceName: i.service || '', oldInvoiceCode: newCode && hire.old_code ? String(i.invoice_code).replace(newCode, hire.old_code) : undefined })
        out.push(i.invoice_code)
      }
      return out.join(', ')
    })
  }
  if (ride && newCode && hire.old_code && want('3b-br-mirror')) {
    await step(db, invoiceId, '3b-br-mirror', async () => {
      const br = supabaseBRService()
      if (!br) throw new Error('SUPABASE_BR_SERVICE_ROLE_KEY missing — BR mirror not recoded')
      const { data: brs, error } = await br.from('rides').select('id').eq('project_code', hire.old_code).limit(2)
      if (error) throw new Error(error.message)
      if (!brs?.length) return 'no BR mirror'
      if (brs.length > 1) throw new Error('more than one BR ride with ' + hire.old_code)
      const { data: busy } = await br.from('rides').select('id').eq('project_code', newCode).limit(1)
      if (busy?.length) throw new Error(`${newCode} already exists in the BR app`)
      const { error: e1 } = await br.from('rides').update({ project_code: newCode }).eq('id', brs[0].id)
      if (e1) throw new Error(e1.message)
      const { data: binvs } = await br.from('invoices').select('id, invoice_code').eq('ride_id', brs[0].id)
      for (const b of binvs || []) if (String(b.invoice_code || '').startsWith(hire.old_code + '.')) {
        await br.from('invoices').update({ invoice_code: newCode + String(b.invoice_code).slice(hire.old_code.length) }).eq('id', b.id)
      }
      return `BR ride ${hire.old_code} → ${newCode} (Dropbox BR folder: rename by the renumber route if it exists)`
    })
  }
  // 2s (11/11/2026): a SHOPPING invoice (no car) lives in «GZ28US Shopping/<client>/<code>» — folder, signed copy, deposit receipt.
  if (!ride && (want('2s-shopping-folder') || want('5-dropbox-docs'))) {
    await step(db, invoiceId, '2s-shopping-folder', async () => {
      const { loadDocState } = await import('./quoteDoc.server')
      const { clientRevisionPdf, attemptReceiptPdf } = await import('./docFiles.server')
      const s = await loadDocState(db, invoiceId)
      if (!s) throw new Error('document not found')
      const clientName = String(s.bundle.client?.name || '').trim()
      if (!clientName) throw new Error('client has no name')
      const code = String(s.bundle.invoice.invoice_code || '')
      const base = { action: 'shopping-folder', zone: 'US', code, clientName, oldInvoiceCode: hire.invoice_code_before || undefined }
      const out = [await post('/api/ride-folder', base)]
      const files: { filename: string; buf: Buffer }[] = []
      const signed = await clientRevisionPdf(db, s)
      if (signed) files.push({ filename: `${code} ${clientName} - Quote rev ${s.live?.seq ?? ''} signed.pdf`.replace(/\s+/g, ' '), buf: signed.buf })
      const paidAttempt = s.attempts.find(a => a.status === 'SUCCEEDED' && a.id === hire.attempt_id) || s.attempts.find(a => a.status === 'SUCCEEDED')
      if (paidAttempt) { const rc = await attemptReceiptPdf(db, s, paidAttempt.id); if (rc) files.push({ filename: `${code} ${clientName} - Deposit receipt.pdf`.replace(/\s+/g, ' '), buf: rc.buf }) }
      for (const f of files) await post('/api/ride-folder', { ...base, oldInvoiceCode: undefined, filename: f.filename, contentBase64: f.buf.toString('base64') })
      return out[0] + (files.length ? ' · ' + files.map(f => f.filename).join(' · ') : '')
    })
  }
  if (want('4-seed-pack')) await step(db, invoiceId, '4-seed-pack', () => post('/api/performance/seed-pack', { invoiceId }))
  // 5 (M2): the signed copy and the deposit receipt go into the car's «Invoices/<code> - <service>» folder (C-53 naming).
  if (ride && want('5-dropbox-docs')) {
    await step(db, invoiceId, '5-dropbox-docs', async () => {
      const { loadDocState } = await import('./quoteDoc.server')
      const { clientRevisionPdf, attemptReceiptPdf } = await import('./docFiles.server')
      const s = await loadDocState(db, invoiceId)
      if (!s) throw new Error('document not found')
      const { data: r2 } = await db.from('rides').select('project_code, project_name').eq('id', ride.id).maybeSingle()
      const code = String(s.bundle.invoice.invoice_code || ''), car = String(r2?.project_name || '')
      const files: { filename: string; buf: Buffer }[] = []
      const signed = await clientRevisionPdf(db, s)
      if (signed) files.push({ filename: `${code} ${car} - Quote rev ${s.live?.seq ?? ''} signed.pdf`.replace(/\s+/g, ' '), buf: signed.buf })
      const paidAttempt = s.attempts.find(a => a.status === 'SUCCEEDED' && a.id === hire.attempt_id) || s.attempts.find(a => a.status === 'SUCCEEDED')
      if (paidAttempt) { const rc = await attemptReceiptPdf(db, s, paidAttempt.id); if (rc) files.push({ filename: `${code} ${car} - Deposit receipt.pdf`.replace(/\s+/g, ' '), buf: rc.buf }) }
      for (const f of files) await post('/api/ride-folder', { action: 'upload', zone: 'US', code: r2?.project_code, name: car, invoiceCode: code,
        invoiceName: s.bundle.invoice.service || '', filename: f.filename, contentBase64: f.buf.toString('base64') })
      return files.map(f => f.filename).join(' · ')
    })
  }
}

// ── THE APPROVAL HIRES (Márcio, 11/11/2026: «whenever a client signs/agree to a quote, the app should send me an email with this
// report... the official report that the quote has been approved and hired. At this point, it must become a real invoice, with the
// hiring date»). quote_approve() already hired inside its transaction (quote_hire_signed → event HIRED {by:'SIGNATURE'}); this runs
// AFTER the response: the same consequences ladder (folders, BR mirror, pack, signed PDF in the car's folder) and the report e-mail.
export const HIRE_REPORT_TO = 'gz28us@gmail.com'
const escH = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function afterSign(invoiceId: string) {
  const db = serviceDb()
  const { data: ev } = await db.from('invoice_events').select('payload, at').eq('invoice_id', invoiceId).eq('kind', 'HIRED').order('at', { ascending: false }).limit(1)
  const p = (ev?.[0]?.payload || null) as Record<string, any> | null
  if (!p || p.by !== 'SIGNATURE') return                      // a change order, or a document that was already an invoice
  await afterHire(invoiceId, { ...p, hired: true, signed: true }).catch(e => console.error('[sign ladder]', invoiceId, (e as Error)?.message || e))
  await step(db, invoiceId, 'hired-report-mail', () => hiredReportMail(db, invoiceId, p, String(ev![0].at)))
}

// A payment on a document that is ALREADY an invoice (the deposit after a signature hire): the deposit's messages by their keys and
// the receipt into the car's folder. The first installment only — what the hire ladder used to do when the money hired.
export async function afterPayment(invoiceId: string, attemptId: string | null) {
  const db = serviceDb()
  try { const { notifyAll } = await import('./notify.server'); await notifyAll(db, ['notify.client.deposit_received', 'notify.reports.deposit_received'], { invoiceId, attemptId }) } catch (e) { console.error('[payment notify]', (e as Error).message) }
  await afterHire(invoiceId, { signed: true, attempt_id: attemptId }, ['5-dropbox-docs'])
}

async function hiredReportMail(db: SupabaseClient, invoiceId: string, p: Record<string, any>, at: string): Promise<string> {
  const { loadDocState } = await import('./quoteDoc.server')
  const { clientRevisionPdf } = await import('./docFiles.server')
  const { transport } = await import('./notifyTransport.server')
  const s = await loadDocState(db, invoiceId)
  if (!s) throw new Error('document not found')
  const isTest = !!s.liveLink?.is_test || s.isTest
  const rev = s.live, h = rev?.document?.header || {}, c = s.bundle.client || {}
  const ap: Record<string, any> = s.approvalOnLive || s.approvals[s.approvals.length - 1] || {}
  const usd = (n: number) => 'US$ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ap.created_at || ap.signed_at || at)) + ' Orlando'
  const code = String(s.bundle.invoice.invoice_code || p.invoice_code || '')
  const before = String(p.invoice_code_before || p.old_code || '')
  const plan = ((rev?.document?.installments || []) as any[]).map(i => `<tr><td style="padding:2px 14px 2px 0">${escH(i.seq)}. ${escH(i.label_text || i.label || '')}</td><td style="padding:2px 14px 2px 0;text-align:right"><b>${usd(Number(i.amount_cents) / 100)}</b></td><td style="padding:2px 0;color:#555">${escH(i.due_rule === 'DATE' ? i.due_date : String(i.due_rule || '').replace('ON_', 'on ').replace('_', ' ').toLowerCase())}</td></tr>`).join('')
  const method = ap.method === 'CLIENT_ESIGN' ? 'e-signature on the link' : `recorded by ${ap.recorded_by || 'staff'} (${ap.method || '?'})${ap.note ? ' — ' + ap.note : ''}`
  const row = (k: string, v: string) => `<tr><td style="padding:3px 14px 3px 0;color:#555">${k}</td><td style="padding:3px 0"><b>${v}</b></td></tr>`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:620px;line-height:1.5">` +
    `<h2 style="margin:0 0 4px">${isTest ? '🧪 TEST · ' : ''}✅ QUOTE APPROVED &amp; HIRED</h2><p style="margin:0 0 16px;color:#555">Official report — the quote is now a real invoice.</p><table style="border-collapse:collapse">` +
    row('Invoice', escH(code) + (before && before !== code ? ` <span style="color:#555;font-weight:normal">(was quote ${escH(before)})</span>` : '')) +
    row('Client', escH(c.name || '') + (p.client_number ? ` <span style="color:#555;font-weight:normal">· client #${escH(p.client_number)}</span>` : '')) +
    (h.car ? row('Car', escH(h.car)) : '') + (s.bundle.invoice.service ? row('Job', escH(s.bundle.invoice.service)) : '') +
    row('Total', usd(Number(rev?.grand_total || 0))) + row('Approved by', escH(ap.signer_name || '')) + row('How', escH(method)) + row('Approved at', escH(when)) +
    row('Hiring date', escH(p.hiring_date || s.bundle.invoice.hiring_date || '')) + row('Version', 'rev ' + escH(rev?.seq ?? '')) + '</table>' +
    (plan ? `<h3 style="margin:20px 0 6px">Payment plan</h3><table style="border-collapse:collapse">${plan}</table>` : '') +
    `<p style="margin:22px 0"><a href="${PUBLIC_DOC}/${invoiceId}">Open the document in the app</a></p><p style="font-size:12px;color:#666">The signed copy is attached as a PDF. No payment has been recorded by this report.</p></div>`
  const pdf = await clientRevisionPdf(db, s).catch(() => null)
  const err = await transport().email({ to: HIRE_REPORT_TO, subject: `${isTest ? 'TEST · ' : ''}✅ APPROVED & HIRED — ${code}${c.name ? ' · ' + c.name : ''}${h.car ? ' · ' + h.car : ''} · ${usd(Number(rev?.grand_total || 0))}`, html,
    attachments: pdf ? [{ name: pdf.name, base64: pdf.buf.toString('base64') }] : [] })
  if (err) throw new Error(err)
  return 'sent to ' + HIRE_REPORT_TO + (pdf ? ' with ' + pdf.name : ' (no PDF)')
}
const PUBLIC_DOC = 'https://www.gz28us.com/ca/doc'
