import { expectTypeOf, it } from 'vitest';
import type { UserSkillSummary } from '../../../lib/tenancy/userSkills';
import type { SkillListItem } from './SkillForm';
import type { SkillActionState } from './actions';

/**
 * Phase-2 (#496) test row 6 — node-env data-contract for the "no body in
 * discovery" invariant. The repo runs vitest `environment: 'node'` with no
 * RTL/jsdom, so there is no React render test here (sibling Settings pages test
 * actions only). Instead we lock the guarantees at the type level, matching how
 * the store projects summaries and how the owner's own edit form gets its body.
 *
 * - The discovery surface (`UserSkillSummary`, used by `listUserSkills`,
 *   `GET /api/skills`, and later `find_skill`) is EXACTLY {id,name,slug,
 *   description,isAlwaysOn,updatedAt} — a body field would break the exact-type match.
 * - Server-action return states never carry a body.
 * - The client list-item type carries a body ONLY for the owner's own edit form
 *   (personas parity: server component prefills the textarea via getSkillBySlug);
 *   that is not a discovery surface.
 */
it('UserSkillSummary is summaries-only (no body in discovery)', () => {
  expectTypeOf<UserSkillSummary>().toEqualTypeOf<{
    id: string;
    name: string;
    slug: string;
    description: string;
    isAlwaysOn: boolean;
    updatedAt: Date;
  }>();
});

it('server-action states never expose a body', () => {
  expectTypeOf<SkillActionState>().toEqualTypeOf<{
    ok?: boolean;
    error?: string;
    message?: string;
    id?: string;
  }>();
});

it('owner edit form list-item carries the owner-own body (personas parity)', () => {
  expectTypeOf<SkillListItem>().toMatchTypeOf<{
    id: string;
    name: string;
    slug: string;
    description: string;
    body: string;
  }>();
});
