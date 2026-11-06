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
  if (isTest) { for (const s of ['1-ride-folder', '2-invoice-folders', '3b-br-mirror', '4-seed-pack', '5-dropbox-docs']) if (want(s)) await skip(s); return }
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
      if (signed) files.push({ filename: `${code} ${car} - Quote rev ${s.live?.seq ?? ''} signed.pdf`.replace(/s+/g, ' '), buf: signed.buf })
      const paidAttempt = s.attempts.find(a => a.status === 'SUCCEEDED' && a.id === hire.attempt_id) || s.attempts.find(a => a.status === 'SUCCEEDED')
      if (paidAttempt) { const rc = await attemptReceiptPdf(db, s, paidAttempt.id); if (rc) files.push({ filename: `${code} ${car} - Deposit receipt.pdf`.replace(/s+/g, ' '), buf: rc.buf }) }
      for (const f of files) await post('/api/ride-folder', { action: 'upload', zone: 'US', code: r2?.project_code, name: car, invoiceCode: code,
        invoiceName: s.bundle.invoice.service || '', filename: f.filename, contentBase64: f.buf.toString('base64') })
      return files.map(f => f.filename).join(' · ')
    })
  }
}
