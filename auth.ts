import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type { OIDCConfig } from 'next-auth/providers';
import { authenticateCredentials } from './lib/tenancy/authenticate';
import {
  findOrCreateOidcUser,
  IdentityError,
  normalizeIdpSubject,
} from './lib/tenancy/identity';
import {
  isEmailVerifiedClaim,
  oidcButtonLabel,
  oidcClientId,
  oidcClientSecret,
  oidcIssuer,
  shouldIncludeOidcProvider,
} from './lib/tenancy/oidcConfig';
import {
  applyJwtToSessionUser,
  applyUserToJwtToken,
} from './lib/tenancy/sessionToken';

type OidcProfile = {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  email_verified?: boolean | string;
};

/**
 * Auth.js v5 — JWT sessions; credentials + optional generic OIDC (#76).
 * OIDC provider registered only when tenancy triple-gate and OIDC env complete.
 */
function buildOidcProvider(): OIDCConfig<OidcProfile> {
  return {
    id: 'oidc',
    name: oidcButtonLabel(),
    type: 'oidc',
    issuer: oidcIssuer(),
    clientId: oidcClientId(),
    clientSecret: oidcClientSecret(),
    authorization: {
      params: { scope: 'openid email profile' },
    },
    profile(profile) {
      const email =
        typeof profile.email === 'string'
          ? profile.email
          : typeof profile.preferred_username === 'string'
            ? profile.preferred_username
            : '';
      return {
        id: profile.sub ?? '',
        email: email || null,
        name: typeof profile.name === 'string' ? profile.name : null,
        emailVerified: isEmailVerifiedClaim(profile.email_verified)
          ? new Date()
          : null,
      };
    },
  };
}

function buildProviders() {
  const credentials = Credentials({
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
  });

  if (shouldIncludeOidcProvider()) {
    return [credentials, buildOidcProvider()];
  }
  return [credentials];
}

const authConfig = {
  trustHost: true,
  session: { strategy: 'jwt' as const },
  pages: {
    signIn: '/login',
  },
  providers: buildProviders(),
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'oidc') {
        return true;
      }

      try {
        const issuer =
          (typeof account.issuer === 'string' && account.issuer.trim()) ||
          oidcIssuer();
        const sub =
          (profile &&
            typeof (profile as OidcProfile).sub === 'string' &&
            (profile as OidcProfile).sub) ||
          (typeof user.id === 'string' ? user.id : '');
        const email =
          (typeof user.email === 'string' && user.email) ||
          (profile && typeof (profile as OidcProfile).email === 'string'
            ? (profile as OidcProfile).email
            : '') ||
          '';
        if (!issuer || !sub || !email) {
          return false;
        }

        const emailVerified = isEmailVerifiedClaim(
          profile
            ? (profile as OidcProfile).email_verified
            : undefined,
        );

        const { user: dbUser } = await findOrCreateOidcUser({
          subject: normalizeIdpSubject(issuer, String(sub)),
          email,
          name:
            (typeof user.name === 'string' && user.name) ||
            (profile && typeof (profile as OidcProfile).name === 'string'
              ? (profile as OidcProfile).name
              : null),
          emailVerified,
        });

        // Force JWT sub = internal users.id (not IdP sub)
        user.id = dbUser.id;
        user.email = dbUser.email;
        user.name = dbUser.name ?? undefined;
        return true;
      } catch (err) {
        if (err instanceof IdentityError) {
          // Generic deny — no enumeration
          return false;
        }
        throw err;
      }
    },
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
