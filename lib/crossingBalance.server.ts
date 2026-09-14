// ════════════════════════════════════════════════════════════════════════════
// lib/crossingBalance.server.ts · 14/set/2026 — QUANTO O BR DEVE AO US: A LEITURA (SÓ SERVIDOR)
//
// A conta mora em lib/crossingBalance.ts (computeCrossingBalance, a régua da manchete do motor). Aqui só se LÊ:
// as shopping invoices dos dois lados, com a chave de serviço dos dois bancos — RLS escondendo linha viraria
// saldo errado e calado (memory/rls-pending.md: anon devolve [] mudo). Nada escreve.
//
// UM NÚMERO, TRÊS TELAS: GZ-FLOW (app/gz-flow), Balanço (app/adm/financials/balance) e o card «Conta corrente GZ28BR»
// do Data Checker leem a MESMA função pela rota GET /api/crossing/balance (portão requireUser). Chave de serviço
// nunca vai para o navegador.
//
// FALHA FECHA: leitura que falha, lista que não volta ou chave ausente lança erro — nunca devolve saldo parcial.
// Tela sem número diz que não leu; tela com número errado ninguém percebe.
//
// DOIS ESQUEMAS: no US as tabelas são invoice_items / invoice_incomes (onda 2, 11/set); no BR continuam
// invoice_parts / invoice_payments.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { computeCrossingBalance, pendingIds, US_CLIENT_GZ28BR, BR_CLIENT_GZ28US, type CrossingBalance, type CrossingRows } from '@/lib/crossingBalance'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>
export type CrossingDbs = { us: SupabaseClient; br: SupabaseClient }

export class CrossingReadError extends Error {
  kind: 'service-key' | 'db'
  constructor(kind: CrossingReadError['kind'], message: string) { super(message); this.name = 'CrossingReadError'; this.kind = kind }
}

/** Os dois bancos com chave de serviço — sem fallback para a anon (bankDb() cai na anon e o RLS devolveria [] calado). */
export function crossingDbs(): CrossingDbs {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new CrossingReadError('service-key', 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY fora do ambiente do servidor — o banco do US não pode ser lido.')
  const br = supabaseBRService()
  if (!br) throw new CrossingReadError('service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY fora do ambiente do servidor — o banco do BR não pode ser lido.')
  return { us: createClient(url, key, { auth: { persistSession: false } }), br }
}

// Paginado e ORDENADO POR id (a ordem de soma do motor). Leitura que falha não é lista vazia.
async function readAll(db: SupabaseClient, label: string, table: string, columns: string, filter: (q: any) => any): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order('id').range(from, from + 999)
    if (error) throw new CrossingReadError('db', `Falha ao ler ${label}.${table}: ${error.message}`)
    if (!Array.isArray(data)) throw new CrossingReadError('db', `A leitura de ${label}.${table} voltou sem lista.`)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}
// Linhas das invoices dadas, em blocos de 100 ids; o resultado volta reordenado por id, como numa leitura só.
async function readByInvoice(db: SupabaseClient, label: string, table: string, columns: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += 100) out.push(...await readAll(db, label, table, columns, q => q.in('invoice_id', ids.slice(i, i + 100))))
  return out.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
}
async function readByIds(db: SupabaseClient, label: string, table: string, columns: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = []
  for (let i = 0; i < ids.length; i += 100) out.push(...await readAll(db, label, table, columns, q => q.in('id', ids.slice(i, i + 100))))
  return out
}

/** Lê as shopping invoices dos dois bancos. Só leitura. */
export async function readCrossingRows(dbs: CrossingDbs): Promise<CrossingRows> {
  const readAt = new Date().toISOString()
  const [usInvoices, brInvoices] = await Promise.all([
    readAll(dbs.us, 'US', 'invoices', 'id, invoice_code, client_id, ride_id, is_quote, service, florida_taxes, global_discount, live_status', q => q.eq('client_id', US_CLIENT_GZ28BR)),
    readAll(dbs.br, 'BR', 'invoices', 'id, invoice_code, client_id, ride_id, is_quote, usd_rate, service, florida_taxes, global_discount', q => q.eq('client_id', BR_CLIENT_GZ28US)),
  ])
  const usIds = usInvoices.map(i => i.id), brIds = brInvoices.map(i => i.id)
  const usRideIds = [...new Set(usInvoices.map(i => i.ride_id).filter(Boolean))] as string[]
  const brRideIds = [...new Set(brInvoices.map(i => i.ride_id).filter(Boolean))] as string[]
  const pend = pendingIds()
  const [usItems, usServices, usIncomes, usRides, brParts, brServices, brPayments, brRides, usOrigins, brExpenses] = await Promise.all([
    // cancel_status: o item estornado sai da conta (lib/estorno.ts). A coluna nasce na MIGRATION_invoice_items_cancel_status.sql.
    readByInvoice(dbs.us, 'US', 'invoice_items', 'id, invoice_id, description, unit_price, quantity, cancel_status', usIds),
    readByInvoice(dbs.us, 'US', 'invoice_services', 'id, invoice_id, description, price', usIds),
    readByInvoice(dbs.us, 'US', 'invoice_incomes', 'id, invoice_id, amount, payment_date, paid_at, description', usIds),
    readByIds(dbs.us, 'US', 'rides', 'id, project_code, project_name', usRideIds),
    readByInvoice(dbs.br, 'BR', 'invoice_parts', 'id, invoice_id, description, unit_price, quantity, unit_price_usd', brIds),
    readByInvoice(dbs.br, 'BR', 'invoice_services', 'id, invoice_id, description, price', brIds),
    readByInvoice(dbs.br, 'BR', 'invoice_payments', 'id, invoice_id, amount, amount_usd, payment_date, paid_at, description', brIds),
    readByIds(dbs.br, 'BR', 'rides', 'id, project_code, project_name', brRideIds),
    // DECISÕES PENDENTES (fora da conta): as invoices de origem no US e as linhas do BR em jogo — us_expense_id/mirror_src dizem se já ligaram.
    readByIds(dbs.us, 'US', 'invoices', 'id, invoice_code, client_id, ride_id', pend.usOrigins),
    readByIds(dbs.br, 'BR', 'invoice_expenses', 'id, invoice_id, item, price, quantity, tax, extra, amount_usd, us_expense_id, mirror_src', pend.brExpenses),
  ])
  const brExpenseInvoices = await readByIds(dbs.br, 'BR', 'invoices', 'id, invoice_code, client_id, ride_id, usd_rate', [...new Set(brExpenses.map(e => e.invoice_id).filter(Boolean))] as string[])
  return {
    readAt,
    us: { invoices: usInvoices, rides: usRides, items: usItems, services: usServices, incomes: usIncomes },
    br: { invoices: brInvoices, rides: brRides, parts: brParts, services: brServices, payments: brPayments },
    pending: { usOrigins, brExpenses, brExpenseInvoices },
  }
}

/** QUANTO O BR DEVE AO US — o número único das três telas. */
export async function crossingBalance(dbs: CrossingDbs = crossingDbs()): Promise<CrossingBalance> {
  return computeCrossingBalance(await readCrossingRows(dbs))
}
