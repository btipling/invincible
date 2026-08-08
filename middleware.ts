import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { tenancyEnabled } from './lib/tenancy/enabled';
import { AUTH_REQUIRED_ERROR } from './lib/tenancy/errors';

function isApiProtected(pathname: string): boolean {
  return (
    pathname === '/api/chat' ||
    pathname === '/api/agent' ||
    pathname === '/api/models' ||
    pathname === '/api/session'
  );
}

function isPageProtected(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname === '/harness' || pathname.startsWith('/harness/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return true;
  return false;
}

/** Auth.js v5 sets `__Secure-authjs.session-token` on HTTPS; getToken must match. */
export function useSecureAuthCookie(req: NextRequest | Request): boolean {
  const url = 'nextUrl' in req && req.nextUrl ? req.nextUrl : new URL(req.url);
  if (url.protocol === 'https:') return true;
  const forwarded = req.headers.get('x-forwarded-proto');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim().toLowerCase();
    if (first === 'https') return true;
  }
  return false;
}

export async function middleware(req: NextRequest) {
  if (!tenancyEnabled()) {
    return NextResponse.next();
  }

  const url = req.nextUrl ?? new URL(req.url);
  const { pathname } = url;

  // Public under tenancy
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  if (!isApiProtected(pathname) && !isPageProtected(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    // tenancyEnabled requires AUTH_SECRET — defensive
    if (isApiProtected(pathname)) {
      return NextResponse.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
    }
    const login = new URL('/login', req.url);
    login.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(login);
  }

  const token = await getToken({
    req,
    secret,
    // Production Vercel is HTTPS → session cookie is `__Secure-authjs.session-token`.
    // Default secureCookie:false looks for `authjs.session-token` and always misses → login loop.
    secureCookie: useSecureAuthCookie(req),
  });

  if (token?.sub) {
    return NextResponse.next();
  }

  if (isApiProtected(pathname)) {
    return NextResponse.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  const login = new URL('/login', req.url);
  login.searchParams.set('callbackUrl', pathname === '/' ? '/harness' : pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    '/',
    '/login',
    '/harness',
    '/harness/:path*',
    '/admin',
    '/admin/:path*',
    '/settings',
    '/settings/:path*',
    '/api/chat',
    '/api/agent',
    '/api/models',
    '/api/session',
  ],
};
