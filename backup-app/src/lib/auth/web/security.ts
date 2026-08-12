import type { Client } from "@libsql/client";
import type { AuthRole } from "@/core/auth/roles";

type RateLimitScope =
  | "login:email"
  | "login:ip"
  | "change-password:user"
  | "change-password:ip";

type RateLimitConfig = {
  scope: RateLimitScope;
  key: string;
  maxAttempts: number;
  windowMs: number;
  blockMs: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type UserSessionState = {
  id: string;
  role: AuthRole;
  version: number;
  isActive: boolean;
  deletedAt: number | null;
};

let rateLimitTableReady = false;

function normalizeIp(value: string | null | undefined): string {
  if (!value) return "unknown";
  return value.split(",")[0]?.trim() || "unknown";
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }

  return false;
}

export function extractClientIp(request: unknown): string {
  if (!request || typeof request !== "object") {
    return "unknown";
  }

  const requestLike = request as {
    headers?: Headers | { get?: (name: string) => string | null };
  };
  const headers = requestLike.headers;

  if (!headers || typeof headers.get !== "function") {
    return "unknown";
  }

  return normalizeIp(
    headers.get("x-forwarded-for") ||
      headers.get("x-real-ip") ||
      headers.get("cf-connecting-ip"),
  );
}

async function ensureRateLimitTable(client: Client) {
  if (rateLimitTableReady) {
    return;
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at INTEGER NOT NULL,
      blocked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    )
  `);

  rateLimitTableReady = true;
}

export async function consumeRateLimit(
  client: Client,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  await ensureRateLimitTable(client);

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = Math.ceil(config.windowMs / 1000);
  const blockSeconds = Math.ceil(config.blockMs / 1000);

  const result = await client.execute({
    sql: `SELECT attempts, first_attempt_at, blocked_until
          FROM auth_rate_limits
          WHERE scope = ? AND key = ?
          LIMIT 1`,
    args: [config.scope, config.key],
  });

  const row = result.rows[0] as
    | {
        attempts?: number;
        first_attempt_at?: number;
        blocked_until?: number | null;
      }
    | undefined;

  if (!row) {
    await client.execute({
      sql: `INSERT INTO auth_rate_limits
            (scope, key, attempts, first_attempt_at, blocked_until, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [config.scope, config.key, 1, now, null, now, now],
    });

    return { allowed: true, retryAfterSeconds: 0 };
  }

  const blockedUntil = row.blocked_until ?? null;
  if (blockedUntil && blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: blockedUntil - now,
    };
  }

  const firstAttemptAt = row.first_attempt_at ?? now;
  const attemptsExpired = firstAttemptAt + windowSeconds <= now;

  if (attemptsExpired) {
    await client.execute({
      sql: `UPDATE auth_rate_limits
            SET attempts = ?, first_attempt_at = ?, blocked_until = NULL, updated_at = ?
            WHERE scope = ? AND key = ?`,
      args: [1, now, now, config.scope, config.key],
    });

    return { allowed: true, retryAfterSeconds: 0 };
  }

  const nextAttempts = (row.attempts ?? 0) + 1;
  const nextBlockedUntil =
    nextAttempts >= config.maxAttempts ? now + blockSeconds : null;

  await client.execute({
    sql: `UPDATE auth_rate_limits
          SET attempts = ?, blocked_until = ?, updated_at = ?
          WHERE scope = ? AND key = ?`,
    args: [nextAttempts, nextBlockedUntil, now, config.scope, config.key],
  });

  return {
    allowed: nextBlockedUntil === null,
    retryAfterSeconds: nextBlockedUntil ? nextBlockedUntil - now : 0,
  };
}

export async function resetRateLimit(
  client: Client,
  scope: RateLimitScope,
  key: string,
) {
  await ensureRateLimitTable(client);

  await client.execute({
    sql: "DELETE FROM auth_rate_limits WHERE scope = ? AND key = ?",
    args: [scope, key],
  });
}

export async function getUserSessionState(
  client: Client,
  userId: string,
): Promise<UserSessionState | null> {
  const result = await client.execute({
    sql: `SELECT id, role, version, is_active, deleted_at
          FROM users
          WHERE id = ?
          LIMIT 1`,
    args: [userId],
  });

  const row = result.rows[0] as
    | {
        id?: string;
        role?: AuthRole;
        version?: number;
        is_active?: number;
        deleted_at?: number | null;
      }
    | undefined;

  if (!row?.id || !row.role) {
    return null;
  }

  return {
    id: row.id,
    role: row.role,
    version: normalizeNumber(row.version, 1),
    isActive: normalizeBoolean(row.is_active),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined
        ? null
        : normalizeNumber(row.deleted_at, 0),
  };
}
