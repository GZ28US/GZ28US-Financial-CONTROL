'use client'

// FIN SYNC ▸ AUTOBOOK (Márcio, 2026-09-10): página nova, ainda sem conteúdo.
// Fica marcada EM DESENVOLVIMENTO (o mesmo selo âmbar das páginas em construção)
// até o escopo ser definido.
import Header from '@/components/Header'

export default function AutoBookPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-3 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">AUTOBOOK</h1>
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>
      </div>
    </main>
  )
}
