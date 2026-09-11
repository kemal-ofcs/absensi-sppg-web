use std::{path::Path, time::SystemTime};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::models::{CommandError, OfflineCredential};
use super::payroll_seed;

const DATABASE_NAME: &str = "desktop-security.db";

pub(crate) fn database(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open(path.join(DATABASE_NAME)).map_err(|_| CommandError::internal())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;",
        )
        .map_err(|_| CommandError::internal())?;
    Ok(connection)
}

pub fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

pub fn normalize_identifier(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn get_or_create_device_id(path: &Path) -> Result<String, CommandError> {
    let connection = database(path)?;
    if let Some(existing) = connection
        .query_row(
            "SELECT device_id FROM desktop_device_identity WHERE singleton_id = 1;",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
    {
        let valid = existing.len() == 71
            && existing.starts_with("device-")
            && existing[7..].bytes().all(|byte| byte.is_ascii_hexdigit());
        if valid {
            return Ok(existing);
        }
    }
    let mut random = [0_u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut random);
    let generated = format!("device-{}", hex::encode(random));
    random.zeroize();
    connection
        .execute(
            "INSERT INTO desktop_device_identity (singleton_id, device_id, created_at) VALUES (1, ?, ?) ON CONFLICT(singleton_id) DO UPDATE SET device_id = excluded.device_id, created_at = excluded.created_at;",
            params![generated, now_epoch_seconds()],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(generated)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let exists = connection
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?);"),
            [column],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| format!("Skema tabel {table} tidak dapat diperiksa."))?;
    if !exists {
        connection
            .execute(alter_sql, [])
            .map_err(|_| format!("Kolom {table}.{column} tidak dapat dimigrasikan."))?;
    }
    Ok(())
}

/// Menanam tarif default payroll dan membersihkan sisa seed versi lama.
///
/// Seed lokal dan seed cloud dulu ditulis terpisah dengan id, kode komponen,
/// dan tarif yang berbeda. Baris lokal ikut terdorong ke cloud lewat backfill
/// outbox sehingga bracket PASAL_17 menjadi dobel, sementara push BPJS selalu
/// gagal karena `component_code` UNIQUE sudah dipakai baris cloud ber-id lain.
/// Sekarang keduanya membaca `payroll_seed`, dan baris lama dihapus sekali.
fn seed_payroll_rate_tables(connection: &Connection) -> Result<(), String> {
    let legacy_ids = payroll_seed::LEGACY_RATE_IDS
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    connection
        .execute_batch(&format!(
            r#"
      DELETE FROM tax_rules WHERE id IN ({legacy_ids});
      DELETE FROM bpjs_rules WHERE id IN ({legacy_ids});
      DELETE FROM overtime_tier_rules WHERE id IN ({legacy_ids});
      DELETE FROM desktop_entity_revision
        WHERE domain = 'payroll' AND entity_key IN ({legacy_ids});
      DELETE FROM desktop_sync_outbox
        WHERE domain = 'payroll' AND entity_key IN ({legacy_ids});
      "#
        ))
        .map_err(|_| "Seed tarif payroll lama tidak dapat dibersihkan.".to_owned())?;

    for statement in [
        payroll_seed::OVERTIME_TIER_RULES_SEED_SQL,
        payroll_seed::TAX_RULES_SEED_SQL,
        payroll_seed::BPJS_RULES_SEED_SQL,
    ] {
        connection
            .execute_batch(statement)
            .map_err(|_| "Tarif default payroll tidak dapat disiapkan.".to_owned())?;
    }
    Ok(())
}

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = database(path).map_err(|error| error.message)?;
    connection
        .execute_batch(
            r#"
      CREATE TABLE IF NOT EXISTS desktop_schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_index (
        identity_key TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        kode_operator TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permission_revision INTEGER NOT NULL,
        provisioned_at INTEGER NOT NULL,
        offline_valid_until INTEGER NOT NULL,
        server_origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_credential_alias (
        alias TEXT NOT NULL,
        server_origin TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        PRIMARY KEY (alias, server_origin),
        FOREIGN KEY (identity_key) REFERENCES desktop_credential_index(identity_key)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS desktop_security_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id INTEGER,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_login_rate_limit (
        identifier_hash TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        last_attempt_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_device_identity (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        device_id TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
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
        tanggal_daftar TEXT,
        catatan TEXT,
        token_absensi TEXT UNIQUE,
        qr_code TEXT,
        status_qr TEXT DEFAULT 'Belum',
        jenis_personil TEXT,
        tanggal_mulai_aktif TEXT,
        tanggal_selesai_aktif TEXT,
        status_backup TEXT DEFAULT 'NORMAL'
      );
      CREATE TABLE IF NOT EXISTS id_card (
        id_card_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_unik TEXT UNIQUE NOT NULL,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        idcard_status TEXT DEFAULT 'Belum',
        idcard_pdf_url TEXT,
        idcard_last_generate TEXT,
        idcard_catatan TEXT,
        tanggal_generate TEXT,
        link_qr_png TEXT,
        FOREIGN KEY (id_unik) REFERENCES master_data(id_unik) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tbl_shift (
        id_shift INTEGER PRIMARY KEY,
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
        izinkan_multi_sesi INTEGER DEFAULT 0,
        shift_lanjutan_id INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS setting_gex_system (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS log_scan (
        id_log INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_scan TEXT NOT NULL,
        tanggal_kerja TEXT NOT NULL,
        jam_scan TEXT NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        divisi TEXT NOT NULL,
        jenis_scan TEXT NOT NULL,
        status_proses TEXT NOT NULL,
        sumber_data TEXT NOT NULL,
        catatan_sistem TEXT,
        keterangan TEXT,
        menit_terlambat INTEGER DEFAULT 0,
        menit_datang_awal INTEGER DEFAULT 0,
        id_referensi TEXT,
        kode_operator TEXT
      );
      CREATE TABLE IF NOT EXISTS absensi_harian (
        id_absensi INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        kelas_divisi TEXT NOT NULL,
        jam_masuk TEXT,
        jam_pulang TEXT,
        status_kehadiran TEXT NOT NULL,
        status_absen TEXT NOT NULL,
        keterangan TEXT,
        sumber TEXT NOT NULL,
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
        tanggal_tugas TEXT
      );
      CREATE TABLE IF NOT EXISTS backup_karyawan (
        id_backup TEXT PRIMARY KEY,
        tanggal_tugas TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS koreksi_admin (
        id_koreksi INTEGER PRIMARY KEY AUTOINCREMENT,
        id_referensi TEXT UNIQUE NOT NULL,
        tanggal TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS audit_absensi (
        id_audit INTEGER PRIMARY KEY AUTOINCREMENT,
        waktu TEXT NOT NULL,
        jenis TEXT NOT NULL,
        tanggal TEXT NOT NULL,
        id_karyawan TEXT NOT NULL,
        nama TEXT NOT NULL,
        baris_referensi TEXT,
        detail TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tbl_hari_libur (
        id_libur INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT UNIQUE NOT NULL,
        nama_libur TEXT NOT NULL,
        jenis_libur TEXT DEFAULT 'Libur Nasional',
        keterangan TEXT,
        status_aktif INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_local_hari_libur_tanggal
        ON tbl_hari_libur(tanggal, status_aktif);
      -- Whitelist Shift/Divisi yang tetap boleh scan pada hari libur.
      -- Cakupan memakai `kode_shift` (UNIQUE, ikut sync) dan NAMA divisi,
      -- BUKAN `id_shift` yang AUTOINCREMENT-nya berbeda tiap perangkat.
      -- PK TEXT dibuat klien; tidak ada UNIQUE pada (scope_type, scope_value)
      -- supaya dua perangkat offline yang mendaftarkan cakupan sama tidak
      -- membuat push sync gagal permanen — duplikat harmless karena
      -- penilaiannya OR, dan dicegah di lapisan aplikasi dengan pesan ramah.
      CREATE TABLE IF NOT EXISTS hari_libur_whitelist (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('SHIFT', 'DIVISI')),
        scope_value TEXT NOT NULL,
        tanggal_libur TEXT,
        keterangan TEXT,
        status_aktif INTEGER NOT NULL DEFAULT 1 CHECK (status_aktif IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_local_hari_libur_whitelist_scope
        ON hari_libur_whitelist(scope_type, scope_value, status_aktif);
      CREATE INDEX IF NOT EXISTS idx_local_hari_libur_whitelist_tanggal
        ON hari_libur_whitelist(tanggal_libur, status_aktif);
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_absensi_foto_tanggal
        ON absensi_foto(tanggal_kerja, timestamp_scan DESC);
      CREATE INDEX IF NOT EXISTS idx_local_absensi_foto_sesi
        ON absensi_foto(id_sesi);
      CREATE TABLE IF NOT EXISTS desktop_client_identity (
        server_origin TEXT PRIMARY KEY,
        client_id TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_outbox (
        event_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        operation TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        base_revision INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'synced', 'failed', 'conflict')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        server_revision INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_cursor (
        domain TEXT PRIMARY KEY,
        last_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      -- Nilai `sync_pulse` cloud per tabel yang terakhir berhasil diterapkan.
      -- Dipakai pull inkremental untuk hanya menarik tabel yang benar-benar basi.
      CREATE TABLE IF NOT EXISTS desktop_sync_table_cursor (
        table_name TEXT PRIMARY KEY,
        remote_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_sync_conflict (
        event_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        local_payload_json TEXT NOT NULL,
        server_payload_json TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (event_id) REFERENCES desktop_sync_outbox(event_id)
      );
      CREATE TABLE IF NOT EXISTS desktop_entity_revision (
        domain TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        server_revision INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (domain, entity_key)
      );
      CREATE TABLE IF NOT EXISTS import_offline (
        id_import INTEGER PRIMARY KEY,
        event_key TEXT UNIQUE NOT NULL,
        timestamp_input TEXT NOT NULL,
        tanggal TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_local_log_scan_employee_date
        ON log_scan(id_karyawan, tanggal_kerja);
      CREATE INDEX IF NOT EXISTS idx_local_log_scan_tanggal
        ON log_scan(tanggal_kerja);
      CREATE INDEX IF NOT EXISTS idx_local_attendance_employee_date
        ON absensi_harian(id_karyawan, tanggal);
      CREATE INDEX IF NOT EXISTS idx_local_absensi_tanggal
        ON absensi_harian(tanggal);
      CREATE INDEX IF NOT EXISTS idx_local_backup_tanggal_status
        ON backup_karyawan(tanggal_tugas, status_tugas);
      CREATE INDEX IF NOT EXISTS idx_local_master_data_shift_aktif
        ON master_data(id_shift, status_aktif);
      CREATE INDEX IF NOT EXISTS idx_local_outbox_status_retry
        ON desktop_sync_outbox(status, next_retry_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_local_outbox_domain_entity
        ON desktop_sync_outbox(domain, entity_key, status);
      CREATE INDEX IF NOT EXISTS idx_local_import_status
        ON import_offline(status_proses, timestamp_input);
      CREATE TABLE IF NOT EXISTS salary_configs (
        id TEXT PRIMARY KEY,
        id_karyawan TEXT NOT NULL,
        rate_per_hour INTEGER NOT NULL CHECK (rate_per_hour >= 0),
        ptkp_status TEXT NOT NULL DEFAULT 'TK/0'
          CHECK (ptkp_status IN ('TK/0','TK/1','TK/2','TK/3','K/0','K/1','K/2','K/3')),
        effective_date TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(id_karyawan, effective_date)
      );
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
      CREATE TABLE IF NOT EXISTS tax_rules (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('TER_A','TER_B','TER_C','PASAL_17')),
        bracket_min INTEGER NOT NULL,
        bracket_max INTEGER,
        rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
        effective_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS bpjs_rules (
        id TEXT PRIMARY KEY,
        component_code TEXT NOT NULL UNIQUE,
        component_name TEXT NOT NULL,
        rate_percentage REAL NOT NULL CHECK (rate_percentage >= 0),
        wage_cap INTEGER,
        effective_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
        total_holiday_hours REAL NOT NULL DEFAULT 0,
        total_holiday_overtime_index REAL NOT NULL DEFAULT 0,
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
        created_at TEXT NOT NULL,
        UNIQUE (payroll_run_id, id_karyawan)
      );
      CREATE TABLE IF NOT EXISTS payroll_audit_logs (
        id TEXT PRIMARY KEY,
        payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        performed_by TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_payroll_items_run ON payroll_items(payroll_run_id);
      CREATE INDEX IF NOT EXISTS idx_local_payroll_items_karyawan ON payroll_items(id_karyawan);
      CREATE INDEX IF NOT EXISTS idx_local_payroll_runs_status ON payroll_runs(status, period_start);
      CREATE INDEX IF NOT EXISTS idx_local_salary_configs_karyawan ON salary_configs(id_karyawan, effective_date DESC);
      -- Tarif default payroll di-seed terpisah dari `super::payroll_seed`, satu
      -- sumber bersama dengan seed cloud di `turso.rs`. Jangan tulis ulang di sini.
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (1, 'desktop-security-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (2, 'desktop-operational-sync-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (3, 'desktop-offline-import-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (4, 'desktop-payroll-foundation', unixepoch());
      "#,
        )
        .map_err(|_| "Schema keamanan Desktop tidak dapat diinisialisasi.".to_owned())?;

    seed_payroll_rate_tables(&connection)?;

    ensure_column(
        &connection,
        "tbl_shift",
        "izinkan_multi_sesi",
        "ALTER TABLE tbl_shift ADD COLUMN izinkan_multi_sesi INTEGER DEFAULT 0;",
    )?;

    // Pemisahan jam kerja hari libur (v14). Database lokal yang dibuat sebelum
    // versi ini sudah memiliki payroll_items, sehingga CREATE TABLE IF NOT
    // EXISTS di atas tidak akan menambahkan kolomnya — hanya ALTER yang bisa.
    ensure_column(
        &connection,
        "payroll_items",
        "total_holiday_hours",
        "ALTER TABLE payroll_items ADD COLUMN total_holiday_hours REAL NOT NULL DEFAULT 0;",
    )?;
    ensure_column(
        &connection,
        "payroll_items",
        "total_holiday_overtime_index",
        "ALTER TABLE payroll_items ADD COLUMN total_holiday_overtime_index REAL NOT NULL DEFAULT 0;",
    )?;

    // Stempel waktu pembuatan tarif payroll. `turso.rs` sudah memilikinya di
    // CREATE TABLE maupun di daftar ensure_column-nya, sehingga tanpa blok ini
    // tabel yang sama punya bentuk berbeda di perangkat dan di cloud. Nullable
    // karena SQLite menolak ADD COLUMN dengan default non-konstan seperti
    // `datetime('now')` — hanya CREATE TABLE yang mengizinkannya.
    for (table, column, sql) in [
        (
            "tax_rules",
            "created_at",
            "ALTER TABLE tax_rules ADD COLUMN created_at TEXT;",
        ),
        (
            "bpjs_rules",
            "created_at",
            "ALTER TABLE bpjs_rules ADD COLUMN created_at TEXT;",
        ),
        (
            "payroll_components",
            "created_at",
            "ALTER TABLE payroll_components ADD COLUMN created_at TEXT;",
        ),
    ] {
        ensure_column(&connection, table, column, sql)?;
    }

    // Shift tujuan sesi lanjutan. 0 = belum ditentukan, sehingga pemasangan
    // lama yang hanya menyalakan izinkan_multi_sesi tetap memakai pencocokan
    // jendela otomatis seperti sebelumnya.
    ensure_column(
        &connection,
        "tbl_shift",
        "shift_lanjutan_id",
        "ALTER TABLE tbl_shift ADD COLUMN shift_lanjutan_id INTEGER DEFAULT 0;",
    )?;

    let has_holiday_table: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tbl_hari_libur';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);
    if !has_holiday_table {
        connection
            .execute_batch(
                r#"
            CREATE TABLE IF NOT EXISTS tbl_hari_libur (
                id_libur INTEGER PRIMARY KEY AUTOINCREMENT,
                tanggal TEXT UNIQUE NOT NULL,
                nama_libur TEXT NOT NULL,
                jenis_libur TEXT DEFAULT 'Libur Nasional',
                keterangan TEXT,
                status_aktif INTEGER DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_local_hari_libur_tanggal
                ON tbl_hari_libur(tanggal, status_aktif);
            "#,
            )
            .map_err(|_| "Tabel hari libur lokal tidak dapat dimigrasikan.".to_owned())?;
    }

    let has_company_profile: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'company_profile';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);
    if !has_company_profile {
        connection
            .execute_batch(
                r#"
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
            "#,
            )
            .map_err(|_| "Tabel profil perusahaan lokal tidak dapat dimigrasikan.".to_owned())?;
    }

    let has_id_card_template: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'id_card_template';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);
    if !has_id_card_template {
        connection
            .execute_batch(
                r#"
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
            "#,
            )
            .map_err(|_| "Tabel template ID card lokal tidak dapat dimigrasikan.".to_owned())?;
    }

    // Idempotent column migrations for legacy operational databases.
    for (column, sql) in [
        (
            "timestamp_input",
            "ALTER TABLE import_offline ADD COLUMN timestamp_input TEXT;",
        ),
        (
            "id_unik",
            "ALTER TABLE import_offline ADD COLUMN id_unik TEXT;",
        ),
        (
            "status_absen",
            "ALTER TABLE import_offline ADD COLUMN status_absen TEXT;",
        ),
        (
            "status_proses",
            "ALTER TABLE import_offline ADD COLUMN status_proses TEXT DEFAULT 'Belum Diproses';",
        ),
        (
            "diproses_pada",
            "ALTER TABLE import_offline ADD COLUMN diproses_pada TEXT;",
        ),
        (
            "pesan_error",
            "ALTER TABLE import_offline ADD COLUMN pesan_error TEXT;",
        ),
    ] {
        ensure_column(&connection, "import_offline", column, sql)?;
    }

    connection
        .execute_batch(
            r#"
            UPDATE desktop_sync_outbox
            SET domain = 'log-scan'
            WHERE domain IN ('scan-log', 'scan_log', 'log_scan');
            DELETE FROM desktop_entity_revision AS legacy
            WHERE legacy.domain IN ('scan-log', 'scan_log', 'log_scan')
              AND EXISTS (
                SELECT 1 FROM desktop_entity_revision AS canonical
                WHERE canonical.domain = 'log-scan'
                  AND canonical.entity_key = legacy.entity_key
              );
            UPDATE desktop_entity_revision
            SET domain = 'log-scan'
            WHERE domain IN ('scan-log', 'scan_log', 'log_scan');
            "#,
        )
        .map_err(|_| "Domain sinkronisasi log scan lokal tidak dapat dinormalisasi.".to_owned())?;

    Ok(())
}

/// Tabel operasional lokal yang isinya 100% milik satu database cloud.
///
/// Semuanya adalah cache dari Turso: tidak ada satu pun baris di sini yang
/// bermakna tanpa database asalnya. Ketika perangkat dipindahkan ke database
/// Turso lain, isi tabel-tabel inilah yang harus hilang.
const CLOUD_MIRRORED_TABLES: &[&str] = &[
    "absensi_harian",
    "log_scan",
    "koreksi_admin",
    "import_offline",
    "audit_absensi",
    "backup_karyawan",
    "id_card",
    "id_card_template",
    "master_data",
    "tbl_shift",
    "tbl_hari_libur",
    "hari_libur_whitelist",
    "company_profile",
    "payroll_audit_logs",
    "payroll_items",
    "payroll_runs",
    "payroll_components",
    "salary_configs",
    "overtime_tier_rules",
    "tax_rules",
    "bpjs_rules",
];

/// Membuang seluruh jejak database cloud lama ketika perangkat dipindahkan ke
/// database Turso yang berbeda.
///
/// Tanpa ini, memindah aplikasi ke database baru hanya mengganti kredensial:
/// karyawan, absensi, log scan, dan payroll dari database lama tetap tersimpan
/// di SQLite lokal, tetap tampil di layar, dan outbox lama tetap terdorong ke
/// database baru. Snapshot pull tidak bisa membereskannya karena `delete_missing`
/// sengaja dimatikan untuk hampir semua tabel — cloud kosong memang tidak boleh
/// menghapus data lokal yang belum pernah dilacak server. Jadi pembersihan wajib
/// dilakukan tepat di titik perpindahan database.
///
/// Yang sengaja DIPERTAHANKAN: `desktop_schema_migration`, `desktop_device_identity`,
/// dan `desktop_client_identity` (identitas perangkat dipakai untuk membuka vault
/// kredensial yang baru saja ditulis), serta setting koneksi milik perangkat ini
/// (`device_local_setting_keys`) yang justru menentukan database tujuan baru.
pub fn reset_cloud_linked_data(
    path: &Path,
    device_local_setting_keys: &[&str],
) -> Result<(), CommandError> {
    let mut connection = database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    // Foreign key antar tabel cache tidak relevan saat seluruh cache dibuang.
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(|_| CommandError::internal())?;

    for table in CLOUD_MIRRORED_TABLES {
        transaction
            .execute(&format!("DELETE FROM {table};"), [])
            .map_err(|_| {
                CommandError::new(
                    "LOCAL_RESET_FAILED",
                    "Data lokal database lama tidak dapat dibersihkan.",
                )
            })?;
    }

    // Setting operasional ikut dibuang, kecuali kunci koneksi perangkat ini.
    let placeholders = vec!["?"; device_local_setting_keys.len()].join(", ");
    transaction
        .execute(
            &format!("DELETE FROM setting_gex_system WHERE key NOT IN ({placeholders});"),
            rusqlite::params_from_iter(device_local_setting_keys.iter()),
        )
        .map_err(|_| {
            CommandError::new(
                "LOCAL_RESET_FAILED",
                "Pengaturan lokal database lama tidak dapat dibersihkan.",
            )
        })?;

    // Seluruh state sinkronisasi milik database lama: outbox yang belum terkirim
    // ke database lama TIDAK boleh dikirim ke database baru.
    transaction
        .execute_batch(
            r#"
            DELETE FROM desktop_sync_outbox;
            DELETE FROM desktop_sync_conflict;
            DELETE FROM desktop_entity_revision;
            DELETE FROM desktop_sync_cursor;
            DELETE FROM desktop_sync_table_cursor;
            DELETE FROM desktop_credential_alias;
            DELETE FROM desktop_credential_index;
            DELETE FROM desktop_login_rate_limit;
            "#,
        )
        .map_err(|_| {
            CommandError::new(
                "LOCAL_RESET_FAILED",
                "Status sinkronisasi database lama tidak dapat dibersihkan.",
            )
        })?;

    // Tarif default payroll bukan data cloud, melainkan seed bawaan aplikasi.
    // Tabelnya baru saja dikosongkan, jadi tanam ulang di transaksi yang sama.
    seed_payroll_rate_tables(&transaction).map_err(|message| {
        CommandError::new("LOCAL_RESET_FAILED", message)
    })?;

    transaction.commit().map_err(|_| CommandError::internal())?;

    // Snapshot login offline terikat ke origin database lama, jadi sudah tidak
    // pernah bisa dipakai lagi. Buang berkasnya supaya kredensial operator
    // database lama tidak tertinggal di perangkat. Vault koneksi Turso
    // (`turso_config.*`) justru baru saja ditulis untuk database baru — jangan
    // disentuh.
    let credentials_dir = path.join("credentials");
    if let Ok(entries) = std::fs::read_dir(&credentials_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("turso_config.") {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }

    Ok(())
}

pub fn save_credential_index(
    path: &Path,
    credential: &OfflineCredential,
) -> Result<(), CommandError> {
    let mut connection = database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            r#"
      INSERT INTO desktop_credential_index (
        identity_key, operator_id, username, kode_operator, role_key,
        permission_revision, provisioned_at, offline_valid_until, server_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        operator_id = excluded.operator_id,
        username = excluded.username,
        kode_operator = excluded.kode_operator,
        role_key = excluded.role_key,
        permission_revision = excluded.permission_revision,
        provisioned_at = excluded.provisioned_at,
        offline_valid_until = excluded.offline_valid_until,
        server_origin = excluded.server_origin;
      "#,
            params![
                credential.identity_key,
                credential.operator.id,
                credential.operator.username,
                credential.operator.kode_operator,
                credential.operator.role_key,
                credential.operator.permission_revision,
                credential.provisioned_at,
                credential.offline_valid_until,
                credential.server_origin,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM desktop_credential_alias WHERE identity_key = ?;",
            params![credential.identity_key],
        )
        .map_err(|_| CommandError::internal())?;

    for alias in [
        normalize_identifier(&credential.operator.username),
        normalize_identifier(&credential.operator.kode_operator),
    ] {
        transaction
            .execute(
                r#"
        INSERT INTO desktop_credential_alias (alias, server_origin, identity_key)
        VALUES (?, ?, ?)
        ON CONFLICT(alias, server_origin) DO UPDATE SET
          identity_key = excluded.identity_key;
        "#,
                params![alias, credential.server_origin, credential.identity_key],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(())
}

pub fn find_identity_key(
    path: &Path,
    server_origin: &str,
    identifier: &str,
) -> Result<Option<String>, CommandError> {
    database(path)?
        .query_row(
            r#"
      SELECT identity_key FROM desktop_credential_alias
      WHERE alias = ? AND server_origin = ? LIMIT 1;
      "#,
            params![normalize_identifier(identifier), server_origin],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn audit(path: &Path, operator_id: Option<i64>, event_type: &str, detail: Option<&str>) {
    if let Ok(connection) = database(path) {
        let _ = connection.execute(
            r#"
      INSERT INTO desktop_security_audit (operator_id, event_type, event_at, detail)
      VALUES (?, ?, ?, ?);
      "#,
            params![operator_id, event_type, now_epoch_seconds(), detail],
        );
    }
}

pub fn get_system_setting(path: &Path, key: &str) -> Result<Option<String>, CommandError> {
    database(path)?
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn set_system_setting(path: &Path, key: &str, value: &str) -> Result<(), CommandError> {
    database(path)?
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![key, value],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

fn login_identifier_hash(identifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_identifier(identifier).as_bytes());
    hex::encode(hasher.finalize())
}

pub fn login_lock_remaining(path: &Path, identifier: &str) -> Result<Option<i64>, CommandError> {
    let connection = database(path)?;
    let identifier_hash = login_identifier_hash(identifier);
    let now = now_epoch_seconds();
    let locked_until: Option<i64> = connection
        .query_row(
            "SELECT locked_until FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
            [&identifier_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .flatten();
    if let Some(until) = locked_until.filter(|until| *until > now) {
        return Ok(Some(until.saturating_sub(now)));
    }
    if locked_until.is_some() {
        connection
            .execute(
                "DELETE FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
                [&identifier_hash],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(None)
}

pub fn record_failed_login(path: &Path, identifier: &str) -> Result<Option<i64>, CommandError> {
    let connection = database(path)?;
    let identifier_hash = login_identifier_hash(identifier);
    let now = now_epoch_seconds();
    connection
        .execute(
            r#"INSERT INTO desktop_login_rate_limit (
                identifier_hash, failed_attempts, locked_until, last_attempt_at
            ) VALUES (?, 1, NULL, ?)
            ON CONFLICT(identifier_hash) DO UPDATE SET
                failed_attempts = desktop_login_rate_limit.failed_attempts + 1,
                locked_until = CASE
                    WHEN desktop_login_rate_limit.failed_attempts + 1 >= 5 THEN ? + 120
                    ELSE desktop_login_rate_limit.locked_until
                END,
                last_attempt_at = excluded.last_attempt_at;"#,
            params![identifier_hash, now, now],
        )
        .map_err(|_| CommandError::internal())?;
    login_lock_remaining(path, identifier)
}

pub fn clear_login_failures(path: &Path, identifier: &str) -> Result<(), CommandError> {
    database(path)?
        .execute(
            "DELETE FROM desktop_login_rate_limit WHERE identifier_hash = ?;",
            [login_identifier_hash(identifier)],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::payroll_seed;
    use super::{
        clear_login_failures, database, get_or_create_device_id, initialize, login_lock_remaining,
        record_failed_login, reset_cloud_linked_data, set_system_setting,
    };

    #[test]
    fn initializes_operational_schema_idempotently() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("first initialization");
        initialize(directory.path()).expect("second initialization");

        let connection = database(directory.path()).expect("database connection");
        for table in [
            "master_data",
            "tbl_shift",
            "log_scan",
            "absensi_harian",
            "desktop_sync_outbox",
            "desktop_sync_cursor",
            "desktop_sync_conflict",
            "desktop_login_rate_limit",
            "desktop_device_identity",
        ] {
            let total: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?;",
                    [table],
                    |row| row.get(0),
                )
                .expect("schema query");
            assert_eq!(total, 1, "missing table {table}");
        }

        let migrations: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_schema_migration;",
                [],
                |row| row.get(0),
            )
            .expect("migration count");
        assert_eq!(migrations, 4);
    }

    /// Pindah database cloud harus membuang seluruh cache database lama, tetapi
    /// tidak boleh menyentuh identitas perangkat, kunci koneksi perangkat, atau
    /// seed tarif payroll bawaan aplikasi.
    #[test]
    fn switching_cloud_database_purges_old_local_data() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");
        let device_id = get_or_create_device_id(directory.path()).expect("device id");

        let connection = database(directory.path()).expect("database connection");
        connection
            .execute(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift) VALUES ('E1', 'K1', 'Karyawan Lama', 'Dapur', 1);",
                [],
            )
            .expect("seed employee");
        connection
            .execute(
                "INSERT INTO desktop_sync_outbox (event_id, client_id, domain, operation, entity_key, payload_json, status, created_at, updated_at) VALUES ('EV1', 'C1', 'employee', 'update', 'E1', '{}', 'pending', 0, 0);",
                [],
            )
            .expect("seed outbox");
        drop(connection);

        set_system_setting(directory.path(), "geofence_radius", "250").expect("seed setting");
        set_system_setting(
            directory.path(),
            "turso_database_url",
            "libsql://lama.turso.io",
        )
        .expect("seed device-local setting");

        let credentials = directory.path().join("credentials");
        std::fs::create_dir_all(&credentials).expect("credentials directory");
        std::fs::write(credentials.join("operator-lama.stronghold"), b"x").expect("write snapshot");
        std::fs::write(credentials.join("turso_config.vault"), b"y").expect("write vault");

        reset_cloud_linked_data(directory.path(), &["turso_database_url", "turso_auth_token"])
            .expect("reset local workspace");

        let connection = database(directory.path()).expect("database connection");
        for table in ["master_data", "desktop_sync_outbox", "desktop_entity_revision"] {
            let total: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .expect("count rows");
            assert_eq!(total, 0, "{table} masih menyimpan data database lama");
        }

        let leftover_settings: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM setting_gex_system WHERE key = 'geofence_radius';",
                [],
                |row| row.get(0),
            )
            .expect("count settings");
        assert_eq!(leftover_settings, 0, "setting database lama harus terbuang");

        let kept_url: String = connection
            .query_row(
                "SELECT value FROM setting_gex_system WHERE key = 'turso_database_url';",
                [],
                |row| row.get(0),
            )
            .expect("device-local setting harus dipertahankan");
        assert_eq!(kept_url, "libsql://lama.turso.io");

        // Tarif default payroll ditanam ulang, bukan ikut terbuang.
        let tax_rules: i64 = connection
            .query_row("SELECT COUNT(*) FROM tax_rules;", [], |row| row.get(0))
            .expect("count tax rules");
        assert!(tax_rules > 0, "seed tarif pajak harus ditanam ulang");
        drop(connection);

        // Identitas perangkat dipakai membuka vault koneksi yang baru ditulis.
        assert_eq!(
            get_or_create_device_id(directory.path()).expect("device id"),
            device_id
        );
        assert!(!credentials.join("operator-lama.stronghold").is_file());
        assert!(credentials.join("turso_config.vault").is_file());
    }

    #[test]
    fn login_is_temporarily_locked_after_five_failures() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");
        for _ in 0..4 {
            assert_eq!(
                record_failed_login(directory.path(), " Operator.Test ").expect("record failure"),
                None
            );
        }
        assert!(record_failed_login(directory.path(), "operator.test")
            .expect("record fifth failure")
            .is_some());
        assert!(login_lock_remaining(directory.path(), "OPERATOR.TEST")
            .expect("read lock")
            .is_some());
        clear_login_failures(directory.path(), "operator.test").expect("clear failures");
        assert_eq!(
            login_lock_remaining(directory.path(), "operator.test").expect("read cleared lock"),
            None
        );
    }

    #[test]
    fn device_identity_is_local_and_stable() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("initialize schema");
        let first = get_or_create_device_id(directory.path()).expect("first device id");
        let second = get_or_create_device_id(directory.path()).expect("second device id");
        assert_eq!(first, second);
        assert!(first.starts_with("device-"));
        assert_eq!(first.len(), 71);
    }

    #[test]
    fn tarif_default_lokal_memakai_id_yang_sama_dengan_cloud() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("local schema");
        let connection = database(directory.path()).expect("local database");

        // Id seed lokal harus identik dengan seed cloud. Dulu lokal memakai
        // `tax-p17-1` sementara cloud `tax_p17_1`, sehingga baris lokal ikut
        // terdorong ke cloud dan bracket PASAL_17 menjadi dobel.
        for table in ["tax_rules", "bpjs_rules", "overtime_tier_rules"] {
            let mut statement = connection
                .prepare(&format!("SELECT id FROM {table};"))
                .expect("rate query");
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("rate rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("rate ids");
            assert!(!ids.is_empty(), "{table} harus punya tarif default");
            for id in &ids {
                assert!(
                    payroll_seed::DEFAULT_RATE_IDS.contains(&id.as_str()),
                    "{table} memuat id tak terdaftar di payroll_seed: {id}"
                );
                assert!(
                    !payroll_seed::LEGACY_RATE_IDS.contains(&id.as_str()),
                    "{table} masih memuat id seed lama: {id}"
                );
            }
        }

        // PPh 21 butuh Pasal 17 dan TER; lokal dulu hanya punya Pasal 17.
        for category in ["PASAL_17", "TER_A", "TER_B", "TER_C"] {
            let total: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM tax_rules WHERE category = ?;",
                    [category],
                    |row| row.get(0),
                )
                .expect("tax category count");
            assert!(total > 0, "kategori tarif {category} tidak ter-seed di lokal");
        }
    }

    #[test]
    fn seed_tarif_lama_dibersihkan_saat_inisialisasi_ulang() {
        let directory = tempdir().expect("temporary directory");
        initialize(directory.path()).expect("local schema");
        let connection = database(directory.path()).expect("local database");
        connection
            .execute(
                "INSERT INTO tax_rules (id, category, bracket_min, bracket_max, rate_percentage, effective_date)
                 VALUES ('tax-p17-1', 'PASAL_17', 0, 60000000, 5.0, '2024-01-01');",
                [],
            )
            .expect("legacy row");
        drop(connection);

        initialize(directory.path()).expect("re-initialize");
        let connection = database(directory.path()).expect("local database");
        let leftover: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tax_rules WHERE id = 'tax-p17-1';",
                [],
                |row| row.get(0),
            )
            .expect("legacy count");
        assert_eq!(leftover, 0, "baris seed lama harus dibersihkan");
    }
}
