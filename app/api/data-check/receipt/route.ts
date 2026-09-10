import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// O RECIBO RESPONDE O QUE FALTA (DC 1.47.0 → 1.48.0 — João, 9/set/2026: «as invoices têm recibo, e o recibo
// definitivamente diz quem vendeu — isso dá pra automatizar»; e «vamos achar erro no paid_from/paid_to — organizar
// os números o quanto antes»). Linha de invoice com recibo anexado e informação faltando ou impossível:
//   · fornecedor vazio         → o VENDEDOR impresso, só quando resolve num cadastro (nome ou apelido inteiro);
//   · data prevista vazia      → a DATA do recibo;
//   · data IMPOSSÍVEL (antes da invoice existir: expense_date ou payment_date < hiring_date − 90 d — o erro de ano
//     que mandou 10 linhas de 2026 pra 2023/2024) → a data do recibo corrige;
//   · quem pagou vazio (linha PAGA) → só o que o documento PROVA: documento brasileiro (real, Pix, TED, boleto)
//     pago pela GZ28BR = GZ28BR. GZ28US NUNCA sai do recibo — quem prova o dólar é o banco (Regions), e um
//     «Bill To: GZ28» é comprador, não pagador (revisão de 9/set). Sócio, cliente ou nome de gente = sugestão.
// LER e APLICAR são passos separados: a leitura fica guardada (data_fixes receipt-read, uma por recibo, com o erro
// quando falhou) e as escritas se reaplicam a cada rodada a partir das leituras guardadas — o que não coube numa
// rodada entra na próxima, sem reler. Cada escrita leva trilha «AUTO ·» com DESFAZER genérico; DESFEITO vira memória.
export const maxDuration = 120

/* eslint-disable @typescript-eslint/no-explicit-any */
const CHECK = 'receipt-read'
const READABLE = /\.(pdf|jpe?g|png|webp|gif)(\?|$)/i
const MAX_BYTES = 9_000_000
const IMPOSSIBLE_SLACK_DAYS = 90   // compra antecipada legítima existe (Texas Speed dez/25 pra invoice de jun/26): folga larga, o recibo decide
const RETRY_ERROR_DAYS = 7
const TIME_BUDGET_MS = 85_000

type Reading = { supplier: string; registry: string | null; date: string; payer: string; bill_to: string; method: string; currency: string; paid_from: string | null; paid_from_hint: string | null; file: string; at: string; model?: string; error?: string }

const esc = (s: string) => [...s].map(ch => /[A-Za-z0-9 ]/.test(ch) ? ch : '\\' + ch).join('')
function registryOf(sups: any[]) {
  return sups.map(s => {
    const phrases = [String(s.name || ''), ...String(s.aliases || '').split(/[,\n]/)].map(x => x.trim()).filter(x => x && (x.replace(/[^A-Za-z0-9]/g, '').length >= 5 || /\s/.test(x)) && !/^https?:|\.com$|\.br$/i.test(x))
    return { name: String(s.name), res: phrases.map(p => new RegExp('(^|[^A-Za-z0-9])' + esc(p) + '([^A-Za-z0-9]|$)', 'i')) }
  })
}
const resolveName = (registry: { name: string; res: RegExp[] }[], raw: string): string | null => {
  if (!raw || /GZ28/i.test(raw)) return null
  const hits = registry.filter(o => o.res.some(re => re.test(raw))).map(o => o.name)
  return hits.length === 1 ? hits[0] : null
}
const parseUrls = (u: any): string[] => { try { const j = typeof u === 'string' ? JSON.parse(u) : u; return Array.isArray(j) ? j.map(String) : [String(u)] } catch { return [String(u)] } }
const addDays = (iso: string, d: number) => new Date(Date.parse(iso.slice(0, 10)) + d * 864e5).toISOString().slice(0, 10)

// QUEM PAGOU, pelo que o recibo mostra. Sócio, cliente e gente vêm ANTES (sugestão); GZ28BR só com documento brasileiro
// pago pela BR (ou sem pagador impresso — o instrumento é dela); GZ28US nunca daqui.
function payerVerdict(r: { payer: string; method: string; currency: string }): { paid_from: string | null; hint: string | null } {
  const payer = r.payer.toUpperCase(), method = r.method.toUpperCase(), cur = r.currency.toUpperCase()
  const brDoc = cur === 'BRL' || /PIX|TED|BOLETO|\bDOC\b/.test(method)
  if (/\bBETO\b|ROBERTO/.test(payer)) return { paid_from: null, hint: 'BETO' }
  if (/HERALDO/.test(payer)) return { paid_from: null, hint: 'HERALDO' }
  if (/MARCIO|MÁRCIO|\bDEMA\b/.test(payer)) return { paid_from: null, hint: brDoc ? 'GZ28BR' : 'GZ28US' }
  if (brDoc && (!payer || /GZ28 ?BR|GZ28BR|SPEEDSHOP BRASIL|GALP[AÃ]O Z28/.test(payer))) return { paid_from: 'GZ28BR', hint: null }
  if (brDoc) return { paid_from: null, hint: 'GZ28BR' }   // documento brasileiro pago por outra empresa/pessoa: palpite, não prova
  if (/GZ28/.test(payer)) return { paid_from: null, hint: 'GZ28US' }   // dólar: quem prova é o banco
  return { paid_from: null, hint: null }
}

async function readReceipt(url: string, today: string): Promise<{ supplier: string; date: string; payer: string; bill_to: string; method: string; currency: string; model: string }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY ausente')
  const r = await fetch(url)
  if (!r.ok) throw new Error('recibo inacessível (' + r.status + ')')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('recibo grande demais (' + Math.round(buf.length / 1e6) + ' MB)')
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const isPDF = ct === 'application/pdf' || /\.pdf(\?|$)/i.test(url)
  if (!isPDF && !/^image\//.test(ct) && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) throw new Error('arquivo não é imagem nem PDF (' + (ct || '?') + ')')
  const media = isPDF ? 'application/pdf' : (/image\/(jpeg|png|webp|gif)/.test(ct) ? ct : (/\.png(\?|$)/i.test(url) ? 'image/png' : 'image/jpeg'))
  const prompt = 'This is a purchase receipt, invoice, order confirmation or payment confirmation for an auto shop. GZ28 V8 SpeedShop (US) and GZ28BR (Brazil) are always on the BUYER side, never the seller. Return ONLY a raw JSON object, no markdown: {"supplier": "the SELLER — the business we bought from, exactly as printed; empty if none", "date": "purchase/order/payment date as YYYY-MM-DD; empty if not found", "bill_to": "the Bill To / Sold To / customer party as printed; empty if none", "payer": "ONLY the account that actually PAID: the cardholder name or card holder line, the wire/ACH sender, the Pix or TED payer, the check account name — NOT the Bill To party; empty if the document does not show who paid", "method": "one of CARD, WIRE, ZELLE, ACH, CHECK, CASH, PAYPAL, PIX, TED, BOLETO or empty", "currency": "USD or BRL or empty" }. Never return a date after ' + today + '.'
  const call = async (model: string) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: [isPDF ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } } : { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } }, { type: 'text', text: prompt }] }] }),
  })
  let model = 'claude-haiku-4-5-20251001'
  let res = await call(model)
  if (!res.ok && isPDF) { model = 'claude-opus-4-8'; res = await call(model) }   // o scanner do Márcio lê PDF com o Opus; se o Haiku recusar, mesmo caminho
  if (!res.ok) throw new Error('IA ' + res.status + ': ' + (await res.text()).slice(0, 120))
  const j: any = await res.json()
  const text = String((j.content || []).map((c: any) => c.text || '').join('')).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: any = {}
  try { parsed = JSON.parse(text) } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]) } catch { /* sem JSON */ } } }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) && String(parsed.date) <= today ? String(parsed.date) : ''
  const s = (v: any, n: number) => String(v || '').trim().slice(0, n)
  return { supplier: s(parsed.supplier, 80), date, payer: s(parsed.payer, 80), bill_to: s(parsed.bill_to, 80), method: s(parsed.method, 12), currency: s(parsed.currency, 3), model }
}

async function readings(db: any): Promise<Map<string, Reading>> {
  const out = new Map<string, Reading>()
  const { data } = await db.from('data_fixes').select('row_id, new_value').eq('check_key', CHECK).eq('field', 'RECEIPT').order('fixed_at', { ascending: false }).limit(4000)
  for (const r of data || []) { if (out.has(String(r.row_id))) continue; try { out.set(String(r.row_id), JSON.parse(String(r.new_value || '{}'))) } catch { /* leitura corrompida */ } }
  return out
}
// Memória do card: a ÚLTIMA dispensa por linha vale; «VOLTOU A PERGUNTAR» (UNDISMISS) cancela.
async function memoOf(db: any): Promise<Set<string>> {
  const { data } = await db.from('data_fixes').select('row_id, new_value, fixed_at').in('check_key', ['inv-no-supplier', 'paid-from', 'undated-inv', 'inv-date-impossible']).eq('field', 'DISMISSED').order('fixed_at', { ascending: false }).limit(4000)
  const latest = new Map<string, string>()
  for (const r of data || []) if (!latest.has(String(r.row_id))) latest.set(String(r.row_id), String(r.new_value || ''))
  return new Set([...latest.entries()].filter(([, v]) => v !== 'UNDISMISS').map(([k]) => k))
}

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const map = await readings(db)
  return NextResponse.json({ ok: true, readings: Object.fromEntries(map) })
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const t0 = Date.now()
  const b = await req.json().catch(() => ({}))
  const dry = !!b.dry
  const max = Math.min(40, Math.max(1, Number(b.max) || 12))
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const res = { candidates: 0, read: 0, reused: 0, applied: 0, supplier_written: 0, supplier_suggested: 0, date_written: 0, date_fixed: 0, payer_written: 0, payer_suggested: 0, skipped: 0, errors: [] as string[], dry }
  try {
    const rows: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('invoice_expenses').select('id, item, supplier, expense_date, payment_date, paid_from, receipt_url, invoice_id').not('receipt_url', 'is', null).order('id').range(from, from + 999)
      if (error) throw new Error(error.message)
      rows.push(...(data || [])); if (!data || data.length < 1000) break
    }
    const { data: invs } = await db.from('invoices').select('id, hiring_date, entry_date')
    const born = new Map<string, string>((invs || []).map((i: any) => [String(i.id), String(i.hiring_date || i.entry_date || '').slice(0, 10)]))
    const floorOf = (r: any) => { const b0 = born.get(String(r.invoice_id)); return b0 ? addDays(b0, -IMPOSSIBLE_SLACK_DAYS) : null }
    const impossible = (r: any): 'expense_date' | 'payment_date' | null => { const fl = floorOf(r); if (!fl) return null; const ed = String(r.expense_date || '').slice(0, 10), pd = String(r.payment_date || '').slice(0, 10); return ed && ed < fl ? 'expense_date' : pd && pd < fl ? 'payment_date' : null }
    const noSup = (r: any) => !String(r.supplier || '').trim()
    const noPayer = (r: any) => !String(r.paid_from || '').trim() && !!r.payment_date
    const needs = (r: any) => noSup(r) || !r.expense_date || !!impossible(r) || noPayer(r)
    const done = await readings(db)
    const memo = await memoOf(db)
    const { data: sups } = await db.from('suppliers').select('id, name, aliases')
    const registry = registryOf(sups || [])

    // APLICAR a partir de uma leitura (guardado; idempotente). Devolve quantas escritas fez.
    const apply = async (r: any, reading: Reading): Promise<number> => {
      if (dry || reading.error) return 0
      let n = 0
      const item = String(r.item || '')
      if (noSup(r) && reading.registry) {
        const { data: ok } = await db.from('invoice_expenses').update({ supplier: reading.registry }).eq('id', r.id).or('supplier.is.null,supplier.eq.').select('id')
        if (ok && ok.length) { n++; res.supplier_written++; await db.from('data_fixes').insert({ check_key: 'inv-no-supplier', table_name: 'invoice_expenses', row_id: r.id, field: 'supplier', old_value: r.supplier ?? null, new_value: reading.registry, label: ('AUTO · recibo lido: «' + reading.supplier + '» = ' + reading.registry + ' (cadastro) · ' + item).slice(0, 200) }).then(() => undefined, () => undefined) }
      } else if (noSup(r) && reading.supplier) res.supplier_suggested++
      if (reading.date) {
        const fl = floorOf(r)
        const plausible = !fl || reading.date >= fl
        if (!r.expense_date && plausible) {
          const { data: ok } = await db.from('invoice_expenses').update({ expense_date: reading.date }).eq('id', r.id).is('expense_date', null).select('id')
          if (ok && ok.length) { n++; res.date_written++; await db.from('data_fixes').insert({ check_key: 'undated-inv', table_name: 'invoice_expenses', row_id: r.id, field: 'expense_date', old_value: null, new_value: reading.date, label: ('AUTO · data do recibo · ' + item).slice(0, 200) }).then(() => undefined, () => undefined) }
        } else {
          const bad = impossible(r)
          if (bad && plausible) {
            const old = String(r[bad]).slice(0, 10)
            const patch: any = { [bad]: reading.date }
            const other = bad === 'expense_date' ? 'payment_date' : 'expense_date'
            const sameOther = r[other] && String(r[other]).slice(0, 10) === old
            if (sameOther) patch[other] = reading.date
            const { data: ok } = await db.from('invoice_expenses').update(patch).eq('id', r.id).eq(bad, r[bad]).select('id')
            if (ok && ok.length) {
              n++; res.date_fixed++
              await db.from('data_fixes').insert({ check_key: 'inv-date-impossible', table_name: 'invoice_expenses', row_id: r.id, field: bad, old_value: old, new_value: reading.date, label: ('AUTO · data impossível (antes da invoice existir) corrigida pelo recibo: ' + old + ' → ' + reading.date + ' · ' + item).slice(0, 200) }).then(() => undefined, () => undefined)
              if (sameOther) await db.from('data_fixes').insert({ check_key: 'inv-date-impossible', table_name: 'invoice_expenses', row_id: r.id, field: other, old_value: old, new_value: reading.date, label: ('AUTO · a outra data era a mesma errada, corrigida junto · ' + item).slice(0, 200) }).then(() => undefined, () => undefined)
            }
          }
        }
      }
      if (noPayer(r)) {
        if (reading.paid_from) {
          const { data: ok } = await db.from('invoice_expenses').update({ paid_from: reading.paid_from }).eq('id', r.id).or('paid_from.is.null,paid_from.eq.').select('id')
          if (ok && ok.length) { n++; res.payer_written++; await db.from('data_fixes').insert({ check_key: 'paid-from', table_name: 'invoice_expenses', row_id: r.id, field: 'paid_from', old_value: null, new_value: reading.paid_from, label: ('AUTO · recibo lido: documento brasileiro' + (reading.payer ? ' pago por «' + reading.payer + '»' : ' (' + (reading.method || reading.currency) + ')') + ' = ' + reading.paid_from + ' · ' + item).slice(0, 200) }).then(() => undefined, () => undefined) }
        } else if (reading.paid_from_hint) res.payer_suggested++
      }
      return n
    }

    const needing = rows.filter(r => needs(r) && !memo.has(String(r.id)))
    // 1 · reaplica as leituras guardadas (sem IA, sem custo): o que não coube numa rodada entra agora.
    for (const r of needing) { const rd = done.get(String(r.id)); if (rd && !rd.error) res.applied += await apply(r, rd) }
    // 2 · lê recibos novos (ou com erro antigo já vencido), até o teto e dentro do tempo.
    const fresh = needing.filter(r => { const rd = done.get(String(r.id)); if (!rd) return true; if (!rd.error) return false; return Date.now() - Date.parse(rd.at || '2000-01-01') > RETRY_ERROR_DAYS * 864e5 })
    // Ordem: o que falta MAIS primeiro (fornecedor, data impossível, data vazia), pagador vazio por último — medido em 9/set: 226 linhas, 192 só sem pagador.
    const score = (r: any) => (noSup(r) ? 8 : 0) + (impossible(r) ? 4 : 0) + (!r.expense_date ? 2 : 0) + (noPayer(r) ? 1 : 0)
    fresh.sort((x, y) => score(y) - score(x))
    res.candidates = fresh.length
    const remember = async (r: any, reading: Reading) => { if (dry) return; await db.from('data_fixes').insert({ check_key: CHECK, table_name: 'invoice_expenses', row_id: r.id, field: 'RECEIPT', old_value: null, new_value: JSON.stringify(reading), label: (reading.error ? 'RECIBO · ' + reading.error : 'RECIBO LIDO · «' + (reading.supplier || '?') + '»' + (reading.registry ? ' = ' + reading.registry : '') + (reading.date ? ' · ' + reading.date : '') + (reading.payer ? ' · pagou ' + reading.payer : '')).slice(0, 160) + ' · ' + String(r.item || '').slice(0, 36) }).then(() => undefined, () => undefined) }
    // MESMA FOTO, UMA LEITURA (DC 1.48.1): pedido com várias linhas anexa o mesmo recibo em cada uma — a irmã já lida responde de graça
    // (7 linhas da AutoZone leram o mesmo recibo 7 vezes na primeira rodada). Reaproveitar não conta no teto de leituras.
    const byFile = new Map<string, Reading>()
    for (const rd of done.values()) if (!rd.error && rd.file && !byFile.has(rd.file)) byFile.set(rd.file, rd)
    let attempted = 0
    for (const r of fresh) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break
      const file = parseUrls(r.receipt_url).find(u => READABLE.test(u))
      const base = { supplier: '', registry: null, date: '', payer: '', bill_to: '', method: '', currency: '', paid_from: null, paid_from_hint: null, file: file || '', at: new Date().toISOString() }
      if (!file) { res.skipped++; await remember(r, { ...base, error: 'sem arquivo legível (html?)' }); continue }
      const sib = byFile.get(file)
      if (sib) { const reading: Reading = { ...sib, at: base.at, model: String(sib.model || '') + ' · mesmo recibo da irmã' }; res.reused++; await remember(r, reading); res.applied += await apply(r, reading); continue }
      if (attempted >= max) continue   // teto de leituras por chamada; segue varrendo por irmãs de graça
      attempted++
      let reading: Reading
      try { const got = await readReceipt(file, today); const pv = payerVerdict(got); reading = { ...base, supplier: got.supplier, registry: resolveName(registry, got.supplier), date: got.date, payer: got.payer, bill_to: got.bill_to, method: got.method, currency: got.currency, paid_from: pv.paid_from, paid_from_hint: pv.hint, model: got.model } }
      catch (e) { const msg = String((e as Error).message || e).slice(0, 100); res.errors.push(String(r.item || '').slice(0, 30) + ': ' + msg); await remember(r, { ...base, error: msg }); continue }
      res.read++
      byFile.set(file, reading)
      await remember(r, reading)
      res.applied += await apply(r, reading)
    }
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 300), ...res }, { status: 500 })
  }
}
