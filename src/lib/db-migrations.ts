import type { Client } from "@libsql/client";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from "@/lib/rbac/catalog";

const RBAC_MIGRATION_VERSION = 1;
const WEB_SESSION_MIGRATION_VERSION = 2;
const LOGIN_RATE_LIMIT_MIGRATION_VERSION = 3;
const OPERATIONAL_SYNC_MIGRATION_VERSION = 4;
const OFFLINE_IMPORT_MIGRATION_VERSION = 5;
const OPERATIONAL_COLUMNS_MIGRATION_VERSION = 6;

const SYSTEM_ROLES = [
  {
    key: "superadmin",
    name: "Superadmin",
    description: "Pemilik akses penuh dan pengelola role aplikasi.",
    isSuperadmin: 1,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Administrator operasional sesuai matriks permission.",
    isSuperadmin: 0,
  },
  {
    key: "operator",
    name: "Operator",
    description: "Operator harian sesuai matriks permission.",
    isSuperadmin: 0,
  },
  {
    key: "scanner",
    name: "Scanner",
    description: "Petugas terminal QR sesuai matriks permission.",
    isSuperadmin: 0,
  },
] as const;

async function hasTable(client: Client, table: string) {
  const result = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = ?;",
    args: [table],
  });
  return Number(result.rows[0]?.cnt ?? 0) > 0;
}

async function hasColumn(client: Client, table: string, column: string) {
  if (!(await hasTable(client, table))) return true; // table will be created with all columns
  const result = await client.execute(`PRAGMA table_info(${table});`);
  return result.rows.some((row) => String(row.name) === column);
}

export async function runDatabaseMigrations(client: Client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_role (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_key TEXT UNIQUE NOT NULL,
      nama_role TEXT UNIQUE NOT NULL,
      deskripsi TEXT,
      is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0, 1)),
      is_superadmin INTEGER NOT NULL DEFAULT 0 CHECK(is_superadmin IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'Aktif' CHECK(status IN ('Aktif', 'Nonaktif')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_permission (
      permission_key TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      grup TEXT NOT NULL,
      deskripsi TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS role_permission (
      role_id INTEGER NOT NULL,
      permission_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 0 CHECK(is_allowed IN (0, 1)),
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (role_id, permission_key),
      FOREIGN KEY (role_id) REFERENCES app_role(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_key) REFERENCES app_permission(permission_key) ON DELETE CASCADE
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS role_permission_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL,
      permission_key TEXT NOT NULL,
      before_allowed INTEGER NOT NULL,
      after_allowed INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_session (
      session_id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      operator_id INTEGER NOT NULL,
      permission_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      user_agent_hash TEXT,
      FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS auth_login_rate_limit (
      rate_key TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL,
      window_started_at TEXT NOT NULL,
      blocked_until TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sync_operation_receipt (
      event_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      operation TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('applied', 'rejected', 'conflict')),
      result_json TEXT NOT NULL,
      base_revision INTEGER,
      server_revision INTEGER,
      actor_operator_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sync_change_log (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      actor_operator_id INTEGER NOT NULL
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS import_offline (
      id_import INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT UNIQUE NOT NULL,
      timestamp_input TEXT NOT NULL,
      tanggal DATE NOT NULL,
      id_unik TEXT NOT NULL,
      nama TEXT,
      divisi TEXT,
      jam_masuk TEXT,
      jam_pulang TEXT,
      status_kehadiran TEXT,
      status_absen TEXT,
      keterangan TEXT,
      status_proses TEXT NOT NULL DEFAULT 'Belum Diproses',
      diproses_pada TEXT,
      pesan_error TEXT,
      kode_operator TEXT
    );
  `);

  if (!(await hasColumn(client, "master_operator", "role_id"))) {
    await client.execute(
      "ALTER TABLE master_operator ADD COLUMN role_id INTEGER;",
    );
  }

  const now = new Date().toISOString();
  for (const role of SYSTEM_ROLES) {
    await client.execute({
      sql: `
        INSERT OR IGNORE INTO app_role (
          role_key, nama_role, deskripsi, is_system, is_superadmin,
          status, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, 1, ?, 'Aktif', ?, ?, 'migration');
      `,
      args: [
        role.key,
        role.name,
        role.description,
        role.isSuperadmin,
        now,
        now,
      ],
    });
  }

  for (const [index, permission] of PERMISSION_CATALOG.entries()) {
    await client.execute({
      sql: `
        INSERT INTO app_permission (
          permission_key, nama, grup, deskripsi, is_active, sort_order
        ) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(permission_key) DO UPDATE SET
          nama = excluded.nama,
          grup = excluded.grup,
          deskripsi = excluded.deskripsi,
          sort_order = excluded.sort_order;
      `,
      args: [
        permission.key,
        permission.name,
        permission.group,
        `Akses ${permission.name.toLocaleLowerCase("id-ID")}.`,
        index + 1,
      ],
    });
  }

  await client.execute(`
    UPDATE master_operator
    SET role_id = (
      SELECT id FROM app_role
      WHERE role_key = LOWER(master_operator.role)
    )
    WHERE role_id IS NULL;
  `);

  for (const [roleKey, permissionKeys] of Object.entries(
    DEFAULT_ROLE_PERMISSIONS,
  )) {
    const roleResult = await client.execute({
      sql: "SELECT id FROM app_role WHERE role_key = ? LIMIT 1;",
      args: [roleKey],
    });
    const roleId = Number(roleResult.rows[0]?.id);
    if (!Number.isSafeInteger(roleId)) continue;

    for (const permissionKey of permissionKeys) {
      await client.execute({
        sql: `
          INSERT OR IGNORE INTO role_permission (
            role_id, permission_key, is_allowed, updated_at, updated_by
          ) VALUES (?, ?, 1, ?, 'migration');
        `,
        args: [roleId, permissionKey, now],
      });
    }
  }

  await client.execute(`
    INSERT OR IGNORE INTO setting_gex_system (key, value)
    VALUES ('rbac_revision', '1');
  `);

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
      VALUES (?, 'dynamic-rbac-foundation', ?);
    `,
    args: [RBAC_MIGRATION_VERSION, now],
  });

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
      VALUES (?, 'web-session-foundation', ?);
    `,
    args: [WEB_SESSION_MIGRATION_VERSION, now],
  });

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
      VALUES (?, 'login-rate-limit', ?);
    `,
    args: [LOGIN_RATE_LIMIT_MIGRATION_VERSION, now],
  });

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
      VALUES (?, 'operational-sync-foundation', ?);
    `,
    args: [OPERATIONAL_SYNC_MIGRATION_VERSION, now],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'offline-import-foundation', ?);`,
    args: [OFFLINE_IMPORT_MIGRATION_VERSION, now],
  });

  if (!(await hasColumn(client, "tbl_shift", "izinkan_multi_sesi"))) {
    await client.execute(
      "ALTER TABLE tbl_shift ADD COLUMN izinkan_multi_sesi INTEGER DEFAULT 0;",
    );
  }

  if (!(await hasColumn(client, "absensi_harian", "mode_tugas"))) {
    await client.execute(
      "ALTER TABLE absensi_harian ADD COLUMN mode_tugas TEXT DEFAULT 'NORMAL';",
    );
  }
  if (!(await hasColumn(client, "absensi_harian", "id_backup"))) {
    await client.execute(
      "ALTER TABLE absensi_harian ADD COLUMN id_backup TEXT;",
    );
  }
  if (!(await hasColumn(client, "absensi_harian", "id_karyawan_asal"))) {
    await client.execute(
      "ALTER TABLE absensi_harian ADD COLUMN id_karyawan_asal TEXT;",
    );
  }
  if (!(await hasColumn(client, "absensi_harian", "tanggal_tugas"))) {
    await client.execute(
      "ALTER TABLE absensi_harian ADD COLUMN tanggal_tugas DATE;",
    );
  }
  if (!(await hasColumn(client, "master_data", "status_backup"))) {
    await client.execute(
      "ALTER TABLE master_data ADD COLUMN status_backup TEXT DEFAULT 'NORMAL';",
    );
  }

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'operational-columns-foundation', ?);`,
    args: [OPERATIONAL_COLUMNS_MIGRATION_VERSION, now],
  });

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_master_operator_role_id ON master_operator(role_id);",
  );

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_role_permission_role ON role_permission(role_id, is_allowed);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_app_session_operator_active ON app_session(operator_id, revoked_at, expires_at);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_auth_login_rate_limit_blocked ON auth_login_rate_limit(blocked_until);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_sync_receipt_client_status ON sync_operation_receipt(client_id, status, processed_at);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_sync_change_domain_revision ON sync_change_log(domain, revision);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_import_offline_status ON import_offline(status_proses, timestamp_input);",
  );
}
