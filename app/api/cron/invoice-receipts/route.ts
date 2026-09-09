import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// O RECIBO TAMBÉM CHEGA NA PASTA QUANDO QUEM ESCREVE É ROBÔ.
//
// Buraco meu, achado pela sessão PESCA/AutoBook em 09/set/2026: eu afirmei que
// anexar um `receipt_url` levava o documento sozinho para a pasta da invoice.
// Não leva — o `syncInvoiceReceipts` só é chamado de TRÊS TELAS (invoice nova,
// invoice em edição e o scan de /goods). Quem escreve direto no banco — os
// robôs do AutoBook, o e-mail de hora em hora, qualquer PATCH no PostgREST —
// nunca dispara nada, e o papel fica só no storage.
//
// Ela anexou o comprovante da FedEx pelo banco, esperou, e a pasta continuou
// com quatro arquivos. Estava certa.
//
// A correção não pode ser "cada robô lembra de chamar" — é a mesma doença de
// lista repetida que já custou a noite (o remetente protegido escrito em três
// arquivos, o índice e a comparação do pedido em dois lugares). Quem varre não
// depende de ninguém lembrar: este cron pega toda invoice cuja despesa mexeu
// desde a última passada e manda a rota sincronizar.
//
// Barato por desenho: a ação `invoice-receipts` tem atalho — nome esperado
// presente e nada sobrando na pasta devolve `unchanged` com UMA listagem e zero
// download. Invoice parada custa quase nada; só a que mexeu paga o preço.
export const maxDuration = 120

const JANELA_H = 6   // folga sobre o intervalo do cron: repetir é barato, perder não

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null
}

export async function GET(req: NextRequest) {
  if ((req.headers.get('authorization') || '') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const d = db()
  if (!d) return NextResponse.json({ error: 'no service key' }, { status: 500 })

  const desde = new Date(Date.now() - JANELA_H * 3600_000).toISOString()
  // Só linha COM recibo interessa: despesa sem papel não tem o que sincronizar.
  const { data: mexidas } = await d.from('invoice_expenses')
    .select('invoice_id, updated_at, receipt_url')
    .gte('updated_at', desde)
    .not('receipt_url', 'is', null)
  const ids = [...new Set((mexidas || []).map((e) => e.invoice_id).filter(Boolean))]
  if (!ids.length) return NextResponse.json({ ok: true, desde, invoices: 0, resultados: [] })

  // A zona sai do CÓDIGO da invoice, não do app que está rodando: o cofre BR
  // guarda carros US.xxx espelhados, e mandar zona errada faz a rota procurar
  // a pasta na raiz errada e não achar nada (silencioso, que é o pior).
  const { data: invs } = await d.from('invoices').select('id, invoice_code, is_quote, ride_id').in('id', ids)
  const base = process.env.GZ28_SELF_URL || 'https://www.gz28us.com/ca'
  const resultados: Array<Record<string, unknown>> = []
  for (const inv of invs || []) {
    if (inv.is_quote || !inv.ride_id) continue
    const zone = String(inv.invoice_code || '').startsWith('BR.') ? 'BR' : 'US'
    try {
      const r = await fetch(`${base}/api/ride-folder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'invoice-receipts', zone, invoiceId: inv.id }),
      })
      const j = await r.json().catch(() => ({}))
      resultados.push({ code: inv.invoice_code, result: j.result || `HTTP ${r.status}`, uploaded: (j.uploaded || []).length })
    } catch (e) {
      resultados.push({ code: inv.invoice_code, erro: String((e as Error).message || e).slice(0, 120) })
    }
  }
  const subiu = resultados.reduce((a, x) => a + (Number(x.uploaded) || 0), 0)
  if (subiu) console.log('[invoice-receipts] papéis colocados na pasta:', subiu)
  return NextResponse.json({ ok: true, desde, invoices: resultados.length, subiu, resultados })
}
