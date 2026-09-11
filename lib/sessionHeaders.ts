// Cabeçalhos de quem chama rota protegida a partir de uma TELA logada: o JWT do
// Supabase vai no Authorization, e a rota confere com `requireUser`
// (lib/apiAuth.server.ts). Morava dentro de components/BankReconcileCard.tsx;
// aqui é o lugar comum de toda tela.
import { supabase } from '@/lib/supabase'

export async function sessionHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }
}
