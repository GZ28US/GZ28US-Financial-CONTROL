/* eslint-disable @typescript-eslint/no-explicit-any */
// /ca/api/adm/notifications — QUOTE PORTAL M4 (06/11/2026; blueprint §8.1). GET: every switch of the portal's robot messages (the
// lib/notify.server.ts registry) with its value, whether a sender is wired, and the last 60 decisions (NOTIFIED / NOTIFY_SKIPPED).
// POST {key, on}: flips ONE registry key (a human login only — machine accounts refused); every flip is a data_fixes row.
// POST {test_targets: string[]}: the only addresses a TEST document may ever be mailed to. Nothing here sends anything.
import { NextRequest, NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth.server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { NOTIFY_KEYS, wired } from '@/lib/notify.server'
import { readSetting, writeSetting } from '@/lib/appSettings.server'

export const dynamic = 'force-dynamic'
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status })

export async function GET(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return bad('staff only (a human login)', 403)
  const db = serviceDb()
  const { data: rows } = await db.from('app_settings').select('key, value, updated_at, updated_by').in('key', [...NOTIFY_KEYS.map(k => k.key), 'notify.test_targets'])
  const val = new Map((rows || []).map(r => [r.key, r]))
  const { data: evs } = await db.from('invoice_events').select('id, invoice_id, kind, payload, at').in('kind', ['NOTIFIED', 'NOTIFY_SKIPPED']).order('at', { ascending: false }).limit(60)
  const ids = [...new Set((evs || []).map(e => e.invoice_id))]
  const { data: invs } = ids.length ? await db.from('invoices').select('id, invoice_code').in('id', ids) : { data: [] as any[] }
  const code = new Map((invs || []).map(i => [i.id, i.invoice_code]))
  return NextResponse.json({
    keys: NOTIFY_KEYS.map(k => ({ ...k, on: val.get(k.key)?.value === true, wired: wired(k), updated_at: val.get(k.key)?.updated_at || null, updated_by: val.get(k.key)?.updated_by || null })),
    test_targets: (await readSetting<string[]>('notify.test_targets')) || [],
    decisions: (evs || []).map(e => ({ id: e.id, at: e.at, kind: e.kind, key: e.payload?.key, reason: e.payload?.reason || null, to: e.payload?.to || null, test: !!e.payload?.test, invoice_id: e.invoice_id, code: code.get(e.invoice_id) || null })),
  })
}

export async function POST(req: NextRequest) {
  const staff = await requireStaff(req)
  if (!staff) return bad('staff only (a human login)', 403)
  const b = await req.json().catch(() => ({})) as any
  const db = serviceDb()
  if (Array.isArray(b.test_targets)) {
    const list = [...new Set(b.test_targets.map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 10)
    const before = (await readSetting<string[]>('notify.test_targets')) || []
    const e = await writeSetting('notify.test_targets', list, staff.email, 'addresses a TEST document may be mailed to')
    if (e) return bad(e, 500)
    await db.from('data_fixes').insert({ check_key: 'notify-switch', table_name: 'app_settings', row_id: 'notify.test_targets', field: 'value', old_value: JSON.stringify(before), new_value: JSON.stringify(list), label: `/adm/notifications · ${staff.email}` }).then(() => undefined, () => undefined)
    return NextResponse.json({ ok: true, test_targets: list })
  }
  const k = NOTIFY_KEYS.find(x => x.key === String(b.key || ''))
  if (!k) return bad('unknown key — only the registry keys flip here')
  const on = b.on === true
  const before = await readSetting<unknown>(k.key)
  const e = await writeSetting(k.key, on, staff.email)
  if (e) return bad(e, 500)
  await db.from('data_fixes').insert({ check_key: 'notify-switch', table_name: 'app_settings', row_id: k.key, field: 'value', old_value: JSON.stringify(before ?? null), new_value: JSON.stringify(on), label: `/adm/notifications · ${staff.email}` }).then(() => undefined, () => undefined)
  return NextResponse.json({ ok: true, key: k.key, on, wired: wired(k) })
}
