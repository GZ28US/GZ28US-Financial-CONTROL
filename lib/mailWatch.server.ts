// SERVER-ONLY — MAIL WATCH (27/ago/2026). Ele pediu um aviso na hora em que o
// Bradenton/FL2K responder os dois e-mails do caso Street Car Shootout. Por
// [[auto-by-app-rule]] e [[claudinha-is-an-interface]] isso não vira script no PC
// dele: vira watcher do app, rodando no mail-poll de 5 min com o PC fechado.
//
// E não vira watcher DO FL2K — vira watcher GENÉRICO com a regra numa tabela
// (`mail_watches`). Da próxima vez que ele quiser ser avisado da resposta de um
// fornecedor, de um advogado ou de um comprador, é um INSERT, não um deploy.
//
// Casa a CAIXA INTEIRA (mesma lição do [[zelle-watch]]: o organizer arquiva em
// minutos, pasta nenhuma pode esconder a resposta) e ignora o que saiu da própria
// conta — senão o watcher se alarma com o e-mail que nós mesmos mandamos.

import type { SupabaseClient } from '@supabase/supabase-js'
import { listMailAuths, freshAccessToken, type MailAuth } from '@/lib/streamMail.server'
import { waSafeTarget } from '@/lib/waSelfGuard.server'

const G = 'https://graph.microsoft.com/v1.0'
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SIGNATURE = 'Sent by GZ28US Control App®'
const FIRST_RUN_MIN = 60
// As caixas vêm do banco (listMailAuths) e cada provedor tem sua perna: Graph
// para as Microsoft, Gmail API para as Google. Até 04/set/2026 o watcher era
// [1, 2, 3] e ignorava calado qualquer mail_watches.slot apontando para uma
// caixa Google — e é justamente lá (gz28speedshop) que caem Home Depot, Target,
// Sam's e cia. Vigia que não cobre a caixa onde o assunto vive é vigia inútil.

export type MailWatch = {
  id: string
  label: string
  slot: number
  from_pattern: string | null
  subject_pattern: string | null
  notify_to: string
  active: boolean
  hits: number
}

// `notify_to` vem do banco (mail_watches) — é o caminho mais fácil de alguém
// reapontar pro cel do Márcio sem querer e o alerta sumir de novo. Guarda aqui.
async function wa(to: string, body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return
  const dest = waSafeTarget(to) // nunca o próprio número — ver waSelfGuard
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: dest, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

// O snippet do Gmail vem com entidade HTML crua (&#39;, &quot;) — sem isto o
// aviso chega no WhatsApp com o código no meio da frase.
const clean = (h: string) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;|&#38;/g, '&').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;|&rsquo;/g, "'")
  .replace(/&lt;|&#60;/g, '<').replace(/&gt;|&#62;/g, '>').replace(/\s+/g, ' ').trim()
const has = (hay: string, needle: string | null) => !needle || String(hay || '').toLowerCase().includes(needle.toLowerCase())

export function matches(w: MailWatch, fromAddr: string, subject: string): boolean {
  if (!w.from_pattern && !w.subject_pattern) return false // regra vazia nunca casa com tudo
  return has(fromAddr, w.from_pattern) && has(subject, w.subject_pattern)
}

// Cursor por caixa: a MESMA linha de whatsapp_polling_state das duas pernas, para
// que trocar o provedor de um slot não faça o watcher reprocessar o passado.
//
// LEI DO CURSOR (04/set/2026, revisão adversarial): o cursor SÓ anda sobre o que
// foi comprovadamente lido. Antes ele avançava para `runStart` no fim da função,
// desse jeito: se o Gmail/Graph devolvesse 401, 429 ou 500, o `.catch(() => null)`
// virava "lista vazia" — igualzinho a "não chegou nada" — e a janela inteira era
// pulada PARA SEMPRE, em silêncio. O vigia existe justamente para o e-mail que
// não pode passar batido; perder a janela é o pior defeito possível nele.
async function readCursor(db: SupabaseClient, slot: number): Promise<string> {
  const { data } = await db.from('whatsapp_polling_state').select('*').eq('id', `mail-watch-${slot}`).limit(1)
  return data?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()
}
async function saveCursor(db: SupabaseClient, slot: number, until: string): Promise<void> {
  await db.from('whatsapp_polling_state').upsert({ id: `mail-watch-${slot}`, last_message_id: until, updated_at: new Date().toISOString() })
}
// Um achado vira aviso — igual nas duas pernas, para o alerta não depender do provedor.
async function fire(db: SupabaseClient, w: MailWatch, fromAddr: string, subject: string, preview: string, when: string, alerts: string[]): Promise<void> {
  await wa(w.notify_to, `📬 *RESPOSTA — ${w.label}*\nDe: ${fromAddr}\nAssunto: ${subject}\n\n${preview}${preview.length >= 400 ? '…' : ''}`)
  await db.from('mail_watches').update({ hits: (w.hits || 0) + 1, last_hit_at: when }).eq('id', w.id)
  w.hits = (w.hits || 0) + 1
  alerts.push(`${w.label} ← ${fromAddr}`)
}

// ── Perna Google ────────────────────────────────────────────────────────────
// in:anywhere cobre inbox, arquivados, spam e lixeira — a resposta que interessa
// costuma já ter sido arquivada pelo organizer quando o watcher passa.
// O `snippet` já vem no format=metadata e serve de preview sem baixar o corpo.
//
// O Gmail cobra uma requisição POR MENSAGEM só para ver De/Assunto (ao contrário
// do Graph, que devolve tudo na listagem). Então o filtro dos próprios watches
// entra na QUERY: o vigia já sabe de quem está esperando resposta, não faz sentido
// baixar a janela inteira. Sem isso eram até 100 idas sequenciais por caixa dentro
// dos 60s que o mail-poll divide com outros 14 trabalhos.
function gmailQuery(watches: MailWatch[], afterSec: number): string {
  // Só estreita quando TODO watch da caixa tem remetente; um watch só de assunto
  // depende da tokenização do Gmail e poderia esconder a mensagem — nesse caso
  // vale mais pagar a busca ampla do que arriscar não ver.
  const alvos = watches.map(w => String(w.from_pattern || '').trim()).filter(Boolean)
  const podeEstreitar = alvos.length === watches.length && alvos.length > 0
  const filtro = podeEstreitar ? ` (${[...new Set(alvos)].map(a => `from:${a}`).join(' OR ')})` : ''
  return `in:anywhere after:${afterSec}${filtro}`
}

async function gmailWatch(db: SupabaseClient, auth: MailAuth, slotWatches: MailWatch[], alerts: string[]): Promise<void> {
  const token = await freshAccessToken(db, auth)
  if (!token) return
  const H = { Authorization: `Bearer ${token}` }
  const self = String(auth.account || '').toLowerCase()
  // Sem saber o próprio endereço não dá para separar resposta de e-mail nosso, e
  // in:anywhere inclui os ENVIADOS: o vigia se alarmaria com a própria cobrança.
  if (!self) { console.warn('[mail-watch gmail] caixa sem account, pulando', auth.id); return }
  const slot = auth.id
  const runStart = new Date().toISOString()
  const cursor = await readCursor(db, slot)
  const cursorMs = new Date(cursor).getTime()
  if (!Number.isFinite(cursorMs)) { console.warn('[mail-watch gmail] cursor inválido', slot, cursor); return }
  // O `after:` do Gmail tem resolução de SEGUNDOS e é inclusivo; recuar 1s evita
  // perder a mensagem que chegou no mesmo segundo em que a passada anterior fechou.
  // A repetição que isso criaria morre no filtro `when > cursor` lá embaixo.
  const afterSec = Math.floor(cursorMs / 1000) - 1

  // Paginação de verdade: o Gmail devolve do mais NOVO para o mais velho, então
  // truncar em 100 jogaria fora justamente as mais ANTIGAS da janela — as que já
  // estavam esperando. Com teto, para não estourar o tempo da rota.
  const stubs: { id: string }[] = []
  let pageToken = ''
  let completo = true
  for (let pagina = 0; pagina < 5; pagina++) {
    const qs = new URLSearchParams({ maxResults: '100', q: gmailQuery(slotWatches, afterSec) })
    if (pageToken) qs.set('pageToken', pageToken)
    const r = await fetch(`${GM}/messages?${qs}`, { headers: H })
    const list = await r.json().catch(() => null)
    // 401/429/500 chegam como JSON de erro e NÃO lançam: sem esta checagem a
    // falha viraria "não chegou nada" e o cursor pularia a janela.
    if (!r.ok || list?.error) { console.error('[mail-watch gmail] list falhou', slot, r.status, list?.error?.message); return }
    stubs.push(...(list.messages || []))
    pageToken = list.nextPageToken || ''
    if (!pageToken) break
    if (pagina === 4) completo = false // bateu o teto: sobrou janela para a próxima passada
  }

  // Do mais velho para o mais novo, para o cursor seguro andar em ordem.
  stubs.reverse()
  let seguro = cursor
  for (const stub of stubs) {
    const r = await fetch(`${GM}/messages/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: H })
    const m = await r.json().catch(() => null)
    // Falha pontual numa mensagem: para aqui e deixa o cursor onde está, senão
    // essa mensagem nunca mais cairia em janela nenhuma.
    if (!r.ok || !m?.id) { console.error('[mail-watch gmail] msg falhou', slot, stub.id, r.status); completo = false; break }
    const hv = (n: string) => String((m.payload?.headers || []).find((h: { name?: string; value?: string }) => String(h.name || '').toLowerCase() === n)?.value || '')
    const fromRaw = hv('from')
    const fromAddr = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).toLowerCase().trim()
    const whenMs = Number(m.internalDate) || 0
    const when = whenMs ? new Date(whenMs).toISOString() : runStart
    // O recuo de 1s do `after:` reapresenta o que já foi avisado — corta aqui.
    if (whenMs && whenMs <= cursorMs) { seguro = when > seguro ? when : seguro; continue }
    if (fromAddr && fromAddr !== self) { // o que NÓS mandamos não é resposta
      const subject = hv('subject')
      for (const w of slotWatches) {
        if (!matches(w, fromAddr, subject)) continue
        await fire(db, w, fromAddr, subject, clean(String(m.snippet || '')).slice(0, 400), when, alerts)
      }
    }
    if (when > seguro) seguro = when
  }
  await saveCursor(db, slot, completo ? runStart : seguro)
}

export async function runMailWatch(db: SupabaseClient): Promise<{ alerts: string[] }> {
  const alerts: string[] = []

  const { data: rows } = await db.from('mail_watches').select('*').eq('active', true)
  const watches = (rows || []) as MailWatch[]
  if (!watches.length) return { alerts }

  // Graph primeiro: são as caixas que já funcionavam. A perna nova não pode
  // atrasar nem comer o tempo da rota antes que as antigas tenham rodado.
  for (const auth of await listMailAuths(db, 'graph')) {
    const slot = auth.id
    const slotWatches = watches.filter(w => Number(w.slot) === slot)
    if (!slotWatches.length) continue
    try {
      const token = await freshAccessToken(db, auth)
      if (!token) continue
      const self = String(auth.account || '').toLowerCase()
      if (!self) { console.warn('[mail-watch graph] caixa sem account, pulando', slot); continue }

      const runStart = new Date().toISOString()
      const cursor = await readCursor(db, slot)

      // Caixa inteira, não só a inbox.
      const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=subject,from,receivedDateTime,body&$orderby=receivedDateTime desc`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const res = await r.json().catch(() => null)
      // Mesma lei do cursor: erro do Graph não pode virar "janela vazia".
      if (!r.ok || !Array.isArray(res?.value)) { console.error('[mail-watch graph] list falhou', slot, r.status, res?.error?.message); continue }

      for (const m of res.value) {
        const fromAddr = String(m.from?.emailAddress?.address || '').toLowerCase()
        if (!fromAddr || fromAddr === self) continue // o que NÓS mandamos não é resposta
        const subject = String(m.subject || '')

        for (const w of slotWatches) {
          if (!matches(w, fromAddr, subject)) continue
          await fire(db, w, fromAddr, subject, clean(m.body?.content || '').slice(0, 400), m.receivedDateTime || runStart, alerts)
        }
      }

      // $top=100 sem paginação: se encheu, sobrou janela — o cursor fica na
      // mensagem mais antiga vista, não no relógio.
      const cheio = res.value.length >= 100
      const maisAntiga = cheio ? String(res.value[res.value.length - 1]?.receivedDateTime || cursor) : runStart
      await saveCursor(db, slot, maisAntiga)
    } catch (e) { console.error('[mail-watch graph]', slot, e) }
  }

  for (const auth of await listMailAuths(db, 'gmail')) {
    const slotWatches = watches.filter(w => Number(w.slot) === auth.id)
    if (!slotWatches.length) continue
    try { await gmailWatch(db, auth, slotWatches, alerts) } catch (e) { console.error('[mail-watch gmail]', auth.id, e) }
  }

  // Watch ativo apontando para caixa que não existe (ou sem token) era ignorado
  // em silêncio — o defeito que este arquivo veio matar, na variante do slot.
  const vivos = new Set((await listMailAuths(db)).map(a => a.id))
  for (const w of watches) if (!vivos.has(Number(w.slot))) console.warn('[mail-watch] watch sem caixa conectada:', w.label, 'slot', w.slot)

  return { alerts }
}
