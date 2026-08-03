'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import HarnessLoading from './HarnessLoading';

const HarnessHost = dynamic(() => import('./HarnessHost'), {
  ssr: false,
  loading: () => <HarnessLoading label="Starting agent panel…" />,
});

/** Client boundary so server can pass AuthNavLinks into the Wasm host. */
export default function HarnessClient({ authNav }: { authNav?: ReactNode }) {
  return <HarnessHost authNav={authNav} />;
}
