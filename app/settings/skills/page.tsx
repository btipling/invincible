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

  const skills: SkillListItem[] = [];
  for (const s of listed.value) {
    const full = await services.userSkills.getSkillBySlug(userId, s.slug);
    skills.push({
      id: s.id,
      name: s.name,
      slug: s.slug,
      description: s.description,
      body: full.ok && full.value ? full.value.body : '',
    });
  }

  return <SkillForms skills={skills} />;
}
