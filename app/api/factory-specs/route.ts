import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { factorySpecs, ErroSpecs } from '@/lib/factorySpecs.server'

// Returns the FACTORY (stock) crank engine ratings for a car, used to build the
// BoneStock baseline dyno row. hp = SAE net crank horsepower, nm = crank torque (N·m).
// PORTÃO (13/set/2026): cada chamada gasta a chave da Anthropic, e a rota respondia
// a pedido anônimo. Entra tela logada (sessionHeaders), servidor do próprio app
// (selfCallHeaders) ou script de sessão com x-read-key no header.
// A regra (o prompt e a leitura) mora em lib/factorySpecs.server.ts desde 18/10/2026.
export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await factorySpecs(await req.json()))
  } catch (err) {
    if (err instanceof ErroSpecs) return NextResponse.json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) }, { status: err.status })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
