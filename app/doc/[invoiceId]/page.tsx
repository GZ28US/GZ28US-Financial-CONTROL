'use client'

// /ca/doc/<invoiceId> — RETIRED as a page (10/11/2026, Márcio: «I don't want another area in the app … improve the current quote
// area»). The portal now lives inside the quote screen (components/quote/QuoteStaffPanel embedded in
// app/rides/[id]/invoices/[invoiceId]/page.tsx). Old links (payments, notifications, e-mails) land there.
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function DocRedirect() {
  const { invoiceId } = useParams<{ invoiceId: string }>()
  const router = useRouter()
  const [err, setErr] = useState('')
  useEffect(() => {
    supabase.from('invoices').select('ride_id, client_id').eq('id', invoiceId).maybeSingle().then(({ data, error }) => {
      if (error || !data) { setErr(error?.message || 'document not found'); return }
      router.replace(data.ride_id ? `/rides/${data.ride_id}/invoices/${invoiceId}` : `/clients/${data.client_id}/invoices/${invoiceId}`)
    })
  }, [invoiceId, router])
  return <div className="min-h-screen bg-black text-gray-400 p-8">{err || 'Opening the quote…'}</div>
}
