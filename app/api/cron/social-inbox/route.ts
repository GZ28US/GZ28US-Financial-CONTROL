import { NextRequest, NextResponse } from 'next/server'
import { cronOk, readKeyOk } from '@/lib/apiAuth.server'
import { socialDb, platformOn } from '@/lib/social.server'
import { settingOn } from '@/lib/appSettings.server'
import { pollMeta, INBOX_SWITCH } from '@/lib/socialInbox.server'

// SOCIAL INBOX — a leitura periódica (13/11/2026), a cada 15 min: mensagens de TODAS as pastas, comentários, menções do
// Facebook e do Instagram → social_items. Só LÊ. Precisa de social.meta.enabled E social.inbox.enabled ligadas.
// Cron da Vercel (Bearer CRON_SECRET) ou x-read-key (rodada à mão). ?force=1 com a chave roda mesmo com o inbox desligado
// (para testar antes de ligar) — continua exigindo social.meta.enabled.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await platformOn('META'))) return NextResponse.json({ ok: true, skipped: 'social.meta.enabled is OFF' })
  const force = req.nextUrl.searchParams.get('force') === '1' && readKeyOk(req)
  if (!force && !(await settingOn(INBOX_SWITCH))) return NextResponse.json({ ok: true, skipped: `${INBOX_SWITCH} is OFF` })
  try {
    const r = await pollMeta(socialDb())
    if (r.errors.length) console.error('[social-inbox]', JSON.stringify(r.errors))
    return NextResponse.json({ ok: r.errors.length === 0, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, { status: 500 })
  }
}
