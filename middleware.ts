import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { tenancyEnabled } from './lib/tenancy/enabled';
import { AUTH_REQUIRED_ERROR } from './lib/tenancy/errors';

function isApiProtected(pathname: string): boolean {
  return pathname === '/api/chat' || pathname === '/api/agent';
}

function isPageProtected(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname === '/harness' || pathname.startsWith('/harness/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
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
    '/api/chat',
    '/api/agent',
  ],
};
