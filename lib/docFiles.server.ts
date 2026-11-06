/* eslint-disable @typescript-eslint/no-explicit-any */
// SERVER-ONLY — where the portal's PDFs live (06/11/2026; M2). Private bucket `client-docs` (never public: the other buckets are
// public and their URLs are guessable — this one is served only through the gated routes). Client copies are stored once and
// re-served (same bytes, same hash); the staff copy with the FULL certificate is generated on demand and never stored.
import type { SupabaseClient } from '@supabase/supabase-js'
import { revisionPdf, receiptPdf, pdfSha, type CertMode } from './docPdf.server'
import type { DocState } from './quoteDoc.server'
import type { Lang } from './quoteStrings'

const BUCKET = 'client-docs'

async function fromStore(db: SupabaseClient, path: string): Promise<Buffer | null> {
  const { data, error } = await db.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}
async function toStore(db: SupabaseClient, path: string, buf: Buffer) {
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: 'application/pdf', upsert: true })
  if (error) console.error('[client-docs] upload', path, error.message)
  return !error
}

// The client copy of the live (or given) revision: signed copy when an approval exists, plain otherwise.
export async function clientRevisionPdf(db: SupabaseClient, s: DocState, revSeq?: number): Promise<{ buf: Buffer; name: string } | null> {
  const rev = revSeq ? s.revisions.find(r => r.seq === revSeq && r.kind !== 'LEGACY_BACKUP') : s.live
  if (!rev) return null
  const ap = s.approvals.find(a => a.revision_id === rev.id) || null
  const code = rev.document?.header?.display_code || rev.document?.header?.code || 'quote'
  const name = `${code} rev ${rev.seq}${ap ? ' signed' : ''}.pdf`
  const path = `${s.bundle.invoice.id}/rev-${rev.seq}${ap ? '-signed' : ''}.pdf`
  const stored = ap ? ap.signed_pdf_path : rev.pdf_path
  if (stored) { const b = await fromStore(db, stored); if (b) return { buf: b, name } }
  const buf = revisionPdf({ document: rev.document, seq: rev.seq, sha256: rev.sha256, approval: ap, cert: ap ? 'public' : 'none', incomesPaid: s.stage.paidBySeq })
  if (await toStore(db, path, buf)) {
    if (ap) await db.from('invoice_approvals').update({ signed_pdf_path: path, signed_pdf_sha256: pdfSha(buf) }).eq('id', ap.id)
    else await db.from('invoice_revisions').update({ pdf_path: path, pdf_sha256: pdfSha(buf) }).eq('id', rev.id)
  }
  return { buf, name }
}

export function staffRevisionPdf(s: DocState, revSeq?: number, cert: CertMode = 'full'): { buf: Buffer; name: string } | null {
  const rev = revSeq ? s.revisions.find(r => r.seq === revSeq && r.kind !== 'LEGACY_BACKUP') : s.live
  if (!rev) return null
  const ap = s.approvals.find(a => a.revision_id === rev.id) || null
  const code = rev.document?.header?.display_code || rev.document?.header?.code || 'quote'
  return { buf: revisionPdf({ document: rev.document, seq: rev.seq, sha256: rev.sha256, approval: ap, cert, incomesPaid: s.stage.paidBySeq }), name: `${code} rev ${rev.seq} STAFF.pdf` }
}

export async function attemptReceiptPdf(db: SupabaseClient, s: DocState, attemptId: string): Promise<{ buf: Buffer; name: string } | null> {
  const a = s.attempts.find(x => x.id === attemptId && x.status === 'SUCCEEDED')
  if (!a) return null
  const rev = s.revisions.find(r => r.id === a.revision_id) || s.live
  if (!rev) return null
  const path = `${s.bundle.invoice.id}/receipt-${a.id}.pdf`
  const name = `${rev.document?.header?.display_code || 'quote'} receipt ${a.seq ?? ''}.pdf`.replace(/\s+\.pdf$/, '.pdf')
  const stored = await fromStore(db, path)
  if (stored) return { buf: stored, name }
  const buf = receiptPdf({ document: rev.document, attempt: a, lang: (s.terms?.language || 'en') as Lang })
  await toStore(db, path, buf)
  return { buf, name }
}

export const pdfResponseHeaders = (name: string) => ({
  'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name.replace(/[^\w .()-]/g, '')}"`,
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
})
