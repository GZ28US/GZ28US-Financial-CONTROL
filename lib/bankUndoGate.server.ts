// SERVER-ONLY — «CONFIRM FIRST» do DESFAZER do Bank Link (Márcio, 04/10/2026; lei «nunca apagar despesa sem perguntar»).
// O DESFAZER de um casamento apaga os lançamentos que o próprio Bank Link criou para ele. As rotas que desfazem
// (/api/bank/reconcile: unmatch, rematch, undo_batch · /api/data-check/auto: undo) chamam a prévia
// (previewUnmatchDeletes), e se houver o que apagar e a tela ainda não tiver mandado o «sim», respondem com isto:
// 409 + a lista. A tela mostra item / valor / onde, a pessoa confirma e o pedido volta com `confirm_delete`.
import { NextResponse } from 'next/server'
import type { UnmatchVictim } from '@/lib/bankReconcile.server'

// O «sim» de UMA linha é a própria lista (as chaves tabela:id, em ordem): se o que seria apagado mudou entre a
// pergunta e o sim, a lista não bate e a rota pergunta de novo. O «sim» do DESFAZER LOTE é `true`.
export const chavesDe = (victims: UnmatchVictim[]): string[] => victims.map(v => v.key).sort()
export const mesmaLista = (sent: unknown, victims: UnmatchVictim[]): boolean =>
  Array.isArray(sent) && sent.length === victims.length && sent.map(String).sort().join('|') === chavesDe(victims).join('|')

const grupos = (victims: UnmatchVictim[]) => {
  const m = new Map<string, { where: string; count: number; total: number }>()
  for (const v of victims) { const k = (v.where || v.table).replace(/ · .*$/, ''); const g = m.get(k) || { where: k, count: 0, total: 0 }; g.count++; g.total += v.amount || 0; m.set(k, g) }
  return [...m.values()].map(g => ({ ...g, total: Math.round(g.total * 100) / 100 })).sort((a, b) => b.count - a.count).slice(0, 60)
}

// `acao`/`nota`: o DESATRIBUIR usa o mesmo portão com o nome dele e a nota de que o dinheiro volta pro balde.
export function pedeConfirmacao(victims: UnmatchVictim[], confirm: true | string[], extra: { acao?: string; nota?: string } = {}) {
  const total = Math.round(victims.reduce((s, v) => s + (v.amount || 0), 0) * 100) / 100
  return NextResponse.json({
    error: `CONFIRMAR — o ${extra.acao || 'DESFAZER'} apaga ${victims.length} lançamento(s) criado(s) pelo Bank Link`,
    action_label: extra.acao || 'DESFAZER', note: extra.nota || null,
    needs_confirm: true,
    will_delete: victims.slice(0, 40), will_delete_count: victims.length, will_delete_total: total,
    // Lista longa (DESFAZER LOTE tem centenas): TODA linha entra na conta por destino — nada sai sem aparecer ao menos aqui.
    will_delete_groups: grupos(victims),
    confirm_delete: confirm,
  }, { status: 409 })
}
