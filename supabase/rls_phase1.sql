-- ============================================================================
-- GZ28US — RLS PHASE 1  (OPS project: fvgpkbpqacnqxtrjsmpi)
-- ----------------------------------------------------------------------------
-- WHAT THIS DOES
--   * Turns on Row Level Security for every INTERNAL table and grants full
--     access to the `authenticated` role only. The /ca app uses real Supabase
--     Auth (signInWithPassword), so a logged-in user carries a JWT (role
--     `authenticated`) on every PostgREST call — those keep working. A bare
--     anon key (the one that ships in the public /ca and /shop bundles, with
--     NO session) is blocked. There is no per-user model today, so
--     "authenticated can do everything" == current behavior.
--   * Replaces the 4 login-free self-service forms' direct table access with
--     SECURITY DEFINER functions scoped to the row id in the link, so anon
--     needs NO table access to clients / rides / staff / invoices /
--     invoice_duties / fixed_cost_suppliers. This is what actually protects
--     the CPFs and the invoice financials.
--
-- WHAT THIS INTENTIONALLY DOES NOT TOUCH (deferred to Phase 2/3 — the BR app
-- and the public shop read these cross-project as anon; locking them needs the
-- BR bank/dyno bridge to get a proxy/machine account first):
--     parts_database, shop_config, dyno_pulls, ride_build_sheets, storage.
--
-- PRE-REQUISITES BEFORE RUNNING (see RLS_PHASE1_CHECKLIST.md):
--   1. Deploy the `rls-phase1` branch (self-forms call the RPCs below; the cron
--      route uses the service-role key).
--   2. Add SUPABASE_SERVICE_ROLE_KEY to the /ca Vercel project (cron needs it).
--   3. Run this WITH an admin logged into /ca in another tab, so you can verify
--      the app instantly. Rollback is at the very bottom.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) SELF-SERVICE RPCs  (SECURITY DEFINER — run as owner, bypass RLS, but only
--    expose the exact scoped operation. anon gets EXECUTE, never table access.)
-- ----------------------------------------------------------------------------

-- 1a) /clients/self/[id] --------------------------------------------------------
create or replace function public.client_self_get(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'name', name, 'email', email, 'instagram', instagram, 'facebook', facebook,
    'country', country, 'phone', phone, 'cpf', cpf, 'address', address,
    'city', city, 'state', state, 'zip', zip,
    'preferred_message_method', preferred_message_method
  )
  from public.clients where id = p_id;
$$;

create or replace function public.client_self_update(
  p_id uuid, p_name text, p_email text, p_instagram text, p_facebook text,
  p_country text, p_phone text, p_cpf text, p_address text, p_city text,
  p_state text, p_zip text, p_preferred text
) returns void language sql security definer set search_path = public as $$
  update public.clients set
    name = p_name, email = p_email, instagram = p_instagram, facebook = p_facebook,
    country = p_country, phone = p_phone, cpf = p_cpf, address = p_address,
    city = p_city, state = p_state, zip = p_zip,
    preferred_message_method = p_preferred, updated_at = now()
  where id = p_id;
$$;

-- 1b) /rides/self/[id]  (car photo) --------------------------------------------
create or replace function public.ride_self_get(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'project_code', r.project_code, 'project_name', r.project_name,
    'manufacturer', r.manufacturer, 'brand', r.brand, 'model', r.model,
    'version', r.version, 'year', r.year, 'client_id', r.client_id,
    'client_name', c.name, 'client_country', c.country
  )
  from public.rides r
  left join public.clients c on c.id = r.client_id
  where r.id = p_id;
$$;

create or replace function public.ride_self_set_photo(p_id uuid, p_photo_url text)
returns void language sql security definer set search_path = public as $$
  update public.rides set photo_url = p_photo_url, updated_at = now() where id = p_id;
$$;

-- 1c) /costs/fixed/self/[id] ---------------------------------------------------
create or replace function public.fixed_supplier_self_get(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'description', description, 'company', company, 'contact_name', contact_name,
    'phone', phone, 'email', email, 'preferred_contact', preferred_contact
  )
  from public.fixed_cost_suppliers where id = p_id;
$$;

create or replace function public.fixed_supplier_self_update(
  p_id uuid, p_company text, p_contact_name text, p_phone text,
  p_email text, p_preferred_contact text
) returns void language sql security definer set search_path = public as $$
  update public.fixed_cost_suppliers set
    company = p_company, contact_name = p_contact_name, phone = p_phone,
    email = p_email, preferred_contact = p_preferred_contact, updated_at = now()
  where id = p_id;
$$;

-- 1d) /duties/self/[staffId]  (staff duty timer) -------------------------------
-- One read RPC returns the staff + their duties joined to invoice_code, ride
-- labels and the PROMISED-TO date — exposing ONLY those safe columns (never
-- invoice pricing).
create or replace function public.duties_self_load(p_staff_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select case when s.id is null then null else jsonb_build_object(
    'staff', jsonb_build_object('name', s.name, 'phone', s.phone),
    'duties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'description', d.description, 'done', d.done,
        'priority', d.priority, 'time_seconds', d.time_seconds,
        'time_started_at', d.time_started_at, 'work_started_at', d.work_started_at,
        'work_ended_at', d.work_ended_at,
        'invoice_code', i.invoice_code,
        'ride_project_code', r.project_code, 'ride_project_name', r.project_name,
        'delivery_date', i.delivery_date, 'conclusion_date', i.conclusion_date
      ) order by d.created_at asc)
      from public.invoice_duties d
      left join public.invoices i on i.id = d.invoice_id
      left join public.rides r on r.id = i.ride_id
      where d.staff_id = p_staff_id
    ), '[]'::jsonb)
  ) end
  from (select * from public.staff where id = p_staff_id) s;
$$;

-- Generic per-row timer write: the client passes the FULL intended state for
-- the duty row (it already holds every value). Scoped to the unguessable duty id.
create or replace function public.duty_self_update(
  p_id uuid, p_time_seconds integer, p_time_started_at timestamptz,
  p_work_started_at timestamptz, p_work_ended_at timestamptz, p_done boolean
) returns void language sql security definer set search_path = public as $$
  update public.invoice_duties set
    time_seconds = p_time_seconds, time_started_at = p_time_started_at,
    work_started_at = p_work_started_at, work_ended_at = p_work_ended_at, done = p_done
  where id = p_id;
$$;

-- anon (+ authenticated) may EXECUTE the self RPCs; nothing else.
grant execute on function
  public.client_self_get(uuid),
  public.client_self_update(uuid,text,text,text,text,text,text,text,text,text,text,text,text),
  public.ride_self_get(uuid),
  public.ride_self_set_photo(uuid,text),
  public.fixed_supplier_self_get(uuid),
  public.fixed_supplier_self_update(uuid,text,text,text,text,text),
  public.duties_self_load(uuid),
  public.duty_self_update(uuid,integer,timestamptz,timestamptz,timestamptz,boolean)
to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) RLS: enable + "authenticated can do everything" on every INTERNAL table.
--    (Not parts_database / shop_config / dyno_pulls / ride_build_sheets.)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'clients','rides','ride_owners','invoices','invoice_parts','invoice_services',
    'invoice_payments','invoice_expenses','invoice_notes','invoice_duties','staff',
    'seasons','expenses','expense_reports_sent','suppliers','fixed_cost_suppliers',
    'fixed_cost_expenses','packs','goods','good_expenses','inputs','inventory',
    'inventory_sales','ride_builds','quote_backups','categories','transactions'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_authenticated_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true);',
      t || '_authenticated_all', t);
  end loop;
end $$;

commit;

-- ============================================================================
-- VERIFY (run after commit, with an admin logged into /ca in another tab):
--   * /ca loads and every page reads/writes normally (authenticated JWT).
--   * Open each self link: /clients/self/<id>, /rides/self/<id>,
--     /costs/fixed/self/<id>, /duties/self/<staffId> — load + save work.
--   * A raw anon read is now BLOCKED, e.g. from a shell:
--       curl "$URL/rest/v1/clients?select=cpf" -H "apikey: $ANON" -> [] / 401
--   * The BR app still reads the US bank (parts_database untouched).
--   * Wait for / trigger the cron once and confirm it still sends (service-role).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ROLLBACK (if anything in /ca breaks — paste and run to fully revert):
-- ----------------------------------------------------------------------------
-- do $$
-- declare t text;
-- begin
--   foreach t in array array[
--     'clients','rides','ride_owners','invoices','invoice_parts','invoice_services',
--     'invoice_payments','invoice_expenses','invoice_notes','invoice_duties','staff',
--     'seasons','expenses','expense_reports_sent','suppliers','fixed_cost_suppliers',
--     'fixed_cost_expenses','packs','goods','good_expenses','inputs','inventory',
--     'inventory_sales','ride_builds','quote_backups','categories','transactions'
--   ] loop
--     execute format('drop policy if exists %I on public.%I;', t || '_authenticated_all', t);
--     execute format('alter table public.%I disable row level security;', t);
--   end loop;
-- end $$;
-- (The self RPCs can stay; they are harmless when RLS is off.)
