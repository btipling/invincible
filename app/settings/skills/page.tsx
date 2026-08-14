import { teal } from '../../../lib/palette';
import { createProdServices } from '../../../lib/di';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import { SkillForms, type SkillListItem } from './SkillForm';

/**
 * Phase-2 (#496) /settings/skills — DOM host chrome, never a chat panel.
 * Server component: loads the user's skill summaries via the composition-root
 * store and the owner's own body for the edit form via `getSkillBySlug`
 * (discovery stays summaries-only — the store's `UserSkillSummary` has no body;
 * `/api/skills` and later `find_skill` never see a body). CRUD is done through
 * server actions (SkillForm).
 */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Skills · Settings · Invincible',
};

export default async function SettingsSkillsPage() {
  const gate = await gateSettingsPage('/settings/skills');
  return (
    <SettingsPageShell title="Skills" gate={gate}>
      {(ctx) => SkillsPageBody({ userId: ctx.userId })}
    </SettingsPageShell>
  );
}

async function SkillsPageBody({ userId }: { userId: string }) {
  const listed = await services.userSkills.listUserSkills(userId);
  if (!listed.ok) {
    return (
      <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
        {listed.code === 'unavailable'
          ? 'Skills are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
          : listed.error}
      </p>
    );
  }

  // Review #525 Major (skills wire plan): the SSR response must NOT inline every
  // skill body into one Vercel Function response — N large bodies would blow the
  // 4.5 MB `FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE` ceiling. The page renders
  // summaries only (name/slug/description/id); each SkillCard lazily loads its own
  // body via the measured `GET /api/settings/skills/:id/body` route when the owner
  // opens the body editor (one small response per skill). SkillListItem.body stays
  // in the type (owner-own edit surface) but the SSR passes an empty placeholder —
  // the real body loads on demand via the route, never a server action.
  const skills: SkillListItem[] = listed.value.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    body: '',
  }));

  return <SkillForms skills={skills} />;
}
