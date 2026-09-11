import { NextRequest, NextResponse } from 'next/server'
import { bankDb } from '@/lib/plaid.server'
import { requireUser } from '@/lib/auth.server'
import { auditWires } from '@/lib/auditWires.server'
import { auditBucketOrders } from '@/lib/auditBucketOrders.server'
import { auditPayer } from '@/lib/auditPayer.server'
import { auditDiscount } from '@/lib/auditDiscount.server'
import { closeScore } from '@/lib/closeScore.server'

// AUDITORIA DO DATA CHECKER (DC 1.51.0 — João, 10/set/2026, depois do Márcio: todo lançamento é do AUTO-BOOK; o AUTO-LINK só casa
// e audita; o Data Checker mostra a prova e pergunta). SÓ LEITURA: cinco módulos leem as tabelas e devolvem { items, summary };
// nenhum escreve, nenhum chama writer do motor. Módulo que falha vira { error } e os outros seguem (o card dele mostra SINAL).
// O placar do fechamento roda depois, com os achados dos quatro — ele mesmo descarta o que já conta (findings_skipped_as_counted).
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Part<T> = T | { error: string }
const msgOf = (e: unknown) => String((e as Error)?.message || e).slice(0, 300)
async function part<T>(f: () => Promise<T>): Promise<Part<T>> { try { return await f() } catch (e) { return { error: msgOf(e) } } }
/* eslint-disable @typescript-eslint/no-explicit-any */
const hasItems = (x: any): x is { items: any[] } => !!x && Array.isArray(x.items)
// A chave do card de cada parte — a mesma do VISTO na página (check_key|row_id, row_id = chave do item cortada em 150).
const CARD = { wires: 'audit-wires', bucketOrders: 'audit-bucket-orders', payer: 'audit-payer', discount: 'audit-discount', noBank: 'audit-no-bank' } as const
const EVIDENCE_MAX = 320

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const db = bankDb()
    // O caixa ao vivo verde (card cash-match, 9c) prova os meses sem extrato. A página só manda a data de hoje (Orlando) quando está verde.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const lp = String(req.nextUrl.searchParams.get('live_proof_until') || '')
    const liveProofUntil = /^\d{4}-\d{2}-\d{2}$/.test(lp) && lp <= today ? lp : null
    // VISTO vale no placar (revisão de 10/set): achado marcado «visto, está certo» num card não trava o mês. A régua do
    // /api/data-check/auto: vale a dispensa mais recente de cada check_key|row_id; UNDISMISS cancela; DESFEITO não esconde.
    // Leitura que falha = nada escondido (o placar conta a mais, nunca a menos).
    const hidden = new Set<string>()
    const dis = await part(async () => {
      const { data, error } = await db.from('data_fixes').select('check_key, row_id, new_value, fixed_at').eq('field', 'DISMISSED').in('check_key', Object.values(CARD)).order('fixed_at', { ascending: false }).limit(5000)
      if (error) throw new Error(error.message)
      const seen = new Set<string>()
      for (const r of data || []) { const k = r.check_key + '|' + r.row_id; if (seen.has(k)) continue; seen.add(k); if (r.new_value !== 'UNDISMISS' && r.new_value !== 'DESFEITO') hidden.add(k) }
      return hidden.size
    })
    const [wires, bucketOrders, payer, discount] = await Promise.all([part(() => auditWires(db)), part(() => auditBucketOrders(db)), part(() => auditPayer(db)), part(() => auditDiscount(db))])
    const visible = (card: string, x: unknown) => (hasItems(x) ? x.items.filter((it: any) => !hidden.has(card + '|' + String(it.key).slice(0, 150))) : [])
    const findings = [...visible(CARD.wires, wires), ...visible(CARD.bucketOrders, bucketOrders), ...visible(CARD.payer, payer), ...visible(CARD.discount, discount)]
    const noBankSeen = new Set([...hidden].filter(k => k.startsWith(CARD.noBank + '|')).map(k => k.slice(CARD.noBank.length + 1)))
    const close0 = await part(() => closeScore(db, { findings, liveProofUntil, dismissed: noBankSeen }))
    // DINHEIRO NO APP SEM LINHA NO BANCO (revisão de 10/set: o placar dizia «cada número mora num card», e o pago/recebido sem linha não
    // morava em card nenhum). As linhas saem do próprio placar; custo fixo tem card próprio («Paga no app, sem linha no banco») e linha de
    // pedido que «Balde em dobro» já cita fica lá — nada pergunta duas vezes.
    let noBank: any
    if (hasItems(close0)) {
      const bucketIds = new Set<string>(hasItems(bucketOrders) ? bucketOrders.items.flatMap((i: any) => (i.refs || []).filter((r: any) => r.table === 'invoice_expenses').map((r: any) => String(r.id))) : [])
      let fixedN = 0, bucketN = 0
      const items = close0.items.filter((i: any) => {
        if (i.kind !== 'paid_no_bank' && i.kind !== 'received_no_bank') return false
        const r0 = (i.refs || [])[0]
        if (r0 && r0.table === 'fixed_cost_expenses') { fixedN++; return false }
        if (r0 && r0.table === 'invoice_expenses' && bucketIds.has(String(r0.id))) { bucketN++; return false }
        return true
      }).map((i: any) => ({ ...i, evidence: String(i.evidence || '').length > EVIDENCE_MAX ? String(i.evidence).slice(0, EVIDENCE_MAX - 1) + '…' : i.evidence }))
      const of = (k: string) => items.filter((i: any) => i.kind === k)
      const usdOf = (rows: any[]) => Math.round(rows.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0) * 100) / 100
      noBank = { items, summary: { pago_sem_linha_n: of('paid_no_bank').length, pago_sem_linha_usd: usdOf(of('paid_no_bank')), recebido_sem_linha_n: of('received_no_bank').length, recebido_sem_linha_usd: usdOf(of('received_no_bank')), fora_custo_fixo_n: fixedN, fora_balde_em_dobro_n: bucketN } }
    } else noBank = { error: 'o placar não rodou — ' + String((close0 as any)?.error || '').slice(0, 200) }
    // O placar vai sem os itens por mês (medido em 10/set: 351 KB de 485 KB): a tabela lê months, summary e global; a pergunta linha a linha mora nos cards.
    const close = hasItems(close0) ? { ...(close0 as any), items: undefined, items_n: close0.items.length } : close0
    // Linha do banco citada que segue sem dono (NEW/QUEUED): a pergunta dela já conta na Conciliação bancária — o card mostra a prova e não conta de novo.
    const ids = [...new Set([wires, bucketOrders, payer, discount].flatMap(x => (hasItems(x) ? x.items : [])).flatMap((i: any) => (i.refs || []).filter((r: any) => r.table === 'bank_transactions').map((r: any) => String(r.id))))]
    let open_bank_ids: string[] | null = []
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db.from('bank_transactions').select('id').in('id', ids.slice(i, i + 200)).in('match_status', ['NEW', 'QUEUED'])
        if (error) throw new Error(error.message)
        for (const r of data || []) open_bank_ids.push(String(r.id))
      }
    } catch { open_bank_ids = null }   // sem essa leitura o card não sabe o que já conta na Conciliação: os itens com linha do banco aparecem sem contar e o card diz SINAL
    return NextResponse.json({ ok: true, wires, bucketOrders, payer, discount, noBank, close, open_bank_ids, live_proof_until: liveProofUntil, dismissals_read: typeof dis === 'number' })
  } catch (e) {
    return NextResponse.json({ error: msgOf(e) }, { status: 500 })
  }
}
