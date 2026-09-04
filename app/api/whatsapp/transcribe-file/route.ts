import { NextRequest, NextResponse } from 'next/server'
import { sttTranscribe } from '@/lib/waTranscribe.server'

// Transcrição de um áudio SOLTO, que não passou pelo espelho.
//
// Por que existe: o WhatsApp HUB só começou a gravar em ago/2026, e os exports
// de conversa trazem anos de áudio anteriores a isso — foi assim que a resposta
// sobre a documentação de um carro ficou inaudível dentro de um zip de 10 GB.
// A fila do cron não alcança esses; este endpoint alcança.
//
//   POST /ca/api/whatsapp/transcribe-file?key=<WHATSAPP_READ_KEY>
//   multipart/form-data, campo `file` (ogg/opus, mp3, m4a, wav, webm, mp4)
//
// Não grava nada: recebe bytes, devolve texto. Quem chama decide onde guardar.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (need && req.nextUrl.searchParams.get('key') !== need) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let file: File | null = null
  try {
    const form = await req.formData()
    const f = form.get('file')
    if (f instanceof File) file = f
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data with a `file` field' }, { status: 400 })
  }
  if (!file) return NextResponse.json({ error: 'missing `file`' }, { status: 400 })

  const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'ogg').toLowerCase()

  try {
    const transcript = await sttTranscribe(await file.arrayBuffer(), ext)
    return NextResponse.json({ ok: true, filename: file.name, bytes: file.size, transcript })
  } catch (e) {
    const msg = String((e as Error).message || e)
    // 429 é a nossa vez que não chegou, não defeito do arquivo — quem chama
    // repete daqui a pouco em vez de desistir.
    const status = /\b429\b|rate.?limit/i.test(msg) ? 429 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
