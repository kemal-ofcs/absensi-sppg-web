import type { Client } from "@libsql/client";
import { BRANDING } from "@/lib/constants/branding";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from "@/lib/rbac/catalog";
import { AKUN_BAWAAN, SEED_AKUN_SQL } from "@/lib/validations/accounting";
import {
  ALASAN_BAWAAN,
  SEED_ALASAN_SQL,
  seedAlasanArgs,
} from "@/lib/validations/hr-keluar";
import {
  JENIS_BAWAAN,
  SEED_JENIS_SQL,
  seedJenisArgs,
} from "@/lib/validations/hr-pengajuan";
import {
  MIGRASI_ORGANISASI_SQL,
  SEED_JENIS_DOKUMEN_SQL,
} from "@/lib/validations/hris";
import {
  BANK_BAWAAN,
  SEED_BANK_SQL,
  seedBankArgs,
} from "@/lib/validations/transfer";

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
const SCAN_SECURITY_MIGRATION_VERSION = 13;
const HOLIDAY_WHITELIST_MIGRATION_VERSION = 14;
const PASSWORD_RECOVERY_MIGRATION_VERSION = 15;
const SHIFT_TIME_RULES_MIGRATION_VERSION = 16;
const PERSONNEL_PHOTO_MIGRATION_VERSION = 17;
const PAYROLL_FLAT_DAILY_MIGRATION_VERSION = 18;
const FACE_VERIFICATION_MIGRATION_VERSION = 19;
const INVENTORY_MIGRATION_VERSION = 20;
const ACCOUNTING_MIGRATION_VERSION = 21;
const EMPLOYEE_LOAN_MIGRATION_VERSION = 22;
const BOOK_CLOSING_MIGRATION_VERSION = 23;
const SHIFT_HARI_KERJA_MIGRATION_VERSION = 24;
const INVENTORY_COLUMN_MIGRATION_VERSION = 25;
const INVENTORY_COLUMN_DELETE_MIGRATION_VERSION = 26;
const INVENTORY_DECIMAL_MIGRATION_VERSION = 27;
const JOURNAL_SOURCE_INVENTORY_MIGRATION_VERSION = 28;
const INVENTORY_SERVICE_MIGRATION_VERSION = 29;
const INVENTORY_REQUEST_MIGRATION_VERSION = 30;
const INVENTORY_INSTALLMENT_MIGRATION_VERSION = 31;
const INVENTORY_ITEM_DELETE_MIGRATION_VERSION = 32;
const TELEGRAM_NOTIFICATION_MIGRATION_VERSION = 33;
const DRIVER_TRIP_MIGRATION_VERSION = 34;
const DRIVER_WAGE_MIGRATION_VERSION = 35;
const HRIS_ORG_MIGRATION_VERSION = 36;
const HRIS_REQUEST_MIGRATION_VERSION = 37;
const HRIS_REQUEST_V2_MIGRATION_VERSION = 38;
const HRIS_REIMBURSE_MIGRATION_VERSION = 39;
const HRIS_KELUAR_MIGRATION_VERSION = 40;
const HRIS_KINERJA_MIGRATION_VERSION = 41;
const HRIS_REKRUTMEN_MIGRATION_VERSION = 42;
const HRIS_PELATIHAN_RENCANA_MIGRATION_VERSION = 43;
const PAYROLL_TRANSFER_MIGRATION_VERSION = 44;

/**
 * v16 — aturan jam scan baru: Jam Kerja Normal = (Jam Pulang − Jam Masuk) −
 * Istirahat, tanpa "+ Batas Masuk" lama. Nilai tersimpan dihitung ulang SEKALI.
 *
 * Shift fleksibel (jam kerja normal 0, jam masuk = jam pulang, atau
 * 00:00–23:59) sengaja dilewati: nilainya adalah penanda fleksibel, dan
 * menghitung ulangnya akan diam-diam mengubah shift itu menjadi reguler.
 * Hasil ≤ 0 juga dilewati karena alasan yang sama. Teks SQL ini WAJIB identik
 * dengan `RECALCULATE_NORMAL_WORK_SQL` di `turso.rs`.
 */
export const RECALCULATE_NORMAL_WORK_SQL = `UPDATE tbl_shift
SET jam_kerja_normal_menit =
  (CAST(substr(jam_pulang, 1, 2) AS INTEGER) * 60 + CAST(substr(jam_pulang, 4, 2) AS INTEGER))
  - (CAST(substr(jam_masuk, 1, 2) AS INTEGER) * 60 + CAST(substr(jam_masuk, 4, 2) AS INTEGER))
  + (CASE WHEN substr(jam_pulang, 1, 5) < substr(jam_masuk, 1, 5) THEN 1440 ELSE 0 END)
  - COALESCE(istirahat_menit, 0)
WHERE COALESCE(jam_kerja_normal_menit, 0) > 0
  AND jam_masuk GLOB '[0-2][0-9]:[0-5][0-9]*'
  AND jam_pulang GLOB '[0-2][0-9]:[0-5][0-9]*'
  AND substr(jam_masuk, 1, 5) <> substr(jam_pulang, 1, 5)
  AND NOT (substr(jam_masuk, 1, 5) = '00:00' AND substr(jam_pulang, 1, 5) = '23:59')
  AND (CAST(substr(jam_pulang, 1, 2) AS INTEGER) * 60 + CAST(substr(jam_pulang, 4, 2) AS INTEGER))
    - (CAST(substr(jam_masuk, 1, 2) AS INTEGER) * 60 + CAST(substr(jam_masuk, 4, 2) AS INTEGER))
    + (CASE WHEN substr(jam_pulang, 1, 5) < substr(jam_masuk, 1, 5) THEN 1440 ELSE 0 END)
    - COALESCE(istirahat_menit, 0) > 0;`;

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
  {
    key: "driver",
    name: "Driver",
    description: "Pengemudi: melapor perjalanan dari HP.",
    isSuperadmin: 0,
  },
  {
    key: "hrd",
    name: "HRD",
    description:
      "Kepegawaian: organisasi, data karyawan, kontrak, dan dokumen.",
    isSuperadmin: 0,
  },
  {
    key: "atasan",
    name: "Atasan",
    description: "Atasan karyawan: melihat data kerja karyawan.",
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
      require_scan_photo INTEGER NOT NULL DEFAULT 0,
      require_scan_ip_allowlist INTEGER NOT NULL DEFAULT 0,
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
    // Keamanan absensi per role (schema versi 13). Sengaja tanpa CHECK, sama
    // seperti `require_totp`: SQLite membatasi bentuk constraint pada
    // ALTER TABLE ADD COLUMN, dan menaruh CHECK hanya di CREATE TABLE membuat
    // database hasil migrasi berbeda dari database baru.
    [
      "app_role",
      "require_scan_photo",
      "ALTER TABLE app_role ADD COLUMN require_scan_photo INTEGER NOT NULL DEFAULT 0;",
    ],
    [
      "app_role",
      "require_scan_ip_allowlist",
      "ALTER TABLE app_role ADD COLUMN require_scan_ip_allowlist INTEGER NOT NULL DEFAULT 0;",
    ],
    [
      "master_operator",
      "updated_at",
      "ALTER TABLE master_operator ADD COLUMN updated_at TEXT;",
    ],
    // Kode pemulihan password Superadmin (schema versi 15). Dieja di sini DAN
    // di daftar ensure_column milik `turso.rs`, supaya klien mana pun bisa
    // menyembuhkan database yang dibuat jalur lainnya.
    [
      "master_operator",
      "password_recovery_codes",
      "ALTER TABLE master_operator ADD COLUMN password_recovery_codes TEXT;",
    ],
    [
      "master_operator",
      "password_recovery_created_at",
      "ALTER TABLE master_operator ADD COLUMN password_recovery_created_at TEXT;",
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
    // Vonis verifikasi wajah pada foto bukti (v19). Cerminan `ensure_column`
    // di `turso.rs` dan `storage.rs`.
    [
      "absensi_foto",
      "wajah_vonis",
      "ALTER TABLE absensi_foto ADD COLUMN wajah_vonis TEXT;",
    ],
    [
      "absensi_foto",
      "wajah_skor",
      "ALTER TABLE absensi_foto ADD COLUMN wajah_skor REAL;",
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
  // v24 — hari kerja mingguan shift. Bawaan tujuh hari: shift lama tidak
  // tiba-tiba punya hari libur. Cermin `ensure_column` di Rust.
  if (!(await hasColumn(client, "tbl_shift", "hari_kerja"))) {
    await client.execute(
      "ALTER TABLE tbl_shift ADD COLUMN hari_kerja TEXT DEFAULT '1,2,3,4,5,6,7';",
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
      company_name TEXT NOT NULL DEFAULT 'YOUR COMPANY',
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
      name TEXT NOT NULL DEFAULT 'Default ID Card Template',
      orientation TEXT NOT NULL DEFAULT 'landscape',
      front_bg_url TEXT,
      back_bg_url TEXT,
      elements_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const defaultTerms = BRANDING.defaultCardTerms;

  await client.execute({
    sql: `
      INSERT OR IGNORE INTO company_profile (
        id, company_name, branch_name, logo_url, signature_url,
        address, phone, email, website,
        leader_name, leader_title, leader_nip,
        card_terms, timezone, updated_at
      ) VALUES (
        'default_company', ?, ?, NULL, NULL,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, 'Asia/Jakarta', ?
      );
    `,
    args: [
      BRANDING.defaultCompanyName,
      BRANDING.defaultBranchName,
      BRANDING.defaultAddress,
      BRANDING.defaultPhone,
      BRANDING.defaultEmail,
      BRANDING.defaultWebsite,
      BRANDING.defaultLeaderName,
      BRANDING.defaultLeaderTitle,
      BRANDING.defaultLeaderNip,
      defaultTerms,
      now,
    ],
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
      salary_type TEXT NOT NULL DEFAULT 'HOURLY' CHECK (salary_type IN ('HOURLY','FLAT_DAILY')),
      daily_rate INTEGER NOT NULL DEFAULT 0 CHECK (daily_rate >= 0),
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
      effective_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      salary_type TEXT NOT NULL DEFAULT 'HOURLY' CHECK (salary_type IN ('HOURLY','FLAT_DAILY')),
      daily_rate INTEGER NOT NULL DEFAULT 0 CHECK (daily_rate >= 0),
      days_present INTEGER NOT NULL DEFAULT 0 CHECK (days_present >= 0),
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

  // Foto bukti absensi. SENGAJA di luar SNAPSHOT_TABLES: satu foto ~40 KB dan
  // ratusan baris per hari akan membuat setiap pull snapshot berukuran puluhan
  // megabyte di tiap perangkat. Foto didorong bersama event 'attendance/scan'
  // lalu dibaca satu per satu dari cloud saat ada yang meninjaunya.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS absensi_foto (
      id_foto TEXT PRIMARY KEY,
      id_sesi TEXT,
      tanggal_kerja TEXT NOT NULL,
      id_karyawan TEXT NOT NULL,
      nama TEXT NOT NULL,
      divisi TEXT,
      jenis_scan TEXT NOT NULL,
      timestamp_scan TEXT NOT NULL,
      sumber_data TEXT NOT NULL DEFAULT 'Scanner',
      kode_operator TEXT,
      ip_perangkat TEXT,
      client_id TEXT,
      foto_mime TEXT NOT NULL DEFAULT 'image/jpeg',
      foto_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      wajah_vonis TEXT,
      wajah_skor REAL
    );
  `);

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'attendance-scan-security', ?);`,
    args: [SCAN_SECURITY_MIGRATION_VERSION, now],
  });

  // ── v14: Whitelist Shift/Divisi hari libur + pemisahan upah jam hari libur ──
  //
  // Cakupan disimpan sebagai `kode_shift` (bukan `id_shift`) dan NAMA divisi,
  // karena `id_shift` adalah AUTOINCREMENT lokal yang berbeda antar perangkat.
  // PK-nya TEXT yang dibuat klien, bukan AUTOINCREMENT, supaya dua perangkat
  // yang offline tidak pernah menghasilkan id yang sama lalu saling menimpa.
  //
  // SENGAJA TANPA UNIQUE INDEX pada (scope_type, scope_value): dua perangkat
  // offline bisa mendaftarkan cakupan yang sama, dan sebuah unique constraint
  // akan membuat push sync-nya gagal PERMANEN. Duplikat tidak berbahaya di sini
  // (penilaiannya OR), dan pencegahannya dilakukan di lapisan aplikasi yang
  // bisa memberi pesan ramah.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hari_libur_whitelist (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('SHIFT', 'DIVISI')),
      scope_value TEXT NOT NULL,
      tanggal_libur DATE,
      keterangan TEXT,
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Jam kerja pada tanggal libur dihitung dengan jenjang HARI_LIBUR, terpisah
  // dari lembur hari kerja yang memakai jenjang HARI_KERJA. Dua kolom ini
  // membekukan hasil pemisahan itu pada setiap slip yang sudah dibuat.
  if (!(await hasColumn(client, "payroll_items", "total_holiday_hours"))) {
    await client.execute(
      "ALTER TABLE payroll_items ADD COLUMN total_holiday_hours REAL NOT NULL DEFAULT 0;",
    );
  }
  if (
    !(await hasColumn(client, "payroll_items", "total_holiday_overtime_index"))
  ) {
    await client.execute(
      "ALTER TABLE payroll_items ADD COLUMN total_holiday_overtime_index REAL NOT NULL DEFAULT 0;",
    );
  }

  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'holiday-whitelist-and-holiday-overtime', ?);`,
    args: [HOLIDAY_WHITELIST_MIGRATION_VERSION, now],
  });

  // Kode pemulihan password Superadmin. Baris versi ini WAJIB dicatat di sini:
  // `isDatabaseSchemaReady` membandingkan MAX(version) dengan
  // CURRENT_SCHEMA_VERSION, sehingga menaikkan konstanta tanpa mencatat
  // barisnya membuat aplikasi menganggap database selamanya belum siap dan
  // menjalankan ulang seluruh migrasi pada setiap permintaan.
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'superadmin-password-recovery-codes', ?);`,
    args: [PASSWORD_RECOVERY_MIGRATION_VERSION, now],
  });

  // ── v16: Aturan jam scan baru (lihat RECALCULATE_NORMAL_WORK_SQL) ──
  //
  // Data migration, bukan DDL: dijalankan hanya sekali, dijaga baris versinya.
  // Setelah itu Jam Kerja Normal selalu ditulis dengan rumus baru oleh form
  // shift, jadi menjalankannya ulang tidak diperlukan.
  const shiftRulesApplied = await client.execute({
    sql: "SELECT COUNT(*) AS total FROM schema_migration WHERE version = ?;",
    args: [SHIFT_TIME_RULES_MIGRATION_VERSION],
  });
  if (
    Number(shiftRulesApplied.rows[0]?.total ?? 0) === 0 &&
    (await hasTable(client, "tbl_shift"))
  ) {
    await client.execute(RECALCULATE_NORMAL_WORK_SQL);
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'shift-time-rules-v2', ?);`,
    args: [SHIFT_TIME_RULES_MIGRATION_VERSION, now],
  });

  // ── v17: Tabel personil_foto (Selective sync / di luar snapshot) ──
  await client.execute(`
    CREATE TABLE IF NOT EXISTS personil_foto (
      id_unik TEXT PRIMARY KEY,
      foto_mime TEXT NOT NULL DEFAULT 'image/jpeg',
      foto_base64 TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (id_unik) REFERENCES master_data(id_unik) ON DELETE CASCADE
    );
  `);
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'personnel-photo-foundation', ?);`,
    args: [PERSONNEL_PHOTO_MIGRATION_VERSION, now],
  });

  // ── v18: Gaji harian tetap (FLAT_DAILY) ──
  //
  // Baris lama otomatis 'HOURLY' lewat DEFAULT, jadi tidak ada backfill.
  // Daftar yang sama ada di `ensure_column` milik `turso.rs` dan `storage.rs`.
  for (const [table, column, sql] of [
    [
      "salary_configs",
      "salary_type",
      "ALTER TABLE salary_configs ADD COLUMN salary_type TEXT NOT NULL DEFAULT 'HOURLY' CHECK (salary_type IN ('HOURLY','FLAT_DAILY'));",
    ],
    [
      "salary_configs",
      "daily_rate",
      "ALTER TABLE salary_configs ADD COLUMN daily_rate INTEGER NOT NULL DEFAULT 0 CHECK (daily_rate >= 0);",
    ],
    [
      "payroll_items",
      "salary_type",
      "ALTER TABLE payroll_items ADD COLUMN salary_type TEXT NOT NULL DEFAULT 'HOURLY' CHECK (salary_type IN ('HOURLY','FLAT_DAILY'));",
    ],
    [
      "payroll_items",
      "daily_rate",
      "ALTER TABLE payroll_items ADD COLUMN daily_rate INTEGER NOT NULL DEFAULT 0 CHECK (daily_rate >= 0);",
    ],
    [
      "payroll_items",
      "days_present",
      "ALTER TABLE payroll_items ADD COLUMN days_present INTEGER NOT NULL DEFAULT 0 CHECK (days_present >= 0);",
    ],
  ] as const) {
    if (!(await hasColumn(client, table, column))) {
      await client.execute(sql);
    }
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'payroll-flat-daily', ?);`,
    args: [PAYROLL_FLAT_DAILY_MIGRATION_VERSION, now],
  });

  // v19 — vektor wajah terdaftar untuk verifikasi 1:1 saat scan. Ikut snapshot
  // supaya terminal offline bisa memeriksa; isinya int8 base64, bukan foto.
  // DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS personil_wajah (
      id_unik TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      vektor TEXT NOT NULL,
      jumlah_sampel INTEGER NOT NULL DEFAULT 1,
      sumber TEXT NOT NULL CHECK (sumber IN ('kamera', 'foto_profil')),
      dibuat_oleh TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'face-verification', ?);`,
    args: [FACE_VERIFICATION_MIGRATION_VERSION, now],
  });

  // v20 — inventaris. DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  // Tidak ada kolom stok: stok dihitung dari mutasi lewat view
  // `inventory_saldo`, karena kolom stok yang ikut sync ditimpa siapa terakhir
  // menang saat dua perangkat offline.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_barang (
      id_barang TEXT PRIMARY KEY,
      kode_barang TEXT NOT NULL,
      nama_barang TEXT NOT NULL,
      kategori TEXT,
      tipe TEXT NOT NULL CHECK (tipe IN ('Aset', 'Habis Pakai')),
      satuan TEXT NOT NULL,
      bisa_expired INTEGER NOT NULL DEFAULT 0 CHECK (bisa_expired IN (0, 1)),
      stok_minimum INTEGER NOT NULL DEFAULT 0 CHECK (stok_minimum >= 0),
      tempat_utama TEXT,
      catatan TEXT,
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      atribut TEXT,
      desimal INTEGER NOT NULL DEFAULT 0 CHECK (desimal IN (0, 1)),
      dihapus_pada TEXT
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_mutasi (
      id_mutasi TEXT PRIMARY KEY,
      id_barang TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Masuk', 'Keluar', 'Pindah')),
      alasan TEXT NOT NULL CHECK (alasan IN (
        'Saldo Awal', 'Pengadaan', 'Hibah', 'Pengembalian',
        'Pemakaian', 'Peminjaman', 'Rusak/Afkir', 'Hilang', 'Kedaluwarsa',
        'Distribusi', 'Perubahan Kondisi',
        'Selisih Opname', 'Pembatalan')),
      tanggal TEXT NOT NULL,
      jumlah INTEGER NOT NULL CHECK (jumlah > 0),
      tempat_asal TEXT,
      kondisi_asal TEXT CHECK (kondisi_asal IN ('Baik', 'Rusak Ringan', 'Rusak Berat')),
      tempat_tujuan TEXT,
      kondisi_tujuan TEXT CHECK (kondisi_tujuan IN ('Baik', 'Rusak Ringan', 'Rusak Berat')),
      id_batch TEXT,
      tanggal_expired TEXT,
      id_ref TEXT,
      penerima_tipe TEXT CHECK (penerima_tipe IN ('Personil', 'Divisi', 'Unit', 'Umum')),
      penerima_id TEXT,
      penerima_nama TEXT,
      keperluan TEXT,
      sumber_dana TEXT,
      nomor_dokumen TEXT,
      harga_satuan INTEGER CHECK (harga_satuan IS NULL OR harga_satuan >= 0),
      catatan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_mutasi_barang_tanggal ON inventory_mutasi(id_barang, tanggal);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_mutasi_batch ON inventory_mutasi(id_batch);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_mutasi_ref ON inventory_mutasi(id_ref);",
  );
  // Satu-satunya rumus stok. `CREATE VIEW IF NOT EXISTS` tidak memperbarui
  // view lama: mengubah rumusnya berarti DROP VIEW di keempat lapis sekaligus.
  await client.execute(`
    CREATE VIEW IF NOT EXISTS inventory_saldo AS
      SELECT id_barang, MIN(tempat) AS tempat, kondisi, id_batch, SUM(delta) AS saldo
      FROM (
        SELECT id_barang, tempat_tujuan AS tempat, kondisi_tujuan AS kondisi, id_batch, jumlah AS delta
          FROM inventory_mutasi WHERE tempat_tujuan IS NOT NULL
        UNION ALL
        SELECT id_barang, tempat_asal, kondisi_asal, id_batch, -jumlah
          FROM inventory_mutasi WHERE tempat_asal IS NOT NULL
      )
      GROUP BY id_barang, LOWER(tempat), kondisi, id_batch;
  `);
  // Registri aset per unit. Hanya identitas unit; tempat dan kondisinya
  // diturunkan dari mutasi. DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_unit (
      id_unit TEXT PRIMARY KEY,
      id_barang TEXT NOT NULL,
      kode_unit TEXT NOT NULL,
      nomor_seri TEXT,
      catatan TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_unit_barang ON inventory_unit(id_barang);",
  );
  // v29: servis aset. DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_servis (
      id_servis TEXT PRIMARY KEY,
      id_barang TEXT NOT NULL,
      id_unit TEXT,
      jumlah INTEGER NOT NULL CHECK (jumlah > 0),
      tempat TEXT NOT NULL,
      kondisi_awal TEXT NOT NULL CHECK (kondisi_awal IN ('Baik', 'Rusak Ringan', 'Rusak Berat')),
      tanggal_mulai TEXT NOT NULL,
      penyedia TEXT,
      keluhan TEXT NOT NULL,
      tanggal_selesai TEXT,
      hasil TEXT CHECK (hasil IS NULL OR hasil IN ('Baik', 'Rusak Ringan', 'Rusak Berat', 'Tidak Bisa Diperbaiki')),
      biaya INTEGER CHECK (biaya IS NULL OR biaya >= 0),
      catatan_selesai TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT,
      dibuka_oleh TEXT NOT NULL,
      ditutup_oleh TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_servis_barang ON inventory_servis(id_barang);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-foundation', ?);`,
    args: [INVENTORY_MIGRATION_VERSION, now],
  });

  // v21 — akuntansi berpasangan. Saldo TIDAK pernah disimpan: dihitung dari
  // baris jurnal. Jurnal append-only; koreksi = jurnal pembalik `batal-<id>`.
  // DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_akun (
      id_akun TEXT PRIMARY KEY,
      kode TEXT NOT NULL,
      nama TEXT NOT NULL,
      kelompok TEXT NOT NULL CHECK (kelompok IN ('Aset', 'Kewajiban', 'Ekuitas', 'Pendapatan', 'Beban')),
      saldo_normal TEXT NOT NULL CHECK (saldo_normal IN ('Debit', 'Kredit')),
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_jurnal (
      id_jurnal TEXT PRIMARY KEY,
      tanggal TEXT NOT NULL,
      seri TEXT NOT NULL,
      nomor_urut INTEGER NOT NULL CHECK (nomor_urut > 0),
      nomor TEXT NOT NULL,
      keterangan TEXT NOT NULL,
      sumber TEXT NOT NULL CHECK (sumber IN ('Manual', 'Kasbon', 'Payroll', 'Inventaris', 'Cicilan', 'Pembatalan')),
      id_sumber TEXT,
      id_jurnal_batal TEXT,
      dibuat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_jurnal_tanggal ON keu_jurnal(tanggal);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_jurnal_seri ON keu_jurnal(seri, nomor_urut);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_jurnal_baris (
      id_baris TEXT PRIMARY KEY,
      id_jurnal TEXT NOT NULL,
      id_akun TEXT NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
      kredit INTEGER NOT NULL DEFAULT 0 CHECK (kredit >= 0),
      keterangan TEXT,
      urutan INTEGER NOT NULL DEFAULT 0,
      CHECK ((debit > 0 AND kredit = 0) OR (debit = 0 AND kredit > 0))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_jurnal_baris_jurnal ON keu_jurnal_baris(id_jurnal);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_jurnal_baris_akun ON keu_jurnal_baris(id_akun);",
  );
  // Bagan akun bawaan dari berkas JSON yang sama dengan seed Rust.
  await client.batch(
    AKUN_BAWAAN.map((akun) => ({
      sql: SEED_AKUN_SQL,
      args: [
        akun.id_akun,
        akun.kode,
        akun.nama,
        akun.kelompok,
        akun.saldo_normal,
      ],
    })),
    "write",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'accounting-foundation', ?);`,
    args: [ACCOUNTING_MIGRATION_VERSION, now],
  });

  // v22 — kasbon karyawan. Sisa TIDAK disimpan: pokok dikurangi angsuran gaji
  // dan pelunasan tunai. DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_pinjaman (
      id_pinjaman TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      nama_karyawan TEXT NOT NULL,
      pokok INTEGER NOT NULL CHECK (pokok > 0),
      cicilan INTEGER NOT NULL CHECK (cicilan > 0),
      mulai_potong TEXT NOT NULL,
      keterangan TEXT,
      status TEXT NOT NULL DEFAULT 'Diajukan' CHECK (status IN ('Diajukan', 'Disetujui', 'Ditolak', 'Dibatalkan')),
      tanggal_pengajuan TEXT NOT NULL,
      diajukan_oleh TEXT NOT NULL,
      diputuskan_oleh TEXT,
      tanggal_cair TEXT,
      id_akun_kas TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_pinjaman_mutasi (
      id_mutasi TEXT PRIMARY KEY,
      id_pinjaman TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Pencairan', 'Angsuran Gaji', 'Pelunasan Tunai', 'Pembatalan')),
      jumlah INTEGER NOT NULL CHECK (jumlah > 0),
      tanggal TEXT NOT NULL,
      id_ref TEXT,
      id_jurnal TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_pinjaman_tunda (
      id_tunda TEXT PRIMARY KEY,
      id_pinjaman TEXT NOT NULL,
      periode TEXT NOT NULL,
      alasan TEXT,
      dibuat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_pinjaman_karyawan ON keu_pinjaman(id_karyawan, status);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_pinjaman_mutasi_pinjaman ON keu_pinjaman_mutasi(id_pinjaman);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_pinjaman_tunda_pinjaman ON keu_pinjaman_tunda(id_pinjaman, periode);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'employee-loan', ?);`,
    args: [EMPLOYEE_LOAN_MIGRATION_VERSION, now],
  });

  // v23 — tutup buku. DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_tutup_buku (
      id_tutup TEXT PRIMARY KEY,
      sampai_tanggal TEXT NOT NULL,
      dibuat_oleh TEXT NOT NULL,
      kode_perangkat TEXT NOT NULL,
      waktu_perangkat TEXT NOT NULL,
      diterima_cloud TEXT,
      saldo_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Aktif' CHECK (status IN ('Aktif', 'Dibuka', 'Digantikan', 'Menunggu')),
      alasan_buka TEXT,
      dibuka_oleh TEXT,
      dibuka_pada TEXT,
      diputuskan_oleh TEXT,
      diputuskan_pada TEXT,
      catatan_keputusan TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'book-closing', ?);`,
    args: [BOOK_CLOSING_MIGRATION_VERSION, now],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'shift-hari-kerja', ?);`,
    args: [SHIFT_HARI_KERJA_MIGRATION_VERSION, now],
  });
  // v25 — kolom tambahan barang inventaris. DDL WAJIB identik dengan
  // `storage.rs` dan `turso.rs`. ALTER-nya di sini, bukan di daftar kolom di
  // atas: di sana `inventory_barang` belum tentu sudah dibuat.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_kolom (
      id_kolom TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      tipe TEXT NOT NULL CHECK (tipe IN ('Teks', 'Angka')),
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      dihapus_pada TEXT
    );
  `);
  if (!(await hasColumn(client, "inventory_barang", "atribut"))) {
    await client.execute(
      "ALTER TABLE inventory_barang ADD COLUMN atribut TEXT;",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-column', ?);`,
    args: [INVENTORY_COLUMN_MIGRATION_VERSION, now],
  });
  // v26 — hapus permanen kolom tambahan. NULL = belum dihapus.
  if (!(await hasColumn(client, "inventory_kolom", "dihapus_pada"))) {
    await client.execute(
      "ALTER TABLE inventory_kolom ADD COLUMN dihapus_pada TEXT;",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-column-delete', ?);`,
    args: [INVENTORY_COLUMN_DELETE_MIGRATION_VERSION, now],
  });
  // v27 — jumlah desimal per barang: 1 = setiap jumlah disimpan ×100.
  if (!(await hasColumn(client, "inventory_barang", "desimal"))) {
    await client.execute(
      "ALTER TABLE inventory_barang ADD COLUMN desimal INTEGER NOT NULL DEFAULT 0 CHECK (desimal IN (0, 1));",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-decimal', ?);`,
    args: [INVENTORY_DECIMAL_MIGRATION_VERSION, now],
  });
  // v28: sumber jurnal `Inventaris`, lalu v31: `Cicilan`. Cermin `ensure_journal_source_values` di
  // `storage.rs`/`turso.rs`. Indeks dan trigger cloud dipasang ulang dari
  // definisinya sendiri SETELAH baris disalin: trigger `trg_sync_append_*`
  // hanya dibuat Rust, dan tanpanya perangkat tidak pernah menerima jurnal
  // baru dari Web.
  const jurnalDdl = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'keu_jurnal';",
  );
  const ddlJurnal = String(jurnalDdl.rows[0]?.sql ?? "");
  if (ddlJurnal && !ddlJurnal.includes("'Cicilan'")) {
    const turunan = await client.execute(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'keu_jurnal' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name;",
    );
    const kolom =
      "id_jurnal, tanggal, seri, nomor_urut, nomor, keterangan, sumber, id_sumber, id_jurnal_batal, dibuat_oleh, created_at";
    await client.batch(
      [
        "DROP TABLE IF EXISTS keu_jurnal__rebuild;",
        `CREATE TABLE keu_jurnal__rebuild (
          id_jurnal TEXT PRIMARY KEY,
          tanggal TEXT NOT NULL,
          seri TEXT NOT NULL,
          nomor_urut INTEGER NOT NULL CHECK (nomor_urut > 0),
          nomor TEXT NOT NULL,
          keterangan TEXT NOT NULL,
          sumber TEXT NOT NULL CHECK (sumber IN ('Manual', 'Kasbon', 'Payroll', 'Inventaris', 'Cicilan', 'Pembatalan')),
          id_sumber TEXT,
          id_jurnal_batal TEXT,
          dibuat_oleh TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
        `INSERT INTO keu_jurnal__rebuild (${kolom}) SELECT ${kolom} FROM keu_jurnal;`,
        "DROP TABLE keu_jurnal;",
        "ALTER TABLE keu_jurnal__rebuild RENAME TO keu_jurnal;",
        ...turunan.rows.map((row) => String(row.sql)),
      ],
      "write",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'journal-source-inventory', ?);`,
    args: [JOURNAL_SOURCE_INVENTORY_MIGRATION_VERSION, now],
  });
  // v29: servis aset (DDL-nya di blok inventaris di atas, bersama `inventory_unit`).
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-service', ?);`,
    args: [INVENTORY_SERVICE_MIGRATION_VERSION, now],
  });

  // v30: pengajuan pembelian dan penerimaannya. DDL WAJIB identik dengan
  // `storage.rs` dan `turso.rs`. Foto penerimaan di luar snapshot, pola
  // `absensi_foto`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_pengajuan (
      id_pengajuan TEXT PRIMARY KEY,
      tanggal TEXT NOT NULL,
      seri TEXT NOT NULL,
      nomor_urut INTEGER NOT NULL,
      nomor TEXT NOT NULL,
      keperluan TEXT NOT NULL,
      sumber_dana TEXT,
      catatan TEXT,
      sidik_baris TEXT NOT NULL,
      diajukan_oleh TEXT NOT NULL,
      disetujui_pada TEXT,
      disetujui_oleh TEXT,
      sidik_disetujui TEXT,
      catatan_persetujuan TEXT,
      ditolak_pada TEXT,
      ditolak_oleh TEXT,
      alasan_tolak TEXT,
      dibatalkan_pada TEXT,
      dibatalkan_oleh TEXT,
      alasan_batal TEXT,
      ditutup_pada TEXT,
      ditutup_oleh TEXT,
      alasan_tutup TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cara_bayar TEXT NOT NULL DEFAULT 'Tunai' CHECK (cara_bayar IN ('Tunai', 'Cicilan'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_pengajuan_tanggal ON inventory_pengajuan(tanggal);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_pengajuan_baris (
      id_baris TEXT PRIMARY KEY,
      id_pengajuan TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan >= 1),
      id_barang TEXT,
      nama_barang TEXT NOT NULL,
      satuan TEXT NOT NULL,
      desimal INTEGER NOT NULL DEFAULT 0 CHECK (desimal IN (0, 1)),
      jumlah INTEGER NOT NULL CHECK (jumlah > 0),
      harga_satuan INTEGER NOT NULL CHECK (harga_satuan >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_pengajuan_baris_induk ON inventory_pengajuan_baris(id_pengajuan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_penerimaan (
      id_penerimaan TEXT PRIMARY KEY,
      id_pengajuan TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      catatan TEXT,
      jumlah_foto INTEGER NOT NULL CHECK (jumlah_foto BETWEEN 1 AND 5),
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_penerimaan_pengajuan ON inventory_penerimaan(id_pengajuan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS inventory_penerimaan_foto (
      id_foto TEXT PRIMARY KEY,
      id_penerimaan TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan BETWEEN 1 AND 5),
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_inventory_penerimaan_foto_induk ON inventory_penerimaan_foto(id_penerimaan);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-request', ?);`,
    args: [INVENTORY_REQUEST_MIGRATION_VERSION, now],
  });

  // v31: pembelian cicilan. DDL WAJIB identik dengan `storage.rs` dan
  // `turso.rs`. Sumber jurnal `Cicilan` ikut rebuild v28 di atas; tiga akun
  // bawaannya ikut seed `akun-bawaan.json` (`INSERT OR IGNORE`).
  if (!(await hasColumn(client, "inventory_pengajuan", "cara_bayar"))) {
    await client.execute(
      "ALTER TABLE inventory_pengajuan ADD COLUMN cara_bayar TEXT NOT NULL DEFAULT 'Tunai' CHECK (cara_bayar IN ('Tunai', 'Cicilan'));",
    );
  }
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_cicilan (
      id_cicilan TEXT PRIMARY KEY,
      id_pengajuan TEXT NOT NULL,
      kreditur TEXT NOT NULL,
      nomor_kontrak TEXT,
      uang_muka INTEGER NOT NULL CHECK (uang_muka >= 0),
      pola TEXT NOT NULL CHECK (pola IN ('Berkala', 'Manual')),
      setiap INTEGER,
      satuan TEXT CHECK (satuan IS NULL OR satuan IN ('Hari', 'Minggu', 'Bulan', 'Tahun')),
      id_akun_utang TEXT NOT NULL,
      id_akun_bunga TEXT NOT NULL,
      id_akun_denda TEXT NOT NULL,
      sidik_syarat TEXT NOT NULL,
      total_disetujui INTEGER,
      diaktifkan_pada TEXT,
      disetujui_ulang_pada TEXT,
      disetujui_ulang_oleh TEXT,
      sidik_disetujui_ulang TEXT,
      ditutup_pada TEXT,
      ditutup_oleh TEXT,
      alasan_tutup TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_cicilan_pengajuan ON keu_cicilan(id_pengajuan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_cicilan_jadwal (
      id_jadwal TEXT PRIMARY KEY,
      id_cicilan TEXT NOT NULL,
      ke INTEGER NOT NULL CHECK (ke >= 0),
      jatuh_tempo TEXT NOT NULL,
      nominal INTEGER NOT NULL CHECK (nominal >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_cicilan_jadwal_induk ON keu_cicilan_jadwal(id_cicilan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_cicilan_bayar (
      id_bayar TEXT PRIMARY KEY,
      id_cicilan TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Bayar', 'Denda')),
      tanggal TEXT NOT NULL,
      nominal INTEGER NOT NULL CHECK (nominal >= 0),
      potongan INTEGER NOT NULL DEFAULT 0 CHECK (potongan >= 0),
      alasan_potongan TEXT,
      keterangan TEXT,
      referensi TEXT,
      id_akun_bayar TEXT NOT NULL,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_keu_cicilan_bayar_induk ON keu_cicilan_bayar(id_cicilan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS keu_cicilan_bayar_batal (
      id_bayar TEXT PRIMARY KEY,
      alasan TEXT NOT NULL,
      dibatalkan_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-installment', ?);`,
    args: [INVENTORY_INSTALLMENT_MIGRATION_VERSION, now],
  });

  // v32: hapus barang. NULL = belum dihapus. Cermin `ensure_column` di
  // `storage.rs`/`turso.rs`.
  if (!(await hasColumn(client, "inventory_barang", "dihapus_pada"))) {
    await client.execute(
      "ALTER TABLE inventory_barang ADD COLUMN dihapus_pada TEXT;",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'inventory-item-delete', ?);`,
    args: [INVENTORY_ITEM_DELETE_MIGRATION_VERSION, now],
  });

  // v33: notifikasi grup Telegram, cloud-only seperti `app_mail_config`. DDL
  // WAJIB identik dengan `turso.rs`. `kejadian` tanpa CHECK: barisnya hanya
  // ditulis pengirim (`services/telegram.ts`).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_telegram_setting (
      kunci TEXT PRIMARY KEY,
      nilai TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS notifikasi_telegram (
      id_notifikasi TEXT PRIMARY KEY,
      kejadian TEXT NOT NULL,
      isi_pesan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Menunggu' CHECK (status IN ('Menunggu', 'Terkirim', 'Gagal', 'Dibatalkan')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      klaim_oleh TEXT,
      klaim_sampai TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_notifikasi_telegram_status ON notifikasi_telegram(status, created_at);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'telegram-notification', ?);`,
    args: [TELEGRAM_NOTIFICATION_MIGRATION_VERSION, now],
  });

  // v34: perjalanan driver / surat jalan. DDL WAJIB identik dengan
  // `storage.rs` dan `turso.rs`. Status tidak disimpan: diturunkan dari
  // `drv_laporan` (append-only). `drv_laporan_foto` di luar snapshot.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_jenis_kendaraan (
      id_jenis TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      tarif INTEGER NOT NULL DEFAULT 0 CHECK (tarif >= 0),
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_kategori_tujuan (
      id_kategori TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      tarif INTEGER NOT NULL DEFAULT 0 CHECK (tarif >= 0),
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_kendaraan (
      id_kendaraan TEXT PRIMARY KEY,
      id_jenis TEXT NOT NULL,
      identitas TEXT NOT NULL,
      nama TEXT,
      catatan TEXT,
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_lokasi (
      id_lokasi TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Pool', 'Muat', 'Bongkar', 'Lainnya')),
      lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
      lng REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
      radius_m INTEGER NOT NULL DEFAULT 200 CHECK (radius_m BETWEEN 10 AND 10000),
      status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_perjalanan (
      id_perjalanan TEXT PRIMARY KEY,
      tanggal TEXT NOT NULL,
      seri TEXT NOT NULL,
      nomor_urut INTEGER NOT NULL CHECK (nomor_urut > 0),
      nomor TEXT NOT NULL,
      id_karyawan TEXT NOT NULL,
      id_kendaraan TEXT NOT NULL,
      id_jenis TEXT NOT NULL,
      id_kategori TEXT NOT NULL,
      tarif_kendaraan INTEGER NOT NULL CHECK (tarif_kendaraan >= 0),
      tarif_tujuan INTEGER NOT NULL CHECK (tarif_tujuan >= 0),
      id_karyawan_upah TEXT,
      catatan TEXT,
      dicetak_pada TEXT,
      dibuat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_perjalanan_tanggal ON drv_perjalanan(tanggal);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_muatan (
      id_muatan TEXT PRIMARY KEY,
      id_perjalanan TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan >= 1),
      tempat_muat TEXT NOT NULL,
      tempat_bongkar TEXT,
      nama_barang TEXT NOT NULL,
      jenis_barang TEXT,
      qty INTEGER NOT NULL CHECK (qty > 0),
      satuan TEXT NOT NULL,
      berat_kg_x100 INTEGER CHECK (berat_kg_x100 IS NULL OR berat_kg_x100 >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_muatan_perjalanan ON drv_muatan(id_perjalanan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_laporan (
      id_laporan TEXT PRIMARY KEY,
      id_perjalanan TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Berangkat', 'Tiba Muat', 'Selesai Muat', 'Tiba Bongkar', 'Selesai Bongkar', 'Kendala', 'Ganti Kendaraan', 'Ganti Driver', 'Disetujui', 'Ditolak', 'Tidak Jalan', 'Dibatalkan', 'Selesai')),
      mode_ganti TEXT CHECK (mode_ganti IS NULL OR mode_ganti IN ('Langsung', 'Darurat', 'Minta Izin')),
      id_ref TEXT,
      jenis_kendala TEXT CHECK (jenis_kendala IS NULL OR jenis_kendala IN ('Macet', 'Kendaraan Rusak', 'Ban', 'Kecelakaan', 'Cuaca', 'Antre Muat/Bongkar', 'Lainnya')),
      terlambat_menit INTEGER CHECK (terlambat_menit IS NULL OR terlambat_menit >= 0),
      id_lokasi TEXT,
      nama_lokasi TEXT,
      lat REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
      lng REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
      akurasi_m REAL CHECK (akurasi_m IS NULL OR akurasi_m >= 0),
      waktu_perangkat TEXT NOT NULL,
      waktu_gps TEXT,
      diterima_cloud TEXT,
      id_karyawan TEXT,
      id_karyawan_baru TEXT,
      id_kendaraan_baru TEXT,
      keterangan TEXT,
      foto_sha256 TEXT,
      dilaporkan_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lokasi_palsu INTEGER CHECK (lokasi_palsu IS NULL OR lokasi_palsu IN (0, 1))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_laporan_perjalanan ON drv_laporan(id_perjalanan, waktu_perangkat);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_laporan_karyawan ON drv_laporan(id_karyawan, waktu_perangkat);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_laporan_muatan (
      id_baris TEXT PRIMARY KEY,
      id_laporan TEXT NOT NULL,
      id_muatan TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty >= 0),
      berat_kg_x100 INTEGER CHECK (berat_kg_x100 IS NULL OR berat_kg_x100 >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_laporan_muatan_laporan ON drv_laporan_muatan(id_laporan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_laporan_foto (
      id_laporan TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Akun Driver ↔ personil. Cermin `ensure_column` di `turso.rs`.
  if (!(await hasColumn(client, "master_operator", "id_karyawan"))) {
    await client.execute(
      "ALTER TABLE master_operator ADD COLUMN id_karyawan TEXT;",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'driver-trip', ?);`,
    args: [DRIVER_TRIP_MIGRATION_VERSION, now],
  });

  // v35: pembayaran upah surat jalan (append-only, pembatalan = baris
  // `Pembatalan` berid `batal-<id_bayar>`) dan lokasi palsu laporan driver.
  // DDL WAJIB identik dengan `storage.rs` dan `turso.rs`.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_upah_bayar (
      id_bayar TEXT PRIMARY KEY,
      jenis TEXT NOT NULL CHECK (jenis IN ('Bayar', 'Pembatalan')),
      id_ref TEXT,
      id_karyawan TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      total INTEGER NOT NULL CHECK (total >= 0),
      keterangan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_upah_bayar_karyawan ON drv_upah_bayar(id_karyawan, tanggal);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drv_upah_bayar_baris (
      id_baris TEXT PRIMARY KEY,
      id_bayar TEXT NOT NULL,
      id_perjalanan TEXT NOT NULL,
      upah INTEGER NOT NULL CHECK (upah >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_upah_bayar_baris_bayar ON drv_upah_bayar_baris(id_bayar);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_drv_upah_bayar_baris_perjalanan ON drv_upah_bayar_baris(id_perjalanan);",
  );
  // Cermin `ensure_column` di `turso.rs`. NULL = tidak diperiksa.
  if (!(await hasColumn(client, "drv_laporan", "lokasi_palsu"))) {
    await client.execute(
      "ALTER TABLE drv_laporan ADD COLUMN lokasi_palsu INTEGER CHECK (lokasi_palsu IS NULL OR lokasi_palsu IN (0, 1));",
    );
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'driver-trip-wage', ?);`,
    args: [DRIVER_WAGE_MIGRATION_VERSION, now],
  });

  // v36: HRIS fase 1. Organisasi dan kontrak tersinkron (DDL WAJIB identik
  // dengan `storage.rs` dan `turso.rs`); profil dan dokumen KHUSUS CLOUD.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_cabang (
      id_cabang TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      alamat TEXT,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_divisi (
      id_divisi TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_divisi_nama (
      id_nama TEXT PRIMARY KEY,
      id_divisi TEXT NOT NULL,
      nama TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_divisi_nama_divisi ON hr_divisi_nama(id_divisi);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_jabatan (
      id_jabatan TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kontrak (
      id_kontrak TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('PKWTT', 'PKWT', 'Harian Lepas', 'Magang', 'Pembatalan')),
      id_ref TEXT,
      nomor TEXT,
      tanggal_mulai TEXT NOT NULL,
      tanggal_selesai TEXT,
      percobaan_selesai TEXT,
      catatan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kontrak_karyawan ON hr_kontrak(id_karyawan, tanggal_mulai);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_profil (
      id_karyawan TEXT PRIMARY KEY,
      nik TEXT,
      no_kk TEXT,
      tempat_lahir TEXT,
      tanggal_lahir TEXT,
      agama TEXT CHECK (agama IS NULL OR agama IN ('Islam', 'Kristen', 'Katolik', 'Hindu', 'Buddha', 'Konghucu', 'Lainnya')),
      status_nikah TEXT CHECK (status_nikah IS NULL OR status_nikah IN ('Belum Kawin', 'Kawin', 'Cerai Hidup', 'Cerai Mati')),
      alamat_ktp TEXT,
      alamat_domisili TEXT,
      pendidikan TEXT CHECK (pendidikan IS NULL OR pendidikan IN ('SD', 'SMP', 'SMA/SMK', 'D1', 'D2', 'D3', 'D4', 'S1', 'S2', 'S3', 'Lainnya')),
      darurat_nama TEXT,
      darurat_hubungan TEXT,
      darurat_hp TEXT,
      bank TEXT,
      no_rekening TEXT,
      nama_rekening TEXT,
      npwp TEXT,
      bpjs_kesehatan TEXT,
      bpjs_ketenagakerjaan TEXT,
      pribadi_diubah_oleh TEXT,
      pribadi_diubah_pada TEXT,
      keuangan_diubah_oleh TEXT,
      keuangan_diubah_pada TEXT
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_dokumen_jenis (
      id_jenis TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_dokumen (
      id_dokumen TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      id_jenis TEXT NOT NULL,
      nomor TEXT,
      tanggal_terbit TEXT,
      tanggal_kedaluwarsa TEXT,
      catatan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_dokumen_karyawan ON hr_dokumen(id_karyawan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_dokumen_kedaluwarsa ON hr_dokumen(tanggal_kedaluwarsa);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_dokumen_berkas (
      id_berkas TEXT PRIMARY KEY,
      id_dokumen TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan BETWEEN 1 AND 5),
      nama_berkas TEXT,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_dokumen_berkas_dokumen ON hr_dokumen_berkas(id_dokumen);",
  );
  await client.execute(SEED_JENIS_DOKUMEN_SQL);
  // Cermin `ensure_column` di `turso.rs`. Kosong = belum dipetakan ke master.
  for (const kolom of ["id_cabang", "id_divisi", "id_jabatan", "id_atasan"]) {
    if (!(await hasColumn(client, "master_data", kolom))) {
      await client.execute(`ALTER TABLE master_data ADD COLUMN ${kolom} TEXT;`);
    }
  }
  // Teks divisi/jabatan → master. Idempoten; teks SQL kembar `hris.rs`.
  for (const sql of MIGRASI_ORGANISASI_SQL) {
    await client.execute(sql);
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-org', ?);`,
    args: [HRIS_ORG_MIGRATION_VERSION, now],
  });

  // v37: HRIS fase 2. Pengajuan dan jatah cuti tersinkron (DDL WAJIB identik
  // dengan `storage.rs` dan `turso.rs`); lampiran KHUSUS CLOUD.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_jenis_pengajuan (
      id_jenis TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      kelompok TEXT NOT NULL CHECK (kelompok IN ('Cuti', 'Izin', 'Sakit', 'Lembur', 'Tukar Shift', 'Dinas Luar', 'Reimburse')),
      izin_pemutus TEXT NOT NULL DEFAULT 'hr.request.decide' CHECK (izin_pemutus IN ('hr.request.decide', 'reimburse.decide')),
      boleh_urgent INTEGER NOT NULL DEFAULT 0 CHECK (boleh_urgent IN (0, 1)),
      potong_jatah INTEGER NOT NULL DEFAULT 0 CHECK (potong_jatah IN (0, 1)),
      dampak_gaji TEXT NOT NULL CHECK (dampak_gaji IN ('Dibayar', 'Potong Gaji', 'Tidak Berpengaruh')),
      maks_hari INTEGER CHECK (maks_hari IS NULL OR maks_hari > 0),
      satuan_maks TEXT NOT NULL DEFAULT 'Hari Kerja' CHECK (satuan_maks IN ('Hari Kerja', 'Hari Kalender')),
      wajib_dokumen INTEGER NOT NULL DEFAULT 0 CHECK (wajib_dokumen IN (0, 1)),
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      batas_bulanan INTEGER,
      CHECK (potong_jatah = 0 OR kelompok = 'Cuti')
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pengajuan (
      id_pengajuan TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      id_jenis TEXT NOT NULL,
      kelompok TEXT NOT NULL CHECK (kelompok IN ('Cuti', 'Izin', 'Sakit', 'Lembur', 'Tukar Shift', 'Dinas Luar', 'Reimburse')),
      potong_jatah INTEGER NOT NULL DEFAULT 0 CHECK (potong_jatah IN (0, 1)),
      dampak_gaji TEXT NOT NULL CHECK (dampak_gaji IN ('Dibayar', 'Potong Gaji', 'Tidak Berpengaruh')),
      tanggal_mulai TEXT NOT NULL,
      tanggal_selesai TEXT NOT NULL,
      setengah_hari INTEGER NOT NULL DEFAULT 0 CHECK (setengah_hari IN (0, 1)),
      alasan TEXT NOT NULL,
      sidik TEXT NOT NULL,
      diajukan_oleh TEXT NOT NULL,
      waktu_perangkat TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      jam_mulai TEXT,
      jam_selesai TEXT,
      id_karyawan_tukar TEXT,
      id_shift_asal INTEGER,
      id_shift_tukar INTEGER,
      nominal INTEGER,
      CHECK (tanggal_selesai >= tanggal_mulai),
      CHECK (setengah_hari = 0 OR (kelompok = 'Izin' AND tanggal_mulai = tanggal_selesai))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pengajuan_karyawan ON hr_pengajuan(id_karyawan, tanggal_mulai);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pengajuan_tanggal ON hr_pengajuan(tanggal_mulai, tanggal_selesai);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pengajuan_keputusan (
      id_keputusan TEXT PRIMARY KEY,
      id_pengajuan TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Setujui', 'Tolak', 'Setujui Urgent', 'Diketahui', 'Batal')),
      sidik TEXT NOT NULL,
      alasan TEXT,
      oleh TEXT NOT NULL,
      waktu_perangkat TEXT NOT NULL,
      diterima_cloud TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      nominal_disetujui INTEGER
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pengajuan_keputusan_pengajuan ON hr_pengajuan_keputusan(id_pengajuan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_cuti_penyesuaian (
      id_penyesuaian TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      periode TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Saldo Awal', 'Koreksi', 'Diuangkan', 'Pembatalan')),
      id_ref TEXT,
      hari INTEGER NOT NULL,
      nominal INTEGER,
      alasan TEXT NOT NULL,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_cuti_penyesuaian_karyawan ON hr_cuti_penyesuaian(id_karyawan, periode);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pengajuan_berkas (
      id_berkas TEXT PRIMARY KEY,
      id_pengajuan TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan BETWEEN 1 AND 5),
      nama_berkas TEXT,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
      data_base64 TEXT NOT NULL,
      diunggah_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pengajuan_berkas_pengajuan ON hr_pengajuan_berkas(id_pengajuan);",
  );
  // v39: kolom reimbursement, cermin `ensure_column` `turso.rs`. WAJIB sebelum
  // seed jenis di bawah, karena seed menulis `batas_bulanan`.
  for (const [tabel, kolom] of [
    ["hr_jenis_pengajuan", "batas_bulanan"],
    ["hr_pengajuan", "nominal"],
    ["hr_pengajuan_keputusan", "nominal_disetujui"],
  ] as const) {
    if (!(await hasColumn(client, tabel, kolom))) {
      await client.execute(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} INTEGER;`);
    }
  }
  // Jenis bawaan dari berkas JSON yang sama dengan seed Rust.
  await client.batch(
    JENIS_BAWAAN.map((jenis) => ({
      sql: SEED_JENIS_SQL,
      args: seedJenisArgs(jenis),
    })),
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-request', ?);`,
    args: [HRIS_REQUEST_MIGRATION_VERSION, now],
  });

  // v38: HRIS fase 3. Isian lembur dan tukar shift, cermin `ensure_column`
  // `turso.rs`; indeks sesudah kolomnya pasti ada (aturan 20). Jenis bawaan
  // fase 3 ikut seed `JENIS_BAWAAN` di atas.
  for (const [kolom, tipe] of [
    ["jam_mulai", "TEXT"],
    ["jam_selesai", "TEXT"],
    ["id_karyawan_tukar", "TEXT"],
    ["id_shift_asal", "INTEGER"],
    ["id_shift_tukar", "INTEGER"],
  ] as const) {
    if (!(await hasColumn(client, "hr_pengajuan", kolom))) {
      await client.execute(
        `ALTER TABLE hr_pengajuan ADD COLUMN ${kolom} ${tipe};`,
      );
    }
  }
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pengajuan_tukar ON hr_pengajuan(id_karyawan_tukar, tanggal_mulai);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-request-v2', ?);`,
    args: [HRIS_REQUEST_V2_MIGRATION_VERSION, now],
  });

  // v39: HRIS fase 4. Pembayaran terpisah reimbursement dan cuti diuangkan,
  // append-only (pembatalan `batal-<id_bayar>`). DDL WAJIB identik dengan
  // `storage.rs` dan `turso.rs`. Kolom nominal ditambahkan sebelum seed jenis.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_reimburse_bayar (
      id_bayar TEXT PRIMARY KEY,
      jenis TEXT NOT NULL CHECK (jenis IN ('Bayar', 'Pembatalan')),
      id_ref TEXT,
      id_karyawan TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      total INTEGER NOT NULL CHECK (total >= 0),
      keterangan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_reimburse_bayar_karyawan ON hr_reimburse_bayar(id_karyawan, tanggal);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_reimburse_bayar_baris (
      id_baris TEXT PRIMARY KEY,
      id_bayar TEXT NOT NULL,
      sumber TEXT NOT NULL CHECK (sumber IN ('Reimburse', 'Cuti Diuangkan')),
      id_klaim TEXT NOT NULL,
      nominal INTEGER NOT NULL CHECK (nominal >= 0)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_reimburse_bayar_baris_bayar ON hr_reimburse_bayar_baris(id_bayar);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_reimburse_bayar_baris_klaim ON hr_reimburse_bayar_baris(id_klaim);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-reimburse', ?);`,
    args: [HRIS_REIMBURSE_MIGRATION_VERSION, now],
  });

  // v40: HRIS fase 5. SP dan karyawan keluar KHUSUS CLOUD (Q-63); DDL WAJIB
  // identik dengan `turso.rs`. Yang tersinkron hanya `master_data.id_keluar`,
  // ditulis transaksi Berlakukan/Batal.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_sp (
      id_sp TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      tingkat TEXT NOT NULL CHECK (tingkat IN ('SP1', 'SP2', 'SP3')),
      tanggal TEXT NOT NULL,
      masa_bulan INTEGER NOT NULL CHECK (masa_bulan BETWEEN 1 AND 12),
      berlaku_sampai TEXT NOT NULL,
      nomor TEXT,
      pelanggaran TEXT NOT NULL,
      harapan TEXT,
      usulan_tingkat TEXT NOT NULL CHECK (usulan_tingkat IN ('SP1', 'SP2', 'SP3')),
      alasan_tingkat TEXT,
      penanda_nama TEXT NOT NULL,
      penanda_jabatan TEXT NOT NULL,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT,
      dicabut_oleh TEXT,
      dicabut_pada TEXT,
      alasan_cabut TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_sp_karyawan ON hr_sp(id_karyawan, tanggal);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_sp_berlaku ON hr_sp(berlaku_sampai);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_keluar_alasan (
      id_alasan TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      pengali_up INTEGER NOT NULL DEFAULT 0 CHECK (pengali_up BETWEEN 0 AND 1000),
      pengali_upmk INTEGER NOT NULL DEFAULT 0 CHECK (pengali_upmk BETWEEN 0 AND 1000),
      uph INTEGER NOT NULL DEFAULT 1 CHECK (uph IN (0, 1)),
      kompensasi_pkwt INTEGER NOT NULL DEFAULT 0 CHECK (kompensasi_pkwt IN (0, 1)),
      uang_pisah INTEGER NOT NULL DEFAULT 0 CHECK (uang_pisah IN (0, 1)),
      dasar_hukum TEXT,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_keluar (
      id_keluar TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      id_alasan TEXT NOT NULL,
      alasan_nama TEXT NOT NULL,
      id_sp TEXT,
      tanggal_pemberitahuan TEXT,
      tanggal_terakhir TEXT NOT NULL,
      keterangan TEXT,
      masa_kerja_mulai TEXT,
      upah_pokok INTEGER NOT NULL DEFAULT 0 CHECK (upah_pokok >= 0),
      usulan_upah_pokok INTEGER NOT NULL DEFAULT 0 CHECK (usulan_upah_pokok >= 0),
      alasan_upah TEXT,
      tunjangan_tetap INTEGER NOT NULL DEFAULT 0 CHECK (tunjangan_tetap >= 0),
      kartu_ditarik INTEGER NOT NULL DEFAULT 0 CHECK (kartu_ditarik IN (0, 1)),
      catatan_checklist TEXT,
      checklist_saat_berlaku TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT,
      berlaku_oleh TEXT,
      berlaku_pada TEXT,
      dibatalkan_oleh TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_keluar_karyawan ON hr_keluar(id_karyawan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_keluar_tanggal ON hr_keluar(tanggal_terakhir);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_keluar_rincian (
      id_rincian TEXT PRIMARY KEY,
      id_keluar TEXT NOT NULL,
      komponen TEXT NOT NULL CHECK (komponen IN ('UP', 'UPMK', 'UPH Cuti', 'UPH Ongkos Pulang', 'UPH Lainnya', 'Kompensasi PKWT', 'Uang Pisah', 'Lainnya')),
      dasar TEXT,
      usulan INTEGER NOT NULL DEFAULT 0 CHECK (usulan >= 0),
      nominal INTEGER NOT NULL DEFAULT 0 CHECK (nominal >= 0),
      alasan_ubah TEXT,
      urutan INTEGER NOT NULL DEFAULT 0
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_keluar_rincian_keluar ON hr_keluar_rincian(id_keluar);",
  );
  // Alasan bawaan dari berkas JSON yang sama dengan seed Rust.
  await client.batch(
    ALASAN_BAWAAN.map((alasan) => ({
      sql: SEED_ALASAN_SQL,
      args: seedAlasanArgs(alasan),
    })),
  );
  if (!(await hasColumn(client, "master_data", "id_keluar"))) {
    await client.execute("ALTER TABLE master_data ADD COLUMN id_keluar TEXT;");
  }
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-keluar', ?);`,
    args: [HRIS_KELUAR_MIGRATION_VERSION, now],
  });

  // v41: HRIS fase 6. Penilaian kinerja, tersinkron semua (Q-71). DDL WAJIB
  // identik dengan `storage.rs` dan `turso.rs`. Tanpa seed (§21.2).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_template (
      id_template TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      keterangan TEXT,
      is_bawaan INTEGER NOT NULL DEFAULT 0 CHECK (is_bawaan IN (0, 1)),
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      diubah_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_aspek (
      id_aspek TEXT PRIMARY KEY,
      id_template TEXT NOT NULL,
      nama TEXT NOT NULL,
      tipe TEXT NOT NULL CHECK (tipe IN ('Manual', 'Otomatis Disiplin')),
      bobot INTEGER NOT NULL CHECK (bobot BETWEEN 1 AND 100),
      panduan TEXT,
      urutan INTEGER NOT NULL DEFAULT 0,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kinerja_aspek_template ON hr_kinerja_aspek(id_template);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_jabatan (
      id_jabatan TEXT PRIMARY KEY,
      id_template TEXT,
      diubah_oleh TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_penilaian (
      id_penilaian TEXT PRIMARY KEY,
      id_karyawan TEXT NOT NULL,
      id_ref TEXT,
      alasan_koreksi TEXT,
      periode_jenis TEXT NOT NULL CHECK (periode_jenis IN ('Bulanan', 'Kuartal', 'Semester', 'Tahunan')),
      periode_mulai TEXT NOT NULL,
      periode_selesai TEXT NOT NULL,
      id_template TEXT NOT NULL,
      template_nama TEXT NOT NULL,
      id_jabatan TEXT,
      jabatan_nama TEXT,
      id_penilai TEXT,
      penilai_oleh TEXT NOT NULL,
      catatan TEXT,
      sidik TEXT NOT NULL,
      dibuat_oleh TEXT NOT NULL,
      waktu_perangkat TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (periode_selesai >= periode_mulai)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kinerja_penilaian_karyawan ON hr_kinerja_penilaian(id_karyawan, periode_mulai);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kinerja_penilaian_ref ON hr_kinerja_penilaian(id_ref);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_nilai (
      id_nilai TEXT PRIMARY KEY,
      id_penilaian TEXT NOT NULL,
      id_aspek TEXT NOT NULL,
      aspek_nama TEXT NOT NULL,
      tipe TEXT NOT NULL CHECK (tipe IN ('Manual', 'Otomatis Disiplin')),
      bobot INTEGER NOT NULL CHECK (bobot BETWEEN 1 AND 100),
      urutan INTEGER NOT NULL DEFAULT 0,
      skor INTEGER CHECK (skor IS NULL OR skor BETWEEN 1 AND 5),
      catatan TEXT,
      rincian TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kinerja_nilai_penilaian ON hr_kinerja_nilai(id_penilaian);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_kinerja_keputusan (
      id_keputusan TEXT PRIMARY KEY,
      id_penilaian TEXT NOT NULL,
      jenis TEXT NOT NULL CHECK (jenis IN ('Ajukan', 'Kembalikan', 'Final', 'Batal')),
      sidik TEXT NOT NULL,
      alasan TEXT,
      nilai_akhir INTEGER CHECK (nilai_akhir IS NULL OR nilai_akhir BETWEEN 0 AND 10000),
      predikat TEXT,
      oleh TEXT NOT NULL,
      waktu_perangkat TEXT NOT NULL,
      diterima_cloud TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_kinerja_keputusan_penilaian ON hr_kinerja_keputusan(id_penilaian);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-kinerja', ?);`,
    args: [HRIS_KINERJA_MIGRATION_VERSION, now],
  });

  // v42: HRIS fase 7. Rekrutmen dan pelatihan, KHUSUS CLOUD (Q-86, Q-87):
  // tidak ada di `storage.rs` maupun snapshot. DDL WAJIB identik dengan
  // `turso.rs`. Tanpa seed (jenis `dok-sertifikat` sudah ada sejak v36).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_lowongan (
      id_lowongan TEXT PRIMARY KEY,
      judul TEXT NOT NULL,
      id_jabatan TEXT,
      id_divisi TEXT,
      id_cabang TEXT,
      jumlah INTEGER NOT NULL CHECK (jumlah BETWEEN 1 AND 999),
      tanggal_buka TEXT NOT NULL,
      tanggal_tutup TEXT,
      keterangan TEXT,
      ditutup_pada TEXT,
      ditutup_oleh TEXT,
      pelamar_dihapus INTEGER NOT NULL DEFAULT 0 CHECK (pelamar_dihapus >= 0),
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT,
      CHECK (tanggal_tutup IS NULL OR tanggal_tutup >= tanggal_buka)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_lowongan_buka ON hr_lowongan(tanggal_buka);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelamar (
      id_pelamar TEXT PRIMARY KEY,
      id_lowongan TEXT NOT NULL,
      nama TEXT NOT NULL,
      no_hp TEXT,
      email TEXT,
      lp TEXT CHECK (lp IS NULL OR lp IN ('L', 'P')),
      tanggal_lahir TEXT,
      alamat TEXT,
      pendidikan TEXT CHECK (pendidikan IS NULL OR pendidikan IN ('SD', 'SMP', 'SMA/SMK', 'D1', 'D2', 'D3', 'D4', 'S1', 'S2', 'S3', 'Lainnya')),
      sumber TEXT,
      tanggal_lamaran TEXT NOT NULL,
      catatan TEXT,
      id_karyawan TEXT,
      dijadikan_oleh TEXT,
      dijadikan_pada TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelamar_lowongan ON hr_pelamar(id_lowongan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelamar_karyawan ON hr_pelamar(id_karyawan);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelamar_tahap (
      id_tahap TEXT PRIMARY KEY,
      id_pelamar TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan >= 1),
      tahap TEXT NOT NULL CHECK (tahap IN ('Lamaran', 'Seleksi Berkas', 'Wawancara', 'Tes', 'Penawaran', 'Diterima', 'Ditolak', 'Mundur')),
      tanggal TEXT NOT NULL,
      catatan TEXT,
      oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      dibatalkan_oleh TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelamar_tahap_pelamar ON hr_pelamar_tahap(id_pelamar);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelamar_berkas (
      id_berkas TEXT PRIMARY KEY,
      id_pelamar TEXT NOT NULL,
      urutan INTEGER NOT NULL CHECK (urutan BETWEEN 1 AND 3),
      nama_berkas TEXT,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
      data_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelamar_berkas_pelamar ON hr_pelamar_berkas(id_pelamar);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelatihan (
      id_pelatihan TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      penyelenggara TEXT,
      tanggal_mulai TEXT NOT NULL,
      tanggal_selesai TEXT NOT NULL,
      lokasi TEXT,
      biaya INTEGER NOT NULL DEFAULT 0 CHECK (biaya >= 0),
      keterangan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT,
      dibatalkan_oleh TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT,
      id_rencana TEXT,
      CHECK (tanggal_selesai >= tanggal_mulai)
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_mulai ON hr_pelatihan(tanggal_mulai);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelatihan_peserta (
      id_peserta TEXT PRIMARY KEY,
      id_pelatihan TEXT NOT NULL,
      id_karyawan TEXT NOT NULL,
      hasil TEXT CHECK (hasil IS NULL OR hasil IN ('Lulus', 'Tidak Lulus', 'Tidak Hadir')),
      id_dokumen TEXT,
      catatan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_peserta_pelatihan ON hr_pelatihan_peserta(id_pelatihan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_peserta_karyawan ON hr_pelatihan_peserta(id_karyawan);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_peserta_dokumen ON hr_pelatihan_peserta(id_dokumen);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-rekrutmen', ?);`,
    args: [HRIS_REKRUTMEN_MIGRATION_VERSION, now],
  });

  // v43: HRIS fase 11. Pagu dan rencana pelatihan, KHUSUS CLOUD seperti
  // induknya (Q-138). DDL WAJIB identik dengan `turso.rs`. Indeks
  // `id_rencana` sesudah kolomnya pasti ada (aturan 20, pola v38).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelatihan_anggaran (
      id_anggaran TEXT PRIMARY KEY,
      tahun INTEGER NOT NULL CHECK (tahun BETWEEN 2000 AND 2100),
      id_divisi TEXT,
      nominal INTEGER NOT NULL CHECK (nominal >= 0),
      catatan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_anggaran_tahun ON hr_pelatihan_anggaran(tahun);",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hr_pelatihan_rencana (
      id_rencana TEXT PRIMARY KEY,
      tahun INTEGER NOT NULL CHECK (tahun BETWEEN 2000 AND 2100),
      nama TEXT NOT NULL,
      id_divisi TEXT,
      bulan INTEGER CHECK (bulan IS NULL OR bulan BETWEEN 1 AND 12),
      peserta_rencana INTEGER NOT NULL DEFAULT 0 CHECK (peserta_rencana >= 0),
      biaya_rencana INTEGER NOT NULL DEFAULT 0 CHECK (biaya_rencana >= 0),
      penyelenggara TEXT,
      keterangan TEXT,
      dicatat_oleh TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      diubah_oleh TEXT,
      diubah_pada TEXT,
      dibatalkan_oleh TEXT,
      dibatalkan_pada TEXT,
      alasan_batal TEXT
    );
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_rencana_tahun ON hr_pelatihan_rencana(tahun);",
  );
  if (!(await hasColumn(client, "hr_pelatihan", "id_rencana"))) {
    await client.execute(
      "ALTER TABLE hr_pelatihan ADD COLUMN id_rencana TEXT;",
    );
  }
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hr_pelatihan_rencana ON hr_pelatihan(id_rencana);",
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'hris-pelatihan-rencana', ?);`,
    args: [HRIS_PELATIHAN_RENCANA_MIGRATION_VERSION, now],
  });

  // v44: HRIS fase 12. Pengaturan transfer bank, KHUSUS CLOUD (§27.2). DDL
  // WAJIB identik dengan `turso.rs`. Bank bawaan dari berkas JSON yang sama
  // dengan seed Rust; tanpa seed rekening dan format.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_bank (
      id_bank TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      kode TEXT CHECK (kode IS NULL OR (length(kode) = 3 AND kode NOT GLOB '*[^0-9]*')),
      alias TEXT NOT NULL DEFAULT '[]',
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      is_bawaan INTEGER NOT NULL DEFAULT 0 CHECK (is_bawaan IN (0, 1)),
      diubah_oleh TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_bank_rekening (
      id_rekening TEXT PRIMARY KEY,
      id_bank TEXT NOT NULL,
      no_rekening TEXT NOT NULL CHECK (length(no_rekening) BETWEEN 5 AND 20 AND no_rekening NOT GLOB '*[^0-9]*'),
      nama_rekening TEXT NOT NULL,
      keterangan TEXT,
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      diubah_oleh TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_bank_format (
      id_format TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      id_bank TEXT,
      jenis TEXT NOT NULL CHECK (jenis IN ('csv', 'txt', 'xlsx')),
      pemisah TEXT CHECK (pemisah IS NULL OR pemisah IN (',', ';', char(9), '|')),
      pakai_judul INTEGER NOT NULL DEFAULT 1 CHECK (pakai_judul IN (0, 1)),
      kutip INTEGER NOT NULL DEFAULT 0 CHECK (kutip IN (0, 1)),
      desimal INTEGER NOT NULL DEFAULT 0 CHECK (desimal IN (0, 1)),
      cakupan TEXT NOT NULL DEFAULT 'semua' CHECK (cakupan IN ('semua', 'sesama', 'antarbank')),
      kolom TEXT NOT NULL,
      maks_berita INTEGER CHECK (maks_berita IS NULL OR maks_berita > 0),
      is_aktif INTEGER NOT NULL DEFAULT 1 CHECK (is_aktif IN (0, 1)),
      diubah_oleh TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((jenis = 'xlsx') = (pemisah IS NULL))
    );
  `);
  await client.batch(
    BANK_BAWAAN.map((bank) => ({
      sql: SEED_BANK_SQL,
      args: seedBankArgs(bank),
    })),
  );
  await client.execute({
    sql: `INSERT OR IGNORE INTO schema_migration (version, name, applied_at)
          VALUES (?, 'payroll-transfer', ?);`,
    args: [PAYROLL_TRANSFER_MIGRATION_VERSION, now],
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
    "CREATE INDEX IF NOT EXISTS idx_absensi_foto_tanggal ON absensi_foto(tanggal_kerja, timestamp_scan DESC);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_absensi_foto_karyawan ON absensi_foto(id_karyawan, tanggal_kerja);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_absensi_foto_sesi ON absensi_foto(id_sesi);",
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
    "CREATE INDEX IF NOT EXISTS idx_hari_libur_whitelist_scope ON hari_libur_whitelist(scope_type, scope_value, status_aktif);",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_hari_libur_whitelist_tanggal ON hari_libur_whitelist(tanggal_libur, status_aktif);",
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
