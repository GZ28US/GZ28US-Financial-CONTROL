// REMETENTE PROTEGIDO — UM LUGAR SÓ.
//
// A lista de quem NUNCA pode ser apagado ou mandado pra lixeira por robô estava
// escrita em três arquivos (VIP_FROM e DESPACHANTE_FROM no inboxZero, SAFE_SENDER
// no streamMail) e nenhum deles cobria o marketing-kill. Lista repetida é lista
// que um robô novo esquece — e em 08/set/2026 uma resposta do despachante da
// frota apareceu nos Itens Excluídos pela SEGUNDA vez (a primeira, em 30/jul,
// levou a cotação da RAMbo, um documento com preço).
//
// Módulo PURO de propósito: sem cliente Supabase, sem fetch. Assim qualquer
// robô — servidor, cron ou tela — pode importar sem arrastar dependência, e não
// há desculpa para não chamar.
//
// A REGRA: correspondência de GENTE não se apaga sozinha. Loja, transportadora e
// banco podem cair na faxina; despachante, advogado, seguradora, contraparte de
// negociação e pedido de assinatura, nunca.

// Correspondência de contraparte ATIVA — as mesmas caras que disparam o VIP MAIL
// ALERT. Quem merece um aviso no WhatsApp não pode ser varrido em silêncio.
//
// STRIPE É `@stripe\.com`, NÃO `stripe\.com` (11/set/2026). Solto, o padrão pegava
// junto o subdomínio de PROPAGANDA `e.stripe.com` — e `updates@e.stripe.com` é um
// dos 65 remetentes que ELE curou em `marketing_senders` para o matador apagar (3
// mortes registradas no gz28us@gmail: 21/08 13:20, 31/08 11:25 e 08/09 11:35). Com
// a trava única entrando também no ramo Gmail, a proteção venceria a curadoria e a
// propaganda ficaria IMORTAL na caixa: a busca é `in:inbox`, o e-mail não sai, o
// cron passa de 5 em 5 minutos e cada passada somaria um bloqueio — a doença que
// deu 1.418 bloqueios no radiumauto e 8.308 no pagoufacil. Medido em 11/set às
// 21:28 de Orlando (REST, só leitura): dos 65 ativos, `updates@e.stripe.com` era o
// ÚNICO a bater nesta lista, e o que chega de verdade da Stripe —
// `notifications@stripe.com`, visto em `mail_processed` — continua protegido pelo
// padrão estreito. O aviso de VIP no WhatsApp não muda: ele tem a lista dele
// (`VIP_FROM` em lib/inboxZero.server.ts) e segue avisando do jeito que avisava.
const VIP = /celinak|@sema\.org|performanceracing\.com|kooksheaders|guerra\.law|kravitz|montway\.com|autotagsandtitle|venterraliving|esusu\.org|treperformance|titanmotorsports|@stripe\.com|refunds@united|highhorseperformance\.com|kramerautoplex\.com|joesal67@gmail\.com/i

// Despachante da frota (Auto Tags & Title Central): o thread carrega invoice,
// recibo de DMV e acerto de crédito. Já é o caso de duas perdas.
const DESPACHANTE = /autotagsandtitle/i

// Advogados de imigração (caso 03/ago: o pacote ASSINATURA FORMULÁRIOS do O-1A
// foi varrido da caixa).
const ADVOGADOS = /guerra\.law|kravitz/i

// Pedido de assinatura eletrônica: ele PRECISA ver e assinar (lei de 30/jul).
const ESIGN_FROM = /echosign|adobesign|docusign|hellosign|sign\.dropbox|pandadoc|esign@/i
const ESIGN_SUBJ = /signature requested|review and sign|aguarda(ndo)? sua assinatura|assinatura pendente/i

/**
 * Esta mensagem pode ser apagada/movida por um robô?
 *
 * Chamar SEMPRE imediatamente antes do move/delete — não na triagem, não no
 * começo do laço: o que protege é a checagem colada na ação, porque é ela que
 * sobrevive a refatoração. Devolve o motivo quando barra, para o log dizer por
 * que a mensagem ficou.
 */
export function protectedSender(addr: string, subject = ''): string | null {
  const a = String(addr || '')
  const s = String(subject || '')
  if (DESPACHANTE.test(a)) return 'despachante da frota'
  if (ADVOGADOS.test(a)) return 'advogados'
  if (ESIGN_FROM.test(a) || ESIGN_SUBJ.test(s)) return 'assinatura eletrônica'
  if (VIP.test(a)) return 'contraparte ativa (VIP)'
  return null
}

/** Açúcar para o caso comum: `if (!mayDelete(addr, subj)) continue`. */
export function mayDelete(addr: string, subject = ''): boolean {
  return protectedSender(addr, subject) === null
}
