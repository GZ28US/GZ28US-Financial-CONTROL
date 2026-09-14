// ════════════════════════════════════════════════════════════════════════════
// lib/crossing.server.ts · 14/set/2026 — O MOTOR DA TRAVESSIA US ⇄ BR (SÓ SERVIDOR)
//
// LEI SAGRADA (Márcio, 13/set/2026 — memory/shopping-invoice-toda-travessia-us-br.md):
//   «TODA E QUALQUER movimentação financeira entre o US e o BR tem que estar nas
//    shopping invoices.» · «Sempre que os recursos PAID FROM & TO entre US e BR são
//    usados, tem que ter a shopping invoice no app da outra.» · «ISSO É SAGRADO»
//
// AS QUATRO DIREÇÕES, E ONDE CADA UMA MORA NO APP DO OUTRO:
//   1. despesa do BR PAID FROM GZ28US ......... US 006.N (cliente 97c4a91e «GZ28 V8 SpeedShop BR Ltda»)
//        a linha do BR JÁ carrega o +10%: despesa US = amount_usd ÷ 1,10; item US = o US$ gravado no BR
//   2. renda do BR PAID TO GZ28US ............. a MESMA 006.N daquela invoice do BR, só a renda (abate)
//   3. despesa do US PAID FROM GZ28BR ......... BR 085.N (cliente 6d4264bc «GZ28 V8 SpeedShop USA LLC»)
//        invoice_expenses → a 085.N da invoice · staff_expenses → uma 085.N por SEASON ·
//        assets / assets_expenses → uma 085.N por MÊS · sem markup
//   4. renda do US PAID TO GZ28BR ............. a MESMA 085.N daquela invoice do US, sem markup
//
// DECISÕES DO DONO QUE ESTE ARQUIVO OBEDECE (14/set/2026):
//   · uma shopping invoice por DOCUMENTO DE ORIGEM, com as duas pernas juntas;
//   · valor gravado em US$ e em R$ PREVALECE sempre e nunca é recalculado. Onde falta, vale a
//     regra do app BR — (cotação oficial do dia do pagamento + R$ 0,20) × 1,0638 de IOF, a mesma
//     do editor do BR (app/rides/[id]/invoices/edit/[invoiceId]/page.tsx do BR, compra em USD
//     escaneada: AwesomeAPI `json/daily/USD-BRL`, campo `bid`) — e o valor é CARIMBADO uma vez;
//   · as 2 linhas de staff sem data (US$ 2.350) são TAXAS de antes de 28/jul, não pagamento: fora.
//
// COMO ELE ANDA:
//   planCrossings() lê os DOIS bancos com a chave de serviço e devolve um DIFF por mirror_key
//   (criar invoice · vincular · criar linha · carimbar · pendente · nada · conflito). Não escreve.
//   applyPlan() refaz o plano na hora, confere a impressão digital de cada chave e só então grava,
//   idempotente: invoice achada por invoices.mirror_key, linha achada por mirror_src. Nunca apaga
//   invoice nem linha com dinheiro ou elo de banco — a única linha que sai é o «Pending balance»
//   em aberto, sem baixa e sem ponteiro. Conflito não grava NADA daquela chave. Falha fecha:
//   a primeira escrita que não confere para tudo. Toda escrita deixa trilha em data_fixes do
//   banco onde aconteceu (check_key 'shopping-invoice-travessia').
//
// DOIS BANCOS, DOIS ESQUEMAS: no US as tabelas se chamam invoice_items / invoice_incomes (onda 2,
// 11/set); no BR continuam invoice_parts / invoice_payments. Todo `br.from(...)` daqui usa o nome
// do BR de propósito.
//
// QUEM CHAMA (14/set/2026, o passo dos ganchos):
//   · os EDITORES dos dois apps, depois do save de uma invoice que cruza — só a chave daquela invoice
//     (US: app/rides/[id]/invoices/edit → /api/crossing; BR: o editor → /api/invoice/crossing do BR →
//     /api/crossing do US, servidor a servidor). Os espelhos velhos (lib/usShoppingMirror.ts do BR e
//     app/api/br-mirror/shopping do US), que apagavam e recriavam item e pendente e recalculavam o R$
//     a cada save, se aposentaram: quem escreve a travessia agora é SÓ este motor;
//   · o cron /api/cron/crossing, de hora em hora, em lotes com relógio (sincronizar()), para o que
//     não passa por tela nenhuma (robôs, Bank Link, folha, assets);
//   · a rota /api/crossing à mão (GET = plano; POST com impressoes = a aplicação conferida).
// TRAVESSIA_PAUSADA=1 no ambiente do US segura as escritas AUTOMÁTICAS (editor e cron); a aplicação à
// mão continua valendo.

import { createHash, randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseBRService } from '@/lib/supabaseBR.server'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>
export type Banco = 'US' | 'BR'
export type Direcao = 1 | 2 | 3 | 4
export type Bancos = { us: SupabaseClient; br: SupabaseClient }

export const US_CLIENTE_GZ28BR = '97c4a91e-d1c2-48ca-9d05-8662fe324f27' // «GZ28 V8 SpeedShop BR Ltda» (client_number 6 no US)
export const BR_CLIENTE_GZ28US = '6d4264bc-9357-4190-94d8-bdc3a254d5bd' // «GZ28 V8 SpeedShop USA LLC» (client_number 85 no BR)
export const TRILHA = 'shopping-invoice-travessia'
const MARGEM_US = 1.10      // só na direção 1 (lei do 10% US)
// MARKUP POR LINHA (Márcio, 14/set/2026: o dinheiro da venda da MasterPiece, BR.484, caiu na Regions e o US gastou nos carros do BR —
// esses gastos atravessam SEM os 10%). BR invoice_expenses.us_markup_pct: vazio = a lei do 10% US; 0 = custo exato; outro = aquele %.
const markupDe = (s: Row): number => { const v = s?.us_markup_pct; return v == null || String(v) === '' ? MARGEM_US : 1 + num(v) / 100 }
const SPREAD = 0.20         // R$ sobre a cotação — o usd_rate do app BR
const IOF = 1.0638          // 6,38% de IOF do cartão internacional — a regra do editor do BR
const TOL = 0.02            // US$: arredondamento de centavo dos dois lados
const ALVO = '$alvo'        // o id da invoice-alvo, resolvido na hora de gravar

// OS CASOS FORA DESTE PASSO (14/set/2026). Ficam como CONFLITO com o motivo escrito — o motor não
// grava nada neles até o dono decidir. As regras gerais já travariam quase todos; a lista deixa o
// motivo legível. Chave = código da invoice NO BR.
export const FORA_DE_ESCOPO_BR: Readonly<Record<string, string>> = {
  'BR.496.1': 'classe (c) — 006.2 + 006.16 Armageddon: duas 006.N para a mesma BR (fora deste passo)',
}

// A MESMA TRAVA DO LADO DAS 085.N — chave = código da invoice NO US (14/set/2026). As regras gerais já
// travam a US.003.1 (a linha «kit motor» da 085.6 não tem origem no US); a lista deixa a trava de pé
// mesmo que alguém mexa nas linhas antes de o dono decidir.
export const FORA_DE_ESCOPO_US: Readonly<Record<string, string>> = {
  'US.003.1': '085.6 «kit motor» (US$ 5.606,13 / R$ 31.114,02) sem origem no US — travada até o Márcio decidir (14/set)',
}

// RENDA DO BR COM O US$ DECIDIDO PELO DONO (14/set/2026, noite). Chave = id da linha em invoice_payments
// do BR. Vale ANTES da usd_rate da invoice porque a usd_rate de uma invoice do BR que não está CLOSED é
// regravada com o dólar do dia a cada save do editor de lá — o número decidido é o que bate com o banco.
export const RENDA_BR_DECIDIDA: Readonly<Record<string, { usd: number; motivo: string }>> = {
  'f3c7943c-2c8f-4972-ad69-8ba77ec8f0bb': { usd: 1402.00, motivo: 'BR.537.1 New Times Agency LLC — decisão do Márcio 14/set: vale a usd_rate gravada na invoice (R$ 7.510,79 ÷ 5,3572 = US$ 1.402,00), que bate com a linha da Regions' },
}

// CHAVES SEGURAS (auditoria da noite de 14/set/2026). Prefixo da mirror_key → o motivo. A chave inteira
// fica em CONFLITO com o motivo escrito — o plano mostra os números que ela gravaria (manchete.bloqueadas),
// e nada é escrito até o dono responder. A resposta do Márcio vira a remoção de UMA linha daqui.
export const CHAVES_SEGURAS: Readonly<Record<string, string>> = {
  'US:invoice:15b95131': 'US.009.1 Poltergeist → 085.1: possível contagem dobrada com a US.007.1 Panther — segura até o Márcio responder (14/set)',
  'US:invoice:828e9c2f': 'US.007.1 Panther (ainda sem 085.N): possível contagem dobrada com a US.009.1 Poltergeist — segura até o Márcio responder (14/set)',
}
const chaveSegura = (key: string): string | null => { for (const [p, motivo] of Object.entries(CHAVES_SEGURAS)) if (key.startsWith(p)) return motivo; return null }

// AS DUAS TAXAS SEM DATA DA FOLHA (decisão de 14/set/2026): «Labor» US$ 100 (Marcelo Vanzela, US.002) e
// «Monthly Payments» US$ 2.250 (Jeferson Ferreira, US.002) são a TAXA de antes de 28/jul, não pagamento —
// ficam fora. Qualquer OUTRA linha de folha PAID FROM GZ28BR sem data nenhuma trava a season dela
// («sem data»), em vez de sumir calada sob o rótulo de taxa.
const TAXAS_SEM_DATA = new Set(['be59504a-de77-4347-9e23-fb1cae7d59de', 'e50b30c7-b1da-4210-a4c7-3899f02f4e60'])

// ── pequenas réguas ─────────────────────────────────────────────────────────
const num = (v: unknown) => parseFloat(String(v ?? '')) || 0
const r2 = (n: number) => Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000
const YMD = /^\d{4}-\d{2}-\d{2}$/
const ymd = (v: unknown): string | null => { const s = String(v ?? '').slice(0, 10); return YMD.test(s) ? s : null }
// Dia de um timestamptz NO FUSO DO ASSUNTO (lei do relógio: nunca o dia UTC cru).
function diaEm(ts: unknown, timeZone: string): string | null {
  if (!ts) return null
  const d = new Date(String(ts))
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
const hojeEm = (tz: string) => diaEm(new Date().toISOString(), tz) as string
function addDias(d: string, n: number): string { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const perto = (a: number | null, b: number | null, tol = TOL) => a != null && b != null && Math.abs(a - b) <= tol + 1e-9

// A mesma régua de lib/financials.ts (whoPaid): PAID FROM manda, SOURCE legado cai atrás, REGIONS = GZ28US.
// Copiada aqui de propósito: financials.ts importa o cliente de navegador.
const empresa = (v: unknown) => { const s = String(v ?? '').trim().toUpperCase(); if (!s) return null; if (s === 'REGIONS') return 'GZ28US'; return s === 'GZ28US' || s === 'GZ28BR' ? s : null }
export const quemPagou = (r: Row) => empresa(r.paid_from) || empresa(r.source)
// O marcador «(atribuída · Bank Link)» é trilha do app US — nunca atravessa.
const limpa = (t: unknown) => String(t ?? '').replace(/\s*\((atribuída|a atribuir) · Bank Link\)/g, '').trim()
const chaveTexto = (t: unknown) => limpa(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)
const FL_TAX = /florida\s*tax/i

// US invoice_expenses: preço × qtd + tax + extra (lib/financials.ts · expLine).
const custoUS = (e: Row) => num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)
// BR invoice_expenses em US$: amount_usd é UNITÁRIO; tax/extra são R$ TOTAIS da linha, convertidos
// pelo fator da própria linha (price ÷ amount_usd) — o fator gravado prevalece sobre o da invoice.
function fatorBR(e: Row, taxaInvoice: unknown): number {
  const au = num(e.amount_usd), p = num(e.price)
  return au > 0 && p > 0 ? p / au : num(taxaInvoice)
}
function usdBR(e: Row, taxaInvoice: unknown): number | null {
  if (e.amount_usd == null || String(e.amount_usd) === '') return null
  const q = num(e.quantity) || 1, te = num(e.tax) + num(e.extra), f = fatorBR(e, taxaInvoice)
  if (te && !(f > 0)) return null
  return num(e.amount_usd) * q + (te ? te / f : 0)
}
const brlBR = (e: Row) => num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)
const linhaItem = (i: Row) => num(i.unit_price) * (num(i.quantity) || 1)

export class ErroTravessia extends Error {
  kind: 'bad-request' | 'service-key' | 'schema' | 'conflict' | 'db' | 'rate'
  constructor(kind: ErroTravessia['kind'], message: string) { super(message); this.name = 'ErroTravessia'; this.kind = kind }
}

// ── OS BANCOS DO SERVIDOR ───────────────────────────────────────────────────
export function bancosDoServidor(): Bancos | { erro: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { erro: 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY fora do ambiente do servidor do US — o banco do US não pode ser lido.' }
  const br = supabaseBRService()
  if (!br) return { erro: 'SUPABASE_BR_SERVICE_ROLE_KEY fora do ambiente do servidor do US — o banco do BR não pode ser lido.' }
  return { us: createClient(url, key, { auth: { persistSession: false } }), br }
}

// ════════════════════════════════════════════════════════════════════════════
// A FOTO DOS DOIS BANCOS
// ════════════════════════════════════════════════════════════════════════════

// As colunas que as migrations da travessia criam. Enquanto não existirem o motor PLANEJA (lê sem
// elas) e o applyPlan RECUSA — gravar sem mirror_key/mirror_src perderia a idempotência.
// crossing_locks (revisão 14/set/2026, MIGRATION_travessia_trava.sql): a trava por chave — sem ela
// nenhuma escrita sai, porque duas rodadas da mesma chave se entrelaçariam.
const COLUNAS_NOVAS: Record<Banco, [string, string][]> = {
  US: [['invoices', 'mirror_key'], ['invoice_expenses', 'mirror_src'], ['invoice_items', 'mirror_src'], ['invoice_incomes', 'mirror_src'], ['invoice_incomes', 'br_payment_id'], ['crossing_locks', 'mirror_key']],
  BR: [['invoices', 'mirror_key'], ['invoice_expenses', 'mirror_src'], ['invoice_parts', 'mirror_src'], ['invoice_payments', 'mirror_src'], ['invoice_payments', 'amount_usd'], ['invoice_payments', 'us_income_id'], ['invoice_expenses', 'us_markup_pct']],
}

export type Foto = {
  lida_em: string
  faltando: { US: string[]; BR: string[] }
  us: { invoices: Row[]; rides: Row[]; despesas: Row[]; itens: Row[]; rendas: Row[]; servicos: Row[]; assets: Row[]; assetsExp: Row[]; staffExp: Row[]; seasons: Row[]; staff: Row[]; semOpcao: { tabela: string; linha: Row }[]; ponteirosBanco: Set<string> }
  br: { clientes: Row[]; invoices: Row[]; rides: Row[]; despesas: Row[]; partes: Row[]; pagamentos: Row[]; servicos: Row[] }
}

async function temColuna(db: SupabaseClient, tabela: string, coluna: string): Promise<boolean> {
  const { error } = await db.from(tabela).select(coluna).limit(1)
  if (!error) return true
  // Coluna OU tabela que ainda não existe (42703, 42P01, PGRST204/205 «could not find … in the schema cache»).
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(String(error.code)) || /does not exist|could not find/i.test(error.message)) return false
  throw new ErroTravessia('db', `Falha ao conferir a coluna ${tabela}.${coluna}: ${error.message}`)
}

async function lerTudo(db: SupabaseClient, rotulo: string, tabela: string, colunas: string, filtro?: (q: any) => any): Promise<Row[]> {
  const out: Row[] = []
  for (let de = 0; ; de += 1000) {
    let q: any = db.from(tabela).select(colunas).order('id').range(de, de + 999)
    if (filtro) q = filtro(q)
    const { data, error } = await q
    // Leitura que falha NÃO é lista vazia: o plano inteiro para aqui.
    if (error) throw new ErroTravessia('db', `Falha ao ler ${rotulo}.${tabela}: ${error.message}`)
    if (!Array.isArray(data)) throw new ErroTravessia('db', `A leitura de ${rotulo}.${tabela} voltou sem lista.`)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

export async function lerFoto(b: Bancos): Promise<Foto> {
  const faltando: Foto['faltando'] = { US: [], BR: [] }
  const extra: Record<string, string> = {}
  for (const banco of ['US', 'BR'] as Banco[]) {
    const db = banco === 'US' ? b.us : b.br
    for (const [t, c] of COLUNAS_NOVAS[banco]) {
      if (await temColuna(db, t, c)) extra[`${banco}.${t}`] = (extra[`${banco}.${t}`] || '') + ', ' + c
      else faltando[banco].push(`${t}.${c}`)
    }
  }
  const x = (k: string) => extra[k] || ''
  const GZBR = 'paid_from.ilike.gz28br,source.ilike.gz28br,paid_to.ilike.gz28br'
  const [
    uInv, uRides, uExp, uItens, uRendas, uServ, uAssets, uAssetsExp, uStaffExp, uSeasons, uStaff, uInputs, uInventory, uFixed, uBanco,
    bCli, bInv, bRides, bExp, bPartes, bPag, bServ,
  ] = await Promise.all([
    lerTudo(b.us, 'US', 'invoices', 'id, invoice_code, client_id, ride_id, is_quote, br_invoice_id, service, florida_taxes, import_margin, global_discount, origin, live_status, hiring_date, created_at' + x('US.invoices')),
    lerTudo(b.us, 'US', 'rides', 'id, project_code, project_name'),
    lerTudo(b.us, 'US', 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, payment_date, expense_date, paid_from, paid_to, source, order_number, part_number, position, br_expense_id, created_at' + x('US.invoice_expenses')),
    lerTudo(b.us, 'US', 'invoice_items', 'id, invoice_id, description, unit_price, quantity, base_cost, position, payment_date' + x('US.invoice_items')),
    lerTudo(b.us, 'US', 'invoice_incomes', 'id, invoice_id, amount, amount_brl, payment_date, paid_at, paid_to, description, source' + x('US.invoice_incomes')),
    lerTudo(b.us, 'US', 'invoice_services', 'id, invoice_id, price'),
    lerTudo(b.us, 'US', 'assets', 'id, description, quantity, unit_price, purchase_date, payment_date, supplier, source, paid_from, paid_to, order_number'),
    lerTudo(b.us, 'US', 'assets_expenses', 'id, good_id, description, amount, expense_date, payment_date, supplier, source, paid_from, paid_to, order_number'),
    lerTudo(b.us, 'US', 'staff_expenses', 'id, season_id, type, amount, amount_brl, expense_date, payment_date, description, supplier, source, origin, paid_from, paid_to, order_number'),
    lerTudo(b.us, 'US', 'seasons', 'id, season_code, staff_id, date_entry'),
    lerTudo(b.us, 'US', 'staff', 'id, name'),
    lerTudo(b.us, 'US', 'inputs', 'id, description, unit_price, quantity, purchase_date, paid_from, paid_to, source', q => q.or(GZBR)),
    lerTudo(b.us, 'US', 'inventory', 'id, description, unit_price, quantity, purchase_date, paid_from, paid_to, source', q => q.or(GZBR)),
    lerTudo(b.us, 'US', 'fixed_cost_expenses', 'id, description, amount, payment_date, paid_from, paid_to, source', q => q.or(GZBR)),
    lerTudo(b.us, 'US', 'bank_transactions', 'id, match_status, matched_table, matched_id, matched_members', q => q.not('matched_table', 'is', null)),
    lerTudo(b.br, 'BR', 'clients', 'id, client_number, name, is_quote'),
    lerTudo(b.br, 'BR', 'invoices', 'id, invoice_code, client_id, ride_id, is_quote, us_invoice_id, usd_rate, service, florida_taxes, import_margin, global_discount, hiring_date, created_at' + x('BR.invoices')),
    lerTudo(b.br, 'BR', 'rides', 'id, project_code, project_name'),
    lerTudo(b.br, 'BR', 'invoice_expenses', 'id, invoice_id, item, supplier, price, quantity, tax, extra, amount_usd, payment_date, expense_date, due_date, paid_from, paid_to, source, order_number, part_number, position, us_expense_id' + x('BR.invoice_expenses')),
    lerTudo(b.br, 'BR', 'invoice_parts', 'id, invoice_id, description, unit_price, quantity, base_cost, unit_price_usd, position, payment_date' + x('BR.invoice_parts')),
    lerTudo(b.br, 'BR', 'invoice_payments', 'id, invoice_id, amount, payment_date, paid_at, paid_to, paid_from, description, source' + x('BR.invoice_payments')),
    lerTudo(b.br, 'BR', 'invoice_services', 'id, invoice_id, price'),
  ])
  const ponteirosBanco = new Set<string>()
  for (const t of uBanco) {
    if (t.match_status === 'REMOVED') continue
    if (t.matched_table && t.matched_id) ponteirosBanco.add(`${t.matched_table}:${t.matched_id}`)
    for (const m of Array.isArray(t.matched_members) ? t.matched_members : []) if (m?.table && m?.id) ponteirosBanco.add(`${m.table}:${m.id}`)
  }
  return {
    lida_em: new Date().toISOString(),
    faltando,
    us: {
      invoices: uInv, rides: uRides, despesas: uExp, itens: uItens, rendas: uRendas, servicos: uServ, assets: uAssets, assetsExp: uAssetsExp,
      staffExp: uStaffExp, seasons: uSeasons, staff: uStaff, ponteirosBanco,
      semOpcao: [...uInputs.map(l => ({ tabela: 'inputs', linha: l })), ...uInventory.map(l => ({ tabela: 'inventory', linha: l })), ...uFixed.map(l => ({ tabela: 'fixed_cost_expenses', linha: l }))],
    },
    br: { clientes: bCli, invoices: bInv, rides: bRides, despesas: bExp, partes: bPartes, pagamentos: bPag, servicos: bServ },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// O CÂMBIO — A REGRA DO APP BR
// ════════════════════════════════════════════════════════════════════════════
// (bid da AwesomeAPI no dia do pagamento + R$ 0,20) × 1,0638. Fim de semana e feriado não têm
// pregão: vale o último bid ATÉ aquele dia (nunca um posterior), olhando no máximo 10 dias para
// trás. Sem bid = sem número: a chave vira conflito, nunca um câmbio inventado.
// `lidos` = todo dia coberto por uma resposta INTEIRA da AwesomeAPI (com ou sem pregão). O recuo de fim de
// semana/feriado só atravessa dia LIDO: dia que ninguém leu não é feriado, é buraco — sem número.
export type Cotacoes = { bids: Map<string, number>; falha: string | null; lidos?: Set<string> }
const cacheBid = new Map<string, number>()   // bid de dia FECHADO (o de hoje ainda muda)
const cacheLido = new Set<string>()          // dia FECHADO já coberto por uma resposta inteira

// O CONSERTO DE 14/SET/2026 (auditoria): antes, a busca era pulada sempre que QUALQUER um dos 10 dias
// anteriores já estivesse no cache — num processo que fica de pé (o cron, a função quente da Vercel),
// uma data nova recebia o bid de um dia mais velho. Agora cada data é resolvida no dia EXATO: só está
// resolvida quando, voltando dela até achar pregão, todo dia do caminho já foi lido; o que falta é
// buscado (a faixa [data − 10, data] de cada uma, juntas quando se encostam).
// O BID DIÁRIO GUARDADO NO BANCO (public.fx_usd_brl_daily, 14/set): dia FECHADO nunca muda de cotação, então é lido uma vez
// e fica. bid null = dia lido sem pregão. Em produção a AwesomeAPI devolve HTTP 429 para o IP compartilhado da Vercel: com a
// tabela, o motor só pede à API os dias que ainda faltam (poucos, os mais novos). Ler ou gravar a tabela nunca derruba o plano.
const FX_TABELA = 'fx_usd_brl_daily'
async function lerCotacoesGuardadas(db: SupabaseClient, de: string, ate: string, hoje: string): Promise<void> {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(FX_TABELA).select('dia, bid').gte('dia', de).lte('dia', ate).order('dia').range(from, from + 999)
    if (error || !data) return
    for (const r of data as { dia: string; bid: string | number | null }[]) {
      const dia = String(r.dia).slice(0, 10)
      if (dia >= hoje) continue
      cacheLido.add(dia)
      const bid = parseFloat(String(r.bid ?? '')) || 0
      if (bid > 0) cacheBid.set(dia, bid)
    }
    if (data.length < 1000) return
  }
}
async function guardarCotacoes(db: SupabaseClient, de: string, fim: string, hoje: string, porDia: Map<string, { ts: number; bid: number }>): Promise<void> {
  const linhas: { dia: string; bid: number | null; ts: number | null }[] = []
  for (let x = de; x <= fim && x < hoje; x = addDias(x, 1)) { const v = porDia.get(x); linhas.push({ dia: x, bid: v ? v.bid : null, ts: v ? v.ts : null }) }
  if (linhas.length) await db.from(FX_TABELA).upsert(linhas, { onConflict: 'dia', ignoreDuplicates: true }).then(() => undefined, () => undefined)
}

export async function carregarCotacoes(datas: string[], db?: SupabaseClient): Promise<Cotacoes> {
  const validas = [...new Set(datas.filter(d => YMD.test(d)))].sort()
  const bids = new Map<string, number>()
  const junta = () => ({ bids: new Map([...cacheBid, ...bids]), lidos: new Set(cacheLido) })
  if (!validas.length) return { ...junta(), falha: null }
  const hoje = hojeEm('America/Sao_Paulo')
  if (db) await lerCotacoesGuardadas(db, addDias(validas[0], -10), validas[validas.length - 1], hoje)
  const resolvida = (d: string) => {
    for (let k = 0; k <= 10; k++) {
      const x = addDias(d, -k)
      if (x >= hoje || !cacheLido.has(x)) return false
      if (cacheBid.has(x)) return true
    }
    return true   // 11 dias lidos sem pregão: sem número — buscar de novo não muda isso
  }
  // UMA faixa só, do primeiro dia que falta (−10) ao último: em produção (14/set 10:21) as dezenas de faixas estreitas
  // levaram HTTP 429 da AwesomeAPI e 39 datas ficaram sem cotação. Blocos de 120 dias = ~5 chamadas para o histórico todo.
  const faltam = validas.filter(x => !resolvida(x))
  const faixas: [string, string][] = faltam.length ? [[addDias(faltam[0], -10), faltam[faltam.length - 1]]] : []
  if (faixas.length) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    try {
      for (const [inicio, ate] of faixas) {
        let de = inicio
        while (de <= ate) {
          const fim = addDias(de, 119) < ate ? addDias(de, 119) : ate
          const url = `https://economia.awesomeapi.com.br/json/daily/USD-BRL/200?start_date=${de.replace(/-/g, '')}&end_date=${fim.replace(/-/g, '')}`
          let r = await fetch(url, { cache: 'no-store' })
          // 429 = limite da API gratuita: espera (Retry-After quando vem, senão 2 s, 4 s, 8 s) e tenta de novo — nunca inventa número.
          for (let tentativa = 0; r.status === 429 && tentativa < 3; tentativa++) {
            const pede = Number(r.headers.get('retry-after')) || 0
            await new Promise(ok => setTimeout(ok, Math.min(15_000, pede > 0 ? pede * 1000 : 2000 * 2 ** tentativa)))
            r = await fetch(url, { cache: 'no-store' })
          }
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          await new Promise(ok => setTimeout(ok, 400))   // folga entre blocos: a API gratuita conta por segundo
          const j = await r.json()
          if (!Array.isArray(j)) throw new Error('resposta sem lista')
          // Mais de um registro no mesmo dia: fica o de timestamp mais tarde (o fechamento).
          const porDia = new Map<string, { ts: number; bid: number }>()
          for (const q of j) {
            const ts = Number(q?.timestamp) || 0, bid = parseFloat(q?.bid) || 0
            if (!(ts > 0 && bid > 0)) continue
            const dia = fmt.format(new Date(ts * 1000))
            const ja = porDia.get(dia)
            if (!ja || ts > ja.ts) porDia.set(dia, { ts, bid })
          }
          for (const [dia, v] of porDia) if (dia < hoje) cacheBid.set(dia, v.bid); else bids.set(dia, v.bid)
          if (db) await guardarCotacoes(db, de, fim, hoje, porDia)
          // A resposta inteira chegou: todo dia FECHADO da janela está LIDO (dia sem registro = sem pregão).
          // Hoje não: pregão que ainda não saiu não é feriado — a data de hoje sem bid fica sem número e o
          // cron tenta de novo.
          for (let x = de; x <= fim && x < hoje; x = addDias(x, 1)) cacheLido.add(x)
          de = addDias(fim, 1)
        }
      }
    } catch (e) {
      return { ...junta(), falha: 'AwesomeAPI (json/daily/USD-BRL) não respondeu: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }
  return { ...junta(), falha: null }
}

// O último pregão ATÉ o dia (nunca um posterior), recuando no máximo 10 dias e só por dia LIDO.
function bidAte(cot: Cotacoes, dia: string): { dia: string; bid: number } | null {
  for (let k = 0; k <= 10; k++) {
    const d = addDias(dia, -k), bid = cot.bids.get(d)
    if (bid) return { dia: d, bid }
    if (cot.lidos && !cot.lidos.has(d)) return null
  }
  return null
}
function regraApp(cot: Cotacoes, dia: string | null): { taxa: number; texto: string; usdRate: number } | null {
  if (!dia) return null
  const b = bidAte(cot, dia)
  if (!b) return null
  const taxa = (b.bid + SPREAD) * IOF
  return { taxa, usdRate: r4(b.bid + SPREAD), texto: `(bid ${b.bid} de ${b.dia} + 0,20) × 1,0638 = ${r4(taxa)}` }
}

// ════════════════════════════════════════════════════════════════════════════
// O PLANO
// ════════════════════════════════════════════════════════════════════════════
export type Op =
  | { tipo: 'vincular_invoice'; banco: Banco; id: string; codigo: string; como: 'ponteiro' | 'texto'; rotulo: string }
  | { tipo: 'criar_invoice'; banco: Banco; serie: '006' | '085'; codigo_previsto: string; campos: Row; rotulo: string }
  | { tipo: 'ponteiro_origem'; banco: Banco; tabela: 'invoices'; id: string; campo: 'us_invoice_id' | 'br_invoice_id'; rotulo: string }
  | { tipo: 'vincular_linha'; banco: Banco; tabela: string; id: string; mirror_src: string; elo: { campo: string; valor: string } | null; direcao: Direcao; rotulo: string }
  // guarda: o carimbo só pega se a linha ainda tem estes valores (o valor que o câmbio usou) — atômico.
  | { tipo: 'carimbo'; banco: Banco; tabela: string; id: string; campo: string; valor: number; regra: string; direcao: Direcao; rotulo: string; guarda: Record<string, string | number | null>; confere: Conferencia[] }
  // confere: as linhas de origem (e o que mais a conta usou) relidas antes da primeira escrita da chave.
  | { tipo: 'criar_linha'; banco: Banco; tabela: string; mirror_src: string; campos: Row; usd: number; brl: number | null; direcao: Direcao; papel: 'despesa' | 'item' | 'renda'; rotulo: string; confere: Conferencia[] }
  | { tipo: 'pendente_criar'; banco: Banco; tabela: string; mirror_src: string; campos: Row; rotulo: string }
  | { tipo: 'pendente_atualizar'; banco: Banco; tabela: string; id: string; de: number; para: number; mirror_src: string; rotulo: string }
  | { tipo: 'pendente_apagar'; banco: Banco; tabela: string; id: string; de: number; mirror_src: string; rotulo: string }

// Uma linha relida no banco antes de gravar: se qualquer campo mudou desde o plano, a chave não grava.
export type Conferencia = { banco: Banco; tabela: string; id: string; campos: Record<string, string | number | null> }
const confere = (banco: Banco, tabela: string, linha: Row, cols: string[]): Conferencia =>
  ({ banco, tabela, id: String(linha.id), campos: Object.fromEntries(cols.map(c => [c, linha[c] ?? null])) })
// Os campos que cada conta usa, por tabela de origem.
const COLS = {
  brDespesa: ['invoice_id', 'price', 'quantity', 'tax', 'extra', 'amount_usd', 'expense_date', 'payment_date', 'paid_from', 'source', 'us_markup_pct'],
  brPagamento: ['invoice_id', 'amount', 'amount_usd', 'paid_at', 'paid_to', 'payment_date'],
  usDespesa: ['invoice_id', 'price', 'quantity', 'tax', 'extra', 'payment_date', 'paid_from', 'paid_to', 'source'],
  usRenda: ['invoice_id', 'amount', 'amount_brl', 'paid_at', 'paid_to', 'payment_date'],
  assets: ['unit_price', 'quantity', 'payment_date', 'paid_from', 'paid_to', 'source'],
  assets_expenses: ['amount', 'payment_date', 'paid_from', 'paid_to', 'source'],
  staff_expenses: ['season_id', 'amount', 'amount_brl', 'payment_date', 'expense_date', 'origin', 'paid_from', 'paid_to', 'source'],
  espelho: ['invoice_id', 'price', 'quantity', 'tax', 'extra', 'mirror_src'],
} as const
const colsFonte3 = (tabela: string): string[] => [...(tabela === 'invoice_expenses' ? COLS.usDespesa : tabela === 'assets' ? COLS.assets : tabela === 'assets_expenses' ? COLS.assets_expenses : COLS.staff_expenses)]

export type Par = { direcao: Direcao; fonte_tabela: string; fonte_id: string; alvo_tabela: string; alvo_id: string; alvo_invoice: string; como: 'mirror_src' | 'elo' | 'valor' | 'valor-b'; classe: 'ok' | 'b' | 'divergente'; usd_fonte: number | null; usd_alvo: number | null; rotulo: string }
export type SemPar = { direcao: Direcao; lado: 'fonte' | 'alvo'; tabela: string; id: string; usd: number | null; rotulo: string; motivo: string }

export type ChavePlano = {
  mirror_key: string
  direcoes: Direcao[]
  banco_alvo: Banco
  origem: { banco: Banco; tipo: 'invoice' | 'season' | 'assets'; id: string; codigo: string; rotulo: string }
  alvo: { id: string | null; codigo: string | null; como: 'mirror_key' | 'ponteiro' | 'texto' | 'criar' | null }
  primeira_data: string | null
  status: 'criar' | 'atualizar' | 'nada' | 'conflito'
  ops: Op[]
  conflitos: string[]
  avisos: string[]
  pares: Par[]
  sem_par: SemPar[]
  // itens_usd / itens_brl: o que os ITENS novos cobrariam na shopping invoice (na 006.N já com o +10%).
  numeros: { linhas_criar: number; linhas_vincular: number; usd_criar: number; brl_criar: number; itens_usd: number; itens_brl: number; rendas_criar: number; renda_usd: number; renda_brl: number; carimbos: number; pendente_de: number | null; pendente_para: number | null }
  impressao: string
}
// O DINHEIRO PARADO (auditoria de 14/set/2026): cada chave travada, com o que ela gravaria se o dono
// liberasse. A manchete ANTES/DEPOIS só conta o que já está nas shopping invoices e o que o plano
// grava — sem esta lista, uma 085.N existente aparece com os itens contados e as rendas que a
// abateriam de fora, calada (a 085.6: itens na conta, US$ 50 mil de rendas não).
export type Bloqueada = {
  mirror_key: string; origem: string; alvo: string | null; banco_alvo: Banco; direcoes: Direcao[]
  alvo_ja_na_manchete: boolean     // a shopping invoice-alvo já existe: as linhas dela JÁ contam no ANTES
  itens_usd: number; itens_brl: number; despesas_usd: number; despesas_brl: number; rendas_usd: number; rendas_brl: number
  motivos: string[]
}
export type Excluido = { direcao: Direcao; banco: Banco; tabela: string; id: string; documento: string; rotulo: string; usd: number | null; brl: number | null; motivo: string }
export type CorrecaoB = { br_invoice: string; us_invoice: string; br_expense_id: string; us_expense_id: string; item: string; custo_usd: number; amount_usd_de: number; amount_usd_para: number; price_de: number; price_para: number; quantidade: number; fator_linha: number; fator_invoice: number; delta_usd: number; sql: string }
export type Manchete = {
  us_006: { invoices: number; grand_usd: number; recebido_usd: number; saldo_usd: number }
  br_085: { invoices: number; grand_usd: number; grand_brl: number; pago_usd: number; pago_brl: number; saldo_usd: number; convertidos_pela_taxa_da_invoice: number }
  br_deve_ao_us_usd: number
}
export type Plano = {
  versao: 1
  gerado_em: string
  migrado: { US: boolean; BR: boolean; faltando: Foto['faltando'] }
  cotacao: { fonte: string; falha: string | null }
  chaves: ChavePlano[]
  excluidos: Excluido[]
  correcoes_b: CorrecaoB[]
  manchete: {
    antes: Manchete; depois: Manchete
    bloqueadas: { chaves: Bloqueada[]; total: { itens_usd: number; despesas_usd: number; rendas_usd: number; rendas_brl: number } }
  }
}

class Montador {
  c: ChavePlano
  constructor(mirror_key: string, banco_alvo: Banco, origem: ChavePlano['origem']) {
    this.c = {
      mirror_key, direcoes: [], banco_alvo, origem, alvo: { id: null, codigo: null, como: null }, primeira_data: null, status: 'nada',
      ops: [], conflitos: [], avisos: [], pares: [], sem_par: [],
      numeros: { linhas_criar: 0, linhas_vincular: 0, usd_criar: 0, brl_criar: 0, itens_usd: 0, itens_brl: 0, rendas_criar: 0, renda_usd: 0, renda_brl: 0, carimbos: 0, pendente_de: null, pendente_para: null },
      impressao: '',
    }
  }
  dir(d: Direcao) { if (!this.c.direcoes.includes(d)) this.c.direcoes.push(d) }
  data(d: string | null) { if (d && (!this.c.primeira_data || d < this.c.primeira_data)) this.c.primeira_data = d }
  conflito(t: string) { this.c.conflitos.push(t) }
  aviso(t: string) { this.c.avisos.push(t) }
  op(o: Op) {
    this.c.ops.push(o)
    const n = this.c.numeros
    if (o.tipo === 'criar_linha') {
      if (o.papel === 'renda') { n.rendas_criar++; n.renda_usd = r2(n.renda_usd + o.usd); n.renda_brl = r2(n.renda_brl + (o.brl || 0)) }
      else if (o.papel === 'despesa') { n.linhas_criar++; n.usd_criar = r2(n.usd_criar + o.usd); n.brl_criar = r2(n.brl_criar + (o.brl || 0)) }
      else if (o.papel === 'item') { n.itens_usd = r2(n.itens_usd + o.usd); n.itens_brl = r2(n.itens_brl + (o.brl || 0)) }
    }
    if (o.tipo === 'vincular_linha') n.linhas_vincular++
    if (o.tipo === 'carimbo') n.carimbos++
  }
  fechar(): ChavePlano {
    const c = this.c
    const ORDEM: Op['tipo'][] = ['vincular_invoice', 'criar_invoice', 'ponteiro_origem', 'vincular_linha', 'carimbo', 'criar_linha', 'pendente_criar', 'pendente_atualizar', 'pendente_apagar']
    const PAPEL = { despesa: 0, item: 1, renda: 2 } as const
    c.ops.sort((a, b) => ORDEM.indexOf(a.tipo) - ORDEM.indexOf(b.tipo) || (a.tipo === 'criar_linha' && b.tipo === 'criar_linha' ? PAPEL[a.papel] - PAPEL[b.papel] : 0))
    if (c.conflitos.length) { c.status = 'conflito'; c.ops = [] }
    else if (!c.ops.length) c.status = 'nada'
    else c.status = c.alvo.como === 'criar' ? 'criar' : 'atualizar'
    return c
  }
}

// Casamento EXATO e SEM AMBIGUIDADE: um par só nasce quando a fonte tem um único candidato e o
// candidato tem só aquela fonte. Empate se desfaz pelo texto (24 primeiros caracteres normalizados,
// que carregam o part number) — e só se o texto também for único dos dois lados.
function casar<S, T>(fontes: S[], alvos: T[], pertoDe: (s: S, t: T) => boolean, txtS: (s: S) => string, txtT: (t: T) => string) {
  let S = [...fontes], T = [...alvos]
  const pares: { s: S; t: T }[] = []
  for (let volta = 0; volta < 500; volta++) {
    let achou: { s: S; t: T } | null = null
    for (const s of S) {
      const cs = T.filter(t => pertoDe(s, t))
      if (!cs.length) continue
      if (cs.length === 1 && S.filter(s2 => pertoDe(s2, cs[0])).length === 1) { achou = { s, t: cs[0] }; break }
      const k = txtS(s)
      if (k.length < 6) continue
      const iguais = cs.filter(t => txtT(t) === k)
      if (iguais.length === 1 && S.filter(s2 => pertoDe(s2, iguais[0]) && txtS(s2) === k).length === 1) { achou = { s, t: iguais[0] }; break }
    }
    if (!achou) break
    const par = achou
    pares.push(par)
    S = S.filter(x => x !== par.s)
    T = T.filter(x => x !== par.t)
  }
  return { pares, restoS: S, restoT: T, ambiguas: S.filter(s => T.some(t => pertoDe(s, t))) }
}

function grandTotal(itens: Row[], servicos: Row[], inv: Row, valor: (i: Row) => number) {
  const base = itens.reduce((s, i) => s + valor(i), 0)
  const serv = servicos.reduce((s, x) => s + num(x.price), 0)
  const pAndS = base + base * (num(inv.florida_taxes) / 100) + serv
  return pAndS - pAndS * (num(inv.global_discount) / 100)
}

function agrupar<T>(linhas: T[], chave: (l: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const l of linhas) { const k = chave(l); const a = m.get(k); if (a) a.push(l); else m.set(k, [l]) }
  return m
}

const maxPos = (linhas: Row[]) => linhas.reduce((m, l) => Math.max(m, l.position == null ? -1 : Number(l.position)), -1)
const parseSrc = (src: unknown) => { const m = String(src ?? '').match(/^(US|BR):([a-z_]+):(.+)$/); return m ? { banco: m[1] as Banco, tabela: m[2], id: m[3] } : null }

// ── OS ELOS DO BANCO-ALVO INTEIRO (revisão 14/set/2026) ──────────────────────
// mirror_src é ÚNICO no banco, não na invoice. Uma linha de asset que mudou de mês, uma despesa que mudou
// de invoice na origem: o plano da chave nova quer criar um mirror_src que já mora em OUTRA shopping
// invoice — e a escrita estourava toda rodada, às vezes depois de criar uma 085.N vazia. Agora o plano
// confere cada elo que vai criar ou ligar contra TODAS as linhas do banco-alvo, e o choque vira conflito
// com o motivo (nada gravado naquela chave; as outras seguem).
type Elos = Map<string, { porSrc: Map<string, Row>; porId: Map<string, Row> }>
function mapaDeElos(tabelas: Record<string, Row[]>): Elos {
  const out: Elos = new Map()
  for (const [t, linhas] of Object.entries(tabelas)) {
    const porSrc = new Map<string, Row>(), porId = new Map<string, Row>()
    for (const l of linhas) { porId.set(String(l.id), l); if (l.mirror_src) porSrc.set(String(l.mirror_src), l) }
    out.set(t, { porSrc, porId })
  }
  return out
}
function conferirElos(m: Montador, elos: Elos, codigoDe: (invoiceId: string) => string) {
  for (const o of m.c.ops) {
    if (o.tipo !== 'criar_linha' && o.tipo !== 'pendente_criar' && o.tipo !== 'vincular_linha') continue
    const t = elos.get(o.tabela)
    if (!t) continue
    const dono = t.porSrc.get(o.mirror_src)
    if (o.tipo === 'vincular_linha') {
      if (dono && String(dono.id) !== o.id) m.conflito(`o elo ${o.mirror_src} já está na linha ${String(dono.id).slice(0, 8)} (${codigoDe(dono.invoice_id)}) — não dá para ligá-lo a outra`)
      const atual = t.porId.get(o.id)?.mirror_src
      if (atual && atual !== o.mirror_src) m.conflito(`a linha ${o.id.slice(0, 8)} de ${o.tabela} já tem outro elo (${atual}) — o motor não troca elo`)
    } else if (dono) {
      m.conflito(`${o.mirror_src} já está gravado em ${o.tabela} ${String(dono.id).slice(0, 8)} na ${codigoDe(dono.invoice_id)} — a data ou o documento da origem mudou? (nada gravado nesta chave)`)
    }
  }
}

// ── O PENDING BALANCE DE UMA SHOPPING INVOICE — a mesma régua nos dois lados ─
// (revisão 14/set/2026)
//   · adota SÓ a linha com mirror_src = pendente:<chave>, ou a linha SEM elo nenhum cuja descrição é
//     «Pending balance» — nunca uma parcela, nunca uma renda espelhada que alguém desmarcou;
//   · Pending balance do motor que ganhou BAIXA (Bank Link, PAID na tela) trava a chave: baixa em pendente
//     não diz de qual renda veio o dinheiro, e a renda da origem entraria de novo, contada duas vezes;
//   · rendas novas que levariam o recebido acima do grand total travam a chave;
//   · o pendente é o devido MENOS as outras rendas em aberto (a régua do app: soma de todas − grand total).
function planejarPendente(m: Montador, a: {
  banco: Banco; tabela: 'invoice_incomes' | 'invoice_payments'; key: string; moeda: 'US$' | 'R$'; tol: number
  rendasAlvo: Row[]; grand: number; recebido: number; novas: number; elo: 'br_payment_id' | 'us_income_id'
  ligadoAoBanco: (id: string) => boolean; camposNovo: (valor: number) => Row
}) {
  const pendKey = `pendente:${a.key}`
  const pagas = a.rendasAlvo.filter(p => p.paid_at), abertas = a.rendasAlvo.filter(p => !p.paid_at)
  const devido = r2(a.grand - a.recebido)
  m.c.numeros.pendente_de = abertas.length ? r2(abertas.reduce((s, p) => s + num(p.amount), 0)) : null
  m.c.numeros.pendente_para = null
  const pagoPend = pagas.find(p => p.mirror_src === pendKey)
  if (pagoPend) { m.conflito(`o Pending balance do motor (${a.moeda} ${num(pagoPend.amount)}) está PAGO — baixa em pendente não diz de qual renda veio o dinheiro, e a renda da origem entraria de novo: ligue a baixa à renda da origem (${a.elo}) ou tire o mirror_src dela`); return }
  // Renda nova acima do grand total, SOZINHA, é o desenho das quatro direções (a renda do cliente que caiu na
  // conta do outro passa do que a shopping invoice cobra: aí quem deve inverte — 085.3, 085.10, BR.537.1). A
  // assinatura da contagem dobrada é outra: a invoice JÁ estava quitada por baixa própria (recebido existente
  // ≥ grand) e a renda da origem ainda entraria por cima.
  const jaRecebido = r2(pagas.reduce((s, p) => s + num(p.amount), 0))
  if (a.novas > 0 && devido < -a.tol && jaRecebido > a.tol && r2(a.grand - jaRecebido) <= a.tol) { m.conflito(`a shopping invoice já estava quitada por baixa própria (recebido ${a.moeda} ${jaRecebido} ≥ grand ${a.moeda} ${r2(a.grand)}) e as rendas novas da origem levariam o recebido a ${a.moeda} ${r2(a.recebido)} — o mesmo dinheiro contado duas vezes? ligue a baixa à renda da origem (${a.elo})`); return }
  const marcada = abertas.find(p => p.mirror_src === pendKey) || null
  const adotaveis = marcada ? [] : abertas.filter(p => !p.mirror_src && !p[a.elo] && /^pending balance$/i.test(String(p.description || '').trim()))
  if (!marcada && adotaveis.length > 1) { m.conflito(`${adotaveis.length} linhas «Pending balance» em aberto, sem elo — qual é a do motor?`); return }
  const pend = marcada || adotaveis[0] || null
  const outras = r2(abertas.filter(p => p !== pend).reduce((s, p) => s + num(p.amount), 0))
  const alvoPend = r2(devido - outras)
  m.c.numeros.pendente_para = alvoPend > 0.005 ? alvoPend : 0
  if (alvoPend < -a.tol && outras > 0.005) { m.conflito(`as rendas em aberto (fora o Pending balance) somam ${a.moeda} ${outras}, mais que o devido ${a.moeda} ${Math.max(devido, 0)} — qual vale?`); return }
  const direcao: Direcao = a.banco === 'US' ? 1 : 3
  if (pend) {
    if (alvoPend > 0.005) {
      if (!perto(num(pend.amount), alvoPend, 0.005)) m.op({ tipo: 'pendente_atualizar', banco: a.banco, tabela: a.tabela, id: pend.id, de: num(pend.amount), para: alvoPend, mirror_src: pendKey, rotulo: `Pending balance ${a.moeda} ${num(pend.amount)} → ${alvoPend}` })
      else if (pend.mirror_src !== pendKey) m.op({ tipo: 'vincular_linha', banco: a.banco, tabela: a.tabela, id: pend.id, mirror_src: pendKey, elo: null, direcao, rotulo: 'Pending balance' })
    } else if (a.ligadoAoBanco(pend.id)) m.conflito('o Pending balance em aberto tem elo de banco e a conta diz que nada é devido')
    else m.op({ tipo: 'pendente_apagar', banco: a.banco, tabela: a.tabela, id: pend.id, de: num(pend.amount), mirror_src: pendKey, rotulo: `Pending balance ${a.moeda} ${num(pend.amount)} sai: nada mais é devido (grand ${r2(a.grand)} − recebido ${r2(a.recebido)}${outras ? ` − outras em aberto ${outras}` : ''})` })
  } else if (alvoPend > 0.005) {
    m.op({ tipo: 'pendente_criar', banco: a.banco, tabela: a.tabela, mirror_src: pendKey, rotulo: `Pending balance ${a.moeda} ${alvoPend}`, campos: a.camposNovo(alvoPend) })
  }
}

// ── DIREÇÕES 1 + 2 → US 006.N ───────────────────────────────────────────────
function planejarUS(foto: Foto, cot: Cotacoes, excluidos: Excluido[], correcoes: CorrecaoB[]): ChavePlano[] {
  const bInv = new Map(foto.br.invoices.map(i => [i.id, i]))
  const bRide = new Map(foto.br.rides.map(r => [r.id, r]))
  const bCli = new Map(foto.br.clientes.map(c => [c.id, c]))
  const uInv = new Map(foto.us.invoices.map(i => [i.id, i]))
  const us006 = foto.us.invoices.filter(i => i.client_id === US_CLIENTE_GZ28BR)
  const docBR = (b: Row) => b?.invoice_code || '?'

  // As fontes da direção 1: despesa do BR paga com dinheiro do GZ28US.
  const fontes1: Row[] = []
  for (const e of foto.br.despesas) {
    const B = bInv.get(e.invoice_id)
    if (!B || B.client_id === BR_CLIENTE_GZ28US) continue   // a 085.N é o espelho da direção 3, não fonte
    const quem = quemPagou(e)
    const base = { direcao: 1 as Direcao, banco: 'BR' as Banco, tabela: 'invoice_expenses', id: e.id, documento: docBR(B), rotulo: limpa(e.item).slice(0, 80), usd: usdBR(e, B.usd_rate), brl: r2(brlBR(e)) }
    if (quem !== 'GZ28US') {
      if (quem === 'GZ28BR' && empresa(e.paid_to) === 'GZ28US') excluidos.push({ ...base, motivo: 'fora deste passo: linha do BR PAID FROM GZ28BR → PAID TO GZ28US (crédito/transferência) — decisão à parte' })
      continue
    }
    if (FL_TAX.test(String(e.item || ''))) { excluidos.push({ ...base, motivo: 'linha de Florida tax nunca atravessa (lei 22/ago/2026)' }); continue }
    if (B.is_quote) { excluidos.push({ ...base, motivo: 'invoice do BR ainda é QUOTE — quote não é dinheiro de ninguém' }); continue }
    fontes1.push(e)
  }
  // As fontes da direção 2: renda do BR que caiu na conta do GZ28US.
  const fontes2: Row[] = []
  for (const p of foto.br.pagamentos) {
    const B = bInv.get(p.invoice_id)
    if (!B || B.client_id === BR_CLIENTE_GZ28US || empresa(p.paid_to) !== 'GZ28US') continue
    const base = { direcao: 2 as Direcao, banco: 'BR' as Banco, tabela: 'invoice_payments', id: p.id, documento: docBR(B), rotulo: String(p.description || 'renda').slice(0, 80), usd: p.amount_usd != null ? num(p.amount_usd) : null, brl: num(p.amount) }
    if (B.is_quote) { excluidos.push({ ...base, motivo: 'invoice do BR ainda é QUOTE' }); continue }
    if (!p.paid_at) { excluidos.push({ ...base, motivo: 'renda ainda não recebida (sem paid_at) — dinheiro que não andou não atravessa' }); continue }
    fontes2.push(p)
  }

  const idsBR = new Set<string>([...fontes1.map(e => e.invoice_id), ...fontes2.map(p => p.invoice_id)])
  // Quem já aponta para uma 006.N também entra: espelho sem fonte tem de aparecer, nunca sumir calado.
  for (const B of foto.br.invoices) if (B.us_invoice_id && uInv.get(B.us_invoice_id)?.client_id === US_CLIENTE_GZ28BR && !B.is_quote) idsBR.add(B.id)
  for (const i of us006) { const s = parseSrc(i.mirror_key); if (s?.banco === 'BR' && s.tabela === 'invoice') idsBR.add(s.id) }

  const f1 = agrupar(fontes1, e => e.invoice_id), f2 = agrupar(fontes2, p => p.invoice_id)
  const chaves: ChavePlano[] = []
  const reivindicadas = new Map<string, string[]>()   // id da 006.N → chaves que querem adotá-la
  const montadores: { m: Montador; alvo: Row | null }[] = []
  const elosUS = mapaDeElos({ invoice_expenses: foto.us.despesas, invoice_items: foto.us.itens, invoice_incomes: foto.us.rendas })
  const codigoUS = (id: string) => uInv.get(id)?.invoice_code || '?'

  for (const brId of idsBR) {
    const B = bInv.get(brId)
    const key = `BR:invoice:${brId}`
    if (!B) {
      const m = new Montador(key, 'US', { banco: 'BR', tipo: 'invoice', id: brId, codigo: '?', rotulo: 'invoice do BR que não existe mais' })
      m.conflito('a 006.N tem mirror_key de uma invoice do BR que não existe mais — espelho órfão, decisão humana')
      chaves.push(m.fechar()); continue
    }
    const ride = B.ride_id ? bRide.get(B.ride_id) : null
    const cli = B.client_id ? bCli.get(B.client_id) : null
    const dono = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : cli ? [cli.client_number != null ? String(cli.client_number) : '', cli.name].filter(Boolean).join(' — ') : ''
    const m = new Montador(key, 'US', { banco: 'BR', tipo: 'invoice', id: B.id, codigo: B.invoice_code, rotulo: `${B.invoice_code}${dono ? ` ${dono}` : ''}${B.service ? ` - ${B.service}` : ''}` })
    const S = f1.get(B.id) || [], P2 = f2.get(B.id) || []
    if (S.length) m.dir(1)
    if (P2.length) m.dir(2)
    const bloqueio = FORA_DE_ESCOPO_BR[B.invoice_code]
    if (bloqueio) m.conflito(bloqueio)
    const segura = chaveSegura(key)
    if (segura) m.conflito(`SEGURA — ${segura}`)

    // ── a 006.N-alvo: mirror_key → ponteiro us_invoice_id → texto do SERVICE ──
    const porKey = us006.filter(i => i.mirror_key === key)
    const ptr = B.us_invoice_id ? uInv.get(B.us_invoice_id) : null
    const porTexto = us006.filter(i => String(i.service || '').startsWith(`GZ28BR Invoice ${B.invoice_code}.`))
    const candidatos = new Map<string, Row>()
    for (const i of [...porKey, ...(ptr ? [ptr] : []), ...porTexto]) candidatos.set(i.id, i)
    let alvo: Row | null = null
    if (porKey.length > 1) m.conflito(`${porKey.length} invoices do US com a mesma mirror_key`)
    if (B.us_invoice_id && !ptr) m.conflito(`ponteiro morto: us_invoice_id ${String(B.us_invoice_id).slice(0, 8)} aponta para uma 006.N que foi apagada — recriar só com ordem`)
    if (ptr && ptr.client_id !== US_CLIENTE_GZ28BR) m.conflito(`o ponteiro us_invoice_id aponta para ${ptr.invoice_code}, que não é do cliente GZ28 V8 SpeedShop BR Ltda`)
    const cands = [...candidatos.values()].filter(i => i.client_id === US_CLIENTE_GZ28BR)
    if (cands.length > 1) m.conflito(`mais de uma 006.N para a mesma invoice do BR: ${cands.map(i => i.invoice_code).join(' + ')}`)
    else if (cands.length === 1) {
      alvo = cands[0]
      if (alvo.is_quote) m.conflito(`a ${alvo.invoice_code} do US é QUOTE`)
      m.c.alvo = { id: alvo.id, codigo: alvo.invoice_code, como: porKey.length ? 'mirror_key' : ptr ? 'ponteiro' : 'texto' }
      const lista = reivindicadas.get(alvo.id) || []; lista.push(key); reivindicadas.set(alvo.id, lista)
      if (String(alvo.live_status || '') === 'CLOSED') m.aviso(`${alvo.invoice_code} está CLOSED no US — linha nova entra numa invoice fechada`)
    } else m.c.alvo = { id: null, codigo: null, como: 'criar' }
    // Para o elo das LINHAS o casamento olha todas as candidatas juntas (006.2 + 006.16 dividem a BR.496.1).
    const invAlvo = cands.map(i => i.id)

    // ── as linhas: elo gravado → valor exato (custo × 1,10) → classe (b) (valor = custo cru) ──
    const E = foto.us.despesas.filter(e => invAlvo.includes(e.invoice_id))
    const I = foto.us.itens.filter(i => invAlvo.includes(i.invoice_id))
    const R = foto.us.rendas.filter(p => invAlvo.includes(p.invoice_id))
    const Rs = (s: Row) => usdBR(s, B.usd_rate)
    const pares: { s: Row; e: Row; como: Par['como'] }[] = []
    let SE = [...S], EE = [...E]
    for (const e of E) {
      const src = parseSrc(e.mirror_src)
      const idFonte = src ? (src.banco === 'BR' && src.tabela === 'invoice_expenses' ? src.id : null) : e.br_expense_id
      if (!idFonte) continue
      const s = SE.find(x => x.id === idFonte)
      if (s) { pares.push({ s, e, como: src ? 'mirror_src' : 'elo' }); SE = SE.filter(x => x !== s); EE = EE.filter(x => x !== e) }
      else {
        const onde = foto.br.despesas.find(x => x.id === idFonte)
        m.c.sem_par.push({ direcao: 1, lado: 'alvo', tabela: 'invoice_expenses', id: e.id, usd: r2(custoUS(e)), rotulo: limpa(e.item).slice(0, 80), motivo: onde ? `o elo aponta para linha do BR que não é fonte desta invoice (${docBR(bInv.get(onde.invoice_id) || {})}, pagador ${quemPagou(onde) || 'vazio'})` : 'o elo aponta para linha do BR que não existe mais' })
        EE = EE.filter(x => x !== e)
        m.conflito(`despesa ${limpa(e.item).slice(0, 40)} (${uInv.get(e.invoice_id)?.invoice_code}) tem elo para linha do BR fora desta fonte`)
      }
    }
    const txtS = (s: Row) => chaveTexto(s.item), txtE = (e: Row) => chaveTexto(e.item)
    const a = casar(SE, EE, (s, e) => perto(Rs(s), custoUS(e) * markupDe(s)), txtS, txtE)
    a.pares.forEach(p => pares.push({ s: p.s, e: p.t, como: 'valor' }))
    const bq = casar(a.restoS, a.restoT, (s, e) => perto(Rs(s), custoUS(e)), txtS, txtE)
    bq.pares.forEach(p => pares.push({ s: p.s, e: p.t, como: 'valor-b' }))
    const sobraS = bq.restoS, sobraE = bq.restoT

    // itens: elo gravado → valor (item = US$ gravado no BR, ou base_cost = custo)
    let II = [...I]
    const itemDe = new Map<string, Row>()
    for (const i of I) {
      const src = parseSrc(i.mirror_src)
      if (src?.banco === 'BR' && src.tabela === 'invoice_expenses') {
        const s = S.find(x => x.id === src.id)
        if (s) { itemDe.set(s.id, i); II = II.filter(x => x !== i) }
      }
    }
    const comItem = pares.filter(p => !itemDe.has(p.s.id))
    const ci = casar(comItem, II, (p, i) => perto(linhaItem(i), Rs(p.s)) || (num(i.base_cost) > 0 && perto(num(i.base_cost) * (num(i.quantity) || 1), custoUS(p.e))), p => chaveTexto(p.s.item), i => chaveTexto(i.description))
    ci.pares.forEach(x => itemDe.set(x.s.s.id, x.t))
    // Último recurso só para DIZER o que houve: o item de mesmo texto (único) de uma despesa já casada
    // vira par — e a conferência abaixo acusa «item divergente» em vez de «sem item».
    const ciTxt = casar(ci.restoS, ci.restoT, (p, i) => chaveTexto(p.s.item).length >= 6 && chaveTexto(p.s.item) === chaveTexto(i.description), p => chaveTexto(p.s.item), i => chaveTexto(i.description))
    ciTxt.pares.forEach(x => itemDe.set(x.s.s.id, x.t))
    const ci2 = casar(sobraS, ciTxt.restoT, (s, i) => perto(linhaItem(i), Rs(s)), txtS, i => chaveTexto(i.description))
    ci2.pares.forEach(x => itemDe.set(x.s.id, x.t))
    const sobraI = ci2.restoT

    // A ESCRITA PELA METADE (revisão 14/set/2026): as escritas de uma chave não são atômicas — o motor grava
    // todas as despesas e depois os itens. Rodada que cai no meio deixa despesa COM mirror_src e sem item;
    // antes isso virava «não tem item correspondente» e a chave travava para sempre. Despesa que o motor
    // gravou (par por mirror_src, valor ok) sem item ganha o item planejado de novo, dos mesmos campos.
    const faltaItem: { s: Row; e: Row; Rv: number; C: number }[] = []
    for (const p of pares) {
      const C = custoUS(p.e), Rv = Rs(p.s), it = itemDe.get(p.s.id)
      const mk = markupDe(p.s)
      const classe: Par['classe'] = perto(Rv, C * mk) ? 'ok' : perto(Rv, C) ? 'b' : 'divergente'
      m.c.pares.push({ direcao: 1, fonte_tabela: 'invoice_expenses', fonte_id: p.s.id, alvo_tabela: 'invoice_expenses', alvo_id: p.e.id, alvo_invoice: uInv.get(p.e.invoice_id)?.invoice_code || '?', como: p.como, classe, usd_fonte: Rv == null ? null : r2(Rv), usd_alvo: r2(C), rotulo: limpa(p.s.item).slice(0, 80) })
      if (classe === 'b') {
        m.conflito(`classe (b): ${limpa(p.s.item).slice(0, 40)} — BR guardou US$ ${r2(Rv || 0)} = custo cru; devia ser ${r2(C * mk)} (correção proposta à parte)`)
        const q = num(p.s.quantity) || 1, f = fatorBR(p.s, B.usd_rate), te = num(p.s.tax) + num(p.s.extra)
        const alvoUsd = r2(C * mk)
        const auPara = r2((alvoUsd - (te ? te / f : 0)) / q)
        const pricePara = r2(auPara * f)
        correcoes.push({
          br_invoice: B.invoice_code, us_invoice: uInv.get(p.e.invoice_id)?.invoice_code || '?', br_expense_id: p.s.id, us_expense_id: p.e.id, item: limpa(p.s.item).slice(0, 80),
          custo_usd: r2(C), amount_usd_de: num(p.s.amount_usd), amount_usd_para: auPara, price_de: num(p.s.price), price_para: pricePara, quantidade: q,
          fator_linha: r4(f), fator_invoice: r4(num(B.usd_rate) * IOF), delta_usd: r2(alvoUsd - (Rv || 0)),
          sql: `update invoice_expenses set amount_usd = ${auPara}, price = ${pricePara} where id = '${p.s.id}' and amount_usd = ${num(p.s.amount_usd)} and price = ${num(p.s.price)};`,
        })
      } else if (classe === 'divergente') m.conflito(`valor divergente: ${limpa(p.s.item).slice(0, 40)} — BR US$ ${Rv == null ? 'sem amount_usd' : r2(Rv)} × US custo ${r2(C)} (esperado ${r2(C * mk)})`)
      if (!it) {
        if (p.como === 'mirror_src' && classe === 'ok' && Rv != null) faltaItem.push({ s: p.s, e: p.e, Rv, C })
        else m.conflito(`a despesa ${limpa(p.e.item).slice(0, 40)} não tem item correspondente na ${uInv.get(p.e.invoice_id)?.invoice_code}`)
      }
      else if (!perto(linhaItem(it), Rv)) m.conflito(`item divergente: ${limpa(it.description).slice(0, 40)} US$ ${r2(linhaItem(it))} × BR US$ ${Rv == null ? '?' : r2(Rv)}`)
      else if (num(it.base_cost) > 0 && !perto(num(it.base_cost) * (num(it.quantity) || 1), C)) m.aviso(`base_cost do item ${limpa(it.description).slice(0, 30)} (${r2(num(it.base_cost) * (num(it.quantity) || 1))}) ≠ custo ${r2(C)} — informativo`)
      if (p.e.br_expense_id && p.e.br_expense_id !== p.s.id) m.conflito(`a despesa ${limpa(p.e.item).slice(0, 40)} tem br_expense_id de outra linha`)
      else if (!p.e.mirror_src) m.op({ tipo: 'vincular_linha', banco: 'US', tabela: 'invoice_expenses', id: p.e.id, mirror_src: `BR:invoice_expenses:${p.s.id}`, elo: p.e.br_expense_id ? null : { campo: 'br_expense_id', valor: p.s.id }, direcao: 1, rotulo: `despesa ${limpa(p.e.item).slice(0, 50)} ⇄ BR ${p.s.id.slice(0, 8)} (${p.como})` })
      else if (!p.e.br_expense_id) m.aviso(`a despesa ${limpa(p.e.item).slice(0, 40)} tem mirror_src mas não br_expense_id`)
      if (it && !parseSrc(it.mirror_src)) m.op({ tipo: 'vincular_linha', banco: 'US', tabela: 'invoice_items', id: it.id, mirror_src: `BR:invoice_expenses:${p.s.id}`, elo: null, direcao: 1, rotulo: `item ${limpa(it.description).slice(0, 50)}` })
    }
    for (const e of sobraE) {
      m.c.sem_par.push({ direcao: 1, lado: 'alvo', tabela: 'invoice_expenses', id: e.id, usd: r2(custoUS(e)), rotulo: limpa(e.item).slice(0, 80), motivo: a.ambiguas.length || bq.ambiguas.length ? 'mais de um candidato no BR com o mesmo valor' : 'nenhuma linha do BR com custo × 1,10 (nem custo cru) igual' })
      m.conflito(`despesa sem origem no BR: ${limpa(e.item).slice(0, 40)} US$ ${r2(custoUS(e))} (${uInv.get(e.invoice_id)?.invoice_code})`)
    }
    for (const i of sobraI) m.conflito(`item sem origem no BR: ${limpa(i.description).slice(0, 40)} US$ ${r2(linhaItem(i))}`)
    for (const s of sobraS) {
      if (E.length) m.c.sem_par.push({ direcao: 1, lado: 'fonte', tabela: 'invoice_expenses', id: s.id, usd: Rs(s) == null ? null : r2(Rs(s) as number), rotulo: limpa(s.item).slice(0, 80), motivo: a.ambiguas.includes(s) || bq.ambiguas.includes(s) ? 'mais de um candidato no US com o mesmo valor' : 'nenhuma despesa do US com o valor desta linha' })
    }
    if (sobraS.length && sobraE.length) m.conflito(`${sobraS.length} linha(s) do BR e ${sobraE.length} do US sem par na mesma invoice — criar duplicaria a mesma compra`)

    // ── o que falta: despesa (custo) + item (US$ gravado no BR) ──
    let pos = maxPos(E), posItem = maxPos(I)
    let latest: string | null = null
    for (const s of S) { const d = ymd(s.expense_date) || ymd(s.payment_date); m.data(d); if (d && (!latest || d > latest)) latest = d }
    const novosItens: Row[] = []
    for (const x of faltaItem) {
      const q = num(x.s.quantity) || 1
      const src = `BR:invoice_expenses:${x.s.id}`
      const item = { invoice_id: ALVO, description: limpa(x.s.item), unit_price: r2(x.Rv / q), base_cost: r2(x.C / q), quantity: q, payment_date: ymd(x.s.expense_date) || ymd(x.s.payment_date) || ymd(x.e.payment_date), position: ++posItem, mirror_src: src }
      novosItens.push(item)
      m.op({ tipo: 'criar_linha', banco: 'US', tabela: 'invoice_items', mirror_src: src, direcao: 1, papel: 'item', usd: r2(x.Rv), brl: null, rotulo: `item ${limpa(x.s.item).slice(0, 50)} (a rodada anterior parou antes dele)`, campos: item,
        confere: [confere('BR', 'invoice_expenses', x.s, [...COLS.brDespesa]), confere('US', 'invoice_expenses', x.e, [...COLS.espelho])] })
    }
    for (const s of sobraS) {
      const q = num(s.quantity) || 1
      const Rv = Rs(s)
      const dia = ymd(s.expense_date) || ymd(s.payment_date)
      if (itemDe.has(s.id)) { m.conflito(`o item de ${limpa(s.item).slice(0, 40)} já está na 006.N, mas a despesa não — espelho pela metade`); continue }
      if (Rv == null) { m.conflito(`linha do BR sem amount_usd: ${limpa(s.item).slice(0, 40)} — sem o US$ gravado não se sabe se o +10% está dentro`); continue }
      if (!dia) { m.conflito(`linha do BR sem a data em que o GZ28US pagou (expense_date/payment_date): ${limpa(s.item).slice(0, 40)}`); continue }
      const f = fatorBR(s, B.usd_rate)
      const mk = markupDe(s)
      const price = r2(num(s.amount_usd) / mk)
      const tax = num(s.tax) ? r2(num(s.tax) / f / mk) : 0
      const ext = num(s.extra) ? r2(num(s.extra) / f / mk) : 0
      const C = r2(price * q + tax + ext)
      const src = `BR:invoice_expenses:${s.id}`
      const conf1 = [confere('BR', 'invoice_expenses', s, [...COLS.brDespesa])]
      m.op({ tipo: 'criar_linha', banco: 'US', tabela: 'invoice_expenses', mirror_src: src, direcao: 1, papel: 'despesa', usd: C, brl: r2(brlBR(s)), rotulo: `despesa ${limpa(s.item).slice(0, 60)}`, confere: conf1, campos: {
        invoice_id: ALVO, item: limpa(s.item), supplier: s.supplier || null, order_number: String(s.order_number || '').trim() || null, part_number: s.part_number || null,
        price, quantity: q, tax, extra: ext, payment_date: dia, expense_date: dia, source: 'GZ28US', paid_from: 'GZ28US', paid_to: 'GZ28US', item_discount: 0,
        position: ++pos, br_expense_id: s.id, mirror_src: src,
      } })
      const item = { invoice_id: ALVO, description: limpa(s.item), unit_price: r2(Rv / q), base_cost: r2(C / q), quantity: q, payment_date: dia, position: ++posItem, mirror_src: src }
      novosItens.push(item)
      m.op({ tipo: 'criar_linha', banco: 'US', tabela: 'invoice_items', mirror_src: src, direcao: 1, papel: 'item', usd: r2(Rv), brl: null, rotulo: `item ${limpa(s.item).slice(0, 60)}`, campos: item, confere: conf1 })
    }

    // ── direção 2: a renda do BR entra PAGA na 006.N ──
    const pagasAlvo = R.filter(p => p.paid_at)
    let RR = [...pagasAlvo]
    const novasRendas: Row[] = []
    for (const p of P2) {
      const dia = ymd(p.payment_date) || diaEm(p.paid_at, 'America/Sao_Paulo')
      m.data(dia)
      const gravado = p.amount_usd != null && String(p.amount_usd) !== ''
      let usd: number | null = gravado ? num(p.amount_usd) : null
      let regra = ''
      let usouTaxaDaInvoice = false
      const src0 = `BR:invoice_payments:${p.id}`
      // O elo é procurado em TODAS as rendas da 006.N, pagas ou não (revisão 14/set/2026): a renda que o motor
      // gravou e alguém desmarcou no US não pode sumir da busca — a renda nova nasceria de novo e contaria duas vezes.
      const eloQualquer = R.find(r => r.mirror_src === src0 || r.br_payment_id === p.id)
      if (eloQualquer && !eloQualquer.paid_at) { m.conflito(`a renda espelhada de ${String(p.description || 'renda').slice(0, 30)} (${String(eloQualquer.id).slice(0, 8)}) está SEM baixa no US, mas a origem no BR está paga — alguém desmarcou? qual vale?`); continue }
      if (eloQualquer && eloQualquer.mirror_src && eloQualquer.mirror_src !== src0) { m.conflito(`a renda ${String(eloQualquer.id).slice(0, 8)} tem o br_payment_id de ${String(p.description || 'renda').slice(0, 30)}, mas outro elo (${eloQualquer.mirror_src}) — qual vale?`); continue }
      const jaElo = eloQualquer || null
      const decidida = RENDA_BR_DECIDIDA[p.id]
      // A ORDEM DO VALOR GRAVADO (decisão do Márcio, 14/set/2026): amount_usd da própria renda →
      // o US$ já gravado na renda espelhada → o US$ decidido pelo dono → a usd_rate GRAVADA na invoice
      // do BR → só então a regra do app (bid + 0,20) × 1,0638. Até 14/set a usd_rate e a regra
      // discordando viravam conflito; o dono respondeu que a usd_rate gravada prevalece.
      if (!gravado && jaElo) { usd = r2(num(jaElo.amount)); regra = `US$ já gravado na renda espelhada ${jaElo.id.slice(0, 8)}` }
      else if (!gravado && decidida) {
        usd = decidida.usd; regra = `US$ decidido pelo dono — ${decidida.motivo}`
        if (num(B.usd_rate) > 0 && !perto(r2(num(p.amount) / num(B.usd_rate)), usd)) m.aviso(`renda ${String(p.description || '').slice(0, 30)}: a usd_rate da ${B.invoice_code} agora é ${num(B.usd_rate)} (dá US$ ${r2(num(p.amount) / num(B.usd_rate))}) — vale o US$ ${usd} decidido`)
      }
      else if (!gravado && num(B.usd_rate) > 0) {
        usd = r2(num(p.amount) / num(B.usd_rate))
        regra = `R$ ${num(p.amount)} ÷ usd_rate gravada na ${B.invoice_code} (${num(B.usd_rate)}, sem IOF)`
        usouTaxaDaInvoice = true
      }
      else if (!gravado) {
        const rg = regraApp(cot, dia)
        if (!rg) { m.conflito(`sem cotação para ${dia || 'data vazia'} — renda ${String(p.description || '').slice(0, 30)} não tem US$`); continue }
        usd = r2(num(p.amount) / rg.taxa); regra = rg.texto
      }
      const src = src0
      // O que o câmbio usou volta a ser conferido na hora de gravar: a renda do BR e, quando valeu, a usd_rate da invoice.
      const conf2 = [confere('BR', 'invoice_payments', p, [...COLS.brPagamento]), ...(usouTaxaDaInvoice ? [confere('BR', 'invoices', B, ['usd_rate'])] : [])]
      const ja = jaElo || (() => { const c = RR.filter(r => !r.mirror_src && !r.br_payment_id && perto(num(r.amount), usd) && ymd(r.payment_date) === dia); return c.length === 1 ? c[0] : null })()
      if (ja) {
        RR = RR.filter(r => r !== ja)
        m.c.pares.push({ direcao: 2, fonte_tabela: 'invoice_payments', fonte_id: p.id, alvo_tabela: 'invoice_incomes', alvo_id: ja.id, alvo_invoice: uInv.get(ja.invoice_id)?.invoice_code || '?', como: ja.mirror_src === src ? 'mirror_src' : ja.br_payment_id === p.id ? 'elo' : 'valor', classe: perto(num(ja.amount), usd) ? 'ok' : 'divergente', usd_fonte: usd, usd_alvo: num(ja.amount), rotulo: String(p.description || '').slice(0, 80) })
        if (!perto(num(ja.amount), usd)) m.conflito(`renda espelhada com valor divergente: US$ ${num(ja.amount)} × ${usd}`)
        else if (ja.mirror_src !== src) m.op({ tipo: 'vincular_linha', banco: 'US', tabela: 'invoice_incomes', id: ja.id, mirror_src: src, elo: ja.br_payment_id ? null : { campo: 'br_payment_id', valor: p.id }, direcao: 2, rotulo: `renda ${String(p.description || '').slice(0, 50)}` })
      } else {
        const campos = { invoice_id: ALVO, amount: usd, payment_date: dia, paid_at: p.paid_at, source: null, paid_to: 'GZ28US', description: `GZ28BR ${B.invoice_code} — ${String(p.description || 'renda').trim()} (PAID TO GZ28US)`, br_payment_id: p.id, mirror_src: src }
        novasRendas.push(campos)
        m.op({ tipo: 'criar_linha', banco: 'US', tabela: 'invoice_incomes', mirror_src: src, direcao: 2, papel: 'renda', usd: usd as number, brl: num(p.amount), rotulo: `renda ${String(p.description || '').slice(0, 60)}`, campos, confere: conf2 })
      }
      if (!gravado) m.op({ tipo: 'carimbo', banco: 'BR', tabela: 'invoice_payments', id: p.id, campo: 'amount_usd', valor: usd as number, regra, direcao: 2, rotulo: `US$ da renda ${String(p.description || '').slice(0, 40)} carimbado pela regra do app`,
        guarda: { amount: p.amount ?? null, paid_to: p.paid_to ?? null }, confere: conf2 })
    }

    // ── o Pending balance: grand total − o que já entrou ──
    if (!alvo && !S.length && !P2.length) { chaves.push(m.fechar()); continue }
    const alvoInv = alvo || { florida_taxes: 0, global_discount: null }
    const itensDepois = [...(alvo ? I.filter(i => i.invoice_id === alvo!.id) : []), ...novosItens]
    const servicos = alvo ? foto.us.servicos.filter(s => s.invoice_id === alvo!.id) : []
    const grand = grandTotal(itensDepois, servicos, alvoInv, linhaItem)
    const recebido = [...(alvo ? R.filter(p => p.invoice_id === alvo!.id && p.paid_at) : []), ...novasRendas].reduce((s, p) => s + num(p.amount), 0)
    planejarPendente(m, {
      banco: 'US', tabela: 'invoice_incomes', key, moeda: 'US$', tol: TOL, elo: 'br_payment_id',
      rendasAlvo: alvo ? R.filter(p => p.invoice_id === alvo!.id) : [], grand, recebido, novas: novasRendas.length,
      ligadoAoBanco: id => foto.us.ponteirosBanco.has(`invoice_incomes:${id}`) || foto.us.ponteirosBanco.has(`invoice_payments:${id}`),
      camposNovo: valor => ({ invoice_id: ALVO, amount: valor, paid_at: null, payment_date: addDias(latest || hojeEm('America/New_York'), 30), source: null, description: 'Pending balance', paid_to: 'GZ28US', mirror_src: `pendente:${key}` }),
    })

    // ── a invoice: adotar (gravar a mirror_key) ou criar a próxima 006.N ──
    const temEscrita = m.c.ops.length > 0
    if (alvo && alvo.mirror_key !== key && temEscrita) m.op({ tipo: 'vincular_invoice', banco: 'US', id: alvo.id, codigo: alvo.invoice_code, como: m.c.alvo.como === 'texto' ? 'texto' : 'ponteiro', rotulo: `adota ${alvo.invoice_code}` })
    if (!alvo && temEscrita) {
      m.op({ tipo: 'criar_invoice', banco: 'US', serie: '006', codigo_previsto: '', rotulo: `nova 006.N para ${B.invoice_code}`, campos: {
        client_id: US_CLIENTE_GZ28BR, ride_id: null, is_quote: false, live_status: 'REALTIME', feed_status: 'REAL_TIME', global_discount: null,
        service: `GZ28BR Invoice ${B.invoice_code}.${dono ? ` ${dono}` : ''}${B.service ? ` - ${B.service}` : ''}`, florida_taxes: 0, import_margin: 10,
        hiring_date: ymd(B.hiring_date), client_hiring_date: ymd(B.hiring_date), mirror_key: key,
      } })
    }
    // O ponteiro também sai quando só ele ficou para trás (a 006.N já tem a mirror_key desta chave): rodada que
    // caiu depois de criar a invoice não deixa a origem sem apontar para ela.
    if ((temEscrita || alvo?.mirror_key === key) && !B.us_invoice_id) m.op({ tipo: 'ponteiro_origem', banco: 'BR', tabela: 'invoices', id: B.id, campo: 'us_invoice_id', rotulo: `${B.invoice_code}.us_invoice_id → a 006.N` })
    conferirElos(m, elosUS, codigoUS)
    montadores.push({ m, alvo })
  }
  for (const [id, keys] of reivindicadas) if (keys.length > 1) for (const { m } of montadores) if (keys.includes(m.c.mirror_key)) m.conflito(`a ${uInv.get(id)?.invoice_code} é reivindicada por ${keys.length} invoices do BR`)
  for (const { m } of montadores) chaves.push(m.fechar())
  return chaves
}

// ── DIREÇÕES 3 + 4 → BR 085.N ───────────────────────────────────────────────
type Fonte3 = { tabela: 'invoice_expenses' | 'assets' | 'assets_expenses' | 'staff_expenses'; linha: Row; usd: number; brl: number | null; q: number; unitUsd: number; taxUsd: number; extraUsd: number; dia: string; item: string; supplier: string | null; order: string | null; part: string | null }

function planejarBR(foto: Foto, cot: Cotacoes, excluidos: Excluido[]): ChavePlano[] {
  const uInv = new Map(foto.us.invoices.map(i => [i.id, i]))
  const uRide = new Map(foto.us.rides.map(r => [r.id, r]))
  const bInv = new Map(foto.br.invoices.map(i => [i.id, i]))
  const seasons = new Map(foto.us.seasons.map(s => [s.id, s]))
  const staff = new Map(foto.us.staff.map(s => [s.id, s]))
  const assetsById = new Map(foto.us.assets.map(a => [a.id, a]))
  const br085 = foto.br.invoices.filter(i => i.client_id === BR_CLIENTE_GZ28US)
  const docUS = (i: Row | undefined) => i?.invoice_code || '?'
  // bloqueios: linha que cruza mas não pode ser gravada sem resposta do dono (sem data, valor a confirmar) —
  // trava a chave inteira, com o motivo, em vez de sumir da conta calada.
  type Bloqueio = { linha: Row; usd: number | null; rotulo: string; motivo: string }
  const grupos = new Map<string, { tipo: 'invoice' | 'season' | 'assets'; id: string; fontes: Fonte3[]; rendas: Row[]; bloqueios: Bloqueio[] }>()
  const grupo = (key: string, tipo: 'invoice' | 'season' | 'assets', id: string) => { let g = grupos.get(key); if (!g) { g = { tipo, id, fontes: [], rendas: [], bloqueios: [] }; grupos.set(key, g) } return g }
  const exclui = (tabela: string, l: Row, documento: string, rotulo: string, usd: number | null, brl: number | null, motivo: string, direcao: Direcao = 3) => excluidos.push({ direcao, banco: 'US', tabela, id: l.id, documento, rotulo: rotulo.slice(0, 80), usd, brl, motivo })

  // Linha GZ28BR: quem pagou é o BR e a conta NÃO é do BR (PAID TO GZ28BR dos dois lados é interna do BR).
  const cruzaBR = (l: Row, tabela: string, doc: string, rot: string, usd: number) => {
    if (quemPagou(l) !== 'GZ28BR') return false
    if (empresa(l.paid_to) === 'GZ28BR') { exclui(tabela, l, doc, rot, usd, null, 'PAID FROM e PAID TO GZ28BR — conta interna do BR, não cruza'); return false }
    return true
  }

  for (const e of foto.us.despesas) {
    const U = uInv.get(e.invoice_id)
    if (!U) continue
    const usd = r2(custoUS(e)), rot = limpa(e.item)
    if (!cruzaBR(e, 'invoice_expenses', docUS(U), rot, usd)) continue
    if (U.client_id === US_CLIENTE_GZ28BR) { exclui('invoice_expenses', e, docUS(U), rot, usd, null, 'linha PAID FROM GZ28BR dentro de invoice do cliente GZ28BR — pergunta'); continue }
    if (U.is_quote) { exclui('invoice_expenses', e, docUS(U), rot, usd, null, 'invoice do US ainda é QUOTE'); continue }
    if (U.origin === 'BUCKET') { exclui('invoice_expenses', e, docUS(U), rot, usd, null, 'compra no balde (a atribuir) — atravessa quando tiver dono'); continue }
    const dia = ymd(e.payment_date)
    if (!dia) { exclui('invoice_expenses', e, docUS(U), rot, usd, null, 'sem payment_date — ainda não é pagamento'); continue }
    const q = num(e.quantity) || 1
    grupo(`US:invoice:${U.id}`, 'invoice', U.id).fontes.push({ tabela: 'invoice_expenses', linha: e, usd, brl: null, q, unitUsd: num(e.price), taxUsd: num(e.tax), extraUsd: num(e.extra), dia, item: rot, supplier: e.supplier || null, order: String(e.order_number || '').trim() || null, part: e.part_number || null })
  }
  for (const p of foto.us.rendas) {
    if (empresa(p.paid_to) !== 'GZ28BR') continue
    const U = uInv.get(p.invoice_id)
    if (!U) continue
    const rot = String(p.description || 'renda')
    if (U.client_id === US_CLIENTE_GZ28BR) { exclui('invoice_incomes', p, docUS(U), rot, num(p.amount), null, 'renda PAID TO GZ28BR dentro de invoice do cliente GZ28BR — pergunta', 4); continue }
    if (U.is_quote) { exclui('invoice_incomes', p, docUS(U), rot, num(p.amount), null, 'invoice do US ainda é QUOTE', 4); continue }
    if (!p.paid_at) { exclui('invoice_incomes', p, docUS(U), rot, num(p.amount), p.amount_brl == null ? null : num(p.amount_brl), 'renda ainda não recebida (sem paid_at)', 4); continue }
    grupo(`US:invoice:${U.id}`, 'invoice', U.id).rendas.push(p)
  }
  for (const a of foto.us.assets) {
    const q = num(a.quantity) || 1, usd = r2(num(a.unit_price) * q), rot = String(a.description || 'asset')
    if (!cruzaBR(a, 'assets', 'ASSETS', rot, usd)) continue
    const dia = ymd(a.payment_date)
    if (!dia) { exclui('assets', a, 'ASSETS', rot, usd, null, 'sem payment_date — ainda não é pagamento'); continue }
    grupo(`US:assets:${dia.slice(0, 7)}`, 'assets', dia.slice(0, 7)).fontes.push({ tabela: 'assets', linha: a, usd, brl: null, q, unitUsd: num(a.unit_price), taxUsd: 0, extraUsd: 0, dia, item: rot, supplier: a.supplier || null, order: String(a.order_number || '').trim() || null, part: null })
  }
  for (const a of foto.us.assetsExp) {
    const usd = r2(num(a.amount)), rot = `${assetsById.get(a.good_id)?.description ? assetsById.get(a.good_id)!.description + ' · ' : ''}${a.description || 'despesa de asset'}`
    if (!cruzaBR(a, 'assets_expenses', 'ASSETS', rot, usd)) continue
    const dia = ymd(a.payment_date)
    if (!dia) { exclui('assets_expenses', a, 'ASSETS', rot, usd, null, 'sem payment_date — ainda não é pagamento'); continue }
    grupo(`US:assets:${dia.slice(0, 7)}`, 'assets', dia.slice(0, 7)).fontes.push({ tabela: 'assets_expenses', linha: a, usd, brl: null, q: 1, unitUsd: usd, taxUsd: 0, extraUsd: 0, dia, item: rot, supplier: a.supplier || null, order: String(a.order_number || '').trim() || null, part: null })
  }
  for (const s of foto.us.staffExp) {
    const se = seasons.get(s.season_id), nome = staff.get(se?.staff_id)?.name || '?'
    const doc = `SEASON ${se?.season_code || '?'} ${nome}`, usd = r2(num(s.amount)), rot = `${s.type || ''} — ${s.description || ''}`
    if (!cruzaBR(s, 'staff_expenses', doc, rot, usd)) continue
    const brl = s.amount_brl == null || String(s.amount_brl) === '' ? null : r2(num(s.amount_brl))
    if (String(s.origin || '').toUpperCase() === 'PERSONAL') { exclui('staff_expenses', s, doc, rot, usd, brl, 'gasto PESSOAL pago pelo BR — pergunta antes de cruzar'); continue }
    const rotLinha = `${nome} · ${s.type || ''}${s.description ? ` — ${s.description}` : ''}`
    if (!ymd(s.payment_date) && !ymd(s.expense_date)) {
      if (TAXAS_SEM_DATA.has(s.id)) { exclui('staff_expenses', s, doc, rot, usd, brl, 'TAXA sem data (RATE de antes de 28/jul), não é pagamento — decisão 14/set'); continue }
      grupo(`US:season:${s.season_id}`, 'season', s.season_id).bloqueios.push({ linha: s, usd, rotulo: rotLinha, motivo: 'sem data (nem payment_date nem expense_date) — pagamento ou taxa? pergunta' })
      continue
    }
    const dia = ymd(s.payment_date)
    if (!dia) { exclui('staff_expenses', s, doc, rot, usd, brl, `sem payment_date (só expense_date ${ymd(s.expense_date)}) — ainda não é pagamento; pergunta`); continue }
    // Valor zero numa linha PAGA PAID FROM GZ28BR é pagamento de valor desconhecido («VALOR A CONFIRMAR»):
    // a season inteira espera, porque a 085.N dela nasceria sem a linha e o Pending balance mentiria.
    if (!usd && !brl) { grupo(`US:season:${s.season_id}`, 'season', s.season_id).bloqueios.push({ linha: s, usd, rotulo: rotLinha, motivo: 'valor a confirmar (US$ 0 e sem R$)' }); continue }
    grupo(`US:season:${s.season_id}`, 'season', s.season_id).fontes.push({ tabela: 'staff_expenses', linha: s, usd, brl, q: 1, unitUsd: usd, taxUsd: 0, extraUsd: 0, dia, item: rotLinha, supplier: s.supplier || nome, order: String(s.order_number || '').trim() || null, part: null })
  }
  for (const { tabela, linha } of foto.us.semOpcao) {
    if (quemPagou(linha) !== 'GZ28BR' && empresa(linha.paid_to) !== 'GZ28BR') continue
    const usd = linha.amount != null ? num(linha.amount) : r2(num(linha.unit_price) * (num(linha.quantity) || 1))
    exclui(tabela, linha, tabela.toUpperCase(), String(linha.description || ''), usd, null, 'tabela sem opção GZ28BR (pacote PAID FROM/TO: sempre GZ28US) — pergunta')
  }
  // Espelho que já existe no BR sem fonte hoje também entra, para aparecer.
  for (const i of br085) { const s = parseSrc(i.mirror_key); if (s?.banco === 'US') { const tipo = s.tabela as 'invoice' | 'season' | 'assets'; if (['invoice', 'season', 'assets'].includes(tipo)) grupo(i.mirror_key, tipo, s.id) } }
  for (const U of foto.us.invoices) if (U.br_invoice_id && bInv.get(U.br_invoice_id)?.client_id === BR_CLIENTE_GZ28US && !U.is_quote) grupo(`US:invoice:${U.id}`, 'invoice', U.id)

  const chaves: ChavePlano[] = []
  const reivindicadas = new Map<string, string[]>()
  const montadores: Montador[] = []
  const elosBR = mapaDeElos({ invoice_expenses: foto.br.despesas, invoice_parts: foto.br.partes, invoice_payments: foto.br.pagamentos })
  const codigoBR = (id: string) => bInv.get(id)?.invoice_code || '?'
  for (const [key, g] of grupos) {
    let origem: ChavePlano['origem'], textoService: string, prefixo: string
    let U: Row | undefined
    if (g.tipo === 'invoice') {
      U = uInv.get(g.id)
      const ride = U?.ride_id ? uRide.get(U.ride_id) : null
      const dono = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''
      origem = { banco: 'US', tipo: 'invoice', id: g.id, codigo: U?.invoice_code || '?', rotulo: `${U?.invoice_code || '?'}${dono ? ` ${dono}` : ''}${U?.service ? ` - ${U.service}` : ''}` }
      prefixo = `GZ28US Invoice ${U?.invoice_code}.`
      textoService = `GZ28US Invoice ${U?.invoice_code}.${dono ? ` ${dono}` : ''}${U?.service ? ` - ${U.service}` : ''}`
    } else if (g.tipo === 'season') {
      const se = seasons.get(g.id), nome = staff.get(se?.staff_id)?.name || '?'
      origem = { banco: 'US', tipo: 'season', id: g.id, codigo: se?.season_code || '?', rotulo: `SEASON ${se?.season_code || '?'} — ${nome}` }
      prefixo = textoService = `GZ28US Season ${se?.season_code || '?'} — ${nome}`
    } else {
      origem = { banco: 'US', tipo: 'assets', id: g.id, codigo: g.id, rotulo: `ASSETS ${g.id}` }
      prefixo = textoService = `GZ28US Assets ${g.id}`
    }
    const m = new Montador(key, 'BR', origem)
    montadores.push(m)
    if (g.fontes.length) m.dir(3)
    if (g.rendas.length) m.dir(4)
    if (g.tipo === 'invoice' && !U) { m.conflito('a 085.N tem mirror_key de uma invoice do US que não existe mais — espelho órfão'); continue }
    const bloqueioUS = U ? FORA_DE_ESCOPO_US[U.invoice_code] : undefined
    if (bloqueioUS) m.conflito(bloqueioUS)
    const segura = chaveSegura(key)
    if (segura) m.conflito(`SEGURA — ${segura}`)
    for (const bl of g.bloqueios) {
      m.conflito(`BLOQUEADA — ${bl.motivo}: ${bl.rotulo.slice(0, 60)}`)
      m.c.sem_par.push({ direcao: 3, lado: 'fonte', tabela: 'staff_expenses', id: bl.linha.id, usd: bl.usd, rotulo: bl.rotulo.slice(0, 80), motivo: bl.motivo })
    }

    // ── a 085.N-alvo ──
    const porKey = br085.filter(i => i.mirror_key === key)
    const ptr = U?.br_invoice_id ? bInv.get(U.br_invoice_id) : null
    const porTexto = br085.filter(i => String(i.service || '').startsWith(prefixo))
    if (porKey.length > 1) m.conflito(`${porKey.length} invoices do BR com a mesma mirror_key`)
    if (U?.br_invoice_id && !ptr) m.conflito(`ponteiro morto: br_invoice_id ${String(U.br_invoice_id).slice(0, 8)} aponta para uma 085.N que não existe — recriar só com ordem`)
    if (ptr && ptr.client_id !== BR_CLIENTE_GZ28US) m.conflito(`o ponteiro br_invoice_id aponta para ${ptr.invoice_code}, que não é do cliente GZ28 V8 SpeedShop USA LLC`)
    const candidatos = new Map<string, Row>()
    for (const i of [...porKey, ...(ptr && ptr.client_id === BR_CLIENTE_GZ28US ? [ptr] : []), ...porTexto]) candidatos.set(i.id, i)
    const cands = [...candidatos.values()]
    let alvo: Row | null = null
    if (cands.length > 1) m.conflito(`mais de uma 085.N para o mesmo documento: ${cands.map(i => i.invoice_code).join(' + ')}`)
    else if (cands.length === 1) {
      alvo = cands[0]
      if (alvo.is_quote) m.conflito(`a ${alvo.invoice_code} do BR é QUOTE`)
      m.c.alvo = { id: alvo.id, codigo: alvo.invoice_code, como: porKey.length ? 'mirror_key' : ptr ? 'ponteiro' : 'texto' }
      const l = reivindicadas.get(alvo.id) || []; l.push(key); reivindicadas.set(alvo.id, l)
    } else m.c.alvo = { id: null, codigo: null, como: 'criar' }
    const invAlvo = cands.map(i => i.id)
    const taxaInv = alvo ? alvo.usd_rate : null

    // ── linhas da direção 3 ──
    const E = foto.br.despesas.filter(e => invAlvo.includes(e.invoice_id))
    const Pt = foto.br.partes.filter(p => invAlvo.includes(p.invoice_id))
    const Pg = foto.br.pagamentos.filter(p => invAlvo.includes(p.invoice_id))
    const srcDe = (f: Fonte3) => `US:${f.tabela}:${f.linha.id}`
    const pares: { f: Fonte3; e: Row; como: Par['como'] }[] = []
    let FF = [...g.fontes], EE = [...E]
    for (const e of E) {
      const src = parseSrc(e.mirror_src)
      const f = src ? FF.find(x => x.tabela === src.tabela && x.linha.id === src.id) : e.us_expense_id ? FF.find(x => x.tabela === 'invoice_expenses' && x.linha.id === e.us_expense_id) : null
      if (f) { pares.push({ f, e, como: src ? 'mirror_src' : 'elo' }); FF = FF.filter(x => x !== f); EE = EE.filter(x => x !== e) }
      else if (src || e.us_expense_id) {
        EE = EE.filter(x => x !== e)
        m.c.sem_par.push({ direcao: 3, lado: 'alvo', tabela: 'invoice_expenses', id: e.id, usd: usdBR(e, taxaInv) == null ? null : r2(usdBR(e, taxaInv) as number), rotulo: limpa(e.item).slice(0, 80), motivo: 'o elo aponta para linha do US que não é mais fonte desta 085.N' })
        m.conflito(`despesa ${limpa(e.item).slice(0, 40)} da ${bInv.get(e.invoice_id)?.invoice_code} tem elo para linha do US que não cruza mais`)
      }
    }
    const c3 = casar(FF, EE, (f, e) => perto(usdBR(e, taxaInv), f.usd), f => chaveTexto(f.item), e => chaveTexto(e.item))
    c3.pares.forEach(p => pares.push({ f: p.s, e: p.t, como: 'valor' }))
    const sobraF = c3.restoS, sobraE = c3.restoT
    let PP = [...Pt]
    const parteDe = new Map<Fonte3, Row>()
    for (const p of Pt) { const src = parseSrc(p.mirror_src); if (src) { const f = g.fontes.find(x => x.tabela === src.tabela && x.linha.id === src.id); if (f) { parteDe.set(f, p); PP = PP.filter(x => x !== p) } } }
    const cp = casar(pares.filter(p => !parteDe.has(p.f)), PP, (p, pt) => perto(num(pt.unit_price_usd) * (num(pt.quantity) || 1), p.f.usd) || perto(linhaItem(pt), brlBR(p.e), 0.05), p => chaveTexto(p.f.item), pt => chaveTexto(pt.description))
    cp.pares.forEach(x => parteDe.set(x.s.f, x.t))
    const cpTxt = casar(cp.restoS, cp.restoT, (p, pt) => chaveTexto(p.f.item).length >= 6 && chaveTexto(p.f.item) === chaveTexto(pt.description), p => chaveTexto(p.f.item), pt => chaveTexto(pt.description))
    cpTxt.pares.forEach(x => parteDe.set(x.s.f, x.t))
    const sobraP = cpTxt.restoT
    // A escrita pela metade, do lado das 085.N (ver planejarUS): despesa que o motor gravou sem a parte.
    const faltaParte: { f: Fonte3; e: Row }[] = []
    for (const p of pares) {
      const Rv = usdBR(p.e, taxaInv), pt = parteDe.get(p.f)
      const ok = perto(Rv, p.f.usd)
      m.c.pares.push({ direcao: 3, fonte_tabela: p.f.tabela, fonte_id: p.f.linha.id, alvo_tabela: 'invoice_expenses', alvo_id: p.e.id, alvo_invoice: bInv.get(p.e.invoice_id)?.invoice_code || '?', como: p.como, classe: ok ? 'ok' : 'divergente', usd_fonte: p.f.usd, usd_alvo: Rv == null ? null : r2(Rv), rotulo: p.f.item.slice(0, 80) })
      if (!ok) m.conflito(`valor divergente: ${p.f.item.slice(0, 40)} — US US$ ${p.f.usd} × BR US$ ${Rv == null ? 'sem amount_usd' : r2(Rv)}`)
      if (p.f.brl != null && !perto(brlBR(p.e), p.f.brl, 0.05)) m.aviso(`${p.f.item.slice(0, 40)}: R$ gravado no US ${p.f.brl} × R$ no BR ${r2(brlBR(p.e))} — os dois gravados, nada muda`)
      if (!pt) {
        if (p.como === 'mirror_src' && ok) faltaParte.push({ f: p.f, e: p.e })
        else m.conflito(`a despesa ${limpa(p.e.item).slice(0, 40)} não tem item correspondente na ${bInv.get(p.e.invoice_id)?.invoice_code}`)
      }
      else if (!perto(num(pt.unit_price_usd) * (num(pt.quantity) || 1), p.f.usd) && !perto(linhaItem(pt), brlBR(p.e), 0.05)) m.conflito(`item divergente na ${bInv.get(p.e.invoice_id)?.invoice_code}: ${limpa(pt.description).slice(0, 40)} US$ ${r2(num(pt.unit_price_usd) * (num(pt.quantity) || 1))} / R$ ${r2(linhaItem(pt))} × despesa US$ ${p.f.usd} / R$ ${r2(brlBR(p.e))}`)
      const precisaElo = p.f.tabela === 'invoice_expenses' && !p.e.us_expense_id
      if (p.e.us_expense_id && p.f.tabela === 'invoice_expenses' && p.e.us_expense_id !== p.f.linha.id) m.conflito(`a despesa ${limpa(p.e.item).slice(0, 40)} tem us_expense_id de outra linha`)
      else if (p.como !== 'mirror_src') m.op({ tipo: 'vincular_linha', banco: 'BR', tabela: 'invoice_expenses', id: p.e.id, mirror_src: srcDe(p.f), elo: precisaElo ? { campo: 'us_expense_id', valor: p.f.linha.id } : null, direcao: 3, rotulo: `despesa ${p.f.item.slice(0, 50)} (${p.como})` })
      if (pt && !parseSrc(pt.mirror_src)) m.op({ tipo: 'vincular_linha', banco: 'BR', tabela: 'invoice_parts', id: pt.id, mirror_src: srcDe(p.f), elo: null, direcao: 3, rotulo: `item ${limpa(pt.description).slice(0, 50)}` })
    }
    for (const e of sobraE) {
      const Rv = usdBR(e, taxaInv)
      m.c.sem_par.push({ direcao: 3, lado: 'alvo', tabela: 'invoice_expenses', id: e.id, usd: Rv == null ? null : r2(Rv), rotulo: limpa(e.item).slice(0, 80), motivo: c3.ambiguas.length ? 'mais de um candidato no US com o mesmo valor' : 'nenhuma linha PAID FROM GZ28BR do US com este valor' })
      m.conflito(`despesa na ${bInv.get(e.invoice_id)?.invoice_code} sem origem no US: ${limpa(e.item).slice(0, 40)} US$ ${Rv == null ? '?' : r2(Rv)}`)
    }
    for (const p of sobraP) m.conflito(`item na 085.N sem origem no US: ${limpa(p.description).slice(0, 40)} R$ ${r2(linhaItem(p))}`)
    if (E.length) for (const f of sobraF) m.c.sem_par.push({ direcao: 3, lado: 'fonte', tabela: f.tabela, id: f.linha.id, usd: f.usd, rotulo: f.item.slice(0, 80), motivo: c3.ambiguas.includes(f) ? 'mais de um candidato na 085.N com o mesmo valor' : 'não está na 085.N — linha a criar' })

    // ── criar o que falta (câmbio: R$ gravado prevalece; senão a regra do app, carimbada na linha) ──
    let pos = maxPos(E), posP = maxPos(Pt), latest: string | null = null, latestRate: number | null = null
    for (const f of g.fontes) m.data(f.dia)
    const novasPartes: Row[] = []
    for (const x of faltaParte) {
      // O R$ é o que JÁ está gravado na despesa espelhada — nunca carimbado de novo.
      const lineBrl = r2(brlBR(x.e)), src = srcDe(x.f)
      const parte = { invoice_id: ALVO, description: x.f.item, unit_price: r2(lineBrl / x.f.q), base_cost: r2(lineBrl / x.f.q), unit_price_usd: r2(x.f.usd / x.f.q), quantity: x.f.q, payment_date: x.f.dia, position: ++posP, mirror_src: src }
      novasPartes.push(parte)
      m.op({ tipo: 'criar_linha', banco: 'BR', tabela: 'invoice_parts', mirror_src: src, direcao: 3, papel: 'item', usd: x.f.usd, brl: lineBrl, rotulo: `item ${x.f.item.slice(0, 50)} (a rodada anterior parou antes dele)`, campos: parte,
        confere: [confere('US', x.f.tabela, x.f.linha, colsFonte3(x.f.tabela)), confere('BR', 'invoice_expenses', x.e, [...COLS.espelho])] })
    }
    for (const f of [...sobraF].sort((x, y) => x.dia.localeCompare(y.dia) || x.item.localeCompare(y.item))) {
      let price: number, tax: number, ext: number, regra: string
      if (f.brl != null) { price = r2(f.brl); tax = 0; ext = 0; regra = 'R$ gravado no US' }
      else {
        const rg = regraApp(cot, f.dia)
        if (!rg) { m.conflito(`sem cotação para ${f.dia} — ${f.item.slice(0, 40)} não tem R$`); continue }
        price = r2(f.unitUsd * rg.taxa); tax = r2(f.taxUsd * rg.taxa); ext = r2(f.extraUsd * rg.taxa); regra = rg.texto
        if (!latest || f.dia >= latest) { latest = f.dia; latestRate = rg.usdRate }
      }
      const lineBrl = r2(price * f.q + tax + ext), lineUsd = f.usd
      const src = srcDe(f)
      const conf3 = [confere('US', f.tabela, f.linha, colsFonte3(f.tabela))]
      m.op({ tipo: 'criar_linha', banco: 'BR', tabela: 'invoice_expenses', mirror_src: src, direcao: 3, papel: 'despesa', usd: lineUsd, brl: lineBrl, rotulo: `despesa ${f.item.slice(0, 50)} · ${regra}`, confere: conf3, campos: {
        invoice_id: ALVO, item: f.item, supplier: f.supplier, price, amount_usd: r2(f.unitUsd), quantity: f.q, tax, extra: ext, payment_date: f.dia, expense_date: f.dia,
        source: 'GZ28BR', paid_from: 'GZ28BR', paid_to: 'GZ28BR', item_discount: 0, position: ++pos, order_number: f.order, part_number: f.part,
        us_expense_id: f.tabela === 'invoice_expenses' ? f.linha.id : null, mirror_src: src,
      } })
      const parte = { invoice_id: ALVO, description: f.item, unit_price: r2(lineBrl / f.q), base_cost: r2(lineBrl / f.q), unit_price_usd: r2(lineUsd / f.q), quantity: f.q, payment_date: f.dia, position: ++posP, mirror_src: src }
      novasPartes.push(parte)
      m.op({ tipo: 'criar_linha', banco: 'BR', tabela: 'invoice_parts', mirror_src: src, direcao: 3, papel: 'item', usd: lineUsd, brl: lineBrl, rotulo: `item ${f.item.slice(0, 50)}`, campos: parte, confere: conf3 })
    }

    // ── direção 4: a renda do US que caiu no BR entra PAGA na 085.N ──
    let PgPagos = Pg.filter(p => p.paid_at)
    const novosPag: Row[] = []
    for (const s of g.rendas) {
      const dia = ymd(s.payment_date) || diaEm(s.paid_at, 'America/New_York')
      m.data(dia)
      const usd = r2(num(s.amount))
      const gravado = s.amount_brl != null && String(s.amount_brl) !== ''
      let brl: number, regra = 'R$ gravado no US'
      const src = `US:invoice_incomes:${s.id}`
      // O elo em TODOS os pagamentos da 085.N, com baixa ou sem (revisão 14/set/2026 — ver a direção 2).
      const eloQualquer = Pg.find(p => p.mirror_src === src || p.us_income_id === s.id)
      if (eloQualquer && !eloQualquer.paid_at) { m.conflito(`o pagamento espelhado de ${String(s.description || 'renda').slice(0, 30)} (${String(eloQualquer.id).slice(0, 8)}) está SEM baixa no BR, mas a renda no US está paga — alguém desmarcou? qual vale?`); continue }
      if (eloQualquer && eloQualquer.mirror_src && eloQualquer.mirror_src !== src) { m.conflito(`o pagamento ${String(eloQualquer.id).slice(0, 8)} tem o us_income_id de ${String(s.description || 'renda').slice(0, 30)}, mas outro elo (${eloQualquer.mirror_src}) — qual vale?`); continue }
      const jaElo = eloQualquer || null
      const conf4 = [confere('US', 'invoice_incomes', s, [...COLS.usRenda])]
      if (gravado) brl = r2(num(s.amount_brl))
      else {
        // O R$ já gravado no pagamento espelhado do BR prevalece sobre a regra; senão, a regra do app.
        const rg = jaElo ? null : regraApp(cot, dia)
        if (!jaElo && !rg) { m.conflito(`sem cotação para ${dia || 'data vazia'} — renda ${String(s.description || '').slice(0, 30)} não tem R$`); continue }
        brl = jaElo ? r2(num(jaElo.amount)) : r2(usd * rg!.taxa)
        regra = jaElo ? `R$ já gravado no pagamento espelhado ${jaElo.id.slice(0, 8)}` : rg!.texto
        m.op({ tipo: 'carimbo', banco: 'US', tabela: 'invoice_incomes', id: s.id, campo: 'amount_brl', valor: brl, regra, direcao: 4, rotulo: `R$ da renda ${String(s.description || '').slice(0, 40)} carimbado`,
          guarda: { amount: s.amount ?? null, paid_to: s.paid_to ?? null }, confere: conf4 })
      }
      const ja = jaElo || (() => { const c = PgPagos.filter(p => !p.mirror_src && !p.us_income_id && ymd(p.payment_date) === dia && (perto(num(p.amount_usd), usd) || perto(num(p.amount), brl, 0.05))); return c.length === 1 ? c[0] : null })()
      if (ja) {
        PgPagos = PgPagos.filter(p => p !== ja)
        const ok = ja.amount_usd != null ? perto(num(ja.amount_usd), usd) : perto(num(ja.amount), brl, 0.05)
        m.c.pares.push({ direcao: 4, fonte_tabela: 'invoice_incomes', fonte_id: s.id, alvo_tabela: 'invoice_payments', alvo_id: ja.id, alvo_invoice: bInv.get(ja.invoice_id)?.invoice_code || '?', como: ja.mirror_src === src ? 'mirror_src' : ja.us_income_id === s.id ? 'elo' : 'valor', classe: ok ? 'ok' : 'divergente', usd_fonte: usd, usd_alvo: ja.amount_usd == null ? null : num(ja.amount_usd), rotulo: String(s.description || '').slice(0, 80) })
        if (!ok) m.conflito(`renda espelhada com valor divergente: ${String(s.description || '').slice(0, 30)}`)
        else if (ja.mirror_src !== src) m.op({ tipo: 'vincular_linha', banco: 'BR', tabela: 'invoice_payments', id: ja.id, mirror_src: src, elo: ja.us_income_id ? null : { campo: 'us_income_id', valor: s.id }, direcao: 4, rotulo: `renda ${String(s.description || '').slice(0, 50)}` })
      } else {
        const campos = { invoice_id: ALVO, amount: brl, amount_usd: usd, payment_date: dia, paid_at: s.paid_at, source: null, paid_from: 'GZ28US', paid_to: 'GZ28BR', description: `Income ${U?.invoice_code || ''} — ${String(s.description || 'renda').trim()} (PAID TO GZ28BR)`, us_income_id: s.id, mirror_src: src }
        novosPag.push(campos)
        m.op({ tipo: 'criar_linha', banco: 'BR', tabela: 'invoice_payments', mirror_src: src, direcao: 4, papel: 'renda', usd, brl, rotulo: `renda ${String(s.description || '').slice(0, 50)} · ${regra}`, campos, confere: conf4 })
      }
    }

    // ── o Pending balance em R$: grand total − o que já foi pago ──
    const partesDepois = [...(alvo ? Pt.filter(p => p.invoice_id === alvo!.id) : []), ...novasPartes]
    const servicos = alvo ? foto.br.servicos.filter(s => s.invoice_id === alvo!.id) : []
    const grand = grandTotal(partesDepois, servicos, alvo || { florida_taxes: 0, global_discount: null }, linhaItem)
    const pago = [...(alvo ? Pg.filter(p => p.invoice_id === alvo!.id && p.paid_at) : []), ...novosPag].reduce((s, p) => s + num(p.amount), 0)
    let latestAll: string | null = null
    for (const f of g.fontes) if (!latestAll || f.dia > latestAll) latestAll = f.dia
    planejarPendente(m, {
      banco: 'BR', tabela: 'invoice_payments', key, moeda: 'R$', tol: 0.05, elo: 'us_income_id',
      rendasAlvo: alvo ? Pg.filter(p => p.invoice_id === alvo!.id) : [], grand, recebido: pago, novas: novosPag.length,
      ligadoAoBanco: () => false,
      camposNovo: valor => ({ invoice_id: ALVO, amount: valor, paid_at: null, payment_date: latestAll || hojeEm('America/Sao_Paulo'), source: null, description: 'Pending balance', paid_from: 'GZ28US', paid_to: 'GZ28BR', mirror_src: `pendente:${key}` }),
    })

    const temEscrita = m.c.ops.length > 0
    if (alvo && alvo.mirror_key !== key && temEscrita) m.op({ tipo: 'vincular_invoice', banco: 'BR', id: alvo.id, codigo: alvo.invoice_code, como: m.c.alvo.como === 'texto' ? 'texto' : 'ponteiro', rotulo: `adota ${alvo.invoice_code}` })
    if (!alvo && temEscrita) {
      if (latestRate == null) { const d = latestAll || [...g.rendas.map(r => ymd(r.payment_date))].filter(Boolean).sort().pop() || null; latestRate = regraApp(cot, d)?.usdRate ?? null }
      m.op({ tipo: 'criar_invoice', banco: 'BR', serie: '085', codigo_previsto: '', rotulo: `nova 085.N para ${origem.rotulo.slice(0, 60)}`, campos: {
        client_id: BR_CLIENTE_GZ28US, ride_id: null, is_quote: false, live_status: 'REALTIME', feed_status: 'REAL_TIME', global_discount: null,
        service: textoService, florida_taxes: 0, import_margin: 0, usd_rate: latestRate, mirror_key: key,
      } })
    }
    if ((temEscrita || alvo?.mirror_key === key) && g.tipo === 'invoice' && U && !U.br_invoice_id) m.op({ tipo: 'ponteiro_origem', banco: 'US', tabela: 'invoices', id: U.id, campo: 'br_invoice_id', rotulo: `${U.invoice_code}.br_invoice_id → a 085.N` })
    conferirElos(m, elosBR, codigoBR)
  }
  for (const [id, keys] of reivindicadas) if (keys.length > 1) for (const m of montadores) if (keys.includes(m.c.mirror_key)) m.conflito(`a ${bInv.get(id)?.invoice_code} é reivindicada por ${keys.length} documentos do US`)
  for (const m of montadores) chaves.push(m.fechar())
  return chaves
}

// ── numeração prevista, impressão digital, manchete ─────────────────────────
function numerar(chaves: ChavePlano[], foto: Foto) {
  const maxDe = (rows: Row[], cliente: string, serie: string) => rows.filter(i => i.client_id === cliente).reduce((mx, i) => { const mm = String(i.invoice_code || '').match(new RegExp(`^${serie.replace('.', '\\.')}\\.(\\d+)$`)); return mm ? Math.max(mx, parseInt(mm[1])) : mx }, 0)
  let us = maxDe(foto.us.invoices, US_CLIENTE_GZ28BR, '006'), br = maxDe(foto.br.invoices, BR_CLIENTE_GZ28US, '085')
  const novas = chaves.filter(c => c.status === 'criar').sort((a, b) => String(a.primeira_data || '9').localeCompare(String(b.primeira_data || '9')) || a.origem.rotulo.localeCompare(b.origem.rotulo))
  for (const c of novas) for (const o of c.ops) if (o.tipo === 'criar_invoice') {
    o.codigo_previsto = o.serie === '006' ? `006.${++us}` : `085.${++br}`
    c.alvo.codigo = o.codigo_previsto
  }
}

function impressao(c: ChavePlano): string {
  const semCodigo = c.ops.map(o => o.tipo === 'criar_invoice' ? { ...o, codigo_previsto: undefined } : o)
  // Os PARES entram na impressão (14/set/2026): como cada linha foi casada (mirror_src, elo, valor) é o
  // estado das colunas de elo — um plano lido antes do backfill ou de um save não bate com o de agora.
  const pares = c.pares.map(p => [p.fonte_tabela, p.fonte_id, p.alvo_id, p.como, p.classe])
  const semPar = c.sem_par.map(s => [s.lado, s.tabela, s.id])
  return createHash('sha256').update(JSON.stringify({ k: c.mirror_key, s: c.status, a: c.alvo.id, ac: c.alvo.como, ops: semCodigo, x: c.conflitos, p: pares, sp: semPar })).digest('hex').slice(0, 16)
}

export function manchete(foto: Foto): Manchete {
  const us006 = foto.us.invoices.filter(i => i.client_id === US_CLIENTE_GZ28BR && !i.is_quote && !i.ride_id)
  const ids = new Set(us006.map(i => i.id))
  const itens = agrupar(foto.us.itens.filter(i => ids.has(i.invoice_id)), i => i.invoice_id)
  const serv = agrupar(foto.us.servicos.filter(s => ids.has(s.invoice_id)), s => s.invoice_id)
  let gU = 0, rU = 0
  for (const i of us006) gU += grandTotal(itens.get(i.id) || [], serv.get(i.id) || [], i, linhaItem)
  for (const p of foto.us.rendas) if (ids.has(p.invoice_id) && p.paid_at) rU += num(p.amount)
  const b085 = foto.br.invoices.filter(i => i.client_id === BR_CLIENTE_GZ28US && !i.is_quote)
  const bId = new Map(b085.map(i => [i.id, i]))
  let gB = 0, gBu = 0, pB = 0, pBu = 0, conv = 0
  for (const p of foto.br.partes) {
    const inv = bId.get(p.invoice_id); if (!inv) continue
    gB += linhaItem(p)
    if (p.unit_price_usd != null && String(p.unit_price_usd) !== '') gBu += num(p.unit_price_usd) * (num(p.quantity) || 1)
    else { conv++; gBu += num(inv.usd_rate) > 0 ? linhaItem(p) / num(inv.usd_rate) : 0 }
  }
  for (const p of foto.br.pagamentos) {
    const inv = bId.get(p.invoice_id); if (!inv || !p.paid_at) continue
    pB += num(p.amount)
    if (p.amount_usd != null && String(p.amount_usd) !== '') pBu += num(p.amount_usd)
    else { conv++; pBu += num(inv.usd_rate) > 0 ? num(p.amount) / num(inv.usd_rate) : 0 }
  }
  const saldoUS = r2(gU - rU), saldoBR = r2(gBu - pBu)
  return {
    us_006: { invoices: us006.length, grand_usd: r2(gU), recebido_usd: r2(rU), saldo_usd: saldoUS },
    br_085: { invoices: b085.length, grand_usd: r2(gBu), grand_brl: r2(gB), pago_usd: r2(pBu), pago_brl: r2(pB), saldo_usd: saldoBR, convertidos_pela_taxa_da_invoice: conv },
    br_deve_ao_us_usd: r2(saldoUS - saldoBR),
  }
}

export function dinheiroParado(chaves: ChavePlano[]): Plano['manchete']['bloqueadas'] {
  const lista: Bloqueada[] = chaves.filter(c => c.status === 'conflito').map(c => ({
    mirror_key: c.mirror_key, origem: c.origem.rotulo, alvo: c.alvo.codigo, banco_alvo: c.banco_alvo, direcoes: c.direcoes,
    alvo_ja_na_manchete: !!c.alvo.id,
    itens_usd: c.numeros.itens_usd, itens_brl: c.numeros.itens_brl,
    despesas_usd: c.numeros.usd_criar, despesas_brl: c.numeros.brl_criar,
    rendas_usd: c.numeros.renda_usd, rendas_brl: c.numeros.renda_brl,
    motivos: c.conflitos.slice(0, 5),
  }))
  const soma = (f: (b: Bloqueada) => number) => r2(lista.reduce((s, b) => s + f(b), 0))
  return { chaves: lista, total: { itens_usd: soma(b => b.itens_usd), despesas_usd: soma(b => b.despesas_usd), rendas_usd: soma(b => b.rendas_usd), rendas_brl: soma(b => b.rendas_brl) } }
}

// A foto como ficaria depois do plano (só chaves criar/atualizar) — para a manchete do DEPOIS.
export function simular(foto: Foto, chaves: ChavePlano[]): Foto {
  const f: Foto = { ...foto, us: { ...foto.us }, br: { ...foto.br } }
  const tab = (banco: Banco, tabela: string): { get: () => Row[]; set: (r: Row[]) => void } => {
    const lado: any = banco === 'US' ? f.us : f.br
    const nome = ({ invoices: 'invoices', invoice_expenses: 'despesas', invoice_items: 'itens', invoice_incomes: 'rendas', invoice_parts: 'partes', invoice_payments: 'pagamentos' } as Record<string, string>)[tabela]
    return nome ? { get: () => lado[nome], set: (r: Row[]) => { lado[nome] = r } } : { get: () => [], set: () => undefined }
  }
  for (const c of chaves) {
    if (c.status !== 'criar' && c.status !== 'atualizar') continue
    let alvoId = c.alvo.id || `novo:${c.mirror_key}`
    for (const o of c.ops) {
      if (o.tipo === 'criar_invoice') { alvoId = `novo:${c.mirror_key}`; const t = tab(o.banco, 'invoices'); t.set([...t.get(), { ...o.campos, id: alvoId, invoice_code: o.codigo_previsto }]) }
      else if (o.tipo === 'vincular_invoice') { const t = tab(o.banco, 'invoices'); t.set(t.get().map(r => r.id === o.id ? { ...r, mirror_key: c.mirror_key } : r)) }
      else if (o.tipo === 'criar_linha' || o.tipo === 'pendente_criar') { const t = tab(o.banco, o.tabela); t.set([...t.get(), { ...o.campos, id: `novo:${o.mirror_src}`, invoice_id: alvoId }]) }
      else if (o.tipo === 'vincular_linha') { const t = tab(o.banco, o.tabela); t.set(t.get().map(r => r.id === o.id ? { ...r, mirror_src: o.mirror_src, ...(o.elo ? { [o.elo.campo]: o.elo.valor } : {}) } : r)) }
      else if (o.tipo === 'carimbo') { const t = tab(o.banco, o.tabela); t.set(t.get().map(r => r.id === o.id ? { ...r, [o.campo]: o.valor } : r)) }
      else if (o.tipo === 'pendente_atualizar') { const t = tab(o.banco, o.tabela); t.set(t.get().map(r => r.id === o.id ? { ...r, amount: o.para, mirror_src: o.mirror_src } : r)) }
      else if (o.tipo === 'pendente_apagar') { const t = tab(o.banco, o.tabela); t.set(t.get().filter(r => r.id !== o.id)) }
    }
  }
  return f
}

export type OpcoesPlano = { cotacoes?: Cotacoes }

/** Lê os dois bancos e devolve o DIFF por mirror_key. NÃO ESCREVE NADA. */
export async function planCrossings(b: Bancos, opcoes: OpcoesPlano = {}): Promise<Plano> {
  const foto = await lerFoto(b)
  return montarPlano(foto, opcoes.cotacoes ?? await carregarCotacoes(datasDaFoto(foto), b.us))
}

// Toda data que pode precisar de câmbio: rendas das direções 2 e 4 e linhas da direção 3.
export function datasDaFoto(foto: Foto): string[] {
  const d: (string | null)[] = []
  for (const p of foto.br.pagamentos) if (empresa(p.paid_to) === 'GZ28US') d.push(ymd(p.payment_date) || diaEm(p.paid_at, 'America/Sao_Paulo'))
  for (const p of foto.us.rendas) if (empresa(p.paid_to) === 'GZ28BR') d.push(ymd(p.payment_date) || diaEm(p.paid_at, 'America/New_York'))
  for (const t of [foto.us.despesas, foto.us.assets, foto.us.assetsExp, foto.us.staffExp]) for (const l of t) if (quemPagou(l) === 'GZ28BR') d.push(ymd(l.payment_date))
  return d.filter((x): x is string => !!x)
}

export function montarPlano(foto: Foto, cot: Cotacoes): Plano {
  const excluidos: Excluido[] = [], correcoes: CorrecaoB[] = []
  const chaves = [...planejarUS(foto, cot, excluidos, correcoes), ...planejarBR(foto, cot, excluidos)]
  numerar(chaves, foto)
  for (const c of chaves) c.impressao = impressao(c)
  chaves.sort((a, b) => a.banco_alvo.localeCompare(b.banco_alvo) || String(a.alvo.codigo || 'zzz').localeCompare(String(b.alvo.codigo || 'zzz'), 'en', { numeric: true }) || a.mirror_key.localeCompare(b.mirror_key))
  return {
    versao: 1,
    gerado_em: foto.lida_em,
    migrado: { US: !foto.faltando.US.length, BR: !foto.faltando.BR.length, faltando: foto.faltando },
    cotacao: { fonte: 'AwesomeAPI json/daily/USD-BRL (bid) · (bid + 0,20) × 1,0638', falha: cot.falha },
    chaves, excluidos, correcoes_b: correcoes,
    manchete: { antes: manchete(foto), depois: manchete(simular(foto, chaves)), bloqueadas: dinheiroParado(chaves) },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// A ESCRITA
// ════════════════════════════════════════════════════════════════════════════
// erro_tipo (revisão 14/set/2026): 'conflito' = o banco não estava como o plano leu (linha mudou, elo já
// existe, trava, código repetido) — a chave para, as OUTRAS seguem e a próxima rodada refaz o plano;
// 'banco' = falha de verdade (rede, permissão, trilha que não gravou) — a rodada inteira para.
export type ResultadoChave = { mirror_key: string; resultado: 'aplicada' | 'pulada' | 'recusada' | 'erro'; motivo: string | null; codigo: string | null; escritas: number; erro_tipo?: 'conflito' | 'banco' }
export type ResultadoAplicacao = { ok: boolean; chaves: ResultadoChave[]; parou_em: string | null; parou_por: 'erro' | 'tempo' | 'lote' | null; restantes: number }

const faltaMigracao = (p: Plano) => new ErroTravessia('schema', `As migrations da travessia não rodaram — faltam: US [${p.migrado.faltando.US.join(', ')}] · BR [${p.migrado.faltando.BR.join(', ')}]. Nada foi escrito.`)

// O laço único de escrita, do applyPlan e do sincronizar.
async function rodarChaves(b: Bancos, lista: ChavePlano[], o: { t0: number; limiteMs?: number; maxChaves?: number; pausada?: boolean; listarTravadas: boolean }) {
  const out: ResultadoChave[] = []
  let aplicadas = 0, restantes = 0, conflitos = 0
  let parou_por: ResultadoAplicacao['parou_por'] = null, parou_em: string | null = null
  for (const c of lista) {
    const base = { mirror_key: c.mirror_key, codigo: c.alvo.codigo, escritas: 0 }
    if (c.status === 'conflito') { conflitos++; if (o.listarTravadas) out.push({ ...base, resultado: 'pulada', motivo: c.conflitos.join(' · ') }); continue }
    if (c.status === 'nada') { if (o.listarTravadas) out.push({ ...base, resultado: 'pulada', motivo: 'nada a fazer' + (c.avisos.length ? ` (${c.avisos.join(' · ')})` : '') }); continue }
    if (o.pausada) { restantes++; out.push({ ...base, resultado: 'pulada', motivo: 'TRAVESSIA_PAUSADA no ambiente do US — nada gravado' }); continue }
    if (parou_por) { restantes++; continue }
    if (o.maxChaves && aplicadas >= o.maxChaves) { parou_por = 'lote'; restantes++; continue }
    if (o.limiteMs && Date.now() - o.t0 > o.limiteMs) { parou_por = 'tempo'; restantes++; continue }
    const r = await executarChave(b, c)
    if (r.resultado === 'pulada') restantes++   // a trava estava com outra rodada: fica para a próxima
    else aplicadas++
    out.push({ ...base, ...r, motivo: r.motivo ?? (c.avisos.length ? c.avisos.join(' · ') : null) })
    if (r.resultado === 'erro' && r.erro_tipo === 'banco') { parou_por = 'erro'; parou_em = c.mirror_key }
  }
  return { out, restantes, conflitos, parou_por, parou_em }
}

/**
 * Grava o plano CONFERIDO. Exige confirm:true. Refaz o plano AGORA e só grava a chave cuja impressão digital
 * bate com a do plano recebido e com a de `impressoes` — plano velho não escreve.
 * REVISÃO 14/set/2026: com `impressoes`, só as chaves que ESTÃO nelas são gravadas (impressoes {} = nada);
 * as outras nem são olhadas. Mesmo relógio do sincronizar: chave nova não começa depois de `limiteMs`.
 * Conflito e «nada» são pulados; erro de conflito para só a chave; erro de banco para a rodada.
 */
export async function applyPlan(b: Bancos, plano: Plano, opcoes: { confirm: boolean; keys?: string[]; impressoes?: Record<string, string>; limiteMs?: number }): Promise<ResultadoAplicacao> {
  const t0 = Date.now()
  if (opcoes?.confirm !== true) throw new ErroTravessia('bad-request', 'applyPlan sem confirm:true não escreve nada.')
  const fresco = await planCrossings(b)
  if (!fresco.migrado.US || !fresco.migrado.BR) throw faltaMigracao(fresco)
  const pedidas = opcoes.keys?.length ? new Set(opcoes.keys) : null
  const conferidas = opcoes.impressoes ? new Set(Object.keys(opcoes.impressoes)) : null
  const out: ResultadoChave[] = []
  const lista: ChavePlano[] = []
  if (conferidas) for (const k of conferidas) if ((!pedidas || pedidas.has(k)) && !plano.chaves.some(c => c.mirror_key === k)) out.push({ mirror_key: k, resultado: 'recusada', motivo: 'a chave conferida não está no plano', codigo: null, escritas: 0 })
  for (const chave of plano.chaves) {
    if (pedidas && !pedidas.has(chave.mirror_key)) continue
    const base = { mirror_key: chave.mirror_key, codigo: chave.alvo.codigo, escritas: 0 }
    if (conferidas && !conferidas.has(chave.mirror_key)) { if (pedidas) out.push({ ...base, resultado: 'recusada', motivo: 'sem impressão conferida para esta chave — nada gravado' }); continue }
    const f = fresco.chaves.find(c => c.mirror_key === chave.mirror_key)
    if (!f) { out.push({ ...base, resultado: 'recusada', motivo: 'a chave não existe mais no plano refeito agora' }); continue }
    if (f.impressao !== chave.impressao || (conferidas && opcoes.impressoes![chave.mirror_key] !== f.impressao)) { out.push({ ...base, resultado: 'recusada', motivo: 'o plano mudou desde a leitura — rode o GET de novo e confira' }); continue }
    lista.push(f)
  }
  const r = await rodarChaves(b, lista, { t0, limiteMs: opcoes.limiteMs, listarTravadas: true })
  return { ok: r.parou_por !== 'erro', chaves: [...out, ...r.out], parou_em: r.parou_em, parou_por: r.parou_por, restantes: r.restantes }
}

// ════════════════════════════════════════════════════════════════════════════
// OS GANCHOS — EDITOR E CRON (14/set/2026)
// ════════════════════════════════════════════════════════════════════════════

export type OrigemSincronia = 'editor' | 'cron' | 'manual'
export type OpcoesSincronia = {
  keys?: string[]            // só estas chaves (o editor manda uma); vazio = o plano inteiro
  limiteMs?: number          // não COMEÇA chave nova depois disto (a que está no meio termina)
  maxChaves?: number         // no máximo N chaves com escrita por rodada
  origem?: OrigemSincronia   // editor e cron obedecem TRAVESSIA_PAUSADA; manual não
}
export type ResultadoSincronia = ResultadoAplicacao & {
  gerado_em: string
  tempo_ms: number
  pausada: boolean
  conflitos: number          // chaves travadas no plano (nada gravado nelas)
}

/** A trava de emergência das escritas automáticas: TRAVESSIA_PAUSADA=1 no ambiente do servidor do US. */
export const travessiaPausada = () => /^(1|true|sim|on)$/i.test(String(process.env.TRAVESSIA_PAUSADA || '').trim())

/**
 * Planeja UMA vez e grava as chaves com escrita, em ordem do plano (a mesma que numera as 085.N/006.N
 * novas por data). Sem a segunda leitura do applyPlan: o plano acabou de ser lido, não há impressão de
 * outra pessoa para conferir — quem confere a origem é o executarChave, relendo as linhas antes da primeira
 * escrita. Conflito e «nada» não gravam. Chave que erra por CONFLITO para só ela (as outras seguem; a
 * próxima rodada refaz o plano); erro de BANCO para a rodada — falha fechada, o contrato do motor.
 * Chave pedida que não está no plano = invoice que não cruza: resposta, não erro.
 */
export async function sincronizar(b: Bancos, opcoes: OpcoesSincronia = {}): Promise<ResultadoSincronia> {
  const t0 = Date.now()
  const plano = await planCrossings(b)
  if (!plano.migrado.US || !plano.migrado.BR) throw faltaMigracao(plano)
  const pedidas = opcoes.keys?.length ? new Set(opcoes.keys) : null
  const pausada = (opcoes.origem === 'editor' || opcoes.origem === 'cron') && travessiaPausada()
  const out: ResultadoChave[] = []
  if (pedidas) for (const k of pedidas) if (!plano.chaves.some(c => c.mirror_key === k)) out.push({ mirror_key: k, resultado: 'pulada', motivo: 'sem travessia: nada nesta invoice cruza entre as empresas', codigo: null, escritas: 0 })
  const lista = pedidas ? plano.chaves.filter(c => pedidas.has(c.mirror_key)) : plano.chaves
  const r = await rodarChaves(b, lista, { t0, limiteMs: opcoes.limiteMs, maxChaves: opcoes.maxChaves, pausada, listarTravadas: !!pedidas })
  return { ok: r.parou_por !== 'erro', chaves: [...out, ...r.out], parou_em: r.parou_em, parou_por: r.parou_por, restantes: r.restantes, gerado_em: plano.gerado_em, tempo_ms: Date.now() - t0, pausada, conflitos: r.conflitos }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A mirror_key da invoice que o editor acabou de salvar — lida do BANCO, nunca dita pelo navegador.
 *   invoice comum do US → 'US:invoice:<id>' (direções 3 + 4) · 006.N → a origem no BR (mirror_key, ou a
 *   invoice do BR que aponta para ela) · invoice comum do BR → 'BR:invoice:<id>' (direções 1 + 2) ·
 *   085.N → a origem no US. Sem origem gravada, `key` volta null com o motivo: o cron cuida.
 */
export async function chaveDaInvoice(b: Bancos, banco: Banco, invoiceId: string): Promise<{ key: string | null; motivo: string | null }> {
  if (!UUID.test(invoiceId)) throw new ErroTravessia('bad-request', `id de invoice inválido: ${invoiceId.slice(0, 40)}`)
  const casa = banco === 'US' ? b.us : b.br
  const outra = banco === 'US' ? b.br : b.us
  const clienteEspelho = banco === 'US' ? US_CLIENTE_GZ28BR : BR_CLIENTE_GZ28US
  const { data: inv, error } = await casa.from('invoices').select('id, client_id, mirror_key').eq('id', invoiceId).maybeSingle()
  if (error) throw new ErroTravessia('db', `ler a invoice ${invoiceId} no ${banco}: ${error.message}`)
  if (!inv) return { key: null, motivo: `a invoice não existe no banco do ${banco}` }
  if (inv.client_id !== clienteEspelho) return { key: `${banco}:invoice:${inv.id}`, motivo: null }
  if (inv.mirror_key) return { key: String(inv.mirror_key), motivo: null }
  const ponteiro = banco === 'US' ? 'us_invoice_id' : 'br_invoice_id'
  const { data: origens, error: e2 } = await outra.from('invoices').select('id').eq(ponteiro, inv.id)
  if (e2) throw new ErroTravessia('db', `procurar a origem da shopping invoice no ${banco === 'US' ? 'BR' : 'US'}: ${e2.message}`)
  if (origens?.length === 1) return { key: `${banco === 'US' ? 'BR' : 'US'}:invoice:${origens[0].id}`, motivo: null }
  return { key: null, motivo: origens?.length ? `${origens.length} invoices do outro app apontam para esta shopping invoice` : 'esta shopping invoice não tem origem gravada (mirror_key / ponteiro) — o cron da travessia cuida' }
}

export type ResumoAlvo = { banco: Banco; id: string; codigo: string; moeda: 'USD' | 'BRL'; custo: number; grand: number; recebido: number; pendente: number; vencimento: string | null }

/** Os números da shopping invoice-alvo de uma chave, lidos DEPOIS da escrita (para o aviso e o report da tela). */
export async function resumoAlvo(b: Bancos, key: string): Promise<ResumoAlvo | null> {
  const banco: Banco = key.startsWith('BR:') ? 'US' : 'BR'
  const db = banco === 'US' ? b.us : b.br
  const { data: inv, error } = await db.from('invoices').select('id, invoice_code, florida_taxes, global_discount').eq('mirror_key', key).maybeSingle()
  if (error) throw new ErroTravessia('db', `ler a shopping invoice de ${key}: ${error.message}`)
  if (!inv) return null
  const [exp, itens, serv, rendas] = await Promise.all([
    db.from('invoice_expenses').select('price, quantity, tax, extra').eq('invoice_id', inv.id),
    db.from(banco === 'US' ? 'invoice_items' : 'invoice_parts').select('unit_price, quantity').eq('invoice_id', inv.id),
    db.from('invoice_services').select('price').eq('invoice_id', inv.id),
    db.from(banco === 'US' ? 'invoice_incomes' : 'invoice_payments').select('amount, paid_at, payment_date').eq('invoice_id', inv.id),
  ])
  const falhou = exp.error || itens.error || serv.error || rendas.error
  if (falhou) throw new ErroTravessia('db', `ler as linhas da ${inv.invoice_code}: ${falhou.message}`)
  const abertas = (rendas.data || []).filter((p: Row) => !p.paid_at)
  return {
    banco, id: inv.id, codigo: inv.invoice_code, moeda: banco === 'US' ? 'USD' : 'BRL',
    custo: r2((exp.data || []).reduce((s: number, e: Row) => s + custoUS(e), 0)),   // preço × qtd + tax + extra: a mesma conta nos dois bancos
    grand: r2(grandTotal(itens.data || [], serv.data || [], inv, linhaItem)),
    recebido: r2((rendas.data || []).filter((p: Row) => p.paid_at).reduce((s: number, p: Row) => s + num(p.amount), 0)),
    pendente: r2(abertas.reduce((s: number, p: Row) => s + num(p.amount), 0)),
    vencimento: abertas.map((p: Row) => ymd(p.payment_date)).filter(Boolean).sort()[0] || null,
  }
}

// ── A TRAVA POR CHAVE (revisão 14/set/2026) ──────────────────────────────────
// Duas rodadas da mesma chave ao mesmo tempo (o save do editor e o cron, dois saves seguidos) entrelaçavam
// escritas que não são atômicas. Antes da primeira escrita, a chave entra em public.crossing_locks (banco do
// US, mirror_key única — MIGRATION_travessia_trava.sql); quem não consegue entrar PULA a chave (a próxima
// rodada tenta). Trava de rodada que morreu no meio (a Vercel corta em 300 s) vence em 10 minutos.
const TRAVA_VENCE_MS = 10 * 60_000

async function travar(b: Bancos, key: string): Promise<{ dono: string } | { ocupada: true } | { falha: string }> {
  const dono = randomUUID()
  const velha = new Date(Date.now() - TRAVA_VENCE_MS).toISOString()
  const { error: eVelha } = await b.us.from('crossing_locks').delete().eq('mirror_key', key).lt('locked_at', velha)
  if (eVelha) return { falha: `limpar trava vencida de ${key}: ${eVelha.message}` }
  const { error } = await b.us.from('crossing_locks').insert([{ mirror_key: key, holder: dono }])
  if (!error) return { dono }
  if (error.code === '23505') return { ocupada: true }
  return { falha: `travar ${key}: ${error.message}` }
}

async function destravar(b: Bancos, key: string, dono: string) {
  const { error } = await b.us.from('crossing_locks').delete().eq('mirror_key', key).eq('holder', dono)
  // Trava que não saiu vence sozinha em 10 minutos; a escrita já terminou — só registra.
  if (error) console.error('[travessia] a trava de', key, 'não saiu:', error.message)
}

// Número compara como número (o PostgREST pode devolver 11175 ou "11175.00"); o resto, como texto. Vazio = null.
function mesmoValor(a: unknown, b: unknown): boolean {
  const vazio = (v: unknown) => v == null || v === ''
  if (vazio(a) || vazio(b)) return vazio(a) && vazio(b)
  const na = Number(a), nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 0.005
  return String(a) === String(b)
}

// ── A CONFERÊNCIA ANTES DA PRIMEIRA ESCRITA (revisão 14/set/2026) ────────────
//   (a) cada linha de origem (e a usd_rate que o câmbio usou) é relida no banco: campo que mudou desde o
//       plano = nada é gravado nesta chave, e a próxima rodada refaz o plano;
//   (b) nenhum mirror_src a criar mora em outra invoice, e nenhum elo a ligar está em outra linha — conferido
//       ANTES de criar a 085.N/006.N, para nunca sobrar uma shopping invoice vazia.
async function conferirAntes(b: Bancos, c: ChavePlano) {
  const dbDe = (banco: Banco) => banco === 'US' ? b.us : b.br
  const fontes = new Map<string, { banco: Banco; tabela: string; linhas: Map<string, Record<string, unknown>> }>()
  for (const o of c.ops) {
    if (o.tipo !== 'criar_linha' && o.tipo !== 'carimbo') continue
    for (const cf of o.confere) {
      const k = `${cf.banco}:${cf.tabela}`
      let g = fontes.get(k)
      if (!g) { g = { banco: cf.banco, tabela: cf.tabela, linhas: new Map() }; fontes.set(k, g) }
      g.linhas.set(cf.id, { ...(g.linhas.get(cf.id) || {}), ...cf.campos })
    }
  }
  for (const g of fontes.values()) {
    const ids = [...g.linhas.keys()]
    const cols = [...new Set([...g.linhas.values()].flatMap(x => Object.keys(x)))]
    for (let i = 0; i < ids.length; i += 100) {
      const lote = ids.slice(i, i + 100)
      const { data, error } = await dbDe(g.banco).from(g.tabela).select(['id', ...cols].join(', ')).in('id', lote)
      if (error || !Array.isArray(data)) throw new ErroTravessia('db', `reler a origem em ${g.banco}.${g.tabela}: ${error?.message || 'sem lista'}`)
      const agora = new Map((data as unknown as Row[]).map(r => [String(r.id), r]))
      for (const id of lote) {
        const r = agora.get(id)
        if (!r) throw new ErroTravessia('conflict', `${g.banco}.${g.tabela} ${id.slice(0, 8)} sumiu desde o plano — nada gravado nesta chave; a próxima rodada refaz o plano`)
        for (const [col, v] of Object.entries(g.linhas.get(id)!)) {
          if (!mesmoValor(v, r[col])) throw new ErroTravessia('conflict', `${g.banco}.${g.tabela} ${id.slice(0, 8)} mudou desde o plano (${col}: ${v ?? 'vazio'} → ${r[col] ?? 'vazio'}) — nada gravado nesta chave; a próxima rodada refaz o plano`)
        }
      }
    }
  }
  const elos = new Map<string, { banco: Banco; tabela: string; srcs: Map<string, string | null> }>()
  for (const o of c.ops) {
    if (o.tipo !== 'criar_linha' && o.tipo !== 'pendente_criar' && o.tipo !== 'vincular_linha') continue
    const k = `${o.banco}:${o.tabela}`
    let g = elos.get(k)
    if (!g) { g = { banco: o.banco, tabela: o.tabela, srcs: new Map() }; elos.set(k, g) }
    g.srcs.set(o.mirror_src, o.tipo === 'vincular_linha' ? o.id : null)
  }
  for (const g of elos.values()) {
    const srcs = [...g.srcs.keys()]
    for (let i = 0; i < srcs.length; i += 50) {
      const { data, error } = await dbDe(g.banco).from(g.tabela).select('id, invoice_id, mirror_src').in('mirror_src', srcs.slice(i, i + 50))
      if (error || !Array.isArray(data)) throw new ErroTravessia('db', `conferir os elos em ${g.banco}.${g.tabela}: ${error?.message || 'sem lista'}`)
      for (const r of data as Row[]) {
        const ligarEm = g.srcs.get(String(r.mirror_src))
        if (ligarEm) { if (String(r.id) !== ligarEm) throw new ErroTravessia('conflict', `o elo ${r.mirror_src} já está em outra linha (${String(r.id).slice(0, 8)}) — nada gravado nesta chave`) }
        // Criar: a mesma linha na PRÓPRIA invoice-alvo é rodada repetida (a escrita pula); em qualquer outra, choque.
        else if (!c.alvo.id || String(r.invoice_id) !== c.alvo.id) throw new ErroTravessia('conflict', `${r.mirror_src} já existe em outra invoice (${String(r.invoice_id).slice(0, 8)}) — nada gravado nesta chave`)
      }
    }
  }
}

async function executarChave(b: Bancos, c: ChavePlano): Promise<Omit<ResultadoChave, 'mirror_key'>> {
  let escritas = 0
  let alvoId = c.alvo.id
  let codigo = c.alvo.codigo
  const trava = await travar(b, c.mirror_key)
  if ('ocupada' in trava) return { resultado: 'pulada', motivo: 'outra rodada está gravando esta chave agora — a próxima continua', codigo, escritas }
  if ('falha' in trava) return { resultado: 'erro', erro_tipo: 'banco', motivo: trava.falha, codigo, escritas }
  const dbDe = (banco: Banco) => banco === 'US' ? b.us : b.br
  // Código repetido (23505: mirror_key, mirror_src ou (client_id, invoice_code) únicos) é conflito, não pane.
  const falhaDe = (msg: string, error?: { code?: string } | null) => new ErroTravessia(error?.code === '23505' ? 'conflict' : 'db', msg)
  const trilha = async (banco: Banco, table_name: string, row_id: string, field: string, old_value: unknown, new_value: unknown, rotulo: string) => {
    const { error } = await dbDe(banco).from('data_fixes').insert([{ check_key: TRILHA, table_name, row_id, field, old_value: old_value == null ? null : String(old_value), new_value: new_value == null ? null : String(new_value), label: `${c.mirror_key} · ${rotulo}`.slice(0, 500) }])
    if (error) throw new ErroTravessia('db', `a escrita em ${banco}.${table_name} ${row_id} aconteceu, mas a trilha em data_fixes falhou: ${error.message}`)
  }
  const resolve = (campos: Row) => { if (!alvoId) throw new ErroTravessia('conflict', 'linha sem invoice-alvo resolvida'); return Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v === ALVO ? alvoId : v])) }
  // O Pending balance só se mexe se a linha ainda é dele: sem elo, ou com o elo do pendente desta chave.
  const soDoPendente = (q: any, mirror_src: string) => q.or(`mirror_src.is.null,mirror_src.eq."${mirror_src}"`)
  try {
    await conferirAntes(b, c)
    for (const o of c.ops) {
      const db = dbDe(o.banco)
      if (o.tipo === 'vincular_invoice') {
        const { data, error } = await db.from('invoices').update({ mirror_key: c.mirror_key }).eq('id', o.id).is('mirror_key', null).select('id')
        if (error) throw falhaDe(`vincular ${o.codigo}: ${error.message}`, error)
        if (!data?.length) {
          const { data: r, error: e2 } = await db.from('invoices').select('mirror_key').eq('id', o.id).maybeSingle()
          if (e2) throw new ErroTravessia('db', `reler ${o.codigo}: ${e2.message}`)
          if (r?.mirror_key !== c.mirror_key) throw new ErroTravessia('conflict', `${o.codigo} não aceitou a mirror_key (já tem outra, ou sumiu)`)
        } else { escritas++; await trilha(o.banco, 'invoices', o.id, 'mirror_key', null, c.mirror_key, o.rotulo) }
        alvoId = o.id
      } else if (o.tipo === 'criar_invoice') {
        const { data: ja, error: eJa } = await db.from('invoices').select('id, invoice_code').eq('mirror_key', c.mirror_key).maybeSingle()
        if (eJa) throw new ErroTravessia('db', `conferir mirror_key antes de criar: ${eJa.message}`)
        if (ja) { alvoId = ja.id; codigo = ja.invoice_code; continue }
        const cliente = o.serie === '006' ? US_CLIENTE_GZ28BR : BR_CLIENTE_GZ28US
        const { data: cods, error: eC } = await db.from('invoices').select('invoice_code').eq('client_id', cliente)
        if (eC || !Array.isArray(cods)) throw new ErroTravessia('db', `numeração da série ${o.serie}: ${eC?.message || 'sem lista'}`)
        const rx = new RegExp(`^${o.serie}\\.(\\d+)$`)
        const prox = cods.reduce((mx: number, r: any) => { const mm = String(r.invoice_code || '').match(rx); return mm ? Math.max(mx, parseInt(mm[1])) : mx }, 0) + 1
        const cod = `${o.serie}.${prox}`
        const { data: ins, error } = await db.from('invoices').insert([{ ...o.campos, invoice_code: cod }]).select('id, invoice_code').single()
        if (error || !ins) throw falhaDe(`criar ${cod}: ${error?.message || 'sem linha'}`, error)
        alvoId = ins.id; codigo = ins.invoice_code; escritas++
        await trilha(o.banco, 'invoices', ins.id, '(invoice criada)', null, cod, o.rotulo)
      } else if (o.tipo === 'ponteiro_origem') {
        const { data, error } = await db.from(o.tabela).update({ [o.campo]: alvoId }).eq('id', o.id).is(o.campo, null).select('id')
        if (error) throw falhaDe(`ponteiro ${o.campo}: ${error.message}`, error)
        if (!data?.length) {
          const { data: r, error: e2 } = await db.from(o.tabela).select(o.campo).eq('id', o.id).maybeSingle()
          if (e2) throw new ErroTravessia('db', `reler o ponteiro ${o.campo}: ${e2.message}`)
          if ((r as any)?.[o.campo] !== alvoId) throw new ErroTravessia('conflict', `${o.campo} da origem já aponta para outra invoice`)
        } else { escritas++; await trilha(o.banco, o.tabela, o.id, o.campo, null, alvoId, o.rotulo) }
      } else if (o.tipo === 'vincular_linha') {
        let q: any = db.from(o.tabela).update({ mirror_src: o.mirror_src, ...(o.elo ? { [o.elo.campo]: o.elo.valor } : {}) }).eq('id', o.id).is('mirror_src', null)
        if (o.elo) q = q.is(o.elo.campo, null)
        const { data, error } = await q.select('id')
        if (error) throw falhaDe(`vincular ${o.tabela} ${o.id}: ${error.message}`, error)
        if (!data?.length) {
          const { data: r, error: e2 } = await db.from(o.tabela).select('mirror_src').eq('id', o.id).maybeSingle()
          if (e2) throw new ErroTravessia('db', `reler ${o.tabela} ${o.id}: ${e2.message}`)
          if ((r as any)?.mirror_src !== o.mirror_src) throw new ErroTravessia('conflict', `${o.tabela} ${o.id} não aceitou o elo (já tem outro, ou sumiu)`)
        } else {
          escritas++
          await trilha(o.banco, o.tabela, o.id, 'mirror_src', null, o.mirror_src, o.rotulo)
          if (o.elo) await trilha(o.banco, o.tabela, o.id, o.elo.campo, null, o.elo.valor, o.rotulo)
        }
      } else if (o.tipo === 'carimbo') {
        // A GUARDA NO PRÓPRIO UPDATE (revisão 14/set/2026): o carimbo só pega se a linha ainda tem o valor e o
        // destino que o câmbio usou. Mudou entre a conferência e aqui = zero linhas = conflito.
        let q: any = db.from(o.tabela).update({ [o.campo]: o.valor }).eq('id', o.id).is(o.campo, null)
        for (const [col, v] of Object.entries(o.guarda)) q = v == null ? q.is(col, null) : q.eq(col, v)
        const { data, error } = await q.select('id')
        if (error) throw falhaDe(`carimbo ${o.tabela}.${o.campo}: ${error.message}`, error)
        if (!data?.length) {
          const { data: r, error: e2 } = await db.from(o.tabela).select([o.campo, ...Object.keys(o.guarda)].join(', ')).eq('id', o.id).maybeSingle()
          if (e2) throw new ErroTravessia('db', `reler ${o.tabela}.${o.campo}: ${e2.message}`)
          const mudou = Object.entries(o.guarda).find(([col, v]) => !mesmoValor(v, (r as any)?.[col]))
          if (mudou) throw new ErroTravessia('conflict', `${o.tabela} ${o.id.slice(0, 8)} mudou antes do carimbo (${mudou[0]}: ${mudou[1] ?? 'vazio'} → ${(r as any)?.[mudou[0]] ?? 'vazio'}) — o câmbio não serve mais`)
          if (!perto(num((r as any)?.[o.campo]), o.valor, 0.005)) throw new ErroTravessia('conflict', `${o.tabela}.${o.campo} ${o.id.slice(0, 8)} já tem outro valor gravado — o gravado prevalece, o plano não serve mais`)
        } else { escritas++; await trilha(o.banco, o.tabela, o.id, o.campo, null, o.valor, `${o.rotulo} · ${o.regra}`) }
      } else if (o.tipo === 'criar_linha' || o.tipo === 'pendente_criar') {
        const { data: ja, error: eJa } = await db.from(o.tabela).select('id, invoice_id').eq('mirror_src', o.mirror_src).maybeSingle()
        if (eJa) throw new ErroTravessia('db', `conferir ${o.tabela} ${o.mirror_src}: ${eJa.message}`)
        if (ja) { if (ja.invoice_id !== alvoId) throw new ErroTravessia('conflict', `${o.mirror_src} já existe em outra invoice`); continue }
        const { data: ins, error } = await db.from(o.tabela).insert([resolve(o.campos)]).select('id').single()
        if (error || !ins) throw falhaDe(`criar ${o.tabela} (${o.mirror_src}): ${error?.message || 'sem linha'}`, error)
        escritas++
        await trilha(o.banco, o.tabela, ins.id, '(linha criada)', null, o.mirror_src, o.rotulo)
      } else if (o.tipo === 'pendente_atualizar') {
        const { data, error } = await soDoPendente(db.from(o.tabela).update({ amount: o.para, mirror_src: o.mirror_src }).eq('id', o.id).is('paid_at', null).eq('amount', o.de), o.mirror_src).select('id')
        if (error) throw falhaDe(`pendente ${o.id}: ${error.message}`, error)
        if (data?.length !== 1) throw new ErroTravessia('conflict', `o Pending balance ${o.id} mudou (baixa, valor ou elo) antes da escrita`)
        escritas++
        await trilha(o.banco, o.tabela, o.id, 'amount', o.de, o.para, o.rotulo)
      } else if (o.tipo === 'pendente_apagar') {
        if (o.banco === 'US') {
          const [{ data: p1, error: e1 }, { data: p2, error: e2 }] = await Promise.all([
            db.from('bank_transactions').select('id').in('matched_table', ['invoice_incomes', 'invoice_payments']).eq('matched_id', o.id).neq('match_status', 'REMOVED').limit(1),
            // jsonb: o contains vai como TEXTO JSON (array JS viraria literal de array do Postgres)
            db.from('bank_transactions').select('id').contains('matched_members', JSON.stringify([{ id: o.id }])).neq('match_status', 'REMOVED').limit(1),
          ])
          if (e1 || e2) throw new ErroTravessia('db', `conferir elo de banco do Pending balance: ${(e1 || e2)!.message}`)
          if (p1?.length || p2?.length) throw new ErroTravessia('conflict', `o Pending balance ${o.id} tem elo de banco — não sai`)
        }
        // A linha inteira vai para a trilha ANTES de sair: é o que permite devolvê-la.
        const { data: antes, error: eAntes } = await db.from(o.tabela).select('*').eq('id', o.id).maybeSingle()
        if (eAntes) throw new ErroTravessia('db', `ler o Pending balance ${o.id} antes de apagar: ${eAntes.message}`)
        if (!antes) throw new ErroTravessia('conflict', `o Pending balance ${o.id} sumiu antes de sair`)
        await trilha(o.banco, o.tabela, o.id, '(pendente apagado)', JSON.stringify(antes), null, o.rotulo)
        const { data, error } = await soDoPendente(db.from(o.tabela).delete().eq('id', o.id).is('paid_at', null).eq('amount', o.de), o.mirror_src).select('id')
        if (error) throw falhaDe(`apagar pendente ${o.id}: ${error.message}`, error)
        if (data?.length !== 1) throw new ErroTravessia('conflict', `o Pending balance ${o.id} mudou (baixa, valor ou elo) antes de sair — a trilha registrou a tentativa, nada saiu`)
        escritas++
      }
    }
    return { resultado: 'aplicada', motivo: null, codigo, escritas }
  } catch (e) {
    const tipo: 'conflito' | 'banco' = e instanceof ErroTravessia && e.kind !== 'db' ? 'conflito' : 'banco'
    return { resultado: 'erro', erro_tipo: tipo, motivo: e instanceof Error ? e.message : String(e), codigo, escritas }
  } finally {
    await destravar(b, c.mirror_key, trava.dono)
  }
}
