import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { AuthRole } from "@/core/auth/roles";
import { hashPassword, verifyPassword } from "@/lib/auth/hash";
import { createAuthDbClient } from "@/lib/auth/web/db";
import {
  buildLoginEmailCandidates,
  normalizeLoginIdentifier,
} from "@/lib/auth/web/login-identifier";
import { resolveAuthRuntimeConfig } from "@/lib/auth/web/runtime-config";
import {
  consumeRateLimit,
  extractClientIp,
  getUserSessionState,
  resetRateLimit,
} from "@/lib/auth/web/security";

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

type AuthRow = {
  id: string;
  email: string;
  full_name?: string;
  role: AuthRole;
  version?: number | string;
  password_hash?: string;
};

type SessionUserWithRole = {
  role?: AuthRole;
  version?: number;
  sessionRevoked?: boolean;
};

function normalizeVersion(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

async function verifyAndUpgradePassword(
  userId: string,
  password: string,
  storedHash: string,
) {
  if (!storedHash) return false;
  if (storedHash.startsWith("$argon2")) {
    return verifyPassword(password, storedHash);
  }
  if (password !== storedHash) return false;
  const client = await createAuthDbClient();
  const nextHash = await hashPassword(password);
  await client.execute({
    sql: `UPDATE users SET password_hash = ?, updated_at = CAST(strftime('%s', 'now') AS INTEGER), sync_status = 'pending' WHERE id = ?`,
    args: [nextHash, userId],
  });
  return true;
}

type AuthBundle = ReturnType<typeof NextAuth>;
let authBundle: AuthBundle | null = null;

function getAuthBundle(): AuthBundle {
  if (authBundle) return authBundle;
  const { trustHost, authSecret, cookieSameSite } = resolveAuthRuntimeConfig();

  authBundle = NextAuth({
    providers: [
      Credentials({
        name: "credentials",
        credentials: {
          email: { label: "Email or username", type: "text" },
          password: { label: "Password", type: "password" },
        },
        authorize: async (credentials, request) => {
          if (!credentials?.email || !credentials.password) return null;
          const identifier = normalizeLoginIdentifier(
            String(credentials.email),
          );
          const password = String(credentials.password);
          const emailCandidates = buildLoginEmailCandidates(identifier);
          if (!identifier || emailCandidates.length === 0) return null;

          const client = await createAuthDbClient();
          const clientIp = extractClientIp(request);
          const [emailLimit, ipLimit] = await Promise.all([
            consumeRateLimit(client, {
              scope: "login:email",
              key: identifier,
              maxAttempts: MAX_ATTEMPTS,
              windowMs: LOCKOUT_DURATION_MS,
              blockMs: LOCKOUT_DURATION_MS,
            }),
            consumeRateLimit(client, {
              scope: "login:ip",
              key: clientIp,
              maxAttempts: MAX_ATTEMPTS * 2,
              windowMs: LOCKOUT_DURATION_MS,
              blockMs: LOCKOUT_DURATION_MS,
            }),
          ]);
          if (!emailLimit.allowed || !ipLimit.allowed) {
            throw new Error(
              "Terlalu banyak percobaan login. Coba beberapa menit lagi.",
            );
          }

          const result = await client.execute({
            sql: `SELECT id, email, full_name, role, version, password_hash
                  FROM users
                  WHERE (lower(email) IN (${emailCandidates.map(() => "?").join(", ")})
                    OR lower(COALESCE(username, '')) = ?)
                    AND deleted_at IS NULL AND is_active = 1 LIMIT 1`,
            args: [...emailCandidates, identifier],
          });
          const user = result.rows[0] as unknown as AuthRow | undefined;
          if (!user) return null;
          const valid = await verifyAndUpgradePassword(
            user.id,
            password,
            user.password_hash || "",
          );
          if (!valid) return null;

          await Promise.all([
            resetRateLimit(client, "login:email", identifier),
            resetRateLimit(client, "login:ip", clientIp),
            client.execute({
              sql: `UPDATE users SET last_login_at = CAST(strftime('%s', 'now') AS INTEGER), updated_at = CAST(strftime('%s', 'now') AS INTEGER), sync_status = 'pending' WHERE id = ?`,
              args: [user.id],
            }),
          ]);
          return {
            id: user.id,
            email: user.email,
            name: user.full_name || user.email,
            role: user.role,
            version: normalizeVersion(user.version),
          };
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          token.id = user.id;
          token.role = (user as SessionUserWithRole).role;
          token.version = normalizeVersion(
            (user as SessionUserWithRole).version,
          );
          token.sessionRevoked = false;
          return token;
        }
        if (!token.id || token.sessionRevoked) return token;
        const client = await createAuthDbClient();
        const state = await getUserSessionState(client, String(token.id));
        if (
          !state ||
          !state.isActive ||
          state.deletedAt !== null ||
          state.version !== normalizeVersion(token.version)
        ) {
          token.sessionRevoked = true;
          return token;
        }
        token.role = state.role;
        token.version = state.version;
        return token;
      },
      async session({ session, token }) {
        if (token.sessionRevoked || !session.user) return null as never;
        session.user.id = String(token.id);
        (session.user as SessionUserWithRole).role = token.role as AuthRole;
        (session.user as SessionUserWithRole).version = normalizeVersion(
          token.version,
        );
        return session;
      },
    },
    pages: { signIn: "/login", error: "/login" },
    session: { strategy: "jwt", maxAge: 24 * 60 * 60 },
    cookies: {
      sessionToken: {
        name: `${process.env.NODE_ENV === "production" ? "__Secure-" : ""}hybrid-starter.session-token`,
        options: {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: cookieSameSite,
          path: "/",
          maxAge: 24 * 60 * 60,
        },
      },
    },
    secret: authSecret,
    trustHost,
  });
  return authBundle;
}

export const handlers = {
  GET(...args: Parameters<AuthBundle["handlers"]["GET"]>) {
    return getAuthBundle().handlers.GET(...args);
  },
  POST(...args: Parameters<AuthBundle["handlers"]["POST"]>) {
    return getAuthBundle().handlers.POST(...args);
  },
};

export const auth = ((...args: Parameters<AuthBundle["auth"]>) =>
  getAuthBundle().auth(...args)) as AuthBundle["auth"];
