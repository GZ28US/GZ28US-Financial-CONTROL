'use client'

// ── CONECTAR CAIXA DE E-MAIL — SÓ COM ADMIN LOGADO (11/set/2026) ───────────
//
// A auditoria de 11/set achou que qualquer pessoa, sem login, abria
// /api/stream/mail-auth (ou gmail-auth), consentia com a PRÓPRIA conta e o
// callback gravava o token dela por cima da caixa da empresa naquele slot — os
// robôs passavam a ler, e a varrer, a caixa de fora.
//
// Agora a conexão começa AQUI. A sessão do app mora no localStorage (não há
// cookie), então um link aberto no navegador não prova quem é: esta tela faz o
// POST com sessionHeaders(), a rota confere o admin (requireUser), devolve a URL
// de consentimento da Microsoft/Google, e só então o navegador vai para lá.
//
// "Replace existing account" é a ordem explícita de TROCAR a conta de um slot
// que já tem dono. Ela viaja dentro do state OAuth, e sem ela o callback recusa
// gravar outra conta por cima (no Gmail, conta diferente vai para a própria
// linha ou para um slot novo, como já ia). Reconectar a MESMA conta — token
// morto, escopo novo — não precisa da marca.
//
// A tela fica atrás do AuthGate (app/layout.tsx), como todo o app.

import { useEffect, useState } from 'react'
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

type Provider = 'outlook' | 'gmail'

const PROVIDERS: { id: Provider; label: string; route: string }[] = [
  { id: 'outlook', label: 'OUTLOOK', route: '/api/stream/mail-auth' },
  { id: 'gmail', label: 'GMAIL', route: '/api/stream/gmail-auth' },
]

export default function ConnectMailboxPage() {
  const [provider, setProvider] = useState<Provider>('outlook')
  const [slot, setSlot] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // O link antigo (/api/stream/mail-auth?slot=N) aponta para cá com provider e
  // slot na URL: a tela chega preenchida, mas quem aperta o botão é gente.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const p = q.get('provider')
    if (p === 'outlook' || p === 'gmail') setProvider(p)
    const s = q.get('slot')
    if (s && /^\d+$/.test(s)) setSlot(s)
  }, [])

  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const raw = slot.trim()
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN
    if (!Number.isInteger(n) || n < 1) {
      setError('Slot must be a whole number, 1 or higher.')
      return
    }
    const route = PROVIDERS.find(x => x.id === provider)!.route
    setBusy(true)
    try {
      const r = await fetch(`${BASE_PATH}${route}`, {
        method: 'POST',
        headers: await sessionHeaders(),
        body: JSON.stringify({ slot: n, replace }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || typeof j?.url !== 'string') {
        setError(j?.error ? String(j.error) : `Could not start the connection (HTTP ${r.status}).`)
        setBusy(false)
        return
      }
      // Sai do app para a tela de consentimento; o callback volta com o resultado.
      window.location.href = j.url
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-1">CONNECT A MAILBOX</h1>
      <p className="text-gray-400 mb-8 max-w-2xl">
        Hooks a mailbox into a STREAM mail slot. After you press the button you will be sent to Microsoft or Google:
        sign in there with the mailbox that belongs in this slot. The result page tells you which account was
        connected and where.
      </p>

      <form onSubmit={connect} className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-3xl p-8 flex flex-col gap-6">
        <div>
          <label className="block mb-2 text-sm font-bold text-gray-400">PROVIDER</label>
          <div className="flex gap-3">
            {PROVIDERS.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProvider(p.id)}
                aria-pressed={provider === p.id}
                className={`flex-1 px-5 py-4 rounded-2xl text-xl font-bold border ${provider === p.id ? 'bg-white text-black border-white' : 'bg-gray-900 text-gray-300 border-gray-700 hover:border-gray-500'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="slot" className="block mb-2 text-sm font-bold text-gray-400">SLOT</label>
          <input
            id="slot"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
            placeholder="e.g. 2"
            required
          />
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          <span>
            <span className="block font-bold">Replace existing account</span>
            <span className="block text-sm text-gray-400">
              Tick only to put a DIFFERENT account into a slot that already has one. Without it, the callback refuses
              to swap accounts{provider === 'gmail' ? ' (a different Google account goes to its own slot or a new one instead)' : ''}.
              Reconnecting the same account does not need it. A replaced mailbox starts with auto sweep OFF.
            </span>
          </span>
        </label>

        {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          {busy ? 'STARTING…' : `CONNECT ${provider === 'gmail' ? 'GMAIL' : 'OUTLOOK'}`}
        </button>
      </form>
    </main>
  )
}
