#!/usr/bin/env node
/**
 * Public Production tenancy smoke (phase 3 / #70).
 * No secrets. Fail closed unless unauth POST /api/agent returns 401 with exact
 * AUTH_REQUIRED_ERROR body.
 *
 * Usage:
 *   node scripts/smoke-tenancy-public.mjs
 *   BASE_URL=https://invincible-dun-ten.vercel.app node scripts/smoke-tenancy-public.mjs
 */
const DEFAULT_BASE = 'https://invincible-dun-ten.vercel.app';
const AUTH_REQUIRED_ERROR = 'Authentication required.';

const base = (process.env.BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
const url = `${base}/api/agent`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'ping' }),
});

let bodyText = '';
try {
  bodyText = await res.text();
} catch {
  bodyText = '';
}

let errorField = null;
try {
  const j = JSON.parse(bodyText);
  errorField = typeof j?.error === 'string' ? j.error : null;
} catch {
  /* non-JSON */
}

const ok = res.status === 401 && errorField === AUTH_REQUIRED_ERROR;

if (ok) {
  console.log(`OK tenancy on: ${url} → 401 + exact AUTH_REQUIRED_ERROR`);
  process.exit(0);
}

console.error(
  [
    'FAIL tenancy smoke (expected 401 + Authentication required.)',
    `  url:    ${url}`,
    `  status: ${res.status}`,
    `  error:  ${errorField === null ? '(missing/non-json)' : JSON.stringify(errorField)}`,
    `  body:   ${bodyText.slice(0, 200)}`,
    '',
    'If status is 200, the agent route did NOT enforce multi-tenant auth',
    '(session gate missing AUTH_SECRET or it is not signing sessions).',
    'See docs/bring-your-own.md §4a and issue #70.',
  ].join('\n'),
);
process.exit(1);
