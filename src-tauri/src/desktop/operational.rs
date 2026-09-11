use std::collections::HashMap;

use base64::prelude::*;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::{config::DesktopState, models::CommandError, scanner, storage, sync};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn integer(value: &Value, key: &str, fallback: i64) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(fallback)
}

fn base_revision(
    transaction: &rusqlite::Transaction<'_>,
    domain: &str,
    entity_key: &str,
) -> Option<i64> {
    transaction
        .query_row(
            r#"
      SELECT server_revision FROM desktop_entity_revision
      WHERE domain = ? AND entity_key = ?;
      "#,
            params![domain, entity_key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn token_from_event(event_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(event_id.as_bytes());
    hex::encode_upper(hasher.finalize())[..10].to_owned()
}

pub fn list_employees(state: &DesktopState, filter: &Value) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            r#"
      SELECT
        m.id_unik, m.kode_karyawan, m.nama, m.divisi, m.jabatan_status,
        m.no_hp, m.lp, m.id_shift, m.status_aktif, m.tanggal_daftar,
        m.catatan, m.status_qr, m.jenis_personil, m.tanggal_mulai_aktif,
        m.tanggal_selesai_aktif, m.status_backup, s.nama_shift,
        c.idcard_status, c.idcard_pdf_url, c.link_qr_png,
        m.token_absensi, m.qr_code
      FROM master_data m
      LEFT JOIN tbl_shift s ON m.id_shift = s.id_shift
      LEFT JOIN id_card c ON m.id_unik = c.id_unik
      ORDER BY m.nama ASC;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let search = text(filter, "search").to_lowercase();
    let division = text(filter, "divisi");
    let status = text(filter, "status_aktif");
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id_unik": row.get::<_, String>(0)?,
                "kode_karyawan": row.get::<_, Option<String>>(1)?,
                "nama": row.get::<_, String>(2)?,
                "divisi": row.get::<_, String>(3)?,
                "jabatan_status": row.get::<_, Option<String>>(4)?,
                "no_hp": row.get::<_, Option<String>>(5)?,
                "lp": row.get::<_, Option<String>>(6)?,
                "id_shift": row.get::<_, i64>(7)?,
                "status_aktif": row.get::<_, Option<String>>(8)?,
                "tanggal_daftar": row.get::<_, Option<String>>(9)?,
                "catatan": row.get::<_, Option<String>>(10)?,
                "status_qr": row.get::<_, Option<String>>(11)?,
                "jenis_personil": row.get::<_, Option<String>>(12)?,
                "tanggal_mulai_aktif": row.get::<_, Option<String>>(13)?,
                "tanggal_selesai_aktif": row.get::<_, Option<String>>(14)?,
                "status_backup": row.get::<_, Option<String>>(15)?,
                "nama_shift": row.get::<_, Option<String>>(16)?,
                "idcard_status": row.get::<_, Option<String>>(17)?,
                "idcard_pdf_url": row.get::<_, Option<String>>(18)?,
                "link_qr_png": row.get::<_, Option<String>>(19)?,
                "token_absensi": row.get::<_, Option<String>>(20)?,
                "qr_code": row.get::<_, Option<String>>(21)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    let mut result = Vec::new();
    for row in rows {
        let row = row.map_err(|_| CommandError::internal())?;
        let matches_search = search.is_empty()
            || ["id_unik", "kode_karyawan", "nama", "divisi"]
                .iter()
                .any(|key| text(&row, key).to_lowercase().contains(&search));
        let matches_division = division.is_empty() || text(&row, "divisi") == division;
        let matches_status = status.is_empty() || text(&row, "status_aktif") == status;
        if matches_search && matches_division && matches_status {
            result.push(row);
        }
    }
    Ok(Value::Array(result))
}

pub fn create_employee(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let id = text(draft, "id_unik");
    let code = text(draft, "kode_karyawan");
    let name = text(draft, "nama");
    let division = text(draft, "divisi");
    let shift_id = integer(draft, "id_shift", 0);
    if id.is_empty() || code.is_empty() || name.len() < 2 || division.is_empty() || shift_id == 0 {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Data karyawan belum lengkap atau tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let event_id = sync::new_event_id(&client_id, "employee", "create");
    let token = token_from_event(&event_id);
    let qr_code = format!("{id}|{token}");
    let mut connection = storage::database(&state.data_dir)?;
    let today = text(draft, "tanggal_daftar");
    let today = if today.is_empty() {
        connection
            .query_row("SELECT date('now', 'localtime');", [], |row| row.get(0))
            .map_err(|_| CommandError::internal())?
    } else {
        today.to_owned()
    };
    let mut payload = draft.as_object().cloned().unwrap_or_else(Map::new);
    payload.insert("id_unik".into(), Value::String(id.to_string()));
    payload.insert("token_absensi".into(), Value::String(token.clone()));
    payload.insert("qr_code".into(), Value::String(qr_code.clone()));
    payload.insert("status_qr".into(), Value::String("Generated".into()));
    let payload = Value::Object(payload);

    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            r#"
      INSERT INTO master_data (
        id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
        id_shift, status_aktif, tanggal_daftar, catatan, token_absensi, qr_code,
        status_qr, jenis_personil, tanggal_mulai_aktif, tanggal_selesai_aktif,
        status_backup
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Generated', ?, ?, ?, 'NORMAL');
      "#,
            params![
                id,
                code,
                name,
                division,
                text(draft, "jabatan_status"),
                text(draft, "no_hp"),
                text(draft, "lp"),
                shift_id,
                if text(draft, "status_aktif") == "Nonaktif" {
                    "Nonaktif"
                } else {
                    "Aktif"
                },
                today,
                text(draft, "catatan"),
                token,
                qr_code,
                if text(draft, "jenis_personil").is_empty() {
                    "Pegawai"
                } else {
                    text(draft, "jenis_personil")
                },
                if text(draft, "tanggal_mulai_aktif").is_empty() {
                    today.as_str()
                } else {
                    text(draft, "tanggal_mulai_aktif")
                },
                text(draft, "tanggal_selesai_aktif"),
            ],
        )
        .map_err(|error| {
            CommandError::new(
                "OPERATIONAL_CONFLICT",
                format!("Karyawan tidak dapat disimpan: {error}"),
            )
        })?;
    transaction
        .execute(
            r#"
      INSERT INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate)
      SELECT ?, ?, ?, 'Belum', ?
      WHERE NOT EXISTS (SELECT 1 FROM id_card WHERE id_unik = ?);
      "#,
            params![id, name, division, today, id],
        )
        .map_err(|_| CommandError::internal())?;
    let now = storage::now_epoch_seconds();
    transaction
        .execute(
            r#"
      INSERT INTO desktop_sync_outbox (
        event_id, client_id, domain, operation, entity_key, payload_json,
        status, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'employee', 'create', ?, ?, 'pending', 0, ?, ?);
      "#,
            params![event_id, client_id, id, payload.to_string(), now, now],
        )
        .map_err(|_| CommandError::internal())?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_unik": id, "token_absensi": token }))
}

pub fn import_employees(state: &DesktopState, drafts: &[Value]) -> Result<Value, CommandError> {
    if drafts.is_empty() {
        return Ok(json!({ "sukses": true, "berhasil": 0, "dilewati": 0 }));
    }
    if drafts.len() > 500 {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Maksimal 500 karyawan per proses import.",
        ));
    }

    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let today: String = connection
        .query_row("SELECT date('now', 'localtime');", [], |row| row.get(0))
        .map_err(|_| CommandError::internal())?;

    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let mut berhasil = 0_i64;
    let mut dilewati = 0_i64;
    let now = storage::now_epoch_seconds();

    for draft in drafts {
        let id = text(draft, "id_unik");
        let code = text(draft, "kode_karyawan");
        let name = text(draft, "nama");
        let division = text(draft, "divisi");
        let shift_id = integer(draft, "id_shift", 1);

        if id.is_empty()
            || code.is_empty()
            || name.len() < 2
            || division.is_empty()
            || shift_id == 0
        {
            dilewati += 1;
            continue;
        }

        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM master_data WHERE id_unik = ? OR kode_karyawan = ?);",
                params![id, code],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if exists {
            dilewati += 1;
            continue;
        }

        let event_id = sync::new_event_id(&client_id, "employee", "create");
        let token = token_from_event(&event_id);
        let qr_code = format!("{id}|{token}");

        let reg_date = text(draft, "tanggal_daftar");
        let reg_date = if reg_date.is_empty() {
            &today
        } else {
            reg_date
        };

        let start_date = text(draft, "tanggal_mulai_aktif");
        let start_date = if start_date.is_empty() {
            reg_date
        } else {
            start_date
        };

        let mut payload = draft.as_object().cloned().unwrap_or_else(Map::new);
        payload.insert("token_absensi".into(), Value::String(token.clone()));
        payload.insert("qr_code".into(), Value::String(qr_code.clone()));
        let payload = Value::Object(payload);

        let insert_res = transaction.execute(
            r#"
            INSERT INTO master_data (
                id_unik, kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
                id_shift, status_aktif, tanggal_daftar, catatan, token_absensi, qr_code,
                status_qr, jenis_personil, tanggal_mulai_aktif, tanggal_selesai_aktif,
                status_backup
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Generated', ?, ?, ?, 'NORMAL');
            "#,
            params![
                id,
                code,
                name,
                division,
                if text(draft, "jabatan_status").is_empty() {
                    "Staff"
                } else {
                    text(draft, "jabatan_status")
                },
                text(draft, "no_hp"),
                if text(draft, "lp").to_uppercase() == "P" {
                    "P"
                } else {
                    "L"
                },
                shift_id,
                if text(draft, "status_aktif") == "Nonaktif" {
                    "Nonaktif"
                } else {
                    "Aktif"
                },
                reg_date,
                text(draft, "catatan"),
                token,
                qr_code,
                if text(draft, "jenis_personil").is_empty() {
                    "Pegawai"
                } else {
                    text(draft, "jenis_personil")
                },
                start_date,
                text(draft, "tanggal_selesai_aktif"),
            ],
        );

        if insert_res.is_err() {
            dilewati += 1;
            continue;
        }

        let _ = transaction.execute(
            "INSERT INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) SELECT ?, ?, ?, 'Belum', ? WHERE NOT EXISTS (SELECT 1 FROM id_card WHERE id_unik = ?);",
            params![id, name, division, reg_date, id],
        );

        let _ = transaction.execute(
            r#"
            INSERT INTO desktop_sync_outbox (
                event_id, client_id, domain, operation, entity_key, payload_json,
                status, attempt_count, created_at, updated_at
            ) VALUES (?, ?, 'employee', 'create', ?, ?, 'pending', 0, ?, ?);
            "#,
            params![event_id, client_id, id, payload.to_string(), now, now],
        );

        berhasil += 1;
    }

    transaction.commit().map_err(|_| CommandError::internal())?;

    Ok(json!({
        "sukses": true,
        "berhasil": berhasil,
        "dilewati": dilewati,
    }))
}

pub fn update_employee(
    state: &DesktopState,
    id: &str,
    draft: &Value,
) -> Result<Value, CommandError> {
    if id.trim().is_empty() {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "ID karyawan tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let revision = base_revision(&transaction, "employee", id);

    let jenis_personil = if text(draft, "jenis_personil").is_empty() {
        "Pegawai"
    } else {
        text(draft, "jenis_personil")
    };
    let tanggal_mulai_aktif = text(draft, "tanggal_mulai_aktif");
    let tanggal_selesai_aktif = text(draft, "tanggal_selesai_aktif");
    // Tanggal Mulai Masuk (tanggal_daftar) kini bisa dikoreksi manual dari form
    // Edit Karyawan. Kosong berarti "jangan ubah" supaya klien lama yang belum
    // mengirim field ini tidak menghapus tanggal yang sudah tersimpan.
    let tanggal_daftar = text(draft, "tanggal_daftar");

    transaction
        .execute(
            r#"
      UPDATE master_data SET
        kode_karyawan = COALESCE(NULLIF(?, ''), kode_karyawan),
        nama = COALESCE(NULLIF(?, ''), nama),
        divisi = COALESCE(NULLIF(?, ''), divisi),
        jabatan_status = COALESCE(NULLIF(?, ''), jabatan_status),
        no_hp = ?,
        lp = COALESCE(NULLIF(?, ''), lp),
        id_shift = CASE WHEN ? > 0 THEN ? ELSE id_shift END,
        status_aktif = COALESCE(NULLIF(?, ''), status_aktif),
        catatan = ?,
        jenis_personil = ?,
        tanggal_mulai_aktif = ?,
        tanggal_selesai_aktif = ?,
        tanggal_daftar = COALESCE(NULLIF(?, ''), tanggal_daftar)
      WHERE id_unik = ?;
      "#,
            params![
                text(draft, "kode_karyawan"),
                text(draft, "nama"),
                text(draft, "divisi"),
                text(draft, "jabatan_status"),
                text(draft, "no_hp"),
                text(draft, "lp"),
                integer(draft, "id_shift", 0),
                integer(draft, "id_shift", 0),
                text(draft, "status_aktif"),
                text(draft, "catatan"),
                jenis_personil,
                tanggal_mulai_aktif,
                tanggal_selesai_aktif,
                tanggal_daftar,
                id,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    let nama = text(draft, "nama");
    let divisi = text(draft, "divisi");
    transaction
        .execute(
            "UPDATE id_card SET nama = ?, divisi = ? WHERE id_unik = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "UPDATE absensi_harian SET nama = ?, kelas_divisi = ? WHERE id_karyawan = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "UPDATE log_scan SET nama = ?, divisi = ? WHERE id_karyawan = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "UPDATE backup_karyawan SET nama_karyawan_pengganti = ?, divisi_pengganti = ? WHERE id_karyawan_pengganti = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "UPDATE backup_karyawan SET nama_karyawan_asal = ?, divisi_asal = ? WHERE id_karyawan_asal = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "UPDATE koreksi_admin SET nama = ?, divisi = ? WHERE id_karyawan = ?;",
            params![nama, divisi, id],
        )
        .map_err(|_| CommandError::internal())?;

    let mut outbox_payload = draft.clone();
    if !outbox_payload.is_object() {
        outbox_payload = json!({});
    }
    outbox_payload["id_unik"] = json!(id);

    if let Ok(full_row) = transaction.query_row(
        r#"
        SELECT kode_karyawan, nama, divisi, jabatan_status, no_hp, lp,
               id_shift, status_aktif, tanggal_daftar, catatan, token_absensi,
               qr_code, status_qr, jenis_personil, tanggal_mulai_aktif,
               tanggal_selesai_aktif, status_backup
        FROM master_data WHERE id_unik = ? LIMIT 1;
        "#,
        params![id],
        |row| {
            Ok(json!({
                "id_unik": id,
                "kode_karyawan": row.get::<_, Option<String>>(0)?,
                "nama": row.get::<_, Option<String>>(1)?,
                "divisi": row.get::<_, Option<String>>(2)?,
                "jabatan_status": row.get::<_, Option<String>>(3)?,
                "no_hp": row.get::<_, Option<String>>(4)?,
                "lp": row.get::<_, Option<String>>(5)?,
                "id_shift": row.get::<_, Option<i64>>(6)?,
                "status_aktif": row.get::<_, Option<String>>(7)?,
                "tanggal_daftar": row.get::<_, Option<String>>(8)?,
                "catatan": row.get::<_, Option<String>>(9)?,
                "token_absensi": row.get::<_, Option<String>>(10)?,
                "qr_code": row.get::<_, Option<String>>(11)?,
                "status_qr": row.get::<_, Option<String>>(12)?,
                "jenis_personil": row.get::<_, Option<String>>(13)?,
                "tanggal_mulai_aktif": row.get::<_, Option<String>>(14)?,
                "tanggal_selesai_aktif": row.get::<_, Option<String>>(15)?,
                "status_backup": row.get::<_, Option<String>>(16)?,
            }))
        },
    ) {
        outbox_payload = full_row;
    }

    sync::enqueue(
        &transaction,
        &client_id,
        "employee",
        "update",
        id,
        &outbox_payload,
        revision,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn set_employee_status(
    state: &DesktopState,
    id: &str,
    status: &str,
) -> Result<Value, CommandError> {
    if status != "Aktif" && status != "Nonaktif" {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Status karyawan tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let revision = base_revision(&transaction, "employee", id);
    transaction
        .execute(
            "UPDATE master_data SET status_aktif = ? WHERE id_unik = ?;",
            params![status, id],
        )
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        &transaction,
        &client_id,
        "employee",
        "status",
        id,
        &json!({ "status_aktif": status }),
        revision,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn generate_employee_tokens(state: &DesktopState) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let ids = {
        let mut statement = connection
            .prepare(
                "SELECT id_unik FROM master_data WHERE token_absensi IS NULL OR token_absensi = '' OR qr_code IS NULL OR qr_code = '' OR status_qr != 'Generated';",
            )
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| CommandError::internal())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?
    };
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    for id in &ids {
        let event_id = sync::new_event_id(&client_id, "employee", "token");
        let token = token_from_event(&event_id);
        let qr_code = format!("{id}|{token}");
        transaction
            .execute(
                "UPDATE master_data SET token_absensi = ?, qr_code = ?, status_qr = 'Generated' WHERE id_unik = ?;",
                params![token, qr_code, id],
            )
            .map_err(|_| CommandError::internal())?;
        sync::enqueue(
            &transaction,
            &client_id,
            "employee",
            "token",
            id,
            &json!({ "id_unik": id, "token_absensi": token, "qr_code": qr_code, "status_qr": "Generated" }),
            base_revision(&transaction, "employee", id),
        )?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "total_generated": ids.len() }))
}

pub fn list_shifts(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare("SELECT * FROM tbl_shift ORDER BY kode_shift ASC;")
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id_shift": row.get::<_, i64>(0)?,
                "kode_shift": row.get::<_, i64>(1)?,
                "nama_shift": row.get::<_, String>(2)?,
                "jam_masuk": row.get::<_, String>(3)?,
                "jam_pulang": row.get::<_, String>(4)?,
                "awal_absen_menit": row.get::<_, i64>(5)?,
                "batas_masuk_menit": row.get::<_, i64>(6)?,
                "toleransi_masuk_menit": row.get::<_, i64>(7)?,
                "jam_kerja_normal_menit": row.get::<_, i64>(8)?,
                "istirahat_menit": row.get::<_, i64>(9)?,
                "batas_pulang_menit": row.get::<_, i64>(10)?,
                "offset_istirahat_mulai": row.get::<_, i64>(11)?,
                "offset_generate_alfa": row.get::<_, i64>(12)?,
                "buffer_shift_malam_menit": row.get::<_, i64>(13)?,
                "izinkan_multi_sesi": row.get::<_, Option<i64>>(14)?.unwrap_or(0),
                "shift_lanjutan_id": row.get::<_, Option<i64>>(15)?.unwrap_or(0),
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

pub fn create_shift(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    validate_shift(draft)?;
    let client_id = sync::ensure_client_id(state)?;
    let local_id = sync::new_local_id();
    let entity_key = format!("kode:{}", integer(draft, "kode_shift", 0));
    let mut payload = draft.as_object().cloned().unwrap_or_else(Map::new);
    payload.insert("local_id_shift".into(), Value::from(local_id));
    let payload = Value::Object(payload);
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    insert_shift(&transaction, local_id, draft)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "shift",
        "create",
        &entity_key,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_shift": local_id }))
}

fn validate_shift(draft: &Value) -> Result<(), CommandError> {
    if integer(draft, "kode_shift", 0) < 1
        || text(draft, "nama_shift").len() < 2
        || text(draft, "jam_masuk").len() != 5
        || text(draft, "jam_pulang").len() != 5
    {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Konfigurasi shift belum lengkap atau tidak valid.",
        ));
    }
    Ok(())
}

fn insert_shift(
    transaction: &rusqlite::Transaction<'_>,
    id: i64,
    draft: &Value,
) -> Result<(), CommandError> {
    let start = text(draft, "jam_masuk");
    let end = text(draft, "jam_pulang");
    let early = integer(draft, "awal_absen_menit", 120);
    let ontime = integer(draft, "batas_masuk_menit", 60);
    let late_tolerance = integer(draft, "toleransi_masuk_menit", 0);
    let break_min = integer(draft, "istirahat_menit", 60);
    let normal_work = if draft.get("jam_kerja_normal_menit").is_some()
        && integer(draft, "jam_kerja_normal_menit", 0) > 0
    {
        integer(draft, "jam_kerja_normal_menit", 0)
    } else {
        super::time_policy::calculate_normal_work_minutes(start, end, break_min)
    };
    let checkout_limit = integer(draft, "batas_pulang_menit", 240);
    let break_offset = integer(draft, "offset_istirahat_mulai", 240);
    let alfa_offset = integer(draft, "offset_generate_alfa", 180);
    let night_buffer = integer(draft, "buffer_shift_malam_menit", 120);
    let multi_session = if draft
        .get("izinkan_multi_sesi")
        .map(|v| {
            v.as_bool().unwrap_or(false)
                || v.as_i64().unwrap_or(0) == 1
                || v.as_str()
                    .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        1
    } else {
        0
    };
    // Shift tujuan sesi lanjutan. Hanya bermakna saat multi-sesi menyala;
    // 0 berarti belum ditentukan sehingga scanner kembali ke pencocokan
    // jendela otomatis seperti perilaku lama.
    let continuation_shift = if multi_session == 1 {
        integer(draft, "shift_lanjutan_id", 0).max(0)
    } else {
        0
    };

    transaction
        .execute(
            r#"
      INSERT INTO tbl_shift (
        id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
        awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
        jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
        offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
        izinkan_multi_sesi, shift_lanjutan_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      "#,
            params![
                id,
                integer(draft, "kode_shift", 0),
                text(draft, "nama_shift"),
                start,
                end,
                early,
                ontime,
                late_tolerance,
                normal_work,
                break_min,
                checkout_limit,
                break_offset,
                alfa_offset,
                night_buffer,
                multi_session,
                continuation_shift,
            ],
        )
        .map_err(|error| {
            CommandError::new(
                "OPERATIONAL_CONFLICT",
                format!("Shift tidak dapat disimpan: {error}"),
            )
        })?;
    Ok(())
}

pub fn update_shift(state: &DesktopState, id: i64, draft: &Value) -> Result<Value, CommandError> {
    validate_shift(draft)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let revision = base_revision(&transaction, "shift", &id.to_string());

    let start = text(draft, "jam_masuk");
    let end = text(draft, "jam_pulang");
    let early = integer(draft, "awal_absen_menit", 120);
    let ontime = integer(draft, "batas_masuk_menit", 60);
    let late_tolerance = integer(draft, "toleransi_masuk_menit", 0);
    let break_min = integer(draft, "istirahat_menit", 60);
    let normal_work = if draft.get("jam_kerja_normal_menit").is_some()
        && integer(draft, "jam_kerja_normal_menit", 0) > 0
    {
        integer(draft, "jam_kerja_normal_menit", 0)
    } else {
        super::time_policy::calculate_normal_work_minutes(start, end, break_min)
    };
    let checkout_limit = integer(draft, "batas_pulang_menit", 240);
    let break_offset = integer(draft, "offset_istirahat_mulai", 240);
    let alfa_offset = integer(draft, "offset_generate_alfa", 180);
    let night_buffer = integer(draft, "buffer_shift_malam_menit", 120);
    let multi_session = if draft
        .get("izinkan_multi_sesi")
        .map(|v| {
            v.as_bool().unwrap_or(false)
                || v.as_i64().unwrap_or(0) == 1
                || v.as_str()
                    .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        1
    } else {
        0
    };
    // Shift tujuan sesi lanjutan. Hanya bermakna saat multi-sesi menyala;
    // 0 berarti belum ditentukan sehingga scanner kembali ke pencocokan
    // jendela otomatis seperti perilaku lama.
    let continuation_shift = if multi_session == 1 {
        integer(draft, "shift_lanjutan_id", 0).max(0)
    } else {
        0
    };

    transaction
        .execute(
            r#"
      UPDATE tbl_shift SET 
        nama_shift = ?, jam_masuk = ?, jam_pulang = ?,
        awal_absen_menit = ?, batas_masuk_menit = ?, toleransi_masuk_menit = ?,
        jam_kerja_normal_menit = ?, istirahat_menit = ?, batas_pulang_menit = ?,
        offset_istirahat_mulai = ?, offset_generate_alfa = ?, buffer_shift_malam_menit = ?,
        izinkan_multi_sesi = ?, shift_lanjutan_id = ?
      WHERE id_shift = ?;
      "#,
            params![
                text(draft, "nama_shift"),
                start,
                end,
                early,
                ontime,
                late_tolerance,
                normal_work,
                break_min,
                checkout_limit,
                break_offset,
                alfa_offset,
                night_buffer,
                multi_session,
                continuation_shift,
                id,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    let full_shift: Value = transaction
        .query_row(
            r#"
        SELECT id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
               awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
               jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
               offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
               izinkan_multi_sesi, shift_lanjutan_id
        FROM tbl_shift WHERE id_shift = ?;
        "#,
            [id],
            |row| {
                Ok(json!({
                    "id_shift": row.get::<_, i64>(0)?,
                    "kode_shift": row.get::<_, i64>(1)?,
                    "nama_shift": row.get::<_, String>(2)?,
                    "jam_masuk": row.get::<_, String>(3)?,
                    "jam_pulang": row.get::<_, String>(4)?,
                    "awal_absen_menit": row.get::<_, i64>(5)?,
                    "batas_masuk_menit": row.get::<_, i64>(6)?,
                    "toleransi_masuk_menit": row.get::<_, i64>(7)?,
                    "jam_kerja_normal_menit": row.get::<_, i64>(8)?,
                    "istirahat_menit": row.get::<_, i64>(9)?,
                    "batas_pulang_menit": row.get::<_, i64>(10)?,
                    "offset_istirahat_mulai": row.get::<_, i64>(11)?,
                    "offset_generate_alfa": row.get::<_, i64>(12)?,
                    "buffer_shift_malam_menit": row.get::<_, i64>(13)?,
                    "izinkan_multi_sesi": row.get::<_, i64>(14)?,
                    "shift_lanjutan_id": row.get::<_, Option<i64>>(15)?.unwrap_or(0),
                }))
            },
        )
        .unwrap_or_else(|_| draft.clone());

    sync::enqueue(
        &transaction,
        &client_id,
        "shift",
        "update",
        &id.to_string(),
        &full_shift,
        revision,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn delete_shift(state: &DesktopState, id: i64) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let used: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM master_data WHERE id_shift = ?;",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if used > 0 {
        return Ok(json!({
            "sukses": false,
            "pesan": "Gagal menghapus shift: Shift ini sedang digunakan oleh karyawan."
        }));
    }
    let revision = base_revision(&transaction, "shift", &id.to_string());
    transaction
        .execute("DELETE FROM tbl_shift WHERE id_shift = ?;", [id])
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        &transaction,
        &client_id,
        "shift",
        "delete",
        &id.to_string(),
        &json!({ "id_shift": id }),
        revision,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn list_id_cards(state: &DesktopState, filter: &Value) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection.prepare(
        // `jabatan_status` WAJIB ikut: halaman ID Card mengirim baris ini
        // langsung ke renderer kartu, dan tanpa kolom itu setiap kartu yang
        // dicetak dari sana berjabatan bawaan "Staff". Sama dengan
        // `getDaftarIdCard` di `lib/services/idcard.ts`.
        "SELECT c.id_card_id, m.id_unik, m.nama, m.divisi, COALESCE(c.idcard_status, 'Belum'), c.idcard_pdf_url, c.idcard_last_generate, c.idcard_catatan, c.tanggal_generate, c.link_qr_png, m.kode_karyawan, m.status_aktif, m.token_absensi, m.qr_code, m.jabatan_status FROM master_data m LEFT JOIN id_card c ON c.id_unik = m.id_unik ORDER BY m.nama;"
    ).map_err(|_| CommandError::internal())?;
    let search = text(filter, "search").to_lowercase();
    let status = text(filter, "status");
    let rows = statement.query_map([], |row| Ok(json!({
        "id_card_id": row.get::<_, Option<i64>>(0)?, "id_unik": row.get::<_, String>(1)?,
        "nama": row.get::<_, String>(2)?, "divisi": row.get::<_, String>(3)?,
        "idcard_status": row.get::<_, Option<String>>(4)?, "idcard_pdf_url": row.get::<_, Option<String>>(5)?,
        "idcard_last_generate": row.get::<_, Option<String>>(6)?, "idcard_catatan": row.get::<_, Option<String>>(7)?,
        "tanggal_generate": row.get::<_, Option<String>>(8)?, "link_qr_png": row.get::<_, Option<String>>(9)?,
        "kode_karyawan": row.get::<_, Option<String>>(10)?, "status_aktif": row.get::<_, Option<String>>(11)?,
        "token_absensi": row.get::<_, Option<String>>(12)?, "qr_code": row.get::<_, Option<String>>(13)?,
        "jabatan_status": row.get::<_, Option<String>>(14)?,
    }))).map_err(|_| CommandError::internal())?;
    let values = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?
        .into_iter()
        .filter(|row| {
            (status.is_empty() || text(row, "idcard_status") == status)
                && (search.is_empty()
                    || ["id_unik", "nama", "divisi"]
                        .iter()
                        .any(|key| text(row, key).to_lowercase().contains(&search)))
        })
        .collect();
    Ok(Value::Array(values))
}

pub fn get_geofence_settings(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM setting_gex_system WHERE key IN ('geofence_enabled','lat_kantor','lng_kantor','radius_meter');",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| CommandError::internal())?;
    let mut values = std::collections::HashMap::<String, String>::new();
    for row in rows {
        let (key, value) = row.map_err(|_| CommandError::internal())?;
        values.insert(key, value);
    }
    let latitude = values
        .get("lat_kantor")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let longitude = values
        .get("lng_kantor")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let enabled = values
        .get("geofence_enabled")
        .map(|value| value == "true")
        .unwrap_or(latitude != 0.0 || longitude != 0.0);
    let radius = values
        .get("radius_meter")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(100);
    Ok(json!({
        "enabled": enabled,
        "latitude": latitude,
        "longitude": longitude,
        "radiusMeter": radius,
    }))
}

pub fn save_geofence_settings(state: &DesktopState, settings: &Value) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let enabled = settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let latitude = settings
        .get("latitude")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let longitude = settings
        .get("longitude")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let radius = settings
        .get("radiusMeter")
        .and_then(Value::as_i64)
        .unwrap_or(100);
    for (key, value) in [
        ("geofence_enabled", enabled.to_string()),
        ("lat_kantor", latitude.to_string()),
        ("lng_kantor", longitude.to_string()),
        ("radius_meter", radius.to_string()),
    ] {
        transaction
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![key, value],
            )
            .map_err(|_| CommandError::internal())?;

        // Bersihkan konflik & antrean outbox stale untuk key ini
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = ?;",
            params![key],
        );
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict');",
            params![key],
        );

        // Enqueue secara otoritatif (base_revision: None) agar langsung disinkronkan ke cloud
        sync::enqueue(
            &transaction,
            &client_id,
            "setting",
            "update",
            key,
            &json!({ "key": key, "value": value }),
            None,
        )?;
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

/// Pengaturan keamanan absensi: sakelar induk fitur + daftar IP.
///
/// `can_manage` menentukan apakah daftar IP ikut dikembalikan. Status hidup/mati
/// fiturnya boleh dibaca siapa saja yang punya sesi — halaman scanner perlu
/// tahu apakah harus menahan scan untuk foto — sedangkan daftar alamatnya hanya
/// untuk Superadmin.
pub fn get_scan_security(
    state: &DesktopState,
    can_manage: bool,
    role_requires_photo: bool,
    role_requires_ip: bool,
) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let read = |key: &str| -> Result<Option<String>, CommandError> {
        connection
            .query_row(
                "SELECT value FROM setting_gex_system WHERE key = ?;",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| CommandError::internal())
    };
    let enabled = |value: Option<String>| {
        value
            .map(|item| item.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    };

    let entries = if can_manage {
        read(scanner::IP_ALLOWLIST_SETTING_KEY)?
            .as_deref()
            .map(scanner::parse_ip_allowlist)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let device_addresses = if can_manage {
        scanner::detect_device_ip_addresses()
            .iter()
            .map(std::net::IpAddr::to_string)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let photo_enabled = enabled(read(scanner::SCAN_PHOTO_ENABLED_KEY)?);
    let ip_enabled = enabled(read(scanner::SCAN_IP_RESTRICTION_ENABLED_KEY)?);
    Ok(json!({
        "photoEnabled": photo_enabled,
        "ipRestrictionEnabled": ip_enabled,
        // Jawaban tunggal untuk halaman scanner: "apakah SAYA wajib berfoto?".
        // Dihitung di sini supaya tidak ada penggabungan kedua di frontend yang
        // bisa memakai salinan sesi yang sudah basi.
        "photoRequiredForMe": photo_enabled && role_requires_photo,
        "ipRestrictionRequiredForMe": ip_enabled && role_requires_ip,
        "entries": entries,
        "deviceAddresses": device_addresses,
        "canManage": can_manage,
    }))
}

/// Simpan sakelar induk dan daftar IP sebagai setting tersinkronisasi.
///
/// Entri IP dinormalisasi lebih dulu; entri tidak valid dibuang di sini agar
/// tidak ada daftar berisi teks sampah yang diam-diam memblokir semua orang.
pub fn save_scan_security(state: &DesktopState, payload: &Value) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut entries: Vec<String> = Vec::new();
    if let Some(items) = payload.get("entries").and_then(Value::as_array) {
        for item in items {
            if let Some(entry) = item.as_str().and_then(scanner::normalize_ip_entry) {
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
        }
    }
    let allowlist_value = serde_json::to_string(&entries).map_err(|_| CommandError::internal())?;
    let flag = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_bool)
            .map(|value| if value { "true" } else { "false" })
            .unwrap_or("false")
            .to_owned()
    };

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    for (key, value) in [
        (
            scanner::SCAN_PHOTO_ENABLED_KEY,
            flag("photoEnabled"),
        ),
        (
            scanner::SCAN_IP_RESTRICTION_ENABLED_KEY,
            flag("ipRestrictionEnabled"),
        ),
        (scanner::IP_ALLOWLIST_SETTING_KEY, allowlist_value),
    ] {
        transaction
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![key, value],
            )
            .map_err(|_| CommandError::internal())?;
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = ?;",
            params![key],
        );
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict');",
            params![key],
        );
        sync::enqueue(
            &transaction,
            &client_id,
            "setting",
            "update",
            key,
            &json!({ "key": key, "value": value }),
            None,
        )?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    // Yang menyimpan pasti Superadmin; sakelar role-nya sendiri tidak relevan
    // untuk balasan formulir.
    get_scan_security(state, true, false, false)
}

pub fn get_scanner_settings(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM setting_gex_system WHERE key IN ('anti_double_scan_seconds','batas_multi_scan_menit');",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| CommandError::internal())?;
    let mut values = std::collections::HashMap::<String, String>::new();
    for row in rows {
        let (key, value) = row.map_err(|_| CommandError::internal())?;
        values.insert(key, value);
    }
    let anti_double_scan = values
        .get("anti_double_scan_seconds")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(60);
    let multi_scan = values
        .get("batas_multi_scan_menit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(5);
    Ok(json!({
        "antiDoubleScanSeconds": anti_double_scan.max(0),
        "batasMultiScanMenit": multi_scan.max(0),
    }))
}

pub fn save_scanner_settings(state: &DesktopState, settings: &Value) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let anti_double_scan = settings
        .get("antiDoubleScanSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(60)
        .max(0);
    let multi_scan = settings
        .get("batasMultiScanMenit")
        .and_then(Value::as_i64)
        .unwrap_or(5)
        .max(0);
    for (key, value) in [
        ("anti_double_scan_seconds", anti_double_scan.to_string()),
        ("batas_multi_scan_menit", multi_scan.to_string()),
    ] {
        transaction
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![key, value],
            )
            .map_err(|_| CommandError::internal())?;

        // Bersihkan konflik & antrean outbox stale untuk key ini
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = ?;",
            params![key],
        );
        let _ = transaction.execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict');",
            params![key],
        );

        // Enqueue secara otoritatif (base_revision: None) agar langsung disinkronkan ke cloud
        sync::enqueue(
            &transaction,
            &client_id,
            "setting",
            "update",
            key,
            &json!({ "key": key, "value": value }),
            None,
        )?;
    }
    transaction.commit().map_err(|_| CommandError::internal())
}

pub fn get_app_display_name(state: &DesktopState) -> Result<String, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let result: Option<String> = connection
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = 'app_display_name' LIMIT 1;",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    Ok(result
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Absensi Perusahaan".to_string()))
}

pub fn save_app_display_name(state: &DesktopState, name: &str) -> Result<String, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let resolved = if name.trim().is_empty() {
        "Absensi Perusahaan".to_string()
    } else {
        name.trim().to_string()
    };

    transaction
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES ('app_display_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![resolved],
        )
        .map_err(|_| CommandError::internal())?;

    let _ = transaction.execute(
        "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = 'app_display_name';",
        [],
    );
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = 'app_display_name' AND status IN ('pending', 'failed', 'conflict');",
        [],
    );

    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "update",
        "app_display_name",
        &json!({ "key": "app_display_name", "value": resolved }),
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(resolved)
}

pub fn update_id_card(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let id = text(draft, "id_unik");
    let status = text(draft, "idcard_status");
    if id.is_empty() || !["Belum", "Berhasil", "Gagal"].contains(&status) {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Status ID Card tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','localtime');",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    let today = &now[..10];
    transaction
        .execute(
            "INSERT INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) SELECT id_unik, nama, divisi, 'Belum', ? FROM master_data WHERE id_unik = ? AND NOT EXISTS (SELECT 1 FROM id_card WHERE id_unik = master_data.id_unik);",
            params![today, id],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = json!({ "id_unik": id, "idcard_status": status,
        "tanggal_generate": today, "idcard_last_generate": now,
        "idcard_pdf_url": text(draft, "idcard_pdf_url"), "link_qr_png": text(draft, "link_qr_png"),
        "idcard_catatan": text(draft, "idcard_catatan") });
    let changed = transaction.execute("UPDATE id_card SET idcard_status = ?, tanggal_generate = ?, idcard_last_generate = ?, idcard_pdf_url = ?, link_qr_png = ?, idcard_catatan = ? WHERE id_unik = ?;", params![status, today, now, text(draft, "idcard_pdf_url"), text(draft, "link_qr_png"), text(draft, "idcard_catatan"), id]).map_err(|_| CommandError::internal())?;
    if changed == 0 {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "ID Card karyawan tidak ditemukan.",
        ));
    }
    sync::enqueue(
        &transaction,
        &client_id,
        "id-card",
        "update",
        id,
        &payload,
        base_revision(&transaction, "id-card", id),
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let clean = if let Some(idx) = input.find(";base64,") {
        &input[idx + 8..]
    } else if let Some(idx) = input.find(',') {
        &input[idx + 1..]
    } else {
        input.trim()
    };
    let clean: String = clean.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64_STANDARD.decode(&clean).ok()
}

/// Folder yang benar-benar bisa dijangkau pengguna, berurutan menurut prioritas.
///
/// Dipisahkan dari [`save_desktop_file`] supaya ekspor cadangan database memakai
/// daftar yang SAMA. Kalau daftarnya diduplikasi, satu sisi cepat atau lambat
/// akan menyimpan berkas ke tempat yang tidak dicari sisi lain.
///
/// TIDAK ADA direktori sementara di sini. Di Android `std::env::temp_dir()`
/// adalah folder privat aplikasi: ketika penulisan ke `/storage/emulated/0/Download`
/// ditolak — dan sejak Android 10 penolakan itu lazim, karena manifest membatasi
/// WRITE_EXTERNAL_STORAGE pada maxSdkVersion 28 — berkasnya tetap tertulis,
/// pemanggil melaporkan sukses, dan pengguna tidak pernah menemukan hasilnya.
/// Kegagalan yang dilaporkan sebagai keberhasilan jauh lebih buruk daripada
/// kegagalan yang terlihat.
pub fn public_output_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    // 1. Direktori publik Android
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/Download"));
    dirs.push(std::path::PathBuf::from("/sdcard/Download"));
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/Pictures"));
    dirs.push(std::path::PathBuf::from("/storage/emulated/0/DCIM"));

    // 2. Folder Unduhan standar Windows / Linux / macOS
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        dirs.push(std::path::PathBuf::from(user_profile).join("Downloads"));
    }
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(std::path::PathBuf::from(home).join("Downloads"));
    }

    dirs
}

/// Salin sebuah berkas ke folder pertama yang benar-benar bisa ditulisi.
///
/// `None` berarti tidak ada satu pun folder publik yang menerima tulisan —
/// keadaan nyata pada Android 10, dan pemanggil WAJIB menyampaikannya apa adanya
/// alih-alih berpura-pura berhasil.
pub fn copy_to_public_dir(source: &std::path::Path, file_name: &str) -> Option<std::path::PathBuf> {
    let sanitized = file_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    for dir in public_output_dirs() {
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
        let target = dir.join(&sanitized);
        if std::fs::copy(source, &target).is_ok() {
            return Some(target);
        }
    }
    None
}

pub fn save_desktop_file(filename: &str, base64_data: &str) -> Result<Value, CommandError> {
    let bytes = decode_base64(base64_data).ok_or_else(|| {
        CommandError::new("DESKTOP_SAVE_FAILED", "Format base64 file tidak valid.")
    })?;

    let sanitized_filename = filename.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");

    let mut last_error = String::new();
    for dir in public_output_dirs() {
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
        let target_path = dir.join(&sanitized_filename);
        match std::fs::write(&target_path, &bytes) {
            Ok(_) => {
                return Ok(json!({
                    "sukses": true,
                    "path": target_path.to_string_lossy().to_string(),
                    "filename": sanitized_filename
                }));
            }
            Err(e) => {
                last_error = e.to_string();
            }
        }
    }

    Err(CommandError::new(
        "DESKTOP_SAVE_FAILED",
        &format!(
            "Berkas tidak dapat disimpan ke folder Unduhan perangkat: {last_error}. Pada Android 10 ke atas, gunakan tombol Bagikan untuk memilih sendiri tujuan penyimpanannya."
        ),
    ))
}

pub fn list_holidays(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id_libur, tanggal, nama_libur, COALESCE(jenis_libur, 'Libur Nasional'), keterangan, status_aktif
             FROM tbl_hari_libur ORDER BY tanggal DESC;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id_libur": row.get::<_, i64>(0)?,
                "tanggal": row.get::<_, String>(1)?,
                "nama_libur": row.get::<_, String>(2)?,
                "jenis_libur": row.get::<_, String>(3)?,
                "keterangan": row.get::<_, Option<String>>(4)?,
                "status_aktif": row.get::<_, Option<i64>>(5)?.unwrap_or(1),
            }))
        })
        .map_err(|_| CommandError::internal())?;
    Ok(Value::Array(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| CommandError::internal())?,
    ))
}

pub fn create_holiday(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let tanggal = text(draft, "tanggal");
    let nama_libur = text(draft, "nama_libur");
    if tanggal.is_empty() || nama_libur.is_empty() {
        return Err(CommandError::new(
            "VALIDATION_ERROR",
            "Tanggal dan nama hari libur wajib diisi.",
        ));
    }
    let jenis_libur =
        if draft.get("jenis_libur").is_some() && !text(draft, "jenis_libur").is_empty() {
            text(draft, "jenis_libur")
        } else {
            "Libur Nasional"
        };
    let keterangan = draft.get("keterangan").and_then(Value::as_str);
    let status_aktif = if draft
        .get("status_aktif")
        .map(|v| v.as_bool().unwrap_or(true) && v.as_i64().unwrap_or(1) == 1)
        .unwrap_or(true)
    {
        1
    } else {
        0
    };

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let existing: bool = transaction
        .query_row(
            "SELECT 1 FROM tbl_hari_libur WHERE tanggal = ? LIMIT 1;",
            [&tanggal],
            |_| Ok(true),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .unwrap_or(false);
    if existing {
        return Err(CommandError::new(
            "OPERATIONAL_CONFLICT",
            format!(
                "Tanggal libur {tanggal} sudah terdaftar. Silakan edit jika ingin mengubahnya."
            ),
        ));
    }

    transaction
        .execute(
            "INSERT INTO tbl_hari_libur (tanggal, nama_libur, jenis_libur, keterangan, status_aktif) VALUES (?, ?, ?, ?, ?);",
            params![tanggal, nama_libur, jenis_libur, keterangan, status_aktif],
        )
        .map_err(|e| CommandError::new("OPERATIONAL_CONFLICT", format!("Gagal menyimpan hari libur: {e}")))?;

    let id_libur = transaction.last_insert_rowid();

    let sync_payload = json!({
        "id_libur": id_libur,
        "tanggal": tanggal,
        "nama_libur": nama_libur,
        "jenis_libur": jenis_libur,
        "keterangan": keterangan,
        "status_aktif": status_aktif,
    });
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday",
        "create",
        &id_libur.to_string(),
        &sync_payload,
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_libur": id_libur }))
}

pub fn update_holiday(state: &DesktopState, id: i64, draft: &Value) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let tanggal = text(draft, "tanggal");
    let nama_libur = text(draft, "nama_libur");
    let jenis_libur =
        if draft.get("jenis_libur").is_some() && !text(draft, "jenis_libur").is_empty() {
            text(draft, "jenis_libur")
        } else {
            "Libur Nasional"
        };
    let keterangan = draft.get("keterangan").and_then(Value::as_str);
    let status_aktif = if draft
        .get("status_aktif")
        .map(|v| v.as_bool().unwrap_or(true) && v.as_i64().unwrap_or(1) == 1)
        .unwrap_or(true)
    {
        1
    } else {
        0
    };

    transaction
        .execute(
            "UPDATE tbl_hari_libur SET tanggal = ?, nama_libur = ?, jenis_libur = ?, keterangan = ?, status_aktif = ? WHERE id_libur = ?;",
            params![tanggal, nama_libur, jenis_libur, keterangan, status_aktif, id],
        )
        .map_err(|_| CommandError::internal())?;

    let sync_payload = json!({
        "id_libur": id,
        "tanggal": tanggal,
        "nama_libur": nama_libur,
        "jenis_libur": jenis_libur,
        "keterangan": keterangan,
        "status_aktif": status_aktif,
    });
    let revision = base_revision(&transaction, "holiday", &id.to_string());
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday",
        "update",
        &id.to_string(),
        &sync_payload,
        revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn delete_holiday(state: &DesktopState, id: i64) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let holiday_data: Option<(String, String)> = transaction
        .query_row(
            "SELECT tanggal, nama_libur FROM tbl_hari_libur WHERE id_libur = ? LIMIT 1;",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let (tanggal, nama_libur) = match holiday_data {
        Some(d) => d,
        None => return Ok(json!({ "sukses": true })),
    };

    transaction
        .execute("DELETE FROM tbl_hari_libur WHERE id_libur = ?;", [id])
        .map_err(|_| CommandError::internal())?;

    let sync_payload = json!({
        "id_libur": id,
        "tanggal": tanggal,
        "nama_libur": nama_libur,
    });
    let revision = base_revision(&transaction, "holiday", &id.to_string());
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday",
        "delete",
        &id.to_string(),
        &sync_payload,
        revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Whitelist Shift/Divisi hari libur.
//
// Penilaian dan normalisasinya hidup di `scanner.rs` (bersama gerbang scan yang
// memakainya) supaya jalur pengelolaan dan jalur penegakan tidak pernah drift.
// Di sini hanya CRUD lokal + antrean outbox.
// ─────────────────────────────────────────────────────────────────────────────

/// Id whitelist dibuat KLIEN, bukan AUTOINCREMENT.
///
/// Dua perangkat yang sedang offline sama-sama boleh menambah baris; kalau
/// kuncinya nomor urut, keduanya memakai angka yang sama lalu saling menimpa
/// begitu tersinkronisasi. 128 bit acak membuat keduanya hidup berdampingan.
fn new_whitelist_id() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let mut id = String::with_capacity(36);
    id.push_str("hlw-");
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

/// Baca satu baris whitelist sebagai JSON siap kirim.
fn whitelist_row_json(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<Option<Value>, CommandError> {
    transaction
        .query_row(
            "SELECT id, scope_type, scope_value, tanggal_libur, keterangan, status_aktif,
                    created_at, updated_at
             FROM hari_libur_whitelist WHERE id = ? LIMIT 1;",
            [id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "scope_type": row.get::<_, String>(1)?,
                    "scope_value": row.get::<_, String>(2)?,
                    "tanggal_libur": row.get::<_, Option<String>>(3)?,
                    "keterangan": row.get::<_, Option<String>>(4)?,
                    "status_aktif": row.get::<_, i64>(5)?,
                    "created_at": row.get::<_, Option<String>>(6)?,
                    "updated_at": row.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

pub fn list_holiday_whitelist(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT id, scope_type, scope_value, tanggal_libur, keterangan, status_aktif
             FROM hari_libur_whitelist ORDER BY scope_type ASC, scope_value ASC;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "scope_type": row.get::<_, String>(1)?,
                "scope_value": row.get::<_, String>(2)?,
                "tanggal_libur": row.get::<_, Option<String>>(3)?,
                "keterangan": row.get::<_, Option<String>>(4)?,
                "status_aktif": row.get::<_, i64>(5)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|_| CommandError::internal())?);
    }
    Ok(Value::Array(result))
}

/// Bentuk kanonik satu draft whitelist, atau pesan kesalahan yang ramah.
fn normalize_whitelist_draft(
    draft: &Value,
) -> Result<(&'static str, String, Option<String>, Option<String>, i64), CommandError> {
    let scope_type = scanner::normalize_whitelist_scope_type(&text(draft, "scope_type"))
        .ok_or_else(|| {
            CommandError::new(
                "VALIDATION_ERROR",
                "Cakupan whitelist harus SHIFT atau DIVISI.",
            )
        })?;
    let scope_value =
        scanner::normalize_whitelist_scope_value(scope_type, &text(draft, "scope_value"))
            .ok_or_else(|| {
                CommandError::new(
                    "VALIDATION_ERROR",
                    if scope_type == "SHIFT" {
                        "Kode Shift harus berupa angka positif."
                    } else {
                        "Nama Divisi wajib diisi."
                    },
                )
            })?;

    let raw_date = text(draft, "tanggal_libur");
    let tanggal_libur = if raw_date.trim().is_empty() {
        None
    } else {
        match scanner::normalize_holiday_date(Some(raw_date)) {
            Some(value) => Some(value),
            None => {
                return Err(CommandError::new(
                    "VALIDATION_ERROR",
                    "Tanggal libur harus berformat YYYY-MM-DD.",
                ))
            }
        }
    };

    let keterangan = {
        let value = text(draft, "keterangan");
        if value.trim().is_empty() {
            None
        } else {
            Some(value.trim().to_owned())
        }
    };

    let status_aktif = match draft.get("status_aktif") {
        Some(Value::Bool(false)) => 0,
        Some(value) if value.as_i64() == Some(0) => 0,
        _ => 1,
    };

    Ok((
        scope_type,
        scope_value,
        tanggal_libur,
        keterangan,
        status_aktif,
    ))
}

/// Cegah cakupan kembar DI LAPISAN APLIKASI, bukan lewat UNIQUE constraint.
///
/// Constraint database akan membuat push sync gagal PERMANEN ketika dua
/// perangkat offline mendaftarkan cakupan yang sama. Di sini penolakannya cukup
/// memberi pesan ramah, dan duplikat yang terlanjur lolos dari jalur offline
/// tetap tidak berbahaya karena penilaian whitelist bersifat OR.
fn assert_whitelist_unique(
    transaction: &Transaction<'_>,
    scope_type: &str,
    scope_value: &str,
    tanggal_libur: Option<&str>,
    except_id: Option<&str>,
) -> Result<(), CommandError> {
    let mut statement = transaction
        .prepare(
            "SELECT id, scope_value, tanggal_libur FROM hari_libur_whitelist WHERE scope_type = ?;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([scope_type], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;

    let target = scanner::fold_whitelist_text(scope_value);
    let target_date = tanggal_libur.and_then(|value| scanner::normalize_holiday_date(Some(value)));
    for row in rows {
        let (id, value, date) = row.map_err(|_| CommandError::internal())?;
        if except_id == Some(id.as_str()) {
            continue;
        }
        let row_date = scanner::normalize_holiday_date(date.as_deref());
        if scanner::fold_whitelist_text(&value) == target && row_date == target_date {
            return Err(CommandError::new(
                "OPERATIONAL_CONFLICT",
                format!("Cakupan {scope_type} {scope_value} sudah terdaftar pada whitelist."),
            ));
        }
    }
    Ok(())
}

pub fn create_holiday_whitelist(
    state: &DesktopState,
    draft: &Value,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let (scope_type, scope_value, tanggal_libur, keterangan, status_aktif) =
        normalize_whitelist_draft(draft)?;

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    assert_whitelist_unique(
        &transaction,
        scope_type,
        &scope_value,
        tanggal_libur.as_deref(),
        None,
    )?;

    let id = new_whitelist_id();
    let now: String = transaction
        .query_row("SELECT datetime('now');", [], |row| row.get(0))
        .unwrap_or_default();

    transaction
        .execute(
            "INSERT INTO hari_libur_whitelist (
                id, scope_type, scope_value, tanggal_libur, keterangan,
                status_aktif, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
            params![
                id,
                scope_type,
                scope_value,
                tanggal_libur,
                keterangan,
                status_aktif,
                now,
                now
            ],
        )
        .map_err(|e| {
            CommandError::new(
                "OPERATIONAL_CONFLICT",
                format!("Gagal menyimpan whitelist hari libur: {e}"),
            )
        })?;

    let payload = whitelist_row_json(&transaction, &id)?.unwrap_or_else(|| json!({ "id": id }));
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday-whitelist",
        "create",
        &id,
        &payload,
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id": id }))
}

pub fn update_holiday_whitelist(
    state: &DesktopState,
    id: &str,
    draft: &Value,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let (scope_type, scope_value, tanggal_libur, keterangan, status_aktif) =
        normalize_whitelist_draft(draft)?;

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    assert_whitelist_unique(
        &transaction,
        scope_type,
        &scope_value,
        tanggal_libur.as_deref(),
        Some(id),
    )?;

    let now: String = transaction
        .query_row("SELECT datetime('now');", [], |row| row.get(0))
        .unwrap_or_default();

    transaction
        .execute(
            "UPDATE hari_libur_whitelist SET
                scope_type = ?, scope_value = ?, tanggal_libur = ?,
                keterangan = ?, status_aktif = ?, updated_at = ?
             WHERE id = ?;",
            params![
                scope_type,
                scope_value,
                tanggal_libur,
                keterangan,
                status_aktif,
                now,
                id
            ],
        )
        .map_err(|_| CommandError::internal())?;

    let payload = whitelist_row_json(&transaction, id)?.unwrap_or_else(|| json!({ "id": id }));
    let revision = base_revision(&transaction, "holiday-whitelist", id);
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday-whitelist",
        "update",
        id,
        &payload,
        revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn delete_holiday_whitelist(state: &DesktopState, id: &str) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    if whitelist_row_json(&transaction, id)?.is_none() {
        return Ok(json!({ "sukses": true }));
    }

    transaction
        .execute("DELETE FROM hari_libur_whitelist WHERE id = ?;", [id])
        .map_err(|_| CommandError::internal())?;

    let revision = base_revision(&transaction, "holiday-whitelist", id);
    sync::enqueue(
        &transaction,
        &client_id,
        "holiday-whitelist",
        "delete",
        id,
        &json!({ "id": id }),
        revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

pub fn get_alfa_settings(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let val: Option<String> = connection
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = 'auto_alfa_aktif' LIMIT 1;",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let is_active = val.map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(true);
    Ok(json!({ "enabled": is_active }))
}

pub fn save_alfa_settings(state: &DesktopState, enabled: bool) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let str_val = if enabled { "true" } else { "false" };

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES ('auto_alfa_aktif', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            [str_val],
        )
        .map_err(|_| CommandError::internal())?;

    // Bersihkan konflik & antrean outbox stale untuk auto_alfa_aktif
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = 'auto_alfa_aktif';",
        [],
    );
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = 'auto_alfa_aktif' AND status IN ('pending', 'failed', 'conflict');",
        [],
    );

    let sync_payload = json!({
        "key": "auto_alfa_aktif",
        "value": str_val,
    });
    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "update",
        "auto_alfa_aktif",
        &sync_payload,
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "enabled": enabled }))
}

fn parse_time_to_minutes(time_str: &str) -> i64 {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() >= 2 {
        let h = parts[0].parse::<i64>().unwrap_or(0);
        let m = parts[1].parse::<i64>().unwrap_or(0);
        h * 60 + m
    } else {
        0
    }
}

pub fn generate_alfa_harian(
    state: &DesktopState,
    simulated_time: Option<String>,
) -> Result<Value, CommandError> {
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    // 1. Cek Setting
    let is_active_val: Option<String> = transaction
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = 'auto_alfa_aktif' LIMIT 1;",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    let is_active = is_active_val
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    if !is_active {
        return Ok(json!({
            "jumlahAlfaDibuat": 0,
            "jumlahSudahAda": 0,
            "jumlahBelumWaktunya": 0,
            "jumlahFleksibel": 0,
            "jumlahNonaktif": 0,
            "jumlahLibur": 0,
            "jumlahShiftTidakValid": 0,
            "status": "NONAKTIF",
            "pesan": "Generate Alfa dimatikan melalui Pengaturan"
        }));
    }

    let now_str = match simulated_time {
        Some(t) => t,
        None => {
            let (dt, tm): (String, String) = transaction
                .query_row(
                    "SELECT strftime('%Y-%m-%d', 'now', '+7 hours'), strftime('%H:%M:%S', 'now', '+7 hours');",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| CommandError::internal())?;
            format!("{dt} {tm}")
        }
    };
    let now_moment = match super::time_policy::timestamp_to_moment(&now_str) {
        Ok(m) => m,
        Err(_) => {
            return Ok(json!({
                "jumlahAlfaDibuat": 0,
                "jumlahSudahAda": 0,
                "jumlahBelumWaktunya": 0,
                "jumlahFleksibel": 0,
                "jumlahNonaktif": 0,
                "jumlahLibur": 0,
                "jumlahShiftTidakValid": 0,
                "status": "ERROR",
                "pesan": "Waktu sistem tidak dapat diproses"
            }));
        }
    };

    let nonaktif_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM master_data WHERE status_aktif != 'Aktif';",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let mut statement = transaction
        .prepare("SELECT id_unik, nama, divisi, COALESCE(id_shift, 1) FROM master_data WHERE status_aktif = 'Aktif';")
        .map_err(|_| CommandError::internal())?;
    let employees = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    drop(statement);

    let mut alfa_dibuat = 0;
    let mut sudah_ada = 0;
    let mut belum_waktunya = 0;
    let mut fleksibel = 0;
    // Dulu dua kondisi ini keluar lewat "continue" tanpa jejak, sehingga
    // ringkasan hanya menampilkan nol tanpa alasan.
    let mut libur = 0;
    let mut shift_tidak_valid = 0;

    let now_minute = parse_time_to_minutes(&now_moment.time);

    let month_names = [
        "Januari",
        "Februari",
        "Maret",
        "April",
        "Mei",
        "Juni",
        "Juli",
        "Agustus",
        "September",
        "Oktober",
        "November",
        "Desember",
    ];

    for (id_unik, nama, divisi, id_shift) in employees {
        let shift_config: Option<(String, String, i64, i64, i64, i64)> = transaction
            .query_row(
                r#"
                SELECT jam_masuk,
                       jam_pulang,
                       COALESCE(offset_generate_alfa, 180),
                       COALESCE(jam_kerja_normal_menit, 0),
                       COALESCE(batas_pulang_menit, 240),
                       COALESCE(buffer_shift_malam_menit, 120)
                FROM tbl_shift WHERE id_shift = ?;
                "#,
                [id_shift],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .unwrap_or(None);

        let (jam_masuk, jam_pulang, offset_alfa, jam_kerja_normal, batas_pulang, buffer_malam) =
            match shift_config {
                Some(cfg) => cfg,
                None => {
                    // Shift karyawan hilang / tidak terbaca. Dulu dilewati diam-diam,
                    // sehingga karyawan tidak pernah di-Alfa-kan tanpa satu pun jejak.
                    shift_tidak_valid += 1;
                    transaction
                        .execute(
                            r#"
                            INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status)
                            VALUES (?, 'Skip Generate Alfa', ?, ?, ?, '', ?, 'Gagal');
                            "#,
                            params![
                                now_str,
                                now_moment.date,
                                id_unik,
                                nama,
                                format!("Shift id {id_shift} tidak ditemukan di tbl_shift."),
                            ],
                        )
                        .map_err(|_| CommandError::internal())?;
                    continue;
                }
            };

        // Shift fleksibel tidak lagi dilewati. Karyawannya bebas absen jam
        // berapa saja, jadi ketidakhadiran baru boleh dinilai setelah hari
        // kalendernya habis — yang di-generate adalah hari kemarin, sama
        // seperti shift malam yang diselesaikan pagi harinya.
        let shift_kind =
            super::time_policy::shift_kind_of(&jam_masuk, &jam_pulang, jam_kerja_normal);
        let is_fleksibel = shift_kind == super::time_policy::ShiftKind::Flexible;
        if is_fleksibel {
            fleksibel += 1;
        }

        let shift_in_min = parse_time_to_minutes(&jam_masuk);
        let shift_out_min = parse_time_to_minutes(&jam_pulang);
        let is_overnight = !is_fleksibel && shift_out_min < shift_in_min;

        // Hari kerja yang sedang dinilai mundur satu hari selama kita masih
        // berada di dalam shift yang belum selesai.
        let masih_di_hari_sebelumnya = if is_fleksibel {
            now_minute < super::time_policy::END_OF_DAY_MINUTE
        } else {
            is_overnight && now_minute < shift_in_min
        };

        let mut work_date = now_moment.date.clone();
        if masih_di_hari_sebelumnya {
            if let Ok(prev) = super::time_policy::add_days(&now_moment.date, -1) {
                work_date = prev;
            }
        }

        let holiday_check: bool = transaction
            .query_row(
                "SELECT 1 FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
                [&work_date],
                |_| Ok(true),
            )
            .optional()
            .unwrap_or(None)
            .unwrap_or(false);
        if holiday_check {
            libur += 1;
            continue;
        }

        // Alfa baru boleh dibuat setelah jendela scan pulang benar-benar tertutup
        // (jam pulang + batas pulang + buffer shift malam), lalu ditambah
        // offset_generate_alfa. Rumus lama "jam_pulang - offset" mengabaikan
        // batas_pulang_menit dan membuat Alfa selagi karyawan masih berhak
        // scan pulang.
        let shift_policy = super::time_policy::ShiftPolicy {
            kind: shift_kind,
            start: jam_masuk.clone(),
            end: jam_pulang.clone(),
            early_window_minutes: 0,
            normal_entry_minutes: 0,
            late_tolerance_minutes: 0,
            checkout_limit_minutes: batas_pulang,
            night_buffer_minutes: buffer_malam,
            break_offset_minutes: 0,
            normal_work_minutes: jam_kerja_normal,
            break_minutes: 0,
        };
        let cutoff_timeline_minute =
            match super::time_policy::alfa_generation_minute(&shift_policy, offset_alfa) {
                Some(minute) => minute,
                None => {
                    shift_tidak_valid += 1;
                    continue;
                }
            };

        let current_timeline_minute =
            match super::time_policy::days_between(&work_date, &now_moment.date) {
                Ok(diff) => diff * 1440 + now_minute,
                Err(_) => now_minute,
            };

        if current_timeline_minute < cutoff_timeline_minute {
            belum_waktunya += 1;
            continue;
        }

        let session_id = format!(
            "NORMAL-{}-{}-{}",
            work_date.replace('-', ""),
            id_unik,
            id_shift
        );

        let exist: bool = transaction
            .query_row(
                "SELECT 1 FROM absensi_harian WHERE id_karyawan = ? AND tanggal = ? AND (mode_tugas = 'NORMAL' OR mode_tugas IS NULL OR mode_tugas = '') LIMIT 1;",
                params![&id_unik, &work_date],
                |_| Ok(true),
            )
            .optional()
            .unwrap_or(None)
            .unwrap_or(false);

        if exist {
            sudah_ada += 1;
            continue;
        }

        let month_idx = match work_date.get(5..7).and_then(|m| m.parse::<usize>().ok()) {
            Some(m) if m >= 1 && m <= 12 => m - 1,
            _ => 0,
        };
        let bulan = month_names[month_idx];
        let tahun = work_date
            .get(0..4)
            .and_then(|y| y.parse::<i64>().ok())
            .unwrap_or(2026);

        transaction
            .execute(
                r#"
                INSERT INTO absensi_harian (
                    tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
                    status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
                    menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
                    id_shift, bulan, tahun, id_sesi, mode_tugas
                ) VALUES (?, ?, ?, ?, '', '', 'Alfa', 'Tidak Hadir', 'Generate Alfa otomatis - belum ada absensi atau koreksi Sakit/Izin/Dispen', 'Generate Sistem', ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, 'NORMAL');
                "#,
                params![
                    work_date,
                    id_unik,
                    nama,
                    divisi,
                    now_str,
                    id_shift,
                    bulan,
                    tahun,
                    session_id,
                ],
            )
            .map_err(|_| CommandError::internal())?;

        transaction
            .execute(
                r#"
                INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status)
                VALUES (?, 'Generate Alfa', ?, ?, ?, ?, 'Alfa sesi NORMAL dibuat karena belum ada absensi atau koreksi Sakit/Izin/Dispen.', 'Selesai');
                "#,
                params![now_str, work_date, id_unik, nama, session_id],
            )
            .map_err(|_| CommandError::internal())?;

        let att_payload = json!({
            "tanggal": work_date,
            "id_karyawan": id_unik,
            "nama": nama,
            "kelas_divisi": divisi,
            "jam_masuk": "",
            "jam_pulang": "",
            "status_kehadiran": "Alfa",
            "status_absen": "Tidak Hadir",
            "keterangan": "Generate Alfa otomatis - belum ada absensi atau koreksi Sakit/Izin/Dispen",
            "sumber": "Generate Sistem",
            "update_terakhir": now_str,
            "menit_terlambat": 0,
            "menit_datang_awal": 0,
            "jam_kerja": 0,
            "lembur": 0,
            "jam_kerja_kurang": 0,
            "id_shift": id_shift,
            "bulan": bulan,
            "tahun": tahun,
            "id_sesi": session_id,
            "mode_tugas": "NORMAL",
        });
        let client_id = sync::ensure_client_id(state)?;
        sync::enqueue(
            &transaction,
            &client_id,
            "attendance",
            "create",
            &format!("alfa:{session_id}"),
            &json!({ "attendance": att_payload }),
            None,
        )?;

        alfa_dibuat += 1;
    }

    let today_holiday: Option<String> = transaction
        .query_row(
            "SELECT nama_libur FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
            [&now_moment.date],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    let (status, pesan) = match today_holiday {
        Some(nama) => (
            "LIBUR",
            format!("Hari ini Hari Libur ({nama}). Generate Alfa dilewati untuk hari ini."),
        ),
        None => {
            if alfa_dibuat > 0 {
                (
                    "SELESAI",
                    format!("Generate Alfa Selesai. Dibuat: {alfa_dibuat}, Sudah Ada: {sudah_ada}, Belum Waktunya: {belum_waktunya}, Fleksibel (dinilai): {fleksibel}, Libur: {libur}, Shift Tidak Valid: {shift_tidak_valid}"),
                )
            } else {
                (
                    "IDLE",
                    format!("Generate Alfa Selesai. Dibuat: {alfa_dibuat}, Sudah Ada: {sudah_ada}, Belum Waktunya: {belum_waktunya}, Fleksibel (dinilai): {fleksibel}, Libur: {libur}, Shift Tidak Valid: {shift_tidak_valid}"),
                )
            }
        }
    };

    transaction.commit().map_err(|_| CommandError::internal())?;

    Ok(json!({
        "jumlahAlfaDibuat": alfa_dibuat,
        "jumlahSudahAda": sudah_ada,
        "jumlahBelumWaktunya": belum_waktunya,
        "jumlahFleksibel": fleksibel,
        "jumlahNonaktif": nonaktif_count,
        "jumlahLibur": libur,
        "jumlahShiftTidakValid": shift_tidak_valid,
        "status": status,
        "pesan": pesan
    }))
}

/// Satu temuan audit kualitas absensi untuk satu karyawan.
struct TemuanAudit {
    id_karyawan: String,
    nama: String,
    divisi: String,
    nama_shift: String,
    jam_shift: String,
    kategori: &'static str,
    keparahan: &'static str,
    detail: String,
    jam_masuk: String,
    jam_pulang: String,
    status_kehadiran: String,
    sumber: String,
}

/// Urutan tampil temuan: yang paling mendesak lebih dulu.
fn peringkat_keparahan(keparahan: &str) -> i64 {
    match keparahan {
        "tinggi" => 0,
        "sedang" => 1,
        "rendah" => 2,
        _ => 3,
    }
}

/// Ubah menit garis waktu tanggal kerja menjadi label jam yang bisa dibaca.
/// Menit di atas 1440 berarti hari berikutnya (shift malam).
fn label_menit(minute: i64) -> String {
    let hari = minute.div_euclid(1440);
    let sisa = minute.rem_euclid(1440);
    let jam = format!("{:02}:{:02}", sisa / 60, sisa % 60);
    if hari > 0 {
        format!("{jam} (H+{hari})")
    } else {
        jam
    }
}

/// Audit kualitas absensi untuk satu tanggal kerja.
///
/// Murni baca — tidak menulis `absensi_harian` maupun outbox. Generate Alfa
/// tetap jadi tombol terpisah di Pengaturan supaya "melihat kualitas" tidak
/// diam-diam mengubah data.
pub fn get_attendance_audit(
    state: &DesktopState,
    tanggal: Option<String>,
) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;

    let (hari_ini, jam_sekarang): (String, String) = connection
        .query_row(
            "SELECT date('now','+7 hours'), strftime('%H:%M:%S','now','+7 hours');",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| CommandError::internal())?;

    let tanggal_target = tanggal
        .map(|value| value.trim().to_owned())
        .filter(|value| value.len() == 10)
        .unwrap_or_else(|| hari_ini.clone());

    let hari_ini_juga = tanggal_target == hari_ini;
    let masa_depan = tanggal_target > hari_ini;
    // Garis waktu relatif tanggal kerja, rumus yang sama dipakai
    // generate_alfa_harian. Sentinel "tanggal lampau = semua jendela lewat"
    // salah untuk shift malam: jendela pulangnya baru tutup pukul 09:00 H+1,
    // sehingga sesi yang masih berjalan dilaporkan "Belum Scan Pulang" saat
    // diaudit pagi harinya.
    let menit_berjalan =
        match super::time_policy::days_between(&tanggal_target, &hari_ini) {
            Ok(selisih) => selisih * 1440 + parse_time_to_minutes(&jam_sekarang),
            Err(_) => i64::MAX / 4,
        };

    let hari_libur: Option<String> = connection
        .query_row(
            "SELECT nama_libur FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
            [&tanggal_target],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    // ── Pre-load shift ──────────────────────────────────────────────────────
    let mut shift_statement = connection
        .prepare(
            r#"
            SELECT id_shift, nama_shift, jam_masuk, jam_pulang,
                   COALESCE(batas_masuk_menit, 60),
                   COALESCE(toleransi_masuk_menit, 0),
                   COALESCE(batas_pulang_menit, 240),
                   COALESCE(buffer_shift_malam_menit, 120),
                   COALESCE(jam_kerja_normal_menit, 0)
            FROM tbl_shift;
            "#,
        )
        .map_err(|_| CommandError::internal())?;
    let mut shifts: HashMap<i64, (String, String, String, i64, i64, i64, i64, i64)> = HashMap::new();
    let shift_rows = shift_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in shift_rows {
        let (id, nama, masuk, pulang, batas_masuk, toleransi, batas_pulang, buffer, normal) =
            row.map_err(|_| CommandError::internal())?;
        shifts.insert(
            id,
            (
                nama,
                masuk,
                pulang,
                batas_masuk,
                toleransi,
                batas_pulang,
                buffer,
                normal,
            ),
        );
    }
    drop(shift_statement);

    // ── Pre-load absensi sesi NORMAL pada tanggal target ────────────────────
    let mut att_statement = connection
        .prepare(
            r#"
            SELECT id_karyawan,
                   COALESCE(jam_masuk, ''),
                   COALESCE(jam_pulang, ''),
                   COALESCE(status_kehadiran, ''),
                   COALESCE(sumber, ''),
                   COALESCE(menit_terlambat, 0),
                   COALESCE(jam_kerja_kurang, 0)
            FROM absensi_harian
            WHERE tanggal = ?
              AND (mode_tugas = 'NORMAL' OR mode_tugas IS NULL OR mode_tugas = '');
            "#,
        )
        .map_err(|_| CommandError::internal())?;
    let mut absensi: HashMap<String, (String, String, String, String, i64, i64)> = HashMap::new();
    let att_rows = att_statement
        .query_map([&tanggal_target], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in att_rows {
        let (id, masuk, pulang, kehadiran, sumber, terlambat, kurang) =
            row.map_err(|_| CommandError::internal())?;
        absensi.insert(id, (masuk, pulang, kehadiran, sumber, terlambat, kurang));
    }
    drop(att_statement);

    // ── Pre-load scan bermasalah pada tanggal target ────────────────────────
    let mut scan_statement = connection
        .prepare(
            r#"
            SELECT id_karyawan, status_proses, COUNT(*)
            FROM log_scan
            WHERE tanggal_kerja = ? AND status_proses IN ('Perlu Verifikasi', 'Ditolak')
            GROUP BY id_karyawan, status_proses;
            "#,
        )
        .map_err(|_| CommandError::internal())?;
    let mut scan_masalah: HashMap<String, (i64, i64)> = HashMap::new();
    let scan_rows = scan_statement
        .query_map([&tanggal_target], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in scan_rows {
        let (id, status, jumlah) = row.map_err(|_| CommandError::internal())?;
        let entry = scan_masalah.entry(id).or_insert((0, 0));
        if status == "Perlu Verifikasi" {
            entry.0 += jumlah;
        } else {
            entry.1 += jumlah;
        }
    }
    drop(scan_statement);

    // ── Karyawan aktif ──────────────────────────────────────────────────────
    let mut emp_statement = connection
        .prepare(
            "SELECT id_unik, nama, divisi, COALESCE(id_shift, 1) FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;",
        )
        .map_err(|_| CommandError::internal())?;
    let employees = emp_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    drop(emp_statement);

    let total_aktif = employees.len() as i64;
    let mut wajib_absen = 0i64;
    let mut hadir = 0i64;
    let mut alfa = 0i64;
    let mut izin_sakit = 0i64;
    let mut belum_scan_masuk = 0i64;
    let mut belum_scan_pulang = 0i64;
    let mut sedang_bekerja = 0i64;
    let mut menunggu_jam_absen = 0i64;
    let mut terlambat = 0i64;
    let mut jam_kerja_kurang = 0i64;
    let mut perlu_verifikasi = 0i64;
    let mut scan_ditolak = 0i64;
    let mut koreksi_admin = 0i64;
    let mut fleksibel = 0i64;
    let mut tanpa_data = 0i64;
    let mut shift_tidak_valid = 0i64;
    let mut karyawan_bermasalah = 0i64;
    let mut temuan: Vec<TemuanAudit> = Vec::new();

    for (id_unik, nama, divisi, id_shift) in employees {
        let Some((
            nama_shift,
            jam_masuk_shift,
            jam_pulang_shift,
            batas_masuk,
            toleransi_masuk,
            batas_pulang,
            buffer_malam,
            jam_kerja_normal,
        )) = shifts.get(&id_shift).cloned()
        else {
            shift_tidak_valid += 1;
            karyawan_bermasalah += 1;
            temuan.push(TemuanAudit {
                id_karyawan: id_unik,
                nama,
                divisi,
                nama_shift: format!("Shift {id_shift}"),
                jam_shift: "-".to_owned(),
                kategori: "Shift Tidak Valid",
                keparahan: "tinggi",
                detail: format!(
                    "Shift id {id_shift} tidak ada di tabel shift, absensi karyawan ini tidak dapat dinilai."
                ),
                jam_masuk: String::new(),
                jam_pulang: String::new(),
                status_kehadiran: String::new(),
                sumber: String::new(),
            });
            continue;
        };

        let jam_shift = format!("{jam_masuk_shift} - {jam_pulang_shift}");

        // Shift fleksibel tetap dinilai: bebas jam absen bukan berarti bebas
        // tidak absen. Jendela waktunya saja yang berbeda — baru tertutup di
        // akhir hari (lihat `entry_window_close_minute`), sehingga selama
        // harinya berjalan karyawan berstatus "Menunggu Jam Absen".
        let shift_kind = super::time_policy::shift_kind_of(
            &jam_masuk_shift,
            &jam_pulang_shift,
            jam_kerja_normal,
        );
        if shift_kind == super::time_policy::ShiftKind::Flexible {
            fleksibel += 1;
        }

        // Hari libur aktif: tidak ada kewajiban absen, jadi tidak dinilai.
        if hari_libur.is_some() {
            continue;
        }

        wajib_absen += 1;

        let shift_policy = super::time_policy::ShiftPolicy {
            kind: shift_kind,
            start: jam_masuk_shift.clone(),
            end: jam_pulang_shift.clone(),
            early_window_minutes: 0,
            normal_entry_minutes: batas_masuk,
            late_tolerance_minutes: toleransi_masuk,
            checkout_limit_minutes: batas_pulang,
            night_buffer_minutes: buffer_malam,
            break_offset_minutes: 0,
            normal_work_minutes: jam_kerja_normal,
            break_minutes: 0,
        };
        let tutup_masuk = super::time_policy::entry_window_close_minute(&shift_policy);
        let tutup_pulang = super::time_policy::latest_checkout_minute(&shift_policy);

        let mut bermasalah = false;
        let catat = |kategori: &'static str,
                         keparahan: &'static str,
                         detail: String,
                         record: Option<&(String, String, String, String, i64, i64)>,
                         temuan: &mut Vec<TemuanAudit>| {
            temuan.push(TemuanAudit {
                id_karyawan: id_unik.clone(),
                nama: nama.clone(),
                divisi: divisi.clone(),
                nama_shift: nama_shift.clone(),
                jam_shift: jam_shift.clone(),
                kategori,
                keparahan,
                detail,
                jam_masuk: record.map(|r| r.0.clone()).unwrap_or_default(),
                jam_pulang: record.map(|r| r.1.clone()).unwrap_or_default(),
                status_kehadiran: record.map(|r| r.2.clone()).unwrap_or_default(),
                sumber: record.map(|r| r.3.clone()).unwrap_or_default(),
            });
        };

        match absensi.get(&id_unik) {
            None => {
                if masa_depan {
                    menunggu_jam_absen += 1;
                } else if tutup_masuk.is_some_and(|tutup| menit_berjalan < tutup) {
                    menunggu_jam_absen += 1;
                    catat(
                        "Menunggu Jam Absen",
                        "info",
                        format!(
                            "Belum scan masuk, tetapi jendela scan masuk baru tutup pukul {}.",
                            tutup_masuk.map(label_menit).unwrap_or_else(|| "-".into())
                        ),
                        None,
                        &mut temuan,
                    );
                } else if hari_ini_juga {
                    belum_scan_masuk += 1;
                    bermasalah = true;
                    catat(
                        "Belum Scan Masuk",
                        "tinggi",
                        format!(
                            "Jendela scan masuk sudah tutup pukul {} dan belum ada satu pun scan.",
                            tutup_masuk.map(label_menit).unwrap_or_else(|| "-".into())
                        ),
                        None,
                        &mut temuan,
                    );
                } else {
                    tanpa_data += 1;
                    bermasalah = true;
                    catat(
                        "Tanpa Data Absensi",
                        "tinggi",
                        "Tanggal kerja sudah lewat tetapi tidak ada baris absensi sama sekali."
                            .to_owned(),
                        None,
                        &mut temuan,
                    );
                }
            }
            Some(record) => {
                let (masuk, pulang, kehadiran, sumber, menit_terlambat, menit_kurang) = record;

                match kehadiran.as_str() {
                    "Alfa" => {
                        alfa += 1;
                        bermasalah = true;
                        catat(
                            "Alfa",
                            "tinggi",
                            format!("Tercatat Alfa melalui sumber \"{sumber}\"."),
                            Some(record),
                            &mut temuan,
                        );
                    }
                    "Hadir" => hadir += 1,
                    _ => izin_sakit += 1,
                }

                if !masuk.is_empty() && pulang.is_empty() && kehadiran.as_str() != "Alfa" {
                    if tutup_pulang.is_some_and(|tutup| menit_berjalan > tutup) {
                        belum_scan_pulang += 1;
                        bermasalah = true;
                        catat(
                            "Belum Scan Pulang",
                            "sedang",
                            format!(
                                "Sudah scan masuk {masuk} tetapi jendela scan pulang tutup pukul {} tanpa scan pulang.",
                                tutup_pulang.map(label_menit).unwrap_or_else(|| "-".into())
                            ),
                            Some(record),
                            &mut temuan,
                        );
                    } else {
                        sedang_bekerja += 1;
                    }
                }

                if *menit_terlambat > 0 {
                    terlambat += 1;
                    catat(
                        "Terlambat",
                        "rendah",
                        format!("Terlambat {menit_terlambat} menit dari jadwal shift."),
                        Some(record),
                        &mut temuan,
                    );
                }

                if *menit_kurang > 0 {
                    jam_kerja_kurang += 1;
                    catat(
                        "Jam Kerja Kurang",
                        "rendah",
                        format!("Kekurangan {menit_kurang} menit dari jam kerja normal."),
                        Some(record),
                        &mut temuan,
                    );
                }

                if sumber.as_str() == "Koreksi Admin" {
                    koreksi_admin += 1;
                    catat(
                        "Koreksi Admin",
                        "info",
                        "Baris ini hasil koreksi manual admin, bukan scan karyawan.".to_owned(),
                        Some(record),
                        &mut temuan,
                    );
                }
            }
        }

        if let Some((verifikasi, ditolak)) = scan_masalah.get(&id_unik).copied() {
            let record = absensi.get(&id_unik);
            if verifikasi > 0 {
                perlu_verifikasi += 1;
                bermasalah = true;
                catat(
                    "Perlu Verifikasi",
                    "sedang",
                    format!("Ada {verifikasi} scan berstatus Perlu Verifikasi yang belum ditindaklanjuti."),
                    record,
                    &mut temuan,
                );
            }
            if ditolak > 0 {
                scan_ditolak += 1;
                bermasalah = true;
                catat(
                    "Scan Ditolak",
                    "sedang",
                    format!("Ada {ditolak} scan ditolak (geofence, multi-scan, atau di luar jendela)."),
                    record,
                    &mut temuan,
                );
            }
        }

        if bermasalah {
            karyawan_bermasalah += 1;
        }
    }

    temuan.sort_by(|a, b| {
        peringkat_keparahan(a.keparahan)
            .cmp(&peringkat_keparahan(b.keparahan))
            .then_with(|| a.nama.cmp(&b.nama))
            .then_with(|| a.kategori.cmp(b.kategori))
    });

    let skor = if wajib_absen <= 0 {
        100
    } else {
        (((wajib_absen - karyawan_bermasalah).max(0) * 100) as f64 / wajib_absen as f64).round()
            as i64
    };

    let daftar_temuan: Vec<Value> = temuan
        .iter()
        .map(|item| {
            json!({
                "idKaryawan": item.id_karyawan,
                "nama": item.nama,
                "divisi": item.divisi,
                "namaShift": item.nama_shift,
                "jamShift": item.jam_shift,
                "kategori": item.kategori,
                "keparahan": item.keparahan,
                "detail": item.detail,
                "jamMasuk": item.jam_masuk,
                "jamPulang": item.jam_pulang,
                "statusKehadiran": item.status_kehadiran,
                "sumber": item.sumber,
            })
        })
        .collect();

    let mut log_statement = connection
        .prepare(
            "SELECT waktu, jenis, nama, detail, status FROM audit_absensi WHERE tanggal = ? ORDER BY id_audit DESC LIMIT 20;",
        )
        .map_err(|_| CommandError::internal())?;
    let log_audit = log_statement
        .query_map([&tanggal_target], |row| {
            Ok(json!({
                "waktu": row.get::<_, String>(0)?,
                "jenis": row.get::<_, String>(1)?,
                "nama": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "detail": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "status": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    drop(log_statement);

    Ok(json!({
        "tanggal": tanggal_target,
        "waktuAudit": format!("{hari_ini} {jam_sekarang}"),
        "hariLibur": hari_libur,
        "ringkasan": {
            "totalKaryawanAktif": total_aktif,
            "wajibAbsen": wajib_absen,
            "hadir": hadir,
            "alfa": alfa,
            "izinSakit": izin_sakit,
            "belumScanMasuk": belum_scan_masuk,
            "belumScanPulang": belum_scan_pulang,
            "sedangBekerja": sedang_bekerja,
            "menungguJamAbsen": menunggu_jam_absen,
            "terlambat": terlambat,
            "jamKerjaKurang": jam_kerja_kurang,
            "perluVerifikasi": perlu_verifikasi,
            "scanDitolak": scan_ditolak,
            "koreksiAdmin": koreksi_admin,
            "fleksibel": fleksibel,
            "tanpaData": tanpa_data,
            "shiftTidakValid": shift_tidak_valid,
            "karyawanBermasalah": karyawan_bermasalah,
            "skorKualitas": skor,
        },
        "temuan": daftar_temuan,
        "logAudit": log_audit,
    }))
}

fn current_iso(connection: &rusqlite::Connection) -> String {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now');", [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "2026-01-01T00:00:00Z".to_string())
}

const DEFAULT_CARD_TERMS: &str = "1. This card is the official identification of your company's employees/personnel.\n2. Must be carried and scanned (QR scan) every time you arrive and leave work.\n3. It is prohibited to transfer or lend this card to other parties.\n4. If the card is lost or found, please report it immediately to the HR/Operations Department.";

pub fn get_company_profile(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let result = connection
        .query_row(
            "SELECT id, company_name, branch_name, logo_url, signature_url, address, phone, email, website, leader_name, leader_title, leader_nip, card_terms, timezone, updated_at FROM company_profile WHERE id = 'default_company' LIMIT 1;",
            [],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "company_name": row.get::<_, String>(1)?,
                    "branch_name": row.get::<_, Option<String>>(2)?,
                    "logo_url": row.get::<_, Option<String>>(3)?,
                    "signature_url": row.get::<_, Option<String>>(4)?,
                    "address": row.get::<_, Option<String>>(5)?,
                    "phone": row.get::<_, Option<String>>(6)?,
                    "email": row.get::<_, Option<String>>(7)?,
                    "website": row.get::<_, Option<String>>(8)?,
                    "leader_name": row.get::<_, Option<String>>(9)?,
                    "leader_title": row.get::<_, Option<String>>(10)?,
                    "leader_nip": row.get::<_, Option<String>>(11)?,
                    "card_terms": row.get::<_, Option<String>>(12)?,
                    "timezone": row.get::<_, Option<String>>(13)?.unwrap_or_else(|| "Asia/Jakarta".to_string()),
                    "updated_at": row.get::<_, String>(14)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    match result {
        Some(val) => Ok(val),
        None => {
            let now = current_iso(&connection);
            let _ = connection.execute(
                r#"
                INSERT OR IGNORE INTO company_profile (
                    id, company_name, branch_name, logo_url, signature_url,
                    address, phone, email, website,
                    leader_name, leader_title, leader_nip,
                    card_terms, timezone, updated_at
                ) VALUES (
                    'default_company', 'YOUR COMPANY', 'Operations Center', NULL, NULL,
                    'Your Company Address', '-', 'info@yourcompany.com', 'https://yourcompany.com',
                    'Your Name', 'Director', '-',
                    ?, 'Asia/Jakarta', ?
                );
                "#,
                params![DEFAULT_CARD_TERMS, now],
            );
            Ok(json!({
                "id": "default_company",
                "company_name": "YOUR COMPANY",
                "branch_name": "Operations Center",
                "logo_url": Value::Null,
                "signature_url": Value::Null,
                "address": "Your Company Address",
                "phone": "-",
                "email": "info@yourcompany.com",
                "website": "https://yourcompany.com",
                "leader_name": "Your Name",
                "leader_title": "Director",
                "leader_nip": "-",
                "card_terms": DEFAULT_CARD_TERMS,
                "timezone": "Asia/Jakarta",
                "updated_at": now,
            }))
        }
    }
}

pub fn update_company_profile(
    state: &DesktopState,
    profile: &Value,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let now = current_iso(&transaction);
    let company_name = text(profile, "company_name");
    let company_name = if company_name.is_empty() {
        "YOUR COMPANY"
    } else {
        company_name
    };
    let branch_name = text(profile, "branch_name");
    let logo_url = text(profile, "logo_url");
    let signature_url = text(profile, "signature_url");
    let address = text(profile, "address");
    let phone = text(profile, "phone");
    let email = text(profile, "email");
    let website = text(profile, "website");
    let leader_name = text(profile, "leader_name");
    let leader_title = text(profile, "leader_title");
    let leader_nip = text(profile, "leader_nip");
    let card_terms = text(profile, "card_terms");
    let timezone = text(profile, "timezone");
    let timezone = if timezone.is_empty() {
        "Asia/Jakarta"
    } else {
        timezone
    };

    transaction
        .execute(
            r#"
        INSERT INTO company_profile (
            id, company_name, branch_name, logo_url, signature_url,
            address, phone, email, website,
            leader_name, leader_title, leader_nip,
            card_terms, timezone, updated_at
        ) VALUES (
            'default_company', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
            company_name = excluded.company_name,
            branch_name = excluded.branch_name,
            logo_url = excluded.logo_url,
            signature_url = excluded.signature_url,
            address = excluded.address,
            phone = excluded.phone,
            email = excluded.email,
            website = excluded.website,
            leader_name = excluded.leader_name,
            leader_title = excluded.leader_title,
            leader_nip = excluded.leader_nip,
            card_terms = excluded.card_terms,
            timezone = excluded.timezone,
            updated_at = excluded.updated_at;
        "#,
            params![
                company_name,
                if branch_name.is_empty() {
                    None
                } else {
                    Some(branch_name)
                },
                if logo_url.is_empty() {
                    None
                } else {
                    Some(logo_url)
                },
                if signature_url.is_empty() {
                    None
                } else {
                    Some(signature_url)
                },
                if address.is_empty() {
                    None
                } else {
                    Some(address)
                },
                if phone.is_empty() { None } else { Some(phone) },
                if email.is_empty() { None } else { Some(email) },
                if website.is_empty() {
                    None
                } else {
                    Some(website)
                },
                if leader_name.is_empty() {
                    None
                } else {
                    Some(leader_name)
                },
                if leader_title.is_empty() {
                    None
                } else {
                    Some(leader_title)
                },
                if leader_nip.is_empty() {
                    None
                } else {
                    Some(leader_nip)
                },
                if card_terms.is_empty() {
                    None
                } else {
                    Some(card_terms)
                },
                timezone,
                now,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    let payload = json!({
        "id": "default_company",
        "company_name": company_name,
        "branch_name": if branch_name.is_empty() { Value::Null } else { Value::String(branch_name.to_string()) },
        "logo_url": if logo_url.is_empty() { Value::Null } else { Value::String(logo_url.to_string()) },
        "signature_url": if signature_url.is_empty() { Value::Null } else { Value::String(signature_url.to_string()) },
        "address": if address.is_empty() { Value::Null } else { Value::String(address.to_string()) },
        "phone": if phone.is_empty() { Value::Null } else { Value::String(phone.to_string()) },
        "email": if email.is_empty() { Value::Null } else { Value::String(email.to_string()) },
        "website": if website.is_empty() { Value::Null } else { Value::String(website.to_string()) },
        "leader_name": if leader_name.is_empty() { Value::Null } else { Value::String(leader_name.to_string()) },
        "leader_title": if leader_title.is_empty() { Value::Null } else { Value::String(leader_title.to_string()) },
        "leader_nip": if leader_nip.is_empty() { Value::Null } else { Value::String(leader_nip.to_string()) },
        "card_terms": if card_terms.is_empty() { Value::Null } else { Value::String(card_terms.to_string()) },
        "timezone": timezone,
        "updated_at": now,
    });

    sync::enqueue(
        &transaction,
        &client_id,
        "company-profile",
        "update",
        "default_company",
        &payload,
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(payload)
}

pub fn default_id_card_elements() -> Value {
    json!([
        {
            "id": "el-company-logo",
            "type": "company_logo",
            "side": "front",
            "sourceKey": "company.logo",
            "label": "Logo Instansi",
            "x": 6,
            "y": 8,
            "width": 14,
            "height": 20,
            "fontSize": 14,
            "color": "#ffffff",
            "visible": true
        },
        {
            "id": "el-header-company",
            "type": "text",
            "side": "front",
            "sourceKey": "company.name",
            "label": "Nama Instansi",
            "x": 22,
            "y": 11,
            "fontSize": 16,
            "fontWeight": "bold",
            "color": "#ffffff",
            "textAlign": "left",
            "isUppercase": true,
            "visible": true
        },
        {
            "id": "el-header-title",
            "type": "static_text",
            "side": "front",
            "sourceKey": "static_text",
            "staticValue": "KARTU IDENTITAS KARYAWAN",
            "label": "Judul Kartu",
            "x": 22,
            "y": 22,
            "fontSize": 9,
            "fontWeight": "600",
            "color": "#38bdf8",
            "textAlign": "left",
            "isUppercase": true,
            "visible": true
        },
        {
            "id": "el-emp-name",
            "type": "text",
            "side": "front",
            "sourceKey": "employee.name",
            "label": "Nama Karyawan",
            "x": 6,
            "y": 44,
            "fontSize": 18,
            "fontWeight": "bold",
            "color": "#ffffff",
            "textAlign": "left",
            "isUppercase": true,
            "visible": true
        },
        {
            "id": "el-emp-pos",
            "type": "text",
            "side": "front",
            "sourceKey": "employee.position",
            "label": "Jabatan / Posisi",
            "x": 6,
            "y": 56,
            "fontSize": 12,
            "fontWeight": "600",
            "color": "#7dd3fc",
            "textAlign": "left",
            "visible": true
        },
        {
            "id": "el-emp-dept",
            "type": "text",
            "side": "front",
            "sourceKey": "employee.department",
            "label": "Divisi / Unit",
            "x": 6,
            "y": 67,
            "fontSize": 11,
            "fontWeight": "normal",
            "color": "#cbd5e1",
            "textAlign": "left",
            "visible": true
        },
        {
            "id": "el-emp-nik",
            "type": "text",
            "side": "front",
            "sourceKey": "employee.nik",
            "label": "NIK / Kode",
            "x": 6,
            "y": 78,
            "fontSize": 10,
            "fontWeight": "normal",
            "color": "#94a3b8",
            "textAlign": "left",
            "visible": true
        },
        {
            "id": "el-emp-qr",
            "type": "qr_code",
            "side": "front",
            "sourceKey": "employee.qr_token",
            "label": "QR Code Token",
            "x": 68,
            "y": 30,
            "width": 26,
            "height": 48,
            "fontSize": 10,
            "color": "#000000",
            "visible": true
        },
        {
            "id": "el-back-title",
            "type": "static_text",
            "side": "back",
            "sourceKey": "static_text",
            "staticValue": "KETENTUAN PENGGUNAAN KARTU",
            "label": "Judul Belakang",
            "x": 8,
            "y": 12,
            "fontSize": 12,
            "fontWeight": "bold",
            "color": "#ffffff",
            "textAlign": "left",
            "isUppercase": true,
            "visible": true
        },
        {
            "id": "el-back-terms",
            "type": "text",
            "side": "back",
            "sourceKey": "company.terms",
            "label": "Syarat & Ketentuan",
            "x": 8,
            "y": 24,
            "width": 84,
            "height": 42,
            "fontSize": 8.5,
            "fontWeight": "normal",
            "color": "#cbd5e1",
            "textAlign": "left",
            "visible": true
        },
        {
            "id": "el-back-sig",
            "type": "company_logo",
            "side": "back",
            "sourceKey": "company.signature",
            "label": "Tanda Tangan Pimpinan",
            "x": 66,
            "y": 68,
            "width": 26,
            "height": 18,
            "fontSize": 10,
            "color": "#ffffff",
            "visible": true
        },
        {
            "id": "el-back-leader",
            "type": "static_text",
            "side": "back",
            "sourceKey": "static_text",
            "staticValue": "Pimpinan Instansi",
            "label": "Label Pimpinan",
            "x": 66,
            "y": 88,
            "fontSize": 8,
            "fontWeight": "600",
            "color": "#94a3b8",
            "textAlign": "center",
            "visible": true
        }
    ])
}

pub fn get_id_card_template(state: &DesktopState, id: &str) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let target_id = if id.is_empty() {
        "default_template"
    } else {
        id
    };
    let default_elements = default_id_card_elements();
    let result = connection
        .query_row(
            "SELECT id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at FROM id_card_template WHERE (id = ? OR is_active = 1) ORDER BY is_active DESC, updated_at DESC LIMIT 1;",
            [target_id],
            |row| {
                let elements_raw: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
                let mut elements: Value = serde_json::from_str(&elements_raw).unwrap_or_else(|_| json!([]));
                while let Value::String(inner_str) = &elements {
                    if let Ok(nested) = serde_json::from_str::<Value>(inner_str) {
                        elements = nested;
                    } else {
                        break;
                    }
                }
                if elements.as_array().map(|a| a.is_empty()).unwrap_or(true) {
                    elements = default_id_card_elements();
                }
                let front_bg = row.get::<_, Option<String>>(3)?;
                let back_bg = row.get::<_, Option<String>>(4)?;
                let is_active = row.get::<_, i64>(6)? != 0;
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "orientation": row.get::<_, String>(2)?,
                    "frontBgUrl": front_bg,
                    "front_bg_url": front_bg,
                    "backBgUrl": back_bg,
                    "back_bg_url": back_bg,
                    "elements": elements,
                    "isActive": is_active,
                    "is_active": is_active,
                    "createdAt": row.get::<_, Option<String>>(7)?,
                    "updatedAt": row.get::<_, Option<String>>(8)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    match result {
        Some(val) => Ok(val),
        None => {
            let now = current_iso(&connection);
            let default_elements_str = serde_json::to_string(&default_elements).unwrap_or_default();
            let _ = connection.execute(
                r#"
                INSERT OR IGNORE INTO id_card_template (
                    id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at
                ) VALUES (
                    ?, 'Default ID Card Template', 'landscape', NULL, NULL, ?, 1, ?, ?
                );
                "#,
                params![target_id, default_elements_str, now, now],
            );
            Ok(json!({
                "id": target_id,
                "name": "Default ID Card Template",
                "orientation": "landscape",
                "frontBgUrl": Value::Null,
                "backBgUrl": Value::Null,
                "elements": default_elements,
                "isActive": true,
                "createdAt": now,
                "updatedAt": now,
            }))
        }
    }
}

pub fn save_id_card_template(
    state: &DesktopState,
    template: &Value,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let now = current_iso(&transaction);
    let id = text(template, "id");
    let id = if id.is_empty() {
        "default_template"
    } else {
        id
    };
    let name = text(template, "name");
    let name = if name.is_empty() {
        "Default ID Card Template"
    } else {
        name
    };
    let orientation = text(template, "orientation");
    let orientation = if orientation == "portrait" {
        "portrait"
    } else {
        "landscape"
    };
    let front_bg_url = if let Some(s) = template
        .get("frontBgUrl")
        .or_else(|| template.get("front_bg_url"))
        .and_then(Value::as_str)
    {
        s.trim()
    } else {
        ""
    };
    let back_bg_url = if let Some(s) = template
        .get("backBgUrl")
        .or_else(|| template.get("back_bg_url"))
        .and_then(Value::as_str)
    {
        s.trim()
    } else {
        ""
    };
    let elements_raw = template
        .get("elements")
        .or_else(|| template.get("elements_json"))
        .cloned()
        .unwrap_or(json!([]));
    let mut normalized_elements = elements_raw;
    while let Value::String(ref s) = normalized_elements {
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            normalized_elements = parsed;
        } else {
            break;
        }
    }
    let elements_json = if normalized_elements.is_array() || normalized_elements.is_object() {
        serde_json::to_string(&normalized_elements).unwrap_or_else(|_| "[]".to_string())
    } else if let Value::String(ref s) = normalized_elements {
        if s.trim().is_empty() {
            "[]".to_string()
        } else {
            s.clone()
        }
    } else {
        "[]".to_string()
    };
    let is_active = if template
        .get("isActive")
        .or_else(|| template.get("is_active"))
        .and_then(|v| {
            if let Some(b) = v.as_bool() {
                Some(b)
            } else if let Some(n) = v.as_i64() {
                Some(n != 0)
            } else if let Some(s) = v.as_str() {
                Some(s == "1" || s.eq_ignore_ascii_case("true"))
            } else {
                None
            }
        })
        .unwrap_or(true)
    {
        1
    } else {
        0
    };

    transaction
        .execute(
            r#"
        INSERT INTO id_card_template (
            id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            orientation = excluded.orientation,
            front_bg_url = excluded.front_bg_url,
            back_bg_url = excluded.back_bg_url,
            elements_json = excluded.elements_json,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at;
        "#,
            params![
                id,
                name,
                orientation,
                if front_bg_url.is_empty() { None } else { Some(front_bg_url) },
                if back_bg_url.is_empty() { None } else { Some(back_bg_url) },
                elements_json,
                is_active,
                now,
                now,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    let outbox_payload = json!({
        "id": id,
        "name": name,
        "orientation": orientation,
        "front_bg_url": if front_bg_url.is_empty() { Value::Null } else { Value::String(front_bg_url.to_string()) },
        "back_bg_url": if back_bg_url.is_empty() { Value::Null } else { Value::String(back_bg_url.to_string()) },
        "elements_json": elements_json,
        "is_active": is_active,
        "created_at": now,
        "updated_at": now,
    });

    sync::enqueue(
        &transaction,
        &client_id,
        "id-card-template",
        "save",
        id,
        &outbox_payload,
        None,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    get_id_card_template(state, id)
}

/// Mendaftarkan ulang seluruh data master lokal (Shift, Template ID Card,
/// Profil Instansi, Hari Libur, dan Pengaturan Sistem) ke antrean outbox.
/// Memastikan seluruh konfigurasi lokal langsung terkirim ke Turso Cloud saat sinkronisasi.
pub fn force_enqueue_settings(state: &DesktopState) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let mut enqueued = 0i64;

    // 1. Shift (tbl_shift)
    let mut shift_stmt = transaction
        .prepare(
            r#"
            SELECT id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                   awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
                   jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
                   offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
                   izinkan_multi_sesi, shift_lanjutan_id
            FROM tbl_shift ORDER BY id_shift ASC;
            "#,
        )
        .map_err(|_| CommandError::internal())?;
    let shifts = shift_stmt
        .query_map([], |row| {
            Ok(json!({
                "id_shift": row.get::<_, i64>(0)?,
                "kode_shift": row.get::<_, i64>(1)?,
                "nama_shift": row.get::<_, String>(2)?,
                "jam_masuk": row.get::<_, String>(3)?,
                "jam_pulang": row.get::<_, String>(4)?,
                "awal_absen_menit": row.get::<_, i64>(5)?,
                "batas_masuk_menit": row.get::<_, i64>(6)?,
                "toleransi_masuk_menit": row.get::<_, i64>(7)?,
                "jam_kerja_normal_menit": row.get::<_, i64>(8)?,
                "istirahat_menit": row.get::<_, i64>(9)?,
                "batas_pulang_menit": row.get::<_, i64>(10)?,
                "offset_istirahat_mulai": row.get::<_, i64>(11)?,
                "offset_generate_alfa": row.get::<_, i64>(12)?,
                "buffer_shift_malam_menit": row.get::<_, i64>(13)?,
                "izinkan_multi_sesi": row.get::<_, i64>(14)?,
                "shift_lanjutan_id": row.get::<_, Option<i64>>(15)?.unwrap_or(0),
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    drop(shift_stmt);

    for shift in shifts {
        let kode_shift = shift.get("kode_shift").and_then(Value::as_i64).unwrap_or(0);
        if kode_shift > 0 {
            let entity_key = format!("kode:{}", kode_shift);
            let _ = sync::enqueue(
                &transaction,
                &client_id,
                "shift",
                "create",
                &entity_key,
                &shift,
                None,
            );
            enqueued += 1;
        }
    }

    // 2. Company Profile (company_profile)
    let mut cp_stmt = transaction
        .prepare(
            "SELECT id, company_name, branch_name, logo_url, signature_url, address, phone, email, website, leader_name, leader_title, leader_nip, card_terms, timezone, updated_at FROM company_profile;",
        )
        .map_err(|_| CommandError::internal())?;
    let profiles = cp_stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "company_name": row.get::<_, String>(1)?,
                "branch_name": row.get::<_, Option<String>>(2)?,
                "logo_url": row.get::<_, Option<String>>(3)?,
                "signature_url": row.get::<_, Option<String>>(4)?,
                "address": row.get::<_, Option<String>>(5)?,
                "phone": row.get::<_, Option<String>>(6)?,
                "email": row.get::<_, Option<String>>(7)?,
                "website": row.get::<_, Option<String>>(8)?,
                "leader_name": row.get::<_, Option<String>>(9)?,
                "leader_title": row.get::<_, Option<String>>(10)?,
                "leader_nip": row.get::<_, Option<String>>(11)?,
                "card_terms": row.get::<_, Option<String>>(12)?,
                "timezone": row.get::<_, Option<String>>(13)?.unwrap_or_else(|| "Asia/Jakarta".to_string()),
                "updated_at": row.get::<_, String>(14)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    drop(cp_stmt);

    for profile in profiles {
        let cp_id = profile.get("id").and_then(Value::as_str).unwrap_or("default_company");
        let _ = sync::enqueue(
            &transaction,
            &client_id,
            "company-profile",
            "update",
            cp_id,
            &profile,
            None,
        );
        enqueued += 1;
    }

    // 3. ID Card Template (id_card_template - seluruh template)
    let mut tpl_stmt = transaction
        .prepare(
            "SELECT id, name, orientation, front_bg_url, back_bg_url, elements_json, is_active, created_at, updated_at FROM id_card_template;",
        )
        .map_err(|_| CommandError::internal())?;
    let templates = tpl_stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "orientation": row.get::<_, String>(2)?,
                "front_bg_url": row.get::<_, Option<String>>(3)?,
                "back_bg_url": row.get::<_, Option<String>>(4)?,
                "elements_json": row.get::<_, String>(5)?,
                "is_active": row.get::<_, i64>(6)?,
                "created_at": row.get::<_, Option<String>>(7)?,
                "updated_at": row.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    drop(tpl_stmt);

    for template in templates {
        let tpl_id = template.get("id").and_then(Value::as_str).unwrap_or("default_template");
        let _ = sync::enqueue(
            &transaction,
            &client_id,
            "id-card-template",
            "save",
            tpl_id,
            &template,
            None,
        );
        enqueued += 1;
    }

    // 4. Hari Libur (tbl_hari_libur)
    let mut hol_stmt = transaction
        .prepare(
            "SELECT id_libur, tanggal, nama_libur, jenis_libur, keterangan, status_aktif FROM tbl_hari_libur;",
        )
        .map_err(|_| CommandError::internal())?;
    let holidays = hol_stmt
        .query_map([], |row| {
            Ok(json!({
                "id_libur": row.get::<_, i64>(0)?,
                "tanggal": row.get::<_, String>(1)?,
                "nama_libur": row.get::<_, String>(2)?,
                "jenis_libur": row.get::<_, Option<String>>(3)?,
                "keterangan": row.get::<_, Option<String>>(4)?,
                "status_aktif": row.get::<_, Option<i64>>(5)?.unwrap_or(1),
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    drop(hol_stmt);

    for holiday in holidays {
        let tanggal = holiday.get("tanggal").and_then(Value::as_str).unwrap_or("");
        if !tanggal.is_empty() {
            let _ = sync::enqueue(
                &transaction,
                &client_id,
                "holiday",
                "create",
                tanggal,
                &holiday,
                None,
            );
            enqueued += 1;
        }
    }

    // 5. Pengaturan Sistem (setting_gex_system)
    let mut set_stmt = transaction
        .prepare("SELECT key, value FROM setting_gex_system;")
        .map_err(|_| CommandError::internal())?;
    let settings = set_stmt
        .query_map([], |row| {
            Ok(json!({
                "key": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    drop(set_stmt);

    for setting in settings {
        let key = setting.get("key").and_then(Value::as_str).unwrap_or("");
        // Kunci koneksi hanya berlaku di perangkat ini. Dulu tombol "Kirim ulang
        // pengaturan lokal" ikut mendorong `turso_database_url` dan
        // `server_api_base_url` ke cloud, lalu perangkat lain menariknya dan bisa
        // diarahkan ke database yang salah saat startup.
        if !key.is_empty() && !sync::is_device_local_setting(key) {
            let _ = sync::enqueue(
                &transaction,
                &client_id,
                "setting",
                "update",
                key,
                &setting,
                None,
            );
            enqueued += 1;
        }
    }

    transaction.commit().map_err(|_| CommandError::internal())?;

    Ok(json!({
        "jumlahDienqueue": enqueued,
        "pesan": format!("{enqueued} data master (Shift, Template ID Card, Instansi, Libur, Pengaturan) berhasil dijadwalkan untuk sinkronisasi ke cloud."),
    }))
}
