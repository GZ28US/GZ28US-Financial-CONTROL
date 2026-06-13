'use client'

import Header from '@/components/Header'
import PackForm from '@/components/PackForm'

export default function NewPackPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">ADD A NEW PACK</h1>
      <PackForm />
    </main>
  )
}
