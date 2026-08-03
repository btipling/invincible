'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '../../auth';

export type LoginState = {
  error?: string;
};

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const callbackUrl = String(formData.get('callbackUrl') ?? '/harness').trim() || '/harness';

  if (!email || !password) {
    return { error: 'Email and password are required.' };
  }

  // Only allow relative same-origin callback paths
  const safeCallback =
    callbackUrl.startsWith('/') && !callbackUrl.startsWith('//')
      ? callbackUrl
      : '/harness';

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
