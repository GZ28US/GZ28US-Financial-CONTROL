import { NextRequest, NextResponse } from 'next/server'
import { requireUser, cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { ensureRideMailFolders, repatriateRideMail, empresaDoCodigo, CAIXAS_DA_EMPRESA, type RideMailCar, type Empresa, type EnsureSlotReport } from '@/lib/rideMailFolders.server'

// A PASTA DE E-MAIL DO CARRO É SAGRADA (Márcio, 05/out/2026): «all the folders there must be 100% synced with the app».
// E CADA CAIXA SÓ CARREGA OS CARROS DA SUA EMPRESA (ele, no mesmo dia): «gz28 both hotmail and gmais should have US cars /
// galpaoz28 and gz28br should have BR cars / all by the app».
//   • frota do US = `rides` do banco US, sem SHOP e sem quote (US · SC · WV · PO)  → caixas 1 e 4;
//   • frota do BR = `rides` do banco BR, sem quote, códigos BR · GM                 → caixas 2 e 3.
// A empresa do carro é o CÓDIGO: US.004 ShakeDown também tem linha no banco do BR e continua sendo carro do US.
//   GET  ?dryRun=1[&company=us|br] → só o plano: o que criaria, renomearia, conflitos, pastas fora do lugar, sobras
//                                    (`extras`) e pastas de carro da OUTRA empresa (`foreign`). Nada é escrito.
//   GET  (cron)                    → aplica. Roda de hora em hora (vercel.json): é a rede que fecha QUALQUER caminho que
//                                    faça um carro existir sem passar pelo gancho — inclusive carro criado no app do BR.
//   POST { code, name, prev? }     → garante a pasta de UM carro, nas caixas da empresa dele.
// Nunca apaga pasta nem move mensagem.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function frota(empresa: Empresa): Promise<RideMailCar[]> {
  const cars: RideMailCar[] = []
  if (empresa === 'US') {
    const { data, error } = await streamDb().from('rides').select('project_code, project_name, origin, is_quote').or('origin.is.null,origin.neq.SHOP').or('is_quote.is.null,is_quote.eq.false')
    if (error) throw new Error('rides (US): ' + error.message)
    for (const r of data || []) if (r.project_code) cars.push({ code: String(r.project_code), name: String(r.project_name || '') })
  } else {
    // Sem a chave do BR não se sabe a frota — e frota desconhecida não é frota vazia: a metade do BR falha, alto.
    const br = supabaseBRService()
    if (!br) throw new Error('rides (BR): sem a service key do banco do BR neste ambiente')
    const { data, error } = await br.from('rides').select('project_code, project_name, is_quote').or('is_quote.is.null,is_quote.eq.false').range(0, 4999)
    if (error) throw new Error('rides (BR): ' + error.message)
    for (const r of data || []) if (r.project_code) cars.push({ code: String(r.project_code), name: String(r.project_name || '') })
  }
  // O código manda: carro do US espelhado no banco do BR não entra na frota do BR (e vice-versa). Quote nunca tem pasta.
  return cars.filter(c => empresaDoCodigo(c.code) === empresa && !/^(US|BR)\.QT\./.test(c.code)).sort((a, b) => a.code.localeCompare(b.code))
}

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const qual = (req.nextUrl.searchParams.get('company') || '').toUpperCase()
  const empresas: Empresa[] = qual === 'US' || qual === 'BR' ? [qual] : ['US', 'BR']
  // Uma empresa não derruba a outra: banco do BR fora do ar não pode parar a conferência das caixas do US.
  const partes = await Promise.all(empresas.map(async empresa => {
    try {
      const cars = await frota(empresa)
      const slots = await ensureRideMailFolders(streamDb(), cars, { dryRun, audit: true, slots: CAIXAS_DA_EMPRESA[empresa] })
      return { empresa, cars: cars.length, slots, error: '' }
    } catch (e) {
      return { empresa, cars: 0, slots: [] as EnsureSlotReport[], error: String((e as Error)?.message || e).slice(0, 300) }
    }
  }))
  const slots = partes.flatMap(p => p.slots)
  const erros = partes.filter(p => p.error).map(p => `${p.empresa}: ${p.error}`)
  const falhou = erros.length > 0 || slots.some(s => s.errors.length)
  return NextResponse.json({ ok: !falhou, dryRun, cars: Object.fromEntries(partes.map(p => [p.empresa, p.cars])), errors: erros, slots }, { status: falhou ? 502 : 200 })
}

export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  // { action: 'repatriate', dryRun?, folder?, limit? } — e-mail de carro que está na caixa da OUTRA empresa volta para casa
  // (Márcio, 05/out/2026: «Remove empty, move the mail»). Cópia conferida no destino, original para o Arquivo morto da
  // origem, casca vazia removida; nada é apagado. Só roda por este pedido explícito — o cron (GET) nunca faz isto.
  if (b.action === 'repatriate') {
    try {
      const [us, br] = await Promise.all([frota('US'), frota('BR')])
      const folders = await repatriateRideMail(streamDb(), { US: us, BR: br }, { dryRun: !!b.dryRun, folder: b.folder ? String(b.folder) : undefined, limit: Number(b.limit) || undefined })
      return NextResponse.json({ ok: !folders.some(f => f.failed.length), dryRun: !!b.dryRun, folders })
    } catch (e) {
      return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, { status: 500 })
    }
  }
  const code = String(b.code || '').trim(), name = String(b.name || '').trim()
  if (!code) return NextResponse.json({ error: 'code obrigatório' }, { status: 400 })
  if (/^(US|BR)\.QT\./.test(code)) return NextResponse.json({ ok: true, result: 'quote não tem pasta de e-mail', slots: [] })
  const prev = b.prev && typeof b.prev === 'object' ? { code: b.prev.code ? String(b.prev.code) : undefined, name: b.prev.name != null ? String(b.prev.name) : undefined } : undefined
  const slots = await ensureRideMailFolders(streamDb(), [{ code, name, prev }], { dryRun: !!b.dryRun })
  return NextResponse.json({ ok: !slots.some(s => s.errors.length), company: empresaDoCodigo(code), slots })
}
