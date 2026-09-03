'use client'

// LATE FEE — bloco único do formulário de fornecedor fixo (NEW e EDIT usam o
// MESMO componente; a regra de multa é uma só, então o formulário também).
// Todos os campos opcionais: tudo vazio = fornecedor sem multa contratada.
// A régua que consome isso mora em lib/lateFee.ts.

import { lateFeeFor, type LateFeeRule } from '@/lib/lateFee'

export type LateFeeForm = { grace: string; fixed: string; percent: string; daily: string; capDays: string }

export const emptyLateFee: LateFeeForm = { grace: '', fixed: '', percent: '', daily: '', capDays: '' }

const s = (v: number | null | undefined) => (v != null ? String(v) : '')
/** Linha do banco → estado do formulário. */
export function lateFeeFromRow(r: any): LateFeeForm {
  return { grace: s(r?.late_grace_days), fixed: s(r?.late_fee_fixed), percent: s(r?.late_fee_percent), daily: s(r?.late_fee_daily), capDays: s(r?.late_fee_daily_cap_days) }
}
const n = (v: string) => (v.trim() === '' ? null : Number(v))
const i = (v: string) => (v.trim() === '' ? null : parseInt(v, 10))
/** Estado do formulário → colunas do banco (vazio grava NULL, não zero). */
export function lateFeeToRow(f: LateFeeForm) {
  return {
    late_grace_days: i(f.grace),
    late_fee_fixed: n(f.fixed),
    late_fee_percent: n(f.percent),
    late_fee_daily: n(f.daily),
    late_fee_daily_cap_days: i(f.capDays),
  }
}

const isNum = (v: string) => v === '' || /^\d*\.?\d*$/.test(v)
const isInt = (v: string) => v === '' || /^\d*$/.test(v)

export default function LateFeeFields({ value, onChange, sampleAmount, dueDay }: { value: LateFeeForm; onChange: (v: LateFeeForm) => void; sampleAmount?: number; dueDay?: number }) {
  const box = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 text-xl'
  const set = (k: keyof LateFeeForm) => (v: string) => onChange({ ...value, [k]: v })

  // Prévia com números de verdade: aplica a régua a uma conta do valor do slot,
  // vencida no dia configurado, 10 dias atrasada. Mostra o que ELE vai ver.
  const rule = lateFeeToRow(value) as LateFeeRule
  const amt = Number(sampleAmount) || 0
  const day = dueDay && dueDay >= 1 && dueDay <= 28 ? dueDay : 1
  const due = `2026-01-${String(day).padStart(2, '0')}`
  const asOf = `2026-01-${String(Math.min(day + 10, 28)).padStart(2, '0')}`
  const preview = lateFeeFor(rule, amt, due, asOf)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-5 space-y-3">
      <p className="text-sm text-gray-400 font-bold">LATE FEE <span className="font-normal">— o que o contrato cobra se esta conta atrasar. Deixe tudo vazio se este fornecedor não cobra multa.</span></p>
      <div className="flex gap-3 flex-wrap">
        <div className="w-32">
          <label className="block mb-1 text-xs text-gray-500 font-bold">GRACE DAYS</label>
          <input type="text" inputMode="numeric" value={value.grace} onChange={(e) => { if (isInt(e.target.value)) set('grace')(e.target.value) }} className={box} placeholder="0" title="Dias depois do vencimento em que pagar ainda é pagar em dia" />
        </div>
        <div className="w-36">
          <label className="block mb-1 text-xs text-gray-500 font-bold">FIXED</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg">$</span>
            <input type="text" inputMode="decimal" value={value.fixed} onChange={(e) => { if (isNum(e.target.value)) set('fixed')(e.target.value) }} className={`${box} pl-9`} placeholder="—" />
          </div>
        </div>
        <div className="w-32">
          <label className="block mb-1 text-xs text-gray-500 font-bold">PERCENT</label>
          <div className="relative">
            <input type="text" inputMode="decimal" value={value.percent} onChange={(e) => { if (isNum(e.target.value)) set('percent')(e.target.value) }} className={`${box} pr-9`} placeholder="—" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg">%</span>
          </div>
        </div>
        <div className="w-36">
          <label className="block mb-1 text-xs text-gray-500 font-bold">PER DAY</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg">$</span>
            <input type="text" inputMode="decimal" value={value.daily} onChange={(e) => { if (isNum(e.target.value)) set('daily')(e.target.value) }} className={`${box} pl-9`} placeholder="—" />
          </div>
        </div>
        <div className="w-36">
          <label className="block mb-1 text-xs text-gray-500 font-bold">MAX DAYS</label>
          <input type="text" inputMode="numeric" value={value.capDays} onChange={(e) => { if (isInt(e.target.value)) set('capDays')(e.target.value) }} className={box} placeholder="—" title="Teto de dias que a diária pode cobrar (Luma: 15)" />
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Vale o <b>MAIOR</b> entre FIXED e PERCENT, mais PER DAY por dia de atraso depois da tolerância.
      </p>
      {preview
        ? <p className="text-xs text-amber-300">Prévia: conta de {fmt(amt)} vencida dia {day} e paga dia {Math.min(day + 10, 28)} — multa de <b>{fmt(preview.fine)}</b> ({preview.billableDays} {preview.billableDays === 1 ? 'dia' : 'dias'} de diária).</p>
        : <p className="text-xs text-gray-600">Sem multa configurada — o app só avisa o vencimento, não calcula multa.</p>}
    </div>
  )
}

function fmt(v: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) }
