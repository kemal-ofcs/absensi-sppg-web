import type { Client } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  createOpaqueSessionToken,
  hashSessionToken,
} from "@/lib/auth/session-token";
import { WEB_SESSION_TTL_SECONDS } from "@/lib/auth/web-session";
import { PERMISSION_CATALOG, type PermissionKey } from "@/lib/rbac/catalog";

export interface CreatedWebSession {
  token: string;
  expiresAt: string;
}

async function hashOptionalValue(value?: string | null) {
  return value ? hashSessionToken(value) : null;
}

export async function createSessionRecord(
  client: Client,
  operator: OperatorUser,
  userAgent?: string | null,
  now = new Date(),
): Promise<CreatedWebSession> {
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * 1_000);
  const token = createOpaqueSessionToken();
  await client.batch(
    [
      {
        sql: `
          INSERT INTO app_session (
            session_id, token_hash, operator_id, permission_revision,
            created_at, expires_at, last_seen_at, user_agent_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `,
        args: [
          crypto.randomUUID(),
          await hashSessionToken(token),
          operator.id,
          operator.permissionRevision,
          now.toISOString(),
          expiresAt.toISOString(),
          now.toISOString(),
          await hashOptionalValue(userAgent),
        ],
      },
      {
        sql: "DELETE FROM app_session WHERE expires_at <= ? OR revoked_at IS NOT NULL;",
        args: [now.toISOString()],
      },
    ],
    "write",
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function readSessionRecord(
  client: Client,
  token: string,
  now = new Date(),
): Promise<OperatorUser | null> {
  if (!token) return null;
  const nowIso = now.toISOString();
  const result = await client.execute({
    sql: `
      SELECT
        s.session_id, m.id, m.kode_operator, m.nama_operator, m.username,
        m.role_id, r.role_key, r.nama_role, r.is_superadmin,
        s.created_at
      FROM app_session s
      JOIN master_operator m ON m.id = s.operator_id
      JOIN app_role r ON r.id = m.role_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND m.status = 'Aktif' AND r.status = 'Aktif'
      LIMIT 1;
    `,
    args: [await hashSessionToken(token), nowIso],
  });
  const row = result.rows[0];
  if (!row) return null;

  const roleId = Number(row.role_id);
  const isSuperadmin = Number(row.is_superadmin) === 1;
  const permissionResult = isSuperadmin
    ? null
    : await client.execute({
        sql: `
          SELECT permission_key FROM role_permission
          WHERE role_id = ? AND is_allowed = 1
          ORDER BY permission_key;
        `,
        args: [roleId],
      });
  const revisionResult = await client.execute(
    "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
  );
  await client.execute({
    sql: "UPDATE app_session SET last_seen_at = ? WHERE session_id = ?;",
    args: [nowIso, String(row.session_id)],
  });

  return {
    id: Number(row.id),
    kode_operator: String(row.kode_operator),
    nama_operator: String(row.nama_operator),
    username: String(row.username),
    role: String(row.nama_role),
    roleId,
    roleKey: String(row.role_key),
    isSuperadmin,
    permissions: isSuperadmin
      ? PERMISSION_CATALOG.map(({ key }) => key)
      : (permissionResult?.rows.map((permission) =>
          String(permission.permission_key),
        ) as PermissionKey[]),
    permissionRevision: Number(revisionResult.rows[0]?.value ?? 1),
    loginAt: String(row.created_at),
  };
}

export async function revokeSessionRecord(
  client: Client,
  token: string,
  reason = "logout",
  now = new Date(),
) {
  if (!token) return;
  await client.execute({
    sql: `
      UPDATE app_session
      SET revoked_at = ?, revoked_reason = ?
      WHERE token_hash = ? AND revoked_at IS NULL;
    `,
    args: [now.toISOString(), reason, await hashSessionToken(token)],
  });
}
