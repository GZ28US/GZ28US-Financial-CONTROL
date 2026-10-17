// Teste do índice pedido → carro (lib/carMail): roda contra os bancos de verdade, só LÊ. npx tsx scripts/teste-pasta-do-carro.ts
import fs from 'fs'
import { createClient } from '@supabase/supabase-js'
const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/'
process.env.SUPABASE_BR_SERVICE_ROLE_KEY ||= fs.readFileSync(MEM + 'br-service-key.txt', 'utf8').trim()
const casos: [string, string[]][] = [
  ['Kong order #23413 shipped', ['US.010']],
  ['Kramer Chrysler invoice 66280 — parachute mount', ['US.019', 'US.022']],
  ['EOS Performance order 140379', ['US.026']],
  ['Your order 1382872 shipped', []],   // fronteira: pedaço de número não casa
]
async function main() {
  const { carregaIndiceCarros, carrosDaCarta } = await import('../lib/carMail.server')
  const us = createClient('https://fvgpkbpqacnqxtrjsmpi.supabase.co', fs.readFileSync(MEM + 'us-service-key.txt', 'utf8').trim(), { auth: { persistSession: false } })
  const erros: string[] = []
  const idx = await carregaIndiceCarros(us, erros)
  console.log('pedidos de carro no índice:', idx.porPedido.size, '· linhas:', idx.porLinha.size, erros.length ? '· erros: ' + erros.join(' | ') : '')
  let ok = 0
  for (const [txt, want] of casos) {
    const got = carrosDaCarta(idx, { subject: txt, text: '' }).map(c => c.code).sort()
    const pass = JSON.stringify(got) === JSON.stringify([...want].sort())
    if (pass) ok++
    console.log(pass ? 'OK ' : 'ERRO', txt, '→', got.join(', ') || '(nenhum)', pass ? '' : '(esperava ' + want.join(', ') + ')')
  }
  console.log(`${ok}/${casos.length}`)
}
main()
