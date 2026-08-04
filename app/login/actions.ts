'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '../../auth';
import { safeCallbackUrl } from '../../lib/tenancy/callbackUrl';

export type LoginState = {
  error?: string;
};

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const safeCallback = safeCallbackUrl(
    String(formData.get('callbackUrl') ?? ''),
    '/harness',
  );

  if (!email || !password) {
    return { error: 'Email and password are required.' };
  }

  try {
    await signIn('credentials', {
      email,
      password,
      redirectTo: safeCallback,
    });
  } catch (err) {
    // signIn throws NEXT_REDIRECT on success
    if (err && typeof err === 'object' && 'digest' in err) {
      const digest = String((err as { digest?: string }).digest ?? '');
      if (digest.startsWith('NEXT_REDIRECT')) {
        throw err;
      }
    }
    if (err instanceof AuthError) {
      return { error: 'Invalid email or password.' };
    }
    // next/navigation redirect throws
    throw err;
  }

  redirect(safeCallback);
}

/** OIDC SSO — redirects to IdP when provider is configured. */
export async function oidcSignInAction(formData: FormData): Promise<void> {
  const safeCallback = safeCallbackUrl(
    String(formData.get('callbackUrl') ?? ''),
    '/harness',
  );
  await signIn('oidc', { redirectTo: safeCallback });
}
