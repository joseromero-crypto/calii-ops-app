import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Single-user auth gate.
 *
 * Refreshes the Supabase session cookie on every request and redirects to
 * /login when there's no user. The login page itself and Supabase auth callback
 * routes are explicitly allowlisted so the redirect doesn't loop.
 */

const PUBLIC_PATHS = new Set(['/login', '/api/auth/signin', '/api/auth/signout']);

export async function middleware(request: NextRequest) {
  // Allowlist auth + Next internals
  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/auth')
  ) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    if (pathname !== '/' && !pathname.startsWith('/api/')) {
      url.searchParams.set('redirect', pathname + request.nextUrl.search);
    }
    return NextResponse.redirect(url);
  }

  // Lock down to the configured owner email (single-user app)
  const owner = process.env.APP_OWNER_EMAIL;
  if (owner && user.email && user.email.toLowerCase() !== owner.toLowerCase()) {
    // Sign them out — wrong account
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('error', 'unauthorized_account');
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
