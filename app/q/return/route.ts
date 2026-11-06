import { NextRequest, NextResponse } from 'next/server'
import { serviceDb } from '@/lib/quoteDoc.server'
import { verifyLandingToken, cookieName } from '@/lib/quotePublic.server'
import { t, moneyCents, type Lang } from '@/lib/quoteStrings'

// STRIPE RETURN (06/11/2026; blueprint §2.1 /q/return, U2-03, RO-08). success_url / cancel_url = /ca/q/return?t=<landing token>.
// The landing token names the ATTEMPT only. With the document's cookie → 302 to the quote page (?a=<attempt>), which confirms.
// Without it (an in-app browser that dropped the cookie) → a branded «payment received» page that confirms by itself. Never 404.
export const dynamic = 'force-dynamic'

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function GET(req: NextRequest) {
  const tok = req.nextUrl.searchParams.get('t') || ''
  const cancelled = req.nextUrl.searchParams.get('c') === '1'
  const attemptId = verifyLandingToken(tok)
  let lang: Lang = 'en', amount = ''
  if (attemptId) {
    try {
      const db = serviceDb()
      const { data: att } = await db.from('payment_attempts').select('id, invoice_id, amount_cents').eq('id', attemptId).maybeSingle()
      if (att) {
        const { data: link } = await db.from('quote_links').select('id, token').eq('invoice_id', att.invoice_id).is('revoked_at', null).maybeSingle()
        const { data: terms } = await db.from('invoice_terms').select('language').eq('invoice_id', att.invoice_id).maybeSingle()
        lang = (terms?.language || 'en') as Lang
        amount = moneyCents(Number(att.amount_cents), lang)
        if (link && req.cookies.get(cookieName(link.id))?.value === link.token) {
          const to = new URL(`/ca/q/${link.token}${cancelled ? '' : `?a=${att.id}`}`, req.nextUrl.origin)
          return NextResponse.redirect(to, { status: 302, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
        }
      }
    } catch (e) { console.error('[q return]', (e as Error).message) }
  }
  const title = cancelled ? (lang === 'pt' ? 'Pagamento não concluído' : 'Payment not completed') : t(lang, 'return_no_session')
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>GZ28 V8 SpeedShop</title>
<style>body{margin:0;background:#000;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:480px;margin:0 auto;padding:32px 16px}
.c{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:20px}h1{font-size:18px;margin:0 0 8px;color:#fff}p{color:#9ca3af;line-height:1.5}
.b{font-weight:700;letter-spacing:.5px;color:#fff;margin-bottom:20px;display:flex;gap:10px;align-items:center}img{height:28px}#s{color:#34d399;font-weight:600}</style></head>
<body><main><div class="b"><img src="/ca/logo_gz28.jpg" alt="">GZ28 V8 SpeedShop</div><div class="c"><h1>${esc(title)}</h1>
${amount && !cancelled ? `<p>${esc(amount)}</p>` : ''}<p id="s">${cancelled ? '' : esc(t(lang, 'landing_pending'))}</p></div></main>
${attemptId && !cancelled ? `<script>(function(){var n=0;function go(){n++;fetch('/ca/api/q/landing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:${JSON.stringify(tok)},no_cookie:n===1})}).then(function(r){return r.json()}).then(function(d){var el=document.getElementById('s');if(d&&(d.attempt_status==='SUCCEEDED')){el.textContent=${JSON.stringify(lang === 'pt' ? '✓ Pagamento confirmado. Abra de novo o link do orçamento para ver o recibo.' : '✓ Payment confirmed. Open your quote link again to see the receipt.')};return}if(d&&d.attempt_status==='PROCESSING'){el.textContent=${JSON.stringify(lang === 'pt' ? '⏳ Em compensação no seu banco — o projeto abre assim que compensar.' : '⏳ Clearing with your bank — your project opens the moment it clears.')};return}if(n<12)setTimeout(go,5000);else el.textContent=${JSON.stringify(t(lang, 'landing_timeout'))}}).catch(function(){if(n<12)setTimeout(go,5000)})}go()})()</script>` : ''}
</body></html>`
  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } })
}
