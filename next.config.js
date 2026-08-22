/** @type {import('next').NextConfig} */
const path = require('path');
// Vercel Workflow SDK (backend-agents D, plan #785): transforms `"use workflow"`
// / `"use step"` directives for this app. CJS subpath resolves to dist/next.cjs.
const { withWorkflow } = require('workflow/next');

const nextConfig = {
  // Repo lives under monorepo-style /workspace; pin tracing to this app.
  outputFileTracingRoot: path.join(__dirname),
  // NOTE (review #525 skill-wire plan): no `serverActions.bodySizeLimit` override
  // here. The generous #514 skill body cap (SKILL_BODY_MAX_BYTES = 4 MiB) is NOT
  // carried by a server action — Next 15's 1 MB default `bodySizeLimit` would reject
  // it, and raising that limit globally would endorse a ~5,242,880 B body that is
  // *above* the inviolable 4.5 MB Vercel Function request ceiling while loosening
  // EVERY other action. Instead the body travels its own measured route handlers
  // (`PUT /api/settings/skills/[id]/body` + create-with-body `POST /api/settings/skills`)
  // with a content-length fast-path + authoritative byte check against
  // `SKILL_BODY_MAX_BYTES` and a raw (un-escaped) wire so a 4 MiB body keeps genuine
  // headroom under the Function ceiling. Server actions stay on the default limit for
  // the small CRUD paths. See app/api/settings/skills/.
  async headers() {
    return [
      {
        // Version stamp — never cache (stale-wasm detector).
        source: '/harness/build-id.txt',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/harness/build-id-full.txt',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        // Production MIME for Wasm — browsers reject wrong types with opaque failures.
        source: '/harness/:path*.wasm',
        headers: [
          { key: 'Content-Type', value: 'application/wasm' },
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/harness/:path*.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

module.exports = withWorkflow(nextConfig);
