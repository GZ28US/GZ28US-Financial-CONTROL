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

    // ── ?probe=1 — A SONDA QUE SEPARA AS DUAS ÚLTIMAS HIPÓTESES ─────────────
    // Com o item são (08/set: `last_successful_update` de hoje 04h46, sem erro
    // nenhum), sobraram duas explicações para o feed mudo, e elas pedem consertos
    // opostos:
    //   (a) o Plaid não TEM o que mandar — o Regions é que não postou; ou
    //   (b) o Plaid tem e a nossa ingestão perde — cursor parado, escrita falhando.
    // Uma chamada de `/transactions/sync` com o cursor ATUAL responde: se vier
    // vazio com `has_more:false`, é (a); se vier com linhas, é (b) e o defeito
    // está no nosso laço.
    //
    // NÃO GRAVA NADA — nem transação, nem cursor. O cursor do Plaid só avança
    // quando a gente SALVA o `next_cursor`, e aqui ele é descartado de propósito:
    // sonda que muda o estado que está medindo não é sonda ([[nao-achei-onde-procurou]]).
    if (req.nextUrl.searchParams.get('probe') === '1' && !linha.item_error) {
      try {
        const s = await plaid('/transactions/sync', { access_token: c.plaid_access_token, cursor: c.sync_cursor || undefined, count: 250 })
        const novas = (s.added || []).length
        linha.sonda = {
          added: novas, modified: (s.modified || []).length, removed: (s.removed || []).length,
          has_more: !!s.has_more,
          cursor_mudou: !!s.next_cursor && s.next_cursor !== c.sync_cursor,
          amostra: (s.added || []).slice(0, 3).map((t: any) => `${t.date} ${t.amount} ${String(t.name || '').slice(0, 40)}`),
          veredito: novas > 0
            ? 'O PLAID TEM E NÓS PERDEMOS — o defeito está na nossa ingestão, não na conexão'
            : s.has_more
              ? 'sem linhas nesta página mas o Plaid diz que há mais — paginação'
              : 'nada novo DESDE O CURSOR — falta saber se o Plaid nunca teve ou se o cursor já passou por cima',
        }

        // O CURSOR NÃO SEPARA AS DUAS HISTÓRIAS (ressalva da sessão PESCA/AutoBook,
        // e ela está certa). "Nada novo desde o cursor" tanto vale para "o banco
        // não postou" quanto para "uma rodada consumiu a página, a escrita falhou
        // e o next_cursor foi salvo assim mesmo" — cursor avançado sobre dado
        // perdido responde IGUALZINHO a banco parado. A sonda pergunta a partir
        // do ponto onde o estrago terminou.
        //
        // Quem separa é a JANELA: `/transactions/get` por intervalo de datas não
        // usa cursor nenhum. Se o Plaid devolver transação depois da última que
        // temos, ele tinha e nós perdemos; se devolver nada, o banco não postou.
        // Uma chamada, sem gravar nada, e responde no mesmo clique.
        if (novas === 0 && !s.has_more && linha.ultima_transacao) {
          try {
            const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
            const g = await plaid('/transactions/get', {
              access_token: c.plaid_access_token,
              start_date: linha.ultima_transacao, end_date: hoje,
              options: { count: 100, offset: 0 },
            })
            const depois = (g.transactions || []).filter((t: any) => String(t.date) > String(linha.ultima_transacao))
            linha.sonda.janela = {
              de: linha.ultima_transacao, ate: hoje,
              total_no_intervalo: (g.transactions || []).length,
              depois_da_ultima_que_temos: depois.length,
              amostra: depois.slice(0, 5).map((t: any) => `${t.date} ${t.amount} ${String(t.name || '').slice(0, 40)}`),
              veredito: depois.length > 0
                ? 'O PLAID TEM E NÓS PERDEMOS — o cursor passou por cima; conserto é NOSSO, no laço do sync'
                : 'o Plaid também não tem nada no intervalo — o banco não postou, e o dono do problema é o Regions',
            }
          } catch (e) {
            linha.sonda.janela = { erro: String((e as Error).message || e).slice(0, 200) }
          }
        }
      } catch (e) {
        linha.sonda = { erro: String((e as Error).message || e).slice(0, 200) }
      }
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
