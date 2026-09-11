import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { rememberCars, supplierNameForRegistry } from '@/lib/supplierGuard'

// ESPELHO DE FORNECEDORES US → BR, NO SERVIDOR (11/set/2026).
//
// One-way mirror of supplier activity from the US app into the GZ28BR project's
// SEPARATE suppliers table. The two suppliers tables stay independent; this just
// makes sure every supplier touched in the US app also exists (and stays current)
// in BR. Matched by NAME, because the US and BR rows have independent ids.
//
// Até 11/set isto rodava no navegador pelo cliente `supabaseBR`, que era anon puro
// (a ponte /api/br-bridge respondia 503) — e o RLS do BR devolvia [] mudo: nenhum
// fornecedor chegou ao BR por este caminho, sem uma palavra. Agora a escrita é do
// servidor, com a chave de serviço do BR, e TODA falha volta como erro.
//
// Corpo: { action: 'upsert', row, prevName? } | { action: 'ensure', name } | { action: 'delete', name }

export const dynamic = 'force-dynamic'

// Columns always present on BR's suppliers table.
const CORE = ['name', 'discount', 'discount_type', 'aliases'] as const
// Extra columns that exist only after MIGRATION_suppliers_parity.sql has been run
// in the BR project. If they're not there yet, the write falls back to CORE.
// `is_dealership` is deliberately NOT mirrored: dealership agreements belong to
// one shop only (US or BR) and must never propagate across projects.
const EXTRA = ['account_number', 'website', 'instagram', 'seller', 'phone', 'email', 'ordering_method', 'discount_code'] as const

function pick(row: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k]
  return out
}

const falha = (status: number, kind: string, error: string) => NextResponse.json({ ok: false, kind, error }, { status })

export async function POST(req: NextRequest) {
  if (!(await requireUser(req))) return falha(401, 'auth', 'Sessão do app ausente ou vencida — entre de novo.')
  const br = supabaseBRService()
  if (!br) return falha(503, 'service-key', 'SUPABASE_BR_SERVICE_ROLE_KEY não está no ambiente do servidor do US — o espelho de fornecedores no BR não pode ser gravado.')

  const b = await req.json().catch(() => ({}))
  const action = String(b?.action || '')

  // Mirror a US supplier delete.
  if (action === 'delete') {
    const n = String(b?.name || '').trim()
    if (!n) return NextResponse.json({ ok: true, result: 'sem nome — nada a apagar' })
    const { error } = await br.from('suppliers').delete().eq('name', n)
    if (error) return falha(502, 'db', `Falha ao apagar o fornecedor "${n}" no BR: ${error.message}`)
    return NextResponse.json({ ok: true, result: 'apagado' })
  }
  if (action !== 'upsert' && action !== 'ensure') return falha(400, 'bad-request', 'action deve ser upsert, ensure ou delete.')

  // GUARDA DO FORNECEDOR (30/ago/2026): o espelho é um caminho de CADASTRO
  // como qualquer outro — um carro barrado no US não pode entrar no BR pela
  // porta dos fundos. E aqui a guarda tem de conhecer os carros DOS DOIS
  // bancos: o destino é a tabela suppliers do BR, e foi exatamente lá que
  // "Dodge Charger Presidiário" (ride que existe nos dois) foi parar.
  // Leitura FRESCA e CONFERIDA a cada chamada: guarda que não conseguiu ler os
  // carros não grava fornecedor — "não li" vira erro, não guarda enfraquecida.
  const usUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const usKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!usUrl || !usKey) return falha(503, 'service-key', 'SUPABASE_SERVICE_ROLE_KEY não está no ambiente do servidor do US — a guarda não consegue ler os carros do US.')
  const us = createClient(usUrl, usKey, { auth: { persistSession: false } })
  const [usCars, brCars] = await Promise.all([
    us.from('rides').select('project_name, brand, model'),
    br.from('rides').select('project_name, brand, model'),
  ])
  if (usCars.error) return falha(502, 'db', 'Falha ao ler os carros do US para a guarda do fornecedor: ' + usCars.error.message)
  if (brCars.error) return falha(502, 'db', 'Falha ao ler os carros do BR para a guarda do fornecedor: ' + brCars.error.message)
  rememberCars(usCars.data)
  rememberCars(brCars.data)

  // Ensure a BR supplier with this name exists (the name-only auto-add that
  // goods/inputs do). Never overwrites an existing BR row's other fields.
  if (action === 'ensure') {
    // Carro não vira linha em suppliers, nem no banco US nem no espelho BR —
    // pelo código OU pelo nome comercial.
    const n = supplierNameForRegistry(typeof b?.name === 'string' ? b.name : '')
    if (!n) return NextResponse.json({ ok: true, result: 'vazio ou carro — não entra no cadastro' })
    const { data, error } = await br.from('suppliers').select('id').eq('name', n).limit(1)
    if (error) return falha(502, 'db', `Falha ao procurar o fornecedor "${n}" no BR: ${error.message}`)
    if (data?.length) return NextResponse.json({ ok: true, result: 'já existe' })
    const { error: eIns } = await br.from('suppliers').insert([{ name: n }])
    if (eIns) return falha(502, 'db', `Falha ao criar o fornecedor "${n}" no BR: ${eIns.message}`)
    return NextResponse.json({ ok: true, result: 'criado' })
  }

  // Insert or update a BR supplier by name with the given fields. `prevName` from
  // an edit relocates the BR row instead of orphaning it. Writes the full field set;
  // if BR is missing the parity columns, retries with just the core fields.
  const row: Record<string, unknown> = b?.row && typeof b.row === 'object' ? b.row : {}
  const name = supplierNameForRegistry(typeof row.name === 'string' ? row.name : '')
  if (!name) return NextResponse.json({ ok: true, result: 'vazio ou carro — não entra no cadastro' })
  const prev = String(b?.prevName || '').trim()

  const full = pick({ ...row, name }, [...CORE, ...EXTRA])
  const core = pick({ ...row, name }, CORE)
  const { data: found, error: eFind } = await br.from('suppliers').select('id').eq('name', name).limit(1)
  if (eFind) return falha(502, 'db', `Falha ao procurar o fornecedor "${name}" no BR: ${eFind.message}`)
  const exists = !!found?.length
  const write = (fields: Record<string, unknown>) =>
    exists
      ? br.from('suppliers').update(fields).eq('name', name)
      : br.from('suppliers').insert([fields])
  let parcial: string | null = null
  const r1 = await write(full)
  if (r1.error) {
    const r2 = await write(core)
    if (r2.error) return falha(502, 'db', `Falha ao gravar o fornecedor "${name}" no BR: ${r2.error.message} (com todos os campos: ${r1.error.message})`)
    parcial = r1.error.message // só os campos CORE entraram — o BR ainda não tem as colunas de paridade
  }
  // O nome antigo sai DEPOIS que o novo está gravado: se a gravação falhar, o BR
  // não perde o fornecedor.
  if (prev && prev !== name) {
    const { error: eDel } = await br.from('suppliers').delete().eq('name', prev)
    if (eDel) return falha(502, 'db', `"${name}" gravado no BR, mas o nome antigo "${prev}" não saiu: ${eDel.message}`)
  }
  return NextResponse.json({ ok: true, result: exists ? 'atualizado' : 'criado', parcial })
}
