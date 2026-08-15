use std::{path::Path, time::SystemTime};

use rusqlite::{params, Connection, OptionalExtension};

use super::models::{CommandError, OfflineCredential};

const DATABASE_NAME: &str = "desktop-security.db";

pub(crate) fn database(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open(path.join(DATABASE_NAME)).map_err(|_| CommandError::internal())?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
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
        buffer_shift_malam_menit INTEGER DEFAULT 120
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
      CREATE INDEX IF NOT EXISTS idx_local_log_scan_employee_date
        ON log_scan(id_karyawan, tanggal_kerja);
      CREATE INDEX IF NOT EXISTS idx_local_attendance_employee_date
        ON absensi_harian(id_karyawan, tanggal);
      CREATE INDEX IF NOT EXISTS idx_local_outbox_status_retry
        ON desktop_sync_outbox(status, next_retry_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_local_import_status
        ON import_offline(status_proses, timestamp_input);
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (1, 'desktop-security-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (2, 'desktop-operational-sync-foundation', unixepoch());
      INSERT OR IGNORE INTO desktop_schema_migration (version, name, applied_at)
      VALUES (3, 'desktop-offline-import-foundation', unixepoch());
      "#,
        )
        .map_err(|_| "Schema keamanan Desktop tidak dapat diinisialisasi.".to_owned())?;
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

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{database, initialize};

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
        assert_eq!(migrations, 3);
    }
}
