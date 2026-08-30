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
const HOLIDAY_MIGRATION_VERSION = 7;
const COMPANY_PROFILE_AND_TEMPLATE_MIGRATION_VERSION = 8;
const TWO_TIER_SECURITY_MIGRATION_VERSION = 9;
const PAYROLL_MIGRATION_VERSION = 10;
const OPERATOR_CONTACT_AND_RESET_MIGRATION_VERSION = 11;
const TWO_FACTOR_MIGRATION_VERSION = 12;

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
      require_totp INTEGER NOT NULL DEFAULT 0,
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

  // Permintaan "Lupa Password". Cloud-only (tidak ikut SNAPSHOT_TABLES):
  // berisi bukti foto liveness dan hash token reset yang tidak boleh
  // direplikasi ke SQLite lokal setiap perangkat.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS password_reset_request (
      id TEXT PRIMARY KEY,
      operator_id INTEGER NOT NULL,
      identifier_used TEXT NOT NULL,
      contact_channel TEXT NOT NULL DEFAULT 'email',
      contact_target TEXT NOT NULL,
      challenge_hash TEXT NOT NULL,
      challenge_sequence TEXT NOT NULL,
      token_hash TEXT,
      status TEXT NOT NULL DEFAULT 'Menunggu Verifikasi'
        CHECK(status IN (
          'Menunggu Verifikasi', 'Terkirim', 'Terpakai', 'Kedaluwarsa', 'Dibatalkan'
        )),
      liveness_score REAL,
      liveness_report TEXT,
      photo_mime TEXT,
      photo_base64 TEXT,
      delivery_status TEXT,
      delivery_error TEXT,
      requested_at TEXT NOT NULL,
      verified_at TEXT,
      sent_at TEXT,
      used_at TEXT,
      expires_at TEXT NOT NULL,
      request_ip_hash TEXT,
      user_agent_hash TEXT,
      FOREIGN KEY (operator_id) REFERENCES master_operator(id) ON DELETE CASCADE
    );
  `);

  // Konfigurasi pengirim email (HTTP API). Cloud-only dan tidak pernah
  // di-snapshot: kunci API tidak boleh mendarat di SQLite tiap perangkat.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_mail_config (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'resend'
        CHECK(provider IN ('resend', 'brevo')),
      api_key TEXT,
      sender_email TEXT,
      sender_name TEXT,
      reset_base_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
      updated_at TEXT NOT NULL,
      updated_by TEXT
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
      receipt_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sync_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      event_id TEXT UNIQUE NOT NULL,
      domain TEXT NOT NULL,
      operation TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_bootstrap_state (
      bootstrap_key TEXT PRIMARY KEY,
      claimed_at TEXT NOT NULL
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

  // Kontak operator: wajib diisi lewat validasi aplikasi, tetapi NULL-able di
  // DDL supaya baris operator lama tidak rusak saat migrasi berjalan. Kolom ini
  // dipakai fitur "Lupa Password" untuk mengirim link reset.
  if (!(await hasColumn(client, "master_operator", "role_id"))) {
    await client.execute(
      "ALTER TABLE master_operator ADD COLUMN role_id INTEGER;",
    );
  }

  // Kolom di bawah dibuat oleh jalur provisioning Rust (`turso.rs`) tetapi dulu
  // tidak ada di jalur Web. Database yang di-provisioning dari Web membuat
  // Desktop/Mobile gagal: `authenticate_operator` menulis `updated_at` saat
  // meng-upgrade hash lama, dan seed tarif payroll menulis `created_at`.
  // Keduanya sekarang saling menyusul lewat migrasi idempoten ini.
  for (const [table, column, alterSql] of [
    [
      "master_operator",
      "created_at",
      "ALTER TABLE master_operator ADD COLUMN created_at TEXT;",
    ],
    [
      "master_operator",
      "email",
      "ALTER TABLE master_operator ADD COLUMN email TEXT;",
    ],
    [
      "master_operator",
      "no_hp",
      "ALTER TABLE master_operator ADD COLUMN no_hp TEXT;",
    ],
    // Verifikasi dua langkah. `totp_enabled` sengaja tanpa CHECK: SQLite
    // membatasi bentuk constraint pada ALTER TABLE ADD COLUMN, dan menaruh CHECK
    // hanya di CREATE TABLE akan membuat database hasil migrasi berbeda dari
    // database baru — persis drift yang dilarang di sini.
    [
      "master_operator",
      "totp_secret",
      "ALTER TABLE master_operator ADD COLUMN totp_secret TEXT;",
    ],
    [
      "master_operator",
      "totp_enabled",
      "ALTER TABLE master_operator ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;",
    ],
    [
      "master_operator",
      "totp_confirmed_at",
      "ALTER TABLE master_operator ADD COLUMN totp_confirmed_at TEXT;",
    ],
    [
      "master_operator",
      "totp_recovery_codes",
      "ALTER TABLE master_operator ADD COLUMN totp_recovery_codes TEXT;",
    ],
    [
      "app_role",
      "require_totp",
      "ALTER TABLE app_role ADD COLUMN require_totp INTEGER NOT NULL DEFAULT 0;",
    ],
    [
      "master_operator",
      "updated_at",
      "ALTER TABLE master_operator ADD COLUMN updated_at TEXT;",
    ],
    [
      "tax_rules",
      "created_at",
      "ALTER TABLE tax_rules ADD COLUMN created_at TEXT;",
    ],
    [
      "bpjs_rules",
      "created_at",
      "ALTER TABLE bpjs_rules ADD COLUMN created_at TEXT;",
    ],
    [
      "payroll_components",
      "created_at",
      "ALTER TABLE payroll_components ADD COLUMN created_at TEXT;",
    ],
  ] as const) {
    if (
      (await hasTable(client, table)) &&
      !(await hasColumn(client, table, column))
    ) {
      await client.execute(alterSql);
    }
  }

  const now = new Date().toISOString();

  if (!(await hasColumn(client, "sync_operation_receipt", "receipt_json"))) {
    await client.execute(
      "ALTER TABLE sync_operation_receipt ADD COLUMN receipt_json TEXT NOT NULL DEFAULT '{}';",
    );
  }
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

  if (!(await hasColumn(client, "tbl_shift", "shift_lanjutan_id"))) {
    await client.execute(
      "ALTER TABLE tbl_shift ADD COLUMN shift_lanjutan_id INTEGER DEFAULT 0;",
    );
  }
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

  await client.execute(`
    CREATE TABLE IF NOT EXISTS tbl_hari_libur (
      id_libur INTEGER PRIMARY KEY AUTOINCREMENT,
      tanggal DATE UNIQUE NOT NULL,
      nama_libur TEXT NOT NULL,
      jenis_libur TEXT DEFAULT 'Libur Nasional',
      keterangan TEXT,
      status_aktif INTEGER DEFAULT 1
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hari_libur_tanggal ON tbl_hari_libur(tanggal, status_aktif);",
  );

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'holiday-management-foundation', ?);`,
    args: [HOLIDAY_MIGRATION_VERSION, now],
  });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS company_profile (
      id TEXT PRIMARY KEY DEFAULT 'default_company',
      company_name TEXT NOT NULL DEFAULT 'SPPG',
      branch_name TEXT,
      logo_url TEXT,
      signature_url TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      leader_name TEXT,
      leader_title TEXT,
      leader_nip TEXT,
      card_terms TEXT,
      timezone TEXT DEFAULT 'Asia/Jakarta',
      updated_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS id_card_template (
      id TEXT PRIMARY KEY DEFAULT 'default_template',
      name TEXT NOT NULL DEFAULT 'Template Default SPPG',
      orientation TEXT NOT NULL DEFAULT 'landscape',
      front_bg_url TEXT,
      back_bg_url TEXT,
      elements_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const defaultTerms = `1. Kartu ini adalah tanda pengenal resmi karyawan/personil SPPG.
2. Wajib dibawa dan dipindai (scan QR) setiap hadir dan pulang kerja.
3. Dilarang memindahtangankan atau meminjamkan kartu ini kepada pihak lain.
4. Apabila kartu hilang atau menemukan kartu ini, harap segera melapor ke Bagian SDM/Operasional SPPG.`;

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO company_profile (
        id, company_name, branch_name, logo_url, signature_url,
        address, phone, email, website,
        leader_name, leader_title, leader_nip,
        card_terms, timezone, updated_at
      ) VALUES (
        'default_company', 'SPPG', 'Pusat Operasional', NULL, NULL,
        'Jl. Sudirman No. 123, Jakarta', '021-5550123', 'info@sppg.id', 'https://sppg.id',
        'Dr. H. Ahmad Fauzi, M.M.', 'Kepala SPPG', '19750815 200003 1 002',
        ?, 'Asia/Jakarta', ?
      );
    `,
    args: [defaultTerms, now],
  });

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'company-profile-and-id-card-template-foundation', ?);`,
    args: [COMPANY_PROFILE_AND_TEMPLATE_MIGRATION_VERSION, now],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'two-tier-security-and-atomic-sync', ?);`,
    args: [TWO_TIER_SECURITY_MIGRATION_VERSION, now],
  });

  // Payroll Engine Tables Migration
  await client.execute(`
    CREATE TABLE IF NOT EXISTS salary_configs (
      id TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      rate_per_hour INTEGER NOT NULL CHECK (rate_per_hour >= 0),
      ptkp_status TEXT NOT NULL DEFAULT 'TK/0'
        CHECK (ptkp_status IN ('TK/0','TK/1','TK/2','TK/3','K/0','K/1','K/2','K/3')),
      effective_date TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(id_karyawan, effective_date)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS overtime_tier_rules (
      id TEXT PRIMARY KEY,
      rule_type TEXT NOT NULL CHECK (rule_type IN ('HARI_KERJA', 'HARI_LIBUR')),
      tier_order INTEGER NOT NULL,
      hour_start REAL NOT NULL CHECK (hour_start >= 0),
      hour_end REAL,
      multiplier REAL NOT NULL CHECK (multiplier >= 1.0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      UNIQUE(rule_type, tier_order)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS payroll_components (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('ALLOWANCE', 'DEDUCTION')),
      calc_type TEXT NOT NULL CHECK (calc_type IN ('FIXED', 'PERCENTAGE')),
      default_value REAL NOT NULL DEFAULT 0 CHECK (default_value >= 0),
      applies_to TEXT NOT NULL DEFAULT 'ALL',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('TER_A','TER_B','TER_C','PASAL_17')),
      bracket_min INTEGER NOT NULL,
      bracket_max INTEGER,
      rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
      effective_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS bpjs_rules (
      id TEXT PRIMARY KEY,
      component_code TEXT NOT NULL UNIQUE,
      component_name TEXT NOT NULL,
      rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
      wage_cap INTEGER,
      effective_date TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','SUBMITTED','REVIEWED','APPROVED','PAID','REJECTED')),
      total_gross_payout INTEGER NOT NULL DEFAULT 0,
      total_net_payout INTEGER NOT NULL DEFAULT 0,
      total_employees INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS payroll_items (
      id TEXT PRIMARY KEY,
      payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      id_karyawan TEXT NOT NULL,
      nama_karyawan TEXT NOT NULL,
      divisi TEXT NOT NULL,
      ptkp_status TEXT NOT NULL DEFAULT 'TK/0',
      total_regular_hours REAL NOT NULL,
      total_overtime_hours REAL NOT NULL,
      total_overtime_index REAL NOT NULL,
      rate_per_hour INTEGER NOT NULL,
      basic_salary INTEGER NOT NULL CHECK (basic_salary >= 0),
      overtime_salary INTEGER NOT NULL CHECK (overtime_salary >= 0),
      gross_salary INTEGER NOT NULL CHECK (gross_salary >= 0),
      total_allowances INTEGER NOT NULL DEFAULT 0,
      total_deductions INTEGER NOT NULL DEFAULT 0,
      bpjs_employee_total INTEGER NOT NULL DEFAULT 0,
      bpjs_company_total INTEGER NOT NULL DEFAULT 0,
      pph21_amount INTEGER NOT NULL DEFAULT 0,
      net_salary INTEGER NOT NULL CHECK (net_salary >= 0),
      breakdown_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (payroll_run_id, id_karyawan)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS payroll_audit_logs (
      id TEXT PRIMARY KEY,
      payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      performed_by TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Default Overtime Tiers (PP 35/2021)
  await client.execute(`
    INSERT OR IGNORE INTO overtime_tier_rules (id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active)
    VALUES
      ('ot-work-1', 'HARI_KERJA', 1, 0.0, 1.0, 1.5, 1),
      ('ot-work-2', 'HARI_KERJA', 2, 1.0, NULL, 2.0, 1),
      ('ot-holiday-1', 'HARI_LIBUR', 1, 0.0, 8.0, 2.0, 1),
      ('ot-holiday-2', 'HARI_LIBUR', 2, 8.0, 9.0, 3.0, 1),
      ('ot-holiday-3', 'HARI_LIBUR', 3, 9.0, NULL, 4.0, 1);
  `);

  // Default BPJS Rules
  await client.execute(`
    INSERT OR IGNORE INTO bpjs_rules (id, component_code, component_name, rate_percentage, wage_cap, effective_date)
    VALUES
      ('bpjs-jht-emp', 'JHT_EMP', 'JHT Karyawan', 2.0, NULL, '2024-01-01'),
      ('bpjs-jht-co', 'JHT_CO', 'JHT Perusahaan', 3.7, NULL, '2024-01-01'),
      ('bpjs-jp-emp', 'JP_EMP', 'Jaminan Pensiun Karyawan', 1.0, 10042300, '2024-01-01'),
      ('bpjs-jp-co', 'JP_CO', 'Jaminan Pensiun Perusahaan', 2.0, 10042300, '2024-01-01'),
      ('bpjs-jkk', 'JKK', 'Jaminan Kecelakaan Kerja', 0.24, NULL, '2024-01-01'),
      ('bpjs-jkm', 'JKM', 'Jaminan Kematian', 0.30, NULL, '2024-01-01'),
      ('bpjs-kes-emp', 'KES_EMP', 'BPJS Kesehatan Karyawan', 1.0, 12000000, '2024-01-01'),
      ('bpjs-kes-co', 'KES_CO', 'BPJS Kesehatan Perusahaan', 4.0, 12000000, '2024-01-01');
  `);

  // Default Tax Rules (Pasal 17 UU HPP)
  await client.execute(`
    INSERT OR IGNORE INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date)
    VALUES
      ('tax-p17-1', 'PASAL_17', 0, 60000000, 5.0, '2024-01-01'),
      ('tax-p17-2', 'PASAL_17', 60000000, 250000000, 15.0, '2024-01-01'),
      ('tax-p17-3', 'PASAL_17', 250000000, 500000000, 25.0, '2024-01-01'),
      ('tax-p17-4', 'PASAL_17', 500000000, 5000000000, 30.0, '2024-01-01'),
      ('tax-p17-5', 'PASAL_17', 5000000000, NULL, 35.0, '2024-01-01');
  `);

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'payroll-engine-foundation', ?);`,
    args: [PAYROLL_MIGRATION_VERSION, now],
  });

  await client.execute({
    sql: `INSERT OR IGNORE INTO app_mail_config (
            id, provider, api_key, sender_email, sender_name,
            reset_base_url, is_active, updated_at, updated_by
          ) VALUES ('default', 'resend', NULL, NULL, NULL, NULL, 0, ?, 'migration');`,
    args: [now],
  });

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'operator-contact-and-password-reset', ?);`,
    args: [OPERATOR_CONTACT_AND_RESET_MIGRATION_VERSION, now],
  });

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'two-factor-totp', ?);`,
    args: [TWO_FACTOR_MIGRATION_VERSION, now],
  });

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_master_operator_role_id ON master_operator(role_id);",
  );

  // Email operator dipakai sebagai identitas pencarian pada "Lupa Password",
  // jadi ia harus unik. Index parsial: baris operator lama yang email-nya masih
  // NULL tidak saling bentrok dan tetap boleh ada lebih dari satu.
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_master_operator_email ON master_operator(LOWER(email)) WHERE email IS NOT NULL AND TRIM(email) <> '';",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_password_reset_operator ON password_reset_request(operator_id, status, requested_at DESC);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_request(token_hash);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_password_reset_challenge ON password_reset_request(challenge_hash);",
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
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_payroll_items_karyawan ON payroll_items(id_karyawan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status, period_start);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_salary_configs_karyawan ON salary_configs(id_karyawan, effective_date DESC);",
  );
}
