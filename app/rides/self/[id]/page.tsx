'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

// PUBLIC car-photo upload page. The shop sends the client this link (PIC FROM CLIENT
// on the ride page) so the client uploads their favorite picture of their car. It is
// login-free (rendered outside AuthGate — see components/AuthGate.tsx) and has NO app
// navigation: only this page. The picture becomes the ride's photo (rides.photo_url).
// Client-facing text is in the CLIENT's language — Portuguese for a BRAZIL client,
// English otherwise. The brand/logo are this app's.

const BRAND = 'GZ28 V8 SpeedShop'
const LOGO = 'logo_gz28_black.png'

const STRINGS = {
  pt: {
    prompt: 'Envie sua foto favorita do seu carro 📸', pick: 'ESCOLHER FOTO', change: 'TROCAR FOTO',
    send: 'ENVIAR FOTO', sending: 'ENVIANDO…',
    loading: 'Carregando…',
    notFoundTitle: 'Carro não encontrado', notFoundBody: `Confira o link recebido ou fale com a ${BRAND}.`,
    savedTitle: 'Foto enviada!', savedThanks: 'Obrigado', savedRest: '! Recebemos a foto do seu carro.',
    tooBig: 'Imagem muito grande (máx. 15 MB). Escolha outra foto.',
    notImage: 'Selecione um arquivo de imagem.',
    consent: `Ao enviar esta foto, você autoriza a ${BRAND} a usá-la para o registro do seu carro no atendimento.`,
  },
  en: {
    prompt: 'Upload your favorite picture of your car 📸', pick: 'CHOOSE PHOTO', change: 'CHANGE PHOTO',
    send: 'SEND PHOTO', sending: 'SENDING…',
    loading: 'Loading…',
    notFoundTitle: 'Car not found', notFoundBody: `Check the link you received or contact ${BRAND}.`,
    savedTitle: 'Photo sent!', savedThanks: 'Thank you', savedRest: '! We received your car photo.',
    tooBig: 'Image too large (max 15 MB). Please pick another photo.',
    notImage: 'Please select an image file.',
    consent: `By sending this photo, you authorize ${BRAND} to use it for your car's record in your service.`,
  },
}

export default function RideSelfPhotoPage() {
  const params = useParams()
  const id = String(params.id || '')

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [sending, setSending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const [carName, setCarName] = useState('')
  const [clientName, setClientName] = useState('')
  const [country, setCountry] = useState('USA')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Language follows the client's country: BRAZIL -> Portuguese, otherwise English.
  const L = country === 'BRAZIL' ? STRINGS.pt : STRINGS.en

  useEffect(() => { if (id) load(id) }, [id])

  async function load(rideId: string) {
    setLoading(true)
    const { data: ride, error } = await supabase
      .from('rides')
      .select('project_code, project_name, manufacturer, brand, model, version, year, client_id')
      .eq('id', rideId)
      .maybeSingle()
    if (error) { setError(error.message); setLoading(false); return }
    if (!ride) { setNotFound(true); setLoading(false); return }

    const car = ride.project_name
      || [ride.manufacturer || ride.brand, ride.model, ride.version, ride.year].filter(Boolean).join(' ')
      || ride.project_code
    setCarName(car)

    if (ride.client_id) {
      const { data: client } = await supabase.from('clients').select('name, country').eq('id', ride.client_id).maybeSingle()
      if (client) { setClientName(client.name || ''); setCountry(client.country || 'USA') }
    }
    setLoading(false)
  }

  function pickFile(f: File | null | undefined) {
    if (!f) return
    if (!f.type.startsWith('image/')) { setError(L.notImage); return }
    if (f.size > 15 * 1024 * 1024) { setError(L.tooBig); return }
    setError('')
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  async function send() {
    if (!file) return
    setSending(true)
    setError('')
    let sendError: string | null = null
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `${id}/client-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage.from('ride-photos').upload(path, file, { upsert: true })
      if (upErr) { sendError = upErr.message }
      else {
        const { data: urlData } = supabase.storage.from('ride-photos').getPublicUrl(path)
        const { error: updErr } = await supabase.from('rides').update({ photo_url: urlData.publicUrl, updated_at: new Date().toISOString() }).eq('id', id)
        if (updErr) sendError = updErr.message
      }
    } catch (e) {
      sendError = String(e)
    } finally {
      setSending(false)
    }
    if (sendError) { setError(sendError); return }
    setSaved(true)
    // Confirm to the internal REPORTS group that the client uploaded their car photo.
    // No `to` -> the route defaults to the group.
    fetch(`${BASE_PATH}/api/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `📸 *CAR PHOTO — UPLOADED BY CLIENT*\n${carName || '—'}${clientName ? `\nClient: ${clientName}` : ''}\nThe client sent their favorite car photo. It's on the vehicle's record now.` }),
    }).catch(() => {})
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <p className="text-xl text-gray-400">{L.loading}</p>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-bold mb-2">{L.notFoundTitle}</h1>
          <p className="text-gray-400">{L.notFoundBody}</p>
        </div>
      </main>
    )
  }

  if (saved) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl p-8 text-center flex flex-col gap-3">
          <div className="text-5xl">✅</div>
          <h1 className="text-2xl font-bold">{L.savedTitle}</h1>
          <p className="text-gray-400">{L.savedThanks}{clientName ? `, ${clientName.split(' ')[0]}` : ''}{L.savedRest}</p>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt={carName} className="rounded-2xl w-full max-h-72 object-cover mt-2" />
          )}
          <p className="text-gray-500 text-sm mt-1">{BRAND}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-6 flex justify-center">
      <div className="w-full max-w-xl">
        <div className="text-center mb-8 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/${LOGO}`} alt={BRAND} className="mx-auto mb-5 w-60 max-w-full" />
          <h1 className="text-3xl font-bold italic">{BRAND}</h1>
          {carName && <p className="text-white mt-2 text-xl font-bold">{carName}</p>}
          <p className="text-gray-400 mt-2 text-lg">{L.prompt}</p>
        </div>

        <div className="grid grid-cols-1 gap-5">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />

          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt={carName} className="rounded-2xl w-full max-h-80 object-cover border border-gray-700" />
          ) : (
            <button onClick={() => fileRef.current?.click()} className="bg-gray-900 border-2 border-dashed border-gray-600 hover:border-gray-400 rounded-3xl p-12 text-center text-gray-300 text-xl font-bold">
              <div className="text-5xl mb-3">📷</div>
              {L.pick}
            </button>
          )}

          {preview && (
            <button onClick={() => fileRef.current?.click()} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">{L.change}</button>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <p className="text-xs text-gray-500 leading-relaxed">{L.consent}</p>

          <button
            onClick={send}
            disabled={!file || sending}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-5 rounded-2xl text-2xl font-bold mt-1"
          >
            {sending ? L.sending : L.send}
          </button>
        </div>
      </div>
    </main>
  )
}
