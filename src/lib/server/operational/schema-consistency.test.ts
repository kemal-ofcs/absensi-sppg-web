import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";

mock.module("server-only", () => ({}));

import {
  CURRENT_SCHEMA_VERSION,
  initDatabaseSchema,
  isDatabaseSchemaReady,
  REQUIRED_TABLE_COUNT,
} from "@/lib/db-schema";

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
});

afterAll(() => client.close());

describe("Schema Consistency & Zero-Drift Guard", () => {
  test("inisialisasi skema lengkap menghasilkan seluruh tabel dan migrasi tanpa drift", async () => {
    await initDatabaseSchema(client);

    // 1. Cek jumlah tabel terdaftar
    const tablesRes = await client.execute(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'master_data', 'id_card', 'master_operator', 'tbl_shift',
        'setting_gex_system', 'log_scan', 'absensi_harian',
        'backup_karyawan', 'koreksi_admin', 'audit_absensi', 'app_role',
        'app_permission', 'role_permission', 'app_session',
        'auth_login_rate_limit', 'sync_operation_receipt',
        'sync_change_log', 'sync_changelog', 'app_bootstrap_state',
        'import_offline', 'tbl_hari_libur',
        'company_profile', 'id_card_template'
      );
    `);
    const tableCount = Number(tablesRes.rows[0]?.count ?? 0);
    expect(tableCount).toBe(REQUIRED_TABLE_COUNT);

    // 2. Cek schema_migration
    const migrationsRes = await client.execute(`
      SELECT MAX(version) AS max_version, COUNT(*) AS count FROM schema_migration;
    `);
    const maxMigrationVersion = Number(migrationsRes.rows[0]?.max_version ?? 0);

    // Assert: versi dan table count tidak boleh drift
    expect(CURRENT_SCHEMA_VERSION).toBe(maxMigrationVersion);
    expect(await isDatabaseSchemaReady(client)).toBe(true);
  });

  test("readOperationalSnapshot dapat membaca seluruh tabel snapshot tanpa error", async () => {
    const { readOperationalSnapshot } = await import(
      "@/lib/server/operational/snapshot"
    );
    const snapshot = await readOperationalSnapshot(client);
    expect(snapshot).toHaveProperty("revision");
    expect(snapshot).toHaveProperty("employees");
    expect(snapshot).toHaveProperty("idCards");
    expect(snapshot).toHaveProperty("shifts");
    expect(snapshot).toHaveProperty("holidays");
    expect(snapshot).toHaveProperty("settings");
    expect(snapshot).toHaveProperty("companyProfiles");
    expect(snapshot).toHaveProperty("idCardTemplates");
    expect(snapshot).toHaveProperty("backups");
    expect(snapshot).toHaveProperty("corrections");
    expect(snapshot).toHaveProperty("imports");
    expect(snapshot).toHaveProperty("attendance");
    expect(snapshot).toHaveProperty("scanLogs");
  });
});
