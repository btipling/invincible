import { AuthNavLinks } from '../components/AuthNavLinks';
import HarnessClient from './HarnessClient';

export const dynamic = 'force-dynamic';

/**
 * Server page: auth chrome as RSC slot into client host (no dual chat).
 */
export default function HarnessPage() {
  return <HarnessClient authNav={<AuthNavLinks />} />;
}
