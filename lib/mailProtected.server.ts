import type { SupabaseClient } from '@supabase/supabase-js'
import { protectedSender } from './mailProtected'

// A METADE IMPURA DA TRAVA — a que deixa RASTRO.
//
// A trava de `mailProtected.ts` impede o apagamento, mas silêncio não é prova.
// A sessão Rides AutoTags mediu e mostrou o buraco: `mail_processed` só registra
// o que passa pela rota `mail-file`; robô que move direto pelo Graph dentro de
// `lib/*.server.ts` não deixa marca nenhuma. Por isso, quando a resposta do
// despachante apareceu nos Itens Excluídos, não havia linha nenhuma dizendo
// quem a pôs lá — e "não tem registro" não distinguia "nenhum robô fez" de
// "o robô fez e não anotou".
//
// Também não dá para pedir a digital ao Graph: `PR_LAST_MODIFIER_NAME` (String
// 0x3FFA) vem VAZIA em conta Outlook.com de consumidor — medido em 12 mensagens,
// inclusive nas intocadas desde 21/ago, que serviram de controle. É propriedade
// de Exchange Server. `PR_LAST_MODIFICATION_TIME` funciona, mas diz quando, não
// quem.
//
// Então o rastro tem de ser nosso. Toda vez que um robô ENCOSTA numa mensagem
// de remetente protegido, fica a linha — e aí a ausência de linha vira prova de
// que não fomos nós, em vez de indício.
//
// Grava em `mail_processed` de propósito: a tabela já é a marca d'água do que os
// robôs fazem com e-mail, e já tem account/slot/from_addr/folder/action/note.
// Campo novo para isso seria coluna duplicada — a lei proíbe.

export async function marcarProtegido(
  db: SupabaseClient,
  robo: string,
  slot: number | null,
  account: string | null,
  msg: { id?: string; subject?: string; from?: string; folder?: string },
  motivo: string,
): Promise<void> {
  try {
    await db.from('mail_processed').upsert({
      account: account || null,
      slot: slot ?? null,
      origin_message_id: msg.id || null,
      message_id: msg.id || null,
      subject: String(msg.subject || '').slice(0, 300) || null,
      from_addr: String(msg.from || '').slice(0, 200) || null,
      folder: msg.folder || null,
      // PROTECTED = o robô QUIS mexer e a trava barrou. Não é arquivamento.
      action: 'PROTECTED',
      note: `${robo}: barrado — ${motivo}`.slice(0, 300),
      processed_at: new Date().toISOString(),
    }, { onConflict: 'account,origin_message_id' })
  } catch (e) {
    // Rastro que derruba o robô é pior que rastro nenhum: a trava JÁ protegeu a
    // mensagem antes desta linha, e é ela que importa.
    console.error('[mailProtected] não consegui gravar a marca:', e)
  }
}

/**
 * Barrou? Grava e devolve o motivo. Devolve null quando pode seguir.
 * Uso: `if (await barrado(db, 'spam-sweep', slot, acct, msg)) continue`
 */
export async function barrado(
  db: SupabaseClient,
  robo: string,
  slot: number | null,
  account: string | null,
  msg: { id?: string; subject?: string; from?: string; folder?: string },
): Promise<string | null> {
  const motivo = protectedSender(msg.from || '', msg.subject || '')
  if (!motivo) return null
  console.warn(`[${robo}] protegido, não apaguei: ${motivo} — ${msg.from}`)
  await marcarProtegido(db, robo, slot, account, msg, motivo)
  return motivo
}
