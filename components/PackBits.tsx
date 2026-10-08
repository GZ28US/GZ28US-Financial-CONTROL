'use client'

import { useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BASE_PATH } from '@/lib/utils'
import { PACK_SCOPES, SCOPE_CLS, SCOPE_LABEL, scopeOf, type PackScope } from '@/lib/packScope'

// Selo do SCOPE de uma linha do pack (lib/packScope.ts). BOTH é o padrão: só aparece quando `showBoth`.
export function ScopeBadge({ scope, showBoth = false }: { scope?: unknown; showBoth?: boolean }) {
  const s = scopeOf({ scope })
  if (s === 'BOTH' && !showBoth) return null
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${SCOPE_CLS[s]}`}>{SCOPE_LABEL[s]}</span>
}

// Seletor do SCOPE, compacto, para a linha do editor.
export function ScopeSelect({ scope, onChange, disabled }: { scope?: unknown; onChange: (s: PackScope) => void; disabled?: boolean }) {
  const s = scopeOf({ scope })
  return (
    <select value={s} disabled={disabled} onChange={(e) => onChange(e.target.value as PackScope)}
      title="Where this line counts: both modes, only the shipped pack, only the in-house build, or only inside the Control App"
      className={`rounded-xl px-2 py-1 text-xs font-bold border border-gray-600 disabled:opacity-60 ${SCOPE_CLS[s]}`}>
      {PACK_SCOPES.map((o) => <option key={o} value={o} className="bg-gray-900 text-white">{SCOPE_LABEL[o]}</option>)}
    </select>
  )
}

// Miniatura de imagem da loja (foto da peça, logo do pack). `dark` = fundo escuro, para o logo branco em PNG transparente.
export function ShopThumb({ url, size = 56, dark = false, title }: { url?: string | null; size?: number; dark?: boolean; title?: string }) {
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" title={title || 'open image'}
      className={`shrink-0 rounded-xl overflow-hidden border border-gray-700 flex items-center justify-center ${dark ? 'bg-black' : 'bg-white'}`}
      style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
    </a>
  )
}

// Logo do pack em faixa larga (lettering + mascote), sempre em fundo escuro.
export function PackLogo({ url, height = 56 }: { url?: string | null; height?: number }) {
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer" title="open logo" className="inline-flex items-center bg-black border border-gray-800 rounded-xl px-3 py-1 shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="pack logo" style={{ height }} className="w-auto object-contain" loading="lazy" />
    </a>
  )
}

// Envia uma imagem para o bucket `shop-images` pela rota /api/shop-images (o bucket não aceita escrita do navegador).
export async function uploadShopImage(kind: 'parts' | 'packs', name: string, src: { file?: File; url?: string }): Promise<string> {
  const fd = new FormData()
  fd.set('kind', kind)
  fd.set('name', name)
  if (src.file) fd.set('file', src.file)
  if (src.url) fd.set('url', src.url)
  const { data } = await supabase.auth.getSession()
  const r = await fetch(`${BASE_PATH}/api/shop-images`, { method: 'POST', headers: { Authorization: `Bearer ${data.session?.access_token || ''}` }, body: fd })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.url) throw new Error(j.error || `upload failed (HTTP ${r.status})`)
  return String(j.url)
}

// Botões 📷 (arquivo) e 🔗 (link) que devolvem a URL pública da imagem enviada. Quem chama decide onde gravar.
export function ShopImagePicker({ kind, name, onDone, label = 'PHOTO', disabled }: {
  kind: 'parts' | 'packs'; name: string; onDone: (url: string) => void | Promise<void>; label?: string; disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  async function run(src: { file?: File; url?: string }) {
    setBusy(true)
    try { await onDone(await uploadShopImage(kind, name, src)) } catch (e) { alert(String((e as Error)?.message || e)) } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run({ file: f }) }} />
      <button type="button" disabled={disabled || busy} onClick={() => ref.current?.click()} className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded-xl font-bold text-xs whitespace-nowrap">{busy ? '…' : `📷 ${label}`}</button>
      <button type="button" disabled={disabled || busy} title="paste an image link — the picture is copied into the shop's storage"
        onClick={() => { const u = prompt('Image link (https://…)'); if (u && u.trim()) run({ url: u.trim() }) }}
        className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-2 py-1 rounded-xl font-bold text-xs">🔗</button>
    </span>
  )
}
