// Harness local (sem banco, sem rede, NADA envia) dos textos dos e-mails do portal — quote portal M2 (06/11/2026).
// npx jiti scripts/test-quote-mail.ts
import { portalMailCopy, PORTAL_MAIL_KINDS } from '../lib/quoteMail.server'

let fail = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL ' + m); fail++ } }
const v = { first: 'Robert', code: 'US.QT.028.1', car: '2019 Trackhawk', link: 'https://www.gz28us.com/ca/q/TESTTOKEN', amount: 'US$ 42,500.00', until: 'Nov 21, 2026', seq: 1 }
for (const kind of PORTAL_MAIL_KINDS) for (const lang of ['en', 'pt'] as const) {
  const m = portalMailCopy(kind, lang, v)
  const tag = `${kind}/${lang}`
  ok(!/undefined|null|NaN/.test(m.subject + m.html), `${tag}: no undefined/null/NaN`)
  ok(m.html.includes(v.link), `${tag}: carries the portal link`)
  ok(m.html.includes('11320 Space Blvd'), `${tag}: signature`)
  ok(m.subject.includes(v.code), `${tag}: subject names the document`)
  ok(lang === 'pt' ? /Olá/.test(m.html) : /Hello/.test(m.html), `${tag}: greeting in the client's language`)
  console.log(`${tag.padEnd(22)} ${m.subject}`)
}
const x = portalMailCopy('quote-link', 'en', { ...v, first: '<script>x</script>', car: 'A&B "C"' })
ok(!x.html.includes('<script>') && x.html.includes('&lt;script&gt;') && x.html.includes('A&amp;B &quot;C&quot;'), 'html escapes names')
const bare = portalMailCopy('installment-due', 'en', { first: '', code: 'US.050.1', car: '', link: 'https://x', seq: 2 })
ok(!/undefined/.test(bare.html) && bare.subject === 'Installment 2 of US.050.1', 'installment-due without amount/car')
console.log(fail ? `\n${fail} FAIL` : '\nTODOS VERDES'); process.exit(fail ? 1 : 0)
