import type { Client } from "@libsql/client";
import { runDatabaseMigrations } from "./db-migrations";

const CURRENT_SCHEMA_VERSION = 6;
const REQUIRED_TABLE_COUNT = 18;

export async function isDatabaseSchemaReady(client: Client) {
  try {
    const result = await client.execute(`
      SELECT
        COALESCE((SELECT MAX(version) FROM schema_migration), 0) AS version,
        (
          SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'master_data', 'id_card', 'master_operator', 'tbl_shift',
            'setting_gex_system', 'log_scan', 'absensi_harian',
            'backup_karyawan', 'koreksi_admin', 'audit_absensi', 'app_role',
            'app_permission', 'role_permission', 'app_session',
            'auth_login_rate_limit', 'sync_operation_receipt',
            'sync_change_log', 'import_offline'
          )
        ) AS table_count;
    `);
    return (
      Number(result.rows[0]?.version ?? 0) >= CURRENT_SCHEMA_VERSION &&
      Number(result.rows[0]?.table_count ?? 0) === REQUIRED_TABLE_COUNT
    );
  } catch {
    return false;
  }
}

export async function initDatabaseSchema(client: Client) {
  try {
    if (await isDatabaseSchemaReady(client)) return;

    // 1. master_data
    await client.execute(`
      CREATE TABLE IF NOT EXISTS master_data (
        id_unik TEXT PRIMARY KEY,
        kode_karyawan TEXT UNIQUE,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        jabatan_status TEXT,
        no_hp TEXT,
        lp TEXT,
        id_shift INTEGER NOT NULL,
        status_aktif TEXT DEFAULT 'Aktif',
        tanggal_daftar DATE,
        catatan TEXT,
        token_absensi TEXT UNIQUE,
        qr_code TEXT,
        status_qr TEXT DEFAULT 'Belum',
        jenis_personil TEXT,
        tanggal_mulai_aktif DATE,
        tanggal_selesai_aktif DATE,
        status_backup TEXT DEFAULT 'NORMAL'
      );
    `);

    // 2. id_card
    await client.execute(`
      CREATE TABLE IF NOT EXISTS id_card (
        id_card_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_unik TEXT UNIQUE NOT NULL,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        idcard_status TEXT DEFAULT 'Belum',
        idcard_pdf_url TEXT,
        idcard_last_generate TEXT,
        idcard_catatan TEXT,
        tanggal_generate DATE,
        link_qr_png TEXT,
        FOREIGN KEY (id_unik) REFERENCES master_data(id_unik) ON DELETE CASCADE
      );
    `);

    // 3. master_operator
    await client.execute(`
      CREATE TABLE IF NOT EXISTS master_operator (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kode_operator TEXT UNIQUE NOT NULL,
        nama_operator TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('Admin', 'Operator', 'Scanner')),
        role_id INTEGER,
        status TEXT DEFAULT 'Aktif'
      );
    `);

    // 4. tbl_shift
    await client.execute(`
      CREATE TABLE IF NOT EXISTS tbl_shift (
        id_shift INTEGER PRIMARY KEY AUTOINCREMENT,
        kode_shift INTEGER UNIQUE NOT NULL,
        nama_shift TEXT NOT NULL,
        jam_masuk TEXT NOT NULL,
        jam_pulang TEXT NOT NULL,
        awal_absen_menit INTEGER DEFAULT 120,
        batas_masuk_menit INTEGER DEFAULT 60,
        toleransi_masuk_menit INTEGER DEFAULT 0,
        jam_kerja_normal_menit INTEGER NOT NULL,
        istirahat_menit INTEGER DEFAULT 60,
        batas_pulang_menit INTEGER DEFAULT 240,
        offset_istirahat_mulai INTEGER DEFAULT 240,
        offset_generate_alfa INTEGER DEFAULT 180,
        buffer_shift_malam_menit INTEGER DEFAULT 120,
        izinkan_multi_sesi INTEGER DEFAULT 0
      );

    `);

    // 5. setting_gex_system
    await client.execute(`
      CREATE TABLE IF NOT EXISTS setting_gex_system (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 6. log_scan
    await client.execute(`
      CREATE TABLE IF NOT EXISTS log_scan (
        id_log INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_scan TEXT NOT NULL,
        tanggal_kerja DATE NOT NULL,
        jam_scan TEXT NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        jenis_scan TEXT NOT NULL,
        status_proses TEXT NOT NULL,
        sumber_data TEXT NOT NULL CHECK(sumber_data IN ('Scanner', 'Koreksi Admin', 'Import Offline', 'Generate Sistem')),
        catatan_sistem TEXT,
        keterangan TEXT,
        menit_terlambat INTEGER DEFAULT 0,
        menit_datang_awal INTEGER DEFAULT 0,
        id_referensi TEXT,
        kode_operator TEXT
      );
    `);

    // 7. absensi_harian
    await client.execute(`
      CREATE TABLE IF NOT EXISTS absensi_harian (
        id_absensi INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal DATE NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        kelas_divisi TEXT NOT NULL,
        jam_masuk TEXT,
        jam_pulang TEXT,
        status_kehadiran TEXT NOT NULL,
        status_absen TEXT NOT NULL,
        keterangan TEXT,
        sumber TEXT NOT NULL CHECK(sumber IN ('Scanner', 'Koreksi Admin', 'Import Offline', 'Generate Sistem')),
        update_terakhir TEXT NOT NULL,
        menit_terlambat INTEGER DEFAULT 0,
        menit_datang_awal INTEGER DEFAULT 0,
        jam_kerja INTEGER DEFAULT 0,
        lembur INTEGER DEFAULT 0,
        jam_kerja_kurang INTEGER DEFAULT 0,
        id_shift INTEGER NOT NULL,
        bulan TEXT NOT NULL,
        tahun INTEGER NOT NULL,
        id_sesi TEXT UNIQUE NOT NULL,
        mode_tugas TEXT DEFAULT 'NORMAL',
        id_backup TEXT,
        id_karyawan_asal TEXT,
        tanggal_tugas DATE
      );
    `);

    // 8. backup_karyawan
    await client.execute(`
      CREATE TABLE IF NOT EXISTS backup_karyawan (
        id_backup TEXT PRIMARY KEY,
        tanggal_tugas DATE NOT NULL,
        id_karyawan_asal TEXT NOT NULL,
        nama_karyawan_asal TEXT NOT NULL,
        divisi_asal TEXT NOT NULL,
        id_shift_asal INTEGER NOT NULL,
        id_karyawan_pengganti TEXT NOT NULL,
        nama_karyawan_pengganti TEXT NOT NULL,
        divisi_pengganti TEXT NOT NULL,
        id_shift_normal_pengganti INTEGER NOT NULL,
        id_shift_backup INTEGER NOT NULL,
        alasan_backup TEXT,
        status_tugas TEXT DEFAULT 'Aktif',
        kode_operator TEXT NOT NULL,
        waktu_input TEXT NOT NULL,
        catatan TEXT,
        waktu_dibatalkan TEXT,
        operator_pembatalan TEXT
      );
    `);

    // 9. koreksi_admin
    await client.execute(`
      CREATE TABLE IF NOT EXISTS koreksi_admin (
        id_koreksi INTEGER PRIMARY KEY AUTOINCREMENT,
        id_referensi TEXT UNIQUE NOT NULL,
        tanggal DATE NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        jenis_koreksi TEXT NOT NULL,
        jam_koreksi TEXT,
        keterangan_admin TEXT,
        status_proses TEXT DEFAULT 'Sudah Diproses',
        timestamp TEXT NOT NULL,
        kode_operator TEXT NOT NULL
      );
    `);

    // 10. audit_absensi
    await client.execute(`
      CREATE TABLE IF NOT EXISTS audit_absensi (
        id_audit INTEGER PRIMARY KEY AUTOINCREMENT,
        waktu TEXT NOT NULL,
        jenis TEXT NOT NULL,
        tanggal DATE NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        baris_referensi TEXT,
        detail TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    await runDatabaseMigrations(client);

    // Indices for ultra-fast queries
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_log_scan_id_tanggal ON log_scan(id_karyawan, tanggal_kerja);",
    );
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_absensi_tanggal_id ON absensi_harian(tanggal, id_karyawan);",
    );
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_absensi_id_sesi ON absensi_harian(id_sesi);",
    );
    // Additional performance indexes for range queries and lookups
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_log_scan_tanggal ON log_scan(tanggal_kerja);",
    );
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_absensi_tanggal ON absensi_harian(tanggal);",
    );
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_backup_tanggal_status ON backup_karyawan(tanggal_tugas, status_tugas);",
    );
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_master_data_shift_aktif ON master_data(id_shift, status_aktif);",
    );

    // 12. tbl_hari_libur
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

    // Seed default data
    await seedDefaultData(client);

    console.log("Database schema berhasil dimigrasikan.");
  } catch (error) {
    console.error("Gagal menginisialisasi database schema:", error);
    throw error;
  }
}

async function seedDefaultData(client: Client) {
  // Seed Default Shift
  const shiftCheck = await client.execute(
    "SELECT COUNT(*) as count FROM tbl_shift;",
  );
  if (Number(shiftCheck.rows[0]?.count || 0) === 0) {
    await client.execute(`
      INSERT OR IGNORE INTO tbl_shift (kode_shift, nama_shift, jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit, offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit)
      VALUES 
      (1, 'Shift 1 - Pagi Normal', '07:00', '15:00', 120, 60, 0, 480, 60, 240, 240, 180, 120),
      (2, 'Shift 2 - Siang Normal', '15:00', '23:00', 120, 60, 0, 480, 60, 240, 240, 180, 120),
      (3, 'Shift 3 - Malam', '23:00', '07:00', 120, 60, 0, 480, 60, 240, 240, 180, 120),
      (4, 'Shift 4 - Fleksibel', '00:00', '23:59', 0, 1440, 0, 0, 0, 1440, 0, 0, 0);
    `);
  }

  // Seed Default System Settings
  const settingsCheck = await client.execute(
    "SELECT COUNT(*) as count FROM setting_gex_system;",
  );
  if (Number(settingsCheck.rows[0]?.count || 0) === 0) {
    await client.execute(`
      INSERT OR IGNORE INTO setting_gex_system (key, value) VALUES
      ('geofence_enabled', 'false'),
      ('lat_kantor', '0'),
      ('lng_kantor', '0'),
      ('radius_meter', '100'),
      ('auto_alfa_aktif', 'true'),
      ('anti_double_scan_seconds', '60');
    `);
  }
}
