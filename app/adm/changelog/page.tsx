'use client'

// CHANGELOG — a história dos três tracks num lugar só (ADM → CHANGELOG).
//   CONTROL APP  núcleo maduro (invoices, rides, custos…)   lib/appVersion
//   FINANCIAL    demonstrações em desenvolvimento           lib/finVersion
//   DATA CHECK   bancada de dados, produto próprio          lib/dcVersion
// Cada track bumpa no seu arquivo; esta tela só lê e lista.
import Header from '@/components/Header'
import { APP_STAGE, APP_VERSION, APP_CHANGELOG } from '@/lib/appVersion'
import { FIN_STAGE, FIN_VERSION, FIN_CHANGELOG } from '@/lib/finVersion'
import { DC_STAGE, DC_VERSION, DC_CHANGELOG } from '@/lib/dcVersion'

type Entry = { version: string; date: string; notes: string }
const TRACKS: { title: string; stage: string; version: string; cls: string; accent: string; entries: Entry[] }[] = [
  { title: 'CONTROL APP', stage: APP_STAGE, version: APP_VERSION, cls: 'bg-emerald-950 text-emerald-400 border-emerald-700', accent: 'text-emerald-300', entries: APP_CHANGELOG },
  { title: 'FINANCIAL', stage: FIN_STAGE, version: FIN_VERSION, cls: 'bg-purple-950 text-purple-300 border-purple-700', accent: 'text-purple-300', entries: FIN_CHANGELOG },
  { title: 'DATA CHECK', stage: DC_STAGE, version: DC_VERSION, cls: 'bg-sky-950 text-sky-300 border-sky-700', accent: 'text-sky-300', entries: DC_CHANGELOG },
]

export default function ChangelogPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <h1 className="text-4xl font-bold mb-1">CHANGELOG</h1>
      <p className="text-gray-400 mb-8 max-w-3xl">Os três tracks de versão do sistema — o núcleo do app e os dois produtos em desenvolvimento. Cada patch bumpa o track certo: demonstrações no FINANCIAL, bancada no DATA CHECK, o resto é CONTROL APP.</p>

      <div className="space-y-10 max-w-5xl">
        {TRACKS.map(t => (
          <div key={t.title}>
            <div className="flex items-baseline gap-3 flex-wrap mb-3">
              <h2 className="text-2xl font-bold">{t.title}</h2>
              <span className={`px-3 py-1 rounded-full text-xs font-bold border ${t.cls}`}>{t.stage} · v{t.version}</span>
              <span className="text-sm text-gray-500">{t.entries.length} versõe{t.entries.length > 1 ? 's' : ''}</span>
            </div>
            <div className="border border-gray-800 rounded-2xl divide-y divide-gray-800">
              {t.entries.map(c => (
                <div key={c.version} className="px-4 py-3 flex gap-4 items-baseline">
                  <span className={`font-bold tabular-nums w-16 shrink-0 ${t.accent}`}>v{c.version}</span>
                  <span className="text-gray-500 text-xs w-20 shrink-0">{c.date}</span>
                  <span className="text-sm text-gray-400">{c.notes}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
