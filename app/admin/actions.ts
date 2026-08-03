'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../auth';
import { rotateSandboxToken } from '../../lib/tenancy/rotateSandboxToken';
import { tenancyEnabled } from '../../lib/tenancy/enabled';

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

  revalidatePath('/admin');
  return { ok: true, sandboxId };
}
