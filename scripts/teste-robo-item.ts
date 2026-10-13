// Teste do robô de e-mail do AutoBook: item, pedido e total (13/10/2026).
// Roda: npx tsx scripts/teste-robo-item.ts  — falha com exit 1 se algum caso quebrar.
import fs from 'fs'
import { parseMoney, orderNumbersIn, itemDoEmail, classify } from '../lib/autoBookMail.server'

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

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OK')
process.exit(falhas ? 1 : 0)
