import { createServerClient as createSSRClient } from '@supabase/ssr';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Server Components / Route Handlers — RLS-bound, scoped to current session cookies.
 */
export function createServerClient() {
  const cookieStore = cookies();
  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components can't write cookies; ignored — middleware handles it.
          }
        },
      },
    }
  );
}

/**
 * Admin client with service-role key. Bypasses RLS.
 * USE ONLY for trusted server logic: ingest pipeline, KPI snapshot computation,
 * AI insight generation. Never expose to a client component.
 */
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
