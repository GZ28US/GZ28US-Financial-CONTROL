import { NextRequest, NextResponse } from 'next/server'
import { plaid, bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

// POR QUE O FEED DO BANCO EMUDECEU — a pergunta que a rodada não sabia responder.
//
// Em 08/set/2026 a sessão PESCA/AutoBook mediu: `bank_transactions` parou em
// 04/set (última linha inserida em 05/09 22:50), o Zelle de US$ 632,26 que o
// Regions confirmou às 19h12 NÃO estava no feed, e mesmo assim as oito últimas
// rodadas diziam DONE com `errors: []`. De 8 a 31 transações por dia até 04/set,
// depois quatro dias de zero numa conta cujo cartão é usado todo dia.
//
// O código do sync está certo — `/transactions/sync` com cursor, paginando por
// `has_more`, e erro do Plaid VIRA exceção. Se não houve exceção e não veio
// nada, o Plaid está respondendo 200 com `added` vazio, e a causa mora no ITEM,
// não no nosso laço: conexão que precisa de re-autenticação, consentimento
// vencendo, ou instituição fora do ar. Nada disso o `/transactions/sync` conta.
//
// Quem sabe é o `/item/get`, e ninguém estava perguntando. Esta rota pergunta —
// e cruza a resposta do Plaid com o que o DADO diz, porque um sozinho engana:
// o Plaid pode dizer "sem erro" enquanto a instituição simplesmente não manda
// nada há dias ([[nao-achei-onde-procurou]]).
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // Usuário logado OU o cron: quem vigia saúde tem de poder ser chamado por
  // robô também, senão o diagnóstico só existe quando alguém lembra de abrir.
  const cron = (req.headers.get('authorization') || '') === `Bearer ${process.env.CRON_SECRET}`
  if (!cron && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const { data: contas } = await db.from('bank_accounts').select('*')
  const out: any[] = []

  for (const c of contas || []) {
    const nome = c.display_name || c.institution || c.id
    const linha: any = { conta: nome, status: c.status, last_synced_at: c.last_synced_at, tem_cursor: !!c.sync_cursor }

    // ── o que o DADO diz ────────────────────────────────────────────────────
    const { data: ultima } = await db.from('bank_transactions').select('date, created_at').eq('item_id', c.id)
      .order('date', { ascending: false }).limit(1).maybeSingle()
    linha.ultima_transacao = ultima?.date || null
    linha.ultima_insercao = ultima?.created_at || null
    if (ultima?.date) {
      const dias = Math.floor((Date.now() - new Date(ultima.date + 'T12:00:00Z').getTime()) / 86_400_000)
      linha.dias_em_silencio = dias
      // Sete dias sem NADA numa conta de uso diário não é conta parada, é feed
      // cego. O número é conservador de propósito: fim de semana prolongado e
      // feriado cabem dentro dele sem gritar à toa.
      linha.veredito_do_dado = dias >= 7 ? 'CEGO' : dias >= 3 ? 'SUSPEITO' : 'ok'
    }

    // ── o que o PLAID diz ───────────────────────────────────────────────────
    try {
      const it = await plaid('/item/get', { access_token: c.plaid_access_token })
      linha.item_error = it?.item?.error
        ? { code: it.item.error.error_code, msg: String(it.item.error.error_message || '').slice(0, 200) }
        : null
      linha.consent_expira_em = it?.item?.consent_expiration_time || null
      linha.produtos = it?.item?.billed_products || it?.item?.products || null
      // `/item/get` também devolve, por conta, quando o Plaid conseguiu falar com
      // a instituição pela última vez. É o campo que distingue "banco sem
      // movimento" de "Plaid sem conseguir entrar".
      linha.ultima_atualizacao_plaid = it?.status?.transactions?.last_successful_update || null
      linha.ultima_falha_plaid = it?.status?.transactions?.last_failed_update || null
    } catch (e) {
      linha.item_error = { code: 'CHAMADA_FALHOU', msg: String((e as Error).message || e).slice(0, 200) }
    }

    // ── o veredito, em uma frase ────────────────────────────────────────────
    linha.diagnostico = linha.item_error
      ? `Plaid acusa ${linha.item_error.code} — a conexão precisa de conserto, e re-autenticar é ação do dono da conta`
      : linha.veredito_do_dado === 'CEGO'
        ? 'Plaid não acusa erro, mas o feed está mudo há uma semana — comparar `ultima_atualizacao_plaid` com o extrato de verdade'
        : linha.veredito_do_dado === 'SUSPEITO'
          ? 'alguns dias sem linha nova; pode ser normal, olhar de novo amanhã'
          : 'saudável'
    out.push(linha)
  }
  return NextResponse.json({ at: new Date().toISOString(), contas: out })
}
