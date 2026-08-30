import { NextResponse } from 'next/server'
import { streamDb, t17Register, t17GetInfo, applyTrackInfo, notify, whereLabel, refreshAllTracking } from '@/lib/stream.server'
import { getMailAuth, setMailAuth, freshAccessToken, fetchRecentMessages, fetchRecentGmail, extractTrackings, isPurchaseConfirmation, matchRows, guessCarrier, carrierFromText, organizeInbox, sweepSpam, sweepMarketing, matchPedidos, decideBoxes, loadMoneyIndex, ensureStreamItemLinks, trackingsInField, isInternalOrderCode, orderHitInBlob, extractItemHints, RETURN_WORDS, PARTIAL_SHIPMENT, type PedidoMatch, type MoneyLine } from '@/lib/streamMail.server'
import { runAppsSweep, gmailAccessToken } from '@/lib/appsMail.server'
import { runStaffTravelSweep } from '@/lib/staffTravel.server'
import { runExpenseReportNet, enforceReceiptPaid } from '@/lib/expenseReportNet.server'
import { runPurchaseCapture } from '@/lib/purchaseCapture.server'
import { runInboxZero, alertVipMail } from '@/lib/inboxZero.server'
import { runZelleWatch } from '@/lib/zelleWatch.server'
import { runDutyWatch } from '@/lib/dutyWatch.server'
import { runMailWatch } from '@/lib/mailWatch.server'
// runStreamAnswers foi SUBSTITUÍDO pela fila de destino (cron purchase-queue,
// 19/ago) — dois leitores no mesmo grupo aplicariam a mesma resposta duas vezes.
import { runStaffPayroll } from '@/lib/staffPayroll.server'
import type { StreamRow } from '@/lib/stream'

// STREAM mail watcher — scans gz28us@hotmail.com for supplier shipping emails
// and auto-fills tracking numbers on open STREAM rows. Matched rows get the
// tracking registered with 17TRACK and flip to SHIPPED (WhatsApp report fires
// inside applyTrackInfo). Called fire-and-forget by the /stream page and daily
// by the Vercel cron; a 10-minute server-side throttle keeps it cheap.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const THROTTLE_MIN = 10
const FIRST_RUN_DAYS = 3

async function run(force: boolean): Promise<NextResponse> {
  const db = streamDb()
  const auth = await getMailAuth(db)
  if (!auth?.refresh_token) return NextResponse.json({ ok: false, reason: 'mailbox not connected (run /api/stream/mail-auth)' })

  const now = Date.now()
  if (!force && auth.last_poll && now - new Date(auth.last_poll).getTime() < THROTTLE_MIN * 60_000) {
    return NextResponse.json({ ok: true, skipped: 'throttled', updated: 0 })
  }

  const token = await freshAccessToken(db, auth)
  if (!token) return NextResponse.json({ ok: false, reason: 'token refresh failed — reconnect at /api/stream/mail-auth' })

  // ── AS TRÊS CAIXAS, não só a primeira (25/ago/2026) ───────────────────────
  // O vigia lia só o slot 1 (gz28us@hotmail) porque getMailAuth() tem id=1 como
  // padrão. Só que o fornecedor responde no endereço com que o pedido foi
  // feito: as atualizações da High Horse dos pedidos #382224 e #382872 caíram
  // SÓ no galpaoz28 (slot 2) — o STREAM ficou sem rastreio nenhum de um pacote
  // de motor de $2.448,74 que já tinha embarcado. Há e-mail da HHP nas três
  // caixas (25 / 25 / 9). Agora o poll varre as três e junta tudo antes de
  // casar com as linhas; cada caixa carrega o próprio last_poll.
  const msgs: Awaited<ReturnType<typeof fetchRecentMessages>> = []
  const boxes: string[] = []
  for (const slot of [1, 2, 3]) {
    const a = slot === 1 ? auth : await getMailAuth(db, slot)
    if (!a?.refresh_token) continue
    const t = slot === 1 ? token : await freshAccessToken(db, a)
    if (!t) continue
    const since = a.last_poll || new Date(now - FIRST_RUN_DAYS * 86_400_000).toISOString()
    const got = await fetchRecentMessages(t, since)
    msgs.push(...got)
    boxes.push(`${a.account || 'slot' + slot}:${got.length}`)
    // High-water mark moves regardless of matches — a mail scanned once is done.
    await setMailAuth(db, { last_poll: new Date(now).toISOString() }, slot)
  }
  // ── E O GMAIL (slot 4), que fala outro protocolo (26/ago/2026) ────────────
  // A Amazon manda a nota de embarque para o gz28us@gmail. Sem esta perna, as
  // compras de 25/ago embarcaram e o STREAM seguiu em BOUGHT sem rastreio.
  try {
    const a4 = await getMailAuth(db, 4)
    if (a4?.refresh_token) {
      const t4 = await gmailAccessToken(db)
      if (t4) {
        const since = a4.last_poll || new Date(now - FIRST_RUN_DAYS * 86_400_000).toISOString()
        const got = await fetchRecentGmail(t4, since)
        msgs.push(...got)
        boxes.push(`${a4.account || 'gmail'}:${got.length}`)
        await setMailAuth(db, { last_poll: new Date(now).toISOString() }, 4)
      }
    }
  } catch (e) { console.error('[mail-poll gmail]', e) }

  // ── tracking capture ──────────────────────────────────────────────────────
  // 29/ago/2026 — MORREU O PAREAMENTO POSICIONAL (rows[i] ← trackings[i]) e o
  // `taken` GLOBAL. O casamento agora é em camadas, por PEDIDO:
  //   a) order number NORMALIZADO escrito no e-mail → inequívoco
  //   b) sem order: fornecedor no REMETENTE/ASSUNTO + UMA única linha aberta
  //   c) e-mail que prova o ITEM (título/part number) → liga item a item
  //   d) resto → NÃO grava item nenhum; 2+ rastreios num pedido sem prova de
  //      item = tracking na REMESSA + NEEDS_ITEMS + pergunta no WhatsApp
  // O MESMO tracking PODE servir N itens do MESMO pedido (palavras do Márcio:
  // "mesmo que seja o mesmo tracking para múltiplos itens"), mas JAMAIS pula
  // de pedido — a defesa contra thread "Re:" citando rastreio velho é o DONO
  // do número: tracking já ligado a outro pedido nunca é recapturado.
  let updated = 0
  let trackAsked = 0
  const details: string[] = []
  // Linhas abertas = pré-entrega (BOUGHT/SHIPPED), COM e SEM rastreio: as com
  // rastreio existem pra detectar a 2ª caixa do mesmo pedido. CANCELLED /
  // REFUNDED / entregues continuam intocáveis (HHP 382526: $5.349,65
  // devolvidos — e-mail velho reprocessado não pode carimbar compra morta).
  type Row = StreamRow & { placement_status?: string | null; asked_count?: number | null; last_asked_at?: string | null }
  const { data } = await db.from('part_streams').select('*').in('status', ['BOUGHT', 'SHIPPED'])
  const open = (data as Row[]) || []
  if (msgs.length && open.length) {
    // DONO de cada tracking já visto (qualquer status; campos legados com 2-3
    // números em texto incluídos): chave = pedido normalizado, ou a própria
    // linha quando não há order. Um número nunca atravessa pra outro pedido.
    const { data: assigned } = await db.from('part_streams').select('id, order_number, tracking_number').not('tracking_number', 'is', null)
    const owners = new Map<string, Set<string>>()
    const ownKey = (r: { id: string; order_number: string | null }) =>
      r.order_number && !isInternalOrderCode(r.order_number) ? r.order_number.toUpperCase().replace(/[^A-Z0-9]/g, '') : `row:${r.id}`
    for (const r of (assigned || []) as { id: string; order_number: string | null; tracking_number: string }[]) {
      for (const t of trackingsInField(r.tracking_number)) owners.set(t, (owners.get(t) || new Set()).add(ownKey(r)))
    }
    const ownedByOther = (t: string, key: string) => { const s = owners.get(t); return !!s && (s.size > 1 || !s.has(key)) }
    const claim = (t: string, key: string) => owners.set(t, (owners.get(t) || new Set()).add(key))

    // Índice pedido→linhas de dinheiro (5 origens US; DONATED, expenses e
    // fixed_cost_expenses FORA por lei; fatura de imposto do dutyWatch fora).
    const moneyIndex = await loadMoneyIndex(db)

    // Grava um rastreio numa CAIXA do pedido: preenche a linha aberta SEM
    // rastreio mais antiga; esgotadas, NASCE uma linha nova de part_streams
    // (1 pedido → N caixas com o mesmo order_number — o modelo que o banco já
    // usa, ex.: HHP 382224 = 4 linhas). Tracking bom NUNCA é sobrescrito: o
    // update só toca linha com tracking_number nulo, e caixa nova é INSERT.
    // TRILHA DE AUDITORIA — toda gravação automática vira linha em data_fixes
    // ('stream-track-auto'). Ela NÃO pode falhar em silêncio: o robô carimba
    // rastreio, registra no 17TRACK e dispara WhatsApp — se a trilha se perder
    // sem ruído, sobra o efeito e some a explicação. Falha de log não derruba a
    // gravação (o rastreio bom vale mais que a linha de auditoria), mas sai
    // gritando no log da Vercel, no padrão do resto do arquivo.
    const logFix = async (rowId: string, field: string, oldV: string | null, newV: string, label: string) => {
      const { error } = await db.from('data_fixes').insert({
        check_key: 'stream-track-auto', table_name: 'part_streams', row_id: rowId,
        field, old_value: oldV, new_value: newV, label: label.slice(0, 200),
      })
      if (error) console.error('[stream-track-auto] trilha data_fixes FALHOU', field, rowId, error.message || error)
    }
    const writeBox = async (p: PedidoMatch, tracking: string, said: string | null, why: string): Promise<Row | null> => {
      // O que o e-mail DIZ vence o palpite por nº de dígitos — foi o palpite
      // "12 dígitos = FedEx" que rotulou um Item ID do eBay como FedEx. DHL só
      // chega aqui quando o e-mail nomeou a DHL (guarda do extractTrackings).
      const carrier = said || guessCarrier(tracking) || (/^\d{10}$/.test(tracking) ? 'DHL' : null)
      const free = p.rows.find(r => !r.tracking_number)
      if (free) {
        // A GUARDA MORA NO PRÓPRIO UPDATE. Duas execuções concorrentes existem
        // de verdade (o cron força GET a cada 5 min e a página faz POST): as
        // duas podiam eleger a MESMA linha livre em memória e a segunda
        // sobrescrevia o rastreio da primeira. Agora o UPDATE só toca linha
        // com tracking_number AINDA nulo — quem perde a corrida não escreve.
        const { data: won } = await db.from('part_streams')
          .update({ tracking_number: tracking, carrier }).eq('id', free.id)
          .is('tracking_number', null).select('id')
        if (won && won.length) {
          await logFix(free.id, 'tracking_number', null, tracking, `${[p.rows[0].supplier, p.rows[0].order_number].filter(Boolean).join(' ')} — ${why}`)
          free.tracking_number = tracking
          free.carrier = carrier
          claim(tracking, p.key)
          return free
        }
        // Perdeu a corrida: alguém preencheu a linha entre a leitura e o write.
        // Relê o estado real; se o outro gravou ESTE mesmo número, o trabalho
        // já foi feito (quem ganhou registra no 17TRACK e liga os itens) e aqui
        // não se faz nada. Se gravou outro, a linha deixa de estar livre em
        // memória e o rastreio segue para uma CAIXA NOVA, logo abaixo.
        const { data: cur } = await db.from('part_streams').select('tracking_number, carrier').eq('id', free.id).maybeSingle()
        console.error('[stream-track-auto] corrida perdida na linha', free.id, '— já tinha', cur?.tracking_number)
        free.tracking_number = (cur?.tracking_number as string | null) || tracking
        free.carrier = (cur?.carrier as string | null) ?? free.carrier
        if (trackingsInField(free.tracking_number).includes(tracking.toUpperCase())) {
          claim(tracking, p.key)
          return null
        }
      }
      const base = p.rows[0]
      const vol = p.rows.length + 1
      const { data: ins } = await db.from('part_streams').insert({
        app: base.app, invoice_id: base.invoice_id, purchase_group: base.purchase_group,
        supplier: base.supplier, order_number: base.order_number,
        item: `${String(base.item || '').replace(/\s*—\s*vol\.\d+$/i, '').slice(0, 90)} — vol.${vol}`,
        tracking_number: tracking, carrier, status: 'SHIPPED', shipped_at: new Date().toISOString(),
        where_label: base.where_label, ship_to: base.ship_to,
        last_event: `Caixa ${vol} do pedido ${base.order_number || ''} — rastreio novo por e-mail; ${why}`.replace(/\s+/g, ' ').slice(0, 240),
        last_event_at: new Date().toISOString(),
      }).select().single()
      if (!ins) return null
      await logFix(String(ins.id), 'tracking_number', '(caixa nova)', tracking, `${[base.supplier, base.order_number].filter(Boolean).join(' ')} — vol.${vol} — ${why}`)
      const row = ins as Row
      p.rows.push(row)
      open.push(row)
      claim(tracking, p.key)
      return row
    }
    const register = async (row: Row, tracking: string) => {
      await t17Register(tracking, row.carrier)
      const info = (await t17GetInfo(tracking, row.carrier)) || { latest_status: { status: 'InTransit' } }
      if (!info.latest_status?.status) info.latest_status = { status: 'InTransit' }
      await applyTrackInfo(db, row, info)
    }

    for (const msg of msgs) {
      // "Order confirmed" = BOUGHT, never SHIPPED — tracking only comes from
      // the shipping-confirmation email (caso eBay 25-14968-48374, 06/ago).
      if (isPurchaseConfirmation(msg)) continue
      const blob = `${msg.subject} ${msg.text}`
      // Devolução/replacement: o rastreio da VOLTA chega no MESMO thread com o
      // MESMO order (caso Amazon 111-9713466-2609021) — nunca capturar.
      if (RETURN_WORDS.test(blob)) continue
      const said = carrierFromText(blob)
      const trackings = extractTrackings(blob)
      // Marketplace que despacha SEM dar o número (eBay manda só "Carrier: USPS"
      // + o link "Track package"): a linha não fica com rastreio falso, mas
      // também não fica cega — grava transportadora e ETA e vai pra SHIPPED.
      if (!trackings.length) {
        // A Amazon não manda NEM rastreio NEM transportadora: a nota de embarque
        // dela traz só o nº do pedido, um link pro rastreador próprio e um
        // "Arriving today" (verificado no corpo cru dos 2 e-mails de 26/ago —
        // zero TBA, zero UPS/FedEx/USPS). Sem este ramo as compras dela
        // embarcavam e a linha ficava em BOUGHT pra sempre.
        const shipSaid = /\b(shipped|on its way|out for delivery|foi enviado|a caminho)\b/i.test(blob)
        if (!said && !shipSaid) continue
        const eta = (blob.match(/(?:estimated delivery|arriving|previs[ãa]o de entrega)[^A-Za-z0-9]{0,4}(?:by\s+)?([A-Z][a-z]{2},?\s+[A-Z][a-z]{2}\s+\d{1,2})(?:\s*[-–]\s*([A-Z][a-z]{2},?\s+[A-Z][a-z]{2}\s+\d{1,2}))?/i) || [])
        const arriving = (blob.match(/\bArriving\s+(today|tomorrow)\b/i) || [])[1]
        for (const row of matchRows(open.filter(r => !r.tracking_number), msg)) {
          // Sem transportadora declarada a prova tem de ser dura: só aceita
          // quando o NÚMERO DO PEDIDO está escrito no e-mail (normalizado). O
          // casamento por fornecedor sozinho não basta pra mexer em logística.
          const byOrder = !!row.order_number && !isInternalOrderCode(row.order_number) && orderHitInBlob(String(row.order_number), blob, true)
          if (!said && !byOrder) continue
          const quando = eta[1] ? `entrega estimada ${eta[1]}${eta[2] ? ' a ' + eta[2] : ''}` : arriving ? `chega ${arriving.toLowerCase() === 'today' ? 'hoje' : 'amanhã'}` : ''
          await db.from('part_streams').update({
            carrier: said || row.carrier, status: 'SHIPPED', shipped_at: row.shipped_at || new Date().toISOString(),
            last_event: said
              ? `Despachado — transportadora ${said} (e-mail: ${msg.subject.slice(0, 60)}). Sem nº de rastreio no e-mail${quando ? `; ${quando}` : ''}.`
              : `Despachado — e-mail do vendedor casado pelo nº do pedido ${row.order_number} ("${msg.subject.slice(0, 50)}"). O vendedor não informa transportadora nem nº de rastreio, só o rastreador próprio dele${quando ? `; ${quando}` : ''}.`,
            last_event_at: new Date().toISOString(),
          }).eq('id', row.id)
          updated++
          details.push(`${row.item} → SHIPPED ${said || '(sem transportadora informada)'}`)
        }
        continue
      }

      // ── e-mail COM rastreio: casar por PEDIDO, decidir por prova ───────────
      const pedidos = matchPedidos(open, msg)
      if (!pedidos.length) continue
      if (pedidos.length > 1) {
        // E-mail citando 2+ pedidos + rastreio: atribuir número a pedido seria
        // chute posicional de novo (regra d) — nada é gravado, fica no log.
        details.push(`⚠️ e-mail cita ${pedidos.length} pedidos + rastreio — nada gravado ("${msg.subject.slice(0, 50)}")`)
        continue
      }
      const p = pedidos[0]
      const prevTracks = new Set(p.rows.flatMap(r => trackingsInField(r.tracking_number)))
      const newTr = trackings.filter(t => !prevTracks.has(t) && !ownedByOther(t, p.key))
      if (!newTr.length) continue
      // Linhas de dinheiro do pedido — só pra remessa US (as do BR moram no
      // banco BR; lá o rastreio fica no nível da remessa, como sempre foi).
      const lines: MoneyLine[] = p.orderNorm && p.rows[0].app === 'US' ? (moneyIndex.get(p.orderNorm) || []) : []
      const why = `casado por ${p.layer === 'ORDER' ? 'nº do pedido' : 'fornecedor único'} ("${msg.subject.slice(0, 60)}")`
      const decision = decideBoxes({
        newTrackings: newTr, prevTrackingCount: prevTracks.size,
        openNoTrack: p.rows.filter(r => !r.tracking_number).length,
        lines, hints: extractItemHints(msg), partial: PARTIAL_SHIPMENT.test(blob),
      })

      if (decision.kind === 'ORDER_FANOUT' || decision.kind === 'EMAIL_ITEM') {
        const row = await writeBox(p, decision.tracking, said, why)
        if (!row) continue
        // Item por item: o rastreio na remessa se materializa em
        // part_stream_items — TODOS os itens do pedido no fan-out (matched_by
        // ORDER), só os provados no EMAIL_ITEM. Link existente é intocável.
        const toLink = decision.kind === 'EMAIL_ITEM' ? lines.filter(l => decision.lineIds.includes(l.id)) : lines
        const linked = await ensureStreamItemLinks(db, p.rows.map(r => r.id), row.id, toLink, decision.kind === 'EMAIL_ITEM' ? 'EMAIL_ITEM' : 'ORDER')
        await register(row, decision.tracking)
        updated++
        details.push(`${row.item} ← ${decision.tracking} (${decision.kind}${linked ? `, ${linked} item(s) ligados` : ''}) [${msg.subject.slice(0, 50)}]`)
      } else {
        // AMBÍGUO (2+ rastreios / parcial multi-item): a remessa é REAL — o
        // rastreio entra em part_streams —, mas item NENHUM é chutado. As
        // caixas ficam NEEDS_ITEMS e o dono é perguntado pelo canal que o
        // watcher já usa (asked_count/last_asked_at controlam a cadência).
        const written: Row[] = []
        for (const t of decision.trackings) {
          const row = await writeBox(p, t, said, `AMBÍGUO — ${decision.reason} ("${msg.subject.slice(0, 50)}")`)
          if (!row) continue
          written.push(row)
          await register(row, t)
          updated++
          details.push(`${row.item} ← ${t} (REMESSA sem itens — ${decision.reason})`)
        }
        if (written.length) {
          for (const r of written) {
            const prevPlacement = r.placement_status ?? null
            await db.from('part_streams').update({ placement_status: 'NEEDS_ITEMS' }).eq('id', r.id)
            r.placement_status = 'NEEDS_ITEMS'
            // A marcação NEEDS_ITEMS é uma decisão do robô sobre a linha tanto
            // quanto o rastreio é — e sem ela na trilha ninguém consegue
            // reconstruir DEPOIS por que aquela caixa ficou sem item.
            await logFix(r.id, 'placement_status', prevPlacement, 'NEEDS_ITEMS',
              `${[p.rows[0].supplier, p.rows[0].order_number].filter(Boolean).join(' ')} — ${decision.reason}`)
          }
          const lastAsk = p.rows.map(r => (r as Row).last_asked_at).filter(Boolean).sort().pop() || null
          if (!lastAsk || Date.now() - new Date(String(lastAsk)).getTime() > 3600_000) {
            const boxes = p.rows.filter(r => r.tracking_number)
              .map(r => `📦 ${trackingsInField(r.tracking_number).join(', ')}${r.carrier ? ` (${r.carrier})` : ''}`)
            const itens = lines.slice(0, 10).map((l, i) => `${i + 1}. ${l.text.slice(0, 60)}`)
            await notify(p.rows[0], [
              `📦 *STREAM — QUAL ITEM FOI EM QUAL CAIXA?*`,
              `Pedido ${p.rows[0].order_number || '?'} — ${p.rows[0].supplier || '?'}\n(${decision.reason})`,
              boxes.length ? `Caixas:\n${boxes.join('\n')}` : '',
              itens.length ? `Itens do pedido:\n${itens.join('\n')}` : 'Itens do pedido: sem linha de dinheiro com esse order number.',
              `Responda qual item foi em cada caixa — o robô não chuta.`,
            ].filter(Boolean).join('\n\n'))
            const now2 = new Date().toISOString()
            for (const r of written) {
              const n = (Number(r.asked_count) || 0) + 1
              await db.from('part_streams').update({ asked_count: n, last_asked_at: now2 }).eq('id', r.id)
              // O THROTTLE DA PERGUNTA LÊ A MEMÓRIA, NÃO O BANCO: sem carimbar
              // aqui o objeto em memória, um pedido com N e-mails de caixa na
              // MESMA batida (o HHP 382224 teve 4) disparava até N-1 perguntas
              // idênticas de uma vez — o `lastAsk` acima varre p.rows, e as
              // linhas escritas agora fazem parte de p.rows.
              r.asked_count = n
              r.last_asked_at = now2
              await logFix(r.id, 'asked_count', String(n - 1), String(n),
                `pergunta "qual item em qual caixa" — ${p.rows[0].order_number || '?'}`)
            }
            trackAsked++
          }
        }
      }
    }
  }

  // ── delivered-email safety net (auditoria 30/jul) — USPS é "Special Carrier"
  // no 17TRACK (registro bloqueado sem quota extra), então linhas USPS/Temu não
  // recebem push. Quando o e-mail do vendedor/transportadora anuncia a ENTREGA
  // (casado por tracking no texto, senão matchRows), a linha vira DELIVERED.
  // 25/ago: +"ORDER DELIVERED" / "DELIVERED:" — é o assunto que o eBay usa, e
  // por não casar aqui a bomba do JailBreak170 ficou 22 dias em SHIPPED mesmo
  // com o aviso de entrega na caixa desde 04/08. matchRows já casa por número
  // do PEDIDO antes de qualquer outra coisa, então basta a frase entrar.
  const DELIVERED_WORDS = /(was|has been|got) delivered|delivered (today|on |at )|delivered notification|your (package|order|item) (was|has been) delivered|\b(order|package|item|shipment|pedido)\s+delivered\b|\bdelivered\s*[:：]|entrega (realizada|conclu[ií]da)|foi entregue/i
  if (msgs.length) {
    const { data: sData } = await db.from('part_streams').select('*').eq('status', 'SHIPPED')
    const shipped = (sData as StreamRow[]) || []
    for (const msg of msgs) {
      const blob = `${msg.subject} ${msg.text}`
      if (!DELIVERED_WORDS.test(blob)) continue
      const byTracking = shipped.filter(r => r.tracking_number && blob.includes(String(r.tracking_number)))
      const hits = byTracking.length ? byTracking : matchRows(shipped, msg)
      for (const row of hits) {
        if ((row as StreamRow).status !== 'SHIPPED') continue
        await applyTrackInfo(db, row, {
          latest_status: { status: 'Delivered' },
          latest_event: { description: `Delivered (e-mail) — ${msg.subject.slice(0, 70)}`, time_iso: new Date().toISOString() },
        })
        ;(row as StreamRow).status = 'DELIVERED'
        updated++
        details.push(`${row.item} → DELIVERED via e-mail (${msg.subject.slice(0, 50)})`)
      }
    }
  }

  // ── refund watch — a CANCELLED row waits for the supplier's refund email;
  // when one lands (matched by order number, else unambiguous supplier) the row
  // flips to REFUNDED and reports it. Manual REFUNDED on the board stays as the
  // fallback for refunds that never email.
  const refunded: string[] = []
  // Only ISSUED-refund language flips the row. Cancellation acknowledgments
  // ("Got it - you want to cancel", "you'll get a refund") merely PROMISE a
  // refund — the first live run flipped on one of those, so future/conditional
  // wording must never match; the money has to have actually moved.
  const REFUND_WORDS = /(refund (has been|was|is) (issued|sent|processed|completed|credited|on its way)|refund (issued|processed|completed)|(issued|processed|sent) (your|a|the) refund|your refund of|(you have been|you've been|you were) refunded|reembolso (efetuado|realizado|conclu[ií]do)|estorno (efetuado|realizado)|compra estornada)/i
  const { data: cData } = await db.from('part_streams').select('*').eq('status', 'CANCELLED')
  const cancelled = (cData as StreamRow[]) || []
  if (msgs.length && cancelled.length) {
    for (const msg of msgs) {
      if (!REFUND_WORDS.test(`${msg.subject} ${msg.text}`)) continue
      for (const row of matchRows(cancelled.filter(r => r.status === 'CANCELLED'), msg)) {
        row.status = 'REFUNDED'
        await db.from('part_streams').update({
          status: 'REFUNDED',
          last_event: `Refund confirmed — ${msg.subject.slice(0, 80)}`,
          last_event_at: new Date().toISOString(),
        }).eq('id', row.id)
        const where = await whereLabel(db, row)
        await notify(row, `💸 *STREAM — REFUNDED*\n${row.item}\n${[row.supplier, where].filter(Boolean).join(' · ')}${row.order_number ? `\nOrder ${row.order_number}` : ''}`)
        refunded.push(row.item)
      }
    }
  }

  // ── 17TRACK batch refresh (auditoria 30/jul) — o webhook deixou de ser o
  // único caminho: toda batida consulta o 17TRACK para TODA linha aberta com
  // tracking. Se o 17TRACK recusar, o erro sai no retorno (nunca mudo).
  let trackRefresh: { checked: number; updated: string[]; reRegistered: number; error?: string } = { checked: 0, updated: [], reRegistered: 0 }
  try { trackRefresh = await refreshAllTracking(db) } catch (e) { console.error('[track-refresh]', e); trackRefresh.error = String(e) }

  // ── purchase capture ANTES dos sweeps que apagam/movem e-mail (auditoria
  // 30/jul: o sweep de marketing comia a confirmação de compra antes da captura
  // rodar — caso TouchUpDirect). Agora a compra é capturada primeiro.
  let purchases: { captured: string[] } = { captured: [] }
  try { purchases = await runPurchaseCapture(db) } catch (e) { console.error('[purchase-capture]', e) }

  // ── inbox organizer — purchase emails file into the car's Outlook folder
  // 10+ min after the user reads them; doubts stay put and get logged.
  let organizer: { moved: string[]; doubts: string[] } = { moved: [], doubts: [] }
  try { organizer = await organizeInbox(db, token) } catch (e) { console.error('[mail-organize]', e) }

  // ── spam auto-clean — toda passada varre as 3 caixas e apaga o marketing
  // conhecido na hora (regra 2026-07-24: "apague logo que chegar").
  let spam: { deleted: string[] } = { deleted: [] }
  try { spam = await sweepSpam(db) } catch (e) { console.error('[spam-sweep]', e) }
  let marketing: { deleted: string[] } = { deleted: [] }
  try { marketing = await sweepMarketing(db) } catch (e) { console.error('[marketing-sweep]', e) }

  // ── APPS watcher — recibos de assinatura no Gmail viram pagamentos no módulo
  // APPS, arquivados em Apps/<App> e reportados no grupo (2026-07-25).
  let appsPayments = 0
  try { const r = await runAppsSweep(db); appsPayments = r.payments.length } catch (e) { console.error('[apps-sweep]', e) }
  let staffTravel: { opened: string[]; closed: string[] } = { opened: [], closed: [] }
  try { staffTravel = await runStaffTravelSweep(db) } catch (e) { console.error('[staff-travel]', e) }
  // LEI 01/ago: comprovante anexado ⇒ expense PAGA — roda antes da rede de
  // reports para o report de PAGA sair no mesmo ciclo.
  let receiptPaid = 0
  try { receiptPaid = (await enforceReceiptPaid(db)).fixed } catch (e) { console.error('[receipt-paid]', e) }
  let reportNet: { reported: string[] } = { reported: [] }
  try { reportNet = await runExpenseReportNet(db) } catch (e) { console.error('[report-net]', e) }

  // ── inbox zero net — depois de todos os sweeps, o que sobrou (>15 min) ganha
  // destino por regra; sem regra → TRIAGEM (Claudinha) + pergunta no grupo.
  let inboxZero: { actions: string[] } = { actions: [] }
  try { inboxZero = await runInboxZero(db) } catch (e) { console.error('[inbox-zero]', e) }
  // ── ZELLE WATCH (LEI 13/ago) — dinheiro que entra/sai por Zelle não pode
  // depender de e-mail parado na inbox: varre a caixa INTEIRA, lança a entrada
  // com histórico e alerta o resto. Roda ANTES do inbox-zero, que arquiva.
  let zelle: { booked: string[]; pending: string[] } = { booked: [], pending: [] }
  try { zelle = await runZelleWatch(db) } catch (e) { console.error('[zelle-watch]', e) }
  // ── MAIL WATCH (27/ago) — resposta que ele está ESPERANDO não pode ficar
  // dormindo na caixa até a ronda humana. As regras moram em `mail_watches`
  // (remetente/assunto), então vigiar um novo interlocutor é um INSERT, não um
  // deploy. Antes do inbox-zero, como os outros watchers.
  let mailWatch: { alerts: string[] } = { alerts: [] }
  try { mailWatch = await runMailWatch(db) } catch (e) { console.error('[mail-watch]', e) }
  // ── DUTY WATCH (LEI 20/ago, caso BONOSS #207546) — com o de minimis morto,
  // toda importação gera uma 2ª cobrança (imposto + desembaraço) que chega
  // sozinha semanas DEPOIS da caixa. A fatura do carrier bate pelo waybill com
  // a linha do STREAM e o imposto cai na invoice certa, rateado se a remessa
  // serviu mais de um carro. Também antes do inbox-zero, que arquiva.
  let duty: { booked: string[]; pending: string[] } = { booked: [], pending: [] }
  try { duty = await runDutyWatch(db) } catch (e) { console.error('[duty-watch]', e) }
  // ── VIP mail alert — contraparte ativa escreveu ⇒ WhatsApp do Márcio na hora
  // (LEI 04/ago, caso Celina: news de negociação não pode dormir na TRIAGEM).
  let vipMail: { alerted: string[] } = { alerted: [] }
  try { vipMail = await alertVipMail(db) } catch (e) { console.error('[vip-mail]', e) }
  // A resposta do grupo à pergunta "a que carro/invoice pertence?" vira destino
  // no STREAM automaticamente (ordem 27/jul) — inclui acertar app US/BR.
  const streamAnswers: { applied: string[] } = { applied: [] } // legado — ver cron purchase-queue

  // ── Folha recorrente de staff: no dia do pagamento, a linha da semana nasce
  // EM ABERTO e fica visível como pendente até alguém dar baixa.
  let payroll: { created: string[] } = { created: [] }
  try { payroll = await runStaffPayroll(db) } catch (e) { console.error('[staff-payroll]', e) }

  // ── FINANCEIRO 24/7 — o grupo mais importante do BR (ordem 27/jul). O webhook
  // deste app enfileira cada post; quem sabe lançar é o app BR, então esta
  // batida de 5 min acorda o robô de lá. Fila e cadência ficam no mesmo relógio.
  let financeiro: unknown = null
  try {
    financeiro = await fetch(`${process.env.GZ28BR_BASE_URL || 'https://www.gz28br.com/ca'}/api/cron/financeiro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: process.env.FINANCEIRO_KEY }),
    }).then(r => r.json())
  } catch (e) { console.error('[financeiro-ping]', e) }

  return NextResponse.json({ ok: true, scanned: msgs.length, boxes, updated, trackAsked, details, refunded, trackRefresh, moved: organizer.moved, doubts: organizer.doubts, spamDeleted: spam.deleted, marketingDeleted: marketing.deleted, appsPayments, staffTravel, receiptPaid, reportNet, purchases, inboxZero, vipMail, zelle, duty, mailWatch, streamAnswers, financeiro, payroll })
}

export async function POST() { return run(false) }
// Vercel cron calls GET daily as the backstop; force past the throttle.
export async function GET() { return run(true) }
