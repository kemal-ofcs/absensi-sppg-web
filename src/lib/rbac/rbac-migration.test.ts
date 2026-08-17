import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import {
  hashPassword,
  hashVerifiedPasswordForUpgrade,
  verifyPassword,
} from "@/lib/auth/password";
import { runDatabaseMigrations } from "@/lib/db-migrations";
import { initDatabaseSchema, isDatabaseSchemaReady } from "@/lib/db-schema";
import {
  DEFAULT_ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await client.execute(`
    CREATE TABLE master_operator (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kode_operator TEXT UNIQUE NOT NULL,
      nama_operator TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('Admin', 'Operator', 'Scanner')),
      status TEXT DEFAULT 'Aktif'
    );
  `);
  await client.execute(`
    CREATE TABLE setting_gex_system (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await client.execute(`
    INSERT INTO master_operator (
      kode_operator, nama_operator, username, password_hash, role, status
    ) VALUES ('OP001', 'Admin Lama', 'admin', 'legacy-password', 'Admin', 'Aktif');
  `);
});

afterAll(() => client.close());

describe("dynamic RBAC migration", () => {
  test("mendeteksi skema siap agar request berikutnya melewati migrasi", async () => {
    await initDatabaseSchema(client);
    expect(await isDatabaseSchemaReady(client)).toBe(true);
    await initDatabaseSchema(client);
  });

  test("migrasi idempotent dan mempertahankan operator lama", async () => {
    await runDatabaseMigrations(client);
    await runDatabaseMigrations(client);

    const roles = await client.execute(
      "SELECT role_key FROM app_role ORDER BY role_key;",
    );
    expect(roles.rows.map((row) => String(row.role_key))).toEqual([
      "admin",
      "operator",
      "scanner",
      "superadmin",
    ]);

    const operator = await client.execute(`
      SELECT m.kode_operator, r.role_key
      FROM master_operator m
      JOIN app_role r ON r.id = m.role_id
      WHERE m.kode_operator = 'OP001';
    `);
    expect(operator.rows[0]).toMatchObject({
      kode_operator: "OP001",
      role_key: "admin",
    });

    const permissionCount = await client.execute(`
      SELECT COUNT(*) AS total
      FROM role_permission rp
      JOIN app_role r ON r.id = rp.role_id
      WHERE r.role_key = 'scanner' AND rp.is_allowed = 1;
    `);
    expect(Number(permissionCount.rows[0]?.total)).toBe(3);

    const migrations = await client.execute(
      "SELECT version FROM schema_migration ORDER BY version;",
    );
    expect(migrations.rows.map((row) => Number(row.version))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);

    const sessionColumns = await client.execute(
      "PRAGMA table_info(app_session);",
    );
    expect(sessionColumns.rows.map((row) => String(row.name))).toEqual(
      expect.arrayContaining([
        "session_id",
        "token_hash",
        "operator_id",
        "expires_at",
        "revoked_at",
      ]),
    );
  });

  test("permission khusus Superadmin tidak masuk default role lain", () => {
    for (const permissions of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      expect(
        permissions.some((permission) =>
          SUPERADMIN_ONLY_PERMISSIONS.has(permission),
        ),
      ).toBe(false);
    }
  });
});

describe("password hashing", () => {
  test("memverifikasi PBKDF2 dan mengenali password legacy", async () => {
    const password = "PasswordAman2026";
    const stored = await hashPassword(password);

    expect(await verifyPassword(password, stored)).toEqual({
      valid: true,
      needsUpgrade: false,
    });
    expect((await verifyPassword("PasswordSalah1", stored)).valid).toBe(false);
    expect(await verifyPassword("legacy-password", "legacy-password")).toEqual({
      valid: true,
      needsUpgrade: true,
    });
    const upgraded = await hashVerifiedPasswordForUpgrade("legacy-password");
    expect(await verifyPassword("legacy-password", upgraded)).toEqual({
      valid: true,
      needsUpgrade: false,
    });
  });
});

describe("production schema initialization", () => {
  test("tidak membuat operator default legacy", async () => {
    const productionClient = createClient({ url: "file::memory:" });
    try {
      await initDatabaseSchema(productionClient);
      const operators = await productionClient.execute(
        "SELECT COUNT(*) AS total FROM master_operator;",
      );
      expect(Number(operators.rows[0]?.total)).toBe(0);
    } finally {
      productionClient.close();
    }
  });
});
