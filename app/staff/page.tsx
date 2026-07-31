'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD, toWaNumber } from '@/lib/utils'

type StaffMember = {
  id: string
  staff_code: string | null
  name: string
  position: string
  phone: string | null
  latestConclusion: string | null
  latestEntry: string | null
  hasActiveSeason: boolean
  hasAnySeason: boolean
  totalExpenses: number
}

export default function StaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [globalTotal, setGlobalTotal] = useState(0)
  const [sendChooserFor, setSendChooserFor] = useState<StaffMember | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sentId, setSentId] = useState<string | null>(null)

  // 📲 SEND — WhatsApp the member a link to their OWN self-service form
  // (/staff/self/[id]) so they fill in their data and save (US port of the BR
  // feature, 31/jul/2026). The chooser picks who gets it: the member, the
  // internal REPORTS group, or both. The invite is bilingual — the crew is
  // mostly Brazilian.
  async function handleSendForm(member: StaffMember, target: 'MEMBER' | 'REPORTS' | 'BOTH') {
    setSendChooserFor(null)
    const link = `${window.location.origin}${BASE_PATH}/staff/self/${member.id}`
    const firstName = (member.name || '').split(' ')[0]
    const memberBody = `Hi${firstName ? ` ${firstName}` : ''}! 👋\n\nTo complete your registration at *_GZ28 V8 SpeedShop_*, please fill in your details at this link and tap *SAVE*:\n\n${link}\n\n_Para concluir seu cadastro, preencha seus dados neste link e toque em *SALVAR*._\n\nThank you! / Obrigado!`
    const groupBody = `📋 *STAFF FORM — MEMBER LINK*\n${member.name || '—'}\nSelf-service form link:\n${link}`
    setSendingId(member.id)
    try {
      if (target === 'REPORTS' || target === 'BOTH') {
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: groupBody }),
        })
        const data = await res.json().catch(() => ({}))
        if (!data.ok) { alert('Failed to send to the REPORTS group.'); setSendingId(null); return }
        if (target === 'REPORTS') { setSentId(member.id); setTimeout(() => setSentId(null), 3000); setSendingId(null); return }
      }
      const to = toWaNumber(member.phone)
      if (!to) { alert('This staff member has no phone / WhatsApp on file.\nAdd a number first (EDIT).'); setSendingId(null); return }
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, body: memberBody }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) {
        const detail = typeof data?.detail?.error === 'object' ? JSON.stringify(data.detail.error) : String(data?.detail?.error || data?.error || `HTTP ${res.status}`)
        alert('Could not send the link:\n' + detail); setSendingId(null); return
      }
      setSentId(member.id); setTimeout(() => setSentId(null), 3000)
    } catch (e) {
      alert('Failed to send: ' + String(e))
    }
    setSendingId(null)
  }

  useEffect(() => {
    loadStaff()
  }, [])

  async function loadStaff() {
    const { data: staffData } = await supabase
      .from('staff')
      .select('*')
      .order('name', { ascending: true })

    if (!staffData) {
      setLoading(false)
      return
    }

    const { data: seasonsData } = await supabase
      .from('seasons')
      .select('id, staff_id, date_entry, date_conclusion')

    const allSeasonIds = seasonsData?.map(s => s.id) || []

    let expensesData: any[] = []
    if (allSeasonIds.length > 0) {
      const { data } = await supabase
        .from('expenses')
        .select('id, season_id, type, amount, expense_date')
        .in('season_id', allSeasonIds)
      expensesData = data || []
    }

    // Custo da season = SOMA DOS PAGAMENTOS REAIS (ordem do Márcio, 28/jul/2026).
    // Antes, uma linha WEEKLY era uma TAXA e a página projetava valor × dias÷7 pra
    // sempre — o Kaue aparecia custando um número que ninguém conseguia conferir,
    // sem data e sem comprovante. Agora a taxa vive na season (pay_type/pay_rate)
    // e cada pagamento é uma linha com data própria, paga ou em aberto.
    function calcSeasonTotal(seasonId: string): number {
      return expensesData
        .filter(e => e.season_id === seasonId)
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
    }

    const staffWithData: StaffMember[] = staffData.map((member) => {
      const memberSeasons = seasonsData?.filter(s => s.staff_id === member.id) || []
      const hasAnySeason = memberSeasons.length > 0
      const hasActiveSeason = memberSeasons.some(s => !s.date_conclusion)

      const concluded = memberSeasons
        .filter(s => s.date_conclusion)
        .map(s => s.date_conclusion as string)
        .sort((a, b) => b.localeCompare(a))
      const latestConclusion = concluded[0] || null

      const entries = memberSeasons
        .filter(s => s.date_entry)
        .map(s => s.date_entry as string)
        .sort((a, b) => b.localeCompare(a))
      const latestEntry = entries[0] || null

      const totalExpenses = memberSeasons.reduce((sum, s) => sum + calcSeasonTotal(s.id), 0)

      return {
        ...member,
        latestConclusion,
        latestEntry,
        hasActiveSeason,
        hasAnySeason,
        totalExpenses,
      }
    })

    staffWithData.sort((a, b) => {
      // 1. Active seasons first
      if (a.hasActiveSeason && !b.hasActiveSeason) return -1
      if (!a.hasActiveSeason && b.hasActiveSeason) return 1

      // 2. Both active — sort by latest entry descending
      if (a.hasActiveSeason && b.hasActiveSeason) {
        if (a.latestEntry && b.latestEntry) return b.latestEntry.localeCompare(a.latestEntry)
        if (a.latestEntry) return -1
        if (b.latestEntry) return 1
        return a.name.localeCompare(b.name)
      }

      // 3. Both concluded — sort by latest conclusion descending
      if (a.hasAnySeason && b.hasAnySeason) {
        if (a.latestConclusion && b.latestConclusion) return b.latestConclusion.localeCompare(a.latestConclusion)
        if (a.latestConclusion) return -1
        if (b.latestConclusion) return 1
        return a.name.localeCompare(b.name)
      }

      // 4. Members with no seasons go to the bottom
      if (a.hasAnySeason && !b.hasAnySeason) return -1
      if (!a.hasAnySeason && b.hasAnySeason) return 1

      return a.name.localeCompare(b.name)
    })

    const total = staffWithData.reduce((sum, m) => sum + m.totalExpenses, 0)
    setGlobalTotal(total)
    setStaff(staffWithData)
    setLoading(false)
  }

  async function removeStaff(id: string) {
    const { error } = await supabase
      .from('staff')
      .delete()
      .eq('id', id)

    if (error) {
      alert(error.message)
      return
    }

    setConfirmId(null)
    loadStaff()
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {sendChooserFor && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Send the form link</h2>
            <p className="text-gray-400 text-lg mb-6">{sendChooserFor.name} — who should receive the self-service form link?</p>
            <div className="flex flex-col gap-3">
              <button onClick={() => handleSendForm(sendChooserFor, 'MEMBER')} className="bg-green-700 hover:bg-green-600 px-5 py-4 rounded-2xl font-bold text-xl">📲 THE MEMBER (WhatsApp)</button>
              <button onClick={() => handleSendForm(sendChooserFor, 'REPORTS')} className="bg-blue-700 hover:bg-blue-600 px-5 py-4 rounded-2xl font-bold text-xl">📋 REPORTS GROUP</button>
              <button onClick={() => handleSendForm(sendChooserFor, 'BOTH')} className="bg-purple-700 hover:bg-purple-600 px-5 py-4 rounded-2xl font-bold text-xl">BOTH</button>
              <button onClick={() => setSendChooserFor(null)} className="bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl">CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {confirmId && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full mx-4">
            <h2 className="text-2xl font-bold mb-2">Remove Staff Member</h2>
            <p className="text-gray-400 text-lg mb-8">Are you sure you want to remove this staff member? This action cannot be undone.</p>
            <div className="flex gap-4">
              <button
                onClick={() => setConfirmId(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                CANCEL
              </button>
              <button
                onClick={() => removeStaff(confirmId)}
                className="flex-1 bg-red-700 hover:bg-red-600 px-5 py-4 rounded-2xl font-bold text-xl"
              >
                REMOVE
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold">
          STAFF ({staff.length})
        </h1>

        <Link
          href="/staff/new"
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          ADD A NEW STAFF MEMBER
        </Link>
      </div>

      {staff.length > 0 && (
        <div className="bg-red-700 rounded-3xl p-6 mb-8 max-w-sm">
          <p className="text-xl font-bold">GLOBAL EXPENSES TOTAL</p>
          <p className="text-5xl font-bold">{formatUSD(globalTotal)}</p>
        </div>
      )}

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : staff.length === 0 ? (
        <p className="text-2xl text-gray-400">No staff members yet.</p>
      ) : (
        <div className="space-y-5">
          {staff.map((member) => (
            <div
              key={member.id}
              className="bg-gray-900 border border-gray-800 rounded-3xl p-6 flex items-center justify-between"
            >
              <div>
                {member.staff_code && <p className="text-sm text-gray-500 font-bold">{member.staff_code}</p>}
                <h2 className="text-2xl font-bold">{member.name}</h2>
                <p className="text-lg text-gray-400">{member.position}</p>
              </div>

              <div className="bg-red-700 rounded-2xl px-6 py-4 text-center">
                <p className="text-sm font-bold">GLOBAL EXPENSES TOTAL</p>
                <p className="text-3xl font-bold">{formatUSD(member.totalExpenses)}</p>
              </div>

              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={() => setSendChooserFor(member)}
                  disabled={sendingId === member.id || sentId === member.id}
                  className={`disabled:opacity-60 px-5 py-3 rounded-2xl font-bold ${sentId === member.id ? 'bg-green-600' : 'bg-green-700 hover:bg-green-600'}`}
                >
                  {sendingId === member.id ? 'SENDING…' : sentId === member.id ? '✓ SENT' : '📲 SEND'}
                </button>

                <Link
                  href={`/staff/edit/${member.id}`}
                  className="bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold"
                >
                  EDIT
                </Link>

                <button
                  onClick={() => setConfirmId(member.id)}
                  className="bg-red-700 hover:bg-red-600 px-5 py-3 rounded-2xl font-bold"
                >
                  REMOVE
                </button>

                <Link
                  href={`/staff/${member.id}/seasons`}
                  className="bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold"
                >
                  SEASONS
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}