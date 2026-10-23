// ════════════════════════════════════════════════════════════════════════════
// lib/intercompanyBank.server.ts · 23/out/2026 — A TRANSFERÊNCIA CASA COM A LINHA DA REGIONS (SÓ SERVIDOR)
//
// Uma transferência BR→US chegou de verdade quando a Regions mostra a entrada. Este robô (cron da conta BR↔US, de hora em hora)
// casa cada transferência ARRIVED sem bank_transaction_id com UMA linha NEW da Regions de ENTRADA, mesmo valor (± US$ 0,01) e
// data a até 5 dias da chegada declarada. Casou → a linha vira MATCHED (matched_table 'intercompany_transfers', match_engine
// 'intercompany') e a transferência RECONCILED. Duas candidatas = não casa (ambíguo, fica para a tela). Nunca inventa.
// Trilha: data_fixes check_key 'intercompany-transfers' + o diário da linha (matched_note).

import type { SupabaseClient } from '@supabase/supabase-js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0
function addDias(d: string, n: number): string { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

export type ResultadoCasamento = { conferidas: number; casadas: { code: string; bank_transaction_id: string; usd: number }[]; ambiguas: { code: string; candidatas: number }[]; sem_par: number; erro?: string }

export async function casarTransferenciasComRegions(us: SupabaseClient, opts: { gravar?: boolean } = {}): Promise<ResultadoCasamento> {
  const gravar = opts.gravar !== false
  const out: ResultadoCasamento = { conferidas: 0, casadas: [], ambiguas: [], sem_par: 0 }
  const { data: trs, error } = await us.from('intercompany_transfers').select('id, code, direction, arrived_on, arrived_amount, arrived_currency, status, bank_transaction_id').eq('direction', 'BR_TO_US').is('bank_transaction_id', null).in('status', ['ARRIVED', 'SENT']).not('arrived_on', 'is', null)
  if (error) return { ...out, erro: error.message }
  for (const t of (trs || []) as Row[]) {
    if (t.arrived_currency !== 'USD' || !(num(t.arrived_amount) > 0)) continue
    out.conferidas++
    const usd = Math.round(num(t.arrived_amount) * 100) / 100
    const de = addDias(String(t.arrived_on).slice(0, 10), -5), ate = addDias(String(t.arrived_on).slice(0, 10), 5)
    // Entrada na Regions: no feed do Plaid o crédito vem NEGATIVO (amount < 0) — os dois sinais são aceitos e o valor é comparado em módulo.
    const { data: linhas, error: e2 } = await us.from('bank_transactions').select('id, date, amount, name, match_status').eq('match_status', 'NEW').gte('date', de).lte('date', ate).or(`amount.eq.${usd},amount.eq.${-usd}`)
    if (e2) return { ...out, erro: e2.message }
    const cands = (linhas || []) as Row[]
    if (!cands.length) { out.sem_par++; continue }
    if (cands.length > 1) { out.ambiguas.push({ code: t.code, candidatas: cands.length }); continue }
    const l = cands[0]
    if (!gravar) { out.casadas.push({ code: t.code, bank_transaction_id: l.id, usd }); continue }
    const nota = `transferência BR→US ${t.code} (casada pelo robô da conta BR↔US, 23/10/2026+)`
    const { data: claimed, error: e3 } = await us.from('bank_transactions').update({ match_status: 'MATCHED', matched_table: 'intercompany_transfers', matched_id: t.id, matched_note: nota, match_engine: 'intercompany', reviewed_at: new Date().toISOString() }).eq('id', l.id).eq('match_status', 'NEW').select('id')
    if (e3 || !claimed?.length) continue
    const { error: e4 } = await us.from('intercompany_transfers').update({ bank_transaction_id: l.id, status: 'RECONCILED', updated_at: new Date().toISOString() }).eq('id', t.id).is('bank_transaction_id', null)
    if (e4) { await us.from('bank_transactions').update({ match_status: 'NEW', matched_table: null, matched_id: null, matched_note: null, match_engine: null, reviewed_at: null }).eq('id', l.id).eq('matched_id', t.id); continue }
    await us.from('data_fixes').insert([{ check_key: 'intercompany-transfers', table_name: 'intercompany_transfers', row_id: t.id, field: 'bank_transaction_id', old_value: null, new_value: l.id, label: `${t.code}: Regions ${String(l.date).slice(0, 10)} ${l.name || ''} US$ ${usd} (robô)` }])
    out.casadas.push({ code: t.code, bank_transaction_id: l.id, usd })
  }
  return out
}
