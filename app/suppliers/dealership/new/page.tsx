'use client'

import Header from '@/components/Header'
import DealershipForm from '@/components/DealershipForm'

export default function NewDealershipPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">NEW DEALERSHIP SUPPLIER</h1>
      <DealershipForm />
    </main>
  )
}
