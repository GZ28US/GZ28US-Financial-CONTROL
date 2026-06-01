'use client'

import { useState } from 'react'
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

export default function NewClientPage() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    country: 'USA',
    phone: '+1 ',
    address: '',
    city: '',
    state: 'FL',
    zip: '',
  })

  function changeCountry(country: string) {
    setForm({
      ...form,
      country,
      phone: country === 'USA' ? '+1 ' : '+55 ',
      state: country === 'USA' ? 'FL' : 'SP',
    })
  }

  async function saveClient() {
    if (!form.name.trim()) {
      alert('NAME is required')
      return
    }

    // Auto-assign the next client_number = current MAX + 1. A first-ever client
    // (no rows yet) starts at 1.
    const { data: maxRow } = await supabase
      .from('clients')
      .select('client_number')
      .order('client_number', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    const nextNumber = (maxRow?.client_number ?? 0) + 1

    const { error } = await supabase
      .from('clients')
      .insert({
        name: form.name,
        email: form.email,
        country: form.country,
        phone: form.phone,
        address: form.address,
        city: form.city,
        state: form.state,
        zip: form.zip,
        client_number: nextNumber,
      })

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

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <h2 className="text-4xl font-bold mb-8">
        ADD A NEW CLIENT
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

        <button
          onClick={saveClient}
          className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold"
        >
          SAVE CLIENT
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
