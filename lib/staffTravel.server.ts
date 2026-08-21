// SERVER-ONLY — STAFF TRAVEL watcher: airline ticket e-mails drive staff Seasons
// end-to-end with zero manual steps (ordem do Márcio, 26/jul/2026):
//   • ticket BR → US (GRU/GIG/VCP → MCO...)  = ABRE a Season do staff member
//   • ticket US → BR (MCO... → GRU/GIG/VCP)  = FECHA a Season (conclusion = voo)
// Em ambos: a passagem vira expense na Season (compra = expense_date), o e-mail
// é arquivado em Trips/<nome> e o grupo STAFF recebe o report — SEMPRE com o
// LOCALIZADOR DEFINITIVO da companhia + NOME e SOBRENOME separados exatamente
// como na passagem, e NUNCA com o preço. Fechamento agradece e convida a voltar.
// Roda dentro do mail-poll (cron 5min) — funciona com o PC desligado.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMailAuth, freshAccessToken } from './streamMail.server'

const G = 'https://graph.microsoft.com/v1.0'
const gh = (t: string) => ({ Authorization: `Bearer ${t}` })

const AIRLINES = /united\.com|latam\.com|delta\.com|aa\.com|copaair\.com|voegol|gol\.com|voeazul|azul\.com/i
const TICKET_SUBJECT = /booking confirmation|eTicket Itinerary|purchase confirmation|confirma[çc][ãa]o de compra/i
const BR_AIRPORTS = ['GRU', 'GIG', 'VCP', 'CGH', 'BSB', 'CNF']
const US_AIRPORTS = ['MCO', 'MIA', 'IAH', 'IAD', 'EWR', 'ORD', 'JFK', 'ATL', 'DFW', 'LAX', 'TPA']

const SIGNATURE = 'Sent by GZ28US Control App®'
async function sendStaffWhatsApp(body: string): Promise<void> {
  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  const groupId = process.env.ULTRAMSG_STAFF_GROUP_ID || process.env.ULTRAMSG_GROUP_ID
  if (!instance || !token || !groupId) return
  try {
    await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, to: groupId, body: `${body}\n\n${SIGNATURE}` }),
    })
  } catch { /* best-effort */ }
}

type Parsed = {
  pnr: string | null
  last: string | null
  first: string | null
  airports: string[]
  flightDate: string | null   // YYYY-MM-DD of first segment
  arriveDate: string | null   // YYYY-MM-DD of last segment
  total: number | null
  flights: string[]           // human lines "UA1360 MCO→IAH ..."
}

function parseTicket(text: string): Parsed {
  const t = text.replace(/\s+/g, ' ')
  const pnr = (t.match(/Confirmation(?:\s*Number)?\s*[:\-–]?\s*([A-Z][A-Z0-9]{5})\b/) || [])[1] || null
  const nm = t.match(/\b([A-Z]{2,})\/([A-Z]{2,})\b/) // FRANCO/MARCELO
  const last = nm ? nm[1] : null
  const first = nm ? nm[2] : null
  const airports = [...t.matchAll(/\(([A-Z]{3})\)/g)].map((m) => m[1]).filter((c) => BR_AIRPORTS.includes(c) || US_AIRPORTS.includes(c))
  const dates = [...t.matchAll(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*([A-Z][a-z]{2})\s*(\d{1,2}),\s*(\d{4})/g)]
    .map((m) => new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00`))
    .filter((d) => !isNaN(d.getTime()))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const total = Number((t.match(/Total(?:\s*Per\s*Passenger)?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i) || [])[1]?.replace(/,/g, '')) || null
  const flights = [...t.matchAll(/\b(UA|LA|DL|AA|CM|G3|AD)\s?(\d{1,4})\b/g)].slice(0, 4).map((m) => `${m[1]}${m[2]}`)
  return {
    pnr, last, first, airports,
    flightDate: dates.length ? iso(dates[0]) : null,
    arriveDate: dates.length ? iso(dates[dates.length - 1]) : null,
    total, flights,
  }
}

// Match "FRANCO/MARCELO" against staff.name "Marcelo Franco".
function staffMatch(staffName: string, first: string, last: string): boolean {
  const toks = staffName.toUpperCase().split(/\s+/)
  return toks.includes(first.toUpperCase()) && toks.includes(last.toUpperCase())
}

async function fileToTrips(token: string, staffName: string, msgId: string): Promise<void> {
  try {
    const top = await fetch(`${G}/me/mailFolders?$top=200&$expand=childFolders($top=200)`, { headers: gh(token) }).then((r) => r.json())
    const flat = (f: any): any[] => [f, ...(f.childFolders || []).flatMap(flat)]
    const trips = (top.value || []).flatMap(flat).find((f: any) => f.displayName === 'Trips')
    if (!trips) return
    const kids = await fetch(`${G}/me/mailFolders/${trips.id}/childFolders?$top=50`, { headers: gh(token) }).then((r) => r.json())
    let mf = (kids.value || []).find((f: any) => String(f.displayName).toLowerCase() === staffName.toLowerCase())
    if (!mf) {
      mf = await fetch(`${G}/me/mailFolders/${trips.id}/childFolders`, {
        method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: staffName }),
      }).then((r) => r.json())
    }
    if (mf?.id) {
      await fetch(`${G}/me/messages/${encodeURIComponent(msgId)}/move`, {
        method: 'POST', headers: { ...gh(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: mf.id }),
      })
    }
  } catch { /* best-effort */ }
}

export async function runStaffTravelSweep(db: SupabaseClient): Promise<{ opened: string[]; closed: string[] }> {
  const out = { opened: [] as string[], closed: [] as string[] }
  const auth = await getMailAuth(db, 1)
  if (!auth?.refresh_token) return out
  const token = await freshAccessToken(db, auth)
  if (!token) return out

  const inbox = await fetch(`${G}/me/mailFolders/inbox/messages?$top=25&$select=id,subject,from`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
  const { data: staff } = await db.from('staff').select('id, name')
  if (!staff?.length) return out

  for (const m of inbox?.value || []) {
    const fromAddr = String(m.from?.emailAddress?.address || '')
    const subj = String(m.subject || '')
    if (!AIRLINES.test(fromAddr) || !TICKET_SUBJECT.test(subj)) continue
    const full = await fetch(`${G}/me/messages/${encodeURIComponent(m.id)}?$select=body`, { headers: gh(token) }).then((r) => r.json()).catch(() => null)
    const text = String(full?.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    const p = parseTicket(text)
    if (!p.pnr || !p.first || !p.last || p.airports.length < 2) continue
    const member = staff.find((s: any) => staffMatch(s.name, p.first!, p.last!))
    if (!member) continue

    const origin = p.airports[0]
    const dest = p.airports[p.airports.length - 1]
    const opening = BR_AIRPORTS.includes(origin) && US_AIRPORTS.includes(dest)
    const closing = US_AIRPORTS.includes(origin) && BR_AIRPORTS.includes(dest)
    if (!opening && !closing) continue

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const flightsLine = p.flights.length ? `✈️ Voos: ${p.flights.join(' + ')} (${origin} → ${dest})` : `✈️ ${origin} → ${dest}`

    if (opening) {
      // next season code: US.<max+1>
      const { data: seasons } = await db.from('seasons').select('season_code')
      const max = (seasons || []).reduce((mx: number, s: any) => Math.max(mx, Number(String(s.season_code || '').replace(/\D/g, '')) || 0), 0)
      const code = `US.${String(max + 1).padStart(3, '0')}`
      const { data: se } = await db.from('seasons').insert({ season_code: code, staff_id: member.id, date_entry: p.arriveDate || p.flightDate || today }).select().single()
      if (se) {
        await db.from('expenses').insert({ season_id: se.id, type: 'SINGLE', amount: p.total, expense_date: today, payment_date: today, description: `Passagem de IDA — ${p.pnr} (${p.last}/${p.first}) ${origin}-${dest}`, source: 'Auto-captura e-mail (staff travel)' })
        await sendStaffWhatsApp([`✈️ *SEASON ABERTA — ${member.name}*`, '', `🎫 *Localizador: ${p.pnr}*`, `👤 Nome: *${p.first}*`, `👤 Sobrenome: *${p.last}*`, '', flightsLine, `🗓 Chegada: ${p.arriveDate || p.flightDate || '—'}`, '', `Bem-vindo(a)! Season ${code} aberta no sistema. 🇺🇸`].join('\n'))
        out.opened.push(`${member.name} ${p.pnr}`)
      }
    } else if (closing) {
      const { data: open } = await db.from('seasons').select('id, season_code').eq('staff_id', member.id).is('date_conclusion', null).order('date_entry', { ascending: false }).limit(1)
      const season = open?.[0]
      if (season) {
        await db.from('expenses').insert({ season_id: season.id, type: 'SINGLE', amount: p.total, expense_date: today, payment_date: today, description: `Passagem de VOLTA — ${p.pnr} (${p.last}/${p.first}) ${origin}-${dest}`, source: 'Auto-captura e-mail (staff travel)' })
        await db.from('seasons').update({ date_conclusion: p.flightDate || today }).eq('id', season.id)
        await sendStaffWhatsApp([`✈️ *PASSAGEM DE VOLTA — ${member.name}*`, '', `🎫 *Localizador: ${p.pnr}*`, `👤 Nome: *${p.first}*`, `👤 Sobrenome: *${p.last}*`, '', flightsLine, `🗓 Voo: ${p.flightDate || '—'}`, '', `A Season ${season.season_code} se encerra com este voo. 👏`, `${member.name.split(' ')[0]}, obrigado DEMAIS pelos serviços prestados nesta temporada. Boa viagem e volte em breve — sua casa te espera! 🙏🇺🇸🇧🇷`].join('\n'))
        out.closed.push(`${member.name} ${p.pnr}`)
      }
    }
    await fileToTrips(token, member.name, m.id)
  }
  return out
}
