use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

use rusqlite::{params, types::Value as SqlValue, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    config::DesktopState,
    models::{CommandError, DesktopSyncStatus},
    payroll_seed, remote, storage,
    turso::TursoClient,
};

/// Versi skema yang dipahami build ini. WAJIB dinaikkan bersama
/// `CURRENT_SCHEMA_VERSION` di `web-desktop/src/lib/db-schema.ts` setiap kali
/// migrasi baru ditambahkan, karena keduanya membaca tabel `schema_migration`
/// yang sama di Turso.
pub const CLIENT_SCHEMA_VERSION: i64 = 15;

/// Hanya `cloud > client` yang berbahaya; `cloud <= client` adalah kondisi normal.
fn is_client_schema_outdated(cloud_version: i64) -> bool {
    cloud_version > CLIENT_SCHEMA_VERSION
}

fn schema_outdated_error(cloud_version: i64) -> CommandError {
    CommandError::new(
        "SCHEMA_VERSION_OUTDATED",
        format!(
            "Aplikasi perlu diperbarui. Skema database cloud sudah versi {cloud_version}, \
             sedangkan aplikasi ini hanya mendukung versi {CLIENT_SCHEMA_VERSION}. \
             Pengiriman data dihentikan agar kolom versi baru tidak tertimpa data lama."
        ),
    )
}

/// Menolak push dari build yang skemanya lebih tua daripada cloud.
///
/// Arah sebaliknya (client lebih baru daripada cloud) sengaja dibiarkan lewat:
/// itu jalur normal, karena `TursoClient::ensure_schema` pada client barulah yang
/// memigrasi cloud. Yang berbahaya hanya client lama menimpa baris yang skemanya
/// sudah lebih baru, sebab kolom yang belum dikenal tidak ikut di-`SNAPSHOT_TABLES`
/// dan akan hilang saat ditulis ulang.
async fn assert_cloud_schema_compatible(turso: &TursoClient) -> Result<(), CommandError> {
    let cloud_version = turso
        .query_one(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration;",
            vec![],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("version").cloned())
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(0);
    if is_client_schema_outdated(cloud_version) {
        return Err(schema_outdated_error(cloud_version));
    }
    Ok(())
}

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
            "shift_lanjutan_id",
        ],
        conflict_column: "kode_shift",
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
    // Whitelist Shift/Divisi yang tetap boleh scan pada hari libur.
    // `delete_missing` menyala seperti `holidays`: daftar ini kecil dan selalu
    // dikirim utuh, sehingga baris yang dicabut admin harus benar-benar hilang
    // dari setiap perangkat — kalau tidak, terminal lama akan terus mengizinkan
    // shift yang sudah dikeluarkan dari whitelist.
    SnapshotTable {
        payload_key: "holidayWhitelists",
        domain: "holiday-whitelist",
        table: "hari_libur_whitelist",
        columns: &[
            "id",
            "scope_type",
            "scope_value",
            "tanggal_libur",
            "keterangan",
            "status_aktif",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
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
        delete_missing: true,
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
        delete_missing: true,
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
        delete_missing: true,
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
        delete_missing: true,
    },
    SnapshotTable {
        payload_key: "salaryConfigs",
        domain: "payroll",
        table: "salary_configs",
        columns: &[
            "id",
            "id_karyawan",
            "rate_per_hour",
            "ptkp_status",
            "effective_date",
            "created_by",
            "created_at",
        ],
        conflict_column: "id_karyawan, effective_date",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "overtimeTierRules",
        domain: "payroll",
        table: "overtime_tier_rules",
        columns: &[
            "id",
            "rule_type",
            "tier_order",
            "hour_start",
            "hour_end",
            "multiplier",
            "is_active",
        ],
        conflict_column: "rule_type, tier_order",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "payrollComponents",
        domain: "payroll",
        table: "payroll_components",
        columns: &[
            "id",
            "name",
            "category",
            "calc_type",
            "default_value",
            "applies_to",
            "is_active",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "taxRules",
        domain: "payroll",
        table: "tax_rules",
        columns: &[
            "id",
            "category",
            "bracket_min",
            "bracket_max",
            "rate_percentage",
            "effective_date",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "bpjsRules",
        domain: "payroll",
        table: "bpjs_rules",
        columns: &[
            "id",
            "component_code",
            "component_name",
            "rate_percentage",
            "wage_cap",
            "effective_date",
        ],
        conflict_column: "component_code",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "payrollRuns",
        domain: "payroll",
        table: "payroll_runs",
        columns: &[
            "id",
            "idempotency_key",
            "period_start",
            "period_end",
            "status",
            "total_gross_payout",
            "total_net_payout",
            "total_employees",
            "created_by",
            "created_at",
            "updated_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "payrollItems",
        domain: "payroll",
        table: "payroll_items",
        columns: &[
            "id",
            "payroll_run_id",
            "id_karyawan",
            "nama_karyawan",
            "divisi",
            "ptkp_status",
            "total_regular_hours",
            "total_overtime_hours",
            "total_overtime_index",
            "total_holiday_hours",
            "total_holiday_overtime_index",
            "rate_per_hour",
            "basic_salary",
            "overtime_salary",
            "gross_salary",
            "total_allowances",
            "total_deductions",
            "bpjs_employee_total",
            "bpjs_company_total",
            "pph21_amount",
            "net_salary",
            "breakdown_snapshot",
            "created_at",
        ],
        conflict_column: "id",
        entity_column: "id",
        delete_missing: false,
    },
    SnapshotTable {
        payload_key: "payrollAuditLogs",
        domain: "payroll",
        table: "payroll_audit_logs",
        columns: &[
            "id",
            "payroll_run_id",
            "action",
            "old_status",
            "new_status",
            "performed_by",
            "notes",
            "created_at",
        ],
        conflict_column: "id",
        entity_column: "id",
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
    ("holiday-whitelist", "create"),
    ("holiday-whitelist", "delete"),
    ("holiday-whitelist", "update"),
    ("id-card", "update"),
    ("id-card-template", "save"),
    ("log-scan", "delete"),
    ("offline-import", "delete"),
    ("offline-import", "row"),
    ("payroll", "bpjs-rule"),
    ("payroll", "create-run"),
    ("payroll", "delete"),
    ("payroll", "overtime-rule"),
    ("payroll", "payroll-component"),
    ("payroll", "salary-config"),
    ("payroll", "tax-rule"),
    ("payroll", "transition-status"),
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

/// Kunci `setting_gex_system` yang HANYA berlaku untuk perangkat ini.
///
/// Tabel setting ikut snapshot sync, jadi tanpa penjagaan ini konfigurasi
/// koneksi satu perangkat bisa terdorong ke cloud lalu tertarik oleh semua
/// perangkat lain — dan `DesktopState::load` membaca `turso_database_url` saat
/// startup untuk memilih database cloud, sehingga perangkat bisa diarahkan ke
/// database yang salah.
pub const DEVICE_LOCAL_SETTING_KEYS: &[&str] = &[
    "turso_database_url",
    "turso_auth_token",
    "server_api_base_url",
    // Provider dan izin transport adalah bagian tak terpisahkan dari alamat
    // database perangkat ini. Kalau ikut tersinkronisasi, perangkat lain akan
    // menarik "self_hosted" beserta URL LAN milik kantor dan mencoba
    // menghubungi 192.168.x.x dari jaringan yang sama sekali berbeda.
    "turso_database_provider",
    "turso_allow_insecure_transport",
];

pub fn is_device_local_setting(key: &str) -> bool {
    DEVICE_LOCAL_SETTING_KEYS.contains(&key)
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

/// Snapshot in-memory dari seluruh entri outbox yang belum tuntas.
///
/// Dibangun sekali di awal `apply_snapshot`, lalu dipakai untuk memeriksa setiap
/// baris snapshot. Versi lama menembakkan 1-4 query per baris — dua di antaranya
/// `json_extract` tanpa indeks yang memindai seluruh outbox — sehingga biaya
/// penerapan snapshot adalah O(baris x outbox). Sekarang O(baris + outbox).
#[derive(Default)]
struct PendingGuard {
    /// Kunci gabungan `domain \u{1} entity_key`; satu alokasi per pencarian.
    by_domain_key: HashSet<String>,
    attendance_sessions: HashSet<String>,
    scan_logs: HashSet<(String, String, String, String)>,
}

fn guard_key(domain: &str, key: &str) -> String {
    format!("{domain}\u{1}{key}")
}

impl PendingGuard {
    fn load(transaction: &Transaction<'_>) -> Result<Self, CommandError> {
        let mut guard = Self::default();
        let mut statement = transaction
            .prepare(
                r#"
      SELECT domain, entity_key,
             COALESCE(json_extract(payload_json, '$.attendance.id_sesi'), '') AS sesi,
             COALESCE(json_extract(payload_json, '$.log.timestamp_scan'), '') AS log_ts,
             COALESCE(json_extract(payload_json, '$.log.id_karyawan'), '') AS log_emp,
             COALESCE(json_extract(payload_json, '$.log.jenis_scan'), '') AS log_kind,
             COALESCE(json_extract(payload_json, '$.log.id_referensi'), '') AS log_ref
      FROM desktop_sync_outbox
      WHERE status IN ('pending', 'failed', 'conflict');
      "#,
            )
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2).unwrap_or_default(),
                    row.get::<_, String>(3).unwrap_or_default(),
                    row.get::<_, String>(4).unwrap_or_default(),
                    row.get::<_, String>(5).unwrap_or_default(),
                    row.get::<_, String>(6).unwrap_or_default(),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (domain, key, sesi, log_ts, log_emp, log_kind, log_ref) =
                row.map_err(|_| CommandError::internal())?;
            guard.by_domain_key.insert(guard_key(&domain, &key));
            if !sesi.is_empty() {
                guard.attendance_sessions.insert(sesi);
            }
            if !(log_ts.is_empty() && log_emp.is_empty()) {
                guard.scan_logs.insert((log_ts, log_emp, log_kind, log_ref));
            }
        }
        Ok(guard)
    }

    fn has(&self, domain: &str, key: &str) -> bool {
        self.by_domain_key.contains(&guard_key(domain, key))
    }

    fn row_has_unsynced_change(&self, definition: &SnapshotTable, row: &Value, key: &str) -> bool {
        if self.has(definition.domain, key) {
            return true;
        }
        match definition.domain {
            "shift" => {
                let code = entity_key(row, "kode_shift");
                if !code.is_empty()
                    && (self.has("shift", &format!("kode:{code}")) || self.has("shift", &code))
                {
                    return true;
                }
                let shift_id = entity_key(row, "id_shift");
                !shift_id.is_empty() && self.has("shift", &shift_id)
            }
            "attendance" => self.attendance_sessions.contains(key),
            "log-scan" => self.scan_logs.contains(&(
                entity_key(row, "timestamp_scan"),
                entity_key(row, "id_karyawan"),
                entity_key(row, "jenis_scan"),
                entity_key(row, "id_referensi"),
            )),
            _ => false,
        }
    }
}

fn sync_table_error(table: &str, err: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        "DESKTOP_SYNC_APPLY_FAILED",
        format!("Snapshot tabel {table} tidak dapat diterapkan ke database lokal: {err}"),
    )
}

fn reconcile_shift_ids(
    transaction: &Transaction<'_>,
    guard: &PendingGuard,
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
        if server_id <= 0 || guard.has("shift", &format!("kode:{code}")) {
            continue;
        }
        let local_id = transaction
            .query_row(
                "SELECT id_shift FROM tbl_shift WHERE kode_shift = ? LIMIT 1;",
                [code],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| sync_table_error("tbl_shift", err))?;
        let Some(local_id) = local_id.filter(|local_id| *local_id != server_id) else {
            continue;
        };
        transaction
            .execute(
                "UPDATE master_data SET id_shift = ? WHERE id_shift = ?;",
                params![server_id, local_id],
            )
            .map_err(|err| sync_table_error("tbl_shift", err))?;
        transaction
            .execute(
                "UPDATE absensi_harian SET id_shift = ? WHERE id_shift = ?;",
                params![server_id, local_id],
            )
            .map_err(|err| sync_table_error("tbl_shift", err))?;
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
                .map_err(|err| sync_table_error("tbl_shift", err))?;
        } else {
            transaction
                .execute(
                    "UPDATE tbl_shift SET id_shift = ? WHERE id_shift = ?;",
                    params![server_id, local_id],
                )
                .map_err(|err| sync_table_error("tbl_shift", err))?;
        }
    }
    Ok(())
}

const REVISION_UPSERT_SQL: &str = r#"
INSERT INTO desktop_entity_revision (
  domain, entity_key, server_revision, payload_hash, updated_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(domain, entity_key) DO UPDATE SET
  server_revision = excluded.server_revision,
  payload_hash = excluded.payload_hash,
  updated_at = excluded.updated_at;
"#;

/// Sidik jari satu baris snapshot. Nama tabel ikut di-hash supaya dua tabel yang
/// berbagi `domain` (mis. `payroll_runs`, `payroll_items`, `payroll_audit_logs`)
/// tidak pernah saling mengaku identik lewat `desktop_entity_revision` yang
/// berkunci `(domain, entity_key)`.
fn row_payload_hash(table: &str, row: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(table.as_bytes());
    hasher.update([0u8]);
    hasher.update(row.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

fn apply_table(
    transaction: &Transaction<'_>,
    guard: &PendingGuard,
    hashes: &mut HashMap<String, String>,
    snapshot: &Value,
    definition: &SnapshotTable,
    revision: i64,
) -> Result<usize, CommandError> {
    // Kunci payload yang tidak dikirim server berarti "tabel ini tidak berubah"
    // pada pull inkremental — bukan "tabel ini kosong". Berhenti lebih awal agar
    // blok delete_missing tidak pernah menyentuhnya.
    let Some(rows) = snapshot
        .get(definition.payload_key)
        .and_then(Value::as_array)
    else {
        return Ok(0);
    };
    let placeholders = vec!["?"; definition.columns.len()].join(", ");
    let conflict_cols = definition
        .conflict_column
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    let updates = definition
        .columns
        .iter()
        .filter(|column| !conflict_cols.contains(column))
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

    // Kalau tabel lokal benar-benar kosong sementara server mengirim baris, cache
    // hash tidak boleh dipercaya (mis. tabel sempat dikosongkan di luar aplikasi).
    // Tulis ulang semuanya sekali supaya drift seperti itu sembuh sendiri.
    let distrust_hash_cache = !rows.is_empty()
        && transaction
            .query_row(
                &format!(
                    "SELECT NOT EXISTS(SELECT 1 FROM {} LIMIT 1);",
                    definition.table
                ),
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);

    let mut written = 0usize;
    {
        let mut upsert_row = transaction
            .prepare_cached(&statement)
            .map_err(|err| sync_table_error(definition.table, err))?;
        let mut upsert_revision = transaction
            .prepare_cached(REVISION_UPSERT_SQL)
            .map_err(|_| CommandError::internal())?;

        for row in rows {
            let key = entity_key(row, definition.entity_column);
            if key.is_empty() || guard.row_has_unsynced_change(definition, row, &key) {
                continue;
            }
            // Konfigurasi koneksi milik perangkat lain tidak boleh menimpa milik kita.
            if definition.domain == "setting" && is_device_local_setting(&key) {
                continue;
            }

            // Lewati baris yang isinya persis sama dengan yang sudah tersimpan.
            // Inilah yang memangkas mayoritas tulisan: snapshot penuh biasanya
            // hanya berbeda di segelintir baris, sisanya identik.
            let payload_hash = row_payload_hash(definition.table, row);
            let cache_key = guard_key(definition.domain, &key);
            if !distrust_hash_cache
                && hashes
                    .get(&cache_key)
                    .is_some_and(|previous| previous == &payload_hash)
            {
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
            upsert_row
                .execute(rusqlite::params_from_iter(values))
                .map_err(|err| sync_table_error(definition.table, err))?;
            upsert_revision
                .execute(params![
                    definition.domain,
                    key,
                    revision,
                    payload_hash,
                    storage::now_epoch_seconds(),
                ])
                .map_err(|_| CommandError::internal())?;
            hashes.insert(cache_key, payload_hash);
            written += 1;
        }
    }
    if definition.delete_missing {
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
            if snapshot_keys.contains(&key) || guard.has(definition.domain, &key) {
                continue;
            }
            let cache_key = guard_key(definition.domain, &key);
            // Jejak `desktop_entity_revision` sudah dimuat di awal apply_snapshot,
            // jadi asal-usul baris diperiksa dari memori, bukan query per baris.
            let came_from_server = hashes.contains_key(&cache_key);
            if !came_from_server {
                // Baris lokal murni yang tidak pernah datang dari server: jangan dihapus.
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
            hashes.remove(&cache_key);
            written += 1;
        }
    }
    Ok(written)
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

/// Daftarkan snapshot terkini satu karyawan ke outbox sebagai `employee/update`.
///
/// Dipakai setiap kali kolom di `master_data` berubah di luar layar Karyawan —
/// perpindahan shift lanjutan oleh scanner, dan pemeliharaan `status_backup`
/// saat penugasan backup dibuat atau dibatalkan. `master_data` ikut
/// disinkronkan, jadi perubahan tanpa event outbox tidak akan pernah sampai ke
/// perangkat lain.
pub fn enqueue_employee_snapshot(
    transaction: &Transaction<'_>,
    client_id: &str,
    employee_id: &str,
) -> Result<(), CommandError> {
    let revision: Option<i64> = transaction
        .query_row(
            "SELECT server_revision FROM desktop_entity_revision WHERE domain = 'employee' AND entity_key = ?;",
            params![employee_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();

    let payload_json: String = transaction
        .query_row(
            r#"
        SELECT json_object(
          'id_unik', id_unik, 'kode_karyawan', COALESCE(kode_karyawan, ''),
          'nama', COALESCE(nama, ''), 'divisi', COALESCE(divisi, ''),
          'jabatan_status', COALESCE(jabatan_status, ''), 'no_hp', COALESCE(no_hp, ''),
          'lp', COALESCE(lp, ''), 'id_shift', id_shift,
          'status_aktif', COALESCE(status_aktif, ''),
          'tanggal_daftar', COALESCE(tanggal_daftar, ''), 'catatan', COALESCE(catatan, ''),
          'token_absensi', COALESCE(token_absensi, ''), 'qr_code', COALESCE(qr_code, ''),
          'status_qr', COALESCE(status_qr, ''), 'jenis_personil', COALESCE(jenis_personil, ''),
          'tanggal_mulai_aktif', COALESCE(tanggal_mulai_aktif, ''),
          'tanggal_selesai_aktif', COALESCE(tanggal_selesai_aktif, ''),
          'status_backup', COALESCE(status_backup, 'NORMAL')
        ) FROM master_data WHERE id_unik = ?;
        "#,
            params![employee_id],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|_| CommandError::internal())?;

    enqueue(
        transaction,
        client_id,
        "employee",
        "update",
        employee_id,
        &payload,
        revision,
    )?;
    Ok(())
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
    // Penjagaan terakhir: konfigurasi koneksi perangkat tidak boleh masuk outbox.
    if domain == "setting" && is_device_local_setting(entity_key) {
        return Err(CommandError::new(
            "DESKTOP_SYNC_EVENT_INVALID",
            format!("Pengaturan '{entity_key}' bersifat lokal perangkat dan tidak disinkronkan."),
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

/// Nilai `sync_pulse` cloud yang terakhir berhasil diterapkan, per tabel.
fn load_table_cursors(state: &DesktopState) -> Result<HashMap<String, i64>, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare("SELECT table_name, remote_revision FROM desktop_sync_table_cursor;")
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| CommandError::internal())?;
    let mut cursors = HashMap::new();
    for row in rows {
        let (table, revision) = row.map_err(|_| CommandError::internal())?;
        cursors.insert(table, revision);
    }
    Ok(cursors)
}

/// Membaca sidik jari baris yang terakhir diterapkan dari server, sekali saja
/// untuk seluruh snapshot. Dipakai `apply_table` untuk melewatkan baris yang
/// tidak berubah tanpa satu pun query tambahan per baris.
fn load_revision_hashes(
    transaction: &Transaction<'_>,
) -> Result<HashMap<String, String>, CommandError> {
    let mut statement = transaction
        .prepare("SELECT domain, entity_key, payload_hash FROM desktop_entity_revision;")
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (domain, key, hash) = row.map_err(|_| CommandError::internal())?;
        hashes.insert(guard_key(&domain, &key), hash);
    }
    Ok(hashes)
}

pub fn apply_snapshot(state: &DesktopState, payload: &Value) -> Result<usize, CommandError> {
    apply_snapshot_with_pulse(state, payload, None)
}

/// Menerapkan snapshot cloud ke SQLite lokal dalam satu transaksi.
///
/// `pulse` adalah nilai `sync_pulse` cloud saat snapshot ini diambil. Nilainya
/// dicatat per tabel HANYA untuk tabel yang benar-benar ikut dikirim, sehingga
/// pull berikutnya tahu persis tabel mana yang masih basi.
pub fn apply_snapshot_with_pulse(
    state: &DesktopState,
    payload: &Value,
    pulse: Option<&HashMap<String, i64>>,
) -> Result<usize, CommandError> {
    // Pastikan skema lokal sudah memuat seluruh tabel snapshot terbaru (mis. id_card_template,
    // company_profile) sebelum menerapkan data server. Tanpa ini, client dengan skema lokal yang
    // tertinggal (belum sempat relaunch sejak tabel baru ditambahkan) akan gagal total di tengah
    // transaksi apply_table dan me-rollback SELURUH snapshot, bukan hanya tabel yang hilang.
    storage::initialize(&state.data_dir).map_err(|_| {
        CommandError::new(
            "DESKTOP_SCHEMA_MIGRATION_FAILED",
            "Skema database lokal tidak dapat disiapkan sebelum menerapkan snapshot sinkronisasi.",
        )
    })?;
    let snapshot = payload.get("snapshot").unwrap_or(payload);
    let revision = snapshot
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(CommandError::internal)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    // Snapshot yang revisinya lebih tua daripada cursor lokal adalah data basi —
    // misalnya replika cloud yang tertinggal. Menerapkannya akan memundurkan
    // cursor dan menimpa baris lokal dengan versi lama.
    let local_revision: i64 = transaction
        .query_row(
            "SELECT last_revision FROM desktop_sync_cursor WHERE domain = 'operational';",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if revision < local_revision {
        return Err(CommandError::new(
            "DESKTOP_SYNC_SNAPSHOT_STALE",
            format!(
                "Snapshot cloud revisi {revision} lebih tua daripada data lokal revisi {local_revision}. Snapshot diabaikan agar data terbaru tidak tertimpa."
            ),
        ));
    }

    let guard = PendingGuard::load(&transaction)?;
    let mut hashes = load_revision_hashes(&transaction)?;
    reconcile_shift_ids(&transaction, &guard, snapshot)?;
    let mut written = 0usize;
    for definition in SNAPSHOT_TABLES {
        written += apply_table(
            &transaction,
            &guard,
            &mut hashes,
            snapshot,
            definition,
            revision,
        )?;
    }

    // Catat pulse cloud per tabel. Pemanggil hanya mengirim entri untuk tabel
    // yang benar-benar ikut ditarik; tabel lain tetap memakai cursor lamanya
    // sehingga pull berikutnya masih menganggapnya basi.
    if let Some(pulse) = pulse {
        for (table, remote_revision) in pulse {
            transaction
                .execute(
                    r#"
          INSERT INTO desktop_sync_table_cursor (table_name, remote_revision, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(table_name) DO UPDATE SET
            remote_revision = excluded.remote_revision,
            updated_at = excluded.updated_at;
          "#,
                    params![table, remote_revision, storage::now_epoch_seconds()],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }

    // Bersihkan temporary local log_scan (id_log < 0) jika sudah ada baris server
    // permanen yang cocok. Dijalankan juga ketika tidak ada baris baru: baris
    // sementara bisa tertinggal dari siklus sebelumnya, misalnya ketika baris
    // server-nya sempat dilewati karena outbox-nya masih pending.
    // `id_log` adalah rowid, jadi penjagaan `id_log < 0` di bawah nyaris gratis.
    let has_temporary_scan_logs = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM log_scan WHERE id_log < 0);",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if has_temporary_scan_logs {
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
    }

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
    transaction
        .commit()
        .map_err(|_| CommandError::internal())
        .map(|()| written)
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

        // Probe murah sebelum menarik apa pun: satu query kecil ke `sync_pulse`
        // memberi tahu tabel mana saja yang berubah sejak pull terakhir. Trigger
        // pulse di cloud ikut naik untuk penulisan dari perangkat lain MAUPUN
        // dari route handler Web yang menulis langsung ke Turso, jadi probe ini
        // tidak bisa melewatkan perubahan. Bila tidak ada yang berubah, siklus
        // sync selesai tanpa menarik satu baris pun.
        let pulse = turso.fetch_sync_pulse().await?;
        let wanted = match pulse.as_ref() {
            Some(pulse) => {
                let local = load_table_cursors(state)?;
                let stale = pulse
                    .iter()
                    .filter(|(table, remote)| local.get(table.as_str()) != Some(remote))
                    .map(|(table, _)| table.clone())
                    .collect::<HashSet<String>>();
                if stale.is_empty() {
                    return status(state);
                }
                Some(stale)
            }
            // Database cloud lama tanpa tabel pulse: jatuh ke pull penuh.
            None => None,
        };

        let payload = turso.pull_snapshot_tables(last_rev, wanted.as_ref()).await?;
        let applied_pulse = pulse.as_ref().map(|pulse| {
            pulse
                .iter()
                .filter(|(table, _)| match wanted.as_ref() {
                    None => true,
                    Some(stale) => stale.contains(table.as_str()),
                })
                .map(|(table, revision)| (table.clone(), *revision))
                .collect::<HashMap<String, i64>>()
        });
        let written = apply_snapshot_with_pulse(state, &payload, applied_pulse.as_ref())?;
        let mut result = status(state)?;
        result.changed_rows = i64::try_from(written).unwrap_or(i64::MAX);
        return Ok(result);
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
        let written = apply_snapshot(state, &payload)?;
        let mut result = status(state)?;
        result.changed_rows = i64::try_from(written).unwrap_or(i64::MAX);
        return Ok(result);
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
      SELECT o.event_id, o.client_id, o.domain, o.operation, o.entity_key, o.payload_json,
             -- `base_revision` dibekukan saat event DIBUAT. Kalau event lain untuk
             -- entitas yang sama sudah terkirim lebih dulu, angka beku itu sudah
             -- usang dan cloud menolak event ini sebagai konflik yang tidak
             -- pernah bisa selesai — perangkat asal sudah menerapkan perubahannya
             -- secara lokal, sementara cloud menahannya selamanya.
             --
             -- Revisi server terbaru yang KITA ketahui ada di
             -- `desktop_entity_revision`. Isinya hanya berasal dari push kita
             -- sendiri yang berhasil dan dari pull yang benar-benar menerapkan
             -- baris itu — dan pull SELALU melewati baris yang outbox-nya masih
             -- menggantung (lihat `PendingGuard`). Jadi memakainya di sini tidak
             -- melemahkan deteksi konflik antar-perangkat: perubahan perangkat
             -- lain tidak akan pernah masuk ke sini selama event ini antre.
             CASE
               WHEN o.base_revision IS NULL THEN NULL
               ELSE MAX(
                 o.base_revision,
                 COALESCE(
                   (SELECT r.server_revision FROM desktop_entity_revision r
                     WHERE r.domain = o.domain AND r.entity_key = o.entity_key),
                   o.base_revision
                 )
               )
             END AS base_revision,
             o.created_at
      FROM desktop_sync_outbox o
      WHERE status = 'pending'
         OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         -- Konflik UNIQUE pada shift/karyawan memang layak dicoba ulang: baris
         -- kembarannya biasanya sudah direkonsiliasi oleh pull berikutnya.
         -- Tetapi retry-nya WAJIB ikut backoff. Tanpa `next_retry_at`, konflik
         -- yang tidak pernah bisa selesai (mis. kode_shift yang memang benar-benar
         -- dobel) akan didorong ulang ke cloud setiap siklus 30 detik selamanya,
         -- menghabiskan kuota dan baterai perangkat lapangan.
         OR (status = 'conflict' AND operation = 'create'
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
             AND (
              (domain = 'shift' AND last_error LIKE '%UNIQUE constraint failed: tbl_shift.kode_shift%')
              OR (domain = 'employee' AND last_error LIKE '%UNIQUE constraint failed: master_data.id_unik%')
            ))
         -- Konflik "revisi basi" pada entitas yang sama nyaris selalu ditimbulkan
         -- perangkat ini sendiri: dua event lahir sebelum sempat terkirim, event
         -- kedua membawa `base_revision` dari sebelum event pertama diterapkan.
         -- Pengiriman ulang sekarang membawa revisi terbaru (lihat kolom
         -- `base_revision` di atas), jadi percobaan pertama biasanya langsung
         -- berhasil. Dibatasi `attempt_count` supaya konflik yang benar-benar
         -- lintas perangkat berhenti dan tetap muncul sebagai konflik yang harus
         -- diselesaikan operator, bukan berputar selamanya.
         --
         -- Pesan lain sengaja TIDAK ikut: "Data absensi server berubah setelah
         -- event lokal dibuat." membandingkan `attendanceBaseUpdatedAt` yang
         -- tertanam di payload dan tidak bisa disegarkan oleh retry, sedangkan
         -- "Data absensi sudah dikoreksi admin..." memang harus tetap ditolak.
         OR (status = 'conflict'
             AND attempt_count < 5
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
             AND last_error = 'Data server berubah setelah snapshot lokal dibuat.')
      ORDER BY
        CASE WHEN domain = 'shift' AND operation = 'create' THEN 0 ELSE 1 END,
        created_at ASC,
        -- Dua event pada detik yang sama untuk entitas yang sama harus tetap
        -- terkirim sesuai urutan pembuatannya; tanpa ini urutannya tidak
        -- ditentukan dan rantai revisi batch bisa terbalik.
        o.rowid ASC
      LIMIT 50;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    let rows = statement
        .query_map([now, now, now], |row| {
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
            // Konflik ikut menaikkan `attempt_count` dan menjadwalkan
            // `next_retry_at` dengan backoff eksponensial yang sama seperti
            // kegagalan biasa. Hanya konflik UNIQUE shift/karyawan yang benar-benar
            // diambil ulang oleh `pending_events`, tetapi tanpa jadwal ini konflik
            // itu didorong ulang setiap siklus 30 detik tanpa henti — termasuk
            // konflik yang memang tidak akan pernah selesai.
            let attempt: i64 = transaction
                .query_row(
                    "SELECT attempt_count FROM desktop_sync_outbox WHERE event_id = ?;",
                    [event_id],
                    |row| row.get(0),
                )
                .unwrap_or_default();
            let exponent = u32::try_from(attempt.clamp(0, 8)).unwrap_or_default();
            let delay = 5_i64.saturating_mul(2_i64.saturating_pow(exponent));
            transaction
                .execute(
                    r#"
          UPDATE desktop_sync_outbox SET status = 'conflict', last_error = ?,
            server_revision = ?, attempt_count = attempt_count + 1,
            next_retry_at = ?, updated_at = ? WHERE event_id = ?;
          "#,
                    params![
                        message,
                        server_revision,
                        storage::now_epoch_seconds() + delay,
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

fn ensure_unsynced_payroll_data_enqueued(state: &DesktopState) -> Result<(), CommandError> {
    let client_id = match ensure_client_id(state) {
        Ok(id) => id,
        Err(_) => return Ok(()),
    };
    let mut connection = match storage::database(&state.data_dir) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let transaction = match connection.transaction() {
        Ok(t) => t,
        Err(_) => return Ok(()),
    };

    // 1. Salary Configs
    if let Ok(mut stmt) = transaction.prepare(
        "SELECT id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at
         FROM salary_configs
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'salary-config'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         );",
    ) {
        if let Ok(rows) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by, created_at) in rows {
                let payload = json!({
                    "id": id,
                    "id_karyawan": id_karyawan,
                    "rate_per_hour": rate_per_hour,
                    "ptkp_status": ptkp_status,
                    "effective_date": effective_date,
                    "created_by": created_by,
                    "created_at": created_at,
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "salary-config", &id, &payload, None);
            }
        }
    }

    // Baris tarif default sudah disediakan seed di sisi lokal MAUPUN cloud, jadi
    // tidak boleh ikut didorong backfill. Kalau ikut, instalasi baru akan
    // menimpa tarif yang sudah disesuaikan admin dengan nilai bawaan.
    let default_rate_ids = payroll_seed::DEFAULT_RATE_IDS
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");

    // 2. Overtime Tier Rules
    if let Ok(mut stmt) = transaction.prepare(&format!(
        "SELECT id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active
         FROM overtime_tier_rules
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'overtime-rule'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         ) AND id NOT IN ({default_rate_ids});"
    )) {
        if let Ok(rows) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, f64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, rule_type, tier_order, hour_start, hour_end, multiplier, is_active) in rows {
                let payload = json!({
                    "id": id,
                    "rule_type": rule_type,
                    "tier_order": tier_order,
                    "hour_start": hour_start,
                    "hour_end": hour_end,
                    "multiplier": multiplier,
                    "is_active": is_active,
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "overtime-rule", &id, &payload, None);
            }
        }
    }

    // 3. Tax Rules
    if let Ok(mut stmt) = transaction.prepare(&format!(
        "SELECT id, category, bracket_min, bracket_max, rate_percentage, effective_date
         FROM tax_rules
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'tax-rule'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         ) AND id NOT IN ({default_rate_ids});"
    )) {
        if let Ok(rows) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, category, bracket_min, bracket_max, rate_percentage, effective_date) in rows {
                let payload = json!({
                    "id": id,
                    "category": category,
                    "bracket_min": bracket_min,
                    "bracket_max": bracket_max,
                    "rate_percentage": rate_percentage,
                    "effective_date": effective_date,
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "tax-rule", &id, &payload, None);
            }
        }
    }

    // 4. BPJS Rules
    if let Ok(mut stmt) = transaction.prepare(&format!(
        "SELECT id, component_code, component_name, rate_percentage, wage_cap, effective_date
         FROM bpjs_rules
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'bpjs-rule'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         ) AND id NOT IN ({default_rate_ids});"
    )) {
        if let Ok(rows) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, component_code, component_name, rate_percentage, wage_cap, effective_date) in rows {
                let payload = json!({
                    "id": id,
                    "component_code": component_code,
                    "component_name": component_name,
                    "rate_percentage": rate_percentage,
                    "wage_cap": wage_cap,
                    "effective_date": effective_date,
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "bpjs-rule", &id, &payload, None);
            }
        }
    }

    // 5. Payroll Components
    if let Ok(mut stmt) = transaction.prepare(
        "SELECT id, name, category, calc_type, default_value, applies_to, is_active
         FROM payroll_components
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'payroll-component'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         );",
    ) {
        if let Ok(rows) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, name, category, calc_type, default_value, applies_to, is_active) in rows {
                let payload = json!({
                    "id": id,
                    "name": name,
                    "category": category,
                    "calc_type": calc_type,
                    "default_value": default_value,
                    "applies_to": applies_to,
                    "is_active": is_active,
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "payroll-component", &id, &payload, None);
            }
        }
    }

    // 6. Payroll Runs
    if let Ok(mut stmt) = transaction.prepare(
        "SELECT id, idempotency_key, period_start, period_end, status,
                total_gross_payout, total_net_payout, total_employees,
                created_by, created_at, updated_at
         FROM payroll_runs
         WHERE id NOT IN (
             SELECT entity_key FROM desktop_sync_outbox WHERE domain = 'payroll' AND operation = 'create-run'
         ) AND id NOT IN (
             SELECT entity_key FROM desktop_entity_revision WHERE domain = 'payroll'
         );",
    ) {
        if let Ok(runs) = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
        {
            drop(stmt);
            for (id, idempotency_key, period_start, period_end, status, total_gross_payout, total_net_payout, total_employees, created_by, created_at, updated_at) in runs {
                let items: Vec<Value> = if let Ok(mut item_stmt) = transaction.prepare(
                    "SELECT id, id_karyawan, nama_karyawan, divisi, ptkp_status,
                            total_regular_hours, total_overtime_hours, total_overtime_index,
                            rate_per_hour, basic_salary, overtime_salary, gross_salary,
                            total_allowances, total_deductions, bpjs_employee_total, bpjs_company_total,
                            pph21_amount, net_salary, breakdown_snapshot, created_at
                     FROM payroll_items
                     WHERE payroll_run_id = ?;",
                ) {
                    let mapped_items = item_stmt.query_map([&id], |row| {
                        Ok(json!({
                            "id": row.get::<_, String>(0)?,
                            "id_karyawan": row.get::<_, String>(1)?,
                            "nama_karyawan": row.get::<_, String>(2)?,
                            "divisi": row.get::<_, String>(3)?,
                            "ptkp_status": row.get::<_, String>(4)?,
                            "total_regular_hours": row.get::<_, f64>(5)?,
                            "total_overtime_hours": row.get::<_, f64>(6)?,
                            "total_overtime_index": row.get::<_, f64>(7)?,
                            "rate_per_hour": row.get::<_, i64>(8)?,
                            "basic_salary": row.get::<_, i64>(9)?,
                            "overtime_salary": row.get::<_, i64>(10)?,
                            "gross_salary": row.get::<_, i64>(11)?,
                            "total_allowances": row.get::<_, i64>(12)?,
                            "total_deductions": row.get::<_, i64>(13)?,
                            "bpjs_employee_total": row.get::<_, i64>(14)?,
                            "bpjs_company_total": row.get::<_, i64>(15)?,
                            "pph21_amount": row.get::<_, i64>(16)?,
                            "net_salary": row.get::<_, i64>(17)?,
                            "breakdown_snapshot": row.get::<_, String>(18)?,
                            "created_at": row.get::<_, String>(19)?,
                        }))
                    });
                    mapped_items.map(|iter| iter.filter_map(|r| r.ok()).collect()).unwrap_or_default()
                } else {
                    Vec::new()
                };

                let payload = json!({
                    "run": {
                        "id": id,
                        "idempotency_key": idempotency_key,
                        "period_start": period_start,
                        "period_end": period_end,
                        "status": status,
                        "total_gross_payout": total_gross_payout,
                        "total_net_payout": total_net_payout,
                        "total_employees": total_employees,
                        "created_by": created_by,
                        "created_at": created_at,
                        "updated_at": updated_at,
                    },
                    "items": items,
                    "audit": {
                        "id": format!("aud-{}", id),
                        "payroll_run_id": id,
                        "action": "AUTO_SYNC_BACKFILL",
                        "old_status": Value::Null,
                        "new_status": status,
                        "performed_by": created_by,
                        "notes": "Backfill otomatis outbox sinkronisasi.",
                        "created_at": created_at,
                    }
                });
                let _ = enqueue(&transaction, &client_id, "payroll", "create-run", &id, &payload, None);
            }
        }
    }

    let _ = transaction.commit();
    Ok(())
}

/// Batas jumlah batch yang boleh dikirim dalam satu siklus push.
///
/// Loop push berhenti ketika satu batch berisi kurang dari 50 event. Kalau
/// seluruh 50 event dalam batch berakhir sebagai `conflict` yang layak dicoba
/// ulang, `pending_events` bisa mengembalikan 50 baris yang sama persis pada
/// putaran berikutnya dan loop tidak pernah berhenti. Batas ini memastikan
/// siklus selalu selesai; sisa antrean ikut siklus berikutnya.
const MAX_PUSH_BATCHES_PER_CYCLE: usize = 40;

pub async fn push_outbox(state: &DesktopState, token: &str) -> Result<(), CommandError> {
    let _ = ensure_unsynced_payroll_data_enqueued(state);
    if let Ok(turso) = state.get_turso_client() {
        // Diperiksa sekali per siklus push, dan hanya bila benar-benar ada yang
        // dikirim, supaya sync idle tidak menambah round-trip ke Turso.
        let mut schema_checked = false;
        for _ in 0..MAX_PUSH_BATCHES_PER_CYCLE {
            let (_client_id, events) = pending_events(state)?;
            if events.is_empty() {
                return Ok(());
            }
            if !schema_checked {
                // Sengaja sebelum mark_batch_failed mana pun: event tetap
                // `pending` dan akan terkirim lagi setelah aplikasi diperbarui.
                assert_cloud_schema_compatible(&turso).await?;
                schema_checked = true;
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
        return Ok(());
    }

    if !token.is_empty() {
        for _ in 0..MAX_PUSH_BATCHES_PER_CYCLE {
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
                Some(json!({
                    "clientId": client_id,
                    "schemaVersion": CLIENT_SCHEMA_VERSION,
                    "events": events,
                })),
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

/// Satu siklus sinkronisasi penuh: kirim antrean lokal, lalu tarik perubahan cloud.
///
/// Push yang gagal sengaja TIDAK menghentikan pull. Sebelumnya `push_outbox(...)?`
/// langsung mengembalikan error, sehingga satu event outbox yang bermasalah
/// (atau satu gangguan jaringan sesaat) mematikan pull selamanya — perangkat
/// berhenti menerima data cloud sama sekali. Sekarang kegagalan push tetap
/// tercatat di outbox dengan backoff, dan dilaporkan lewat `push_error`.
/// Penjaga agar hanya satu siklus sinkronisasi berjalan pada satu waktu.
///
/// Auto-sync berkala, tombol sync manual, dan push setelah scan bisa datang
/// hampir bersamaan. Menjalankannya paralel tidak mempercepat apa pun — keduanya
/// hanya berebut kunci tulis SQLite lokal dan berisiko "database is locked".
static SYNC_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct SyncInFlightGuard;

impl Drop for SyncInFlightGuard {
    fn drop(&mut self) {
        SYNC_IN_FLIGHT.store(false, Ordering::Release);
    }
}

pub async fn synchronize(
    state: &DesktopState,
    token: &str,
) -> Result<DesktopSyncStatus, CommandError> {
    if SYNC_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        // Siklus lain sedang berjalan; laporkan status terkini saja.
        return status(state);
    }
    let _in_flight = SyncInFlightGuard;

    let push_error = push_outbox(state, token).await.err();
    let pulled = pull_snapshot(state, token).await;

    // Penegakan RBAC dinamis untuk jalur 2-tier. Sesi Desktop/Mobile hidup di
    // memori sampai aplikasi ditutup, jadi tanpa langkah ini operator yang baru
    // saja dinonaktifkan atau dicabut permission-nya tetap memegang akses penuh
    // di perangkatnya. Sisi web sudah memeriksa `rbac_revision` pada setiap
    // request; perangkat memeriksanya sekali per siklus sinkronisasi.
    enforce_rbac_revision(state).await;

    match pulled {
        Ok(mut status) => {
            status.push_error = push_error.map(|error| error.message);
            Ok(status)
        }
        Err(pull_error) => Err(push_error.unwrap_or(pull_error)),
    }
}

/// Cabut atau segarkan sesi aktif bila katalog RBAC cloud sudah berubah.
///
/// Sengaja tidak mengembalikan error: ini pekerjaan latar di akhir siklus sync,
/// dan kegagalan jaringan TIDAK boleh menjatuhkan sinkronisasi yang sudah
/// berhasil — apalagi mencabut sesi. Sesi hanya dicabut ketika cloud menjawab
/// dengan pasti bahwa operatornya sudah tidak aktif.
async fn enforce_rbac_revision(state: &DesktopState) {
    let Some((operator_id, known_revision)) = ({
        let Ok(guard) = state.session.lock() else {
            return;
        };
        guard
            .as_ref()
            .map(|session| (session.operator.id, session.operator.permission_revision))
    }) else {
        return;
    };

    // `rbac_revision` ikut tersinkronisasi lewat `setting_gex_system`, jadi
    // perbandingannya dibaca dari SQLite lokal — nol round-trip tambahan pada
    // kasus normal ketika tidak ada perubahan role sama sekali.
    let Ok(connection) = storage::database(&state.data_dir) else {
        return;
    };
    let local_revision: Option<i64> = connection
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = 'rbac_revision' LIMIT 1;",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok());
    drop(connection);

    let Some(local_revision) = local_revision else {
        return;
    };
    if local_revision == known_revision {
        return;
    }

    let Ok(turso) = state.get_turso_client() else {
        return;
    };
    match turso.reload_operator(operator_id).await {
        Ok(Some(refreshed)) => {
            if let Ok(mut guard) = state.session.lock() {
                if let Some(session) = guard.as_mut() {
                    // Hanya perbarui bila sesi masih milik operator yang sama:
                    // pengguna bisa saja logout lalu login sebagai orang lain
                    // selama query di atas berjalan.
                    if session.operator.id == operator_id {
                        session.operator = refreshed;
                    }
                }
            }
        }
        Ok(None) => {
            if let Ok(mut guard) = state.session.lock() {
                if guard
                    .as_ref()
                    .is_some_and(|session| session.operator.id == operator_id)
                {
                    *guard = None;
                }
            }
            storage::audit(
                &state.data_dir,
                Some(operator_id),
                "session-revoked-rbac-change",
                None,
            );
        }
        // Cloud tidak menjawab: biarkan sesi apa adanya dan coba lagi siklus
        // berikutnya. Mencabut sesi di sini akan mengeluarkan operator lapangan
        // setiap kali sinyal terputus sesaat.
        Err(_) => {}
    }
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
            "payrollRuns": table_count("payroll_runs"),
            "payrollItems": table_count("payroll_items"),
            "salaryConfigs": table_count("salary_configs"),
        }),
        push_error: None,
        changed_rows: 0,
        local_mode: state
            .turso_config()
            .is_some_and(|config| config.provider.is_local_file()),
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

pub fn resolve_conflicts_local(
    state: &DesktopState,
    event_id: Option<&str>,
) -> Result<(), CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    if let Some(event_id) = event_id {
        transaction
            .execute(
                "DELETE FROM desktop_sync_conflict WHERE event_id = ?;",
                params![event_id],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                // Payload ikut ditandai supaya server tahu ini keputusan sadar
                // operator, bukan push biasa. Tanpa tanda ini konfliknya abadi:
                // basis optimistis di payload tidak pernah berubah, jadi setiap
                // percobaan ulang ditolak dengan pesan yang sama.
                "UPDATE desktop_sync_outbox SET status = 'pending', base_revision = NULL, attempt_count = 0, last_error = NULL, payload_json = json_set(payload_json, '$.forceLocalOverride', json('true')), updated_at = ? WHERE event_id = ? AND status = 'conflict';",
                params![now, event_id],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        transaction
            .execute(
                "DELETE FROM desktop_sync_conflict;",
                [],
            )
            .map_err(|_| CommandError::internal())?;
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'pending', base_revision = NULL, attempt_count = 0, last_error = NULL, payload_json = json_set(payload_json, '$.forceLocalOverride', json('true')), updated_at = ? WHERE status = 'conflict';",
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
        apply_push_results, apply_snapshot, enqueue, ensure_client_id, is_client_schema_outdated,
        pending_events, storage, DesktopState, CLIENT_SCHEMA_VERSION,
    };

    #[test]
    fn push_ditolak_hanya_saat_skema_cloud_lebih_baru() {
        // Cloud lebih baru: build ini tidak mengenal kolom barunya, push harus berhenti.
        assert!(is_client_schema_outdated(CLIENT_SCHEMA_VERSION + 1));
        // Sama versi: kondisi normal.
        assert!(!is_client_schema_outdated(CLIENT_SCHEMA_VERSION));
        // Client lebih baru: jalur migrasi normal lewat ensure_schema, jangan diblokir.
        assert!(!is_client_schema_outdated(CLIENT_SCHEMA_VERSION - 1));
        // Cloud kosong / belum bermigrasi.
        assert!(!is_client_schema_outdated(0));
    }

    /// `AutoSyncRunner` memakai bendera ini untuk memutuskan apakah
    /// `navigator.onLine === false` boleh dipakai sebagai alasan melewatkan
    /// siklus. Salah di sini berarti perangkat mode lokal yang benar-benar
    /// terputus berhenti menguras outbox, hub tertinggal, lalu ekspor cadangan
    /// dan promosi ke cloud kehilangan data tanpa satu pun pesan error.
    #[test]
    fn status_menandai_mode_lokal_hanya_untuk_provider_local_file() {
        let (_dir, state) = fixture();

        // Belum dikonfigurasi: bukan mode lokal.
        assert!(!super::status(&state).expect("status").local_mode);

        for (provider, harapan) in [
            (crate::desktop::turso::DatabaseProvider::Turso, false),
            (crate::desktop::turso::DatabaseProvider::SelfHosted, false),
            (crate::desktop::turso::DatabaseProvider::LocalFile, true),
        ] {
            *state.turso_config.write().expect("kunci config") =
                Some(crate::desktop::turso::TursoConfig::new(
                    if provider.is_local_file() {
                        "C:/data/sppg-hub.db".to_string()
                    } else {
                        "https://contoh.turso.io".to_string()
                    },
                    "token".to_string(),
                    provider,
                    false,
                ));
            assert_eq!(
                super::status(&state).expect("status").local_mode,
                harapan,
                "provider {provider:?} salah ditandai"
            );
        }
    }

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

    /// Regresi: dua event untuk SATU sesi absensi dibuat berturut-turut sebelum
    /// siklus push berikutnya — persis yang terjadi saat operator menghapus jam
    /// scan Masuk (`attendance/update`) lalu jam scan Pulang
    /// (`attendance/delete`). Event kedua membeku dengan `base_revision` dari
    /// SEBELUM event pertama diterapkan, sehingga cloud menolaknya sebagai
    /// konflik yang tidak pernah bisa selesai: perangkat asal sudah menghapus
    /// barisnya secara lokal sementara cloud — dan setiap perangkat lain yang
    /// menariknya — menyimpannya selamanya.
    ///
    /// `pending_events` karena itu WAJIB mengambil revisi server terbaru yang
    /// diketahui perangkat ini, bukan angka beku saat enqueue.
    #[test]
    fn pending_events_memakai_revisi_server_terbaru_untuk_entitas_yang_sama() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        let update_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "update",
            "NORMAL-20260902-K001-1",
            &json!({"id_sesi": "NORMAL-20260902-K001-1", "jam_masuk": ""}),
            Some(453),
        )
        .expect("attendance update event");
        let delete_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "delete",
            "NORMAL-20260902-K001-1",
            &json!({"id_sesi": "NORMAL-20260902-K001-1"}),
            Some(453),
        )
        .expect("attendance delete event");
        transaction.commit().expect("commit");
        drop(connection);

        // Event pertama terkirim; revisi server entitas ini maju ke 458.
        let results = json!([{
            "eventId": update_id,
            "status": "applied",
            "message": "Berhasil.",
            "serverRevision": 458
        }]);
        apply_push_results(
            &state,
            std::slice::from_ref(&update_id),
            results.as_array().expect("results"),
        )
        .expect("valid result");

        let (_batch_client_id, events) = pending_events(&state).expect("pending events");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("eventId").and_then(Value::as_str),
            Some(delete_id.as_str())
        );
        assert_eq!(
            events[0].get("baseRevision").and_then(Value::as_i64),
            Some(458),
            "event kedua harus memakai revisi hasil event pertama, bukan 453"
        );
    }

    /// Konflik "revisi basi" harus dicoba ulang — dengan revisi yang sudah
    /// disegarkan percobaan berikutnya biasanya langsung berhasil — tetapi
    /// TIDAK selamanya: konflik yang benar-benar lintas perangkat wajib berhenti
    /// dan tetap terlihat sebagai konflik yang harus diselesaikan operator.
    #[test]
    fn konflik_revisi_basi_dicoba_ulang_sampai_batas_percobaan() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        let event_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "delete",
            "NORMAL-20260902-K001-3",
            &json!({"id_sesi": "NORMAL-20260902-K001-3"}),
            Some(453),
        )
        .expect("attendance delete event");
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'conflict', attempt_count = 1,
                   next_retry_at = ?, last_error = 'Data server berubah setelah snapshot lokal dibuat.'
                 WHERE event_id = ?;",
                rusqlite::params![storage::now_epoch_seconds() - 60, event_id],
            )
            .expect("mark conflict");
        transaction.commit().expect("commit");
        drop(connection);

        let (_client, events) = pending_events(&state).expect("pending events");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("eventId").and_then(Value::as_str),
            Some(event_id.as_str())
        );

        // Sudah dicoba lima kali: berhenti, jangan berputar selamanya.
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE desktop_sync_outbox SET attempt_count = 5 WHERE event_id = ?;",
                rusqlite::params![event_id],
            )
            .expect("exhaust attempts");
        drop(connection);
        let (_client, events) = pending_events(&state).expect("pending events");
        assert!(events.is_empty());
    }

    /// Konflik jenis lain TIDAK boleh ikut jalur retry ini: pesan prioritas
    /// Koreksi Admin memang harus tetap ditolak, dan pemeriksaan
    /// `attendanceBaseUpdatedAt` tertanam di payload sehingga retry tidak
    /// pernah bisa menyegarkannya.
    #[test]
    fn konflik_selain_revisi_basi_tidak_dicoba_ulang() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        let event_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "delete",
            "NORMAL-20260902-K001-4",
            &json!({"id_sesi": "NORMAL-20260902-K001-4"}),
            Some(453),
        )
        .expect("attendance delete event");
        transaction
            .execute(
                "UPDATE desktop_sync_outbox SET status = 'conflict', attempt_count = 1,
                   next_retry_at = ?,
                   last_error = 'Data absensi sudah dikoreksi admin dan tidak boleh ditimpa sumber lain.'
                 WHERE event_id = ?;",
                rusqlite::params![storage::now_epoch_seconds() - 60, event_id],
            )
            .expect("mark conflict");
        transaction.commit().expect("commit");
        drop(connection);

        let (_client, events) = pending_events(&state).expect("pending events");
        assert!(events.is_empty());
    }

    /// `base_revision` yang memang NULL berarti "tanpa pemeriksaan konkurensi"
    /// (mis. create). Kesegaran revisi tidak boleh mengubahnya menjadi angka:
    /// itu akan memasang pemeriksaan yang tidak pernah diminta pemanggilnya.
    #[test]
    fn pending_events_membiarkan_base_revision_null_apa_adanya() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");
        let transaction = connection.transaction().expect("transaction");
        transaction
            .execute(
                "INSERT INTO desktop_entity_revision (domain, entity_key, server_revision, payload_hash, updated_at)
                 VALUES ('attendance', 'NORMAL-20260902-K001-2', 501, 'tracked', 1);",
                [],
            )
            .expect("seed revision");
        let create_id = enqueue(
            &transaction,
            &client_id,
            "attendance",
            "create",
            "NORMAL-20260902-K001-2",
            &json!({"attendance": {"id_sesi": "NORMAL-20260902-K001-2"}}),
            None,
        )
        .expect("attendance create event");
        transaction.commit().expect("commit");
        drop(connection);

        let (_batch_client_id, events) = pending_events(&state).expect("pending events");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("eventId").and_then(Value::as_str),
            Some(create_id.as_str())
        );
        assert!(events[0]
            .get("baseRevision")
            .is_some_and(serde_json::Value::is_null));
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
    fn apply_snapshot_self_heals_a_stale_local_schema_missing_a_snapshot_table() {
        let (_directory, state) = fixture();
        {
            let connection = storage::database(&state.data_dir).expect("local database");
            connection
                .execute("DROP TABLE id_card_template;", [])
                .expect("simulate stale schema predating id_card_template");
        }

        let snapshot = json!({
            "snapshot": {
                "revision": 5,
                "employees": [],
                "idCards": [],
                "shifts": [],
                "settings": [],
                "idCardTemplates": [{
                    "id": "default_template",
                    "name": "Template Kantor",
                    "orientation": "portrait",
                    "front_bg_url": "data:image/png;base64,AAAA",
                    "back_bg_url": null,
                    "elements_json": "[]",
                    "is_active": 1,
                    "created_at": "2026-01-01T00:00:00.000Z",
                    "updated_at": "2026-01-01T00:00:00.000Z"
                }],
                "backups": [],
                "corrections": [],
                "imports": [],
                "attendance": [],
                "scanLogs": []
            }
        });

        apply_snapshot(&state, &snapshot).expect("snapshot applies after self-healing schema");

        let connection = storage::database(&state.data_dir).expect("local database");
        let name: String = connection
            .query_row(
                "SELECT name FROM id_card_template WHERE id = 'default_template';",
                [],
                |row| row.get(0),
            )
            .expect("recreated table has the pulled template row");
        assert_eq!(name, "Template Kantor");
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
    fn pengaturan_koneksi_perangkat_tidak_pernah_ikut_sinkronisasi() {
        let (_directory, state) = fixture();
        let client_id = ensure_client_id(&state).expect("client identity");
        let mut connection = storage::database(&state.data_dir).expect("local database");

        // Nilai koneksi milik perangkat ini.
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES ('turso_database_url', 'libsql://milik-saya.turso.io');",
                [],
            )
            .expect("local connection setting");

        let transaction = connection.transaction().expect("transaction");
        // Arah keluar: tidak boleh bisa masuk outbox.
        let ditolak = enqueue(
            &transaction,
            &client_id,
            "setting",
            "update",
            "turso_database_url",
            &json!({"key": "turso_database_url", "value": "libsql://milik-saya.turso.io"}),
            None,
        );
        assert!(ditolak.is_err(), "kunci koneksi perangkat tidak boleh di-enqueue");
        // Kunci pengaturan biasa tetap boleh.
        enqueue(
            &transaction,
            &client_id,
            "setting",
            "update",
            "geofence_enabled",
            &json!({"key": "geofence_enabled", "value": "1"}),
            None,
        )
        .expect("pengaturan operasional tetap disinkronkan");
        transaction.commit().expect("commit");
        drop(connection);

        // Arah masuk: nilai dari perangkat lain tidak boleh menimpa milik kita.
        let snapshot = json!({
            "snapshot": {
                "revision": 40,
                "settings": [
                    {"key": "turso_database_url", "value": "libsql://punya-perangkat-lain.turso.io"},
                    {"key": "anti_double_scan_seconds", "value": "30"}
                ],
                "employees": [], "idCards": [], "shifts": [], "backups": [],
                "corrections": [], "imports": [], "attendance": [], "scanLogs": []
            }
        });
        apply_snapshot(&state, &snapshot).expect("snapshot pengaturan");

        let connection = storage::database(&state.data_dir).expect("local database");
        let url: String = connection
            .query_row(
                "SELECT value FROM setting_gex_system WHERE key = 'turso_database_url';",
                [],
                |row| row.get(0),
            )
            .expect("connection setting");
        assert_eq!(
            url, "libsql://milik-saya.turso.io",
            "URL database perangkat lain tidak boleh menimpa milik perangkat ini"
        );
        let scan: String = connection
            .query_row(
                "SELECT value FROM setting_gex_system WHERE key = 'anti_double_scan_seconds';",
                [],
                |row| row.get(0),
            )
            .expect("operational setting");
        assert_eq!(scan, "30", "pengaturan operasional tetap ikut sinkronisasi");
    }

    #[test]
    fn snapshot_kedua_yang_identik_tidak_menulis_ulang_satu_baris_pun() {
        let (_directory, state) = fixture();
        let snapshot = json!({
            "snapshot": {
                "revision": 30,
                "employees": [
                    {
                        "id_unik": "EMP100", "kode_karyawan": "K100",
                        "nama": "Pegawai Tetap", "divisi": "Dapur",
                        "id_shift": 1
                    }
                ],
                "idCards": [], "shifts": [], "settings": [], "backups": [],
                "corrections": [], "imports": [], "attendance": [], "scanLogs": []
            }
        });

        let pertama = apply_snapshot(&state, &snapshot).expect("snapshot pertama");
        assert_eq!(pertama, 1, "baris baru harus ditulis pada pull pertama");

        // Snapshot yang isinya persis sama tidak boleh menyentuh SQLite lagi.
        // Inilah yang membuat sync berkala nyaris tanpa biaya tulis.
        let kedua = apply_snapshot(&state, &snapshot).expect("snapshot kedua");
        assert_eq!(kedua, 0, "baris identik harus dilewati tanpa penulisan");

        let mut berubah = snapshot.clone();
        berubah["snapshot"]["revision"] = json!(31);
        berubah["snapshot"]["employees"][0]["nama"] = json!("Pegawai Berubah");
        let ketiga = apply_snapshot(&state, &berubah).expect("snapshot berubah");
        assert_eq!(ketiga, 1, "baris yang berubah harus ditulis ulang");

        let connection = storage::database(&state.data_dir).expect("local database");
        let nama: String = connection
            .query_row(
                "SELECT nama FROM master_data WHERE id_unik = 'EMP100';",
                [],
                |row| row.get(0),
            )
            .expect("nama karyawan");
        assert_eq!(nama, "Pegawai Berubah");
    }

    #[test]
    fn snapshot_tanpa_kunci_tabel_tidak_menghapus_data_lokal_tabel_itu() {
        let (_directory, state) = fixture();
        let penuh = snapshot_with_shifts(json!([{
            "id_shift": 5, "kode_shift": 5, "nama_shift": "Shift Cloud",
            "jam_masuk": "07:00", "jam_pulang": "15:00",
            "jam_kerja_normal_menit": 480, "istirahat_menit": 60
        }]));
        apply_snapshot(&state, &penuh).expect("snapshot penuh");

        // Pull inkremental hanya mengirim tabel yang basi. Tabel yang tidak ikut
        // dikirim WAJIB dibiarkan apa adanya — termasuk yang delete_missing.
        let inkremental = json!({ "snapshot": { "revision": 13, "employees": [] } });
        apply_snapshot(&state, &inkremental).expect("snapshot inkremental");

        let connection = storage::database(&state.data_dir).expect("local database");
        let shifts: i64 = connection
            .query_row("SELECT COUNT(*) FROM tbl_shift;", [], |row| row.get(0))
            .expect("shift count");
        assert_eq!(shifts, 1, "tabel yang tidak dikirim tidak boleh dikosongkan");
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
