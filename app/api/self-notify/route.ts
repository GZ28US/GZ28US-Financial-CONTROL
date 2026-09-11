import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendKeyValue } from '@/lib/apiAuth.server'

// AVISO DAS PÁGINAS PÚBLICAS (11/set/2026 — auditoria de segurança).
//
// As 5 páginas sem login (/clients/self, /rides/self, /costs/fixed/self,
// /staff/self e /duties/self — PUBLIC_PREFIXES em components/AuthGate.tsx)
// montavam o texto do WhatsApp NO NAVEGADOR e postavam em /api/whatsapp sem
// credencial: qualquer um mandava qualquer texto, pra qualquer destino, com a
// assinatura do app. A rota de envio fechou. As páginas agora dizem só O QUE
// aconteceu — {kind, id}; no duty, staffId + dutyId + ação — e este servidor:
//   1. lê a linha com a service role e remonta EXATAMENTE a mensagem que a página
//      montava (mesmos emojis, títulos, rótulos, idioma, campos vazios pulados);
//   2. só avisa mudança de verdade e recente: o updated_at que as RPCs
//      *_self_update / ride_self_set_photo carimbam, nos últimos 10 min; no duty,
//      a linha do duty_events da mesma ação, nos últimos 3 min. Fora disso, 409;
//   3. no máximo um aviso por (kind, id[, ação]) a cada 2 min, e UM aviso por
//      mudança (o mesmo updated_at / o mesmo duty_events.at não avisa de novo
//      dentro da janela), na MEMÓRIA desta lambda. Nenhuma tabela serve:
//      wa_send_log é o log do envio e data_fixes é a trilha de consertos do Data
//      Checker. Outra instância da função não vê esta memória, então um repetido
//      pode escapar por lá;
//   4. manda pela rota do próprio app, servidor com servidor (x-send-key): a
//      assinatura, o wa_send_log, as menções e a trava do "nunca pra mim mesmo"
//      continuam num lugar só. A chave só sai para o host do próprio app.
// Texto, telefone, chat id e nome de grupo NUNCA vêm do pedido: campo fora da
// lista é 400.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JANELA_LINHA_MS = 10 * 60 * 1000
const JANELA_EVENTO_MS = 3 * 60 * 1000
// As pausas automáticas são gravadas no mesmo toque do START: segundos de distância.
const JANELA_AUTOPAUSA_MS = 60 * 1000
const DEDUPE_MS = 2 * 60 * 1000
// Carimbo no FUTURO não é mudança recente: o duty_events aceita `at` do pedido e as
// telas de edição gravam updated_at com o relógio do navegador. Só a folga do relógio.
const FOLGA_RELOGIO_MS = 60 * 1000

// Espelho de app/duties/self/[staffId]/page.tsx.
const STAFF_GROUP_NAME = 'GZ28US - STAFF'
const MANOBRAS_DESC = 'MANOBRAS — cars OUT (morning) / cars IN (end of day)'

type Kind = 'client' | 'ride' | 'fixed_supplier' | 'staff' | 'duty'
const CAMPOS: Record<Kind, Set<string>> = {
  client: new Set(['kind', 'id']),
  ride: new Set(['kind', 'id']),
  fixed_supplier: new Set(['kind', 'id']),
  staff: new Set(['kind', 'id']),
  duty: new Set(['kind', 'staffId', 'dutyId', 'action', 'autoPaused']),
}
// A ação do aviso → a ação que a página grava no duty_events (DONE, não FINISHED).
const DUTY_ACTIONS = { STARTED: 'STARTED', RESUMED: 'RESUMED', PAUSED: 'PAUSED', FINISHED: 'DONE' } as const
type DutyAction = keyof typeof DUTY_ACTIONS

// `marca` = o carimbo da mudança avisada (updated_at da linha ou `at` do evento).
type Montagem = { ok: true; body: string; marca: string; toGroupName?: string } | { ok: false; status: number; error: string }

function falha(status: number, error: string): Montagem {
  return { ok: false, status, error }
}
function erroDb(onde: string, e: { message?: string } | null): Montagem {
  console.error('[self-notify] banco', onde, e?.message)
  return falha(500, 'database error')
}

// ── dedupe: memória desta lambda ─────────────────────────────────────────────
// chave → até quando ela segura (ms). (kind, id[, ação]) segura 2 min; a mudança
// em si (chave@carimbo) segura a janela inteira, senão o MESMO salvamento podia
// ser reavisado a cada 2 min enquanto o updated_at ainda é "recente".
const avisados = new Map<string, number>()
function jaAvisado(chave: string): boolean {
  const agora = Date.now()
  for (const [k, ate] of avisados) if (agora >= ate) avisados.delete(k)
  return avisados.has(chave)
}
function reservar(chaves: [string, number][]): boolean {
  if (chaves.some(([k]) => jaAvisado(k))) return false
  const agora = Date.now()
  for (const [k, ms] of chaves) avisados.set(k, agora + ms)
  return true
}

// A chave de envio só sai para o PRÓPRIO app. nextUrl.origin nasce do Host do
// pedido; atrás de um Host forjado (fora da Vercel, proxy mal configurado) o
// x-send-key iria para o servidor de outro. Vale o domínio do app, as URLs desta
// implantação que a Vercel informa e o localhost do dev.
function origemDoApp(req: NextRequest): string | null {
  const origem = req.nextUrl.origin
  let host = ''
  try { host = new URL(origem).hostname.toLowerCase() } catch { return null }
  const aceitos = new Set(['www.gz28us.com', 'gz28us.com', 'localhost', '127.0.0.1'])
  for (const v of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (v) aceitos.add(v.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0])
  }
  return aceitos.has(host) ? origem : null
}

// ── relógio ──────────────────────────────────────────────────────────────────
// O Supabase devolve timestamptz com o fuso; se um dia vier sem, é UTC.
function instante(s: unknown): number {
  const v = String(s || '')
  if (!v) return NaN
  return Date.parse(/(z|[+-]\d{2}(:?\d{2})?)$/i.test(v.slice(16)) ? v : v + 'Z')
}
function recente(s: unknown, janelaMs: number): boolean {
  const t = instante(s)
  if (!Number.isFinite(t)) return false
  const idade = Date.now() - t
  return idade <= janelaMs && idade >= -FOLGA_RELOGIO_MS
}
// A página formatava no relógio do celular do staff, em Orlando. No servidor
// (UTC) o fuso é explícito, senão a hora do aviso sai 4h adiantada.
const DIA_ORL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
const HORA_ORL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const DATA_UTC = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
function fmtDT(iso: unknown): string {
  const d = new Date(instante(iso))
  return DIA_ORL.format(d) + ', ' + HORA_ORL.format(d)
}
// Data pura ('yyyy-mm-dd') lida como meia-noite UTC e formatada em UTC: o dia não pula.
function fmtPromised(d: string): string {
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(d)
  return DATA_UTC.format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])))
}
function fmtDur(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : m > 0 ? `${m}m ${ss}s` : `${ss}s`
}
// 'yyyy-mm-dd' -> 'MMM d, yyyy' without new Date() (avoids the UTC day-shift).
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatBirthDateUS(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return iso
  return `${MONTHS_SHORT[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`
}

const txt = (v: unknown): string => (v == null ? '' : String(v))

// ── /clients/self/[id] ───────────────────────────────────────────────────────
async function avisoClient(db: SupabaseClient, id: string): Promise<Montagem> {
  const { data: c, error } = await db.from('clients')
    .select('name, email, instagram, facebook, country, phone, cpf, address, city, state, zip, preferred_message_method, updated_at')
    .eq('id', id).maybeSingle()
  if (error) return erroDb('clients', error)
  if (!c) return falha(404, 'not found')
  if (!recente(c.updated_at, JANELA_LINHA_MS)) return falha(409, 'no recent change')
  const form = {
    name: txt(c.name), email: txt(c.email), instagram: txt(c.instagram), facebook: txt(c.facebook),
    country: txt(c.country), phone: txt(c.phone), cpf: txt(c.cpf), address: txt(c.address),
    city: txt(c.city), state: txt(c.state), zip: txt(c.zip), preferred_message_method: txt(c.preferred_message_method),
  }
  const zipLabel = form.country === 'USA' ? 'ZIP' : form.country === 'ENGLAND' ? 'POSTCODE' : 'CEP'
  // Confirm to the internal REPORTS group (team language: English) that the client
  // filled in their own data, listing every field they filled (blanks skipped).
  const rows: string[] = []
  if (form.email.trim()) rows.push(`Email: ${form.email.trim()}`)
  if (form.instagram.trim()) rows.push(`Instagram: ${form.instagram.trim()}`)
  if (form.facebook.trim()) rows.push(`Facebook: ${form.facebook.trim()}`)
  if (form.country.trim()) rows.push(`Country: ${form.country.trim()}`)
  if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
  if (form.country === 'BRAZIL' && form.cpf.trim()) rows.push(`CPF: ${form.cpf.trim()}`)
  if (form.address.trim()) rows.push(`Address: ${form.address.trim()}`)
  if (form.city.trim()) rows.push(`City: ${form.city.trim()}`)
  if (form.state.trim()) rows.push(`State: ${form.state.trim()}`)
  if (form.zip.trim()) rows.push(`${zipLabel}: ${form.zip.trim()}`)
  if (form.preferred_message_method.trim()) rows.push(`Messages: ${form.preferred_message_method.trim()}`)
  const body = `✅ *FORM FILLED BY THE CLIENT*\n${form.name || '—'}\nThe client filled in and saved their own details:${rows.length ? '\n\n' + rows.join('\n') : ''}`
  return { ok: true, body, marca: txt(c.updated_at) }
}

// ── /rides/self/[id] (foto do carro) ─────────────────────────────────────────
async function avisoRide(db: SupabaseClient, id: string): Promise<Montagem> {
  const { data: r, error } = await db.from('rides')
    .select('project_code, project_name, manufacturer, brand, model, version, year, client_id, photo_url, updated_at')
    .eq('id', id).maybeSingle()
  if (error) return erroDb('rides', error)
  if (!r) return falha(404, 'not found')
  // "UPLOADED BY CLIENT" só é verdade se a foto atual saiu da página pública, que
  // grava em ride-photos/<id>/client-<...>.
  const daPagina = txt(r.photo_url).toLowerCase().includes(`/${id.toLowerCase()}/client-`)
  if (!recente(r.updated_at, JANELA_LINHA_MS) || !daPagina) return falha(409, 'no recent change')
  let clientName = ''
  if (r.client_id) {
    const { data: c, error: cErr } = await db.from('clients').select('name').eq('id', r.client_id).maybeSingle()
    if (cErr) return erroDb('clients', cErr)
    clientName = txt(c?.name)
  }
  const carName = r.project_name
    || [r.manufacturer || r.brand, r.model, r.version, r.year].filter(Boolean).join(' ')
    || r.project_code
  // Confirm to the internal REPORTS group that the client uploaded their car photo.
  const body = `📸 *CAR PHOTO — UPLOADED BY CLIENT*\n${carName || '—'}${clientName ? `\nClient: ${clientName}` : ''}\nThe client sent their favorite car photo. It's on the vehicle's record now.`
  return { ok: true, body, marca: txt(r.updated_at) }
}

// ── /costs/fixed/self/[id] ───────────────────────────────────────────────────
async function avisoFixedSupplier(db: SupabaseClient, id: string): Promise<Montagem> {
  const { data: s, error } = await db.from('fixed_cost_suppliers')
    .select('description, company, contact_name, phone, email, preferred_contact, updated_at')
    .eq('id', id).maybeSingle()
  if (error) return erroDb('fixed_cost_suppliers', error)
  if (!s) return falha(404, 'not found')
  if (!recente(s.updated_at, JANELA_LINHA_MS)) return falha(409, 'no recent change')
  const form = {
    company: txt(s.company), contact_name: txt(s.contact_name), phone: txt(s.phone), email: txt(s.email),
    preferred_contact: txt(s.preferred_contact) || 'WhatsApp',
  }
  // Confirm to the internal REPORTS group (team language: English).
  const rows: string[] = []
  if (form.company.trim()) rows.push(`Company: ${form.company.trim()}`)
  if (form.contact_name.trim()) rows.push(`Contact: ${form.contact_name.trim()}`)
  if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
  if (form.email.trim()) rows.push(`Email: ${form.email.trim()}`)
  rows.push(`Preferred: ${form.preferred_contact}`)
  const body = `✅ *FIXED COST SUPPLIER — FORM FILLED*\n${txt(s.description) || form.company || '—'}\nThe supplier filled in and saved their own details:\n\n${rows.join('\n')}`
  return { ok: true, body, marca: txt(s.updated_at) }
}

// ── /staff/self/[id] ─────────────────────────────────────────────────────────
async function avisoStaff(db: SupabaseClient, id: string): Promise<Montagem> {
  const { data: m, error } = await db.from('staff')
    .select('name, email, instagram, phone, cpf, birth_date, passport, passport_expiry, zip, address, city, state, preferred_message_method, updated_at')
    .eq('id', id).maybeSingle()
  if (error) return erroDb('staff', error)
  if (!m) return falha(404, 'not found')
  if (!recente(m.updated_at, JANELA_LINHA_MS)) return falha(409, 'no recent change')
  const form = {
    name: txt(m.name), email: txt(m.email), instagram: txt(m.instagram), phone: txt(m.phone), cpf: txt(m.cpf),
    birth_date: txt(m.birth_date), passport: txt(m.passport), passport_expiry: txt(m.passport_expiry),
    zip: txt(m.zip), address: txt(m.address), city: txt(m.city), state: txt(m.state),
    preferred_message_method: txt(m.preferred_message_method),
  }
  // Confirm to the internal REPORTS group that the member filled their own data.
  const rows: string[] = []
  if (form.email.trim()) rows.push(`E-mail: ${form.email.trim()}`)
  if (form.instagram.trim()) rows.push(`Instagram: ${form.instagram.trim()}`)
  if (form.phone.replace(/\D/g, '').length > 3) rows.push(`Phone: ${form.phone.trim()}`)
  if (form.cpf.trim()) rows.push(`Document: ${form.cpf.trim()}`)
  if (form.birth_date) rows.push(`Birth date: ${formatBirthDateUS(form.birth_date)}`)
  if (form.passport.trim()) rows.push(`Passport: ${form.passport.trim()}`)
  if (form.passport_expiry) rows.push(`Passport expiry: ${formatBirthDateUS(form.passport_expiry)}`)
  if (form.zip.trim()) rows.push(`ZIP: ${form.zip.trim()}`)
  if (form.address.trim()) rows.push(`Address: ${form.address.trim()}`)
  if (form.city.trim()) rows.push(`City: ${form.city.trim()}`)
  if (form.state.trim()) rows.push(`State: ${form.state.trim()}`)
  if (form.preferred_message_method.trim()) rows.push(`Messages: ${form.preferred_message_method.trim()}`)
  const body = `✅ *STAFF FORM — FILLED BY THE MEMBER*\n${form.name || '—'}\nThe staff member filled in and saved their own details:${rows.length ? '\n\n' + rows.join('\n') : ''}`
  return { ok: true, body, marca: txt(m.updated_at) }
}

// ── /duties/self/[staffId] ───────────────────────────────────────────────────
// A mesma mensagem do eventBody da página (formato do Márcio, 01/ago/2026: nome
// em negrito sem @menção e uma linha "Carro - Tarefa", só o nome do carro). Tudo
// vem do banco: nome do staff, a duty e o carro pelas tabelas, a hora e o tempo
// bancado pelo duty_events da ação. A descrição gravada no duty_events NÃO é
// usada — ela chega de uma rota pública e seria texto livre de novo.
async function avisoDuty(db: SupabaseClient, staffId: string, dutyId: string, action: DutyAction, autoPaused: string[]): Promise<Montagem> {
  const { data: st, error: sErr } = await db.from('staff').select('name').eq('id', staffId).maybeSingle()
  if (sErr) return erroDb('staff', sErr)
  if (!st) return falha(404, 'not found')
  const manobras = dutyId === 'MANOBRAS'

  let description = MANOBRAS_DESC
  let carLabel = ''
  // Invoice DELIVERY DATE with no CONCLUSION DATE = the PROMISED TO date —
  // carried on every update report.
  let promised: string | null = null
  let workStartedAt: string | null = null
  let rowSeconds = 0
  if (!manobras) {
    const { data: d, error: dErr } = await db.from('invoice_duties')
      .select('description, invoice_id, time_seconds, work_started_at').eq('id', dutyId).eq('staff_id', staffId).maybeSingle()
    if (dErr) return erroDb('invoice_duties', dErr)
    if (!d) return falha(404, 'not found')
    description = txt(d.description)
    workStartedAt = d.work_started_at || null
    rowSeconds = Number(d.time_seconds) || 0
    if (d.invoice_id) {
      const { data: inv, error: iErr } = await db.from('invoices')
        .select('ride_id, delivery_date, conclusion_date').eq('id', d.invoice_id).maybeSingle()
      if (iErr) return erroDb('invoices', iErr)
      promised = inv?.delivery_date && !inv?.conclusion_date ? String(inv.delivery_date) : null
      if (inv?.ride_id) {
        const { data: ride, error: rErr } = await db.from('rides').select('project_code, project_name').eq('id', inv.ride_id).maybeSingle()
        if (rErr) return erroDb('rides', rErr)
        carLabel = [ride?.project_code, ride?.project_name].filter(Boolean).join(' — ')
      }
    }
  }

  // O toque tem que estar gravado: a página grava o duty_events ANTES de pedir o aviso.
  let evQ = db.from('duty_events').select('at, seconds_banked')
    .eq('staff_id', staffId).eq('action', DUTY_ACTIONS[action])
    .gte('at', new Date(Date.now() - JANELA_EVENTO_MS).toISOString())
    .lte('at', new Date(Date.now() + FOLGA_RELOGIO_MS).toISOString())
  evQ = manobras ? evQ.is('duty_id', null) : evQ.eq('duty_id', dutyId)
  const { data: evs, error: eErr } = await evQ.order('at', { ascending: false }).limit(1)
  if (eErr) return erroDb('duty_events', eErr)
  const ev = evs?.[0]
  if (!ev) return falha(409, 'no recent change')
  const secs = ev.seconds_banked != null && Number.isFinite(Number(ev.seconds_banked)) ? Number(ev.seconds_banked) : rowSeconds

  // MANOBRAS não tem linha: o início da rodada morava só no celular. É o último
  // STARTED depois do DONE anterior — o mesmo que o localStorage guardava.
  if (manobras && action === 'FINISHED') {
    const { data: antes, error: aErr } = await db.from('duty_events').select('at')
      .eq('staff_id', staffId).is('duty_id', null).eq('action', 'DONE').lt('at', ev.at)
      .order('at', { ascending: false }).limit(1)
    if (aErr) return erroDb('duty_events', aErr)
    let iniQ = db.from('duty_events').select('at')
      .eq('staff_id', staffId).is('duty_id', null).eq('action', 'STARTED').lte('at', ev.at)
    if (antes?.[0]?.at) iniQ = iniQ.gt('at', antes[0].at)
    const { data: ini, error: nErr } = await iniQ.order('at', { ascending: false }).limit(1)
    if (nErr) return erroDb('duty_events', nErr)
    workStartedAt = ini?.[0]?.at || null
  }

  // "auto-paused": a página manda só os ids que ela pausou; entra quem tem PAUSED
  // gravado colado neste START, com a descrição da tabela. Ordem da página: as
  // duties por created_at, MANOBRAS por último.
  let extra = ''
  if ((action === 'STARTED' || action === 'RESUMED') && autoPaused.length) {
    const t = instante(ev.at)
    const desde = new Date(t - JANELA_AUTOPAUSA_MS).toISOString()
    const ate = new Date(t + JANELA_AUTOPAUSA_MS).toISOString()
    const nomes: string[] = []
    const ids = [...new Set(autoPaused.filter(x => x !== 'MANOBRAS' && x !== dutyId))]
    if (ids.length) {
      const [rowsRes, pausasRes] = await Promise.all([
        db.from('invoice_duties').select('id, description, created_at').eq('staff_id', staffId).in('id', ids).order('created_at', { ascending: true }),
        db.from('duty_events').select('duty_id').eq('staff_id', staffId).eq('action', 'PAUSED').in('duty_id', ids).gte('at', desde).lte('at', ate),
      ])
      if (rowsRes.error) return erroDb('invoice_duties', rowsRes.error)
      if (pausasRes.error) return erroDb('duty_events', pausasRes.error)
      const pausados = new Set((pausasRes.data || []).map(p => String(p.duty_id)))
      for (const r of rowsRes.data || []) if (pausados.has(String(r.id))) nomes.push(txt(r.description))
    }
    if (!manobras && autoPaused.includes('MANOBRAS')) {
      const { data: mp, error: mErr } = await db.from('duty_events').select('at')
        .eq('staff_id', staffId).eq('action', 'PAUSED').is('duty_id', null).gte('at', desde).lte('at', ate).limit(1)
      if (mErr) return erroDb('duty_events', mErr)
      if (mp?.length) nomes.push('MANOBRAS')
    }
    if (nomes.length) extra = `⏸ auto-paused: ${nomes.join(', ')}`
  }

  const icon = action === 'PAUSED' ? '⏸' : action === 'FINISHED' ? '✅' : '▶'
  const carName = carLabel ? (carLabel.split(' — ').pop() || '') : ''
  const desc = description.replace(/^\s*\d+[.)]\s*/, '')
  const lines = [
    `${icon} DUTY ${action}`,
    `👤 *${txt(st.name)}*`,
    `${carName ? `${carName} - ` : ''}${desc}`,
  ]
  if (promised) lines.push(`🗓 PROMISED TO: ${fmtPromised(promised)}`)
  if (action === 'STARTED' || action === 'RESUMED') lines.push(`At: ${fmtDT(ev.at)}`)
  if (action === 'PAUSED') lines.push(`⏱ ${fmtDur(secs)} so far`)
  if (action === 'FINISHED') {
    lines.push(`⏱ Total time: ${fmtDur(secs)}`)
    if (workStartedAt) lines.push(`${fmtDT(workStartedAt)} → ${fmtDT(ev.at)}`)
  }
  if (extra) lines.push(extra)
  return { ok: true, body: lines.join('\n'), marca: txt(ev.at), toGroupName: STAFF_GROUP_NAME }
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null)
  if (!b || typeof b !== 'object' || Array.isArray(b)) return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  const kind = String(b.kind || '') as Kind
  if (!Object.prototype.hasOwnProperty.call(CAMPOS, kind)) return NextResponse.json({ error: 'unknown kind' }, { status: 400 })
  if (Object.keys(b).some(k => !CAMPOS[kind].has(k))) return NextResponse.json({ error: 'unexpected field' }, { status: 400 })

  let chave: string
  let montar: (db: SupabaseClient) => Promise<Montagem>
  if (kind === 'duty') {
    const staffId = String(b.staffId || '')
    const dutyId = String(b.dutyId || '')
    const action = String(b.action || '') as DutyAction
    if (!UUID.test(staffId) || (dutyId !== 'MANOBRAS' && !UUID.test(dutyId)) || !Object.prototype.hasOwnProperty.call(DUTY_ACTIONS, action)) {
      return NextResponse.json({ error: 'bad payload' }, { status: 400 })
    }
    const autoPaused = b.autoPaused == null ? [] : b.autoPaused
    if (!Array.isArray(autoPaused) || autoPaused.length > 50 || autoPaused.some((x: unknown) => typeof x !== 'string' || (x !== 'MANOBRAS' && !UUID.test(x)))) {
      return NextResponse.json({ error: 'bad payload' }, { status: 400 })
    }
    chave = `duty:${staffId}:${dutyId}:${action}`
    montar = db => avisoDuty(db, staffId, dutyId, action, autoPaused as string[])
  } else {
    const id = String(b.id || '')
    if (!UUID.test(id)) return NextResponse.json({ error: 'bad payload' }, { status: 400 })
    chave = `${kind}:${id}`
    montar = kind === 'client' ? db => avisoClient(db, id)
      : kind === 'ride' ? db => avisoRide(db, id)
      : kind === 'fixed_supplier' ? db => avisoFixedSupplier(db, id)
      : db => avisoStaff(db, id)
  }

  // Repetido dentro dos 2 min: já avisado, nem lê o banco.
  if (jaAvisado(chave)) return NextResponse.json({ ok: true, deduped: true })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'no service key' }, { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })

  let m: Montagem
  try {
    m = await montar(db)
  } catch (e) {
    console.error('[self-notify] exceção montando', kind, e)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
  if (!m.ok) return NextResponse.json({ error: m.error }, { status: m.status })

  // Dois pedidos iguais ao mesmo tempo: só um reserva a vaga. A mesma mudança já
  // avisada (mesmo carimbo) também não sai de novo.
  const chaveMudanca = `${chave}@${m.marca}`
  if (!reservar([[chave, DEDUPE_MS], [chaveMudanca, JANELA_LINHA_MS + FOLGA_RELOGIO_MS]])) {
    return NextResponse.json({ ok: true, deduped: true })
  }
  const liberar = () => { avisados.delete(chave); avisados.delete(chaveMudanca) }
  const sendKey = sendKeyValue()
  if (!sendKey) {
    liberar()
    console.error('[self-notify] sem WHATSAPP_SEND_KEY/WHATSAPP_READ_KEY no ambiente')
    return NextResponse.json({ error: 'send not configured' }, { status: 500 })
  }
  const origem = origemDoApp(req)
  if (!origem) {
    liberar()
    console.error('[self-notify] host fora do app — chave não sai', req.nextUrl.hostname)
    return NextResponse.json({ error: 'send not configured' }, { status: 500 })
  }
  try {
    const r = await fetch(`${origem}/ca/api/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-send-key': sendKey },
      // Sem `to`: a rota cai no grupo REPORTS. O duty vai pro grupo do staff.
      body: JSON.stringify(m.toGroupName ? { toGroupName: m.toGroupName, body: m.body } : { body: m.body }),
      cache: 'no-store',
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || data?.error) {
      // Falhou: libera a vaga, senão o próximo toque ficaria calado por 2 min.
      liberar()
      console.error('[self-notify] envio recusado', { kind, status: r.status, error: String(data?.error || '').slice(0, 200) })
      return NextResponse.json({ error: 'WhatsApp send failed' }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    liberar()
    console.error('[self-notify] envio exceção', kind, e)
    return NextResponse.json({ error: 'WhatsApp send failed' }, { status: 502 })
  }
}
