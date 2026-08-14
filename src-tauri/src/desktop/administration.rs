use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::{config::DesktopState, models::CommandError, storage, sync};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn revision(transaction: &Transaction<'_>, domain: &str, key: &str) -> Option<i64> {
    transaction
        .query_row(
            "SELECT server_revision FROM desktop_entity_revision WHERE domain = ? AND entity_key = ?;",
            params![domain, key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn rows_as_json(connection: &rusqlite::Connection, sql: &str) -> Result<Value, CommandError> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| CommandError::internal())?;
    let values = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?
        .into_iter()
        .map(|value| serde_json::from_str(&value).unwrap_or(Value::Null))
        .collect();
    Ok(Value::Array(values))
}

pub fn list_corrections(state: &DesktopState, filter: &Value) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let date = text(filter, "tanggal").replace("'", "''");
    let employee = text(filter, "id_karyawan").replace("'", "''");
    rows_as_json(
        &connection,
        &format!(
            r#"
      SELECT json_object(
        'id_koreksi', id_koreksi, 'id_referensi', id_referensi,
        'tanggal', tanggal, 'id_karyawan', id_karyawan, 'nama', nama,
        'divisi', divisi, 'jenis_koreksi', jenis_koreksi,
        'jam_koreksi', COALESCE(jam_koreksi, ''),
        'keterangan_admin', COALESCE(keterangan_admin, ''),
        'status_proses', status_proses, 'timestamp', timestamp,
        'kode_operator', kode_operator
      ) FROM koreksi_admin
      WHERE ('{date}' = '' OR tanggal = '{date}')
        AND ('{employee}' = '' OR id_karyawan = '{employee}')
      ORDER BY id_koreksi DESC;
      "#
        ),
    )
}

fn attendance_json(transaction: &Transaction<'_>, session_id: &str) -> Result<Value, CommandError> {
    let value: String = transaction
        .query_row(
            r#"
      SELECT json_object(
        'tanggal', tanggal, 'id_karyawan', id_karyawan, 'nama', nama,
        'kelas_divisi', kelas_divisi, 'jam_masuk', COALESCE(jam_masuk, ''),
        'jam_pulang', COALESCE(jam_pulang, ''), 'status_kehadiran', status_kehadiran,
        'status_absen', status_absen, 'keterangan', COALESCE(keterangan, ''),
        'sumber', sumber, 'update_terakhir', update_terakhir,
        'menit_terlambat', menit_terlambat, 'menit_datang_awal', menit_datang_awal,
        'jam_kerja', jam_kerja, 'lembur', lembur, 'jam_kerja_kurang', jam_kerja_kurang,
        'id_shift', id_shift, 'bulan', bulan, 'tahun', tahun, 'id_sesi', id_sesi,
        'mode_tugas', mode_tugas, 'id_backup', COALESCE(id_backup, ''),
        'id_karyawan_asal', COALESCE(id_karyawan_asal, ''),
        'tanggal_tugas', COALESCE(tanggal_tugas, '')
      ) FROM absensi_harian WHERE id_sesi = ?;
      "#,
            [session_id],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    serde_json::from_str(&value).map_err(|_| CommandError::internal())
}

pub fn create_correction(
    state: &DesktopState,
    draft: &Value,
    operator: &str,
) -> Result<Value, CommandError> {
    const TYPES: &[&str] = &[
        "Sakit",
        "Izin",
        "Dispen",
        "Alfa",
        "Lupa Absen Masuk",
        "Lupa Absen Pulang",
        "Kendala Sistem - Jam Masuk",
        "Kendala Sistem - Jam Pulang",
        "Terlambat",
    ];
    let date = text(draft, "tanggal");
    let employee_key = text(draft, "id_karyawan");
    let correction_type = text(draft, "jenis_koreksi");
    let correction_time = text(draft, "jam_koreksi");
    let needs_time = !matches!(correction_type, "Sakit" | "Izin" | "Dispen" | "Alfa");
    if date.len() != 10
        || employee_key.is_empty()
        || !TYPES.contains(&correction_type)
        || (needs_time && correction_time.len() != 5)
    {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Data Koreksi Admin tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let event_id = sync::new_event_id(&client_id, "correction", "create");
    let reference = format!(
        "KOR-{}-{}",
        date.replace('-', ""),
        event_id[4..16].to_uppercase()
    );
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let employee = transaction
        .query_row(
            "SELECT id_unik, nama, divisi, id_shift FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;",
            params![employee_key, employee_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| CommandError::new("OPERATIONAL_NOT_FOUND", "Karyawan tidak ditemukan."))?;
    let (employee_id, name, division, shift_id) = employee;
    let session_id = format!(
        "NORMAL-{}-{}-{shift_id}",
        date.replace('-', ""),
        employee_id
    );
    let previous_update: Option<String> = transaction
        .query_row("SELECT update_terakhir FROM absensi_harian WHERE id_sesi = ? OR (id_karyawan = ? AND tanggal = ?) LIMIT 1;", params![session_id, employee_id, date], |row| row.get(0))
        .optional().map_err(|_| CommandError::internal())?;
    let (now, year, month): (String, i64, i64) = transaction.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours'), CAST(substr(?,1,4) AS INTEGER), CAST(substr(?,6,2) AS INTEGER);",
        params![date, date], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| CommandError::internal())?;
    let months = [
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
    let month_name = months
        .get(month.saturating_sub(1) as usize)
        .unwrap_or(&"Januari");
    transaction
        .execute(
            r#"
      INSERT INTO absensi_harian (
        id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk,
        jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
        update_terakhir, id_shift, bulan, tahun, id_sesi, mode_tugas
      ) VALUES (?, ?, ?, ?, ?, '', '', '', '', '-', 'Koreksi Admin', ?, ?, ?, ?, ?, 'NORMAL')
      ON CONFLICT(id_sesi) DO NOTHING;
      "#,
            params![
                sync::new_local_id(),
                date,
                employee_id,
                name,
                division,
                now,
                shift_id,
                month_name,
                year,
                session_id
            ],
        )
        .map_err(|_| CommandError::internal())?;
    let note = if text(draft, "keterangan_admin").is_empty() {
        correction_type
    } else {
        text(draft, "keterangan_admin")
    };
    let mut late = 0_i64;
    let mut early = 0_i64;
    let scan_kind;
    if matches!(correction_type, "Sakit" | "Izin" | "Dispen" | "Alfa") {
        scan_kind = correction_type;
        transaction.execute(
            "UPDATE absensi_harian SET jam_masuk = '', jam_pulang = '', status_kehadiran = ?, status_absen = 'Tidak Hadir', keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?, menit_terlambat = 0, menit_datang_awal = 0, jam_kerja = 0, lembur = 0, jam_kerja_kurang = 0 WHERE id_sesi = ?;",
            params![correction_type, note, now, session_id],
        ).map_err(|_| CommandError::internal())?;
    } else if matches!(
        correction_type,
        "Lupa Absen Masuk" | "Kendala Sistem - Jam Masuk" | "Terlambat"
    ) {
        scan_kind = "Masuk";
        let shift: Option<(String, i64)> = transaction
            .query_row(
                "SELECT jam_masuk, batas_masuk_menit FROM tbl_shift WHERE id_shift = ?;",
                [shift_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        if let Some((start, normal_window)) = shift {
            let to_minutes = |value: &str| {
                value
                    .split(':')
                    .filter_map(|part| part.parse::<i64>().ok())
                    .take(2)
                    .enumerate()
                    .map(|(index, value)| if index == 0 { value * 60 } else { value })
                    .sum::<i64>()
            };
            let arrival = to_minutes(correction_time);
            let start_minutes = to_minutes(&start);
            late = (arrival - start_minutes - normal_window).max(0);
            early = (start_minutes - arrival).max(0);
        }
        let check_in = format!("{date} {correction_time}:00");
        transaction.execute(
            "UPDATE absensi_harian SET jam_masuk = ?, status_kehadiran = 'Hadir', status_absen = CASE WHEN COALESCE(jam_pulang, '') != '' THEN 'Lengkap' ELSE 'Belum Pulang' END, keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ? WHERE id_sesi = ?;",
            params![check_in, note, now, late, early, session_id],
        ).map_err(|_| CommandError::internal())?;
    } else {
        scan_kind = "Pulang";
        let check_out = format!("{date} {correction_time}:00");
        let has_check_in: bool = transaction
            .query_row(
                "SELECT COALESCE(jam_masuk, '') != '' FROM absensi_harian WHERE id_sesi = ?;",
                [&session_id],
                |row| row.get(0),
            )
            .unwrap_or(false);
        transaction.execute(
            "UPDATE absensi_harian SET jam_pulang = ?, status_kehadiran = CASE WHEN ? THEN 'Hadir' ELSE 'Perlu Verifikasi' END, status_absen = CASE WHEN ? THEN 'Lengkap' ELSE 'Perlu Verifikasi' END, keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ? WHERE id_sesi = ?;",
            params![check_out, has_check_in, has_check_in, note, now, session_id],
        ).map_err(|_| CommandError::internal())?;
    }
    let correction_id = sync::new_local_id();
    transaction.execute(
        "INSERT INTO koreksi_admin (id_koreksi, id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi, jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, ?);",
        params![correction_id, reference, date, employee_id, name, division, correction_type, correction_time, note, now, operator],
    ).map_err(|_| CommandError::internal())?;
    let log = json!({
        "timestamp_scan": now, "tanggal_kerja": date,
        "jam_scan": if correction_time.is_empty() { "00:00:00" } else { correction_time },
        "id_karyawan": employee_id, "nama": name, "divisi": division,
        "jenis_scan": scan_kind, "status_proses": "Berhasil",
        "sumber_data": "Koreksi Admin", "catatan_sistem": format!("Koreksi Admin - {correction_type}"),
        "keterangan": note, "menit_terlambat": late, "menit_datang_awal": early,
        "id_referensi": reference, "kode_operator": operator,
    });
    let local_log_id = sync::new_local_id();
    transaction.execute(
        "INSERT INTO log_scan (id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan, menit_terlambat, menit_datang_awal, id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, ?, ?, ?, ?);",
        params![local_log_id, text(&log, "timestamp_scan"), date, text(&log, "jam_scan"), employee_id, name, division, scan_kind, text(&log, "catatan_sistem"), note, late, early, reference, operator],
    ).map_err(|_| CommandError::internal())?;
    let attendance = attendance_json(&transaction, &session_id)?;
    let correction = json!({
        "id_referensi": reference, "tanggal": date, "id_karyawan": employee_id,
        "nama": name, "divisi": division, "jenis_koreksi": correction_type,
        "jam_koreksi": correction_time, "keterangan_admin": note,
        "status_proses": "Sudah Diproses", "timestamp": now, "kode_operator": operator,
    });
    sync::enqueue(
        &transaction,
        &client_id,
        "correction",
        "create",
        &reference,
        &json!({ "correction": correction, "attendance": attendance, "attendanceBaseUpdatedAt": previous_update, "log": log }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(
        json!({ "sukses": true, "pesan": format!("Koreksi admin '{correction_type}' untuk {name} ({employee_id}) berhasil diproses."), "id_referensi": reference }),
    )
}

pub fn list_backups(state: &DesktopState, filter: &Value) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let date = text(filter, "tanggal").replace("'", "''");
    let status = text(filter, "status_tugas").replace("'", "''");
    rows_as_json(
        &connection,
        &format!(
            r#"
      SELECT json_object(
        'id_backup', id_backup, 'tanggal_tugas', tanggal_tugas,
        'id_karyawan_asal', id_karyawan_asal, 'nama_karyawan_asal', nama_karyawan_asal,
        'divisi_asal', divisi_asal, 'id_shift_asal', id_shift_asal,
        'id_karyawan_pengganti', id_karyawan_pengganti,
        'nama_karyawan_pengganti', nama_karyawan_pengganti,
        'divisi_pengganti', divisi_pengganti,
        'id_shift_normal_pengganti', id_shift_normal_pengganti,
        'id_shift_backup', id_shift_backup, 'alasan_backup', COALESCE(alasan_backup, ''),
        'status_tugas', status_tugas, 'kode_operator', kode_operator,
        'waktu_input', waktu_input, 'catatan', COALESCE(catatan, ''),
        'waktu_dibatalkan', COALESCE(waktu_dibatalkan, ''),
        'operator_pembatalan', COALESCE(operator_pembatalan, '')
      ) FROM backup_karyawan WHERE ('{date}' = '' OR tanggal_tugas = '{date}')
        AND ('{status}' = '' OR status_tugas = '{status}') ORDER BY waktu_input DESC;
    "#
        ),
    )
}

pub fn create_backup(
    state: &DesktopState,
    draft: &Value,
    operator: &str,
) -> Result<Value, CommandError> {
    let date = text(draft, "tanggal_tugas");
    let original_key = text(draft, "id_karyawan_asal");
    let replacement_key = text(draft, "id_karyawan_pengganti");
    let backup_shift = draft
        .get("id_shift_backup")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if date.len() != 10
        || original_key.is_empty()
        || replacement_key.is_empty()
        || backup_shift == 0
    {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Data penugasan backup tidak valid.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let event_id = sync::new_event_id(&client_id, "backup", "create");
    let id = format!(
        "BCK-{}-{}",
        date.replace('-', ""),
        event_id[4..14].to_uppercase()
    );
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let employee = |key: &str| -> Result<(String, String, String, i64), CommandError> {
        transaction.query_row(
            "SELECT id_unik, nama, divisi, id_shift FROM master_data WHERE (id_unik = ? OR kode_karyawan = ?) AND status_aktif = 'Aktif' LIMIT 1;",
            params![key, key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|_| CommandError::internal())?.ok_or_else(|| CommandError::new("OPERATIONAL_NOT_FOUND", "Karyawan tidak ditemukan atau nonaktif."))
    };
    let original = employee(original_key)?;
    let replacement = employee(replacement_key)?;
    if original.0 == replacement.0 {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Karyawan asal dan pengganti tidak boleh sama.",
        ));
    }
    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    let reason = if text(draft, "alasan_backup").is_empty() {
        "Penggantian Shift"
    } else {
        text(draft, "alasan_backup")
    };
    let backup = json!({
        "id_backup": id, "tanggal_tugas": date,
        "id_karyawan_asal": original.0, "nama_karyawan_asal": original.1,
        "divisi_asal": original.2, "id_shift_asal": original.3,
        "id_karyawan_pengganti": replacement.0, "nama_karyawan_pengganti": replacement.1,
        "divisi_pengganti": replacement.2, "id_shift_normal_pengganti": replacement.3,
        "id_shift_backup": backup_shift, "alasan_backup": reason, "status_tugas": "Aktif",
        "kode_operator": operator, "waktu_input": now, "catatan": text(draft, "catatan"),
        "waktu_dibatalkan": "", "operator_pembatalan": "",
    });
    transaction.execute(
        "INSERT INTO backup_karyawan (id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal, divisi_asal, id_shift_asal, id_karyawan_pengganti, nama_karyawan_pengganti, divisi_pengganti, id_shift_normal_pengganti, id_shift_backup, alasan_backup, status_tugas, kode_operator, waktu_input, catatan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', ?, ?, ?);",
        params![id, date, original.0, original.1, original.2, original.3, replacement.0, replacement.1, replacement.2, replacement.3, backup_shift, reason, operator, now, text(draft, "catatan")],
    ).map_err(|error| CommandError::new("OPERATIONAL_CONFLICT", format!("Penugasan backup tidak dapat disimpan: {error}")))?;
    sync::enqueue(
        &transaction,
        &client_id,
        "backup",
        "create",
        &id,
        &json!({ "backup": backup }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(
        json!({ "sukses": true, "pesan": format!("Penugasan backup {} menggantikan {} berhasil dibuat.", replacement.1, original.1), "id_backup": id }),
    )
}

pub fn cancel_backup(
    state: &DesktopState,
    id: &str,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let current_revision = revision(&transaction, "backup", id);
    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    let changed = transaction.execute(
        "UPDATE backup_karyawan SET status_tugas = 'Dibatalkan', waktu_dibatalkan = ?, operator_pembatalan = ? WHERE id_backup = ? AND status_tugas = 'Aktif';",
        params![now, operator, id],
    ).map_err(|_| CommandError::internal())?;
    if changed == 0 {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Penugasan backup aktif tidak ditemukan.",
        ));
    }
    sync::enqueue(
        &transaction,
        &client_id,
        "backup",
        "cancel",
        id,
        &json!({ "id_backup": id, "waktu_dibatalkan": now, "operator_pembatalan": operator }),
        current_revision,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": format!("Penugasan backup '{id}' berhasil dibatalkan.") }))
}

pub fn import_offline(
    state: &DesktopState,
    rows: &[Value],
    operator: &str,
) -> Result<Value, CommandError> {
    if rows.is_empty() || rows.len() > 500 {
        return Err(CommandError::new(
            "OPERATIONAL_VALIDATION_FAILED",
            "Import harus berisi 1 sampai 500 baris.",
        ));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut results = Vec::new();
    for row in rows {
        let date = text(row, "tanggal");
        let employee_key = text(row, "id_unik");
        let check_in_time = text(row, "jam_masuk");
        let check_out_time = text(row, "jam_pulang");
        let event_id = sync::new_event_id(&client_id, "offline-import", "row");
        let event_key = format!("IMP-{}", event_id[4..20].to_uppercase());
        let mut connection = storage::database(&state.data_dir)?;
        let transaction = connection
            .transaction()
            .map_err(|_| CommandError::internal())?;
        let process = (|| -> Result<Value, CommandError> {
            if date.len() != 10
                || employee_key.is_empty()
                || (check_in_time.is_empty() && check_out_time.is_empty())
            {
                return Err(CommandError::new(
                    "OPERATIONAL_VALIDATION_FAILED",
                    "Tanggal, ID, atau jam import tidak valid.",
                ));
            }
            let employee = transaction
                .query_row(
                    "SELECT id_unik, nama, divisi, id_shift FROM master_data WHERE (id_unik = ? OR kode_karyawan = ?) AND status_aktif = 'Aktif' LIMIT 1;",
                    params![employee_key, employee_key],
                    |result| Ok((result.get::<_, String>(0)?, result.get::<_, String>(1)?, result.get::<_, String>(2)?, result.get::<_, i64>(3)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?
                .ok_or_else(|| CommandError::new("OPERATIONAL_NOT_FOUND", "Karyawan tidak ditemukan atau nonaktif."))?;
            let (id, default_name, default_division, normal_shift) = employee;
            let name = if text(row, "nama").is_empty() {
                default_name
            } else {
                text(row, "nama").to_owned()
            };
            let division = if text(row, "divisi").is_empty() {
                default_division
            } else {
                text(row, "divisi").to_owned()
            };
            let backup = transaction.query_row(
                "SELECT id_backup, id_karyawan_asal, id_karyawan_pengganti, id_shift_backup FROM backup_karyawan WHERE tanggal_tugas = ? AND status_tugas = 'Aktif' AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) LIMIT 1;",
                params![date, id, id], |result| Ok((result.get::<_, String>(0)?, result.get::<_, String>(1)?, result.get::<_, String>(2)?, result.get::<_, i64>(3)?)),
            ).optional().map_err(|_| CommandError::internal())?;
            if backup.as_ref().is_some_and(|value| value.1 == id) {
                return Err(CommandError::new(
                    "OPERATIONAL_CONFLICT",
                    "Import ditolak karena karyawan sedang digantikan.",
                ));
            }
            let (mode, backup_id, original_id, shift_id) = backup
                .map(|value| ("PENGGANTI", value.0, value.1, value.3))
                .unwrap_or(("NORMAL", String::new(), String::new(), normal_shift));
            let session_id = if mode == "PENGGANTI" {
                format!("{backup_id}-PENGGANTI-{id}")
            } else {
                format!("NORMAL-{}-{id}-{shift_id}", date.replace('-', ""))
            };
            let previous = transaction
                .query_row(
                    "SELECT update_terakhir, sumber FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
                    [&session_id],
                    |result| Ok((result.get::<_, String>(0)?, result.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?;
            if previous
                .as_ref()
                .is_some_and(|value| value.1 == "Koreksi Admin")
            {
                return Err(CommandError::new(
                    "OPERATIONAL_CONFLICT",
                    "Data sudah dikoreksi admin; import tidak boleh menimpa.",
                ));
            }
            let now: String = transaction
                .query_row(
                    "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
                    [],
                    |result| result.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            let check_in = if check_in_time.is_empty() {
                String::new()
            } else {
                format!(
                    "{date} {}",
                    if check_in_time.len() == 5 {
                        format!("{check_in_time}:00")
                    } else {
                        check_in_time.to_owned()
                    }
                )
            };
            let out_date: String = if !check_in_time.is_empty()
                && !check_out_time.is_empty()
                && check_out_time < check_in_time
            {
                transaction
                    .query_row("SELECT date(?, '+1 day');", [date], |result| result.get(0))
                    .map_err(|_| CommandError::internal())?
            } else {
                date.to_owned()
            };
            let check_out = if check_out_time.is_empty() {
                String::new()
            } else {
                format!(
                    "{out_date} {}",
                    if check_out_time.len() == 5 {
                        format!("{check_out_time}:00")
                    } else {
                        check_out_time.to_owned()
                    }
                )
            };
            let shift = transaction.query_row("SELECT jam_kerja_normal_menit, istirahat_menit FROM tbl_shift WHERE id_shift = ?;", [shift_id], |result| Ok((result.get::<_, i64>(0)?, result.get::<_, i64>(1)?))).unwrap_or((480, 60));
            let total: i64 = if !check_in.is_empty() && !check_out.is_empty() {
                transaction
                    .query_row(
                        "SELECT MAX(0, CAST((julianday(?) - julianday(?)) * 1440 AS INTEGER));",
                        params![check_out, check_in],
                        |result| result.get(0),
                    )
                    .unwrap_or_default()
            } else {
                0
            };
            let worked = if total > 0 {
                (total - shift.1).max(0)
            } else {
                0
            };
            let attendance_status = if text(row, "status_kehadiran").is_empty() {
                "Hadir"
            } else {
                text(row, "status_kehadiran")
            };
            let record_status = if !text(row, "status_absen").is_empty() {
                text(row, "status_absen")
            } else if !check_in.is_empty() && !check_out.is_empty() {
                "Lengkap"
            } else if !check_in.is_empty() {
                "Belum Pulang"
            } else {
                "Perlu Verifikasi"
            };
            let (year, month): (i64, i64) = transaction
                .query_row(
                    "SELECT CAST(substr(?,1,4) AS INTEGER), CAST(substr(?,6,2) AS INTEGER);",
                    params![date, date],
                    |result| Ok((result.get(0)?, result.get(1)?)),
                )
                .map_err(|_| CommandError::internal())?;
            let months = [
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
            transaction.execute(
                "INSERT INTO absensi_harian (id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, sumber, update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Import Offline', ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id_sesi) DO UPDATE SET jam_masuk = CASE WHEN excluded.jam_masuk != '' THEN excluded.jam_masuk ELSE absensi_harian.jam_masuk END, jam_pulang = CASE WHEN excluded.jam_pulang != '' THEN excluded.jam_pulang ELSE absensi_harian.jam_pulang END, status_kehadiran = excluded.status_kehadiran, status_absen = excluded.status_absen, keterangan = excluded.keterangan, sumber = 'Import Offline', update_terakhir = excluded.update_terakhir, jam_kerja = excluded.jam_kerja, lembur = excluded.lembur, jam_kerja_kurang = excluded.jam_kerja_kurang;",
                params![sync::new_local_id(), date, id, name, division, check_in, check_out, attendance_status, record_status, text(row, "keterangan"), now, worked, (worked - shift.0).max(0), if total > 0 { (shift.0 - worked).max(0) } else { 0 }, shift_id, months.get(month.saturating_sub(1) as usize).unwrap_or(&"Januari"), year, session_id, mode, backup_id, original_id, date],
            ).map_err(|_| CommandError::internal())?;
            let attendance = attendance_json(&transaction, &session_id)?;
            let mut logs = Vec::new();
            for (kind, value) in [("Masuk", check_in.as_str()), ("Pulang", check_out.as_str())] {
                if value.is_empty() {
                    continue;
                }
                let log = json!({ "timestamp_scan": now, "tanggal_kerja": date, "jam_scan": &value[11..], "id_karyawan": id, "nama": name, "divisi": division, "jenis_scan": kind, "status_proses": "Berhasil", "sumber_data": "Import Offline", "catatan_sistem": if backup_id.is_empty() { "Import Offline".to_owned() } else { format!("Import Offline sebagai karyawan pengganti. ID Backup: {backup_id}") }, "keterangan": text(row, "keterangan"), "menit_terlambat": 0, "menit_datang_awal": 0, "id_referensi": backup_id, "kode_operator": operator });
                transaction.execute("INSERT INTO log_scan (id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan, menit_terlambat, menit_datang_awal, id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Import Offline', ?, ?, 0, 0, ?, ?);", params![sync::new_local_id(), now, date, &value[11..], id, name, division, kind, text(&log, "catatan_sistem"), text(row, "keterangan"), backup_id, operator]).map_err(|_| CommandError::internal())?;
                logs.push(log);
            }
            let import = json!({ "event_key": event_key, "timestamp_input": now, "tanggal": date, "id_unik": id, "nama": name, "divisi": division, "jam_masuk": check_in_time, "jam_pulang": check_out_time, "status_kehadiran": attendance_status, "status_absen": record_status, "keterangan": text(row, "keterangan"), "status_proses": "Sudah Diproses", "diproses_pada": now, "pesan_error": "", "kode_operator": operator });
            transaction.execute("INSERT INTO import_offline (id_import, event_key, timestamp_input, tanggal, id_unik, nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, status_proses, diproses_pada, pesan_error, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, '', ?);", params![sync::new_local_id(), event_key, now, date, id, name, division, check_in_time, check_out_time, attendance_status, record_status, text(row, "keterangan"), now, operator]).map_err(|_| CommandError::internal())?;
            sync::enqueue(
                &transaction,
                &client_id,
                "offline-import",
                "row",
                &event_key,
                &json!({ "import": import, "attendance": attendance, "attendanceBaseUpdatedAt": previous.map(|value| value.0), "logs": logs }),
                None,
            )?;
            Ok(
                json!({ "sukses": true, "pesan": format!("Import {id} berhasil diproses."), "eventKey": event_key }),
            )
        })();
        match process {
            Ok(result) => {
                transaction.commit().map_err(|_| CommandError::internal())?;
                results.push(result);
            }
            Err(error) => {
                let _ = transaction.rollback();
                results.push(json!({ "sukses": false, "pesan": error.message }));
            }
        }
    }
    let success = results
        .iter()
        .filter(|value| value.get("sukses").and_then(Value::as_bool) == Some(true))
        .count();
    Ok(
        json!({ "sukses": success > 0, "berhasil": success, "gagal": results.len() - success, "results": results }),
    )
}

pub fn dashboard_data(
    state: &DesktopState,
    kind: &str,
    filter: &Value,
) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    if kind == "metrics" {
        let value: String = connection.query_row(
            r#"
      SELECT json_object(
        'totalKaryawan', (SELECT COUNT(*) FROM master_data WHERE status_aktif = 'Aktif'),
        'hadirHariIni', COALESCE(SUM(CASE WHEN status_kehadiran = 'Hadir' THEN 1 ELSE 0 END), 0),
        'terlambatHariIni', COALESCE(SUM(CASE WHEN menit_terlambat > 0 THEN 1 ELSE 0 END), 0),
        'sakitIzinHariIni', COALESCE(SUM(CASE WHEN status_kehadiran IN ('Sakit','Izin','Dispen') THEN 1 ELSE 0 END), 0),
        'alfaHariIni', COALESCE(SUM(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END), 0),
        'persentaseKehadiran', CASE WHEN (SELECT COUNT(*) FROM master_data WHERE status_aktif = 'Aktif') > 0
          THEN ROUND(100.0 * SUM(CASE WHEN status_kehadiran = 'Hadir' THEN 1 ELSE 0 END) /
            (SELECT COUNT(*) FROM master_data WHERE status_aktif = 'Aktif')) ELSE 0 END
      ) FROM absensi_harian WHERE tanggal = date('now','+7 hours');
      "#,
            [], |row| row.get(0),
        ).map_err(|_| CommandError::internal())?;
        return serde_json::from_str(&value).map_err(|_| CommandError::internal());
    }
    let division = text(filter, "divisi").replace("'", "''");
    if kind == "scan-history" {
        let date = if text(filter, "tanggal").is_empty() {
            connection
                .query_row("SELECT date('now','+7 hours');", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|_| CommandError::internal())?
        } else {
            text(filter, "tanggal").replace("'", "''")
        };
        let search = text(filter, "search").replace("'", "''");
        let limit = filter
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(200)
            .clamp(1, 500);
        let offset = filter
            .get("offset")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        return rows_as_json(
            &connection,
            &format!(
                r#"
          SELECT json_object('id_log', id_log, 'timestamp_scan', timestamp_scan,
            'tanggal_kerja', tanggal_kerja, 'jam_scan', jam_scan,
            'id_karyawan', id_karyawan, 'nama', nama, 'divisi', divisi,
            'jenis_scan', jenis_scan, 'status_proses', status_proses,
            'sumber_data', sumber_data, 'catatan_sistem', COALESCE(catatan_sistem,''),
            'keterangan', COALESCE(keterangan,''), 'kode_operator', COALESCE(kode_operator,''))
          FROM log_scan WHERE tanggal_kerja = '{date}'
            AND ('{search}' = '' OR nama LIKE '%{search}%' OR id_karyawan LIKE '%{search}%'
              OR divisi LIKE '%{search}%')
          ORDER BY timestamp_scan DESC, id_log DESC LIMIT {limit} OFFSET {offset};
        "#
            ),
        );
    }
    if kind == "daily" {
        let date = if text(filter, "tanggal").is_empty() {
            connection
                .query_row("SELECT date('now','+7 hours');", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|_| CommandError::internal())?
        } else {
            text(filter, "tanggal").replace("'", "''")
        };
        return rows_as_json(
            &connection,
            &format!(
                r#"
          SELECT json_object('id_absensi', a.id_absensi, 'tanggal', a.tanggal,
            'id_karyawan', a.id_karyawan, 'nama', a.nama, 'kelas_divisi', a.kelas_divisi,
            'jam_masuk', COALESCE(a.jam_masuk,''), 'jam_pulang', COALESCE(a.jam_pulang,''),
            'status_kehadiran', a.status_kehadiran, 'status_absen', a.status_absen,
            'keterangan', COALESCE(a.keterangan,''), 'sumber', a.sumber,
            'menit_terlambat', a.menit_terlambat, 'jam_kerja', a.jam_kerja,
            'lembur', a.lembur, 'kode_karyawan', COALESCE(m.kode_karyawan,''),
            'nama_shift', COALESCE(s.nama_shift,''))
          FROM absensi_harian a LEFT JOIN master_data m ON a.id_karyawan = m.id_unik
          LEFT JOIN tbl_shift s ON a.id_shift = s.id_shift WHERE a.tanggal = '{date}'
          AND ('{division}' = '' OR a.kelas_divisi = '{division}') ORDER BY a.nama;
        "#
            ),
        );
    }
    if kind == "monthly" {
        let month = text(filter, "bulan").replace("'", "''");
        let year = filter
            .get("tahun")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| {
                connection
                    .query_row(
                        "SELECT CAST(strftime('%Y','now','+7 hours') AS INTEGER);",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or_default()
            });
        let month_clause = if month.is_empty() {
            "bulan = CASE strftime('%m','now','+7 hours') WHEN '01' THEN 'Januari' WHEN '02' THEN 'Februari' WHEN '03' THEN 'Maret' WHEN '04' THEN 'April' WHEN '05' THEN 'Mei' WHEN '06' THEN 'Juni' WHEN '07' THEN 'Juli' WHEN '08' THEN 'Agustus' WHEN '09' THEN 'September' WHEN '10' THEN 'Oktober' WHEN '11' THEN 'November' ELSE 'Desember' END".to_owned()
        } else {
            format!("bulan = '{month}'")
        };
        return rows_as_json(
            &connection,
            &format!(
                r#"
          SELECT json_object('idKaryawan', id_karyawan, 'nama', nama,
            'divisi', kelas_divisi, 'totalHadir', SUM(CASE WHEN status_kehadiran='Hadir' THEN 1 ELSE 0 END),
            'totalTerlambat', SUM(menit_terlambat), 'frekuensiTelat', SUM(CASE WHEN menit_terlambat>0 THEN 1 ELSE 0 END),
            'totalSakit', SUM(CASE WHEN status_kehadiran='Sakit' THEN 1 ELSE 0 END),
            'totalIzin', SUM(CASE WHEN status_kehadiran='Izin' THEN 1 ELSE 0 END),
            'totalDispen', SUM(CASE WHEN status_kehadiran='Dispen' THEN 1 ELSE 0 END),
            'totalAlfa', SUM(CASE WHEN status_kehadiran='Alfa' THEN 1 ELSE 0 END),
            'totalJamKerja', ROUND(SUM(jam_kerja)/60.0,1), 'totalLembur', ROUND(SUM(lembur)/60.0,1))
          FROM absensi_harian WHERE {month_clause} AND tahun = {year}
            AND ('{division}' = '' OR kelas_divisi = '{division}') GROUP BY id_karyawan ORDER BY nama;
        "#
            ),
        );
    }
    if kind == "top" {
        let limit = filter
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(5)
            .clamp(1, 50);
        return rows_as_json(
            &connection,
            &format!(
                r#"
          SELECT json_object('id_karyawan', id_karyawan, 'nama', nama,
            'divisi', kelas_divisi, 'total_kehadiran', COUNT(*),
            'total_telat', SUM(menit_terlambat)) FROM absensi_harian
          WHERE status_kehadiran = 'Hadir' GROUP BY id_karyawan
          ORDER BY COUNT(*) DESC, SUM(menit_terlambat) ASC LIMIT {limit};
        "#
            ),
        );
    }
    Err(CommandError::new(
        "OPERATIONAL_VALIDATION_FAILED",
        "Jenis data dashboard tidak dikenali.",
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use reqwest::Client;
    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::{dashboard_data, storage, DesktopState};

    fn fixture() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("temporary directory");
        storage::initialize(directory.path()).expect("local schema");
        let connection = storage::database(directory.path()).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          jam_kerja_normal_menit, istirahat_menit
        ) VALUES (1, 1, 'Shift Pagi', '07:00', '15:00', 420, 60);
        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif
        ) VALUES ('K001', 'K001', 'Karyawan Test', 'Dapur', 1, 'Aktif');
        INSERT INTO absensi_harian (
          tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
          status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
          menit_terlambat, menit_datang_awal, jam_kerja, lembur,
          jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas,
          id_backup, id_karyawan_asal, tanggal_tugas
        ) VALUES (
          '2026-08-12', 'K001', 'Karyawan Test', 'Dapur',
          '2026-08-12 07:00:00', '2026-08-12 16:00:00', 'Hadir', 'Lengkap',
          'Pulang Lembur', 'Scanner', '2026-08-12 16:00:00', 0, 0,
          420, 60, 0, 1, 'Agustus', 2026, 'NORMAL-20260812-K001-1',
          'NORMAL', '', '', '2026-08-12'
        );
        INSERT INTO log_scan (
          timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi,
          jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan,
          menit_terlambat, menit_datang_awal, id_referensi, kode_operator
        ) VALUES (
          '2026-08-13 00:30:00', '2026-08-12', '00:30:00', 'K001',
          'Karyawan Test', 'Dapur', 'Pulang', 'Berhasil', 'Scanner',
          'Pulang shift malam', 'Pulang Lembur', 0, 0, '', 'SPD001'
        );
        "#,
            )
            .expect("dashboard seed");
        let state = DesktopState {
            api_base_url: Url::parse("http://localhost:3000").expect("url"),
            server_origin: "http://localhost:3000".into(),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: Client::new(),
            session: Mutex::new(None),
            vault_lock: Mutex::new(()),
        };
        (directory, state)
    }

    #[test]
    fn dashboard_reads_status_minutes_and_work_date_without_reinterpreting_them() {
        let (_directory, state) = fixture();
        let daily = dashboard_data(&state, "daily", &json!({"tanggal": "2026-08-12"}))
            .expect("daily report");
        let daily_row = daily
            .as_array()
            .and_then(|rows| rows.first())
            .expect("daily row");
        assert_eq!(daily_row["status_absen"], "Lengkap");
        assert_eq!(daily_row["jam_kerja"], 420);
        assert_eq!(daily_row["lembur"], 60);

        let monthly = dashboard_data(
            &state,
            "monthly",
            &json!({"bulan": "Agustus", "tahun": 2026}),
        )
        .expect("monthly report");
        let monthly_row = monthly
            .as_array()
            .and_then(|rows| rows.first())
            .expect("monthly row");
        assert_eq!(monthly_row["totalJamKerja"], 7.0);
        assert_eq!(monthly_row["totalLembur"], 1.0);

        let history = dashboard_data(&state, "scan-history", &json!({"tanggal": "2026-08-12"}))
            .expect("scan history");
        let history_row = history
            .as_array()
            .and_then(|rows| rows.first())
            .expect("history row");
        assert_eq!(history_row["tanggal_kerja"], "2026-08-12");
        assert_eq!(history_row["timestamp_scan"], "2026-08-13 00:30:00");
    }
}
