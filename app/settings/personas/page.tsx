import { teal } from '../../../lib/palette';
import { createProdServices } from '../../../lib/di';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import { PersonaForms, type PersonaListItem } from './PersonaForm';

/**
 * Phase-2 (#487) /settings/personas — DOM host chrome, never a chat panel.
 * Server component: loads the user's persona summaries via the composition-root
 * store and the owner's own body for the edit form via `getPersonaById`
 * (bodies stay server-side; `/api/personas` and the harness picker never see a
 * body). CRUD is done through server actions (PersonaForm).
 */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Personas · Settings · Invincible',
};

export default async function SettingsPersonasPage() {
  const gate = await gateSettingsPage('/settings/personas');
  return (
    <SettingsPageShell title="Personas" gate={gate}>
      {(ctx) => PersonasPageBody({ userId: ctx.userId })}
    </SettingsPageShell>
  );
}

async function PersonasPageBody({ userId }: { userId: string }) {
  const listed = await services.userPersonas.listUserPersonas(userId);
  if (!listed.ok) {
    return (
      <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
        {listed.code === 'unavailable'
          ? 'Personas are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
          : listed.error}
      </p>
    );
  }

  const personas: PersonaListItem[] = [];
  for (const s of listed.value) {
    const full = await services.userPersonas.getPersonaById(userId, s.id);
    personas.push({
      id: s.id,
      name: s.name,
      slug: s.slug,
      body: full.ok && full.value ? full.value.body : '',
      isDefault: s.isDefault,
    });
  }

  return <PersonaForms personas={personas} />;
}
