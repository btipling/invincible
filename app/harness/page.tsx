import type { Metadata } from 'next';
import HarnessHost from './HarnessHost';

export const metadata: Metadata = {
  title: 'Harness · Invincible',
  description: 'Zig + dvui Wasm agent harness',
};

export default function HarnessPage() {
  return <HarnessHost />;
}
