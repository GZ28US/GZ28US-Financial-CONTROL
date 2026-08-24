'use client'

// TAX SHIELD (ADM ▸ TAX SHIELD; "TAX HUB" no nascimento, escudado em 23/ago/2026): impostos e obrigações da GZ28US.
// Regra da casa: o app ORGANIZA os fatos (quem recebeu, quanto, quando — direto
// do extrato); quem AFIRMA a lei é a Drummond. Módulo 1: rastreador de 1099-NEC.
// Na fila: FL Sales Tax (DR-15), pacote de fim de ano, impostos de veículo.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/Header'
import TaxBadge from '@/components/TaxBadge'
import { sessionHeaders } from '@/components/BankReconcileCard'
import { BASE_PATH, formatShortDate } from '@/lib/utils'
import { TAX_CHANGELOG } from '@/lib/taxVersion'

const usd = (v: number) => '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
type Payee = { key: string; name: string; total: number; n: number; methods: string[]; last_date: string; classification: string | null; w9_on_file: boolean; notes: string | null }
type Year = { year: string; payees: Payee[] }
type MergeHint = { a_key: string; a_name: string; b_key: string; b_name: string }

const CLS = [
  { value: 'SERVICE', label: 'Serviço — candidato a 1099' },
  { value: 'GOODS', label: 'Mercadoria (fora do 1099)' },
  { value: 'CORPORATION', label: 'Corporação (fora do 1099)' },
  { value: 'PERSONAL', label: 'Pessoal / sócio' },
  { value: 'IGNORE', label: 'Ignorar' },
]
const MODULES = [
  { title: '1099-NEC', sub: 'contratados pagos por Zelle/wire/cheque', live: true },
  { title: 'FL SALES TAX', sub: 'DR-15 — coletado × recolhido', live: false },
  { title: 'YEAR-END PACK', sub: 'pacote anual pra Drummond', live: false },
  { title: 'VEHICLE TAXES', sub: 'compra de carro — taxas e títulos', live: false },
]

export default function TaxHubPage() {
  const [years, setYears] = useState<Year[] | null>(null)
  const [hints, setHints] = useState<MergeHint[]>([])
  const [needsAliasMig, setNeedsAliasMig] = useState(false)
  const [merging, setMerging] = useState<string | null>(null)   // key da linha com o UNIR aberto
  const [needsMigration, setNeedsMigration] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Record<string, { classification: string; w9: boolean; notes: string }>>({})
  const [saving, setSaving] = useState<string | null>(null)

  async function load() {
    setError('')
    try {
      const r = await fetch(`${BASE_PATH}/api/tax/1099`, { headers: await sessionHeaders() })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setYears(d.years || []); setNeedsMigration(!!d.needs_migration); setHints(d.merge_hints || []); setNeedsAliasMig(!!d.needs_alias_migration)
      const dr: Record<string, { classification: string; w9: boolean; notes: string }> = {}
      for (const y of d.years || []) for (const p of y.payees) dr[p.key] = { classification: p.classification || '', w9: p.w9_on_file, notes: p.notes || '' }
      setDraft(dr)
    } catch (e) { setError(String((e as Error).message || e)); setYears([]) }
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  async function save(p: Payee) {
    const v = draft[p.key]; if (!v) return
    setSaving(p.key)
    try {
      const r = await fetch(`${BASE_PATH}/api/tax/1099`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ key: p.key, name: p.name, classification: v.classification || null, w9_on_file: v.w9, notes: v.notes }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { if (d.needs_migration) setNeedsMigration(true); alert(d.error || `Falhou (${r.status})`); return }
      // reflete em todos os anos do mesmo beneficiário
      setYears(prev => (prev || []).map(y => ({ ...y, payees: y.payees.map(x => x.key === p.key ? { ...x, classification: v.classification || null, w9_on_file: v.w9, notes: v.notes || null } : x) })))
    } finally { setSaving(null) }
  }

  const pendings = (y: Year) => y.payees.filter(p => !p.classification || (p.classification === 'SERVICE' && !p.w9_on_file)).length
  const allPayees = () => { const m = new Map<string, string>(); for (const y of years || []) for (const p of y.payees) m.set(p.key, p.name); return [...m.entries()] }
  async function merge(canonical: Payee, aliasKey: string) {
    const aliasName = allPayees().find(([k]) => k === aliasKey)?.[1] || aliasKey
    if (!confirm(`Unir "${aliasName}" em "${canonical.name}"? A linha some e os totais somam no ${canonical.name}. Fica na trilha e dá pra reverter só editando os apelidos.`)) return
    setSaving('merge')
    try {
      const r = await fetch(`${BASE_PATH}/api/tax/1099`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ action: 'merge', canonical_key: canonical.key, canonical_name: canonical.name, alias_key: aliasKey }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { if (d.needs_migration) setNeedsAliasMig(true); alert(d.error || `Falhou (${r.status})`); return }
      setMerging(null); await load()
    } finally { setSaving(null) }
  }

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1">
        <h1 className="text-4xl font-bold">TAX SHIELD</h1>
        <TaxBadge />
        <a href={`${BASE_PATH}/adm/check`} className="text-gray-400 hover:text-white font-bold">DATA CHECKER →</a>
      </div>
      <p className="text-xl text-gray-400 mb-6 max-w-3xl">O app organiza os fatos fiscais — quem afirma a lei é a Drummond.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-4xl mb-8">
        {MODULES.map(m => (
          <div key={m.title} className={`rounded-2xl border p-4 ${m.live ? 'bg-gray-900 border-gray-700' : 'bg-gray-950 border-gray-800 opacity-60'}`}>
            <p className="font-bold">{m.title}</p>
            <p className="text-xs text-gray-500 mt-1">{m.sub}</p>
            {!m.live && <p className="text-[10px] font-bold text-amber-300 mt-2">EM BREVE</p>}
          </div>
        ))}
      </div>

      <h2 className="text-2xl font-bold mb-1">1099-NEC — quem a LLC pagou por Zelle, wire ou cheque</h2>
      <p className="text-sm text-gray-400 mb-4 max-w-3xl">Regra geral: <b>serviço</b> somando <b>$600+ no ano</b> pago a <b>não-corporação</b> pede 1099-NEC até <b>31 de janeiro</b> (peça o W-9 antes de pagar, não depois). Mercadoria e corporações normalmente ficam fora; cartão/PayPal é 1099-K do processador. Classifique cada beneficiário — a Drummond bate o martelo.</p>
      {needsMigration && <div className="bg-amber-950/40 border border-amber-700 rounded-2xl p-4 mb-4 max-w-4xl"><p className="text-amber-300 font-bold">Rode MIGRATION_tax_1099.sql no SQL Editor</p><p className="text-sm text-gray-300">Os totais já aparecem; a classificação e o W-9 só gravam com a tabela tax_contractors criada.</p></div>}
      {!needsMigration && needsAliasMig && <div className="bg-amber-950/40 border border-amber-700 rounded-2xl p-4 mb-4 max-w-4xl"><p className="text-amber-300 font-bold">Rode MIGRATION_tax_1099_v2.sql no SQL Editor</p><p className="text-sm text-gray-300">O UNIR (apelidos de beneficiário) precisa da coluna aliases.</p></div>}
      {hints.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-4 max-w-4xl">
          <p className="text-sm font-bold text-amber-300 mb-1">PARECE O MESMO — o banco trunca nomes; una se for a mesma pessoa/empresa:</p>
          {hints.map(h => (
            <p key={h.a_key + h.b_key} className="text-sm text-gray-300">"{h.b_name}" ⇄ "{h.a_name}" <button disabled={saving !== null || needsAliasMig} onClick={() => { const y = (years || []).flatMap(x => x.payees).find(p => p.key === h.a_key); if (y) merge(y, h.b_key) }} className="ml-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 px-2 py-0.5 rounded-lg font-bold text-xs">UNIR EM "{h.a_name.slice(0, 18)}"</button></p>
          ))}
        </div>
      )}
      {error && <p className="text-red-400 mb-4">{error} <button onClick={load} className="underline ml-2">tentar de novo</button></p>}
      {!years ? <p className="text-gray-400">Lendo o extrato…</p> : years.length === 0 ? <p className="text-gray-400">Nenhum beneficiário com $600+ num ano.</p> : years.map(y => (
        <div key={y.year} className="bg-gray-900 border border-gray-800 rounded-3xl p-6 mb-6 max-w-6xl overflow-x-auto">
          <div className="flex items-baseline gap-3 mb-3">
            <h3 className="text-xl font-bold">{y.year}</h3>
            <span className="text-sm text-gray-500">{y.payees.length} beneficiários com $600+</span>
            <span className={`text-xs font-bold ${pendings(y) === 0 ? 'text-emerald-400' : 'text-amber-300'}`}>{pendings(y) === 0 ? '✓ tudo classificado' : pendings(y) + ' pendentes'}</span>
            {y.year !== String(new Date().getFullYear()) && <span className="text-xs text-gray-500">1099 até 31/jan/{Number(y.year) + 1}</span>}
          </div>
          <table className="w-full text-left text-sm">
            <thead><tr className="text-gray-400 text-xs border-b border-gray-700">
              <th className="py-2 pr-3 font-bold">BENEFICIÁRIO</th><th className="py-2 pr-3 font-bold text-right">TOTAL</th><th className="py-2 pr-3 font-bold">PGTOS</th><th className="py-2 pr-3 font-bold">VIA</th><th className="py-2 pr-3 font-bold">ÚLTIMO</th><th className="py-2 pr-3 font-bold">CLASSIFICAÇÃO</th><th className="py-2 pr-3 font-bold">W-9</th><th className="py-2 pr-3 font-bold">NOTAS</th><th className="py-2 font-bold"></th>
            </tr></thead>
            <tbody>
              {y.payees.map(p => { const v = draft[p.key] || { classification: '', w9: false, notes: '' }; const dirty = v.classification !== (p.classification || '') || v.w9 !== p.w9_on_file || (v.notes || '') !== (p.notes || '')
                return (
                  <tr key={p.key} className="border-b border-gray-800">
                    <td className="py-2 pr-3 font-bold whitespace-nowrap">{p.name}{!p.classification && <span className="ml-2 text-[10px] font-bold text-amber-300">CLASSIFICAR</span>}{p.classification === 'SERVICE' && !p.w9_on_file && <span className="ml-2 text-[10px] font-bold text-red-300">SEM W-9</span>}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-bold">{usd(p.total)}</td>
                    <td className="py-2 pr-3 tabular-nums">{p.n}</td>
                    <td className="py-2 pr-3 text-xs text-gray-400">{p.methods.join('·')}</td>
                    <td className="py-2 pr-3 text-xs text-gray-400 whitespace-nowrap">{formatShortDate(p.last_date)}</td>
                    <td className="py-2 pr-3"><select value={v.classification} onChange={e => setDraft({ ...draft, [p.key]: { ...v, classification: e.target.value } })} className="bg-gray-950 border border-gray-700 rounded-xl px-2 py-1 text-xs"><option value="">— classificar —</option>{CLS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></td>
                    <td className="py-2 pr-3"><input type="checkbox" checked={v.w9} onChange={e => setDraft({ ...draft, [p.key]: { ...v, w9: e.target.checked } })} className="w-4 h-4" /></td>
                    <td className="py-2 pr-3"><input value={v.notes} onChange={e => setDraft({ ...draft, [p.key]: { ...v, notes: e.target.value } })} placeholder="EIN, contato…" className="bg-gray-950 border border-gray-700 rounded-xl px-2 py-1 text-xs w-40" /></td>
                    <td className="py-2 whitespace-nowrap"><button disabled={!dirty || saving === p.key || needsMigration} onClick={() => save(p)} className="bg-green-700 hover:bg-green-600 disabled:opacity-30 px-3 py-1 rounded-xl font-bold text-xs">{saving === p.key ? '…' : 'SALVAR'}</button>
                      <button disabled={saving !== null || needsAliasMig} onClick={() => setMerging(merging === p.key ? null : p.key)} className="ml-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 px-2 py-1 rounded-xl font-bold text-xs" title="o banco truncou o nome? una as duas linhas">UNIR…</button>
                      {merging === p.key && (
                        <select autoFocus onChange={e => { if (e.target.value) merge(p, e.target.value) }} defaultValue="" className="ml-1 bg-gray-950 border border-gray-700 rounded-xl px-2 py-1 text-xs max-w-[10rem]">
                          <option value="">— quem é o mesmo? —</option>
                          {allPayees().filter(([k]) => k !== p.key).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                        </select>
                      )}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="mt-10 max-w-4xl">
        <h2 className="text-xl font-bold mb-3 text-gray-300">CHANGELOG</h2>
        <div className="border border-gray-800 rounded-2xl divide-y divide-gray-800">
          {TAX_CHANGELOG.map(c => (
            <div key={c.version} className="px-4 py-3 flex gap-4 items-baseline">
              <span className="font-bold tabular-nums text-purple-300 w-16 shrink-0">v{c.version}</span>
              <span className="text-gray-500 text-xs w-20 shrink-0">{c.date}</span>
              <span className="text-sm text-gray-400">{c.notes}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-6 text-sm text-gray-500 max-w-3xl">Classificações gravam em <Link href="/adm/check" className="underline">tax_contractors</Link> e alimentam o card TAX do Data Checker.</p>
    </main>
  )
}
