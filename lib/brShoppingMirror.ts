import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

// ── GZ28BR-paid US expenses  ->  a BR SHOPPING INVOICE (client BR.085) ─────────
// Lei do usuário (25/ago/2026): quando uma despesa de invoice de RIDE do GZ28US é
// marcada PAID FROM = GZ28BR, o GZ28BR pagou uma conta nossa — e isso tem que
// existir como SAÍDA no app brasileiro, senão o Flow dos dois apps nunca bate.
// Então, no save, o app US espelha essas linhas numa SHOPPING INVOICE do cliente
// BR.085 — "GZ28 V8 SpeedShop USA LLC" — no projeto BR:
//   • EXPENSES = as linhas que o BR pagou (a saída de caixa, em R$ + o US$ original)
//   • ITEMS    = as mesmas linhas a CUSTO PURO (0% de margem — é reembolso, não venda)
//   • INCOME   = um PENDING BALANCE do total: o que o GZ28US ainda deve ao BR
// É o espelho exato do caminho inverso (lib/usShoppingMirror.ts no app BR, que
// cria a US.006.N quando o GZ28US paga peça de carro brasileiro).
//
// A REGRA E A ESCRITA MORAM NO SERVIDOR (11/set/2026):
// app/api/br-mirror/shopping/route.ts, com a chave de serviço do BR — câmbio do dia,
// numeração 085.N, reconciliação linha a linha e a guarda do dinheiro já pago.
// Até aqui tudo isso rodava no navegador pelo cliente `supabaseBR` anon: a ponte
// respondia 503, o RLS do BR devolvia [] mudo, o erro dizia "cliente não
// encontrado" e o apagar respondia deleted:true sem apagar nada.
//
// O SERVIDOR LÊ A INVOICE DO BANCO DO US. Deste lado só viaja `usInvoiceId`: código,
// carro, serviço, o elo br_invoice_id e as despesas PAID FROM GZ28BR (com o id de
// cada linha, que alimenta o elo us_expense_id) são lidos lá. Os outros campos de
// BrMirrorInput ficam no tipo para a tela não mudar, mas não são enviados — rota que
// segura a chave do BR não obedece a id de invoice do BR vindo do navegador.

export type BrMirrorItem = {
  item: string
  supplier: string | null
  usdPrice: number             // custo UNITÁRIO em US$
  usdTax: number               // tax TOTAL da linha em US$ (como o app soma)
  usdExtra: number             // frete/extra TOTAL da linha em US$
  quantity: number
  paymentDate: string | null   // YYYY-MM-DD — o dia em que o BR pagou
  // ORDER NUMBER é SAGRADO (29/ago/2026): o pedido da loja viaja com o espelho
  // — é ele que liga a linha espelhada no BR ao STREAM da remessa.
  orderNumber?: string | null
  // O ELO DA LINHA (04/set/2026). A invoice já tinha o dela (br_invoice_id /
  // us_invoice_id); a LINHA não tinha — e sem ele o espelho apagava todas as
  // linhas do outro lado e recriava, matando rastreio, recibo, part_number,
  // picked_up e o escudo receipt_proves_payment. O servidor preenche com o id da
  // despesa do US.
  srcId?: string | null
}

export type BrMirrorInput = {
  usInvoiceId: string          // a invoice do US — é o que o servidor lê
  usInvoiceCode: string
  rideName: string             // "<project_code> — <project_name>"
  usService: string
  existingBrInvoiceId: string | null
  items: BrMirrorItem[]
}

// keptPaid: não havia mais linha PAID FROM GZ28BR, mas a shopping invoice do BR
// FICOU porque o GZ28US já pagou parte dela — o elo continua (brInvoiceId).
export type BrMirrorResult = { brInvoiceId: string | null; code: string | null; totalBrl: number; totalUsd: number; deleted: boolean; keptPaid?: boolean }

// A CAUSA DA FALHA, para a tela dizer o que houve de verdade.
export type BrMirrorFailureKind = 'auth' | 'service-key' | 'network' | 'not-found' | 'conflict' | 'rate' | 'bad-request' | 'db'
const KINDS: BrMirrorFailureKind[] = ['auth', 'service-key', 'network', 'not-found', 'conflict', 'rate', 'bad-request', 'db']

export class BrMirrorError extends Error {
  kind: BrMirrorFailureKind
  status: number
  constructor(kind: BrMirrorFailureKind, message: string, status = 0) {
    super(message)
    this.name = 'BrMirrorError'
    this.kind = kind
    this.status = status
  }
}

function kindFor(status: number, kind: unknown, hasJson: boolean): BrMirrorFailureKind {
  if (typeof kind === 'string' && (KINDS as string[]).includes(kind)) return kind as BrMirrorFailureKind
  if (status === 401 || status === 403) return 'auth'
  if (status === 503) return 'service-key'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'rate'
  if (status === 400) return 'bad-request'
  // Resposta sem JSON (504 da Vercel, página de erro) é o servidor que não respondeu.
  return hasJson ? 'db' : 'network'
}

export async function mirrorBrShoppingInvoice(input: BrMirrorInput): Promise<BrMirrorResult> {
  const usInvoiceId = String(input?.usInvoiceId || '').trim()
  if (!usInvoiceId) throw new BrMirrorError('bad-request', 'usInvoiceId ausente — o espelho não sabe qual invoice do US ler.')
  let res: Response
  try {
    res = await fetch(`${BASE_PATH}/api/br-mirror/shopping`, {
      method: 'POST', headers: await sessionHeaders(), body: JSON.stringify({ usInvoiceId }),
    })
  } catch (e) {
    throw new BrMirrorError('network', 'Sem resposta do servidor do app: ' + (e instanceof Error ? e.message : String(e)))
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) {
    throw new BrMirrorError(kindFor(res.status, data?.kind, !!data), data?.error || `HTTP ${res.status}`, res.status)
  }
  return {
    brInvoiceId: data.brInvoiceId ?? null,
    code: data.code ?? null,
    totalBrl: Number(data.totalBrl) || 0,
    totalUsd: Number(data.totalUsd) || 0,
    deleted: !!data.deleted,
    keptPaid: !!data.keptPaid,
  }
}

// O texto do alerta: a causa primeiro, o detalhe do servidor depois.
export function brMirrorFailureCause(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  const kind = err instanceof BrMirrorError ? err.kind : null
  const http = err instanceof BrMirrorError && err.status ? ` (HTTP ${err.status})` : ''
  switch (kind) {
    case 'auth': return `SESSÃO${http}: o login do app venceu ou não foi enviado. Entre de novo e salve.\n${detail}`
    case 'service-key': return `CHAVE${http}: o servidor do US está sem a chave de serviço necessária.\n${detail}`
    case 'network': return `REDE${http}: o servidor do app não respondeu.\n${detail}`
    case 'not-found': return `NÃO ENCONTRADO${http}: ${detail}`
    case 'rate': return `CÂMBIO${http}: ${detail}`
    case 'conflict': return `CONFLITO${http}: ${detail}`
    case 'bad-request': return `PEDIDO INVÁLIDO${http}: ${detail}`
    case 'db': return `BANCO${http}: ${detail}`
    default: return detail
  }
}
