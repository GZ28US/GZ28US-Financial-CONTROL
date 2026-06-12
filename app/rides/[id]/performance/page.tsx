'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'

const TABS = ['DYNO', '1/4 MILE', '1/8 MILE', '100-200'] as const
type Tab = typeof TABS[number]

const DYNO_OPTIONS = ['DynoSolutions DynoJet', 'GZ28US DynoJet']

const MONTHS: [string, string][] = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'], ['05', 'May'], ['06', 'June'],
  ['07', 'July'], ['08', 'August'], ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
const YEARS = Array.from({ length: new Date().getFullYear() - 2025 + 1 }, (_, i) => String(2025 + i))

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
// Normalize a stored phone string into the digits-only form UltraMsg expects.
// US default: a bare 10-digit number gets a leading 1. Numbers that already
// include a country code are passed through.
function toWaNumber(phone: string | null | undefined): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return '1' + digits
  return digits
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}
function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
// Crank value = wheel value / (1 - loss%). e.g. 850 whp @ 15% loss => 1000 bhp (same for torque)
function applyLoss(wheel: string, loss: string): number | null {
  const w = parseFloat(wheel)
  if (!isFinite(w)) return null
  const l = loss === '' ? 0 : parseFloat(loss)
  if (!isFinite(l)) return null
  const denom = 1 - l / 100
  if (denom <= 0) return null
  return Math.round((w / denom) * 100) / 100
}

type DynoPull = { id: string; pack: string | null; whp: number | null; wnm: number | null; loss_pct: number | null; bhp: number | null; bnm: number | null; pull_date: string | null; dyno: string | null; document_url: string | null }

function DynoSection({ rideId, rideTitle }: { rideId: string; rideTitle: string }) {
  const [pulls, setPulls] = useState<DynoPull[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ pack: '', whp: '', wnm: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ pack: '', whp: '', wnm: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
  const editBhp = applyLoss(editForm.whp, editForm.loss)
  const editBnm = applyLoss(editForm.wnm, editForm.loss)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scannedFile, setScannedFile] = useState<File | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)
  const [client, setClient] = useState<{ name: string | null; email: string | null; phone: string | null; country: string | null; preferred_message_method: string | null } | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  // After a pull is saved, ask whether to report it on WhatsApp (and optionally to the client).
  const [reportPull, setReportPull] = useState<DynoPull | null>(null)
  const [reportToClient, setReportToClient] = useState(false)
  const [reporting, setReporting] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: rideRow } = await supabase.from('rides').select('client_id').eq('id', rideId).single()
      if (rideRow?.client_id) {
        const { data: c } = await supabase.from('clients').select('name, email, phone, country, preferred_message_method').eq('id', rideRow.client_id).single()
        if (c) setClient(c as typeof client)
      }
    })()
  }, [])

  async function handleScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setScanning(true)
    try {
      const base64 = await fileToBase64(file)
      const res = await fetch(`${BASE_PATH}/api/scan-dyno`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: file.type || 'application/octet-stream' }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { alert(data.error || 'Scan failed.'); return }
      const m = String(data.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
      setForm((f) => ({
        ...f,
        pack: data.pack || f.pack,
        whp: data.whp || f.whp,
        wnm: data.wnm || f.wnm,
        dmonth: m ? m[2] : f.dmonth,
        dday: m ? m[3] : f.dday,
        dyear: m ? m[1] : f.dyear,
        dyno: data.dyno || f.dyno,
      }))
      setScannedFile(file)
    } catch (err) {
      alert('Scan failed: ' + String(err))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase
      .from('dyno_pulls')
      .select('*')
      .eq('ride_id', rideId)
      .order('pull_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setPulls((data || []) as DynoPull[])
    setLoading(false)
  }

  async function addPull() {
    if (!form.pack.trim() && !form.whp) { alert('Enter at least a PACK or a WHP figure.'); return }
    setSaving(true)
    try {
      let documentUrl: string | null = null
      if (scannedFile) {
        const ext = scannedFile.name.split('.').pop() || 'pdf'
        const path = `dyno/${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage.from('dyno-charts').upload(path, scannedFile, { upsert: true })
        if (upErr) { alert('Document upload failed: ' + upErr.message); return }
        const { data: urlData } = supabase.storage.from('dyno-charts').getPublicUrl(path)
        documentUrl = urlData.publicUrl
      }
      const pullDate = form.dyear && form.dmonth && form.dday ? `${form.dyear}-${form.dmonth}-${form.dday}` : null
      const { data: inserted, error } = await supabase.from('dyno_pulls').insert([{
        ride_id: rideId,
        pack: form.pack.trim() || null,
        whp: form.whp ? parseFloat(form.whp) : null,
        wnm: form.wnm ? parseFloat(form.wnm) : null,
        loss_pct: form.loss ? parseFloat(form.loss) : null,
        bhp: applyLoss(form.whp, form.loss),
        bnm: applyLoss(form.wnm, form.loss),
        pull_date: pullDate,
        dyno: form.dyno || null,
        document_url: documentUrl,
      }]).select().single()
      if (error) { alert(error.message); return }

      setForm({ pack: '', whp: '', wnm: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
      setScannedFile(null)
      load()
      // Ask whether to report it (instead of auto-sending).
      setReportToClient(false)
      setReportPull(inserted as DynoPull)
    } finally {
      setSaving(false)
    }
  }

  async function removePull(id: string) {
    if (!window.confirm('Remove this pull?')) return
    const { error } = await supabase.from('dyno_pulls').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setPulls(prev => prev.filter(p => p.id !== id))
  }

  function startEdit(p: DynoPull) {
    const m = (p.pull_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    setEditForm({
      pack: p.pack || '',
      whp: p.whp != null ? String(p.whp) : '',
      wnm: p.wnm != null ? String(p.wnm) : '',
      loss: p.loss_pct != null ? String(p.loss_pct) : '',
      dmonth: m ? m[2] : '', dday: m ? m[3] : '', dyear: m ? m[1] : '',
      dyno: p.dyno || 'GZ28US DynoJet',
    })
    setEditingId(p.id)
  }

  async function saveEdit(id: string) {
    const pullDate = editForm.dyear && editForm.dmonth && editForm.dday ? `${editForm.dyear}-${editForm.dmonth}-${editForm.dday}` : null
    const { error } = await supabase.from('dyno_pulls').update({
      pack: editForm.pack.trim() || null,
      whp: editForm.whp ? parseFloat(editForm.whp) : null,
      wnm: editForm.wnm ? parseFloat(editForm.wnm) : null,
      loss_pct: editForm.loss ? parseFloat(editForm.loss) : null,
      bhp: applyLoss(editForm.whp, editForm.loss),
      bnm: applyLoss(editForm.wnm, editForm.loss),
      pull_date: pullDate,
      dyno: editForm.dyno || null,
    }).eq('id', id)
    if (error) { alert(error.message); return }
    setEditingId(null)
    load()
  }

  function pullReport(p: DynoPull): string {
    return [
      '🏁 *DYNO PULL*',
      rideTitle ? `*Ride:* ${rideTitle}` : null,
      p.pack ? `*Pack:* ${p.pack}` : null,
      p.whp != null ? `*WHP:* ${p.whp.toFixed(2)}` : null,
      p.wnm != null ? `*WNM:* ${p.wnm.toFixed(2)} N·m` : null,
      p.loss_pct != null ? `*Loss:* ${p.loss_pct}%` : null,
      p.bhp != null ? `*BHP:* ${p.bhp.toFixed(2)}` : null,
      p.bnm != null ? `*BNM:* ${p.bnm.toFixed(2)} N·m` : null,
      p.pull_date ? `*Date:* ${fmtDate(p.pull_date)}` : null,
      p.dyno ? `*Dyno:* ${p.dyno}` : null,
    ].filter(Boolean).join('\n')
  }

  function docFilename(p: DynoPull) {
    return `dyno-chart.${(p.document_url || '').split('?')[0].split('.').pop() || 'pdf'}`
  }

  // Post the report to the WhatsApp reports group. Returns true on success.
  async function sendGroupReport(p: DynoPull): Promise<boolean> {
    const payload: { body: string; documentUrl?: string; filename?: string } = { body: pullReport(p) }
    if (p.document_url) { payload.documentUrl = p.document_url; payload.filename = docFilename(p) }
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) { alert('WhatsApp report failed: ' + (data?.detail?.error ? JSON.stringify(data.detail.error) : (data.error || `HTTP ${res.status}`))); return false }
      return true
    } catch (e) { alert('WhatsApp report failed: ' + String(e)); return false }
  }

  // The "Report this pull?" dialog Send button.
  async function confirmReport() {
    if (!reportPull) return
    setReporting(true)
    try {
      await sendGroupReport(reportPull)
      if (reportToClient && client) await sendPull(reportPull)
    } finally {
      setReporting(false)
      setReportPull(null)
    }
  }

  async function sendPull(p: DynoPull) {
    if (!client) { alert('This ride has no client on file to send to. Assign a client on the ride page first.'); return }
    const method = client.preferred_message_method || 'WhatsApp'
    const report = pullReport(p)
    const plain = report.replace(/\*/g, '') + (p.document_url ? `\n\nChart: ${p.document_url}` : '')

    if (method === 'WhatsApp') {
      const to = toWaNumber(client.phone)
      if (!to) { alert('This client has no phone number for WhatsApp.\nAdd a phone on the client page, or change their preferred method to SMS / E-Mail.'); return }
      setSendingId(p.id)
      try {
        const payload: { to: string; body: string; documentUrl?: string; filename?: string } = { to, body: report }
        if (p.document_url) {
          payload.documentUrl = p.document_url
          payload.filename = `dyno-chart.${(p.document_url.split('?')[0].split('.').pop() || 'pdf')}`
        }
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!data.ok) {
          const detailErr = data?.detail?.error
          alert('WhatsApp send failed:\n' + (typeof detailErr === 'object' ? JSON.stringify(detailErr) : String(detailErr || data?.error || `HTTP ${res.status}`)))
          return
        }
        alert(`Report sent to ${client.name || 'client'} via WhatsApp.`)
      } finally {
        setSendingId(null)
      }
      return
    }

    if (method === 'SMS') {
      window.location.href = `sms:${client.phone || ''}?&body=${encodeURIComponent(plain)}`
      return
    }

    if (method === 'E-Mail') {
      const subject = `Dyno Pull${rideTitle ? ` — ${rideTitle}` : ''}`
      window.location.href = `mailto:${client.email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      return
    }

    // Instagram or any non-automated method: copy the text for manual paste.
    try { await navigator.clipboard.writeText(plain) } catch { /* clipboard may be blocked */ }
    alert(`This client prefers ${method}, which can't be sent automatically.\nThe report was copied to your clipboard — paste it into ${method}.`)
  }

  const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
  const editInput = 'bg-gray-800 border border-gray-700 rounded-xl px-2 py-1 text-base'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      {/* REPORT THIS PULL TO WHATSAPP? */}
      {reportPull && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
            <h2 className="text-2xl font-bold">REPORT THIS PULL TO WHATSAPP?</h2>
            <label className="flex items-center gap-3 text-lg cursor-pointer">
              <input type="checkbox" checked={reportToClient} onChange={(e) => setReportToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              Send to the client too?
            </label>
            {reportToClient && !client && <p className="text-sm text-yellow-400">This ride has no client on file — only the group report will be sent.</p>}
            <div className="flex gap-3 pt-1">
              <button onClick={() => setReportPull(null)} disabled={reporting} className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">SKIP</button>
              <button onClick={confirmReport} disabled={reporting} className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{reporting ? 'SENDING…' : 'SEND'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add a pull */}
      <div className="flex flex-wrap gap-3 items-start mb-6">
        <div className="flex-1 min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">PACK</label>
          <input value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} className={inputClass} placeholder="e.g. Stage 2" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">WHP</label>
          <input value={form.whp} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, whp: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">WNM</label>
          <input value={form.wnm} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, wnm: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">LOSS (%)</label>
          <input value={form.loss} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, loss: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="min-w-[300px] flex-1">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DATE</label>
          <div className="flex gap-2">
            <select value={form.dmonth} onChange={(e) => setForm({ ...form, dmonth: e.target.value })} className={inputClass}>
              <option value="">Month</option>
              {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={form.dday} onChange={(e) => setForm({ ...form, dday: e.target.value })} className={inputClass}>
              <option value="">Day</option>
              {DAYS.map((d) => <option key={d} value={d}>{parseInt(d, 10)}</option>)}
            </select>
            <select value={form.dyear} onChange={(e) => setForm({ ...form, dyear: e.target.value })} className={inputClass}>
              <option value="">Year</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DYNO</label>
          <select value={form.dyno} onChange={(e) => setForm({ ...form, dyno: e.target.value })} className={inputClass}>
            {DYNO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">ADD</label>
          <button onClick={addPull} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{saving ? 'SAVING…' : '+ ADD PULL'}</button>
        </div>
        <div>
          <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">SCAN</label>
          <button onClick={() => scanInputRef.current?.click()} disabled={scanning} className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{scanning ? 'SCANNING…' : 'SCAN PULL'}</button>
          <input ref={scanInputRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={handleScanFile} />
        </div>
      </div>

      {scannedFile && (
        <p className="text-sm text-purple-300 mb-4">📎 Chart attached: <span className="font-bold">{scannedFile.name}</span> — saved with this pull on ADD.
          <button onClick={() => setScannedFile(null)} className="ml-2 text-gray-400 hover:text-gray-200 underline">remove</button>
        </p>
      )}

      {/* Pulls table */}
      {loading ? (
        <p className="text-lg text-gray-400">Loading...</p>
      ) : pulls.length === 0 ? (
        <p className="text-lg text-gray-400">No pulls recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-gray-400 text-sm border-b border-gray-700">
                <th className="py-2 pr-4 font-bold">PACK</th>
                <th className="py-2 pr-4 font-bold">WHP</th>
                <th className="py-2 pr-4 font-bold">WNM</th>
                <th className="py-2 pr-4 font-bold">LOSS (%)</th>
                <th className="py-2 pr-4 font-bold">BHP</th>
                <th className="py-2 pr-4 font-bold">BNM</th>
                <th className="py-2 pr-4 font-bold">DATE</th>
                <th className="py-2 pr-4 font-bold">DYNO</th>
                <th className="py-2 pr-4 font-bold">DOC</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {pulls.map((p) => editingId === p.id ? (
                <tr key={p.id} className="border-b border-gray-800 bg-gray-950/40">
                  <td className="py-2 pr-2"><input value={editForm.pack} onChange={(e) => setEditForm({ ...editForm, pack: e.target.value })} className={`${editInput} w-full`} placeholder="PACK" /></td>
                  <td className="py-2 pr-2"><input value={editForm.whp} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setEditForm({ ...editForm, whp: e.target.value }) }} className={`${editInput} w-20`} placeholder="0" /></td>
                  <td className="py-2 pr-2"><input value={editForm.wnm} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setEditForm({ ...editForm, wnm: e.target.value }) }} className={`${editInput} w-20`} placeholder="0" /></td>
                  <td className="py-2 pr-2"><input value={editForm.loss} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setEditForm({ ...editForm, loss: e.target.value }) }} className={`${editInput} w-16`} placeholder="0" /></td>
                  <td className="py-2 pr-2 text-gray-400">{editBhp != null ? editBhp.toFixed(2) : '—'}</td>
                  <td className="py-2 pr-2 text-gray-400">{editBnm != null ? editBnm.toFixed(2) : '—'}</td>
                  <td className="py-2 pr-2">
                    <div className="flex gap-1">
                      <select value={editForm.dmonth} onChange={(e) => setEditForm({ ...editForm, dmonth: e.target.value })} className={editInput}>
                        <option value="">Mon</option>
                        {MONTHS.map(([v, l]) => <option key={v} value={v}>{l.slice(0, 3)}</option>)}
                      </select>
                      <select value={editForm.dday} onChange={(e) => setEditForm({ ...editForm, dday: e.target.value })} className={editInput}>
                        <option value="">Day</option>
                        {DAYS.map((d) => <option key={d} value={d}>{parseInt(d, 10)}</option>)}
                      </select>
                      <select value={editForm.dyear} onChange={(e) => setEditForm({ ...editForm, dyear: e.target.value })} className={editInput}>
                        <option value="">Year</option>
                        {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <select value={editForm.dyno} onChange={(e) => setEditForm({ ...editForm, dyno: e.target.value })} className={editInput}>
                      {DYNO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="py-2 pr-2">{p.document_url ? <a href={p.document_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a> : '—'}</td>
                  <td className="py-2 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => saveEdit(p.id)} className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded-xl font-bold text-sm">SAVE</button>
                      <button onClick={() => setEditingId(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-xl font-bold text-sm">CANCEL</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={p.id} className="border-b border-gray-800">
                  <td className="py-3 pr-4 font-bold">{p.pack || '—'}</td>
                  <td className="py-3 pr-4">{p.whp != null ? `${p.whp.toFixed(2)} whp` : '—'}</td>
                  <td className="py-3 pr-4">{p.wnm != null ? `${p.wnm.toFixed(2)} N·m` : '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{p.loss_pct != null ? `${p.loss_pct}%` : '—'}</td>
                  <td className="py-3 pr-4">{p.bhp != null ? `${p.bhp.toFixed(2)} bhp` : '—'}</td>
                  <td className="py-3 pr-4">{p.bnm != null ? `${p.bnm.toFixed(2)} N·m` : '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{fmtDate(p.pull_date)}</td>
                  <td className="py-3 pr-4">{p.dyno || '—'}</td>
                  <td className="py-3 pr-4">{p.document_url ? <a href={p.document_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a> : '—'}</td>
                  <td className="py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => startEdit(p)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                      <button onClick={() => removePull(p.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                      <button onClick={() => sendPull(p)} disabled={sendingId === p.id} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-3 py-1 rounded-xl font-bold text-sm">{sendingId === p.id ? 'SENDING…' : 'SEND'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function RidePerformancePage() {
  const params = useParams()
  const rideId = String(params.id)
  const [ride, setRide] = useState<{ project_code: string | null; project_name: string | null } | null>(null)
  const [tab, setTab] = useState<Tab>('DYNO')

  useEffect(() => {
    supabase.from('rides').select('project_code, project_name').eq('id', rideId).single().then(({ data }) => setRide(data))
  }, [])

  const title = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">PERFORMANCE</h1>
        <div className="flex gap-3">
          <Link href="/rides" className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/rides/${rideId}`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">VIEW RIDE</Link>
        </div>
      </div>
      {title && <p className="text-xl text-gray-400 mb-6">{title}</p>}

      <div className="flex gap-2 flex-wrap mb-8">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 rounded-2xl font-bold ${tab === t ? 'bg-white text-black' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'DYNO' ? (
        <DynoSection rideId={rideId} rideTitle={title} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8">
          <h2 className="text-2xl font-bold mb-2">{tab}</h2>
          <p className="text-xl text-gray-400">This section is under construction.</p>
        </div>
      )}
    </main>
  )
}
