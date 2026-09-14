import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { applyPlan, bancosDoServidor, ErroTravessia, planCrossings } from '@/lib/crossing.server'

// ── A TRAVESSIA US ⇄ BR (14/set/2026) ────────────────────────────────────────
// Toda movimentação de dinheiro entre GZ28US e GZ28BR vira shopping invoice no app do OUTRO
// (lei sagrada de 13/set; a regra inteira mora em lib/crossing.server.ts).
//
//   GET  → o PLANO (dry run): o diff por mirror_key, os excluídos com motivo, a correção da
//          classe (b) proposta à parte e a manchete «quanto o BR deve ao US» antes e depois.
//          Não escreve nada.
//   POST { confirm: true, keys?: string[], impressoes?: { [mirror_key]: impressao } }
//        → grava. Refaz o plano na hora e só grava a chave cuja impressão digital bate
//          (com a do GET, se `impressoes` vier). Sem confirm:true, 400 e nada escrito.
//
// Portão: tela logada (requireUser), a Vercel (cronOk) ou sessão/script com a chave de leitura
// no header (readKeyOk). AINDA NÃO está em cron nem em editor nenhum.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const falha = (status: number, kind: string, error: string) => NextResponse.json({ ok: false, kind, error }, { status })
const STATUS: Record<ErroTravessia['kind'], number> = { 'bad-request': 400, 'service-key': 503, schema: 409, conflict: 409, db: 502, rate: 422 }

async function portao(req: NextRequest): Promise<boolean> {
  if (cronOk(req) || readKeyOk(req)) return true
  return requireUser(req)
}

function responderErro(e: unknown) {
  if (e instanceof ErroTravessia) return falha(STATUS[e.kind], e.kind, e.message)
  return falha(502, 'db', e instanceof Error ? e.message : String(e))
}

export async function GET(req: NextRequest) {
  if (!(await portao(req))) return falha(401, 'auth', 'unauthorized')
  const bancos = bancosDoServidor()
  if ('erro' in bancos) return falha(503, 'service-key', bancos.erro)
  try {
    const plano = await planCrossings(bancos)
    return NextResponse.json({ ok: true, plano })
  } catch (e) {
    return responderErro(e)
  }
}

export async function POST(req: NextRequest) {
  if (!(await portao(req))) return falha(401, 'auth', 'unauthorized')
  const body = await req.json().catch(() => null)
  if (!body || body.confirm !== true) return falha(400, 'bad-request', 'POST grava — mande { confirm: true }. Para só ver o plano, use GET.')
  const keys = Array.isArray(body.keys) ? body.keys.map((k: unknown) => String(k)).filter(Boolean) : undefined
  const impressoes = body.impressoes && typeof body.impressoes === 'object' ? Object.fromEntries(Object.entries(body.impressoes).map(([k, v]) => [k, String(v)])) : undefined
  const bancos = bancosDoServidor()
  if ('erro' in bancos) return falha(503, 'service-key', bancos.erro)
  try {
    const plano = await planCrossings(bancos)
    const resultado = await applyPlan(bancos, plano, { confirm: true, keys, impressoes })
    return NextResponse.json({ ok: resultado.ok, resultado }, { status: resultado.ok ? 200 : 502 })
  } catch (e) {
    return responderErro(e)
  }
}
