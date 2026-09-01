// SERVER-ONLY — A LEI DO "NUNCA MANDE PRA MIM MESMO" (31/ago/2026).
//
// A UltraMsg NÃO entrega mensagem endereçada ao número da própria instância.
// Ela aceita a chamada, responde `sent: true`, e joga no balde `unsent` — sem
// erro, sem log, sem exceção. O envio morre calado.
//
// Custou caro descobrir: 26 avisos pessoais sumiram assim (20 FILA DE COMPRAS,
// 4 COMPRA TEMU, 1 VIP MAIL, 1 ZELLE ENVIADO e o alerta do MAIL WATCH da
// resposta da Luma sobre a internet do apartamento). Ninguém percebeu porque a
// API mentia dizendo que tinha enviado.
//
// Ordem do Márcio: "se mandar msg pro meu próprio número é ruim, bane esta
// função do app, nunca msg pra mim mesmo". Então não é convenção, é trava: todo
// caminho de envio passa por aqui e um destino self é RECUSADO, não "tentado".
//
// Aviso que era "pra ele" vai pro grupo REPORTS — é lá que ele lê.

/** Números das duas instâncias. Mandar pra eles = mandar pra si mesmo. */
export const WA_SELF_NUMBERS = ['13213150973', '5511981215678'] as const

/** Onde vai o aviso que antes ia "pro cel dele". */
export const WA_REPORTS_US = '120363425950692194@g.us'

/** Só os dígitos, pra comparar '1321...@c.us', '+1 321...' e '1321...' igual. */
function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '')
}

/** true se o destino é o número de uma das instâncias (ou seja: nós mesmos). */
export function isWaSelf(to: unknown): boolean {
  const d = digits(to)
  if (!d) return false
  return WA_SELF_NUMBERS.some(self => d === self)
}

/**
 * Trava de envio. Devolve o motivo da recusa, ou null quando o destino é válido.
 * Quem envia deve ABORTAR quando vier motivo — nunca seguir e torcer.
 */
export function waSelfBlockReason(to: unknown): string | null {
  if (!isWaSelf(to)) return null
  return `destino ${String(to)} é o número da própria instância — a UltraMsg descarta em silêncio. Mande pro grupo REPORTS (${WA_REPORTS_US}).`
}

/**
 * Versão pra quem manda alerta interno: devolve o destino que deve ser usado.
 * Se pediram self, redireciona pro REPORTS e avisa no log — o aviso é importante
 * demais pra simplesmente sumir.
 */
export function waSafeTarget(to: string): string {
  if (!isWaSelf(to)) return to
  console.warn(`[wa-self-guard] destino ${to} é a própria instância; redirecionando pro grupo REPORTS`)
  return WA_REPORTS_US
}
