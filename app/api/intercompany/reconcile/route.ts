import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk, requireUser } from '@/lib/apiAuth.server'
import { CrossingReadError } from '@/lib/crossingBalance.server'
import { intercompanyReconcile } from '@/lib/intercompanyReconcile.server'

// ── A CONTA NOVA × O ESPELHO VELHO, LINHA A LINHA (23/out/2026) — só leitura ──
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) return NextResponse.json({ ok: false, kind: 'auth', error: 'unauthorized' }, { status: 401 })
  try {
    const data = await intercompanyReconcile()
    return NextResponse.json({ ok: true, ...data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const kind = e instanceof CrossingReadError ? e.kind : 'db'
    return NextResponse.json({ ok: false, kind, error: String((e as Error)?.message || e).slice(0, 400) }, { status: kind === 'service-key' ? 503 : 502 })
  }
}
