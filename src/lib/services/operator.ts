import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { db, ensureDbInitialized } from "@/lib/db";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import { PERMISSION_CATALOG, type PermissionKey } from "@/lib/rbac/catalog";
import { assertOnlineSecurityMutation } from "@/lib/runtime/security-mutation";
import { assertSuperadmin } from "@/lib/services/rbac";

export type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";

export interface AuthenticatedOperator extends OperatorRecord {
  permissions: PermissionKey[];
  permissionRevision: number;
}

interface CachedOperator extends AuthenticatedOperator {
  passwordHash: string;
}

const CACHED_OPERATORS_KEY = "absensi_sppg_cached_operators_v2";

function ensureOnlineSecurityMutation() {
  assertOnlineSecurityMutation(
    "Perubahan Master Operator wajib dilakukan saat online.",
  );
}

function validateOperatorDraft(draft: OperatorDraft) {
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

async function getPermissions(roleId: number, isSuperadmin: boolean) {
  if (isSuperadmin) return PERMISSION_CATALOG.map(({ key }) => key);
  const result = await db.execute({
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

export async function getMasterOperators(actorId: number) {
  await assertSuperadmin(actorId);
  const result = await db.execute(`
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

export async function createOperator(actorId: number, draft: OperatorDraft) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  validateOperatorDraft(draft);
  if (!draft.password) throw new Error("Password operator wajib diisi.");
  const passwordHash = await hashPassword(draft.password);
  const role = await db.execute({
    sql: "SELECT role_key FROM app_role WHERE id = ? AND status = 'Aktif' LIMIT 1;",
    args: [draft.roleId],
  });
  if (role.rows.length === 0) throw new Error("Role aktif tidak ditemukan.");
  const legacyRole = ["admin", "scanner"].includes(
    String(role.rows[0]?.role_key),
  )
    ? `${String(role.rows[0]?.role_key).charAt(0).toUpperCase()}${String(role.rows[0]?.role_key).slice(1)}`
    : "Operator";

  const result = await db.execute({
    sql: `
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, password_hash, role, role_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      draft.kodeOperator.trim().toUpperCase(),
      draft.name.trim(),
      draft.username.trim(),
      passwordHash,
      legacyRole,
      draft.roleId,
      draft.status,
    ],
  });
  return { success: true, id: Number(result.lastInsertRowid) };
}

export async function updateMasterOperator(
  actorId: number,
  operatorId: number,
  draft: OperatorDraft,
) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  validateOperatorDraft(draft);
  const target = await db.execute({
    sql: `
      SELECT m.id, m.status, r.is_superadmin
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  if (target.rows.length === 0) throw new Error("Operator tidak ditemukan.");
  const nextRole = await db.execute({
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
    const count = await db.execute(`
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
    "role_id = ?",
    "status = ?",
  ];
  const args: (string | number)[] = [
    draft.kodeOperator.trim().toUpperCase(),
    draft.name.trim(),
    draft.username.trim(),
    draft.roleId,
    draft.status,
  ];
  if (draft.password) {
    updates.push("password_hash = ?");
    args.push(await hashPassword(draft.password));
  }
  args.push(operatorId);
  await db.execute({
    sql: `UPDATE master_operator SET ${updates.join(", ")} WHERE id = ?;`,
    args,
  });
  return { success: true };
}

export async function deleteMasterOperator(
  actorId: number,
  operatorId: number,
) {
  ensureOnlineSecurityMutation();
  await assertSuperadmin(actorId);
  if (actorId === operatorId) {
    throw new Error("Akun yang sedang digunakan tidak dapat dihapus.");
  }
  const target = await db.execute({
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
    const count = await db.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.status = 'Aktif' AND r.is_superadmin = 1;
    `);
    if (Number(count.rows[0]?.total) <= 1) {
      throw new Error("Superadmin aktif terakhir tidak dapat dihapus.");
    }
  }

  const references = await Promise.all([
    db.execute({
      sql: "SELECT COUNT(*) AS total FROM log_scan WHERE kode_operator = ?;",
      args: [operatorCode],
    }),
    db.execute({
      sql: "SELECT COUNT(*) AS total FROM koreksi_admin WHERE kode_operator = ?;",
      args: [operatorCode],
    }),
    db.execute({
      sql: `
        SELECT COUNT(*) AS total FROM backup_karyawan
        WHERE kode_operator = ? OR operator_pembatalan = ?;
      `,
      args: [operatorCode, operatorCode],
    }),
    db.execute({
      sql: "SELECT COUNT(*) AS total FROM role_permission_audit WHERE changed_by = ?;",
      args: [operatorCode],
    }),
  ]);
  if (references.some((result) => Number(result.rows[0]?.total) > 0)) {
    throw new Error(
      "Operator memiliki histori transaksi. Nonaktifkan akun agar audit tetap utuh.",
    );
  }
  await db.execute({
    sql: "DELETE FROM master_operator WHERE id = ?;",
    args: [operatorId],
  });
  return { success: true };
}

export async function bootstrapSuperadmin(
  draft: Omit<OperatorDraft, "roleId">,
) {
  ensureOnlineSecurityMutation();
  await ensureDbInitialized();
  if (draft.kodeOperator.trim().toUpperCase() !== "SPD001") {
    throw new Error("Kode bootstrap Superadmin harus SPD001.");
  }
  if (!draft.password) throw new Error("Password Superadmin wajib diisi.");
  const existing = await db.execute(`
    SELECT COUNT(*) AS total
    FROM master_operator m JOIN app_role r ON r.id = m.role_id
    WHERE m.status = 'Aktif' AND r.is_superadmin = 1;
  `);
  if (Number(existing.rows[0]?.total) > 0) {
    throw new Error(
      "Bootstrap ditutup karena Superadmin aktif sudah tersedia.",
    );
  }
  const role = await db.execute(
    "SELECT id FROM app_role WHERE role_key = 'superadmin' LIMIT 1;",
  );
  const roleId = Number(role.rows[0]?.id);
  if (!Number.isSafeInteger(roleId))
    throw new Error("Role Superadmin belum tersedia.");
  return createBootstrapOperator({ ...draft, roleId });
}

async function createBootstrapOperator(draft: OperatorDraft) {
  validateOperatorDraft(draft);
  const passwordHash = await hashPassword(draft.password ?? "");
  const result = await db.execute({
    sql: `
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, password_hash, role, role_id, status
      ) VALUES (?, ?, ?, ?, 'Operator', ?, 'Aktif');
    `,
    args: [
      draft.kodeOperator.trim().toUpperCase(),
      draft.name.trim(),
      draft.username.trim(),
      passwordHash,
      draft.roleId,
    ],
  });
  return { success: true, id: Number(result.lastInsertRowid) };
}

export async function verifikasiLoginOperator(
  username: string,
  passwordPlain: string,
) {
  await ensureDbInitialized();
  try {
    const result = await db.execute({
      sql: `
        SELECT
          m.id, m.kode_operator, m.nama_operator, m.username, m.password_hash,
          m.role_id, m.status, r.role_key, r.nama_role, r.is_superadmin
        FROM master_operator m
        JOIN app_role r ON r.id = m.role_id
        WHERE (m.username = ? OR m.kode_operator = ?)
          AND m.status = 'Aktif' AND r.status = 'Aktif'
        LIMIT 1;
      `,
      args: [username, username],
    });
    if (result.rows.length > 0) {
      const row = result.rows[0] as unknown as Record<string, unknown>;
      const storedPassword = String(row.password_hash ?? "");
      const verification = await verifyPassword(passwordPlain, storedPassword);
      if (!verification.valid) {
        return {
          sukses: false as const,
          pesan: "Login gagal: Password / PIN salah.",
        };
      }
      let cachedPasswordHash = storedPassword;
      if (verification.needsUpgrade) {
        cachedPasswordHash = await hashPassword(passwordPlain);
        await db.execute({
          sql: "UPDATE master_operator SET password_hash = ? WHERE id = ?;",
          args: [cachedPasswordHash, Number(row.id)],
        });
      }

      const record = toOperatorRecord(row);
      const revisionResult = await db.execute(
        "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
      );
      const operator: AuthenticatedOperator = {
        ...record,
        permissions: await getPermissions(record.roleId, record.isSuperadmin),
        permissionRevision: Number(revisionResult.rows[0]?.value ?? 1),
      };
      saveOperatorToLocalCache({
        ...operator,
        passwordHash: cachedPasswordHash,
      });
      return {
        sukses: true as const,
        pesan: "Login berhasil.",
        operator,
      };
    }
  } catch (databaseError) {
    console.warn(
      "Database tidak dapat dijangkau, mencoba cache offline:",
      databaseError,
    );
  }

  const offlineMatch = await checkOfflineOperatorCache(username, passwordPlain);
  if (offlineMatch) {
    return {
      sukses: true as const,
      pesan: "Login berhasil menggunakan snapshot offline.",
      operator: offlineMatch,
    };
  }
  return {
    sukses: false as const,
    pesan: "Login gagal: Username atau Password tidak sesuai.",
  };
}

function saveOperatorToLocalCache(operator: CachedOperator) {
  if (typeof window === "undefined") return;
  try {
    const existing = localStorage.getItem(CACHED_OPERATORS_KEY);
    let list: CachedOperator[] = existing ? JSON.parse(existing) : [];
    list = list.filter((item) => item.username !== operator.username);
    list.push(operator);
    localStorage.setItem(CACHED_OPERATORS_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn("Gagal menyimpan snapshot operator lokal:", error);
  }
}

async function checkOfflineOperatorCache(username: string, password: string) {
  const candidates: CachedOperator[] = [];
  if (typeof window !== "undefined") {
    try {
      const existing = localStorage.getItem(CACHED_OPERATORS_KEY);
      if (existing)
        candidates.unshift(...(JSON.parse(existing) as CachedOperator[]));
    } catch (error) {
      console.warn("Gagal membaca snapshot operator lokal:", error);
    }
  }
  for (const candidate of candidates) {
    if (candidate.username !== username && candidate.kodeOperator !== username)
      continue;
    if ((await verifyPassword(password, candidate.passwordHash)).valid) {
      const { passwordHash: _, ...operator } = candidate;
      return operator;
    }
  }
  return null;
}
