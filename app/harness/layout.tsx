import type { ReactNode } from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Harness · Invincible',
  description: 'Zig + dvui Wasm agent harness — multi-turn chat via AI Gateway',
};

/**
 * Preload heavy harness assets so the dynamic client chunk and Wasm race less.
 * Headers for application/wasm live in next.config.js.
 */
export default function HarnessLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link
        rel="preload"
        href="/harness/web.js"
        as="script"
        // web.js is loaded via dynamic import(); preload still warms the cache
      />
      <link rel="preload" href="/harness/harness.wasm" as="fetch" crossOrigin="anonymous" />
      {children}
    </>
  );
}
