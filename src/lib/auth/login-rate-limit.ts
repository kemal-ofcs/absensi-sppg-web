import type { Client } from "@libsql/client";
import { hashSessionToken } from "@/lib/auth/session-token";

const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1_000;
const BLOCK_MS = 2 * 60 * 1_000;

async function createRateKeys(clientAddress: string, identifier: string) {
  return Promise.all([
    hashSessionToken(`ip:${clientAddress}`),
    hashSessionToken(`identity:${clientAddress}:${identifier.toLowerCase()}`),
  ]);
}

export async function checkLoginRateLimit(
  client: Client,
  clientAddress: string,
  identifier: string,
  now = new Date(),
) {
  const keys = await createRateKeys(clientAddress, identifier);
  const placeholders = keys.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `
      SELECT blocked_until FROM auth_login_rate_limit
      WHERE rate_key IN (${placeholders}) AND blocked_until > ?
      ORDER BY blocked_until DESC LIMIT 1;
    `,
    args: [...keys, now.toISOString()],
  });
  const blockedUntil = result.rows[0]?.blocked_until;
  if (!blockedUntil) return { allowed: true as const, retryAfterSeconds: 0 };
  return {
    allowed: false as const,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        (new Date(String(blockedUntil)).getTime() - now.getTime()) / 1_000,
      ),
    ),
  };
}

export async function recordLoginFailure(
  client: Client,
  clientAddress: string,
  identifier: string,
  now = new Date(),
) {
  await consumeLoginAttempt(client, clientAddress, identifier, now);
}

export async function consumeLoginAttempt(
  client: Client,
  clientAddress: string,
  identifier: string,
  now = new Date(),
) {
  const keys = await createRateKeys(clientAddress, identifier);
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const blockedUntil = new Date(now.getTime() + BLOCK_MS).toISOString();
  const results = await client.batch(
    keys.map((key) => ({
      sql: `
        INSERT INTO auth_login_rate_limit (
          rate_key, attempt_count, window_started_at, blocked_until, updated_at
        ) VALUES (?, 1, ?, NULL, ?)
        ON CONFLICT(rate_key) DO UPDATE SET
          attempt_count = CASE
            WHEN blocked_until > ? THEN attempt_count + 1
            WHEN window_started_at > ? THEN attempt_count + 1 ELSE 1
          END,
          window_started_at = CASE
            WHEN blocked_until > ? THEN window_started_at
            WHEN window_started_at > ? THEN window_started_at ELSE ?
          END,
          blocked_until = CASE
            WHEN blocked_until > ? THEN blocked_until
            WHEN (
              CASE WHEN window_started_at > ? THEN attempt_count + 1 ELSE 1 END
            ) >= ? THEN ? ELSE NULL
          END,
          updated_at = ?
        RETURNING attempt_count, blocked_until;
      `,
      args: [
        key,
        nowIso,
        nowIso,
        nowIso,
        cutoffIso,
        nowIso,
        cutoffIso,
        nowIso,
        nowIso,
        cutoffIso,
        MAX_FAILURES,
        blockedUntil,
        nowIso,
      ],
    })),
    "write",
  );
  const denied = results.some(
    (result) => Number(result.rows[0]?.attempt_count ?? 0) > MAX_FAILURES,
  );
  if (!denied) {
    return { allowed: true as const, retryAfterSeconds: 0 };
  }
  const latestBlock = Math.max(
    ...results.map((result) =>
      new Date(String(result.rows[0]?.blocked_until ?? nowIso)).getTime(),
    ),
  );
  return {
    allowed: false as const,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((latestBlock - now.getTime()) / 1_000),
    ),
  };
}

export async function clearLoginFailures(
  client: Client,
  clientAddress: string,
  identifier: string,
) {
  const keys = await createRateKeys(clientAddress, identifier);
  await client.execute({
    sql: `DELETE FROM auth_login_rate_limit WHERE rate_key IN (?, ?);`,
    args: keys,
  });
}
