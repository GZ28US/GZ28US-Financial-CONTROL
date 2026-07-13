# RLS Phase 1 — go-live checklist

Everything is built on the **`rls-phase1`** branch (production `master` is untouched).
This locks the internal data (CPFs, invoices, financials) behind Supabase Auth
while keeping the 4 login-free WhatsApp forms working. **Do it together, with an
admin logged into `/ca` in another tab**, so a mistake is caught in seconds.

Deferred to **Phase 2/3** (needs the BR bank/dyno bridge to get a proxy first):
`parts_database`, `shop_config`, `dyno_pulls`, `ride_build_sheets`, storage buckets.
Because `shop_config` stays open, the shop margin editor keeps working as-is — no
change needed this phase.

## What changed on the branch
- **4 self-forms** (`/clients/self`, `/rides/self`, `/costs/fixed/self`,
  `/duties/self`) now call scoped **SECURITY DEFINER RPCs** instead of touching
  tables directly → anon needs zero access to `clients`/`rides`/`staff`/
  `invoices`/`invoice_duties`/`fixed_cost_suppliers`.
- **Cron** (`app/api/cron/recurring-expense-reports`) now uses the
  **service-role** key (bypasses RLS). Falls back to anon if the key is missing.
- **`supabase/rls_phase1.sql`** — the migration (RPCs + `authenticated`-only RLS
  on every internal table + rollback).

## Steps
1. **Add the secret** to the `/ca` Vercel project → Settings → Environment
   Variables: `SUPABASE_SERVICE_ROLE_KEY` = the ops-project service_role key
   (Supabase → Project Settings → API → `service_role`, the secret one).
2. **Deploy the branch**: merge `rls-phase1` → `master` and push (or
   `git checkout master && git merge rls-phase1 && git push`). Redeploy so the
   cron picks up the new env var.
3. **Smoke-test BEFORE the SQL** (RLS still off, so nothing should have changed):
   - `/ca` loads and works.
   - Open one of each self link — load + save still work.
4. **Run the SQL**: paste `supabase/rls_phase1.sql` into the Supabase SQL editor
   (ops project) and run. It's wrapped in a transaction.
5. **Verify WITH the admin session live**:
   - `/ca`: open invoices, rides, clients, packs, expenses — read + write all OK.
   - Each self link: `/clients/self/<id>`, `/rides/self/<id>`,
     `/costs/fixed/self/<id>`, `/duties/self/<staffId>` — load + save + the
     duty timer (START/PAUSE/DONE) all OK.
   - Anon is now blocked — from a shell:
     `curl "$SUPABASE_URL/rest/v1/clients?select=cpf" -H "apikey: $ANON"` → `[]`/401.
   - BR app still reads the US bank (parts_database untouched).
   - Trigger the cron once (or wait for its daily run) → it still sends.
6. **If anything in `/ca` breaks** → run the ROLLBACK block at the bottom of the
   SQL (drops the policies + disables RLS). Instant revert.

## Then Phase 2/3 (separate session)
BR↔US bank/dyno bridge → server proxy or machine account; then RLS on
`parts_database`, `shop_config`, `dyno_pulls`, `ride_build_sheets`; storage
bucket policies (incl. anon upload on `ride-photos`).
