'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../auth';
import { rotateSandboxToken } from '../../lib/tenancy/rotateSandboxToken';
import { rotateTenantDek } from '../../lib/tenancy/rotateTenantDek';
import { tenancyEnabled } from '../../lib/tenancy/enabled';
import { loadAdminContext } from '../../lib/tenancy/adminContext';
import {
  createProviderSecret,
  disableProviderSecret,
  setProviderSecretGrants,
  setProviderSecretModels,
  updateProviderSecret,
} from '../../lib/tenancy/providerSecrets';
import {
  byokCredentialShape,
  isByokProvider,
  isValidModelId,
  normalizeModelIds,
} from '../../lib/gateway/byokProviders';

function revalidateAdmin() {
  revalidatePath('/admin');
  revalidatePath('/admin/users');
  revalidatePath('/admin/sandboxes');
  revalidatePath('/admin/inference');
  revalidatePath('/admin/encryption');
}

async function requireAdminSession(): Promise<
  | { ok: true; userId: string; tenantId: string }
  | { ok: false; error: string }
> {
  if (!tenancyEnabled()) {
    return { ok: false, error: 'Tenancy is not enabled.' };
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const ctx = await loadAdminContext(userId);
  if (!ctx.ok) {
    return { ok: false, error: 'Admin access required.' };
  }
  return { ok: true, userId, tenantId: ctx.value.tenant.id };
}

export type RotateState = {
  ok?: boolean;
  error?: string;
  sandboxId?: string;
};

export async function rotateTokenAction(
  _prev: RotateState,
  formData: FormData,
): Promise<RotateState> {
  if (!tenancyEnabled()) {
    return { error: 'Tenancy is not enabled.' };
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { error: 'Authentication required.' };
  }

  const sandboxId = String(formData.get('sandboxId') ?? '').trim();
  const newToken = String(formData.get('newToken') ?? '');

  if (!sandboxId) {
    return { error: 'Missing sandbox.' };
  }
  if (!newToken.trim()) {
    return { error: 'New token is required.', sandboxId };
  }

  const result = await rotateSandboxToken(userId, sandboxId, newToken);
  if (!result.ok) {
    if (result.reason === 'forbidden') {
      return { error: 'Only the tenant owner can rotate the token.', sandboxId };
    }
    if (result.reason === 'empty') {
      return { error: 'New token is required.', sandboxId };
    }
    if (result.reason === 'not_found') {
      return { error: 'Sandbox not found.', sandboxId };
    }
    return { error: 'Could not rotate token.', sandboxId };
  }

  revalidateAdmin();
  return { ok: true, sandboxId };
}

export type RotateDekState = {
  ok?: boolean;
  error?: string;
  tenantId?: string;
};

export async function rotateTenantDekAction(
  _prev: RotateDekState,
  formData: FormData,
): Promise<RotateDekState> {
  if (!tenancyEnabled()) {
    return { error: 'Tenancy is not enabled.' };
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { error: 'Authentication required.' };
  }

  const tenantId = String(formData.get('tenantId') ?? '').trim();
  if (!tenantId) {
    return { error: 'Missing tenant.' };
  }

  const result = await rotateTenantDek(userId, tenantId);
  if (!result.ok) {
    if (result.reason === 'forbidden') {
      return {
        error: 'Only the tenant owner can rotate the encryption key.',
        tenantId,
      };
    }
    if (result.reason === 'not_found') {
      return { error: 'Tenant not found.', tenantId };
    }
    return { error: 'Could not rotate encryption key.', tenantId };
  }

  revalidateAdmin();
  return { ok: true, tenantId };
}

export type InferenceActionState = {
  ok?: boolean;
  error?: string;
  secretId?: string;
};

function parseModels(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function parseGrantUserIds(formData: FormData): string[] {
  const multi = formData.getAll('grantUserIds').map((v) => String(v).trim()).filter(Boolean);
  if (multi.length > 0) return [...new Set(multi)];
  const csv = String(formData.get('grantUserIdsCsv') ?? '');
  return [...new Set(csv.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function credentialsFromForm(provider: string, formData: FormData): Record<string, unknown> {
  if (!isByokProvider(provider)) return {};
  const shape = byokCredentialShape(provider);
  if (shape === 'apiKey') {
    return { apiKey: String(formData.get('apiKey') ?? '') };
  }
  if (shape === 'azure') {
    return {
      apiKey: String(formData.get('apiKey') ?? ''),
      resourceName: String(formData.get('resourceName') ?? ''),
    };
  }
  if (shape === 'vertex') {
    return {
      project: String(formData.get('project') ?? ''),
      location: String(formData.get('location') ?? ''),
      googleCredentials: {
        privateKey: String(formData.get('privateKey') ?? ''),
        clientEmail: String(formData.get('clientEmail') ?? ''),
      },
    };
  }
  // bedrock
  return {
    accessKeyId: String(formData.get('accessKeyId') ?? ''),
    secretAccessKey: String(formData.get('secretAccessKey') ?? ''),
    region: String(formData.get('region') ?? '') || undefined,
  };
}

export async function createProviderSecretAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const name = String(formData.get('name') ?? '').trim();
  const provider = String(formData.get('provider') ?? '').trim();
  if (!isByokProvider(provider)) {
    return { error: 'Unknown provider.' };
  }
  const credentials = credentialsFromForm(provider, formData);
  const models = normalizeModelIds(
    parseModels(String(formData.get('modelIds') ?? '')),
    provider,
  );
  for (const mid of models) {
    if (!isValidModelId(mid)) {
      return {
        error: `Invalid model id: ${mid} (use provider/model, e.g. xai/grok-4.5)`,
      };
    }
  }
  const grantIds = parseGrantUserIds(formData);

  const created = await createProviderSecret(
    {
      tenantId: gate.tenantId,
      name,
      provider,
      credentials,
    },
  );
  if (!created.ok) {
    return { error: created.error };
  }
  const secretId = created.value.id;

  if (models.length > 0) {
    const m = await setProviderSecretModels(secretId, models, gate.tenantId);
    if (!m.ok) {
      return { error: m.error, secretId };
    }
  }

  if (grantIds.length > 0) {
    const g = await setProviderSecretGrants(
      secretId,
      grantIds.map((userId) => ({ userId, canUse: true })),
      gate.tenantId,
    );
    if (!g.ok) {
      return { error: g.error, secretId };
    }
  }

  revalidateAdmin();
  return { ok: true, secretId };
}

export async function updateProviderSecretAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const secretId = String(formData.get('secretId') ?? '').trim();
  if (!secretId) return { error: 'Missing secret.' };

  const name = String(formData.get('name') ?? '').trim();
  const replaceKey = String(formData.get('replaceKey') ?? '') === '1';
  const provider = String(formData.get('provider') ?? '').trim();

  const patch: {
    secretId: string;
    tenantId: string;
    name?: string;
    credentials?: Record<string, unknown>;
  } = { secretId, tenantId: gate.tenantId };

  if (name) patch.name = name;
  if (replaceKey && isByokProvider(provider)) {
    patch.credentials = credentialsFromForm(provider, formData);
  }

  const updated = await updateProviderSecret(patch);
  if (!updated.ok) {
    return { error: updated.error, secretId };
  }

  revalidateAdmin();
  return { ok: true, secretId };
}

export async function disableProviderSecretAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const secretId = String(formData.get('secretId') ?? '').trim();
  if (!secretId) return { error: 'Missing secret.' };

  const result = await disableProviderSecret(secretId, gate.tenantId);
  if (!result.ok) {
    return { error: result.error, secretId };
  }

  revalidateAdmin();
  return { ok: true, secretId };
}

export async function enableProviderSecretAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const secretId = String(formData.get('secretId') ?? '').trim();
  if (!secretId) return { error: 'Missing secret.' };

  const result = await updateProviderSecret({
    secretId,
    tenantId: gate.tenantId,
    status: 'active',
  });
  if (!result.ok) {
    return { error: result.error, secretId };
  }

  revalidateAdmin();
  return { ok: true, secretId };
}

export async function setProviderSecretModelsAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const secretId = String(formData.get('secretId') ?? '').trim();
  if (!secretId) return { error: 'Missing secret.' };

  // Bare model names are prefixed with the secret's provider inside setProviderSecretModels.
  const models = parseModels(String(formData.get('modelIds') ?? ''));

  const result = await setProviderSecretModels(secretId, models, gate.tenantId);
  if (!result.ok) {
    return { error: result.error, secretId };
  }

  revalidateAdmin();
  return { ok: true, secretId };
}

export async function setProviderSecretGrantsAction(
  _prev: InferenceActionState,
  formData: FormData,
): Promise<InferenceActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const secretId = String(formData.get('secretId') ?? '').trim();
  if (!secretId) return { error: 'Missing secret.' };

  const grantIds = parseGrantUserIds(formData);
  const result = await setProviderSecretGrants(
    secretId,
    grantIds.map((userId) => ({ userId, canUse: true })),
    gate.tenantId,
  );
  if (!result.ok) {
    return { error: result.error, secretId };
  }

  revalidateAdmin();
  return { ok: true, secretId };
}
