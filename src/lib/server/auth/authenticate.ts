import "server-only";

import type { OperatorUser } from "@/lib/auth/operator-user";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { PERMISSION_CATALOG, type PermissionKey } from "@/lib/rbac/catalog";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";

let dummyPasswordHash: Promise<string> | null = null;

function getDummyPasswordHash() {
  dummyPasswordHash ??= hashPassword("InvalidLoginPassword2026");
  return dummyPasswordHash;
}

async function readPermissions(roleId: number, isSuperadmin: boolean) {
  if (isSuperadmin) return PERMISSION_CATALOG.map(({ key }) => key);

  const result = await getServerDatabase().execute({
    sql: `
      SELECT permission_key
      FROM role_permission
      WHERE role_id = ? AND is_allowed = 1
      ORDER BY permission_key;
    `,
    args: [roleId],
  });

  return result.rows.map((row) =>
    String(row.permission_key),
  ) as PermissionKey[];
}

export async function authenticateWebOperator(
  usernameOrCode: string,
  password: string,
): Promise<OperatorUser | null> {
  await ensureServerDatabaseInitialized();
  const database = getServerDatabase();
  const identifier = usernameOrCode.trim();
  const result = await database.execute({
    sql: `
      SELECT
        m.id, m.kode_operator, m.nama_operator, m.username, m.password_hash,
        m.role_id, r.role_key, r.nama_role, r.is_superadmin
      FROM master_operator m
      JOIN app_role r ON r.id = m.role_id
      WHERE (m.username = ? OR m.kode_operator = ?)
        AND m.status = 'Aktif' AND r.status = 'Aktif'
      LIMIT 1;
    `,
    args: [identifier, identifier],
  });

  const row = result.rows[0];
  if (!row) {
    await verifyPassword(password, await getDummyPasswordHash());
    return null;
  }

  const passwordHash = String(row.password_hash ?? "");
  const verification = await verifyPassword(password, passwordHash);
  if (!verification.valid) return null;

  if (verification.needsUpgrade) {
    await database.execute({
      sql: "UPDATE master_operator SET password_hash = ? WHERE id = ?;",
      args: [await hashPassword(password), Number(row.id)],
    });
  }

  const roleId = Number(row.role_id);
  const isSuperadmin = Number(row.is_superadmin) === 1;
  const revision = await database.execute(
    "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
  );

  return {
    id: Number(row.id),
    kode_operator: String(row.kode_operator),
    nama_operator: String(row.nama_operator),
    username: String(row.username),
    role: String(row.nama_role),
    roleId,
    roleKey: String(row.role_key),
    isSuperadmin,
    permissions: await readPermissions(roleId, isSuperadmin),
    permissionRevision: Number(revision.rows[0]?.value ?? 1),
    loginAt: new Date().toISOString(),
  };
}
