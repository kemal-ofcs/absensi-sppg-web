use std::{collections::HashSet, time::SystemTime};

use rusqlite::{params, types::Value as SqlValue, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    config::DesktopState,
    models::{CommandError, DesktopSyncStatus},
    remote, storage,
};

struct SnapshotTable {
    payload_key: &'static str,
    domain: &'static str,
    table: &'static str,
    columns: &'static [&'static str],
    conflict_column: &'static str,
    entity_column: &'static str,
    delete_missing: bool,
}

const SNAPSHOT_TABLES: &[SnapshotTable] = &[
    SnapshotTable {
        payload_key: "employees",
        domain: "employee",
        table: "master_data",
        columns: &[
            "id_unik",
            "kode_karyawan",
            "nama",
            "divisi",
            "jabatan_status",
            "no_hp",
            "lp",
            "id_shift",
            "status_aktif",
            "tanggal_daftar",
            "catatan",
            "token_absensi",
            "qr_code",
            "status_qr",
            "jenis_personil",
            "tanggal_mulai_aktif",
            "tanggal_selesai_aktif",
            "status_backup",
        ],
        conflict_column: "id_unik",
        entity_column: "id_unik",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "idCards",
        domain: "id-card",
        table: "id_card",
        columns: &[
            "id_unik",
            "nama",
            "divisi",
            "idcard_status",
            "idcard_pdf_url",
            "idcard_last_generate",
            "idcard_catatan",
            "tanggal_generate",
            "link_qr_png",
        ],
        conflict_column: "id_unik",
        entity_column: "id_unik",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "shifts",
        domain: "shift",
        table: "tbl_shift",
        columns: &[
            "id_shift",
            "kode_shift",
            "nama_shift",
            "jam_masuk",
            "jam_pulang",
            "awal_absen_menit",
            "batas_masuk_menit",
            "toleransi_masuk_menit",
            "jam_kerja_normal_menit",
            "istirahat_menit",
            "batas_pulang_menit",
            "offset_istirahat_mulai",
            "offset_generate_alfa",
            "buffer_shift_malam_menit",
            "izinkan_multi_sesi",
        ],
        conflict_column: "id_shift",
        entity_column: "id_shift",
        delete_missing: true,
    },
    SnapshotTable {
        payload_key: "holidays",
        domain: "holiday",
        table: "tbl_hari_libur",
        columns: &[
            "id_libur",
            "tanggal",
            "nama_libur",
            "jenis_libur",
            "keterangan",
            "status_aktif",
        ],
        conflict_column: "tanggal",
        entity_column: "tanggal",
        delete_missing: true,
    },
    SnapshotTable {
        payload_key: "settings",
        domain: "setting",
        table: "setting_gex_system",
        columns: &["key", "value"],
        conflict_column: "key",
        entity_column: "key",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "companyProfiles",
        domain: "company-profile",
        table: "company_profile",
        columns: &[
            "id",
            "company_name",
            "branch_name",
            "logo_url",
            "signature_url",
            "address",
            "phone",
            "email",
            "website",
            "leader_name",
            "leader_title",
            "leader_nip",
            "card_terms",
            "timezone",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "idCardTemplates",
        domain: "id-card-template",
        table: "id_card_template",
        columns: &[
            "id",
            "name",
            "orientation",
            "front_bg_url",
            "back_bg_url",
            "elements_json",
            "is_active",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "backups",
        domain: "backup",
        table: "backup_karyawan",
        columns: &[
            "id_backup",
            "tanggal_tugas",
            "id_karyawan_asal",
            "nama_karyawan_asal",
            "divisi_asal",
            "id_shift_asal",
            "id_karyawan_pengganti",
            "nama_karyawan_pengganti",
            "divisi_pengganti",
            "id_shift_normal_pengganti",
            "id_shift_backup",
            "alasan_backup",
            "status_tugas",
            "kode_operator",
            "waktu_input",
            "catatan",
            "waktu_dibatalkan",
            "operator_pembatalan",
        ],
        conflict_column: "id_backup",
        entity_column: "id_backup",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "corrections",
        domain: "correction",
        table: "koreksi_admin",
        columns: &[
            "id_referensi",
            "tanggal",
            "id_karyawan",
            "nama",
            "divisi",
            "jenis_koreksi",
            "jam_koreksi",
            "keterangan_admin",
            "status_proses",
            "timestamp",
            "kode_operator",
        ],
        conflict_column: "id_referensi",
        entity_column: "id_referensi",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "imports",
        domain: "offline-import",
        table: "import_offline",
        columns: &[
            "event_key",
            "timestamp_input",
            "tanggal",
            "id_unik",
            "nama",
            "divisi",
            "jam_masuk",
            "jam_pulang",
            "status_kehadiran",
            "status_absen",
            "keterangan",
            "status_proses",
            "diproses_pada",
            "pesan_error",
            "kode_operator",
        ],
        conflict_column: "event_key",
        entity_column: "event_key",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "attendance",
        domain: "attendance",
        table: "absensi_harian",
        columns: &[
            "tanggal",
            "id_karyawan",
            "nama",
            "kelas_divisi",
            "jam_masuk",
            "jam_pulang",
            "status_kehadiran",
            "status_absen",
            "keterangan",
            "sumber",
            "update_terakhir",
            "menit_terlambat",
            "menit_datang_awal",
            "jam_kerja",
            "lembur",
            "jam_kerja_kurang",
            "id_shift",
            "bulan",
            "tahun",
            "id_sesi",
            "mode_tugas",
            "id_backup",
            "id_karyawan_asal",
            "tanggal_tugas",
        ],
        conflict_column: "id_sesi",
        entity_column: "id_sesi",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "scanLogs",
        domain: "log-scan",
        table: "log_scan",
        columns: &[
            "id_log",
            "timestamp_scan",
            "tanggal_kerja",
            "jam_scan",
            "id_karyawan",
            "nama",
            "divisi",
            "jenis_scan",
            "status_proses",
            "sumber_data",
            "catatan_sistem",
            "keterangan",
            "menit_terlambat",
            "menit_datang_awal",
            "id_referensi",
            "kode_operator",
        ],
        conflict_column: "id_log",
        entity_column: "id_log",
        delete_missing: false,
    },
];

const CANONICAL_SYNC_ROUTES: &[(&str, &str)] = &[
    ("attendance", "create"),
    ("attendance", "delete"),
    ("attendance", "scan"),
    ("attendance", "update"),
    ("backup", "cancel"),
    ("backup", "create"),
    ("company-profile", "update"),
    ("correction", "create"),
    ("correction", "delete"),
    ("employee", "create"),
    ("employee", "status"),
    ("employee", "token"),
    ("employee", "update"),
    ("holiday", "create"),
    ("holiday", "delete"),
    ("holiday", "update"),
    ("id-card", "update"),
    ("id-card-template", "save"),
    ("log-scan", "delete"),
    ("offline-import", "delete"),
    ("offline-import", "row"),
    ("setting", "update"),
    ("setting", "upsert"),
    ("shift", "create"),
    ("shift", "delete"),
    ("shift", "update"),
];

pub(super) fn is_canonical_sync_route(domain: &str, operation: &str) -> bool {
    CANONICAL_SYNC_ROUTES
        .iter()
        .any(|route| *route == (domain, operation))
}

fn sql_value(value: Option<&Value>) -> SqlValue {
    match value {
        None | Some(Value::Null) => SqlValue::Null,
        Some(Value::Bool(value)) => SqlValue::Integer(i64::from(*value)),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Some(Value::String(value)) => SqlValue::Text(value.clone()),
        Some(value) => SqlValue::Text(value.to_string()),
    }
}

fn entity_key(row: &Value, column: &str) -> String {
    match row.get(column) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string().trim_matches('"').to_owned(),
        None => String::new(),
    }
}

fn has_unsynced_change(
    transaction: &Transaction<'_>,
    domain: &str,
    key: &str,
) -> Result<bool, CommandError> {
    transaction
        .query_row(
            r#"
      SELECT EXISTS(
        SELECT 1 FROM desktop_sync_outbox
        WHERE domain = ? AND entity_key = ?
          AND status IN ('pending', 'failed', 'conflict')
      );
      "#,
            params![domain, key],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

fn row_has_unsynced_change(
    transaction: &Transaction<'_>,
    definition: &SnapshotTable,
    row: &Value,
    key: &str,
) -> Result<bool, CommandError> {
    if has_unsynced_change(transaction, definition.domain, key)? {
        return Ok(true);
    }
    if definition.domain == "shift" {
        let code = entity_key(row, "kode_shift");
        if !code.is_empty()
            && (has_unsynced_change(transaction, definition.domain, &format!("kode:{code}"))?
                || has_unsynced_change(transaction, definition.domain, &code)?)
        {
            return Ok(true);
        }
        let shift_id = entity_key(row, "id_shift");
        if !shift_id.is_empty() && has_unsynced_change(transaction, definition.domain, &shift_id)? {
            return Ok(true);
        }
    }
    if definition.domain == "attendance" {
        let pending_attendance: bool = transaction
            .query_row(
                r#"
        SELECT EXISTS(
          SELECT 1 FROM desktop_sync_outbox
          WHERE status IN ('pending', 'failed', 'conflict')
            AND COALESCE(json_extract(payload_json, '$.attendance.id_sesi'), '') = ?
        );
        "#,
                [key],
                |result| result.get(0),
            )
            .map_err(|_| CommandError::internal())?;
        if pending_attendance {
            return Ok(true);
        }
    }
    if definition.domain == "log-scan" {
        let timestamp = entity_key(row, "timestamp_scan");
        let employee_id = entity_key(row, "id_karyawan");
        let scan_type = entity_key(row, "jenis_scan");
        let reference_id = entity_key(row, "id_referensi");
        let pending_log: bool = transaction
            .query_row(
                r#"
        SELECT EXISTS(
          SELECT 1 FROM desktop_sync_outbox
          WHERE status IN ('pending', 'failed', 'conflict')
            AND COALESCE(json_extract(payload_json, '$.log.timestamp_scan'), '') = ?
            AND COALESCE(json_extract(payload_json, '$.log.id_karyawan'), '') = ?
            AND COALESCE(json_extract(payload_json, '$.log.jenis_scan'), '') = ?
            AND COALESCE(json_extract(payload_json, '$.log.id_referensi'), '') = ?
        );
        "#,
                params![timestamp, employee_id, scan_type, reference_id],
                |result| result.get(0),
            )
            .map_err(|_| CommandError::internal())?;
        if pending_log {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sync_table_error(table: &str) -> CommandError {
    CommandError::new(
        "DESKTOP_SYNC_APPLY_FAILED",
        format!("Snapshot tabel {table} tidak dapat diterapkan ke database lokal."),
    )
}

fn reconcile_shift_ids(
    transaction: &Transaction<'_>,
    snapshot: &Value,
) -> Result<(), CommandError> {
    let empty_vec = Vec::new();
    let shifts = match snapshot.get("shifts").and_then(Value::as_array) {
        Some(arr) => arr,
        None => &empty_vec,
    };
    for shift in shifts {
        let Some(server_id) = shift.get("id_shift").and_then(Value::as_i64) else {
            continue;
        };
        let Some(code) = shift.get("kode_shift").and_then(Value::as_i64) else {
            continue;
        };
        if server_id <= 0 || has_unsynced_change(transaction, "shift", &format!("kode:{code}"))? {
            continue;
        }
        let local_id = transaction
            .query_row(
                "SELECT id_shift FROM tbl_shift WHERE kode_shift = ? LIMIT 1;",
                [code],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| sync_table_error("tbl_shift"))?;
        let Some(local_id) = local_id.filter(|local_id| *local_id != server_id) else {
            continue;
        };
        transaction
            .execute(
                "UPDATE master_data SET id_shift = ? WHERE id_shift = ?;",
                params![server_id, local_id],
            )
            .map_err(|_| sync_table_error("tbl_shift"))?;
        transaction
            .execute(
                "UPDATE absensi_harian SET id_shift = ? WHERE id_shift = ?;",
                params![server_id, local_id],
            )
            .map_err(|_| sync_table_error("tbl_shift"))?;
        let server_id_exists = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tbl_shift WHERE id_shift = ?);",
                [server_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if server_id_exists {
            transaction
                .execute("DELETE FROM tbl_shift WHERE id_shift = ?;", [local_id])
                .map_err(|_| sync_table_error("tbl_shift"))?;
        } else {
            transaction
                .execute(
                    "UPDATE tbl_shift SET id_shift = ? WHERE id_shift = ?;",
                    params![server_id, local_id],
                )
                .map_err(|_| sync_table_error("tbl_shift"))?;
        }
    }
    Ok(())
}

fn apply_table(
    transaction: &Transaction<'_>,
    snapshot: &Value,
    definition: &SnapshotTable,
    revision: i64,
) -> Result<(), CommandError> {
    let empty_vec = Vec::new();
    let (rows, present) = match snapshot
        .get(definition.payload_key)
        .and_then(Value::as_array)
    {
        Some(arr) => (arr, true),
        None => (&empty_vec, false),
    };
    let placeholders = vec!["?"; definition.columns.len()].join(", ");
    let updates = definition
        .columns
        .iter()
        .filter(|column| **column != definition.conflict_column)
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let statement = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) DO UPDATE SET {};",
        definition.table,
        definition.columns.join(", "),
        placeholders,
        definition.conflict_column,
        updates,
    );

    let snapshot_keys = rows
        .iter()
        .map(|row| entity_key(row, definition.entity_column))
        .filter(|key| !key.is_empty())
        .collect::<HashSet<_>>();

    for row in rows {
        let key = entity_key(row, definition.entity_column);
        if key.is_empty() || row_has_unsynced_change(transaction, definition, row, &key)? {
            continue;
        }

        if definition.domain == "log-scan" {
            let ts = entity_key(row, "timestamp_scan");
            let emp = entity_key(row, "id_karyawan");
            let kind = entity_key(row, "jenis_scan");
            let tgl = entity_key(row, "tanggal_kerja");
            let ref_id = entity_key(row, "id_referensi");
            // Bersihkan baris log scan lokal sementara (id_log < 0) yang cocok sebelum memasukkan baris server
            let _ = transaction.execute(
                "DELETE FROM log_scan WHERE id_log < 0 AND tanggal_kerja = ? AND id_karyawan = ? AND (jenis_scan = ? OR (id_referensi = ? AND id_referensi != '') OR timestamp_scan = ?);",
                params![tgl, emp, kind, ref_id, ts],
            );
        }

        let values = definition
            .columns
            .iter()
            .map(|column| sql_value(row.get(*column)))
            .collect::<Vec<_>>();
        transaction
            .execute(&statement, rusqlite::params_from_iter(values))
            .map_err(|_| sync_table_error(definition.table))?;
        let mut hasher = Sha256::new();
        hasher.update(row.to_string().as_bytes());
        transaction
            .execute(
                r#"
        INSERT INTO desktop_entity_revision (
          domain, entity_key, server_revision, payload_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(domain, entity_key) DO UPDATE SET
          server_revision = excluded.server_revision,
          payload_hash = excluded.payload_hash,
          updated_at = excluded.updated_at;
        "#,
                params![
                    definition.domain,
                    key,
                    revision,
                    hex::encode(hasher.finalize()),
                    storage::now_epoch_seconds(),
                ],
            )
            .map_err(|_| CommandError::internal())?;
    }
    if definition.delete_missing && present {
        let select = format!(
            "SELECT CAST({} AS TEXT) FROM {};",
            definition.entity_column, definition.table
        );
        let mut statement = transaction
            .prepare(&select)
            .map_err(|_| CommandError::internal())?;
        let local_keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| CommandError::internal())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?;
        drop(statement);
        let delete = format!(
            "DELETE FROM {} WHERE CAST({} AS TEXT) = ?;",
            definition.table, definition.entity_column
        );
        for key in local_keys {
            if snapshot_keys.contains(&key)
                || has_unsynced_change(transaction, definition.domain, &key)?
            {
                continue;
            }
            let came_from_server = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM desktop_entity_revision WHERE domain = ? AND entity_key = ?);",
                    params![definition.domain, key],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| CommandError::internal())?;
            if !came_from_server {
                continue;
            }
            transaction
                .execute(&delete, [&key])
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    "DELETE FROM desktop_entity_revision WHERE domain = ? AND entity_key = ?;",
                    params![definition.domain, key],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }
    Ok(())
}

pub fn ensure_client_id(state: &DesktopState) -> Result<String, CommandError> {
    let server_origin = state.server_origin();
    let connection = storage::database(&state.data_dir)?;
    if let Ok(client_id) = connection.query_row(
        "SELECT client_id FROM desktop_client_identity WHERE server_origin = ?;",
        [&server_origin],
        |row| row.get(0),
    ) {
        return Ok(client_id);
    }
    let created_at = storage::now_epoch_seconds();
    let mut hasher = Sha256::new();
    hasher.update(server_origin.as_bytes());
    hasher.update(state.data_dir.to_string_lossy().as_bytes());
    hasher.update(created_at.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let client_id = format!("desktop-{}", hex::encode(hasher.finalize()));
    connection
        .execute(
            r#"
      INSERT OR IGNORE INTO desktop_client_identity (server_origin, client_id, created_at)
      VALUES (?, ?, ?);
      "#,
            params![server_origin, client_id, created_at],
        )
        .map_err(|_| CommandError::internal())?;
    connection
        .query_row(
            "SELECT client_id FROM desktop_client_identity WHERE server_origin = ?;",
            [&server_origin],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

pub fn new_event_id(client_id: &str, domain: &str, operation: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(client_id.as_bytes());
    hasher.update(domain.as_bytes());
    hasher.update(operation.as_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    format!("evt-{}", hex::encode(hasher.finalize()))
}

pub fn new_local_id() -> i64 {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(1);
    const MAX_SAFE_JSON_INTEGER: u128 = 9_007_199_254_740_991;
    -((nanos % (MAX_SAFE_JSON_INTEGER - 1)) as i64 + 1)
}

pub fn enqueue(
    transaction: &Transaction<'_>,
    client_id: &str,
    domain: &str,
    operation: &str,
    entity_key: &str,
    payload: &Value,
    base_revision: Option<i64>,
) -> Result<String, CommandError> {
    let payload_json = payload.to_string();
    if !is_canonical_sync_route(domain, operation)
        || entity_key.trim().is_empty()
        || entity_key.len() > 160
        || !payload.is_object()
        || payload_json.len() > 25_165_824
    {
        return Err(CommandError::new(
            "DESKTOP_SYNC_EVENT_INVALID",
            format!("Event sinkronisasi tidak valid: {domain}/{operation}."),
        ));
    }
    let event_id = new_event_id(client_id, domain, operation);
    let now = storage::now_epoch_seconds();
    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_outbox (
        event_id, client_id, domain, operation, entity_key,
        payload_json, base_revision, status, attempt_count,
        next_retry_at, last_error, server_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?);
      "#,
            params![
                event_id,
                client_id,
                domain,
                operation,
                entity_key,
                payload_json,
                base_revision,
                now,
                now,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(event_id)
}

pub fn apply_snapshot(state: &DesktopState, payload: &Value) -> Result<(), CommandError> {
    let snapshot = payload.get("snapshot").unwrap_or(payload);
    let revision = snapshot
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(CommandError::internal)?;
    let mut connection = storage::database(&state.data_dir)?;
    let current_revision = connection
        .query_row(
            "SELECT last_revision FROM desktop_sync_cursor WHERE domain = 'operational';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or_default();
    if revision < current_revision {
        return Err(CommandError::internal());
    }
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    reconcile_shift_ids(&transaction, snapshot)?;
    for definition in SNAPSHOT_TABLES {
        apply_table(&transaction, snapshot, definition, revision)?;
    }

    // Bersihkan temporary local log_scan (id_log < 0) jika sudah ada baris server permanen yang cocok
    let _ = transaction.execute(
        r#"
        DELETE FROM log_scan
        WHERE id_log < 0
          AND EXISTS (
            SELECT 1 FROM log_scan s2
            WHERE s2.id_log > 0
              AND s2.tanggal_kerja = log_scan.tanggal_kerja
              AND s2.id_karyawan = log_scan.id_karyawan
              AND s2.jenis_scan = log_scan.jenis_scan
          );
        "#,
        [],
    );

    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_cursor (domain, last_revision, updated_at)
      VALUES ('operational', ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        last_revision = excluded.last_revision,
        updated_at = excluded.updated_at;
      "#,
            params![revision, storage::now_epoch_seconds()],
        )
        .map_err(|_| CommandError::internal())?;
    transaction.commit().map_err(|_| CommandError::internal())
}

pub async fn pull_snapshot(
    state: &DesktopState,
    token: &str,
) -> Result<DesktopSyncStatus, CommandError> {
    if let Ok(turso) = state.get_turso_client() {
        let (last_rev, _) = {
            let connection = storage::database(&state.data_dir)?;
            connection
                .query_row(
                    "SELECT last_revision, updated_at FROM desktop_sync_cursor WHERE domain = 'operational';",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .unwrap_or((0, None))
        };
        let payload = turso.pull_snapshot(last_rev).await?;
        apply_snapshot(state, &payload)?;
        return status(state);
    }

    if !token.is_empty() {
        let payload = remote::authorized_json(
            state,
            reqwest::Method::POST,
            "/api/sync/snapshot",
            None,
            token,
        )
        .await?;
        apply_snapshot(state, &payload)?;
    }
    status(state)
}

fn mark_batch_failed(state: &DesktopState, event_ids: &[String], message: &str) {
    if event_ids.is_empty() {
        return;
    }
    if let Ok(mut connection) = storage::database(&state.data_dir) {
        if let Ok(transaction) = connection.transaction() {
            for event_id in event_ids {
                let attempt: i64 = transaction
                    .query_row(
                        "SELECT attempt_count FROM desktop_sync_outbox WHERE event_id = ?;",
                        [event_id],
                        |row| row.get(0),
                    )
                    .unwrap_or_default();
                let exponent = u32::try_from(attempt.clamp(0, 8)).unwrap_or_default();
                let delay = 5_i64.saturating_mul(2_i64.saturating_pow(exponent));
                let _ = transaction.execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'failed',
            attempt_count = attempt_count + 1, next_retry_at = ?,
            last_error = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![
                        storage::now_epoch_seconds() + delay,
                        message,
                        storage::now_epoch_seconds(),
                        event_id,
                    ],
                );
            }
            let _ = transaction.commit();
        }
    }
}

fn pending_events(state: &DesktopState) -> Result<(String, Vec<Value>), CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, client_id, domain, operation, entity_key, payload_json,
             base_revision, created_at
      FROM desktop_sync_outbox
      WHERE status = 'pending'
         OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         OR (status = 'conflict' AND operation = 'create' AND (
              (domain = 'shift' AND last_error LIKE '%UNIQUE constraint failed: tbl_shift.kode_shift%')
              OR (domain = 'employee' AND last_error LIKE '%UNIQUE constraint failed: master_data.id_unik%')
            ))
      ORDER BY
        CASE WHEN domain = 'shift' AND operation = 'create' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 50;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([storage::now_epoch_seconds()], |row| {
            let payload: String = row.get(5)?;
            Ok(json!({
                "eventId": row.get::<_, String>(0)?,
                "clientId": row.get::<_, String>(1)?,
                "domain": row.get::<_, String>(2)?,
                "operation": row.get::<_, String>(3)?,
                "entityKey": row.get::<_, String>(4)?,
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
                "baseRevision": row.get::<_, Option<i64>>(6)?,
                "createdAt": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok((
        client_id,
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

fn validate_push_results(
    expected_event_ids: &[String],
    results: &[Value],
) -> Result<(), CommandError> {
    if results.len() != expected_event_ids.len() {
        return Err(CommandError::internal());
    }
    let expected = expected_event_ids.iter().collect::<HashSet<_>>();
    let mut received = HashSet::with_capacity(results.len());
    for result in results {
        let event_id = result
            .get("eventId")
            .and_then(Value::as_str)
            .filter(|event_id| !event_id.is_empty())
            .ok_or_else(CommandError::internal)?;
        if !expected.contains(&event_id.to_owned()) || !received.insert(event_id) {
            return Err(CommandError::internal());
        }
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(CommandError::internal)?;
        if !matches!(status, "applied" | "rejected" | "conflict") {
            return Err(CommandError::internal());
        }
        if result
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .is_none()
        {
            return Err(CommandError::internal());
        }
        if status == "applied"
            && result
                .get("serverRevision")
                .and_then(Value::as_i64)
                .filter(|revision| *revision > 0)
                .is_none()
        {
            return Err(CommandError::internal());
        }
    }
    Ok(())
}

fn apply_push_results(
    state: &DesktopState,
    expected_event_ids: &[String],
    results: &[Value],
) -> Result<(), CommandError> {
    validate_push_results(expected_event_ids, results)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    for result in results {
        let event_id = result
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sync_status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("rejected");
        let message = result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Respons sinkronisasi tidak valid.");
        let server_revision = result.get("serverRevision").and_then(Value::as_i64);
        let source = transaction
            .query_row(
                r#"
        SELECT domain, entity_key, payload_json FROM desktop_sync_outbox
        WHERE event_id = ?;
        "#,
                [event_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        let Some((domain, entity_key, local_payload)) = source else {
            continue;
        };
        if sync_status == "applied" {
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'synced', server_revision = ?,
            next_retry_at = NULL, last_error = NULL, updated_at = ?
          WHERE event_id = ?;
          "#,
                    params![server_revision, storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE event_id = ? AND resolved_at IS NULL;",
                    params![storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
            if let Some(revision) = server_revision {
                let revision_entity_key = if domain == "shift" {
                    result
                        .get("serverPayload")
                        .and_then(|payload| payload.get("id_shift"))
                        .and_then(Value::as_i64)
                        .filter(|server_id| *server_id > 0)
                        .map(|server_id| server_id.to_string())
                        .unwrap_or_else(|| entity_key.clone())
                } else {
                    entity_key.clone()
                };
                let mut hasher = Sha256::new();
                hasher.update(local_payload.as_bytes());
                transaction
                    .execute(
                        r#"
            INSERT INTO desktop_entity_revision (
              domain, entity_key, server_revision, payload_hash, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(domain, entity_key) DO UPDATE SET
              server_revision = excluded.server_revision,
              payload_hash = excluded.payload_hash,
              updated_at = excluded.updated_at;
            "#,
                        params![
                            domain,
                            revision_entity_key,
                            revision,
                            hex::encode(hasher.finalize()),
                            storage::now_epoch_seconds(),
                        ],
                    )
                    .map_err(|_| CommandError::internal())?;
            }
            if domain == "shift" {
                let payload = result.get("serverPayload").unwrap_or(&Value::Null);
                let server_id = payload.get("id_shift").and_then(Value::as_i64).unwrap_or(0);
                let local_id = payload
                    .get("local_id_shift")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if local_id < 0 && server_id > 0 {
                    transaction
                        .execute(
                            "UPDATE master_data SET id_shift = ? WHERE id_shift = ?;",
                            params![server_id, local_id],
                        )
                        .map_err(|_| CommandError::internal())?;
                    transaction
                        .execute(
                            "UPDATE absensi_harian SET id_shift = ? WHERE id_shift = ?;",
                            params![server_id, local_id],
                        )
                        .map_err(|_| CommandError::internal())?;
                    let server_shift_exists = transaction
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM tbl_shift WHERE id_shift = ?);",
                            [server_id],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false);
                    if server_shift_exists {
                        transaction
                            .execute("DELETE FROM tbl_shift WHERE id_shift = ?;", [local_id])
                            .map_err(|_| CommandError::internal())?;
                    } else {
                        transaction
                            .execute(
                                "UPDATE tbl_shift SET id_shift = ? WHERE id_shift = ?;",
                                params![server_id, local_id],
                            )
                            .map_err(|_| CommandError::internal())?;
                    }
                    transaction
                        .execute(
                            r#"
              UPDATE desktop_sync_outbox SET
                entity_key = CASE
                  WHEN domain = 'shift' AND entity_key = CAST(? AS TEXT)
                  THEN CAST(? AS TEXT) ELSE entity_key END,
                payload_json = CASE
                  WHEN json_extract(payload_json, '$.id_shift') = ?
                  THEN json_set(payload_json, '$.id_shift', ?)
                  ELSE payload_json END
              WHERE status IN ('pending', 'failed');
              "#,
                            params![local_id, server_id, local_id, server_id],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
            }
            if domain == "attendance" {
                let payload = result.get("serverPayload").unwrap_or(&Value::Null);
                let server_log_id = payload.get("id_log").and_then(Value::as_i64).unwrap_or(0);
                let local_log_id = entity_key
                    .strip_prefix("scan:")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                if local_log_id < 0 && server_log_id > 0 {
                    transaction
                        .execute(
                            "UPDATE log_scan SET id_log = ? WHERE id_log = ?;",
                            params![server_log_id, local_log_id],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
            }
            if domain == "correction" {
                let payload = result.get("serverPayload").unwrap_or(&Value::Null);
                let server_correction_id = payload
                    .get("id_koreksi")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let server_log_id = payload.get("id_log").and_then(Value::as_i64).unwrap_or(0);
                if server_correction_id > 0 {
                    transaction
                        .execute(
                            "UPDATE koreksi_admin SET id_koreksi = ? WHERE id_referensi = ?;",
                            params![server_correction_id, entity_key],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
                if server_log_id > 0 {
                    transaction
                        .execute(
                            "UPDATE log_scan SET id_log = ? WHERE id_referensi = ? AND sumber_data = 'Koreksi Admin';",
                            params![server_log_id, entity_key],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
            }
            if domain == "offline-import" {
                let payload = result.get("serverPayload").unwrap_or(&Value::Null);
                let server_import_id = payload
                    .get("id_import")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if server_import_id > 0 {
                    transaction
                        .execute(
                            "UPDATE import_offline SET id_import = ? WHERE event_key = ?;",
                            params![server_import_id, entity_key],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
                let local = serde_json::from_str::<Value>(&local_payload).unwrap_or(Value::Null);
                let logs = local
                    .get("logs")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let server_ids = payload
                    .get("log_ids")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for (log, server_id) in logs.iter().zip(server_ids.iter()) {
                    let server_id = server_id.as_i64().unwrap_or(0);
                    if server_id <= 0 {
                        continue;
                    }
                    transaction
                        .execute(
                            r#"
              UPDATE log_scan SET id_log = ? WHERE id_log = (
                SELECT id_log FROM log_scan WHERE id_log < 0
                  AND sumber_data = 'Import Offline' AND timestamp_scan = ?
                  AND id_karyawan = ? AND jenis_scan = ? LIMIT 1
              );
              "#,
                            params![
                                server_id,
                                log.get("timestamp_scan").and_then(Value::as_str),
                                log.get("id_karyawan").and_then(Value::as_str),
                                log.get("jenis_scan").and_then(Value::as_str),
                            ],
                        )
                        .map_err(|_| CommandError::internal())?;
                }
            }
        } else if sync_status == "conflict" {
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'conflict', last_error = ?,
            server_revision = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![
                        message,
                        server_revision,
                        storage::now_epoch_seconds(),
                        event_id,
                    ],
                )
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    r#"
          INSERT OR REPLACE INTO desktop_sync_conflict (
            event_id, domain, entity_key, local_payload_json,
            server_payload_json, reason, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL);
          "#,
                    params![
                        event_id,
                        domain,
                        entity_key,
                        local_payload,
                        result.get("serverPayload").map(Value::to_string),
                        message,
                        storage::now_epoch_seconds(),
                    ],
                )
                .map_err(|_| CommandError::internal())?;
        } else {
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'failed',
            attempt_count = attempt_count + 1, next_retry_at = NULL,
            last_error = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![message, storage::now_epoch_seconds(), event_id],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

pub async fn push_outbox(state: &DesktopState, token: &str) -> Result<(), CommandError> {
    if let Ok(turso) = state.get_turso_client() {
        loop {
            let (_client_id, events) = pending_events(state)?;
            if events.is_empty() {
                return Ok(());
            }
            let event_ids = events
                .iter()
                .filter_map(|event| event.get("eventId").and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<Vec<_>>();

            let results = match turso.push_events(&events).await {
                Ok(res) => res,
                Err(error) => {
                    mark_batch_failed(state, &event_ids, &error.message);
                    return Err(error);
                }
            };

            if let Err(error) = apply_push_results(state, &event_ids, &results) {
                mark_batch_failed(
                    state,
                    &event_ids,
                    "Respons database Turso tidak lengkap atau tidak valid.",
                );
                return Err(error);
            }
            if event_ids.len() < 50 {
                return Ok(());
            }
        }
    }

    if !token.is_empty() {
        loop {
            let (client_id, events) = pending_events(state)?;
            if events.is_empty() {
                return Ok(());
            }
            let event_ids = events
                .iter()
                .filter_map(|event| event.get("eventId").and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let response = remote::authorized_json(
                state,
                reqwest::Method::POST,
                "/api/sync/push",
                Some(json!({ "clientId": client_id, "events": events })),
                token,
            )
            .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    mark_batch_failed(state, &event_ids, &error.message);
                    return Err(error);
                }
            };
            let results = response
                .get("results")
                .and_then(Value::as_array)
                .ok_or_else(CommandError::internal)?;
            if let Err(error) = apply_push_results(state, &event_ids, results) {
                mark_batch_failed(
                    state,
                    &event_ids,
                    "Respons server tidak lengkap atau tidak valid.",
                );
                return Err(error);
            }
            if event_ids.len() < 50 {
                return Ok(());
            }
        }
    }

    Ok(())
}

pub async fn synchronize(
    state: &DesktopState,
    token: &str,
) -> Result<DesktopSyncStatus, CommandError> {
    push_outbox(state, token).await?;
    pull_snapshot(state, token).await
}

pub fn status(state: &DesktopState) -> Result<DesktopSyncStatus, CommandError> {
    let client_id = ensure_client_id(state)?;
    let connection = storage::database(&state.data_dir)?;
    let count = |status: &str| -> Result<i64, CommandError> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE status = ?;",
                [status],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())
    };
    let (last_revision, last_sync_at) = connection
        .query_row(
            r#"
      SELECT last_revision, updated_at FROM desktop_sync_cursor
      WHERE domain = 'operational';
      "#,
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, None));
    let table_count = |table: &str| -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                row.get(0)
            })
            .unwrap_or_default()
    };
    Ok(DesktopSyncStatus {
        client_id,
        pending: count("pending")?,
        synced: count("synced")?,
        failed: count("failed")?,
        conflict: count("conflict")?,
        last_revision,
        last_sync_at,
        table_counts: json!({
            "employees": table_count("master_data"),
            "idCards": table_count("id_card"),
            "shifts": table_count("tbl_shift"),
            "holidays": table_count("tbl_hari_libur"),
            "settings": table_count("setting_gex_system"),
            "companyProfiles": table_count("company_profile"),
            "idCardTemplates": table_count("id_card_template"),
            "backups": table_count("backup_karyawan"),
            "corrections": table_count("koreksi_admin"),
            "imports": table_count("import_offline"),
            "attendance": table_count("absensi_harian"),
            "scanLogs": table_count("log_scan"),
        }),
    })
}

pub fn conflicts(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT event_id, domain, entity_key, local_payload_json,
             server_payload_json, reason, created_at
      FROM desktop_sync_conflict WHERE resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 100;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "eventId": row.get::<_, String>(0)?,
                "domain": row.get::<_, String>(1)?,
                "entityKey": row.get::<_, String>(2)?,
                "localPayload": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
                "serverPayload": row.get::<_, Option<String>>(4)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "reason": row.get::<_, String>(5)?,
                "createdAt": row.get::<_, i64>(6)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

pub fn retry_failed(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let changed = if let Some(event_id) = event_id {
        connection.execute(
            "UPDATE desktop_sync_outbox SET status = 'pending', next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE event_id = ? AND status IN ('failed', 'conflict');",
            params![storage::now_epoch_seconds(), event_id],
        )
    } else {
        connection.execute(
            "UPDATE desktop_sync_outbox SET status = 'pending', next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE status IN ('failed', 'conflict');",
            [storage::now_epoch_seconds()],
        )
    }.map_err(|_| CommandError::internal())?;
    if event_id.is_some() && changed == 0 {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Event gagal atau konflik tidak ditemukan.",
        ));
    }
    Ok(())
}

pub fn resolve_conflicts(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        transaction
            .execute(
                "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE event_id = ? AND resolved_at IS NULL;",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE event_id = ? AND status = 'conflict';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        transaction
            .execute(
                "UPDATE desktop_sync_conflict SET resolved_at = ? WHERE resolved_at IS NULL;",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE status = 'conflict';",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

pub fn clear_failed(state: &DesktopState, event_id: Option<&str>) -> Result<(), CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE event_id = ? AND status = 'failed';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced', next_retry_at = NULL, updated_at = ? WHERE status = 'failed';",
                [now],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, RwLock};

    use reqwest::Client;
    use serde_json::{json, Value};
    use tempfile::tempdir;

    use super::{
        apply_push_results, apply_snapshot, enqueue, ensure_client_id, pending_events, storage,
        DesktopState,
    };

    fn fixture() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("temporary directory");
        storage::initialize(directory.path()).expect("local schema");
        let state = DesktopState {
            server_origin: RwLock::new("http://localhost:3000".to_string()),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: Client::new(),
            turso_config: RwLock::new(None),
            session: Mutex::new(None),
            vault_lock: Mutex::new(()),
        };
        (directory, state)
    }

    fn snapshot_with_shifts(shifts: Value) -> Value {
        json!({
            "snapshot": {
                "revision": 12,
                "employees": [],
                "idCards": [],
                "shifts": shifts,
                "settings": [],
                "backups": [],
                "corrections": [],
                "imports": [],
                "attendance": [],
                "scanLogs": []
            }
        })
    }

    #[test]
    fn pending_batch_prioritizes_shift_create_and_defers_future_retry() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        let attendance_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "scan",
            "scan:-1",
            &json!({"log": {}}),
            None,
        )
        .expect("attendance event");
        let shift_id = enqueue(
            &transaction,
            &client_id,
            "shift",
            "create",
            "kode:8",
            &json!({"kode_shift": 8}),
            None,
        )
        .expect("shift event");
        let deferred_id = enqueue(
            &transaction,
            &client_id,
            "employee",
            "update",
            "K001",
            &json!({"nama": "Ditunda"}),
            None,
        )
        .expect("deferred event");
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'failed', next_retry_at = ? WHERE event_id = ?;",
                rusqlite::params![storage::now_epoch_seconds() + 3_600, deferred_id],
            )
            .expect("defer event");
        transaction.commit().expect("commit");

        let (batch_client_id, events) = pending_events(&state).expect("pending events");
        assert_eq!(batch_client_id, client_id);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].get("eventId").and_then(Value::as_str),
            Some(shift_id.as_str())
        );
        assert_eq!(
            events[1].get("eventId").and_then(Value::as_str),
            Some(attendance_id.as_str())
        );
    }

    #[test]
    fn snapshot_does_not_overwrite_an_unsynced_local_entity() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "INSERT INTO tbl_shift (
                    id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                    jam_kerja_normal_menit, istirahat_menit
                ) VALUES (1, 1, 'Shift Lokal', '08:00', '16:00', 480, 60);",
                [],
            )
            .expect("local shift");
        let transaction = connection.transaction().expect("transaction");
        let event_id = enqueue(
            &transaction,
            &client_id,
            "shift",
            "update",
            "1",
            &json!({"nama_shift": "Shift Lokal"}),
            Some(1),
        )
        .expect("local event");
        transaction.commit().expect("commit");
        drop(connection);

        let snapshot = snapshot_with_shifts(json!([{
            "id_shift": 1,
            "kode_shift": 1,
            "nama_shift": "Shift Server",
            "jam_masuk": "07:00",
            "jam_pulang": "15:00",
            "awal_absen_menit": 60,
            "batas_masuk_menit": 120,
            "toleransi_masuk_menit": 10,
            "jam_kerja_normal_menit": 480,
            "istirahat_menit": 60,
            "batas_pulang_menit": 240,
            "offset_istirahat_mulai": 240,
            "offset_generate_alfa": 180,
            "buffer_shift_malam_menit": 120
        }]));
        apply_snapshot(&state, &snapshot).expect("protected snapshot");

        let connection = storage::database(&state.data_dir).expect("local database");
        let local_name: String = connection
            .query_row(
                "SELECT nama_shift FROM tbl_shift WHERE id_shift = 1;",
                [],
                |row| row.get(0),
            )
            .expect("local shift name");
        assert_eq!(local_name, "Shift Lokal");
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'synced' WHERE event_id = ?;",
                [event_id],
            )
            .expect("mark synced");
        drop(connection);

        apply_snapshot(&state, &snapshot).expect("server snapshot");
        let connection = storage::database(&state.data_dir).expect("local database");
        let server_name: String = connection
            .query_row(
                "SELECT nama_shift FROM tbl_shift WHERE id_shift = 1;",
                [],
                |row| row.get(0),
            )
            .expect("server shift name");
        assert_eq!(server_name, "Shift Server");
    }

    #[test]
    fn snapshot_does_not_overwrite_pending_scanner_attendance_or_log() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT INTO absensi_harian (
          id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk,
          jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
          update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja,
          lembur, jam_kerja_kurang, id_shift, bulan, tahun, id_sesi,
          mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
        ) VALUES (
          -20, '2026-08-12', 'K001', 'Karyawan Lokal', 'Dapur',
          '2026-08-12 07:00:00', '', 'Hadir', 'Belum Pulang',
          'Data scanner lokal', 'Scanner', '2026-08-12 07:00:00',
          0, 0, 0, 0, 420, 1, 'Agustus', 2026,
          'NORMAL-20260812-K001-1', 'NORMAL', '', '', '2026-08-12'
        );
        INSERT INTO log_scan (
          id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan,
          nama, divisi, jenis_scan, status_proses, sumber_data,
          catatan_sistem, keterangan, menit_terlambat, menit_datang_awal,
          id_referensi, kode_operator
        ) VALUES (
          -10, '2026-08-12 07:00:00', '2026-08-12', '07:00:00',
          'K001', 'Karyawan Lokal', 'Dapur', 'Masuk', 'Berhasil',
          'Scanner', 'Log scanner lokal', 'Tepat Waktu', 0, 0, '', 'SPD001'
        );
        "#,
            )
            .expect("pending scanner rows");
        let transaction = connection.transaction().expect("transaction");
        enqueue(
            &transaction,
            &client_id,
            "attendance",
            "scan",
            "scan:-10",
            &json!({
                "log": {
                    "timestamp_scan": "2026-08-12 07:00:00",
                    "tanggal_kerja": "2026-08-12",
                    "jam_scan": "07:00:00",
                    "id_karyawan": "K001",
                    "nama": "Karyawan Lokal",
                    "divisi": "Dapur",
                    "jenis_scan": "Masuk",
                    "status_proses": "Berhasil",
                    "sumber_data": "Scanner",
                    "catatan_sistem": "Log scanner lokal",
                    "keterangan": "Tepat Waktu",
                    "menit_terlambat": 0,
                    "menit_datang_awal": 0,
                    "id_referensi": "",
                    "kode_operator": "SPD001"
                },
                "attendance": {
                    "tanggal": "2026-08-12",
                    "id_karyawan": "K001",
                    "nama": "Karyawan Lokal",
                    "kelas_divisi": "Dapur",
                    "jam_masuk": "2026-08-12 07:00:00",
                    "jam_pulang": "",
                    "status_kehadiran": "Hadir",
                    "status_absen": "Belum Pulang",
                    "keterangan": "Data scanner lokal",
                    "sumber": "Scanner",
                    "update_terakhir": "2026-08-12 07:00:00",
                    "menit_terlambat": 0,
                    "menit_datang_awal": 0,
                    "jam_kerja": 0,
                    "lembur": 0,
                    "jam_kerja_kurang": 420,
                    "id_shift": 1,
                    "bulan": "Agustus",
                    "tahun": 2026,
                    "id_sesi": "NORMAL-20260812-K001-1",
                    "mode_tugas": "NORMAL",
                    "id_backup": "",
                    "id_karyawan_asal": "",
                    "tanggal_tugas": "2026-08-12"
                },
                "attendanceBaseUpdatedAt": null
            }),
            None,
        )
        .expect("scanner outbox");
        transaction.commit().expect("commit");
        drop(connection);

        let snapshot = json!({
            "snapshot": {
                "revision": 13,
                "employees": [], "idCards": [], "shifts": [], "settings": [],
                "backups": [], "corrections": [], "imports": [],
                "attendance": [{
                    "tanggal": "2026-08-12", "id_karyawan": "K001",
                    "nama": "Karyawan Server", "kelas_divisi": "Dapur",
                    "jam_masuk": "2026-08-12 07:05:00", "jam_pulang": "",
                    "status_kehadiran": "Hadir", "status_absen": "Belum Pulang",
                    "keterangan": "Snapshot server lama", "sumber": "Scanner",
                    "update_terakhir": "2026-08-12 07:05:00",
                    "menit_terlambat": 5, "menit_datang_awal": 0,
                    "jam_kerja": 0, "lembur": 0, "jam_kerja_kurang": 420,
                    "id_shift": 1, "bulan": "Agustus", "tahun": 2026,
                    "id_sesi": "NORMAL-20260812-K001-1", "mode_tugas": "NORMAL",
                    "id_backup": "", "id_karyawan_asal": "", "tanggal_tugas": "2026-08-12"
                }],
                "scanLogs": [{
                    "id_log": 99, "timestamp_scan": "2026-08-12 07:00:00",
                    "tanggal_kerja": "2026-08-12", "jam_scan": "07:00:00",
                    "id_karyawan": "K001", "nama": "Karyawan Server",
                    "divisi": "Dapur", "jenis_scan": "Masuk",
                    "status_proses": "Berhasil", "sumber_data": "Scanner",
                    "catatan_sistem": "Snapshot server", "keterangan": "Tepat Waktu",
                    "menit_terlambat": 0, "menit_datang_awal": 0,
                    "id_referensi": "", "kode_operator": "SPD001"
                }]
            }
        });
        apply_snapshot(&state, &snapshot).expect("protected scanner snapshot");

        let connection = storage::database(&state.data_dir).expect("local database");
        let attendance_note: String = connection
            .query_row(
                "SELECT keterangan FROM absensi_harian WHERE id_sesi = 'NORMAL-20260812-K001-1';",
                [],
                |row| row.get(0),
            )
            .expect("local attendance");
        let log: (i64, i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MIN(id_log), MAX(catatan_sistem) FROM log_scan WHERE id_karyawan = 'K001';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("local log");
        assert_eq!(attendance_note, "Data scanner lokal");
        assert_eq!(log, (1, -10, "Log scanner lokal".into()));
    }

    #[test]
    fn snapshot_reconciles_shift_ids_and_keeps_id_card_ids_local() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "INSERT INTO tbl_shift (
                    id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                    jam_kerja_normal_menit, istirahat_menit
                ) VALUES (-99, 1, 'Shift Lokal', '19:00', '05:00', 480, 60);",
                [],
            )
            .expect("local shift");
        connection
            .execute(
                "INSERT INTO master_data (
                    id_unik, kode_karyawan, nama, divisi, id_shift
                ) VALUES ('USR001', 'USRID001', 'User Lokal', 'Dapur', -99);",
                [],
            )
            .expect("local employee");
        connection
            .execute(
                "INSERT INTO id_card (
                    id_card_id, id_unik, nama, divisi
                ) VALUES (1, 'USR001', 'User Lokal', 'Dapur');",
                [],
            )
            .expect("local id card");
        drop(connection);

        let snapshot = json!({
            "snapshot": {
                "revision": 20,
                "employees": [
                    {
                        "id_unik": "EMP002", "kode_karyawan": "K002",
                        "nama": "Pegawai Server", "divisi": "Keuangan",
                        "id_shift": 1
                    },
                    {
                        "id_unik": "USR001", "kode_karyawan": "USRID001",
                        "nama": "User Server", "divisi": "Operasional",
                        "id_shift": 1
                    }
                ],
                "idCards": [
                    {"id_card_id": 1, "id_unik": "EMP002", "nama": "Pegawai Server", "divisi": "Keuangan"},
                    {"id_card_id": 2, "id_unik": "USR001", "nama": "User Server", "divisi": "Operasional"}
                ],
                "shifts": [{
                    "id_shift": 1, "kode_shift": 1, "nama_shift": "Shift Server",
                    "jam_masuk": "07:00", "jam_pulang": "15:00",
                    "jam_kerja_normal_menit": 480, "istirahat_menit": 60
                }],
                "settings": [], "backups": [], "corrections": [], "imports": [],
                "attendance": [], "scanLogs": []
            }
        });
        apply_snapshot(&state, &snapshot).expect("reconciled snapshot");

        let connection = storage::database(&state.data_dir).expect("local database");
        let employees: i64 = connection
            .query_row("SELECT COUNT(*) FROM master_data;", [], |row| row.get(0))
            .expect("employee count");
        let cards: i64 = connection
            .query_row("SELECT COUNT(*) FROM id_card;", [], |row| row.get(0))
            .expect("card count");
        let user_shift: i64 = connection
            .query_row(
                "SELECT id_shift FROM master_data WHERE id_unik = 'USR001';",
                [],
                |row| row.get(0),
            )
            .expect("user shift");
        let shift_name: String = connection
            .query_row(
                "SELECT nama_shift FROM tbl_shift WHERE id_shift = 1;",
                [],
                |row| row.get(0),
            )
            .expect("server shift");
        assert_eq!(employees, 2);
        assert_eq!(cards, 2);
        assert_eq!(user_shift, 1);
        assert_eq!(shift_name, "Shift Server");
    }

    #[test]
    fn snapshot_requires_monotonic_revision_and_only_removes_server_tracked_shift() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "INSERT INTO tbl_shift (
                    id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                    jam_kerja_normal_menit, istirahat_menit
                ) VALUES (2, 2, 'Shift Lama', '09:00', '17:00', 480, 60);",
                [],
            )
            .expect("old local shift");
        drop(connection);

        let current = snapshot_with_shifts(json!([]));
        apply_snapshot(&state, &current).expect("current snapshot");
        let connection = storage::database(&state.data_dir).expect("local database");
        let untracked_remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tbl_shift WHERE id_shift = 2;",
                [],
                |row| row.get(0),
            )
            .expect("shift count");
        assert_eq!(untracked_remaining, 1);
        connection
            .execute(
                "INSERT INTO desktop_entity_revision (domain, entity_key, server_revision, payload_hash, updated_at) VALUES ('shift', '2', 11, 'tracked', 1);",
                [],
            )
            .expect("tracked server shift");
        drop(connection);

        apply_snapshot(&state, &current).expect("tracked deletion snapshot");
        let connection = storage::database(&state.data_dir).expect("local database");
        let tracked_remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tbl_shift WHERE id_shift = 2;",
                [],
                |row| row.get(0),
            )
            .expect("tracked shift count");
        assert_eq!(tracked_remaining, 0);
        drop(connection);

        let mut stale = snapshot_with_shifts(json!([]));
        stale["snapshot"]["revision"] = json!(11);
        assert!(apply_snapshot(&state, &stale).is_err());

        let mut missing_revision = snapshot_with_shifts(json!([]));
        missing_revision["snapshot"]
            .as_object_mut()
            .expect("snapshot object")
            .remove("revision");
        assert!(apply_snapshot(&state, &missing_revision).is_err());
    }

    #[test]
    fn push_results_must_be_complete_and_store_shift_revision_by_server_id() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "INSERT INTO tbl_shift (
                    id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                    jam_kerja_normal_menit, istirahat_menit
                ) VALUES (-8, 8, 'Shift Lokal', '08:00', '16:00', 480, 60);",
                [],
            )
            .expect("local shift");
        let transaction = connection.transaction().expect("transaction");
        let event_id = enqueue(
            &transaction,
            &client_id,
            "shift",
            "create",
            "kode:8",
            &json!({"kode_shift": 8, "local_id_shift": -8}),
            None,
        )
        .expect("shift create event");
        transaction.commit().expect("commit");
        drop(connection);

        assert!(apply_push_results(&state, std::slice::from_ref(&event_id), &[]).is_err());
        let results = json!([{
            "eventId": event_id,
            "status": "applied",
            "message": "Berhasil.",
            "serverRevision": 27,
            "serverPayload": {"id_shift": 8, "local_id_shift": -8}
        }]);
        apply_push_results(
            &state,
            std::slice::from_ref(&event_id),
            results.as_array().expect("results"),
        )
        .expect("valid result");

        let connection = storage::database(&state.data_dir).expect("local database");
        let mapped: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tbl_shift WHERE id_shift = 8;",
                [],
                |row| row.get(0),
            )
            .expect("mapped shift");
        assert_eq!(mapped, 1);
        let revision: i64 = connection
            .query_row(
                "SELECT server_revision FROM desktop_entity_revision
                 WHERE domain = 'shift' AND entity_key = '8';",
                [],
                |row| row.get(0),
            )
            .expect("server shift revision");
        assert_eq!(revision, 27);
    }

    #[test]
    fn test_resolve_conflicts_and_clear_failed() {
        let (_dir, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client id");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        let event_1 = enqueue(
            &transaction,
            &client_id,
            "shift",
            "update",
            "1",
            &json!({"nama_shift": "Pagi"}),
            Some(10),
        )
        .expect("event 1");
        let event_2 = enqueue(
            &transaction,
            &client_id,
            "employee",
            "update",
            "K001",
            &json!({"nama": "Budi"}),
            Some(15),
        )
        .expect("event 2");
        transaction.commit().expect("commit");
        drop(connection);

        // Mark event_1 as conflict, event_2 as failed
        let results = json!([{
            "eventId": event_1,
            "status": "conflict",
            "message": "Data server berubah.",
            "serverRevision": 12
        }]);
        apply_push_results(
            &state,
            std::slice::from_ref(&event_1),
            results.as_array().expect("results"),
        )
        .expect("applied conflict");

        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'failed' WHERE event_id = ?;",
                [&event_2],
            )
            .expect("set failed");
        drop(connection);

        let conflict_list = super::conflicts(&state).expect("conflicts list");
        assert_eq!(conflict_list.as_array().expect("array").len(), 1);

        // Resolve conflicts
        super::resolve_conflicts(&state, None).expect("resolve conflicts");
        let conflict_list_after = super::conflicts(&state).expect("conflicts list after");
        assert_eq!(conflict_list_after.as_array().expect("array").len(), 0);

        // Clear failed
        super::clear_failed(&state, None).expect("clear failed");
        let connection = storage::database(&state.data_dir).expect("local database");
        let failed_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE status = 'failed';",
                [],
                |row| row.get(0),
            )
            .expect("failed count");
        assert_eq!(failed_count, 0);
    }
}
