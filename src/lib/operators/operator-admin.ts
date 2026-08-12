import type { Client } from "@libsql/client";
import { hashPassword } from "@/lib/auth/password";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";

export function validateOperatorDraft(draft: OperatorDraft) {
  const code = draft.kodeOperator.trim().toUpperCase();
  const username = draft.username.trim();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
    throw new Error(
      "Kode operator harus 3-24 karakter: huruf, angka, _ atau -.",
    );
  }
  if (draft.name.trim().length < 3) {
    throw new Error("Nama operator minimal 3 karakter.");
  }
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new Error("Username harus 3-40 karakter tanpa spasi.");
  }
  if (!Number.isSafeInteger(draft.roleId) || draft.roleId < 1) {
    throw new Error("Role operator wajib dipilih.");
  }
  if (draft.status !== "Aktif" && draft.status !== "Nonaktif") {
    throw new Error("Status operator tidak valid.");
  }
}

function toOperatorRecord(row: Record<string, unknown>): OperatorRecord {
  return {
    id: Number(row.id),
    kodeOperator: String(row.kode_operator),
    name: String(row.nama_operator),
    username: String(row.username),
    roleId: Number(row.role_id),
    roleKey: String(row.role_key),
    roleName: String(row.nama_role),
    isSuperadmin: Number(row.is_superadmin) === 1,
    status: String(row.status) === "Nonaktif" ? "Nonaktif" : "Aktif",
  };
}

export async function listOperators(client: Client) {
  const result = await client.execute(`
    SELECT
      m.id, m.kode_operator, m.nama_operator, m.username, m.role_id, m.status,
      r.role_key, r.nama_role, r.is_superadmin
    FROM master_operator m
    JOIN app_role r ON r.id = m.role_id
    ORDER BY r.is_superadmin DESC, m.nama_operator ASC;
  `);
  return result.rows.map((row) =>
    toOperatorRecord(row as unknown as Record<string, unknown>),
  );
}

async function getLegacyRole(client: Client, roleId: number) {
  const role = await client.execute({
    sql: "SELECT role_key FROM app_role WHERE id = ? AND status = 'Aktif' LIMIT 1;",
    args: [roleId],
  });
  if (role.rows.length === 0) throw new Error("Role aktif tidak ditemukan.");
  const roleKey = String(role.rows[0]?.role_key);
  return ["admin", "scanner"].includes(roleKey)
    ? `${roleKey.charAt(0).toUpperCase()}${roleKey.slice(1)}`
    : "Operator";
}

export async function insertOperator(client: Client, draft: OperatorDraft) {
  validateOperatorDraft(draft);
  if (!draft.password) throw new Error("Password operator wajib diisi.");
  const result = await client.execute({
    sql: `
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, password_hash, role, role_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      draft.kodeOperator.trim().toUpperCase(),
      draft.name.trim(),
      draft.username.trim(),
      await hashPassword(draft.password),
      await getLegacyRole(client, draft.roleId),
      draft.roleId,
      draft.status,
    ],
  });
  return { success: true, id: Number(result.lastInsertRowid) };
}

export async function bootstrapSuperadmin(
  client: Client,
  draft: Omit<OperatorDraft, "roleId">,
) {
  if (draft.kodeOperator.trim().toUpperCase() !== "SPD001") {
    throw new Error("Kode bootstrap Superadmin harus SPD001.");
  }
  if (!draft.password) throw new Error("Password Superadmin wajib diisi.");

  const existing = await client.execute(`
    SELECT COUNT(*) AS total
    FROM master_operator m JOIN app_role r ON r.id = m.role_id
    WHERE m.status = 'Aktif' AND r.is_superadmin = 1;
  `);
  if (Number(existing.rows[0]?.total) > 0) {
    throw new Error(
      "Bootstrap ditutup karena Superadmin aktif sudah tersedia.",
    );
  }

  const role = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'superadmin' AND status = 'Aktif' LIMIT 1;",
  );
  const roleId = Number(role.rows[0]?.id);
  if (!Number.isSafeInteger(roleId)) {
    throw new Error("Role Superadmin aktif belum tersedia.");
  }
  return insertOperator(client, { ...draft, roleId });
}

export async function editOperator(
  client: Client,
  actorId: number,
  operatorId: number,
  draft: OperatorDraft,
) {
  validateOperatorDraft(draft);
  const target = await client.execute({
    sql: `
      SELECT m.id, m.status, r.is_superadmin
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  if (target.rows.length === 0) throw new Error("Operator tidak ditemukan.");
  const nextRole = await client.execute({
    sql: "SELECT is_superadmin, status FROM app_role WHERE id = ? LIMIT 1;",
    args: [draft.roleId],
  });
  if (
    nextRole.rows.length === 0 ||
    String(nextRole.rows[0]?.status) !== "Aktif"
  ) {
    throw new Error("Role tujuan tidak ditemukan atau sedang nonaktif.");
  }
  const removesActiveSuperadmin =
    Number(target.rows[0]?.is_superadmin) === 1 &&
    String(target.rows[0]?.status) === "Aktif" &&
    (draft.status !== "Aktif" || Number(nextRole.rows[0]?.is_superadmin) !== 1);
  if (removesActiveSuperadmin) {
    const count = await client.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.status = 'Aktif' AND r.is_superadmin = 1;
    `);
    if (Number(count.rows[0]?.total) <= 1) {
      throw new Error("Superadmin aktif terakhir tidak dapat dinonaktifkan.");
    }
  }

  const updates = [
    "kode_operator = ?",
    "nama_operator = ?",
    "username = ?",
    "role = ?",
    "role_id = ?",
    "status = ?",
  ];
  const args: (string | number)[] = [
    draft.kodeOperator.trim().toUpperCase(),
    draft.name.trim(),
    draft.username.trim(),
    await getLegacyRole(client, draft.roleId),
    draft.roleId,
    draft.status,
  ];
  if (draft.password) {
    updates.push("password_hash = ?");
    args.push(await hashPassword(draft.password));
  }
  args.push(operatorId);
  await client.execute({
    sql: `UPDATE master_operator SET ${updates.join(", ")} WHERE id = ?;`,
    args,
  });

  await revokeOperatorSessions(
    client,
    operatorId,
    actorId === operatorId
      ? "self-security-update"
      : "operator-security-update",
  );
  return { success: true };
}

export async function removeOperator(
  client: Client,
  actorId: number,
  operatorId: number,
) {
  if (actorId === operatorId) {
    throw new Error("Akun yang sedang digunakan tidak dapat dihapus.");
  }
  const target = await client.execute({
    sql: `
      SELECT m.kode_operator, m.status, r.is_superadmin
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  if (target.rows.length === 0) throw new Error("Operator tidak ditemukan.");
  const operatorCode = String(target.rows[0]?.kode_operator);
  if (
    Number(target.rows[0]?.is_superadmin) === 1 &&
    String(target.rows[0]?.status) === "Aktif"
  ) {
    const count = await client.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.status = 'Aktif' AND r.is_superadmin = 1;
    `);
    if (Number(count.rows[0]?.total) <= 1) {
      throw new Error("Superadmin aktif terakhir tidak dapat dihapus.");
    }
  }

  const references = await Promise.all([
    client.execute({
      sql: "SELECT COUNT(*) AS total FROM log_scan WHERE kode_operator = ?;",
      args: [operatorCode],
    }),
    client.execute({
      sql: "SELECT COUNT(*) AS total FROM koreksi_admin WHERE kode_operator = ?;",
      args: [operatorCode],
    }),
    client.execute({
      sql: `
        SELECT COUNT(*) AS total FROM backup_karyawan
        WHERE kode_operator = ? OR operator_pembatalan = ?;
      `,
      args: [operatorCode, operatorCode],
    }),
    client.execute({
      sql: "SELECT COUNT(*) AS total FROM role_permission_audit WHERE changed_by = ?;",
      args: [operatorCode],
    }),
  ]);
  if (references.some((result) => Number(result.rows[0]?.total) > 0)) {
    throw new Error(
      "Operator memiliki histori transaksi. Nonaktifkan akun agar audit tetap utuh.",
    );
  }

  await client.execute({
    sql: "DELETE FROM master_operator WHERE id = ?;",
    args: [operatorId],
  });
  return { success: true };
}

export async function revokeOperatorSessions(
  client: Client,
  operatorId: number,
  reason: string,
) {
  await client.execute({
    sql: `
      UPDATE app_session SET revoked_at = ?, revoked_reason = ?
      WHERE operator_id = ? AND revoked_at IS NULL;
    `,
    args: [new Date().toISOString(), reason, operatorId],
  });
}

export async function revokeRoleSessions(
  client: Client,
  roleId: number,
  reason: string,
) {
  await client.execute({
    sql: `
      UPDATE app_session SET revoked_at = ?, revoked_reason = ?
      WHERE operator_id IN (
        SELECT id FROM master_operator WHERE role_id = ?
      ) AND revoked_at IS NULL;
    `,
    args: [new Date().toISOString(), reason, roleId],
  });
}
