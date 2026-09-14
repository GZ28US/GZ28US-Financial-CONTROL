import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { bancosDoServidor, ErroTravessia, sincronizar } from '@/lib/crossing.server'

// ── O CRON DA TRAVESSIA US ⇄ BR (14/set/2026) ─────────────────────────────────
// A lei sagrada de 13/set diz que TODO dinheiro que cruza as empresas vira shopping invoice no app do
// outro — e metade do app não passa por tela nenhuma: o AutoBook, o Bank Link, a folha, os assets e
// qualquer PATCH direto no banco escrevem PAID FROM/TO sem abrir editor. Os editores chamam o motor
// na hora (só a chave da invoice salva); este cron é a rede de segurança para todo o resto.
//
// DE HORA EM HORA (vercel.json, minuto 47 — longe do :00 do auto-book, do :23 do invoice-receipts e do
// :37 do items/track), EM LOTES: no máximo LOTE chaves com escrita por rodada e nenhuma chave nova
// começa depois de LIMITE_MS — a chave que já começou termina (a maior, US.001.1, tem ~110 escritas),
// então a rodada cabe nos 300 s da Vercel com folga. O que sobra (`restantes`) fica para a hora seguinte.
//
// IDEMPOTENTE: o motor acha o que já gravou por invoices.mirror_key e mirror_src. Rodada sem nada a
// fazer não escreve nada — nem trilha. Toda escrita deixa a sua linha em data_fixes
// (check_key 'shopping-invoice-travessia') no banco onde aconteceu; é o motor que grava, não o cron.
//
// FALHA FECHADA, SEM TRAVAR O CRON (revisão 14/set/2026): chave que erra por CONFLITO (a origem mudou desde
// o plano, elo já em outra linha, trava de outra rodada) para só ela — as outras seguem e a próxima hora
// refaz o plano. Erro de BANCO (rede, permissão, trilha que não gravou) para a rodada inteira. O motivo sai
// na resposta e no log da Vercel. Chave em CONFLITO no plano (as travas do dono) nunca grava.
//
// TRAVESSIA_PAUSADA=1 no ambiente segura as escritas (o cron só conta o que faria).
//
// Portão: o cron da Vercel (Authorization: Bearer CRON_SECRET) ou a chave de leitura no header
// x-read-key, para a rodada humana. As duas comparações falham fechadas.

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const LOTE = 15
const LIMITE_MS = 200_000

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const bancos = bancosDoServidor()
  if ('erro' in bancos) return NextResponse.json({ ok: false, kind: 'service-key', error: bancos.erro }, { status: 503 })
  try {
    const r = await sincronizar(bancos, { limiteMs: LIMITE_MS, maxChaves: LOTE, origem: 'cron' })
    const gravadas = r.chaves.filter(c => c.escritas > 0)
    const erros = r.chaves.filter(c => c.resultado === 'erro')
    for (const e of erros) console.error(`[cron crossing] ${e.erro_tipo === 'banco' ? 'PAROU' : 'pulou'} em`, e.mirror_key, '—', e.motivo)
    return NextResponse.json({
      ok: r.ok,
      pausada: r.pausada,
      tempo_ms: r.tempo_ms,
      chaves_aplicadas: r.chaves.filter(c => c.resultado === 'aplicada').length,
      chaves_com_conflito_na_escrita: erros.filter(e => e.erro_tipo === 'conflito').length,
      escritas: gravadas.reduce((s, c) => s + c.escritas, 0),
      conflitos_no_plano: r.conflitos,
      restantes: r.restantes,
      parou_por: r.parou_por,
      parou_em: r.parou_em,
      chaves: r.chaves,
    }, { status: r.ok ? 200 : 502 })
  } catch (e) {
    const kind = e instanceof ErroTravessia ? e.kind : 'db'
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[cron crossing]', kind, msg)
    return NextResponse.json({ ok: false, kind, error: msg }, { status: kind === 'schema' ? 409 : 502 })
  }
}
