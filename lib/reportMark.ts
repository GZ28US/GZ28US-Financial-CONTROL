// A TELA RESERVA ANTES DE MANDAR (16/set/2026 — lib/reportedAt.ts, «o App não reporta mais coisa que já reportou»).
// Toda tela que manda balão de gasto ou renda para o grupo chama `reservarReport` com as linhas daquele balão:
//   · antes de mandar — só manda se a reserva voltou com alguma linha (a rede de 5 minutos pode ter mandado
//     enquanto o diálogo estava aberto);
//   · e também quando a resposta é NÃO ou o diálogo é fechado — a recusa vale, e a rede não manda depois.
// A reserva grava reported_at no banco pela rota /api/report-net/mute (logada) e devolve os ids datados AGORA.
// Falha de rede devolve vazio: melhor não mandar um balão que talvez já tenha saído.
import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'
import { reportKey, type ReportKind } from '@/lib/reportedAt'

export async function reservarReport(kind: ReportKind, ids: (string | null | undefined)[]): Promise<Set<string>> {
  const keys = [...new Set(ids.filter((x): x is string => !!x))].map((id) => reportKey(kind, id))
  if (!keys.length) return new Set()
  try {
    const res = await fetch(`${BASE_PATH}/api/report-net/mute`, { method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ keys }) })
    const j = await res.json().catch(() => null)
    const claimed: string[] = Array.isArray(j?.claimed) ? j.claimed : []
    return new Set(claimed.map((k) => k.slice(k.indexOf(':') + 1)))
  } catch {
    return new Set()
  }
}

// O balão da tela carrega as linhas que ele reporta, por tabela (`marks`). Antes de mandar, a tela chama isto:
// reserva tudo (as recusadas também — NÃO é resposta, e a rede não manda depois) e devolve só os balões que
// ainda podem sair. Balão sem linha nenhuma (tela antiga, linha sem id) sai como antes.
export type ReportMarks = { kind: ReportKind; ids: string[] }[]
export async function filtrarJaReportados<R extends { report: boolean; marks?: ReportMarks }>(reports: R[] | null | undefined): Promise<{ chosen: R[]; jaSairam: number }> {
  const todas = reports || []
  const porKind = new Map<ReportKind, string[]>()
  for (const r of todas) for (const m of r.marks || []) porKind.set(m.kind, [...(porKind.get(m.kind) || []), ...m.ids])
  const reservadas = new Set<string>()
  for (const [k, ids] of porKind) for (const id of await reservarReport(k, ids)) reservadas.add(id)
  const ids = (r: R) => (r.marks || []).flatMap((m) => m.ids)
  const pode = (r: R) => !ids(r).length || ids(r).some((id) => reservadas.has(id))
  return { chosen: todas.filter((r) => r.report && pode(r)), jaSairam: todas.filter((r) => r.report && !pode(r)).length }
}
