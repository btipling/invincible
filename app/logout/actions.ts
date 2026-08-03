'use server';

import { signOut } from '../../auth';

/** Clear Auth.js session and send user to login. */
export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}
