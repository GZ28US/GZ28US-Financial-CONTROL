import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'

// FOTO DA PEÇA e LOGO DO PACK (Márcio, 07–08/10/2026: «photo option in parts db!!!!!!» · «The LOGO of the PACK in packs db!!!!»).
// O bucket público `shop-images` (a loja lê dali) não aceita escrita do navegador — só a chave de serviço grava, e é por aqui.
//   POST multipart/form-data, header Authorization: Bearer <JWT da tela logada>
//     kind = parts | packs          → pasta dentro do bucket
//     name = PN, id ou nome do pack → vira o nome do arquivo (só [A-Za-z0-9._-])
//     file = a imagem  OU  url = link de uma imagem (é BAIXADA e copiada: não fica dependendo do site do fornecedor)
//   → { url } pública, pronta para gravar em parts_database.image_url, packs.logo_url ou packs.cars[].logo_url.
// Cada envio é um arquivo NOVO (nome + carimbo): a foto antiga não é sobrescrita nem apagada, e o cache do CDN não serve a velha.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 8 * 1024 * 1024
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' }

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  let form: FormData
  try { form = await req.formData() } catch { return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 }) }
  const kind = String(form.get('kind') || '')
  if (kind !== 'parts' && kind !== 'packs') return NextResponse.json({ error: 'kind must be parts or packs' }, { status: 400 })
  const base = String(form.get('name') || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image'

  let bytes: ArrayBuffer
  let type = ''
  const f = form.get('file')
  if (f instanceof File && f.size > 0) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: 'image larger than 8 MB' }, { status: 413 })
    bytes = await f.arrayBuffer(); type = f.type
  } else {
    const link = String(form.get('url') || '').trim()
    if (!/^https?:\/\//i.test(link)) return NextResponse.json({ error: 'send a file or an http(s) url' }, { status: 400 })
    const r = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 GZ28-ControlApp' }, signal: AbortSignal.timeout(20000) }).catch(() => null)
    if (!r || !r.ok) return NextResponse.json({ error: `could not download the image (HTTP ${r?.status ?? '—'})` }, { status: 502 })
    type = (r.headers.get('content-type') || '').split(';')[0].trim()
    bytes = await r.arrayBuffer()
    if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: 'image larger than 8 MB' }, { status: 413 })
  }
  type = type.toLowerCase()
  const ext = EXT[type]
  if (!ext) return NextResponse.json({ error: `not an image (${type || 'unknown type'})` }, { status: 415 })

  const path = `${kind}/${base}-${Date.now().toString(36)}.${ext}`
  const st = streamDb().storage.from('shop-images')
  const { error } = await st.upload(path, bytes, { contentType: type, upsert: false })
  if (error) return NextResponse.json({ error: 'upload failed: ' + error.message }, { status: 502 })
  return NextResponse.json({ url: st.getPublicUrl(path).data.publicUrl, path })
}
