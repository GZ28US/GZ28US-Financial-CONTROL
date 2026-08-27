'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

// A PASSAGEM DA SEASON (Márcio, 27/ago/2026). Uma season já é uma viagem real,
// então é aqui que o voo mora — e não enfiado no texto da descrição da expense,
// que é onde ele estava. Ninguém consegue mandar pro membro um localizador que
// está no meio de um parágrafo.
//
// Os horários são de RELÓGIO LOCAL de cada aeroporto: sai 12:25 em Campinas e
// chega 20:30 em Orlando. Por isso datetime-local e coluna `timestamp` sem fuso
// — nada aqui é convertido, nem na ida nem na volta.

const inputClass = 'w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-4 text-xl'
const smallLabel = 'block mb-2 text-sm text-gray-400'

type Flight = {
  id?: string
  direction: string
  locator: string
  booking_ref: string
  airline: string
  flight_number: string
  operated_by: string
  from_city: string
  from_airport: string
  to_city: string
  to_airport: string
  departure_local: string
  arrival_local: string
  duration_minutes: string
  baggage_included: string   // '' | 'yes' | 'no' — vazio = ainda não se sabe
  welcome_sent_at: string | null
}

const VAZIO: Flight = {
  direction: 'INBOUND', locator: '', booking_ref: '', airline: '', flight_number: '',
  operated_by: '', from_city: '', from_airport: '', to_city: '', to_airport: '',
  departure_local: '', arrival_local: '', duration_minutes: '', baggage_included: '',
  welcome_sent_at: null,
}

// 'YYYY-MM-DDTHH:MM:SS' <-> o que o datetime-local aceita, sem tocar no fuso.
const paraInput = (v: string | null) => (v ? String(v).replace(' ', 'T').slice(0, 16) : '')

export default function SeasonFlight({ staffId, seasonId }: { staffId: string; seasonId: string }) {
  const [f, setF] = useState<Flight>(VAZIO)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => { load() }, [seasonId])

  async function load() {
    const { data } = await supabase.from('staff_flights').select('*')
      .eq('season_id', seasonId).order('departure_local', { ascending: true }).limit(1)
    const r = data?.[0]
    if (r) {
      setF({
        id: r.id, direction: r.direction || 'INBOUND',
        locator: r.locator || '', booking_ref: r.booking_ref || '',
        airline: r.airline || '', flight_number: r.flight_number || '', operated_by: r.operated_by || '',
        from_city: r.from_city || '', from_airport: r.from_airport || '',
        to_city: r.to_city || '', to_airport: r.to_airport || '',
        departure_local: paraInput(r.departure_local), arrival_local: paraInput(r.arrival_local),
        duration_minutes: r.duration_minutes != null ? String(r.duration_minutes) : '',
        baggage_included: r.baggage_included === true ? 'yes' : r.baggage_included === false ? 'no' : '',
        welcome_sent_at: r.welcome_sent_at || null,
      })
    }
    setLoading(false)
  }

  async function save(): Promise<string | null> {
    const row = {
      staff_id: staffId, season_id: seasonId, direction: f.direction,
      locator: f.locator.trim().toUpperCase() || null,
      booking_ref: f.booking_ref.trim() || null,
      airline: f.airline.trim() || null,
      flight_number: f.flight_number.trim().toUpperCase() || null,
      operated_by: f.operated_by.trim() || null,
      from_city: f.from_city.trim() || null,
      from_airport: f.from_airport.trim().toUpperCase() || null,
      to_city: f.to_city.trim() || null,
      to_airport: f.to_airport.trim().toUpperCase() || null,
      departure_local: f.departure_local || null,
      arrival_local: f.arrival_local || null,
      duration_minutes: f.duration_minutes !== '' ? parseInt(f.duration_minutes, 10) || null : null,
      baggage_included: f.baggage_included === 'yes' ? true : f.baggage_included === 'no' ? false : null,
      updated_at: new Date().toISOString(),
    }
    if (f.id) {
      const { error } = await supabase.from('staff_flights').update(row).eq('id', f.id)
      if (error) { setMsg(error.message); return null }
      return f.id
    }
    const { data, error } = await supabase.from('staff_flights').insert(row).select('id').single()
    if (error) { setMsg(error.message); return null }
    setF({ ...f, id: data.id })
    return data.id as string
  }

  // Salva primeiro e SÓ ENTÃO monta o texto: o que a pessoa vê no preview é o
  // que está gravado, nunca o que está na tela por preencher.
  async function verMensagem() {
    setBusy(true); setMsg(null)
    const id = await save()
    if (!id) { setBusy(false); return }
    const r = await fetch(`${BASE_PATH}/api/staff/flight-welcome?flightId=${id}`)
    const j = await r.json()
    setBusy(false)
    if (!r.ok) { setMsg(j.error || 'erro'); return }
    setPreview(j.body)
    if (!j.to) setMsg('Este membro está sem telefone no cadastro — a mensagem não tem para onde ir.')
  }

  async function mandar(force: boolean) {
    if (!f.id) return
    setBusy(true); setMsg(null)
    const r = await fetch(`${BASE_PATH}/api/staff/flight-welcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flightId: f.id, force }),
    })
    const j = await r.json()
    setBusy(false)
    if (r.status === 409) { setMsg(`Já enviada em ${new Date(j.sent_at).toLocaleString()}. Use REENVIAR se quiser mandar de novo.`); return }
    if (!r.ok) { setMsg(j.error || 'erro ao enviar'); return }
    setF({ ...f, welcome_sent_at: j.sent_at })
    setPreview(null)
    setMsg('Boas-vindas enviada.')
  }

  if (loading) return null

  return (
    <div className="border border-gray-700 rounded-2xl p-5">
      <label className="block text-lg font-bold mb-1">FLIGHT</label>
      <p className="text-sm text-gray-400 mb-5">
        Times are the local clock at each airport — nothing is converted.
      </p>

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className={smallLabel}>TRIP</label>
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} className={inputClass}>
            <option value="INBOUND">Coming to work</option>
            <option value="OUTBOUND">Going back home</option>
          </select>
        </div>

        <div>
          <label className={smallLabel}>AIRLINE LOCATOR (what works at the counter)</label>
          <input value={f.locator} onChange={(e) => setF({ ...f, locator: e.target.value.toUpperCase() })} className={inputClass} placeholder="XW7LKT" />
        </div>

        <div>
          <label className={smallLabel}>AGENCY BOOKING REF</label>
          <input value={f.booking_ref} onChange={(e) => setF({ ...f, booking_ref: e.target.value })} className={inputClass} placeholder="BUSA-36857155" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={smallLabel}>AIRLINE</label>
            <input value={f.airline} onChange={(e) => setF({ ...f, airline: e.target.value })} className={inputClass} placeholder="Azul" />
          </div>
          <div>
            <label className={smallLabel}>FLIGHT No.</label>
            <input value={f.flight_number} onChange={(e) => setF({ ...f, flight_number: e.target.value.toUpperCase() })} className={inputClass} placeholder="AD9730" />
          </div>
        </div>

        <div>
          <label className={smallLabel}>OPERATED BY (only if different)</label>
          <input value={f.operated_by} onChange={(e) => setF({ ...f, operated_by: e.target.value })} className={inputClass} placeholder="EuroAtlantic" />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className={smallLabel}>FROM — CITY</label>
            <input value={f.from_city} onChange={(e) => setF({ ...f, from_city: e.target.value })} className={inputClass} placeholder="Campinas" />
          </div>
          <div>
            <label className={smallLabel}>CODE</label>
            <input value={f.from_airport} onChange={(e) => setF({ ...f, from_airport: e.target.value.toUpperCase() })} className={inputClass} placeholder="VCP" />
          </div>
        </div>

        <div>
          <label className={smallLabel}>DEPARTURE — local time at origin</label>
          <input type="datetime-local" value={f.departure_local} onChange={(e) => setF({ ...f, departure_local: e.target.value })} className={inputClass} />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className={smallLabel}>TO — CITY</label>
            <input value={f.to_city} onChange={(e) => setF({ ...f, to_city: e.target.value })} className={inputClass} placeholder="Orlando" />
          </div>
          <div>
            <label className={smallLabel}>CODE</label>
            <input value={f.to_airport} onChange={(e) => setF({ ...f, to_airport: e.target.value.toUpperCase() })} className={inputClass} placeholder="MCO" />
          </div>
        </div>

        <div>
          <label className={smallLabel}>ARRIVAL — local time at destination</label>
          <input type="datetime-local" value={f.arrival_local} onChange={(e) => setF({ ...f, arrival_local: e.target.value })} className={inputClass} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={smallLabel}>DURATION (minutes)</label>
            <input type="number" min="0" value={f.duration_minutes} onChange={(e) => setF({ ...f, duration_minutes: e.target.value })} className={inputClass} placeholder="545" />
          </div>
          <div>
            <label className={smallLabel}>CHECKED BAGGAGE</label>
            <select value={f.baggage_included} onChange={(e) => setF({ ...f, baggage_included: e.target.value })} className={inputClass}>
              <option value="">Unknown</option>
              <option value="yes">Included</option>
              <option value="no">NOT included</option>
            </select>
          </div>
        </div>
      </div>

      {f.welcome_sent_at && (
        <p className="mt-5 text-sm text-green-400">
          Welcome sent on {new Date(f.welcome_sent_at).toLocaleString()}.
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={verMensagem} disabled={busy}
          className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
          {busy ? 'WORKING…' : 'SAVE + PREVIEW WELCOME'}
        </button>
        {preview && (
          <button onClick={() => mandar(!!f.welcome_sent_at)} disabled={busy}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-4 rounded-2xl text-xl font-bold">
            {f.welcome_sent_at ? 'SEND AGAIN' : 'SEND TO THE MEMBER'}
          </button>
        )}
      </div>

      {msg && <p className="mt-4 text-lg text-amber-400">{msg}</p>}

      {preview && (
        <pre className="mt-4 whitespace-pre-wrap bg-gray-900 border border-gray-700 rounded-2xl p-4 text-base text-gray-200">
          {preview}
        </pre>
      )}
    </div>
  )
}
