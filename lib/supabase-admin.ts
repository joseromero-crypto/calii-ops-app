/**
 * Service-role Supabase client, in its own Next-free module.
 *
 * Split out of `lib/supabase-server.ts` in session 17. That module statically
 * imports `next/headers` for `createServerClient()`, which means anything
 * importing it drags Next into the bundle — fine inside a route handler, a
 * hazard everywhere else. `lib/tenure.ts` already worked around it by taking
 * an `SB` parameter instead (see its header note), and `netlify/functions/*`
 * are bundled by esbuild as plain functions where `next/headers` does not
 * exist at all.
 *
 * So: admin client lives here, `supabase-server.ts` re-exports it for the ~20
 * existing call sites, and anything that must run outside the Next runtime —
 * background functions, `tsx` scripts — imports it from this file directly.
 */
import { createClient as createAdminClient } from '@supabase/supabase-js';

export function createAdminSupabase() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for admin operations');
  }
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export type AdminSupabase = ReturnType<typeof createAdminSupabase>;
