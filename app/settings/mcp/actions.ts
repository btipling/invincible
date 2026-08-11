'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { loadSoleMembership } from '../../../lib/tenancy/soleMembership';
import {
  createUserMcpServer,
  deleteUserMcpServer,
  loadUserMcpSecretById,
  setUserMcpServerEnabled,
  setUserMcpServerLastError,
  updateUserMcpServer,
  type UserMcpServerErrorCode,
} from '../../../lib/tenancy/userMcpServers';
import { probeUserMcpServer } from '../../../lib/mcp/client';

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/mcp');
}

async function requireSettingsSession(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const membership = await loadSoleMembership(userId);
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

function mapError(code: UserMcpServerErrorCode, fallback: string): string {
  switch (code) {
    case 'invalid_name':
      return 'Name must be 1–80 characters.';
    case 'invalid_slug':
      return 'Slug must match a–z, digits, underscore (max 32), starting with a letter.';
    case 'invalid_url':
      return fallback || 'Invalid MCP URL (https only; private hosts blocked).';
    case 'invalid_header':
      return 'Auth header name is required when an API key is set (A–Z, a–z, 0–9, -, ≤64).';
    case 'duplicate_name':
      return 'That name is already used.';
    case 'duplicate_slug':
      return 'That slug is already used.';
    case 'limit_exceeded':
      return 'At most 5 MCP servers per user.';
    case 'not_found':
      return 'MCP server not found.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'unavailable':
      return fallback || 'MCP servers unavailable.';
    default:
      return fallback;
  }
}

export type McpActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  id?: string;
  toolCount?: number;
};

export async function createMcpServerAction(
  _prev: McpActionState,
  formData: FormData,
): Promise<McpActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const name = String(formData.get('name') ?? '');
  const slug = String(formData.get('slug') ?? '');
  const url = String(formData.get('url') ?? '');
  const authHeaderName = String(formData.get('authHeaderName') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '');
  const enabled = formData.get('enabled') === 'on' || formData.get('enabled') === 'true';

  const result = await createUserMcpServer({
    userId: session.userId,
    name,
    slug,
    url,
    authHeaderName: authHeaderName || null,
    apiKey: apiKey.trim() || null,
    enabled,
  });

  if (!result.ok) {
    return { error: mapError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'MCP server created.', id: result.value.id };
}

export async function updateMcpServerAction(
  _prev: McpActionState,
  formData: FormData,
): Promise<McpActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing server id.' };

  const name = String(formData.get('name') ?? '');
  const slug = String(formData.get('slug') ?? '');
  const url = String(formData.get('url') ?? '');
  const authHeaderName = String(formData.get('authHeaderName') ?? '').trim();
  const apiKeyRaw = formData.get('apiKey');
  const apiKey =
    apiKeyRaw === null || apiKeyRaw === undefined
      ? undefined
      : String(apiKeyRaw);

  const result = await updateUserMcpServer({
    userId: session.userId,
    id,
    name,
    slug,
    url,
    authHeaderName: authHeaderName || null,
    // blank → keep existing key
    apiKey: apiKey !== undefined && apiKey.trim() === '' ? undefined : apiKey,
  });

  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }

  revalidateSettings();
  return { ok: true, message: 'MCP server updated.', id };
}

export async function deleteMcpServerAction(
  _prev: McpActionState,
  formData: FormData,
): Promise<McpActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing server id.' };

  const result = await deleteUserMcpServer(session.userId, id);
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }

  revalidateSettings();
  return { ok: true, message: 'MCP server deleted.', id };
}

export async function toggleMcpServerAction(
  _prev: McpActionState,
  formData: FormData,
): Promise<McpActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing server id.' };
  const enabled = formData.get('enabled') === 'true' || formData.get('enabled') === 'on';

  const result = await setUserMcpServerEnabled(session.userId, id, enabled);
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }

  revalidateSettings();
  return {
    ok: true,
    message: enabled ? 'Server enabled.' : 'Server disabled.',
    id,
  };
}

export async function testMcpServerAction(
  _prev: McpActionState,
  formData: FormData,
): Promise<McpActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing server id.' };

  const loaded = await loadUserMcpSecretById(session.userId, id);
  if (!loaded.ok) {
    return { error: mapError(loaded.code, loaded.error), id };
  }

  const row = loaded.value;
  const probe = await probeUserMcpServer({
    url: row.url,
    authHeaderName: row.authHeaderName,
    apiKey: row.apiKey,
  });

  if (!probe.ok) {
    await setUserMcpServerLastError(session.userId, id, probe.error);
    revalidateSettings();
    return { error: probe.error, id };
  }

  await setUserMcpServerLastError(session.userId, id, null);
  revalidateSettings();
  return {
    ok: true,
    message: `Connected — ${probe.toolNames.length} tool(s).`,
    toolCount: probe.toolNames.length,
    id,
  };
}
