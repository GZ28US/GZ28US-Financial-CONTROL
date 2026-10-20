import { NextRequest, NextResponse } from 'next/server'
import { requireUser, cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { streamDb } from '@/lib/stream.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { empresaDoCodigo, type Empresa } from '@/lib/rideMailFolders.server'
import { ROOTS, sanitize, nomeNu, dbx, dbxAccessToken, ensureSubfolders } from '@/lib/dropboxRides.server'

// A PASTA DO CARRO NO DROPBOX EXISTE (20/10/2026) — o gêmeo do /api/rides/mail-folders, pedido no RECADO de 10/10 da sessão Pastas
// dos Carros: quote promovida a carro (US.QT.017 → US.047) nascia sem pasta, e NENHUM cron conferia pasta de Dropbox. O único gancho que
// cria é o fetch do navegador em /rides/new, cujo único aviso de falha é um alert().
//   • frota do US = rides do banco US, sem SHOP e sem quote → «/001 - GZ28US/GZ28US Rides»;
//   • frota do BR = rides do banco BR, sem quote            → «/000 - GZ28BR/GZ28BR Rides». A empresa do carro é o CÓDIGO.
// Para cada carro: pasta cujo nome é o código, ou começa por «<código> » → existe (só garante as subpastas). Sem ela:
//   • pasta de NÚMERO LEGADO com o mesmo NOME do carro («377 - HellDog…») → NÃO cria: é a pasta dele com número velho
//     ([[pastas-rides-numero-legado]]); entra no relatório como `legado`, para gente decidir;
//   • nada → CRIA «<código> - <nome>» + subpastas (ensureSubfolders).
//   GET ?dryRun=1[&zone=US|BR] → só o plano. GET (cron) → aplica. POST { code, name } → um carro só. Nunca apaga nem move pasta.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Car = { code: string; name: string }
type Relatorio = { zone: Empresa; frota: number; ok: number; criadas: string[]; legado: { carro: string; pasta: string }[]; erros: string[] }

async function frota(empresa: Empresa): Promise<Car[]> {
  const cars: Car[] = []
  if (empresa === 'US') {
    const { data, error } = await streamDb().from('rides').select('project_code, project_name, origin, is_quote').or('origin.is.null,origin.neq.SHOP').or('is_quote.is.null,is_quote.eq.false')
    if (error) throw new Error('rides (US): ' + error.message)
    for (const r of data || []) if (r.project_code) cars.push({ code: String(r.project_code), name: String(r.project_name || '') })
  } else {
    const br = supabaseBRService()
    if (!br) throw new Error('rides (BR): sem a service key do banco do BR neste ambiente')
    const { data, error } = await br.from('rides').select('project_code, project_name, is_quote').or('is_quote.is.null,is_quote.eq.false').range(0, 4999)
    if (error) throw new Error('rides (BR): ' + error.message)
    for (const r of data || []) if (r.project_code) cars.push({ code: String(r.project_code), name: String(r.project_name || '') })
  }
  return cars.filter(c => empresaDoCodigo(c.code) === empresa && !/^(US|BR)\.QT\./.test(c.code)).sort((a, b) => a.code.localeCompare(b.code))
}

async function pastasDaRaiz(token: string, root: string): Promise<string[]> {
  const nomes: string[] = []
  let cursor: string | null = null
  do {
    const r = cursor ? await dbx(token, 'files/list_folder/continue', { cursor }) : await dbx(token, 'files/list_folder', { path: root, recursive: false, limit: 2000 })
    if (!r.ok) throw new Error('list_folder ' + root + ': ' + r.text.slice(0, 200))
    for (const e of r.data.entries || []) if (e['.tag'] === 'folder') nomes.push(String(e.name))
    cursor = r.data.has_more ? r.data.cursor : null
  } while (cursor)
  return nomes
}

async function garantir(token: string, zone: Empresa, cars: Car[], aplicar: boolean): Promise<Relatorio> {
  const root = ROOTS[zone]
  const rel: Relatorio = { zone, frota: cars.length, ok: 0, criadas: [], legado: [], erros: [] }
  const nomes = await pastasDaRaiz(token, root)
  for (const c of cars) {
    const code = sanitize(c.code)
    const dele = nomes.find(n => n === code || n.startsWith(code + ' '))
    if (dele) { rel.ok++; continue }
    // número legado: «377 - HellDog MPVI2 455» — o NOME depois do primeiro « - » bate com o nome do carro
    const alvoNome = nomeNu(c.name)
    const legado = alvoNome.length >= 3 ? nomes.find(n => { const i = n.indexOf(' - '); return i > 0 && nomeNu(n.slice(i + 3)).startsWith(alvoNome) }) : undefined
    if (legado) { rel.legado.push({ carro: `${c.code} - ${c.name}`, pasta: legado }); continue }
    const alvo = sanitize(`${c.code}${c.name ? ' - ' + c.name : ''}`)
    if (!aplicar) { rel.criadas.push(alvo); continue }
    const r = await dbx(token, 'files/create_folder_v2', { path: `${root}/${alvo}`, autorename: false })
    if (!r.ok && !r.text.includes('conflict')) { rel.erros.push(`${alvo}: ${r.text.slice(0, 160)}`); continue }
    await ensureSubfolders(token, `${root}/${alvo}`)
    rel.criadas.push(alvo); nomes.push(alvo)
  }
  return rel
}

async function porta(req: NextRequest) { return cronOk(req) || readKeyOk(req) || (await requireUser(req)) }

export async function GET(req: NextRequest) {
  if (!(await porta(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const z = (req.nextUrl.searchParams.get('zone') || '').toUpperCase()
  const zonas: Empresa[] = z === 'US' ? ['US'] : z === 'BR' ? ['BR'] : ['US', 'BR']
  try {
    const token = await dbxAccessToken()
    const out: Relatorio[] = []
    for (const zone of zonas) {
      try { out.push(await garantir(token, zone, await frota(zone), !dryRun)) }
      catch (e) { out.push({ zone, frota: 0, ok: 0, criadas: [], legado: [], erros: [String((e as Error)?.message || e).slice(0, 300)] }) }
    }
    if (out.some(r => r.criadas.length || r.erros.length)) console.log('[dropbox-folders]', JSON.stringify(out.map(r => ({ zone: r.zone, criadas: r.criadas, erros: r.erros }))))
    return NextResponse.json({ ok: out.every(r => !r.erros.length), dryRun, zonas: out })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await porta(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))
  const code = String(b?.code || '').trim(), name = String(b?.name || '').trim()
  if (!code) return NextResponse.json({ error: 'code obrigatório' }, { status: 400 })
  if (/^(US|BR)\.QT\./.test(code)) return NextResponse.json({ ok: true, result: 'quote não tem pasta' })
  try {
    const token = await dbxAccessToken()
    return NextResponse.json({ ok: true, ...(await garantir(token, empresaDoCodigo(code) as Empresa, [{ code, name }], true)) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, { status: 500 })
  }
}
