import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth } from '@/lib/streamMail.server'
import { sendStreamWhatsApp } from '@/lib/stream.server'

// APPS watcher — o Gmail (stream_mail_auth slot 4) é a fonte da verdade das
// assinaturas de apps da empresa. Cada recibo vira um pagamento no módulo APPS
// (fixed_cost_suppliers cost_type='APP' + fixed_cost_expenses), o e-mail é
// arquivado no marcador Apps/<App> e o grupo recebe o report. App nunca visto
// antes é criado sozinho (regra 2026-07-25: "interferência zero minha").
//
// Dedup em duas camadas: o marcador Apps/* no próprio e-mail (processado = tem
// marcador) e o id da mensagem gravado em fixed_cost_expenses.receipt_url
// (link permanente do Gmail).

const SLOT = 4
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

// ── Apelidos: fornecedor do recibo → nome do app + domínios extras ──────────
// Só melhora a apresentação dos conhecidos; desconhecidos entram com o nome
// cru do recibo e o domínio do remetente (autossuficiente).
const APP_ALIASES: { match: RegExp; app: string; domains?: string[] }[] = [
  { match: /anthropic/i, app: 'Claude', domains: ['anthropic.com', 'claude.com'] },
  { match: /midjourney/i, app: 'Midjourney', domains: ['midjourney.com'] },
  { match: /supabase/i, app: 'Supabase', domains: ['supabase.com', 'supabase.io'] },
  { match: /vercel/i, app: 'Vercel', domains: ['vercel.com'] },
  { match: /skywork/i, app: 'Skywork AI', domains: ['skywork.ai'] },
  { match: /recraft/i, app: 'Recraft', domains: ['recraft.ai'] },
  { match: /candy\.?\s?ai/i, app: 'Candy.ai', domains: ['candy.ai'] },
  // O UltraMsg fatura como SWIFT TECH TRADING LLC no Stripe.
  { match: /swift tech trading/i, app: 'UltraMsg', domains: ['ultramsg.com'] },
  { match: /dropbox/i, app: 'Dropbox', domains: ['dropbox.com'] },
  { match: /openai|chatgpt/i, app: 'ChatGPT', domains: ['openai.com'] },
  { match: /github/i, app: 'GitHub', domains: ['github.com'] },
  { match: /google (one|workspace|storage)/i, app: 'Google One' },
  { match: /ultramsg/i, app: 'UltraMsg', domains: ['ultramsg.com'] },
  { match: /17track/i, app: '17TRACK', domains: ['17track.net'] },
]

type Msg = { id: string; from: string; subject: string; date: string; labelIds: string[] }
type AppRow = {
  id: string; description: string | null; company: string | null; email: string | null
  date_entry: string | null; payment_day_1: number | null; amount_1: number | null
  mail_match?: string | null
}

const fmtUSD = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
const fmtDate = (ymd: string) => new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
// Data local da cobrança (fuso da empresa) a partir do internalDate UTC do Gmail.
const ymdET = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const senderDomain = (from: string) => {
  const m = from.toLowerCase().match(/@([a-z0-9.-]+)/)
  if (!m) return ''
  const parts = m[1].split('.')
  return parts.slice(-2).join('.') === 'com.br' ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}

// ── Token (mesmo fluxo do mail-query, branch gmail) ─────────────────────────
async function gmailToken(db: SupabaseClient): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const auth = await getMailAuth(db, SLOT)
  if (!auth?.refresh_token) return null
  const tk = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: auth.refresh_token, grant_type: 'refresh_token' }),
  })).json()
  return tk?.access_token || null
}

const gh = (t: string) => ({ Authorization: `Bearer ${t}` })

async function listMessages(token: string, q: string, cap: number): Promise<{ id: string }[]> {
  const out: { id: string }[] = []
  let pageToken = ''
  while (out.length < cap) {
    const qs = new URLSearchParams({ maxResults: '100', q })
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await (await fetch(`${API}/messages?${qs}`, { headers: gh(token) })).json()
    out.push(...(data.messages || []))
    pageToken = data.nextPageToken || ''
    if (!pageToken) break
  }
  return out.slice(0, cap)
}

async function msgMeta(token: string, id: string): Promise<Msg | null> {
  const m = await (await fetch(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: gh(token) })).json()
  if (!m?.id) return null
  const hdr = (name: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
  return { id: m.id, from: hdr('From'), subject: hdr('Subject'), date: m.internalDate ? ymdET(+m.internalDate) : '', labelIds: m.labelIds || [] }
}

async function msgText(token: string, id: string): Promise<string> {
  const m = await (await fetch(`${API}/messages/${id}?format=full`, { headers: gh(token) })).json()
  const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  let text = ''
  const walk = (part: any) => {
    if (!part) return
    if (part.mimeType === 'text/plain' && part.body?.data) text += b64(part.body.data) + '\n'
    else if (part.mimeType === 'text/html' && part.body?.data && !text) text += b64(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    for (const sp of part.parts || []) walk(sp)
  }
  walk(m.payload)
  return text.replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Marcadores (Apps/<App>) ─────────────────────────────────────────────────
async function labelMap(token: string): Promise<Map<string, string>> {
  const data = await (await fetch(`${API}/labels`, { headers: gh(token) })).json()
  const m = new Map<string, string>()
  for (const l of data.labels || []) m.set(l.name, l.id)
  return m
}

async function ensureLabel(token: string, labels: Map<string, string>, name: string): Promise<string> {
  const have = labels.get(name)
  if (have) return have
  const res = await (await fetch(`${API}/labels`, {
    method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  })).json()
  if (res?.id) { labels.set(name, res.id); return res.id }
  // Corrida (marcador criado por outra passada): recarrega e tenta achar.
  const fresh = await labelMap(token)
  const id = fresh.get(name)
  if (id) { labels.set(name, id); return id }
  throw new Error(`label create failed: ${name} — ${res?.error?.message || '?'}`)
}

// Arquiva na pasta do app: aplica Apps/<App> e tira da caixa de entrada.
async function fileUnder(token: string, msgId: string, labelId: string): Promise<void> {
  await fetch(`${API}/messages/${msgId}/modify`, {
    method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ['INBOX'] }),
  })
}

// ── Classificação ───────────────────────────────────────────────────────────
type Kind =
  | { kind: 'receipt'; vendor: string; receiptNo: string | null }
  | { kind: 'bill'; vendor: string }
  | { kind: 'failure'; vendor: string }
  | { kind: 'vendor-mail' }
  | { kind: 'skip' }

function classify(msg: Msg): Kind {
  const s = msg.subject.trim()
  let m = s.match(/^Your receipt from (.+?)(?:\s+#([\d-]+))?$/i)
  if (m) return { kind: 'receipt', vendor: m[1].trim(), receiptNo: m[2] || null }
  m = s.match(/^New invoice from (.+?)\s*\(/i)
  if (m) return { kind: 'bill', vendor: m[1].trim() }
  m = s.match(/payment to (.+?) was unsuccessful/i)
  if (m) return { kind: 'failure', vendor: m[1].trim() }
  // Confirmações fora do padrão Stripe (ex.: Candy.ai "Purchase Confirmation").
  if (/^(purchase|payment|order) confirmation/i.test(s) || /^receipt for your (payment|purchase)/i.test(s)) {
    return { kind: 'receipt', vendor: '', receiptNo: null }
  }
  return { kind: 'vendor-mail' }
}

function parseAmount(text: string): number | null {
  const pats = [
    /amount (?:paid|charged|due)\D{0,20}\$\s?([\d,]+(?:\.\d{1,2})?)/i,
    /total\D{0,12}\$\s?([\d,]+(?:\.\d{1,2})?)/i,
    /\$\s?([\d,]+\.\d{2})\b/,
  ]
  for (const p of pats) {
    const m = text.match(p)
    if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (v > 0) return v }
  }
  return null
}

function appNameFor(vendor: string, from: string): { app: string; domains: string[] } {
  for (const a of APP_ALIASES) if (a.match.test(vendor) || a.match.test(from)) return { app: a.app, domains: a.domains || [senderDomain(from)].filter(Boolean) }
  const dom = senderDomain(from)
  // Sem apelido: nome cru do recibo (ou o domínio) — o Márcio renomeia no EDIT se quiser.
  return { app: vendor || dom || 'Unknown App', domains: [dom].filter(Boolean) }
}

// ── Registro no módulo APPS ─────────────────────────────────────────────────
async function loadApps(db: SupabaseClient): Promise<AppRow[]> {
  const { data } = await db.from('fixed_cost_suppliers').select('*').eq('cost_type', 'APP')
  return (data as AppRow[]) || []
}

function matchApp(apps: AppRow[], app: string, vendor: string, dom: string): AppRow | null {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const a of apps) {
    if (norm(a.description || '') === norm(app)) return a
    if (vendor && norm(a.company || '') === norm(vendor)) return a
    if (dom && (a.mail_match || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(dom)) return a
  }
  return null
}

// mail_match é coluna nova — se a migração ainda não rodou, o update falha em
// silêncio e o matching cai nos nomes (funciona do mesmo jeito).
async function rememberDomains(db: SupabaseClient, row: AppRow, domains: string[]): Promise<void> {
  const have = (row.mail_match || '').split(',').map(s => s.trim()).filter(Boolean)
  const next = [...new Set([...have, ...domains.filter(Boolean)])]
  if (next.length === have.length) return
  try { await db.from('fixed_cost_suppliers').update({ mail_match: next.join(',') }).eq('id', row.id); row.mail_match = next.join(',') } catch { /* coluna ainda não existe */ }
}

export type AppsSweepResult = {
  payments: { app: string; amount: number; date: string }[]
  newApps: string[]
  billsFiled: number
  failures: string[]
  filed: number
  errors: string[]
}

// full=true varre a caixa INTEIRA (backfill) e manda UM resumo no fim.
// full=false (cron) varre os últimos dias e reporta cada pagamento na hora.
export async function runAppsSweep(db: SupabaseClient, opts: { full?: boolean } = {}): Promise<AppsSweepResult> {
  const out: AppsSweepResult = { payments: [], newApps: [], billsFiled: 0, failures: [], filed: 0, errors: [] }
  const token = await gmailToken(db)
  if (!token) { out.errors.push('gmail token unavailable'); return out }

  const labels = await labelMap(token)
  const apps = await loadApps(db)
  const domainToApp = () => {
    const m = new Map<string, AppRow>()
    for (const a of apps) for (const d of (a.mail_match || '').toLowerCase().split(',')) if (d.trim()) m.set(d.trim(), a)
    return m
  }

  const q = opts.full ? 'in:anywhere -in:trash -in:spam' : 'in:anywhere -in:trash -in:spam newer_than:3d'
  const ids = await listMessages(token, q, opts.full ? 1500 : 200)

  for (const { id } of ids) {
    try {
      const msg = await msgMeta(token, id)
      if (!msg) continue
      // Já tem marcador Apps/* = já processado em alguma passada.
      const hasAppLabel = msg.labelIds.some(l => { const name = [...labels.entries()].find(([, v]) => v === l)?.[0] || ''; return name === 'Apps' || name.startsWith('Apps/') })
      if (hasAppLabel) continue

      const cls = classify(msg)
      if (cls.kind === 'skip') continue

      if (cls.kind === 'vendor-mail') {
        // Não é recibo/fatura: só arquiva se o remetente pertence a um app conhecido.
        const app = domainToApp().get(senderDomain(msg.from))
        if (!app) continue
        const lid = await ensureLabel(token, labels, `Apps/${app.description || app.company}`)
        await fileUnder(token, msg.id, lid)
        out.filed++
        continue
      }

      const { app: appName, domains } = appNameFor(cls.vendor, msg.from)
      let row = matchApp(apps, appName, cls.vendor || '', senderDomain(msg.from))

      if (cls.kind === 'failure') {
        if (row) { const lid = await ensureLabel(token, labels, `Apps/${row.description || row.company}`); await fileUnder(token, msg.id, lid); out.filed++ }
        out.failures.push(`${appName} — ${msg.subject}`)
        if (!opts.full) await sendStreamWhatsApp(`⚠️ *APP PAYMENT FAILED — ${appName}*\n${msg.subject}\nCheck the card on file.`)
        continue
      }

      if (cls.kind === 'bill') {
        // Fatura é o aviso da cobrança; o pagamento entra quando o RECIBO chegar.
        if (row) { const lid = await ensureLabel(token, labels, `Apps/${row.description || row.company}`); await fileUnder(token, msg.id, lid); out.billsFiled++; out.filed++ }
        continue
      }

      // ── Recibo = pagamento ────────────────────────────────────────────────
      const text = await msgText(token, id)
      const amount = parseAmount(text)
      const payDate = msg.date || ymdET(Date.now())
      const gmailLink = `https://mail.google.com/mail/u/0/#all/${msg.id}`

      // Dedup pelo id da mensagem já registrado.
      const { data: dup } = await db.from('fixed_cost_expenses').select('id').like('receipt_url', `%${msg.id}%`).limit(1)
      if (dup && dup.length) { const lid = await ensureLabel(token, labels, `Apps/${row?.description || appName}`); await fileUnder(token, msg.id, lid); continue }

      if (!row) {
        const { data: created, error } = await db.from('fixed_cost_suppliers').insert({
          description: appName,
          company: cls.vendor || appName,
          email: 'gz28us@gmail.com',
          preferred_contact: 'Email',
          cost_type: 'APP',
          periodicity: 'MONTHLY',
          date_entry: payDate,
          payment_day_1: Number(payDate.slice(8, 10)),
          amount_1: amount ?? 0,
        }).select('*').single()
        if (error || !created) { out.errors.push(`create ${appName}: ${error?.message}`); continue }
        row = created as AppRow
        apps.push(row)
        out.newApps.push(appName)
        if (!opts.full) await sendStreamWhatsApp(`🆕 *NEW APP DETECTED — ${appName}*\n${cls.vendor || ''}\nFirst charge: *${fmtUSD(amount ?? 0)}* — ${fmtDate(payDate)}\nRegistered under COSTS → APPS.`)
      } else {
        // O preço acompanha a cobrança mais recente POR DATA (o backfill processa
        // fora de ordem); recibo mais antigo que o cadastro puxa o date_entry.
        const { data: latest } = await db.from('fixed_cost_expenses').select('payment_date')
          .eq('supplier_id', row.id).not('payment_date', 'is', null)
          .order('payment_date', { ascending: false }).limit(1)
        const latestDate = latest?.[0]?.payment_date || ''
        const patch: Record<string, unknown> = {}
        if (amount != null && payDate >= latestDate) { patch.amount_1 = amount; row.amount_1 = amount }
        if (row.date_entry && payDate < row.date_entry) { patch.date_entry = payDate; patch.payment_day_1 = Number(payDate.slice(8, 10)); row.date_entry = payDate }
        if (Object.keys(patch).length) await db.from('fixed_cost_suppliers').update(patch).eq('id', row.id)
      }
      await rememberDomains(db, row, domains)

      // Casa com a linha agendada em aberto do MESMO mês; senão insere nova.
      const monthKey = payDate.slice(0, 7)
      const { data: openRows } = await db.from('fixed_cost_expenses').select('id, expense_date')
        .eq('supplier_id', row.id).is('payment_date', null)
        .gte('expense_date', monthKey + '-01').lte('expense_date', monthKey + '-31')
      const target = (openRows || [])[0]
      const desc = `${row.description || appName}${cls.receiptNo ? ` #${cls.receiptNo}` : ''}`
      if (target) {
        await db.from('fixed_cost_expenses').update({ amount: amount ?? 0, payment_date: payDate, description: desc, receipt_url: gmailLink }).eq('id', target.id)
      } else {
        await db.from('fixed_cost_expenses').insert({
          supplier_id: row.id, type: 'SINGLE', description: desc, amount: amount ?? 0,
          source: 'GZ28US', expense_date: payDate, payment_date: payDate, receipt_url: gmailLink,
        })
      }

      const lid = await ensureLabel(token, labels, `Apps/${row.description || appName}`)
      await fileUnder(token, msg.id, lid)
      out.filed++
      out.payments.push({ app: row.description || appName, amount: amount ?? 0, date: payDate })
      if (!opts.full) {
        await sendStreamWhatsApp([
          `💵 *APP EXPENSE — ${row.description || appName}*`,
          cls.vendor && cls.vendor !== row.description ? cls.vendor : null,
          cls.receiptNo ? `Receipt #${cls.receiptNo}` : null,
          `Amount: *${fmtUSD(amount ?? 0)}*`,
          `Paid: ${fmtDate(payDate)}`,
          amount == null ? '⚠️ Could not read the amount — fix it on the APPS page.' : null,
          `📧 Filed under Apps/${row.description || appName}`,
        ].filter(Boolean).join('\n'))
      }
    } catch (e) {
      out.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Backfill: um resumo só, em vez de metralhar o grupo com o histórico.
  if (opts.full && (out.payments.length || out.newApps.length)) {
    const byApp = new Map<string, { n: number; total: number }>()
    for (const p of out.payments) { const c = byApp.get(p.app) || { n: 0, total: 0 }; c.n++; c.total += p.amount; byApp.set(p.app, c) }
    const lines = [...byApp.entries()].sort((a, b) => b[1].total - a[1].total)
      .map(([app, c]) => `• ${app}: ${c.n} payment${c.n > 1 ? 's' : ''} — ${fmtUSD(c.total)}`)
    const grand = out.payments.reduce((s, p) => s + p.amount, 0)
    await sendStreamWhatsApp(`📱 *APPS — GMAIL BACKFILL DONE*\n${lines.join('\n')}\n\nTotal registered: *${fmtUSD(grand)}*\nEmails filed: ${out.filed}\nEverything is on COSTS → APPS.`)
  }
  return out
}
