// ════════════════════════════════════════════════════════════════════════════
// lib/remittance.server.ts · 17/out/2026 — A TROCA DO COMPROVANTE PROVISÓRIO (SÓ SERVIDOR)
//
// Márcio, 17/10/2026: «podem ficar os comprovantes do BR no app do US, de forma provisória, até que hajam os comprovantes
// do US, quando existirem os comprovantes do US, o app automaticamente tem que substitui-los… é assim que tem que ser».
// Modelo aprovado por ele no mesmo dia (MIGRATION_comprovante_entrada.sql):
//   remittances ........ a remessa BR→US, um registro (câmbio real)
//   remittance_incomes . COVERS  = renda do US PAID TO GZ28BR que ela cobre
//                        ARRIVAL = pagamento do GZ28BR numa 006.N que É um pedaço dela (casado com a linha da Regions)
//   invoice_incomes.receipt_kinds  { url: NF | BR_ENTRY | REGIONS_ENTRY }
//
// O QUE ESTE ARQUIVO FAZ, a cada rodada do cron da travessia (depois do motor, para a direção 4 já ter copiado o PIX ao BR):
//   · pedaço que CHEGOU (pago + linha da Regions MATCHED) → os comprovantes dele entram nas rendas cobertas como REGIONS_ENTRY;
//   · remessa INTEIRA na Regions (todo pedaço chegou e a soma dos pedaços = amount_usd) → o BR_ENTRY sai das rendas cobertas
//     («só quando completa», decisão do Márcio 17/10). A NF e todo arquivo sem tipo ficam. O PIX só sai do US se o pagamento
//     espelho no BR (us_income_id) tem o mesmo arquivo — o papel nunca some dos dois lados. Feito isso, completed_at.
// Idempotente (estado desejado × estado atual), guarda no update (receipt_url como foi lido) e trilha em data_fixes
// (check_key 'comprovante-entrada-regions') com o valor antigo e o novo de cada campo.

import type { SupabaseClient } from '@supabase/supabase-js'
import { gravarRecibo, nomeDoArquivo, tiposDoRecibo, urlsDoRecibo, type ReceiptKind } from '@/lib/receiptKinds'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>
export const TRILHA_COMPROVANTE = 'comprovante-entrada-regions'

export type TrocaRenda = { remessa: string; income_id: string; entra: string[]; sai: string[]; gravado: boolean; motivo: string | null }
export type ResultadoTroca = { remessas_abertas: number; concluidas: string[]; rendas: TrocaRenda[]; avisos: string[] }

const r2 = (n: number) => Math.round(n * 100) / 100

async function ler(db: SupabaseClient, tabela: string, colunas: string, filtro: (q: any) => any): Promise<Row[]> {
  const { data, error } = await filtro(db.from(tabela).select(colunas))
  if (error || !Array.isArray(data)) throw new Error(`ler ${tabela}: ${error?.message || 'sem lista'}`)
  return data as Row[]
}

/** As rendas (ids) com linha da Regions MATCHED — direta (matched_id) ou dentro de um grupo (matched_members). */
async function chegaramNaRegions(us: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (!ids.length) return out
  for (const t of await ler(us, 'bank_transactions', 'matched_id', q => q.eq('match_status', 'MATCHED').eq('matched_table', 'invoice_incomes').in('matched_id', ids))) out.add(String(t.matched_id))
  for (const id of ids) {
    if (out.has(id)) continue
    const g = await ler(us, 'bank_transactions', 'id', q => q.eq('match_status', 'MATCHED').contains('matched_members', JSON.stringify([{ id, table: 'invoice_incomes' }])).limit(1))
    if (g.length) out.add(id)
  }
  return out
}

/**
 * Uma rodada da troca. `gravar: false` só conta o que faria (TRAVESSIA_PAUSADA). Erro de leitura sobe; conflito numa renda
 * (alguém mexeu no comprovante entre a leitura e a escrita) vira motivo naquela renda e a remessa espera a próxima rodada.
 */
export async function trocarComprovantes(b: { us: SupabaseClient; br: SupabaseClient }, opcoes: { gravar: boolean }): Promise<ResultadoTroca> {
  const { us, br } = b
  const out: ResultadoTroca = { remessas_abertas: 0, concluidas: [], rendas: [], avisos: [] }
  const remessas = await ler(us, 'remittances', 'id, code, amount_usd, completed_at', q => q.is('completed_at', null).order('remit_date'))
  out.remessas_abertas = remessas.length
  if (!remessas.length) return out
  const elos = await ler(us, 'remittance_incomes', 'remittance_id, income_id, role', q => q.in('remittance_id', remessas.map(r => r.id)))
  const ids = [...new Set(elos.map(e => String(e.income_id)))]
  const rendas = new Map((ids.length ? await ler(us, 'invoice_incomes', 'id, amount, paid_at, paid_to, receipt_url, receipt_kinds', q => q.in('id', ids)) : []).map(r => [String(r.id), r]))
  const arrivalIds = [...new Set(elos.filter(e => e.role === 'ARRIVAL').map(e => String(e.income_id)))]
  const naRegions = await chegaramNaRegions(us, arrivalIds)
  const coveredIds = [...new Set(elos.filter(e => e.role === 'COVERS').map(e => String(e.income_id)))]
  // O pagamento espelho no BR de cada renda coberta: o PIX só sai do US se ele já está lá.
  const espelhos = coveredIds.length ? await ler(br, 'invoice_payments', 'us_income_id, receipt_url', q => q.in('us_income_id', coveredIds)) : []
  const noBR = new Map<string, Set<string>>()
  for (const p of espelhos) { const k = String(p.us_income_id); const s = noBR.get(k) || new Set<string>(); for (const u of urlsDoRecibo(p.receipt_url)) s.add(nomeDoArquivo(u)); noBR.set(k, s) }

  for (const rem of remessas) {
    const meus = elos.filter(e => e.remittance_id === rem.id)
    const pedacos = meus.filter(e => e.role === 'ARRIVAL').map(e => rendas.get(String(e.income_id))).filter(Boolean) as Row[]
    const cobertas = meus.filter(e => e.role === 'COVERS').map(e => rendas.get(String(e.income_id))).filter(Boolean) as Row[]
    if (!cobertas.length) { out.avisos.push(`${rem.code}: nenhuma renda coberta (COVERS) ligada — nada a trocar`); continue }
    const chegou = (p: Row) => !!p.paid_at && naRegions.has(String(p.id))
    // Os comprovantes dos pedaços que chegaram — tudo menos o que o próprio pedaço tipou como NF ou BR_ENTRY. Um por nome.
    const daRegions: string[] = []
    const vistos = new Set<string>()
    for (const p of pedacos.filter(chegou)) {
      const k = tiposDoRecibo(p.receipt_kinds)
      const urls = urlsDoRecibo(p.receipt_url).filter(u => k[u] !== 'NF' && k[u] !== 'BR_ENTRY')
      if (!urls.length) out.avisos.push(`${rem.code}: o pedaço ${String(p.id).slice(0, 8)} (US$ ${p.amount}) chegou à Regions SEM comprovante anexado`)
      for (const u of urls) { const n = nomeDoArquivo(u); if (!vistos.has(n)) { vistos.add(n); daRegions.push(u) } }
    }
    const somaPedacos = r2(pedacos.reduce((s, p) => s + Number(p.amount || 0), 0))
    const inteira = pedacos.length > 0 && pedacos.every(chegou) && Math.abs(somaPedacos - Number(rem.amount_usd)) < 0.01
    if (pedacos.length && pedacos.every(chegou) && !inteira) out.avisos.push(`${rem.code}: os pedaços somam US$ ${somaPedacos}, a remessa é US$ ${rem.amount_usd} — falta pedaço; o PIX fica provisório`)
    if (inteira && !daRegions.length) out.avisos.push(`${rem.code}: chegou inteira mas nenhum pedaço tem comprovante — o PIX fica até o da Regions ser anexado`)
    const trocaPix = inteira && daRegions.length > 0
    let tudoCerto = trocaPix

    for (const c of cobertas) {
      const urls = urlsDoRecibo(c.receipt_url)
      const k = tiposDoRecibo(c.receipt_kinds)
      const t: TrocaRenda = { remessa: rem.code, income_id: String(c.id), entra: [], sai: [], gravado: false, motivo: null }
      if (String(c.paid_to || '').toUpperCase() !== 'GZ28BR') {
        out.avisos.push(`${rem.code}: a renda coberta ${String(c.id).slice(0, 8)} não é PAID TO GZ28BR (${c.paid_to || 'vazio'}) — não mexo`)
        tudoCerto = false
        continue
      }
      const nomes = new Set(urls.map(nomeDoArquivo))
      t.entra = daRegions.filter(u => !nomes.has(nomeDoArquivo(u)))
      let ficam = urls
      if (trocaPix) {
        const espelho = noBR.get(String(c.id)) || new Set<string>()
        const pix = urls.filter(u => k[u] === 'BR_ENTRY')
        const semCopia = pix.filter(u => !espelho.has(nomeDoArquivo(u)))
        if (semCopia.length) { t.motivo = `o pagamento espelho no BR ainda não tem ${semCopia.map(nomeDoArquivo).join(', ')} — o PIX fica no US até a direção 4 copiar`; tudoCerto = false }
        t.sai = pix.filter(u => !semCopia.includes(u))
        ficam = urls.filter(u => !t.sai.includes(u))
      }
      if (!t.entra.length && !t.sai.length) { out.rendas.push(t); continue }
      const para = [...ficam, ...t.entra]
      const kinds: Record<string, ReceiptKind> = {}
      for (const u of para) if (k[u]) kinds[u] = k[u]
      for (const u of t.entra) kinds[u] = 'REGIONS_ENTRY'
      if (!opcoes.gravar) { t.motivo = t.motivo || 'TRAVESSIA_PAUSADA — só contado'; out.rendas.push(t); tudoCerto = false; continue }
      const antes = c.receipt_url ?? null
      const novo = gravarRecibo(para)
      const q: any = us.from('invoice_incomes').update({ receipt_url: novo, receipt_kinds: Object.keys(kinds).length ? kinds : null }).eq('id', c.id)
      const { data, error } = await (antes == null ? q.is('receipt_url', null) : q.eq('receipt_url', antes)).select('id')
      if (error) throw new Error(`trocar comprovante da renda ${c.id}: ${error.message}`)
      if (data?.length !== 1) { t.motivo = 'o comprovante mudou desde a leitura — a próxima rodada refaz'; out.rendas.push(t); tudoCerto = false; continue }
      t.gravado = true
      const rotulo = `${rem.code} · ${t.sai.length ? 'remessa inteira na Regions: o PIX do BR sai do US (fica no espelho do BR), entra o comprovante da Regions' : 'pedaço da remessa chegou à Regions: o comprovante entra; o PIX do BR fica provisório'} (Márcio 17/10/2026)`
      const { error: eT } = await us.from('data_fixes').insert([
        { check_key: TRILHA_COMPROVANTE, table_name: 'invoice_incomes', row_id: String(c.id), field: 'receipt_url', old_value: antes, new_value: novo, label: rotulo.slice(0, 500) },
        { check_key: TRILHA_COMPROVANTE, table_name: 'invoice_incomes', row_id: String(c.id), field: 'receipt_kinds', old_value: c.receipt_kinds == null ? null : JSON.stringify(c.receipt_kinds), new_value: JSON.stringify(kinds), label: rotulo.slice(0, 500) },
      ])
      if (eT) throw new Error(`a troca da renda ${c.id} gravou, mas a trilha em data_fixes falhou: ${eT.message}`)
      out.rendas.push(t)
    }

    if (tudoCerto) {
      const { data, error } = await us.from('remittances').update({ completed_at: new Date().toISOString() }).eq('id', rem.id).is('completed_at', null).select('id')
      if (error) throw new Error(`fechar a remessa ${rem.code}: ${error.message}`)
      if (data?.length === 1) {
        out.concluidas.push(rem.code)
        const { error: eT } = await us.from('data_fixes').insert([{ check_key: TRILHA_COMPROVANTE, table_name: 'remittances', row_id: String(rem.id), field: 'completed_at', old_value: null, new_value: 'concluída', label: `${rem.code} · chegou inteira na Regions (US$ ${rem.amount_usd}); comprovantes das rendas cobertas trocados` }])
        if (eT) throw new Error(`a remessa ${rem.code} fechou, mas a trilha em data_fixes falhou: ${eT.message}`)
      }
    }
  }
  return out
}
