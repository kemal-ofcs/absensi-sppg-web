import type { Client, InStatement } from "@libsql/client";
import { revokeRoleSessions } from "@/lib/operators/operator-admin";
import {
  isPermissionKey,
  normalizeRoleKey,
  type PermissionKey,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";
import type { RoleDraft, RoleRecord } from "@/lib/rbac/types";

export async function listRoles(client: Client): Promise<RoleRecord[]> {
  const [roleResult, permissionResult] = await Promise.all([
    client.execute(`
      SELECT
        r.id, r.role_key, r.nama_role, r.deskripsi, r.is_system,
        r.is_superadmin, r.status, COUNT(m.id) AS operator_count
      FROM app_role r
      LEFT JOIN master_operator m ON m.role_id = r.id
      GROUP BY r.id
      ORDER BY r.is_superadmin DESC, r.is_system DESC, r.nama_role ASC;
    `),
    client.execute(`
      SELECT role_id, permission_key
      FROM role_permission
      WHERE is_allowed = 1;
    `),
  ]);

  const permissionsByRole = new Map<number, PermissionKey[]>();
  for (const row of permissionResult.rows) {
    const key = String(row.permission_key);
    if (!isPermissionKey(key)) continue;
    const roleId = Number(row.role_id);
    permissionsByRole.set(roleId, [
      ...(permissionsByRole.get(roleId) ?? []),
      key,
    ]);
  }

  return roleResult.rows.map((row) => ({
    id: Number(row.id),
    roleKey: String(row.role_key),
    name: String(row.nama_role),
    description: String(row.deskripsi ?? ""),
    isSystem: Number(row.is_system) === 1,
    isSuperadmin: Number(row.is_superadmin) === 1,
    status: String(row.status) === "Nonaktif" ? "Nonaktif" : "Aktif",
    operatorCount: Number(row.operator_count),
    permissions: permissionsByRole.get(Number(row.id)) ?? [],
  }));
}

function validateRoleDraft(draft: RoleDraft) {
  const name = draft.name.trim();
  const roleKey = normalizeRoleKey(name);
  if (name.length < 3) throw new Error("Nama role minimal 3 karakter.");
  if (!roleKey) throw new Error("Nama role tidak menghasilkan key yang valid.");
  if (draft.status && !["Aktif", "Nonaktif"].includes(draft.status)) {
    throw new Error("Status role tidak valid.");
  }
  return { name, roleKey };
}

async function getActorCode(client: Client, actorId: number) {
  const actor = await client.execute({
    sql: "SELECT kode_operator FROM master_operator WHERE id = ? LIMIT 1;",
    args: [actorId],
  });
  if (!actor.rows[0]) throw new Error("Actor perubahan tidak ditemukan.");
  return String(actor.rows[0].kode_operator);
}

export async function insertRole(
  client: Client,
  actorId: number,
  draft: RoleDraft,
  permissionKeys: readonly string[] = [],
) {
  const { name, roleKey } = validateRoleDraft(draft);
  const actorCode = await getActorCode(client, actorId);
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `
      INSERT INTO app_role (
        role_key, nama_role, deskripsi, is_system, is_superadmin,
        status, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, 0, 0, 'Aktif', ?, ?, ?);
    `,
    args: [roleKey, name, draft.description?.trim() ?? "", now, now, actorCode],
  });
  const roleId = Number(result.lastInsertRowid);
  try {
    await replaceRolePermissions(client, actorId, roleId, permissionKeys);
  } catch (error) {
    await client.execute({
      sql: "DELETE FROM app_role WHERE id = ?;",
      args: [roleId],
    });
    throw error;
  }
  return { success: true, id: roleId };
}

export async function editRole(
  client: Client,
  roleId: number,
  draft: RoleDraft,
) {
  const target = await client.execute({
    sql: "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
    args: [roleId],
  });
  if (target.rows.length === 0) throw new Error("Role tidak ditemukan.");
  if (Number(target.rows[0]?.is_superadmin) === 1) {
    throw new Error("Role Superadmin tidak dapat diubah atau dinonaktifkan.");
  }

  const { name } = validateRoleDraft(draft);
  await client.execute({
    sql: `
      UPDATE app_role
      SET nama_role = ?, deskripsi = ?, status = ?, updated_at = ?
      WHERE id = ?;
    `,
    args: [
      name,
      draft.description?.trim() ?? "",
      draft.status ?? "Aktif",
      new Date().toISOString(),
      roleId,
    ],
  });
  await revokeRoleSessions(client, roleId, "role-updated");
  return { success: true };
}

export async function removeRole(client: Client, roleId: number) {
  const target = await client.execute({
    sql: `
      SELECT
        r.is_system, r.is_superadmin,
        COUNT(DISTINCT m.id) AS operator_count,
        (SELECT COUNT(*) FROM role_permission_audit a WHERE a.role_id = r.id)
          AS audit_count
      FROM app_role r
      LEFT JOIN master_operator m ON m.role_id = r.id
      WHERE r.id = ?
      GROUP BY r.id;
    `,
    args: [roleId],
  });
  if (target.rows.length === 0) throw new Error("Role tidak ditemukan.");
  if (Number(target.rows[0]?.is_system) === 1) {
    throw new Error(
      "Role sistem tidak dapat dihapus. Nonaktifkan bila diperlukan.",
    );
  }
  if (Number(target.rows[0]?.operator_count) > 0) {
    throw new Error(
      "Role masih dipakai operator. Pindahkan operator terlebih dahulu.",
    );
  }
  if (Number(target.rows[0]?.audit_count) > 0) {
    throw new Error(
      "Role memiliki histori audit. Nonaktifkan agar audit tetap utuh.",
    );
  }
  await client.execute({
    sql: "DELETE FROM app_role WHERE id = ?;",
    args: [roleId],
  });
  return { success: true };
}

export async function replaceRolePermissions(
  client: Client,
  actorId: number,
  roleId: number,
  permissionKeys: readonly string[],
) {
  const target = await client.execute({
    sql: "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
    args: [roleId],
  });
  if (target.rows.length === 0) throw new Error("Role tidak ditemukan.");
  if (Number(target.rows[0]?.is_superadmin) === 1) {
    throw new Error(
      "Permission Superadmin selalu penuh dan tidak dapat diubah.",
    );
  }

  const allowed = new Set<string>(
    permissionKeys
      .filter(isPermissionKey)
      .filter((key) => !SUPERADMIN_ONLY_PERMISSIONS.has(key)),
  );
  const [currentResult, revisionResult, catalogResult] = await Promise.all([
    client.execute({
      sql: "SELECT permission_key, is_allowed FROM role_permission WHERE role_id = ?;",
      args: [roleId],
    }),
    client.execute(
      "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
    ),
    client.execute(
      "SELECT permission_key FROM app_permission WHERE is_active = 1 ORDER BY sort_order;",
    ),
  ]);
  const current = new Map(
    currentResult.rows.map((row) => [
      String(row.permission_key),
      Number(row.is_allowed) === 1,
    ]),
  );
  const actorCode = await getActorCode(client, actorId);
  const revision = Number(revisionResult.rows[0]?.value ?? 1) + 1;
  const now = new Date().toISOString();
  const statements: InStatement[] = [];

  for (const row of catalogResult.rows) {
    const key = String(row.permission_key);
    const before = current.get(key) ?? false;
    const after = allowed.has(key);
    statements.push({
      sql: `
        INSERT INTO role_permission (
          role_id, permission_key, is_allowed, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(role_id, permission_key) DO UPDATE SET
          is_allowed = excluded.is_allowed,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by;
      `,
      args: [roleId, key, after ? 1 : 0, now, actorCode],
    });
    if (before !== after) {
      statements.push({
        sql: `
          INSERT INTO role_permission_audit (
            role_id, permission_key, before_allowed, after_allowed,
            changed_at, changed_by, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?);
        `,
        args: [
          roleId,
          key,
          before ? 1 : 0,
          after ? 1 : 0,
          now,
          actorCode,
          revision,
        ],
      });
    }
  }

  statements.push({
    sql: `
      INSERT INTO setting_gex_system (key, value) VALUES ('rbac_revision', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `,
    args: [String(revision)],
  });
  await client.batch(statements, "write");
  await revokeRoleSessions(client, roleId, "role-permissions-updated");
  return { success: true, revision };
}
