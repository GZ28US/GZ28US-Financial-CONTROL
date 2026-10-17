// O TIPO DE CADA COMPROVANTE DE UMA RENDA DO US (17/out/2026, MIGRATION_comprovante_entrada.sql).
// Márcio, 17/10: no espelho do BR, o comprovante de ENTRADA no BR; no app do US, o de entrada na REGIONS — e o do BR fica
// no US como PROVISÓRIO até o da Regions existir, quando o app troca sozinho.
//   invoice_incomes.receipt_url   = o array JSON que as telas leem (inalterado)
//   invoice_incomes.receipt_kinds = { "<url>": "NF" | "BR_ENTRY" | "REGIONS_ENTRY" } — arquivo sem tipo nunca é mexido.

export type ReceiptKind = 'NF' | 'BR_ENTRY' | 'REGIONS_ENTRY'
export const RECEIPT_KINDS: readonly ReceiptKind[] = ['NF', 'BR_ENTRY', 'REGIONS_ENTRY']

/** Um `receipt_url` pode ser texto, JSON de array, ou array — a mesma leitura de lib/papelOrfao.server.ts. */
export function urlsDoRecibo(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String).filter(Boolean) : [] } catch { /* texto puro */ } }
  return [s]
}

/** O nome do arquivo, sem pasta nem query — o mesmo PDF copiado para o storage do outro banco tem o mesmo nome. */
export const nomeDoArquivo = (url: string) => decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').toLowerCase()

export function tiposDoRecibo(v: unknown): Record<string, ReceiptKind> {
  let o: unknown = v
  if (typeof v === 'string') { try { o = JSON.parse(v) } catch { return {} } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
  const out: Record<string, ReceiptKind> = {}
  for (const [u, k] of Object.entries(o as Record<string, unknown>)) if (RECEIPT_KINDS.includes(k as ReceiptKind)) out[u] = k as ReceiptKind
  return out
}

/** As urls do receipt_url daquele tipo, na ordem em que estão. */
export function urlsDoTipo(linha: { receipt_url?: unknown; receipt_kinds?: unknown }, tipo: ReceiptKind): string[] {
  const k = tiposDoRecibo(linha.receipt_kinds)
  return urlsDoRecibo(linha.receipt_url).filter(u => k[u] === tipo)
}

/** O receipt_url como as telas gravam: null quando vazio, senão o array JSON. */
export const gravarRecibo = (urls: string[]) => urls.length ? JSON.stringify(urls) : null
