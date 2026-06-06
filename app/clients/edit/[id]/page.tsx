'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import Header from '@/components/Header'

const usaStates = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const brazilStates = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]

const messageMethods = ['WhatsApp', 'SMS', 'E-Mail']

export default function EditClientPage() {
  const params = useParams()
  const id = String(params.id || '')

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [form, setForm] = useState({
    name: '',
    email: '',
    instagram: '',
    country: 'USA',
    phone: '+1 ',
    address: '',
    city: '',
    state: 'FL',
    zip: '',
    preferred_message_method: 'WhatsApp',
  })

  useEffect(() => {
    if (id) {
      loadClient(id)
    }
  }, [id])

  async function loadClient(clientId: string) {
    setLoading(true)

    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .maybeSingle()

    if (error) {
      alert(error.message)
      setLoading(false)
      return
    }

    if (!data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setForm({
      name: data.name || '',
      email: data.email || '',
      instagram: data.instagram || '',
      country: data.country || 'USA',
      phone: data.phone || '',
      address: data.address || '',
      city: data.city || '',
      state: data.state || '',
      zip: data.zip || '',
      preferred_message_method: data.preferred_message_method || 'WhatsApp',
    })

    setLoading(false)
  }

  function changeCountry(country: string) {
    setForm({
      ...form,
      country,
      phone: country === 'USA' ? '+1 ' : '+55 ',
      state: country === 'USA' ? 'FL' : 'SP',
    })
  }

  async function updateClient() {
    const { error } = await supabase
      .from('clients')
      .update({
        name: form.name,
        email: form.email,
        instagram: form.instagram,
        country: form.country,
        phone: form.phone,
        address: form.address,
        city: form.city,
        state: form.state,
        zip: form.zip,
        preferred_message_method: form.preferred_message_method,
      })
      .eq('id', id)

    if (error) {
      alert(error.message)
      return
    }

    window.location.href = '/clients'
  }

  const stateOptions =
    form.country === 'USA'
      ? usaStates
      : brazilStates

  if (loading) {
    return (
      <main className="min-h-screen bg-black text-white p-8">
        <Header />
        <p className="text-xl text-gray-400">Loading...</p>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="min-h-screen bg-black text-white p-8">
        <Header />

        <h2 className="text-4xl font-bold mb-8">
          CLIENT NOT FOUND
        </h2>

        <a
          href="/clients"
          className="text-gray-400 text-xl"
        >
          Back to Clients
        </a>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h2 className="text-4xl font-bold mb-8">
        EDIT CLIENT
      </h2>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">
        <input
          placeholder="NAME"
          value={form.name}
          onChange={(e) =>
            setForm({
              ...form,
              name: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <input
          placeholder="EMAIL"
          value={form.email}
          onChange={(e) =>
            setForm({
              ...form,
              email: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <input
          placeholder="INSTAGRAM (@username)"
          value={form.instagram}
          onChange={(e) =>
            setForm({
              ...form,
              instagram: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <select
          value={form.country}
          onChange={(e) => changeCountry(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        >
          <option value="USA">USA</option>
          <option value="BRAZIL">BRAZIL</option>
        </select>

        <input
          placeholder={
            form.country === 'USA'
              ? '+1 (407) 123-4567'
              : '+55 (62) 99999-9999'
          }
          value={form.phone}
          onChange={(e) =>
            setForm({
              ...form,
              phone: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <input
          placeholder="ADDRESS"
          value={form.address}
          onChange={(e) =>
            setForm({
              ...form,
              address: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <input
          placeholder="CITY"
          value={form.city}
          onChange={(e) =>
            setForm({
              ...form,
              city: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <select
          value={form.state}
          onChange={(e) =>
            setForm({
              ...form,
              state: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        >
          {stateOptions.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>

        <input
          placeholder="ZIP"
          value={form.zip}
          onChange={(e) =>
            setForm({
              ...form,
              zip: e.target.value,
            })
          }
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
        />

        <div>
          <label className="block mb-2 text-sm text-gray-400 font-bold">PREFERRED MESSAGE METHOD</label>
          <select
            value={form.preferred_message_method}
            onChange={(e) =>
              setForm({
                ...form,
                preferred_message_method: e.target.value,
              })
            }
            className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl"
          >
            {messageMethods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={updateClient}
          className="bg-blue-700 hover:bg-blue-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          UPDATE CLIENT
        </button>

        <a
          href="/clients"
          className="text-gray-400 text-xl"
        >
          Cancel
        </a>
      </div>
    </main>
  )
}
