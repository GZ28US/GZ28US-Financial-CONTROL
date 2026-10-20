// Teste do RASTREIO CEGO (LIVRO 13.10, 20/10/2026): quem é cego, de que loja, e a fila real.
// Roda: npx tsx scripts/teste-rastreio-cego.ts  — falha com exit 1 se algum caso quebrar.
// Com FILA=1 (e .env.local à mão) também lista a fila do banco US, só leitura.
import { isBlindTracking, blindStore, storeOrderUrl } from '../lib/deliverStatus'

let falhas = 0
const ok = (nome: string, cond: boolean, visto: unknown) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${nome} → ${JSON.stringify(visto)}`); if (!cond) falhas++ }
const base = { picked_up: false, cancel_status: null, payment_date: '2026-10-12', nature: null, tracking_number: null, delivered_at: null, supplier: 'Amazon — Shift Craft', order_number: '111-9840614-1537067', amount: 247 }

ok('Shift Craft antes de chegar é cego', isBlindTracking(base), true)
ok('loja pelo formato Amazon', blindStore('Shift Craft', '111-9840614-1537067') === 'AMAZON', blindStore('Shift Craft', '111-9840614-1537067'))
ok('loja pelo formato eBay', blindStore('racercentre', '24-15302-86434') === 'EBAY', blindStore('racercentre', '24-15302-86434'))
ok('loja pelo formato Temu', blindStore('', 'PO-211-13662680248952437') === 'TEMU', blindStore('', 'PO-211-13662680248952437'))
ok('loja desconhecida', blindStore('Titan Motorsports', '384917') === null, blindStore('Titan Motorsports', '384917'))
ok('com rastreio não é cego', !isBlindTracking({ ...base, tracking_number: '1Z999' }), false)
ok('entregue não é cego', !isBlindTracking({ ...base, delivered_at: '2026-10-19T15:40:21Z' }), false)
ok('balcão não é cego', !isBlindTracking({ ...base, picked_up: true }), false)
ok('cancelada não é cega', !isBlindTracking({ ...base, cancel_status: 'CANCELLED' }), false)
ok('não paga não é cega', !isBlindTracking({ ...base, payment_date: null }), false)
ok('sem pedido não é cega', !isBlindTracking({ ...base, order_number: '' }), false)
ok('linha de ESTORNO (negativa) não é cega', !isBlindTracking({ ...base, amount: -540.43 }), false)
ok('serviço não é cego', !isBlindTracking({ ...base, nature: 'SERVICE' }), false)
ok('chave bank: do Bank Link não é pedido', !isBlindTracking({ ...base, supplier: 'BP', order_number: 'bank:b7dadb6f-b712-4a97-9616-74fcfa1921cb' }), false)
ok('AutoZone de balcão com nota não é cega', !isBlindTracking({ ...base, supplier: 'AutoZone 02484', order_number: '2484-11' }), false)
ok('URL Amazon', storeOrderUrl('AMAZON', '111-9840614-1537067') === 'https://www.amazon.com/gp/your-account/order-details?orderID=111-9840614-1537067', storeOrderUrl('AMAZON', '111-9840614-1537067'))

async function fila() {
  const fs = await import('fs')
  for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '') }
  // A chave de serviço mora fora do repo (memory/us-service-key.txt) — lida aqui, nunca em argv.
  const kf = "C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/us-service-key.txt"
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && fs.existsSync(kf)) process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(kf, "utf8").replace(/\s+/g, "")
  const { itemsDb } = await import('../lib/itemTracking.server')
  const { listBlind } = await import('../lib/storeCheck.server')
  const r = await listBlind(itemsDb())
  if (r.error) { console.log('FAIL fila', r.error); falhas++; return }
  console.log(`\nFILA: ${r.lines} linhas cegas em ${r.orders.length} pedidos; robô lê ${r.orders.filter(o => o.store).length}`)
  for (const o of r.orders) console.log(`  ${o.store || '—'.padEnd(6)} ${o.order_number.padEnd(26)} ${String(o.lines[0].payment_date)} ${o.lines.length}× ${o.supplier.slice(0, 30)} · ${o.lines[0].item.slice(0, 50)}`)
}
;(async () => { if (process.env.FILA) await fila(); if (falhas) { console.log(`\n${falhas} FALHA(S)`); process.exit(1) } else console.log('\ntudo OK') })()
