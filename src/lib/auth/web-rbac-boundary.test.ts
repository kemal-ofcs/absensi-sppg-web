import { describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { canAccessArea } from "@/lib/auth/access";
import {
  checkLoginRateLimit,
  consumeLoginAttempt,
  recordLoginFailure,
} from "@/lib/auth/login-rate-limit";
import type { OperatorUser } from "@/lib/auth/operator-user";
import {
  AuthorizationError,
  assertActorPermission,
} from "@/lib/auth/permission-assertion";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import {
  createSessionRecord,
  readSessionRecord,
} from "@/lib/auth/session-store";
import { WEB_SESSION_TTL_SECONDS } from "@/lib/auth/web-session";
import { initDatabaseSchema } from "@/lib/db-schema";
import { editOperator } from "@/lib/operators/operator-admin";
import { SUPERADMIN_ONLY_PERMISSIONS } from "@/lib/rbac/catalog";
import { replaceRolePermissions } from "@/lib/rbac/role-admin";
import { IZIN_PERHATIAN, izinPerhatian } from "@/lib/validations/telegram";
import { IZIN_PENGATURAN, IZIN_UNDUH } from "@/lib/validations/transfer";

interface Fixture {
  client: Client;
  superadmin: OperatorUser;
  admin: OperatorUser;
}

async function createFixture(): Promise<Fixture> {
  const client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
  const roles = await client.execute(
    "SELECT id, role_key, nama_role, is_superadmin FROM app_role;",
  );
  const superRole = roles.rows.find((row) => row.role_key === "superadmin");
  const adminRole = roles.rows.find((row) => row.role_key === "admin");
  if (!superRole || !adminRole) throw new Error("Fixture role tidak tersedia.");
  await client.execute({
    sql: `
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, email, no_hp,
        password_hash, role, role_id, status
      ) VALUES
        ('SPD_TEST', 'Superadmin Test', 'super-test', 'super-test@sppg.id', '+6281200000001', 'unused', 'Operator', ?, 'Aktif'),
        ('ADM_TEST', 'Admin Test', 'admin-test', 'admin-test@sppg.id', '+6281200000002', 'unused', 'Admin', ?, 'Aktif');
    `,
    args: [Number(superRole.id), Number(adminRole.id)],
  });
  const operators = await client.execute(
    "SELECT id, kode_operator, role_id FROM master_operator ORDER BY id;",
  );
  const superRow = operators.rows.find(
    (row) => row.kode_operator === "SPD_TEST",
  );
  const adminRow = operators.rows.find(
    (row) => row.kode_operator === "ADM_TEST",
  );
  if (!superRow || !adminRow) throw new Error("Fixture operator gagal dibuat.");

  return {
    client,
    superadmin: {
      id: Number(superRow.id),
      kode_operator: "SPD_TEST",
      nama_operator: "Superadmin Test",
      username: "super-test",
      role: String(superRole.nama_role),
      roleId: Number(superRow.role_id),
      roleKey: "superadmin",
      isSuperadmin: true,
      permissions: ["operators.view", "operators.manage", "roles.manage"],
      permissionRevision: 1,
    },
    admin: {
      id: Number(adminRow.id),
      kode_operator: "ADM_TEST",
      nama_operator: "Admin Test",
      username: "admin-test",
      role: String(adminRole.nama_role),
      roleId: Number(adminRow.role_id),
      roleKey: "admin",
      isSuperadmin: false,
      permissions: ["home.view"],
      permissionRevision: 1,
    },
  };
}

describe("Web RBAC trusted boundary", () => {
  test("direct call guest dan role tanpa permission ditolak", () => {
    expect(() => assertActorPermission(null, "operators.view", true)).toThrow(
      AuthorizationError,
    );
    try {
      assertActorPermission(null, "operators.view", true);
    } catch (error) {
      expect((error as AuthorizationError).status).toBe(401);
    }

    const admin: OperatorUser = {
      id: 9,
      kode_operator: "ADM009",
      nama_operator: "Admin",
      username: "admin9",
      role: "Admin",
      roleId: 2,
      roleKey: "admin",
      isSuperadmin: false,
      permissions: ["home.view"],
      permissionRevision: 1,
    };
    expect(() =>
      assertActorPermission(admin, "operators.manage", true),
    ).toThrow(AuthorizationError);
    try {
      assertActorPermission(admin, "operators.manage", true);
    } catch (error) {
      expect((error as AuthorizationError).status).toBe(403);
    }
  });

  test("origin publik tetap valid saat URL internal memakai localhost", () => {
    expect(
      isSameOriginRequest(
        new Request("http://localhost:3000/api/operators", {
          headers: {
            origin: "https://absensi.example.com",
            host: "localhost:3000",
            "x-forwarded-host": "absensi.example.com",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe(true);

    expect(
      isSameOriginRequest(
        new Request("http://localhost:3000/api/operators", {
          headers: {
            origin: "https://evil.example",
            "x-forwarded-host": "absensi.example.com",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe(false);

    expect(
      isSameOriginRequest(new Request("http://localhost:3000/api/operators")),
    ).toBe(false);
  });

  test("session kedaluwarsa dan operator nonaktif tidak dapat dipakai", async () => {
    const { client, admin } = await createFixture();
    try {
      const now = new Date("2026-08-09T00:00:00.000Z");
      const expired = await createSessionRecord(client, admin, "test", now);
      expect(
        await readSessionRecord(
          client,
          expired.token,
          new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * 1_000 + 1),
        ),
      ).toBeNull();

      const active = await createSessionRecord(client, admin, "test", now);
      await client.execute({
        sql: "UPDATE master_operator SET status = 'Nonaktif' WHERE id = ?;",
        args: [admin.id],
      });
      expect(await readSessionRecord(client, active.token, now)).toBeNull();
    } finally {
      client.close();
    }
  });

  test("Superadmin aktif terakhir tidak dapat diturunkan", async () => {
    const { client, superadmin, admin } = await createFixture();
    try {
      await expect(
        editOperator(client, admin.id, superadmin.id, {
          kodeOperator: superadmin.kode_operator,
          name: superadmin.nama_operator,
          username: superadmin.username,
          email: "super-test@sppg.id",
          noHp: "+6281200000001",
          password: "",
          roleId: admin.roleId,
          status: "Aktif",
        }),
      ).rejects.toThrow("Superadmin aktif terakhir");
    } finally {
      client.close();
    }
  });

  test("perubahan permission mencabut session role terkait", async () => {
    const { client, superadmin, admin } = await createFixture();
    try {
      const session = await createSessionRecord(client, admin, "test");
      await replaceRolePermissions(client, superadmin.id, admin.roleId, [
        "home.view",
      ]);
      expect(await readSessionRecord(client, session.token)).toBeNull();
      const audit = await client.execute({
        sql: "SELECT COUNT(*) AS total FROM role_permission_audit WHERE role_id = ?;",
        args: [admin.roleId],
      });
      expect(Number(audit.rows[0]?.total)).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test("lima kegagalan login mengaktifkan rate limit persisten", async () => {
    const { client } = await createFixture();
    try {
      const now = new Date("2026-08-09T01:00:00.000Z");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await recordLoginFailure(client, "203.0.113.10", "unknown-user", now);
      }
      const result = await checkLoginRateLimit(
        client,
        "203.0.113.10",
        "unknown-user",
        now,
      );
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test("reservasi login atomik menolak percobaan setelah batas", async () => {
    const { client } = await createFixture();
    try {
      const now = new Date("2026-08-09T01:00:00.000Z");
      const results = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        results.push(
          await consumeLoginAttempt(
            client,
            "203.0.113.11",
            "parallel-user",
            now,
          ),
        );
      }
      expect(results.slice(0, 5).every((result) => result.allowed)).toBe(true);
      expect(results[5]?.allowed).toBe(false);
    } finally {
      client.close();
    }
  });

  // HRIS fase 6 (§21.8): `view`/`assess` rahasia dan `finalize` sensitif tidak
  // ikut paket Admin; HRD memegang keempatnya, Atasan hanya `assess`.
  test("izin penilaian kinerja: paket bawaan dan area pengajuan", async () => {
    const { client } = await createFixture();
    try {
      const izin = async (roleKey: string) =>
        (
          await client.execute({
            sql: `SELECT rp.permission_key FROM role_permission rp JOIN app_role r ON r.id = rp.role_id
                  WHERE r.role_key = ?1 AND rp.permission_key LIKE 'hr.performance.%' AND rp.is_allowed = 1
                  ORDER BY rp.permission_key;`,
            args: [roleKey],
          })
        ).rows.map((row) => String(row.permission_key));
      expect(await izin("admin")).toEqual(["hr.performance.config"]);
      expect(await izin("hrd")).toEqual([
        "hr.performance.assess",
        "hr.performance.config",
        "hr.performance.finalize",
        "hr.performance.view",
      ]);
      expect(await izin("atasan")).toEqual(["hr.performance.assess"]);

      expect(
        canAccessArea(
          { isSuperadmin: false, permissions: ["hr.performance.assess"] },
          "pengajuan",
        ),
      ).toBe(true);
      expect(
        canAccessArea(
          { isSuperadmin: false, permissions: ["home.view"] },
          "pengajuan",
        ),
      ).toBe(false);
      const atasan = {
        id: 9,
        username: "atasan",
        isSuperadmin: false,
        permissions: ["hr.performance.assess"],
      };
      expect(() =>
        assertActorPermission(
          atasan as unknown as OperatorUser,
          "hr.performance.finalize",
          true,
        ),
      ).toThrow(AuthorizationError);

      // Kartu "Perlu perhatian" bagian Kinerja (§24.6, Q-122): paket HRD
      // membukanya, Atasan (`assess` saja) dan Admin (`config`) tidak.
      const kinerja = async (roleKey: string) => {
        const punya = await izin(roleKey);
        return izinPerhatian((p) => punya.includes(p)).kinerja;
      };
      expect(await kinerja("hrd")).toBe(true);
      expect(await kinerja("atasan")).toBe(false);
      expect(await kinerja("admin")).toBe(false);
      expect(IZIN_PERHATIAN).toContain("hr.performance.view");
      expect(IZIN_PERHATIAN).toContain("hr.performance.finalize");
    } finally {
      client.close();
    }
  });

  // HRIS fase 7 (§22.8): rekrutmen rahasia dan hapus pelamar sensitif tidak
  // ikut paket Admin; pelatihan ikut. HRD memegang kelimanya, Atasan tidak ada.
  test("izin rekrutmen dan pelatihan: paket bawaan", async () => {
    const { client } = await createFixture();
    try {
      const izin = async (roleKey: string) =>
        (
          await client.execute({
            sql: `SELECT rp.permission_key FROM role_permission rp JOIN app_role r ON r.id = rp.role_id
                  WHERE r.role_key = ?1 AND (rp.permission_key LIKE 'hr.recruit.%' OR rp.permission_key LIKE 'hr.training.%') AND rp.is_allowed = 1
                  ORDER BY rp.permission_key;`,
            args: [roleKey],
          })
        ).rows.map((row) => String(row.permission_key));
      expect(await izin("admin")).toEqual([
        "hr.training.manage",
        "hr.training.view",
      ]);
      expect(await izin("hrd")).toEqual([
        "hr.recruit.delete",
        "hr.recruit.manage",
        "hr.recruit.view",
        "hr.training.manage",
        "hr.training.view",
      ]);
      expect(await izin("atasan")).toEqual([]);
      const hrd = {
        id: 9,
        username: "hrd",
        isSuperadmin: false,
        permissions: ["hr.recruit.manage"],
      };
      expect(() =>
        assertActorPermission(
          hrd as unknown as OperatorUser,
          "hr.recruit.delete",
          true,
        ),
      ).toThrow(AuthorizationError);
    } finally {
      client.close();
    }
  });

  // HRIS fase 12 (§27.5): unduh berkas transfer wajib KEDUA izin (Q-157 (a));
  // tidak ada paket bawaan yang memegang keduanya, dan Pengaturan transfer
  // (`payroll.config.manage`) khusus Superadmin (Q-173 (a)).
  test("izin berkas transfer: kedua izin unduh, Pengaturan khusus Superadmin", async () => {
    const { client } = await createFixture();
    try {
      const pemegang = async (izin: string) =>
        (
          await client.execute({
            sql: `SELECT r.role_key FROM role_permission rp JOIN app_role r ON r.id = rp.role_id
                  WHERE rp.permission_key = ?1 AND rp.is_allowed = 1 ORDER BY r.role_key;`,
            args: [izin],
          })
        ).rows.map((row) => String(row.role_key));
      expect(await pemegang("payroll.run.disburse")).toEqual(["admin"]);
      expect(await pemegang("hr.finance.view")).toEqual(["hrd"]);
      expect(await pemegang(IZIN_PENGATURAN)).toEqual([]);
      expect(SUPERADMIN_ONLY_PERMISSIONS.has(IZIN_PENGATURAN)).toBe(true);

      const aktor = (permissions: string[]) =>
        ({
          id: 9,
          username: "uji",
          isSuperadmin: false,
          permissions,
        }) as unknown as OperatorUser;
      const bolehUnduh = (actor: OperatorUser) => {
        for (const izin of IZIN_UNDUH) assertActorPermission(actor, izin);
      };
      expect(() => bolehUnduh(aktor(["payroll.run.disburse"]))).toThrow(
        AuthorizationError,
      );
      expect(() => bolehUnduh(aktor(["hr.finance.view"]))).toThrow(
        AuthorizationError,
      );
      expect(() => bolehUnduh(aktor([...IZIN_UNDUH]))).not.toThrow();
      expect(() =>
        assertActorPermission(aktor([...IZIN_UNDUH]), IZIN_PENGATURAN),
      ).toThrow(AuthorizationError);
    } finally {
      client.close();
    }
  });
});
