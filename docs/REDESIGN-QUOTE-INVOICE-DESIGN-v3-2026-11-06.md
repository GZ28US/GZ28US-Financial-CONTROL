# 00-DESIGN v3 — QUOTE → INVOICE · "The client reads, signs and pays on one link; the project is born by itself"

Chief-architect revision, written 2026-11-06 06:17 Orlando (`scripts/agora.mjs`) against the US repo at HEAD `1681ef42`, the evidence base `understand/00-MAP.md` (+18 reports), `00-DESIGN-v2.md`, and the six round-2 refutations (`refute-rules-r2`, `refute-consumers-r2`, `refute-security-r2`, `refute-payments-r2`, `refute-ux-regression-r2`, `refute-rollout-r2`). Every r2 finding was decided — ACCEPT (design changed) or REJECT (with the evidence) — in **§17 REFUTATION LOG r2**; nothing was skipped. The r1 log (122 findings) stands as written in `00-DESIGN-v2.md` §17 and is referenced here as `r1 …`. Rules are cited as **C-nn** (00-MAP §3), open questions as **Q-nn**, r2 findings as `rules R2-nn`, `consumers #n`, `security R2-nn`, `payments P-nn`, `ux R2-nn` (renamed **U2-nn** here to avoid the clash with the rules/security files), `rollout R2-nn` (renamed **RO-nn**).

**What changed from v2 in one paragraph.** The money path now cannot hire a real document with test money (`stripeMode()` must be live for any non-`is_test` link, in the route and inside `book_payment`); the landing and the webhook claim **one** fulfilment row per Checkout Session (`cs:<id>`), a repeat of an already-booked session is a benign `{repeat:true}` and never an anomaly, and `fulfillCheckout` is a pure function of `(attempt.status, session.payment_status, pi.status)` — event types are only triggers; a business refusal **returns** `{anomaly}` after writing the attempt flip and the event (a RAISE would roll both back), and the webhook answers 500 only on true errors; every state function takes the invoice row lock first; re-minting an expired Checkout Session is a **new** attempt row (new idempotency key); PROCESSING ACH attempts are never expired by time. The public page authenticates by an httpOnly cookie **scoped to `/ca` and named per link**, read server-side (no header the browser cannot build); the Stripe return URL carries a short signed landing token so a cookie-less in-app browser lands on "payment received", never on NOT FOUND. The token is unreadable by any JWT through a **column-list GRANT** (the column REVOKE of v2 was a PostgreSQL no-op), the staff routes require a human account (`requireStaff`, machine accounts refused), the gate pass is an HMAC cookie with normalised answers, masked hints, per-(link, ip) lockout and a staff UNLOCK, and a link can be ROTATED at any stage. `trg_invoices_quote_flip` arms its second half on **V2 facts only** (approval or `installment_id`) so the legacy status cycle and HIRING DATE edits keep working; the editor guard also silences the TARGET solver and the labor re-save on sent quotes; the plan is materialized only on documents with **zero** incomes; PAID per installment is **Σ amounts** (refund/dispute rows carry the `installment_id`); the dispute money row and the `payout_id` link ship in M1; the fee row is honest (no borrowed receipt, `source` set, voucher PDF in M2); the Daily Mega-Report never prints an unpaid plan row (no predictions, C-66) and gains a structural DISPUTE line; the intercompany ledger dates by `paid_at` tonight; `trg_incomes_touch` is dropped (04/10 decision kept). The owner keeps **SEND BY APP** as a manual act (always available; robot keys gate robots only), gets "Client already approved" on the SEND sheet (one paste for Zapata), EDIT IN EDITOR on `/doc`, an ACTION NEEDED index at `/doc`, honest tap counts, grouped list chips + search; the client gets "included" (not COURTESY) under a package, a rails sentence that matches the buttons, PT terms hashed in PT, an EXPIRED "ask to renew" button, a collapsible "Not now", an in-page contact sheet (C-84, no outbound `href`), a landing timeout state and `err_limit`. Rails use one vocabulary; `seed_terms` is exempt from the actions key; the fixture is deleted by one SECURITY DEFINER RPC in FK order; `app/q/[token]/layout.tsx` owns the metadata; `next.config` header sources are written without `/ca`; the Stripe SDK/API version is pinned; the live switch is **three** env values.

**Spine and grafts (unchanged).** Client surface and lifecycle = client-first; money rails, webhook, attempts and test plan = payments-specialist; the structural guards, `income_settle()`, `invoice_terms`, `invoice_installments` = accountant-first; tonight's shipping shape = minimal-change; card-with-next-action, tap budget, CLOSE checklist, `NOTIFY_SKIPPED` = operator-first; `SIDE_EFFECT` ladder, partial unique `(ride_id, invoice_code)`, runtime flags, BR `TenantConfig` delta = clean-slate.

---

## 0. The judges' fatal findings (round 0) and how each is closed — amended where r1/r2 changed the closure

| # | Finding (judge) | Closed by (v3) |
|---|---|---|
| F-01 | Test deposit ballooned to REPORTS / listed by the Daily Mega-Report | **Mute is a property of the document**: `quote_links.is_test` (set only by the fixture script, service role; trigger `trg_quote_links_is_test` ties it to the `GZ28 TEST` client, `security R2-12`, `RO-05`) → every money row of that document is born `reported_at = now()` and every event carries `payload.test=true`, whatever the caller. **Structural**: `daily-report`, `expenseReportNet`, `recurring-expense-reports` skip `is_test` documents (§9). No fee row for test money. **And test money never touches a real document** (`security R2-01`, §3.3 step 1b). The ride-promotion branch is tested in a rolled-back transaction; the committed shopping fixture is **deleted by `fixture_delete()`** (one RPC, FK order — `RO-07`), never demoted. |
| F-02 | Live deposit never reported when every key is OFF | `reported_at` NULL for live money; **`updated_at = now()` set explicitly in `income_settle`/`quote_hire`/materialization — the generic `trg_incomes_touch` of v2 is dropped** (04/10/2026 decision, `RO-13`); ACH `paid_at` = settlement day (`r1 R1-02`); the fee row balloons as a normal purchase. |
| F-03 | Quote print date reintroduced | Unchanged: "rev n · valid until <date>" only (D-05). |
| F-04 | Presented-price lock UI-only / absent | DB trigger `trg_lock_presented_lines` scoped to the line ids frozen in the live revision, firing from SEND, `cancel_status` excluded, inserts free — **now also `invoices(fl_tax_override, global_discount)`** (identical-value-safe; the E guard already disables those inputs — `consumers #4`); plus the E guard that disables the inputs **and silences the TARGET solver and the labor re-save** (`consumers #3`, `U2-01`). |
| F-05 | C-07 structural | `trg_incomes_no_quote` in M1 — unchanged — plus `trg_invoices_quote_flip`: `is_quote false→true` refused universally (C-09); `hiring_date→NULL` / REALTIME→INCOMPLETE refused **only when an approval or an income with `installment_id` exists** (`rules R2-01`, `consumers #2`). |
| F-06 | CHECK legitimizing strays | Unchanged: list only tonight (C-100). |
| F-07 | Double deposit by double tap | One open attempt per `(invoice_id, installment_id)`; a second tap returns the same URL; **an expired OPEN attempt is set EXPIRED and a new attempt row (new id = new idempotency key) is minted** (`security R2-09`, `payments P-21`); a paid session for an installment already paid is applied to the next unpaid installment, else held — never auto-refunded. |
| F-08 | Collision with the shipped foundation | Unchanged: extends `stripe_events` (`locked_at`, `attempts int`, and the synthetic `cs:<id>` fulfilment rows), `app_settings` keys, `metadata.app='control-app'`. |
| F-09 | Legal record on cascade | Unchanged split (legal/money RESTRICT; terms/installments/links/events/notes CASCADE) — **`invoice_events.revision_id` and `invoice_client_notes.revision_id` are `on delete set null`** so a fixture deletion in FK order works (`RO-07`). |
| F-10 | Stored status on the money row | Unchanged; `invoice_incomes` gains only `installment_id`, `attempt_id`, `refund_id`, `payment_reference`. **PAID per installment = Σ amounts of rows with that `installment_id` and `paid_at`** (`consumers #6`, `payments P-25`). |
| F-11 | Promotion over HTTP inside the webhook | Unchanged: inside `quote_hire()` under the advisory lock; BR mirror recode is ladder step 3b. |
| F-12 | Hire at ACH authorization | Unchanged: `quote.hire_on = CLEARED` default. |
| F-13 | Triggers on legacy write paths tonight | Tonight: `trg_incomes_no_quote`, `trg_invoices_quote_flip`, `trg_plan_row_no_delete`, `trg_incomes_plan_guard`, `trg_append_only`, `trg_lock_presented_lines`, `trg_approval_binds_revision`, `trg_quote_links_is_test`. **Honest blast radius**: the universal clause of `trg_invoices_quote_flip` (`is_quote false→true`) touches every invoice — it refuses exactly the write C-09 forbids and nothing else; every other trigger arms only on V2 facts (a revision, an approval, an `installment_id`, an `is_test` link), which no legacy document has. A-18/A-22 assert the legacy status cycle (CLOSED→INCOMPLETE) and clearing/retyping HIRING DATE on a legacy invoice with hand-made incomes still save. |
| F-14 | C-06 broken | Unchanged: three flags + recode in one transaction. |
| F-15 | Hard-coded offset | Unchanged: `lib/orlando.ts` in Node; `orlando_today()` / `orlando_noon()` in SQL. |
| F-16/F-17 | Fee row vocabulary / importable | `nature='MONEY'`, `export_status='FRESH'`, `importIntuitiveParts` skip — **and `source='GZ28US'`, `receipt_url=[]`, `receipt_proves_payment=true` until the M2 voucher** (`rules R2-03/R2-13`, `consumers #7`). |
| F-18 | No historical rewrite | Unchanged. |
| F-19 | Owner's vocabulary | Unchanged; PAYMENT PLAN while `is_quote`, INCOMES after hire. |
| F-20 | Incomes in two places | Unchanged. |
| F-21 | Per-revision link dies | One stable token per document, **rotatable by staff at any stage (ROTATE LINK)**; the token is never readable by a JWT (column-list GRANT, `security R2-02/R2-07`). |
| F-22 | VIEWED on server render | Unchanged (beacon + UA filter + dedupe) plus the limiter — **now keyed by link and by IP hash** (`security R2-08`). |
| F-23 | Sidney sees Stripe buttons | Rails driven by `invoice_terms.rails` seeded by **payer house** (language by `clientSpeaksPortuguese(country)`, incl. ANGOLA — `rules R2-11`); **one rails vocabulary** across DDL, settings and attempts (`RO-01`). |
| F-24 | `invoice_creation` | Unchanged (never set). **D-06 rewritten honestly a second time**: Checkout collects the payer's e-mail and writes it onto the Customer; the only levers are the account-level "Customer emails" switch or a separate account; a code gate (`stripe.customer_emails_checked`) blocks live sessions until the owner has recorded the Dashboard choice (`rules R2-02`, `payments P-23`). |
| F-25 | Owner's surfaces ship last | M1 ships `/doc/[id]` with two flag-free entry points **plus EDIT IN EDITOR, a link back from E, and an ACTION NEEDED index at `/doc`** (`U2-05`, `U2-11`). |
| F-26 | Not shippable tonight | M1 is step-ordered; honest estimate now **19–23 h** (§12). |
| F-27 | Synthesized approval row | Unchanged — manual paths freeze a `RECORDED` revision first; **`recorded_by` is always the JWT e-mail** (`security R2-05`). |
| F-28 | Failed ACH leaves a DELAYED row | Unchanged (no income before CLEARED). |
| F-29 | GET with side effects | Landing POSTs; **both landing and webhook claim the same `stripe_events` row `cs:<session>`** for the fulfilment (`security R2-03`, `payments P-19`, `RO-02`). |

---

## 1. Vision & principles

1. **The quote is a page the client signs and pays on his phone** — one stable, unguessable link per document (`www.gz28us.com/ca/q/<token>`), channel-agnostic, rotatable by staff; the PDF is a download *of* the page, never the thing we send (`benchmark` §3.2).
2. **Read → sign → pay, as few interactions as the law allows.** Name pre-filled, two consents, two one-tap elections, one button that names the act and the amount; the signature binds by SHA-256 to the exact revision **and to the terms text in the signer's language**; signed copy and receipt on the same page (C-102, C-103; ESIGN/UETA, Fla. §668.50).
3. **Quote = terms; invoice = money.** A quote never holds an income (C-07, trigger). The payment plan is a terms table; it becomes `invoice_incomes` rows in the same transaction that flips `is_quote` (constraint 4) — **and only on a document that has no incomes yet** (`consumers #5`).
4. **The deposit is the hiring — when the money is confirmed, dated on the day it confirmed.** `quote_hire()` is one transaction (C-02, C-06, C-09, C-11, C-13, C-20); folders/mail/seed/PDF/BR-recode are consequences (C-79).
5. **Received money is always booked — and a refusal always leaves a trace.** `book_payment()` never returns 200 with nothing written: hire, settle, or materialize-then-settle. When it must refuse (voided document, test money on a real document, currency not the tenant's), it **writes** the attempt flip (`SUCCEEDED_UNBOOKED`) and the `PAYMENT_ANOMALY` event and **returns** `{anomaly}` — it does not raise, because a RAISE would roll those writes back (`RO-03`); it raises only on true bugs, and then the webhook answers 500 so Stripe retries (C-88). A repeat of a session already booked is `{repeat:true}`, never an anomaly (`payments P-19`).
6. **Sent = locked.** From SEND the presented lines of the live revision cannot change (C-16); to change prices the staff starts a NEW REVISION and SENDs again; after signature, a CHANGE_ORDER (M4). Inserts stay free (C-38) — and a hired document whose live grand drifts from the plan says so on both pages until the change order exists (`U2-06`).
7. **Stripe is only the rail.** Checkout Session per click, one rail per button, `automatic_tax` off (C-36), fees absorbed by default (C-90), "paid" only from a signature-verified webhook or a server-side `sessions.retrieve` under the same claim (C-88); **fulfilment is a pure function of observed states, not of event types** (`payments P-26`). **No robot ever moves client money back.** **Test money never hires a real document** (`security R2-01`).
8. **Status is derived from facts** (C-05, C-19); `live_status` unchanged (C-17); PAID per installment by Σ amounts on its `installment_id`.
9. **Nothing reaches anyone tonight.** Every *automatic* message is an `app_settings` key born `false` (constraint 10, C-68). **A staff tap on SEND BY APP is a manual act and is not a robot** — it stays available as today (`U2-02`; `view-page.md` §9.6, memory `never-send-unauthorized` 18/10 exception); tonight it is exercised only against our own fixture addresses. Test documents are muted and structurally excluded from every report.
10. **The owner's words on every screen**: QUOTE / ONLINE / CLOSED; ITEMS · SERVICES · EXPENSES · PAYMENT PLAN→INCOMES · NOTES · DUTIES; packs; SEND. One URL per document for its whole life. Phone first; one primary action per stage; **honest tap counts** (§6.7).
11. **Build on `1681ef42`**; eleven additive legacy edits, each named and justified (§9).
12. **US first, BR by `TenantConfig` + a separate templated migration** (§10 M6) — the US DDL carries no BR vocabulary; **M1–M5 are US-only by design** (`RO-16`).

---

## 2. Information architecture — every route/page

Runtime keys (`app_settings`, all `false` tonight): `quote_portal.enabled` (public page + public mutations for real links), `qi_v2.actions` (staff mutations on real documents), `qi_v2.enabled` (Header entry "QUOTES v2", M3). **A `quote_links.is_test = true` document bypasses both.** One server predicate each: `portalAllows(link) = settingOn('quote_portal.enabled') || link.is_test` in **every** `/api/q/*` handler; `actionsAllow(invoice) = settingOn('qi_v2.actions') || link?.is_test` in every `/api/doc/[id]/*` mutation (409 `{error:'V2 actions are off (qi_v2.actions)'}` otherwise) — **except `seed_terms`** (terms + plan rows, no money, no revision, no link, idempotent, cascades on REMOVE), which runs on `/doc` open regardless, so the owner's morning review of US.QT.028.1 shows its PAYMENT PLAN (`RO-09`). **Mode rule**: a PAY card and a Checkout Session exist for a real (non-`is_test`) link only when `stripeMode()==='live'` **and** `settings['stripe.customer_emails_checked'].live === true`; otherwise `/api/q/checkout` → 409 `{rail_unavailable:true, reason}` + event `RAIL_UNAVAILABLE` and the page shows the Zelle/wire sheet (`security R2-01`, `rules R2-02`).

**Staff identity** (`security R2-05`): `lib/auth.server.ts::requireStaff(req)` = `requireUser` + the user's e-mail, refusing e-mails listed in env `MACHINE_ACCOUNTS` (comma list; first entry `br-bridge@gz28us.com`); `/api/health/env` warns when the list is empty. Every `/api/doc/[id]/*` route uses it; `recorded_by`, `created_by`, `invoice_events.actor_id` are **always** the JWT e-mail, never a body field.

### 2.1 Public (login-free; `AuthGate.PUBLIC_PREFIXES += '/q/'` in the US app tonight — C-84; BR in M6)

Token custody (`security S-07`, corrected by `payments P-20`, `security R2-14`, `U2-03`, `RO-08`): the capability token appears in a URL **once** — the link itself (`GET /ca/q/<token>`). The page handler sets an **httpOnly, Secure, SameSite=Lax cookie `gz28_q_<link_id>=<token>` with `Path=/ca`** (one cookie per document, so a client with two quotes is never mis-landed). Every `/api/q/*` call sends `{link_id}` (a public, non-secret UUID) in the body and the handler reads the matching cookie **server-side** — there is no `x-q-token` header (an httpOnly cookie cannot be read by page JavaScript). Stripe's `success_url`/`cancel_url` carry **no token**: they carry `?t=<landing token>` = `<attempt_id>.<exp>.<base64url(hmac_sha256(QUOTE_GATE_SECRET, attempt_id|exp))>` (2-hour TTL, resolves the **attempt** only, never the document), so `/q/return` works with or without the cookie. Honest statement: when the cookie **is** present, `/q/return` 302s to `/ca/q/<token>?a=<attempt_id>` and the token re-enters the browser history and our access log once more — accepted and stated (`security R2-14`). Every `/q/` and `/api/q/` response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY` — `next.config.ts` `headers()` with `source: '/q/:path*'` and `'/api/q/:path*'` (**no `/ca` prefix**: `basePath` is prepended automatically, `RO-11`).

**Limiter** (`security R2-08`): `public_hits` keyed **two ways** — `(link_id, route, bucket)` and `(ip_hash, route, bucket)` with `ip_hash = sha256(daily_salt || x-real-ip)` (no raw IP at rest in the limiter). Unknown-token resolution and the layout metadata lookup count against `(ip_hash, 'resolve')` 30/h; `GET /api/q` 120/h per (link, ip); per-link budgets: view 6/h, sign 30/h, checkout 12/10 min, landing 10/h, changes 3/day, promised 3/day, renewal 1/day; per-ip budgets stay tight (sign 10/h, checkout 5/10 min). `is_test` documents bypass the per-link **keys**, never the limiter. Housekeeping deletes `public_hits` rows older than 48 h.

| Route | Shape | Shows / does |
|---|---|---|
| `app/q/layout.tsx` | server component, brand shell only | no data access |
| `app/q/[token]/layout.tsx` | **server component**, `generateMetadata` with `params: Promise<{token}>` awaited (Next 16) | title "GZ28 V8 SpeedShop — Your quote" / "— Seu orçamento" (language by a service-role lookup of the token's terms language; **no amounts, no name**), `robots: {index:false, follow:false}`, `referrer:'no-referrer'`, OG image = brand logo; counted against `(ip_hash,'resolve')` (`RO-06`) |
| `GET /ca/q/[token]` | `'use client'` page under that layout, fetching `GET /api/q` with `{link_id}`; the first server render sets the cookie | The document (§5.1) from the **revision snapshot**: hero, package, items/services/notes, totals by law, payment plan, terms (inline, expandable), APPROVE card → PAY card → CLEARING / HIRED, change-order banner, print. `?a=<attempt_id>` → the island POSTs `/api/q/landing {link_id, attempt_id}`. `?preview=1` + staff JWT → no stamps, no cookie. On in-app UAs (Messenger/Instagram/FB) a one-line "Open in your browser" hint is shown above the PAY card (`payments P-36`). |
| `GET /ca/q/[token]/print` | same component, `@media print` | Retainable copy tonight (rev n + certificate block when signed) — Fla. §668.50(8). **Print stylesheet**: light tokens, letter size, buttons/toasts hidden, company block + certificate block printed, legacy `.pi` structure reused so both papers read as one family (`U2-14`). Public certificate **masks** `signer_contact`, IP (city only) — the full certificate is the staff print from `/doc` (`security R2-07`). |
| `GET /ca/q/return?t=<landing token>` | Route Handler | Verifies the landing token (constant-time; expired → `return_no_session`). Cookie for the attempt's link present → 302 `/ca/q/<token>?a=<attempt_id>`. **No cookie** → renders the branded **`return_no_session`** page (EN/PT by the attempt's document language): "Payment received — we are confirming it. Open your quote link again to see the confirmation." It POSTs `/api/q/landing {t}` itself (the landing token authenticates the attempt), shows amount + state from the attempt (no document data), and writes event `LANDING_NO_COOKIE`. Never NOT FOUND (`U2-03`, `RO-08`, `security R2-14`). |
| `GET /api/q` | Route Handler, service role, `lib/quotePublic.server.ts` (`import 'server-only'`; **throws inside the exported functions** when `SUPABASE_SERVICE_ROLE_KEY` is missing → 503 at request time, never at module scope, `RO-12`) | DTO of the current revision + stage + plan (cents) + attempts summary (incl. PROCESSING / `verification`) + link flags + rails enabled + terms text in the document language; **never** `base_cost`, expenses, markup, `grade`, other invoices, phone/e-mail. 404 unknown/revoked; `{state:'inactive'}` when `!portalAllows`. |
| `POST /api/q/view` | `{link_id}` | VIEWED after a 3-s visibility beacon; UA filter; 30-min dedupe per link |
| `POST /api/q/gate` | `{link_id, answer}` | CONTACT gate: answer normalised (trim, lower-case, NFKC; phone → digits, last 4), constant-time hash compare; success → HMAC cookie `gz28_qg_<link_id>=<link_id>.<exp>.<hmac>` (15-min TTL, httpOnly, Secure, Lax, `Path=/ca`); fails counted per `(link_id, ip_hash)`: 5 → 15 min lock, next 5 → 1 h; per-link daily cap 25 → event `GATE_CAP` (staff notified when the key is ON) instead of locking the client (`security R2-06`, `U2-08`) |
| `POST /api/q/sign` | `{link_id, revision_id, sha256, terms_sha256, signer_name, consents:{erecords, terms, estimate:'REQUEST'|'LIMIT'|'WAIVE', limit_amount?, parts_return:'RETURN'|'INSPECT'|'NONE'}, signature_png?}` | §5.2; requires a valid gate cookie when the link has a gate; **recomputes the terms hash from `lib/quoteStrings.ts` for `terms.language` and refuses a mismatch (`err_stale`)** (`U2-10`, `rules R2-11`); `LIMIT` without `limit_amount` → 400 `err_limit` (`U2-13`); `quote_approve()`; PNG ≤ 200 KB, magic bytes + dimensions, metadata stripped |
| `POST /api/q/checkout` | `{link_id, seq, rail}` | Requires approval on the live revision; `rail ∈ terms.rails ∩ settings['payments.rails_enabled']` (**same vocabulary**, `RO-01`); mode rule above; amount/label/`paid_to`/`fee_policy` **only from the approved revision's `document.installments[seq]` (integer cents)**; **refused on the last installment while `grand(live) ≠ Σ plan cents`** (page shows `balance_pending_update`, `U2-06`); returns the OPEN attempt's `url` or mints one via the SECURITY DEFINER `attempt_open()` which re-reads `revoked_at`, `live_revision`, approval **under the invoice row lock** (`security R2-04`); an OPEN attempt with `expires_at < now()` is set EXPIRED and a **new attempt row** is inserted and minted (`security R2-09`, `payments P-21`); activation error → 409 `{rail_unavailable:true}` + event |
| `POST /api/q/landing` | `{link_id, attempt_id}` or `{t}` | attempt must belong to this link (or be named by a valid landing token) and be OPEN/PROCESSING/SUCCEEDED; claims `stripe_events` row **`cs:<checkout_session_id>`** (the one fulfilment claim shared with the webhook) → `fulfillCheckout(cs)` → returns the stage or `{state:'landing_pending'}` — **never a 500 to the client** (`rules R2-15`) |
| `POST /api/q/promised` | `{link_id, seq, method, note?}` | PAYMENT_PROMISED (never money, C-62) |
| `POST /api/q/changes` | `{link_id, text ≤ 1000}` | Row in `invoice_client_notes`; event CHANGES_REQUESTED `{note_id}`; one open per revision |
| `POST /api/q/decline` · `/decline-withdraw` | `{link_id, reason:'TIMING'|'SCOPE'|'OTHER', text?}` | Two-step sheet; event DECLINED `{note_id}` / DECLINE_WITHDRAWN (`U2-18`: no "Price" chip) |
| `POST /api/q/renewal` | `{link_id}` | EXPIRED only; event RENEWAL_REQUESTED; 1/day (`U2-13`) |
| `GET /api/q/pdf?rev=n&signed=1` · `GET /api/q/receipt/[attempt_id]` | M2 | vector PDF / receipt from the private bucket; **behind the CONTACT gate when the link has one** (`security R2-07`) |
| `POST /ca/api/stripe/webhook` | exists | handlers in `lib/stripeEvents.server.ts` (§7.1) |

### 2.2 Internal (login; `'use client'`; dark house look C-94)

| Route | Milestone | Shows / does |
|---|---|---|
| `/ca/doc/[invoiceId]` | M1 shell → M3 full | **THE document page.** Header card: display code via `displayCode()` (`.QT.` normalised for project-car quotes, `consumers #10`; + "formerly US.QT.028.1 until {hire date}" for 30 days after hire, `rules R2-12`), car (nickname only after hire, C-15), client, **`live_status` pill hidden while `is_quote`** (`U2-15`), stage chip, grand total by law, received/open, PROMISED TO (C-23); **red chips**: "unsent changes" (presented drift), "balance ≠ plan (+US$ x)" (`U2-06`, `rules R2-17`), "signed total ≠ live total" (`consumers #4`). **Stage-driven ACTION BAR** (phone: one primary + one secondary + `⋯`): DRAFT → **SEND** · PLAN & TERMS · ⋯ · SENT/VIEWED → **COPY LINK** · NEW REVISION · ⋯ · SIGNED → **RECORD DEPOSIT** · COPY PAY LINK · ⋯ · EXPIRED → **EXTEND** · SEND · ⋯ · INVOICE → **RECORD PAYMENT** · COPY PAY LINK · ⋯. `⋯` always holds **EDIT IN EDITOR →** (`/rides/[id]/invoices/edit/[invoiceId]?from=doc`), PRINT, EXTEND, PLAN & TERMS, **UNLOCK GATE**, **ROTATE LINK**, VOID (`U2-11`, `U2-08`, `security R2-07`). VOID = confirm sheet (type the **number** only, e.g. `028`, or hold 2 s — `U2-17`); EXTEND = +7/+15/+30 chips with date preview. Tabs **ITEMS · SERVICES · EXPENSES · PAYMENT PLAN (→ INCOMES after hire) · NOTES · DUTIES · ACTIVITY**. M1: header + bar + PLAN & TERMS sheet + PAYMENT PLAN (editable while DRAFT) + ACTIVITY + preview; **the non-editing tabs render a read-only summary (count + total) with the EDIT IN EDITOR link — never empty** (`U2-11`); full editing tabs M3. ACTIVITY collapses SYSTEM/STRIPE events under "▸ system (n)"; the hash is shown only on the certificate (`U2-15`). Opening a quote with no terms/plan **lazily seeds** them (`seed_terms`, exempt from `actionsAllow`). |
| `/ca/doc?code=US.QT.028.1` | M1 | resolver → `/doc/[id]`: live code first (display form normalised), then "formerly" matches from `invoice_events HIRED.old_code` listed as a second row with the hire date (`rules R2-12`) |
| `/ca/doc` (no code) | M1 | **ACTION NEEDED index** (`U2-05`): every document with a live revision, grouped SIGNED · awaiting deposit → CLEARING → CHANGES / DECLINED / RENEWAL REQUESTED → VIEWED → SENT → EXPIRING, one line each from `quoteStage()` + last event time (one query over `invoice_events` + `invoice_revisions`); search box on code/name/car |
| `/ca/doc/[invoiceId]/preview` | M1 | the public component in a phone frame, no stamps |
| legacy `V` header | M1 | one `<Link>` **OPEN IN V2 →**; when a revision exists, PRINT shows "signed/sent rev n differs — print from /doc" |
| legacy `E` banner | M1 | carries a `<Link>` back to `/doc/[id]`; `?from=doc` makes SAVE & EXIT return to `/doc` (`U2-11`, `U2-17`) |
| `/ca/quotes` (rebuilt) | M2 | C-93 list: `QUOTES (n)` + **search (name/code/car)** + green `+ NEW QUOTE` on the top line; chips below as **three groups + ALL** — **NEEDS ME** (SIGNED · CLEARING · CHANGES · DECLINED · RENEWAL · EXPIRING) · **WAITING** (SENT · VIEWED) · **DONE/OLD** (EXPIRED · VOID); zero-count chips hidden; horizontally scrollable fallback; the fine stage on the card line (`U2-12`). Card = code · client · car · grand · stage line `SENT 2h (Messenger) · 👁 opened 2h ago · last seen 12 m ago · ✍ —`. **Sort key = staff/system writes + every first-of-kind client event (VIEWED, SIGNED, CHANGES_REQUESTED, DECLINED, PAYMENT_PROMISED, RENEWAL_REQUESTED, DEPOSIT_*); only repeated VIEWED beacons never reorder** (`U2-05`). |
| `/ca/invoices` (rebuilt) | M3 | as v1 |
| `/ca/doc/new` | M3 | as v2 (duplicate copies unpaid forecast expenses with the listed fields nulled/refreshed) |
| `/ca/adm/notifications` | M4 | one row per key; **QUOTE FLOW (not money)** group for `notify.reports.quote_*` |
| `/ca/adm/payments` | M5 | attempts · events (REPLAY) · payouts · refunds (**REFUND is here, staff-only; amount field hidden for `us_bank_account`**) · disputes · unlinked Stripe incomes · `is_test` artefacts · stale PROCESSING |
| `/ca/adm/check` (Data Checker) | M1 cards | `closed-with-open-plan` (`rules R2-05`), `signed-total-drift` (`consumers #4`, `rules R2-09`), `plan-sum-drift` (`rules R2-17`); the existing `paid-no-receipt` card lists fee rows until the M2 voucher (not special-cased away, `rules R2-03`); the existing `paid-no-bank` card lists Stripe rows honestly until `payout_id` is matched (`payments P-31`) |

### 2.3 Internal API (all `requireStaff`, fail closed — C-86; all mutations through `actionsAllow` except `seed_terms`)

| Route | Does |
|---|---|
| `POST /api/doc/[id]/send` `{channel, sent_to, valid_days?, already_approved?:{method, signer_name, note}, send_by_app?:boolean}` | Readiness gate (§6.2) + content lint → `quote_send()`: revision n (snapshot with line ids + installments in integer cents, `sha256`, `presented_sha256`, **`terms_sha256` of the terms text in the document language**), previous revision superseded, link minted once, `valid_until = orlando_today() + valid_days`, event SENT `{channel}`, `sent_to` recorded (masked in UI); **409 while an attempt is OPEN/PROCESSING; 409 when an approval exists**. **`already_approved`** → `quote_approve(SHOP_*, recorded_by = JWT e-mail)` in the same request and the returned `{url, text}` is the **pay** text (one sheet, one paste — `U2-07`). **`send_by_app`** (WhatsApp / E-mail) → the manual send through `/api/whatsapp` (document message, client language, ® signature by the route, C-67) or `/api/mail/client` kind `quote-link` — **always available to a human staff tap; not keyed** (`U2-02`); event SENT `{channel, by_app:true}`. |
| `POST /api/doc/[id]/revision` `{kind:'QUOTE'}` | **NEW REVISION**: supersedes the live revision under the invoice row lock; refused when an approval exists; returns `{editor_url:'/rides/[rid]/invoices/edit/[id]?from=doc'}` so the UI goes straight to E. `{kind:'CHANGE_ORDER'}` M4. |
| `GET /api/doc/[id]/link` | the stable URL (service role reads the token; a JWT never can) — COPY LINK / COPY PAY LINK (`?seq=k` anchor); writes event `LINK_COPIED {actor}` (`security R2-05`) |
| `POST /api/doc/[id]/rotate` | **ROTATE LINK**: new token, old `revoked_at = now()`, cookies for the old link id invalid, event LINK_ROTATED `{actor}`; any stage incl. INVOICE (`security R2-07`) |
| `POST /api/doc/[id]/gate-unlock` | clears `gate_locked_until` / fail counters for the link; event GATE_RESET `{actor}` (`U2-08`, `security R2-06`) |
| `POST /api/doc/[id]/plan` `{installments[], terms{}}` | PLAN & TERMS sheet; refused once a live revision exists; **the sheet names the missing field** (`due_date` for DATE, `net_days` for NET_DAYS — `rules R2-16`) |
| `POST /api/doc/[id]/approve-manual` `{method, signer_name, note, evidence_url?}` | freezes `RECORDED` revision if none → `quote_approve()` with `recorded_by = JWT e-mail` (C-101) |
| `POST /api/doc/[id]/deposit-manual` `{seq?, income_id?, amount, source, paid_to, amount_brl?, paid_on, receipt_url?, receipt_kinds?, approval?}` | **whitelist only** — `livemode`/`reported_at`/mute computed server-side; `paid_on ∈ [today−90 d, today]`; expires every OPEN Stripe session of the invoice first; freezes `RECORDED` revision if none; attempt (provider ZELLE/WIRE/CASH/CHECK/PIX_BR; `installment_id` nullable for non-Stripe providers) → `book_payment()`. **On a document that already has non-plan incomes** (legacy, SHOP): no materialization; the sheet lists the open incomes (default: oldest unpaid) and settles the picked one, or inserts one ad-hoc paid row (`consumers #5`). `source in ('CASH','OTHER')` above `settings['deposit.manual_cap']` (US$ 10,000) requires `receipt_url` (`security R2-05`). **Receipt-first** sheet (`/api/scan-receipt` mode `payment`). |
| `POST /api/doc/[id]/extend` `{days}` | `invoice_terms.valid_until += days` under the row lock; event EXTENDED |
| `POST /api/doc/[id]/void` | **sets `revoked_at` first (under the row lock), then** expires OPEN sessions; event VOIDED (`security R2-04`) |
| `POST /api/doc/[id]/notes/[noteId]` `{hidden:true}` | staff hides a client note |
| `GET /api/doc/[id]/preview` | DTO for the phone frame |
| `POST /api/cron/docs-housekeeping` (hourly) | EXPIRED at `valid_until` (expires OPEN sessions, under the row lock); retries failed `SIDE_EFFECT`; **expires only `status='OPEN' and expires_at < now()` attempts — PROCESSING is never expired by time; PROCESSING older than 10 calendar days → `PAYMENT_ANOMALY {stale_processing}` + owner alert key** (`payments P-27`); re-queues stale `stripe_events` PROCESSING (> 2 min) **and re-runs `status='ERROR'` rows younger than 72 h through the same claim, bounded by `stripe_events.attempts ≤ 5`; `notify.owner.payment_anomaly` on the 3rd failure** (`RO-10`); trims `stripe_events.payload` after 90 days; deletes `public_hits` older than 48 h; **auto-cleanup of `is_test` hires older than 2 h unless `settings['test.keep']` by calling `fixture_delete()`** (`RO-07`); lists every `is_test` link for the morning note and auto-revokes those older than 24 h regardless of `test.keep` (`security R2-12`) |
| `GET /api/cron/daily-report?dry=1` | M1: builds the body, sends nothing |
| `POST /api/stripe/payouts/sync` | M5 |

---

## 3. Lifecycle & state machine

### 3.1 Two orthogonal axes, nothing stored as a status (C-05, C-17, Q-01)

- `invoices.live_status` ∈ {INCOMPLETE, REALTIME (ONLINE), CLOSED} — unchanged, with its gates (C-18). Quotes stay INCOMPLETE; the two REALTIME quotes are listed for the owner (D-11).
- **Stage** = `quoteStage(doc)` in `lib/quoteStage.ts` (pure, shared). "Live revision" = the newest non-superseded revision with `kind in ('QUOTE','CHANGE_ORDER')`; `LEGACY_BACKUP` rows are ignored.

```
stage(doc):
  link.revoked_at                                        → VOID                       -- evaluated first
  not is_quote and no live revision and no approval      → INVOICE (legacy or hand-made)
  not is_quote                                           → INVOICE · deposit_state()
  approval on live revision ∧ attempt PROCESSING         → SIGNED · DEPOSIT CLEARING (+ verification='microdeposits' copy)
  approval on live revision ∧ attempt OPEN               → SIGNED · DEPOSIT PENDING
  approval on live revision ∧ latest attempt FAILED      → SIGNED · DEPOSIT FAILED
  approval on live revision                              → SIGNED
  no live revision ∧ a superseded revision exists        → DRAFT · "new version pending" (client page: SUPERSEDED)
  terms.valid_until < orlando_today() ∧ no approval      → EXPIRED (client: ask_renewal button)
  event DECLINED after live revision, not withdrawn      → DECLINED
  open CHANGES note after live revision                  → CHANGES REQUESTED
  link.first_viewed_at ≥ live revision.created_at        → VIEWED
  live revision exists                                   → SENT (rev n)
  else                                                   → DRAFT
  + staff chips: "unsent changes" (presented_sha256 drift) · "balance ≠ plan" (hired ∧ round(grand(live)×100) ≠ Σ plan cents)
                 · "signed total ≠ live total" (approval ∧ |revision.grand_total − invoiceMoneyFor(live)| > 0.005)

deposit_state(invoice): plan row seq 1 → incomes with installment_id = seq1.id:
  Σ amount of rows with paid_at ≥ plan amount − 0.01    → DEPOSIT RECEIVED
  Σ paid rows > 0 ∧ Σ < plan amount − 0.01 (refund/dispute row present) → DEPOSIT REFUNDED (hire stands, C-09; PAY returns for seq 1)
  attempt PROCESSING (hire_on=AUTHORIZED only)           → DEPOSIT CLEARING
  latest attempt FAILED, no paid row                     → DEPOSIT FAILED
  per installment k: PAID ⇔ Σ amount over incomes (installment_id = k.id, paid_at not null) ≥ k.amount − 0.01
                     — refund and dispute rows carry the installment_id they reverse (consumers #6, payments P-25)
```

The client page never hides SIGN/PAY because of staff drift. Buttons disappear only on EXPIRED (replaced by `ask_renewal`), VOID, SUPERSEDED, DECLINED (until withdrawn), by state after signature/hire, **and PAY is hidden on the last installment while "balance ≠ plan" is red and while an attempt is PROCESSING** (`U2-06`, `U2-13`).

### 3.2 Transitions

| # | From → To | Trigger | Writes | Side effects (keys OFF) |
|---|---|---|---|---|
| T0 | (none) → DRAFT | staff: legacy NEW tonight / `/doc/new` M3; **lazy seed on first `/doc` open or SEND** (exempt from `qi_v2.actions`) | `invoice_terms` + `invoice_installments` seeded **by payer house and language**: `language = clientSpeaksPortuguese(country) ? 'pt' : 'en'` (BRAZIL, ANGOLA → pt); `consent_version = 'terms-'||language||'-v1-2026-11'`; USA/other → 50/50 `GZ28US`, rails `{us_bank_account,card,ZELLE,WIRE}`; BRAZIL → 50/50 `GZ28BR`, rails `{PIX_BR}`; ANGOLA → `GZ28US`, rails `{card,WIRE}` (`rules R2-11`, `RO-01`). **Never writes `invoice_installments` on an `is_quote=false` document that already has any `invoice_incomes` row** (`consumers #5`). Event CREATED. | — |
| T1 | DRAFT → SENT (rev n) | staff: SEND (optionally `already_approved`, `send_by_app`) | `quote_send()` under the invoice row lock; `valid_until` reset; `sent_to`; lock active on the frozen line ids; `already_approved` → `quote_approve(SHOP_*)` in the same request | manual `send_by_app` (not keyed); `notify.reports.quote_sent` (robot) |
| T1' | SENT/VIEWED → DRAFT · new version pending | staff: NEW REVISION | live revision `superseded_at = now()` under the row lock; event REVISION_SUPERSEDED; lock lifts; refused when an approval exists or an attempt is OPEN/PROCESSING | — |
| T2 | SENT → VIEWED | client beacon | event VIEWED `{ip (platform header), ua_class}`; link timestamps | `notify.reports.quote_viewed` (first per revision) |
| T3 | VIEWED → CHANGES REQUESTED | client | `invoice_client_notes` row; event `{note_id}` | `notify.reports.changes_requested` (**no client text**) |
| T3' | VIEWED → DECLINED / back | client two-step sheet / "I changed my mind" | note + event DECLINED `{note_id}` / DECLINE_WITHDRAWN | `notify.reports.quote_declined` |
| T3'' | EXPIRED → (renewal asked) | client `ask_renewal` | event RENEWAL_REQUESTED (1/day); shows in the ACTION NEEDED index | `notify.reports.renewal_requested` |
| T4 | SENT/VIEWED → SIGNED | client APPROVE & SIGN (gate cookie when gated) | `quote_approve()` under the row lock → `invoice_approvals` (`revision_id`, `document_sha256`, `consent_version` per language, `consent_text_sha256` recomputed server-side, consents, elections, `signer_name` Unicode-sanitized + `consents.signer_name_sha256` of the raw typed value (`security R2-13`), `signer_contact = revision.sent_to`, `ip`, `attribution {gate_tier, xff[], country, city, ua_class}`, UA); `invoice_terms.disclosure_choice/parts_return_choice`; event SIGNED | `notify.client.signed_copy`; `notify.reports.quote_signed` |
| T4' | → SIGNED (shop-recorded) | staff RECORD APPROVAL or SEND with `already_approved` | RECORDED revision if none; `method ∈ SHOP_*`, `recorded_by = JWT e-mail`, `note`, `evidence_url` | — |
| T5 | SIGNED → DEPOSIT PENDING | client PAY (live mode only on real links) | `attempt_open()` → `payment_attempts` OPEN (`revision_id`, `seq`, `amount_cents`, rail, session, `expires_at` = session expiry (24 h), `livemode`, `return_nonce` not needed — the landing token is HMAC); event CHECKOUT_OPENED | redirect |
| T6 | DEPOSIT PENDING → **INVOICE · DEPOSIT RECEIVED** (card) | `fulfillCheckout` observes `payment_status='paid'` ∧ attempt ∈ {OPEN, PROCESSING} (from `checkout.session.completed` or landing) | `book_payment()` → `quote_hire()` (§3.3) with `p_money` {amount_cents, currency, source 'STRIPE', paid_on = Orlando day of `charge.created`, fee/net/txn, method, last4, `account_holder_type`, livemode}; attempt OPEN→SUCCEEDED **inside**; fee row **inside** (live only); events HIRED + DEPOSIT_RECEIVED **inside** | ladder §3.4; `notify.client.deposit_received`; `notify.reports.deposit_received` |
| T6a | DEPOSIT PENDING → DEPOSIT CLEARING (ACH) | `payment_status='unpaid'` ∧ `pi.status='processing'` ∧ attempt OPEN | CLEARED: attempt PROCESSING (`authorized_at`, PI id); event DEPOSIT_AUTHORIZED; **no invoice change, no income**. `pi.status='requires_action'` with `verify_with_microdeposits` → PROCESSING with `verification='microdeposits'` (own copy, `payments P-30`). AUTHORIZED (owner's flip): `quote_hire()` with `paid_at null` | `notify.client.deposit_clearing`; `notify.reports.deposit_clearing` |
| T7 | CLEARING → INVOICE · DEPOSIT RECEIVED | `async_payment_succeeded` (observed `paid` ∧ PROCESSING) | CLEARED: `quote_hire()` as T6 with **`paid_on = Orlando day of the event`** (settlement = the cash event, C-58); `hiring_date` = same day. AUTHORIZED: `income_settle()` | as T6 |
| T8 | CLEARING → SIGNED · DEPOSIT FAILED | `async_payment_failed` (observed) | attempt FAILED (`failure_code`; `verification_timeout` for microdeposits); event; CLEARED: PAY card returns (a **new** attempt per tap); AUTHORIZED: hire stands (C-09) | `notify.client.deposit_failed`; `notify.owner.payment_failed` |
| T9 | DEPOSIT PENDING → SIGNED | `checkout.session.expired` / housekeeping (OPEN only) / inline at next tap | attempt EXPIRED; the next PAY tap inserts a new attempt | — |
| T10 | SENT/VIEWED/SIGNED → EXPIRED | housekeeping `valid_until < orlando_today()` ∧ no approval | event EXPIRED; OPEN sessions expired at Stripe | `notify.reports.quote_expiring` (7 d), `notify.client.quote_expiring` (3 d) |
| T11 | EXPIRED → SENT | staff EXTEND (no revision) or SEND (new revision) | `valid_until` | — |
| T12 | any → VOID | staff VOID | `revoked_at` **first** (row lock), then OPEN sessions expired; event; `book_payment` on this document → attempt SUCCEEDED_UNBOOKED + PAYMENT_ANOMALY `{voided}`, **returned** (money stays in Stripe for a staff refund) | `notify.owner.payment_anomaly` |
| T12' | staff ROTATE LINK | any stage | new token; old `revoked_at`; event LINK_ROTATED | — |
| T13 | INVOICE → change order pending | staff NEW REVISION kind CHANGE_ORDER (M4) | rev n+1 `delta`; below the §559.909 band staff may RECORD APPROVAL | `notify.client.change_order` |
| T14 | → applied | client signs rev n+1 | `change_order_apply()` under the GUC discipline; plan last row absorbs; the "balance ≠ plan" chip clears | — |
| T15 | installment k due | `payment_date ≤ today` or milestone | DELAYED robot: legacy rows unchanged; **plan rows (`installment_id` not null) only when `notify.reports.installment_delayed` is ON** (`consumers #9`); page shows PAY (not on the last row while "balance ≠ plan"); webhook → `book_payment()` → `income_settle()` by `installment_id` | `notify.client.installment_due` |
| T15' | payment for an installment already paid | webhook | applied to the **next unpaid installment**, event PAYMENT_ANOMALY `{applied_to_seq}`; none open → ad-hoc income "Overpayment — hold"; **never `refunds.create`** | owner alert |
| T16 | refund | card: `charge.refunded` is the **trigger**; the handler calls `stripe.refunds.list({charge})` and books one negative row per `re_…` with `status='succeeded'` not yet in `invoice_incomes.refund_id` (the event payload carries no `refunds[]` on this API version, `payments P-24`); bank: `refund.updated status='succeeded'`; `refund.failed` → reversing row | attempt resolved by `charge_id`/`payment_intent_id` (no match → IGNORED, shop charge); `attempt.income_id null` → event only; else **negative row carrying the refunded row's `installment_id`**, `paid_at` = event day, `description` "Refund — {plan label}"; `refund.failed` → positive reversing row `refund_id = re_…:reversal`; fee row stays; stage → DEPOSIT REFUNDED when Σ falls below the plan | `notify.owner.refund` |
| T17 | dispute | `charge.dispute.created/updated/funds_withdrawn/funds_reinstated/closed` | events + Orlando deadlines **and, in M1**: `charge.dispute.created` → negative income row `refund_id = 'dp_<id>'`, same `installment_id`, `paid_at` = event day; `funds_reinstated` / `closed status='won'` → reversing row `refund_id = 'dp_<id>:reinstated'` (`payments P-22`); ACH/dispute fees as MONEY rows M4 | `notify.owner.dispute`; **structural DISPUTE line in the Daily Mega-Report (no key)** |
| T18/T19 | cancellation before/after hire | as v1; refund only via `/adm/payments` (staff) | — | — |

### 3.3 `book_payment()` and `quote_hire()` — the one transaction

`book_payment(p_attempt uuid, p_money jsonb, p_actor text) returns jsonb`, `SECURITY DEFINER`, `set search_path = public`, `revoke all … from public, anon, authenticated; grant execute … to service_role`. Called only by `lib/stripeEvents.server.ts::fulfillCheckout` (webhook and landing, both after the `cs:<session>` claim) and by `/api/doc/[id]/deposit-manual`. **It returns `{anomaly}` for business refusals and raises only on bugs** (`RO-03`).

```
book_payment:
 0. perform id from invoices where id = (select invoice_id from payment_attempts where id = p_attempt) for update;   -- invoice row lock (security R2-04)
    perform pg_advisory_xact_lock(hashtext('attempt:' || p_attempt))
 1. select attempt … for update; link := quote_links of invoice (non-revoked, or the revoked one if none live)
 1a. repeat detection (payments P-19, security R2-03):
       if attempt.status = 'SUCCEEDED' and attempt.income_id is not null
          and (attempt.checkout_session_id = p_money->>'checkout_session_id' or attempt.payment_intent_id = p_money->>'payment_intent_id')
          → return {income_id, repeat:true}                                           -- benign; no event, no anomaly
       if attempt.status = 'SUCCEEDED'  (different session/PI)
          → event PAYMENT_ANOMALY{replay}; return {anomaly:'replay'}                   -- true replay; nothing booked
       require status in ('OPEN','PROCESSING') or (status='EXPIRED' and (p_money->>'payment_status')='paid')   -- booked_after_expiry (P-27)
 1b. refusals that WRITE then RETURN (never raise):
       link.revoked_at is not null           → attempt 'SUCCEEDED_UNBOOKED'; event PAYMENT_ANOMALY{voided};             return {anomaly:'voided'}
       (p_money->>'livemode')='false' and not link.is_test
                                             → attempt 'SUCCEEDED_UNBOOKED'; event PAYMENT_ANOMALY{test_money_on_live_doc}; return {anomaly}   (security R2-01)
       p_money->>'currency' <> tenant currency ('usd')
                                             → attempt 'SUCCEEDED_UNBOOKED'; event PAYMENT_ANOMALY{currency};           return {anomaly}   (payments P-33, variant)
     muted := link.is_test                                                            -- mute is a DOCUMENT property; livemode=false on a real doc is refused above
 2. if invoices.is_quote → return quote_hire(invoice, attempt, p_money, muted, p_actor)
 3. else (already an invoice — legacy HIRING DATE, RECORD DEPOSIT, SHOP, or a later installment):
      if attempt.installment_id is null (non-Stripe manual on a document without a plan):
           target := p_money->>'income_id' (an open income of this invoice) or insert one ad-hoc paid row; skip materialization   (consumers #5)
      else:
        inst := plan row of attempt.installment_id
        if the invoice has ZERO invoice_incomes rows → materialize the plan rows now (same loop as quote_hire step 7)   -- never on top of hand-made rows
        target := income with installment_id = inst.id and paid_at is null
        if none → target := next unpaid plan row; if none → insert ad-hoc income 'Overpayment — hold'; anomaly := true (T15')
      perform income_settle(target.id, p_money, p_attempt, muted)
      update attempt set status='SUCCEEDED', income_id=target.id, succeeded_at, charge_id, payment_intent_id, balance_transaction_id, fee, net, method_type, method_last4, account_holder_type
      if not muted and p_money ? 'fee' → insert fee expense (§7.4) once (unique index)
      events INSTALLMENT_RECEIVED (+ PAYMENT_ANOMALY when anomaly)
      return {income_id, anomaly}
 4. assert returned income_id is not null when no anomaly, else raise                 -- a bug, not a business case → 500 → Stripe retries
```

`quote_hire(p_invoice, p_attempt, p_money, p_muted, p_actor)` (internal to `book_payment`, also REVOKEd):

```
 1. invoice already locked by book_payment; require is_quote
 2. require an invoice_approvals row bound to attempt.revision_id (the revision the client paid against);
    if a newer unsigned revision exists → superseded_at = now(), event REVISION_DROPPED
 3. perform pg_advisory_xact_lock(hashtext('ride_codes'))
 4. if ride_id is not null and rides.is_quote:                                         -- a quote on a PROJECT car keeps its code; only is_quote flips (consumers #10)
      new_code := alloc_ride_code('US')     -- lowest free on the US/SC/WV scale; pinned never released or reused
      update rides set project_code=new_code, is_quote=false, updated_at=now()
      update invoices set invoice_code = new_code || substr(invoice_code, length(old_code)+1)
         where ride_id = ride and invoice_code like old_code || '.%'
      data_fixes per recoded row (check_key 'quote-hire')
 5. if clients.is_quote: client_number := max+1 over (origin, is_quote=false); is_quote=false; data_fixes row
      if ride_id is null: recode every invoice of the client where invoice_code like oldPad || '.%'; data_fixes per row
 6. set_config('gz28.hire', <run nonce>, true)
    update invoices set is_quote=false, hiring_date=paid_on, client_hiring_date = case when ride_id is null then paid_on end,
       live_status='REALTIME', feed_status='REAL_TIME', updated_at=now()
 7. materialize the plan from the APPROVED revision's document.installments (cents):
      insert invoice_incomes (invoice_id, amount = cents/100.0, description = label in the client's language,
         payment_date = due_date | hired_on (ON_APPROVAL) | hired_on + net_days (NET_DAYS), date_label = ARRIVAL|CONCLUSION (C-60),
         paid_to, installment_id, paid_at null, reported_at = case when p_muted then now() end, created_at=now(), updated_at=now())
      seq k = attempt.seq ← income_settle(...)  (paid_at = orlando_noon(paid_on), source, amount_brl, attempt_id, payment_reference 'stripe:<ch>')
    update attempt set status='SUCCEEDED', income_id, succeeded_at, charge facts
    if not p_muted and p_money ? 'fee' → insert fee expense row (§7.4)
 8. insert quote_backups (legacy snapshot, C-10)
 9. events HIRED {old_code, new_code, attempt_id, revision_id, plan:{n, amounts}, test}, DEPOSIT_RECEIVED
10. return {old_code, new_code, invoice_code, income_id, client_number}
```

`income_settle(p_income, p_money jsonb, p_attempt uuid, p_muted boolean)` — the only way to stamp `paid_at` on a plan row (`where paid_at is null`; enforced by `trg_incomes_plan_guard`, `security R2-11`); sets `source`, `paid_to` (if given), `amount_brl`, `receipt_url/receipt_kinds` (manual receipts only — never Stripe's hosted URL), `attempt_id`, `payment_reference` (`'stripe:<ch>'`, `'zelle:<conf>'`), `reported_at` (muted → now()), **`updated_at = now()` explicitly**; **never touches `description`** (the plan label the client signed, `consumers #11`); never deletes. Used by `book_payment`, RECORD PAYMENT, and the Zelle watch from tonight (§9 #3).

`attempt_open(p_link, p_seq, p_rail, p_livemode) returns payment_attempts` — SECURITY DEFINER: invoice row lock; re-reads `revoked_at`, `live_revision`, approval, the "balance ≠ plan" condition for the last seq; expires an OPEN attempt past `expires_at` (status EXPIRED); inserts the new OPEN row (one-open index); returns it. Node then calls `sessions.create` with `idempotencyKey = attempt.id` and writes `checkout_session_id/url/expires_at` back (`security R2-04/R2-09`).

Why not `POST /api/rides/renumber` — unchanged (L-02, `r1 R1-18`).

### 3.4 Consequences after commit (C-79, C-80, C-81, C-77, C-53) — skipped when `is_test`

`hireQuote()` runs the ladder with `after()`; each step = `invoice_events SIDE_EFFECT{step, status, reason}`; `docs-housekeeping` retries `failed`. When `quote_links.is_test`: steps 1, 2, 3, 3b, 5, 5b are `skipped: test`.
1. `/api/ride-folder {action:'create'}`.
2. `/api/ride-folder {action:'invoice-folder'}` + `{action:'invoice-receipts'}` per recoded invoice.
3. `ensureRideMailFolders([{code, name}])`.
3b. `lib/renumberBR.server.ts::recodeCommonCar(oldCode, newCode)` — the BR block of the renumber route extracted; without `SUPABASE_BR_SERVICE_ROLE_KEY` → `failed` and the card says so.
4. `/api/performance/seed-pack {invoiceId}`.
5. M2: upload signed PDF, certificate, **client receipt PDF** into `Invoices/<code> - <service>/` (C-53 naming, hash dedupe).
5b. **M2 — Stripe fee voucher** (`rules R2-03`, `consumers #7`): `balance_transactions.retrieve(txn)` + the charge facts → one PDF "Stripe fee voucher — <txn> — fee US$ x.xx on US$ y" into `Invoices/<code> - <service>/` named `<code> <car> - Stripe <txn>.pdf`, hash-deduped, uploaded to the `expense-receipts` bucket; the storage URL is written into the fee row's `receipt_url` (kind `STRIPE_RECEIPT`). Until then the fee row has `receipt_url=[]` and the Data Checker lists it as proof pending.
6. Notifications per keys; OFF → `NOTIFY_SKIPPED{key, reason}`; muted → `NOTIFY_SKIPPED{reason:'test'}`.

### 3.5 Versions, expiry, change orders, installments, cancellation
- Every SEND = immutable revision; NEW REVISION supersedes the live one; the public URL is stable (rotatable by staff).
- Signature binds `(revision_id, sha256, terms_sha256)`; `trg_approval_binds_revision` enforces live revision, unexpired, hash equality, one per revision, `CLIENT_ESIGN → link_id not null and recorded_by null`.
- Validity: `invoice_terms.valid_until = orlando_today() + valid_days` at every SEND; EXTEND adds days; printed "valid until {date}" (+ "(extended on {date})").
- Lock: from SEND on the frozen line ids; inserts free (C-38); `cancel_status` free (estorno law); `invoice_installments`, `invoice_terms(rails, fee_policy)` **and `invoices(fl_tax_override, global_discount)`** locked while a live revision exists (`consumers #4`); PLAN & TERMS edits need NEW REVISION.
- **Drift windows stated** (`U2-06`, `rules R2-17`): a hired document whose `round(grand(live)×100) ≠ Σ plan cents` (estorno, inserted line) shows the red chip on `/doc` and `balance_pending_update` on the public page; PAY on the last installment is hidden; RECORD PAYMENT accepts any amount; M4's change order restores PAY. After signature, **the approved revision's `grand_total`, `fl_tax`, `fl_tax_status` are the truth for money consumers**: M3's `lib/money.ts` re-host reads them first and falls back to `invoiceMoneyFor` only when no approval exists; tonight the Data Checker card `signed-total-drift` shows the gap (`consumers #4`, `rules R2-09`).
- Installments: `due_rule ∈ ON_APPROVAL · ON_ARRIVAL · ON_CONCLUSION · DATE · NET_DAYS`; **CHECKs: DATE needs `due_date`, NET_DAYS needs `net_days`, ON_ARRIVAL/ON_CONCLUSION need the matching `label_key`** (`rules R2-16`). Amounts frozen as integer cents at SEND, last row absorbs, Σ cents = round(grand×100). Labels `label_key` + optional `label`, printed and written in the client's language.
- GROSS_UP (D-02, off by default): the installment income is written at X (plan untouched) and the recovered surcharge is booked as a **negative MONEY expense against the fee row** (`item='Stripe processing fee — recovered from client'`, `price = −surcharge`, `order_number = <txn>:rec`), the house "refund = negative line" convention (C-40) — never a synthetic income (C-32) nor an automated service line (C-43) (`rules R2-08`). The formula `(X+30)/0.971` assumes a domestic card; international (+1.5 %) and conversion (+1 %) fees leave the recovered line short — the row's description states "recovered US$ a of US$ b" from `balance_transaction.fee` (`payments P-34`). FL-tax treatment of a surcharge is a counsel question (D-02).

---
## 4. Data model

### 4.1 New tables (DDL sketch)

Migration `MIGRATION_quote_portal_core.sql` **wrapped in `begin; … commit;`**, rollback file, run via `scripts/roda-sql.mjs`, shown inline, trailed in `data_fixes` (C-98). **GRANT discipline (corrected — `security R2-02`, `RO-04`)**: the roda-sql brake (`roda-sql.mjs:155-168`) requires, for every new table, a `grant … on public.<t> … to … authenticated` statement in the same file — its regex is satisfied by a **column-list grant**, which is the PostgreSQL mechanism that actually hides a column (a column-level REVOKE under a table-level GRANT is a documented no-op). So: every new table gets `grant select on public.<t> to anon` + RLS with **no anon policy** (anon reads nothing, C-84/C-87) and `grant select, insert, update, delete on public.<t> to service_role`; for `authenticated`: `invoice_terms`, `invoice_installments` get the full grant + `authenticated_all` (locked by trigger once sent); `invoice_revisions`, `invoice_approvals`, `invoice_events`, `invoice_client_notes` get `grant select` + a SELECT-only policy (every write goes through SECURITY DEFINER functions); **`quote_links` gets `grant select (id, invoice_id, gate, is_test, created_at, revoked_at, first_viewed_at, last_viewed_at, view_count) on public.quote_links to authenticated` — never a table-level SELECT — and RLS ON with no `authenticated` policy at all (belt)**; **`payment_attempts` gets a column-list grant that excludes `url`** (the bearer Checkout URL is served only via `GET /api/doc/[id]/link?seq=`) + a SELECT-only policy; `public_hits`, `quote_link_*` internals: service role only. The view `quote_links_public` is owned by `postgres` with `security_invoker = false` stated in the DDL, `grant select on quote_links_public to authenticated`. A-21 asserts the mechanism, not the symptom.

```sql
create table invoice_terms (                          -- 1:1; mutable until a live revision exists; CASCADE
  invoice_id uuid primary key references invoices(id) on delete cascade,
  valid_days int not null default 30, valid_until date,
  fee_policy text not null default 'ABSORB' check (fee_policy in ('ABSORB','GROSS_UP')),
  rails text[] not null check (rails <@ '{card,us_bank_account,ZELLE,WIRE,PIX_BR}'::text[]),   -- ONE vocabulary (RO-01): seeded by payer house
  language text not null check (language in ('en','pt')),
  consent_version text not null,                      -- 'terms-'||language||'-v1-2026-11', set by seed_terms (rules R2-11, U2-10)
  estimate_at timestamptz, rate_basis text check (rate_basis in ('FLAT','HOURLY','BOTH')), hourly_rate numeric,
  guarantee_text text, alt_authorizer_name text, alt_authorizer_phone text, storage_charge_daily numeric, intended_payment_method text,
  parts_return_choice text check (parts_return_choice in ('RETURN','INSPECT','NONE')),
  disclosure_choice text check (disclosure_choice in ('REQUEST','LIMIT','WAIVE')), disclosure_limit numeric,
  updated_at timestamptz not null default now()
);
create table invoice_installments (                   -- the PLAN (terms, not money); CASCADE
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  seq smallint not null, kind text not null check (kind in ('DEPOSIT','INSTALLMENT','BALANCE')),
  label_key text not null check (label_key in ('DEPOSIT','ARRIVAL','CONCLUSION','CUSTOM')), label text,
  pct numeric check (pct > 0 and pct <= 100), amount numeric check (amount > 0),
  due_rule text not null check (due_rule in ('ON_APPROVAL','ON_ARRIVAL','ON_CONCLUSION','DATE','NET_DAYS')),
  due_date date, net_days int,
  paid_to text not null check (paid_to in ('GZ28US','GZ28BR')),   -- US file; BR migration is its own templated file
  unique (invoice_id, seq), check ((pct is null) <> (amount is null)),
  check ((due_rule <> 'DATE' or due_date is not null) and (due_rule <> 'NET_DAYS' or net_days is not null)
         and (due_rule not in ('ON_ARRIVAL','ON_CONCLUSION') or label_key in ('ARRIVAL','CONCLUSION')))   -- rules R2-16
);
create table invoice_revisions (                      -- APPEND-ONLY; RESTRICT
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete restrict,
  seq smallint not null, kind text not null check (kind in ('QUOTE','CHANGE_ORDER','LEGACY_BACKUP')),
  document jsonb not null,                            -- DTO: header, lines[] WITH ids, totals by law, fl_tax_status, installments[] {seq, label_key, amount_cents, paid_to, due_rule…}, terms, company block, language, valid_until (send-time)
  delta jsonb,
  sha256 text not null,                               -- canonical JSON(document) — what the client signs
  presented_sha256 text not null,                     -- presented facts only — drives the staff "unsent changes" chip
  terms_sha256 text not null,                         -- sha256 of the terms text in `language` at send time (U2-10)
  grand_total numeric not null, fl_tax numeric not null, fl_tax_status text not null,
  pdf_path text, pdf_sha256 text,
  sent_at timestamptz, sent_channel text check (sent_channel in ('WHATSAPP','EMAIL','SMS','FACEBOOK','INSTAGRAM','COPY','RECORDED')),
  sent_to text, sent_by_app boolean not null default false,
  superseded_at timestamptz,                          -- mutable (trigger exception)
  created_by text, created_at timestamptz not null default now(), unique (invoice_id, seq)
);
create table quote_links (                            -- ONE LIVE per invoice (rotation keeps the revoked ones); CASCADE
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  token text not null unique,                         -- base64url(32 bytes); column-list GRANT excludes it (security R2-02)
  gate text not null default 'NONE' check (gate in ('NONE','CONTACT')),
  gate_tier text check (gate_tier in ('PHONE4','EMAIL')),      -- phone last-4 when a phone exists; e-mail only when none ("weak gate")
  is_test boolean not null default false,             -- trigger-guarded (security R2-12, RO-05); immutable after insert
  created_at timestamptz not null default now(), created_by text, revoked_at timestamptz, rotated_from uuid references quote_links(id),
  first_viewed_at timestamptz, last_viewed_at timestamptz, view_count int not null default 0
);
create unique index quote_links_one_live_idx on quote_links (invoice_id) where revoked_at is null;
create table quote_gate_fails (link_id uuid not null references quote_links(id) on delete cascade, ip_hash text not null, fails int not null default 0,
  locked_until timestamptz, day date not null default (now() at time zone 'America/New_York')::date, primary key (link_id, ip_hash));   -- service role only (security R2-06)
create view quote_links_public with (security_invoker = false) as
  select id, invoice_id, gate, gate_tier, is_test, created_at, revoked_at, first_viewed_at, last_viewed_at, view_count from quote_links;
create table invoice_approvals (                      -- APPEND-ONLY; RESTRICT
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete restrict,
  revision_id uuid not null unique references invoice_revisions(id),
  document_sha256 text not null,
  method text not null check (method in ('CLIENT_ESIGN','SHOP_PHONE','SHOP_IN_PERSON','SHOP_TEXT','SHOP_EMAIL','LEGACY_HIRING_DATE')),
  signer_name text not null,                          -- Unicode-aware sanitizer /[^\p{L}\p{M}\s'.\-]/gu, NFC, whitespace collapsed, ≤ 80 (security R2-13)
  signer_contact text,                                -- = revision.sent_to (masked on the public certificate)
  link_id uuid references quote_links(id),
  consent_version text not null, consent_text_sha256 text not null, consents jsonb not null,   -- consents.signer_name_sha256 = sha256 of the RAW typed name
  attribution jsonb not null default '{}',            -- {gate_tier, gate_ok, ip_source, xff[], country, city, ua_class}
  signature_png_path text, ip inet, user_agent text, signed_at timestamptz not null default now(),
  recorded_by text, note text, evidence_url text, signed_pdf_path text, signed_pdf_sha256 text,
  check (method <> 'CLIENT_ESIGN' or (link_id is not null and recorded_by is null))
);
create table invoice_client_notes (                   -- client prose: mutable, staff-moderated; CASCADE
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  revision_id uuid references invoice_revisions(id) on delete set null,   -- RO-07
  kind text not null check (kind in ('CHANGES','DECLINE')),
  text text not null check (length(text) <= 1000), reason text, hidden_at timestamptz, hidden_by text,
  ip inet, created_at timestamptz not null default now()
);
create table invoice_events (                         -- APPEND-ONLY timeline; CASCADE
  id bigint generated always as identity primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  revision_id uuid references invoice_revisions(id) on delete set null,   -- RO-07
  kind text not null check (kind in ('CREATED','SENT','REVISION_SUPERSEDED','REVISION_DROPPED','VIEWED','CHANGES_REQUESTED','DECLINED','DECLINE_WITHDRAWN',
    'RENEWAL_REQUESTED','SIGNED','GATE_RESET','GATE_CAP','LINK_COPIED','LINK_ROTATED','LANDING_NO_COOKIE',
    'CHECKOUT_OPENED','RAIL_UNAVAILABLE','DEPOSIT_AUTHORIZED','DEPOSIT_RECEIVED','DEPOSIT_FAILED','HIRED','INSTALLMENT_RECEIVED','PAYMENT_PROMISED',
    'PAYMENT_ANOMALY','REFUND_PENDING','REFUNDED','REFUND_FAILED','DISPUTE_OPENED','DISPUTE_UPDATED','DISPUTE_CLOSED','EXPIRED','EXTENDED','VOIDED',
    'CHANGE_ORDER_APPLIED','SIDE_EFFECT','NOTIFIED','NOTIFY_SKIPPED')),
  actor text not null check (actor in ('CLIENT','STAFF','STRIPE','SYSTEM')), actor_id text, ip inet, user_agent text,
  payload jsonb not null default '{}',                -- ids and small facts; never client prose (C-85); test:true when muted
  at timestamptz not null default now()
);
create index invoice_events_inv_at_idx on invoice_events (invoice_id, at desc);
create table payment_attempts (                       -- every try to collect, any rail; RESTRICT
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete restrict,
  installment_id uuid references invoice_installments(id),           -- nullable for non-Stripe manual on documents without a plan (consumers #5)
  seq smallint, revision_id uuid references invoice_revisions(id),
  income_id uuid references invoice_incomes(id) on delete set null,
  provider text not null check (provider in ('STRIPE','ZELLE','WIRE','CASH','CHECK','PIX_BR','OTHER')),
  rail text check (rail in ('card','us_bank_account','ZELLE','WIRE','PIX_BR')),          -- same vocabulary as terms.rails (RO-01)
  status text not null check (status in ('OPEN','PROCESSING','SUCCEEDED','SUCCEEDED_UNBOOKED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','DISPUTED','VOIDED_TEST')),
  verification text check (verification in ('instant','microdeposits')),              -- payments P-30
  amount_cents bigint not null, currency text not null default 'usd',                  -- BR template substitutes 'brl' (payments P-33)
  fee numeric, net numeric, method_type text, method_last4 text, account_holder_type text,   -- individual/company → 60-day ACH dispute window (P-22)
  checkout_session_id text unique, payment_intent_id text unique, charge_id text, balance_transaction_id text, refund_ids text[], dispute_id text, payout_id text,
  url text, expires_at timestamptz, livemode boolean not null default false,
  created_at timestamptz not null default now(), authorized_at timestamptz, succeeded_at timestamptz, failed_at timestamptz, failure_code text, created_by text,
  check (installment_id is not null or provider <> 'STRIPE')
);                                                    -- Stripe idempotency key = attempt.id; ONE attempt row per Checkout Session (security R2-09)
create unique index payment_attempts_one_open_idx on payment_attempts (invoice_id, installment_id) where status in ('OPEN','PROCESSING') and installment_id is not null;
create table public_hits (scope text not null check (scope in ('link','ip')), key text not null, route text not null, bucket timestamptz not null, n int not null default 0,
  primary key (scope, key, route, bucket));         -- limiter on two keys (security R2-08); service role only; trimmed at 48 h
-- M5: stripe_payouts as v1
```

`stripe_events` gains `locked_at timestamptz` and `attempts int not null default 0` (`RO-10`); synthetic fulfilment rows `id = 'cs:'||checkout_session_id` share the table (one claim per session, `payments P-19`); its RLS stays "no policies" (service role only).

### 4.2 Columns added to existing tables (additive, nullable; C-05)

| Column | Meaning |
|---|---|
| `invoice_incomes.installment_id uuid references invoice_installments(id) on delete set null` | which plan row this money settles (refund/dispute rows carry the reversed row's id) |
| `invoice_incomes.attempt_id uuid references payment_attempts(id) on delete set null` | the attempt that settled it |
| `invoice_incomes.refund_id text unique` | one negative row per Stripe refund `re_…` / dispute `dp_…` / reversal `…:reversal`, `…:reinstated` |
| `invoice_incomes.payment_reference text` · `invoice_expenses.payment_reference text` | `'stripe:<charge_id>'`, `'zelle:<conf>'` — a reference, **not** a bank link: `paidNoBank.linkedToBank` keeps honouring `bank:` only; Stripe rows are honestly unlinked until `payout_id` is matched (`payments P-31`; the v2 `stripe:` special case is withdrawn — `consumers #8`) |
| `invoice_notes.client_visible boolean not null default true` | hide a template note from the client page |
| `clients.stripe_customer_ids jsonb` `{test, live}` | Customer per mode; the `test` key is cleared by the fixture cleanup |
| `lib/receiptKinds.ts` `+ 'STRIPE_RECEIPT'`; `components/PaymentFields.tsx` `PAYMENT_METHODS += 'STRIPE'` | vocabulary |
| `invoices_ride_code_uidx` partial unique `(ride_id, invoice_code) where ride_id is not null` | own file after the pre-flight duplicate query |
| `invoice_expenses_stripe_txn_uidx` partial unique `(order_number) where payment_method='STRIPE'` | one fee row per balance transaction |

Nothing on `invoices`. **No `updated_at` trigger on `invoice_incomes`** — the 04/10/2026 decision stands (`RO-13`); our writers set it explicitly.

### 4.3 Constraints, triggers and functions (M1 unless noted)

Every function: `SECURITY DEFINER`, `set search_path = public`, `revoke all on function … from public, anon, authenticated; grant execute … to service_role`. **GUC escape discipline** (`security R2-10`): a trigger escape (`gz28.hire`, `gz28.requote`, `gz28.test_cleanup`, `gz28.change_order`, `gz28.settle`) fires only when `current_setting('gz28.<x>', true)` equals a **per-run nonce** generated by the calling SECURITY DEFINER function or script **and** `current_user in ('postgres','service_role')`; the nonce is recorded in `data_fixes` with the run label; never a bare `'on'`.

1. **`orlando_today()`** / **`orlando_noon(d date)`** — the only SQL clock.
2. **`trg_incomes_no_quote`** BEFORE INSERT OR UPDATE ON `invoice_incomes`: raise `'quote has no income (C-07)'` when the parent `is_quote`, unless the `gz28.requote`/`gz28.test_cleanup` escape.
3. **`trg_invoices_quote_flip`** BEFORE UPDATE OF `is_quote, hiring_date, live_status` ON `invoices` — **scoped** (`rules R2-01`, `consumers #2`): (a) `is_quote false→true` raises on **every** invoice unless the escape (C-09 letter); (b) `hiring_date → NULL` and `REALTIME → INCOMPLETE` raise **only when** `exists(select 1 from invoice_approvals a where a.invoice_id = new.id) or exists(select 1 from invoice_incomes i where i.invoice_id = new.id and i.installment_id is not null)`. Legacy invoices with hand-made incomes keep today's status cycle (`E:3681-3702`) and HIRING DATE edits (A-18, A-22).
4. ~~`trg_incomes_touch`~~ — **dropped** (`RO-13`): `income_settle`, `quote_hire` step 7, `book_payment` step 3 and the Zelle patch set `updated_at = now()` explicitly, which is all the net's `updated_at >= EPOCH` filter needs; robot UPDATEs (`claimReport`, housekeeping) do not reorder the "last activity" lists.
5. **`trg_plan_row_no_delete`** BEFORE DELETE ON `invoice_incomes`: raise when `installment_id is not null` and the parent is not a quote, unless the escape.
6. **`trg_incomes_plan_guard`** BEFORE UPDATE ON `invoice_incomes` (`security R2-11`): when `OLD.installment_id is not null`, refuse changes to `installment_id`, `attempt_id`, `refund_id`, and refuse `paid_at` NULL→value unless the `gz28.settle` escape set by `income_settle`. The legacy E INCOME panel renders plan rows read-only with "settle in /doc → RECORD PAYMENT" (legacy edit §9 #2), so no legacy SAVE hits this trigger.
7. **`trg_append_only`** on `invoice_revisions` (UPDATE only `superseded_at, pdf_path, pdf_sha256`), `invoice_approvals` (only `signed_pdf_path, signed_pdf_sha256`), `invoice_events` (none). DELETE raises unless the `gz28.test_cleanup` escape **and** the invoice's link `is_test` (set inside `fixture_delete()`).
8. **`trg_lock_presented_lines`** BEFORE UPDATE OR DELETE ON `invoice_items` (`description, unit_price, quantity, kit_group, kit_name` — not `cancel_status`), `invoice_services` (`description, price`), `invoice_installments` (all), `invoice_terms` (`rails, fee_policy`), **`invoices` (`fl_tax_override, global_discount`)** — fires only when `live_revision(invoice)` exists and (`OLD.id ∈ document.lines[].id` for items/services; always for installments/terms/header); identical-value writes pass; raise `'locked by sent revision <seq> — NEW REVISION in /doc (C-16)'` unless the `gz28.change_order` escape names an approved CHANGE_ORDER. INSERTs never blocked (C-38). `import_margin` stays unlocked (it feeds `base_cost`, not presented prices); the E guard disables its input anyway.
9. **`trg_approval_binds_revision`** BEFORE INSERT ON `invoice_approvals`: revision = `live_revision(invoice)`; `invoice_terms.valid_until >= orlando_today()` (CLIENT_ESIGN); `document_sha256 = revision.sha256`; `consent_version = invoice_terms.consent_version`; none for that revision; `kind <> 'LEGACY_BACKUP'`.
10. **`trg_quote_links_is_test`** BEFORE INSERT OR UPDATE OF `is_test` ON `quote_links` (`security R2-12`, `RO-05` — a CHECK cannot reference another table): on INSERT `is_test` may be true only when the invoice's client has `name like 'GZ28 TEST%' and origin = 'PROJECT'`; on UPDATE any change of `is_test` raises (immutable).
11. **`live_revision(p_invoice)`** — newest `superseded_at is null and kind in ('QUOTE','CHANGE_ORDER')`.
12. **`alloc_ride_code(p_prefix)`** — port of `lib/rideCodes.ts` under `pg_advisory_xact_lock(hashtext('ride_codes'))`; pinned codes never released; A-02 characterization is a blocking gate before the migration.
13. **`quote_send(p_invoice, p_actor, p_channel, p_sent_to, p_valid_days, p_document, p_sha256, p_presented_sha256, p_terms_sha256, p_grand, p_fl_tax, p_fl_status, p_by_app)`** — **first statement: `perform id from invoices where id = p_invoice for update`** (`security R2-04`); asserts identities only (`p_grand = document.totals.grand`, `Σ installments.amount_cents = round(p_grand*100)`, every `lines[].id` exists, `p_terms_sha256` matches the strings table for `terms.language` — the Node caller passes the text's hash and SQL stores it); refuses when an attempt is OPEN/PROCESSING or an approval exists; supersedes the previous revision; mints the link if absent; `valid_until := orlando_today() + p_valid_days`; event SENT (none for `RECORDED`).
14. **`quote_revision_supersede(p_invoice, p_actor)`** — row lock first; refused with approval or open attempt.
15. **`quote_approve(p_link, p_revision, p_sha256, p_terms_sha256, p_signer jsonb, p_consents jsonb, p_attribution jsonb, p_method, p_recorded_by)`** — row lock first; the `supersede ‖ sign` race resolves to exactly one winner (A-05).
16. **`attempt_open(...)`**, **`book_payment` / `quote_hire` / `income_settle`** — §3.3.
17. **`seed_terms(p_invoice)`** — row lock; idempotent; language/consent_version/rails by the T0 rule; **no-op for `invoice_installments` when the document is `is_quote=false` and has incomes**.
18. **`quote_void(p_invoice, p_actor)`** / **`quote_extend(p_invoice, p_days, p_actor)`** / **`quote_expire(p_invoice)`** / **`quote_rotate_link(p_invoice, p_actor)`** / **`gate_unlock(p_link, p_actor)`** — row lock first; `quote_void` sets `revoked_at` and returns the OPEN session ids for Node to expire **after** commit.
19. **`fixture_delete(p_invoice, p_label)`** (`RO-07`) — REVOKEd SECURITY DEFINER: requires the invoice's link `is_test`; `set_config('gz28.test_cleanup', <nonce>, true)` (transaction-local); writes the full-row JSON of every child into `data_fixes` (label); deletes in FK order **attempts → approvals → events → client notes → revisions → incomes → items/services/notes → installments/terms/gate fails/links → invoice → client**; sets `VOIDED_TEST` and `revoked_at` first; returns the ids. Called by `scripts/quote-portal-fixture.mjs --cleanup` and by `docs-housekeeping`.
20. **`change_order_apply`** — M4. Later (M4): CHECKs on strays after D-11/D-12; `trg_incomes_paid_at_noon`.

### 4.4 What existing columns keep meaning — as v2 §4.4 with these amendments
`invoice_incomes.paid_at` = cash event (settlement day for bank debits, charge day for card, event day for refund/dispute rows), noon Orlando; `invoices.hiring_date` = the same day as the deposit's `paid_at`; `invoice_incomes.reported_at` = NULL for live money, `now()` for `is_test` documents; `invoice_incomes.description` = plan label in the client's language, **never overwritten by a settlement** (`consumers #11`); `invoice_incomes.updated_at` set explicitly by our writers only.

### 4.5 Backward compatibility with every consumer (`consumers.md` §4)
- Money readers gate on `is_quote=false ∧ live_status ∈ (REALTIME, CLOSED)` — true after `quote_hire`; cannot be undone by a stale legacy tab (`trg_invoices_quote_flip` (a)); a legacy invoice can still be parked INCOMPLETE (`trg_invoices_quote_flip` (b) is V2-scoped).
- Report net: live rows `reported_at NULL` + explicit `updated_at` → balloon once; **sign-aware label**: amount < 0 → "*REFUND / CHARGEBACK* {code} — {amount}" (`payments P-25`; legacy edit §9 #5).
- Daily Mega-Report (legacy edit §9 #4): skips `is_test` documents; **unpaid plan rows (`installment_id not null ∧ paid_at null`) never appear in the "registered" section — they are folded into the 🏁 HIRED line as `plan: 2 × US$ 42,500 (1 received)`** (`rules R2-04`, C-66 "no predictions"); **structural ⚠ DISPUTE / FAILED AFTER SETTLEMENT line** from `invoice_events kind in ('DISPUTE_OPENED','DEPOSIT_FAILED')` in the window (`payments P-22`); `?dry=1`.
- Bank Link: gross income + exact fee row → MIXED once `payout_id` is set (M1 writes it on `payout.paid` via `balanceTransactions.list({payout})`; the MIXED matcher extension that accepts Σ(income − fee) per `payout_id` is M2); until matched the rows are **honestly UNLINKED** in the checker (`payments P-31`).
- DELAYED robot (`recurring-expense-reports`, legacy edit §9 #6): skips `is_test`; **skips plan rows unless `notify.reports.installment_delayed` is ON** (`consumers #9`); under AUTHORIZED skips rows with an open attempt (M4).
- **Zelle watch (legacy edit §9 #3, tonight — corrected, `consumers #1`)**: `destinoPorValor` selects **`paid_at is null`** (the law: `income-baixa-e-paid-at`) instead of `payment_date is null`, keeping the legacy undated semantics for rows without `installment_id` (`.or('payment_date.is.null,installment_id.not.is.null')`); exact matches prefer rows with `installment_id`; a matched plan row → `income_settle()` (UPDATE, `payment_reference='zelle:<conf>'`, description untouched); **never the "PALPITE" fallback when the client has any open plan row — it writes a doubt instead**; rows without `installment_id` keep today's path byte for byte.
- **`intercompanyLedger` (legacy edit §9 #10, tonight — `rules R2-06`)**: `dia = dayIn(paid_at, 'America/New_York') || ymd(payment_date)` at `:245-254` (unpaid rows are already excluded above). Constraint 2: the writer that would have made the bug systematic ships in the same step as the fix.
- `duties_self_load`, pack seed, shop `opsWrite.ts`, renumber route, folder/mail crons: as v1. **Receipt hunt / `cron/invoice-receipts`**: fee and income rows carry **no hosted Stripe URL** in `receipt_url` (it would be fetched as HTML and filed as a `.pdf` in the sacred folder, re-uploaded on every run — `consumers #7`); the M2 voucher PDF in the `expense-receipts` bucket is the only URL ever written there.
- BR app: new tables US-only until M6; no anon exposure added (C-87).

### 4.6 Migration / backfill (M1)
1. **Pre-flight** (read-only, shown inline): duplicate `(ride_id, invoice_code)`; `invoice_incomes` on quotes (must be 0); A-02 characterization inside `begin … rollback`.
2. `MIGRATION_quote_portal_core.sql` in one transaction: tables, columns, triggers, functions, GRANTs per §4.1, supplier `Stripe`, bucket `client-docs`, `app_settings` seeds (every `notify.*` false incl. `notify.reports.installment_delayed` and `notify.reports.renewal_requested`; `quote_portal.enabled=false`; `qi_v2.actions=false`; `quote.hire_on="CLEARED"`; **`payments.ach_verification="automatic"`** (`payments P-30`); `payments.rails_enabled=["card"]`; **`stripe.customer_emails_checked={"test":true,"live":false}`** (`rules R2-02`); **`deposit.manual_cap=10000`**; `stripe.endpoint_events=[expected list]`; `notify.test_targets=[]`; `test.keep=false`; `quote.gate_default="CONTACT_25K"`). `MIGRATION_quote_portal_uidx.sql` separately if the pre-flight is clean. Rollback drops in order: `invoice_incomes` columns → `payment_attempts` → the rest.
3. **No backfill of terms/plan/events** — lazy seed on first `/doc` open or SEND. `LEGACY_BACKUP` revisions from `quote_backups` move to M2.
4. No historical rewrite; counts in the morning note (C-100).
5. `vercel.json`: `docs-housekeeping` hourly (18th cron). `/api/health/env`: new checks — `STRIPE_WEBHOOK_ENDPOINT_ID` present; `webhookEndpoints.retrieve(id).enabled_events ⊇ stripe.endpoint_events`; `webhookEndpoints.retrieve(id).api_version === Stripe.API_VERSION` (`payments P-29`); `QUOTE_GATE_SECRET` present; `MACHINE_ACCOUNTS` non-empty (warn); in live mode `stripe.customer_emails_checked.live === true`, `notify.owner.dispute` and `notify.owner.payment_failed` ON (**live-switch preconditions**, `payments P-22`).
6. `AuthGate.PUBLIC_PREFIXES += '/q/'` (US); `next.config.ts` headers with sources `/q/:path*`, `/api/q/:path*`.
7. **Env (new)**: `QUOTE_GATE_SECRET` (32 random bytes), `MACHINE_ACCOUNTS=br-bridge@gz28us.com`, `STRIPE_WEBHOOK_ENDPOINT_ID=we_1UYjOkQekIwjYgOOhADU2tsD` (test). Tonight the test endpoint's missing events are added by `webhookEndpoints.update(id, {enabled_events})` with the test key (`RO-14`).

---

## 5. Client-facing flow — the public page `/ca/q/<token>`

### 5.1 Content and mobile layout (one column, max-w 480 px, dark house look on screen, light on print; D-08)

```
┌──────────────────────────────────────────┐
│  [logo]  GZ28 V8 SpeedShop               │  sticky brand line only
│  ┌────────────────────────────────────┐  │
│  │  2021 Jeep Grand Cherokee Trackhawk│  │  make/model/year — never the nickname on a quote (C-15)
│  │  Z2000 TYPHON PACKAGE              │  │
│  │  US$ 85,000.00                     │  │  grand total by law (C-24/C-25)
│  │  Quote US.QT.028.1 · rev 1         │  │  NO issue date (D-05)
│  │  valid until Dec 6, 2026           │  │  invoice_terms.valid_until (+ "extended on …" when it differs)
│  └────────────────────────────────────┘  │
│  Hi Robert — here is your build quote.   │  hello / hello_parts by document kind; person vs company name rule
│  ▾ WHAT'S INCLUDED (11 parts · 13 services)│
│    📦 Z2000 Typhon Package … US$ 85,000.00│  kit header + members (C-41); $0 members print "included" (D-04 default A — U2-04)
│      Engine build ……………………… included     │  a $0 line OUTSIDE any package keeps COURTESY/CORTESIA (C-31 intact)
│  ▸ NOTES (4)                             │  invoice_notes where client_visible (C-42)
│  TOTAL … Florida sales tax: exempt — out-of-state … GRAND TOTAL US$ 85,000.00
│  PAYMENT PLAN                            │  from the revision (cents)
│  1  Deposit on approval     US$ 42,500.00│
│  2  When your car is done   US$ 42,500.00│
│  Card — no fee to you. Zelle or wire also welcome.   ← composed from terms.rails ∩ rails_enabled (+ non-Stripe rails); the ACH sentence appears only when enabled (U2-09)
│  ▸ YOUR FLORIDA WRITTEN ESTIMATE         │  collapsed §559.905 (a)–(n) (D-07)
│  ▸ TERMS OF THIS QUOTE                   │  the terms text in the document language, INLINE, expandable (U2-10) — its sha256 is what the consent hashes
│  ┌ APPROVE THIS QUOTE ──────────────────┐│
│  │ Your name  [ Robert Zapata        ] ││  PRE-FILLED from clients.name, editable, ≥ 2 chars
│  │ ☐ I agree to receive and sign this estimate electronically. Paper copy on request.   (C-103)
│  │ ☐ I have read and accept the terms of this quote (above).
│  │ Written estimate: [This document] [Only above US$ __] [Not needed]     ← chips, none pre-selected; LIMIT reveals the amount field inline (U2-13)
│  │ Replaced parts:   [Return to me] [Keep for inspection] [No need]      ← chips, none pre-selected
│  │ (gate CONTACT, when ON) "To sign, confirm the phone ending in ••34" / "…the e-mail r•••a@g•••.com"  [____]   ← masked hint (U2-08)
│  │ [ ✍ APPROVE & SIGN — US$ 85,000.00 ] ││  56 px, full width; error toasts below
│  │ Next: pay the US$ 42,500.00 deposit. ││
│  └──────────────────────────────────────┘│
│  Request changes · Not now · 💬 Contact GZ28 │  Not now = collapses the card to "▸ Approve this quote" (tap re-opens), NO event (U2-13);
│                                           │  Contact GZ28 = IN-PAGE sheet with the shop's contact for the channel you were reached on, tap-to-copy, no href (C-84; rules R2-14)
│  🖨 Print / save as PDF                  │
│  GZ28 V8 SpeedShop USA LLC · <address as the current paper prints it; D-03> · (321) 315-0973 · [FDACS reg. # only when TenantConfig.fdacs_registration is set — rules R2-10] │
└──────────────────────────────────────────┘
```

Interactions to sign: name pre-filled (0), two consent taps (2), two election taps (2), button (1) = **5 taps**, plus the gate when ON (1). Pay adds one rail tap + Stripe's hosted flow.

States of the same URL:
- **SIGNED · awaiting deposit** — badge "✓ Approved by Robert Zapata · Nov 6, 2026 10:12 (Orlando)"; PAY card "DEPOSIT DUE NOW — US$ 42,500.00"; rail buttons only for `rails ∩ payments.rails_enabled`, **cheapest first (ACH, then card)** when both exist; on a real link **only in live mode with the e-mail check recorded** — otherwise the Zelle/wire sheet is the only rail (§2); "Prefer Zelle or wire? Tap for instructions" ("I sent it" → PAYMENT_PROMISED); Stripe footnote; "⬇ Your signed copy"; in-app browsers see "Open in your browser" (`payments P-36`).
- **DEPOSIT CLEARING (ACH)** — "⏳ Deposit of US$ 42,500.00 authorized Nov 6 — clearing with your bank, in up to 4 business days. Your project opens the moment it clears. Stripe e-mailed you the debit authorization." `verification='microdeposits'` → `clearing_microdeposits`: "Stripe sent two small deposits to your account — confirm them from Stripe's e-mail (up to 10 days)." Card payment unavailable while a bank transfer is pending.
- **DEPOSIT FAILED** — "Your bank returned the payment ({reason}). Nothing was charged. [Pay again]" (a new attempt).
- **DEPOSIT REFUNDED** — "Your deposit of US$ 42,500.00 was refunded on {date}. Your project stands; the deposit is due again. [Pay]" (hire stands, C-09 — `consumers #6`, `payments P-25`).
- **HIRED** — "🏁 You're in. Project US.0xx — <car>"; "formerly quote US.QT.028.1" for 30 days; plan rows ✓ with receipts (M2, gated when a gate exists); next installment with PAY when due; PROMISED TO; signed copy.
- **`balance_pending_update`** — on the last installment while "balance ≠ plan": "Your final balance is being updated — GZ28 will send the revised amount." (PAY hidden on that row only — `U2-06`).
- **CHANGE ORDER pending** — banner + APPROVE card for rev n+1 (M4).
- **CHANGES REQUESTED** — "We received your request on {date} and will send a revised quote."
- **DECLINED** — "You declined this quote on {date}. [I changed my mind]".
- **SUPERSEDED** — "GZ28 is preparing a new version of this quote — it will appear here." (buttons hidden; the only staff-driven hide).
- **EXPIRED** — document visible, approve/pay gone, **one button `ask_renewal`** ("Still interested? Ask GZ28 to renew this quote" → RENEWAL_REQUESTED, 1/day, then "✓ Asked — GZ28 will get back to you") (`U2-13`).
- **`return_no_session`** (`/q/return` without the cookie) — "Payment received — we are confirming it. Open your quote link again to see the confirmation." with amount + state from the attempt, no document data (`U2-03`, `RO-08`).
- **VOID / NOT FOUND / INACTIVE** — branded card, no data.
- **Error/empty states**: `err_stale`, `err_rate`, `err_pay_unavailable` (+ Zelle/wire sheet), `err_gate` / `err_gate_locked`, **`err_limit`**, `landing_pending` ("We're confirming your payment… this page refreshes by itself", 5-s poll for 60 s) → **`landing_timeout`** ("Still confirming — nothing else to do; your receipt will show here. You will not be charged twice."), `offline`. PAY hidden while an attempt is PROCESSING. Toasts, never `alert()`.

### 5.2 Approve & e-sign — how, and the audit trail (constraint 8; C-102, C-103)
- **Intent**: pre-filled name confirmed/edited + two consents + two elections + a button naming the act and the amount. Optional drawn signature (PNG ≤ 200 KB, validated).
- **Association**: `revision_id + sha256 + terms_sha256` from the DTO; the server requires equality with `live_revision` and recomputes the terms hash for `terms.language` (`trg_approval_binds_revision`, `/api/q/sign`); the certificate prints the hash with `hash_hint`.
- **Attribution** (Fla. §668.50(9)): (1) the 256-bit link; (2) `signer_contact` always recorded from the SEND sheet's `sent_to`; (3) **gate CONTACT** — tiered: **phone last-4 when a phone exists; e-mail only when no phone exists, and then the SEND sheet says "weak gate (e-mail)"**; answers normalised before hashing; masked hint; constant-time compare; pass = HMAC cookie (15 min); fails per (link, ip): 5 → 15 min, then 1 h; per-link daily cap 25 → `GATE_CAP` + staff notice, never a client lockout; staff UNLOCK GATE; `attribution.gate_tier` recorded — default ON when the quote ≥ US$ 25k and a contact exists (D-14 B); when neither exists the SEND sheet says "no identity gate possible" (`security R2-06`, `U2-08`); (4) IP from `x-real-ip`/`x-vercel-forwarded-for`, raw XFF stored, `x-vercel-ip-country/-city`; UA class; timestamps UTC + Orlando; consent version per language + both hashes; elections; `consents.signer_name_sha256` of the raw typed name (`security R2-13`). (5) M4: 6-digit OTP on the same channel when client keys come ON.
- **Retained copy**: page readable by token after signing and hiring (sensitive views behind the gate when one exists, `security R2-07`); print view tonight (public certificate masks contact/IP; full certificate on the staff print); vector signed PDF + certificate M2; e-mail/WhatsApp copy only when `notify.client.signed_copy` is ON.
- **Shop-recorded approvals**: `method ∈ SHOP_*`, `recorded_by = JWT e-mail`, `note` mandatory; the page prints the method label, never the enum.
- **Withdrawal path**: paper-copy line (§7001(c), C-103; counsel D-07). The two consents stay two checkboxes.

### 5.3 Pay the 1st installment — Stripe (Checkout Session, `mode:'payment'`, one attempt row per session)

```ts
// POST /api/q/checkout — amount, label, paid_to, fee_policy ONLY from the approved revision's document.installments[seq] (S-10)
// mode rule: real link ⇒ stripeMode()==='live' && settings['stripe.customer_emails_checked'].live, else 409 rail_unavailable (security R2-01, rules R2-02)
const attempt = await rpc('attempt_open', { link, seq, rail, livemode })          // row lock; expires a stale OPEN; NEW row per session (R2-09/P-21)
const inst = approvedRevision.document.installments[seq]                           // {amount_cents, label_key, paid_to, ...}
const customer = await customerForMode(client)                                     // clients.stripe_customer_ids[stripeMode()]; search by metadata.client_id, then create; persisted BEFORE sessions.create
const suffix = cardSuffix(accountDescriptorPrefix, installmentWord)                // DEPOSIT / BAL / INST k — never an opaque id (P-35); sent on card only when ≥ 4 chars fit
const s = cap(str, n) => stripped of control chars, truncated                      // name 120, description 300, metadata ≤ 500 (P-37)
stripe.checkout.sessions.create({
  mode: 'payment', locale: lang === 'pt' ? 'pt-BR' : 'en', customer,
  payment_method_types: RAIL_TO_STRIPE[rail],                                      // {card:['card'], us_bank_account:['us_bank_account']} — the one mapping (RO-01); explicit list → Link OFF
  payment_method_options: { us_bank_account: { verification_method: settings['payments.ach_verification'] ?? 'automatic',   // P-30
                                               financial_connections: { permissions: ['payment_method'] } },
                            card: { request_three_d_secure: 'automatic' } },
  line_items: [{ quantity: 1, price_data: { currency: tenant.currency /* 'usd' */, unit_amount: inst.amount_cents,
    product_data: { name: s(`GZ28 — ${installmentLabel} · ${service}`, 120), description: s(`${carMakeModelYear} · doc ${shortId} · rev ${revSeq}`, 300) } } }],
  client_reference_id: attempt.id,
  metadata: { app: 'control-app', invoice_id, attempt_id: attempt.id, installment_id, revision_id, fl_tax_cents: String(revision.fl_tax_cents) },   // P-32: Dashboard readers see the tax portion
  payment_intent_data: { metadata: { app: 'control-app', invoice_id, attempt_id: attempt.id, installment_id },
                         description: s(`${service} — installment ${seq}/${n}`, 300),
                         ...(rail === 'card' && suffix ? { statement_descriptor_suffix: suffix } : {}),
                         ...(rail === 'us_bank_account' ? { statement_descriptor: 'GZ28 DEPOSIT'.slice(0, 16) } : {}),   // P-35
                         ...(settings['notify.client.stripe_receipt'] ? { receipt_email: client.email } : {}) },      // forces a receipt even when the account switch is OFF — its only real function (P-23)
  success_url: `https://www.gz28us.com/ca/q/return?t=${landingToken(attempt.id)}`,   // signed landing token, no capability token (S-07, R2-14)
  cancel_url:  `https://www.gz28us.com/ca/q/return?t=${landingToken(attempt.id)}&c=1`,
  expires_at: nowSec + 24 * 3600, submit_type: 'pay',                                // 24 h (P-36): one-open index + inline expiry already prevent duplicates
  custom_text: { submit: { message: lang === 'pt' ? `Sinal do orçamento ${shortId}` : `Deposit on quote ${shortId}` } },   // stable short id (rules R2-12)
}, { idempotencyKey: attempt.id })                                                 // a NEW attempt id per session — never reused after expiry/failure
// then: update payment_attempts set checkout_session_id, url, expires_at where id = attempt.id
```
- `automatic_tax` never set (C-36); `invoice_creation` never set; `consent_collection` not used. **Stripe Tax (live on the shared account for shop orders) is blind to Control App money by design: FL sales tax for quote/invoice money is filed from the Control App export only; Stripe Tax reports cover shop orders only; never add the two** (`payments P-32`; memory `fl-tax-export-rule`).
- Fees: ABSORB → amount = cents of the plan row (C-90). GROSS_UP (per quote, D-02) → card button shows `(X + 30) / 0.971` cents as its own disclosed line; booking rule §3.5.
- Sidney (`rails={PIX_BR}`, `paid_to=GZ28BR`): PIX/TED sheet shows the USD amount and "R$ at the official rate confirmed by GZ28BR on the day you pay — ask us for today's figure", the C6 PIX key from `TenantConfig`; no computed R$. Attempt stays USD; RECORD DEPOSIT writes `amount_brl` + NF/BR_ENTRY (C-61, C-63, C-64).
- Later installments: same page, PAY on the due row, a new attempt per click; no off-session charges; PAY hidden on the last row while "balance ≠ plan".

### 5.4 Confirmations the client receives — page always; messages only when keys are ON; after a decline "You can change your mind here"; after CLEARING the honest Stripe-mandate sentence; after a refund the DEPOSIT REFUNDED card.

### 5.5 If he abandons — DECLINED reversible; SUPERSEDED says a new version is coming; EXPIRED offers `ask_renewal`.

### 5.6 Copy — EN / PT (`lib/quoteStrings.ts`; language `invoice_terms.language`; Orlando dates for US subjects, Brasília for BR clients, C-92)

All v2 keys stand with these changes/additions (`U2-04`, `U2-08`, `U2-09`, `U2-10`, `U2-13`, `U2-18`, `payments P-30`):

| key | EN | PT |
|---|---|---|
| included | included | incluído |
| courtesy (outside a package only) | COURTESY | CORTESIA |
| no_fee (composed) | {Card} / {Bank transfer (ACH) or card} — no fee to you. {Zelle or wire also welcome.} | {Cartão} / {Transferência (ACH) ou cartão} — sem taxa para você. {Zelle ou wire também.} |
| terms_title / terms_body_v1 | Terms of this quote / <the v1 terms text, EN> | Condições deste orçamento / <the v1 terms text, PT — reviewed by the BR session before the first Brazilian link> |
| consent_terms | I have read and accept the terms of this quote (above). | Li e aceito as condições deste orçamento (acima). |
| gate_phone / gate_email | To sign, confirm the phone ending in ••{last2} / To sign, confirm the e-mail {masked} | Para assinar, confirme o telefone terminado em ••{last2} / Para assinar, confirme o e-mail {masked} |
| err_gate / err_gate_locked | That doesn't match our records / Too many tries — try again in {minutes} minutes or contact GZ28 | Não bate com o nosso cadastro / Muitas tentativas — tente em {minutes} minutos ou fale com a GZ28 |
| err_limit | Enter the amount above which you want a written estimate | Informe o valor acima do qual quer orçamento por escrito |
| not_now / approve_reopen | Not now / ▸ Approve this quote | Agora não / ▸ Aprovar este orçamento |
| contact_us / contact_sheet | 💬 Contact GZ28 / Reach us on {channel}: {handle} (tap to copy) | 💬 Falar com a GZ28 / Fale conosco no {channel}: {handle} (toque para copiar) |
| ask_renewal / renewal_asked | Still interested? Ask GZ28 to renew this quote / ✓ Asked — GZ28 will get back to you | Ainda tem interesse? Peça à GZ28 para renovar / ✓ Pedido enviado — a GZ28 vai retornar |
| landing_timeout | Still confirming — nothing else to do; your receipt will show here. You will not be charged twice. | Ainda confirmando — não precisa fazer mais nada; o recibo aparece aqui. Você não será cobrado duas vezes. |
| return_no_session | Payment received — we are confirming it. Open your quote link again to see the confirmation. | Pagamento recebido — estamos confirmando. Abra de novo o link do orçamento para ver a confirmação. |
| clearing_microdeposits | Stripe sent two small deposits to your account — confirm them from Stripe's e-mail (up to 10 days). | A Stripe enviou dois pequenos depósitos para a sua conta — confirme pelo e-mail da Stripe (até 10 dias). |
| fail_reason.verification_timeout | bank account not verified in time | conta bancária não verificada no prazo |
| deposit_refunded | Your deposit of {amount} was refunded on {date}. Your project stands; the deposit is due again. | Seu sinal de {amount} foi devolvido em {date}. Seu projeto continua; o sinal volta a ser devido. |
| balance_pending_update | Your final balance is being updated — GZ28 will send the revised amount. | Seu saldo final está sendo atualizado — a GZ28 vai enviar o valor revisado. |
| open_in_browser | For the smoothest payment, open this page in your browser. | Para pagar sem percalços, abra esta página no seu navegador. |
| decline_reasons | Timing · Scope · Other | Prazo · Escopo · Outro |
| hired / formerly | 🏁 You're in. Project {code} — {car}. / formerly quote {old_code} (until {date}) | 🏁 Confirmado. Projeto {code} — {car}. / antes orçamento {old_code} (até {date}) |

Keys from v2 kept verbatim: hello, hello_parts, first-name rule, sign_name, est_*, method_*, approved_shop, clearing, clearing_no_card, fail_reason.*, superseded, decline_title/btn, declined/undo_decline, print, hash_hint, err_stale/err_rate/err_pay_unavailable/landing_pending/offline/err_name/err_consent. The BR session reviews every PT string **and the PT terms text** before the first Brazilian link.

---

## 6. Internal flow

### 6.1 Building a quote (M3; tonight legacy NEW + editor) — as v2; the creation path calls `seed_terms` so no quote is ever without a plan.

### 6.2 Sending (M1)
SEND (primary action on DRAFT) → readiness gate naming the field to fix: FL status resolvable **(refuses when `title_scope` is blank and the client address would decide the tax — `consumers #4`)**, Σ plan = 100 %/grand (PLAN & TERMS sheet inline when not; names the missing `due_date`/`net_days`), a destination for the chosen channel (recorded as `sent_to`), rails line to confirm, gate line ("gate: phone ••34" / "weak gate (e-mail)" / "no identity gate possible"), **"FDACS number missing" (yellow, one tap to continue)** when `TenantConfig.fdacs_registration` is unset (`rules R2-10`), BR mirror existence for a ride, `expected_conclusion_date` optional. **Content lint** (warnings, one tap to continue): template notes contradicting the lines; Remote/In-House pairs; APP_ONLY notes; a "50% Down…" note duplicating the plan — each with "hide on client page". Then the **SEND sheet**: preferred channel first (C-70), ready text in the client's language (shown, editable); **WhatsApp / E-mail → `SEND BY APP` (manual, always available — the tap is the approval) or COPY TEXT; Messenger / Instagram / SMS → COPY TEXT & OPEN**; `valid_days` editable (default 30); **chip "Client already approved — by {phone / in person / text / e-mail}" + note → the sheet's text becomes the pay text and the approval is recorded in the same request** (`U2-07`). Every choice writes SENT{channel, by_app} and `sent_to`.

### 6.3 Tracking (M1 ACTIVITY + ACTION NEEDED index; M2 list cards)
ACTIVITY = `invoice_events` in Orlando time + client notes as quote blocks; SYSTEM/STRIPE events collapsed under "▸ system (n)"; e.g. `rev 1 frozen · sent via FACEBOOK (copy) to m.me/robert.z… · marcio` · `👁 opened · iPhone` · `✍ signed · Robert Zapata · e-sign · gate phone ok` · `checkout opened (card)` · `deposit received · hired US.QT.028 → US.047 · plan 2 × US$ 42,500 (1 received)` · `▸ system (4)`. `/doc` (no code) = ACTION NEEDED index (§2.2). Card line (M2): `SENT 2h (Messenger) · 👁 opened 2h ago · last seen 12 m ago · ✍ —`.

### 6.4 The invoice page after hiring (M3) — tab INCOMES, per-installment PAID by Σ on `installment_id` (refund pair shown), `[+ CHANGE ORDER]` once M4 exists; before M4 the locked fields say "sent rev n — change order arrives soon"; the red chip "balance ≠ plan" when the live grand drifted.

### 6.5 Closing — **D-17** (`rules R2-05`): CLOSED stays date-only (today's C-18 law: Σ listed incomes ≥ grand ∧ every income dated/labelled ∧ `conclusion_date`); unpaid plan rows show as A/R. The M3 CLOSE checklist prints in red "plan rows unpaid: k × US$ …" and the Data Checker card `closed-with-open-plan` lists any CLOSED invoice with an unpaid plan row (M1). DEFAULT A; the owner may pick B (CLOSE requires every plan row paid or an explicit "close with balance").

### 6.6 Wireframes (text)

**(A) QUOTES list — phone (M2)** (`U2-12`)
```
QUOTES (35)                                  [🔍 search] [+ NEW QUOTE]
[ALL 35] [NEEDS ME 4] [WAITING 9] [DONE/OLD 22]        ← groups; zero-count chips hidden; scrolls horizontally if needed
┌──────────────────────────────────────────────────────┐
│ US.QT.028.1 · rev 1  Z2000 Typhon Package  US$ 85,000 │
│ Robert Zapata #75 · 2021 Jeep Trackhawk · Messenger   │
│ ✍ SIGNED 1h · awaiting deposit                        │
│ [COPY PAY LINK]  [⋯]                                  │
├──────────────────────────────────────────────────────┤
│ US.QT.024.3 · rev 2  DemonRango …          US$ 12,900 │
│ Sidney Penna · 2024 Durango · WhatsApp · PT · PIX GZ28BR│
│ ✍ SIGNED 1d · awaiting PIX · ⚠ expires in 3 d        │
│ [RECORD DEPOSIT]  [⋯]                                 │
├──────────────────────────────────────────────────────┤
│ US.QT.033.1 · DRAFT  2022 Ram TRX · Oliveira US$ 27,100│
│ plan 50/50 · tax status: SET OWNER & DESTINATION      │
│ [SEND]  [⋯]                                           │
└──────────────────────────────────────────────────────┘
Last activity first (C-93) — staff/system writes + every first-of-kind client event; beacons never reorder
```

**(B) `/doc/[id]` — QUOTE mode, phone (M1)**
```
← QUOTES   US.QT.028.1 · rev 1  SIGNED · awaiting deposit                                   ⋯
Robert Zapata #75 · 2021 Jeep Grand Cherokee Trackhawk (US.QT.028) · Z2000 Typhon Package
valid until Dec 6 · plan 50/50 · fees ABSORB · pays by card/Zelle/wire · tax EXEMPT (out-of-state, OR) · gate phone ••34 · PROMISED TO —
GRAND TOTAL US$ 85,000.00                                   [CLIENT VIEW ◯]
[ITEMS 11] [SERVICES 13] [EXPENSES 0] [PAYMENT PLAN] [NOTES 5] [DUTIES 13] [ACTIVITY]
─ ITEMS (read-only summary in M1) ─────────────────────────
 11 lines · US$ 85,000.00 (package)                    [EDIT IN EDITOR →]
─ PAYMENT PLAN (becomes INCOMES at hire) ────────────────────
 1  Deposit on approval      50%  US$ 42,500.00  GZ28US   [COPY PAY LINK]
 2  When your car is done    50%  US$ 42,500.00  GZ28US
 ✓ sums to 100 %                        locked — sent rev 1 (NEW REVISION to change)
─ ACTIVITY ─────────────────────────────────────────────────
 Nov 5 22:40  rev 1 frozen · sent via FACEBOOK (copy) to m.me/robert.z… · marcio
 Nov 6 10:14  👁 opened · iPhone
 Nov 6 10:21  ✍ signed · Robert Zapata · e-sign · gate phone ok
              ▸ system (2)
══════════════════════════════════════════════════════════════
[ RECORD DEPOSIT ]            [ COPY PAY LINK ]            [ ⋯ ]   ← ⋯: EDIT IN EDITOR · PRINT · EXTEND · PLAN & TERMS (read-only now) · UNLOCK GATE · ROTATE LINK · VOID
```
RECORD DEPOSIT sheet: **📎 Receipt first** (file → `/api/scan-receipt` mode `payment` pre-fills amount, date, method, R$) → method · RECEIVED BY (GZ28US/GZ28BR; R$ + NF/BR_ENTRY when GZ28BR) · date (today Orlando) · amount (pre-filled from the due installment) → CONFIRM. If no approval exists, the sheet first asks "How did the client approve?" and freezes a RECORDED revision. On a document with hand-made incomes: a picker of open incomes (default oldest unpaid) instead of a plan seq.

**(C) `/doc/[id]` — INVOICE mode, phone (M3)** — as v1 wireframe (C); header adds "formerly US.QT.028.1 (until Nov 6)"; INCOMES rows show PAID by Σ on `installment_id` with the refund pair; bar = `[ RECORD PAYMENT ] [ COPY PAY LINK ] [ ⋯ ]`.

### 6.7 Tap budget — **honest counts** (`U2-02`, `U2-07`, `U2-11`, `U2-16`); M1 unless noted
| Task | Today | This design |
|---|---|---|
| Reach the document on the phone | 2 (list → card) + scanning a code-only list | M1: `/doc` index (1) → line (1) = 2; or legacy V → OPEN IN V2 (2 + scan); M2: list card (1–2) |
| Send (WhatsApp / e-mail) | 4 / 2 pages (SEND → Client → one message with the live PDF) | **3**: SEND → sheet → SEND BY APP (the sent revision's link + text, recorded) |
| Send (Messenger / SMS) | 4 + paste | 4 + paste: SEND → sheet → COPY & OPEN → paste |
| Zapata: approved by chat, wants the pay link | not possible (Dashboard link pasted) | **one sheet, one paste**: SEND → "Client already approved — by text" + note → COPY & OPEN (pay text) → paste ≈ 5 |
| Client approves | one "ok" in chat (no record) | 5 taps (+1 gate), legal floor |
| Client pays | Dashboard link pasted by staff | 1 rail tap + Stripe hosted flow |
| Zelle / wire / PIX deposit in | 4 + file (scan) | **3 + picker + scan wait** (open → attach → confirm); **+2 first time** (approval method + note) |
| See viewed / signed / paid / asked changes | impossible | `/doc` index (M1, 1–2); card line (M2) |
| Change price after SEND, before signature | VIEW → EDIT → change → SAVE & EXIT → VIEW → SEND → Client = 6, 2 pages, nothing recorded | `/doc` → ⋯ → NEW REVISION (lands in E) → change → SAVE & EXIT (back to `/doc`) → SEND → sheet = **7–8, 2 pages**, recorded |
| Add a line after SEND (quote with a target) | free | free — the solver is silenced; SAVE succeeds; "unsent changes" chip shows the drift |
| Change price after signature | edit (no lock, no record) | impossible until M4 (change order); add lines freely; the drift chip + `balance_pending_update` tell both sides |
| Print the signed document (staff) | V → PRINT (live rows) | ⋯ → PRINT (revision snapshot + full certificate) |
| Close | 2–3, drops to INCOMPLETE | 2, checklist with the unpaid-plan line (M3) |

---
## 7. Payments & reconciliation

### 7.1 Webhook (`app/api/stripe/webhook/route.ts` — the claim becomes a state transition; handlers in `lib/stripeEvents.server.ts`)
1. Raw body → `verifyStripeEvent` (400), 503 when unconfigured (shipped). **`stripeClient()` pins `apiVersion` to the SDK's `Stripe.API_VERSION`; `package.json` locks `"stripe": "22.6.2"`** (no caret); `/api/health/env` compares the endpoint's `api_version` with it (`payments P-29`).
2. **Receipt ledger**: `insert stripe_events (id = evt_…, status 'RECEIVED') on conflict do nothing` — the audit row for every delivery.
3. **Mode guard**: `event.livemode` must equal `stripeMode()==='live'` → else IGNORED.
4. **Namespace**: session/PI events without `metadata.app==='control-app'` → IGNORED; charge/refund/dispute/payout events are matched by `payment_attempts.charge_id`/`payment_intent_id`/`payout_id`; no match → IGNORED `{note:'not a Control App charge'}`.
5. **One fulfilment claim per session** (`security R2-03`, `payments P-19`, `RO-02`): for any `checkout.session.*` event the handler maps `evt → cs` and claims the synthetic row **`cs:<checkout_session_id>`**: `insert … on conflict do nothing`, then `update stripe_events set status='PROCESSING', locked_at=now(), attempts=attempts+1 where id='cs:'||cs and status in ('RECEIVED','ERROR') returning id` → 0 rows = in-flight or settled → the `evt_` row is marked DONE `{duplicate:true}` and the route answers 200. The landing claims the **same** row. Stale PROCESSING (> 2 min) and ERROR (< 72 h, `attempts ≤ 5`) are re-queued by `docs-housekeeping` (`RO-10`).
6. **`fulfillCheckout(cs)` is the single choke point and a pure function of observed state** (`payments P-26`): `sessions.retrieve(cs, {expand:['payment_intent.latest_charge.balance_transaction']})`; re-validates `session.livemode`, `metadata.app`, `metadata.attempt_id`, integer `amount_total`; then dispatches on `(attempt.status, session.payment_status, pi.status)`:
   - `paid` ∧ attempt ∈ {OPEN, PROCESSING, EXPIRED} → `book_payment` (EXPIRED books with anomaly `{booked_after_expiry}`, `payments P-27`);
   - `paid` ∧ SUCCEEDED for the same session/PI → `{repeat:true}` → DONE, 200, no event;
   - `unpaid` ∧ `pi.status='processing'` ∧ OPEN → PROCESSING (T6a); `pi.status='requires_action'` (`verify_with_microdeposits`) ∧ OPEN → PROCESSING `verification='microdeposits'`;
   - `unpaid` ∧ `pi.status in ('requires_payment_method','canceled')` ∧ PROCESSING → FAILED (T8; `last_payment_error.code` → `failure_code`);
   - any other combination (e.g. a late `completed` after FAILED, a reversed pair) → DONE `{noop:true, observed:{…}}`.
   A true `amount_total` mismatch still books the received amount with PAYMENT_ANOMALY `{amount_mismatch}`; a currency not the tenant's → `SUCCEEDED_UNBOOKED` + anomaly `{currency}` (§3.3 1b).
7. **Business refusals never throw**: `book_payment` returns `{anomaly}` after writing; the handler records DONE `{anomaly}` and answers **200** (Stripe must not retry a refusal). **True errors** (RPC exception, Stripe API failure) → the `cs:` and `evt_` rows set to ERROR and the route answers **500** so Stripe retries (C-88, `rules R2-15`); the landing route maps the same failure to 200 `{state:'landing_pending'}` and the page polls.
8. Other events: `checkout.session.expired` → T9 (OPEN only) · `charge.refunded` → trigger for `refunds.list({charge})` (T16, `payments P-24`) · `refund.updated` / `refund.failed` → T16 · `charge.dispute.*` → T17 **with the M1 money row** · `payout.paid` → `balanceTransactions.list({payout, type:'charge'})` → `payment_attempts.payout_id` per charge (M1 — `payments P-31`); `payout.failed` → owner alert key · default → IGNORED. `charge.refund.updated` (deprecated) not used.
9. **Mute**: decided inside `book_payment` from the document (`is_test`); `livemode=false` on a real document is a **refusal**, not a mute (`security R2-01`).
10. **No automatic refund, ever.**
11. `maxDuration = 60`; SQL in-request, consequences in `after()`; **latency budget for `book_payment` ≤ 3 s** (A-08 records it — Checkout's redirect waits on every endpoint subscribed to `completed` on the shared account, `payments P-28`).
12. **Landing**: `/q/return?t=…` → page POSTs `/api/q/landing` → claims `cs:<cs>` (same transition) → `fulfillCheckout` → stage or `landing_pending`.

### 7.2 Idempotency
Inbound: `stripe_events.id` PK (`evt_` receipt + `cs:` fulfilment) + PROCESSING claim; `payment_attempts.checkout_session_id`/`payment_intent_id` UNIQUE; one-open index; `book_payment` invoice row lock + advisory lock per attempt + repeat detection by session/PI (benign) vs replay (anomaly); `income_settle where paid_at is null`; fee row unique by `order_number`; refund/dispute rows unique by `refund_id`. Outbound: Stripe `Idempotency-Key = attempt.id`, **one attempt row per Checkout Session** (`security R2-09`, `payments P-21`); `customers.search` before create; manual refunds (M5) key `re:<attempt>:<n>`. Replay: `/adm/payments` REPLAY (M5) or `stripe events resend` → a DONE event is a no-op; the same session against its SUCCEEDED attempt → `{repeat:true}`; a **different** session/PI against a SUCCEEDED attempt → PAYMENT_ANOMALY `{replay}`.

### 7.3 Mapping Stripe → `invoice_incomes`
| Fact | Where |
|---|---|
| `completed` observed `unpaid` + `pi.processing` | `attempt.authorized_at`, `payment_intent_id`, PROCESSING; event DEPOSIT_AUTHORIZED |
| `paid` (card) | income `paid_at = orlando_noon(orlandoDay(charge.created))`, `source='STRIPE'`, `paid_to` from the revision, **`receipt_url` untouched (no hosted URL)**, `installment_id`, `attempt_id`, `payment_reference='stripe:<ch>'`; attempt charge facts incl. `account_holder_type` |
| `async_payment_succeeded` (bank) | `paid_at = orlando_noon(orlandoDay(event.created))` — settlement day; `attempt.authorized_at` keeps the client's day |
| `invoices.hiring_date` | the same day as the deposit's `paid_at` |
| `balance_transaction.fee` | fee expense row inside the transaction, live only (§7.4) |
| refund | one negative row per `re_…` (from `refunds.list`), same `installment_id`; `refund.failed` → reversing row |
| dispute (M1) | negative row `refund_id='dp_<id>'`, same `installment_id`, `paid_at` = event day; `funds_reinstated`/won → reversing row |
| payout (M1 column, M5 table) | `payment_attempts.payout_id` → Bank Link MIXED |

### 7.4 Fees accounting (Q-11) — corrected (`rules R2-03`, `rules R2-13`, `consumers #7`, `payments P-31`)
`invoice_expenses` row per live charge, inserted inside `book_payment`/`quote_hire`: `item='Stripe processing fee — installment k/n'`, `supplier='Stripe'`, `nature='MONEY'`, `price=fee`, `quantity=1`, `payment_date=expense_date=charge day`, `paid_from=paid_to='GZ28US'`, **`source='GZ28US'`** (C-49), `payment_method='STRIPE'`, `order_number=<txn_id>` (unique index), `export_status='FRESH'`, **`receipt_url=[]`, `receipt_proves_payment=true`** (the client's charge receipt is proof of the *income*, C-62 — not the vendor document for the fee; the M2 ladder step 5b writes the Stripe fee voucher PDF path into `receipt_url` with kind `STRIPE_RECEIPT`, filed in the Invoices folder under the C-53 name), `payment_reference='stripe:<ch>'`, `reported_at = NULL` so the classic expense balloon reports a real cash-out once. Until M2 the Data Checker `paid-no-receipt` card lists these rows ("proof pending") and the morning note says so. **Test money writes no fee row.** The fee is never paid from Regions — it is netted inside the payout: until `payout_id` is matched the income and the fee are honestly UNLINKED in the checker (no `stripe:` special case). GROSS_UP recovered surcharge = negative MONEY expense `<txn>:rec` (§3.5). ACH failed-debit and dispute fees: M4/M5 as MONEY rows.

### 7.5 Payouts → Regions — `payout.paid` writes `payout_id` on the attempts in M1 (`balanceTransactions.list({payout})`); the MIXED matcher accepts a Regions credit = Σ(income − fee) over rows sharing a `payout_id` in M2; `stripe_payouts` table + `/adm/payments` M5. Nothing is "linked" until `payout_id` is set.

### 7.6 FL tax — amounts frozen in cents at SEND; `fl_tax_cents` in the session metadata for Dashboard readers; **the filing comes from the Control App export only; Stripe Tax covers shop orders only; never add the two** (`payments P-32`); after signature the approved revision's `fl_tax`/`fl_tax_status` are the truth (M3 readers; M1 drift card). A unit test asserts no `automatic_tax` and `unit_amount == installments[seq].amount_cents`.

### 7.7 Deposits vs final balance — PAID per installment by Σ on `installment_id`; refund/dispute rows reverse on the same id; the last-row PAY is hidden while the live grand drifts from the plan.

### 7.8 Non-Stripe payments — first class; attempt born OPEN and flipped to SUCCEEDED inside `book_payment`; `installment_id` nullable for documents without a plan; `deposit-manual` expires any OPEN Stripe session first; `CASH/OTHER` above `deposit.manual_cap` requires a receipt.

### 7.9 Stripe Dashboard / account preconditions (owner/morning tasks)
- Test endpoint `we_1UYjOkQekIwjYgOOhADU2tsD`: **updated tonight by API** (`webhookEndpoints.update`) with `refund.updated`, `refund.failed`, `charge.dispute.updated/funds_withdrawn/funds_reinstated/closed`, `payout.paid`, `payout.failed`; the live endpoint is **created by API** at the switch (`webhookEndpoints.create({url, enabled_events: settings['stripe.endpoint_events'], api_version: Stripe.API_VERSION})`) so neither the list nor the version is typed by hand (`payments P-29`, `RO-14`).
- ACH Direct Debit + Financial Connections activation (test and live); then `payments.rails_enabled += 'us_bank_account'`; verification `automatic` (instant when the bank is in Financial Connections, microdeposits otherwise).
- **Customer emails (honest, final — `rules R2-02`, `payments P-23`)**: hosted Checkout collects the payer's e-mail and **writes it onto the Customer when the Customer has none**; Stripe then sends the account's receipt per the Dashboard switch "Successful payments" (ON today for shop buyers on the shared account). Test payments never trigger receipts, so tonight cannot reveal it. The only levers: the account-level switch (shared with the shop) or a separate account (D-15 B). The owner's choice is recorded in `app_settings['stripe.customer_emails_checked'] = {live:true}` **before** any live session can be minted (code gate in `/api/q/checkout` and `deposit-manual`; `/api/health/env` lists it). `notify.client.stripe_receipt` only adds `receipt_email` (forces a receipt even when the account switch is OFF). The ACH mandate confirmation is sent by Stripe per Nacha regardless (disclosed in the CLEARING copy).
- **Shared account cross-fire** (`payments P-28`): each endpoint's failures appear in the other's Dashboard "failing endpoint" banner; A-29 asserts a Control App test refund/dispute delivered to the shop endpoint answers 200 (`stripe trigger` against both).
- **ACH dispute window** (`payments P-22`): personal accounts may dispute for 60 calendar days and the dispute is final; the attempt records `account_holder_type` and ACTIVITY prints it so the owner knows the window before buying parts (D-01 note).

---

## 8. Notifications & documents

### 8.1 Switch registry — every **robot** key in `app_settings`, ALL `false` (constraint 10, C-68); `/adm/notifications` (M4) groups MONEY · QUOTE FLOW (not money) · OWNER ALERTS; SEND TEST TO ME only to `notify.test_targets`; every decision logged NOTIFIED/NOTIFY_SKIPPED

**Not a key** (`U2-02`): a staff tap on **SEND BY APP** in the SEND sheet (WhatsApp document message by `/api/whatsapp`, e-mail by `/api/mail/client` kind `quote-link`) is today's manual send — a human composing and approving at the moment of the tap (memory `never-send-unauthorized`, 18/10 exception: human-initiated app sends continue; `view-page.md` §9.6). It is recorded as SENT `{by_app:true}`. Tonight it is exercised only against the fixture's own addresses.

**Pre-existing robot kept, now keyed for V2 rows** (`consumers #9`): the DELAYED robot (`recurring-expense-reports`) keeps today's behaviour for legacy rows; plan rows (`installment_id not null`) are included only when `notify.reports.installment_delayed` is ON (default false).

| Key | Group | Template (EN; PT mirrored) |
|---|---|---|
| `notify.client.quote_sent.whatsapp` / `.email` | client (robot resends only — e.g. auto-resend on EXTEND, M4) | §6.2 text |
| `notify.client.signed_copy` · `.deposit_clearing` · `.deposit_received` · `.deposit_failed` · `.installment_due` · `.quote_expiring` · `.change_order` · `.stripe_receipt` (adds `receipt_email`) | client | as v1; `deposit_clearing` adds the mandate sentence |
| `notify.reports.quote_sent` · `.quote_viewed` · `.changes_requested` · `.quote_declined` · `.renewal_requested` · `.quote_signed` · `.quote_expiring` · `.quote_unopened_48h` | **QUOTE FLOW (not money)** — never recommended first | "📤 *QUOTE SENT* {code} — {car} · {client} · {total} · **markup {x}%** · via {channel} · valid until {date}" (**markup kept — C-26 says REPORTS sees it on quotes; dropping it is D-10's question, not a default** — `rules R2-07`) · "✏️ *CHANGES REQUESTED* {code} — {client} · open ACTIVITY: {doc_url}" (never client text) · "✍ *QUOTE SIGNED* {code} — {car} · {client} · {total} · markup {x}% · deposit {amount} pending" (signer name sanitized, not interpolated) |
| `notify.reports.deposit_clearing` · `.deposit_received` · `.installment_delayed` | MONEY | "💰 *DEPOSIT RECEIVED* {new_code} — {car} · {client} · {amount} via {method} (fee {fee} absorbed) · PROJECT BORN {ride_code} · plan {n} × … · 🗓 PROMISED TO: {date}" — claims income and fee ids; OFF → the classic net balloons income and fee separately |
| `notify.owner.payment_failed` · `.refund` · `.dispute` · `.payment_anomaly` · `.payout_unmatched` · `.gate_cap` | OWNER ALERTS | red balloons; **`.dispute` and `.payment_failed` are live-switch preconditions** (`/api/health/env`, `payments P-22`) |
| Behaviour keys | — | `quote_portal.enabled` · `qi_v2.actions` · `qi_v2.enabled` · `quote.hire_on` ("CLEARED") · `payments.ach_verification` ("automatic") · `payments.rails_enabled` (["card"]) · `quote.gate_default` ("CONTACT_25K") · `quote.rotate_at_hire` (false, D-18) · `stripe.endpoint_events` · `stripe.customer_emails_checked` ({test:true, live:false}) · `deposit.manual_cap` (10000) · `notify.test_targets` ([]) · `test.keep` (false) |

**Structural (no key)**: the Daily Mega-Report's 🏁 HIRED line (with the plan summary) and ⚠ DISPUTE / FAILED AFTER SETTLEMENT line — reports of money that moved (C-65, C-66).

Rules kept: C-67, C-69 (kinds `quote-link`, `quote-signed`, `deposit-receipt`, `installment-due`, `quote-expiring`, `change-order`; `/api/mail/client` resolves paths from `invoice_revisions.pdf_path`, never caller-supplied), C-71, C-23, C-15, C-85.

### 8.2 PDF generation — print view tonight (light print stylesheet); vector M2 from the revision snapshot; private bucket; gated when a gate exists.

### 8.3 Dropbox filing — as v1; skipped for `is_test`; **only storage URLs ever enter `receipt_url`**; step 5b files the fee voucher (M2).

---

## 9. Reuse vs replace

**Kept as-is**: the v1 list stands (shipped foundation, pure rulers, robots, RPCs, `applyPack`/`duplicateQuote` rules, expense engines, `T` label map, shop Stripe discipline, `scripts/*`, `data_fixes`).

**Legacy edits tonight — eleven, all additive, each justified** (constraint 2: the pages keep *working*, and each edit exists so that they do):
1. `E:218` `importIntuitiveParts` skips `nature==='MONEY'`.
2. **`E` guard** (`r1 U-01/U-03`, `consumers #3`, `U2-01`, `security R2-11`, `U2-11`, `U2-17`): one read at open — `live_revision`, `invoice_approvals`, OPEN/PROCESSING attempts. When a live revision exists: red banner "SENT rev n — prices locked (C-16). Add lines freely; to change prices tap NEW REVISION in **/doc** (`<Link>`)"; **disable** MARGIN, TARGET GRAND TOTAL, GLOBAL DISCOUNT, FL TAX select, per-row price/qty/description inputs and row delete for the frozen ids; **early-return the TARGET solver effect at `E:1896` and skip the labor-row UPDATE at `E:2791-2795` when that row id is frozen** (TARGET shown read-only "frozen by rev n"); save order untouched. When an approval or an open attempt exists: HIRING DATE read-only with "approved online — the deposit converts this quote; use RECORD DEPOSIT in /doc". **INCOME panel rows with `installment_id` are read-only** ("settle in /doc → RECORD PAYMENT"). `?from=doc` makes SAVE & EXIT return to `/doc`. Legacy quotes (no revision) see no change.
3. **`lib/zelleWatch.server.ts`** (`consumers #1`, `#11`): selector `paid_at is null` with the legacy undated semantics kept for rows without `installment_id`; prefer `installment_id` rows on exact match; matched plan row → `income_settle()` RPC (`source='ZELLE'`, `payment_reference='zelle:<conf>'`, description untouched); **no PALPITE when the client has any open plan row — a doubt is written instead**; rows without `installment_id` keep today's path byte for byte.
4. **`app/api/cron/daily-report/route.ts`** (`rules R2-04`, `payments P-22`): select `invoices(…, quote_links(is_test))`; skip `is_test` documents; **exclude `installment_id not null ∧ paid_at null` rows from the "registered" section**; 🏁 HIRED line from `invoice_events kind='HIRED'` with `plan: n × … (k received)`; ⚠ DISPUTE / FAILED AFTER SETTLEMENT line from `invoice_events kind in ('DISPUTE_OPENED','DEPOSIT_FAILED')`; `?dry=1`.
5. **`lib/expenseReportNet.server.ts`**: skip `is_test` documents (one join + one `continue`); **sign-aware label** — amount < 0 → "*REFUND / CHARGEBACK*" (`payments P-25`).
6. **`app/api/cron/recurring-expense-reports/route.ts`**: skip `is_test`; skip `installment_id not null` rows unless `notify.reports.installment_delayed` (`consumers #9`).
7. `components/PaymentFields.tsx`: `PAYMENT_METHODS += 'STRIPE'`.
8. Legacy `V` header: `<Link>` **OPEN IN V2 →**; PRINT notice when a revision exists.
9. `components/AuthGate.tsx` `PUBLIC_PREFIXES += '/q/'`; `next.config.ts` headers (`/q/:path*`, `/api/q/:path*`); `app/api/stripe/webhook/route.ts` claim → `cs:` state transition + 200-on-refusal / 500-on-error semantics; `lib/stripe.server.ts` `apiVersion` pin; `package.json` exact `stripe` version.
10. **`lib/intercompanyLedger.server.ts:245-254`**: `dayIn(paid_at, 'America/New_York') || ymd(payment_date)` (`rules R2-06`).
11. **`app/adm/check`**: three new cards (`closed-with-open-plan`, `signed-total-drift`, `plan-sum-drift`); no change to `paid-no-receipt` / `paid-no-bank` (they list the Stripe rows honestly).

**Withdrawn from v2** (`payments P-31`, `consumers #8`): the `lib/paidNoBank.ts` `bankRef` extension for `stripe:` — Stripe rows are unlinked until `payout_id` is matched; silence would have hidden a real gap until M5.

**Replaced, and why** — as v2, plus: raise-after-write → return-after-write (`RO-03`); two claim keys → one `cs:` key (`P-19`); event-type dispatch → observed-state dispatch (`P-26`); `x-q-token` header → cookie read server-side (`P-20`); column REVOKE → column-list GRANT (`security R2-02`); `trg_incomes_touch` → explicit `updated_at` (`RO-13`); CHECK on `is_test` → trigger (`RO-05`); cleanup script deletes → `fixture_delete()` RPC (`RO-07`).

**Rejected refuter proposals kept out of the design** (see §17): the `stripe:` bankRef special case (superseded); booking a foreign-currency amount into the USD ledger (variant: held as anomaly); `payer_houses` table, pre-selected elections, merged consents, `delivery_date` twin, legacy per-ride pill (r1).

---

## 10. Migration & rollout

Keys: `quote_portal.enabled`, `qi_v2.actions`, `qi_v2.enabled`; `is_test` documents bypass the first two; `seed_terms` is exempt. Stripe TEST tonight; **live = three env values** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_ENDPOINT_ID`) + the live endpoint created by API with the full event list and pinned version + `stripe.customer_emails_checked.live=true` + `notify.owner.dispute`/`.payment_failed` ON — `/api/health/env` refuses the live check otherwise (constraint 11: env-only switch, code-side gates). **M1–M5 are US-only by design; the BR repo is not deployed until M6** (`RO-16`; owner informed in the morning note). **D-15**: going live on the shop's shared account means Stripe-branded e-mails per that account's setting and cross-visible endpoint failures; the owner decides.

| Milestone | Ships | When | Risks |
|---|---|---|---|
| **M1 — tonight: the Zapata path in test mode** | §16 steps 1→12: pre-flight + migration + functions + triggers + GRANTs; `lib/orlando.ts`, `lib/quoteDoc.server.ts` (DTO, cents, canonical JSON, `sha256` + `presented_sha256` + `terms_sha256`, `displayCode`), `lib/quoteStage.ts`, `lib/quoteStrings.ts` (+ terms text EN/PT), `lib/auth.server.ts::requireStaff`; `/doc/[id]` shell + `/doc?code=` + `/doc` index; `/api/doc/[id]/*` behind `actionsAllow`; public `app/q/[token]/layout.tsx` + page + print + `/api/q/*` (cookie per link, landing token, gate HMAC, two-key limiter, CSP) + `/q/return` states; `lib/stripeEvents.server.ts` (`cs:` claim, pure `fulfillCheckout`, `book_payment`, refunds.list, dispute row, payout_id); `renumberBR.server.ts::recodeCommonCar`; `docs-housekeeping`; the eleven legacy edits; ride-promotion test rolled back; shopping-fixture end-to-end test; `fixture_delete` | tonight (**19–23 h**) | pre-flight duplicates; Dashboard ACH unknown (card-only rails); `alloc_ride_code` parity gate; 03:00 report — structural `is_test` skip + `fixture_delete` auto-cleanup |
| **M2 — documents + QUOTES list** | vector PDF + certificate; private bucket serving (gated); signed copy; client receipt PDF; Dropbox step 5 + **5b fee voucher**; `/quotes` rebuilt (grouped chips, search, honest card line, first-of-kind sort); MIXED matcher Σ(income − fee) per `payout_id`; `LEGACY_BACKUP` backfill | day 1 | jsPDF in Node |
| **M3 — the document page** | `/doc/new`, full tabs, `/invoices` rebuilt, SET ONLINE chip, CLOSE checklist (unpaid-plan line), PROMISED TO readers, `lib/money.ts` re-host **reading the approved revision first**, `qi_v2.enabled` Header entry, full E banner | day 2–4 | expense engine extraction |
| **M4 — money & legal ops** | change orders (`change_order_apply`, restores PAY), `/adm/notifications` + senders (OTP on the same channel), DELAYED robot open-attempt skip, ACH/dispute fee rows, CHECKs + `trg_incomes_paid_at_noon` after D-11/D-12 | day 4–6 | senders honour `false` by default |
| **M5 — reconciliation & numbering** | `stripe_payouts`, payout handlers, payouts sync → `match_mixed`, `/adm/payments` (REPLAY, REFUND, unlinked incomes, stale PROCESSING, `is_test` artefacts), renumber route adopts `alloc_ride_code` | week 2 | payout descriptor |
| **M6 — cleanup & BR port** | editor conversion path retired; column drops after audits; redirects; **BR migration as its own templated file** (`{{incomes}}`, `{{items}}`, `{{currency}}='brl'`, payer CHECK with CLIENT, NF-e hook after `fiscal_note_payments_trava`, `trg_stock_sempre_pago` co-existence); `TenantConfig` (BRL anchor, PT, LGPD, C6/PIX, no Stripe, `contact` per channel, `fdacs_registration` n/a); BR `AuthGate` prefix | week 2–3 | BR trigger landscape |

### 10.1 Order of shipping tonight — §16 steps, commit per step, `git add` by path (C-99); `tsc` + `lint` + a local `next build` before each push (C-97; `RO-12` makes the build pass without the service key); migration shown inline and trailed (C-98). Nothing is sent to anyone; the only Stripe traffic is TEST on our own fixture.

### 10.2 The end-to-end test and its cleanup (constraint 10)

**A. Ride-promotion branch — rolled back, never committed.** `scripts/roda-sql.mjs --file test-quote-hire-ride.sql`: `begin; <disposable quote ride US.QT.9xx + invoice + terms/plan + RECORDED revision + SHOP_PHONE approval + OPEN attempt>; select book_payment(...); <asserts>; rollback;`. Asserts: `project_code = nextFreeCode(live,'US')`, every invoice re-prefixed, three `is_quote` flags false, two incomes (seq 1 paid), `data_fixes` rows, HIRED event with the plan summary. Nothing persists.

**B. Shopping fixture — committed, exercised through Stripe, then deleted.**
1. Fixture via `scripts/quote-portal-fixture.mjs` (service role): test client "GZ28 TEST — Quote Portal" (`is_quote=true`, USA/OR, e-mail gz28us@hotmail.com, phone = the shop's own number, `origin PROJECT`), no ride; quote duplicated from US.QT.028.1's shape; `seed_terms`; `quote_links` minted with `is_test=true` (trigger-guarded). `quote_portal.enabled` and `qi_v2.actions` stay `false`. **A second fixture client with country BRAZIL** for the PT path (A-03b, A-19).
2. Before the first checkout: `GET /api/cron/daily-report?dry=1` body saved; report-net query replica saved.
3. Scenarios: SEND (RECORDED, COPY, **SEND BY APP to our own e-mail**, **`already_approved` chip**); VIEW beacon (real UA / crawler UA); gate (wrong ×5 per ip → 15-min lock; `Robert.Zapata@Gmail.com ` vs lower-case → pass; UNLOCK GATE); SIGN (stale hash 409; **stale terms hash 409**; LIMIT without amount 400 `err_limit`; good); **supersede ‖ sign → one winner**; card `4242…` → one hire; **expire the OPEN attempt by hand → PAY → new attempt row, new `cs_`**; **real-link + test key → 409 `rail_unavailable`; forged `livemode=false` session on a non-test attempt → UNBOOKED + anomaly, `is_quote` unchanged**; ACH only if `payments.rails_enabled` includes it (`000123456789` → PROCESSING → `async_payment_succeeded` → hire with `paid_at` = event day; `000222222227` → FAILED; `000000000009` → CLEARING); **concurrent landing + webhook → one hire, both `cs:` claimants DONE, zero PAYMENT_ANOMALY, attempt SUCCEEDED**; the three orderings of `completed`/`async_*`; forced DB error → ERROR → housekeeping re-run → DONE; replay of a DONE event → no-op; **same session against the SUCCEEDED attempt → `{repeat:true}`, no event; a different session against it → anomaly `{replay}`**; shop test session / refund → IGNORED; **Control App test refund + dispute delivered to the shop endpoint → 200 (A-29)**; second paid session for seq 1 → applied to seq 2 + anomaly, no `refunds.create`; **two partial card refunds → two negative rows with `installment_id`, Σ = `amount_refunded`; full refund of seq 1 → DEPOSIT REFUNDED, PAY visible, HOME due = 42,500**; **dispute created → negative `dp_` row; funds_reinstated → reversing row**; legacy HIRING DATE first, Stripe `paid` second → exactly one income; RECORD DEPOSIT (Zelle / PIX GZ28BR) muted; **RECORD PAYMENT on a legacy invoice with two hand-made incomes → still two rows, one paid, no plan rows**; VOID with an OPEN session → `revoked_at` set, session expired, payment refused → anomaly `{voided}` returned with 200; NEW REVISION after SEND → lock lifts; `trg_invoices_quote_flip` refuses a stale `is_quote=true` write **and passes `live_status='INCOMPLETE'` on a legacy invoice with hand-made incomes**; **SENT quote with `target_grand_total` → + ADD ITEM in E → SAVE succeeds, labor unchanged**; **landing with no cookie → `return_no_session`, webhook books, re-open shows HIRED**; Zelle dry runs A-23/A-23b/A-23c; bridge JWT → 403 on `/api/doc/[id]/link`.
4. Assertions at every step: `invoice_incomes` on quotes = 0; every money row of the fixture `reported_at not null`; no `invoice_expenses` row for the fixture; `wa_send_log` unchanged except the one SEND BY APP to our own address (none for WhatsApp — the fixture has no WhatsApp destination); zero `NOTIFIED`; `?dry=1` body contains no fixture code at any time; `has_function_privilege('anon'|'authenticated', fn, 'execute') = false`; `select token from quote_links` as `authenticated` → **permission denied**.
5. **Cleanup = `fixture_delete()` immediately after the last scenario** (hard belt: 02:00 Orlando, verified with `scripts/agora.mjs`; structural net: `docs-housekeeping` calls the same RPC for `is_test` hires older than 2 h unless `test.keep`): expires any OPEN Stripe session, sets attempts `VOIDED_TEST` and `quote_links.revoked_at` first, writes the full-row JSON of every child into `data_fixes` (label `quote-portal-test-0611`), deletes in FK order (§4.3 #19), clears `clients.stripe_customer_ids.test`. **`client_number` discipline** (`RO-15`): the hire assigns `max+1` (step 5 exercised); the script immediately rewrites the fixture client's number to **9999** with a `data_fixes` row, so the real sequence is held for one transaction, not two hours; the deletion then frees 9999. Never flips `is_quote` back; never deletes a real expense. `stripe_events` rows stay. The morning note lists every id, the `?dry=1` bodies, the pre-flight counts, the Dashboard toggles, the `is_test` links left (none), and D-04/D-06/D-13/D-14/D-15/D-16/D-17/D-18/D-19.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Paid session with no income | `book_payment` branches on the invoice, materializes only when the document has zero incomes, settles a picked income otherwise; asserts `income_id` when no anomaly; books EXPIRED-but-paid with anomaly |
| **Test money hires a real document** | mode rule in `/api/q/checkout` (409) + refusal inside `book_payment` (UNBOOKED + anomaly, returned) |
| **Refusal leaves no trace** | refusals write then **return**; raise only on bugs → 500 → Stripe retries |
| **Landing ‖ webhook storm** | one `cs:<session>` claim; repeat detection `{repeat:true}`; `fulfillCheckout` never downgrades a SUCCEEDED attempt; webhook 200 on duplicates/refusals |
| Money collected on a superseded revision | `attempt.revision_id`; `quote_send` 409 while an attempt is open; invoice row lock in every state function |
| **Sign ‖ supersede race** | `perform … for update` first statement everywhere; `attempt_open` re-reads under the lock; void sets `revoked_at` first |
| Stale legacy tab demotes a hired invoice | `trg_invoices_quote_flip` (a) universal |
| **Legacy status cycle / HIRING DATE broken** | `trg_invoices_quote_flip` (b) scoped to V2 facts; A-18/A-22 |
| **Half-saved SAVE on a sent quote with a target** | E guard silences the solver and skips the frozen labor UPDATE |
| **Re-mint returns the dead session** | new attempt row per session; new idempotency key |
| **PROCESSING ACH expired by cron** | only OPEN expire by time; stale PROCESSING → anomaly + alert |
| Double fee / double events | fee inside the transaction + unique index; one claim per session |
| Test money in REPORTS / Daily Mega-Report | document-level mute; structural skips; `fixture_delete` auto-cleanup |
| **Predictions in the Daily Mega-Report** | unpaid plan rows excluded from "registered"; folded into HIRED |
| **Dispute unnoticed for 60 days** | structural DISPUTE line; dispute money row in M1; live-switch preconditions on the two owner keys; `account_holder_type` on ACTIVITY |
| ACH deposit invisible to the net | `paid_at` = settlement day |
| First live deposit never ballooned | explicit `updated_at`; fee row `reported_at` NULL |
| **Any JWT reads tokens / Checkout URLs** | column-list GRANTs (no table-level SELECT); no authenticated policy on `quote_links`; `url` excluded; A-21 asserts permission denied |
| **Machine account hires by hand** | `requireStaff` refuses `MACHINE_ACCOUNTS`; `recorded_by` = JWT e-mail; LINK_COPIED events; manual cap needs a receipt |
| anon calls the functions | REVOKE from public/anon/authenticated; A-21 |
| Real quote hired while the portal is OFF | `portalAllows` + `actionsAllow`; `seed_terms` is the only exempt write (no money, no link) |
| **Gate forged / DoS on the real client** | HMAC cookie; normalised answers; per-(link, ip) fails; daily cap notifies staff; UNLOCK GATE |
| **Link held forever by a third party** | ROTATE LINK at any stage; masked public certificate; receipts behind the gate |
| **Limiter starves the client / unknown tokens unlimited** | two-key buckets; `(ip,'resolve')` for unknown tokens; 48-h trim |
| **Cookie lost in an in-app browser** | cookie `Path=/ca` per link; signed landing token; `return_no_session` page; webhook books regardless |
| **Public money routes cannot authenticate** | cookie read server-side; no header |
| Stripe e-mails in live mode on the shared account | honest D-06; `stripe.customer_emails_checked` gate before any live session |
| **Refund leaves the installment PAID** | PAID by Σ on `installment_id`; DEPOSIT REFUNDED state; refunds.list for card |
| **Fee row with a borrowed receipt in the sacred folder** | `receipt_url=[]` + `receipt_proves_payment`; M2 voucher PDF via storage; cron never sees a hosted URL |
| **Hand-made incomes doubled by the plan** | `seed_terms`/`book_payment` never materialize on a document with incomes; nullable `installment_id` for manual attempts |
| **Live grand drifts from the signed plan** | header fields locked; drift chips; `balance_pending_update`; approved revision = truth for M3 readers |
| **CLOSED with half unpaid, silently** | D-17; checklist line; `closed-with-open-plan` card |
| Legacy REMOVE breaks on RESTRICT children | cascade for terms/installments/links/events/notes; `set null` on `revision_id` |
| **Fixture cannot be deleted from the cron** | `fixture_delete()` RPC with transaction-local GUC and FK order |
| **Migration fails to compile** | `is_test` guard is a trigger; DDL reviewed against PostgreSQL CHECK rules |
| **Metadata language always EN** | `app/q/[token]/layout.tsx` owns `generateMetadata` |
| **Local build fails without the service key** | throw inside functions, not at module scope |
| **Header sources double-prefixed** | sources without `/ca` |
| **Payload drift across Stripe versions** | pinned `apiVersion`; locked SDK; endpoint version check; live endpoint created by API |
| **ACH dead end for banks outside Financial Connections** | `verification_method='automatic'`; microdeposit state + copy |
| Sidney's BR mirror diverges after hire | ladder step 3b |
| Brazilian client sees USD rails / EN terms | seed by payer house + language; PT terms hashed in PT |
| V2 unreachable from the phone | OPEN IN V2; `/doc?code=`; `/doc` index; EDIT IN EDITOR; link back from E |
| `alloc_ride_code` drift | A-02 blocking gate |
| BR port forced early | separate templated migration (M6); M1–M5 US-only |

---

## 12. Effort estimate (agent-hours, one App Development 2 session) and what I am unsure about

| Milestone | Hours |
|---|---|
| M1 tonight (pre-flight + migration 3 · functions/triggers/GRANTs/`fixture_delete`/`attempt_open` 3.5 · DTO/hash/terms/stage/strings 2.5 · public layout/page/routes/cookie/landing token/gate HMAC/two-key limiter/CSP 4.5 · checkout + pure `fulfillCheckout` + `book_payment` + refunds/dispute/payout handlers 3.5 · `/doc` shell + index + sheets 3 · eleven legacy edits 2 · cron/AuthGate/headers/health 1 · tests + fixture + cleanup 2) | **19–23** (was 16–20; the extra is the r2 criticals: claim key, cookie path, re-mint, mode refusal, E solver guard, fixture RPC) |
| M2 | 9–11 (+ fee voucher, MIXED per payout) |
| M3 | 16–20 |
| M4 | 9–11 |
| M5 | 8–10 |
| M6 | 13–15 |
| **Total** | **≈ 74–90** |

Unsure: (1) jsPDF in Node; (2) Zapata's `state='OR'` and whether a phone exists for the gate; (3) Regions payout descriptor; (4) Dashboard state — ACH, Financial Connections, pt-BR, Customer emails; (5) the statement-descriptor prefix length of the shop account; (6) `match_mixed` signature; (7) counsel items (§559.905 wording, consents, dispute policy, FDACS number, address, surcharge tax, PT terms); (8) BR legal block; (9) whether the owner accepts "sent = locked" (D-16) and "included" (D-04); (10) `x-vercel-forwarded-for` presence behind the `/ca` rewrite; (11) 18th cron within the plan; (12) whether Stripe's 10-s redirect wait applies per endpoint on the shared account (we budget as if it does).

---

## 13. DECISION LOG

v1 entries L-01 … L-42 and v2 entries L-02' … L-60 stand unless amended below; new or changed entries:

| # | Decision | Options | Chosen (v3) | Why / driver |
|---|---|---|---|---|
| L-09'' | Token at rest | column REVOKE (v2) · **column-list GRANT, no authenticated policy** · separate secrets table | column-list GRANT | PostgreSQL: column REVOKE under a table GRANT is a no-op; the brake regex accepts a column list; a secrets table would still need the brake's grant and rely on "no policy" alone — `security R2-02`, `RO-04` |
| L-14'' | Stripe e-mails | "no e-mail on the Customer" (v2) · **honest: Checkout writes the e-mail; account switch or separate account; code gate `stripe.customer_emails_checked`** | honest + gate | `rules R2-02`, `payments P-23` |
| L-43' | Money booking entry point | raise on refusal (v2) · **write then return `{anomaly}`; raise only on bugs** | return | a RAISE rolls back the trace — `RO-03`; C-88 kept for true errors |
| L-59' | Fulfilment claim | `evt_` + `landing:<cs>` (v2) · **one `cs:<session>` row for both paths** | `cs:` | `security R2-03`, `payments P-19`, `RO-02` |
| L-60' | Return URL | attempt id + httpOnly cookie path `/ca/q/` + header (v2) · **cookie per link `Path=/ca` read server-side + signed landing token** | the latter | `payments P-20`, `U2-03`, `RO-08`, `security R2-14` |
| L-61 | Test money on a real document | muted (v2) · **refused** (route 409 + `book_payment` UNBOOKED) | refused | mute ≠ refuse — `security R2-01` |
| L-62 | `trg_invoices_quote_flip` second half | any income (v2) · **approval or `installment_id`** | V2 facts | constraint 2; C-17 INCOMPLETE is legal — `rules R2-01`, `consumers #2` |
| L-63 | TARGET solver on a sent quote | inputs disabled only (v2) · **solver effect + labor re-save silenced** | silenced | `consumers #3`, `U2-01` |
| L-64 | Plan materialization on an existing invoice | always when no plan row (v2) · **only when zero incomes; otherwise settle a picked income** | zero incomes | `consumers #5` |
| L-65 | PAID per installment | existence (v2) · **Σ amounts ≥ plan − 0.01; refund/dispute rows carry the id** | Σ | `consumers #6`, `payments P-25` |
| L-66 | Fee row proof | `[charge.receipt_url]` (v2) · **`[]` + `receipt_proves_payment`; M2 voucher PDF via storage** | voucher | C-53/C-62 — `rules R2-03`, `consumers #7` |
| L-67 | Unpaid plan rows in the Daily Mega-Report | listed NOT RECEIVED (v2) · **excluded; folded into HIRED** | excluded | C-66 — `rules R2-04` |
| L-68 | CLOSE and the plan | silent (v2) · **D-17: date-only (A) with checklist + checker card** | A | C-18 letter, C-100 — `rules R2-05` |
| L-69 | `intercompanyLedger` dating | M4 (v2) · **tonight, legacy edit #10** | tonight | constraint 2 — `rules R2-06` |
| L-70 | Stripe `payment_reference` and the bank checker | `stripe:` = linked (v2) · **honest UNLINKED until `payout_id`; `payout_id` written in M1** | honest | `payments P-31`; supersedes `consumers #8` |
| L-71 | Re-mint | same attempt (v2) · **new attempt row per session** | new row | Stripe idempotency semantics — `security R2-09`, `payments P-21` |
| L-72 | Fulfilment dispatch | by event type (v2) · **by observed `(attempt, payment_status, pi.status)`** | observed | `payments P-26` |
| L-73 | Housekeeping and PROCESSING | expire stale attempts (v2) · **OPEN only; PROCESSING → anomaly at 10 d** | OPEN only | `payments P-27` |
| L-74 | Dispute money row | M4 (v2) · **M1 + structural report line + live preconditions** | M1 | `payments P-22` |
| L-75 | ACH verification | instant (v2) · **automatic + microdeposit state** | automatic | `payments P-30` |
| L-76 | Staff identity on `/api/doc/*` | `requireUser` (v2) · **`requireStaff` (machine accounts refused); actor from JWT** | requireStaff | `security R2-05` |
| L-77 | Gate | hash compare, per-link lockout, cookie flag (v2) · **HMAC cookie, normalised answers, tiers, per-(link, ip) fails, cap notifies staff, UNLOCK** | the latter | `security R2-06`, `U2-08` |
| L-78 | Link rotation | VOID only (v2) · **ROTATE LINK at any stage; masked public certificate; gated receipts; D-18 rotate-at-hire off** | rotate | `security R2-07` |
| L-79 | Limiter keys | link only (v2) · **link + ip hash; unknown tokens counted** | both | `security R2-08` |
| L-80 | Row locking | per attempt/ride codes (v2) · **invoice row lock first in every state function; `attempt_open`** | lock | `security R2-04` |
| L-81 | GUC escapes | bare `'on'` (v2) · **per-run nonce + `current_user` check** | nonce | `security R2-10` |
| L-82 | Plan-row `paid_at` | by policy (v2) · **`trg_incomes_plan_guard`; legacy E rows read-only** | trigger | `security R2-11` |
| L-83 | `is_test` guard | CHECK (v2) · **trigger, immutable, 24-h auto-revoke** | trigger | `security R2-12`, `RO-05` |
| L-84 | `updated_at` on incomes | trigger + explicit (v2) · **explicit only** | explicit | 04/10/2026 decision — `RO-13` |
| L-85 | Fixture deletion | script with GUC (v2) · **`fixture_delete()` RPC, FK order, `set null` on `revision_id`** | RPC | `RO-07` |
| L-86 | SEND BY APP | keyed by `notify.client.quote_sent.*` (v2) · **manual act, always available; keys gate robots only** | manual | `U2-02`; 18/10 exception; C-70 |
| L-87 | Zapata's one-paste path | three sheets (v2) · **"Client already approved" chip on the SEND sheet** | chip | `U2-07`; benchmark Tekmetric |
| L-88 | $0 lines under a package | COURTESY (v2 D-04 B) · **"included" inside a package; COURTESY outside** | included (D-04 A) | the paper is now signed evidence; C-31 is about a genuinely free extra and its legacy code is untouched — `U2-04` |
| L-89 | Rails sentence | static (v2) · **composed from the enabled rails** | composed | constraint 5 — `U2-09` |
| L-90 | Terms text and consent hash | EN default (v2) · **per language, inline, server-recomputed** | per language | C-71, C-102 — `U2-10`, `rules R2-11` |
| L-91 | `/doc` reachability | two entry points (v2) · **+ `/doc` index, EDIT IN EDITOR, link back, read-only tabs** | all | `U2-05`, `U2-11` |
| L-92 | QUOTES chips | ten (v2) · **three groups + ALL, search named** | groups | C-93 — `U2-12` |
| L-93 | Client dead ends | (v2 silent) · **ask_renewal, collapsible Not now, contact sheet (no href, C-84), landing_timeout, err_limit** | all | `U2-13`, `rules R2-14` |
| L-94 | Post-signature drift before M4 | silent (v2) · **drift chip + `balance_pending_update`; last-row PAY hidden; approved revision = truth** | stated | `U2-06`, `rules R2-17`, `consumers #4`, `rules R2-09` |
| L-95 | Rails vocabulary | three (v2) · **one: `{card, us_bank_account, ZELLE, WIRE, PIX_BR}`** | one | `RO-01` |
| L-96 | `seed_terms` and the actions key | gated (v2) · **exempt** | exempt | `RO-09` |
| L-97 | Stripe version | unpinned (v2) · **pinned SDK + endpoint `api_version`; live endpoint by API** | pinned | `payments P-29`, `RO-14` |
| L-98 | Markup in QUOTE FLOW pings | removed (v2) · **kept; removal is a D-10 question** | kept | C-26 — `rules R2-07` |
| L-99 | GROSS_UP booking | synthetic income (v2) · **negative MONEY expense against the fee row** | expense | C-32, C-40, C-43 — `rules R2-08` |
| L-100 | Fixture `client_number` | freed at deletion (v2) · **re-numbered to 9999 right after the hire** | 9999 | `RO-15` |
| L-101 | Currency mismatch | FAILED, nothing booked (v2 A-14) · **UNBOOKED + anomaly, money held** (variant of P-33) | held | a BRL amount cannot enter the USD ledger (C-24 anchor); deliberate exception to principle 5, stated |

---
## 14. DECISIONS FOR THE OWNER (one A/B each; the team proceeds with the DEFAULT tonight)

- **D-01 Hire moment for ACH** — unchanged. **DEFAULT A** (CLEARED). **Note added**: a client paying from a *personal* bank account may dispute the ACH debit for up to 60 calendar days and the dispute is final; the page shows "individual/company" on the attempt — parts bought inside that window are at GZ28's risk.
- **D-02 Card fee** — unchanged. **DEFAULT A** (absorb). If B is ever used: the recovered surcharge is booked as a negative MONEY expense against the fee row (not a synthetic income); international cards (+1.5 %) leave it short; FL tax on a surcharge is a counsel question.
- **D-03 Address on the client document** — unchanged. **DEFAULT: what the current paper prints.**
- **D-04 $0 lines under a package.** A) "included / incluído" for members of a package line; COURTESY/CORTESIA only for a $0 line outside any package · B) COURTESY on every $0 line as today. **DEFAULT A (changed back from v2)** — the signed Zapata document would otherwise print "COURTESY" thirteen times under an US$ 85,000 package and read as "the labor is free"; today's paper (legacy V) is untouched either way.
- **D-05 Issue date** — unchanged. **DEFAULT A** (no issue date).
- **D-06 Stripe's own e-mails to the payer (rewritten, final).** Hosted Checkout asks the payer for an e-mail and writes it onto the Stripe Customer; Stripe then sends a receipt according to the **shop account's** Dashboard switch "Customer emails → Successful payments" (ON today for shop buyers) — nothing in our code prevents it, and test payments never reveal it. A) Turn that switch OFF on the account (also affects shop buyers) and we send our own receipt when you turn `notify.client.deposit_received` on · B) Leave it ON — quote clients get a Stripe-branded receipt · C) A separate Stripe account for quotes (D-15 B). **DEFAULT: no live Checkout Session is created until you tell us the choice** — the app records it in `stripe.customer_emails_checked` and `/api/health/env` shows it.
- **D-07 Florida written-estimate block and consents** — unchanged. **DEFAULT A.** The terms text (EN and PT) is in `lib/quoteStrings.ts` for counsel to read.
- **D-08 Public page look** — unchanged. **DEFAULT A** (dark on screen; the print view is light). **Added**: the page has no outbound link (C-84) — "Contact GZ28" opens an in-page sheet with the handle to copy; may it carry a real `href` (wa.me / m.me / sms: / mailto:)? **DEFAULT: no href.**
- **D-09 Token storage** — unchanged. **DEFAULT A** (stored; readable only by the server).
- **D-10 Switches to turn ON first** — same order; all OFF. **QUOTE FLOW pings are not recommended.** **Question added**: those pings print `markup x%` on quotes as today's REPORTS does (C-26) — keep or drop?
- **D-11 / D-12** — unchanged (list only).
- **D-13 Zapata's live link** — **DEFAULT B** (test mode until you review the page) **with a precision**: in test mode his page shows the quote and the APPROVE card, but **no PAY button** — test money cannot hire a real document; the Zelle/wire sheet is the only rail until the live switch. His record must have `state='OR'`, a phone if you want the gate, and the Messenger handle typed in the SEND sheet.
- **D-14 Identity gate on big quotes.** A) None · B) Last-4 of phone before signing on quotes ≥ US$ 25k when a phone exists; e-mail only when no phone exists (the sheet calls it a weak gate). **DEFAULT B.** Five wrong answers from one device lock that device for 15 minutes, never the client's link; you can UNLOCK GATE from `/doc`.
- **D-15 Which Stripe account for quotes.** A) The shop's account (one payout stream; Stripe e-mails and endpoint-failure banners shared with the shop) · B) A separate account for the Control App. **DEFAULT A tonight** (test keys already there); live switch waits for your word either way.
- **D-16 "Sent = locked".** **DEFAULT A** — after SEND, prices need NEW REVISION (which now drops you straight into the editor and back).
- **D-17 (new) CLOSE and unpaid installments.** A) CLOSED stays date-only as today (every income dated or milestone-labelled, conclusion date) — unpaid installments show as receivables, the CLOSE checklist prints them in red, the Data Checker lists any CLOSED invoice with one · B) CLOSE requires every installment paid (or an explicit "close with balance"). **DEFAULT A** (today's law).
- **D-18 (new) New link at hire.** A) The same link lives on after the deposit (installments, receipts, signed copy — receipts behind the phone gate when one exists) · B) The hire rotates the link and you send the new PAY LINK. **DEFAULT A.** You can ROTATE LINK by hand at any time.
- **D-19 (new) Who may act in `/doc`.** Today any logged-in user has full access; `/doc` actions now refuse the `br-bridge` machine account and record who copied a link, recorded an approval or a payment. A) Keep "any human user" · B) Name the people allowed to RECORD APPROVAL / RECORD PAYMENT. **DEFAULT A.**

---

## 15. ACCEPTANCE CRITERIA (testable without the owner; test mode; our own fixture)

- **A-01** `invoice_incomes` on quotes = 0 before/during/after; an insert on a quote raises C-07.
- **A-02** `alloc_ride_code(p)` = `nextFreeCode(liveCodes, p)` for `US, SC, WV, US.QT, PO, SHP`, pinned excluded — run before the migration in a rolled-back transaction; blocking.
- **A-03** `GET /api/q {link_id}` with the cookie for a real link and `quote_portal.enabled=false` → `inactive`; `is_test` → document; unknown/revoked → not found; no `base_cost/expenses/markup/grade/phone/e-mail`. **A `fetch('/ca/api/q/checkout')` from the page with no custom header succeeds after the first `GET /ca/q/<token>`; the same POST without the cookie → 404** (`payments P-20`). **A-03b** `curl -A facebookexternalhit /ca/q/<token>` → HTML with `noindex` and the neutral OG title, no amounts; **the BR fixture's link → `<title>` contains "Seu orçamento"** (`RO-06`); every `/api/q/*` mutation on a real link returns 409/`inactive` while the key is OFF.
- **A-04** Crawler UA or < 3 s → no VIEWED; real open → one VIEWED per 30 min; 7th view beacon in an hour → 429; **31st unknown-token hit from one IP in an hour → 429** (`security R2-08`).
- **A-05** `sign` with stale `sha256` → 409 `err_stale`; **stale `terms_sha256` → 409**; current → one approval row (`document_sha256`, `consent_version` per language, consents incl. `signer_name_sha256`, elections, `signer_contact`, `attribution.gate_tier`); second sign → trigger; `signer_name` "Antônio Penna Jr." survives the sanitizer, `@`/markdown stripped; `LIMIT` without amount → 400 `err_limit`; a direct `insert into invoice_approvals` as `authenticated` → permission denied; **gate: `Robert.Zapata@Gmail.com ` typed vs `robert.zapata@gmail.com` on file → pass; 5 wrong from one IP → 15-min lock for that IP only; UNLOCK GATE clears it**; **supersede ‖ sign fired together → exactly one succeeds** (`security R2-04`).
- **A-06** After SEND: `update invoice_items set unit_price = unit_price + 1` on a frozen id → raise C-16; same value → passes; a line inserted after SEND → editable and deletable; `cancel_status='REFUNDED'` → passes; **`update invoices set global_discount = global_discount + 1` → raise; identical value → passes**; NEW REVISION → the update passes; a legacy quote → unaffected.
- **A-07** `checkout` twice → same `url`; two concurrent first taps → one attempt; session: `metadata.app`, `metadata.fl_tax_cents`, no `automatic_tax`, `unit_amount = installments[seq].amount_cents`, exact rail via the one mapping, no `invoice_creation`, no `customer_email`; `success_url` carries a landing token and no capability token; descriptor suffix ∈ {DEPOSIT, BAL, INST k} ≤ computed max; ACH `statement_descriptor` ≤ 16; rail not enabled → 409; **expire an OPEN attempt by hand (`expires_at = now() − 1`), tap PAY → a second attempt row, a different `cs_…`, HTTP 200** (`security R2-09`, `payments P-21`); **a 600-char service name creates a session** (`payments P-37`).
- **A-08** Card `4242…` on the fixture: `is_quote=false`, REALTIME, `hiring_date` = today Orlando, client promoted (+ `data_fixes`; number rewritten to 9999 by the script), codes re-prefixed; two incomes (seq 1 `paid_at` 12:00 Orlando, `source='STRIPE'`, `attempt_id`, `installment_id`, `payment_reference`, `updated_at not null`, `reported_at not null`, **`receipt_url` null / no hosted URL**); no fee row (test); `quote_backups`; HIRED `{plan:{n:2,…}}` + DEPOSIT_RECEIVED with `test:true`; SIDE_EFFECT steps `skipped: test`; **handler latency recorded ≤ 3 s**. **A-08b** legacy HIRING DATE first, Stripe `paid` second → exactly one paid income. **A-08c** rolled-back ride run: new `project_code`, all invoices re-prefixed, nothing persisted. **A-08d** live-mode replica (SQL, rolled back): fee row has `paid_from = paid_to = source = 'GZ28US'`, `receipt_url = '[]'`, `receipt_proves_payment = true`, `nature='MONEY'` (`rules R2-13`).
- **A-09** (conditional on Dashboard ACH) `000123456789`: observed `unpaid`+`processing` → PROCESSING; `async_payment_succeeded` → A-08 with `paid_at` = the event day and the report-net replica lists the row; `000222222227` → FAILED, no income, PAY again mints a **new** attempt; `000000000009` → CLEARING copy, no card button; **housekeeping run while PROCESSING with `expires_at` in the past → attempt untouched** (`payments P-27`).
- **A-10** Duplicate delivery → 200 `{duplicate:true}`; two concurrent deliveries → one handler run; **the three orderings (`completed paid` only · `completed unpaid` then `async_succeeded` · `async_succeeded` then late `completed`) → the same end state, the late event DONE `{repeat|noop}`**; `completed unpaid` after `async_failed` → FAILED stays FAILED; forced DB error → ERROR → **housekeeping re-run (attempts=2) → DONE**; replay of DONE → no-op; **same session against the SUCCEEDED attempt → `{repeat:true}`, zero events; a different session/PI → PAYMENT_ANOMALY `{replay}`**; shop session and shop refund → IGNORED; `livemode` mismatch → IGNORED; **concurrent landing + webhook → one hire, both `cs:` claimants DONE, zero PAYMENT_ANOMALY rows, attempt still SUCCEEDED, both HTTP 200**; **two partial card refunds → `refunds.list` → two negative rows with the deposit's `installment_id`, Σ = `amount_refunded`**; **dispute created → `dp_` negative row; `funds_reinstated` → reversing row**.
- **A-11** Landing POST before the webhook → HIRED; the webhook → `{duplicate:true}`; landing for an attempt of another link → 404. **A-11b** landing with no cookie (`/q/return?t=…` from a fresh browser) → `return_no_session` page with the amount, event LANDING_NO_COOKIE; the webhook books; re-opening the link shows HIRED.
- **A-12** Every fixture money row `reported_at not null`; no fixture `invoice_expenses`; `wa_send_log` unchanged; zero `NOTIFIED`; `daily-report?dry=1` body contains no fixture code before, while hired, and after cleanup; `data_fixes` holds the full JSON of every deleted row; after `fixture_delete` the fixture client and invoice do not exist.
- **A-13** Second paid session for seq 1 → income on seq 2 + anomaly, `refunds.create` never called; no unpaid row → "Overpayment — hold" + alert SKIPPED. **A-13b** Σ incomes = Σ received. **A-13c** full refund of seq 1 → stage INVOICE · DEPOSIT REFUNDED, PAY visible for seq 1, HOME due = 42,500 (`consumers #6`).
- **A-14** `amount_total` tampered → income booked for `amount_total` + anomaly `{amount_mismatch}`; **currency ≠ usd → attempt SUCCEEDED_UNBOOKED + anomaly `{currency}`, HTTP 200, nothing in `invoice_incomes`**; **VOID then a paid session → UNBOOKED + anomaly `{voided}` written and visible after the call (the refusal persisted)** (`RO-03`).
- **A-15** RECORD DEPOSIT on a quote with no revision → RECORDED revision + approval + hire (Zelle, no fee row); PIX GZ28BR → `paid_to='GZ28BR'`, `amount_brl`, BR_ENTRY; the route rejects `livemode`/`reported_at` in the body and `paid_on` outside the window; CASH above US$ 10,000 without a receipt → 400; **SEND with `already_approved` → revision + approval (`method=SHOP_TEXT`, `recorded_by` = JWT e-mail even when the body says otherwise) + pay text in one response**; **RECORD PAYMENT on a legacy invoice with two hand-made incomes → still two rows, one now paid, zero `invoice_installments`** (`consumers #5`).
- **A-16** `quoteStage()` DRAFT → SENT → VIEWED → SIGNED → DEPOSIT PENDING → (CLEARING) → INVOICE·DEPOSIT RECEIVED → DEPOSIT REFUNDED after a full refund; EXPIRED after `valid_until` yesterday + cron, with `ask_renewal` → RENEWAL_REQUESTED; SENT again after EXTEND; DRAFT·"new version pending" after NEW REVISION; VOID first; `LEGACY_BACKUP` ignored; **the `/doc` index orders SIGNED-awaiting-deposit before CHANGES before VIEWED before SENT, and a CHANGES_REQUESTED event moves the document** (`U2-05`).
- **A-17** SEND refused with the field named (no state, no `title_scope`; FDACS missing → warning only); succeeds after `state='OR'`; revision `fl_tax_status='OUT_OF_STATE'`, `grand_total` = `invoiceMoneyFor`, Σ `amount_cents` = round(grand×100), `terms_sha256` = sha256 of the EN terms; `valid_until` = today + 30; second SEND resets it; SEND while an attempt is OPEN → 409.
- **A-18** `tsc` + `lint` + **local `next build` without `SUPABASE_SERVICE_ROLE_KEY`** clean; every legacy page loads and saves a legacy quote as before; SAVE without changes on US.QT.028.1 → no error, `presented_sha256` unchanged; **SENT quote with `target_grand_total` set → `+ ADD ITEM` → SAVE succeeds, Full Project Labor price unchanged, new item saved** (`consumers #3`, `U2-01`); the E banner shows disabled price inputs, read-only TARGET, HIRING DATE read-only when an approval exists, plan rows read-only in the INCOME panel, and a `<Link>` to `/doc`; **on a legacy invoice with hand-made incomes: the status cycle CLOSED → INCOMPLETE saves; clearing and retyping HIRING DATE saves** (`rules R2-01`); REMOVE on a never-sent quote works; REMOVE on a sent quote fails readably. **A-18b** `/doc/<US.QT.028.1>` shows PAYMENT PLAN 50/50 with `qi_v2.actions=false`; SEND on it → 409 (`RO-09`).
- **A-19** 375 px, no horizontal scroll, 44 px targets; PT for the BRAZIL fixture (rails PIX_BR, GZ28BR, PT strings, **PT terms inline**), EN for USA; every `err_*` state and `landing_timeout` render as toasts/cards; **the rails sentence names exactly the rails whose buttons render** (`U2-09`); "included" under the package line, COURTESY on a $0 line outside it; `/print` renders light with the company block.
- **A-20** `/api/health/env` lists the Stripe vars, `STRIPE_WEBHOOK_ENDPOINT_ID`, `QUOTE_GATE_SECRET`, `MACHINE_ACCOUNTS`, the endpoint event-list **and `api_version`** checks, `stripe.customer_emails_checked`, and the two owner keys as live preconditions; webhook 400 unsigned / 503 without env; `customerForMode` never sends a `test` id with a live key (unit test); **live key + `customer_emails_checked.live=false` → `/api/q/checkout` 409, no session created** (`rules R2-02`).
- **A-21** `has_function_privilege('anon'|'authenticated', fn, 'execute') = false` for every new function; **as `authenticated`: `select token from quote_links` → permission denied; `select * from quote_links` → permission denied; `select id from quote_links` → 0 rows (no policy); `select * from quote_links_public` → rows; `select url from payment_attempts` → permission denied**; `insert into payment_attempts` as `authenticated` → permission denied; `select count(*) from pg_policies where tablename='quote_links' and 'authenticated' = any(roles)` = 0 (`security R2-02`, `RO-04`).
- **A-22** `trg_invoices_quote_flip`: `update invoices set is_quote=true` on the hired fixture → raise; identical-value write → passes; **`update invoices set live_status='INCOMPLETE'` on a legacy REALTIME invoice with hand-made incomes → passes; the same on the hired fixture (plan rows) → raise**; Data Checker "paid income on a quote" = 0.
- **A-23** Zelle dry run against a hired fixture with an open ON_CONCLUSION plan row of the exact amount → UPDATED (`paid_at`, `source='ZELLE'`, `payment_reference='zelle:…'`, description unchanged), no insert, no delete; **A-23b** a `due_rule='DATE'` plan row (dated) of the Zelle amount → UPDATED, no insert; **A-23c** an amount matching nothing on a client with open plan rows → no insert, a doubt written; a legacy open row without `installment_id` → today's behaviour. **A-23d** a GZ28BR plan row settled by RECORD DEPOSIT with `paid_on = D` appears in the intercompany ledger on D, not on its due date (`rules R2-06`).
- **A-24** `daily-report?dry=1` lists a 🏁 HIRED line `plan: 2 × US$ 42,500 (1 received)` for a (non-test) hire in the window **and no "NOT RECEIVED" entry for the balance row** (`rules R2-04`); a DISPUTE_OPENED event in the window → the ⚠ line — verified with SQL replicas.
- **A-25** `curl /ca/q/<token>` and `/ca/api/q` return `Cache-Control: no-store`, `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (sources without `/ca`, `RO-11`).
- **A-26** (`security R2-01`) real (non-test) link + test key + `checkout` → 409 `rail_unavailable`, no PAY card rendered; a forged `checkout.session.completed` with `livemode=false` against a real attempt → attempt SUCCEEDED_UNBOOKED + anomaly `{test_money_on_live_doc}`, `is_quote` unchanged, HTTP 200.
- **A-27** (`security R2-05`) the `br-bridge` JWT → 403 on `GET /api/doc/[id]/link` and every `/api/doc/[id]/*` mutation; a body `recorded_by` is ignored; `GET …/link` by a human writes LINK_COPIED `{actor}`.
- **A-28** (`RO-10`) a `stripe_events` row forced to ERROR after a 200'd duplicate → re-run by housekeeping → DONE; after 5 attempts it stops and the anomaly key is consulted.
- **A-29** (`payments P-28`) `stripe trigger charge.refunded` / `charge.dispute.created` for a Control App test charge → the shop endpoint answers 200 (no 500 in the Dashboard); the Control App endpoint IGNOREs a shop test session.
- **A-30** (`security R2-07`) ROTATE LINK → old token 404, new token serves the document, event LINK_ROTATED; the public `/print` certificate shows `r•••a@g•••.com` and the city only; the staff print shows the full values.

---

## 16. MILESTONES for App Development 2

### M1 — tonight, in this order (each step deployable alone; commit per step; `git add` by path)
1. **Pre-flight (read-only)**: duplicate `(ride_id, invoice_code)`; incomes-on-quotes count; `scripts/test-alloc-ride-code.mjs` inside `begin … rollback` (A-02, blocking). Env: `QUOTE_GATE_SECRET`, `MACHINE_ACCOUNTS`, `STRIPE_WEBHOOK_ENDPOINT_ID`; `webhookEndpoints.update` of the test endpoint's events.
2. **Migration** `MIGRATION_quote_portal_core.sql` (+ `ROLLBACK_…`) in one transaction: tables §4.1 (grants per the column-list discipline; view with `security_invoker=false`), columns §4.2, `stripe_events.locked_at/attempts`, triggers §4.3 #2–#10, functions #1, #11–#19 with REVOKE/GRANT, RLS policies as specified, supplier `Stripe`, bucket `client-docs`, `app_settings` seeds. `MIGRATION_quote_portal_uidx.sql` only if the pre-flight is clean. `data_fixes` trail. A-21 run immediately.
3. **Pure libs**: `lib/orlando.ts`, `lib/quoteDoc.server.ts` (DTO with line ids, cents, canonical JSON, `sha256`, `presented_sha256`, `terms_sha256`, language, person/company rule, `displayCode`), `lib/quoteStage.ts` (Σ-based PAID, drift chips), `lib/quoteStrings.ts` (§5.6 + terms EN/PT), `lib/notifyTemplates.ts`, `lib/receiptKinds.ts`, `components/PaymentFields.tsx`, `lib/renumberBR.server.ts`, `lib/auth.server.ts::requireStaff`, `lib/stripe.server.ts` (`apiVersion` pin; `package.json` exact version).
4. **Internal actions** (`requireStaff` + `actionsAllow`): `app/api/doc/[id]/{send,revision,link,rotate,gate-unlock,plan,approve-manual,deposit-manual,extend,void,preview}/route.ts`, `notes/[noteId]`; `lib/hire.server.ts` (ladder with `after()`, `is_test` skips, step 3b). Next 16: `await ctx.params`; `next typegen` + `tsc`.
5. **`/doc/[id]` shell + `/doc?code=` + `/doc` index**: header (chips), stage bar (+ EDIT IN EDITOR, UNLOCK GATE, ROTATE LINK), PLAN & TERMS sheet, PAYMENT PLAN tab, read-only summaries for the other tabs, RECORD DEPOSIT (receipt-first; picker for documents with incomes), RECORD APPROVAL, EXTEND/VOID sheets, ACTIVITY (collapsed system events), preview; lazy `seed_terms`.
6. **Public API** `app/api/q/{route,view,gate,sign,checkout,landing,promised,changes,decline,decline-withdraw,renewal}/route.ts` + `lib/quotePublic.server.ts` (`server-only`, throws inside functions, per-link cookie, `portalAllows`, mode rule, two-key limiter, UA filter, platform IP, gate HMAC + normalisation, PNG validation, landing token) + `app/q/return/route.ts` (cookie → 302; else `return_no_session`).
7. **Public page**: `app/q/layout.tsx` (shell), `app/q/[token]/layout.tsx` (metadata), `app/q/[token]/page.tsx` (§5.1 states), `app/q/[token]/print/page.tsx` (print stylesheet), `app/q/not-found.tsx`; `AuthGate` prefix; `next.config.ts` headers (`/q/:path*`, `/api/q/:path*`).
8. **Stripe handlers**: `lib/stripeEvents.server.ts` (`cs:` claim, pure `fulfillCheckout`, `book_payment` RPC, `expireAttempt` (OPEN only), `bookRefund` via `refunds.list`, `bookDispute` with the money row, `payoutPaid` → `payout_id`, namespace by attempt match, 200-on-refusal / 500-on-error); `app/api/stripe/webhook/route.ts` claim change; `customerForMode`, `cardSuffix`, string caps, `RAIL_TO_STRIPE`.
9. **Cron**: `app/api/cron/docs-housekeeping/route.ts` (EXPIRED + session expiry, SIDE_EFFECT retries, OPEN-only attempt expiry, stale PROCESSING anomaly, stale/ERROR event re-queue, payload trim, `public_hits` trim, `is_test` auto-cleanup via `fixture_delete`, 24-h `is_test` revoke) + `vercel.json`; `/api/health/env` checks §4.6 #5.
10. **Legacy edits** (§9 #1–#11): E MONEY skip; E guard (banner + link, disabled inputs, solver + labor skip, HIRING DATE, plan rows read-only, `?from=doc`); Zelle watch (selector, settle, no PALPITE); daily-report (skips, HIRED with plan, no unpaid plan rows, DISPUTE line, `?dry=1`); expenseReportNet (skip + sign-aware label); recurring-expense-reports (skip + plan-row key); PaymentFields; V header link + PRINT notice; AuthGate/headers/webhook/stripe pin; intercompany ledger; Data Checker cards.
11. **Tests**: A-02 (step 1), A-08c rolled-back ride run, fixture script (two clients), scenarios §10.2 B, A-01…A-30.
12. **`fixture_delete` + morning note** (ids, `?dry=1` bodies, pre-flight counts, Dashboard toggles, env values set, D-04/D-06/D-10/D-13/D-14/D-15/D-16/D-17/D-18/D-19, `is_test` links = none left, fee-row "proof pending" list, what to flip for live).

### M2 — documents and the QUOTES list
`lib/docPdf.server.ts`, PDF/receipt routes (gated), Dropbox step 5 + **5b fee voucher**, `app/quotes/page.tsx` rebuilt (grouped chips, search, honest card line, first-of-kind sort), MIXED matcher Σ(income − fee) per `payout_id`, `LEGACY_BACKUP` backfill, `/api/mail/client` kinds with DB-resolved paths.

### M3 — the document page
`app/doc/new`, full tabs (engines extracted), CLOSE checklist with the unpaid-plan line, `/invoices` rebuilt + SET ONLINE, PROMISED TO readers, `lib/money.ts` re-host reading the approved revision first, `qi_v2.enabled` Header entry, full E banner.

### M4 — money & legal ops
Change orders (`change_order_apply`, public delta card, restores last-row PAY), `/adm/notifications` + `lib/notify.server.ts` (keys, NOTIFIED/NOTIFY_SKIPPED, test targets, signing OTP), DELAYED robot open-attempt skip, ACH/dispute fee rows, CHECKs + `trg_incomes_paid_at_noon` after D-11/D-12.

### M5 — reconciliation & numbering unification
`stripe_payouts`, payout handlers, payouts sync → `match_mixed`, `app/adm/payments` (REPLAY, REFUND, unlinked incomes, stale PROCESSING, `is_test` artefacts), renumber route adopts `alloc_ride_code`, optional shop `opsWrite.ts` PI id.

### M6 — cleanup & BR port
Editor conversion path retired; column drops after audits; redirects; `MIGRATION_quote_portal_core.BR.sql` from the template (`invoice_payments`/`invoice_parts`, `'brl'`, CLIENT payer, NF-e hook after `fiscal_note_payments_trava`); `TenantConfig` (incl. `contact` per channel, currency); BR `AuthGate` prefix; BR public page in PT with PIX_BR and NF link; `sync-core-to-br.mjs` drift check.

---

## 17. REFUTATION LOG r2 — every finding, decided

Legend: **ACCEPT** = design changed as the refuter proposed (or a stronger variant); **ACCEPT (variant)** = the failure is real, the fix differs — the difference is stated; **REJECT** = the finding or its fix is wrong, with evidence. The ux file numbers its findings R2-nn → **U2-nn**; the rollout file R2-nn → **RO-nn**. The r1 log (122 findings) stands in `00-DESIGN-v2.md` §17.

### 17.1 Rules (`refute-rules-r2`)

| # | Sev | Decision | What changed |
|---|---|---|---|
| R2-01 `trg_invoices_quote_flip` breaks the legacy editor on every invoice with an income | critical | **ACCEPT** | Second half armed only on `exists(invoice_approvals) or exists(invoice_incomes where installment_id is not null)`; the `is_quote false→true` refusal stays universal; F-13 rewritten with the honest blast radius; A-18/A-22 assert the legacy CLOSED→INCOMPLETE cycle and HIRING DATE clear/retype. Verified: `E:3681-3702` sets INCOMPLETE legitimately. §4.3 #3 |
| R2-02 Stripe-e-mail mitigation false; env-only live switch lets a receipt reach a client | major | **ACCEPT** | D-06 rewritten (levers = account switch or separate account); `app_settings['stripe.customer_emails_checked']={test:true, live:false}`; `/api/q/checkout` and `deposit-manual` → 409 in live mode until `.live=true`; listed in `/api/health/env`; A-20. §2, §7.9, §14 |
| R2-03 Fee row has no PRINTABLE vendor invoice; charge receipt is the income's proof | major | **ACCEPT** | Fee row born `receipt_url=[]`, `receipt_proves_payment=true`, `nature='MONEY'`; ladder step 5b (M2) renders the Stripe fee voucher PDF into the Invoices folder under the C-53 name via the `expense-receipts` bucket and writes the storage path; `paid-no-receipt` card not special-cased; morning note lists "proof pending". §3.4, §7.4 |
| R2-04 Materialized plan rows appear as "NOT RECEIVED" predictions | major | **ACCEPT** | Legacy edit §9 #4 excludes `installment_id not null ∧ paid_at null` rows from "registered" and folds them into the HIRED line `plan: 2 × US$ 42,500 (1 received)`; A-24. |
| R2-05 CLOSED reachable with half unpaid, in silence | major | **ACCEPT** | D-17 (DEFAULT A, date-only); M3 CLOSE checklist red line; M1 Data Checker card `closed-with-open-plan`. §6.5 |
| R2-06 `intercompanyLedger` dates paid plan rows by due date | major | **ACCEPT** | Legacy edit #10 tonight: `dayIn(paid_at, NY) || ymd(payment_date)` at `:245-254` (verified the line reads `ymd(p.payment_date) || dayIn(p.paid_at, …)` today); A-23d. |
| R2-07 Markup removed from QUOTE FLOW pings by default | minor | **ACCEPT** | `· markup {x}%` kept in `quote_sent`/`quote_signed` (both OFF); removal is a D-10 question. §8.1 |
| R2-08 GROSS_UP has no lawful booking | minor | **ACCEPT** | Recovered surcharge = negative MONEY expense against the fee row (`<txn>:rec`); never a synthetic income or an automated service line. §3.5 |
| R2-09 FL-tax inputs outside `invoices` not locked after signature | minor | **ACCEPT** | M1 Data Checker card `signed-total-drift`; M3 readers take `fl_tax_status`/`grand` from the approved revision; plus `fl_tax_override`/`global_discount` locked tonight (with consumers #4). §3.5 |
| R2-10 FDACS line printed blank | minor | **ACCEPT** | Printed only when `TenantConfig.fdacs_registration` is set; SEND gate yellow warning; morning list. §5.1, §6.2 |
| R2-11 `consent_version` EN for every language; ANGOLA ignored | minor | **ACCEPT** | `seed_terms`: language by `clientSpeaksPortuguese(country)`, `consent_version='terms-'||language||'-v1-2026-11'`, rails by payer house (ANGOLA → GZ28US `{card, WIRE}`); `/api/q/sign` recomputes the terms hash. §3.2 T0, §4.1 |
| R2-12 Vacated `US.QT.###` reused the same day; "formerly" ambiguous | minor | **ACCEPT** | `/doc?code=` resolves the live code first and lists "formerly" matches with the hire date; the label carries the date; Stripe `custom_text` uses the stable short id. §2.2, §5.3 |
| R2-13 Fee row omits `source` | minor | **ACCEPT** | `source='GZ28US'`; A-08d asserts `paid_from = paid_to = source`. §7.4 |
| R2-14 Public page carries outbound links (C-84) | minor | **ACCEPT** | "Contact GZ28" = in-page sheet with the channel's handle, tap-to-copy, **no `href`**; "Read all →" removed (terms inline); the `href` question recorded in D-08. §5.1 |
| R2-15 Webhook HTTP status on failure unspecified | minor | **ACCEPT** | Stated: refusal → 200 after writing; true error → ledger ERROR + 500 (Stripe retries); landing → 200 `landing_pending`, never 500 to the client. §7.1 #7 |
| R2-16 Installment CHECKs allow DATE without `due_date` etc. | minor | **ACCEPT** | CHECK added verbatim; PLAN & TERMS sheet names the missing field. §4.1 |
| R2-17 Estorno after SEND leaves plan Σ ≠ live grand until M4 | minor | **ACCEPT** | Chip "balance ≠ plan" + Data Checker `plan-sum-drift`; PAY hidden on the last installment while red (deposit unaffected); M4 change order absorbs. §3.5 |

### 17.2 Consumers (`refute-consumers-r2`)

| # | Sev | Decision | What changed |
|---|---|---|---|
| #1 Zelle patch never sees a DATED plan row; PALPITE inserts a second income | critical | **ACCEPT** | Selector → `paid_at is null` (legacy undated semantics kept for rows without `installment_id`); prefer `installment_id` rows on exact match; no PALPITE when the client has any open plan row (doubt written); A-23b/A-23c. Verified `zelleWatch.server.ts:178-180` `.is('payment_date', null)`. §4.5, §9 #3 |
| #2 `trg_invoices_quote_flip` arms on any income | major | **ACCEPT** | Same as rules R2-01. |
| #3 Auto-CALCULATE rewrites frozen labor → half-committed SAVE | major | **ACCEPT** | E guard early-returns the solver effect at `E:1896` and skips the labor UPDATE at `E:2791-2795` for a frozen row id; TARGET read-only "frozen by rev n"; A-18 case. §9 #2 |
| #4 Money consumers compute BILLED live from unlocked inputs after signature | major | **ACCEPT** | (a) approved revision = truth for money consumers once an approval exists (M3 `lib/money.ts`); (b) SEND gate refuses when `title_scope` is blank and the address decides the tax; M1 Data Checker `signed-total-drift`; (c) `invoices(fl_tax_override, global_discount)` in `trg_lock_presented_lines` tonight (identical-value-safe). §3.5, §4.3 #8 |
| #5 RECORD PAYMENT materializes the plan on top of hand-made incomes | major | **ACCEPT** | `seed_terms` never writes installments on an `is_quote=false` document with incomes; `book_payment` materializes only when the invoice has zero incomes; RECORD PAYMENT without a plan settles a picked open income or inserts an ad-hoc paid row; `payment_attempts.installment_id` nullable with `check (installment_id is not null or provider <> 'STRIPE')`; A-15. §3.3 |
| #6 Refund leaves the installment PAID | major | **ACCEPT** | Negative rows carry the reversed row's `installment_id`; PAID = Σ ≥ plan − 0.01; `DEPOSIT REFUNDED` state; PAY returns; A-13c. §3.1, §3.2 T16 |
| #7 Fee `receipt_url` picked up by `cron/invoice-receipts` → HTML filed as `.pdf` | major | **ACCEPT** | No hosted URL ever in `receipt_url`; M2 voucher PDF via the storage bucket (same mechanism as rules R2-03); A-08 asserts no hosted URL. Verified `invoice-receipts/route.ts:53-71` selects any `receipt_url not null`. §4.5 |
| #8 `paidNoBank` `stripe:` extension missing from §9 | minor | **REJECT (superseded)** | The promise itself is withdrawn: `payments P-31` shows the `stripe:` special case would silence a real gap (the fee is netted inside the payout; nothing is "linked" until `payout_id`). Stripe rows stay honestly UNLINKED in the checker; `payout_id` is written in M1 and the MIXED matcher learns Σ(income − fee) in M2. The refuter's finding (inconsistency between §4.2 and §9) was true — resolved by removing the claim, not by adding the edit. §4.2, §9 |
| #9 DELAYED robot becomes an ungated sender for plan rows | minor | **ACCEPT (variant)** | New key `notify.reports.installment_delayed` (default **false**, not "today's behaviour" — constraint 10 says every new automatic message is OFF): the robot skips `installment_id not null` rows unless ON; legacy rows unchanged. §8.1, §9 #6 |
| #10 Display `.QT.` vs stored code on PROJECT cars | minor | **ACCEPT** | `displayCode()` helper in `lib/quoteDoc.server.ts`; `/doc?code=` strips `.QT.` before lookup; HIRED/"formerly" print the display form; `quote_hire` step 4 states that a project-car quote keeps its code and only flips `is_quote`. §2.2, §3.3 |
| #11 Zelle `income_settle` overwrites the plan label | minor | **ACCEPT** | `income_settle` never touches `description`; confirmation in `payment_reference='zelle:<conf>'`. §3.3 |

### 17.3 Security (`refute-security-r2`)

| # | Sev | Decision | What changed |
|---|---|---|---|
| R2-01 Test-mode money hires a REAL document once the portal is ON | critical | **ACCEPT** | `book_payment` 1b: `livemode='false' and not link.is_test` → UNBOOKED + anomaly `{test_money_on_live_doc}`, returned; `/api/q/checkout` → 409 in test mode for real links; PAY card on real documents only in live mode; D-13 precision; A-26. §2, §3.3 |
| R2-02 Column REVOKE is a no-op; policy "on the view" cannot exist | critical | **ACCEPT** | Column-list GRANT on `quote_links` (no table-level SELECT), RLS ON with no `authenticated` policy; view owned by `postgres`, `security_invoker=false` in the DDL; `payment_attempts.url` excluded from the column list and served only via `/api/doc/[id]/link`; A-21 asserts permission denied / 0 rows / `pg_policies` = 0. Verified the brake regex accepts a column-list grant (`roda-sql.mjs:155-168`). §4.1 |
| R2-03 Landing ‖ webhook claim different keys; loser raises, downgrades, retry loop | critical | **ACCEPT** | One claim `cs:<session>` for both paths; `book_payment` returns `{repeat:true}` for the same session/PI, anomaly only for a different one; `fulfillCheckout` never downgrades a SUCCEEDED attempt (`where status in ('OPEN','PROCESSING')`); A-10 rewritten. §3.3 1a, §7.1 #5 |
| R2-04 No invoice-level row lock; sign ‖ supersede race | major | **ACCEPT** | `perform id from invoices where id=… for update` first in every state function; `attempt_open()` SECURITY DEFINER re-reads under the lock; `void` sets `revoked_at` before expiring sessions; A-05 concurrency case. §3.3, §4.3 |
| R2-05 Any JWT incl. `br-bridge` can copy links / hire by hand | major | **ACCEPT** | `requireStaff` + `MACHINE_ACCOUNTS`; `recorded_by`/`created_by`/`actor_id` from the JWT; LINK_COPIED events; `deposit.manual_cap` requires a receipt for CASH/OTHER; A-27; D-19 asks whether to narrow further. §2 |
| R2-06 Gate cookie forgeable; e-mail not a secret; per-link lockout is a DoS | major | **ACCEPT** | HMAC cookie `gz28_qg_<link_id>` (15 min, `QUOTE_GATE_SECRET`, 503 without it); tiers (phone first, e-mail only when no phone, "weak gate" in the SEND sheet); fails per `(link_id, ip_hash)`; daily cap notifies staff instead of locking; RESET/UNLOCK GATE; `attribution.gate_tier`. Merged with U2-08's normalisation and hint. §2.1, §5.2 |
| R2-07 One bearer token for life; no rotation; certificate prints PII | major | **ACCEPT** | ROTATE LINK at any stage (event); public certificate masks contact/IP (full on the staff print); receipts/signed copy behind the gate when one exists; `quote.rotate_at_hire` as D-18 (default off). §2.2, §2.3, §14 |
| R2-08 Limiter keyed by link only | major | **ACCEPT** | Two-key buckets `(link)` and `(ip_hash)`; unknown-token and metadata lookups counted at 30/h per IP; `GET /api/q` 120/h; per-link budgets raised, per-IP tight; `public_hits` trimmed at 48 h; `is_test` bypasses keys, never the limiter. §2.1 |
| R2-09 Re-mint reuses `attempt.id` as the idempotency key | major | **ACCEPT** | New attempt row per session; old set EXPIRED in the same transaction (`attempt_open`); `sessions.expire` best-effort; A-07. §2.1, §5.3 |
| R2-10 GUC escapes settable by any role | minor | **ACCEPT** | Per-run nonce + `current_user in ('postgres','service_role')` for every escape; nonce recorded in `data_fixes`. §4.3 preamble |
| R2-11 `invoice_incomes` `authenticated_all` lets a JWT stamp `paid_at` on a plan row | minor | **ACCEPT** | `trg_incomes_plan_guard` (`gz28.settle` escape set by `income_settle`); legacy E renders plan rows read-only so no legacy SAVE hits it. §4.3 #6, §9 #2 |
| R2-12 `is_test` CHECK not expressible; service key shared with the shop | minor | **ACCEPT** | `trg_quote_links_is_test` (insert-only, `GZ28 TEST%` + `origin='PROJECT'`, immutable); housekeeping lists and auto-revokes `is_test` links older than 24 h. §4.3 #10 |
| R2-13 ASCII sanitizer corrupts non-ASCII names | minor | **ACCEPT** | `/[^\p{L}\p{M}\s'.\-]/gu`, NFC, whitespace collapsed; `consents.signer_name_sha256` of the raw value; A-05. §4.1 |
| R2-14 `/q/return` 302 re-emits the token; one cookie mis-lands multi-document clients | minor | **ACCEPT** | Signed landing token `t=<attempt>.<exp>.<hmac>` in `success_url`; cookie per link `gz28_q_<link_id>`; redirect to the token URL only when the cookie is present; the re-entry of the token on that redirect is stated honestly. §2.1 |

### 17.4 Payments (`refute-payments-r2`)

| # | Sev | Decision | What changed |
|---|---|---|---|
| P-19 Landing↔webhook claim keys differ → 3-day retry storm | critical | **ACCEPT** | Same as security R2-03 (`cs:` claim, `{repeat:true}`, webhook DONE/200). A-10 rewritten. |
| P-20 Public money routes cannot authenticate (httpOnly + wrong cookie path) | critical | **ACCEPT** | Cookie `Path=/ca`, read server-side; no `x-q-token`; `return_no_session` specified; A-03. §2.1 |
| P-21 Re-mint reuses the idempotency key | critical | **ACCEPT** | Same as security R2-09; also applies after FAILED (new attempt per PAY tap). |
| P-22 ACH disputes final for 60 days, every alert OFF, no money row until M4 | critical | **ACCEPT** | Structural DISPUTE / FAILED AFTER SETTLEMENT line in the Daily Mega-Report; `notify.owner.dispute` + `.payment_failed` as live-switch preconditions in `/api/health/env`; dispute negative row `dp_…` in M1 with the reinstated reversal; `account_holder_type` on the attempt and in ACTIVITY; D-01 note. §3.2 T17, §4.5, §7.9 |
| P-23 Checkout writes the collected e-mail onto the Customer | major | **ACCEPT** | Same as rules R2-02; `notify.client.stripe_receipt` documented as "adds `receipt_email`" only. §7.9, §5.3 |
| P-24 `charge.refunded` payload has no `refunds[]` | major | **ACCEPT** | `bookRefund` calls `stripe.refunds.list({charge})` and books one row per succeeded `re_…` not yet in `refund_id`; A-10 two partial refunds. §3.2 T16 |
| P-25 Refunded deposit reads PAID; report net announces a refund as income | major | **ACCEPT** | Σ-based PAID (with consumers #6); sign-aware label "*REFUND / CHARGEBACK*" in `expenseReportNet` (legacy edit §9 #5); DEPOSIT REFUNDED stage. |
| P-26 Dispatch by event type; out-of-order re-enters wrong branches | major | **ACCEPT** | `fulfillCheckout` as a pure function of `(attempt.status, payment_status, pi.status)`; A-10 enumerates the orderings. §7.1 #6 |
| P-27 Housekeeping expires PROCESSING ACH attempts | major | **ACCEPT** | Only OPEN expire by time; PROCESSING > 10 d → anomaly + alert; `book_payment` accepts EXPIRED when `paid` (`booked_after_expiry`); A-09. §2.3, §3.3 |
| P-28 Shared-account cross-fire; 10-s redirect wait spans both handlers | major | **ACCEPT** | Latency budget ≤ 3 s recorded in A-08; shop-side assertions A-29; D-15 notes the shared failing-endpoint banner. §7.1 #11, §7.9 |
| P-29 Unpinned API/SDK version | major | **ACCEPT** | `apiVersion` pinned to `Stripe.API_VERSION`; `"stripe": "22.6.2"`; `/api/health/env` compares the endpoint's `api_version`; live endpoint created by API. §7.1 #1, §7.9 |
| P-30 `verification_method: 'instant'` dead end | major | **ACCEPT** | Default `automatic`; `requires_action`/microdeposits modelled as PROCESSING `verification='microdeposits'` with its copy and `fail_reason.verification_timeout`. §3.2 T6a, §5.6 |
| P-31 Fee row dated charge day, `paidNoBank` silenced for `stripe:` | major | **ACCEPT (variant)** | `payout_id` written on `payout.paid` in **M1** (one column); rows honestly UNLINKED until matched (no `stripe:` special case, which also closes consumers #8); the MIXED matcher Σ(income − fee) per `payout_id` lands in **M2** (needs the `match_mixed` signature we are unsure about, §12 #6) rather than M1 — the first live payout cannot precede the live switch, so nothing is lost. §4.5, §7.4, §7.5 |
| P-32 Stripe Tax blind to Control App taxable sales | major | **ACCEPT** | One sentence in §7.6 + morning note (file from the Control App export only; never add the two); `fl_tax_cents` in session metadata. §5.3 |
| P-33 `currency ≠ usd → nothing booked` contradicts principle 5; hard-coded `usd` inherited by BR | minor | **ACCEPT (variant)** | Compare with `TenantConfig.currency` (template variable; `payment_attempts.currency` default from it) — accepted. **Booking the foreign amount into the ledger is not adopted**: `invoice_incomes.amount` is the tenant's anchor currency (C-24, memory `indice-moeda-e-travessia`); a BRL amount written as USD would corrupt the DRE. A mismatch (only possible by tampering) → `SUCCEEDED_UNBOOKED` + anomaly `{currency}`, money held for staff — a stated exception to principle 5 (L-101). A-14 corrected ("FAILED" was the wrong word: the client was charged). |
| P-34 GROSS_UP formula assumes a domestic card | minor | **ACCEPT** | Limit documented beside the formula; the recovered row's description states "recovered US$ a of US$ b" from `balance_transaction.fee`; no code tonight. §3.5 |
| P-35 Descriptor suffix is an opaque id; ACH gets none | minor | **ACCEPT** | Suffix ∈ {DEPOSIT, BAL, INST k}; ACH `statement_descriptor` ≤ 16 chars; A-07 length check kept. §5.3 |
| P-36 2-h session + Lax cookie in a killed in-app webview | minor | **ACCEPT** | "Open in your browser" hint on in-app UAs; session expiry 24 h. §2.1, §5.3 |
| P-37 Free-text service name can break `sessions.create` | minor | **ACCEPT** | Caps (name 120, description 300, metadata ≤ 500) + control-char strip in a helper; A-07 600-char test. §5.3 |

### 17.5 UX regression (`refute-ux-regression-r2`, renumbered U2-nn)

| # | Sev | Decision | What changed |
|---|---|---|---|
| U2-01 E guard disables TARGET but not the solver → half-saved SAVE | critical | **ACCEPT** | Same as consumers #3 (solver effect early-return + labor UPDATE skip; "unsent changes" chip shows the drift); A-18. §9 #2 |
| U2-02 Owner loses "send by the app" until a robot key is ON | critical | **ACCEPT** | SEND BY APP is a manual act, always available (`requireStaff`, `/api/whatsapp` / `/api/mail/client` kind `quote-link`, client language, C-67 signature); `notify.client.quote_sent.*` gates robot resends only; recorded SENT `{by_app:true}`; tonight exercised only against the fixture's own e-mail. Verified `view-page.md` §9.6: human-initiated sends continue under the 18/10 exception. §6.2, §8.1 |
| U2-03 Messenger/Instagram webviews lose the cookie → NOT FOUND after paying | critical | **ACCEPT** | `return_no_session` state (EN/PT) with amount/state from the attempt; signed landing token in `success_url` (variant of the proposed nonce — HMAC needs no stored secret per attempt); A-11b. §2.1, §5.1 |
| U2-04 Thirteen COURTESY lines under an US$ 85,000 package | major | **ACCEPT** | "included / incluído" for a $0 line inside a package (kit member, or any $0 service when the document has a package line > 0); COURTESY/CORTESIA only outside a package (C-31 intact; legacy V code untouched); D-04 default A (changed back); L-88 states the reason. §5.1, §5.6 |
| U2-05 Nothing surfaces client events across quotes until M2; M2 sort key incomplete | major | **ACCEPT** | M1 `/doc` (no code) = ACTION NEEDED index grouped by stage with last event time; M2 sort key = staff/system writes + every first-of-kind client event (incl. CHANGES_REQUESTED, DECLINED, PAYMENT_PROMISED, RENEWAL_REQUESTED, DEPOSIT_*); A-16 ordering assertion. §2.2 |
| U2-06 Post-signature addition collectable nowhere before M4 | major | **ACCEPT** | `balance_pending_update` on the last installment while `grand(live) ≠ Σ plan`; PAY hidden on that row; `/doc` red chip "balance ≠ plan (+US$ x)"; RECORD PAYMENT accepts any amount; M4 restores PAY. S-10 intact. §3.1, §3.5 |
| U2-07 Zapata's brief costs three sheets and two pastes | major | **ACCEPT** | SEND sheet chip "Client already approved — by {method}" + note → `quote_send` + `quote_approve(SHOP_*)` in one request, returning the pay text; one paste; A-15. §2.3, §6.2 |
| U2-08 Gate asks for "your e-mail", no normalisation, no hint, no unlock | major | **ACCEPT** | Normalisation (trim, lower-case, NFKC; digits last-4); masked hint; UNLOCK GATE; lockout 15 min then 1 h (merged with security R2-06's per-IP counting); A-05. §2.1, §5.1 |
| U2-09 Static copy promises ACH while only card is enabled | major | **ACCEPT** | `no_fee` composed from `terms.rails ∩ rails_enabled` + non-Stripe rails; buttons cheapest-first; A-19. §5.1, §5.6 |
| U2-10 `consent_version` EN for a PT signer; "Read all →" has no target | major | **ACCEPT** | Per-language `consent_version`; terms text in `lib/quoteStrings.ts` rendered inline above the checkboxes; `terms_sha256` frozen at SEND and recomputed at `/sign`; BR session reviews the PT terms. §4.1, §5.1 |
| U2-11 M1 `/doc` tabs empty; NEW REVISION → edit → SEND is 13–14 taps | major | **ACCEPT** | EDIT IN EDITOR in `⋯`; E banner `<Link>` back; NEW REVISION lands in E with `?from=doc` and SAVE & EXIT returns to `/doc`; non-editing tabs show count + total + the link; §6.7 rewritten (7–8 taps). §2.2 |
| U2-12 Ten chips, no search named | major | **ACCEPT** | NEEDS ME · WAITING · DONE/OLD + ALL; zero-count chips hidden; scrollable fallback; search on name/code/car named in §2.2 (C-93). §6.6 |
| U2-13 Missing client states (EXPIRED, Not now, Message us, poll end, LIMIT) | major | **ACCEPT (variant on #3)** | (1) `ask_renewal` → RENEWAL_REQUESTED; (2) "Not now" collapses to "▸ Approve this quote"; (3) **"Contact GZ28" opens an in-page sheet with the channel's handle to copy — no `href`**, because C-84 forbids outbound links (rules R2-14); the `href` option is D-08's question; (4) `landing_timeout` + PAY hidden while PROCESSING; (5) `err_limit`, LIMIT reveals the amount inline. §5.1, §5.6 |
| U2-14 No print stylesheet for the dark page | minor | **ACCEPT** | `@media print`: light tokens, letter, buttons/toasts hidden, company + certificate blocks, legacy `.pi` structure reused. §2.1 |
| U2-15 `live_status` pill beside the stage chip on a quote; hashes and SIDE_EFFECTs in ACTIVITY | minor | **ACCEPT** | Pill hidden while `is_quote` (C-17 untouched); SYSTEM/STRIPE events collapsed under "▸ system (n)"; hash only on the certificate. §2.2, §6.3 |
| U2-16 Tap table inaccuracies (RECORD DEPOSIT, reach) | minor | **ACCEPT** | Honest counts published in §6.7; receipt-first sheet kept. |
| U2-17 E banner has no link; VOID requires typing the full code | minor | **ACCEPT** | Banner `<Link>` (with U2-11); VOID confirm = type the number only or hold 2 s. §2.2, §9 #2 |
| U2-18 Decline reason "Price" invites haggling | minor | **ACCEPT** | "Timing · Scope · Other" (C-72). §2.1, §5.6 |

### 17.6 Rollout (`refute-rollout-r2`, renumbered RO-nn)

| # | Sev | Decision | What changed |
|---|---|---|---|
| RO-01 Rails vocabulary mismatch → no PAY button | major | **ACCEPT** | One set `{card, us_bank_account, ZELLE, WIRE, PIX_BR}` in `invoice_terms.rails` CHECK, `payments.rails_enabled`, `payment_attempts.rail`; `RAIL_TO_STRIPE` mapping once in `lib/stripeEvents.server.ts`. §4.1, §5.3 |
| RO-02 Landing and webhook claim different rows | major | **ACCEPT** | Same as security R2-03 / payments P-19. |
| RO-03 "writes … before raising" is impossible in one transaction | major | **ACCEPT** | Option (a): `book_payment` returns `{anomaly}` after writing for every business refusal; raises only on bugs; `fulfillCheckout` maps refusal → 200, error → 500; A-14 asserts the persisted trace. §1 #5, §3.3, §7.1 #7 |
| RO-04 Column REVOKE is a no-op; A-21 cannot pass | major | **ACCEPT (variant)** | Mechanism = column-list GRANT (security R2-02), not a secrets table: the brake's regex (`roda-sql.mjs:155-168`) accepts `grant select (cols) on public.quote_links to authenticated`, so no table-level SELECT is ever granted and even a copy-pasted `authenticated_all` policy cannot expose `token` (`select token` → permission denied regardless of policies). A secrets table would still need the brake's grant and would rely on "no policy" alone — the weaker belt. A-21 rewritten to assert permission denied on `token`/`*`, 0 rows on `id`, and `pg_policies` = 0 for `authenticated` on `quote_links`. §4.1 |
| RO-05 CHECK referencing `clients.name` cannot compile | major | **ACCEPT** | `trg_quote_links_is_test` BEFORE INSERT OR UPDATE OF `is_test` joining `invoices → clients` (same trigger as security R2-12). §4.3 #10 |
| RO-06 `app/q/layout.tsx` cannot see `[token]` | major | **ACCEPT** | `app/q/[token]/layout.tsx` with `params: Promise<{token}>` awaited; `app/q/layout.tsx` = brand shell; `return/route.ts` and `not-found.tsx` outside `[token]`; A-03b BR title. §2.1, §16 step 7 |
| RO-07 GUC escapes unusable from supabase-js/cron; delete order violates FKs | major | **ACCEPT** | `fixture_delete(p_invoice, p_label)` SECURITY DEFINER with transaction-local `set_config`, full-row JSON to `data_fixes`, FK order attempts → approvals → events → notes → revisions → incomes → items/services/notes → installments/terms/links → invoice → client; `revision_id` FKs `on delete set null`; both the script and the cron call it. §4.3 #19 |
| RO-08 Attempt-id return + httpOnly cookie breaks for the Messenger client | major | **ACCEPT** | Same as U2-03 / payments P-20 / security R2-14: `return_no_session`, signed landing token, bounded resolution, event LANDING_NO_COOKIE; A-11b. |
| RO-09 Lazy `seed_terms` is a gated write while the key is OFF | major | **ACCEPT** | `seed_terms` declared exempt from `actionsAllow` (idempotent, no money/revision/link, cascades on REMOVE); A-18b. §2 |
| RO-10 ERROR after a 200'd duplicate is never retried before M5 | major | **ACCEPT** | Housekeeping re-runs ERROR rows < 72 h through the same claim, bounded by `stripe_events.attempts ≤ 5`; `notify.owner.payment_anomaly` on the 3rd failure; A-28. §2.3, §7.1 #5 |
| RO-11 `headers()` sources double-prefixed with `basePath` | minor | **ACCEPT** | `source: '/q/:path*'` and `'/api/q/:path*'`; A-25. §2.1 |
| RO-12 Throw at import breaks the local `next build` | minor | **ACCEPT** | Throw inside the exported functions (503 at request time); A-18 runs a local build without the service key. §2.1 |
| RO-13 `trg_incomes_touch` reverses the 04/10/2026 decision | minor | **ACCEPT** | Trigger dropped; `updated_at` set explicitly by `income_settle`/`quote_hire`/materialization/Zelle patch (the net's `updated_at >= EPOCH` filter needs nothing more — verified `expenseReportNet.server.ts:249,286,305`); decision recorded (L-84). §4.3 #4 |
| RO-14 Live switch is not "two env values"; test endpoint events are not Dashboard-only | minor | **ACCEPT** | `STRIPE_WEBHOOK_ENDPOINT_ID` env (registered in `/api/health/env`); "three env values" in §10; the test endpoint's events added tonight via `webhookEndpoints.update`; the live endpoint created by API. §4.6, §7.9, §10 |
| RO-15 Fixture client burns `max+1` for up to 2 h | minor | **ACCEPT (variant)** | Not "born outside the scale" (r1 R1-03 rejected a fixture that skips hire step 5): the hire assigns `max+1` as in production and the script **immediately** rewrites the fixture client to 9999 with a `data_fixes` row, so the real sequence is held for one transaction; deletion frees 9999. §10.2 B5 |
| RO-16 "In both apps" vs M6; the 21/06 both-apps rule silently suspended | minor | **ACCEPT** | "in both apps" struck from §2.1 (US tonight, BR in M6); §10 states "M1–M5 are US-only by design; the BR repo is not deployed until M6 (owner informed in the morning note)". |

### 17.7 Tally
**100 findings decided** (rules 17 · consumers 11 · security 14 · payments 19 · ux 18 · rollout 16 — the task's list of 64 critical/major + 36 minor). Every failure path described by a refuter was accepted as real. **90 fixes adopted as proposed**, **9 adopted in a variant form** (consumers #9 default-off key; payments P-31 matcher in M2 with `payout_id` in M1; payments P-33 held-not-booked for a foreign currency; ux U2-03 HMAC landing token instead of a stored nonce; ux U2-13 in-page contact sheet instead of deep links; rollout RO-04 column-list GRANT instead of a secrets table; rollout RO-15 post-hire renumbering instead of a pre-hire out-of-scale number; security R2-06/ux U2-08 merged into one gate design), **1 rejected as superseded** (consumers #8: the `stripe:` bank-link special case is withdrawn from the design rather than added to §9, because payments P-31 shows it would hide a real reconciliation gap). Where two refuters collided (rules R2-14 vs ux U2-13 on outbound links; consumers #8 vs payments P-31 on `stripe:`; security R2-02 vs rollout RO-04 on the token mechanism), the constitution decided (C-84, C-58/C-65 honesty, the brake's actual regex). No finding was left undecided.
