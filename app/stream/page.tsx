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
//
// ── 04/set/2026 — TRÊS ORDENS DO DONO, PALAVRA POR PALAVRA ──────────────────
//   (a) "quando invoice, escreva o carro ou o cliente (se shopping invoice)"
//   (b) "quando shipped, mostre a data estimada de entrega"
//   (c) a linha ainda SEM natureza continua aqui, marcada A CLASSIFICAR.
//
// (a) A linha dizia "INVOICE US.030.4". Código de invoice não é resposta para
//     "de quem é isso?" — ninguém guarda 137 códigos de cabeça. Agora ela diz o
//     CARRO (rides.project_code + project_name) e, quando a invoice não tem
//     carro (shopping invoice), diz o CLIENTE. Medido no banco US em 04/set: das
//     803 linhas de invoice_expenses com badge, 687 resolvem para carro e 116
//     para cliente — ZERO órfãs (BR: 316 = 242 carro + 74 cliente, zero órfã).
//     O código não sumiu: virou a segunda linha, cinza. E a shopping invoice,
//     que era texto morto (href null), agora abre em
//     /clients/<id>/invoices/<id>: 116 linhas que não levavam a lugar nenhum.
//
// (b) `eta` existe nas 6 tabelas e quase não está preenchido: das 23 linhas
//     SHIPPED hoje, só 10 têm eta — e NENHUMA das 12 do lado carro. Então a
//     linha SHIPPED mostra a previsão quando ela existe e diz, em letra dura,
//     que NÃO existe quando não existe. Buraco em branco é pior que "sem
//     previsão": em branco parece que a tela esqueceu, e ninguém vai cobrar a
//     transportadora. Inventar data aqui viraria promessa falsa ao cliente.
//     Previsão vencida com a coisa ainda em trânsito fica âmbar (todayLocal()).
//
// (c) nature NULL NÃO some — some quem foi classificado como SERVIÇO, DIGITAL,
//     ENCARGO ou DINHEIRO, e quem corta é a cascata (deriveDeliverStatus), não
//     esta tela. O que a tela faz é (i) trazer `nature` no select — sem isso o
//     degrau nunca dispara, e é por isso que o select agora sai de
//     DELIVER_COLUMNS em vez de uma cópia à mão — e (ii) marcar a não
//     classificada com o chip A CLASSIFICAR, que leva à fila do /adm/check.

import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, formatUSD, formatShortDate } from '@/lib/utils'
import { EXPENSE_ITEM_GATE, DELIVER_COLUMNS } from '@/lib/deliverStatus'
import { needsNature } from '@/lib/itemNature'
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
// O CARRO E O CLIENTE VÊM JUNTO COM A INVOICE (ordem (a) do dono). São embeds do
// PostgREST na MESMA leitura — nada de duas consultas novas: são 137 invoices no
// US e 105 no BR, e a página já lia esta tabela inteira. Elo a elo:
// invoices.ride_id → rides (o carro) e invoices.client_id → cliente. Um deles é
// null por construção: shopping invoice não tem carro.
type RideRef = { project_code: string | null; project_name: string | null }
type ClientRef = { name: string | null }
type InvoiceRef = { id: string; invoice_code: string; ride_id: string | null; client_id: string | null; is_quote: boolean | null; origin: string | null; rides: RideRef | null; clients: ClientRef | null }

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
  // A segunda linha, cinza, embaixo do link: hoje só a invoice a usa, para não
  // perder o código quando o rótulo passa a ser o carro/cliente (ordem (a)).
  sourceNote?: string
  href: string | null
}

// O SELECT SAI DA CONSTANTE, NÃO DE UMA CÓPIA. DELIVER_COLUMNS
// (lib/deliverStatus.ts) é a lista canônica da cascata; esta tela mantinha uma
// cópia à mão e foi exatamente assim que `nature` quase ficou de fora — e sem
// nature no select o campo chega undefined, VIAJA, e o degrau zero nunca dispara
// nesta tela (o comentário do próprio DeliverChipRow avisa disso). Aqui só se
// SOMA o que a cascata não pede e a linha desenha: payment_date (o degrau
// "pagou?", que DELIVER_COLUMNS deliberadamente não traz), supplier e
// order_number. Coluna nova da cascata passa a chegar aqui sozinha.
const DELIVER_SELECT = `${DELIVER_COLUMNS}, payment_date, supplier, order_number`

// LEI DO RELÓGIO (AGENTS.md): data nenhuma sai da cabeça, e o fuso segue o
// ASSUNTO — esta tela é o galpão de Orlando. `new Date().toISOString()` daria a
// data UTC, que depois das 20h daqui já é o dia seguinte: um ETA de hoje
// nasceria pintado de OVERDUE toda noite. Intl com timeZone explícito é a única
// forma que acerta nesta máquina (o `date` do Git Bash mente, ver AGENTS.md).
// 'en-CA' porque é o locale que formata em YYYY-MM-DD — o mesmo formato do
// campo `eta` no banco (é DATE puro: "2026-08-11"), então a comparação é
// string com string e nenhum fuso entra no meio.
const todayLocal = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

// LEITURA PAGINADA. supabase-js corta em 1000 linhas EM SILÊNCIO e
// invoice_expenses já passa disso — sem o .range() em loop a tela mentiria por
// omissão. Erro NUNCA vira lista vazia: estoura para o estado de erro da tela.
// `filter` é o corte em SQL de quem precisa (expenses: só linha que é ITEM) —
// a tabela de folha inteira não pode nem viajar até o browser.
// O builder do Supabase tem generics profundos demais para tipar o filtro (TS2589);
// aqui `any` e deliberado e local — o mesmo compromisso que itemTracking.server.ts ja faz.
//
// MIGRATION AINDA NÃO RODADA NÃO PODE APAGAR A TELA. `nature` nasce na
// MIGRATION_item_nature.sql e o Márcio roda migration à mão no editor do
// Supabase — existe uma janela real em que o código já pede a coluna e o banco
// ainda não a tem. Nessa janela o PostgREST NÃO devolve lista vazia: devolve
// HTTP 400 / 42703 ("column invoice_expenses.nature does not exist" — foi
// exatamente o que este banco respondeu em 04/set/2026, quando esta tela foi
// escrita). Sem o desvio abaixo, o STREAM inteiro viraria a caixa vermelha de
// erro até alguém colar o SQL. Então: cai para o select SEM nature, levanta a
// bandeira, e a tela avisa que a migration está pendente (mesmo padrão do card
// MIGRATION PENDENTE do /adm/check). Sem nature a cascata volta a listar tudo
// que foi pago — sobrar é o erro barato, sumir é o caro.
type LoadFlags = { natureMissing: boolean }
const NATURE_IN_SELECT = /,\s*nature\b/
const isMissingNature = (e: { code?: string; message?: string }) =>
  e.code === '42703' && /\bnature\b/.test(String(e.message || ''))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(table: string, select: string, flags: LoadFlags, filter?: (q: any) => any): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select)
    if (filter) q = filter(q)
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) {
      // Coluna inexistente estoura SEMPRE na primeira página — por isso o
      // `from === 0`: se um 42703 aparecesse no meio da paginação seria outra
      // coisa, e outra coisa vira erro na tela, nunca lista pela metade.
      if (from === 0 && isMissingNature(error) && NATURE_IN_SELECT.test(select)) {
        flags.natureMissing = true
        return fetchAll<T>(table, select.replace(NATURE_IN_SELECT, ''), flags, filter)
      }
      throw new Error(`${table}: ${error.message}`)
    }
    const chunk = (data || []) as unknown as T[]
    out.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return out
}

// ── (b) A PREVISÃO DE ENTREGA DA LINHA QUE ESTÁ VIAJANDO ────────────────────
// Três estados, e o terceiro é o que importa:
//   ETA 09/12/26            — a transportadora prometeu uma data (azul).
//   ETA 08/11/26 · OVERDUE  — prometeu, a data passou e a coisa não chegou. É
//                             fato, não palpite: o badge só é SHIPPED enquanto
//                             delivered_at estiver vazio (âmbar, a mesma cor que
//                             a casa já usa para "tem dinheiro parado nisso").
//   NO ETA YET              — NINGUÉM prometeu nada. Este é o caso comum (13 das
//                             23 linhas SHIPPED em 04/set/2026, e 12 de 12 do
//                             lado carro) e é justamente o que não pode ficar em
//                             branco: espaço vazio parece tela incompleta, e
//                             ninguém cobra o que a tela não pergunta.
// O que esta função NUNCA faz: estimar. Não há "chega em ~5 dias" aqui — data
// inventada no STREAM vira promessa ao cliente, e promessa não se deriva.
function EtaChip({ eta, today }: { eta: string | null; today: string }) {
  const shown = formatShortDate(eta)
  if (!shown) {
    return (
      <span
        title="No carrier estimate for this shipment yet — the tracking robot fills it in when the carrier publishes one."
        className="px-2.5 py-0.5 rounded-lg text-sm font-bold border border-dashed border-gray-600 bg-gray-900 text-gray-500 whitespace-nowrap"
      >NO ETA YET</span>
    )
  }
  // Comparação de string com string: `eta` é DATE no banco ("2026-08-11") e
  // `today` nasce em YYYY-MM-DD no fuso de Orlando (todayLocal) — nenhum objeto
  // Date entra nesta conta, então nenhum fuso pode empurrar o dia.
  const overdue = String(eta || '').slice(0, 10) < today
  return (
    <span className={`px-2.5 py-0.5 rounded-lg text-sm font-bold border whitespace-nowrap ${overdue ? 'bg-amber-950 text-amber-300 border-amber-700' : 'bg-blue-950 text-blue-300 border-blue-800'}`}>
      ETA {shown}{overdue ? ' · OVERDUE' : ''}
    </span>
  )
}

export default function StreamPage() {
  const [items, setItems] = useState<StreamItem[]>([])
  const [loading, setLoading] = useState(true)
  // Leitura que falha NÃO é lista vazia (mesmo padrão da /performance).
  const [err, setErr] = useState<string | null>(null)
  const [chip, setChip] = useState<Chip>('ALL')
  const [search, setSearch] = useState('')
  // Verdadeiro só enquanto MIGRATION_item_nature.sql não tiver rodado neste
  // banco. Enquanto for verdadeiro a tela NÃO marca ninguém como A CLASSIFICAR:
  // sem a coluna, "não classificado" seria todo mundo — um chip em cada linha
  // não é aviso, é ruído.
  const [natureMissing, setNatureMissing] = useState(false)

  useEffect(() => { void load() }, [])

  async function load() {
    try {
      setErr(null)
      const flags: LoadFlags = { natureMissing: false }
      const [ie, inputs, inventory, goods, goodExpenses, expenses, invoices] = await Promise.all([
        fetchAll<InvoiceExpenseRow>('invoice_expenses', `id, invoice_id, item, price, quantity, stock_source_type, ${DELIVER_SELECT}`, flags),
        fetchAll<InputRow>('inputs', `id, description, unit_price, quantity, source_type, ${DELIVER_SELECT}`, flags),
        fetchAll<InputRow>('inventory', `id, description, unit_price, quantity, source_type, ${DELIVER_SELECT}`, flags),
        fetchAll<GoodRow>('goods', `id, description, unit_price, quantity, ${DELIVER_SELECT}`, flags),
        fetchAll<GoodExpenseRow>('good_expenses', `id, description, amount, ${DELIVER_SELECT}`, flags),
        // expenses: o gate "é ITEM?" vai NA QUERY — folha nunca chega aqui.
        fetchAll<ExpenseRow>('expenses', `id, description, amount, expense_date, origin, season_id, ${DELIVER_SELECT}`, flags, q => q.eq('origin', 'PERSONAL').or(EXPENSE_ITEM_GATE)),
        // O carro e o cliente vêm de carona (ordem (a)): mesma leitura, dois
        // embeds. Sem eles a linha continuaria dizendo só o código da invoice.
        fetchAll<InvoiceRef>('invoices', 'id, invoice_code, ride_id, client_id, is_quote, origin, rides(project_code, project_name), clients(name)', flags),
      ])
      setNatureMissing(flags.natureMissing)
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
      // Balde do Bank Link (AUTO-BOOK fase B, 4/set/2026): linha da pseudo-invoice
      // A ATRIBUIR (invoices.origin = 'BUCKET') é compra paga e sem dono — por lei
      // compra paga é item vivo, então ela aparece (BOUGHT, sem rastreio), mas
      // rotulada A ATRIBUIR e apontando pra fila, não pra uma invoice de carro.
      for (const r of ie) {
        const inv = r.invoice_id ? invMap.get(r.invoice_id) : undefined
        if (inv?.is_quote) continue
        const status = deriveDeliverStatus(r)
        if (!status) continue
        const bucket = inv?.origin === 'BUCKET'
        // (a) O CARRO MANDA; O CLIENTE É A RESPOSTA DA SHOPPING INVOICE.
        // A ordem não é arbitrária: uma invoice de projeto TEM os dois (carro e
        // cliente), e a pergunta que a oficina faz olhando o stream é "que carro
        // está esperando isso?". Só quando não há carro — shopping invoice — o
        // cliente vira a resposta. Medido em 04/set: 687 caem no primeiro caso,
        // 116 no segundo e nenhuma no terceiro; o terceiro (volta ao código) fica
        // no código mesmo assim, porque zero hoje não é zero para sempre.
        const car = [inv?.rides?.project_code, inv?.rides?.project_name].map(v => String(v || '').trim()).filter(Boolean).join(' ')
        const client = String(inv?.clients?.name || '').trim()
        const who = car || client
        list.push({
          key: `ie-${r.id}`, status, row: r,
          name: r.item || '—', supplier: r.supplier || '', order: r.order_number || '',
          amount: r.price != null ? r.price * (r.quantity || 1) : null,
          paymentDate: r.payment_date || '',
          sourceLabel: bucket ? 'A ATRIBUIR' : who || (inv ? `INVOICE ${inv.invoice_code}` : 'INVOICE'),
          // O código da invoice não se perde — ele é a chave que casa com o
          // papel do fornecedor e com o report. Vira a segunda linha, cinza.
          // SHOPPING marca de onde saiu a linha sem carro (é o nome que os dois
          // apps já usam na tela do cliente: "SHOPPING INVOICES").
          sourceNote: bucket || !inv ? undefined : `${car ? '' : 'SHOPPING · '}INVOICE ${inv.invoice_code}`,
          // A shopping invoice era texto morto aqui (href null) — 116 linhas que
          // não levavam a lugar nenhum. Ela tem página própria, a mesma que a
          // ficha do cliente abre: /clients/<id>/invoices/<id>.
          href: bucket ? `${BASE_PATH}/adm/bank#a-atribuir`
            : inv?.ride_id && r.invoice_id ? `${BASE_PATH}/rides/${inv.ride_id}/invoices/${r.invoice_id}`
            : inv?.client_id && r.invoice_id ? `${BASE_PATH}/clients/${inv.client_id}/invoices/${r.invoice_id}` : null,
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

  // Quantas linhas ninguém classificou ainda. SAI DO DADO (é uma contagem da
  // mesma lista que a tela desenha), nunca de estimativa — e é o número que
  // mede o tamanho da fila do /adm/check visto daqui.
  const toClassify = useMemo(() => items.filter(it => needsNature(it.row.nature)).length, [items])

  // Seções na ordem do dono, cada uma do mais recente pro mais antigo
  // (payment_date desc; linha sem data — estorno limpou — vai pro fim).
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase()
    // sourceLabel entrou na busca junto com a ordem (a): agora que a linha diz o
    // CARRO, procurar por "HellBull" tem de achar as peças do HellBull — antes
    // esse texto era um código que ninguém digita.
    const match = (it: StreamItem) =>
      !q || [it.name, it.supplier, it.order, it.sourceLabel, it.row.tracking_number || ''].some(v => v.toLowerCase().includes(q))
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
  // Um relógio por render, lido no fuso do ASSUNTO (Orlando) — ver todayLocal().
  const today = todayLocal()

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
          placeholder="SEARCH item, supplier, order, tracking, car/client…"
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

      {/* MIGRATION PENDENTE — recado de operação, em português como o resto das
          ferramentas internas (o /adm/check usa exatamente este mesmo cartão).
          Só aparece na janela entre o deploy do código e o SQL rodado. */}
      {natureMissing && (
        <div className="mb-8 max-w-4xl rounded-2xl border border-amber-800 bg-amber-950/60 px-5 py-4 text-amber-200">
          <p className="font-bold">MIGRATION PENDENTE</p>
          <p className="text-sm mt-1">
            A coluna <code className="bg-black/40 px-1.5 rounded">nature</code> ainda não existe neste banco — rode <b>MIGRATION_item_nature.sql</b> (raiz do projeto) no SQL Editor do Supabase.
            Até lá o STREAM lista TUDO que foi pago (inclusive wire, imposto e licença, que nunca chegam de caminhão) e não marca nada como A CLASSIFICAR.
          </p>
        </div>
      )}

      {/* A FILA DA CLASSIFICAÇÃO, com número que sai do dado desta lista. Fica
          logo abaixo dos chips porque é isto que faz o BOUGHT encolher. */}
      {!natureMissing && toClassify > 0 && (
        <p className="-mt-4 mb-8 text-sm text-gray-500">
          <a href={`${BASE_PATH}/adm/check#dc-cards`} className="font-bold text-gray-300 hover:text-white underline">{toClassify} A CLASSIFICAR</a>
          {' '}of {items.length} lines — nobody has said yet whether they are parts. They stay on the list on purpose: a line that hides is a car nobody chases.
        </p>
      )}

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
                        {/* (b) "quando shipped, mostre a data estimada de entrega".
                            O chip do semáforo já emenda "· ETA" no texto quando há
                            eta, mas ele fica MUDO quando não há — e o silêncio é o
                            caso comum aqui (13 das 23 linhas SHIPPED, e 12 de 12 no
                            lado carro). Este chip é o que fala nos dois casos: diz a
                            data quando existe e diz que NÃO existe quando não existe,
                            que é o que faz alguém ligar para a transportadora. */}
                        {it.status === 'SHIPPED' && <EtaChip eta={it.row.eta} today={today} />}
                        {/* (c) A CLASSIFICAR. Rótulo em PORTUGUÊS mesmo no app US:
                            o vocabulário de natureza é de quem classifica, e quem
                            classifica é a casa (está escrito em lib/itemNature.ts —
                            o app US é inglês para o CLIENTE; isto é ferramenta
                            interna). Leva à fila do /adm/check, onde se responde. */}
                        {!natureMissing && needsNature(it.row.nature) && (
                          <a
                            href={`${BASE_PATH}/adm/check#dc-cards`}
                            title="Ninguém disse ainda o que é esta linha (peça? serviço? encargo? dinheiro?). Ela continua no STREAM de propósito — só sai quando alguém disser que NÃO é peça."
                            className="px-2.5 py-0.5 rounded-lg text-xs font-bold border border-dashed border-gray-600 bg-gray-900 text-gray-400 hover:text-white hover:border-gray-400 whitespace-nowrap"
                          >A CLASSIFICAR</a>
                        )}
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
                      {/* O código da invoice, que era o rótulo, agora é a nota. */}
                      {it.sourceNote && <p className="text-gray-600 text-xs mt-0.5">{it.sourceNote}</p>}
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
