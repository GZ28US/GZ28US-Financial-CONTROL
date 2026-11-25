// DEVOLUÇÃO LOGO DEPOIS DO ENVIO — caixas Outlook/Hotmail (25/11/2026, Márcio: «que isso pare de acontecer»).
//
// O fato: o e-mail à Drummond (25/11 16:16 Orlando) e o da CP-Carrillo (19/11) saíram pela rota mail-send com `ok:true` e
// voltaram 8 SEGUNDOS depois, de postmaster@outlook.com, para TODOS os destinatários:
//   «550 5.7.501 Service unavailable. Spam abuse detected from IP range. AS(130)»
// gerado pelo servidor da PRÓPRIA caixa (…BRAP284.PROD.OUTLOOK.COM) — é o filtro de saída da Microsoft, não o destinatário.
// O mesmo e-mail reenviado um minuto depois passou. Quem enviava não ficava sabendo: a devolução só aparecia na caixa.
//
// Aqui: depois de um envio pelo Graph, olha a caixa por alguns segundos atrás de uma devolução daquela mensagem e diz
// quem não recebeu e por quê. Só LÊ. A causa do 5.7.501 não está provada (duas ocorrências, as duas respostas em thread).
const G = 'https://graph.microsoft.com/v1.0'

export type Bounce = { id: string; received: string; subject: string; reason: string; code: string | null; failed: string[]; all: boolean }

const strip = (h: string) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&quot;/g, "'").replace(/\s+/g, ' ')

/** One look at the mailbox: a delivery-failure notice received since `sinceIso` that names one of `recipients` (and, when
 *  `subject` is given, carries it — two sends in a row to the same person must not read each other's notice).
 *  THROWS when the mailbox cannot be read: «could not look» is not «nothing came back». */
export async function findBounce(token: string, sinceIso: string, recipients: string[], exclude: string[] = [], subject = '', untilIso = ''): Promise<Bounce | null> {
  const want = recipients.map(r => String(r || '').trim().toLowerCase()).filter(Boolean)
  if (!want.length) return null
  // every folder (the organizer may have filed it already); filter by time only — `from` is checked here, not in OData
  const u = `${G}/me/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}` + (untilIso ? ` and receivedDateTime le ${untilIso}` : ''))}&$orderby=${encodeURIComponent('receivedDateTime desc')}&$select=id,subject,from,receivedDateTime,body&$top=25`
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error('Graph ' + r.status + ': ' + (await r.text()).slice(0, 160))
  const j = await r.json().catch(() => null)
  const subj0 = String(subject || '').trim().toLowerCase()
  for (const m of (j?.value || [])) {
    if (exclude.includes(m.id)) continue
    const from = String(m.from?.emailAddress?.address || '').toLowerCase()
    const subj = String(m.subject || '')
    if (!/^(postmaster|mailer-daemon)@/.test(from) && !/^(undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem))/i.test(subj)) continue
    if (subj0 && !subj.toLowerCase().includes(subj0)) continue
    const body = strip(m.body?.content || '')
    const low = body.toLowerCase()
    const failed = want.filter(a => low.includes(a))
    if (!failed.length) continue
    const reason = (body.match(/Remote server returned '([^']{0,240})'/i)?.[1] || body.match(/\b(5\.\d\.\d{1,3}\b[^.]{0,160})/)?.[1] || 'delivery failed').replace(/[<>]/g, '').trim()
    const code = reason.match(/\b5\.\d\.\d{2,3}\b/g)?.pop() || reason.match(/\b5\.\d\.\d\b/)?.[0] || null
    return { id: m.id, received: m.receivedDateTime, subject: subj, reason, code, failed, all: failed.length === want.length }
  }
  return null
}

/** Watches for up to `ms` (looks every 4 s). The two real cases came back in 8 s.
 *  checked=false → no look succeeded (error says why): the caller must NOT report «it did not bounce». */
export async function watchBounce(token: string, sinceIso: string, recipients: string[], opts: { ms?: number; exclude?: string[]; subject?: string } = {}): Promise<{ bounce: Bounce | null; checked: boolean; error?: string }> {
  const end = Date.now() + (opts.ms ?? 16000)
  let looks = 0, error = ''
  while (Date.now() < end) {
    await new Promise(res => setTimeout(res, 4000))
    try { const b = await findBounce(token, sinceIso, recipients, opts.exclude || [], opts.subject || ''); looks++; if (b) return { bounce: b, checked: true } }
    catch (e) { error = String((e as Error).message || e).slice(0, 200) }
  }
  return { bounce: null, checked: looks > 0, ...(looks > 0 ? {} : { error: error || 'no look at the mailbox succeeded' }) }
}

// the sender-side refusal that a plain resend got through (25/11): the only one that is retried by itself
export const isOutboundSpamBlock = (b: Bounce | null) => !!b && (b.code === '5.7.501' || /spam abuse detected/i.test(b.reason))
