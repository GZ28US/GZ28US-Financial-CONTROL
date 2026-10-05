import { NextRequest, NextResponse } from 'next/server'
import { requireUser, cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { ensureRideMailFolders, type RideMailCar } from '@/lib/rideMailFolders.server'

// A PASTA DE E-MAIL DO CARRO É SAGRADA (Márcio, 05/out/2026): «all the folders there must be 100% synced with the app».
// Esta rota confere a frota inteira contra as caixas 1, 2 e 4 e cria / renomeia o que falta (lib/rideMailFolders.server.ts).
//   GET  ?dryRun=1   → só o plano: o que criaria, o que renomearia, conflitos, pastas fora do lugar e sobras. Nada é escrito.
//   GET  (cron)      → aplica. Roda de hora em hora (vercel.json): é a rede que fecha QUALQUER caminho que faça um carro
//                      existir sem passar pelo gancho — quote promovida por renumeração, carro criado por outra tela.
//   POST { code, name, prev? } → garante a pasta de UM carro (chamado pelo ride-folder e pelo renumber).
// Carros = rides de origem PROJECT que não são quote (US / SC / WV / PO). Quote e SHP ficam fora até ele decidir.
// Nunca apaga pasta nem move mensagem.

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function frota(): Promise<RideMailCar[]> {
  const { data, error } = await streamDb().from('rides').select('project_code, project_name, origin, is_quote').or('origin.is.null,origin.neq.SHOP').or('is_quote.is.null,is_quote.eq.false')
  if (error) throw new Error('rides: ' + error.message)
  return (data || []).filter(r => r.project_code).map(r => ({ code: String(r.project_code), name: String(r.project_name || '') }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    const cars = await frota()
    const slots = await ensureRideMailFolders(streamDb(), cars, { dryRun, audit: true })
    const falhou = slots.some(s => s.errors.length)
    return NextResponse.json({ ok: !falhou, dryRun, cars: cars.length, slots }, { status: falhou ? 502 : 200 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const code = String(b.code || '').trim(), name = String(b.name || '').trim()
  if (!code) return NextResponse.json({ error: 'code obrigatório' }, { status: 400 })
  const prev = b.prev && typeof b.prev === 'object' ? { code: b.prev.code ? String(b.prev.code) : undefined, name: b.prev.name != null ? String(b.prev.name) : undefined } : undefined
  const slots = await ensureRideMailFolders(streamDb(), [{ code, name, prev }], { dryRun: !!b.dryRun })
  return NextResponse.json({ ok: !slots.some(s => s.errors.length), slots })
}
