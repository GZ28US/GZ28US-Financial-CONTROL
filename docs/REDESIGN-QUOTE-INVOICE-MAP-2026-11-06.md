# 00-MAP — the QUOTE → INVOICE area of the GZ28US Control App, as it is today

Synthesis of the 18 reader reports in this folder (phase 1 "Understand" of the redesign ordered by Márcio on 06/11/2026, memory `redesign-quote-invoice-06nov`). Written 2026-11-06 (Orlando) against US repo HEAD `6252e6c0`. This document feeds the Design phase: it is the architecture map, the lifecycle, the constitution, the ranked pain, the reuse/replace list, the open questions and the gap analysis for the target (client views → approves/e-signs → pays the 1st installment via Stripe → the project is born automatically).

Conventions. **FACT** = seen in code / schema / live data / a dated memory note (cited `file:line`, `memory:<note> (<date>)`, or `[reader-key]` when the citation is carried from a reader report). **INFERENCE** = the synthesizer's reading, flagged. **LIVE** = the read-only PostgREST probe run on 06/11/2026 (`probe-invoices.mjs`, Appendix A). `E:` = `app/rides/[id]/invoices/edit/[invoiceId]/page.tsx`; `V:` = `app/rides/[id]/invoices/[invoiceId]/page.tsx`; `N:` = `app/rides/[id]/invoices/new/page.tsx`; `L:` = `app/rides/[id]/invoices/page.tsx`; `SHOP:` = `C:/Users/gz28u/gz28shop-us`; `BR:` = the BR sister repo.

---

## 0. Method, sources and the conflicts resolved against evidence

### 0.1 Sources
All 18 reports read in full: `editor-A-state`, `editor-B-actions`, `editor-C-ui`, `view-page`, `lists-and-new`, `packs`, `money-engine`, `client-surfaces`, `messaging-pdf-files`, `shop-stripe`, `data-model`, `constitution`, `consumers`, `duties-streams`, `framework-conventions`, `br-parity`, `history`, `benchmark`. Plus direct verification of: `MIGRATION_despesa_nunca_apaga_em_cascata.sql`, `MIGRATION_invoice_expected_conclusion.sql`, `lib/appVersion.ts:27`, `lib/laborCost.ts:1-26`, `N:303-320`, `V:335-342`, `E:3030-3035`, `app/api/rides/renumber/route.ts:1-60`, `SHOP:lib/opsWrite.ts:509-562`, `RECADOS.md` (27/09, 08/10, 10/10→20/10), memory notes `redesign-quote-invoice-06nov`, `promised-to-date`, `quote-sem-renda-sem-pasta`, `new-invoice-online-and-report`, `invoice-status-model`, and the live probe.

### 0.2 Where readers disagreed, and what the evidence says

| # | Topic | Reader positions | Resolution (FACT unless flagged) |
|---|---|---|---|
| R1 | `invoice_expenses.invoice_id` delete rule in US | `br-parity` inferred US still CASCADEs; `data-model`, `editor-B`, `lists-and-new` cite RESTRICT | **RESTRICT.** `MIGRATION_despesa_nunca_apaga_em_cascata.sql` exists in the US repo and flips every CASCADE FK on `staff_expenses, fixed_cost_expenses, assets_expenses, invoice_expenses`; RECADOS 27/09 00h42 says "nos 2 apps … 11 FKs". `invoice_items` and `invoice_incomes` still CASCADE (`PREVOO_pacote_catalogo.sql:25-26` per `data-model`); `invoice_services/notes/duties` rules were never inventoried. The list pages' bare `invoices.delete()` therefore fails on any document with expenses. |
| R2 | Which field is PROMISED TO | `view-page`/`money-engine`/`consumers`/`constitution` note the view tests `delivery_date` but prints `expected_conclusion_date`; `consumers` found 3 consumers + 1 RPC reading `delivery_date`; memory `promised-to-date` (modified 11/09) says `delivery_date`; `editor-A/B` show the editor uses `expected_conclusion_date` | **`expected_conclusion_date` is the promise.** `MIGRATION_invoice_expected_conclusion.sql` ("Ideia do Márcio (20/ago)") created the column, copied every open invoice's `delivery_date` into it and cleared `delivery_date`, which "vira campo de FATO"; `lib/appVersion.ts:27` records the move. LIVE: 0 invoices have `delivery_date` set with `conclusion_date` empty, so `V:339-340`, `app/api/self-notify/route.ts:286-290`, `app/duties/page.tsx:164,205` and the RPC `duties_self_load` never produce a PROMISED TO line today — they are stale readers, and the memory note predates the move. Open question Q-07 asks Márcio to confirm the retirement of the old wording. |
| R3 | New invoice born ONLINE? | Law (memory `new-invoice-online-and-report` 24/08) vs `lists-and-new`: NEW form never sets `live_status` | **Law says ONLINE; code does not do it.** `N:308-316` writes no `live_status`; `SHOP:lib/opsWrite.ts:521-525` writes none either. LIVE: 14 non-quote invoices sit at INCOMPLETE (one is the BUCKET). Gap G-11. |
| R4 | Quote status vocabulary | memory `invoice-status-model` (19/06): quotes cycle INCOMPLETE↔CLOSED only; `constitution` found quotes created REALTIME in practice | **Unresolved in the data.** LIVE: 35 quotes = 20 CLOSED, 13 INCOMPLETE, 2 REALTIME. The editor button enforces the two-state cycle (`E:3674-3680`); the two REALTIME quotes were created outside it. Q-01. |
| R5 | FINAL MARKUP basis | `money-engine`/`editor-A`: code uses Σ listed incomes when any exist; label and `lib/laborCost.ts:7-8` say "grand total − expenses − staff cost" | **Law and code differ; three code variants exist** (editor/view with staff cost; per-owner list without staff; global list/home/future without staff and without grand-total fallback). Q-10. |
| R6 | Stripe fee policy | gross-up `(X+0.30)/0.971` (memory `stripe-cobrar-cartao` 26/10) vs absorb (memory `redesign-quote-invoice-06nov` 06/11) | **Absorb is the current decision for quote deposits** (latest); gross-up remains a documented per-case option. |
| R7 | Is `.QT.` ever stored in `invoice_code`? | `consumers` doubted; others said display-only | **Both are right.** `.QT.` is stored only because quote CARS carry `US.QT.###` as `project_code`, so their invoice codes are `US.QT.028.1`. For a quote on a PROJECT car the code is `US.033.1` and `.QT.` is inserted at display time only (`E:3664`, `app/quotes/page.tsx:95`). LIVE: 30 codes contain `.QT.`, all `is_quote=true`. |
| R8 | How a quote car is promoted | `editor-B`: editor's own `migrateQuoteToProject`; memory `renumeracao-escala-26set`/`pastas-numero-unico`: only via `POST /api/rides/renumber` | **Two promotion paths exist.** The editor never references the renumber route (grep 0 hits); its private copy (`E:2608-2666`) runs in the browser without the route's pre-checks (409 without touching), without the `retryFrom` resume, and without the mail-folder/BR steps. The route is the sanctioned path (header comment 27/09/2026) and since 20/10 creates the Dropbox folder when the quote never had one (RECADOS 10/10 → RESOLVIDO 20/10). |
| R9 | Shop webhook on mirror failure | stale comments in `opsWrite.ts:407-414` say 200; code returns 500 | **Code wins: 500 → Stripe retries up to 3 days** (`SHOP:app/api/stripe-webhook/route.ts:245`, audit 08/10). The "paid order leaves no artefact" hole described in memory `paid-from-to-por-tabela` (11/09) is therefore narrowed to a 3-day retry window. |
| R10 | CLOSED gate reads `payment_date`, not `paid_at` | `constitution` flagged a tension with the cash law | **Consistent with the owner's words**: "CLOSED has nothing to do with payment, it's about DATES" (25/08). The gate is `Σ listed incomes ≥ grand (±0.005)` ∧ `every income has payment_date or date_label` ∧ `conclusion_date` (`E:1836-1839, 2694-2701, 3686-3699`). Not a bug; whether it should also require `paid_at` is Q-02. |
| R11 | Were SHOP invoices affected by FL-tax-by-law? | `shop-stripe` flagged a live collision | **Theoretical today.** LIVE: 0 invoices with `shop_order_id` or `shop_wishlist_id`, 0 with `origin='SHOP'`; one SHOP client exists. The collision becomes real with the first paid shop order. |
| R12 | `invoice_expenses.part_id` has no writer | `duties-streams` | LIVE: 9 rows have it set (scripts or hand edits). Still effectively dead: the editor and robots write null. |
| R13 | Promotion-without-folder bug (R-36 in `constitution`) | reported as open | **Resolved 20/10/2026** for the renumber route (RECADOS 10/10 13h57 → ✅ 20/10); the editor path has always called `/api/ride-folder create` itself (`E:2637-2643`). |

### 0.3 Live facts that recalibrate several reports (probe 06/11/2026, Appendix A)
- Status is not what the memory says in two places: 2 REALTIME quotes (R4) and 14 INCOMPLETE real invoices (R3).
- `invoices.pack_id` is NULL on all 211 rows; `target_grand_total` is set on 27; `fl_tax_override` on 0; `florida_taxes` non-zero on 19 (legacy).
- 0 incomes on quotes (the 06/11 law holds). 325 incomes: 290 received (`paid_at`), 9 scheduled, 26 undated; `paid_at` written in four time-of-day shapes (141 noon-UTC, 32 noon-Orlando, 21 midnight-UTC, 96 other). `source` already contains `STRIPE` (2) and PIX (78 — BR-received money on US invoices).
- 2,133 expenses: 394 unpaid; 414 without `paid_from`; **1,106 without `paid_to`** (the "hidden GZ28US" rule only covers rows written since the rule); `export_status` has 13 rows of an off-vocabulary `PENDING`; `priority` has one `P0`; `origin` has one `GZ28BR` invoice and one `FACEBOOK` client — none of these columns has a CHECK.
- 85 rides (28 quote cars), **26 with `title_scope` NULL** → FL tax falls back to the client's address for those cars; 4 USA clients have a blank state (taxed as Florida by assumption, `lib/flTax.ts:52`).
- 90 clients (53 quote clients); 30 have no e-mail, 8 have no preferred method — relevant to how the approval link is delivered.
- 16 `quote_backups` (one per converted quote); 29 unassigned duties of which 25 belong to quotes.

---

## 1. ARCHITECTURE MAP (as it is today)

### 1.1 Entities

```
clients ──(current owner, no FK)──► rides ──(1:n)──► invoices ──(1:n)──► invoice_items      (ex invoice_parts; total & base_tributavel GENERATED; CASCADE)
   │ client_number int (max+1,         │ project_code UNIQUE        │ invoice_code      ├──► invoice_services  (price; payment_date = client paid, not executed)
   │ no unique), is_quote, origin,     │ is_quote, origin, pinned,  │ client_id frozen  ├──► invoice_incomes   (ex invoice_payments; paid_at = CASH, payment_date = schedule; CASCADE)
   │ preferred_message_method,         │ title_scope (OWNER &       │ is_quote, origin  ├──► invoice_expenses  (45 cols: price/qty/tax/extra, payment_date = PAID, paid_from/paid_to,
   │ country → language, grade         │ DESTINATION → FL tax)      │ live_status       │                        order_number, purchase_group, export_status, tracking facts; RESTRICT)
   └── ride_owners (ownership eras)    └── ride_builds/dyno_pulls/  │ feed_status (dead)├──► invoice_notes     (print on the PDF)
                                           ride_build_sheets        │ hiring_date,      └──► invoice_duties    (staff_id nullable, priority, estimated/time_seconds, blockers, release_*)
packs (JSON template: parts/services/   (performance seed)          │ client_hiring_date,
   expenses/notes/duties; zone, status,                             │ entry/expected_conclusion/conclusion/delivery dates,
   shop_locked, validated_by, scope per line) ── pack_id (SET NULL) ─┤ global_discount %, import_margin %, target_grand_total,
                                                                    │ fl_tax_override(+reason), florida_taxes (LEGACY), fl_tax_expense_date,
quote_backups (invoice_id no FK, snapshot jsonb {invoice,parts,      │ pack_id, shop_order_id, shop_wishlist_id, br_invoice_id, mirror_key
   services,payments,notes,expenses}; one row per conversion)       │
data_fixes (robot trail; the editor never writes it) · duty_events (invoice_code text copy) · wa_send_log (no document identity)
parts_database (shared catalog, text link via part_number) · suppliers · inventory (DONATED stock, order_number = invoice_code) · assets
```
Sources: `data-model` §1–2, `editor-A` §3, schema dump. A QUOTE is not an entity: three independent `is_quote` flags (client, ride, invoice) with independent number series and no DB rule tying them (`data-model` §0.2).

### 1.2 Pages and routes of the area

| Route (under `/ca`) | File | Lines | Role | Also mounted at |
|---|---|---|---|---|
| `/rides/[id]/invoices/new` (`?mode=quote`, `?duplicateFrom=`) | `N` | 546 | creation form, code allocation, pack picker + `applyPack`, literal DUPLICATE | `/clients/[id]/invoices/new` (1-line re-export; `isClient` by pathname) |
| `/rides/[id]/invoices/edit/[invoiceId]` | `E` | 4,802 | THE editor: items/services/expenses/incomes/notes/duties/status/dates/tax/inventory; quote→invoice conversion inside SAVE; WhatsApp reports; scans | `/clients/[id]/invoices/edit/[invoiceId]` |
| `/rides/[id]/invoices/[invoiceId]` | `V` | 1,214 | read-only view + hidden print layout + raster PDF + SEND chooser + ORIGINAL QUOTE modal + DUPLICATE QUOTE | `/clients/[id]/invoices/[invoiceId]` |
| `/rides/[id]/invoices` | `L` | 386 | per-owner list (last-activity order, 6-rung ladder, 4 money badges, REMOVE, DUPLICATE) | `/clients/[id]/invoices` |
| `/invoices` (`?mode=shop`) | `app/invoices/page.tsx` | 264 | global list of real RIDE invoices (shopping docs excluded) | — |
| `/quotes` (`?mode=shop`) | `app/quotes/page.tsx` | 114 | global list of RIDE quotes (no amounts, no client) | — |
| `/payments` | `app/payments/page.tsx` | 386 | PAST 12-month cash ledger | — |
| `/rides/[id]`, `/clients/[id]` | — | 731 / 317 | INVOICES / SHOPPING sections with a third status vocabulary | — |
| `components/DocPicker.tsx` | — | 80 | client → ride → `new?mode=quote` (always a ride) | — |

Every page is `'use client'`, reads/writes Supabase directly with the anon key + the admin's JWT under RLS "authenticated can do everything" (`framework-conventions` §3, §4.3; `supabase/rls_phase1.sql:166-182`).

### 1.3 Server routes the area calls (all gated by `lib/apiAuth.server.ts`)
`/api/ride-folder` (create · rename · invoice-folder · invoice-receipts), `/api/performance/seed-pack`, `/api/scan-receipt`, `/api/whatsapp`, `/api/report-net/mute`, `/api/mail/client` (kinds `invoice-pdf`, `client-form`, `car-photo`), `/api/crossing` + `/api/br-mirror/paid` (frozen engine, `ESPELHO_ENCERRADO = true`), `/api/br-mirror/suppliers`, `/api/rides/renumber` (not called by the editor), `/api/self-notify` (public pages), `/api/duty-events`. Vercel crons relevant here: `invoice-receipts` (2 h), `mail-poll` (5 min; report net, receipt→paid, mail→item), `items/track` (hourly), `staff-duty-watch` (30 min), `daily-report` (08:00 UTC), `rides/dropbox-folders` and `rides/mail-folders` (hourly) (`messaging-pdf-files` App. A; `duties-streams` App. A).

### 1.4 Pure rulers (libs) and what each owns
| Lib | Owns | Callers |
|---|---|---|
| `lib/flTax.ts` | `flTaxStatus` (scope → client address → override), `invoiceMoney` (subtotal − discount% before tax + 6% + 0.5% on first $5,000 per line), `invoiceMoneyFor` | editor, view, 4 lists, home, future, `lib/financials.ts`, packs (12 callers; each resolves scope/client itself) |
| `lib/estorno.ts` | REFUNDED leaves money unless a negative line books it; CANCELLED counts | loader, all invoice screens, import-to-items, crossing, ledger, close score |
| `lib/financials.ts` (`'use client'`) | `expLine`, `qtyLine`, `whoPaid`, `invoiceTotals`, `recognitionDate`, `buildCashEvents`, `unpaidTotals` | DRE/DFC/Balance/Data Checker; copied by hand into 4 server libs because it imports the browser client |
| `lib/payerRule.ts` + `components/PaymentFields.tsx` | PAYER_RULE per table, `hiddenPayers`, `methodsFor` | every money form, robots |
| `lib/deliverStatus.ts` + `components/DeliverChip.tsx` | derived delivery cascade, blind tracking | editor, view, STREAM, 5 robots |
| `lib/rideCodes.ts` | series (US/SC/WV one scale; PO, US.QT, SHP own), `nextFreeCode` (lowest free, pinned skipped) | new ride, editor conversion, renumber route |
| `lib/reportedAt.ts` / `lib/reportMark.ts` | claim `reported_at` before any balloon | editor, report net, Zelle watch |
| `lib/receiptKinds.ts`, `lib/itemNature.ts`, `lib/laborCost.ts` (US$15/h constant), `lib/packScope.ts`, `lib/ultimaAtividade.ts`, `lib/allRows.ts`, `lib/utils.ts` | receipt URL/kind polymorphism; nature vocabulary; staff cost; pack scopes; last-activity order; 1,000-row paging; formatters/codes/phones/language | across the area |

### 1.5 Robots that write the same tables (must survive any redesign)
Bank Link (`lib/bankReconcile.server.ts`: fills `payment_date`/`paid_at`, stamps payers, BUCKET rows), Zelle watch (`lib/zelleWatch.server.ts`: inserts paid incomes, **deletes** the matched scheduled row), report net + `enforceReceiptPaid` (`lib/expenseReportNet.server.ts`), AutoBook mail (`lib/autoBookMail.server.ts`), 17TRACK/store-check/mail-to-item (tracking facts), receipt hunt, duty watch (import tax), duty release, renumber route, the shop's `opsWrite.ts` (service key), and the frozen crossing engine (`consumers` §3.H, §6.4 of `data-model`).

### 1.6 Flow diagram (today)

```
 LEAD                                  QUOTE                                   SEND (manual)                     ACCEPT (out of band)
 client self-form link ─► quote client ─► quote ride US.QT.### ─► NEW ?mode=quote ─► EDITOR ─► VIEW ─► PDF (html2canvas) ─► WhatsApp/e-mail/SMS/IG/FB ─► client replies on WhatsApp
 (/clients/self/<uuid>)  (clients.is_quote)  (rides.is_quote)    applyPack copies    staged+immediate   public bucket invoice-pdfs            nothing recorded (no sent/viewed/accepted)
                                                                 5 sections          writes; SAVE
                                                                                                                                                       │
 CONVERSION (staff types HIRING DATE + SAVE, browser-side, non-transactional)                                                                           ▼
 quote_backups snapshot ─► migrateQuoteToProject (ride → lowest free US.###, client → max+1, every invoice re-coded, Dropbox create/rename/receipts) ─► invoices.update(is_quote=false, live REALTIME…) ─► seed-pack performance ─► children saved ─► crossing (no-op) ─► report dialogs
                                                                                                                                                       │
 EXECUTION                                               MONEY                                              CLOSE
 duties (immediate CRUD; /duties board; phone page)      incomes typed by hand or scanned; paid_at = cash   CLOSED gate: Σ listed incomes ≥ grand ∧ all dated/labelled ∧ conclusion_date
 expenses: scan/DB/stock/manual; robots add facts        Bank Link / Zelle watch stamp paid_at              recognition month = conclusion > delivery > last income
 PAID toggles → WhatsApp report (reported_at claimed)    report net (5 min) catches the rest                lists/HOME/FUTURE read REALTIME|CLOSED only
```

### 1.7 Who writes / who reads (per table, the facts the redesign must keep true)
- `invoices`: written by NEW (birth), editor SAVE (header, status, conversion), renumber route (code), shop (SHOP birth), crossing (frozen). Read by ~70 consumer files; gates everywhere are `is_quote=false` and `live_status ∈ {REALTIME, CLOSED}` (`consumers` §4.1).
- `invoice_items`: editor (insert on SAVE; immediate row edits; margin re-pricer rewrites `unit_price`/`base_cost` of every non-mirror row on every SAVE), applyPack, duplicate, shop. Read by totals via `base_tributavel` (financials) or `unit_price×quantity` (screens) (`money-engine` §2.2).
- `invoice_services`: editor (labor solver rewrites `Full Project Labor` on SAVE), applyPack, shop. `payment_date` = client paid, never "executed" (memory `o-que-falta-mora-na-invoice` 14/09).
- `invoice_incomes`: editor, Zelle watch, Bank Link, shop; read by every money report through `paid_at` only (`consumers` §4.4).
- `invoice_expenses`: editor, applyPack, duplicate, scan, Bank Link, receipt hunt, duty watch, AutoBook mail, shop, robots' tracking facts; read by cost, report net, Dropbox receipts, STREAM, release robot (`consumers` §4.5).
- `invoice_duties`: editor (immediate), applyPack, `/duties`, phone RPCs, release/watch robots.
- `quote_backups`: editor only (conversion); read by the view's ORIGINAL QUOTE modal (legacy tax math).

### 1.8 Security topology
Client-side `AuthGate` with five `PUBLIC_PREFIXES` (`/clients/self/`, `/rides/self/`, `/costs/fixed/self/`, `/duties/self/`, `/staff/self/`); public pages use SECURITY DEFINER RPCs granted to anon and `POST /api/self-notify` (server rebuilds the message, 10-min recency gate, 2-min dedupe, `x-send-key`); anon has no table access to any invoice table; the row UUID in the URL is the whole credential and never expires; the invoice UUID already leaks in every public PDF URL (`client-surfaces` §1–§8).

### 1.9 Sister systems
- **Shop** (`gz28shop-us`, `/shop`, own customer Supabase project): Stripe Checkout (one ad-hoc line, `automatic_tax` by address, 50/50 for in-house) → webhook (`www` only; 400/503/500/200 semantics; status-gated idempotency; ACH states) → `createShopInvoice` into the US DB with the service key (deposit income with `paid_at` + undated balance row; `florida_taxes` written; `live_status` not written) (`shop-stripe` §4–6).
- **BR app**: a fork at ~68% identical lines in the editor; old table names (`invoice_parts`, `invoice_payments`), BRL anchor + USD shadow, "Impostos NF" in `florida_taxes`, CLIENT payer, PowerTrade import services, NF entity, staff cost in totals, different numbering (BR.401+ max+1); the BR shop is closing (`br-parity` §0–§4; memory `fim-oficina-br-status-final` 27/10).

---

## 2. LIFECYCLE TODAY — step by step, with the exact fields

### 2.1 Birth of a quote
1. **Lead** → `clients` row with `is_quote=true`, `client_number = max+1` within (origin, is_quote), `preferred_message_method`, `country` (drives language); the client may fill `/clients/self/<uuid>` (memory `client-self-form`; `client-surfaces` §2).
2. **Quote car** → `rides` row with `is_quote=true`, `project_code = nextFreeCode(…, 'US.QT')` (own scale), `title_scope` optional (LIVE: 26 rides NULL).
3. **Document** → `DocPicker` (client → ride) → `N?mode=quote` → `createInvoice`: `invoice_code = <project_code>.<lowest unused n>` computed in the browser (only guard: unique `(client_id, invoice_code)`), `is_quote = true`, `client_id` = ride's current owner (frozen forever), `origin` inherited, `pack_id/target_grand_total/global_discount/import_margin` copied from the pack; **no `live_status` written**; no folder for quotes (`N:274-294, 303-366`; `lists-and-new` §3.1).
4. **applyPack** copies parts → `invoice_items` (unit_price/base_cost/kit fields, no position), services (+ `Full Project Labor @ 0` anchor), expenses (unpaid, `paid_to GZ28US` hidden, `part_number`, `export_status` carried, kit → fresh `purchase_group`), notes (all scopes — SHIPPED and IN_HOUSE lines together), duties (`staff_id null`), `show_part_numbers` when true; "Importação" lines dropped; no FL tax carried (`N:371-464`; `packs` §4.3). Then `router.push(edit)`.
5. Shopping quote (no ride): code `<pad3(client_number)>.<n>`, REQUEST DATE label, no ENTRY/MILEAGE, no folder, no performance (`lists-and-new` §3.3).

### 2.2 Authoring (editor)
Two write regimes coexist: adds/removes/reorder/export_status/margin/labor/header wait for SAVE; row edits, PAID toggles, duties, SEND TO, FROM STOCK (inventory decremented at once), SHOW PART NUMBERS, supplier upsert, Parts-DB enrolment write immediately; Cancel = `history.back()` (`editor-A` §10; `editor-B` §1). Quote branches: INCOME panel hidden, no PAID toggles, expenses stay unpaid, no reports, status INCOMPLETE↔CLOSED only (`editor-A` §8). Totals: `invoiceMoney` on live lines; FL tax by law from `rides.title_scope` or client address (`E:1818-1822`); TARGET GRAND TOTAL solves `Full Project Labor` iteratively (`E:1896-1923`); MARGIN re-prices every item with `base_cost` (`E:1870-1889`).

### 2.3 Sending (view page, manual)
`generatePdfBlob` rasterizes the hidden `.print-page` (html2canvas scale 2 → JPEG → jsPDF letter, sliced by height) → upload to PUBLIC bucket `invoice-pdfs/<invoiceId>-<ts>.pdf` → chooser REPORTS / Client · method / Both → WhatsApp document (`/api/whatsapp`), e-mail (`/api/mail/client kind:'invoice-pdf'`, Graph slot 1, PDF attached), SMS `sms:` link, IG/FB clipboard. Captions: quote → Grand Total + courtesy line (client) / + MarkUp (REPORTS); invoice → Open balance (client) / Grand Total (REPORTS); English only; PROMISED TO condition broken (R2). **Nothing is written on the invoice about the send**; only `wa_send_log` (160 chars of body) (`view-page` §9; `messaging-pdf-files` §3).

### 2.4 Acceptance and conversion
Acceptance is a WhatsApp reply; Márcio tells the assistant "mude esta quote pra invoice, data de hoje" (memory `enviar-como-o-app-na-conversa` 25/09). Conversion = editor SAVE with a valid HIRING DATE (`hiring_date` for rides; `client_hiring_date` for shopping quotes — `hiring_date` there is REQUEST DATE and never converts): `nextIsQuote = isQuote && !isValidDate(conversionDate)` (`E:2706-2707`). Sequence (`E:2689-2965`, `editor-B` §2–3):
1. guards: FL override needs reason; CLOSED demoted to REALTIME when the gate fails; a converting CLOSED quote is reborn REALTIME (`E:2710-2713`);
2. `backupQuoteBeforeConversion()` → one `quote_backups` row `{invoice, parts, services, payments, notes, expenses}` (legacy key names; duties not included);
3. `migrateQuoteToProject()`: client branch (`client_number = max+1`, `is_quote=false`, shopping codes re-prefixed) or ride branch (`project_code = nextFreeCode(all non-quote codes, 'US')`, `is_quote=false`, `POST /api/ride-folder create`, every invoice of the ride re-coded + folder renamed + receipts re-synced, client promoted) — browser-side, no transaction, no 409 pre-check, not the sanctioned renumber route (R8);
4. `invoices.update({hiring_date, client_hiring_date, entry_date, conclusion_date, delivery_date, expected_conclusion_date, mileage, service, feed_status (vestigial mirror 'REAL_TIME'|'INCOMPLETE'), live_status, fl_tax_override(+reason), global_discount, target_grand_total, import_margin (0, never null), fl_tax_expense_date, is_quote: nextIsQuote, updated_at})`; on error alert and return — steps 2–3 stay committed;
5. `semearPerformance` (validated shop-locked pack → BoneStock + build + build sheet; today unreachable via `pack_id` since it is NULL everywhere, falls back to exact `service == packs.name`);
6. bulk inserts of new rows (items with `position`; incomes with `paid_to` default GZ28US; expenses with `expense_date = payment_date`, `paid_to = 'GZ28US'`, `source = paid_from`), labor row price update, `position`/`export_status` updates (errors unchecked), DONATED inventory delete-and-reinsert, staged deletes after the crossing-mirror check (`confirm()`), crossing engine call (returns "TRAVADA/nada" since 23/10), WhatsApp report dialogs for new paid rows, `syncInvoiceReceipts` fire-and-forget.
Nothing duty- or purchase-specific happens on the flip: quote duties and placeholder expenses simply persist and become live by virtue of `is_quote=false` (`duties-streams` §3.2).

### 2.5 Execution
Duties: immediate CRUD in the editor (owner required), `/duties` board (START auto-pauses, `duty_take` for shared, WhatsApp to "GZ28US - STAFF"), phone page `/duties/self/<staffId>` (RPCs, `duty_events`, `self-notify`), release robot (`blocked_by_expenses` arrived → `release_priority`), watch robot (LONG/OVERLAP/OVERNIGHT). Purchases: scan (lines born PAID on the document date, `purchase_group`, order number on every line, placeholder of same PN/name deleted — the only sanctioned automatic delete), IMPORT FROM DATABASE, FROM STOCK (FIFO, cost 0 for DONATED), manual add (born PAID today on invoices); robots add tracking facts; status derived by `deriveDeliverStatus`; IMPORT INTUITIVE PARTS turns FRESH expenses into items at landed cost × (1+margin) (`duties-streams` §3–4; `editor-B` §8).

### 2.6 Payments
Incomes: typed (`+ ADD INCOME`, unpaid), `ADD PENDING BALANCE` (undated row = grand − Σ listed, full precision), scanned (born paid, `paid_at` = noon UTC of the document date), PAID toggle → `PAID IN?` → `paid_at = date + 'T12:00:00Z'` → report dialog (`reported_at` claimed first). Robots: Zelle watch inserts a paid income (`paid_at` noon Orlando, `paid_to GZ28US`, `reported_at` set) and deletes the matched scheduled row; Bank Link fills `paid_at` where NULL. Only `paid_at` is cash anywhere; DELAYED = `payment_date ≤ today` and unpaid (one WhatsApp alert, `delayed_alert_sent_at`); REMIND button auto-sends by preferred method (`editor-B` §7; `consumers` §3.H; `money-engine` §6).

### 2.7 Closing
STATUS button INCOMPLETE → ONLINE → CLOSED; CLOSED requires `pendingBalance ≥ −0.005` ∧ every income dated or ARRIVAL/CONCLUSION-labelled ∧ `conclusion_date` (confirm offers today in America/New_York); failing gates drop to INCOMPLETE; save guard demotes a non-qualifying CLOSED to REALTIME. CLOSED is about client dates, never our payables. Recognition month = `conclusion_date > delivery_date > last income`; period DRE counts only CLOSED; Bank Link needs `force_closed` to move cost into a CLOSED invoice (`E:3672-3707`; `consumers` §2.1; memory `invoice-status-model` 25/08).

### 2.8 Status vocabularies in use (five, for one document)
`live_status` (INCOMPLETE / REALTIME→"ONLINE" / CLOSED); derived REPORT READY (`!is_quote && live ∈ {REALTIME, CLOSED}`); the per-ride ladder QUOTE → AWAITING CAR → ON DUTY → PRE-DELIVERED → DONE → DELIVERED (6 rungs; the global list has 5; the ride page has OPEN/CLOSED by `delivery_date ≤ local today`); income PAID/DELAYED/PENDING; expense PAID/UNPAID; item/service PAID/PENDING (procurement / client-paid, never "executed"); delivery chips PICKUP/BOUGHT/SHIPPED/DELIVERED/CANCELLED/REFUNDED (`lists-and-new` §7; `editor-C` §5).

### 2.9 Codes
Ride `US.###` (shared scale with SC/WV), `US.QT.###` (quote cars), `SHP.###`, `PO.###`; invoice `<ride code>.<n>` lowest unused per owner; shopping `<pad3(client_number)>.<n>` (no prefix); intercompany `006.N`/`085.N` max+1 (history); bucket `A ATRIBUIR`; `.QT.` display-inserted for quotes on project cars. Three numbering algorithms (app lowest-free, shop lowest-free anchored, crossing max+1), all client/webhook-side, no sequence (`lists-and-new` §2; `data-model` §5).

---

## 3. CONSTITUTION — merged, de-duplicated invariants the redesign must preserve

Each rule carries its source; where a reader's statement conflicted, §0.2 holds the resolution. "Law" = Márcio's words recorded in a memory note; "code" = enforced in code today.

### A. The model
- **C-01** Everything hangs on an invoice: items, services, expenses, incomes, notes, duties all carry `invoice_id`; what a car still needs lives in its invoice (unpaid expenses = A COMPRAR, open duties = work) — memory `invoice-centric-app-law` (10/08/2026), `o-que-falta-mora-na-invoice` (14/09/2026).
- **C-02** A quote and its invoice are the same `invoices` row; conversion flips `is_quote` in place and never copies lines — commit `4dec9c4e` (31/08/2026); `E:2707,2734`.
- **C-03** `invoice.client_id` is stamped at creation with the ride's then-current owner and never re-attributed; resolve owner as `invoice.client_id ?? ride.client_id` — `N:334-337`; `V:176-184`; memory `ride-ownership-transfer` (12/07/2026).
- **C-04** `origin` ∈ {PROJECT, SHOP, BUCKET} is inherited from the owner and partitions every list; the BUCKET pseudo-invoice (`A ATRIBUIR`, INCOMPLETE, no client/ride) exists exactly once, cannot be deleted, is excluded from every total and never edited/viewed/listed where REMOVE exists — `N:326-339`; `MIGRATION_auto_book_phase_b.sql:49-65`; `E:625-630`; `V:188-191`.
- **C-05** No duplicate fields: one column per fact; never data inside text; status is derived, not stored — memory `no-duplicate-fields` (03/09/2026), `never-data-as-text` (26/08/2026); `lib/deliverStatus.ts:14-18`.
- **C-06** Three independent `is_quote` flags (client, ride, invoice) must flip together on promotion; robots filter on them — `E:2605-2666`; `lib/receiptHunt.server.ts:292`; `app/api/rides/mail-folders/route.ts:81`.

### B. Quote laws
- **C-07** A quote has no income, appears in no money report or flow, and has no Dropbox or e-mail folder; `invoice_incomes` joined to `is_quote=true` must be 0 (LIVE: 0) — memory `quote-sem-renda-sem-pasta` (06/11/2026), `quotes-excluded-from-reports` (22/06/2026); `lib/financials.ts:164-171`; `app/api/ride-folder/route.ts:370`.
- **C-08** Quote expenses are allowed (markup model) and may carry receipts as price references; a receipt on a quote expense is not proof of payment (`enforceReceiptPaid` skips quotes) — memory `receipt-means-paid` (01/08/2026); `lib/expenseReportNet.server.ts:161-162`.
- **C-09** Conversion is one-way and triggered only by a valid HIRING DATE (`hiring_date` on rides, `client_hiring_date` on shopping quotes; REQUEST DATE never converts); an invoice never reverts — `E:2702-2707`; commits `a1d067d0` (06/06), `2a72b718` (22/06/2026).
- **C-10** Before conversion the pristine quote is archived in `quote_backups.snapshot` — `E:2575-2603`; commit `0e9e7ae3` (06/06/2026).
- **C-11** On conversion a quote ride becomes a PROJECT ride with the lowest free number on the US/SC/WV scale (never max+1; pinned never reused), a quote client gets `client_number = max+1`, every invoice of the ride is re-coded, Dropbox folders/receipts follow, and performance is seeded for a validated shop-locked pack — `E:2608-2666, 2741`; `lib/rideCodes.ts:59-64`; commits `51703c00`, `d12088ca`, `39dbfc32`; `lib/packPerformance.server.ts:46-141`.
- **C-12** The sanctioned renumber/promotion path is `POST /api/rides/renumber` (pre-checks, 409 without touching, Dropbox recode, mail folders, BR, receipts, folder creation since 20/10) — route header (27/09/2026); memory `renumeracao-escala-26set`, `pastas-numero-unico` (13/10/2026); RECADOS 20/10.
- **C-13** A newborn invoice is never CLOSED; a quote's CLOSED flips to REALTIME on conversion — `E:2708-2713`; commit `01f897b9` (09/08/2026).
- **C-14** Quote duties reach staff phones only once hired; pack duties are born unassigned — memory `caso-shaker-camaro-luciano` (15/10/2026), `pack-staff-duties` (26/08/2026); `N:446-463`.
- **C-15** The quote PDF hides the car nickname; the invoice shows it; nicknames in external text always come with make/model/year — `V:638-642` (26/08/2026); memory `never-send-unauthorized` §4.
- **C-16** Prices presented to a client never change afterwards; the version sent is the version that stands; items of a sold pack are not rewritten when the build changes — memory `presented-price-law` (10/08/2026), `servicos-sao-do-marcio` (27/10/2026 "don't touch ITEMS").

### C. Status
- **C-17** `live_status` ∈ {INCOMPLETE, REALTIME (displayed ONLINE), CLOSED}; there is no `status` column; renaming values requires rewriting every reader (10+ filter sites) — memory `invoice-status-model` (19/06/2026); `consumers` §8.1.
- **C-18** CLOSED ⇔ Σ listed incomes ≥ grand total (half-cent) ∧ every income dated or milestone-labelled ∧ `conclusion_date`; it is about client-side dates, never about our unpaid expenses; a CLOSED invoice that stops qualifying drops to ONLINE on save — `E:1836-1839, 2694-2701, 3686-3699`; memory `invoice-status-model` (25/08/2026).
- **C-19** REPORT READY is derived (`!is_quote && live ∈ {REALTIME, CLOSED}`), never a toggle; `feed_status` is vestigial and no feed toggle may return — memory `invoice-status-model`; `L:67-71`.
- **C-20** A new real invoice is born ONLINE (`REALTIME`); creation itself emits no real-time report (only the Daily Mega-Report lists new rides/invoices) — memory `new-invoice-online-and-report` (24/08/2026). (Code gap R3.)
- **C-21** Recognition month of a CLOSED invoice = `conclusion_date > delivery_date > last income`; period DRE counts only CLOSED; moving cost into a CLOSED invoice reopens the period and needs `force_closed` — `lib/financials.ts:507-517`; `app/api/bank/reconcile/route.ts:1097-1114`.
- **C-22** Car ladder QUOTE → AWAITING CAR → ON DUTY → PRE-DELIVERED → DONE → DELIVERED is derived from `is_quote`/`entry_date`/`conclusion_date`/`delivery_date` — `L:50-65`.
- **C-23** `expected_conclusion_date` is the promise; `conclusion_date` and `delivery_date` are facts; every report/update about an open invoice carries `🗓 PROMISED TO: <expected_conclusion_date>` — `MIGRATION_invoice_expected_conclusion.sql` (20/08/2026); `lib/appVersion.ts:27`; `E:3032-3034`; memory `promised-to-date` ("all reports and updates, always"). See R2 for the stale readers.

### D. Billing math (US)
- **C-24** Billed = Σ `invoice_items (unit_price×quantity)` + Σ `invoice_services.price` − `global_discount`% (before tax) + FL tax by law; `invoice_expenses` are cost and never enter what the client owes — memory `faturado-e-items-mais-services` (18/09/2026); `lib/flTax.ts:92-105`.
- **C-25** Every US total passes through `invoiceMoneyFor`/`invoiceMoney`; no other total formula may exist — memory `fl-sales-tax-pela-lei` (26/10/2026); `lib/flTax.ts:109-114`.
- **C-26** Open balance shown to the client = grand − incomes with `paid_at` (min 0); quotes show the grand total; REPORTS gets grand total (+ markup on quotes); the client never sees markup or cost; the PDF stays the full document — memory `msg-cliente-valor-em-aberto` (30/09/2026); `V:334-350`.
- **C-27** Pending balance = Σ all listed incomes − grand; ADD PENDING BALANCE writes the remainder as an undated income row — `E:1831, 2089-2095`; commits `8a8eebc7`, `f581b266`.
- **C-28** Markup = profit ÷ cost, never margin; staff cost = Σ `estimated_seconds` × US$15/h constant enters FINAL MARKUP and never CURRENT CASH FLOW — memory `use-markup-not-margin` (24/06/2026); `lib/laborCost.ts:1-26` (31/08/2026); `E:1849-1863`. (Basis of FINAL MARKUP is Q-10.)
- **C-29** TARGET GRAND TOTAL solves only the service line keyed exactly `'Full Project Labor'` (iterating because labor is taxed); display renames keep the stored key — `E:213, 1896-1923`; commits `4ed1c636`, `a8de9ddd`, `ec92f161`.
- **C-30** `import_margin` % lives on the invoice header; items with `base_cost` are re-priced `base_cost × (1+margin)`; `base_cost` is display/pricing only and never a cost input — `E:1870-1889`; `lib/financials.ts:8-9`.
- **C-31** Courtesy: a 0-priced item/service prints COURTESY/CORTESIA, never $0.00 — `V:681,692,717`.
- **C-32** When billed ≠ received at close, the fix is a real line (labor adjustment, discount), never a synthetic rounding row — memory `vida-real-usd-e-brl` (17/10/2026), `fl-sales-tax-pela-lei` (26/10/2026).

### E. FL sales tax
- **C-33** Status from `rides.title_scope` (USA taxable; OUT_OF_STATE exempt; CLIENT/EXPORT export; OWN/TOOL/PART_OUT no sale) else the client's address (non-US = export; US non-FL = out of state; blank US state = Florida); override only with `fl_tax_override` + mandatory reason; 6% state on every taxable line + 0.5% Orange County on the first $5,000 of each line; labor taxed whenever any part is furnished; labor-only exempt; `invoices.florida_taxes` is LEGACY and no screen may read it — `lib/flTax.ts:9-28, 46-70, 74-82`; `MIGRATION_fl_tax_by_law.sql`; memory `fl-sales-tax-pela-lei` (26/10/2026), `fl-tax-export-rule` (17/10/2026).
- **C-34** Only Florida clients' cars pay; GZ28BR/006.N and exports are zero; purchase tax inside items is a cost, distinct from FL sales tax — memory `br-zero-fl-tax` (10/08/2026), `anistia-10pct-cambio-18out` (18/10/2026), `import-to-items-costs` (17/06/2026).
- **C-35** Quotes are taxed by the same law (the 2026-06 "Prices Exclude Florida Taxes" rule is superseded) — memory `quotes-exclude-fl-tax` (SUPERADO 26/10/2026).
- **C-36** Stripe Tax must never add tax on an amount already computed by law (manual links: untick "Recolher impostos automaticamente") — memory `stripe-cobrar-cartao` (26/10/2026); `benchmark` §1.8.

### F. Items
- **C-37** Never write `invoice_items.total` or `base_tributavel` (GENERATED); `quantity` must be written as a positive number — `MIGRATION_pacote_onda9_regra_dos_campos.sql:53-58`; `N:154-156`; memory `servicos-sao-do-marcio` (26/10/2026).
- **C-38** Every bought-and-paid expense becomes an ITEM at landed cost per unit `(market×qty + tax + extra)/qty × (1+margin)` with `base_cost`, `source_item` = expense text, the paid status carried; cost-only lines (tax/shipping/… ≤40 chars) never import; MAP-first (parts DB), discount gross-up as fallback; DONATED stock imports at MSRP with cost 0 — `E:1579-1659, 214-218`; memory `import-to-items-costs`, `item-discount-percentual` (07–10/09/2026), `stock-donated-msrp` (22/08/2026).
- **C-39** `invoice_items.payment_date` is procurement-only and never feeds income or profit; items carry no payer — memory `import-to-items-costs`; `lib/payerRule.ts` (no `invoice_items` entry).
- **C-40** Only REFUNDED removes a line from the money, and only when no negative line already books the refund; CANCELLED counts; refunded lines stay visible struck through on screen and paper — `lib/estorno.ts:12-14, 28-38, 64-88` (14/09/2026); `V:685-695`.
- **C-41** Kits: `kit_group`/`kit_name` on items, `purchase_group`+`kit_name` on expenses, link by `source_item` text; kits print as a 📦 header with indented members; chips live on item rows, never on headers — `E:941-2000`; `V:666-699`; `components/DeliverChip.tsx:20-23` (29/08/2026).
- **C-42** Item/service/income descriptions print verbatim on the client PDF — client-readable text only; expenses never print — memory `descricao-vai-pro-pdf-do-cliente` (02/10/2026).

### G. Services
- **C-43** Services (labor) are Márcio's: automation fills only expenses and items and never creates/edits/zeroes a service line; the TARGET solver is his own tool — memory `servicos-sao-do-marcio` (26/10/2026); `E:1896-1923`.
- **C-44** `invoice_services.payment_date` means the client paid that service, not that it was executed (no execution state exists) — memory `o-que-falta-mora-na-invoice` (14/09/2026).

### H. Expenses (our cost, the purchase queue)
- **C-45** One date: `payment_date` is both the paid flag and the day money left; empty = UNDATED = not bought yet (a legitimate planning state); `expense_date` is a mirror written equal on every save; exceptions: fixed/APPS/staff recurrences (due date) and the QuickSilver-style scheduled installments (LIVE: 22 rows) — memory `expense-date-vs-paid` (18/08/2026), `receipt-means-paid` (03/09/2026); `E:63-69, 2504, 2829`.
- **C-46** A receipt attached means paid (except quotes, `receipt_proves_payment=false`, cancelled); the payment date is the day money left our hands, never the bank's processing date — `lib/expenseReportNet.server.ts:133-199`; memory `receipt-means-paid` (01/08/2026), `data-pagamento-x-processamento` (08/09/2026).
- **C-47** Enrolling an expense on an invoice marks it PAID today by default; on a quote it stays a forecast; a scanned purchase enters every line paid on the document date — `E:2498-2506, 1274-1275`; `components/PaymentFields.tsx:15` (01/08/2026).
- **C-48** Cost line = `price × (quantity||1) + tax + extra`; `item_discount` is a percentage that only rebuilds MAP and is never subtracted; `price` is the net cost — `lib/financials.ts:21-22`; memory `item-discount-percentual` (07–10/09/2026).
- **C-49** Expense payer: PAID BY ∈ {GZ28US, GZ28BR} is the only choice; PAID TO is hidden, born GZ28US on new rows, filled only when a payment is born on an empty field, never over a stored value; empty stays empty (never fabricated); `source` mirrors `paid_from` — `lib/payerRule.ts:27-81`; `E:720-728, 2304-2308, 2846-2852`; memory `paid-to-so-na-renda` (23/10/2026), `paid-from-to-por-tabela` (11/09/2026); Caso Drácula (25/08/2026).
- **C-50** Who paid is decided by the money: Regions feed = GZ28US; before 10/11/2025 everything was GZ28BR; Rafa/Beto cards = GZ28BR; currency never decides the payer — memory `plaid-regions-paid-from-gz28us` (13/09/2026), `antes-do-regions-tudo-e-br` (17/10/2026), `paid-by-gz28us-so-com-dinheiro-dele` (18/10/2026).
- **C-51** `order_number` is sacred: a column on every purchase table, stamped on every line of a scanned group, carried to inventory/assets on SEND TO, the match key for e-mails/tracking/receipts; a DONATED part never inherits the donor invoice code as an order — memory `order-number-law` (04/08/2026); `E:85-87, 1289, 1424, 1495, 1524`.
- **C-52** Never delete an expense without asking Márcio how (FKs are RESTRICT); the only automatic delete is the unpaid placeholder of the same item on the same invoice replaced by the real purchase, with the whole row in `data_fixes`; if the placeholder is EXPORTED, overwrite it instead of delete+recreate — memory `nunca-apagar-despesa` (27/09/2026), `real-purchase-replaces-placeholder` (10/08 & 18/10/2026), `caso-hhp-384734-goldeneye` (09/09/2026).
- **C-53** Every real purchase carries the vendor's PRINTABLE invoice in `receipt_url` (JSON array) and in the Dropbox invoice folder named `<invoice code> <car> - <curated supplier> <order#>.<ext>`, deduped by content hash, split purchases attached to every invoice sharing the order — memory `printable-invoice-law` (24/08, 03/09, 15/10/2026), `pasta-por-invoice` (08/09/2026); `app/api/ride-folder/route.ts:357-520`.
- **C-54** Supplier names are the curated catalog name (`matchSupplier`), never raw text; a car code or name never becomes a supplier — memory `fornecedor-nome-curado` (04–07/09/2026); `lib/supplierGuard.ts`; `E:2477-2494`.
- **C-55** Delivery status is derived (donated/stock → none; non-PART w/o arrival → none; `cancel_status` → CANCELLED/REFUNDED; unpaid → none; `picked_up` → PICKUP; `delivered_at` → DELIVERED; `tracking_number` → SHIPPED; else BOUGHT); only `picked_up` and `cancel_status` are typed facts; robots write facts never status; a recorded delivery is never undone; blank `nature` travels — `lib/deliverStatus.ts:1-44, 192-216`; `lib/itemNature.ts:54-68`; memory `rastreio-cego-nao-abandona` (19/10/2026).
- **C-56** Crossing-mirror rows (`mirror_src`, `br_expense_id`, `br_payment_id`) are never re-priced, never sent to stock, never silently deleted; 006.N/085.N are read-only history — `E:339-356, 1469-1475, 1879, 2915-2936`; `lib/intercompanyLedger.server.ts:22`.
- **C-57** Expense and item linkage by text (`source_item == expenses.item`) and `export_status` FRESH/EXPORTED/REMOVED govern re-import — `E:1652, 2001-2017`; `packs` §2.2.

### I. Incomes (the client's money)
- **C-58** `paid_at` is the cash event; `payment_date` is the schedule; only `paid_at` counts as received anywhere (financials, reports, daily report, bank link); canonical `paid_at` = noon Orlando (`<date>T12:00:00-04:00`) — memory `income-baixa-e-paid-at` (08/09/2026), `mega-report-so-dinheiro-de-verdade` (06/11/2026); `lib/bankReconcile.server.ts:1318`.
- **C-59** Income has no PAID FROM (the client always pays); RECEIVED BY (`paid_to` ∈ GZ28US, GZ28BR; NOT NULL default GZ28US) is the intercompany signal; method list follows the receiving house; `amount_brl` recorded when received by GZ28BR — memory `income-no-paid-from` (26/08/2026), `paid-to-so-na-renda` (23/10/2026); `components/PaymentFields.tsx:28-40`; onda 9 drop.
- **C-60** `date_label` ARRIVAL/CONCLUSION replaces a date and counts as dated for CLOSED — `E:36-38, 1839, 4415-4419`; commit `f713de54` (21/06/2026).
- **C-61** Receipts of a GZ28BR-received income or of a 006.N carry a kind NF | BR_ENTRY | REGIONS_ENTRY; untyped files never cross; `receipt_url/receipt_kinds` are written only when changed in this edit — `lib/receiptKinds.ts`; `E:415, 1234, 2107-2116` (17/10/2026).
- **C-62** Every income carries its proof (Zelle = Regions e-mail PDF with confirmation number; PIX/TED/NF for BR money); a Stripe payment's proof is the Stripe receipt/event — memory `comprovante-zelle-sempre` (04/10/2026), `zelle-watch` (26/10/2026); `benchmark` §2.5 (INFERENCE for Stripe).
- **C-63** Income `amount` = USD negotiated; `amount_brl` = R$ that really entered; FX derived, never a third stored field — memory `vida-real-usd-e-brl` (17/10/2026).
- **C-64** A US receipt entering via BR = income on the US invoice RECEIVED BY GZ28BR (+ `amount_brl`, NF/BR_ENTRY) and an `intercompany_transfers` row when the wire arrives — memory `recebimento-us-pelo-br-formato-definitivo` (20/10/2026).

### J. Reports (WhatsApp)
- **C-65** Report only money that actually moved, within 3 days, once: reserve `reported_at` before sending (a NO also reserves), one balloon per purchase per car naming invoice + car, PROMISED TO on every report; retroactive bookings are silent; outside writers must bump `updated_at` or the net never sees them — memory `report-net-universal-rule` (01/08, 12/09, 16/09/2026), `report-balloon-law` (10/08/2026); `lib/reportedAt.ts:44-55`; `lib/expenseReportNet.server.ts`.
- **C-66** Quotes never report; creation never reports; the Daily Mega-Report counts only `paid_at` money and excludes quotes — `E:2969`; memory `mega-report-so-dinheiro-de-verdade` (06/11/2026); commit `6252e6c0`.
- **C-67** Every outbound WhatsApp goes through `POST /api/whatsapp` (session or `x-send-key`; signature `Sent by GZ28US Control App®` appended; self-send blocked; mentions derived; every attempt logged to `wa_send_log`); PDFs for Márcio go to the REPORTS group; files sent by WhatsApp must not depend on a public link (base64, ≤3.2 MB) — `app/api/whatsapp/route.ts:7-31, 131-142, 176-207`; memory `claudinha-signature` (02–05/08/2026), `pdf-delivery-us-cel` (07/09/2026), `wa-arquivo-sem-link-publico` (23/10/2026).
- **C-68** No human- or AI-composed message leaves without Márcio's OK to that exact text; robot messages the app already fires keep running; a NEW robot message needs his explicit go-ahead before it is switched on — memory `never-send-unauthorized` (25/07, 18/10, 30/10/2026).
- **C-69** Client e-mails only through `/api/mail/client` closed templates (Graph slot 1 gz28us@hotmail, HTML, red button, PDF attached, PT/EN by `clients.country`); `mailto:` is forbidden — memory `client-email-by-app` (31/07/2026); `app/api/mail/client/route.ts:7-23`.
- **C-70** Delivery honors `clients.preferred_message_method` (WhatsApp, SMS, E-Mail, Instagram, Facebook); never force WhatsApp — `app/clients/[id]/page.tsx:68-75`; `V:316-319`.
- **C-71** Client-facing text is Portuguese for BRAZIL/ANGOLA (language only; CPF/UF/CEP/LGPD keyed on BRAZIL); internal notifications are English; the US app's UI and DB text are English — `lib/utils.ts:103-109`; memory `sidney-penna-pt-invoices` (31/07/2026), `us-app-english-only` (28/07/2026).
- **C-72** Brand positioning in every client text: elite, never cheap, never discount as appeal — memory `gz28-brand-positioning` (02/08/2026).

### K. Packs (quote blueprint)
- **C-73** One shared `packs` table in the US project read by BR and the shop; US offers only `zone='US'`, `status='CLOSED'` packs matching the car; US packs never carry "Importação" lines; quotes/invoices never write back to packs — memory `shared-parts-packs-db` (16/06/2026), `packs-currency-model` (23/07/2026); `N:255-266, 372-377`; commit `bb18dd18` (13/06/2026).
- **C-74** Pack pricing: EXPENSES = cost (`item_discount` = % off MAP), PARTS = MAP FINAL (`base_cost` = MAP, `unit_price = MAP×(1+import_margin)`); margin 0 ≠ items at cost; staff cost live from `estimated_seconds`; FL tax never stored; power target encoded in the name `Z#### <Name> Pack` — memory `packs-currency-model`, `the-table` (05/10/2026); `lib/utils.ts:263-267`.
- **C-75** `shop_locked` packs/parts are read-only for app users (DB triggers); copies are born unlocked; every line carries `scope` BOTH/SHIPPED/IN_HOUSE/APP_ONLY — `MIGRATION_packs_shop_locked.sql`; `lib/packScope.ts`; memory `gz28-shop-locked` (04/10/2026), `shop-packs-na-loja` (07/10/2026).
- **C-76** `part_number` and `export_status` travel pack → quote → invoice expense; pack duties are task-only with `estimated_seconds`; add-ons apply on top via the same function — `N:414-427, 446-463`; memory `pack-staff-duties` (26/08/2026) (Márcio 31/08/2026).
- **C-77** A validated (`validated_by`) shop-locked pack on a real ride invoice seeds BoneStock (no sheet) + pack build + build sheet, idempotently; quotes never seed — `lib/packPerformance.server.ts`; memory `power-table` (18/10/2026).

### L. Numbering, folders, mail
- **C-78** Ride series US/SC/WV share one scale; PO, US.QT, SHP each their own; new = lowest free; pinned never reused; `project_code` unique; invoice code = `<ride code>.<n>`, shopping = `<pad3(client_number)>.<n>`; invoice codes are rewritten on renumber but history tables never are — `lib/rideCodes.ts:21-64`; `N:274-294`; `app/api/rides/renumber/route.ts` header; memory `renumeracao-escala-26set`.
- **C-79** Every real ride invoice has a Dropbox folder `…/<ride code> - <name>/Invoices/<invoice code> - <service|car>/`; names follow the app dynamically; a car folder is identified by code AND name; folder sync is a consequence, never a condition (failures never block a save) — `app/api/ride-folder/route.ts:525-551`; `lib/dropboxRides.server.ts:59-80`; `N:41-66`; memory `pasta-por-invoice`.
- **C-80** Every mailbox has `GZ28US Rides/` and `GZ28BR Rides/` with `<code> - <name>` per car; mail about a car is filed in that car's folder in the box where it arrived; quotes have no mail folder — memory `pasta-de-email-do-carro-sagrada` (05/10, 20/10/2026); `lib/carMailFolder.server.ts`.
- **C-81** A new real ride is born COMPLETE (ride + invoice ONLINE + Dropbox subfolders + e-mail folders + self-form link); quotes create nothing — memory `ride-creation-full-kit` (24/08/2026), `ride-folder-sync` (24/08/2026).

### M. Intercompany
- **C-82** The BR↔US account is computed from PAID BY / RECEIVED BY + `intercompany_transfers`; 006.N/085.N are history; the crossing engine must never write and `/api/crossing` must not be called by new flows — memory `conta-corrente-br-us-calculada` (23/10/2026), `fluxo-br-us-modelo-23out`; `lib/crossing.server.ts:2200`.
- **C-83** Any company may pay for any company, but a cross-company movement must carry `paid_from`/`paid_to`; GZ28BR money never matches Regions — memory `paid-to-settles-intercompany-debt` (24/08/2026); blVersion 1.7.0.

### N. Security and public pages
- **C-84** Public pages are allow-listed in `AuthGate.PUBLIC_PREFIXES` (both apps), render without Header or any outbound link, speak the client's language, and reach data only through scoped SECURITY DEFINER RPCs or service-key server routes; anon never gets table access to internal data; an empty anon result proves nothing — `components/AuthGate.tsx:7-11, 85-88`; `supabase/rls_phase1.sql:43-45, 150-182`; memory `rls-pending` (13/07/2026), `us-rls-empty-not-absent` (11/09/2026), `client-self-form` (18/06/2026).
- **C-85** A public page never authors message text, phone, chat id or group; the server rebuilds the message from the saved row and only for a recent, recorded change — `app/api/self-notify/route.ts:5-28, 149, 299-308` (audit 11/09/2026).
- **C-86** Every API route imports the single gate, fails closed, takes secrets only in headers; new env vars are registered in `/api/health/env` — `lib/apiAuth.server.ts:1-20, 27-32`; memory `troca-de-chaves-11set` (14/09/2026).
- **C-87** Any RLS/anon change is checked against the BR app and the shop first (they read the US project as anon: `parts_database`, `dyno_pulls`, `ride_build_sheets`, `shop_config` keys) — `MIGRATION_rls_anon_exposure_11set.sql:18-31`.
- **C-88** "Paid" comes only from the payment provider's webhook (signature verified on the raw body, 500 to force retry, idempotent by business key), never from a browser redirect; a paid order never leaves a half-written invoice — `SHOP:app/api/stripe-webhook/route.ts:11-14, 57-66, 120-123, 245`; `SHOP:lib/opsWrite.ts:391-436`; RECADOS 08/10/2026.
- **C-89** Stripe-facing URLs on this domain use `www.gz28us.com` (apex 308-redirects; Stripe treats 3xx as failure); the live shop endpoint `/shop/api/stripe-webhook` and the root `/` = shop never move — `SHOP:app/api/stripe-webhook/route.ts:6-9`; memory `shop-na-raiz` (08/10/2026).
- **C-90** Stripe fees on quote deposits are absorbed (no gross-up); nobody at GZ28 types card data; Stripe Tax stays off for law-computed amounts; payout to Regions in 1–2 business days — memory `redesign-quote-invoice-06nov` (06/11/2026), `stripe-cobrar-cartao` (26/10/2026).

### O. Framework and house conventions
- **C-91** basePath `/ca`: raw `<a>`, own-API `fetch`, `<img>` and outbound links carry it; `<Link>`/router do not — `next.config.ts:4-7`; `lib/utils.ts:1-3`.
- **C-92** Times shown are Orlando (US) / Brasília (BR), computed never estimated; date-only columns are `YYYY-MM-DD` strings parsed with `+'T00:00:00'`; money via `formatUSD` (snaps −0.00) — AGENTS.md "O RELÓGIO"; memory `show-times-in-local-zone` (19/08/2026); `lib/utils.ts:9-17`.
- **C-93** Lists: `TITLE (count)` + search + green ADD on the top line, chips below; order by last activity (ms, children included) with "Last activity: … (Orlando)" — memory `list-page-search-layout`, `lista-ultima-atividade-primeiro` (01/10/2026); `lib/ultimaAtividade.ts`.
- **C-94** Universal payment block PAYMENT METHOD → PAID BY/RECEIVED BY → PAID (+date) decided by `PAYER_RULE[table]`; one SEND TO chooser; dark house look (bg-black, gray-900 cards, green/blue/red/gray button semantics, pill badges) — `components/PaymentFields.tsx:6-18`; `components/SendToDialog.tsx:5-11`; `framework-conventions` §7.
- **C-95** Reads that may exceed 1,000 rows must page (`lib/allRows.ts`); PostgREST truncates silently — finVersion 0.14.0; memory `flow-br-teto-1000-linhas` (25/10/2026).
- **C-96** HOME (CURRENT) and PAST layouts are approved and settled — memory `home-flow-pages-approved`.
- **C-97** Do not enable `cacheComponents`/PPR (74 `useParams` sites without Suspense); `next lint` no longer runs in build — run `tsc --noEmit` and `npm run lint` before pushing — `framework-conventions` §10.3, §14.
- **C-98** Every schema change is a migration + rollback run via `scripts/roda-sql.mjs`, shown inline, trailed in `data_fixes`; a new table carries the three GRANTs — memory `claude-runs-migrations`, `tabela-nova-precisa-grant` (30/10/2026), `show-sql-inline`.
- **C-99** Every change ships to both apps (BR ported surgically, keeping its dual-currency fields); only the App Development 2 session changes code/schema/deploy; `git add` by explicit path; never commit while another commit runs — memory `deploy-preference` (16/06, 21/06, 07/09/2026), `br-brl-divergence`, `mudanca-no-app-vai-pro-app-development` (25/10/2026), `git-add-nunca-tudo` (07/09/2026).
- **C-100** Ask with 1% doubt, one question at a time; the app (not the assistant) owns automation — every process must run with the PC closed — memory `ask-when-in-doubt`, `uma-pergunta-por-vez`, `auto-by-app-rule` (27/07/2026), `claudinha-is-an-interface` (24/08/2026).

### P. Legal (benchmark, for the client-facing document)
- **C-101** Florida Motor Vehicle Repair Act: a written estimate before work over US$150 with items (a)–(n) and the signed disclosure block (§559.905); extra charges beyond max($10, 10%) and never > $50 need prompt notice and the customer's oral or written authorization, recorded (§559.909; FDACS); the completion invoice carries date, odometer, itemized labor/parts, used/rebuilt statement, guarantee and the FDACS registration number (§559.911); records kept 12 months (§559.915); copies of anything the customer signed (§559.920(12)) — `benchmark` §4.1; RECADOS 08/10/2026 (FDACS registration pending; legal name GZ28 V8 SPEEDSHOP USA LLC).
- **C-102** An electronic signature binds only to the exact record it is logically associated with, with intent; the record must remain retainable/reproducible; attribution must be provable (security procedure + audit trail); terms must sit adjacent to the approve button with an affirmative act — 15 U.S.C. §7001(a),(d),(e), §7006(5); Fla. Stat. §668.50(2),(7),(8),(9),(12); Meyer v. Uber; Nguyen v. Barnes & Noble (`benchmark` §2).
- **C-103** Consumer "in writing" delivered electronically needs affirmative consent and a withdrawal path (15 U.S.C. §7001(c)) — INFERENCE that it applies; counsel to confirm (`benchmark` §2.1).

### Q. Conflicts and supersessions (keep the latest)
FL tax by law (26/10) supersedes tax-exclusive quotes (06/2026) · calculated ledger (23/10) supersedes 006.N/085.N mirrors (23/08→13/09) · no PAID TO on expenses (23/10) supersedes required-hidden (11/09) · no PAID FROM on incomes (26/08) · CLIENT payer removed in US (11/09), kept in BR · absorb Stripe fees (06/11) supersedes gross-up (26/10) · one expense date (18/08) supersedes two dates (21/06) · `expected_conclusion_date` as promise (20/08) supersedes `delivery_date` (10/07; memory note not updated) · lowest-free numbering (04/07) supersedes max+1 (12/06) · derived delivery status (30/08) supersedes `deliver_status` column · STREAM as a view (30/08) supersedes `part_streams` · all mailboxes carry both roots (20/10) supersedes per-company folders (05/10). Full table in `constitution` §20 and `history` §6 ("do not reintroduce").

---

## 4. PAIN POINTS ranked by impact (with evidence)

### Tier 1 — structural, blocks the target
1. **Conversion is a side effect of typing a date inside a 4,802-line browser component, non-transactional, and duplicated against the sanctioned route.** `backupQuoteBeforeConversion` + `migrateQuoteToProject` + `invoices.update` + `seed-pack` + children + deletes + crossing run as ~14 sequential steps with alert-and-return; steps 1–3 stay committed when step 4 fails; the editor never calls `/api/rides/renumber` (R8) — `E:2689-2965, 2716-2737`; `editor-B` §2; `data-model` §10.4.
2. **No client surface exists for the quote**: no sent/viewed/accepted/signed/paid state anywhere in the 80 tables; the PDF has wet-ink lines; acceptance is a WhatsApp reply; deposits are typed by hand or made with manual Stripe Payment Links that the shop webhook ignores by design — `view-page` §9.7; `data-model` §9; `SHOP:app/api/stripe-webhook/route.ts:83`; memory `stripe-cobrar-cartao`.
3. **A quote cannot hold money and a quote cannot be the thing the client pays**: every money consumer gates on `is_quote=false` (financials, HOME, FUTURE, daily report, report net, close score, Bank Link, ledger) — so the first Stripe payment must land on an invoice that exists before checkout, or the deposit is invisible to every statement and reconciliation — `consumers` §1.2, §8.2; C-07.
4. **Two write regimes in one screen**: adds/removes/reorder/margin/labor/header wait for SAVE while row edits, PAID toggles, duties, SEND TO, FROM STOCK (inventory decremented before SAVE), SHOW PART NUMBERS write immediately; Cancel is `history.back()`; the REMOVE modal says "cannot be undone" for a staged delete — `E:529-532, 1048, 2027-2049, 2261-2363, 2402-2440, 4781`; `editor-C` §6.
5. **The client-facing total has four names and two semantics** (`balance` paid−grand; `pendingBalance` Σ listed−grand; DUE by CLIENTS Σ unpaid listed; open balance max(0, grand−paid)), and FINAL MARKUP has three formulas across screens while the stated law is a fourth — `E:1828-1863`; `app/invoices/page.tsx:114-126`; `L:211-213`; `lib/laborCost.ts:7-8`; `money-engine` §5–6.
6. **Status is five vocabularies and the stored one lies**: `live_status` with a vestigial twin; derived REPORT READY copied in 6 pages; 6-, 5- and 2-rung ladders; CLOSED silently demoted on save; new invoices (NEW form, shop) born INCOMPLETE against the 24/08 law and therefore invisible to HOME/FUTURE/REPORTS; two quotes REALTIME against the 19/06 law — LIVE; `N:308-316`; `SHOP:lib/opsWrite.ts:521-525`; `consumers` §2.1.

### Tier 2 — correctness and money
7. **Totals/cost/badge math hand-copied**: `expLine` in ≥30 files (daily report sums `price` only), `whoPaid` ×4 (financials is `'use client'`), REPORT READY ×6, badge helpers ×4, FL-tax status resolution ×9 around one pure function; `lib/financials.invoiceTotals` unused by every list — `money-engine` §2.1, §16; `consumers` §6.2; `app/api/cron/daily-report/route.ts:77-78`.
8. **Clock-law violations in the money path**: `todayStr()` UTC in the editor (`E:267`), `isTodayOrPast`/`formatTsDate` browser-local, four `paid_at` shapes in the DB (LIVE 141/32/21/96), DFC slices UTC days, hard-coded UTC-4 in duty hours/daily report/trim (wrong since 01/11/2026 EST) — `editor-A` D11; `money-engine` §14; `duties-streams` §9.5.
9. **Dropped guarantees the robots rely on are not enforced by the schema**: no CHECK on `live_status`, `origin`, `paid_to`, `source`, `export_status`, `priority` (LIVE off-vocabulary values exist); `client_number` not unique; `invoice_code` unique only with `client_id` (NULL rows escape); numbering is a browser read-then-insert race; lowest-free reuse lets a new invoice adopt a deleted invoice's orphan Dropbox folder and receipts — `data-model` §3.2-3.3; `lists-and-new` §2.2 (INFERENCE on adoption).
10. **Deletes are broken by design, both ways**: list REMOVE is a bare `invoices.delete()` that fails with a raw FK error whenever expenses exist, and succeeds leaving Dropbox/mail folders and `quote_backups` behind; the editor's hard deletes (REMOVE, SEND TO full quantity, placeholder replacement) write no `data_fixes` trail — `L:226-231`; `app/invoices/page.tsx:135-140`; `editor-B` §2 (grep 0 `data_fixes`).
11. **Margin re-pricer rewrites every item's `unit_price` on every SAVE; nothing freezes a quote after the client saw it** (the presented-price law exists only as discipline) — `E:1870-1889, 2769-2772`; memory `presented-price-law`.
12. **Shopping (no-ride) documents are invisible in every global list** and `DocPicker` forces a ride; `/quotes` shows no amount, client, or activity — `lists-and-new` P3, P8, P12.
13. **Frozen crossing engine still wired into SAVE and every PAID toggle** (full two-database plan, "TRAVADA" alert that means nothing), `/api/br-mirror/paid` round-trips to `encerrado` — `E:2245-2259, 2947-2960`; `lib/crossing.server.ts:2134, 2200`.
14. **Two promotion numbering algorithms + a third in the shop + max+1 in the crossing**; quote-client numbering is max+1 while quote-ride is lowest-free — `E:2612-2616, 2629-2633`; `SHOP:lib/opsWrite.ts:370-377`.

### Tier 3 — documents and messaging
15. **The client PDF is a raster screenshot** uploaded to a PUBLIC bucket on every send (never deleted, never archived in Dropbox, never recorded in any table), the only raster PDF in the app, contradicting the 23/10 no-public-link law; `/api/mail/client` only accepts that public prefix — `V:253-329`; `app/api/mail/client/route.ts:50,65`; `messaging-pdf-files` §3, §8.
16. **PROMISED TO is dead in four readers** (view caption, self-notify, duties page, `duties_self_load` RPC) since the 20/08 migration cleared `delivery_date` on open invoices; the memory note still describes the old field — R2.
17. **Captions English-only for Portuguese clients; quote paper has no issue/validity date, prints `Hiring: —`; `Sub-Total` = `Items Total`; LABOR_ONLY/NO_SALE print no tax statement; ORIGINAL QUOTE modal uses the legacy tax formula; company footer address undecided (11320 Unit 2A vs 11352 Shop 2A)** — `view-page` §15; memory `gz28us-address` ("perguntar antes de mexer").
18. **17 call sites append a legacy footer the route strips; `wa_send_log` has no document identity; REMIND auto-sends and uses `mailto:`/`sms:`** — `messaging-pdf-files` §8; `E:2186, 2192`.

### Tier 4 — UX and performance
19. 82 `alert()`/`confirm()` in the editor (492 app-wide), several in Portuguese or carrying raw JSON/DDL; 13 modals without Escape/backdrop close; no `<form>`, no Enter, 16 three-select date pickers, two pickers for the same field; CLOSED attempt that fails jumps to INCOMPLETE; EXPENSES rendered above ITEMS/SERVICES; zero responsive classes — `editor-C` §4, §7–8, §11.
20. ~15 round trips on open (parts_database ×3, 2,000 duty descriptions), SAVE-stay reloads everything; lists N+1 (5 queries per invoice); `/invoices` unpaged bulk `.in()` reads at the 1,000-row cliff — `editor-A` §6; `lists-and-new` P17.
21. Pack UX: no "apply pack" inside the editor; IMPORT FROM DATABASE closes per ADD; `applyPack` copies SHIPPED and IN_HOUSE lines together (two $1,500 tuning lines, "50% Down" with "FREE SHIPPING"); `pack_id` NULL on all invoices — `packs` §8.15, §2.3.
22. Dead/vestigial: `feed_status`, `florida_taxes` (still written by the shop), `client_hiring_date` as a second conversion date, `expense_date`/`source` mirrors, `fl_tax_refund_date`, `mirror_expense_id`, `part_id`, `invoice_items.total`, `PAID_VIA_OPTIONS`, `part_streams`, 410 stub routes, `supplierInfo`, `DUTY_PRIORITY_RANK` local copies, `void rName`, `isTodayOrPast` — `editor-A` §12; `consumers` §6.1.

---

## 5. REUSE (keep as-is or lift verbatim) vs REPLACE

### 5.1 Reuse — pure rulers and server routes already right
| Keep | Why |
|---|---|
| `lib/flTax.ts` (`flTaxStatus`, `flTaxOnLines`, `invoiceMoney`, `invoiceMoneyFor`, labels) | the single legal totals engine, pure, 12 callers |
| `lib/estorno.ts` (`foraDoDinheiro`, `soOQueConta`, `valorDespesa`, `valorItem`) | pure refund rule |
| `lib/payerRule.ts` + `components/PaymentFields.tsx` (`PAYER_RULE`, `hiddenPayers`, `fillHiddenPayers`, `methodsFor`, `PaidFromSelect`) | the payer/receiver vocabulary |
| `lib/deliverStatus.ts` + `components/DeliverChip.tsx`; `lib/itemNature.ts` | derived delivery cascade, compile-time row contract |
| `lib/rideCodes.ts`; `POST /api/rides/renumber` | the only safe code allocation/promotion path |
| `lib/reportedAt.ts` / `lib/reportMark.ts` + `/api/report-net/mute`; `lib/expenseReportNet.server.ts` | reserve-before-send contract and the 5-minute net |
| `lib/receiptKinds.ts`, `lib/laborCost.ts`, `lib/packScope.ts`, `lib/ultimaAtividade.ts`, `lib/allRows.ts`, `lib/flowHorizon.ts`, `lib/tableRenames.ts`, `lib/paidNoBank.ts::orlandoDay`, `lib/utils.ts` (formatters, `clientCode`, `pad3`, `toWaNumber`, `clientSpeaksPortuguese`, `CAR_DESTINY`, duty helpers, `packTargetBhp`) | small, correct, shared |
| `lib/financials.ts` semantics (`expLine`, `qtyLine`, `whoPaid`, `invoiceTotals`, `recognitionDate`, `buildCashEvents`, `unpaidTotals`) | re-host in a neutral (non-`'use client'`) module; characterization baseline |
| `lib/supplierMatch.ts`, `lib/supplierGuard.ts`, `lib/carRegistry.ts`, `lib/partsDb.ts` (`enrollParts`, `normPN`), `lib/scanFile.ts`, `/api/scan-receipt` | supplier curation, catalog laws, scan prompts/prorating |
| `/api/whatsapp` (+ `lib/waSend.server.ts`, `waMentions`, `waSelfGuard`, the mirror), `/api/mail/client` (add kinds, never a relay), `/api/self-notify` (pattern), `lib/apiAuth.server.ts` + `lib/sessionHeaders.ts`, `components/AuthGate.tsx` (extend prefixes) | the house egress and gates |
| `/api/ride-folder` (create · rename · invoice-folder · invoice-receipts), `lib/dropboxRides.server.ts`, `lib/carMailFolder.server.ts`, `lib/rideMailFolders.server.ts` + crons | folder identity and receipt discipline |
| `lib/packPerformance.server.ts` + `/api/performance/seed-pack` | idempotent, trailed; only its pack-lookup gate needs the new link |
| `lib/bankReconcile.server.ts` (`writeMatch`, `stampPayers`, `paidAtFor`), `lib/intercompanyLedger.server.ts`, `lib/zelleWatch.server.ts` income shape (minus its delete) | money-truth paths a Stripe income must coexist with |
| `lib/dutyRelease.server.ts`, `lib/staffDutyWatch.server.ts`, `lib/itemTracking.server.ts`, `lib/mailToItem.server.ts`, `lib/storeCheck.server.ts`, `lib/receiptHunt.server.ts`, `/api/duty-events`, RPCs `duties_self_load`/`duty_self_update`/`duty_take` | execution robots keyed on the same tables |
| `lib/statementPdf.ts` (vector jsPDF + autotable recipe); the view's `T` PT/EN label map and print section order; `Templates/*.xlsx` client-page/internal-control split | base for a real document renderer |
| `components/DocPicker.tsx`, `components/SendToDialog.tsx`, `components/DatePicker.tsx` (only if native date input is rejected), `components/PackBits.tsx`, `lib/carGroups.ts`, `applyPack` mapping rules (`N:371-464`, as semantics), `duplicateQuote` column whitelist (`N:157-201`) | approved conventions and insertable-column knowledge |
| SHOP: `app/api/checkout/route.ts:134-164` session skeleton, `app/api/stripe-webhook/route.ts` (raw body, 400/503/500/200, status-gated PATCH, ACH states, `latest_charge`, `after()`), `lib/opsWrite.ts` (`today()` Orlando, `insere`, `desfazInvoiceNova`, deposit + balance income shape), `SHOP:lib/packs.ts` (scope-aware pack pricing) | the reference Stripe discipline and the only correct per-mode pack pricing |
| `scripts/agora.mjs`, `scripts/roda-sql.mjs`, the `data_fixes` trail pattern, the SECURITY DEFINER RPC recipe | house tooling |

### 5.2 Replace (rebuild on the rulers above)
- The editor page (`E`) as a component: its *rules* become server specifications (groupStock FIFO, FRESH_DELIVERY contract, `receiptUrlLike/kindsFor`, target-labor solver, `importIntuitiveParts` pricing, kit-aware reorder, paid-first/mode-date group rules, conversion sequence, mirror-delete guard, scan confirm, caption builders, CLOSED gates), the component itself is retired.
- The view page's screen/paper double JSX, the html2canvas raster PDF and the public `invoice-pdfs` contract (and the `/api/mail/client invoice-pdf` prefix check that depends on it).
- The NEW form + DocPicker as the only creation path (quote without a ride, pack inside the editor, no landing in a 4,800-line page).
- The three list pages' private money/badge math and `updated_at` ordering; the ride page's OPEN/CLOSED-by-date vocabulary.
- The editor's private `migrateQuoteToProject` (use the renumber route), the crossing hooks (`sincronizarTravessia`, `mirrorUsInvoicePaidToBR`, `linhasDaTravessia` confirms), the `feed_status` mirror, the `client_hiring_date` second trigger (decision Q-05), `expense_date`/`source` mirrors (after a reader audit), `invoice_items.base_cost` (BR precedent; Q-24), REMIND's `mailto:`/`sms:`, the inline SEND chooser (adopt or retire `SendToDialog`), `DatePicker`'s three selects, native `alert/confirm`.
- `quote_backups` as "version at conversion" → generalize to immutable revisions at send/sign (Q-13).
- Browser-side numbering → DB-side allocator or global uniqueness (Q-21).

---

## 6. OPEN QUESTIONS for Márcio (one at a time — each yes/no or A/B with the recommended default)

Lifecycle and approval
- **Q-01** May quotes get their own state machine (DRAFT → SENT → VIEWED → APPROVED/SIGNED → DEPOSIT CLEARING → DEPOSIT RECEIVED → PROJECT) stored in orthogonal columns/events, leaving `live_status` untouched for invoices and migrating today's 20 CLOSED / 13 INCOMPLETE / 2 REALTIME quotes? **Default: yes** (keeps the 10+ `live_status` filter sites intact; C-17; LIVE).
- **Q-02** Should CLOSED additionally require `paid_at` on every income (cash), instead of only a date or milestone label? **Default: no** — keep "CLOSED is about dates" (25/08) and show "received vs scheduled" explicitly on the screen instead.
- **Q-03** Is the client's approval (e-sign or approve button) the conversion event, setting `hiring_date` = approval day and birthing the project before the deposit is charged — A — or does the project wait for the deposit to clear — B? **Default: A** (every money consumer needs `is_quote=false` before the first income exists; ACH clears in up to 4 business days; the deposit state is shown separately).
- **Q-04** May the approval record be a new fact table (`invoice_approvals`: revision hash, signer name, channel, IP, user agent, consent text version, timestamps, Stripe ids) with `hiring_date` derived from it, rather than new columns on `invoices`? **Default: yes** (no existing column serves this; C-05 satisfied).
- **Q-05** Unify the conversion trigger into one field (`hiring_date`) and retire `client_hiring_date`, showing REQUEST DATE as `created_at`? **Default: yes** (duplicate-field law; LIVE 62 rows to migrate).
- **Q-06** Quote expiry: 30 days by default, expiry hides the pay button and requires a new revision? **Default: yes, 30 days** (`benchmark` §3.2).
- **Q-07** Confirm that PROMISED TO = `expected_conclusion_date` (the 20/08 migration) and that the four readers still using `delivery_date` plus the memory note are to be fixed? **Default: yes** (R2; LIVE 0 open invoices with delivery_date).

Money and payments
- **Q-08** First installment on a quote: fixed 50% of the grand total (as the shop) — A — or an amount/percent set per quote with a visible schedule of N dated installments — B? **Default: B with 50% pre-filled** (Zapata 50%; QuickSilver 5×; Sidney monthly; C-27).
- **Q-09** Deposit rails: offer ACH first (US$5 fee, T+4, 60-day dispute window) with card as the fast alternative (US$1,232.80 on US$42,500)? **Default: yes**, and ordering of parts starts only at DEPOSIT RECEIVED (`async_payment_succeeded`), never at authorization.
- **Q-10** FINAL MARKUP basis: grand total − expenses − staff cost (the stated law) everywhere, including lists? **Default: yes** (one formula, one module).
- **Q-11** Should a Stripe deposit be recorded as GROSS income (`amount` = contract value, `paid_at` = client's payment day, `source` STRIPE, `paid_to` GZ28US) plus a separate fee line so the net Regions payout reconciles in Bank Link? **Default: yes**, fee as an `invoice_expenses` line (`nature` MONEY, supplier Stripe, `order_number` = Stripe balance_transaction id) — the alternative (BANK fixed cost) hides the fee from the car's markup.
- **Q-12** Keep ADD PENDING BALANCE once installments are first-class rows? **Default: no** — the schedule always sums to the grand total by construction, so DUE by CLIENTS and open balance coincide.
- **Q-13** Should every SEND produce an immutable revision (JSON + rendered PDF + SHA-256) with the signature bound to one revision, replacing the single `quote_backups` snapshot at conversion? **Default: yes** (C-16; §559.920(6),(12); `benchmark` §4.4).
- **Q-14** After approval, which fields lock: items, services, discount, tax status, margin — all, with changes only through a signed change order (revision n+1)? **Default: all** (C-16; Shopmonkey/Jobber pattern).

Tax
- **Q-15** Confirm the assumptions taken on 26/10 without asking: US client with blank state = Florida; global discount before tax; "exempt" wording on the PDF? **Default: confirm**, and require a state (or `title_scope`) before a quote can be approved online (LIVE: 26 rides without `title_scope`, 4 USA clients with blank state).
- **Q-16** Freeze the fiscal status (`title_scope`/address) on the approved revision — "emission" = approval? **Default: yes**.

Documents, messaging, legal
- **Q-17** Which address goes on client documents: legal 11352 Space Blvd Shop 2A — A — or shipping 11320 Space Blvd Unit 2A — B? **Default: A for the legal document, B shown as "ship parts to"**; memory `gz28us-address` says ask first.
- **Q-18** Should the client-facing quote be the Florida written estimate (§559.905 items + disclosure block + e-records consent line), so e-sign = the statutory signature? **Default: yes** (counsel to confirm wording).
- **Q-19** May the app send the three new robot messages without per-message OK: quote link to the client, "approved/signed" to REPORTS, "deposit received" to the client (receipt + PDF) and to REPORTS? **Default: yes for all three**, texts approved once in the spec (C-68).
- **Q-20** Keep SMS/Instagram/Facebook link paths for quotes? **Default: keep only as a copy of the private link** (no public PDF URL).

Data model and numbering
- **Q-21** Numbering: move invoice/ride number allocation to a DB-side function (advisory lock) and make `invoice_code` globally unique after cleaning NULL-client rows and the bucket? **Default: yes** (webhook-time allocation needs it; `history` Q6).
- **Q-22** Store items ↔ expenses by id (`invoice_items.source_expense_id`) while keeping `source_item` text for robots during a dual-read period? **Default: yes**.
- **Q-23** Add a service execution status (done/pending) to `invoice_services`? **Default: yes** (memory `o-que-falta-mora-na-invoice`).
- **Q-24** Drop `feed_status`, `fl_tax_refund_date`, `invoice_items.total`, `mirror_expense_id` ×2, `client_hiring_date` (after Q-05), `invoice_items.base_cost` (BR precedent), with reader audits and the house migration+rollback? **Default: yes**, in the redesign migration, after removing the selects (`consumers` §8.7).
- **Q-25** Quote cars: keep `US.QT.###` with renumber on promotion — A — or attach quotes to a provisional ride that keeps its number — B? **Default: A** (26 live quote cars, folder rule, the renumber route already handles it).
- **Q-26** Shopping (no-ride) quotes: do they get approval/payment too, and a global list? **Default: yes** (73 shopping docs are invisible today).

Platform and scope
- **Q-27** Own Stripe webhook endpoint under `www.gz28us.com/ca/api/stripe/webhook` with its own secret on the same account (the shop endpoint keeps ignoring foreign sessions)? **Default: yes**.
- **Q-28** Public quote page in the Control App zone (`/ca/quotes/self/<token>`), Server Component, token-gated (not the invoice UUID), private PDF served through a token-checked route? **Default: yes** (`framework-conventions` §12.1; `client-surfaces` §8).
- **Q-29** US first; BR receives the shared core later with a `TenantConfig` (BRL, NF, PIX) and its own payment strategy — not blocked on BR parity? **Default: yes** (memory `roadmap-us-first-br-cure`; BR shop closing 27/10).
- **Q-30** Replace the editor's hard deletes (REMOVE, SEND TO full quantity) with CANCEL/REFUND stamps and `data_fixes` trails? **Default: yes** (C-52).

---

## 7. GAP ANALYSIS for the target — client view · approve/e-sign · Stripe 1st installment · auto project birth

### 7.1 Client VIEWS the quote
- **Exists**: the full document model (items/services/notes/totals by law), the PT/EN label map, the client's `preferred_message_method`, `/api/mail/client` templated e-mails, the public-page pattern (`PUBLIC_PREFIXES` + SECURITY DEFINER RPCs + `self-notify`), the shop's Server-Component-friendly zone layout.
- **Missing**: any client-readable projection of a quote (no RPC/route returns an invoice to a link holder; `duties_self_load` is the only invoice-touching anon RPC and exposes no pricing); a capability token (today the row UUID is the credential and the invoice UUID already leaks in public PDF URLs); sent/viewed events; a stable private URL (today each send uploads a new public PDF); a vector, archived PDF; issue/validity dates; `generateMetadata`/`noindex`; branded `error.tsx`/`not-found.tsx`.
- **Conflicts**: RLS phase 1 forbids anon table reads (C-84) → a `server-only` DAL with the service key returning a minimal DTO (never `base_cost`, expenses, markup, other invoices, `grade`); the public bucket contradicts the 23/10 no-public-link law (C-67); captions are English-only for PT clients (C-71); 30 clients have no e-mail and 8 no method (LIVE) → delivery falls back to WhatsApp (C-70).

### 7.2 Client APPROVES / E-SIGNS
- **Exists**: the paper signature lines (`V:770-773`), `quote_backups` snapshot (at conversion only), Stripe's ToS checkbox (`consent_collection`), the FDACS forms drafted in Downloads (RECADOS 08/10), the owner's explicit wish ("approval button, or check, or sign", memory `redesign-quote-invoice-06nov`).
- **Missing**: approval/signature/consent record (no table or column in 80 tables); immutable revision + hash per send; authorization method as data (client self-approval vs shop-recorded phone/in-person); change-order flow for scope changes after approval (§559.909 band); expiry; the §559.905 elements (estimate time, tag, rate basis, payment method, alternate authorizer, guarantee, parts-return choice, storage charge, disclosure block) and the FDACS number on the invoice (registration itself pending); e-records consent line.
- **Conflicts**: "no duplicate fields" (C-05) vs the need for new state → new table, not twins of `hiring_date`; "never send without OK" (C-68) vs automatic confirmations → approve the texts once (Q-19); `presented-price-law` and "don't touch ITEMS" (C-16) vs the margin re-pricer that rewrites every item on SAVE → lock the approved revision (Q-14); the BR print already has a wet-ink "Nome Legível" line — the e-sign replaces it.

### 7.3 Client PAYS the 1st installment (Stripe)
- **Exists**: the live Stripe account (payouts to Regions, Stripe Tax registered), the shop's Checkout Session creator and webhook skeleton (ACH-aware, status-gated, 500-retry, `after()` WhatsApp), the income row shape (paid row with `paid_at` + undated balance row), `paid_to GZ28US`, `source` already carrying `STRIPE` (LIVE 2), `reported_at` reservation, Bank Link's `paidAtFor` noon-Orlando convention, DELAYED alerts on scheduled incomes, the fee table and gross-up knowledge.
- **Missing**: any Stripe code in the Control App (no `stripe` dependency), a Control App webhook endpoint/secret, an event-id dedupe table, `success_url` with `{CHECKOUT_SESSION_ID}` + landing-page fulfilment, a payment-plan entity (installment k of n with dates), a home for the absorbed fee, a Stripe Customer/saved method for later installments (consent text), a "deposit clearing vs received" state, a receipt e-mail kind, reconciliation of gross income vs net payout.
- **Conflicts**: `automatic_tax` would double-tax a law-computed amount (C-36) → charge the law amount as one line, Stripe Tax off; quotes cannot carry incomes (C-07) → the invoice must exist before the session is created (Q-03); Bank Link matches to the cent → gross income + fee line (Q-11); Zelle watch's delete-and-insert anti-pattern must not be copied (update the scheduled row by id so `delayed_alert_sent_at` and any approval reference survive); the report net will balloon a webhook-written `paid_at` unless `reported_at` is claimed deliberately and `updated_at` bumped (C-65); the shop endpoint ignores sessions without `metadata.order_id` → separate endpoint (Q-27); ACH disputes are final for 60 days → policy on when parts are ordered (Q-09).

### 7.4 The PROJECT is born automatically
- **Exists**: the full conversion recipe (snapshot → promote ride/client → re-code invoices → folders/receipts → `is_quote=false` + REALTIME → performance seed), the sanctioned renumber route that pre-checks and now creates folders, `ride-creation-full-kit` (Dropbox subfolders + e-mail folders), the 24/08 "born ONLINE" law, duties and placeholder expenses that persist across the flip, the idempotent `createShopInvoice` + compensation pattern.
- **Missing**: a server-side, idempotent "birth" transaction callable from a webhook/approval route (today the recipe lives only inside the editor's SAVE and is non-atomic; the editor's private copy diverges from the route); `live_status='REALTIME'` at birth (NEW form and shop omit it); `pack_id` populated (NULL everywhere, so the performance seed's primary path never runs); activation of quote duties on the mechanics' phones (today only implicit); the Daily Mega-Report "new" entry; a `title_scope` for FL tax at birth (26 rides NULL); race-safe numbering at webhook time.
- **Conflicts**: two promotion paths (editor vs route) → keep the route (C-12); quote has no folder → folder must be created at birth, not renamed (RECADOS 20/10 already fixed the route); "creation emits no report" (C-20) vs the natural wish to announce a signed deal → only the deposit's INCOME balloon is money; "approved" is an informational notice needing Q-19; BR has no Stripe and different numbering → tenant strategy (Q-29).

### 7.5 Cross-cutting gaps
- A neutral money module (server-importable) so the webhook, the public page and the lists compute the same total — `lib/financials.ts` is `'use client'` (Tier-2 pain 7).
- One status model with events (sent/viewed/approved/deposit) orthogonal to `live_status`, and the four stale PROMISED TO readers fixed.
- Schema hygiene before new writers arrive: CHECK constraints on `live_status/origin/paid_to/source/export_status/priority`, the 1,106 `paid_to`-less expenses, four `paid_at` shapes, `client_number` uniqueness.
- Both apps: the shared core + `TenantConfig` plan (`br-parity` §11) so the US redesign can be vendored to BR without rewriting its BRL/NF/PIX logic; the BR table rename decision (Q in `br-parity`).

---

## Appendix A — live probe (read-only, 06/11/2026 ~04:30 Orlando; `probe-invoices.mjs`)

```
TOTAL invoices: 211
is_quote x live_status: quote=false|CLOSED 35 · INCOMPLETE 14 · REALTIME 127 ; quote=true|CLOSED 20 · INCOMPLETE 13 · REALTIME 2
origin: BUCKET 1 · GZ28BR 1 (stray) · PROJECT 209 ; SHOP 0 ; shop_order_id 0 ; shop_wishlist_id 0
feed_status: INCOMPLETE 44 · REAL_TIME 167
ride_id null (shopping docs): 73 · client_id null: 2 · codes containing .QT.: 30 (all is_quote)
quotes with hiring_date: 2 · non-quotes without hiring_date: 11 · client_hiring_date set: 62
expected_conclusion_date set: 10 · delivery_date set & conclusion null: 0
pack_id set: 0 · target_grand_total set: 27 · import_margin 0 on 177 (others 6.5–43.1)
fl_tax_override: 0 · florida_taxes non-null 137, non-zero 19 · global_discount > 0: 4
TOTAL incomes: 325 · on quotes: 0 · paid_at set 290 · scheduled only 9 · undated unpaid 26
date_label: CONCLUSION 2 · paid_to: GZ28BR 104 / GZ28US 221
source: PIX 78 · ZELLE 57 · WIRE 53 · CASH 52 · ACH 40 · NULL 31 · TED 6 · CHECK 5 · STRIPE 2 · DEPOSIT 1
paid_at shapes: noon-UTC 141 · 16:00Z (noon EDT) 26 · 17:00Z (noon EST) 6 · midnight-UTC 21 · other 96
descriptions ~ "pending balance": 7
TOTAL items: 946 · base_cost null 89 · kit_group 139 · REFUNDED 4 · payment_date set 341 · mirror_src 116 · quantity ≤ 0: 0
TOTAL services: 353 · 'Full Project Labor' 74 · price 0: 80 · payment_date set 114
TOTAL expenses: 2133 · on quotes 335 · unpaid 394 · expense_date≠payment_date (both set) 23 · expense_date set while unpaid 22
paid_from: GZ28BR 302 · GZ28US 1417 · NULL 414 ; paid_to: GZ28US 1024 · NULL 1106 · 3 supplier names (legacy)
export_status: FRESH 1640 · EXPORTED 412 · REMOVED 68 · PENDING 13 (off-vocabulary) ; cancel_status REFUNDED 18
nature: PART 1318 · NULL 610 · SERVICE 142 · MONEY 41 · DIGITAL 21 · CHARGE 1
order_number set 1003 · receipt_url set 1225 · part_id set 9 · mirror_src 117 · stock DONATED 23
quote_backups: 16 (16 distinct invoices)
duties: 466 · unassigned 29 · on quotes 25 · priority 0:94 1:180 2:76 3:33 4:14 STANDBY:68 'P0':1 (off-vocabulary)
rides: 85 · is_quote 28 · origin PROJECT 85 · title_scope NULL 26 · CLIENT 22 · EXPORT 13 · USA 13 · OWN 5 · OUT_OF_STATE 2 · PART_OUT 2 · TOOL 2 · pinned 5
clients: 90 · is_quote 53 · origin PROJECT 88 · SHOP 1 · FACEBOOK 1 (off-vocabulary) · country BRAZIL 45 · 'Brazil' 1 · USA 43 · ENGLAND 1
clients USA with blank state: 4 · preferred_message_method WhatsApp 64 · Instagram 9 · NULL 8 · SMS 5 · Facebook 3 · E-Mail 1 · no email 30 · no phone 3
duplicate client_number within (origin, is_quote): none
```

## Appendix B — the 18 reader reports (this folder)
`editor-A-state.md` (imports/state/loaders/computations) · `editor-B-actions.md` (every action, SAVE sequence, conversion, reports, mirrors) · `editor-C-ui.md` (screen, modals, click counts, UX) · `view-page.md` (view, PDF, SEND, duplicate) · `lists-and-new.md` (creation, numbering, lists, PAST) · `packs.md` (templates, applyPack, shop contract, live probe) · `money-engine.md` (formula sheet) · `client-surfaces.md` (login, self pages, RLS, notifications, e-mail, language) · `messaging-pdf-files.md` (WhatsApp, e-mail, PDF, Dropbox, mailboxes) · `shop-stripe.md` (checkout, webhook, mirror, fees, tax collision) · `data-model.md` (ER, columns, constraints, missing pieces) · `constitution.md` (~180 rules from ~240 memory notes, conflicts, gaps) · `consumers.md` (~70 outside readers, column matrix) · `duties-streams.md` (execution: duties, purchases, parts DB) · `framework-conventions.md` (Next 16, house style, rendering model) · `br-parity.md` (US vs BR diff, shared-core strategy) · `history.md` (470 + 304 commits, reverted ideas) · `benchmark.md` (Stripe, e-sign law, vendors, Florida statute). Supporting artefacts: `probe-packs.mjs`, `probe-invoices.mjs`, `br-parity-diffs/`, `br-parity-norm/`, `history-*.txt`.
