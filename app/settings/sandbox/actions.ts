'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { createProdServices } from '../../../lib/di';
import type { UserPreferredSandboxErrorCode } from '../../../lib/tenancy/userPreferredSandbox';
import type {
  UserSandboxInstanceErrorCode,
  UserSandboxPurpose,
} from '../../../lib/tenancy/userSandboxInstance';

/** Phase-1 DI: server actions wire through the composition root. */
const services = createProdServices();

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/sandbox');
}

async function requireSettingsSession(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const membership = await services.soleMembership.loadSoleMembership(userId);
  if (!membership.ok) {
    if (membership.reason === 'ambiguous') {
      return {
        ok: false,
        error: 'Multiple tenant memberships — v1 Settings requires exactly one.',
      };
    }
    if (membership.reason === 'db') {
      return {
        ok: false,
        error: 'Could not load membership (database unavailable).',
      };
    }
    return { ok: false, error: 'No tenant membership found.' };
  }
  return { ok: true, userId };
}

function mapPreferredError(
  code: UserPreferredSandboxErrorCode,
  fallback: string,
): string {
  switch (code) {
    case 'not_found':
      return 'Sandbox not found in your tenant.';
    case 'forbidden':
      return 'You do not have access to that sandbox.';
    case 'invalid':
      return fallback || 'That sandbox is not usable right now.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'unavailable':
      return (
        fallback ||
        'Sandbox preference storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
      );
    default:
      return fallback;
  }
}

function mapInstanceError(
  code: UserSandboxInstanceErrorCode,
  fallback: string,
): string {
  switch (code) {
    case 'invalid':
      return fallback || 'Invalid request.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'already_exists':
      return fallback || 'Instance already exists.';
    case 'precondition':
      return (
        fallback ||
        'Workspace Create requires a usable vercel catalog sandbox (set preferred when you have multiple).'
      );
    case 'not_found':
      return fallback || 'Instance not found. Refresh the page.';
    case 'platform':
      return fallback || 'Sandbox platform error. Try again or Destroy and Create.';
    case 'unavailable':
      return (
        fallback ||
        'Instance storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
      );
    default:
      return fallback || 'Request failed.';
  }
}

function parsePurpose(raw: FormDataEntryValue | null): UserSandboxPurpose | null {
  const p = String(raw ?? '').trim();
  if (p === 'workspace' || p === 'http') return p;
  return null;
}

export type SandboxSelectActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export type SandboxInstanceActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export type SessionSandboxActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /** The session-owned active sandbox the operator chose (client persists it). */
  sandboxId?: string;
};

export async function selectSandboxAction(
  _prev: SandboxSelectActionState,
  formData: FormData,
): Promise<SandboxSelectActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const sandboxId = String(formData.get('sandboxId') ?? '');
  const result = await services.userPreferredSandbox.setUserPreferredSandbox(
    session.userId,
    sandboxId,
  );
  if (!result.ok) {
    return { error: mapPreferredError(result.code, result.error) };
  }

  revalidateSettings();
  return {
    ok: true,
    message: 'Preferred sandbox saved. Agent turns will use this workspace.',
  };
}

/**
 * Set the session-owned active sandbox (mid-session switch). Distinct from
 * `selectSandboxAction` (Preferred): this binds the *active browser session*
 * routing to a specific usable grant — strictly higher-precedence than the
 * preference — and does NOT write the Preferred row.
 *
 * On success returns `sandboxId`; the caller (Settings page client) persists it
 * to the local `SessionStore.activeSandboxId`, which the host folds into the
 * next agent POST and the cloud session PUT carries for cross-device restore.
 * Canvas is never touched (feature-divide).
 */
export async function setActiveSandboxAction(
  _prev: SessionSandboxActionState,
  formData: FormData,
): Promise<SessionSandboxActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const sandboxId = String(formData.get('sandboxId') ?? '').trim();
  if (!sandboxId) {
    return { error: 'sandboxId is required.' };
  }

  const listed = await services.userPreferredSandbox.listUserSandboxChoices(
    session.userId,
  );
  if (!listed.ok) {
    return {
      error: mapPreferredError(
        listed.code === 'no_membership' ? 'no_membership' : 'unavailable',
        listed.error,
      ),
    };
  }

  const match = listed.value.options.find(
    (o) => o.sandboxId === sandboxId && o.usable && o.granted,
  );
  if (!match) {
    return {
      error:
        'That sandbox is not a usable grant for this account. Select under Admin → Sandboxes or pick a usable row.',
    };
  }

  // Do NOT write user_preferred_sandbox — this is a session binding only.
  return {
    ok: true,
    sandboxId: match.sandboxId,
    message: `Agent tools will run in "${match.name}" for this browser session.`,
  };
}

export async function createInstanceAction(
  _prev: SandboxInstanceActionState,
  formData: FormData,
): Promise<SandboxInstanceActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const purpose = parsePurpose(formData.get('purpose'));
  if (!purpose) {
    return { error: 'Invalid purpose (workspace or http required).' };
  }

  // Session identity only — ignore any client-supplied userId.
  void formData.get('userId');

  const result =
    purpose === 'workspace'
      ? await services.userSandboxInstance.createWorkspace(session.userId)
      : await services.userSandboxInstance.createHttp(session.userId);

  if (!result.ok) {
    return { error: mapInstanceError(result.code, result.error) };
  }

  revalidateSettings();
  return {
    ok: true,
    message:
      purpose === 'workspace'
        ? 'Workspace instance created and running.'
        : 'HTTP/curl instance created and running.',
  };
}

export async function startInstanceAction(
  _prev: SandboxInstanceActionState,
  formData: FormData,
): Promise<SandboxInstanceActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const purpose = parsePurpose(formData.get('purpose'));
  if (!purpose) {
    return { error: 'Invalid purpose (workspace or http required).' };
  }
  void formData.get('userId');

  const result = await services.userSandboxInstance.startInstance(
    session.userId,
    purpose,
  );
  if (!result.ok) {
    return { error: mapInstanceError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'Instance started (or resumed).' };
}

export async function stopInstanceAction(
  _prev: SandboxInstanceActionState,
  formData: FormData,
): Promise<SandboxInstanceActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const purpose = parsePurpose(formData.get('purpose'));
  if (!purpose) {
    return { error: 'Invalid purpose (workspace or http required).' };
  }
  void formData.get('userId');

  const result = await services.userSandboxInstance.stopInstance(
    session.userId,
    purpose,
  );
  if (!result.ok) {
    return { error: mapInstanceError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'Instance stopped.' };
}

export async function destroyInstanceAction(
  _prev: SandboxInstanceActionState,
  formData: FormData,
): Promise<SandboxInstanceActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const purpose = parsePurpose(formData.get('purpose'));
  if (!purpose) {
    return { error: 'Invalid purpose (workspace or http required).' };
  }
  void formData.get('userId');

  const result = await services.userSandboxInstance.destroyInstance(
    session.userId,
    purpose,
  );
  if (!result.ok) {
    return { error: mapInstanceError(result.code, result.error) };
  }

  revalidateSettings();
  return {
    ok: true,
    message: 'Instance destroyed (platform VM deleted and registry row removed).',
  };
}
