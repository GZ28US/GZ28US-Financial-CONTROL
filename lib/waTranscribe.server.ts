// SERVER-ONLY — TRANSCRIÇÃO DOS ÁUDIOS DO WHATSAPP.
//
// O problema que isto mata (02/set/2026): metade do que chega nos dois números
// vem em áudio (`ptt`/`audio`). O espelho guardava a linha e o link da mídia,
// mas o conteúdo era um buraco — uma rodada de leitura passava por cima de um
// áudio do advogado sem saber o que ele disse. Agora cada áudio espelhado vira
// texto numa COLUNA PRÓPRIA (`transcript`), nunca enfiado no `body`, e quem lê
// o espelho lê o áudio junto.
//
//   webhook / cron whatsapp-sync  ──→  whatsapp_messages (linha + media_url)
//                                             │
//                        cron whatsapp-transcribe  ──→  transcript
//
// PROVIDER — proposital: qualquer endpoint compatível com o formato
// `POST {base}/audio/transcriptions` (OpenAI e Groq falam o mesmo protocolo).
// Trocar de fornecedor é trocar env var, não código:
//   STT_API_KEY   — a chave (única obrigatória)
//   STT_BASE_URL  — default https://api.openai.com/v1
//   STT_MODEL     — default whisper-1
// Sem STT_API_KEY o worker não quebra: devolve `skipped: 'no key'` e segue.
import { waDb } from '@/lib/waStore.server'

// Áudio do WhatsApp é pequeno (voice note de 1 min ≈ 300KB); o teto dos
// provedores é 25MB. O que passar disso não vale a chamada.
const MAX_BYTES = 24 * 1024 * 1024

export type WaTranscribeResult = {
  scanned: number
  done: number
  failed: number
  skipped?: string
  rateLimited?: boolean
  errors?: string[]
}

type PendingRow = { app: string; message_id: string; media_url: string }

// Um áudio: baixa a mídia e devolve o texto. Erros viram exceção com mensagem
// curta — quem chama grava no `transcript_error` da linha.
async function transcribeOne(mediaUrl: string): Promise<string> {
  const base = (process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.STT_MODEL || 'whisper-1'
  const key = process.env.STT_API_KEY!

  const media = await fetch(mediaUrl)
  if (!media.ok) throw new Error(`media ${media.status}`)
  const buf = await media.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error(`too big (${Math.round(buf.byteLength / 1e6)}MB)`)
  if (buf.byteLength < 512) throw new Error('media empty')

  // O nome do arquivo importa: o provider decide o decoder pela extensão, e a
  // UltraMsg entrega voice note como .ogg (opus).
  const ext = (mediaUrl.split('?')[0].match(/\.(ogg|oga|mp3|m4a|wav|webm|mp4)$/i)?.[1] || 'ogg').toLowerCase()
  const form = new FormData()
  form.append('file', new Blob([buf]), `audio.${ext}`)
  form.append('model', model)
  form.append('response_format', 'text')

  const r = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`stt ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
  return text.trim()
}

// Varre os áudios ainda sem transcrição e transcreve `limit` deles. Idempotente
// — a própria coluna `transcript_status` é a fila, então rodar duas vezes não
// duplica trabalho nem cobra duas vezes.
export async function waTranscribePending(opts: { limit?: number } = {}): Promise<WaTranscribeResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  if (!process.env.STT_API_KEY) return { scanned: 0, done: 0, failed: 0, skipped: 'no key' }

  const db = waDb()
  // Os que ainda não foram tentados. `error` fica de fora de propósito: falha
  // repetida não pode virar loop de cobrança — reprocessar é decisão manual
  // (zerar o transcript_status da linha).
  const { data, error } = await db
    .from('whatsapp_messages')
    .select('app,message_id,media_url')
    .in('type', ['ptt', 'audio'])
    .not('media_url', 'is', null)
    .is('transcript_status', null)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`db: ${error.message}`)

  const rows = (data || []) as PendingRow[]
  const out: WaTranscribeResult = { scanned: rows.length, done: 0, failed: 0, errors: [] }

  for (const row of rows) {
    try {
      const transcript = await transcribeOne(row.media_url)
      await db
        .from('whatsapp_messages')
        .update({
          transcript: transcript.slice(0, 20000),
          transcript_status: transcript ? 'done' : 'empty',
          transcript_at: new Date().toISOString(),
          transcript_error: null,
        })
        .eq('app', row.app)
        .eq('message_id', row.message_id)
      out.done++
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 300)
      // 429 do provider NÃO é defeito da linha — é a nossa vez que não chegou.
      // Marcar 'error' aqui tirava o áudio da fila PARA SEMPRE (foi o que
      // aconteceu com 420 áudios no 1º backfill). Deixa o status NULL e para o
      // lote: quem volta é o cron, daqui a 10 minutos, com a cota renovada.
      if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
        out.rateLimited = true
        break
      }
      await db
        .from('whatsapp_messages')
        .update({ transcript_status: 'error', transcript_error: msg, transcript_at: new Date().toISOString() })
        .eq('app', row.app)
        .eq('message_id', row.message_id)
      out.failed++
      out.errors!.push(`${row.message_id}: ${msg}`)
    }
    // Respiro entre chamadas: o teto do provider é por minuto, e estourá-lo
    // devolve 429 pra todo o resto do lote.
    await new Promise(r => setTimeout(r, 1200))
  }

  if (!out.errors!.length) delete out.errors
  return out
}
