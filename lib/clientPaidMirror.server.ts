import type { SupabaseClient } from '@supabase/supabase-js'

// PAID FROM CLIENT: OS TRÊS BOXES PREENCHIDOS, NÃO DERIVADOS.
//
// Márcio, 09/set/2026: *"não é a tela que tem que derivar, tem que estar gravado
// no banco certo. (...) o que o sistema tem que fazer é gravar nos items e
// incomes os exatos mesmos valores, tem que ser tudo preenchido."*
//
// Até aqui só a DESPESA existia; ITEMS e INCOMES eram soma feita na hora pela
// tela. Fechava na tela e o banco só tinha o lado do custo — a BR.538.1 tinha
// R$ 55.666,84 em despesas do cliente e ZERO linha dos outros dois lados.
//
// O QUE NÃO PODE MUDAR AO GRAVAR (decisão dele de 06/set, que continua de pé):
// o valor do cliente entra DEPOIS do imposto e DEPOIS do desconto global. Dentro
// da base, a GZ28US passaria a dever FL tax sobre uma venda de margem zero, e o
// desconto global jogaria a linha para prejuízo. Por isso o ITEM nasce com
// `paid_from='CLIENT'` e a coluna GERADA `base_tributavel` o zera na base — o
// Postgres calcula, ninguém precisa lembrar.
//
// E O INCOME NÃO PODE VIRAR CAIXA: nenhum dinheiro nosso se moveu. A marca aqui
// NÃO é `paid_from` — a renda não tem paid_from por decisão de 26/ago ("it's
// always paid by the client"), e usar esse campo faria todo o caixa da empresa
// sumir do DFC no dia em que alguém o preenchesse por essa outra razão. A marca
// é o ELO: `mirror_expense_id` diz de qual despesa a linha nasceu. Vínculo não
// se confunde com sinalizador, não duplica (índice único) e explica sozinho por
// que a linha existe.
//
// O RECIBO É O MESMO NOS DOIS LADOS (Márcio, 09/set): *"o comprovante deve estar
// anexado tanto nas expenses quanto nas incomes, o mesmo, quando é paid from
// client."*

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
export const CLIENT = 'CLIENT'
const ehDoCliente = (e: { paid_from?: string | null }) => String(e?.paid_from || '').trim().toUpperCase() === CLIENT
/** O valor da linha, na régua de sempre: preço × qtd + imposto + extra. */
const valorDaDespesa = (e: any) => num(e.price) * (num(e.quantity) || 1) + num(e.tax) + num(e.extra)

export type EspelhoResultado = {
  invoice_id: string
  criados: number
  atualizados: number
  removidos: number
  total: number
  erros: string[]
}

/**
 * Deixa ITEMS e INCOMES desta invoice em dia com as despesas PAID FROM CLIENT.
 * Idempotente: rodar de novo não duplica e conserta valor que mudou. Some com o
 * espelho quando a despesa deixa de ser do cliente ou é apagada — senão sobraria
 * receita de uma compra que não existe mais.
 */
export async function sincronizarEspelhoCliente(db: SupabaseClient, invoiceId: string): Promise<EspelhoResultado> {
  const out: EspelhoResultado = { invoice_id: invoiceId, criados: 0, atualizados: 0, removidos: 0, total: 0, erros: [] }

  const { data: despesas, error: e1 } = await db.from('invoice_expenses')
    .select('id, item, supplier, price, quantity, tax, extra, paid_from, payment_date, receipt_url')
    .eq('invoice_id', invoiceId)
  if (e1) { out.erros.push('despesas: ' + e1.message); return out }

  const doCliente = (despesas || []).filter(ehDoCliente)
  const querido = new Map(doCliente.map((e: any) => [e.id, e]))
  out.total = doCliente.reduce((s, e) => s + valorDaDespesa(e), 0)

  const [{ data: itens }, { data: rendas }] = await Promise.all([
    db.from('invoice_parts').select('id, mirror_expense_id, description, unit_price, quantity, paid_from').eq('invoice_id', invoiceId).not('mirror_expense_id', 'is', null),
    db.from('invoice_payments').select('id, mirror_expense_id, amount, payment_date, paid_at, receipt_url, description').eq('invoice_id', invoiceId).not('mirror_expense_id', 'is', null),
  ])

  const itemDe = new Map((itens || []).map((p: any) => [p.mirror_expense_id, p]))
  const rendaDe = new Map((rendas || []).map((p: any) => [p.mirror_expense_id, p]))

  for (const e of doCliente as any[]) {
    const valor = valorDaDespesa(e)
    // A descrição diz o que é E de onde veio: quem abrir a invoice daqui a um ano
    // precisa entender por que existe uma venda de margem zero.
    const desc = `${String(e.item || 'Peça').trim()}${e.supplier ? ` · ${e.supplier}` : ''} — pago direto pelo cliente`
    const item = itemDe.get(e.id)
    const linhaItem = {
      invoice_id: invoiceId, mirror_expense_id: e.id, description: desc,
      unit_price: valor, quantity: 1, paid_from: CLIENT,
    }
    if (!item) {
      const { error } = await db.from('invoice_parts').insert(linhaItem)
      if (error) out.erros.push(`item ${e.id}: ${error.message}`); else out.criados++
    } else if (num(item.unit_price) !== valor || num(item.quantity) !== 1 || item.paid_from !== CLIENT || item.description !== desc) {
      const { error } = await db.from('invoice_parts').update(linhaItem).eq('id', item.id)
      if (error) out.erros.push(`item ${e.id}: ${error.message}`); else out.atualizados++
    }

    // A RENDA nasce BAIXADA quando a despesa está paga: o cliente quitou no ato,
    // no mesmo valor. Despesa ainda não paga (o link da FedEx que ele não pagou,
    // por exemplo) vira renda PREVISTA, sem baixa — previsto não é caixa.
    const pago = /^\d{4}-\d{2}-\d{2}$/.test(String(e.payment_date || ''))
    const linhaRenda = {
      invoice_id: invoiceId, mirror_expense_id: e.id, amount: valor,
      payment_date: pago ? e.payment_date : null,
      paid_at: pago ? e.payment_date : null,
      // O MESMO documento dos dois lados (ordem dele, 09/set).
      receipt_url: e.receipt_url || null,
      description: desc,
    }
    const renda = rendaDe.get(e.id)
    if (!renda) {
      const { error } = await db.from('invoice_payments').insert(linhaRenda)
      if (error) out.erros.push(`renda ${e.id}: ${error.message}`); else out.criados++
    } else if (num(renda.amount) !== valor || (renda.paid_at || null) !== linhaRenda.paid_at || (renda.receipt_url || null) !== linhaRenda.receipt_url) {
      const { error } = await db.from('invoice_payments').update(linhaRenda).eq('id', renda.id)
      if (error) out.erros.push(`renda ${e.id}: ${error.message}`); else out.atualizados++
    }
  }

  // ÓRFÃO MORRE. Despesa que deixou de ser do cliente — ou que foi apagada —
  // não pode deixar receita para trás: seria venda sem compra, e o número mente
  // para cima. Só apaga o que ESTE mecanismo criou (tem mirror_expense_id).
  for (const [expId, p] of itemDe) if (!querido.has(expId)) {
    const { error } = await db.from('invoice_parts').delete().eq('id', (p as any).id)
    if (error) out.erros.push(`órfão item: ${error.message}`); else out.removidos++
  }
  for (const [expId, p] of rendaDe) if (!querido.has(expId)) {
    const { error } = await db.from('invoice_payments').delete().eq('id', (p as any).id)
    if (error) out.erros.push(`órfão renda: ${error.message}`); else out.removidos++
  }

  return out
}
