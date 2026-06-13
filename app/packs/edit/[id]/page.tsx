'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Header from '@/components/Header'
import PackForm, { PackData } from '@/components/PackForm'
import { supabase } from '@/lib/supabase'

export default function EditPackPage() {
  const params = useParams()
  const id = String(params.id || '')
  const [pack, setPack] = useState<PackData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => { if (id) load(id) }, [id])

  async function load(packId: string) {
    const { data } = await supabase.from('packs').select('*').eq('id', packId).maybeSingle()
    if (!data) { setNotFound(true); setLoading(false); return }
    setPack({
      name: data.name || '',
      status: data.status || 'DRAFT',
      cars: Array.isArray(data.cars) ? data.cars : [],
      target_grand_total: data.target_grand_total ?? null,
      florida_taxes: data.florida_taxes ?? null,
      global_discount: data.global_discount ?? null,
      import_margin: data.import_margin ?? 0,
      parts: data.parts || [],
      services: data.services || [],
      expenses: data.expenses || [],
      notes: data.notes || [],
    })
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">EDIT PACK</h1>
      {loading ? (
        <p className="text-xl text-gray-400">Loading...</p>
      ) : notFound ? (
        <p className="text-xl text-gray-400">Pack not found.</p>
      ) : (
        <PackForm packId={id} initial={pack!} />
      )}
    </main>
  )
}
