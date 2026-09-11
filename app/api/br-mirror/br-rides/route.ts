import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'

// OS RIDES DO BR, LIDOS PELO SERVIDOR (11/set/2026).
// O placar de /performance precisa do apelido dos carros BR, e o app US só guarda
// rides US. Até 11/set a tela lia pelo cliente `supabaseBR` anon — a ponte
// respondia 503 e o RLS do BR devolvia [] mudo, então todo carro BR aparecia só com
// o código. Aqui a leitura é com a chave de serviço: lista vazia significa que o
// código não existe no BR, e leitura que falha volta como erro.
//
// GET ?codes=BR.492,BR.501  →  { ok, rides: [{ id, project_code, project_name }] }

export const dynamic = 'force-dynamic'

const falha = (status: number, kind: string, error: string) => NextResponse.json({ ok: false, kind, error }, { status })

export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) return falha(401, 'auth', 'Sessão do app ausente ou vencida — entre de novo.')
  const br = supabaseBRService()
  if (!br) return falha(503, 'service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o banco do BR não pode ser lido.')

  const codes = [...new Set((req.nextUrl.searchParams.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean))]
  if (!codes.length) return falha(400, 'bad-request', 'codes obrigatório (lista separada por vírgula).')
  if (codes.length > 500) return falha(400, 'bad-request', 'No máximo 500 códigos por leitura.')

  const { data, error } = await br.from('rides').select('id, project_code, project_name').in('project_code', codes)
  if (error) return falha(502, 'db', 'Falha ao ler os rides no banco do BR: ' + error.message)
  return NextResponse.json({ ok: true, rides: data || [] })
}
