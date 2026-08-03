'use client';

import dynamic from 'next/dynamic';
import HarnessLoading from './HarnessLoading';

/**
 * Code-split the heavy host (Wasm glue, bridge, session) off the main bundle.
 * ssr: false — WebAssembly + canvas only exist in the browser.
 */
const HarnessHost = dynamic(() => import('./HarnessHost'), {
  ssr: false,
  loading: () => <HarnessLoading label="Starting agent panel…" />,
});

export default function HarnessPage() {
  return <HarnessHost />;
}
