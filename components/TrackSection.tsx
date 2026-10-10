'use client'

// ── 1/4 MILE · 1/8 MILE · 100-200 (Márcio, 10/10/2026) ───────────────────────────────────────────────────────────────
// «now let's build the 1/8, 1/4 and 100-200 pages … the Alcatraz performance receipts, that when scanned, builds the
// pulls … follow the same standards of the dyno page».
// The dyno page's standards, one for one: SCAN reads the receipt and SAVES the run by itself (the paper is the proof),
// then asks «REPORT THIS RUN TO WHATSAPP?» (group + optionally the client, by the client's preferred channel); every
// row has EDIT / REMOVE / SEND; the baseline (pack BoneStock/Stock) is pinned on top and the GAINS row measures the
// latest run against it (against the first run when there is no baseline); SEND … DATA builds the PDF, saves it in
// the car's Dropbox Performance folder and sends it to the reports group (+ client).
// Data: table track_runs (US bank, shared). One DRAG timeslip feeds BOTH the 1/8 tab (its 201 m split) and the 1/4 tab
// (its 402 m finish) — never duplicated. Stored metric (km/h, m); this app shows mph / ft.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, toWaNumber, isBaselineName } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { fileForScan } from '@/lib/scanFile'

export type TrackMode = 'QUARTER' | 'EIGHTH' | 'ROLL'

type Split = { to: number; s: number }
type Run = {
  id: string; ride_code: string; build_no: number; origin: string | null; kind: 'DRAG' | 'ROLL'
  pack: string | null; run_date: string | null; run_time: string | null; track: string | null; device: string | null
  driver: string | null; lane: string | null; category: string | null
  reaction_s: number | null; t60ft_s: number | null; t100m_s: number | null; t201m_s: number | null; v201m_kmh: number | null
  t302m_s: number | null; t402m_s: number | null; v402m_kmh: number | null; total_s: number | null
  t100_200_s: number | null; splits: Split[] | null; distance_m: number | null; slope_pct: number | null
  temp_c: number | null; altitude_m: number | null; density_alt_m: number | null; valid: boolean | null
  document_url: string | null; created_at: string
}

const MPH_PER_KMH = 1 / 1.609344
const FT_PER_M = 1 / 0.3048
const MODE_TITLE: Record<TrackMode, string> = { QUARTER: '1/4 MILE', EIGHTH: '1/8 MILE', ROLL: '100-200 km/h' }
const MONTHS: [string, string][] = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'], ['05', 'May'], ['06', 'June'],
  ['07', 'July'], ['08', 'August'], ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
const YEARS = Array.from({ length: new Date().getFullYear() - 2025 + 1 }, (_, i) => String(new Date().getFullYear() - i))

const n = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const isNumeric = (v: string) => v === '' || /^-?\d*\.?\d*$/.test(v)
const f3 = (v: number | null) => (v == null ? '—' : v.toFixed(3))
const f2 = (v: number | null) => (v == null ? '—' : v.toFixed(2))
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1))
const mph = (kmh: number | null) => (kmh == null ? null : kmh * MPH_PER_KMH)
function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
const isBase = (r: { pack: string | null }) => isBaselineName(r.pack)

// The headline figure of each page and how "better" reads.
const headline = (mode: TrackMode, r: Run): number | null =>
  mode === 'QUARTER' ? n(r.t402m_s) : mode === 'EIGHTH' ? n(r.t201m_s) : n(r.t100_200_s)
const belongs = (mode: TrackMode, r: Run) => (mode === 'ROLL' ? r.kind === 'ROLL' : r.kind === 'DRAG' && headline(mode, r) != null)

// Columns per page. `better` drives the GAINS colour (time: lower is better; speed: higher).
type Col = { label: string; get: (r: Run) => number | null; fmt: (v: number | null) => string; better?: 'lower' | 'higher'; unit?: string }
const COLS: Record<TrackMode, Col[]> = {
  QUARTER: [
    { label: 'R/T', get: (r) => n(r.reaction_s), fmt: f3, unit: 's' },
    { label: '60 FT', get: (r) => n(r.t60ft_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '330 FT', get: (r) => n(r.t100m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/8 ET', get: (r) => n(r.t201m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/8 MPH', get: (r) => mph(n(r.v201m_kmh)), fmt: f1, better: 'higher', unit: 'mph' },
    { label: '1000 FT', get: (r) => n(r.t302m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/4 ET', get: (r) => n(r.t402m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/4 MPH', get: (r) => mph(n(r.v402m_kmh)), fmt: f1, better: 'higher', unit: 'mph' },
  ],
  EIGHTH: [
    { label: 'R/T', get: (r) => n(r.reaction_s), fmt: f3, unit: 's' },
    { label: '60 FT', get: (r) => n(r.t60ft_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '330 FT', get: (r) => n(r.t100m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/8 ET', get: (r) => n(r.t201m_s), fmt: f3, better: 'lower', unit: 's' },
    { label: '1/8 MPH', get: (r) => mph(n(r.v201m_kmh)), fmt: f1, better: 'higher', unit: 'mph' },
  ],
  ROLL: [
    { label: '100-200', get: (r) => n(r.t100_200_s), fmt: f2, better: 'lower', unit: 's' },
    { label: 'DIST (ft)', get: (r) => (n(r.distance_m) == null ? null : n(r.distance_m)! * FT_PER_M), fmt: f1, better: 'lower', unit: 'ft' },
    { label: 'SLOPE %', get: (r) => n(r.slope_pct), fmt: f2 },
    { label: 'TEMP °F', get: (r) => (n(r.temp_c) == null ? null : n(r.temp_c)! * 9 / 5 + 32), fmt: f1 },
    { label: 'DA (ft)', get: (r) => (n(r.density_alt_m) == null ? null : n(r.density_alt_m)! * FT_PER_M), fmt: (v) => (v == null ? '—' : Math.round(v).toString()) },
  ],
}

// Manual form fields per page (speeds typed in MPH, stored in km/h).
type FField = { key: string; label: string; speed?: boolean }
const FIELDS: Record<TrackMode, FField[]> = {
  QUARTER: [
    { key: 'reaction_s', label: 'R/T' }, { key: 't60ft_s', label: '60 FT' }, { key: 't100m_s', label: '330 FT' },
    { key: 't201m_s', label: '1/8 ET' }, { key: 'v201m_kmh', label: '1/8 MPH', speed: true }, { key: 't302m_s', label: '1000 FT' },
    { key: 't402m_s', label: '1/4 ET' }, { key: 'v402m_kmh', label: '1/4 MPH', speed: true },
  ],
  EIGHTH: [
    { key: 'reaction_s', label: 'R/T' }, { key: 't60ft_s', label: '60 FT' }, { key: 't100m_s', label: '330 FT' },
    { key: 't201m_s', label: '1/8 ET' }, { key: 'v201m_kmh', label: '1/8 MPH', speed: true },
  ],
  ROLL: [{ key: 't100_200_s', label: '100-200 (s)' }, { key: 'distance_m', label: 'DIST (m)' }],
}

type Client = { name: string | null; email: string | null; phone: string | null; country: string | null; preferred_message_method: string | null; instagram: string | null; facebook: string | null }

export default function TrackSection({ mode, rideId, rideCode, rideName, rideTitle, buildNo, packName, reportsGroup }: {
  mode: TrackMode; rideId: string; rideCode: string; rideName: string; rideTitle: string; buildNo: number; packName: string; reportsGroup: string
}) {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [car, setCar] = useState<{ brand: string | null; model: string | null; version: string | null; year: number | null } | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const emptyForm = () => ({ pack: packName || '', track: '', dmonth: '', dday: '', dyear: '', vals: {} as Record<string, string> })
  const [form, setForm] = useState(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const scanRef = useRef<HTMLInputElement>(null)
  const [reportRun, setReportRun] = useState<Run | null>(null)
  const [reportToClient, setReportToClient] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [sendToClient, setSendToClient] = useState(false)
  const [sendingData, setSendingData] = useState(false)
  const cols = COLS[mode]
  const title = MODE_TITLE[mode]

  useEffect(() => {
    ;(async () => {
      const { data: rideRow } = await supabase.from('rides').select('client_id, brand, model, version, year').eq('id', rideId).single()
      if (rideRow) {
        setCar({ brand: rideRow.brand, model: rideRow.model, version: rideRow.version, year: rideRow.year })
        if (rideRow.client_id) {
          const { data: c } = await supabase.from('clients').select('name, email, phone, country, preferred_message_method, instagram, facebook').eq('id', rideRow.client_id).single()
          if (c) setClient(c as Client)
        }
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps
  // The build's pack arrives async from the parent; fill only while the field is empty.
  useEffect(() => { if (packName) setForm((f) => (f.pack.trim() ? f : { ...f, pack: packName })) }, [packName])

  async function load() {
    const { data } = await supabase.from('track_runs').select('*').eq('ride_code', rideCode).eq('build_no', buildNo)
      .order('run_date', { ascending: true, nullsFirst: true }).order('created_at', { ascending: true })
    setRuns(((data || []) as Run[]).filter((r) => belongs(mode, r)))
    setLoading(false)
  }

  // Display order = the dyno page's: baseline pinned on top, then every run OLDEST → NEWEST.
  const ordered = (() => {
    const base = runs.find(isBase)
    return [...(base ? [base] : []), ...runs.filter((r) => r !== base)]
  })()
  const nonBase = ordered.filter((r) => !isBase(r))
  const latest = nonBase[nonBase.length - 1] ?? null
  const reference = runs.find(isBase) ?? (nonBase.length > 1 ? nonBase[0] : null)
  const best = nonBase.reduce<Run | null>((b, r) => {
    const v = headline(mode, r)
    if (v == null) return b
    const bv = b ? headline(mode, b) : null
    return bv == null || v < bv ? r : b
  }, null)

  function sheetTitle(): string {
    const carName = [car?.year, car?.brand, car?.model, car?.version].filter(Boolean).join(' ')
    return [carName, rideTitle].filter((s) => s && String(s).trim()).join(' — ')
  }

  // ---- SAVE ------------------------------------------------------------------------------------------------------
  async function uploadDoc(file: File): Promise<string | null> {
    const ext = file.name.split('.').pop() || 'jpg'
    const path = `track/${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage.from('dyno-charts').upload(path, file, { upsert: true })
    if (error) { alert('Receipt upload failed: ' + error.message); return null }
    return supabase.storage.from('dyno-charts').getPublicUrl(path).data.publicUrl
  }

  async function insertRun(row: Record<string, unknown>): Promise<Run | null> {
    const { data, error } = await supabase.from('track_runs').insert([{ ride_code: rideCode, build_no: buildNo, origin: 'US', ...row }]).select().single()
    if (error) { alert(error.message); return null }
    return data as Run
  }

  // SCAN: the receipt is the proof — it saves by itself, then offers the report (dyno standard, 17/ago/2026).
  async function handleScan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setScanning(true)
    try {
      const { base64, mediaType } = await fileForScan(file)
      const res = await fetch(`${BASE_PATH}/api/scan-track`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ base64, mediaType: mediaType || 'application/octet-stream', filename: file.name }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.error) { alert(d.error || 'Scan failed.'); return }
      const documentUrl = await uploadDoc(file)
      if (!documentUrl) return
      const common = { pack: (form.pack.trim() || packName || '').trim() || null, run_date: d.date || null, run_time: d.time || null, document_url: documentUrl }
      const row = d.kind === 'DRAG'
        ? { ...common, kind: 'DRAG', track: d.track || null, driver: d.driver || null, lane: d.lane || null, category: d.category || null,
            reaction_s: d.reaction_s, t60ft_s: d.t60ft_s, t100m_s: d.t100m_s, t201m_s: d.t201m_s, v201m_kmh: d.v201m_kmh,
            t302m_s: d.t302m_s, t402m_s: d.t402m_s, v402m_kmh: d.v402m_kmh, total_s: d.total_s }
        : { ...common, kind: 'ROLL', device: d.device || null, t100_200_s: d.t100_200_s, splits: d.splits || [], distance_m: d.distance_m,
            slope_pct: d.slope_pct, temp_c: d.temp_c, altitude_m: d.altitude_m, density_alt_m: d.density_alt_m, valid: d.valid }
      const saved = await insertRun(row)
      if (!saved) return
      await load()
      if (!belongs(mode, saved)) {
        alert(saved.kind === 'ROLL' ? 'Saved — it is a 100-200 report: see the 100-200 tab.' : `Saved — it is a timeslip: see the ${saved.t402m_s != null ? '1/4 MILE' : '1/8 MILE'} tab.`)
      }
      if (d.note) alert(`Saved. Note from the scan: ${d.note}`)
      setReportToClient(false)
      setReportRun(saved)
    } catch (err) {
      alert('Scan failed: ' + String(err))
    } finally {
      setScanning(false)
    }
  }

  function formRow(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {}
    for (const fld of FIELDS[mode]) {
      const v = (form.vals[fld.key] || '').trim()
      const num = v === '' ? null : parseFloat(v)
      out[fld.key] = num == null || !Number.isFinite(num) ? null : fld.speed ? Math.round(num / MPH_PER_KMH * 100) / 100 : num
    }
    const head = mode === 'QUARTER' ? out.t402m_s : mode === 'EIGHTH' ? out.t201m_s : out.t100_200_s
    if (head == null) { alert(`Enter the ${mode === 'ROLL' ? '100-200 time' : mode === 'QUARTER' ? '1/4 ET' : '1/8 ET'}.`); return null }
    return {
      ...out,
      pack: form.pack.trim() || null,
      run_date: form.dyear && form.dmonth && form.dday ? `${form.dyear}-${form.dmonth}-${form.dday}` : null,
      ...(mode === 'ROLL' ? { kind: 'ROLL', device: form.track.trim() || null } : { kind: 'DRAG', track: form.track.trim() || null }),
    }
  }

  async function addRun() {
    const row = formRow()
    if (!row) return
    setSaving(true)
    try {
      const saved = await insertRun(row)
      if (!saved) return
      setForm(emptyForm())
      await load()
      setReportToClient(false)
      setReportRun(saved)
    } finally { setSaving(false) }
  }

  function startEdit(r: Run) {
    const m = (r.run_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    const vals: Record<string, string> = {}
    for (const fld of FIELDS[mode]) {
      const v = n((r as unknown as Record<string, unknown>)[fld.key])
      vals[fld.key] = v == null ? '' : fld.speed ? (v * MPH_PER_KMH).toFixed(1) : String(v)
    }
    setForm({ pack: r.pack || '', track: (mode === 'ROLL' ? r.device : r.track) || '', dmonth: m ? m[2] : '', dday: m ? m[3] : '', dyear: m ? m[1] : '', vals })
    setEditingId(r.id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function saveEdit() {
    if (!editingId) return
    const row = formRow()
    if (!row) return
    delete row.kind
    setSaving(true)
    try {
      const { error } = await supabase.from('track_runs').update(row).eq('id', editingId)
      if (error) { alert(error.message); return }
      setEditingId(null)
      setForm(emptyForm())
      load()
    } finally { setSaving(false) }
  }

  async function removeRun(r: Run) {
    // One timeslip feeds both drag tabs — say so before it disappears from the other one too.
    const both = r.kind === 'DRAG' && r.t201m_s != null && r.t402m_s != null
    if (!window.confirm(both ? 'Remove this run? It is the same timeslip on the 1/8 MILE and the 1/4 MILE tabs — it leaves both.' : 'Remove this run?')) return
    const { error } = await supabase.from('track_runs').delete().eq('id', r.id)
    if (error) { alert(error.message); return }
    setRuns((prev) => prev.filter((x) => x.id !== r.id))
  }

  // ---- REPORTS -----------------------------------------------------------------------------------------------------
  function runReport(r: Run): string {
    const m = r.kind === 'ROLL' ? 'ROLL' : r.t402m_s != null ? 'QUARTER' : 'EIGHTH'
    const when = [r.run_date ? fmtDate(r.run_date) : null, r.run_time ? r.run_time.slice(0, 5) : null].filter(Boolean).join(' · ')
    const at = (t: number | null, v: number | null) => `${f3(t)} s${v != null ? ` @ ${f1(mph(v))} mph` : ''}`
    const lines: Array<string | null> = m === 'ROLL'
      ? [
          '🏁 *100-200 km/h*',
          rideTitle ? `*Ride:* ${rideTitle}` : null,
          r.pack ? `*Pack:* ${r.pack}` : null,
          `*Time:* ${f2(n(r.t100_200_s))} s${r.valid === true ? ' ✅ valid' : r.valid === false ? ' ❌ invalid' : ''}`,
          r.distance_m != null ? `*Distance:* ${f1(n(r.distance_m)! * FT_PER_M)} ft (${f2(n(r.distance_m))} m)` : null,
          r.slope_pct != null ? `*Slope:* ${f2(n(r.slope_pct))}%` : null,
          r.temp_c != null || r.density_alt_m != null
            ? `*Conditions:* ${r.temp_c != null ? `${f1(n(r.temp_c)! * 9 / 5 + 32)}°F` : ''}${r.altitude_m != null ? ` · alt ${Math.round(n(r.altitude_m)! * FT_PER_M)} ft` : ''}${r.density_alt_m != null ? ` · DA ${Math.round(n(r.density_alt_m)! * FT_PER_M)} ft` : ''}`
            : null,
          r.splits?.length ? `*Splits:* ${r.splits.map((s) => `100-${s.to} ${f2(s.s)}`).join(' · ')}` : null,
          when ? `*Date:* ${when}` : null,
          r.device ? `*Device:* ${r.device}` : null,
        ]
      : [
          `🏁 *${m === 'QUARTER' ? '1/4' : '1/8'} MILE PASS*`,
          rideTitle ? `*Ride:* ${rideTitle}` : null,
          r.pack ? `*Pack:* ${r.pack}` : null,
          m === 'QUARTER' ? `*ET:* ${at(n(r.t402m_s), n(r.v402m_kmh))}` : `*ET:* ${at(n(r.t201m_s), n(r.v201m_kmh))}`,
          r.t60ft_s != null ? `*60 ft:* ${f3(n(r.t60ft_s))} s` : null,
          r.t100m_s != null ? `*330 ft:* ${f3(n(r.t100m_s))} s` : null,
          m === 'QUARTER' && r.t201m_s != null ? `*1/8:* ${at(n(r.t201m_s), n(r.v201m_kmh))}` : null,
          m === 'QUARTER' && r.t302m_s != null ? `*1000 ft:* ${f3(n(r.t302m_s))} s` : null,
          r.reaction_s != null ? `*R/T:* ${f3(n(r.reaction_s))} s` : null,
          when ? `*Date:* ${when}` : null,
          r.track ? `*Track:* ${r.track}` : null,
        ]
    return lines.filter(Boolean).join('\n') + '\n\nSent by GZ28 Control App'
  }
  const docName = (r: Run) => `${r.kind === 'ROLL' ? '100-200-report' : 'timeslip'}.${(r.document_url || '').split('?')[0].split('.').pop() || 'jpg'}`

  async function sendWa(payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(payload) })
      const d = await res.json().catch(() => ({}))
      if (!d.ok) { alert('WhatsApp send failed: ' + (d?.detail?.error ? JSON.stringify(d.detail.error) : (d.error || `HTTP ${res.status}`))); return false }
      return true
    } catch (e) { alert('WhatsApp send failed: ' + String(e)); return false }
  }

  async function confirmReport() {
    if (!reportRun) return
    setReporting(true)
    try {
      const body = runReport(reportRun)
      const doc = reportRun.document_url ? { documentUrl: reportRun.document_url, filename: docName(reportRun) } : {}
      const ok = await sendWa({ toGroupName: reportsGroup, body, ...doc })
      if (ok && reportToClient) await sendToClientChannel(body, reportRun.document_url, doc, `${title} run`)
    } finally {
      setReporting(false)
      setReportRun(null)
    }
  }

  // The client's preferred channel — same routing as the dyno page.
  async function sendToClientChannel(body: string, link: string | null, doc: Record<string, unknown>, subjectLabel: string) {
    if (!client) { alert('This ride has no client on file — only the group was sent.'); return }
    const method = client.preferred_message_method || 'WhatsApp'
    const plain = body.replace(/\*/g, '') + (link ? `\n\nReceipt: ${link}` : '')
    if (method === 'WhatsApp') {
      const to = toWaNumber(client.phone, client.country)
      if (!to) { alert('Sent to the group. The client has no WhatsApp number on file.'); return }
      if (await sendWa({ to, body, ...doc })) alert(`Sent to ${client.name || 'client'} via WhatsApp.`)
      return
    }
    if (method === 'SMS') { window.location.href = `sms:${client.phone || ''}?&body=${encodeURIComponent(plain)}`; return }
    if (method === 'E-Mail') {
      const subject = `${subjectLabel}${rideTitle ? ` — ${rideTitle}` : ''}`
      window.location.href = `mailto:${client.email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      return
    }
    try { await navigator.clipboard.writeText(plain) } catch { /* clipboard may be blocked */ }
    if (method === 'Instagram') {
      const h = (client.instagram || '').replace(/^@/, '').trim()
      window.open(h ? `https://instagram.com/${h}` : 'https://www.instagram.com/direct/inbox/', '_blank')
      alert('Text copied. Open the client’s Instagram DM and paste to send.')
      return
    }
    if (method === 'Facebook') {
      const fb = (client.facebook || '').trim()
      const url = !fb ? 'https://www.facebook.com/messages/' : /^https?:\/\//i.test(fb) ? fb : fb.includes('facebook.com') ? `https://${fb.replace(/^\/+/, '')}` : `https://www.facebook.com/${fb.replace(/^@/, '')}`
      window.open(url, '_blank')
      alert('Text copied. Open the client’s Facebook / Messenger and paste to send.')
      return
    }
    alert(`This client prefers ${method}, which can't be sent automatically.\nThe text was copied to your clipboard — paste it into ${method}.`)
  }

  // ---- PDF (same sheet look as the DynoData RECEIPT) ---------------------------------------------------------------
  async function loadLogo(): Promise<{ data: string; w: number; h: number } | null> {
    try {
      const img = new window.Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = `${BASE_PATH}/logo_gz28.jpg` })
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d'); if (!ctx) return null
      ctx.drawImage(img, 0, 0)
      return { data: c.toDataURL('image/jpeg', 0.92), w: img.naturalWidth, h: img.naturalHeight }
    } catch { return null }
  }

  function gainOf(col: Col, a: Run, b: Run): number | null {
    const va = col.get(a), vb = col.get(b)
    return va == null || vb == null ? null : va - vb
  }

  async function buildPdf(): Promise<Blob> {
    const { jsPDF } = await import('jspdf')
    const autoTable = (await import('jspdf-autotable')).default
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()
    const logo = await loadLogo()
    if (logo) { const s = Math.min(48 / logo.w, 17 / logo.h); doc.addImage(logo.data, 'JPEG', 8, 5, logo.w * s, logo.h * s) }
    doc.setFont('helvetica', 'italic'); doc.setFontSize(13); doc.setTextColor(20, 20, 20)
    doc.text(sheetTitle() || title, pageW / 2, 12, { align: 'center', maxWidth: pageW - 120 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120)
    doc.text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), pageW / 2, 17.5, { align: 'center' })
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(20, 20, 20)
    doc.text(`${title} — TIMES IN SECONDS, SPEEDS IN MPH`, pageW - 8, 20, { align: 'right' })
    const WHITE: [number, number, number] = [255, 255, 255]
    const BLUE: [number, number, number] = [36, 51, 194]
    const body = ordered.map((r) => [
      { content: isBase(r) ? (r.pack || 'BoneStock') : (r.pack || '—'), styles: { fontStyle: 'bold', fillColor: WHITE, textColor: [40, 40, 40] } },
      { content: fmtDate(r.run_date), styles: { fillColor: WHITE, textColor: [80, 80, 80] } },
      ...cols.map((c) => ({ content: c.fmt(c.get(r)), styles: { fillColor: r === best ? [0, 140, 70] : BLUE, textColor: WHITE, fontStyle: 'bold' } })),
    ])
    const foot = reference && latest && reference !== latest
      ? [[
          { content: `GAINS (${isBase(reference) ? 'baseline' : 'first run'} → latest)`, colSpan: 2, styles: { fillColor: [0, 0, 0], textColor: WHITE, fontStyle: 'bold' } },
          ...cols.map((c) => { const g = c.better ? gainOf(c, latest, reference) : null; return { content: g == null ? '—' : (g > 0 ? '+' : '') + c.fmt(g), styles: { fillColor: [0, 0, 0], textColor: [46, 204, 113], fontStyle: 'bold' } } }),
        ]]
      : undefined
    autoTable(doc, {
      startY: 22,
      head: [['PACK', 'DATE', ...cols.map((c) => c.label)]],
      body: body as never, foot: foot as never,
      theme: 'grid',
      styles: { fontSize: 9, halign: 'center', valign: 'middle', cellPadding: 2.6, lineColor: [150, 150, 150], lineWidth: 0.2 },
      headStyles: { fillColor: [224, 224, 224], textColor: [55, 55, 55], fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 55 } },
      margin: { left: 8, right: 8 },
    })
    // 100-200: the best run's split ladder under the table.
    if (mode === 'ROLL' && best?.splits?.length) {
      const y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 60) + 8
      autoTable(doc, {
        startY: y,
        head: [best.splits.map((s) => `100-${s.to}`)],
        body: [best.splits.map((s) => f2(s.s))],
        theme: 'grid',
        styles: { fontSize: 8.5, halign: 'center', cellPadding: 2 },
        headStyles: { fillColor: [224, 224, 224], textColor: [55, 55, 55], fontStyle: 'bold' },
        margin: { left: 8, right: 8 },
      })
    }
    return doc.output('blob')
  }

  async function confirmSendData() {
    setSendingData(true)
    try {
      const blob = await buildPdf()
      const rideLabel = (rideTitle || sheetTitle() || title).replace(/\s*—\s*/g, ' ').trim()
      const fileLabel = `GZ28 V8 SpeedShop ${title.replace('/', '-')} RECEIPT - ${rideLabel}`
      const filename = `${fileLabel}.pdf`
      const slug = fileLabel.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'track-data'
      const path = `reports/${rideId}/${slug}-${Date.now()}.pdf`
      const { error } = await supabase.storage.from('dyno-charts').upload(path, blob, { upsert: true, contentType: 'application/pdf' })
      if (error) { alert('PDF upload failed: ' + error.message); return }
      const url = supabase.storage.from('dyno-charts').getPublicUrl(path).data.publicUrl
      // Dropbox Performance folder — best effort, the WhatsApp still goes out.
      try {
        const b64: string = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob) })
        await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'upload', zone: 'US', code: rideCode, name: rideName, filename, subfolder: 'Performance', contentBase64: b64 }) })
      } catch { /* non-fatal */ }
      const head = cols.find((c) => c.better === 'lower')!
      const lines = [
        `🏁 *GZ28US · ${title} RECEIPT:*`,
        sheetTitle() ? `*${sheetTitle()}*` : null,
        best ? `BEST: *${head.fmt(headline(mode, best))} s*${mode !== 'ROLL' ? (() => { const v = mode === 'QUARTER' ? best.v402m_kmh : best.v201m_kmh; return v != null ? ` @ ${f1(mph(n(v)))} mph` : '' })() : ''}${best.run_date ? ` (${fmtDate(best.run_date)})` : ''}` : null,
        reference && latest && reference !== latest
          ? `${head.label}: FROM ${head.fmt(head.get(reference))} TO *${head.fmt(head.get(latest))}* - GAIN: *${(() => { const g = gainOf(head, latest, reference); return g == null ? '—' : (g > 0 ? '+' : '') + head.fmt(g) + ' s' })()}*`
          : null,
      ].filter(Boolean).join('\n') + '\n\nSent by GZ28 Control App'
      if (!(await sendWa({ toGroupName: reportsGroup, body: lines, documentUrl: url, filename }))) return
      if (sendToClient) await sendToClientChannel(lines, url, { documentUrl: url, filename }, `GZ28US ${title} RECEIPT`)
    } catch (e) {
      alert('Could not generate/send the data: ' + String(e))
    } finally {
      setSendingData(false)
      setSendOpen(false)
    }
  }

  // ---- RENDER ------------------------------------------------------------------------------------------------------
  const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
  const placeLabel = mode === 'ROLL' ? 'DEVICE' : 'TRACK'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      {reportRun && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
            <h2 className="text-2xl font-bold">REPORT THIS RUN TO WHATSAPP?</h2>
            <pre className="text-xs text-gray-400 whitespace-pre-wrap bg-black/40 rounded-xl p-3 max-h-60 overflow-y-auto">{runReport(reportRun).replace(/\*/g, '')}</pre>
            <label className="flex items-center gap-3 text-lg cursor-pointer">
              <input type="checkbox" checked={reportToClient} onChange={(e) => setReportToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              Send to the client too?
            </label>
            {reportToClient && !client && <p className="text-sm text-yellow-400">This ride has no client on file — only the group report will be sent.</p>}
            <div className="flex gap-3 pt-1">
              <button onClick={() => setReportRun(null)} disabled={reporting} className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">SKIP</button>
              <button onClick={confirmReport} disabled={reporting} className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{reporting ? 'SENDING…' : 'SEND'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add / edit a run */}
      <div className="flex flex-wrap gap-3 items-start mb-6">
        <div className="flex-1 min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">PACK</label>
          <input value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} className={inputClass} placeholder="e.g. Stage 2" />
        </div>
        {FIELDS[mode].map((fld) => (
          <div key={fld.key} className="w-28">
            <label className="block mb-1 text-sm text-gray-400 font-bold">{fld.label}</label>
            <input value={form.vals[fld.key] || ''} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, vals: { ...form.vals, [fld.key]: e.target.value } }) }} className={inputClass} placeholder="0" />
          </div>
        ))}
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
          <label className="block mb-1 text-sm text-gray-400 font-bold">{placeLabel}</label>
          <input value={form.track} onChange={(e) => setForm({ ...form, track: e.target.value })} className={inputClass} placeholder={mode === 'ROLL' ? 'e.g. Dragy DRG69' : 'e.g. Orlando Speed World'} />
        </div>
        {editingId ? (
          <div className="flex gap-2">
            <div>
              <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">SAVE</label>
              <button onClick={saveEdit} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{saving ? 'SAVING…' : 'SAVE'}</button>
            </div>
            <div>
              <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">CANCEL</label>
              <button onClick={() => { setEditingId(null); setForm(emptyForm()) }} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
            </div>
          </div>
        ) : (
          <div>
            <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">ADD</label>
            <button onClick={addRun} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{saving ? 'SAVING…' : '+ ADD RUN'}</button>
          </div>
        )}
        <div>
          <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">SCAN</label>
          <button onClick={() => scanRef.current?.click()} disabled={scanning} className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{scanning ? 'SCANNING…' : mode === 'ROLL' ? 'SCAN REPORT' : 'SCAN TIMESLIP'}</button>
          <input ref={scanRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={handleScan} />
        </div>
      </div>
      <p className="text-sm text-purple-300 -mt-3 mb-6">
        {mode === 'ROLL'
          ? '📷 SCAN REPORT reads the 100-200 km/h report (Dragy and the like) — time, splits, distance, slope and conditions — and saves the run by itself.'
          : '📷 SCAN TIMESLIP reads the slip and saves the run by itself. One slip feeds both drag tabs: its 1/8 split shows on 1/8 MILE, its finish on 1/4 MILE.'}
      </p>

      {loading ? (
        <p className="text-lg text-gray-400">Loading...</p>
      ) : ordered.length === 0 ? (
        <p className="text-lg text-gray-400">No {title} runs recorded yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-gray-400 text-sm border-b border-gray-700">
                  <th className="py-2 pr-4 font-bold">PACK</th>
                  {cols.map((c) => <th key={c.label} className="py-2 pr-4 font-bold whitespace-nowrap">{c.label}</th>)}
                  <th className="py-2 pr-4 font-bold">DATE</th>
                  <th className="py-2 pr-4 font-bold">{placeLabel}</th>
                  <th className="py-2 pr-4 font-bold">DOC</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((r) => (
                  <tr key={r.id} className={`border-b border-gray-800 align-top ${isBase(r) ? 'bg-gray-800/40' : r === best ? 'bg-green-900/20' : ''}`}>
                    <td className={`py-3 pr-4 font-bold ${isBase(r) ? 'text-amber-300' : ''}`}>
                      {r.pack || '—'}{r === best ? <span className="ml-2 text-xs font-normal text-green-400">🏆 best</span> : null}
                      {mode === 'ROLL' && r.splits?.length ? <div className="text-xs font-normal text-gray-500 mt-1">{r.splits.map((s) => `100-${s.to} ${f2(s.s)}`).join(' · ')}</div> : null}
                      {mode === 'ROLL' && r.valid != null ? <div className={`text-xs font-normal mt-1 ${r.valid ? 'text-green-400' : 'text-red-400'}`}>{r.valid ? '✅ valid' : '❌ invalid'}</div> : null}
                    </td>
                    {cols.map((c) => <td key={c.label} className="py-3 pr-4 whitespace-nowrap">{c.fmt(c.get(r))}</td>)}
                    <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">{fmtDate(r.run_date)}{r.run_time ? <span className="block text-xs">{r.run_time.slice(0, 5)}</span> : null}</td>
                    <td className="py-3 pr-4 text-sm">{(mode === 'ROLL' ? r.device : r.track) || '—'}</td>
                    <td className="py-3 pr-4">{r.document_url ? <a href={r.document_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a> : '—'}</td>
                    <td className="py-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => startEdit(r)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                        <button onClick={() => removeRun(r)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                        <button onClick={() => { setReportToClient(false); setReportRun(r) }} className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded-xl font-bold text-sm">SEND</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {reference && latest && reference !== latest && (
                  <tr className="border-t-2 border-gray-600 bg-green-900/10">
                    <td className="py-3 pr-4 font-bold text-green-300">GAINS <span className="text-xs font-normal text-gray-400">({isBase(reference) ? 'baseline' : 'first run'} → latest)</span></td>
                    {cols.map((c) => {
                      const g = c.better ? gainOf(c, latest, reference) : null
                      const good = g != null && (c.better === 'lower' ? g < 0 : g > 0)
                      return <td key={c.label} className={`py-3 pr-4 font-bold ${g == null ? 'text-gray-500' : good ? 'text-green-400' : 'text-red-400'}`}>{g == null ? '—' : (g > 0 ? '+' : '') + c.fmt(g)}</td>
                    })}
                    <td colSpan={4}></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-center mt-6">
            <button onClick={() => { setSendToClient(false); setSendOpen(true) }} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">SEND {title} DATA</button>
          </div>
        </>
      )}

      {sendOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
            <h2 className="text-2xl font-bold">SEND {title} DATA TO WHATSAPP?</h2>
            <p className="text-sm text-gray-400">Generates the {title} sheet (every run + best + gains) as a PDF, saves it in the car&apos;s Dropbox Performance folder and sends it to the reports group.</p>
            <label className="flex items-center gap-3 text-lg cursor-pointer">
              <input type="checkbox" checked={sendToClient} onChange={(e) => setSendToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              Send to the client too?
            </label>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setSendOpen(false)} disabled={sendingData} className="bg-gray-600 hover:bg-gray-500 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">SKIP</button>
              <button onClick={confirmSendData} disabled={sendingData} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">{sendingData ? 'SENDING…' : 'SEND'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
