/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  // Repo lives under monorepo-style /workspace; pin tracing to this app.
  outputFileTracingRoot: path.join(__dirname),
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
