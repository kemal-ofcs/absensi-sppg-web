const LIBSQL_SCHEMES = ["libsql:", "https:", "http:", "ws:", "wss:", "file:"];

const AUTH_DATABASE_TOKEN_ENV_KEYS = [
  "AUTH_DATABASE_AUTH_TOKEN",
  "TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_AUTH_TOKEN",
  "TURSO_DATABASE_TURSO_AUTH_TOKEN",
] as const;

function isSupportedLibsqlUrl(url: string): boolean {
  try {
    const normalized = url.startsWith("libsql://")
      ? url.replace("libsql://", "https://")
      : url;
    const parsed = new URL(normalized);
    return LIBSQL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function resolveAuthDatabaseUrl(): string {
  const candidates = [
    process.env.AUTH_DATABASE_URL,
    process.env.TURSO_DATABASE_URL,
  ].filter((value): value is string => Boolean(value));

  const url = candidates.find((value) => isSupportedLibsqlUrl(value));

  if (!url) {
    throw new Error(
      "Auth database URL is not configured for libSQL/Turso. Set AUTH_DATABASE_URL or TURSO_DATABASE_URL to a libsql/https URL. Do not use Vercel Postgres DATABASE_URL here.",
    );
  }

  return url.startsWith("libsql://")
    ? url.replace("libsql://", "https://")
    : url;
}

export function resolveAuthDatabaseToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of AUTH_DATABASE_TOKEN_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export async function createAuthDbClient() {
  const url = resolveAuthDatabaseUrl();
  const authToken = resolveAuthDatabaseToken();

  // Edge/Web safety:
  // Next.js middleware (Edge) cannot use the native '@libsql/client'
  const isEdge =
    typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !==
    "undefined";

  if (isEdge) {
    const { createClient: createWebClient } = await import(
      "@libsql/client/web"
    );
    return createWebClient({ url, authToken });
  }

  const { createClient: createNodeClient } = await import("@libsql/client");
  return createNodeClient({ url, authToken });
}
