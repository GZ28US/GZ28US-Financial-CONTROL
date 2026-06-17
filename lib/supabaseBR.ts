import { createClient } from '@supabase/supabase-js'

// Suppliers mirror target — the GZ28BR project.
// Supplier activity in the US app is mirrored one-way (US -> BR) into BR's own
// SEPARATE suppliers table (see lib/suppliersMirror.ts). Nothing else uses this
// client. The value below is BR's PUBLISHABLE anon key (safe in browser code,
// like any NEXT_PUBLIC_* var); it can be overridden via env.
const BR_URL = process.env.NEXT_PUBLIC_SUPABASE_BR_URL || 'https://saaowriaptbvfoqoykrh.supabase.co'
const BR_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_BR_ANON_KEY || 'sb_publishable_Y35Mic14DUJODqz_LG6LxA_3kWXuUMz'

export const supabaseBR = createClient(BR_URL, BR_ANON_KEY)
