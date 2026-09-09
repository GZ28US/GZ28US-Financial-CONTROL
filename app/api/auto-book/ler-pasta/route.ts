import { NextRequest, NextResponse } from 'next/server'
import { baixarDaPasta, tipoDeArquivo } from '@/lib/dropboxRead.server'
import { requireUser } from '@/lib/auth.server'

// PASSO 7 DO AUTOBOOK: LER O DOCUMENTO QUE ELE SALVOU NA PASTA.
//
// A caça (`lib/dropboxHunt.server.ts`) responde QUAL invoice desde 08/set. O que
// faltava era abrir o arquivo: o app nunca baixou nada do Dropbox — só escrevia.
// Sem isso o robô só tinha o TOTAL do e-mail, e lançar um total como preço
// único quebra `price × qty + tax + extra` e contamina o custo unitário no
// Parts DB. Com o PDF na mão ele tem a linha detalhada e o lançamento é seguro.
//
// Esta rota faz UMA coisa: baixa o arquivo e devolve as linhas que o leitor de
// recibo extraiu. NÃO lança nada — quem decide lançar é o AutoBook, que é quem
// conhece a invoice, o rateio e as regras de duplicata. Ferramenta separada de
// decisão: assim a mesma leitura serve para o robô e para conferência humana.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const cron = (req.headers.get('authorization') || '') === `Bearer ${process.env.CRON_SECRET}`
  if (!cron && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const b = await req.json().catch(() => ({}))
  const path = String(b?.path || '')
  if (!path.startsWith('/')) return NextResponse.json({ error: 'path do Dropbox obrigatório (começa com /)' }, { status: 400 })
  if (!tipoDeArquivo(path.split('/').pop() || '')) {
    return NextResponse.json({ error: 'tipo não legível: só PDF e imagem viram recibo' }, { status: 415 })
  }

  let arq
  try { arq = await baixarDaPasta(path) } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e).slice(0, 240) }, { status: 502 })
  }

  // Só baixar? Útil para conferir que o arquivo abre, sem gastar leitura.
  if (b?.apenasBaixar) return NextResponse.json({ ok: true, nome: arq.nome, mediaType: arq.mediaType, bytes: arq.bytes })

  const base = process.env.GZ28_SELF_URL || 'https://www.gz28us.com/ca'
  const r = await fetch(`${base}/api/scan-receipt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: arq.base64, mediaType: arq.mediaType, mode: b?.mode || 'purchase', separateExtras: true }),
  })
  const lido = await r.json().catch(() => null)
  if (!r.ok) return NextResponse.json({ error: `scan-receipt ${r.status}`, detalhe: String(lido?.error || '').slice(0, 200) }, { status: 502 })

  return NextResponse.json({
    ok: true,
    arquivo: { path: arq.path, nome: arq.nome, mediaType: arq.mediaType, bytes: arq.bytes },
    lido,
  })
}
