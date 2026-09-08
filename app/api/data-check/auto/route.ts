import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'

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
  const [{ data: auto, error: e1 }, { data: dis, error: e2 }] = await Promise.all([
    db.from('data_fixes').select('id, check_key, table_name, row_id, field, old_value, new_value, label, created_at').like('label', 'AUTO ·%').gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
    db.from('data_fixes').select('id, check_key, row_id, new_value, created_at').eq('field', 'DISMISSED').order('created_at', { ascending: false }).limit(2000),
  ])
  if (e1 || e2) return NextResponse.json({ error: (e1 || e2)!.message }, { status: 500 })
  // Uma dispensa vale até ser desfeita (new_value 'UNDISMISS' mais recente cancela).
  const dismissed: Record<string, string> = {}
  const seen = new Set<string>()
  for (const r of dis || []) { const k = r.check_key + '|' + r.row_id; if (seen.has(k)) continue; seen.add(k); if (r.new_value !== 'UNDISMISS') dismissed[k] = String(r.new_value || 'visto') }
  return NextResponse.json({ ok: true, auto: auto || [], dismissed })
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
    const table = String(fx.table_name), rowId = String(fx.row_id), field = String(fx.field)
    if (field === 'DELETED') {
      let snap: any = null
      try { snap = JSON.parse(String(fx.old_value || '')) } catch { snap = null }
      if (!snap || typeof snap !== 'object' || !snap.id) return NextResponse.json({ error: 'sem foto da linha apagada — não dá pra restaurar' }, { status: 409 })
      const { error } = await (db.from(table) as any).insert(snap)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else if (table === 'bank_transactions') {
      return NextResponse.json({ error: 'casamento se desfaz no Bank Link (A CONFERIR → DESFAZER)' }, { status: 409 })
    } else {
      const prev = fx.old_value === undefined ? null : fx.old_value
      let q: any = (db.from(table) as any).update({ [field]: prev === '' ? null : prev }).eq('id', rowId)
      q = fx.new_value == null ? q.is(field, null) : q.eq(field, fx.new_value)
      const { data: ok, error } = await q.select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!ok || !ok.length) return NextResponse.json({ error: 'o campo já mudou depois — nada desfeito' }, { status: 409 })
    }
    await db.from('data_fixes').insert({ check_key: fx.check_key, table_name: table, row_id: rowId, field, old_value: fx.new_value ?? null, new_value: field === 'DELETED' ? 'RESTORED' : (fx.old_value ?? null), label: ('DESFEITO · ' + String(fx.label || '').replace(/^AUTO · /, '')).slice(0, 200) }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true })
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
