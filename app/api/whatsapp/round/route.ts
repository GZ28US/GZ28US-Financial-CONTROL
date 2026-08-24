import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth.server'
import { waDb } from '@/lib/waStore.server'

// WHATSAPP HUB — O ROUND, no app (ordem do Márcio, 24/ago/2026: "Você aqui tem
// que ser só UMA INTERFACE do APP; tudo que puder ficar lá tem que ficar").
// A regra do round deixou de morar num script da assistente e passou a ser do
// app — a assistente só chama esta rota e apresenta.
//
//   GET /ca/api/whatsapp/round            → a PRÓXIMA conversa não-processada
//   GET /ca/api/whatsapp/round?view=list  → só o placar e a fila (sem mensagens)
//
// As leis que esta rota implementa:
//   • NEXT = a conversa NÃO-PROCESSADA mais recente ([[wa-round-next-rule]])
//   • processada = tudo até `whatsapp_chats.processed_through`; mensagem
//     posterior REABRE a conversa sozinha
//   • policy IGNORE nunca entra; MENTION_ONLY só entra se o Márcio foi MARCADO
//     depois da marca d'água (mentioned_ids — o texto @<LID> não serve)
//   • fuso pelo ASSUNTO: grupo "GZ28US …" é Orlando mesmo lido pela cópia BR
//   • self-chats e grupos de report automático nunca são pauta

export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Os 2 números do Márcio: conversa consigo mesmo é canal de report, não pauta.
const SELF = new Set(['13213150973@c.us', '5511981215678@c.us'])
const MARCIO = ['13213150973', '5511981215678']
const isReportGroup = (name: string) => /Control App REPORTS/i.test(name)

function zoneOf(app: string, name: string | null): 'US' | 'BR' {
  const n = String(name || '').toUpperCase()
  if (n.includes('GZ28US')) return 'US'
  if (n.includes('GZ28BR')) return 'BR'
  return app === 'US' ? 'US' : 'BR'
}

const mentionsMarcio = (ids: string[] | null) =>
  (ids || []).some(id => MARCIO.some(n => String(id).includes(n)))

export async function GET(req: NextRequest) {
  // Sessão do /ca (a tela) OU a WHATSAPP_READ_KEY (a assistente), igual às
  // demais rotas de leitura do WhatsApp — é a mesma informação que elas servem.
  const p = req.nextUrl.searchParams
  const key = process.env.WHATSAPP_READ_KEY
  const keyOk = !!key && p.get('key') === key
  if (!keyOk && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = waDb()
  const listOnly = p.get('view') === 'list'
  const since = p.get('since') || '2026-08-01T00:00:00Z'

  try {
    const { data: chats, error: cErr } = await db.from('whatsapp_chats')
      .select('app, chat_id, name, is_group, last_at, policy, processed_through, processed_note')
      .neq('policy', 'IGNORE')
      .order('last_at', { ascending: false, nullsFirst: false })
      .limit(1500)
    if (cErr) throw cErr

    // Candidatas: têm atividade e ainda não foram processadas até o fim.
    const open = (chats || []).filter(c => {
      if (SELF.has(c.chat_id) || isReportGroup(c.name || '')) return false
      if (!c.last_at || c.last_at < since) return false
      return !c.processed_through || c.last_at > c.processed_through
    })

    // O mesmo grupo existe nos 2 números: fica a cópia do lado do assunto.
    const dedup = new Map<string, any>()
    for (const c of open) {
      const want = c.is_group ? zoneOf(c.app, c.name) : c.app
      const prev = dedup.get(c.chat_id)
      if (!prev || (prev.app !== want && c.app === want)) dedup.set(c.chat_id, c)
    }

    const ordered = [...dedup.values()].sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))

    // MENTION_ONLY: só é pauta se o Márcio foi marcado DEPOIS da marca d'água.
    const eligible: any[] = []
    for (const c of ordered) {
      if (c.policy !== 'MENTION_ONLY') { eligible.push(c); continue }
      const { data: hits } = await db.from('whatsapp_messages')
        .select('mentioned_ids')
        .eq('chat_id', c.chat_id)
        .gt('sent_at', c.processed_through || since)
        .not('mentioned_ids', 'is', null)
        .limit(200)
      if ((hits || []).some((h: any) => mentionsMarcio(h.mentioned_ids))) eligible.push(c)
    }

    const summary = (c: any) => ({
      app: c.app, chatId: c.chat_id, name: c.name, isGroup: c.is_group,
      lastAt: c.last_at, zone: zoneOf(c.app, c.name), policy: c.policy,
      processedThrough: c.processed_through,
    })

    if (listOnly || !eligible.length) {
      return NextResponse.json({
        remaining: eligible.length,
        next: eligible.length ? summary(eligible[0]) : null,
        queue: eligible.slice(0, 25).map(summary),
      })
    }

    // A próxima, com as mensagens ainda não tratadas (e um pouco de contexto).
    const c = eligible[0]
    const { data: msgs } = await db.from('whatsapp_messages')
      .select('from_me, author, pushname, type, body, media_url, sent_at, mentioned_ids')
      .eq('app', c.app).eq('chat_id', c.chat_id)
      .gt('sent_at', c.processed_through || since)
      .order('sent_at', { ascending: true }).limit(120)

    return NextResponse.json({
      remaining: eligible.length,
      next: { ...summary(c), newCount: (msgs || []).length, messages: msgs || [] },
      queue: eligible.slice(1, 6).map(summary),
    })
  } catch (e) {
    console.error('[whatsapp-round]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
