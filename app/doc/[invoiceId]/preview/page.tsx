'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// /ca/doc/<id>/preview — the client's page exactly as the client sees it, in a phone frame. Nothing is stamped (no VIEWED, no
// cookie) and no button reaches the server.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import QuotePublic from '@/components/quote/QuotePublic'

export default function DocPreview() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const [dto, setDto] = useState<Record<string, any> | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { (async () => {
    const r = await fetch(`${BASE_PATH}/api/doc/${invoiceId}/preview`, { headers: await sessionHeaders() })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setErr(j.error || `HTTP ${r.status}`); else setDto(j)
  })() }, [invoiceId])
  return <div className="min-h-screen bg-gray-900 py-6">
    <div className="text-center mb-3"><Link href={`/doc/${invoiceId}`} className="text-sm text-gray-300 underline">← back to the document</Link></div>
    {err && <p className="text-center text-red-400">{err}</p>}
    {dto && <div className="mx-auto w-[390px] max-w-full h-[780px] overflow-y-auto rounded-[2rem] border-8 border-gray-700 bg-black"><QuotePublic previewDto={dto} /></div>}
  </div>
}
