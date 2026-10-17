// Teste da troca do comprovante provisório (lib/remittance.server.ts, 17/10/2026) — num banco DE MENTIRA, em memória.
// Roda: npx tsx scripts/teste-troca-comprovante.ts  — falha com exit 1 se algum caso quebrar.
import { trocarComprovantes } from '../lib/remittance.server'

/* eslint-disable @typescript-eslint/no-explicit-any */
let falhas = 0
const ok = (nome: string, cond: boolean, visto: unknown) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${nome} → ${JSON.stringify(visto)}`); if (!cond) falhas++ }

// O pedaço do supabase-js que a troca usa: select/update/insert com eq, in, is, contains, order, limit.
function bancoFalso(tabelas: Record<string, any[]>) {
  const contem = (v: any, padrao: any): boolean => Array.isArray(padrao) ? Array.isArray(v) && padrao.every(p => v.some((x: any) => contem(x, p)))
    : padrao && typeof padrao === 'object' ? !!v && Object.entries(padrao).every(([k, p]) => contem(v[k], p)) : v === padrao
  const consulta = (t: string, modo: 'select' | 'update', patch?: any) => {
    const filtros: ((r: any) => boolean)[] = []
    let lim = Infinity
    const q: any = {
      select: () => q, order: () => q,
      eq: (c: string, v: any) => { filtros.push(r => String(r[c]) === String(v)); return q },
      in: (c: string, vs: any[]) => { filtros.push(r => vs.map(String).includes(String(r[c]))); return q },
      is: (c: string, v: any) => { filtros.push(r => (r[c] ?? null) === v); return q },
      contains: (c: string, v: string) => { const p = JSON.parse(v); filtros.push(r => contem(r[c], p)); return q },
      limit: (n: number) => { lim = n; return q },
      then: (res: any, rej: any) => {
        const linhas = (tabelas[t] ||= []).filter(r => filtros.every(f => f(r))).slice(0, lim)
        if (modo === 'update') for (const r of linhas) Object.assign(r, structuredClone(patch))
        return Promise.resolve({ data: linhas.map(r => ({ ...r })), error: null }).then(res, rej)
      },
    }
    return q
  }
  return {
    from: (t: string) => ({
      select: () => consulta(t, 'select'),
      update: (patch: any) => consulta(t, 'update', patch),
      insert: (rows: any[]) => { (tabelas[t] ||= []).push(...rows); return Promise.resolve({ error: null }) },
    }),
  } as any
}

const U = (n: string) => `https://us.example/storage/${n}`
const B = (n: string) => `https://br.example/storage/x/${n}`
function cenario() {
  const us = {
    remittances: [{ id: 'R1', code: 'REM.001', amount_usd: 29882.39, completed_at: null, remit_date: '2026-10-16' }],
    remittance_incomes: [
      { remittance_id: 'R1', income_id: 'tornado', role: 'COVERS' },
      { remittance_id: 'R1', income_id: 'cambio', role: 'COVERS' },
      { remittance_id: 'R1', income_id: 'wire22', role: 'ARRIVAL' },
      { remittance_id: 'R1', income_id: 'zelle300', role: 'ARRIVAL' },
      { remittance_id: 'R1', income_id: 'wire7582', role: 'ARRIVAL' },
    ],
    invoice_incomes: [
      { id: 'tornado', amount: 18515.99, paid_at: 'x', paid_to: 'GZ28BR', receipt_url: JSON.stringify([U('nfe-082.pdf'), U('pix-tornado.pdf')]), receipt_kinds: { [U('nfe-082.pdf')]: 'NF', [U('pix-tornado.pdf')]: 'BR_ENTRY' } },
      { id: 'cambio', amount: 4725.9, paid_at: 'x', paid_to: 'GZ28BR', receipt_url: JSON.stringify([U('pix-cambio.pdf')]), receipt_kinds: { [U('pix-cambio.pdf')]: 'BR_ENTRY' } },
      { id: 'wire22', amount: 22000, paid_at: 'x', paid_to: 'GZ28US', receipt_url: JSON.stringify([U('wire-22000.pdf')]), receipt_kinds: null },
      { id: 'zelle300', amount: 300, paid_at: 'x', paid_to: 'GZ28US', receipt_url: JSON.stringify([U('zelle-mara.png')]), receipt_kinds: null },
      { id: 'wire7582', amount: 7582.39, paid_at: null, paid_to: 'GZ28US', receipt_url: null, receipt_kinds: null },
    ],
    bank_transactions: [
      { id: 'b1', match_status: 'MATCHED', matched_table: 'invoice_incomes', matched_id: 'wire22', matched_members: null },
      { id: 'b2', match_status: 'MATCHED', matched_table: 'mixed_group', matched_id: 'g', matched_members: [{ id: 'capa700', table: 'invoice_incomes' }, { id: 'zelle300', table: 'invoice_incomes' }] },
    ],
    data_fixes: [] as any[],
  }
  const br = { invoice_payments: [
    { us_income_id: 'tornado', receipt_url: JSON.stringify([B('pix-tornado.pdf')]) },
    { us_income_id: 'cambio', receipt_url: null },
  ] }
  return { us, br, b: { us: bancoFalso(us), br: bancoFalso(br) } }
}
const urls = (r: any) => JSON.parse(r.receipt_url || '[]').map((u: string) => u.split('/').pop())

async function main() {
  // 1. Dois pedaços chegaram, falta o de 7.582,39: o da Regions ENTRA, o PIX FICA.
  const c = cenario()
  const r1 = await trocarComprovantes(c.b, { gravar: true })
  const t = c.us.invoice_incomes.find(r => r.id === 'tornado')!
  ok('parcial: Tornado = NF + PIX + wire + zelle', JSON.stringify(urls(t)) === JSON.stringify(['nfe-082.pdf', 'pix-tornado.pdf', 'wire-22000.pdf', 'zelle-mara.png']), urls(t))
  ok('parcial: wire tipado REGIONS_ENTRY', (t.receipt_kinds as any)[U('wire-22000.pdf')] === 'REGIONS_ENTRY', t.receipt_kinds)
  ok('parcial: remessa aberta', !c.us.remittances[0].completed_at && !r1.concluidas.length, r1.concluidas)
  ok('parcial: trilha 2 por renda', c.us.data_fixes.length === 4, c.us.data_fixes.length)
  const r1b = await trocarComprovantes(c.b, { gravar: true })
  ok('parcial: 2ª rodada não escreve', c.us.data_fixes.length === 4 && r1b.rendas.every(x => !x.gravado), c.us.data_fixes.length)

  // 2. O último pedaço chega: o PIX sai onde o espelho do BR já o tem; no câmbio o espelho não tem → fica, remessa espera.
  const w = c.us.invoice_incomes.find(r => r.id === 'wire7582')!
  w.paid_at = 'x'; w.receipt_url = JSON.stringify([U('wire-7582.pdf')])
  c.us.bank_transactions.push({ id: 'b3', match_status: 'MATCHED', matched_table: 'invoice_incomes', matched_id: 'wire7582', matched_members: null })
  const r2 = await trocarComprovantes(c.b, { gravar: true })
  ok('inteira: Tornado = NF + 3 da Regions, PIX fora', JSON.stringify(urls(t)) === JSON.stringify(['nfe-082.pdf', 'wire-22000.pdf', 'zelle-mara.png', 'wire-7582.pdf']), urls(t))
  ok('inteira: NF continua NF', (t.receipt_kinds as any)[U('nfe-082.pdf')] === 'NF' && !(U('pix-tornado.pdf') in (t.receipt_kinds as any)), t.receipt_kinds)
  const cb = c.us.invoice_incomes.find(r => r.id === 'cambio')!
  ok('inteira: câmbio guarda o PIX (espelho BR sem ele)', urls(cb).includes('pix-cambio.pdf'), urls(cb))
  ok('inteira: remessa ainda aberta', !c.us.remittances[0].completed_at, r2.rendas.map(x => x.motivo).filter(Boolean))
  ok('inteira: trilha guarda o antigo', c.us.data_fixes.some(f => f.row_id === 'tornado' && f.field === 'receipt_url' && String(f.old_value).includes('pix-tornado')), c.us.data_fixes.length)

  // 3. A direção 4 copia o PIX ao espelho do câmbio: a próxima rodada tira o PIX e fecha a remessa.
  c.br.invoice_payments[1].receipt_url = JSON.stringify([U('pix-cambio.pdf')])
  const r3 = await trocarComprovantes(c.b, { gravar: true })
  ok('fecha: câmbio = só Regions', JSON.stringify(urls(cb)) === JSON.stringify(['wire-22000.pdf', 'zelle-mara.png', 'wire-7582.pdf']), urls(cb))
  ok('fecha: completed_at', !!c.us.remittances[0].completed_at && r3.concluidas[0] === 'REM.001', r3.concluidas)
  const r4 = await trocarComprovantes(c.b, { gravar: true })
  ok('fechada: some da fila', r4.remessas_abertas === 0, r4)

  // 4. Soma dos pedaços menor que a remessa (pedaço não registrado): PIX fica, aviso.
  const d = cenario()
  d.us.remittance_incomes = d.us.remittance_incomes.filter(e => e.income_id !== 'wire7582')
  const r5 = await trocarComprovantes(d.b, { gravar: true })
  ok('faltando pedaço: PIX fica', urls(d.us.invoice_incomes[0]).includes('pix-tornado.pdf'), urls(d.us.invoice_incomes[0]))
  ok('faltando pedaço: avisa', r5.avisos.some(a => a.includes('falta pedaço')), r5.avisos)

  // 5. Pausada: não escreve nada.
  const e = cenario()
  await trocarComprovantes(e.b, { gravar: false })
  ok('pausada: nada gravado', e.us.data_fixes.length === 0 && urls(e.us.invoice_incomes[0]).length === 2, e.us.data_fixes.length)

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\ntudo certo')
  process.exit(falhas ? 1 : 0)
}
main()
