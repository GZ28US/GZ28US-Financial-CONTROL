import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { getMailAuth, inboxRules } from '@/lib/streamMail.server'
import { requireUser, readKeyOk } from '@/lib/apiAuth.server'

// AS REGRAS DA CAIXA, PELA TELA — o último suspeito do caso do despachante.
//
// Uma resposta da Auto Tags & Title foi parar nos Itens Excluídos duas vezes
// (30/jul, levando a cotação da RAMbo; 07/set). A medição inocentou os cinco
// robôs deste repositório, e o que sobrou foi a hipótese de uma regra criada na
// PRÓPRIA caixa do Outlook — coisa que nenhum commit conserta e que ninguém
// tinha como ver, porque ler regra exige `MailboxSettings.Read`.
//
// Agora dá para olhar sem abrir o Outlook:
//   /api/stream/mail-rules            → caixa 1 (gz28us@hotmail)
//   /api/stream/mail-rules?slot=2     → outra caixa
//
// Caixa que ainda não reconsentiu responde 409 com o link do reconsentimento —
// nunca 500, porque não ter a permissão é um estado normal, não um defeito.
//
// PORTÃO (11/set/2026): até aqui respondia a qualquer um — todas as regras da
// caixa e, de brinde, um refresh do token (que rotaciona). Agora só entra admin
// logado (Authorization: Bearer <sessão>) ou quem tem a chave de leitura (header
// x-read-key; ?key= ainda vale na transição). Nada de token sem prova.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!(await requireUser(req)) && !readKeyOk(req, { allowQuery: true })) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get('slot') || '1') || 1)
  const db = streamDb()
  const auth = await getMailAuth(db, slot)
  if (!auth) return NextResponse.json({ error: `slot ${slot} não existe` }, { status: 404 })

  const { rules, error } = await inboxRules(db, auth)
  if (error) return NextResponse.json({ account: auth.account || null, error }, { status: 409 })

  // O que interessa é quem MOVE ou APAGA: a regra que só marca como lida não
  // some com correspondência. Vem tudo, mas o resumo aponta o dedo.
  const suspeitas = (rules || []).filter((r: any) => {
    const a = r?.actions || {}
    return a.delete === true || a.permanentDelete === true || !!a.moveToFolder
  })
  return NextResponse.json({
    account: auth.account || null,
    total: (rules || []).length,
    movemOuApagam: suspeitas.length,
    suspeitas: suspeitas.map((r: any) => ({
      nome: r.displayName, ativa: r.isEnabled, ordem: r.sequence,
      condicoes: r.conditions, acoes: r.actions,
    })),
    todas: rules,
  })
}
