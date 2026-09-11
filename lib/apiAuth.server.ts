// PORTÃO ÚNICO DAS ROTAS DE API (11/set/2026).
//
// A auditoria de 11/set achou rotas que mandavam WhatsApp, rodavam robôs e ligavam
// caixas de e-mail para QUALQUER pedido anônimo — e outras que conferiam a chave no
// padrão `if (need && key !== need)`, que ABRE sozinho quando a variável some do
// ambiente. Cada rota escrevia a sua checagem, e algumas erravam. Aqui fica a
// checagem única, e toda comparação FALHA FECHADA: variável ausente = ninguém entra.
//
// Quatro jeitos de entrar, um para cada tipo de chamador:
//   requireUser → tela do app com admin logado (JWT do Supabase no Authorization)
//   cronOk      → a própria Vercel chamando o cron (Authorization: Bearer CRON_SECRET)
//   readKeyOk   → sessões e scripts que LEEM (header x-read-key)
//   sendKeyOk   → servidor ou script que MANDA mensagem (header x-send-key)
//
// Chave na URL (`?key=`) grava o segredo em todo log de acesso — medido no log da
// Vercel em 11/set. Só vale onde a rota pede `allowQuery`: quem chama não tem como
// mandar header (webhook da UltraMsg, atalho do iPhone) ou ainda está na transição.
import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth.server'

export { requireUser }

function mesmoSegredo(recebido: string | null | undefined, esperado: string | undefined): boolean {
  if (!esperado || !recebido) return false
  const a = Buffer.from(recebido)
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A própria Vercel chamando o cron: `Authorization: Bearer CRON_SECRET`. */
export function cronOk(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET
  return !!s && mesmoSegredo(req.headers.get('authorization'), `Bearer ${s}`)
}

/**
 * Chave de LEITURA (`WHATSAPP_READ_KEY`) no header `x-read-key` (o antigo `x-wa-key` também vale).
 * `allowQuery` aceita `?key=` e `bodyKey` aceita a chave vinda no JSON — só onde a rota já recebia assim.
 */
export function readKeyOk(req: NextRequest, opts: { allowQuery?: boolean; bodyKey?: unknown } = {}): boolean {
  const need = process.env.WHATSAPP_READ_KEY
  if (mesmoSegredo(req.headers.get('x-read-key') || req.headers.get('x-wa-key'), need)) return true
  if (opts.allowQuery && mesmoSegredo(req.nextUrl.searchParams.get('key'), need)) return true
  if (typeof opts.bodyKey === 'string' && mesmoSegredo(opts.bodyKey, need)) return true
  return false
}

/**
 * A chave que MANDA mensagem. Enquanto `WHATSAPP_SEND_KEY` não existir no ambiente, vale a de leitura;
 * quando a variável entrar (o mesmo valor nos dois projetos), a de leitura para de mandar sem mexer em código.
 */
export function sendKeyValue(): string | undefined {
  return process.env.WHATSAPP_SEND_KEY || process.env.WHATSAPP_READ_KEY
}

/** A chave para mandar pela rota do app BR (repasse da tela /whatsapp). */
export function brSendKeyValue(): string | undefined {
  return process.env.GZ28BR_SEND_KEY || sendKeyValue()
}

/** Servidor ou script mandando mensagem: header `x-send-key`. */
export function sendKeyOk(req: NextRequest): boolean {
  return mesmoSegredo(req.headers.get('x-send-key'), sendKeyValue())
}
