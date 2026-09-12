// MARCAR É NOTIFICAR (10/set/2026).
//
//   "pergunte pro kaue MARCANDO ele com o @, sempre, sempre que for falar algo
//    pra alguém, marque"  — Márcio, 10/set/2026
//
// ── O DEFEITO QUE ISTO FECHA ───────────────────────────────────────────────
// `@14073645198` dentro do texto é só TEXTO: o WhatsApp não notifica ninguém.
// A menção de verdade viaja num campo à parte — na UltraMsg, `mentions`, com os
// números separados por vírgula, junto com o `@numero` no corpo
// (blog.ultramsg.com/create-mention-in-group-using-whatsapp-api).
//
// Medido pela sessão do AutoBook em 10/set: TODA mensagem que saiu pela rota do
// app tem `mentioned_ids` NULO no espelho `whatsapp_messages` (24/08, 26/08 e
// 10/09), enquanto as marcações feitas à mão no celular chegam com o campo
// preenchido. Ou seja: a ordem dele nunca foi cumprida pelo app, e ninguém viu,
// porque a mensagem chega bonita — só não acende para quem devia responder.
//
// ── POR QUE DERIVAR DO CORPO, EM VEZ DE PEDIR O CAMPO ──────────────────────
// Quem escreve a mensagem já digita `@numero`. Exigir um segundo campo é confiar
// na memória de cada chamador — e são mais de dez lugares que mandam WhatsApp
// neste app. Derivando aqui, a lei vale para report, duty, aviso e para o que
// ainda vai nascer, sem ninguém precisar lembrar.
//
// ── AS TRÊS TRAVAS ─────────────────────────────────────────────────────────
//   • Só GRUPO. Em conversa de um pra um o WhatsApp já notifica, e mandar campo
//     onde ele não é esperado é risco sem ganho.
//   • Só número de telefone: 8 a 15 dígitos. `@aqui`, `@todos`, e-mail e preço
//     não viram menção.
//   • Sem repetido e no máximo 32 — texto colado com números não vira spam.
//
// Quem envia continua responsável por uma coisa: a menção é BÔNUS, entregar é
// obrigação. Se a UltraMsg recusar o envio com o campo, o chamador reenvia sem
// ele (é o que a rota /api/whatsapp faz).
export function mencoesDoTexto(texto: string, destino: string): string {
  const para = String(destino || '').trim()
  if (!/@g\.us$/i.test(para)) return ''
  const achados = String(texto || '').match(/@(\d{8,15})(?!\d)/g) || []
  const numeros = [...new Set(achados.map(a => a.slice(1)))].slice(0, 32)
  return numeros.join(',')
}

// ── TEXTO DE FORA NÃO ESCOLHE QUEM O APP MARCA (11/set/2026) ───────────────
// A menção sai do CORPO — e vários avisos deste app carregam texto de terceiro:
// remetente e assunto crus de qualquer e-mail que chegue, o memo livre de quem
// manda o Zelle, a resposta que alguém digita no grupo da fila. Sem esta peneira,
// um `no-reply@123456789.mailer.com` ou um assunto "boleto @202609110001" bastaria
// para um e-mail de fora decidir quem o app marca num grupo interno.
//
// Quem escreve o MOLDE da mensagem continua podendo marcar à vontade; o que passa
// por aqui é só o pedaço que veio de fora. A quebra é mínima e legível — um espaço
// entre o "@" e os dígitos, que é o bastante para o `@numero` virar texto de novo:
// "no-reply@ 123456789.mailer.com". Nada de caractere invisível, que some no
// print e assombra depois.
//
// Medido em 11/set/2026 (só leitura): 0 de 1.000 pares assunto+remetente em
// stream_mail_moves e 0 de 220 descrições de invoice_incomes (é lá que o memo do
// Zelle é gravado) casariam com o padrão. Risco real, frequência medida ZERO — a
// peneira existe para que continue assim quando o volume mudar.
export function semMarcacao(texto: unknown): string {
  return String(texto ?? '').replace(/@(?=\d{8,15}(?!\d))/g, '@ ')
}
