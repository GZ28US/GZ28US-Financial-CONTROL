'use client'

// PART PICKER — o formulário escolhe do catálogo em vez de digitar texto livre
// (pré-P1 do Crew Chief, 24/ago/2026): entrada nova já NASCE linkada (part_id),
// e o LINKER do Data Checker vira ferramenta de legado, não rotina. Busca por
// part number, nome ou apelido; 🔒 = peça travada (conferida pelo Márcio).
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

export type PickedPart = { id: string; item: string; alias: string | null; part_number: string | null; supplier: string | null; unit_price: number | null; locked: boolean }
type Row = PickedPart & { hay: string }

export default function PartPicker({ onPick, placeholder = 'buscar no catálogo (PN, nome, apelido)…' }: { onPick: (p: PickedPart) => void; placeholder?: string }) {
  const [catalog, setCatalog] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<PickedPart | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const acc: Row[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('parts_database').select('id, item, alias, part_number, supplier, unit_price, source_type, locked_at').order('item').range(from, from + 999)
        if (error || !data) break
        for (const p of data) acc.push({ id: p.id, item: p.item || '', alias: p.alias, part_number: p.part_number, supplier: p.supplier, unit_price: p.unit_price == null ? null : Number(p.unit_price), locked: p.locked_at != null || p.source_type === 'LOCKED', hay: [p.part_number, p.alias, p.item, p.supplier].filter(Boolean).join(' ').toUpperCase() })
        if (data.length < 1000) break
      }
      if (live) setCatalog(acc)
    })()
    return () => { live = false }
  }, [])

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const hits = useMemo(() => {
    const needle = q.trim().toUpperCase()
    if (!catalog || needle.length < 2) return []
    const toks = needle.split(/\s+/)
    return catalog.filter(r => toks.every(t => r.hay.includes(t))).slice(0, 8)
  }, [catalog, q])

  const pick = (p: Row) => { setPicked(p); setQ(''); setOpen(false); onPick(p) }

  return (
    <div ref={box} className="relative">
      <label className="text-sm text-gray-400 font-bold">PEÇA DO CATÁLOGO <span className="text-gray-600 font-normal">(opcional — linka a entrada à peça)</span></label>
      {picked ? (
        <div className="flex items-center gap-2 mt-1">
          <span className="bg-gray-800 border border-gray-600 rounded-2xl px-3 py-2 text-sm flex-1 truncate">{picked.locked ? '🔒 ' : ''}{[picked.part_number, picked.alias || picked.item].filter(Boolean).join(' · ')}</span>
          <button type="button" onClick={() => { setPicked(null) }} className="text-gray-400 hover:text-white font-bold px-2" title="desfazer escolha">✕</button>
        </div>
      ) : (
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} placeholder={catalog ? placeholder : 'carregando catálogo…'} disabled={!catalog}
          className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-2 text-base mt-1" />
      )}
      {open && hits.length > 0 && !picked && (
        <div className="absolute z-30 mt-1 w-full bg-gray-900 border border-gray-600 rounded-2xl overflow-hidden shadow-xl">
          {hits.map(h => (
            <button type="button" key={h.id} onClick={() => pick(h)} className="block w-full text-left px-4 py-2 hover:bg-gray-700 text-sm border-b border-gray-800 last:border-0">
              {h.locked ? '🔒 ' : ''}<b>{h.part_number || 'sem PN'}</b> · {h.alias || h.item}{h.supplier ? <span className="text-gray-500"> · {h.supplier}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
