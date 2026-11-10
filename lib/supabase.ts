import { createClient } from '@supabase/supabase-js'
import { viewOnlyFetch } from '@/lib/viewOnly'

// viewOnlyFetch passes everything through, except for a VIEW-ONLY account (lib/viewOnly), where table / storage writes stop
// in the browser with a clear message — the database refuses them anyway (MIGRATION_app_viewer_readonly.sql).
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { global: { fetch: viewOnlyFetch } }
)
