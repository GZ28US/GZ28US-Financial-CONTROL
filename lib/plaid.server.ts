// PLAID — a ponte com o banco (ordem do Márcio, 18/ago/2026): o app lê a Regions
// SOZINHO, sem humano. O Plaid é o agregador (a Regions não tem API pública); a
// conexão é OAuth no nome da LLC, o token mora em bank_accounts (RLS trancado —
// só a service key enxerga) e TODA transação desagua em bank_transactions, o
// UNIVERSO contra o qual as despesas do app são conferidas.
//
// Modelo: bank_accounts = UMA linha por CONEXÃO (Item do Plaid). Uma conexão
// Regions pode carregar conta corrente + cartão juntos — as sub-contas ficam no
// jsonb `accounts` (plaid_account_id → nome/máscara/tipo) e cada transação grava
// o seu plaid_account_id. Sync por CURSOR (/transactions/sync): idempotente —
// webhook e cron podem rodar juntos que nada duplica; o dedupe físico é o UNIQUE
// em bank_transactions.plaid_id.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const PLAID_BASE: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
}

export function plaidEnv(): 'sandbox' | 'production' {
  return process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox'
}

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}

// Chamada crua à API do Plaid — client_id/secret vão no corpo (padrão deles).
export async function plaid(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${PLAID_BASE[plaidEnv()]}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Plaid ${endpoint}: ${data.error_code || res.status} — ${String(data.error_message || '').slice(0, 200)}`)
  }
  return data
}

export function bankDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  )
}

type BankItem = { id: string; plaid_access_token: string; sync_cursor: string | null }

// Sincroniza UMA conexão: puxa added/modified/removed desde o cursor salvo e aplica
// em bank_transactions. O amount segue o Plaid: POSITIVO = dinheiro SAINDO da conta.
export async function syncBankItem(db: SupabaseClient, item: BankItem): Promise<{ added: number; modified: number; removed: number }> {
  let cursor = item.sync_cursor || undefined
  let added = 0, modified = 0, removed = 0
  // Pagina com has_more — itera até esvaziar (30 páginas ≈ 7.500 transações, folga).
  for (let page = 0; page < 30; page++) {
    const r = await plaid('/transactions/sync', {
      access_token: item.plaid_access_token,
      cursor,
      count: 250,
    })
    for (const t of r.added || []) {
      const { error } = await db.from('bank_transactions').upsert([{
        item_id: item.id,
        plaid_account_id: t.account_id || null,
        plaid_id: t.transaction_id,
        pending: Boolean(t.pending),
        pending_plaid_id: t.pending_transaction_id || null,
        date: t.date,
        amount: t.amount,
        name: t.name || null,
        merchant: t.merchant_name || null,
        category: t.personal_finance_category?.primary || (Array.isArray(t.category) ? t.category[0] : null) || null,
        check_number: t.check_number || null,
        raw: t,
      }], { onConflict: 'plaid_id' })
      if (!error) added++
    }
    for (const t of r.modified || []) {
      const { error } = await db.from('bank_transactions').update({
        pending: Boolean(t.pending),
        date: t.date,
        amount: t.amount,
        name: t.name || null,
        merchant: t.merchant_name || null,
        raw: t,
      }).eq('plaid_id', t.transaction_id)
      if (!error) modified++
    }
    for (const t of r.removed || []) {
      // Removida = quase sempre a PENDING que virou posted com outro id (a linha nova
      // já chegou no added). NEW some sem dó; linha já casada/lançada NUNCA some —
      // fica marcada pra auditoria, porque apagar seria sumir com dinheiro tratado.
      const { data: old } = await db.from('bank_transactions').select('id, match_status').eq('plaid_id', t.transaction_id).maybeSingle()
      if (!old) continue
      if (old.match_status === 'NEW') {
        await db.from('bank_transactions').delete().eq('id', old.id)
      } else {
        await db.from('bank_transactions').update({ match_status: 'REMOVED', matched_note: 'removida pelo banco (pending→posted)' }).eq('id', old.id)
      }
      removed++
    }
    cursor = r.next_cursor
    if (!r.has_more) break
  }
  await db.from('bank_accounts').update({ sync_cursor: cursor || null, last_synced_at: new Date().toISOString() }).eq('id', item.id)
  return { added, modified, removed }
}

// SALDO DO DIA (BL v0.2.0): depois do sync, o saldo atual de cada sub-conta vai
// pra cash_balances (source PLAID) — é o "caixa" do Balanço, sem lançamento
// manual. Uma chamada por dia por conta (a /accounts/balance/get é cobrada):
// se já existe linha PLAID de hoje, não chama. Chave da conta = display_name
// da conexão, a mesma que os extratos importados usam.
// SALDO REAL, direto do banco via Plaid (/accounts/balance/get) — nunca "calculado".
// current = o que o banco diz que tem; available = descontando o que ainda está
// pendente (cartão ainda não postou). Caixa = só depósito; cartão de crédito
// (saldo = dívida) SUBTRAI. (João, 22/ago: "quero o saldo REAL do banco ali.")
export type LiveBalance = { current: number; available: number; as_of: string; realtime: boolean; accounts: { name: string; mask: string | null; type: string; current: number; available: number | null }[] }
// Custo (João, 22/ago): /accounts/balance/get força o banco a responder AGORA e é
// COBRADO por chamada (produto Balance). /accounts/get é grátis (vem com
// Transactions) e devolve o saldo da última atualização do item pelo Plaid —
// geralmente do mesmo dia. Regra: só pede o pago quando wantRealtime = true
// (1×/dia no primeiro sync + botão CONSULTAR O BANCO AGORA, teto 3/dia); o resto
// usa o grátis. Sem o produto Balance habilitado (INVALID_PRODUCT) cai no grátis.
export async function liveBalance(item: { plaid_access_token: string }, wantRealtime = false): Promise<LiveBalance> {
  let realtime = false
  let r: any
  if (wantRealtime) {
    try { r = await plaid('/accounts/balance/get', { access_token: item.plaid_access_token }); realtime = true }
    catch (e) { if (!/INVALID_PRODUCT|not authorized to access the following products/i.test(String(e))) throw e }
  }
  if (!r) r = await plaid('/accounts/get', { access_token: item.plaid_access_token })
  const accounts = (r.accounts || []).map((a: any) => ({
    name: a.name || a.official_name || 'conta', mask: a.mask || null, type: String(a.type || ''),
    current: Number(a.balances?.current) || 0, available: a.balances?.available == null ? null : Number(a.balances.available),
  }))
  const sign = (t: string) => (t === 'depository' ? 1 : t === 'credit' ? -1 : 0)
  const current = accounts.reduce((s: number, a: any) => s + sign(a.type) * a.current, 0)
  const available = accounts.reduce((s: number, a: any) => s + sign(a.type) * (a.available ?? a.current), 0)
  return { current: Math.round(current * 100) / 100, available: Math.round(available * 100) / 100, as_of: new Date().toISOString(), realtime, accounts }
}

// Grava o saldo do dia em cash_balances (source PLAID). Sobrescreve só linha
// PLAID do mesmo dia; linha MANUAL (extrato/lançamento) nunca é tocada.
// Devolve o que gravou ou o erro — nada de engolir falha (22/ago: o saldo do
// Bank Link ficou meses mostrando o extrato de junho porque esta função falhava
// em silêncio).
// mode: 'daily' = pago só se ainda não há foto paga de hoje (1×/dia), senão grátis;
//       'free'  = nunca paga;  'paid' = paga (botão), respeitando o teto do chamador.
export async function syncBalances(db: SupabaseClient, item: { id: string; plaid_access_token: string; display_name: string | null; institution: string }, mode: 'daily' | 'free' | 'paid' = 'daily'): Promise<{ written: boolean; balance?: LiveBalance; skipped?: string; error?: string }> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const account = item.display_name || item.institution
  try {
    const { data: existing } = await db.from('cash_balances').select('id, source, notes').eq('account', account).eq('balance_date', today).maybeSingle()
    if (existing && existing.source !== 'PLAID') return { written: false, skipped: 'lançamento manual de hoje tem prioridade' }
    const paidToday = !!existing && /tempo real/.test(existing.notes || '')
    const want = mode === 'paid' || (mode === 'daily' && !paidToday)
    const balance = await liveBalance(item, want)
    // Foto paga de hoje não é sobrescrita por leitura grátis (a paga é a melhor do dia).
    if (paidToday && !balance.realtime) return { written: false, balance, skipped: 'foto paga de hoje mantida' }
    const row = { balance_date: today, account, balance: balance.current, source: 'PLAID', notes: `Plaid ${balance.realtime ? 'tempo real' : 'última atualização'} ${balance.as_of.slice(11, 16)}Z · available ${balance.available} · ` + balance.accounts.map(a => `${a.name}${a.mask ? ' •' + a.mask : ''}: ${a.current}`).join(' · ') }
    const { error } = existing ? await db.from('cash_balances').update(row).eq('id', existing.id) : await db.from('cash_balances').insert(row)
    if (error) return { written: false, balance, error: 'cash_balances: ' + error.message }
    return { written: true, balance }
  } catch (e) {
    return { written: false, error: String((e as Error).message || e).slice(0, 200) }
  }
}

// Sincroniza TODAS as conexões ativas — usada pelo webhook e pelo cron (rede de segurança).
export async function syncAllBankItems(): Promise<Array<Record<string, unknown>>> {
  const db = bankDb()
  const { data: items } = await db.from('bank_accounts').select('*').eq('status', 'ACTIVE')
  const out: Array<Record<string, unknown>> = []
  for (const it of items || []) {
    try {
      const r = await syncBankItem(db, it)
      // Saldo do dia é melhor esforço: falha aqui não derruba o sync das transações.
      const balances = await syncBalances(db, it)
      out.push({ account: it.display_name || it.institution, ...r, balances: balances.written ? 1 : 0, balance_error: balances.error || null, balance_current: balances.balance?.current ?? null })
    } catch (e) {
      const msg = String(e).slice(0, 200)
      // Token vencido (banco força re-auth) não derruba as outras conexões — marca
      // NEEDS_REAUTH e a tela BANK mostra o botão de reconectar.
      if (msg.includes('ITEM_LOGIN_REQUIRED')) {
        await db.from('bank_accounts').update({ status: 'NEEDS_REAUTH' }).eq('id', it.id)
      }
      out.push({ account: it.display_name || it.institution, error: msg })
    }
  }
  return out
}
