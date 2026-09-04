'use client'

// ── STREAM — A VISTA DERIVADA DAS COMPRAS ───────────────────────────────────
//
// Ordem do dono (Márcio, 30/ago/2026), palavra por palavra:
//
//   "crie uma pagina nova de STREAM DO ZERO, ignore TOTALMENTE o que la esta.
//    Mostre absolutamente todos os itens, com todos os filtros, nesta ordem:
//      DELIVERED / SHIPPED / BOUGHT / AGUARDANDO ESTORNO / ESTORNADO / PICKUP
//    IMPORTANTE: O STREAM agora NAO TEM BANCO PROPRIO, ele e somente uma pagina
//    de leitura dos itens em suas origens!!!!"
//
// Portanto esta página é uma VISTA, nada mais: ela LÊ as 6 tabelas de item
// comprado (invoice_expenses, inputs, inventory, goods, good_expenses e
// expenses), deriva
// o badge com a MESMA cascata de todas as outras telas (lib/deliverStatus.ts →
// deriveDeliverStatus) e lista. Nenhum insert, nenhum update, nenhum delete,
// nenhuma leitura de part_streams — se um dia alguém quiser GRAVAR algo aqui,
// está no lugar errado: o fato mora na linha de origem do item, e é lá que se
// edita (a página só aponta o caminho com o link de origem de cada linha).
//
// Item SEM badge (não pago, doado, de estoque) NÃO aparece: a lista de filtros
// do dono define o universo — stream é compra viva ou morta, não rascunho.
// Invoice de quote também fica fora: quote não é compra.
//
// A 6ª tabela, expenses, entrou por lei do dono (Márcio, 03/set/2026): "compra
// pessoal esta no lugar certo (expenses, origin='PERSONAL'), mas TEM que estar
// no STREAM tambem, e tem que ter rastreio". expenses é quase toda FOLHA
// (WEEKLY/MONTHLY/DAILY, Zelle, mensal): só a linha com order_number OU
// tracking_number é ITEM, e o corte é feito NA QUERY (EXPENSE_ITEM_GATE, o
// mesmo do robô e da ponte de e-mail) — salário nunca sai do banco para cá.
// A linha aparece como PERSONAL · nome da pessoa e o link leva à própria
// despesa na season dela.

import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD, formatShortDate } from '@/lib/utils'
import { EXPENSE_ITEM_GATE } from '@/lib/deliverStatus'
import { DeliverChip, OrderChip, deriveDeliverStatus, type DeliverChipRow, type DeliverStatus } from '@/components/DeliverChip'

// A ordem das seções e dos chips é A ORDEM DO DONO — não mexer.
const SECTION_ORDER: DeliverStatus[] = ['DELIVERED', 'SHIPPED', 'BOUGHT', 'CANCELLED', 'REFUNDED', 'PICKUP']
// Rótulos na língua DESTA tela (app US = inglês; no BR são os do dono em PT).
const SECTION_LABEL: Record<DeliverStatus, string> = {
  DELIVERED: 'DELIVERED',
  SHIPPED: 'SHIPPED',
  BOUGHT: 'BOUGHT',
  CANCELLED: 'AWAITING REFUND',
  REFUNDED: 'REFUNDED',
  PICKUP: 'PICKUP',
}

type Chip = 'ALL' | DeliverStatus

// Os campos comuns às 6 tabelas de que a derivação e a linha precisam. O tipo
// estende DeliverChipRow de propósito: o compilador cobra os campos que a
// cascata e o chip leem — esquecer um no select não compila.
type BaseRow = DeliverChipRow & {
  id: string
  supplier: string | null
  order_number: string | null
  shipped_at: string | null
  last_event_at: string | null
}
type InvoiceExpenseRow = BaseRow & { invoice_id: string | null; item: string | null; price: number | null; quantity: number | null; stock_source_type: string | null }
type InputRow = BaseRow & { description: string | null; unit_price: number | null; quantity: number | null; source_type: string | null }
type GoodRow = BaseRow & { description: string | null; unit_price: number | null; quantity: number | null }
type GoodExpenseRow = BaseRow & { description: string | null; amount: number | null }
// expenses NÃO tem quantity/unit_price/source_type: amount é o total pago, e
// expense_date é a data da compra (lei "uma data": a data é a do pagamento).
// Tipo próprio de propósito — reaproveitar InputRow/GoodRow passaria no tsc e
// quebraria o select em runtime.
type ExpenseRow = BaseRow & { description: string | null; amount: number | null; expense_date: string | null; origin: string | null; season_id: string | null }
type SeasonRef = { id: string; staff_id: string | null }
type StaffRef = { id: string; name: string | null }
type InvoiceRef = { id: string; invoice_code: string; ride_id: string | null; is_quote: boolean | null }

// Uma linha do stream, já derivada e pronta para desenhar.
type StreamItem = {
  key: string
  status: DeliverStatus
  row: DeliverChipRow
  name: string
  supplier: string
  order: string
  amount: number | null
  paymentDate: string
  sourceLabel: string
  href: string | null
}

const DELIVER_SELECT = 'picked_up, cancel_status, payment_date, tracking_number, carrier, eta, shipped_at, delivered_at, last_event, last_event_at, supplier, order_number'

// LEITURA PAGINADA. supabase-js corta em 1000 linhas EM SILÊNCIO e
// invoice_expenses já passa disso — sem o .range() em loop a tela mentiria por
// omissão. Erro NUNCA vira lista vazia: estoura para o estado de erro da tela.
// `filter` é o corte em SQL de quem precisa (expenses: só linha que é ITEM) —
// a tabela de folha inteira não pode nem viajar até o browser.
// O builder do Supabase tem generics profundos demais para tipar o filtro (TS2589);
// aqui `any` e deliberado e local — o mesmo compromisso que itemTracking.server.ts ja faz.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select)
    if (filter) q = filter(q)
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const chunk = (data || []) as unknown as T[]
    out.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return out
}

export default function StreamPage() {
  const [items, setItems] = useState<StreamItem[]>([])
  const [loading, setLoading] = useState(true)
  // Leitura que falha NÃO é lista vazia (mesmo padrão da /performance).
  const [err, setErr] = useState<string | null>(null)
  const [chip, setChip] = useState<Chip>('ALL')
  const [search, setSearch] = useState('')

  useEffect(() => { void load() }, [])

  async function load() {
    try {
      setErr(null)
      const [ie, inputs, inventory, goods, goodExpenses, expenses, invoices] = await Promise.all([
        fetchAll<InvoiceExpenseRow>('invoice_expenses', `id, invoice_id, item, price, quantity, stock_source_type, ${DELIVER_SELECT}`),
        fetchAll<InputRow>('inputs', `id, description, unit_price, quantity, source_type, ${DELIVER_SELECT}`),
        fetchAll<InputRow>('inventory', `id, description, unit_price, quantity, source_type, ${DELIVER_SELECT}`),
        fetchAll<GoodRow>('goods', `id, description, unit_price, quantity, ${DELIVER_SELECT}`),
        fetchAll<GoodExpenseRow>('good_expenses', `id, description, amount, ${DELIVER_SELECT}`),
        // expenses: o gate "é ITEM?" vai NA QUERY — folha nunca chega aqui.
        fetchAll<ExpenseRow>('expenses', `id, description, amount, expense_date, origin, season_id, ${DELIVER_SELECT}`, q => q.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)),
        fetchAll<InvoiceRef>('invoices', 'id, invoice_code, ride_id, is_quote'),
      ])
      const invMap = new Map(invoices.map(i => [i.id, i]))
      const list: StreamItem[] = []

      // A pessoa da despesa: expenses → seasons.staff_id → staff.name. Só as
      // seasons das (poucas) linhas que passaram no gate — barato.
      const seasonById = new Map<string, SeasonRef>()
      const staffById = new Map<string, StaffRef>()
      const seasonIds = [...new Set(expenses.map(e => e.season_id).filter((s): s is string => !!s))]
      if (seasonIds.length) {
        const { data: seasons, error: sErr } = await supabase.from('seasons').select('id, staff_id').in('id', seasonIds)
        if (sErr) throw new Error(`seasons: ${sErr.message}`)
        for (const s of (seasons || []) as SeasonRef[]) seasonById.set(s.id, s)
        const staffIds = [...new Set([...seasonById.values()].map(s => s.staff_id).filter((s): s is string => !!s))]
        if (staffIds.length) {
          const { data: staff, error: stErr } = await supabase.from('staff').select('id, name').in('id', staffIds)
          if (stErr) throw new Error(`staff: ${stErr.message}`)
          for (const s of (staff || []) as StaffRef[]) staffById.set(s.id, s)
        }
      }

      // invoice_expenses → a página da invoice no ride. Quote não é compra.
      for (const r of ie) {
        const inv = r.invoice_id ? invMap.get(r.invoice_id) : undefined
        if (inv?.is_quote) continue
        const status = deriveDeliverStatus(r)
        if (!status) continue
        list.push({
          key: `ie-${r.id}`, status, row: r,
          name: r.item || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.price != null ? r.price * (r.quantity || 1) : null,
          paymentDate: r.payment_date || '',
          sourceLabel: inv ? `INVOICE ${inv.invoice_code}` : 'INVOICE',
          href: inv?.ride_id && r.invoice_id ? `${BASE_PATH}/rides/${inv.ride_id}/invoices/${r.invoice_id}` : null,
        })
      }
      // inputs → SUPPLIES; inventory → a mesma ficha com ?src=inventory
      // (é assim que /supplies/[id] distingue as duas tabelas hoje).
      for (const r of inputs) {
        const status = deriveDeliverStatus(r)
        if (!status) continue
        list.push({
          key: `in-${r.id}`, status, row: r,
          name: r.description || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.unit_price != null ? r.unit_price * (r.quantity || 1) : null,
          paymentDate: r.payment_date || '',
          sourceLabel: 'SUPPLIES', href: `${BASE_PATH}/supplies/${r.id}`,
        })
      }
      for (const r of inventory) {
        const status = deriveDeliverStatus(r)
        if (!status) continue
        list.push({
          key: `iv-${r.id}`, status, row: r,
          name: r.description || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.unit_price != null ? r.unit_price * (r.quantity || 1) : null,
          paymentDate: r.payment_date || '',
          sourceLabel: 'INVENTORY', href: `${BASE_PATH}/supplies/${r.id}?src=inventory`,
        })
      }
      // goods e good_expenses → o quadro /goods (não há ficha por linha lá).
      for (const r of goods) {
        const status = deriveDeliverStatus(r)
        if (!status) continue
        list.push({
          key: `gd-${r.id}`, status, row: r,
          name: r.description || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.unit_price != null ? r.unit_price * (r.quantity || 1) : null,
          paymentDate: r.payment_date || '',
          sourceLabel: 'GOODS', href: `${BASE_PATH}/goods`,
        })
      }
      for (const r of goodExpenses) {
        const status = deriveDeliverStatus(r)
        if (!status) continue
        list.push({
          key: `ge-${r.id}`, status, row: r,
          name: r.description || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.amount,
          paymentDate: r.payment_date || '',
          sourceLabel: 'GOODS', href: `${BASE_PATH}/goods`,
        })
      }
      // expenses → a própria despesa na season da pessoa (lei do dono,
      // 03/set/2026). amount é o total (sem quantity); a data é payment_date
      // com expense_date atrás (uma data só: a do pagamento). PERSONAL é o
      // rótulo quando origin diz isso; o resto é despesa de STAFF com pedido.
      for (const r of expenses) {
        const status = deriveDeliverStatus(r)
        if (!status) continue
        const season = r.season_id ? seasonById.get(r.season_id) : undefined
        const person = season?.staff_id ? staffById.get(season.staff_id) : undefined
        const who = person?.name ? ` · ${person.name}` : ''
        list.push({
          key: `ex-${r.id}`, status, row: r,
          name: r.description || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.amount,
          paymentDate: r.payment_date || r.expense_date || '',
          sourceLabel: `${r.origin === 'PERSONAL' ? 'PERSONAL' : 'STAFF'}${who}`,
          href: season?.staff_id && r.season_id
            ? `${BASE_PATH}/staff/${season.staff_id}/seasons/${r.season_id}/expenses/edit/${r.id}`
            : `${BASE_PATH}/staff`,
        })
      }
      setItems(list)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Contagem por status sobre o universo INTEIRO — os chips não mudam com a busca.
  const counts = useMemo(() => {
    const c: Record<Chip, number> = { ALL: items.length, DELIVERED: 0, SHIPPED: 0, BOUGHT: 0, CANCELLED: 0, REFUNDED: 0, PICKUP: 0 }
    for (const it of items) c[it.status] += 1
    return c
  }, [items])

  // Seções na ordem do dono, cada uma do mais recente pro mais antigo
  // (payment_date desc; linha sem data — estorno limpou — vai pro fim).
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase()
    const match = (it: StreamItem) =>
      !q || [it.name, it.supplier, it.order, it.row.tracking_number || ''].some(v => v.toLowerCase().includes(q))
    return SECTION_ORDER
      .filter(s => chip === 'ALL' || chip === s)
      .map(s => ({
        status: s,
        rows: items
          .filter(it => it.status === s && match(it))
          .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate)),
      }))
      .filter(s => s.rows.length > 0)
  }, [items, chip, search])

  const shown = sections.reduce((n, s) => n + s.rows.length, 0)

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      {/* Lei da casa (list-page-search-layout): título + SEARCH em cima, chips
          embaixo. SEM botão ADD — nada se cria numa vista. */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">STREAM ({items.length})</h1>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="SEARCH item, supplier, order, tracking…"
          className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-lg w-80"
        />
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {(['ALL', ...SECTION_ORDER] as Chip[]).map(c => (
          <button
            key={c}
            onClick={() => setChip(c)}
            className={`px-5 py-2 rounded-2xl font-bold text-sm border ${chip === c ? 'bg-white text-black border-white' : 'bg-gray-900 text-gray-300 border-gray-700 hover:border-gray-500'}`}
          >
            {c === 'ALL' ? 'ALL' : SECTION_LABEL[c]} ({counts[c]})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-2xl text-gray-400">Loading...</p>
      ) : err ? (
        // Falha de leitura NÃO é lista vazia — mesmo padrão da /performance.
        <div className="bg-red-900/20 border border-red-700 rounded-3xl p-6">
          <p className="text-2xl font-bold text-red-300">Couldn&apos;t read the purchase tables.</p>
          <p className="text-lg text-gray-300 mt-2">This is NOT an empty list — the stream is unknown right now.</p>
          <p className="text-sm text-gray-500 mt-2 break-all">{err}</p>
          <button onClick={() => { setLoading(true); void load() }} className="mt-4 bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-2xl font-bold">TRY AGAIN</button>
        </div>
      ) : shown === 0 ? (
        <div className="border border-gray-800 rounded-3xl bg-gray-900/40 px-8 py-16 text-center">
          <p className="text-5xl mb-4">📦</p>
          <p className="text-2xl font-bold mb-2">Nothing here</p>
          <p className="text-lg text-gray-400">
            {items.length === 0
              ? 'No paid purchase carries a badge yet — the stream reads the items at their source tables.'
              : 'No item matches this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {sections.map(sec => (
            <section key={sec.status}>
              <h2 className="text-2xl font-bold mb-4 text-gray-300">{SECTION_LABEL[sec.status]} <span className="text-gray-500">({sec.rows.length})</span></h2>
              <div className="space-y-3">
                {sec.rows.map(it => (
                  <div key={it.key} className="bg-gray-900 border border-gray-800 rounded-3xl p-5 flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <DeliverChip row={it.row} />
                        {it.order && <OrderChip order={it.order} />}
                      </div>
                      <p className="text-xl font-bold mt-2 break-words">{it.name}</p>
                      <p className="text-gray-400 mt-0.5">{it.supplier || '—'}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xl font-bold">{it.amount != null ? formatUSD(it.amount) : '—'}</p>
                      <p className="text-gray-400">{formatShortDate(it.paymentDate) || '—'}</p>
                      {it.href ? (
                        <a href={it.href} className="text-blue-400 hover:underline text-sm font-bold">{it.sourceLabel}</a>
                      ) : (
                        <span className="text-gray-500 text-sm font-bold">{it.sourceLabel}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
