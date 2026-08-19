import type { Client } from "@libsql/client";
import { runDatabaseMigrations } from "./db-migrations";

export const CURRENT_SCHEMA_VERSION = 8;
export const REQUIRED_TABLE_COUNT = 21;

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
            'sync_change_log', 'import_offline', 'tbl_hari_libur',
            'company_profile', 'id_card_template'
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

    // 11. tbl_hari_libur
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

    // 12. company_profile
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

    // 13. id_card_template
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

const DEFAULT_CARD_TERMS = `1. Kartu ini adalah tanda pengenal resmi karyawan/personil SPPG.
2. Wajib dibawa dan dipindai (scan QR) setiap hadir dan pulang kerja.
3. Dilarang memindahtangankan atau meminjamkan kartu ini kepada pihak lain.
4. Apabila kartu hilang atau menemukan kartu ini, harap segera melapor ke Bagian SDM/Operasional SPPG.`;

const DEFAULT_ID_CARD_ELEMENTS_JSON = JSON.stringify([
  {
    id: "el-company-logo",
    type: "company_logo",
    side: "front",
    sourceKey: "company.logo",
    label: "Logo Instansi",
    x: 6,
    y: 8,
    width: 14,
    height: 20,
    fontSize: 14,
    color: "#ffffff",
  },
  {
    id: "el-header-company",
    type: "text",
    side: "front",
    sourceKey: "company.name",
    label: "Nama Instansi",
    x: 22,
    y: 11,
    fontSize: 16,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-header-title",
    type: "static_text",
    side: "front",
    sourceKey: "static_text",
    staticValue: "KARTU IDENTITAS KARYAWAN",
    label: "Judul Kartu",
    x: 22,
    y: 22,
    fontSize: 9,
    fontWeight: "600",
    color: "#38bdf8",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-emp-name",
    type: "text",
    side: "front",
    sourceKey: "employee.name",
    label: "Nama Karyawan",
    x: 6,
    y: 44,
    fontSize: 18,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-emp-pos",
    type: "text",
    side: "front",
    sourceKey: "employee.position",
    label: "Jabatan / Posisi",
    x: 6,
    y: 56,
    fontSize: 12,
    fontWeight: "600",
    color: "#7dd3fc",
    textAlign: "left",
  },
  {
    id: "el-emp-dept",
    type: "text",
    side: "front",
    sourceKey: "employee.department",
    label: "Divisi / Unit",
    x: 6,
    y: 67,
    fontSize: 11,
    fontWeight: "normal",
    color: "#cbd5e1",
    textAlign: "left",
  },
  {
    id: "el-emp-nik",
    type: "text",
    side: "front",
    sourceKey: "employee.nik",
    label: "NIK / Kode",
    x: 6,
    y: 78,
    fontSize: 10,
    fontWeight: "normal",
    color: "#94a3b8",
    textAlign: "left",
  },
  {
    id: "el-emp-qr",
    type: "qr_code",
    side: "front",
    sourceKey: "employee.qr_token",
    label: "QR Code Token",
    x: 68,
    y: 30,
    width: 26,
    height: 48,
    fontSize: 10,
    color: "#000000",
  },
  {
    id: "el-back-title",
    type: "static_text",
    side: "back",
    sourceKey: "static_text",
    staticValue: "KETENTUAN PENGGUNAAN KARTU",
    label: "Judul Belakang",
    x: 8,
    y: 12,
    fontSize: 12,
    fontWeight: "bold",
    color: "#ffffff",
    textAlign: "left",
    isUppercase: true,
  },
  {
    id: "el-back-terms",
    type: "text",
    side: "back",
    sourceKey: "company.terms",
    label: "Syarat & Ketentuan",
    x: 8,
    y: 24,
    width: 84,
    height: 42,
    fontSize: 8.5,
    fontWeight: "normal",
    color: "#cbd5e1",
    textAlign: "left",
  },
  {
    id: "el-back-sig",
    type: "company_logo",
    side: "back",
    sourceKey: "company.signature",
    label: "Tanda Tangan Pimpinan",
    x: 66,
    y: 68,
    width: 26,
    height: 18,
    fontSize: 10,
    color: "#ffffff",
  },
  {
    id: "el-back-leader",
    type: "static_text",
    side: "back",
    sourceKey: "static_text",
    staticValue: "Pimpinan Instansi",
    label: "Label Pimpinan",
    x: 66,
    y: 88,
    fontSize: 8,
    fontWeight: "600",
    color: "#94a3b8",
    textAlign: "center",
  },
]);

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

  // Seed Default Company Profile
  const now = new Date().toISOString();
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
    args: [DEFAULT_CARD_TERMS, now],
  });

  // Seed Default ID Card Template
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO id_card_template (
        id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at
      ) VALUES (
        'default_template', 'Template Default SPPG', 'landscape', NULL, NULL, ?, 1, ?, ?
      );
    `,
    args: [DEFAULT_ID_CARD_ELEMENTS_JSON, now, now],
  });
}
