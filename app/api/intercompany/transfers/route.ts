import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { readKeyOk, requireUser } from '@/lib/apiAuth.server'

// ── TRANSFERÊNCIAS BR↔US (23/out/2026): o dinheiro que uma empresa manda para a outra ─────────────────────────────
// POST { action: 'create' | 'update', transfer: {...} } — grava intercompany_transfers com trilha em data_fixes (check_key
// 'intercompany-transfers'). Regras: direction e pelo menos uma perna (sent ou arrived) com data, valor e moeda; moeda só
// BRL/USD; status SENT (só saiu) → ARRIVED (chegou) → RECONCILED (linha da Regions casada). Nunca apaga: para desfazer,
// zere os valores e descreva. Portão: tela logada (sessionHeaders) ou x-read-key (as AutoBooks).
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */
const falha = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status })
const YMD = /^\d{4}-\d{2}-\d{2}$/
const CUR = new Set(['BRL', 'USD'])
const num = (v: unknown): number | null => { if (v === '' || v == null) return null; const n = parseFloat(String(v)); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null }
const urls = (v: unknown): string[] => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(/\s*[\n,]\s*/).map(s => s.trim()).filter(Boolean) : []

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

function limpar(t: any): { row: Record<string, unknown>; erro?: string } {
  const direction = String(t.direction || '').toUpperCase()
  if (direction !== 'BR_TO_US' && direction !== 'US_TO_BR') return { row: {}, erro: 'direction: BR_TO_US ou US_TO_BR' }
  const sent_on = t.sent_on ? String(t.sent_on).slice(0, 10) : null, arrived_on = t.arrived_on ? String(t.arrived_on).slice(0, 10) : null
  if (sent_on && !YMD.test(sent_on)) return { row: {}, erro: 'sent_on: YYYY-MM-DD' }
  if (arrived_on && !YMD.test(arrived_on)) return { row: {}, erro: 'arrived_on: YYYY-MM-DD' }
  const sent_amount = num(t.sent_amount), arrived_amount = num(t.arrived_amount)
  const sent_currency = t.sent_currency ? String(t.sent_currency).toUpperCase() : null, arrived_currency = t.arrived_currency ? String(t.arrived_currency).toUpperCase() : null
  if (sent_currency && !CUR.has(sent_currency)) return { row: {}, erro: 'sent_currency: BRL ou USD' }
  if (arrived_currency && !CUR.has(arrived_currency)) return { row: {}, erro: 'arrived_currency: BRL ou USD' }
  const pernaSaiu = !!(sent_on && sent_amount != null && sent_currency), pernaChegou = !!(arrived_on && arrived_amount != null && arrived_currency)
  if (!pernaSaiu && !pernaChegou) return { row: {}, erro: 'pelo menos uma perna completa: (sent_on, sent_amount, sent_currency) ou (arrived_on, arrived_amount, arrived_currency)' }
  const status = t.status ? String(t.status).toUpperCase() : (pernaChegou ? 'ARRIVED' : 'SENT')
  if (!['SENT', 'ARRIVED', 'RECONCILED'].includes(status)) return { row: {}, erro: 'status: SENT, ARRIVED ou RECONCILED' }
  if (status !== 'SENT' && !pernaChegou) return { row: {}, erro: 'ARRIVED/RECONCILED exigem a perna da chegada' }
  const covers = Array.isArray(t.covers) ? t.covers.filter((c: any) => c && c.app && c.table && c.id).map((c: any) => ({ app: String(c.app).toUpperCase(), table: String(c.table), id: String(c.id) })) : undefined
  const row: Record<string, unknown> = {
    direction, via: t.via ? String(t.via).toUpperCase().slice(0, 40) : null,
    sent_on, sent_amount, sent_currency, sent_receipts: urls(t.sent_receipts),
    arrived_on, arrived_amount, arrived_currency, arrived_receipts: urls(t.arrived_receipts),
    description: t.description ? String(t.description).slice(0, 1000) : null, status,
    fx_diff_usd: num(t.fx_diff_usd) ?? 0, needs_review: !!t.needs_review, updated_at: new Date().toISOString(),
  }
  if (covers) row.covers = covers
  if (t.bank_transaction_id !== undefined) row.bank_transaction_id = t.bank_transaction_id ? String(t.bank_transaction_id) : null
  return { row }
}

export async function GET(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return falha(401, 'unauthorized')
  const d = db(); if (!d) return falha(503, 'chave de serviço fora do ambiente')
  const { data, error } = await d.from('intercompany_transfers').select('*').order('arrived_on', { ascending: false, nullsFirst: false }).order('sent_on', { ascending: false, nullsFirst: false })
  if (error) return falha(502, error.message)
  return NextResponse.json({ ok: true, transfers: data })
}

export async function POST(req: NextRequest) {
  if (!readKeyOk(req) && !(await requireUser(req))) return falha(401, 'unauthorized')
  const d = db(); if (!d) return falha(503, 'chave de serviço fora do ambiente')
  const b = await req.json().catch(() => null)
  if (!b || !b.transfer) return falha(400, 'POST { action, transfer }')
  const { row, erro } = limpar(b.transfer)
  if (erro) return falha(400, erro)
  if (b.action === 'create') {
    const dia = String(row.arrived_on || row.sent_on)
    const code = b.transfer.code ? String(b.transfer.code).slice(0, 60) : `TR-${dia}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const { data, error } = await d.from('intercompany_transfers').insert([{ ...row, code, legacy: {} }]).select('*').single()
    if (error) return falha(502, error.message)
    await d.from('data_fixes').insert([{ check_key: 'intercompany-transfers', table_name: 'intercompany_transfers', row_id: data.id, field: '(criada)', old_value: null, new_value: JSON.stringify(row), label: `${code} · ${row.direction} · ${row.description || ''}`.slice(0, 300) }])
    return NextResponse.json({ ok: true, transfer: data })
  }
  if (b.action === 'update') {
    const id = String(b.transfer.id || '')
    if (!id) return falha(400, 'update precisa de id')
    const { data: antes, error: e0 } = await d.from('intercompany_transfers').select('*').eq('id', id).single()
    if (e0 || !antes) return falha(404, 'transferência não encontrada')
    const { data, error } = await d.from('intercompany_transfers').update(row).eq('id', id).select('*').single()
    if (error) return falha(502, error.message)
    const mudou = Object.keys(row).filter(k => k !== 'updated_at' && JSON.stringify((antes as any)[k] ?? null) !== JSON.stringify((row as any)[k] ?? null))
    if (mudou.length) await d.from('data_fixes').insert(mudou.map(k => ({ check_key: 'intercompany-transfers', table_name: 'intercompany_transfers', row_id: id, field: k, old_value: JSON.stringify((antes as any)[k] ?? null), new_value: JSON.stringify((row as any)[k] ?? null), label: `${antes.code}: ${k}` })))
    return NextResponse.json({ ok: true, transfer: data })
  }
  return falha(400, 'action: create ou update')
}
