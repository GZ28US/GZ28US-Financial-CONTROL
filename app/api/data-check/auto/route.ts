import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { writeUnmatch, logMatchEvent } from '@/lib/bankReconcile.server'
import { tabelaAtual } from '@/lib/tableRenames'

// O APP PREENCHEU SOZINHO — a memória do Data Checker autossuficiente (DC 1.44.0, João, 8/set/2026:
// «só chamar a gente quando for REALMENTE necessário»). Tudo que o app escreve sem clique deixa
// uma linha em data_fixes com o rótulo «AUTO · <prova>»; este endpoint devolve as dos últimos
// 7 dias (o card SOZINHO, com DESFAZER genérico) e guarda as DISPENSAS («visto, está certo»),
// que um card nunca mais pergunta — dispensa que não ensina é silêncio que volta.
export const maxDuration = 30

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const since = new Date(Date.now() - 7 * 864e5).toISOString()
  // A lista INTEIRA dos 7 dias (João, 8/set: «tem que mostrar o total, não só 1.000»): o PostgREST
  // devolve 1.000 por vez, então pagina; teto de 20.000 por sanidade — se cortar, o card diz.
  const AUTO_CAP = 20000
  const auto: any[] = []
  let e1: any = null
  for (let from = 0; from < AUTO_CAP; from += 1000) {
    const { data, error } = await db.from('data_fixes').select('id, check_key, table_name, row_id, field, old_value, new_value, label, fixed_at').like('label', 'AUTO ·%').gte('fixed_at', since).order('fixed_at', { ascending: false }).range(from, from + 999)
    if (error) { e1 = error; break }
    // data_fixes.table_name é LOG HISTÓRICO: guarda o nome que a tabela tinha na hora
    // do conserto, e a onda 2 (11/set/2026) NÃO reescreve o log. Quem recebe esta lista
    // monta o DESFAZER (db.from) e o rótulo/link por nome de tabela — então o nome sai
    // daqui já traduzido pelo mapa. Prefixo US./BR. é outra convenção e passa intacto.
    auto.push(...(data || []).map((r: any) => ({ ...r, table_name: tabelaAtual(r.table_name) })))
    if (!data || data.length < 1000) break
  }
  const [{ data: dis, error: e2 }, { count: total }] = await Promise.all([
    db.from('data_fixes').select('id, check_key, row_id, new_value, fixed_at').eq('field', 'DISMISSED').order('fixed_at', { ascending: false }).limit(2000),
    db.from('data_fixes').select('id', { count: 'exact', head: true }).like('label', 'AUTO ·%').gte('fixed_at', since),   // contagem exata: o card compara com o que recebeu
  ])
  if (e1 || e2) return NextResponse.json({ error: (e1 || e2)!.message }, { status: 500 })
  // Uma dispensa vale até ser desfeita (new_value 'UNDISMISS' mais recente cancela).
  const dismissed: Record<string, string> = {}
  const seen = new Set<string>()
  for (const r of dis || []) { const k = r.check_key + '|' + r.row_id; if (seen.has(k)) continue; seen.add(k); if (r.new_value !== 'UNDISMISS') dismissed[k] = String(r.new_value || 'visto') }
  return NextResponse.json({ ok: true, auto, dismissed, total: total ?? auto.length })
}

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const db = bankDb()
  const b = await req.json().catch(() => ({}))
  const action = String(b.action || '')
  // DESFAZER genérico: o campo volta ao valor anterior — só se ainda estiver com o valor que o app
  // gravou (alguém mexeu depois = nada é tocado, e o card diz). Linha apagada com foto (old_value
  // JSON) volta a existir.
  if (action === 'undo') {
    const { data: fx } = await db.from('data_fixes').select('*').eq('id', String(b.fix_id || '')).maybeSingle()
    if (!fx || !/^AUTO ·/.test(String(fx.label || ''))) return NextResponse.json({ error: 'não foi o app que fez isto' }, { status: 409 })
    // O nome vem do log com a grafia da época: o mapa dos cinco renames o traz pra hoje,
    // senão o db.from(table) daqui pra baixo aponta pra tabela que não existe mais (as
    // views-ponte caem na onda 5). 91 linhas antigas têm nome velho — medido em 11/set.
    const table = tabelaAtual(fx.table_name), rowId = String(fx.row_id), field = String(fx.field)
    const changed: string[] = []   // o que o DESFAZER do casamento disse (inclusive «não revertido — confira») vai pra trilha
    if (field === 'DELETED') {
      let snap: any = null
      try { snap = JSON.parse(String(fx.old_value || '')) } catch { snap = null }
      if (!snap || typeof snap !== 'object' || !snap.id) return NextResponse.json({ error: 'sem foto da linha apagada — não dá pra restaurar' }, { status: 409 })
      const { error } = await (db.from(table) as any).insert(snap)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else if (table === 'bank_transactions') {
      // BL 1.4.0: o casamento do motor nasce visto e sai de A CONFERIR — o DESFAZER por linha mora aqui.
      // Só desfaz o que ainda é o MESMO casamento (MATCHED, nota «AUTO ·»); writeUnmatch devolve o backfill e vira NÃO É ESSE.
      const { data: line } = await db.from('bank_transactions').select('*').eq('id', rowId).maybeSingle()
      if (!line || line.match_status !== 'MATCHED') return NextResponse.json({ error: 'a linha já não está casada — nada a desfazer' }, { status: 409 })
      if (!/^AUTO ·/.test(String(line.matched_note || ''))) return NextResponse.json({ error: 'este casamento foi feito por gente, não pelo app — o card verde só desfaz o que o app fez (adoção feita por gente: DESFAZER em «casadas a conferir» no Bank Link; MATCH à mão nasce visto e não tem DESFAZER na tela)' }, { status: 409 })
      try { await writeUnmatch(db, line, changed, { unlearn: false, refuse: true }); await logMatchEvent(db, line, 'UNMATCH', { note: 'DESFAZER · Data Checker (card verde)' }) }
      catch (e) { return NextResponse.json({ error: String((e as Error).message || e).slice(0, 200) }, { status: 409 }) }
      // ADOÇÃO desfeita: a memória do Data Checker também diz NÃO — o AUTO-RUN pula 'bank-drift|<id da agendada>' (a mesma chave
      // da dispensa). DESFEITO não esconde o item; só impede a máquina de adotar de novo. A deriva não mostra mais o par recusado: gente casa à mão pela Conciliação.
      if (line.matched_table === 'fixed_cost_expenses' && line.matched_id && (fx.check_key === 'bank-drift' || /ADOTOU agendada/.test(String(line.matched_note || '')) || (Array.isArray(line.backfill) && line.backfill.some((x: any) => x && x.t === 'fixed_cost_expenses' && x.f === 'bank_transaction_id'))))
        await db.from('data_fixes').insert({ check_key: 'bank-drift', table_name: 'fixed_cost_expenses', row_id: String(line.matched_id), field: 'DISMISSED', old_value: null, new_value: 'DESFEITO', label: ('DESFEITO · o app não adota sozinho · ' + String(fx.label || '').replace(/^AUTO · /, '')).slice(0, 200) }).then(() => undefined, () => undefined)
      // CASAR do Data Checker desfeito («Despesa venceu…» / «Paga no app, sem linha no banco»): a mesma memória, na chave do card — o card
      // não oferece de novo o par como certo e o AUTO-RUN não insiste (a rota recusaria: par recusado). Revisão da BL 1.5.1.
      if (['undated-inv', 'paid-no-bank'].includes(String(fx.check_key)) && line.matched_table && line.matched_id)
        await db.from('data_fixes').insert({ check_key: fx.check_key, table_name: String(line.matched_table), row_id: String(line.matched_id), field: 'DISMISSED', old_value: null, new_value: 'DESFEITO', label: ('DESFEITO · o app não casa sozinho de novo · ' + String(fx.label || '').replace(/^AUTO · /, '')).slice(0, 200) }).then(() => undefined, () => undefined)
    } else {
      const prev = fx.old_value === undefined ? null : fx.old_value
      let q: any = (db.from(table) as any).update({ [field]: prev === '' ? null : prev }).eq('id', rowId)
      q = fx.new_value == null ? q.is(field, null) : q.eq(field, fx.new_value)
      const { data: ok, error } = await q.select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!ok || !ok.length) return NextResponse.json({ error: 'o campo já mudou depois — nada desfeito' }, { status: 409 })
      // Revisão de 9/set: desfazer um «quem pagou» com o SOURCE legado dizendo o mesmo pagador não desfaria nada (whoPaid cai no
      // SOURCE e DFC/Balanço seguiriam contando) — limpa o SOURCE junto, com trilha própria.
      if (field === 'paid_from' && fx.new_value) { const { data: cleared } = await (db.from(table) as any).update({ source: null }).eq('id', rowId).eq('source', fx.new_value).select('id'); if (cleared && cleared.length) await db.from('data_fixes').insert({ check_key: fx.check_key, table_name: table, row_id: rowId, field: 'source', old_value: fx.new_value, new_value: null, label: ('DESFEITO · o SOURCE antigo dizia o mesmo pagador (' + fx.new_value + ') — limpo junto, senão DFC e Balanço seguiriam contando').slice(0, 200) }).then(() => undefined, () => undefined) }
    }
    // DESFAZER é a pessoa discordando da prova: a máquina não refaz esta linha (DESFEITO na memória; o card ainda pergunta).
    if (table !== 'bank_transactions') await db.from('data_fixes').insert({ check_key: fx.check_key, table_name: table, row_id: rowId, field: 'DISMISSED', old_value: null, new_value: 'DESFEITO', label: ('DESFEITO · o app não refaz sozinho · ' + String(fx.label || '').replace(/^AUTO · /, '')).slice(0, 200) }).then(() => undefined, () => undefined)
    await db.from('data_fixes').insert({ check_key: fx.check_key, table_name: table, row_id: rowId, field, old_value: fx.new_value ?? null, new_value: field === 'DELETED' ? 'RESTORED' : (fx.old_value ?? null), label: ('DESFEITO · ' + String(fx.label || '').replace(/^AUTO · /, '') + (changed.length ? ' → ' + changed.join(', ') : '')).slice(0, 200) }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true, changed })
  }
  // DISPENSA: «visto, está certo» com motivo — o card para de perguntar até alguém desdispensar.
  if (action === 'dismiss' || action === 'undismiss') {
    const checkKey = String(b.check_key || ''), rowId = String(b.row_id || '')
    if (!checkKey || !rowId) return NextResponse.json({ error: 'check_key/row_id required' }, { status: 400 })
    const reason = action === 'dismiss' ? (String(b.reason || '').trim().slice(0, 160) || 'visto, está certo') : 'UNDISMISS'
    const { error } = await db.from('data_fixes').insert({ check_key: checkKey, table_name: String(b.table || 'data_check'), row_id: rowId, field: 'DISMISSED', old_value: null, new_value: reason, label: ((action === 'dismiss' ? 'DISPENSADO · ' : 'VOLTOU A PERGUNTAR · ') + String(b.label || '')).slice(0, 200) })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ error: 'action inválida' }, { status: 400 })
}
