type AuthEnv = NodeJS.ProcessEnv;

export type AuthRuntimeConfig = {
  trustHost: boolean;
  authSecret: string;
  cookieSameSite: "lax" | "strict";
};

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function parseOrigin(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalOrigin(value: string): boolean {
  const parsed = parseOrigin(value);
  if (!parsed) {
    return false;
  }

  return isLoopbackHostname(parsed.hostname);
}

function normalizeConfiguredAuthOrigin(env: AuthEnv): {
  authUrl?: string;
  nextAuthUrl?: string;
} {
  const authUrl = env.AUTH_URL?.trim();
  const nextAuthUrl = env.NEXTAUTH_URL?.trim();

  if (env.NODE_ENV !== "production") {
    const hasNonLocalAuthUrl = authUrl && !isLocalOrigin(authUrl);
    const hasNonLocalNextAuthUrl = nextAuthUrl && !isLocalOrigin(nextAuthUrl);

    if (hasNonLocalAuthUrl || hasNonLocalNextAuthUrl) {
      console.warn(
        "[AUTH] Non-local AUTH_URL/NEXTAUTH_URL detected in development. Falling back to request host for local sign-in routes.",
      );
      return {};
    }
  }

  if (authUrl && nextAuthUrl) {
    const authOrigin = parseOrigin(authUrl);
    const nextAuthOrigin = parseOrigin(nextAuthUrl);

    if (!authOrigin || !nextAuthOrigin) {
      throw new Error(
        "AUTH_URL/NEXTAUTH_URL harus berupa URL absolut yang valid.",
      );
    }

    if (authOrigin.origin !== nextAuthOrigin.origin) {
      throw new Error(
        "AUTH_URL dan NEXTAUTH_URL harus memakai origin yang sama.",
      );
    }
  }

  return {
    authUrl,
    nextAuthUrl,
  };
}

export function resolveAuthRuntimeConfig(
  env: AuthEnv = process.env,
): AuthRuntimeConfig {
  normalizeConfiguredAuthOrigin(env);

  const authSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET;
  if (!authSecret) {
    if (env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET atau NEXTAUTH_SECRET wajib di production.");
    }

    return {
      trustHost: true,
      authSecret: "hybrid-starter-dev-auth-secret",
      cookieSameSite: "lax",
    };
  }

  return {
    trustHost: env.AUTH_TRUST_HOST === "true" || env.NODE_ENV !== "production",
    authSecret,
    cookieSameSite: env.NODE_ENV === "production" ? "strict" : "lax",
  };
}

export { isLocalOrigin };
