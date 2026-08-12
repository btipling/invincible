'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../auth';
import { createProdServices } from '../../lib/di';
import {
  byokCredentialShape,
  isByokProvider,
  isValidModelId,
  normalizeModelIds,
} from '../../lib/gateway/byokProviders';

/** Phase-1 DI: server actions wire through the composition root. */
const services = createProdServices();

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
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const ctx = await services.adminContext.loadAdminContext(userId);
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

  const result = await services.rotateSandboxToken.rotateSandboxToken(
    userId,
    sandboxId,
    newToken,
  );
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
    if (result.reason === 'wrong_backend') {
      return {
        error: 'Token rotate applies to BYO sandboxes only.',
        sandboxId,
      };
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
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { error: 'Authentication required.' };
  }

  const tenantId = String(formData.get('tenantId') ?? '').trim();
  if (!tenantId) {
    return { error: 'Missing tenant.' };
  }

  const result = await services.rotateTenantDek.rotateTenantDek(userId, tenantId);
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

export type SandboxActionState = {
  ok?: boolean;
  error?: string;
  sandboxId?: string;
};

function imageFromForm(formData: FormData): string | null {
  const mode = String(formData.get('imageMode') ?? 'preset').trim();
  if (mode === 'custom') {
    return String(formData.get('imageCustom') ?? '');
  }
  const preset = String(formData.get('imagePreset') ?? '').trim();
  // empty preset = null default
  return preset || null;
}

export async function createSandboxAction(
  _prev: SandboxActionState,
  formData: FormData,
): Promise<SandboxActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  const backend = String(formData.get('backend') ?? 'byo').trim();
  const baseUrl = String(formData.get('baseUrl') ?? '');
  const token = String(formData.get('token') ?? '');
  const image = imageFromForm(formData);

  const result = await services.manageSandbox.createSandboxForAdmin(gate.userId, {
    name,
    slug,
    backend,
    baseUrl,
    token,
    image,
  });
  if (!result.ok) {
    if (result.reason === 'forbidden') {
      return { error: 'Admin access required.' };
    }
    if (result.reason === 'conflict') {
      return { error: result.error ?? 'Slug already in use.' };
    }
    if (result.reason === 'validation') {
      return { error: result.error ?? 'Invalid sandbox fields.' };
    }
    return { error: 'Could not create sandbox.' };
  }

  revalidateAdmin();
  return { ok: true, sandboxId: result.sandboxId };
}

export async function updateSandboxAction(
  _prev: SandboxActionState,
  formData: FormData,
): Promise<SandboxActionState> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { error: gate.error };

  const sandboxId = String(formData.get('sandboxId') ?? '').trim();
  if (!sandboxId) return { error: 'Missing sandbox.' };

  const name = String(formData.get('name') ?? '').trim();
  const backend = String(formData.get('backend') ?? 'byo').trim();
  const baseUrl = String(formData.get('baseUrl') ?? '');
  const token = String(formData.get('token') ?? '');
  const image = imageFromForm(formData);

  const result = await services.manageSandbox.updateSandboxForAdmin(gate.userId, {
    sandboxId,
    name,
    backend,
    baseUrl,
    token: token.trim() ? token : undefined,
    image,
  });
  if (!result.ok) {
    if (result.reason === 'forbidden') {
      return { error: 'Admin access required.', sandboxId };
    }
    if (result.reason === 'not_found') {
      return { error: 'Sandbox not found.', sandboxId };
    }
    if (result.reason === 'validation') {
      return { error: result.error ?? 'Invalid sandbox fields.', sandboxId };
    }
    return { error: 'Could not update sandbox.', sandboxId };
  }

  revalidateAdmin();
  return { ok: true, sandboxId };
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

  const created = await services.providerSecrets.createProviderSecret(
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
    const m = await services.providerSecrets.setProviderSecretModels(secretId, models, gate.tenantId);
    if (!m.ok) {
      return { error: m.error, secretId };
    }
  }

  if (grantIds.length > 0) {
    const g = await services.providerSecrets.setProviderSecretGrants(
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

  const updated = await services.providerSecrets.updateProviderSecret(patch);
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

  const result = await services.providerSecrets.disableProviderSecret(secretId, gate.tenantId);
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

  const result = await services.providerSecrets.updateProviderSecret({
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

  const result = await services.providerSecrets.setProviderSecretModels(secretId, models, gate.tenantId);
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
  const result = await services.providerSecrets.setProviderSecretGrants(
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
