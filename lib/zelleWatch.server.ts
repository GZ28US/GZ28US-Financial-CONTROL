// SERVER-ONLY — ZELLE WATCH (ordem do Márcio, 13/ago/2026: "zelle is a serious
// thing, fix it, so it never happens anymore"). Um Zelle de $875 do Martez caiu
// 12/ago 19:57, o organizer arquivou o aviso do Regions antes da ronda humana e
// o dinheiro passou despercebido: a ronda só enxerga a CAIXA DE ENTRADA, e o
// e-mail já não estava nela.
//
// Correção: este watcher varre a CAIXA INTEIRA (todas as pastas, via /me/messages
// sem folder), não só a inbox — pasta nenhuma esconde dinheiro. Roda a cada 5 min
// no mail-poll.
//
//   ENTRADA ($ recebido)  → lança em invoice_payments quando o remetente já tem
//                           histórico (mesma invoice do último pagamento dele) e
//                           reporta no WhatsApp; sem histórico → PENDING + alerta.
//   SAÍDA ($ enviado)     → nunca lança sozinho (falta o carro/invoice) — alerta
//                           pra virar expense na mão.
//
// Dedup pelo NÚMERO DE CONFIRMAÇÃO do Zelle, procurado nas duas tabelas — o mesmo
// aviso pode ser reprocessado sem nunca duplicar dinheiro ([[financeiro-learning-order]]:
// o robô só lança o que tem certeza, o resto é PENDING_HUMAN).

import type { SupabaseClient } from '@supabase/supabase-js'
import { waSafeTarget } from '@/lib/waSelfGuard.server'
import { enviaUltra } from '@/lib/waSend.server'

const G = 'https://graph.microsoft.com/v1.0'
const SIGNATURE = 'Sent by GZ28US Control App®'
// 31/ago/2026: NÃO pode ser o número da própria instância (13213150973). A
// UltraMsg recusa mensagem pro próprio número e o envio morre calado — 26
// avisos (FILA DE COMPRAS, COMPRA TEMU, VIP MAIL, ZELLE, MAIL WATCH) sumiram
// assim sem ninguém perceber. Todo aviso pessoal vai pro grupo REPORTS.
const MARCIO_US = '120363425950692194@g.us'
const ACCOUNT = 'gz28us@hotmail.com' // Regions escreve só nesta caixa
const FIRST_RUN_MIN = 60

type Hit = {
  direction: 'IN' | 'OUT'
  amount: number
  party: string
  conf: string
  when: string
  memo?: string
}

// Um caminho só até a UltraMsg (lib/waSend.server.ts, 11/set/2026) — é lá que o
// `@numero` do texto vira marcação de verdade, e enviaUltra nunca lança: o aviso
// segue best-effort, o lançamento do Zelle não depende dele.
async function wa(to: string, body: string): Promise<void> {
  const dest = waSafeTarget(to) // nunca o próprio número — ver waSelfGuard
  await enviaUltra(dest, `${body}\n\n${SIGNATURE}`)
}

async function msToken(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from('stream_mail_auth').select('*').eq('account', ACCOUNT).limit(1)
  const auth = data?.[0]
  if (!auth?.refresh_token) return null
  const tk = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access' }),
  }).then(r => r.json()).catch(() => null)
  if (!tk?.access_token) return null
  if (tk.refresh_token && tk.refresh_token !== auth.refresh_token) {
    await db.from('stream_mail_auth').update({ refresh_token: tk.refresh_token }).eq('id', auth.id)
  }
  return tk.access_token
}

const money = (s: string) => Number(String(s).replace(/,/g, ''))
const clean = (h: string) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

// Os dois avisos do Regions/Zelle, textos estáveis desde 2025.
export function parseZelle(subject: string, body: string): Hit | null {
  const t = clean(body)
  const inMatch = t.match(/deposited the \$([\d,]+\.\d{2}) payment from ([^(]+?)\s*\(confirmation number (\d+)\)/i)
  if (inMatch) return { direction: 'IN', amount: money(inMatch[1]), party: inMatch[2].trim(), conf: inMatch[3], when: '' }
  if (/payment to .+ (is complete|has finished processing)/i.test(`${subject} ${t}`)) {
    const amount = t.match(/Amount \$([\d,]+\.\d{2})/i)
    const conf = t.match(/Confirmation Number (\d+)/i)
    const to = t.match(/To ([A-Za-z0-9 .,&'-]+?) \(/) || subject.match(/payment to (.+?) is complete/i)
    const memo = t.match(/Message ([^]{0,80}?) As of /i)
    if (amount && conf) return { direction: 'OUT', amount: money(amount[1]), party: (to?.[1] || '?').trim(), conf: conf[1], when: '', memo: memo?.[1]?.trim() }
  }
  return null
}

// Já lançado? O número de confirmação vive na descrição do pagamento (entrada)
// ou na linha de despesa (saída) — é a impressão digital do Zelle.
async function alreadyBooked(db: SupabaseClient, hit: Hit): Promise<boolean> {
  if (hit.direction === 'IN') {
    const { data } = await db.from('invoice_payments').select('id').ilike('description', `%${hit.conf}%`).limit(1)
    return !!data?.length
  }
  const { data } = await db.from('invoice_expenses').select('id').ilike('item', `%${hit.conf}%`).limit(1)
  return !!data?.length
}

// ── O DESTINO DE UMA ENTRADA — O VALOR MANDA (Márcio, 08/set/2026) ─────────
//   "a primeira coisa que o robô tem que fazer é ver se temos um cliente com
//    este nome, se tiver, ele tem que ver se há alguma invoice dele com um valor
//    próximo, tendo, é isso, ele deve cadastrar o income e apagar a linha
//    anterior de income não paga, se houver, anexando o comprovante."
//
// A regra ANTERIOR era "invoice ABERTA mais nova do cliente" (LEI 13/ago, caso
// Martez). Ela erra de um jeito específico e caro: quando o cliente paga a conta
// de um serviço que ACABOU DE FECHAR, a invoice certa já está concluída — e o
// dinheiro vai parar na única que sobrou aberta.
//
// MEDIDO NO DIA EM QUE A LEI MUDOU (08/set/2026, 19h12): Jesse McGee mandou
// US$ 632,26 por Zelle. A US.023.3 (sondas lambda, concluída horas antes) tinha
// "Pending balance" de EXATAMENTE 632,26. A regra antiga jogou o dinheiro na
// US.023.2 — uma troca de óleo de US$ 179,56 que passou a mostrar US$ 812,26
// recebidos. O valor apontava a invoice certa; a data de conclusão escondeu.
//
// A ordem nova, e ela é a do dono:
//   1. o cliente pelo NOME;
//   2. entre TODAS as invoices dele (concluída inclusive), a linha de income
//      NÃO PAGA (sem payment_date — o "Pending balance") de valor igual;
//   3. igual ao centavo e ÚNICA  → é essa: lança e APAGA a pendente que ela quita;
//      perto mas não igual      → é essa invoice, mas a pendente FICA e o aviso
//                                 diz a diferença (nunca apagar recebível por
//                                 aproximação);
//      empate entre duas        → não é resposta, é dúvida: cai no palpite e
//                                 avisa que foi palpite.
type Destino = {
  invoice_id: string
  code: string
  // A linha de "Pending balance" que este dinheiro quita, quando bate exato.
  quita?: { id: string; amount: number }
  // Como se chegou aqui — vai no aviso, para o palpite nunca se passar por certeza.
  via: 'VALOR EXATO' | 'VALOR PROXIMO' | 'PALPITE: invoice aberta mais nova' | 'PALPITE: historico'
  diferenca?: number
}

async function destinoPorValor(db: SupabaseClient, clientId: string, amount: number): Promise<Destino | null> {
  const { data: invs } = await db.from('invoices').select('id, invoice_code')
    .eq('client_id', clientId).eq('is_quote', false)
  const ids = (invs || []).map(i => String((i as Record<string, unknown>).id))
  if (!ids.length) return null
  const code = new Map((invs || []).map(i => [String((i as Record<string, unknown>).id), String((i as Record<string, unknown>).invoice_code || '?')]))

  // A linha de income NÃO PAGA é a dívida: `payment_date` vazio é o interruptor
  // de caixa do app, e o editor cria essa linha como "Pending balance".
  const { data: abertas } = await db.from('invoice_payments')
    .select('id, invoice_id, amount, payment_date, description')
    .in('invoice_id', ids).is('payment_date', null)
  const cands = (abertas || []) as Array<Record<string, unknown>>

  const exatas = cands.filter(p => Math.abs(Number(p.amount) - amount) < 0.005)
  if (exatas.length === 1) {
    const p = exatas[0]
    return { invoice_id: String(p.invoice_id), code: code.get(String(p.invoice_id)) || '?', quita: { id: String(p.id), amount: Number(p.amount) }, via: 'VALOR EXATO' }
  }
  if (exatas.length > 1) return null  // empate não é resposta

  // "Próximo": 2% ou US$ 25, o que for maior. Serve para achar a INVOICE certa
  // quando entra um sinal ou sobra um troco — nunca para apagar a pendente.
  const tol = Math.max(25, amount * 0.02)
  const perto = cands.filter(p => Math.abs(Number(p.amount) - amount) <= tol)
    .sort((a, b) => Math.abs(Number(a.amount) - amount) - Math.abs(Number(b.amount) - amount))
  if (perto.length === 1) {
    const p = perto[0]
    return { invoice_id: String(p.invoice_id), code: code.get(String(p.invoice_id)) || '?', via: 'VALOR PROXIMO', diferenca: Number(p.amount) - amount }
  }
  return null
}

async function targetInvoice(db: SupabaseClient, party: string, amount: number): Promise<Destino | null> {
  const words = party.trim().split(/\s+/).filter(w => w.length > 2)
  if (!words.length) return null

  const { data: clients } = await db.from('clients').select('id, name')
  const norm = (s: string) => String(s || '').toUpperCase()
  const client = (clients || []).find(c => words.every(w => norm(c.name).includes(norm(w))))
    || (clients || []).find(c => norm(c.name).includes(norm(words[0])) && words.length === 1)
  if (client) {
    // O VALOR PRIMEIRO — a dívida em aberto diz a invoice melhor que a data.
    const porValor = await destinoPorValor(db, String(client.id), amount)
    if (porValor) return porValor

    // Sem dívida que case: aí sim o palpite antigo — invoice viva mais recente
    // (nunca quote, nunca concluída). Vai rotulado como palpite no aviso.
    const { data: invs } = await db.from('invoices').select('id, invoice_code, conclusion_date, created_at')
      .eq('client_id', client.id).eq('is_quote', false).is('conclusion_date', null)
      .order('created_at', { ascending: false }).limit(1)
    if (invs?.[0]) return { invoice_id: invs[0].id, code: invs[0].invoice_code || '?', via: 'PALPITE: invoice aberta mais nova' }
  }

  const { data } = await db.from('invoice_payments').select('invoice_id, payment_date').ilike('description', `%${words[0]}%`).not('invoice_id', 'is', null).order('payment_date', { ascending: false }).limit(1)
  const invoice_id = data?.[0]?.invoice_id
  if (!invoice_id) return null
  const { data: inv } = await db.from('invoices').select('invoice_code').eq('id', invoice_id).limit(1)
  return { invoice_id, code: inv?.[0]?.invoice_code || '?', via: 'PALPITE: historico' }
}

// ── O COMPROVANTE (ordem dele: "anexando o comprovante") ───────────────────
// O Zelle não manda PDF: o comprovante É o aviso do Regions. Guardo o e-mail
// inteiro, como chegou, no mesmo bucket dos outros recibos e sob a invoice que
// recebeu o dinheiro — assim a linha de income abre o papel igual a qualquer
// outra. Falhar aqui não pode desfazer o lançamento: dinheiro lançado sem papel
// é problema pequeno; dinheiro não lançado é o problema que este robô existe
// para não deixar acontecer.
async function guardaComprovante(db: SupabaseClient, invoiceId: string, hit: Hit, html: string): Promise<string | null> {
  try {
    const path = `invoices/${invoiceId}/incomes/zelle-${hit.conf}.html`
    const corpo = `<!doctype html><meta charset="utf-8"><title>Zelle ${hit.conf}</title>`
      + `<p style="font:13px system-ui;color:#555">Comprovante capturado do aviso do Regions Bank pelo GZ28US Control App — `
      + `${hit.direction === 'IN' ? 'recebido de' : 'enviado para'} ${hit.party}, US$ ${hit.amount.toFixed(2)}, confirmação ${hit.conf}, ${hit.when}.</p><hr>${html}`
    const { error } = await db.storage.from('expense-receipts')
      .upload(path, new Blob([corpo], { type: 'text/html' }), { upsert: true, contentType: 'text/html' })
    if (error) return null
    return db.storage.from('expense-receipts').getPublicUrl(path).data.publicUrl
  } catch { return null }
}

export async function runZelleWatch(db: SupabaseClient): Promise<{ booked: string[]; pending: string[] }> {
  const runStart = new Date().toISOString()
  const booked: string[] = [], pending: string[] = []
  const token = await msToken(db)
  if (!token) return { booked, pending }

  const { data: st } = await db.from('whatsapp_polling_state').select('*').eq('id', 'zelle-watch').limit(1)
  const cursor = st?.[0]?.last_message_id || new Date(Date.now() - FIRST_RUN_MIN * 60_000).toISOString()

  // CAIXA INTEIRA, não só a inbox — o organizer arquiva em minutos.
  const url = `${G}/me/messages?$filter=receivedDateTime gt ${cursor}&$top=100&$select=subject,from,receivedDateTime,body`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => null)

  for (const m of res?.value || []) {
    const from = m.from?.emailAddress?.address || ''
    if (!/regions\.com$/i.test(from)) continue
    const hit = parseZelle(String(m.subject || ''), m.body?.content || '')
    if (!hit) continue
    hit.when = String(m.receivedDateTime || runStart).slice(0, 10)
    if (await alreadyBooked(db, hit)) continue

    if (hit.direction === 'IN') {
      const target = await targetInvoice(db, hit.party, hit.amount)
      if (target) {
        const recibo = await guardaComprovante(db, target.invoice_id, hit, String(m.body?.content || ''))
        await db.from('invoice_payments').insert({
          invoice_id: target.invoice_id, amount: hit.amount, payment_date: hit.when, source: 'ZELLE', paid_to: 'GZ28US',
          description: `Zelle from ${hit.party} — conf ${hit.conf} (Regions •9336)`,
          receipt_url: recibo,
          // ── A BAIXA É `paid_at`, NÃO `payment_date` (Márcio, 08/set/2026: ──
          // "se escreveu o income do Jesse McGee no lugar certo, porque está
          //  marcando como devido ainda?")
          // `payment_date` é só a data PREVISTA; quem tira do "a receber" e vira
          // caixa é `paid_at` (`lib/financials.ts:281` — "só o que TEM paid_at;
          // agendado ainda não é caixa"). Este robô nasceu escrevendo só a
          // prevista, então TODO Zelle que ele lançou continuou aparecendo como
          // devido: o do Martez (US$ 1.000, 11/ago) ficou assim por um mês.
          // E aqui a baixa é certa por definição — o Regions escreve "we have
          // successfully DEPOSITED"; o dinheiro já está na conta.
          // Meio-dia de Orlando pela mesma razão do resto do app: data não
          // escorrega de fuso.
          paid_at: `${hit.when}T12:00:00-04:00`,
        })
        // A PENDENTE QUE ESTE DINHEIRO QUITA MORRE AQUI — e só quando bate ao
        // centavo. Deixar as duas faz a invoice mostrar o dobro recebido; apagar
        // por aproximação apagaria recebível de verdade.
        if (target.quita) await db.from('invoice_payments').delete().eq('id', target.quita.id)
        const nota = target.via === 'VALOR EXATO' ? `✅ quitou a pendência de $${target.quita?.amount.toFixed(2)} (linha antiga apagada)`
          : target.via === 'VALOR PROXIMO' ? `⚠️ pendência de $${(hit.amount + (target.diferenca || 0)).toFixed(2)} — ${target.diferenca && target.diferenca > 0 ? `ainda faltam $${target.diferenca.toFixed(2)}` : `sobraram $${Math.abs(target.diferenca || 0).toFixed(2)}`}; a linha pendente FICOU`
          : `⚠️ ${target.via} — nenhuma pendência bateu com este valor, confira`
        booked.push(`${hit.party} $${hit.amount} → ${target.code} (${target.via})`)
        await wa(MARCIO_US, `💰 *ZELLE RECEBIDO — LANÇADO*\n$${hit.amount.toFixed(2)} de ${hit.party}\nInvoice ${target.code}\n${nota}\nConf ${hit.conf} · Regions •9336${recibo ? '\n📎 comprovante anexado' : '\n⚠️ sem comprovante anexado'}`)
      } else {
        pending.push(`${hit.party} $${hit.amount}`)
        await wa(MARCIO_US, `⚠️ *ZELLE RECEBIDO — SEM DESTINO*\n$${hit.amount.toFixed(2)} de ${hit.party}\nConf ${hit.conf} · Regions •9336\n\nPrimeiro pagamento deste remetente — me diga a invoice e eu lanço.`)
      }
    } else {
      pending.push(`OUT ${hit.party} $${hit.amount}`)
      await wa(MARCIO_US, `💸 *ZELLE ENVIADO*\n$${hit.amount.toFixed(2)} para ${hit.party}${hit.memo ? `\n"${hit.memo}"` : ''}\nConf ${hit.conf} · Regions •9336\n\nMe diga o carro/invoice e eu lanço a despesa.`)
    }
  }

  await db.from('whatsapp_polling_state').upsert({ id: 'zelle-watch', last_message_id: runStart, updated_at: runStart })
  return { booked, pending }
}
