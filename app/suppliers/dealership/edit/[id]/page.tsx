'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import DealershipForm, { DealershipData } from '@/components/DealershipForm'
import { supabase } from '@/lib/supabase'

export default function EditDealershipPage() {
  const params = useParams()
  const id = String(params.id || '')
  const [data, setData] = useState<DealershipData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => { if (id) load(id) }, [id])

  async function load(supplierId: string) {
    const { data: row } = await supabase.from('suppliers').select('*').eq('id', supplierId).maybeSingle()
    if (!row) { setNotFound(true); setLoading(false); return }
    setData({
      name: row.name || '',
      aliases: row.aliases || '',
      website: row.website || '',
      seller: row.seller || '',
      phone: row.phone || '',
      email: row.email || '',
      ordering_method: row.ordering_method || '',
      account_number: row.account_number ?? null,
      discount_code: row.discount_code || '',
    })
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT DEALERSHIP SUPPLIER</h1>
      {loading ? (
        <p className="text-xl text-gray-400">Loading...</p>
      ) : notFound ? (
        <p className="text-xl text-gray-400">Supplier not found.</p>
      ) : (
        <DealershipForm supplierId={id} initial={data!} />
      )}
    </main>
  )
}
