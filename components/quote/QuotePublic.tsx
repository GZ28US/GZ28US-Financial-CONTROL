'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// THE CLIENT'S QUOTE PAGE (06/11/2026; blueprint §5.1). One column, max 480 px, dark house look on screen, light on print.
// Read → approve & sign (name pre-filled, two consents, two elections, one button that names the act and the amount) → pay
// the deposit (Stripe Checkout) → the project is born when the money clears. Every state of the same URL renders here.
// Also used by the staff preview (/doc/<id>/preview) with `previewDto` — then nothing is stamped and no button calls the server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BASE_PATH } from '@/lib/utils'
import { t, money, moneyCents, type Lang } from '@/lib/quoteStrings'
import { fmtDay, fmtStamp } from '@/lib/orlando'

type Dto = Record<string, any>
const api = (path: string, body: unknown) => fetch(`${BASE_PATH}/api/q/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))

export default function QuotePublic({ token, attemptId, print, previewDto }: { token?: string; attemptId?: string | null; print?: boolean; previewDto?: Dto }) {
  const [d, setD] = useState<Dto | null>(previewDto || null)
  const [state, setState] = useState<string>(previewDto ? 'ok' : 'loading')
  const [toast, setToast] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [landing, setLanding] = useState<string>('')
  const preview = !!previewDto
  const lang: Lang = (d?.language || 'en') as Lang
  const T = useCallback((k: string, v?: Record<string, string | number>) => t(lang, k, v), [lang])
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 6000) }

  // open (the one time the token travels) → cookie; then everything goes by link_id
  useEffect(() => {
    if (preview || !token) return
    api('open', { token }).then(({ status, data }) => {
      if (status === 200 && data.state === 'inactive') { setState('inactive'); return }
      if (status === 404) { setState(data.state === 'void' ? 'void' : 'not_found'); return }
      if (status === 429) { setState('rate'); return }
      if (status !== 200) { setState('error'); return }
      setD(data); setState('ok')
    }).catch(() => setState('offline'))
  }, [token, preview])

  // VIEWED: after 3 s visible (crawlers and quick previews never count)
  useEffect(() => {
    if (preview || print || !d?.link_id) return
    let done = false
    const fire = () => { if (!done && document.visibilityState === 'visible') { done = true; api('view', { link_id: d.link_id }) } }
    const tm = setTimeout(fire, 3000)
    return () => clearTimeout(tm)
  }, [d?.link_id, preview, print])

  // back from Stripe (?a=<attempt>): confirm, then poll 5 s × 12
  const polls = useRef(0)
  useEffect(() => {
    if (preview || !attemptId || !d?.link_id) return
    let stop = false
    const go = () => api('landing', { link_id: d.link_id, attempt_id: attemptId }).then(({ status, data }) => {
      if (stop) return
      if (status === 200 && data.stage) { setD(data); const s = data.landing
        if (s === 'booked' || s === 'repeat' || data.stage === 'INVOICE') { setLanding('done'); return }
        if (s === 'processing') { setLanding('done'); return } }
      polls.current++
      if (polls.current >= 12) { setLanding('timeout'); return }
      setLanding('pending'); setTimeout(go, 5000)
    }).catch(() => { if (!stop) setTimeout(go, 5000) })
    go()
    return () => { stop = true }
  }, [attemptId, d?.link_id, preview])

  const refresh = () => d?.link_id && api('state', { link_id: d.link_id }).then(({ status, data }) => { if (status === 200 && data.stage) setD(data) })

  if (state !== 'ok' || !d) {
    const msg = state === 'loading' ? '' : state === 'inactive' ? t('en', 'inactive') : state === 'void' ? t('en', 'void') : state === 'not_found' ? t('en', 'not_found')
      : state === 'rate' ? t('en', 'err_rate') : state === 'offline' ? t('en', 'offline') : t('en', 'err_generic')
    return <Shell print={print}>{state === 'loading' ? <div className="h-40" /> : <Card><p className="text-gray-300">{msg}</p></Card>}</Shell>
  }
  const doc = d.document
  if (!doc) return <Shell print={print}><Card><p className="text-gray-300">{T('superseded')}</p></Card></Shell>

  const hdr = doc.header || {}
  const tot = doc.totals || {}
  const grand = Number(tot.grand || 0)
  const stage: string = d.stage
  const sub: string | null = d.sub
  const plan: any[] = d.plan || []
  const approved = !!d.approval
  const isInvoice = stage === 'INVOICE'
  const nextDue = plan.find(p => !p.paid)
  const lines: any[] = doc.lines || []
  const items = lines.filter(l => l.kind === 'item'), services = lines.filter(l => l.kind === 'service')
  const fmtLine = (l: any) => l.display === 'price' ? money(l.total, lang) : l.display === 'included' ? T('included') : T('courtesy')

  return (
    <Shell print={print} lang={lang}>
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-700 text-white text-sm px-4 py-3 rounded-lg shadow-lg max-w-[90vw] print:hidden" role="alert">{toast}</div>}
      {d.is_test && <div className="mb-3 text-center text-xs font-bold tracking-widest text-yellow-300 bg-yellow-900/40 border border-yellow-700 rounded py-1 print:hidden">TEST DOCUMENT — Stripe test mode</div>}

      <Card>
        <div className="text-lg font-semibold text-white">{hdr.car || hdr.service}</div>
        {hdr.car && <div className="text-sm uppercase tracking-wide text-gray-300">{hdr.service}</div>}
        <div className="text-2xl font-bold text-white mt-2">{money(grand, lang)}</div>
        <div className="text-xs text-gray-400 mt-1">{T('quote')} {hdr.display_code || hdr.code} · {T('rev')} {doc.seq}</div>
        {!isInvoice && doc.valid_until && <div className="text-xs text-gray-400">{T('valid_until')} {fmtDay(doc.valid_until, lang)}{doc.sent_valid_until && doc.sent_valid_until !== doc.valid_until ? ` (${T('extended_on')} ${fmtDay(doc.valid_until, lang)})` : ''}</div>}
      </Card>

      {d.hired && <Card tone="green"><div className="font-semibold text-emerald-300">{T('hired', { code: d.hired.code, car: d.hired.car })}</div>
        {d.hired.old_code && <div className="text-xs text-gray-400 mt-1">{T('formerly', { old_code: d.hired.old_code, date: fmtDay(addDaysIso(d.hired.at, 30), lang) })}</div>}</Card>}
      {landing === 'pending' && <Card><p className="text-gray-300">{T('landing_pending')}</p></Card>}
      {landing === 'timeout' && <Card><p className="text-gray-300">{T('landing_timeout')}</p></Card>}

      <p className="text-gray-200 my-4">{T(hdr.parts_only ? 'hello_parts' : 'hello', { name: hdr.client_first || '' })}</p>

      <Section title={`${T('whats_included')} (${items.length} ${T('parts')} · ${services.length} ${T('services')})`} open>
        {[...items, ...services].map(l => (
          <div key={l.id} className="flex justify-between gap-3 py-1.5 border-b border-gray-800 text-sm">
            <span className={l.display === 'price' ? 'text-white' : 'text-gray-300'}>{l.display === 'price' && hdr.has_package ? '📦 ' : ''}{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</span>
            <span className="shrink-0 text-gray-300">{fmtLine(l)}</span>
          </div>))}
      </Section>

      {doc.notes?.length > 0 && <Section title={`${T('notes')} (${doc.notes.length})`}>{doc.notes.map((n: any) => <p key={n.id} className="text-sm text-gray-300 py-1">{n.text}</p>)}</Section>}

      <Card>
        {Number(tot.discount) > 0 && <Row k={T('subtotal')} v={money(tot.subtotal, lang)} />}
        {Number(tot.discount) > 0 && <Row k={`${T('discount')} (${tot.discount_pct}%)`} v={`− ${money(tot.discount, lang)}`} />}
        <Row k={T('fl_tax')} v={tot.taxable ? money(tot.fl_tax, lang) : `${T('fl_exempt')} — ${String(tot.fl_label || '').replace(/^Exempt — /, '')}`} />
        <Row k={T('grand_total')} v={money(grand, lang)} strong />
      </Card>

      <Card>
        <div className="text-xs font-bold tracking-widest text-gray-400 mb-2">{T('payment_plan')}</div>
        {plan.map(p => (
          <div key={p.seq} className="flex justify-between gap-3 py-1.5 text-sm">
            <span className="text-gray-200">{p.seq}&nbsp;&nbsp;{p.label}</span>
            <span className={p.paid ? 'text-emerald-400 font-semibold' : 'text-white'}>{moneyCents(p.amount_cents, lang)}{p.paid ? ` ✓ ${T('paid')}` : ''}</span>
          </div>))}
        <p className="text-xs text-gray-400 mt-2">{railsSentence(d, lang)}</p>
      </Card>

      <Section title={T('fl_estimate_title')}><p className="text-sm text-gray-300 whitespace-pre-line">{d.fl_estimate_text}</p></Section>
      <Section title={T('terms_title')} open={print}><p className="text-sm text-gray-300 whitespace-pre-line">{d.terms_text}</p></Section>

      {!print && <Actions d={d} lang={lang} T={T} busy={busy} setBusy={setBusy} flash={flash} setD={setD} preview={preview} refresh={refresh} stage={stage} sub={sub} approved={approved} nextDue={nextDue} grand={grand} />}

      {approved && <Certificate d={d} lang={lang} T={T} />}

      {!print && <div className="flex flex-wrap gap-4 justify-center text-sm my-6 print:hidden">
        <a className="text-gray-400 underline" href={token ? `${BASE_PATH}/q/${token}/print` : '#'} onClick={e => { if (!token) e.preventDefault(); else { e.preventDefault(); window.open(`${BASE_PATH}/q/${token}/print`, '_blank') } }}>{T('print')}</a>
      </div>}
      {print && <AutoPrint />}

      <footer className="text-center text-xs text-gray-500 mt-8 pb-10">{doc.company?.name} · {doc.company?.address} · {doc.company?.phone}</footer>
    </Shell>
  )
}

function addDaysIso(iso: string, n: number) { const x = new Date(iso); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

function railsSentence(d: Dto, lang: Lang): string {
  const rails: string[] = d.rails || []
  const stripe = d.pay_ok ? rails.filter(r => r === 'card' || r === 'us_bank_account') : []
  const parts: string[] = []
  if (stripe.includes('us_bank_account') && stripe.includes('card')) parts.push(t(lang, 'rail_ach_card') + ' ' + t(lang, 'no_fee'))
  else if (stripe.includes('card')) parts.push(t(lang, 'rail_card') + ' ' + t(lang, 'no_fee'))
  if (rails.includes('ZELLE') || rails.includes('WIRE')) parts.push(t(lang, 'zelle_wire'))
  if (rails.includes('PIX_BR')) parts.push(lang === 'pt' ? 'PIX / TED para a GZ28BR.' : 'PIX / TED to GZ28BR.')
  return parts.join(' ')
}

function Actions(p: { d: Dto; lang: Lang; T: (k: string, v?: Record<string, string | number>) => string; busy: boolean; setBusy: (b: boolean) => void; flash: (m: string) => void;
  setD: (d: Dto) => void; preview: boolean; refresh: () => void; stage: string; sub: string | null; approved: boolean; nextDue: any; grand: number }) {
  const { d, lang, T, busy, setBusy, flash, setD, preview, stage, sub, approved, nextDue, grand } = p
  const call = async (path: string, body: Record<string, unknown>) => {
    if (preview) { flash('preview — nothing is sent'); return null }
    if (!navigator.onLine) { flash(T('offline')); return null }
    setBusy(true)
    try { return await api(path, { link_id: d.link_id, ...body }) } catch { flash(T('offline')); return null } finally { setBusy(false) }
  }
  const errMsg = (data: any) => data?.error === 'err_gate_locked' ? T('err_gate_locked', { minutes: data.minutes || 15 }) : T(String(data?.error || 'err_generic'))

  if (stage === 'VOID') return <Card><p className="text-gray-300">{T('void')}</p></Card>
  if (stage === 'DRAFT') return <Card><p className="text-gray-300">{T('superseded')}</p></Card>
  if (stage === 'EXPIRED') return <Renewal d={d} T={T} call={call} lang={lang} />
  if (stage === 'DECLINED') return <Card><p className="text-gray-300">{T('declined', { date: fmtDay(String(d.declined_at || '').slice(0, 10), lang) })}</p>
    <button disabled={busy} onClick={async () => { const r = await call('decline-withdraw', {}); if (r?.status === 200) p.refresh() }} className="mt-3 w-full min-h-[44px] rounded-lg border border-gray-600 text-white">{T('undo_decline')}</button></Card>

  if (!approved && stage !== 'INVOICE') return <>
    {stage === 'CHANGES' && <Card><p className="text-gray-300">{T('changes_received', { date: fmtDay(String(d.changes_at || '').slice(0, 10), lang) })}</p></Card>}
    <SignCard d={d} T={T} busy={busy} call={call} flash={flash} errMsg={errMsg} setD={setD} grand={grand} lang={lang} />
    <ChangesDecline T={T} call={call} refresh={p.refresh} flash={flash} d={d} />
  </>

  // approved (or already an invoice): the PAY card for the next due installment
  if (!nextDue) return null
  const processing = (d.attempts || []).some((a: any) => a.status === 'PROCESSING')
  const failed = sub === 'DEPOSIT_FAILED'
  const isLast = nextDue.seq === d.last_seq && (d.plan || []).length > 1
  if (processing) {
    const a = (d.attempts || []).find((x: any) => x.status === 'PROCESSING')
    return <Card tone="amber"><p className="text-amber-200 text-sm">{T('clearing', { amount: moneyCents(a.amount_cents, lang), date: fmtDay(String(a.authorized_at || '').slice(0, 10), lang) })}</p>
      {a.verification === 'microdeposits' && <p className="text-amber-200 text-sm mt-2">{T('clearing_microdeposits')}</p>}
      <p className="text-xs text-gray-400 mt-2">{T('clearing_no_card')}</p></Card>
  }
  if (isLast && d.balance_pending_update) return <Card><p className="text-gray-300 text-sm">{T('balance_pending_update')}</p></Card>
  const rails: string[] = (d.rails || []).filter((r: string) => r === 'card' || r === 'us_bank_account')
  const pay = async (rail: string) => {
    const r = await call('checkout', { seq: nextDue.seq, rail })
    if (!r) return
    if (r.status === 200 && r.data.url) { window.location.href = r.data.url; return }
    flash(errMsg(r.data))
  }
  const amt = moneyCents(nextDue.amount_cents, lang)
  return <Card tone="blue">
    {sub === 'DEPOSIT_REFUNDED' && <p className="text-sm text-gray-300 mb-2">{T('deposit_refunded', { amount: amt, date: fmtDay(String(d.refunded_at || '').slice(0, 10), lang) })}</p>}
    {failed && <p className="text-sm text-red-300 mb-2">{T('failed', { reason: T('fail_reason.' + ((d.attempts || []).slice(-1)[0]?.failure_code === 'verification_timeout' ? 'verification_timeout' : 'generic')) })}</p>}
    <div className="font-bold text-white">{T(nextDue.seq === 1 ? 'deposit_due' : 'installment_due', { amount: amt })}</div>
    {d.in_app && <p className="text-xs text-amber-300 mt-2">{T('open_in_browser')}</p>}
    {d.pay_ok && rails.includes('us_bank_account') && <button disabled={busy} onClick={() => pay('us_bank_account')} className="mt-3 w-full min-h-[56px] rounded-xl bg-white text-black font-bold">{T('pay_ach', { amount: amt })}</button>}
    {d.pay_ok && rails.includes('card') && <button disabled={busy} onClick={() => pay('card')} className="mt-3 w-full min-h-[56px] rounded-xl bg-emerald-500 text-black font-bold">{failed ? T('pay_again') : T('pay_card', { amount: amt })}</button>}
    {!d.pay_ok && <p className="text-xs text-gray-400 mt-2">{T('err_pay_unavailable')}</p>}
    <ZelleSheet d={d} T={T} call={call} seq={nextDue.seq} flash={flash} />
    <p className="text-[11px] text-gray-500 mt-3">{T('stripe_foot')}</p>
  </Card>
}

function SignCard({ d, T, busy, call, flash, errMsg, setD, grand, lang }: { d: Dto; T: any; busy: boolean; call: any; flash: any; errMsg: any; setD: any; grand: number; lang: Lang }) {
  const [open, setOpen] = useState(true)
  const [name, setName] = useState<string>(d.signer_default || '')
  const [c1, setC1] = useState(false), [c2, setC2] = useState(false)
  const [est, setEst] = useState<string>(''), [lim, setLim] = useState<string>(''), [parts, setParts] = useState<string>('')
  const [gate, setGate] = useState(''), [gateOk, setGateOk] = useState<boolean>(!!d.gate?.ok)
  const dep = (d.plan || [])[0]
  if (!open) return <button onClick={() => setOpen(true)} className="w-full text-left text-white my-3">{T('approve_reopen')}</button>
  const sign = async () => {
    if (name.trim().length < 2) return flash(T('err_name'))
    if (!c1 || !c2) return flash(T('err_consent'))
    if (!est || !parts) return flash(T('err_choice'))
    if (est === 'LIMIT' && !(Number(lim) > 0)) return flash(T('err_limit'))
    if (d.gate?.needed && !gateOk) {
      const g = await call('gate', { answer: gate })
      if (!g) return
      if (g.status !== 200) return flash(errMsg(g.data))
      setGateOk(true)
    }
    const r = await call('sign', { revision_id: d.document.revision_id, sha256: d.document.sha256, terms_sha256: d.document.terms_sha256, signer_name: name,
      consents: { erecords: c1, terms: c2, estimate: est, limit_amount: est === 'LIMIT' ? Number(lim) : null, parts_return: parts } })
    if (!r) return
    if (r.status === 200 && r.data.stage) { setD(r.data); window.scrollTo({ top: document.body.scrollHeight * 0.4, behavior: 'smooth' }); return }
    if (r.data?.error === 'err_stale') { flash(T('err_stale')); setTimeout(() => window.location.reload(), 2500); return }
    flash(errMsg(r.data))
  }
  const chip = (on: boolean) => `px-3 min-h-[44px] rounded-lg border text-sm ${on ? 'bg-white text-black border-white' : 'border-gray-600 text-gray-200'}`
  return <Card tone="blue">
    <div className="text-xs font-bold tracking-widest text-gray-300 mb-3">{T('approve_title')}</div>
    <label className="text-xs text-gray-400">{T('sign_name')}</label>
    <input value={name} onChange={e => setName(e.target.value)} className="w-full mt-1 mb-3 bg-black border border-gray-700 rounded-lg px-3 min-h-[44px] text-white" autoComplete="name" />
    <label className="flex gap-3 items-start text-sm text-gray-200 mb-2"><input type="checkbox" checked={c1} onChange={e => setC1(e.target.checked)} className="mt-1 w-5 h-5" />{T('consent_erecords')}</label>
    <label className="flex gap-3 items-start text-sm text-gray-200 mb-3"><input type="checkbox" checked={c2} onChange={e => setC2(e.target.checked)} className="mt-1 w-5 h-5" />{T('consent_terms')}</label>
    <div className="text-xs text-gray-400 mb-1">{T('est_label')}</div>
    <div className="flex flex-wrap gap-2 mb-2">{['REQUEST', 'LIMIT', 'WAIVE'].map(k => <button key={k} type="button" onClick={() => setEst(k)} className={chip(est === k)}>{T('est_' + k)}</button>)}</div>
    {est === 'LIMIT' && <input inputMode="decimal" value={lim} onChange={e => setLim(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="US$" className="w-40 mb-2 bg-black border border-gray-700 rounded-lg px-3 min-h-[44px] text-white" />}
    <div className="text-xs text-gray-400 mb-1 mt-2">{T('parts_label')}</div>
    <div className="flex flex-wrap gap-2 mb-3">{['RETURN', 'INSPECT', 'NONE'].map(k => <button key={k} type="button" onClick={() => setParts(k)} className={chip(parts === k)}>{T('parts_' + k)}</button>)}</div>
    {d.gate?.needed && !gateOk && <div className="mb-3">
      <div className="text-sm text-gray-200 mb-1">{d.gate.hint?.kind === 'phone' ? T('gate_phone', { last2: d.gate.hint.last2 }) : T('gate_email', { masked: d.gate.hint?.masked || '' })}</div>
      <input value={gate} onChange={e => setGate(e.target.value)} placeholder={d.gate.hint?.kind === 'phone' ? T('gate_phone_ph') : T('gate_email_ph')}
        inputMode={d.gate.hint?.kind === 'phone' ? 'numeric' : 'email'} className="w-full bg-black border border-gray-700 rounded-lg px-3 min-h-[44px] text-white" /></div>}
    <button disabled={busy} onClick={sign} className="w-full min-h-[56px] rounded-xl bg-emerald-500 text-black font-bold disabled:opacity-60">{T('approve_btn', { amount: money(grand, lang) })}</button>
    {dep && <p className="text-xs text-gray-400 mt-2">{T('next_pay', { amount: moneyCents(dep.amount_cents, lang) })}</p>}
    <button onClick={() => setOpen(false)} className="text-xs text-gray-500 mt-3 underline">{T('not_now')}</button>
  </Card>
}

function ChangesDecline({ T, call, refresh, flash, d }: { T: any; call: any; refresh: () => void; flash: any; d: Dto }) {
  const [mode, setMode] = useState<'' | 'changes' | 'decline' | 'contact'>('')
  const [text, setText] = useState(''), [reason, setReason] = useState('')
  const c = d.contact || {}
  const handle = /face/i.test(c.channel) ? `Facebook: ${c.facebook}` : /insta/i.test(c.channel) ? `Instagram: ${c.instagram}` : /mail/i.test(c.channel) ? `E-mail: ${c.email}` : `WhatsApp: ${c.whatsapp}`
  return <div className="my-4">
    <div className="flex flex-wrap gap-4 justify-center text-sm">
      <button onClick={() => setMode(mode === 'changes' ? '' : 'changes')} className="text-gray-300 underline min-h-[44px]">{T('request_changes')}</button>
      <button onClick={() => setMode(mode === 'decline' ? '' : 'decline')} className="text-gray-500 underline min-h-[44px]">{T('decline_title')}</button>
      <button onClick={() => setMode(mode === 'contact' ? '' : 'contact')} className="text-gray-300 underline min-h-[44px]">{T('contact_us')}</button>
    </div>
    {mode === 'changes' && <Card><div className="text-sm text-white mb-2">{T('changes_title')}</div>
      <textarea value={text} onChange={e => setText(e.target.value.slice(0, 1000))} rows={4} className="w-full bg-black border border-gray-700 rounded-lg p-3 text-white text-sm" />
      <button onClick={async () => { const r = await call('changes', { text }); if (r?.status === 200) { setMode(''); refresh() } else if (r) flash(T('err_generic')) }} className="mt-2 w-full min-h-[44px] rounded-lg bg-white text-black font-semibold">{T('changes_send')}</button></Card>}
    {mode === 'decline' && <Card><div className="flex gap-2 flex-wrap mb-2">{['TIMING', 'SCOPE', 'OTHER'].map(k => <button key={k} onClick={() => setReason(k)} className={`px-3 min-h-[44px] rounded-lg border text-sm ${reason === k ? 'bg-white text-black' : 'border-gray-600 text-gray-200'}`}>{T('reason_' + k)}</button>)}</div>
      <textarea value={text} onChange={e => setText(e.target.value.slice(0, 1000))} rows={2} className="w-full bg-black border border-gray-700 rounded-lg p-3 text-white text-sm" />
      <button disabled={!reason} onClick={async () => { const r = await call('decline', { reason, text }); if (r?.status === 200) { setMode(''); refresh() } }} className="mt-2 w-full min-h-[44px] rounded-lg border border-red-500 text-red-300 disabled:opacity-50">{T('decline_confirm')}</button></Card>}
    {mode === 'contact' && <Card><button onClick={() => { navigator.clipboard?.writeText(handle.split(': ')[1] || handle); flash(T('copied')) }} className="text-sm text-gray-200 text-left">{T('contact_sheet', { channel: handle.split(':')[0], handle: handle.split(': ')[1] || '' })}</button></Card>}
  </div>
}

function ZelleSheet({ d, T, call, seq, flash }: { d: Dto; T: any; call: any; seq: number; flash: any }) {
  const [open, setOpen] = useState(false), [sent, setSent] = useState(false)
  const rails: string[] = d.rails || []
  if (!rails.includes('ZELLE') && !rails.includes('WIRE') && !rails.includes('PIX_BR')) return null
  return <div className="mt-3">
    <button onClick={() => setOpen(!open)} className="text-sm text-gray-300 underline min-h-[44px]">{T('prefer_zelle')}</button>
    {open && <div className="mt-2 text-sm text-gray-200 whitespace-pre-line bg-black/40 rounded-lg p-3">{T('zelle_sheet', { zelle: d.zelle, code: d.document?.header?.display_code || '' })}
      {!sent ? <button onClick={async () => { const r = await call('promised', { seq, method: 'ZELLE' }); if (r?.status === 200) { setSent(true); flash(T('promised_ok')) } }} className="block mt-3 w-full min-h-[44px] rounded-lg border border-gray-500 text-white">{T('i_sent_it')}</button>
        : <p className="mt-2 text-emerald-300">{T('promised_ok')}</p>}</div>}
  </div>
}

function Renewal({ d, T, call, lang }: { d: Dto; T: any; call: any; lang: Lang }) {
  const [asked, setAsked] = useState<boolean>(!!d.renewal_at)
  return <Card><p className="text-gray-300">{T('expired', { date: fmtDay(d.document?.valid_until, lang) })}</p>
    {asked ? <p className="text-emerald-300 mt-2">{T('renewal_asked')}</p>
      : <button onClick={async () => { const r = await call('renewal', {}); if (r?.status === 200) setAsked(true) }} className="mt-3 w-full min-h-[44px] rounded-lg bg-white text-black font-semibold">{T('ask_renewal')}</button>}</Card>
}

function Certificate({ d, lang, T }: { d: Dto; lang: Lang; T: any }) {
  const a = d.approval
  const when = fmtStamp(a.signed_at, lang)
  return <Card>
    <div className="text-emerald-300 font-semibold">{a.method === 'CLIENT_ESIGN' ? T('approved_by', { name: a.signer_name, when }) : T('approved_shop', { method: T('method.' + a.method), when })}</div>
    <div className="mt-3 text-[11px] text-gray-500 leading-relaxed">
      <div className="font-bold tracking-widest text-gray-400">{T('certificate')}</div>
      <div>{a.signer_name} · {T('method.' + a.method)} · {when} (Orlando){a.city ? ` · ${a.city}` : ''}{a.signer_contact_masked ? ` · ${a.signer_contact_masked}` : ''}</div>
      <div>{d.document?.header?.display_code} · {T('rev')} {d.document?.seq} · {a.consent_version}</div>
      <div className="break-all">{T('hash_hint')}: {a.document_sha256}</div>
    </div>
  </Card>
}

function AutoPrint() { useEffect(() => { const tm = setTimeout(() => window.print(), 900); return () => clearTimeout(tm) }, []); return null }

function Shell({ children, print, lang }: { children: React.ReactNode; print?: boolean; lang?: Lang }) {
  const cls = useMemo(() => print ? 'bg-white text-black min-h-screen q-print' : 'bg-black min-h-screen', [print])
  return <div className={cls} lang={lang}>
    <style>{`@media print { .print\\:hidden { display:none !important } body { background:#fff } } .q-print * { color:#111 !important; border-color:#ccc !important; background:transparent !important }`}</style>
    <header className="sticky top-0 z-40 bg-black/95 border-b border-gray-900 print:static">
      <div className="max-w-[480px] mx-auto px-4 py-3 flex items-center gap-3">
        <img src={`${BASE_PATH}/logo_gz28.jpg`} alt="" className="h-7 w-auto rounded" />
        <span className="text-white font-semibold tracking-wide">GZ28 V8 SpeedShop</span>
      </div>
    </header>
    <main className="max-w-[480px] mx-auto px-4 py-4">{children}</main>
  </div>
}

function Card({ children, tone }: { children: React.ReactNode; tone?: 'green' | 'blue' | 'amber' }) {
  const b = tone === 'green' ? 'border-emerald-700' : tone === 'blue' ? 'border-sky-800' : tone === 'amber' ? 'border-amber-700' : 'border-gray-800'
  return <div className={`bg-gray-950 border ${b} rounded-2xl p-4 my-3`}>{children}</div>
}
function Section({ title, children, open }: { title: string; children: React.ReactNode; open?: boolean }) {
  return <details className="bg-gray-950 border border-gray-800 rounded-2xl my-3" open={open}>
    <summary className="cursor-pointer list-none px-4 py-3 text-xs font-bold tracking-widest text-gray-300 min-h-[44px] flex items-center">▸ {title}</summary>
    <div className="px-4 pb-4">{children}</div>
  </details>
}
function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className={`flex justify-between gap-3 py-1 text-sm ${strong ? 'text-white font-bold text-base border-t border-gray-800 mt-1 pt-2' : 'text-gray-300'}`}><span>{k}</span><span className="text-right">{v}</span></div>
}
