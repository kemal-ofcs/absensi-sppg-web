use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::{config::DesktopState, models::CommandError, storage, sync};

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
        c.idcard_status, c.idcard_pdf_url, c.link_qr_png
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
    payload.insert("token_absensi".into(), Value::String(token.clone()));
    payload.insert("qr_code".into(), Value::String(qr_code.clone()));
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
      INSERT OR IGNORE INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate)
      VALUES (?, ?, ?, 'Belum', ?);
      "#,
            params![id, name, division, today],
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

pub fn import_employees(
    state: &DesktopState,
    drafts: &[Value],
) -> Result<Value, CommandError> {
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

        if id.is_empty() || code.is_empty() || name.len() < 2 || division.is_empty() || shift_id == 0 {
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
        let reg_date = if reg_date.is_empty() { &today } else { reg_date };

        let start_date = text(draft, "tanggal_mulai_aktif");
        let start_date = if start_date.is_empty() { reg_date } else { start_date };

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
                if text(draft, "jabatan_status").is_empty() { "Staff" } else { text(draft, "jabatan_status") },
                text(draft, "no_hp"),
                if text(draft, "lp").to_uppercase() == "P" { "P" } else { "L" },
                shift_id,
                if text(draft, "status_aktif") == "Nonaktif" { "Nonaktif" } else { "Aktif" },
                reg_date,
                text(draft, "catatan"),
                token,
                qr_code,
                if text(draft, "jenis_personil").is_empty() { "Pegawai" } else { text(draft, "jenis_personil") },
                start_date,
                text(draft, "tanggal_selesai_aktif"),
            ],
        );

        if insert_res.is_err() {
            dilewati += 1;
            continue;
        }

        let _ = transaction.execute(
            "INSERT OR IGNORE INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) VALUES (?, ?, ?, 'Belum', ?);",
            params![id, name, division, reg_date],
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
    transaction
        .execute(
            r#"
      UPDATE master_data SET
        kode_karyawan = ?, nama = ?, divisi = ?, jabatan_status = ?, no_hp = ?,
        lp = ?, id_shift = ?, status_aktif = ?, catatan = ?
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
                text(draft, "status_aktif"),
                text(draft, "catatan"),
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

    sync::enqueue(
        &transaction,
        &client_id,
        "employee",
        "update",
        id,
        draft,
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
                "SELECT id_unik FROM master_data WHERE token_absensi IS NULL OR token_absensi = '';",
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
            &json!({ "token_absensi": token, "qr_code": qr_code }),
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
        super::time_policy::calculate_normal_work_minutes(start, end, break_min, ontime)
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
                || v.as_str().map(|s| s == "1" || s.eq_ignore_ascii_case("true")).unwrap_or(false)
        })
        .unwrap_or(false)
    {
        1
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
        izinkan_multi_sesi
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
        super::time_policy::calculate_normal_work_minutes(start, end, break_min, ontime)
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
                || v.as_str().map(|s| s == "1" || s.eq_ignore_ascii_case("true")).unwrap_or(false)
        })
        .unwrap_or(false)
    {
        1
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
        izinkan_multi_sesi = ?
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
                id,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    sync::enqueue(
        &transaction,
        &client_id,
        "shift",
        "update",
        &id.to_string(),
        draft,
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
        "SELECT c.id_card_id, m.id_unik, m.nama, m.divisi, COALESCE(c.idcard_status, 'Belum'), c.idcard_pdf_url, c.idcard_last_generate, c.idcard_catatan, c.tanggal_generate, c.link_qr_png, m.kode_karyawan, m.status_aktif, m.token_absensi, m.qr_code FROM master_data m LEFT JOIN id_card c ON c.id_unik = m.id_unik ORDER BY m.nama;"
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
    let connection = storage::database(&state.data_dir)?;
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
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![key, value],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
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
    let connection = storage::database(&state.data_dir)?;
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
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![key, value],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
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
            "INSERT OR IGNORE INTO id_card (id_unik, nama, divisi, idcard_status, tanggal_generate) SELECT id_unik, nama, divisi, 'Belum', ? FROM master_data WHERE id_unik = ?;",
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
    } else {
        input.trim()
    };
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &b in clean.as_bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

pub fn save_desktop_file(filename: &str, base64_data: &str) -> Result<Value, CommandError> {
    let bytes = decode_base64(base64_data).ok_or_else(|| {
        CommandError::new("DESKTOP_SAVE_FAILED", "Format base64 file tidak valid.")
    })?;

    let download_dir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(|p| std::path::PathBuf::from(p).join("Downloads"))
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());

    if !download_dir.exists() {
        let _ = std::fs::create_dir_all(&download_dir);
    }

    let sanitized_filename = filename.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let target_path = download_dir.join(&sanitized_filename);

    std::fs::write(&target_path, &bytes).map_err(|e| {
        CommandError::new("DESKTOP_SAVE_FAILED", &format!("Gagal menulis file: {}", e))
    })?;

    Ok(json!({
        "sukses": true,
        "path": target_path.to_string_lossy().to_string(),
        "filename": sanitized_filename
    }))
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
    let jenis_libur = if draft.get("jenis_libur").is_some() && !text(draft, "jenis_libur").is_empty() {
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
            format!("Tanggal libur {tanggal} sudah terdaftar. Silakan edit jika ingin mengubahnya."),
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
    let jenis_libur = if draft.get("jenis_libur").is_some() && !text(draft, "jenis_libur").is_empty() {
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

    let sync_payload = json!({
        "key": "auto_alfa_aktif",
        "value": str_val,
    });
    let revision = base_revision(&transaction, "setting", "auto_alfa_aktif");
    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "upsert",
        "auto_alfa_aktif",
        &sync_payload,
        revision,
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

pub fn generate_alfa_harian(state: &DesktopState, simulated_time: Option<String>) -> Result<Value, CommandError> {
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
    let is_active = is_active_val.map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(true);
    if !is_active {
        return Ok(json!({
            "jumlahAlfaDibuat": 0,
            "jumlahSudahAda": 0,
            "jumlahBelumWaktunya": 0,
            "jumlahFleksibel": 0,
            "jumlahNonaktif": 0,
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

    let now_minute = parse_time_to_minutes(&now_moment.time);

    let month_names = [
        "Januari", "Februari", "Maret", "April", "Mei", "Juni",
        "Juli", "Agustus", "September", "Oktober", "November", "Desember"
    ];

    for (id_unik, nama, divisi, id_shift) in employees {
        let shift_config: Option<(String, String, i64, i64, i64)> = transaction
            .query_row(
                "SELECT jam_masuk, jam_pulang, COALESCE(offset_generate_alfa, 180), COALESCE(jam_kerja_normal_menit, 0), kode_shift FROM tbl_shift WHERE id_shift = ?;",
                [id_shift],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .unwrap_or(None);

        let (jam_masuk, jam_pulang, offset_alfa, jam_kerja_normal, kode_shift) = match shift_config {
            Some(cfg) => cfg,
            None => continue,
        };

        if kode_shift == 4
            || (jam_masuk == "00:00" && jam_pulang == "23:59")
            || jam_kerja_normal == 0
        {
            fleksibel += 1;
            continue;
        }

        let shift_in_min = parse_time_to_minutes(&jam_masuk);
        let shift_out_min = parse_time_to_minutes(&jam_pulang);
        let is_overnight = shift_out_min < shift_in_min;

        let mut work_date = now_moment.date.clone();
        if is_overnight && now_minute < shift_in_min {
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
            continue;
        }

        let cutoff_timeline_minute = if is_overnight {
            shift_out_min + 1440 - offset_alfa
        } else {
            shift_out_min - offset_alfa
        };

        let current_timeline_minute = match super::time_policy::days_between(&work_date, &now_moment.date) {
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
        let tahun = work_date.get(0..4).and_then(|y| y.parse::<i64>().ok()).unwrap_or(2026);

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
                    format!("Generate Alfa Selesai. Dibuat: {alfa_dibuat}, Sudah Ada: {sudah_ada}, Belum Waktunya: {belum_waktunya}"),
                )
            } else {
                (
                    "IDLE",
                    format!("Generate Alfa Selesai. Dibuat: {alfa_dibuat}, Sudah Ada: {sudah_ada}, Belum Waktunya: {belum_waktunya}"),
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
        "status": status,
        "pesan": pesan
    }))
}
