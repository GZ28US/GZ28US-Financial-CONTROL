import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

// ── A TRAVESSIA US ⇄ BR, VISTA DO EDITOR DO US (14/set/2026) ────────────────────
// Lei do usuário (25/ago/2026), virada lei sagrada em 13/set: quando uma despesa do GZ28US é
// PAID FROM GZ28BR (ou uma renda cai PAID TO GZ28BR), o dinheiro cruzou as empresas — e isso tem que
// existir no app brasileiro, numa SHOPPING INVOICE do cliente BR.085 «GZ28 V8 SpeedShop USA LLC».
//
// ATÉ 14/SET ESTE ARQUIVO ERA O ESPELHO VELHO: mandava a invoice para app/api/br-mirror/shopping, que
// apagava e recriava os itens e o pendente da 085.N a cada save e recalculava o R$ de TODA linha pelo
// dólar do dia — por cima do que o motor da travessia grava (lib/crossing.server.ts). Aposentado.
//
// AGORA ELE SÓ CHAMA O MOTOR, para a chave desta invoice: POST /api/crossing com
// { confirm: true, invoice: { banco: 'US', id }, origem: 'editor' }. O servidor lê a chave do banco
// (o navegador só diz qual invoice), grava só o que falta — linha nova, elo, carimbo de câmbio UMA vez,
// o Pending balance — e nunca apaga nem recria linha espelhada. Vale para a invoice comum do US
// (direções 3 + 4 → 085.N) e para a 006.N aberta no US (direções 1 + 2, origem no BR).

export type TravessiaChave = { mirror_key: string; resultado: 'aplicada' | 'pulada' | 'recusada' | 'erro'; motivo: string | null; codigo: string | null; escritas: number }
export type TravessiaResumo = { banco: 'US' | 'BR'; id: string; codigo: string; moeda: 'USD' | 'BRL'; custo: number; grand: number; recebido: number; pendente: number; vencimento: string | null }
export type TravessiaResposta = {
  ok: boolean
  chave: string | null            // null = esta invoice não cruza (ou a shopping invoice não tem origem gravada)
  motivo?: string | null
  escreveu?: boolean
  resultado: { chaves: TravessiaChave[]; pausada: boolean; parou_por: string | null } | null
  resumo: TravessiaResumo | null
}

// A CAUSA DA FALHA, para a tela dizer o que houve de verdade.
export type BrMirrorFailureKind = 'auth' | 'service-key' | 'network' | 'not-found' | 'conflict' | 'rate' | 'bad-request' | 'db' | 'schema'
const KINDS: BrMirrorFailureKind[] = ['auth', 'service-key', 'network', 'not-found', 'conflict', 'rate', 'bad-request', 'db', 'schema']

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

/** Roda o motor da travessia para a chave desta invoice do US. Estoura BrMirrorError quando o servidor falha. */
export async function sincronizarTravessia(invoiceId: string): Promise<TravessiaResposta> {
  const id = String(invoiceId || '').trim()
  if (!id) throw new BrMirrorError('bad-request', 'invoiceId ausente — o motor não sabe qual invoice ler.')
  let res: Response
  try {
    res = await fetch(`${BASE_PATH}/api/crossing`, {
      method: 'POST', headers: await sessionHeaders(),
      body: JSON.stringify({ confirm: true, invoice: { banco: 'US', id }, origem: 'editor' }),
    })
  } catch (e) {
    throw new BrMirrorError('network', 'Sem resposta do servidor do app: ' + (e instanceof Error ? e.message : String(e)))
  }
  const data = await res.json().catch(() => null)
  // 502 com `resultado` = uma chave errou no meio da escrita: é resposta do motor, a tela mostra o motivo.
  if (data?.resultado && Array.isArray(data.resultado.chaves)) return data as TravessiaResposta
  if (!res.ok || !data?.ok) throw new BrMirrorError(kindFor(res.status, data?.kind, !!data), data?.error || `HTTP ${res.status}`, res.status)
  return data as TravessiaResposta
}

/** O que a tela precisa dizer depois do motor: null quando está tudo certo (gravou ou não havia nada). */
export function avisoDaTravessia(r: TravessiaResposta): string | null {
  const c = r.resultado?.chaves.find(x => x.mirror_key === r.chave) || r.resultado?.chaves[0]
  if (!c) return null
  if (c.resultado === 'erro') return `A GRAVAÇÃO PAROU no meio (${c.codigo || c.mirror_key}) — o que já foi gravado fica, e o próximo save ou o cron continuam de onde parou.\n${c.motivo || ''}`
  if (c.resultado === 'pulada' && c.motivo && !/^nada a fazer|^sem travessia/.test(c.motivo)) {
    const motivos = c.motivo.split(' · ')
    return `A travessia desta invoice está TRAVADA — nada foi gravado no outro app:\n• ${motivos.slice(0, 3).join('\n• ')}${motivos.length > 3 ? `\n(+${motivos.length - 3} motivo(s) no plano da travessia)` : ''}`
  }
  if (c.resultado === 'recusada') return `A travessia recusou a gravação: ${c.motivo || ''}`
  return null
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
    case 'schema': return `BANCO SEM AS COLUNAS DA TRAVESSIA${http}: ${detail}`
    case 'bad-request': return `PEDIDO INVÁLIDO${http}: ${detail}`
    case 'db': return `BANCO${http}: ${detail}`
    default: return detail
  }
}
