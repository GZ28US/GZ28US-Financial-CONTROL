// O BANCO DO BR VISTO DO SERVIDOR — e por que precisa de chave própria.
//
// `lib/supabaseBR.ts` é cliente de NAVEGADOR: entra com a anon key e depois
// ganha uma sessão de usuário pelo bridge (`ensureBRBridgeSession`), minerada a
// partir do token do admin logado. Serve tela; não serve rota de cron, que não
// tem admin logado nenhum.
//
// ── POR QUE NÃO USAR O BRIDGE AQUI (09/set/2026) ───────────────────────────
// As credenciais do bridge (`BR_BRIDGE_EMAIL`/`BR_BRIDGE_PASSWORD`) já vivem no
// ambiente do US e dariam para logar de dentro de uma rota. Só que entrar como
// USUÁRIO significa entrar sob RLS — e quem lê para ACUSAR não pode ver menos
// do que existe.
//
// O risco é concreto e a gente acabou de viver a versão dele: a varredura de
// papel marcou 29 invoices do BR como "compra não lançada" só porque não estava
// olhando o banco certo. Com RLS escondendo linha, o mesmo erro volta — só que
// SILENCIOSO, sem os `recibos 0 · despesas 0` denunciando. Linha que o RLS
// esconde vira papel órfão, e papel órfão vira acusação.
//
// Por isso a service key. Ela não se aplica RLS, então "não achei" passa a
// significar mesmo "não existe". Ausente a variável, este módulo devolve null e
// quem chama continua dizendo INVOICE FORA DESTE BANCO — que é a verdade
// enquanto a pergunta não puder ser feita.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const BR_URL = process.env.NEXT_PUBLIC_SUPABASE_BR_URL || 'https://saaowriaptbvfoqoykrh.supabase.co'

let cliente: SupabaseClient | null | undefined

/** O banco do BR com chave de serviço, ou null quando a variável não está no ambiente. */
export function supabaseBRService(): SupabaseClient | null {
  if (cliente !== undefined) return cliente
  const key = process.env.SUPABASE_BR_SERVICE_ROLE_KEY
  cliente = key ? createClient(BR_URL, key, { auth: { persistSession: false } }) : null
  return cliente
}
