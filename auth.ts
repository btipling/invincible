import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { eq } from 'drizzle-orm';
import type { NextAuthConfig } from 'next-auth';
import { createDbConnection, users } from './db';
import { verifyPassword } from './lib/tenancy/password';

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
        const email = emailRaw.trim().toLowerCase();
        if (!email || !password) {
          return null;
        }

        if (!process.env.DATABASE_URL?.trim()) {
          return null;
        }

        const { db, client } = createDbConnection();
        try {
          const rows = await db
            .select({
              id: users.id,
              email: users.email,
              name: users.name,
              status: users.status,
              passwordHash: users.passwordHash,
            })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          const row = rows[0];
          if (!row || row.status !== 'active' || !row.passwordHash) {
            return null;
          }
          const ok = await verifyPassword(password, row.passwordHash);
          if (!ok) {
            return null;
          }
          return {
            id: row.id,
            email: row.email,
            name: row.name ?? undefined,
          };
        } finally {
          await client.end({ timeout: 5 });
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        if (user.email) token.email = user.email;
        if (user.name) token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        if (typeof token.email === 'string') {
          session.user.email = token.email;
        }
        if (typeof token.name === 'string') {
          session.user.name = token.name;
        }
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
