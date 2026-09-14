import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { applyPlan, bancosDoServidor, chaveDaInvoice, ErroTravessia, planCrossings, resumoAlvo, sincronizar, type Banco, type OrigemSincronia } from '@/lib/crossing.server'

// ── A TRAVESSIA US ⇄ BR (14/set/2026) ────────────────────────────────────────
// Toda movimentação de dinheiro entre GZ28US e GZ28BR vira shopping invoice no app do OUTRO
// (lei sagrada de 13/set; a regra inteira mora em lib/crossing.server.ts).
//
//   GET  → o PLANO (dry run): o diff por mirror_key, os excluídos com motivo, a correção da
//          classe (b) proposta à parte e a manchete «quanto o BR deve ao US» antes e depois.
//          Não escreve nada.
//   POST { confirm: true, impressoes: { [mirror_key]: impressao }, keys? }
//        → a aplicação CONFERIDA: refaz o plano na hora e só grava as chaves QUE ESTÃO em impressoes,
//          cada uma só se a impressão digital bate com a do GET que alguém leu ({} = nada). Passa por
//          cima de TRAVESSIA_PAUSADA. Sem confirm:true, 400 e nada escrito.
//   POST { confirm: true, keys?: string[], origem?: 'manual' | 'cron' | 'editor' }
//        → sincronizar(): planeja uma vez e grava. Sem origem vale 'editor' (obedece a pausa).
//   POST { confirm: true, invoice: { banco: 'US'|'BR', id }, origem: 'editor' }
//        → O GANCHO DOS EDITORES (14/set): a chave é lida do BANCO pela invoice (o navegador só diz
//          qual invoice) e só ela é gravada; a resposta traz o resumo da shopping invoice-alvo.
//          O editor do BR chega aqui servidor a servidor (/api/invoice/crossing do BR, header x-read-key).
//   Todo POST sem impressoes tem relógio: não começa chave nova depois de 240 s (maxDuration 300) —
//   `restantes` diz quanto ficou para a próxima chamada ou para o cron (/api/cron/crossing).
//
// Portão: tela logada (requireUser), a Vercel (cronOk) ou servidor/script com a chave de leitura
// no header (readKeyOk).

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const LIMITE_MS = 240_000

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
  let keys = Array.isArray(body.keys) ? body.keys.map((k: unknown) => String(k)).filter(Boolean) : undefined
  const impressoes = body.impressoes && typeof body.impressoes === 'object' ? Object.fromEntries(Object.entries(body.impressoes).map(([k, v]) => [k, String(v)])) : undefined
  // TRAVESSIA_PAUSADA (revisão 14/set/2026): só a chamada EXPLICITAMENTE manual — com impressoes, ou com
  // origem: 'manual' — passa por cima da pausa. Sem origem, vale 'editor', que obedece.
  const origem: OrigemSincronia = impressoes || body.origem === 'manual' ? 'manual' : body.origem === 'cron' ? 'cron' : 'editor'
  const bancos = bancosDoServidor()
  if ('erro' in bancos) return falha(503, 'service-key', bancos.erro)
  try {
    // A aplicação conferida contra um GET lido por alguém: só as chaves que estão em `impressoes` gravam
    // ({} = nada), com o mesmo relógio de 240 s.
    if (impressoes) {
      const plano = await planCrossings(bancos)
      const resultado = await applyPlan(bancos, plano, { confirm: true, keys, impressoes, limiteMs: LIMITE_MS })
      return NextResponse.json({ ok: resultado.ok, resultado }, { status: resultado.ok ? 200 : 502 })
    }
    // O gancho do editor: a chave sai do banco, pela invoice.
    let chave: string | null = null
    if (body.invoice) {
      const banco = String(body.invoice?.banco || '').toUpperCase()
      const id = String(body.invoice?.id || '').trim()
      if (banco !== 'US' && banco !== 'BR') return falha(400, 'bad-request', 'invoice.banco tem de ser US ou BR.')
      const r = await chaveDaInvoice(bancos, banco as Banco, id)
      if (!r.key) return NextResponse.json({ ok: true, chave: null, motivo: r.motivo, resultado: null, resumo: null })
      chave = r.key
      keys = [r.key]
    }
    const resultado = await sincronizar(bancos, { keys, limiteMs: LIMITE_MS, origem })
    const escreveu = resultado.chaves.some(c => c.escritas > 0)
    // O resumo só serve ao editor (uma chave); leitura que falha não desfaz o que já foi gravado.
    const resumo = chave ? await resumoAlvo(bancos, chave).catch(() => null) : null
    return NextResponse.json({ ok: resultado.ok, chave, escreveu, resultado, resumo }, { status: resultado.ok ? 200 : 502 })
  } catch (e) {
    return responderErro(e)
  }
}
