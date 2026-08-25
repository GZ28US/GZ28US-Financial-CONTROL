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

// PostgREST devolve NO MÁXIMO 1000 linhas por request e IGNORA .limit() acima
// disso — em silêncio. O round lia 1000 dos 1369 chats (369 sorteados fora) e
// só as 1000 mensagens mais novas da janela, e por isso respondeu "0 pendentes"
// com 100 conversas esperando (bug achado por ele em 24/ago/2026). Toda leitura
// de volume desta rota passa por aqui.
async function pageAll<T>(build: () => any, size = 1000, max = 120000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < max; from += size) {
    const { data, error } = await build().range(from, from + size - 1)
    if (error) throw error
    const rows = (data || []) as T[]
    out.push(...rows)
    if (rows.length < size) break
  }
  return out
}

export async function GET(req: NextRequest) {
  // Sessão do /ca (a tela) OU a WHATSAPP_READ_KEY (a assistente), igual às
  // demais rotas de leitura do WhatsApp — é a mesma informação que elas servem.
  const p = req.nextUrl.searchParams
  const key = process.env.WHATSAPP_READ_KEY
  const keyOk = !!key && p.get('key') === key
  if (!keyOk && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = waDb()
  const listOnly = p.get('view') === 'list'
  // Janela do round. Padrão 3 dias: é o que o round trata de fato — conversa
  // parada há semanas não é "não-processada", é arquivo. `since` alarga quando
  // ele quiser varrer mais fundo.
  const days = Math.min(Math.max(parseInt(p.get('days') || '3') || 3, 1), 90)
  const since = p.get('since') || new Date(Date.now() - days * 864e5).toISOString()

  try {
    const chats = await pageAll<any>(() => db.from('whatsapp_chats')
      .select('app, chat_id, name, is_group, policy, processed_through, processed_note')
      .neq('policy', 'IGNORE')
      .order('app', { ascending: true })
      .order('chat_id', { ascending: true }))

    // A ATIVIDADE REAL vem das mensagens, nunca de whatsapp_chats.last_at: o
    // sync grava null ali quando a UltraMsg não manda a hora e apaga o que o
    // webhook tinha posto (1.325 de 1.340 chats estavam com o campo nulo).
    const recent = await pageAll<any>(() => db.from('whatsapp_messages')
      .select('app, chat_id, sent_at, from_me')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .order('id', { ascending: false }))
    const lastBy = new Map<string, string>()
    const lastMine = new Map<string, boolean>()
    for (const m of recent || []) {
      const k = `${m.app}|${m.chat_id}`
      if (!lastBy.has(k)) { lastBy.set(k, m.sent_at); lastMine.set(k, !!m.from_me) }
    }

    // ?waiting=1 — só o que ESPERA POR ELE: se a última palavra foi dele, a
    // conversa está em movimento e não é aviso (senão o vigia vira enxurrada:
    // 12 avisos em 4 minutos, 9 deles conversa que ele já estava respondendo).
    const waitingOnly = p.get('waiting') === '1'

    const open = (chats || [])
      .map(c => ({
        ...c,
        last_at: lastBy.get(`${c.app}|${c.chat_id}`) || null,
        last_from_me: lastMine.get(`${c.app}|${c.chat_id}`) ?? null,
      }))
      .filter(c => {
        if (SELF.has(c.chat_id) || isReportGroup(c.name || '')) return false
        if (!c.last_at) return false
        if (waitingOnly && c.last_from_me) return false
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
      lastAt: c.last_at, zone: zoneOf(c.app, c.name), policy: c.policy, lastFromMe: c.last_from_me,
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
      .order('sent_at', { ascending: false }).limit(60)

    return NextResponse.json({
      remaining: eligible.length,
      next: { ...summary(c), newCount: (msgs || []).length, messages: (msgs || []).reverse() },
      queue: eligible.slice(1, 6).map(summary),
    })
  } catch (e) {
    console.error('[whatsapp-round]', e)
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 })
  }
}
