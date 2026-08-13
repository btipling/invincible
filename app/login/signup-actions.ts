'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '../../auth';
import { createProdServices } from '../../lib/di';
import { FirstRunError } from '../../lib/tenancy/firstRun';

/** Phase-1 (parent #473) — first-run tenant sign-up action. */
const services = createProdServices();

export type SignupState = {
  error?: string;
};

function firstRunMessage(err: FirstRunError): string {
  switch (err.code) {
    case 'invalid_input':
      return err.message;
    case 'already_initialized':
      return 'This database already has a tenant; sign-up is closed. Sign in instead.';
    case 'conflict':
      return 'Could not create the first tenant (conflict). Please try again.';
    default:
      return 'Could not create the first tenant. Please try again.';
  }
}

/**
 * Create the first tenant + owner in one transaction (server-side), then sign
 * the owner in and continue to `/harness`. Mirrors the `signIn` + `NEXT_REDIRECT`
 * swallow pattern in `login/actions.ts`.
 */
export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const tenantName = String(formData.get('tenantName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  try {
    await services.firstRun.createFirstTenant({ tenantName, email, password });
    await signIn('credentials', {
      email,
      password,
      redirectTo: '/harness',
    });
  } catch (err) {
    // signIn throws NEXT_REDIRECT on success
    if (err && typeof err === 'object' && 'digest' in err) {
      const digest = String((err as { digest?: string }).digest ?? '');
      if (digest.startsWith('NEXT_REDIRECT')) {
        throw err;
      }
    }
    if (err instanceof FirstRunError) {
      return { error: firstRunMessage(err) };
    }
    if (err instanceof AuthError) {
      return {
        error:
          'Your tenant was created, but sign-in failed. Try signing in with your new credentials.',
      };
    }
    // next/navigation redirect throws; otherwise rethrow
    throw err;
  }

  redirect('/harness');
}
