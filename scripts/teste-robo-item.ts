// Teste do robô de e-mail do AutoBook: item, pedido e total (13/10/2026).
// Roda: npx tsx scripts/teste-robo-item.ts  — falha com exit 1 se algum caso quebrar.
import fs from 'fs'
import { parseMoney, orderNumbersIn, itemDoEmail, classify } from '../lib/autoBookMail.server'
import { linhaNomeada } from '../lib/mailToItem.server'

let falhas = 0
const ok = (nome: string, cond: boolean, visto: unknown) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${nome} → ${JSON.stringify(visto)}`); if (!cond) falhas++ }

// O e-mail real do Walmart (pedido 2000153-81883855), se o scratch estiver à mão; senão, o trecho dele.
const walmartTexto = (() => {
  const p = process.env.WALMART_JSON
  if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).message.text as string
  return "96 We’re on it! Lemorele Wireless HDMI... 👍 &nbsp;&zwnj;&nbsp;&zwnj; Order date: Mon, Oct 12, 2026 Order number: #2000153-81883855 Thanks for your order, Marcio! 1 item &nbsp; See item &nbsp; Order total &#8202; Includes all fees, taxes and discounts $38.44 &nbsp; Payment method &#8202; Ending in 9336 $38.44"
})()
const wm = { subject: 'Thanks for your delivery order, Marcio', text: walmartTexto, fromAddr: 'help@walmart.com', from: 'Walmart', received: '2026-10-13T00:06:51Z' }
ok('Walmart: pedido inteiro', JSON.stringify(orderNumbersIn(walmartTexto)) === JSON.stringify(['2000153-81883855']), orderNumbersIn(walmartTexto))
const m = parseMoney(walmartTexto)
ok('Walmart: total 38.44 forte', m?.amount === 38.44 && m.strong === true, m)
const it = itemDoEmail(wm)
ok('Walmart: item', it?.nome === 'Lemorele Wireless HDMI' && it.cortado === true, it)
const c = classify(wm as never)
ok('Walmart: classify PURCHASE', c?.kind === 'PURCHASE' && c.money?.amount === 38.44, c && { kind: c.kind, amount: c.money?.amount, orders: c.orders })

// Amazon — item no assunto
ok('Amazon: Ordered', itemDoEmail({ subject: 'Ordered: "Vibrant Performance 11524 Banjo..."', text: '' })?.nome === 'Vibrant Performance 11524 Banjo', itemDoEmail({ subject: 'Ordered: "Vibrant Performance 11524 Banjo..."', text: '' }))
ok('Amazon: Shipped + more', itemDoEmail({ subject: 'Shipped: "NGK Iridium Spark Plug" and 2 more items', text: '' })?.nome === 'NGK Iridium Spark Plug', itemDoEmail({ subject: 'Shipped: "NGK Iridium Spark Plug" and 2 more items', text: '' }))
ok('sem item: e-mail comum', itemDoEmail({ subject: 'Your HP Tuners order has been received!', text: 'Order ID 1965912 Total $299.94' }) === null, null)

// Regressões dos casos escritos no próprio código
ok('HHP parênteses', orderNumbersIn('Your High Horse Performance, Inc. Order Confirmation (#384734)').includes('384734'), orderNumbersIn('Your High Horse Performance, Inc. Order Confirmation (#384734)'))
ok('PayPal Order ID 384734', orderNumbersIn('Order ID 384734 Merchant High Horse').includes('384734'), orderNumbersIn('Order ID 384734 Merchant High Horse'))
ok('Summit 0430475', orderNumbersIn('Order # 0430475').includes('0430475'), orderNumbersIn('Order # 0430475'))
ok('Temu PO', orderNumbersIn('Order ID: PO-211-12345678901234').includes('PO-211-12345678901234'), orderNumbersIn('Order ID: PO-211-12345678901234'))
ok('eBay', orderNumbersIn('Order number: 19-14770-39666').includes('19-14770-39666'), orderNumbersIn('Order number: 19-14770-39666'))
ok('Amazon pedido', orderNumbersIn('Order # 113-1234567-1234567').includes('113-1234567-1234567'), orderNumbersIn('Order # 113-1234567-1234567'))
ok('Home Depot total do bloco', parseMoney('Order Summary Subtotal $175.00 Taxes $11.47 Total $186.47')?.amount === 186.47 && parseMoney('Order Summary Subtotal $175.00 Taxes $11.47 Total $186.47')?.strong === true, parseMoney('Order Summary Subtotal $175.00 Taxes $11.47 Total $186.47'))
ok('HHP desconto: total pago, não subtotal', parseMoney('Subtotal $1,444.75 Discount -$161.77 Handling $7.95 Order total $1,290.93')?.amount === 1290.93, parseMoney('Subtotal $1,444.75 Discount -$161.77 Handling $7.95 Order total $1,290.93'))
ok('Mopar cabeçalho não é valor', parseMoney('Part Number Part Name Price Quantity Total 68434939AC Valve 1 Amount Charged/Authorized $801.43')?.amount === 801.43, parseMoney('Part Number Part Name Price Quantity Total 68434939AC Valve 1 Amount Charged/Authorized $801.43'))
ok('Temu zero forte', parseMoney('Order total $0.00')?.amount === 0, parseMoney('Order total $0.00'))
ok('forte colado ganha do longe', parseMoney('Order total $50.00 ... Order total includes taxes $99.00')?.amount === 50, parseMoney('Order total $50.00 ... Order total includes taxes $99.00'))

// ── ENVIO PARCIAL (13/10/2026): HHP #386933, a 1ª caixa levou só as 2 Cometic ─────────────────────────────────────
// O e-mail real da HHP («Order Has Been Updated (#386933)», status Partially shipped) e as 10 linhas reais do pedido.
const hhpCaixa1 = 'The status of your order #386933 has changed to Partially shipped . Products to be shipped Cart Items SKU Qty Cometic C15292 4.150&quot; Bore Right Hand MLX Head Gasket for 15-26 SRT Hellcat, Trackhawk &amp; TRX 6.2L HEMI C15292-052 1 Cometic C15293 4.150&quot; Bore Left Hand MLX Head Gasket for 15-26 SRT Hellcat, Trackhawk &amp; TRX 6.2L HEMI C15293-052 1 Tracking information 1Z4XR0770301699514 (UPS® - Free Shipping)'
const hhpLinhas = [
  { nome: 'Cometic C15292 4.150" MLX head gasket .052", right — Typhoon', pn: 'C15292-052', caixa1: true },
  { nome: 'Cometic C15293 4.150" MLX head gasket .052", left — Typhoon', pn: 'C15293-052', caixa1: true },
  { nome: 'COMP Cams 201-332-17 Stage 2 Turbo HRT 229/237 camshaft (636', pn: 'cca201-332-17 + HHPSPRINGKIT2', caixa1: false },
  { nome: 'COMP Cams 5761CPG phaser limiter, Hemi VVT (HHP #386933, lista', pn: 'cca5761CPG', caixa1: false },
  { nome: 'HHP Racing 5/16" .083" wall pushrods (16) (HHP #386933, lista', pn: 'HHP640', caixa1: false },
  { nome: 'HHP Racing crankshaft pin (pinning kit) (HHP #386933, lista', pn: 'PIN', caixa1: false },
  { nome: 'Mishimoto 180° racing thermostat + gasket, Hemi (HHP #386933', pn: 'MMTS-JED-06L', caixa1: false },
  { nome: 'MOPAR 05038784AD heavy duty non-MDS lifter set (16) (HHP #38', pn: '05038784AD', caixa1: false },
  { nome: 'MOPAR 68262328AA lower engine gasket kit 6.2L Hellcat (HHP #', pn: '68262328AA', caixa1: false },
  { nome: 'MOPAR exhaust manifold gasket set (L+R) Hemi (HHP #386933, l', pn: '05038098AA / 05038099AA', caixa1: false },
]
const alfa = hhpCaixa1.toUpperCase().replace(/[^A-Z0-9]/g, '')
const nomeadas = hhpLinhas.filter(l => linhaNomeada(l, alfa))
ok('HHP caixa 1: só as 2 Cometic', nomeadas.length === 2 && nomeadas.every(l => l.caixa1), nomeadas.map(l => l.pn))
// A carta do PayPal («on its way») não nomeia item nenhum — nenhuma linha pode se achar nomeada nela.
const paypalAlfa = 'YOUR HIGH HORSE PERFORMANCE, INC. ORDER IS ON ITS WAY CARRIER: UPS TRACKING NUMBER: 1Z1777V54254687752 TRANSACTION ID 1TX24019121442911 TOTAL US$2,321.56 USD'.replace(/[^A-Z0-9]/g, '')
ok('PayPal on its way: nenhuma linha nomeada', hhpLinhas.filter(l => linhaNomeada(l, paypalAlfa)).length === 0, hhpLinhas.filter(l => linhaNomeada(l, paypalAlfa)).map(l => l.pn))

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OK')
process.exit(falhas ? 1 : 0)
