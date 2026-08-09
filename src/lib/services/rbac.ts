import type { InStatement } from "@libsql/client";
import { db, ensureDbInitialized } from "@/lib/db";
import {
  isPermissionKey,
  normalizeRoleKey,
  type PermissionKey,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";
import type { RoleDraft, RoleRecord } from "@/lib/rbac/types";
import { assertOnlineSecurityMutation } from "@/lib/runtime/security-mutation";

export type { RoleDraft, RoleRecord } from "@/lib/rbac/types";

function ensureOnlineSecurityMutation() {
  assertOnlineSecurityMutation(
    "Perubahan role dan permission wajib dilakukan saat online.",
  );
}

export async function assertSuperadmin(actorId: number) {
  await ensureDbInitialized();
  const result = await db.execute({
    sql: `
      SELECT m.id
      FROM master_operator m
      JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? AND m.status = 'Aktif' AND r.status = 'Aktif'
        AND r.is_superadmin = 1
      LIMIT 1;
    `,
    args: [actorId],
  });
  if (result.rows.length === 0) {
    throw new Error("Akses ditolak. Tindakan ini hanya untuk Superadmin.");
  }
}

export async function getRoleRecords(actorId: number): Promise<RoleRecord[]> {
  await assertSuperadmin(actorId);
  const [roleResult, permissionResult] = await Promise.all([
    db.execute(`
      SELECT
        r.id, r.role_key, r.nama_role, r.deskripsi, r.is_system,
        r.is_superadmin, r.status, COUNT(m.id) AS operator_count
      FROM app_role r
      LEFT JOIN master_operator m ON m.role_id = r.id
      GROUP BY r.id
      ORDER BY r.is_superadmin DESC, r.is_system DESC, r.nama_role ASC;
    `),
    db.execute(`
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

export async function createRole(
  actorId: number,
  draft: RoleDraft,
  permissionKeys: readonly string[] = [],
) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  const name = draft.name.trim();
  const roleKey = normalizeRoleKey(name);
  if (name.length < 3) throw new Error("Nama role minimal 3 karakter.");
  if (!roleKey) throw new Error("Nama role tidak menghasilkan key yang valid.");

  const actor = await db.execute({
    sql: "SELECT kode_operator FROM master_operator WHERE id = ? LIMIT 1;",
    args: [actorId],
  });
  const actorCode = String(actor.rows[0]?.kode_operator ?? "UNKNOWN");
  const now = new Date().toISOString();
  const result = await db.execute({
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
    await setRolePermissions(actorId, roleId, permissionKeys);
  } catch (error) {
    await db.execute({
      sql: "DELETE FROM app_role WHERE id = ?;",
      args: [roleId],
    });
    throw error;
  }
  return { success: true, id: roleId };
}

export async function updateRole(
  actorId: number,
  roleId: number,
  draft: RoleDraft & { status?: "Aktif" | "Nonaktif" },
) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  const target = await db.execute({
    sql: "SELECT is_superadmin FROM app_role WHERE id = ? LIMIT 1;",
    args: [roleId],
  });
  if (target.rows.length === 0) throw new Error("Role tidak ditemukan.");
  if (Number(target.rows[0]?.is_superadmin) === 1) {
    throw new Error("Role Superadmin tidak dapat diubah atau dinonaktifkan.");
  }

  const name = draft.name.trim();
  if (name.length < 3) throw new Error("Nama role minimal 3 karakter.");
  await db.execute({
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
  return { success: true };
}

export async function deleteRole(actorId: number, roleId: number) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  const target = await db.execute({
    sql: `
      SELECT
        r.is_system,
        r.is_superadmin,
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
  await db.execute({
    sql: "DELETE FROM app_role WHERE id = ?;",
    args: [roleId],
  });
  return { success: true };
}

export async function setRolePermissions(
  actorId: number,
  roleId: number,
  permissionKeys: readonly string[],
) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  const target = await db.execute({
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
  const [currentResult, actorResult, revisionResult, catalogResult] =
    await Promise.all([
      db.execute({
        sql: "SELECT permission_key, is_allowed FROM role_permission WHERE role_id = ?;",
        args: [roleId],
      }),
      db.execute({
        sql: "SELECT kode_operator FROM master_operator WHERE id = ? LIMIT 1;",
        args: [actorId],
      }),
      db.execute(
        "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
      ),
      db.execute(
        "SELECT permission_key FROM app_permission WHERE is_active = 1 ORDER BY sort_order;",
      ),
    ]);
  const current = new Map(
    currentResult.rows.map((row) => [
      String(row.permission_key),
      Number(row.is_allowed) === 1,
    ]),
  );
  const actorCode = String(actorResult.rows[0]?.kode_operator ?? "UNKNOWN");
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
  await db.batch(statements, "write");
  return { success: true, revision };
}
