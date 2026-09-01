// SERVER-ONLY — FILA DE DESTINO DAS COMPRAS (ordem do Márcio, 19/ago/2026:
// "quero que o APP faça tudo isso, não você"). Fecha o ciclo que faltava:
// capturar → regra decide, ou triagem pelo conteúdo decide → o que sobrar
// espera a PESCA → registrar no lugar certo. Nada pode ficar no limbo.
//
// O GRUPO NÃO PERGUNTA MAIS NADA (ordem dele, 25/ago: "não pergunte mais no
// grupo, não vai funcionar; isso roda no PESCA"). Tudo o que a fila fala sai no
// PVT dele — relatório do que registrou sozinha e o sino de hora em hora com o
// comando certo (PESCA TEMU / PESCA AMAZON). O ERRADO é lido nos DOIS chats.
//
// Estado DE VERDADE em part_streams.placement_status (nunca emoji em texto):
//   NEEDS_ITEMS      compra cega (Temu): sem item/valor — só a PESCA resolve
//   NEEDS_PLACEMENT  itens conhecidos, destino não — triagem tenta; senão PESCA
//   PLACED           registrada (placed_ref diz onde)   IGNORED  descartada
//
// placed_ref carrega "DESTINO#id-da-linha-criada" quando a FILA inseriu o
// dinheiro — o ERRADO só pode desfazer o que tem esse id; lançamento manual
// com o mesmo order_number é intocável (achado F2 da revisão de 19/ago).
//
// Regras (placement_rules) decidem sozinhas quando podem — resposta com
// "SEMPRE" vira regra nova (lei do auto-pelo-app). Perguntas de destino só
// DEPOIS de saber o que é cada item (ordem dele, 19/ago).

import type { SupabaseClient } from '@supabase/supabase-js'

const SIGNATURE = 'Sent by GZ28US Control App®'
// 31/ago/2026: era o cel US do Márcio — que é o número da PRÓPRIA instância. A
// UltraMsg recusa isso e o envio morre calado; 20 FILA DE COMPRAS e 4 COMPRA
// TEMU se perderam assim. Vai pro grupo REPORTS. Ver zelleWatch.
const PVT = '120363425950692194@g.us'
const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type StreamRow = {
  id: string; supplier: string | null; item: string; order_number: string | null
  ship_to: string | null; placement_status: string | null; asked_count: number
  last_asked_at: string | null; invoice_id: string | null; placed_ref: string | null
}
type Rule = { id: number; store: string | null; keyword: string | null; ship_to_match: string | null; destination: string; hits: number }

const amountOf = (item: string): number | null => {
  const m = String(item || '').match(/\$\s?([\d,]+\.\d{2})/)
  return m ? Number(m[1].replace(/,/g, '')) : null
}
// Título limpo pro lançamento ("Loja PEDIDO — $X — ❓ destino a definir" → só o que descreve).
// Strip do order number SÓ quando ele existe (achado F9: fallback 'x' comia letras do título).
function titleOf(r: StreamRow): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let t = String(r.item || '').replace(/\s*—\s*❓[^—]*$/g, '').replace(/\s*—\s*\$[\d,.]+/g, '')
  if (r.supplier) t = t.replace(new RegExp(`^${esc(r.supplier)}\\s*`, 'i'), '')
  if (r.order_number) t = t.replace(new RegExp(`\\s*#?${esc(r.order_number)}\\s*`), ' ')
  t = t.replace(/\s+/g, ' ').trim()
  return t || `${r.supplier || 'Compra'} ${r.order_number || ''}`.trim()
}
const keyOf = (r: StreamRow): string => String(r.order_number || r.id).slice(-6)
// Temu cobra via PayPal (aprendizado da PESCA TEMU 19/ago); resto = débito Regions.
const methodOf = (r: StreamRow): string => /temu/i.test(r.supplier || '') ? 'PAYPAL' : 'GZ28US Regions DebitCard'

async function wa(to: string, body: string): Promise<boolean> {
  const instance = process.env.ULTRAMSG_INSTANCE, tk = process.env.ULTRAMSG_TOKEN
  if (!instance || !tk || !to) return false
  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tk, to, body: `${body}\n\n${SIGNATURE}` }),
  }).catch(() => null)
  return !!r?.ok
}

// 23h–07h de Orlando o app dorme (perguntar às 3h só ensina a ignorar o grupo).
// Via Intl pra sobreviver ao horário de verão (achado F8: UTC-4 fixo erraria no inverno).
const quietNow = (): boolean => {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()))
  return h >= 23 || h < 7
}
const hourSince = (iso: string | null) => !iso || (Date.now() - new Date(iso).getTime()) > 3600_000

// ── Triagem pelo CONTEÚDO da compra ─────────────────────────────────────────
// Ordem do Márcio (25/ago/2026): *"vai ser muito raro enviarmos algo da oficina
// pro apartamento; o ideal seria o robô checar os itens, e havendo algo
// 'estranho' pro apartamento, requerer o PESCA, mas estando tudo ok, segue o
// fluxo."*
//
// A lei do endereço não roda em compra de marketplace: a Amazon imprime só o
// apelido do catálogo ("GZ28 - ORLANDO, FL"), nunca a rua. Então o que decide é
// o que foi comprado. A triagem é DELIBERADAMENTE torta pro lado seguro: ela só
// tem poder de dizer "isto é casa" e seguir o fluxo; qualquer cheiro de carro,
// oficina, ferramenta ou peça — e qualquer dúvida — NÃO coloca nada, deixa na
// fila pra PESCA conferir o endereço. Errar pro lado de perguntar custa tempo;
// errar pro outro lado joga custo de oficina no apartamento.
async function looksLikeHome(item: string): Promise<boolean> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return false
  const prompt = `Uma oficina de preparação de carros (GZ28) comprou os itens abaixo. O dono também mobilia um APARTAMENTO com compras da mesma conta.

ITENS: ${String(item).slice(0, 600)}

Responda SOMENTE com JSON: {"home": true|false, "why": "3-8 palavras"}

"home": true SOMENTE se TODOS os itens forem claramente de casa/apartamento (móvel, cama, banheiro, cozinha, decoração, organização doméstica, eletrodoméstico pequeno, roupa de cama/banho).
"home": false se QUALQUER item puder ser de oficina, carro, ferramenta, peça automotiva, produto de lavagem/detailing, eletrônica de bancada, EPI — ou se você tiver qualquer dúvida.
Na dúvida, SEMPRE false.`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
  }).then(x => x.json()).catch(() => null)
  try {
    const j = JSON.parse(String(r?.content?.[0]?.text || '').replace(/```json|```/g, '').trim())
    return j.home === true
  } catch { return false }
}

// ── Destinos ────────────────────────────────────────────────────────────────
// Vocabulário EXATO (achado F3: "\bCAT\b" pegava "cat-back"; palavra solta em
// conversa virava lançamento). Carro (RIDE:) só com a chave da compra junto.
function parseDestination(raw: string, allowRide: boolean): string | null {
  const clean = raw.trim().replace(/\s*SEMPRE\s*$/i, '')
  const t = clean.toUpperCase()
  if (/^(IGNORA|IGNORE|LIXO)$/.test(t)) return 'IGNORE'
  if (/^(APARTMENT|APARTAMENTO|APTO?)$/.test(t)) return 'INPUTS/APARTMENT'
  if (/^(CATS?|GATOS?)$/.test(t)) return 'INPUTS/CATS'
  if (/^(CONSUMPTION|OFICINA|SHOP|CONSUMO|INPUTS?)$/.test(t)) return 'INPUTS/CONSUMPTION'
  if (allowRide && clean.length >= 2 && clean.length <= 60) return `RIDE:${clean}`
  return null
}

async function resolveInvoice(db: SupabaseClient, term: string): Promise<{ id: string; code: string } | null> {
  const t = term.trim()
  const m = t.match(/^(US\.\d+)(\.\d+)?$/i)
  if (m?.[2]) { // código de invoice exato (US.019.2)
    const { data } = await db.from('invoices').select('id, invoice_code').ilike('invoice_code', t).limit(1)
    if (data?.[0]) return { id: data[0].id, code: data[0].invoice_code }
  }
  // ride por código (US.019) ou nome (Tornado) → invoice viva mais nova
  const rideQ = m ? db.from('rides').select('id, project_name').ilike('project_code', m[1]) : db.from('rides').select('id, project_name').ilike('project_name', `%${t}%`)
  const { data: rides } = await rideQ.limit(2)
  if (rides?.length !== 1) return null // 0 ou ambíguo: não chutar carro em dado financeiro
  const { data: invs } = await db.from('invoices').select('id, invoice_code').eq('ride_id', rides[0].id)
    .eq('is_quote', false).is('conclusion_date', null).order('created_at', { ascending: false }).limit(1)
  return invs?.[0] ? { id: invs[0].id, code: invs[0].invoice_code } : null
}

// Registra a compra no destino. Devolve o placed_ref (com #id quando a fila
// inseriu dinheiro), 'NEEDS_VALUE' quando falta valor, ou null quando o
// destino não resolve (ex.: carro não encontrado).
async function place(db: SupabaseClient, r: StreamRow, dest: string, out: string[]): Promise<string | null> {
  const amt = amountOf(r.item)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // relogio do app = Orlando (ordem 20/08): UTC virava "amanha" depois das 20h
  if (dest === 'IGNORE') {
    await db.from('part_streams').update({ placement_status: 'IGNORED', placed_ref: 'IGNORED' }).eq('id', r.id)
    return 'IGNORED'
  }
  if (dest.startsWith('INPUTS/')) {
    const category = dest.split('/')[1]
    if (amt == null) return 'NEEDS_VALUE' // sem valor não vira dinheiro — segue na fila
    let ref = dest
    const { data: dup } = r.order_number ? await db.from('inputs').select('id').eq('order_number', r.order_number).limit(1) : { data: null }
    if (!dup?.length) {
      // UMA data só (lei 18/ago): payment_date espelha purchase_date.
      const { data: ins } = await db.from('inputs').insert({
        description: titleOf(r), category, quantity: 1, unit_price: amt,
        purchase_date: today, payment_date: today, supplier: r.supplier,
        order_number: r.order_number, payment_method: methodOf(r), paid_from: 'GZ28US',
      }).select('id').single()
      if (ins?.id) {
        ref = `${dest}#${ins.id}`
        // PONTE item↔remessa (29/ago/2026): no ato de colocar a compra, a fila
        // liga o STREAM à linha de dinheiro que ELA MESMA acabou de criar — o
        // vínculo nasce de graça, casado pelo pedido (matched_by 'ORDER').
        // part_stream_items mora no banco US, o mesmo `db` desta fila. Falha
        // aqui não pode derrubar o lançamento: o dinheiro já está registrado.
        await db.from('part_stream_items').insert({
          stream_id: r.id, source_app: 'US', source_table: 'inputs',
          source_id: ins.id, qty: 1, matched_by: 'ORDER',
        }).then(() => undefined, () => undefined)
      }
    }
    await db.from('part_streams').update({ placement_status: 'PLACED', placed_ref: ref, where_label: category }).eq('id', r.id)
    out.push(`${keyOf(r)} → ${dest}`)
    return ref
  }
  if (dest.startsWith('RIDE:')) {
    const inv = await resolveInvoice(db, dest.slice(5))
    if (!inv) return null
    if (amt == null) return 'NEEDS_VALUE'
    let ref = inv.code
    // dedup pelo order_number quando houver; sem order_number insere direto
    // (achado F6: exigir order_number sumia com o dinheiro em silêncio)
    const { data: dup } = r.order_number ? await db.from('invoice_expenses').select('id').eq('order_number', r.order_number).limit(1) : { data: null }
    if (!dup?.length) {
      const { data: ins } = await db.from('invoice_expenses').insert({
        invoice_id: inv.id, supplier: r.supplier, item: titleOf(r), price: amt, quantity: 1,
        source: 'GZ28US', payment_method: methodOf(r), paid_from: 'GZ28US', paid_to: 'GZ28US',
        payment_date: today, expense_date: today, order_number: r.order_number,
      }).select('id').single()
      if (ins?.id) {
        ref = `${inv.code}#${ins.id}`
        // PONTE item↔remessa (29/ago/2026): mesma regra do destino INPUTS — a
        // linha de dinheiro recém-criada pela fila é ligada ao STREAM na hora
        // (matched_by 'ORDER'). Best-effort: nunca derruba o lançamento.
        await db.from('part_stream_items').insert({
          stream_id: r.id, source_app: 'US', source_table: 'invoice_expenses',
          source_id: ins.id, qty: 1, matched_by: 'ORDER',
        }).then(() => undefined, () => undefined)
      }
    }
    await db.from('part_streams').update({ placement_status: 'PLACED', placed_ref: ref, invoice_id: inv.id, where_label: inv.code }).eq('id', r.id)
    out.push(`${keyOf(r)} → ${inv.code}`)
    return ref
  }
  return null
}

const refLabel = (ref: string) => ref.split('#')[0]

export async function runPurchaseQueue(db: SupabaseClient): Promise<{ placed: string[]; asked: number; answered: number }> {
  const placed: string[] = []
  let asked = 0, answered = 0
  const quiet = quietNow()

  // ── 0. Classificar/promover ───────────────────────────────────────────────
  // Limbo herdado ("❓ destino a definir" no texto) entra na fila; linha cuja
  // pesca já trouxe valor sobe de NEEDS_ITEMS para NEEDS_PLACEMENT sozinha.
  // Dois marcadores de limbo herdados: "❓ destino a definir" (captura) e
  // "(itens a detalhar)" (rounds manuais de Temu) — os dois entram na fila.
  for (const marker of ['%destino a definir%', '%a detalhar%']) {
    const { data: legacy } = await db.from('part_streams').select('id, item').ilike('item', marker).is('placement_status', null)
    for (const l of legacy || []) {
      await db.from('part_streams').update({ placement_status: amountOf(l.item) == null ? 'NEEDS_ITEMS' : 'NEEDS_PLACEMENT' }).eq('id', l.id)
    }
  }
  const { data: blind } = await db.from('part_streams').select('id, item').eq('placement_status', 'NEEDS_ITEMS')
  for (const b of blind || []) {
    if (amountOf(b.item) != null && !/destino a definir/i.test(b.item)) {
      await db.from('part_streams').update({ placement_status: 'NEEDS_PLACEMENT' }).eq('id', b.id)
    }
  }

  const pending = async (st: string): Promise<StreamRow[]> => {
    const { data } = await db.from('part_streams')
      .select('id, supplier, item, order_number, ship_to, placement_status, asked_count, last_asked_at, invoice_id, placed_ref')
      .eq('placement_status', st).order('created_at', { ascending: true })
    return (data || []) as StreamRow[]
  }

  // ── 1. Regras decidem sem perguntar ───────────────────────────────────────
  // Fora do horário quieto (o report da regra faz parte do registro — de
  // madrugada a linha espera a manhã em vez de registrar mudo, achado F7).
  if (!quiet) {
    const { data: rulesData } = await db.from('placement_rules').select('*')
    const rules = (rulesData || []) as Rule[]
    for (const r of await pending('NEEDS_PLACEMENT')) {
      const rule = rules.find(x =>
        (!x.store || (r.supplier || '').toLowerCase().includes(x.store.toLowerCase())) &&
        (!x.keyword || r.item.toLowerCase().includes(x.keyword.toLowerCase())) &&
        (!x.ship_to_match || (r.ship_to || '').toLowerCase().includes(x.ship_to_match.toLowerCase())) &&
        (x.store || x.keyword || x.ship_to_match))
      if (!rule) continue
      const ref = await place(db, r, rule.destination, placed)
      if (ref && ref !== 'NEEDS_VALUE') {
        await db.from('placement_rules').update({ hits: (rule.hits || 0) + 1 }).eq('id', rule.id)
        const amt = amountOf(r.item)
        await wa(PVT, `🛒 *COMPRA REGISTRADA — ${r.supplier || 'Loja'}*\n\nPedido: ${r.order_number || '—'}\n${titleOf(r)}${amt != null ? ' — *' + usd(amt) + '*' : ''}\n\n✅ Regra aplicada: *${refLabel(ref)}*\nSe o destino estiver errado, responda: *ERRADO ${keyOf(r)}: <destino certo>*`)
      }
    }

    // ── 1b. Triagem pelo conteúdo: casa segue o fluxo, resto espera a PESCA ──
    // Só linhas ainda não triadas (asked_count 0). A que não passa recebe
    // asked_count 1 — não se re-classifica a cada 5 min e o relógio do sino
    // começa a correr. Teto de 6 por rodada pra não pesar o cron.
    let triaged = 0
    for (const r of await pending('NEEDS_PLACEMENT')) {
      if (r.asked_count > 0 || triaged >= 6) continue
      triaged++
      if (amountOf(r.item) == null) continue           // sem valor não vira dinheiro
      if (!(await looksLikeHome(r.item))) {
        await db.from('part_streams').update({ asked_count: 1 }).eq('id', r.id)
        continue
      }
      const ref = await place(db, r, 'INPUTS/APARTMENT', placed)
      if (!ref || ref === 'NEEDS_VALUE') { await db.from('part_streams').update({ asked_count: 1 }).eq('id', r.id); continue }
      const amt = amountOf(r.item)
      await wa(PVT, `🏠 *COMPRA REGISTRADA — ${r.supplier || 'Loja'}*\n\nPedido: ${r.order_number || '—'}\n${titleOf(r)}${amt != null ? ' — *' + usd(amt) + '*' : ''}\n\n✅ Só item de casa — registrada em *${refLabel(ref)}*\nSe estiver errado, responda: *ERRADO ${keyOf(r)}: <destino certo>*`)
    }
  }

  // ── 2. Ler respostas — PVT dele E grupo (resposta merece ação na hora) ────
  // O relatório do que a fila registrou sozinha passou a sair no PVT (25/ago),
  // e o ERRADO tem que poder voltar pelo MESMO lugar onde ele leu — antes só o
  // grupo era lido, então a correção morreria sem ninguém escutar. O grupo
  // continua sendo lido por segurança: resposta antiga lá ainda funciona.
  const instance = process.env.ULTRAMSG_INSTANCE, tk = process.env.ULTRAMSG_TOKEN, group = process.env.ULTRAMSG_GROUP_ID
  for (const chat of [PVT, group].filter(Boolean) as string[]) {
    if (!instance || !tk) break
    const msgs: { id?: string; body?: string; fromMe?: boolean }[] = await fetch(`https://api.ultramsg.com/${instance}/chats/messages?token=${encodeURIComponent(tk)}&chatId=${encodeURIComponent(chat)}&limit=40`).then(r => r.json()).catch(() => [])
    const { data: seenRows } = await db.from('stream_mail_moves').select('message_id').eq('from_addr', 'queue-answer')
    const seen = new Set((seenRows || []).map((x: any) => x.message_id))
    const open = [...await pending('NEEDS_PLACEMENT')]
    const done = await pending('PLACED')
    const markSeen = (mid: string, body: string, state: string) =>
      db.from('stream_mail_moves').insert({ message_id: mid, subject: body.slice(0, 120), from_addr: 'queue-answer', folder_name: 'REPORTS', state })
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const mid = 'qa:' + String(m.id || '')
      if (!m.id || m.fromMe || seen.has(mid)) continue
      const body = String(m.body || '').trim()
      if (!body || body.length > 200 || body.includes(SIGNATURE)) continue

      // "ERRADO <chave>: <destino>" — desfaz e realoca. Resolve o destino ANTES
      // de apagar qualquer coisa, e só apaga linha criada pela própria fila
      // (placed_ref com #id) — achados F1/F2.
      const err = body.match(/^ERRADO\s+([\w.-]{4,30})\s*[:\-]?\s*(.*)$/i)
      if (err) {
        const matches = done.filter(x => (x.order_number || x.id).endsWith(err[1]) || keyOf(x) === err[1])
        if (matches.length !== 1) { await wa(chat, matches.length ? `⚠️ Chave *${err[1]}* ambígua — usa o número do pedido completo.` : `⚠️ Não achei compra registrada com a chave *${err[1]}*.`); await markSeen(mid, body, 'ERRADO-NOT-FOUND'); answered++; continue }
        const row = matches[0]
        const dest = parseDestination(err[2] || '', true)
        if (!dest) { await wa(chat, `⚠️ ERRADO ${err[1]}: me diz o destino certo — *ERRADO ${err[1]}: <APARTMENT | CATS | OFICINA | carro | IGNORA>*`); await markSeen(mid, body, 'ERRADO-NO-DEST'); answered++; continue }
        if (dest.startsWith('RIDE:') && !(await resolveInvoice(db, dest.slice(5)))) { await wa(chat, `⚠️ Não achei carro/invoice viva pra "*${dest.slice(5)}*" — nada foi mexido.`); await markSeen(mid, body, 'ERRADO-BAD-RIDE'); answered++; continue }
        const [refDest, refId] = String(row.placed_ref || '').split('#')
        if (!refId) { await wa(chat, `⚠️ ${keyOf(row)} foi lançada MANUALMENTE (não pela fila) — não mexo em lançamento manual. Ajusta no app e me avisa.`); await markSeen(mid, body, 'ERRADO-MANUAL'); answered++; continue }
        // A ponte item↔remessa morre junto com a linha de dinheiro desfeita —
        // sem isso part_stream_items apontaria para um id que não existe mais.
        await db.from('part_stream_items').delete().eq('source_id', refId).then(() => undefined, () => undefined)
        if (refDest.startsWith('INPUTS/')) await db.from('inputs').delete().eq('id', refId)
        else await db.from('invoice_expenses').delete().eq('id', refId)
        const ref = await place(db, row, dest, placed)
        await wa(chat, ref && ref !== 'NEEDS_VALUE' ? `↪️ ${keyOf(row)} realocada: *${refLabel(ref)}*` : `⚠️ ${keyOf(row)}: desfeita, mas o novo destino falhou — segue na fila.`)
        if (!ref || ref === 'NEEDS_VALUE') await db.from('part_streams').update({ placement_status: 'NEEDS_PLACEMENT', placed_ref: null }).eq('id', row.id)
        await markSeen(mid, body, 'ERRADO-APPLIED'); answered++; continue
      }

      // "<chave>: <destino>" — ou destino EXATO puro quando só há UMA pendente
      const kv = body.match(/^([\w.-]{4,30})\s*[:\-]\s*(.+)$/)
      if (kv) {
        const matches = open.filter(x => (x.order_number || x.id).endsWith(kv[1]) || keyOf(x) === kv[1])
        if (!matches.length) continue // chave não é nossa — pode ser conversa; não marca
        if (matches.length > 1) { await wa(chat, `⚠️ Chave *${kv[1]}* bate em ${matches.length} compras — usa o número do pedido completo.`); await markSeen(mid, body, 'AMBIGUOUS'); answered++; continue }
        const row = matches[0]
        const dest = parseDestination(kv[2], true)
        if (!dest) continue
        const ref = await place(db, row, dest, placed)
        if (ref === 'NEEDS_VALUE') { await wa(chat, `⚠️ ${keyOf(row)} ainda não tem valor (PESCA TEMU pendente) — repete a resposta depois da pesca.`); await markSeen(mid, body, 'NEEDS-VALUE'); answered++; continue }
        if (!ref) { await wa(chat, `⚠️ Não achei carro/invoice viva pra "*${kv[2].trim()}*" (${keyOf(row)}). Tenta o código US.xxx ou o nome exato.`); await markSeen(mid, body, 'BAD-RIDE'); answered++; continue }
        open.splice(open.indexOf(row), 1)
        answered++
        if (/\bSEMPRE\b/i.test(body) && r_supplier(row)) {
          await db.from('placement_rules').insert({ store: r_supplier(row), destination: dest, note: `aprendida da resposta: "${body.slice(0, 60)}"` })
          await wa(chat, `🧠 Regra aprendida: *${r_supplier(row)} → ${refLabel(dest)}* (sempre). ✅ ${keyOf(row)} registrada em *${refLabel(ref)}*`)
        } else {
          await wa(chat, `✅ ${keyOf(row)} registrada em *${refLabel(ref)}*`)
        }
        await markSeen(mid, body, 'APPLIED'); continue
      }
      if (open.length === 1) {
        const dest = parseDestination(body, false) // sem chave: só vocabulário exato — conversa não vira lançamento
        if (!dest) continue
        const row = open[0]
        const ref = await place(db, row, dest, placed)
        if (ref && ref !== 'NEEDS_VALUE') { open.pop(); answered++; await wa(chat, `✅ ${keyOf(row)} registrada em *${refLabel(ref)}*`); await markSeen(mid, body, 'APPLIED') }
      }
    }
  }

  // ── 3. Avisar — SÓ no PVT dele, NUNCA no grupo ────────────────────────────
  // Ordem do Márcio (25/ago/2026): *"não pergunte mais no grupo, não vai
  // funcionar. Isso roda no PESCA TEMU... eu dou destino pras coisas que o robô
  // tiver dúvida na sessão do PESCA TEMU."*
  // O grupo tinha perguntado 6 vezes pelo MESMO pedido sem uma resposta: o
  // canal estava errado, não a pergunta. A fila deixa de cobrar em público e
  // vira lista silenciosa — quem consome e decide destino é a sessão PESCA
  // TEMU. O PVT só toca o sino de hora em hora dizendo que há trabalho.
  if (!quiet) {
    const needPlace = await pending('NEEDS_PLACEMENT')
    const needItems = await pending('NEEDS_ITEMS')
    const all = [...needPlace, ...needItems]
    const newest = all.map(r => r.last_asked_at).filter(Boolean).sort().pop() || null
    if (all.length && hourSince(newest)) {
      const line = (r: StreamRow) => {
        const amt = amountOf(r.item)
        // Alarme herdado da captura: entrega fora do galpão merece destaque.
        const addr = r.ship_to && !/11320|space\s*blvd/i.test(r.ship_to) ? ' 🚨 ' + r.ship_to : ''
        return `• ${r.order_number || r.id} — ${r.supplier || '?'} ${titleOf(r).slice(0, 34)}${amt != null ? ' — ' + usd(amt) : ''}${addr}`
      }
      const blk = (label: string, rows: StreamRow[]) => rows.length ? `\n\n*${label} (${rows.length})*\n${rows.map(line).join('\n')}` : ''
      // Cada loja tem seu comando na thread da PESCA (ordem dele, 25/ago): a
      // Temu se pesca inteira (e-mail cego), a Amazon se pesca só pelo ENDEREÇO
      // de entrega — que é o único dado que o e-mail dela não traz e é o que
      // decide o destino pela lei do apartamento.
      const cmdOf = (r: StreamRow): string | null =>
        /temu/i.test(r.supplier || '') ? 'PESCA TEMU'
          : /amazon/i.test(r.supplier || '') ? 'PESCA AMAZON' : null
      const cmds = [...new Set(all.map(cmdOf).filter(Boolean))] as string[]
      const foot = cmds.length
        ? `\n\nNa thread da PESCA, roda: *${cmds.join('*  •  *')}*`
        : '\n\nAbre a thread da *PESCA* no Claude e resolve por lá.'
      await wa(PVT, `🎣 *FILA DE COMPRAS — ${all.length} pendente(s)*${blk('Sem destino', needPlace)}${blk('Sem itens/valores', needItems)}${foot}`)
      const now = new Date().toISOString()
      for (const r of all) await db.from('part_streams').update({ asked_count: r.asked_count + 1, last_asked_at: now }).eq('id', r.id)
      asked += all.length
    }
  }

  return { placed, asked, answered }
}

const r_supplier = (r: StreamRow) => (r.supplier || '').trim() || null
