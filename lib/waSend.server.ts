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
// ── O QUE ESTA FUNÇÃO NÃO FAZ ──────────────────────────────────────────────
// Não mexe no texto (assinatura, emoji e quebras são de quem escreve), não
// escolhe destino, não aplica o waSafeTarget (quem sabe se o aviso é "pra ele"
// é o chamador) e não grava `wa_send_log` — o log é da rota, que tem cliente do
// banco; aqui é biblioteca chamada de dentro dos watchers.
import { mencoesDoTexto } from '@/lib/waMentions'

export type EnvioUltra = {
  /** O critério da rota: HTTP ok E a UltraMsg dizendo que mandou. Decide o reenvio. */
  ok: boolean
  /** Só o status HTTP — é o que a maioria dos chamadores já olhava (`r.ok`). */
  httpOk: boolean
  status: number | null
  /** Corpo da resposta já em objeto (`{}` quando não é JSON). */
  data: any
  raw: string
  /** O que foi no campo `mentions` da última tentativa (vazio quando não houve, ou quando caiu no reenvio). */
  mentions: string
  /** true = a UltraMsg recusou COM o campo e o MESMO texto foi de novo sem ele. */
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
 *                    reports recorrentes faz assim, e continua fazendo)
 * @param opts.extra  campos extras da API (ex.: `priority`)
 */
export async function enviaUltra(to: string, body: string, opts: { json?: boolean; extra?: Campos } = {}): Promise<EnvioUltra> {
  const falha = (error: string): EnvioUltra => ({ ok: false, httpOk: false, status: null, data: {}, raw: '', mentions: '', retried: false, error })

  const instance = process.env.ULTRAMSG_INSTANCE
  const token = process.env.ULTRAMSG_TOKEN
  if (!instance || !token) return falha('no ultramsg env')
  const dest = String(to || '').trim()
  if (!dest) return falha('sem destino')

  // AS MESMAS TRAVAS DA ROTA: a menção sai do próprio corpo, só em GRUPO e só no
  // /messages/chat — menção em legenda de imagem ou documento não é documentada
  // pela UltraMsg, e campo onde não cabe é risco sem ganho.
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
  // causa de uma marcação, e o log diz quando isso aconteceu.
  //
  // SÓ REENVIA QUANDO A ULTRAMSG RESPONDEU RECUSANDO (`status` preenchido). Se a
  // chamada nem completou — rede caiu no meio —, não dá pra saber se a mensagem
  // chegou lá, e repetir arriscaria mandar a mesma coisa duas vezes. Nesse caso
  // fica a falha, que é o que a rota também faz.
  const primeiro = await disparar(mentions ? { ...base, mentions } : base)
  if (primeiro.ok || !mentions || primeiro.status === null) return { ...primeiro, mentions }

  console.error('[wa-send] recusado COM mentions — repetindo sem o campo', { to: dest, rawPreview: primeiro.raw.slice(0, 300) })
  const segundo = await disparar(base)
  return { ...segundo, mentions: '', retried: true }
}
