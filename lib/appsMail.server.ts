import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from '@/lib/streamMail.server'
import { sendStreamWhatsApp } from '@/lib/stream.server'

// APPS watcher — TODAS as 4 caixas do Márcio são fonte das assinaturas de apps
// (regra 2026-07-25: "caça em todos os emails, todas as pastas, inclusive junk,
// deleted e sent"). Cada recibo vira um pagamento no módulo APPS
// (fixed_cost_suppliers cost_type='APP' + fixed_cost_expenses), o e-mail é
// arquivado em Apps/<App> (marcador no Gmail, pasta no Outlook) e o grupo
// recebe o report. App nunca visto antes é criado sozinho ("interferência zero").
//
// Dedup em camadas: estar em Apps/* = processado; nº do recibo Stripe na
// description; id da mensagem no receipt_url; e (app, valor, data) como último
// recurso — o mesmo recibo nunca registra duas vezes, nem entre caixas.

const GMAIL_SLOT = 4
const OUTLOOK_SLOTS = [1, 2, 3]
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const G = 'https://graph.microsoft.com/v1.0'

// ── Apelidos: fornecedor do recibo → nome do app + domínios extras ──────────
const APP_ALIASES: { match: RegExp; app: string; domains?: string[] }[] = [
  { match: /anthropic/i, app: 'Claude', domains: ['anthropic.com', 'claude.com'] },
  { match: /midjourney/i, app: 'Midjourney', domains: ['midjourney.com'] },
  { match: /supabase/i, app: 'Supabase', domains: ['supabase.com', 'supabase.io'] },
  { match: /vercel/i, app: 'Vercel', domains: ['vercel.com'] },
  { match: /skywork/i, app: 'Skywork AI', domains: ['skywork.ai'] },
  { match: /recraft/i, app: 'Recraft', domains: ['recraft.ai'] },
  { match: /candy\.?\s?ai/i, app: 'Candy.ai', domains: ['candy.ai'] },
  // O UltraMsg fatura como SWIFT TECH TRADING LLC no Stripe.
  { match: /swift tech trading|ultramsg/i, app: 'UltraMsg', domains: ['ultramsg.com'] },
  { match: /dropbox/i, app: 'Dropbox', domains: ['dropbox.com'] },
  { match: /openai|chatgpt/i, app: 'ChatGPT', domains: ['openai.com'] },
  { match: /github/i, app: 'GitHub', domains: ['github.com'] },
  { match: /google (one|workspace|storage)/i, app: 'Google One' },
  { match: /17track/i, app: '17TRACK', domains: ['17track.net'] },
  // Auditoria 2026-07-27: 8 assinaturas viviam fora do módulo porque não usam o
  // formato Stripe. Ficam registradas aqui pelo NOME do faturador real.
  { match: /teamviewer/i, app: 'TeamViewer', domains: ['teamviewer.com'] },
  { match: /autoauth/i, app: 'AutoAuth', domains: ['autoauth.com'] },
  // O NordVPN cobra como Lagosec Inc. e escreve do nordaccount.com.
  { match: /nordvpn|nord security|lagosec|nordaccount/i, app: 'NordVPN', domains: ['nordaccount.com', 'nordvpn.com'] },
  { match: /microsoft 365|microsoft do brasil/i, app: 'Microsoft 365 Family', domains: ['microsoft.com'] },
  // CorelDRAW é faturado pelo revendedor Cleverbridge, em reais.
  { match: /coreldraw|corel/i, app: 'CorelDRAW', domains: ['cleverbridge.com'] },
  { match: /fox digital/i, app: 'Fox Digital', domains: ['fox.com'] },
]

type AppRow = {
  id: string; description: string | null; company: string | null; email: string | null
  date_entry: string | null; payment_day_1: number | null; amount_1: number | null
  date_conclusion?: string | null
  mail_match?: string | null
}
export type AppsSweepResult = {
  payments: { app: string; amount: number; date: string; box: string }[]
  newApps: string[]
  cancelled: string[]
  billsFiled: number
  failures: string[]
  filed: number
  errors: string[]
}

const fmtUSD = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
const fmtDate = (ymd: string) => new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
// Data local da cobrança (fuso da empresa) a partir do timestamp do e-mail.
const ymdET = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const senderDomain = (from: string) => {
  const m = from.toLowerCase().match(/@([a-z0-9.-]+)/)
  if (!m) return ''
  const parts = m[1].split('.')
  return parts.slice(-2).join('.') === 'com.br' ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}
const stripHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim()

// ── Classificação (compartilhada Gmail/Outlook) ─────────────────────────────
type Kind =
  | { kind: 'receipt'; vendor: string; receiptNo: string | null }
  | { kind: 'bill'; vendor: string }
  | { kind: 'failure'; vendor: string }
  | { kind: 'cancel'; vendor: string }
  | { kind: 'vendor-mail' }

// Lojas/marketplaces NÃO são apps — confirmação de compra deles é peça/ingresso,
// nunca assinatura (o backfill 2026-07-25 pescou eBay e Tixr por engano).
const NOT_AN_APP = /ebay|tixr|amazon|mercado\s?livre|aliexpress|rockauto|summit\s?racing|jegs|paypal|walmart|bestbuy/i

function classify(subject: string, from: string): Kind {
  if (NOT_AN_APP.test(from)) return { kind: 'vendor-mail' }
  const s = subject.trim()
  // "Your receipt from Apple." — o ponto final não faz parte do nome.
  let m = s.match(/^Your receipt from (.+?)(?:\s+#([\d-]+))?\.?$/i)
  if (m) return { kind: 'receipt', vendor: m[1].trim().replace(/[.,;]+$/, ''), receiptNo: m[2] || null }
  m = s.match(/^New invoice from (.+?)\s*\(/i)
  if (m) return { kind: 'bill', vendor: m[1].trim() }
  m = s.match(/payment to (.+?) was unsuccessful/i)
  if (m) return { kind: 'failure', vendor: m[1].trim() }
  // Confirmações fora do padrão Stripe (ex.: Candy.ai "Purchase Confirmation").
  if (/^(purchase|payment|order) confirmation/i.test(s) || /^receipt for your (payment|purchase)/i.test(s)) {
    return { kind: 'receipt', vendor: '', receiptNo: null }
  }

  // ── Formatos que NÃO são Stripe (auditoria 2026-07-27) ────────────────────
  // O PayPal anuncia o lojista no próprio assunto: "Lagosec Inc.: $94.23 USD".
  // Só vira recibo de APP quando esse lojista é um app conhecido — senão seria
  // peça de fornecedor (eBay, Summit, Temu) entrando como assinatura.
  m = s.match(/^(.{2,60}?)\.{0,3}:\s*\$[\d,]+\.\d{2}\s*USD$/i)
  if (m && knownApp(m[1])) return { kind: 'receipt', vendor: m[1].replace(/\.{2,}$/, '').trim(), receiptNo: null }

  // Recibos com nome próprio: Nord ("Your payment confirmation and receipt"),
  // AutoAuth ("AutoAuth Annual Payment Receipt"), TeamViewer ("Your TeamViewer
  // Payment Confirmation – AccID ...").
  if (/(payment confirmation and receipt|annual payment receipt|payment confirmation\b)/i.test(s) && knownApp(`${s} ${from}`)) {
    return { kind: 'receipt', vendor: aliasName(`${s} ${from}`) || '', receiptNo: null }
  }

  // Cleverbridge (revendedor, em português): "N° de referência 519904391: Sua
  // assinatura do Assinatura (365 dias) do CorelDRAW". Só a mensagem da
  // ASSINATURA vale — "Seu pedido" e "Informações para pagamento" são etapas do
  // checkout, não recibo (registravam a mesma anuidade várias vezes, zerada).
  if (/cleverbridge/i.test(from) && /sua assinatura/i.test(s) && !/informa[çc][õo]es para pagamento/i.test(s)) {
    return { kind: 'receipt', vendor: aliasName(s) || 'Cleverbridge', receiptNo: (s.match(/refer[êe]ncia\s*(\d+)/i) || [])[1] || null }
  }

  // Microsoft: "Sua compra do Microsoft 365 Family foi processada".
  m = s.match(/sua compra d[oa]\s+(.+?)\s+foi processada/i)
  if (m) return { kind: 'receipt', vendor: m[1].trim(), receiptNo: null }

  // CANCELAMENTO (ordem 27/jul: "any activity of a bought app goes to this page
  // — new one, cancellation, payments, anything"). Fim de assinatura em qualquer
  // das formas que os fornecedores escrevem, nos dois idiomas. Só vale pra app
  // conhecido: "order canceled" de loja não encerra assinatura nenhuma.
  if (CANCEL_WORDS.test(s) && knownApp(`${s} ${from}`)) {
    return { kind: 'cancel', vendor: aliasName(`${s} ${from}`) || '' }
  }

  return { kind: 'vendor-mail' }
}

// Cancelamento CONSUMADO — nada de "clique aqui para cancelar" ou aviso de que
// a renovação está chegando; a assinatura tem que ter acabado de verdade.
// O nome do app costuma entrar no meio da frase ("Your *Recraft* plan has
// ended", "Sua assinatura *do CorelDRAW* foi cancelada"), por isso os trechos
// curinga entre as palavras-chave.
const CANCEL_WORDS = /(subscription (has been |was |is )?cancel(l)?ed|cancel(l)?ed your subscription|(will not|won'?t) (be )?renew|auto[- ]?renew(al)? (is )?(off|disabled|turned off)|your (\S+\s){0,3}(plan|subscription|membership) (has )?ended|assinatura[^.!?]{0,40}?(foi )?cancelada|cancelamento (da|de sua) assinatura|n[ãa]o ser[áa] renovad|renova[çc][ãa]o autom[áa]tica (foi )?(desativada|cancelada))/i

// O texto cita algum app do catálogo de apelidos? Vale pelo NOME ou pelo
// DOMÍNIO do remetente — o Cleverbridge escreve "Sua assinatura foi cancelada"
// sem dizer que é o CorelDRAW, e só o domínio identifica o app.
function aliasName(text: string): string | null {
  for (const a of APP_ALIASES) if (a.match.test(text)) return a.app
  for (const a of APP_ALIASES) if ((a.domains || []).some(d => text.toLowerCase().includes(d))) return a.app
  return null
}
const knownApp = (text: string) => aliasName(text) !== null

// Taxa da casa pra recibo em reais (CorelDRAW/Cleverbridge, Microsoft do Brasil).
// O módulo APPS é todo em USD; sem isso o recibo entrava valendo ZERO.
const BRL_USD = Number(process.env.BRL_USD_RATE) || 5.2785

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
  // Reais: "R$ 1.600,00" / "BRL 599.00" — milhar com ponto e decimal com vírgula.
  const br = text.match(/(?:R\$|BRL)\s?([\d.]+,\d{2}|[\d,]+\.\d{2})/i)
  if (br) {
    const raw = br[1]
    const v = raw.includes(',') && raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? parseFloat(raw.replace(/\./g, '').replace(',', '.'))
      : parseFloat(raw.replace(/,/g, ''))
    if (v > 0) return Math.round((v / BRL_USD) * 100) / 100
  }
  return null
}

function appNameFor(vendor: string, from: string): { app: string; domains: string[] } {
  for (const a of APP_ALIASES) if (a.match.test(vendor) || a.match.test(from)) return { app: a.app, domains: a.domains || [senderDomain(from)].filter(Boolean) }
  const dom = senderDomain(from)
  // Sem apelido: nome cru do recibo (ou o domínio) — o Márcio renomeia no EDIT se quiser.
  return { app: vendor || dom || 'Unknown App', domains: [dom].filter(Boolean) }
}

// ── Registro no módulo APPS (compartilhado) ─────────────────────────────────
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

async function rememberDomains(db: SupabaseClient, row: AppRow, domains: string[]): Promise<void> {
  const have = (row.mail_match || '').split(',').map(s => s.trim()).filter(Boolean)
  const next = [...new Set([...have, ...domains.filter(Boolean)])]
  if (next.length === have.length) return
  try { await db.from('fixed_cost_suppliers').update({ mail_match: next.join(',') }).eq('id', row.id); row.mail_match = next.join(',') } catch { /* coluna ausente */ }
}

function domainToApp(apps: AppRow[]): Map<string, AppRow> {
  const m = new Map<string, AppRow>()
  for (const a of apps) for (const d of (a.mail_match || '').toLowerCase().split(',')) if (d.trim()) m.set(d.trim(), a)
  return m
}

type ReceiptInfo = {
  vendor: string; receiptNo: string | null; from: string; amount: number | null
  payDate: string; link: string; msgKey: string; box: string
}

// Registra um recibo; devolve o app (criado se preciso) e se registrou de fato
// (false = era duplicado). notifyEach fora do backfill.
async function registerReceipt(
  db: SupabaseClient, apps: AppRow[], info: ReceiptInfo, out: AppsSweepResult, notifyEach: boolean,
): Promise<{ row: AppRow | null; registered: boolean }> {
  const { app: appName, domains } = appNameFor(info.vendor, info.from)
  let row = matchApp(apps, appName, info.vendor || '', senderDomain(info.from))

  // Dedup: id da mensagem já visto; nº do recibo já registrado (mesmo vindo de
  // OUTRA caixa); ou mesma (app, valor, data) pra recibos sem número.
  const { data: dupMsg } = await db.from('fixed_cost_expenses').select('id').like('receipt_url', `%${info.msgKey}%`).limit(1)
  if (dupMsg?.length) return { row, registered: false }
  if (row && info.receiptNo) {
    const { data: dupNo } = await db.from('fixed_cost_expenses').select('id').eq('supplier_id', row.id).like('description', `%#${info.receiptNo}%`).limit(1)
    if (dupNo?.length) return { row, registered: false }
  }
  if (row && !info.receiptNo && info.amount != null) {
    // Janela de ±2 dias, não data exata: o recibo carimba a data no fuso de
    // Orlando e um lançamento feito à mão (ou o e-mail que chega 20h+) cai no
    // dia anterior — foi assim que o AutoAuth nasceu duplicado em 27/jul.
    const day = 86_400_000
    const from = new Date(new Date(info.payDate + 'T00:00:00Z').getTime() - 2 * day).toISOString().slice(0, 10)
    const to = new Date(new Date(info.payDate + 'T00:00:00Z').getTime() + 2 * day).toISOString().slice(0, 10)
    const { data: dupAmt } = await db.from('fixed_cost_expenses').select('id')
      .eq('supplier_id', row.id).eq('amount', info.amount)
      .gte('payment_date', from).lte('payment_date', to).limit(1)
    if (dupAmt?.length) return { row, registered: false }
  }

  if (!row) {
    const { data: created, error } = await db.from('fixed_cost_suppliers').insert({
      description: appName,
      company: info.vendor || appName,
      email: 'gz28us@gmail.com',
      preferred_contact: 'Email',
      cost_type: 'APP',
      periodicity: 'MONTHLY',
      date_entry: info.payDate,
      payment_day_1: Number(info.payDate.slice(8, 10)),
      amount_1: info.amount ?? 0,
    }).select('*').single()
    if (error || !created) { out.errors.push(`create ${appName}: ${error?.message}`); return { row: null, registered: false } }
    row = created as AppRow
    apps.push(row)
    out.newApps.push(appName)
    if (notifyEach) await sendStreamWhatsApp(`🆕 *NEW APP DETECTED — ${appName}*\n${info.vendor || ''}\nFirst charge: *${fmtUSD(info.amount ?? 0)}* — ${fmtDate(info.payDate)}\nRegistered under COSTS → APPS.`)
  } else {
    // O preço acompanha a cobrança mais recente POR DATA; recibo mais antigo
    // que o cadastro puxa o date_entry pra trás.
    const { data: latest } = await db.from('fixed_cost_expenses').select('payment_date')
      .eq('supplier_id', row.id).not('payment_date', 'is', null)
      .order('payment_date', { ascending: false }).limit(1)
    const latestDate = latest?.[0]?.payment_date || ''
    const patch: Record<string, unknown> = {}
    if (info.amount != null && info.payDate >= latestDate) { patch.amount_1 = info.amount; row.amount_1 = info.amount }
    if (row.date_entry && info.payDate < row.date_entry) { patch.date_entry = info.payDate; patch.payment_day_1 = Number(info.payDate.slice(8, 10)); row.date_entry = info.payDate }
    if (Object.keys(patch).length) await db.from('fixed_cost_suppliers').update(patch).eq('id', row.id)
  }
  await rememberDomains(db, row, domains)

  // Casa com a linha agendada em aberto do MESMO mês; senão insere nova.
  const monthKey = info.payDate.slice(0, 7)
  const { data: openRows } = await db.from('fixed_cost_expenses').select('id')
    .eq('supplier_id', row.id).is('payment_date', null)
    .gte('expense_date', monthKey + '-01').lte('expense_date', monthKey + '-31')
  const desc = `${row.description || appName}${info.receiptNo ? ` #${info.receiptNo}` : ''}`
  if (openRows?.length) {
    await db.from('fixed_cost_expenses').update({ amount: info.amount ?? 0, payment_date: info.payDate, description: desc, receipt_url: info.link }).eq('id', openRows[0].id)
  } else {
    await db.from('fixed_cost_expenses').insert({
      supplier_id: row.id, type: 'SINGLE', description: desc, amount: info.amount ?? 0,
      source: 'GZ28US', expense_date: info.payDate, payment_date: info.payDate, receipt_url: info.link,
    })
  }
  out.payments.push({ app: row.description || appName, amount: info.amount ?? 0, date: info.payDate, box: info.box })
  if (notifyEach) {
    await sendStreamWhatsApp([
      `💵 *APP EXPENSE — ${row.description || appName}*`,
      info.vendor && info.vendor !== row.description ? info.vendor : null,
      info.receiptNo ? `Receipt #${info.receiptNo}` : null,
      `Amount: *${fmtUSD(info.amount ?? 0)}*`,
      `Paid: ${fmtDate(info.payDate)}`,
      info.amount == null ? '⚠️ Could not read the amount — fix it on the APPS page.' : null,
      `📧 Filed under Apps/${row.description || appName} (${info.box})`,
    ].filter(Boolean).join('\n'))
  }
  return { row, registered: true }
}

async function handleFailure(appName: string, subject: string, out: AppsSweepResult, notifyEach: boolean): Promise<void> {
  out.failures.push(`${appName} — ${subject}`)
  if (notifyEach) await sendStreamWhatsApp(`⚠️ *APP PAYMENT FAILED — ${appName}*\n${subject}\nCheck the card on file.`)
}

// Encerra o app na página: `date_conclusion` é o que vira o selo ENDED e tira o
// custo da média mensal. Nunca reabre nem mexe no histórico de pagamentos — o
// que foi pago continua pago, e a cobrança futura agendada é apagada porque
// deixou de existir.
async function handleCancel(db: SupabaseClient, row: AppRow | null, appName: string, subject: string, date: string, out: AppsSweepResult, notifyEach: boolean): Promise<void> {
  if (!row) { out.errors.push(`cancel sem app cadastrado: ${appName} — ${subject}`); return }
  if (row.date_conclusion) return // já encerrado numa passada anterior
  const { error } = await db.from('fixed_cost_suppliers').update({ date_conclusion: date }).eq('id', row.id)
  if (error) { out.errors.push(`cancel ${appName}: ${error.message}`); return }
  await db.from('fixed_cost_expenses').delete().eq('supplier_id', row.id).is('payment_date', null)
  out.cancelled.push(`${row.description || appName} (${date})`)
  if (notifyEach) {
    await sendStreamWhatsApp(`🛑 *APP CANCELLED — ${row.description || appName}*\n${subject}\nEnded on ${fmtDate(date)} — it stops counting in the monthly cost.`)
  }
}

// ═══ GMAIL (slot 4) ═════════════════════════════════════════════════════════
async function gmailToken(db: SupabaseClient): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const auth = await getMailAuth(db, GMAIL_SLOT)
  if (!auth?.refresh_token) return null
  const tk = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: auth.refresh_token, grant_type: 'refresh_token' }),
  })).json()
  return tk?.access_token || null
}

const gh = (t: string) => ({ Authorization: `Bearer ${t}` })

async function gmailSweep(db: SupabaseClient, apps: AppRow[], out: AppsSweepResult, opts: { full?: boolean }): Promise<void> {
  const token = await gmailToken(db)
  if (!token) { out.errors.push('gmail token unavailable'); return }

  const labelMap = async () => {
    const data = await (await fetch(`${API}/labels`, { headers: gh(token) })).json()
    const m = new Map<string, string>()
    for (const l of data.labels || []) m.set(l.name, l.id)
    return m
  }
  const labels = await labelMap()
  const ensureLabel = async (name: string): Promise<string> => {
    const have = labels.get(name)
    if (have) return have
    // O Gmail só aninha "Apps/X" debaixo de "Apps" se o marcador-pai existir.
    if (name.includes('/')) await ensureLabel(name.split('/')[0])
    const res = await (await fetch(`${API}/labels`, {
      method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    })).json()
    if (res?.id) { labels.set(name, res.id); return res.id }
    const fresh = await labelMap()
    const id = fresh.get(name)
    if (id) { labels.set(name, id); return id }
    throw new Error(`label create failed: ${name} — ${res?.error?.message || '?'}`)
  }
  const fileUnder = async (msgId: string, labelId: string) => {
    await fetch(`${API}/messages/${msgId}/modify`, {
      method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ['INBOX'] }),
    })
  }

  // TODAS as pastas de verdade: in:anywhere já inclui spam e lixeira.
  const q = opts.full ? 'in:anywhere' : 'in:anywhere newer_than:3d'
  const ids: { id: string }[] = []
  let pageToken = ''
  const cap = opts.full ? 1500 : 200
  while (ids.length < cap) {
    const qs = new URLSearchParams({ maxResults: '100', q })
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await (await fetch(`${API}/messages?${qs}`, { headers: gh(token) })).json()
    ids.push(...(data.messages || []))
    pageToken = data.nextPageToken || ''
    if (!pageToken) break
  }

  for (const { id } of ids.slice(0, cap)) {
    try {
      const m = await (await fetch(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: gh(token) })).json()
      if (!m?.id) continue
      const hdr = (name: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
      const from = hdr('From'), subject = hdr('Subject')
      const date = m.internalDate ? ymdET(+m.internalDate) : ymdET(Date.now())
      const labelIds: string[] = m.labelIds || []
      const hasAppLabel = labelIds.some(l => { const name = [...labels.entries()].find(([, v]) => v === l)?.[0] || ''; return name === 'Apps' || name.startsWith('Apps/') })
      if (hasAppLabel) continue

      const cls = classify(subject, from)
      if (cls.kind === 'vendor-mail') {
        const app = domainToApp(apps).get(senderDomain(from))
        if (!app) continue
        await fileUnder(m.id, await ensureLabel(`Apps/${app.description || app.company}`))
        out.filed++
        continue
      }
      const { app: appName } = appNameFor(cls.vendor, from)
      if (cls.kind === 'failure') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row) { await fileUnder(m.id, await ensureLabel(`Apps/${row.description || row.company}`)); out.filed++ }
        await handleFailure(appName, subject, out, !opts.full)
        continue
      }
      if (cls.kind === 'cancel') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row) { await fileUnder(m.id, await ensureLabel(`Apps/${row.description || row.company}`)); out.filed++ }
        await handleCancel(db, row, appName, subject, date, out, !opts.full)
        continue
      }
      if (cls.kind === 'bill') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row) { await fileUnder(m.id, await ensureLabel(`Apps/${row.description || row.company}`)); out.billsFiled++; out.filed++ }
        continue
      }

      // Recibo: corpo pra tirar o valor.
      const fullMsg = await (await fetch(`${API}/messages/${id}?format=full`, { headers: gh(token) })).json()
      const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      let text = ''
      const walk = (part: any) => {
        if (!part) return
        if (part.mimeType === 'text/plain' && part.body?.data) text += b64(part.body.data) + '\n'
        else if (part.mimeType === 'text/html' && part.body?.data && !text) text += stripHtml(b64(part.body.data))
        for (const sp of part.parts || []) walk(sp)
      }
      walk(fullMsg.payload)
      const { row, registered } = await registerReceipt(db, apps, {
        vendor: cls.vendor, receiptNo: cls.receiptNo, from,
        amount: parseAmount(text.replace(/\s+/g, ' ')), payDate: date,
        link: `https://mail.google.com/mail/u/0/#all/${m.id}`, msgKey: m.id, box: 'gmail',
      }, out, !opts.full)
      const name = row?.description || appName
      await fileUnder(m.id, await ensureLabel(`Apps/${name}`))
      if (registered) out.filed++
    } catch (e) {
      out.errors.push(`gmail ${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ═══ OUTLOOK (slots 1-3, Graph) ═════════════════════════════════════════════
// IDs imutáveis pra tudo: um /move não muda o id nem quebra o webLink salvo.
const oh = (t: string) => ({ Authorization: `Bearer ${t}`, Prefer: 'IdType="ImmutableId"' })

async function outlookSweep(db: SupabaseClient, slot: number, apps: AppRow[], out: AppsSweepResult, opts: { full?: boolean }): Promise<void> {
  const auth = await getMailAuth(db, slot)
  if (!auth?.refresh_token) return
  const token = await freshAccessToken(db, auth)
  if (!token) { out.errors.push(`slot ${slot}: token refresh failed`); return }
  const box = auth.account || `slot${slot}`

  // Pasta Apps + filhas (criadas sob demanda). Set de ids = "já processado".
  const folders = new Map<string, string>()
  const root = await (await fetch(`${G}/me/mailFolders?$top=200&$select=id,displayName`, { headers: oh(token) })).json()
  let appsRootId = (root.value || []).find((f: any) => f.displayName === 'Apps')?.id
  if (!appsRootId) {
    const created = await (await fetch(`${G}/me/mailFolders`, { method: 'POST', headers: { ...oh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Apps' }) })).json()
    appsRootId = created?.id
    if (!appsRootId) { out.errors.push(`slot ${slot}: Apps folder create failed`); return }
  }
  const kids = await (await fetch(`${G}/me/mailFolders/${appsRootId}/childFolders?$top=200&$select=id,displayName`, { headers: oh(token) })).json()
  for (const f of kids.value || []) folders.set(f.displayName, f.id)
  const appsFolderIds = new Set<string>([appsRootId, ...folders.values()])
  const ensureFolder = async (name: string): Promise<string> => {
    const have = folders.get(name)
    if (have) return have
    const created = await (await fetch(`${G}/me/mailFolders/${appsRootId}/childFolders`, { method: 'POST', headers: { ...oh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) })).json()
    if (!created?.id) throw new Error(`folder create failed: ${name}`)
    folders.set(name, created.id); appsFolderIds.add(created.id)
    return created.id
  }
  // Itens enviados ficam onde estão (registra, não move).
  const sent = await (await fetch(`${G}/me/mailFolders/sentitems?$select=id`, { headers: oh(token) })).json()
  const sentId = sent?.id || ''
  const moveTo = async (msgId: string, folderId: string) => {
    await fetch(`${G}/me/messages/${msgId}/move`, { method: 'POST', headers: { ...oh(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: folderId }) })
  }

  // Candidatos: no backfill, $search cobre a caixa INTEIRA (junk/deleted/sent
  // incluídos); no cron, tudo que chegou nos últimos 3 dias em qualquer pasta.
  const SELECT = '$select=id,subject,from,receivedDateTime,parentFolderId,webLink'
  const seen = new Set<string>()
  const msgs: any[] = []
  if (opts.full) {
    for (const term of ['"Your receipt from"', '"New invoice from"', '"was unsuccessful"', '"Purchase Confirmation"']) {
      const r = await (await fetch(`${G}/me/messages?$search=${encodeURIComponent(term)}&$top=250&${SELECT}`, { headers: oh(token) })).json()
      for (const m of r.value || []) if (!seen.has(m.id)) { seen.add(m.id); msgs.push(m) }
    }
  } else {
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const r = await (await fetch(`${G}/me/messages?$filter=receivedDateTime ge ${since}&$top=100&${SELECT}`, { headers: oh(token) })).json()
    for (const m of r.value || []) msgs.push(m)
  }

  for (const m of msgs) {
    try {
      if (appsFolderIds.has(m.parentFolderId)) continue
      const from = m.from?.emailAddress?.address || ''
      const subject = m.subject || ''
      const date = m.receivedDateTime ? ymdET(new Date(m.receivedDateTime).getTime()) : ymdET(Date.now())
      const inSent = m.parentFolderId === sentId

      const cls = classify(subject, from)
      if (cls.kind === 'vendor-mail') {
        // No cron o fluxo de 3 dias traz de tudo; só arquivamos correio de
        // fornecedor conhecido, e nunca tiramos nada dos Itens Enviados.
        const app = domainToApp(apps).get(senderDomain(from))
        if (!app || inSent) continue
        await moveTo(m.id, await ensureFolder(String(app.description || app.company)))
        out.filed++
        continue
      }
      const { app: appName } = appNameFor(cls.vendor, from)
      if (cls.kind === 'failure') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row && !inSent) { await moveTo(m.id, await ensureFolder(String(row.description || row.company))); out.filed++ }
        await handleFailure(appName, subject, out, !opts.full)
        continue
      }
      if (cls.kind === 'cancel') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row && !inSent) { await moveTo(m.id, await ensureFolder(String(row.description || row.company))); out.filed++ }
        await handleCancel(db, row, appName, subject, date, out, !opts.full)
        continue
      }
      if (cls.kind === 'bill') {
        const row = matchApp(apps, appName, cls.vendor, senderDomain(from))
        if (row && !inSent) { await moveTo(m.id, await ensureFolder(String(row.description || row.company))); out.billsFiled++; out.filed++ }
        continue
      }

      const body = await (await fetch(`${G}/me/messages/${m.id}?$select=body`, { headers: oh(token) })).json()
      const text = stripHtml(String(body?.body?.content || ''))
      const { row, registered } = await registerReceipt(db, apps, {
        vendor: cls.vendor, receiptNo: cls.receiptNo, from,
        amount: parseAmount(text), payDate: date,
        link: m.webLink || `outlook:${m.id}`, msgKey: m.id, box,
      }, out, !opts.full)
      if (!inSent) {
        await moveTo(m.id, await ensureFolder(String(row?.description || appName)))
        if (registered) out.filed++
      }
    } catch (e) {
      out.errors.push(`slot${slot} ${m.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ═══ Entrada única — as 4 caixas ════════════════════════════════════════════
// full=true varre tudo (backfill/resync) e manda UM resumo; full=false (cron)
// varre os últimos dias e reporta cada movimento na hora.
export async function runAppsSweep(db: SupabaseClient, opts: { full?: boolean } = {}): Promise<AppsSweepResult> {
  const out: AppsSweepResult = { payments: [], newApps: [], cancelled: [], billsFiled: 0, failures: [], filed: 0, errors: [] }
  const apps = await loadApps(db)
  try { await gmailSweep(db, apps, out, opts) } catch (e) { out.errors.push('gmail: ' + (e instanceof Error ? e.message : String(e))) }
  for (const slot of OUTLOOK_SLOTS) {
    try { await outlookSweep(db, slot, apps, out, opts) } catch (e) { out.errors.push(`slot${slot}: ` + (e instanceof Error ? e.message : String(e))) }
  }

  if (opts.full && (out.payments.length || out.newApps.length)) {
    const byApp = new Map<string, { n: number; total: number }>()
    for (const p of out.payments) { const c = byApp.get(p.app) || { n: 0, total: 0 }; c.n++; c.total += p.amount; byApp.set(p.app, c) }
    const lines = [...byApp.entries()].sort((a, b) => b[1].total - a[1].total)
      .map(([app, c]) => `• ${app}: ${c.n} payment${c.n > 1 ? 's' : ''} — ${fmtUSD(c.total)}`)
    const grand = out.payments.reduce((s, p) => s + p.amount, 0)
    await sendStreamWhatsApp(`📱 *APPS — MAILBOX SWEEP DONE*\n${lines.join('\n')}\n\nTotal registered: *${fmtUSD(grand)}*\nEmails filed: ${out.filed}\nEverything is on COSTS → APPS.`)
  }
  return out
}
