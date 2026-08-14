/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  // Repo lives under monorepo-style /workspace; pin tracing to this app.
  outputFileTracingRoot: path.join(__dirname),
  // Server-action body ceiling must accommodate the generous #514 skill body cap
  // (SKILL_BODY_MAX_BYTES = 4 MiB) so a playbook save through `createSkillAction` /
  // `updateSkillBodyAction` is not rejected by Next 15's 1 MB default
  // `bodySizeLimit` (review #525 Major: "advertised cap must be usable"). The real
  // inviolable bound stays the Vercel Function 4.5 MB request payload; a 4 MiB
  // skill body is under it. (Still bounded by the store's own `validateBody`.)
  experimental: {
    serverActions: {
      bodySizeLimit: '5mb',
    },
  },
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

module.exports = nextConfig;
