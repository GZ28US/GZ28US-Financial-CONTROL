import { BASE_PATH } from '@/lib/utils'
import { sessionHeaders } from '@/lib/sessionHeaders'

// One-way mirror of supplier activity from the US app into the GZ28BR project's
// SEPARATE suppliers table. The two suppliers tables stay independent; this just
// makes sure every supplier touched in the US app also exists (and stays current)
// in BR.
//
// Matched by NAME, because the US and BR rows have independent ids. Every call is
// best-effort and non-blocking — wrap with `void` at the call site so a BR hiccup
// never breaks the US write. Re-runnable: the standalone backfill reconciles
// anything a transient failure missed.
//
// A ESCRITA MORA NO SERVIDOR (11/set/2026): /api/br-mirror/suppliers, com a chave
// de serviço do BR. Até aqui este arquivo escrevia pelo cliente `supabaseBR` anon
// do navegador — a ponte respondia 503, o RLS do BR devolvia [] mudo e nenhum
// fornecedor chegou ao BR por este caminho. A GUARDA DO FORNECEDOR (carro nunca
// vira linha em suppliers, 30/ago/2026) também foi junto: o servidor lê os carros
// dos DOIS bancos e aplica supplierNameForRegistry antes de gravar.
//
// Quem chama continua com `void`: a falha não trava a tela, mas também não some —
// vai para o console com a causa que o servidor devolveu.

async function espelhar(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${BASE_PATH}/api/br-mirror/suppliers`, {
      method: 'POST', headers: await sessionHeaders(), body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      console.error(`[espelho de fornecedores → BR] ${String(body.action)} falhou:`, data?.error || `HTTP ${res.status}`)
    } else if (data.parcial) {
      console.warn('[espelho de fornecedores → BR] gravado só com os campos básicos — o BR ainda não tem as colunas de paridade:', data.parcial)
    }
  } catch (e) {
    console.error('[espelho de fornecedores → BR] sem resposta do servidor do app:', e)
  }
}

// Insert or update a BR supplier by name with the given fields. Pass `prevName`
// from an edit so a rename relocates the BR row instead of orphaning it.
export async function mirrorUpsertSupplier(row: Record<string, unknown>, prevName?: string) {
  if (!String(row?.name || '').trim()) return
  await espelhar({ action: 'upsert', row, prevName: prevName ?? null })
}

// Ensure a BR supplier with this name exists (the name-only auto-add that
// goods/inputs do). Never overwrites an existing BR row's other fields.
export async function mirrorEnsureSupplier(name: string) {
  if (!String(name || '').trim()) return
  await espelhar({ action: 'ensure', name })
}

// Mirror a US supplier delete.
export async function mirrorDeleteSupplier(name: string) {
  const n = String(name || '').trim()
  if (!n) return
  await espelhar({ action: 'delete', name: n })
}
