// SERVER-ONLY — UM CAMINHO SÓ ATÉ A ULTRAMSG (11/set/2026).
//
//   "Autoriza"  — Márcio, 11/set/2026, sobre marcar de verdade também nos
//                 remetentes que não passam pela rota.
//   "pergunte pro kaue MARCANDO ele com o @, sempre, sempre que for falar algo
//    pra alguém, marque"  — Márcio, 10/set/2026
//
// ── O DEFEITO QUE ISTO FECHA ───────────────────────────────────────────────
// A rota /api/whatsapp aprendeu a marcar em 10/set (lib/waMentions): `@numero`
// no corpo é só TEXTO; quem faz o WhatsApp acender o nome de quem tem que
// responder é o campo `mentions`, que viaja à parte. Prova em produção: 11/set,
// 11:40 de Orlando, grupo 120363422206851200@g.us saiu com
// `mentioned_ids = ["14073645198@c.us"]` no espelho `whatsapp_messages` — a
// mesma pergunta de 10/set, antes do conserto, tinha `null`.
//
// Só que QUINZE envios deste app não passam pela rota: duty, staff duty, zelle,
// mail watch, inbox zero, stream, respostas do grupo, staff travel, fila de
// compras, captura de compra, report da rede, boas-vindas de voo e os dois crons
// de report chamam a UltraMsg direto, cada um com o seu `fetch`. Nenhum deles
// mandava o campo — a lei valia num lugar e falhava em catorze.
//
// Medido no espelho em 11/set (só leitura, 45 dias, 14.198 mensagens nossas):
// 93 foram pra GRUPO com `@numero` no texto e 43 delas saíram SEM
// `mentioned_ids` — ninguém foi notificado. As 50 que acenderam são de depois do
// conserto da rota, ou marcação feita à mão no celular.
//
// ── POR QUE UM HELPER, E NÃO O MESMO BLOCO QUINZE VEZES ────────────────────
// Repetir as travas (só grupo · reenviar sem o campo se a UltraMsg recusar ·
// nunca perder a mensagem por causa de uma marcação) em quinze arquivos é quinze
// lugares pra errar — e o décimo sexto envio, o que nascer amanhã, já nasce
// errado. Aqui o caminho é UM: quem envia passa destino e texto pronto.
//
// ── O QUE ESTA FUNÇÃO FAZ — E O QUE ELA NÃO FAZ ────────────────────────────
// A rota /api/whatsapp tem TRÊS travas antes de disparar. Aqui há DUAS, e é
// melhor dizer isso em voz alta do que deixar o próximo envio nascer confiando
// numa terceira que não existe:
//   (a) SELF-GUARD — destino que é o número da própria instância é RECUSADO na
//       cara, igual à rota (waSelfBlockReason). A UltraMsg aceita esse envio,
//       responde `sent: true` e joga fora; 26 avisos sumiram assim em ago/2026.
//   (b) MENÇÃO — derivada do próprio corpo, só em GRUPO, com reenvio sem o campo
//       se a UltraMsg recusar.
//   (c) …e a que NÃO está aqui: `wa_send_log`. O log é da rota, que tem cliente
//       do banco; isto é biblioteca chamada de dentro dos watchers e não grava
//       linha nenhuma — nem no sucesso, nem na recusa. Quem quiser saber quantas
//       vezes um watcher tentou e falhou só tem o log de runtime da Vercel, que
//       expira. Fechar isso é o item 10(d) do pacote PAID FROM/TO, outra fatia.
// Fora as travas: não mexe no texto (assinatura, emoji e quebras são de quem
// escreve), não escolhe destino e NÃO aplica o waSafeTarget — desviar pro grupo
// REPORTS o aviso que era "pra ele" é decisão do chamador; aqui o self é recusado,
// não desviado.
//
// ── DE ONDE VEM O `@numero`: CUIDADO COM TEXTO DE FORA ─────────────────────
// A menção sai do corpo, e vários destes avisos CARREGAM texto de terceiro —
// assunto e remetente crus de e-mail, fornecedor e título escritos pela loja,
// endereço de entrega, memo de quem manda o Zelle, resposta digitada no grupo.
// Sem cuidado, um e-mail de fora escolheria quem o app marca num grupo interno.
// Por isso TODO campo de fora passa por `semMarcacao()` (lib/waMentions) ANTES de
// entrar no corpo, no arquivo de cada aviso. A conta, remetente por remetente,
// para que ninguém precise acreditar na frase:
//   PENEIRADOS (carregam texto livre de fora)
//     • VIP MAIL / INBOX ZERO — remetente e assunto do e-mail
//     • MAIL WATCH — os 3 pedaços (os 15 vigias mandam pra GRUPO, medido)
//     • ZELLE — nome de quem mandou e memo (3 avisos)
//     • APPS / SUBSCRIPTIONS — assunto e nome de app lidos do e-mail (4 avisos)
//     • FILA DE COMPRAS — fornecedor, nº do pedido, título e ENDEREÇO DE ENTREGA
//       no sino de hora em hora; o eco do destino digitado no grupo ("ERRADO ...",
//       resposta com chave) e o fornecedor ecoado na "Regra aprendida"
//     • STREAM (SHIPPED/DELIVERED) — item e fornecedor do e-mail da loja, e o nome
//       da transportadora que veio do 17TRACK
//     • REDE DE REPORTS (expenseReportNet) — item, fornecedor, nº do pedido e a
//       `description` do pagamento, que é onde o memo do Zelle é gravado; vale
//       para os 3 balões da rede e para o balão da atribuição do Bank Link
//     • IMPOSTO DE IMPORTAÇÃO (dutyWatch) — o fornecedor da remessa
//     • REPORTS RECORRENTES (cron) — `description` e `source` das duas listas
//     • DAILY MEGA-REPORT (cron/daily-report, 4h, grupo REPORTS, pelo
//       sendStreamWhatsApp) — o `item` da despesa, escrito pelo AutoBook a partir
//       do e-mail da loja, e a `description` do duty, digitada pelo funcionário na
//       página pública
//   NÃO PENEIRADOS, E POR QUÊ (não é esquecimento; é que "@numero" não cabe ali)
//     • campos de forma fixa: chave do ERRADO e da resposta ([\w.-]), waybill
//       (1Z+16 ou 10/12 dígitos), nº de fatura do carrier e nº de pedido da
//       captura ([A-Z0-9-]), nome do carrier (4 literais), e TODO o staff travel
//       (PNR [A-Z][A-Z0-9]{5}, nomes [A-Z]{2,}, aeroportos [A-Z]{3} de lista fixa,
//       voos sigla+dígitos), datas e valores formatados pelo app
//     • rótulos que o PRÓPRIO APP escreve: invoice_code, season_code, nome do
//       carro e do cliente, nome do staff, rótulo de duty, destino fixo
//       (INPUTS/…, IGNORED) — não vêm de fora, vêm da tela dele
//     • BOAS-VINDAS DE VOO e as DMs do staff duty: destino `@c.us`, e menção em
//       conversa de um pra um nem é montada (`mencoesDoTexto` exige `@g.us`)
// Medido em 11/set/2026 no banco do US (só leitura): 3.110 valores reais desses
// campos (209 linhas de part_streams — item, supplier, ship_to, order_number —,
// 1.000 de invoice_expenses e 220 descrições de invoice_incomes). SEIS contêm
// "@" e a peneira deixa os seis byte a byte iguais ("Peniel at penielusa@msn.com",
// "…0.45 kg @ USD 50/kg", "…(R$ 42.307,25 @ 5,0052)"). ZERO virariam menção hoje,
// e ZERO mudam de forma com a peneira — ou seja: o campo `mentions` não sai destes
// 16 remetentes hoje, e a peneira não estraga uma linha sequer do que já sai.
// (Dezesseis, não quinze: o DAILY MEGA-REPORT entra pelo sendStreamWhatsApp, que é
// outro caminho até o mesmo `enviaUltra` — foi o que o terceiro cético achou.)
import { mencoesDoTexto } from '@/lib/waMentions'
import { waSelfBlockReason } from '@/lib/waSelfGuard.server'

export type EnvioUltra = {
  /** O critério da rota: HTTP ok E a UltraMsg dizendo que mandou (`sent`, ou `id` sem `error`). */
  ok: boolean
  /**
   * Só o status HTTP — é o que a maioria dos chamadores já olhava (`r.ok`) e por
   * isso continua aqui: HTTP 200 com `sent:"false"` passa por true neles. Quem
   * quiser a verdade inteira olha o `ok`. (Medido em 11/set/2026 no wa_send_log:
   * 191 respostas HTTP 200, ZERO com `sent:"false"` — a diferença entre os dois
   * campos nunca apareceu em 11 dias de envio.)
   */
  httpOk: boolean
  status: number | null
  /** Corpo da resposta já em objeto (`{}` quando não é JSON — aí o cru está em `raw`). */
  data: any
  raw: string
  /** O que foi no campo `mentions` da última tentativa (vazio quando não houve, ou quando caiu no reenvio). */
  mentions: string
  /**
   * true = a UltraMsg recusou COM o campo e o MESMO texto foi de novo sem ele.
   * NINGUÉM LÊ ISTO HOJE (14 chamadores, nenhum olha) — e como aqui não há banco,
   * este campo e o console.error da Vercel são o único rastro do reenvio.
   */
  retried: boolean
  error: string | null
}

type Campos = Record<string, string | number>

/**
 * Manda uma mensagem de texto pela UltraMsg, marcando de verdade quem o corpo
 * chamar com `@numero`. Nunca lança: falha vira `{ ok: false, error }`.
 *
 * @param to      destino já em formato de chat (`...@g.us` ou `...@c.us`)
 * @param body    o texto FINAL, assinatura incluída — é dele que a menção sai
 * @param opts.json   manda o corpo como JSON em vez de formulário (só o cron de
 *                    reports recorrentes faz assim, e continua fazendo). ATENÇÃO:
 *                    a prova em produção da menção (11/set, grupo
 *                    120363422206851200@g.us) é do caminho FORMULÁRIO, que é o da
 *                    rota; em JSON o campo `mentions` é não-testado. Se a UltraMsg
 *                    ignorar o campo ali, aquele report sai sem marcar ninguém e
 *                    ninguém percebe; se recusar, cai no reenvio e o texto sai
 *                    igual. Nos dois casos a mensagem chega — o que falta é prova
 *                    de que a marcação pega nesse transporte.
 * @param opts.extra  campos extras da API (ex.: `priority`)
 */
export async function enviaUltra(to: string, body: string, opts: { json?: boolean; extra?: Campos } = {}): Promise<EnvioUltra> {
  const falha = (error: string): EnvioUltra => ({ ok: false, httpOk: false, status: null, data: {}, raw: '', mentions: '', retried: false, error })

  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return falha('no ultramsg env')
  const dest = String(to || '').trim()
  if (!dest) return falha('sem destino')

  // TRAVA (a) — "NUNCA PRA MIM MESMO" (31/ago/2026, ver lib/waSelfGuard.server.ts).
  // A UltraMsg NÃO entrega mensagem endereçada ao número da própria instância:
  // aceita a chamada, responde `sent: true` e joga no balde `unsent`. Recusar aqui
  // é o que a rota faz — melhor um erro barulhento do que outro aviso morrendo
  // calado. MEDIDO EM 11/set/2026: o telefone do staff US.002 (Márcio) no cadastro
  // É o número da instância, e app/api/staff/flight-welcome monta o destino direto
  // do cadastro (`${fone}@c.us`), sem waSafeTarget — sem esta trava, as boas-vindas
  // dele sumiriam e o app gravaria `welcome_sent_at` de uma mensagem que ninguém
  // recebeu. No wa_send_log da rota, a mesma trava já barrou 2 tentativas reais
  // (07/set/2026).
  const self = waSelfBlockReason(dest)
  if (self) {
    console.error('[wa-send] BLOQUEADO —', self)
    return falha(`self-send bloqueado: ${self}`)
  }

  // TRAVA (b) — MARCAR É NOTIFICAR: a menção sai do próprio corpo, só em GRUPO e
  // só no /messages/chat — menção em legenda de imagem ou documento não é
  // documentada pela UltraMsg, e campo onde não cabe é risco sem ganho. (Mídia nem
  // passa por aqui: quem manda imagem e documento é a rota.)
  const mentions = mencoesDoTexto(body, dest)
  const base: Campos = { token, to: dest, body, ...(opts.extra || {}) }
  const endpoint = `https://api.ultramsg.com/${instance}/messages/chat`

  const disparar = async (campos: Campos): Promise<EnvioUltra> => {
    try {
      const res = opts.json
        ? await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campos) })
        : await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(Object.entries(campos).map(([k, v]) => [k, String(v ?? '')])).toString(),
          })
      const raw = await res.text()
      let data: any = {}
      try { data = JSON.parse(raw) } catch { /* nem sempre volta JSON */ }
      // `sent: "false"` com HTTP 200 (instância fora do ar, número inválido) NÃO
      // é sucesso — mesmo critério da rota.
      const sentOk = data?.sent === 'true' || data?.sent === true
      return { ok: res.ok && (sentOk || (!!data?.id && !data?.error)), httpOk: res.ok, status: res.status, data, raw, mentions: '', retried: false, error: res.ok ? null : `ultramsg ${res.status}` }
    } catch (e) {
      return falha(String(e))
    }
  }

  // A MENÇÃO É BÔNUS; ENTREGAR É OBRIGAÇÃO (10/set/2026). O campo `mentions` está
  // no guia da UltraMsg, não na referência da API — então, se um envio COM o campo
  // for recusado, o MESMO texto vai de novo sem ele. Nenhum aviso se perde por
  // causa de uma marcação.
  //
  // DISSO NÃO FICA REGISTRO CONSULTÁVEL: aqui não há cliente de banco. O único
  // rastro é o console.error do runtime da Vercel (que expira) e o campo `retried`
  // do retorno — que nenhum dos 14 chamadores lê hoje. Se um dia a pergunta for
  // "quantas vezes a marcação foi recusada?", a resposta honesta hoje é: não dá
  // pra saber. Quem fecha isso é o wa_send_log (item 10(d) do pacote), outra fatia.
  //
  // SÓ REENVIA QUANDO A RECUSA PODE TER SIDO DO CAMPO:
  //   • chamada que nem completou (`status === null`, rede caiu no meio) NÃO
  //     repete — não dá pra saber se a mensagem chegou, e repetir arriscaria
  //     mandar a mesma coisa duas vezes (é o que a rota faz também: lá a exceção
  //     sobe e ninguém tenta de novo);
  //   • 429 e 5xx TAMBÉM NÃO repetem — aí a UltraMsg está sobrecarregada ou
  //     quebrada, não foi o campo que incomodou, e insistir na hora só dobra a
  //     chamada. Isto importa mais aqui do que na rota: lá é um clique humano por
  //     vez, aqui são watchers em cron de 5 em 5 minutos e dentro de laços.
  //   • 401 e 404 também não: 401 é token recusado e 404 é instância/rota que não
  //     existe — nenhum dos dois olha o corpo, então a segunda chamada falha
  //     igual, com certeza. Medido no wa_send_log em 11/set/2026: em 200 envios
  //     desde 31/ago houve 1×401 e 6×404, ou seja sete chamadas que teriam saído
  //     à toa. O que SOBRA repetindo (400, 403, 422 e afins) é onde um campo do
  //     corpo pode mesmo ser a causa — e aí a segunda tentativa é o que cumpre o
  //     "entregar é obrigação".
  // Medido no mesmo log: ZERO 429, ZERO 5xx e ZERO HTTP 200 com `sent:"false"` —
  // o reenvio já era raro de fato; agora é raro por regra.
  const recusaPodeSerDoCampo = (s: number | null) => s !== null && s !== 429 && s !== 401 && s !== 404 && s < 500
  const primeiro = await disparar(mentions ? { ...base, mentions } : base)
  if (primeiro.ok || !mentions || !recusaPodeSerDoCampo(primeiro.status)) return { ...primeiro, mentions }

  console.error('[wa-send] recusado COM mentions — repetindo sem o campo', { to: dest, rawPreview: primeiro.raw.slice(0, 300) })
  const segundo = await disparar(base)
  return { ...segundo, mentions: '', retried: true }
}
