import { NextRequest, NextResponse } from 'next/server'
import { streamDb } from '@/lib/stream.server'
import { lancar } from '@/lib/autoBookMail.server'
import { cacaNaPasta, respostaUnica } from '@/lib/dropboxHunt.server'
import { papeisOrfaos } from '@/lib/papelOrfao.server'
import { tabelaAtual } from '@/lib/tableRenames'

// AUTO-BOOK — A MESA DA DÚVIDA.
//
// GET  → o que o robô não soube resolver (status DOUBT), do mais novo pro mais
//        velho, com o que ele leu do e-mail e os destinos que ele MEDIU no banco.
//        É esta lista que vale como "a rodada", não a resposta do cron.
// POST → a resposta. Uma resposta faz DUAS coisas, e a segunda é a que importa:
//        1) resolve ESTE e-mail (lança a linha, ou marca como ignorado);
//        2) com `learn`, vira REGRA em auto_book_mail_rules — e o mesmo caso
//           nunca mais é perguntado. É assim que a fila encolhe sozinha.
//
// Autenticação: a mesma chave de leitura das outras rotas de assistente
// (WHATSAPP_READ_KEY). A service key nunca sai do servidor.

export const dynamic = 'force-dynamic'

const auth = (req: NextRequest, key?: string | null) => {
  const need = process.env.WHATSAPP_READ_KEY
  return !!need && (key || req.nextUrl.searchParams.get('key')) === need
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const p = req.nextUrl.searchParams
  const db = streamDb()

  // ── ?pasta=<fornecedor>&pedido=<n> — O QUE O ROBÔ ENXERGA NAS PASTAS ──────
  // Somente LEITURA. Existe porque a caça na pasta só roda quando um e-mail
  // chega à dúvida, e numa casa em dia isso pode não acontecer por dias —
  // então a feature ficaria sem prova de que funciona ([[denial-is-not-proof]]:
  // não disparar não é o mesmo que funcionar). Com esta porta eu pergunto
  // direto: "para a Summit, pedido 430475, o que você acha no Dropbox?".
  if (p.get('pasta') || p.get('pedido')) {
    try {
      const hits = await cacaNaPasta({ vendor: p.get('pasta'), order: p.get('pedido'), quando: p.get('quando') })
      return NextResponse.json({ ok: true, n: hits.length, unica: respostaUnica(hits), hits })  // hits trazem o relogio usado (client_modified)
    } catch (e) {
      return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
    }
  }

  // ── ?orfaos=1 — PAPEL QUE NINGUÉM LANÇOU ─────────────────────────────────
  // O outro lado da caça: em vez de e-mail procurando invoice, papel procurando
  // lançamento. Existe porque fornecedor que não manda e-mail (AutoZone, balcão,
  // loja física, serviço por telefone) NUNCA dispara o robô — e o único sinal que
  // sobra é o arquivo na pasta com o nome que veio da loja, porque o app só
  // renomeia o que tem linha no banco. Ver lib/papelOrfao.server.ts.
  // Somente LEITURA: nada é lançado, nada é apagado, nada é renomeado.
  if (p.get('orfaos')) {
    try {
      const v = await papeisOrfaos(Math.min(120, parseInt(p.get('paginas') || '40') || 40))
      return NextResponse.json({ ok: true, ...v })
    } catch (e) {
      return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 })
    }
  }

  const status = p.get('status') || 'DOUBT'
  let q = db.from('auto_book_mail').select('*').order('received_at', { ascending: false }).limit(Math.min(200, parseInt(p.get('limit') || '50') || 50))
  if (status !== 'ALL') q = q.eq('status', status)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const { data: rules } = await db.from('auto_book_mail_rules').select('id,label,action,match_from,match_subject,match_vendor,hits,last_hit_at,active').order('hits', { ascending: false })
  // `cands` é JSON com NOME DE TABELA dentro (`[{table,ref,…}]`), gravado quando a
  // pergunta nasceu — e a migration da onda 2 só reescreve a coluna de TEXTO
  // booked_table. Medido na noite de 11/set/2026: 6 das 20 linhas da fila têm 'expenses' aí
  // dentro. Traduzido na SAÍDA para que a sugestão que a pessoa lê (e devolve no
  // `target` do POST) já venha com o nome de hoje; o `lancar` traduz de novo, porque
  // o POST pode vir com um target escrito à mão. Idempotente nas duas pontas.
  const fila = (data || []).map((r: Record<string, unknown>) => Array.isArray(r.cands)
    ? { ...r, cands: (r.cands as Record<string, unknown>[]).map(c => ({ ...c, table: tabelaAtual(String(c?.table ?? '')) })) }
    : r)
  return NextResponse.json({ ok: true, n: fila.length, fila, regras: rules || [] })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  if (!auth(req, typeof body.key === 'string' ? body.key : null)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = streamDb()

  // ── criar regra avulsa (sem responder e-mail nenhum) ──────────────────────
  if (body.rule) {
    const { data, error } = await db.from('auto_book_mail_rules').insert(body.rule as Record<string, unknown>).select('*').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, regra: data })
  }

  const id = String(body.id || '')
  const action = String(body.action || '').toUpperCase()
  if (!id || !['BOOK', 'IGNORE'].includes(action)) return NextResponse.json({ error: 'informe id e action=BOOK|IGNORE (ou rule)' }, { status: 400 })

  const { data: row, error: e0 } = await db.from('auto_book_mail').select('*').eq('id', id).single()
  if (e0 || !row) return NextResponse.json({ error: e0?.message || 'linha não encontrada' }, { status: 404 })
  if (row.status !== 'DOUBT') return NextResponse.json({ error: `esta linha já está ${row.status}` }, { status: 409 })

  let booked: { table: string; id: string } | null = null
  if (action === 'BOOK') {
    const target = (body.target || {}) as Record<string, unknown>
    // O valor da resposta manda sobre o que o parser leu — quem responde está
    // olhando o e-mail. Sem valor de lado nenhum não se lança nada.
    const amount = body.amount != null ? Number(body.amount) : (row.amount != null ? Number(row.amount) : NaN)
    if (!Number.isFinite(amount) || !(amount > 0)) return NextResponse.json({ error: 'sem valor: mande amount' }, { status: 400 })
    const r = await lancar(db, target, {
      vendor: String(body.vendor || row.vendor || ''),
      order: (body.order_number as string) || row.order_number || null,
      amount,
      date: String(body.date || row.received_at || '').slice(0, 10),
      desc: String(body.desc || `${row.vendor || ''} — ${row.subject || ''}`).slice(0, 240),
    })
    if ('erro' in r) return NextResponse.json({ error: r.erro }, { status: 500 })
    booked = r
  }

  await db.from('auto_book_mail').update({
    status: action === 'BOOK' ? 'BOOKED' : 'IGNORED',
    answer: body as Record<string, unknown>,
    answered_at: new Date().toISOString(),
    booked_table: booked?.table || null,
    booked_id: booked?.id || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)

  // ── A RESPOSTA VIRA AUTOMAÇÃO ────────────────────────────────────────────
  let regra = null
  if (body.learn) {
    const { data } = await db.from('auto_book_mail_rules').insert({
      label: String(body.label || `${row.vendor} — ${action.toLowerCase()}`),
      match_vendor: row.vendor,
      match_from: body.match_from ?? null,
      match_subject: body.match_subject ?? null,
      action,
      target: action === 'BOOK' ? (body.target as Record<string, unknown>) : null,
      note: `nascida da dúvida ${id} (${row.subject || ''})`.slice(0, 400),
    }).select('*').single()
    regra = data
  }

  return NextResponse.json({ ok: true, status: action === 'BOOK' ? 'BOOKED' : 'IGNORED', booked, regra })
}
