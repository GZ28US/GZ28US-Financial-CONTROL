import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// BOAS-VINDAS DA PASSAGEM (Márcio, 27/ago/2026: "foi comprada a passagem, tem
// que ter msg de boas-vindas pro membro no Staff, passando todos os dados da
// passagem dele, em especial o localizador da companhia aérea").
//
// GET  ?flightId=…           -> devolve o texto SEM mandar (a tela mostra antes)
// POST { flightId, force? }  -> manda pro WhatsApp do membro e carimba a data
//
// Em português de propósito: mensagem para STAFF é em português, mesma regra dos
// duties. O app é em inglês; quem lê isto não é o app, é a pessoa.
export const maxDuration = 30

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

// Horário de voo é LOCAL do aeroporto e nunca se converte: a saída é 12:25 em
// Campinas e a chegada 20:30 em Orlando. Por isso lemos a string do banco letra
// por letra, sem deixar o Date deslocar nada.
function quando(local: string | null | undefined): { data: string; hora: string; dia: string } | null {
  const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  return { data: `${d}/${mo}/${y}`, hora: `${h}:${mi}`, dia: DIAS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()] }
}

const ondeFica = (cidade: string | null, sigla: string | null) =>
  [cidade, sigla ? `(${sigla})` : ''].filter(Boolean).join(' ').trim()

type Flight = {
  id: string; staff_id: string; direction: string | null
  locator: string | null; booking_ref: string | null
  airline: string | null; flight_number: string | null; operated_by: string | null
  from_airport: string | null; from_city: string | null
  to_airport: string | null; to_city: string | null
  departure_local: string | null; arrival_local: string | null
  duration_minutes: number | null; baggage_included: boolean | null
  expense_id: string | null; welcome_sent_at: string | null
}

export function buildWelcome(f: Flight, nome: string): string {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || ''
  const ida = f.direction !== 'OUTBOUND'
  const saida = quando(f.departure_local)
  const chegada = quando(f.arrival_local)
  const L: string[] = []

  L.push(ida
    ? `✈️ *BEM-VINDO À GZ28 V8 SPEEDSHOP${primeiro ? `, ${primeiro.toUpperCase()}` : ''}!*`
    : `✈️ *SUA VOLTA ESTÁ MARCADA${primeiro ? `, ${primeiro.toUpperCase()}` : ''}*`)
  L.push('')
  L.push(ida
    ? 'Sua passagem está *comprada e paga*. Guarde estes dados — o localizador é o que vale no balcão da companhia:'
    : 'Sua passagem de volta está *comprada e paga*. Os dados:')

  // O localizador vem primeiro e sozinho: é o que a pessoa precisa no balcão.
  if (f.locator) { L.push(''); L.push(`*LOCALIZADOR (check-in): ${f.locator}*`) }

  const voo = [f.airline, f.flight_number].filter(Boolean).join(' ')
  if (voo || saida) {
    L.push(''); L.push('*VOO*')
    if (voo) L.push(f.operated_by ? `${voo} — operado por ${f.operated_by}` : voo)
    if (saida) L.push(`${saida.dia}, ${saida.data}`)
  }

  if (saida || chegada) {
    L.push('')
    if (saida) L.push(`*SAÍDA* — ${ondeFica(f.from_city, f.from_airport) || '—'} às ${saida.hora}`)
    if (chegada) L.push(`*CHEGADA* — ${ondeFica(f.to_city, f.to_airport) || '—'} às ${chegada.hora}`)
    const extras: string[] = []
    if (f.duration_minutes) extras.push(`duração ${Math.floor(f.duration_minutes / 60)}h${String(f.duration_minutes % 60).padStart(2, '0')}`)
    extras.push(ida ? 'só ida' : 'volta')
    L.push(extras.join(' · '))
    L.push('_Os horários são os do relógio local de cada aeroporto._')
  }

  // Bagagem só aparece quando a resposta é conhecida — e quando NÃO está inclusa
  // vira aviso, porque é a surpresa que estraga um embarque.
  if (f.baggage_included === false) {
    L.push(''); L.push('*BAGAGEM*')
    L.push('⚠️ Esta tarifa *não inclui bagagem despachada*.')
  } else if (f.baggage_included === true) {
    L.push(''); L.push('*BAGAGEM* — despachada inclusa.')
  }

  L.push(''); L.push('Qualquer dúvida, é só responder aqui.')
  L.push(''); L.push('— *Claudinha* 👩🏻‍💻')
  return L.join('\n')
}

type Membro = { name: string; phone: string | null; staff_code: string | null }

async function carregar(db: ReturnType<typeof bankDb>, flightId: string) {
  const { data: f } = await db.from('staff_flights').select('*').eq('id', flightId).maybeSingle()
  if (!f) return { erro: 'passagem não encontrada' as const }
  const { data: st } = await db.from('staff').select('name, phone, staff_code').eq('id', f.staff_id).maybeSingle()
  if (!st) return { erro: 'membro não encontrado' as const }
  return { f: f as Flight, st: st as Membro }
}

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const flightId = req.nextUrl.searchParams.get('flightId') || ''
  if (!flightId) return NextResponse.json({ error: 'flightId obrigatório' }, { status: 400 })
  const r = await carregar(bankDb(), flightId)
  if ('erro' in r) return NextResponse.json({ error: r.erro }, { status: 404 })
  return NextResponse.json({
    ok: true, to: r.st.phone, name: r.st.name,
    already_sent_at: r.f.welcome_sent_at,
    body: buildWelcome(r.f, r.st.name),
  })
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const flightId = String(b.flightId || '')
  if (!flightId) return NextResponse.json({ error: 'flightId obrigatório' }, { status: 400 })

  const db = bankDb()
  const r = await carregar(db, flightId)
  if ('erro' in r) return NextResponse.json({ error: r.erro }, { status: 404 })
  // Ninguém recebe a mesma boas-vindas duas vezes por acidente.
  if (r.f.welcome_sent_at && !b.force) {
    return NextResponse.json({ error: 'boas-vindas já enviada', sent_at: r.f.welcome_sent_at }, { status: 409 })
  }
  const fone = String(r.st.phone || '').replace(/\D/g, '')
  if (!fone) return NextResponse.json({ error: `${r.st.name} está sem telefone no cadastro` }, { status: 400 })

  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return NextResponse.json({ error: 'WhatsApp não configurado' }, { status: 500 })

  const body = buildWelcome(r.f, r.st.name)
  const res = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, to: `${fone}@c.us`, body }),
  })
  const out = await res.json().catch(() => ({}))
  // 'sent: true' da UltraMsg não prova entrega — por isso devolvemos a resposta crua.
  if (!res.ok || String(out?.sent) !== 'true') {
    return NextResponse.json({ error: 'UltraMsg recusou', detail: out }, { status: 502 })
  }
  const stamp = new Date().toISOString()
  await db.from('staff_flights').update({ welcome_sent_at: stamp, updated_at: stamp }).eq('id', flightId)
  return NextResponse.json({ ok: true, to: fone, sent_at: stamp, body })
}
