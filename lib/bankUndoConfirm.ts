// CLIENTE — «CONFIRM FIRST» do DESFAZER do Bank Link (Márcio, 04/10/2026; lei «nunca apagar despesa sem perguntar»).
// As rotas que desfazem um casamento respondem 409 `needs_confirm` com a lista dos lançamentos que o Bank Link criou
// e que o DESFAZER apagaria (lib/bankUndoGate.server.ts). Aqui a tela mostra a lista e, com o sim, repete o pedido
// com `confirm_delete`. Sem o sim, NADA foi escrito.
type WillDelete = { key: string; table: string; label: string; amount: number | null; where: string | null }
type NeedsConfirm = { needs_confirm?: boolean; will_delete?: WillDelete[]; will_delete_count?: number; will_delete_total?: number; will_delete_groups?: { where: string; count: number; total: number }[]; confirm_delete?: unknown }

const usd = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function textoDoQueApaga(d: NeedsConfirm): string {
  const list = d.will_delete || []
  const n = d.will_delete_count ?? list.length
  const linhas = list.slice(0, 15).map(v => `• ${v.amount != null ? usd(v.amount) + ' — ' : ''}${v.label}${v.where ? '  [' + v.where + ']' : ''}`)
  if (n > linhas.length) {
    // Lista longa: as primeiras linhas + TODAS as linhas contadas por destino (onde · quantas · quanto).
    linhas.push(`… e mais ${n - linhas.length}`, '', 'TUDO o que sai, por destino:')
    for (const g of (d.will_delete_groups || []).slice(0, 25)) linhas.push(`• ${g.where}: ${g.count} lançamento(s) — ${usd(g.total)}`)
    if ((d.will_delete_groups || []).length > 25) linhas.push(`• … e mais ${(d.will_delete_groups || []).length - 25} destino(s)`)
  }
  return [
    `DESFAZER vai APAGAR ${n} lançamento(s) criado(s) pelo Bank Link${d.will_delete_total ? ' — ' + usd(d.will_delete_total) + ' no total' : ''}:`,
    '',
    ...linhas,
    '',
    'Lançamento digitado por gente NÃO é apagado (só é solto).',
    'OK = apagar e desfazer · Cancelar = não mexe em nada',
  ].join('\n')
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// POST que pergunta antes de apagar. `cancelled: true` = a pessoa disse não (nada foi escrito).
export async function postComConfirmacao(url: string, headers: HeadersInit, body: Record<string, unknown>): Promise<{ r: Response; d: any; cancelled: boolean; confirmed: unknown }> {
  let r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  let d = await r.json().catch(() => ({}))
  let confirmed: unknown = undefined
  // Até 2 perguntas: se a lista mudou entre a pergunta e o sim, a rota manda a lista nova e a tela pergunta de novo.
  for (let i = 0; i < 2 && r.status === 409 && d && d.needs_confirm; i++) {
    if (!window.confirm(textoDoQueApaga(d))) return { r, d, cancelled: true, confirmed: undefined }
    confirmed = d.confirm_delete
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, confirm_delete: confirmed }) })
    d = await r.json().catch(() => ({}))
  }
  return { r, d, cancelled: false, confirmed }
}
