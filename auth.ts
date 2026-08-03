import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import { authenticateCredentials } from './lib/tenancy/authenticate';
import {
  applyJwtToSessionUser,
  applyUserToJwtToken,
} from './lib/tenancy/sessionToken';

/**
 * Auth.js v5 — JWT sessions; credentials against phase-1 `users.password_hash`.
 * No Auth.js adapter tables this phase.
 */
const authConfig = {
  trustHost: true,
  session: { strategy: 'jwt' as const },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      id: 'credentials',
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const emailRaw =
          typeof credentials?.email === 'string' ? credentials.email : '';
        const password =
          typeof credentials?.password === 'string' ? credentials.password : '';
        const user = await authenticateCredentials(emailRaw, password);
        return user;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      return applyUserToJwtToken(token, user);
    },
    async session({ session, token }) {
      if (session.user) {
        applyJwtToSessionUser(session.user, token);
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
