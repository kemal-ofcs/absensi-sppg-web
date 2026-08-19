use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::{config::DesktopState, models::CommandError, storage, sync};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

fn normalize_date(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() == 10 {
        let parts: Vec<&str> = raw.split('/').collect();
        if parts.len() == 3 && parts[0].len() == 2 && parts[1].len() == 2 && parts[2].len() == 4 {
            return format!("{}-{}-{}", parts[2], parts[1], parts[0]);
        }
        let parts_dash: Vec<&str> = raw.split('-').collect();
        if parts_dash.len() == 3 && parts_dash[0].len() == 2 && parts_dash[1].len() == 2 && parts_dash[2].len() == 4 {
            return format!("{}-{}-{}", parts_dash[2], parts_dash[1], parts_dash[0]);
        }
    }
    raw.to_owned()
}

fn clean_time(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 19 && s.chars().nth(10) == Some(' ') {
        s[11..].to_string()
    } else if s.len() >= 16 && s.chars().nth(10) == Some(' ') {
        s[11..].to_string()
    } else {
        s.to_string()
    }
}

fn parse_time_min(raw: &str) -> Option<i64> {
    let clean = if raw.contains(' ') {
        raw.split(' ').nth(1).unwrap_or(raw)
    } else if raw.contains('T') {
        raw.split('T').nth(1).unwrap_or(raw)
    } else {
        raw
    };
    let parts: Vec<&str> = clean.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let h = parts[0].parse::<i64>().ok()?;
    let m = parts[1].parse::<i64>().ok()?;
    Some(h * 60 + m)
}

fn format_date_time_str(date_str: &str, time_str: &str) -> String {
    let clean_time = if time_str.contains(' ') {
        time_str.split(' ').nth(1).unwrap_or(time_str)
    } else if time_str.contains('T') {
        time_str.split('T').nth(1).unwrap_or(time_str)
    } else {
        time_str
    };
    if clean_time.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = clean_time.split(':').collect();
    if parts.len() < 2 {
        return String::new();
    }
    let h = parts[0].parse::<i64>().unwrap_or(0);
    let m = parts[1].parse::<i64>().unwrap_or(0);
    let s = if parts.len() >= 3 {
        parts[2].parse::<i64>().unwrap_or(0)
    } else {
        0
    };
    format!("{date_str} {h:02}:{m:02}:{s:02}")
}

fn time_matches_shift_window(
    time_str: &str,
    jam_masuk: &str,
    jam_pulang: &str,
    is_check_in: bool,
    awal_absen: i64,
    batas_masuk: i64,
    toleransi: i64,
    batas_pulang: i64,
) -> bool {
    let parse_min = |v: &str| -> i64 {
        let clean = if v.contains(' ') {
            v.split(' ').nth(1).unwrap_or(v)
        } else if v.contains('T') {
            v.split('T').nth(1).unwrap_or(v)
        } else {
            v
        };
        clean
            .split(':')
            .filter_map(|p| p.parse::<i64>().ok())
            .take(2)
            .enumerate()
            .map(|(idx, val)| if idx == 0 { val * 60 } else { val })
            .sum()
    };
    if time_str.is_empty() {
        return false;
    }
    let user_min = parse_min(time_str);
    if is_check_in {
        let shift_in = parse_min(jam_masuk);
        let mut diff = user_min - shift_in;
        if diff < -720 {
            diff += 1440;
        }
        if diff > 720 {
            diff -= 1440;
        }
        diff >= -awal_absen && diff <= (batas_masuk + toleransi)
    } else {
        let shift_out = parse_min(jam_pulang);
        let mut diff = user_min - shift_out;
        if diff < -720 {
            diff += 1440;
        }
        if diff > 720 {
            diff -= 1440;
        }
        diff >= -120 && diff <= batas_pulang
    }
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

pub fn list_imports(state: &DesktopState, filter: &Value) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let date = text(filter, "tanggal").replace("'", "''");
    let employee = text(filter, "id_karyawan").replace("'", "''");
    let search = text(filter, "search").replace("'", "''");
    rows_as_json(
        &connection,
        &format!(
            r#"
      SELECT json_object(
        'id_import', id_import, 'event_key', event_key,
        'timestamp_input', timestamp_input, 'tanggal', tanggal,
        'id_unik', id_unik, 'nama', COALESCE(nama, ''),
        'divisi', COALESCE(divisi, ''),
        'jam_masuk', COALESCE(jam_masuk, ''),
        'jam_pulang', COALESCE(jam_pulang, ''),
        'status_kehadiran', COALESCE(status_kehadiran, ''),
        'status_absen', COALESCE(status_absen, ''),
        'keterangan', COALESCE(keterangan, ''),
        'status_proses', status_proses,
        'diproses_pada', COALESCE(diproses_pada, ''),
        'pesan_error', COALESCE(pesan_error, ''),
        'kode_operator', COALESCE(kode_operator, '')
      ) FROM import_offline
      WHERE ('{date}' = '' OR tanggal = '{date}')
        AND ('{employee}' = '' OR id_unik = '{employee}')
        AND ('{search}' = '' OR id_unik LIKE '%{search}%' OR nama LIKE '%{search}%')
      ORDER BY id_import DESC;
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
    let date_raw = text(draft, "tanggal");
    let date = normalize_date(&date_raw);
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
    let (employee_id, name, division, normal_shift) = employee;

    let backup: Option<(String, String, String, i64)> = transaction
        .query_row(
            "SELECT id_backup, id_karyawan_asal, id_karyawan_pengganti, id_shift_backup FROM backup_karyawan WHERE tanggal_tugas = ? AND status_tugas = 'Aktif' AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) LIMIT 1;",
            params![date, employee_id, employee_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    if backup.as_ref().is_some_and(|b| b.1 == employee_id) {
        return Err(CommandError::new(
            "OPERATIONAL_CONFLICT",
            "Koreksi ditolak: Karyawan sedang digantikan oleh karyawan lain.",
        ));
    }

    let (mode, backup_id, original_id, shift_id, session_id) = if let Some(b) = backup {
        let backup_shift_id = b.3;
        let explicit_shift = text(draft, "id_shift").parse::<i64>().ok();
        let explicit_mode = text(draft, "mode_tugas");

        let (m, b_id, o_id, s_id) = if explicit_mode == "PENGGANTI" || explicit_shift == Some(backup_shift_id) {
            ("PENGGANTI".to_owned(), b.0, b.1, backup_shift_id)
        } else if explicit_mode == "NORMAL" || explicit_shift == Some(normal_shift) {
            ("NORMAL".to_owned(), String::new(), String::new(), normal_shift)
        } else {
            let backup_shift_cfg: Option<(String, String, i64, i64, i64, i64)> = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
                    [backup_shift_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                ).optional().unwrap_or(None);
            let normal_shift_cfg: Option<(String, String, i64, i64, i64, i64)> = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
                    [normal_shift],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                ).optional().unwrap_or(None);

            let is_in = matches!(correction_type, "Lupa Absen Masuk" | "Kendala Sistem - Jam Masuk" | "Terlambat");

            let matches_backup = backup_shift_cfg.as_ref().map(|s| {
                time_matches_shift_window(correction_time, &s.0, &s.1, is_in, s.2, s.3, s.4, s.5)
            }).unwrap_or(false);

            let matches_normal = normal_shift_cfg.as_ref().map(|s| {
                time_matches_shift_window(correction_time, &s.0, &s.1, is_in, s.2, s.3, s.4, s.5)
            }).unwrap_or(false);

            if matches_backup && !matches_normal {
                ("PENGGANTI".to_owned(), b.0, b.1, backup_shift_id)
            } else {
                ("NORMAL".to_owned(), String::new(), String::new(), normal_shift)
            }
        };
        let s_id_str = if m == "PENGGANTI" {
            format!("{b_id}-PENGGANTI-{employee_id}")
        } else {
            format!("NORMAL-{}-{employee_id}-{s_id}", date.replace('-', ""))
        };
        (m, b_id, o_id, s_id, s_id_str)
    } else {
        ("NORMAL".to_owned(), String::new(), String::new(), normal_shift, format!("NORMAL-{}-{employee_id}-{normal_shift}", date.replace('-', "")))
    };

    let session_exists: bool = transaction
        .query_row(
            "SELECT 1 FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
            [&session_id],
            |_| Ok(true),
        )
        .optional()
        .unwrap_or(None)
        .unwrap_or(false);

    let is_checkout = matches!(
        correction_type,
        "Lupa Absen Pulang" | "Kendala Sistem - Jam Pulang"
    );

    let (mode, backup_id, original_id, shift_id, session_id, date) = if !session_exists {
        let unclosed: Option<(String, String, i64, String, String, String)> = transaction
            .query_row(
                "SELECT id_sesi, mode_tugas, id_shift, COALESCE(id_backup, ''), COALESCE(id_karyawan_asal, ''), tanggal FROM absensi_harian WHERE id_karyawan = ? AND tanggal = ? AND ((jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '')) OR ((jam_masuk IS NULL OR jam_masuk = '') AND jam_pulang != '')) LIMIT 1;",
                params![employee_id, &date],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        if let Some(u) = unclosed {
            (u.1, u.3, u.4, u.2, u.0, u.5)
        } else if is_checkout {
            let prev_date: String = transaction
                .query_row("SELECT date(?, '-1 day');", [&date], |row| row.get(0))
                .unwrap_or_else(|_| date.clone());
            let unclosed_yesterday: Option<(String, String, i64, String, String, String)> = transaction
                .query_row(
                    "SELECT id_sesi, mode_tugas, id_shift, COALESCE(id_backup, ''), COALESCE(id_karyawan_asal, ''), tanggal FROM absensi_harian WHERE id_karyawan = ? AND tanggal = ? AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') LIMIT 1;",
                    params![employee_id, &prev_date],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?;
            if let Some(uy) = unclosed_yesterday {
                (uy.1, uy.3, uy.4, uy.2, uy.0, uy.5)
            } else {
                (mode, backup_id, original_id, shift_id, session_id, date)
            }
        } else {
            (mode, backup_id, original_id, shift_id, session_id, date)
        }
    } else {
        (mode, backup_id, original_id, shift_id, session_id, date)
    };



    let previous_update: Option<String> = transaction
        .query_row("SELECT update_terakhir FROM absensi_harian WHERE id_sesi = ? LIMIT 1;", [&session_id], |row| row.get(0))
        .optional().map_err(|_| CommandError::internal())?;
    let (now, year, month): (String, i64, i64) = transaction.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours'), CAST(substr(?,1,4) AS INTEGER), CAST(substr(?,6,2) AS INTEGER);",
        params![&date, &date], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
        update_terakhir, id_shift, bulan, tahun, id_sesi, mode_tugas,
        id_backup, id_karyawan_asal, tanggal_tugas
      ) VALUES (?, ?, ?, ?, ?, '', '', '', '', '-', 'Koreksi Admin', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_sesi) DO NOTHING;
      "#,
            params![
                sync::new_local_id(),
                &date,
                employee_id,
                name,
                division,
                now,
                shift_id,
                month_name,
                year,
                session_id,
                mode,
                backup_id,
                original_id,
                if mode == "PENGGANTI" { &date } else { "" }
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
    let shift_config: (String, String, i64, i64, i64, i64, i64, i64) = transaction
        .query_row(
            "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, batas_masuk_menit, awal_absen_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
            [shift_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get::<_, Option<i64>>(6)?.unwrap_or(120), row.get::<_, Option<i64>>(7)?.unwrap_or(240))),
        )
        .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0, 60, 120, 240));

    let to_minutes = |value: &str| {
        let clean = if value.contains(' ') {
            value.split(' ').nth(1).unwrap_or(value)
        } else if value.contains('T') {
            value.split('T').nth(1).unwrap_or(value)
        } else {
            value
        };
        clean
            .split(':')
            .filter_map(|part| part.parse::<i64>().ok())
            .take(2)
            .enumerate()
            .map(|(index, value)| if index == 0 { value * 60 } else { value })
            .sum::<i64>()
    };

    let clean_time = |value: &str| -> String {
        if value.contains(' ') {
            value.split(' ').nth(1).unwrap_or(value).to_owned()
        } else if value.contains('T') {
            value.split('T').nth(1).unwrap_or(value).to_owned()
        } else {
            value.to_owned()
        }
    };

    if matches!(correction_type, "Sakit" | "Izin" | "Dispen" | "Alfa") {
        scan_kind = correction_type;
        transaction.execute(
            "UPDATE absensi_harian SET jam_masuk = '', jam_pulang = '', status_kehadiran = ?, status_absen = 'Tidak Hadir', keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?, menit_terlambat = 0, menit_datang_awal = 0, jam_kerja = 0, lembur = 0, jam_kerja_kurang = 0 WHERE id_sesi = ?;",
            params![correction_type, note, now, session_id],
        ).map_err(|_| CommandError::internal())?;
    } else {
        if matches!(
            correction_type,
            "Lupa Absen Masuk" | "Kendala Sistem - Jam Masuk" | "Terlambat"
        ) {
            let user_in = to_minutes(correction_time);
            let shift_in = to_minutes(&shift_config.0);
            let mut diff = user_in - shift_in;
            if diff < -720 {
                diff += 1440;
            }
            if diff > 720 {
                diff -= 1440;
            }
            if diff < -shift_config.6 || diff > shift_config.5 + shift_config.4 {
                return Err(CommandError::new(
                    "OPERATIONAL_VALIDATION_FAILED",
                    format!(
                        "Jam masuk ({correction_time}) di luar rentang jadwal Shift {shift_id} (Jam Masuk: {}).",
                        shift_config.0
                    ),
                ));
            }
        } else if matches!(
            correction_type,
            "Lupa Absen Pulang" | "Kendala Sistem - Jam Pulang"
        ) {
            let user_out = to_minutes(correction_time);
            let shift_out = to_minutes(&shift_config.1);
            let mut diff = user_out - shift_out;
            if diff < -720 {
                diff += 1440;
            }
            if diff > 720 {
                diff -= 1440;
            }
            if diff < -120 || diff > shift_config.7 {
                return Err(CommandError::new(
                    "OPERATIONAL_VALIDATION_FAILED",
                    format!(
                        "Jam pulang ({correction_time}) di luar rentang jadwal Shift {shift_id} (Jam Pulang: {}).",
                        shift_config.1
                    ),
                ));
            }
        }

        let (current_in, current_out): (String, String) = transaction
            .query_row(
                "SELECT COALESCE(jam_masuk, ''), COALESCE(jam_pulang, '') FROM absensi_harian WHERE id_sesi = ?;",
                [&session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_default();

        let shift_start_min = to_minutes(&shift_config.0);
        let shift_end_min = to_minutes(&shift_config.1);
        let is_overnight_shift = shift_end_min < shift_start_min;

        let next_date: String = transaction
            .query_row("SELECT date(?, '+1 day');", [&date], |row| row.get(0))
            .unwrap_or_else(|_| date.clone());

        let check_in = if matches!(
            correction_type,
            "Lupa Absen Masuk" | "Kendala Sistem - Jam Masuk" | "Terlambat"
        ) {
            scan_kind = "Masuk";
            if correction_time.len() == 5 {
                format!("{date} {correction_time}:00")
            } else {
                format!("{date} {correction_time}")
            }
        } else {
            scan_kind = "Pulang";
            current_in.clone()
        };

        if !check_in.is_empty() {
            let in_time_str = clean_time(&check_in);
            let mut arrival = to_minutes(&in_time_str);
            if is_overnight_shift && arrival < shift_start_min - 720 {
                arrival += 1440;
            }
            let tolerance = shift_config.4;
            if arrival > shift_start_min + tolerance {
                late = (arrival - shift_start_min).max(0);
            } else if arrival < shift_start_min {
                early = (shift_start_min - arrival).max(0);
            }
        }

        let check_out = if matches!(
            correction_type,
            "Lupa Absen Pulang" | "Kendala Sistem - Jam Pulang"
        ) {
            let out_time_min = to_minutes(correction_time);
            let in_time_min = if !check_in.is_empty() {
                Some(to_minutes(&clean_time(&check_in)))
            } else {
                None
            };
            let is_cross_day = match in_time_min {
                Some(in_min) => out_time_min < in_min,
                None => is_overnight_shift && out_time_min < shift_start_min,
            };
            let target_date = if is_cross_day { &next_date } else { &date };
            if correction_time.len() == 5 {
                format!("{target_date} {correction_time}:00")
            } else {
                format!("{target_date} {correction_time}")
            }
        } else if !current_out.is_empty() {
            let out_time_min = to_minutes(&clean_time(&current_out));
            let in_time_min = if !check_in.is_empty() {
                Some(to_minutes(&clean_time(&check_in)))
            } else {
                None
            };
            let is_cross_day = match in_time_min {
                Some(in_min) => out_time_min < in_min,
                None => is_overnight_shift && out_time_min < shift_start_min,
            };
            let target_date = if is_cross_day { &next_date } else { &date };
            let raw_time = clean_time(&current_out);
            format!("{target_date} {raw_time}")
        } else {
            String::new()
        };

        let has_check_in = !check_in.is_empty();
        let has_check_out = !check_out.is_empty();

        let mut worked = 0;
        let mut overtime = 0;
        let mut shortage = 0;

        if has_check_in && has_check_out {
            let in_min = to_minutes(&clean_time(&check_in));
            let out_min = to_minutes(&clean_time(&check_out));
            let total_presence = if out_min < in_min || is_overnight_shift {
                if out_min < in_min {
                    (out_min + 1440) - in_min
                } else if check_out.starts_with(&next_date) && check_in.starts_with(&date) && next_date != date {
                    (out_min + 1440) - in_min
                } else {
                    out_min - in_min
                }
            } else {
                (out_min - in_min).max(0)
            };

            let break_min = shift_config.3;
            let normal_work_min = shift_config.2;

            if total_presence > 0 {
                worked = (total_presence - break_min).max(0);
            }
            overtime = (worked - normal_work_min).max(0);
            shortage = (normal_work_min - worked).max(0);
        }

        let record_status = if has_check_in && has_check_out {
            "Lengkap"
        } else if has_check_in {
            "Belum Pulang"
        } else {
            "Perlu Verifikasi"
        };

        transaction.execute(
            "UPDATE absensi_harian SET jam_masuk = ?, jam_pulang = ?, status_kehadiran = 'Hadir', status_absen = ?, keterangan = ?, sumber = 'Koreksi Admin', update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ? WHERE id_sesi = ?;",
            params![check_in, check_out, record_status, note, now, late, early, worked, overtime, shortage, session_id],
        ).map_err(|_| CommandError::internal())?;
    }

    let correction_id = sync::new_local_id();
    transaction.execute(
        "INSERT INTO koreksi_admin (id_koreksi, id_referensi, tanggal, id_karyawan, nama, divisi, jenis_koreksi, jam_koreksi, keterangan_admin, status_proses, timestamp, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, ?);",
        params![correction_id, reference, &date, employee_id, name, division, correction_type, correction_time, note, now, operator],
    ).map_err(|_| CommandError::internal())?;
    let log_late = if scan_kind == "Masuk" { late } else { 0 };
    let log_early = if scan_kind == "Masuk" { early } else { 0 };
    let log = json!({
        "timestamp_scan": now, "tanggal_kerja": &date,
        "jam_scan": if correction_time.is_empty() { "00:00:00" } else { correction_time },
        "id_karyawan": employee_id, "nama": name, "divisi": division,
        "jenis_scan": scan_kind, "status_proses": "Berhasil",
        "sumber_data": "Koreksi Admin", "catatan_sistem": format!("Koreksi Admin - {correction_type}"),
        "keterangan": note, "menit_terlambat": log_late, "menit_datang_awal": log_early,
        "id_referensi": if mode == "PENGGANTI" { &backup_id } else { &reference }, "kode_operator": operator,
    });
    transaction.execute(
        "DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND sumber_data = 'Koreksi Admin' AND COALESCE(id_referensi, '') = ?;",
        params![&date, employee_id, &scan_kind, if mode == "PENGGANTI" { &backup_id } else { &reference }],
    ).map_err(|_| CommandError::internal())?;
    let local_log_id = sync::new_local_id();
    transaction.execute(
        "INSERT INTO log_scan (id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan, menit_terlambat, menit_datang_awal, id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Koreksi Admin', ?, ?, ?, ?, ?, ?);",
        params![local_log_id, text(&log, "timestamp_scan"), &date, text(&log, "jam_scan"), employee_id, name, division, scan_kind, text(&log, "catatan_sistem"), note, late, early, if mode == "PENGGANTI" { &backup_id } else { &reference }, operator],
    ).map_err(|_| CommandError::internal())?;

    let attendance = attendance_json(&transaction, &session_id)?;
    let correction = json!({
        "id_referensi": reference, "tanggal": &date, "id_karyawan": employee_id,
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
    let date_raw = text(draft, "tanggal_tugas");
    let date = normalize_date(&date_raw);
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
        let date_raw = text(row, "tanggal");
        let date = normalize_date(&date_raw);
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
            let backup: Option<(String, String, String, i64)> = transaction
                .query_row(
                    "SELECT id_backup, id_karyawan_asal, id_karyawan_pengganti, id_shift_backup FROM backup_karyawan WHERE tanggal_tugas = ? AND status_tugas = 'Aktif' AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?) LIMIT 1;",
                    params![&date, id, id],
                    |result| Ok((result.get::<_, String>(0)?, result.get::<_, String>(1)?, result.get::<_, String>(2)?, result.get::<_, i64>(3)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?;


            if backup.as_ref().is_some_and(|value| value.1 == id) {
                return Err(CommandError::new(
                    "OPERATIONAL_CONFLICT",
                    "Import ditolak karena karyawan sedang digantikan.",
                ));
            }

            let (mode, backup_id, original_id, shift_id, session_id) = if let Some(b) = backup {
                let backup_shift_id = b.3;
                let explicit_shift = text(row, "id_shift").parse::<i64>().ok();
                let explicit_mode = text(row, "mode_tugas");

                let (m, b_id, o_id, s_id) = if explicit_mode == "PENGGANTI" || explicit_shift == Some(backup_shift_id) {
                    ("PENGGANTI".to_owned(), b.0, b.1, backup_shift_id)
                } else if explicit_mode == "NORMAL" || explicit_shift == Some(normal_shift) {
                    ("NORMAL".to_owned(), String::new(), String::new(), normal_shift)
                } else {
                    let backup_shift_cfg: Option<(String, String, i64, i64, i64, i64)> = transaction
                        .query_row(
                            "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
                            [backup_shift_id],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                        ).optional().unwrap_or(None);
                    let normal_shift_cfg: Option<(String, String, i64, i64, i64, i64)> = transaction
                        .query_row(
                            "SELECT jam_masuk, jam_pulang, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
                            [normal_shift],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                        ).optional().unwrap_or(None);

                    let check_time = if !check_in_time.is_empty() {
                        &check_in_time
                    } else {
                        &check_out_time
                    };
                    let is_in = !check_in_time.is_empty();

                    let matches_backup = backup_shift_cfg.as_ref().map(|s| {
                        time_matches_shift_window(check_time, &s.0, &s.1, is_in, s.2, s.3, s.4, s.5)
                    }).unwrap_or(false);

                    let matches_normal = normal_shift_cfg.as_ref().map(|s| {
                        time_matches_shift_window(check_time, &s.0, &s.1, is_in, s.2, s.3, s.4, s.5)
                    }).unwrap_or(false);

                    if matches_backup && !matches_normal {
                        ("PENGGANTI".to_owned(), b.0, b.1, backup_shift_id)
                    } else {
                        ("NORMAL".to_owned(), String::new(), String::new(), normal_shift)
                    }
                };
                let s_id_str = if m == "PENGGANTI" {
                    format!("{b_id}-PENGGANTI-{id}")
                } else {
                    format!("NORMAL-{}-{id}-{s_id}", date.replace('-', ""))
                };
                (m, b_id, o_id, s_id, s_id_str)
            } else {
                ("NORMAL".to_owned(), String::new(), String::new(), normal_shift, format!("NORMAL-{}-{id}-{normal_shift}", date.replace('-', "")))
            };

            let existing_row: Option<(String, String, i64, String, String, Option<String>, Option<String>)> = transaction
                .query_row(
                    "SELECT id_sesi, mode_tugas, id_shift, COALESCE(id_backup, ''), COALESCE(id_karyawan_asal, ''), jam_masuk, jam_pulang FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
                    [&session_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?;

            let is_checkout_only = check_in_time.is_empty() && !check_out_time.is_empty();
            let (mode, backup_id, original_id, shift_id, session_id, existing_row, date) = if existing_row.is_none() && (is_checkout_only || (!check_in_time.is_empty() && check_out_time.is_empty())) {
                let unclosed: Option<(String, String, i64, String, String, Option<String>, Option<String>, String)> = transaction
                    .query_row(
                        "SELECT id_sesi, mode_tugas, id_shift, COALESCE(id_backup, ''), COALESCE(id_karyawan_asal, ''), jam_masuk, jam_pulang, tanggal FROM absensi_harian WHERE id_karyawan = ? AND tanggal = ? AND ((jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '')) OR ((jam_masuk IS NULL OR jam_masuk = '') AND jam_pulang != '')) LIMIT 1;",
                        params![id, &date],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
                    )
                    .optional()
                    .map_err(|_| CommandError::internal())?;
                if let Some(ref u) = unclosed {
                    (u.1.clone(), u.3.clone(), u.4.clone(), u.2, u.0.clone(), Some((u.0.clone(), u.1.clone(), u.2, u.3.clone(), u.4.clone(), u.5.clone(), u.6.clone())), u.7.clone())
                } else if is_checkout_only {
                    let prev_date: String = transaction
                        .query_row("SELECT date(?, '-1 day');", [&date], |row| row.get(0))
                        .unwrap_or_else(|_| date.clone());
                    let unclosed_yesterday: Option<(String, String, i64, String, String, Option<String>, Option<String>, String)> = transaction
                        .query_row(
                            "SELECT id_sesi, mode_tugas, id_shift, COALESCE(id_backup, ''), COALESCE(id_karyawan_asal, ''), jam_masuk, jam_pulang, tanggal FROM absensi_harian WHERE id_karyawan = ? AND tanggal = ? AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') LIMIT 1;",
                            params![id, &prev_date],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
                        )
                        .optional()
                        .map_err(|_| CommandError::internal())?;
                    if let Some(ref uy) = unclosed_yesterday {
                        (uy.1.clone(), uy.3.clone(), uy.4.clone(), uy.2, uy.0.clone(), Some((uy.0.clone(), uy.1.clone(), uy.2, uy.3.clone(), uy.4.clone(), uy.5.clone(), uy.6.clone())), uy.7.clone())
                    } else {
                        (mode, backup_id, original_id, shift_id, session_id, None, date)
                    }
                } else {
                    (mode, backup_id, original_id, shift_id, session_id, None, date)
                }
            } else {
                (mode, backup_id, original_id, shift_id, session_id, existing_row, date)
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

            let existing_in = existing_row.as_ref().and_then(|r| r.5.clone()).unwrap_or_default();
            let existing_out = existing_row.as_ref().and_then(|r| r.6.clone()).unwrap_or_default();

            let check_in = if check_in_time.is_empty() {
                existing_in.clone()
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

            let shift: (String, String, i64, i64, i64, i64, i64, i64) = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit, awal_absen_menit, batas_masuk_menit, batas_pulang_menit FROM tbl_shift WHERE id_shift = ?;",
                    [shift_id],
                    |result| Ok((result.get(0)?, result.get(1)?, result.get(2)?, result.get(3)?, result.get(4)?, result.get(5)?, result.get(6)?, result.get(7)?)),
                )
                .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0, 60, 360, 360));

            let to_min = |val: &str| -> i64 {
                val.split(':')
                    .filter_map(|p| p.parse::<i64>().ok())
                    .take(2)
                    .enumerate()
                    .map(|(idx, v)| if idx == 0 { v * 60 } else { v })
                    .sum()
            };

            let is_overnight_shift = to_min(&shift.1) < to_min(&shift.0);
            let existing_in_clock = if existing_in.len() >= 16 { &existing_in[11..16] } else { "" };
            let out_date: String = if is_overnight_shift
                || (!check_in_time.is_empty() && !check_out_time.is_empty() && check_out_time < check_in_time)
                || (!existing_in_clock.is_empty() && !check_out_time.is_empty() && check_out_time < existing_in_clock)
            {
                transaction
                    .query_row("SELECT date(?, '+1 day');", [&date], |result| result.get(0))
                    .map_err(|_| CommandError::internal())?
            } else {
                date.clone()
            };

            let check_out = if check_out_time.is_empty() {
                existing_out
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


            let attendance_status = if text(row, "status_kehadiran").is_empty() {
                "Hadir"
            } else {
                text(row, "status_kehadiran")
            };

            if attendance_status == "Hadir" {
                if !check_in_time.is_empty() {
                    let user_in = to_min(&check_in_time);
                    let shift_in = to_min(&shift.0);
                    let mut diff = user_in - shift_in;
                    if diff < -720 {
                        diff += 1440;
                    }
                    if diff > 720 {
                        diff -= 1440;
                    }
                    if diff < -shift.5 || diff > shift.6 + shift.4 {
                        return Err(CommandError::new(
                            "OPERATIONAL_VALIDATION_FAILED",
                            format!(
                                "Jam masuk ({check_in_time}) di luar rentang jadwal Shift {shift_id} (Jam Masuk: {}).",
                                shift.0
                            ),
                        ));
                    }
                }
                if !check_out_time.is_empty() {
                    let user_out = to_min(&check_out_time);
                    let shift_out = to_min(&shift.1);
                    let mut diff = user_out - shift_out;
                    if diff < -720 {
                        diff += 1440;
                    }
                    if diff > 720 {
                        diff -= 1440;
                    }
                    if diff < -120 || diff > shift.7 {
                        return Err(CommandError::new(
                            "OPERATIONAL_VALIDATION_FAILED",
                            format!(
                                "Jam pulang ({check_out_time}) di luar rentang jadwal Shift {shift_id} (Jam Pulang: {}).",
                                shift.1
                            ),
                        ));
                    }
                }
            }

            let mut late = 0_i64;
            let mut early = 0_i64;

            if !check_in.is_empty() {
                let in_time_str = clean_time(&check_in);
                let mut user_in = to_min(&in_time_str);
                let shift_in = to_min(&shift.0);
                if is_overnight_shift && user_in < shift_in - 720 {
                    user_in += 1440;
                }
                if user_in > shift_in + shift.4 {
                    late = (user_in - shift_in).max(0);
                } else if user_in < shift_in {
                    early = (shift_in - user_in).max(0);
                }
            }

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
                (total - shift.3).max(0)
            } else {
                0
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
                    params![&date, &date],
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
                "INSERT INTO absensi_harian (id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, sumber, update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang, id_shift, bulan, tahun, id_sesi, mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Import Offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id_sesi) DO UPDATE SET jam_masuk = CASE WHEN excluded.jam_masuk != '' THEN excluded.jam_masuk ELSE absensi_harian.jam_masuk END, jam_pulang = CASE WHEN excluded.jam_pulang != '' THEN excluded.jam_pulang ELSE absensi_harian.jam_pulang END, status_kehadiran = excluded.status_kehadiran, status_absen = excluded.status_absen, keterangan = excluded.keterangan, sumber = 'Import Offline', update_terakhir = excluded.update_terakhir, menit_terlambat = excluded.menit_terlambat, menit_datang_awal = excluded.menit_datang_awal, jam_kerja = excluded.jam_kerja, lembur = excluded.lembur, jam_kerja_kurang = excluded.jam_kerja_kurang;",
                params![sync::new_local_id(), &date, id, name, division, check_in, check_out, attendance_status, record_status, text(row, "keterangan"), now, late, early, worked, (worked - shift.2).max(0), if total > 0 { (shift.2 - worked).max(0) } else { 0 }, shift_id, months.get(month.saturating_sub(1) as usize).unwrap_or(&"Januari"), year, session_id, mode, backup_id, original_id, if mode == "PENGGANTI" { &date } else { "" }],
            ).map_err(|_| CommandError::internal())?;
            let attendance = attendance_json(&transaction, &session_id)?;
            let mut logs = Vec::new();
            for (kind, value) in [("Masuk", check_in.as_str()), ("Pulang", check_out.as_str())] {
                if value.is_empty() {
                    continue;
                }
                let log_late = if kind == "Masuk" { late } else { 0 };
                let log_early = if kind == "Masuk" { early } else { 0 };
                let log_timestamp = value.to_owned();
                let log_time = clean_time(value);
                let log = json!({ "timestamp_scan": log_timestamp, "tanggal_kerja": &date, "jam_scan": log_time, "id_karyawan": id, "nama": name, "divisi": division, "jenis_scan": kind, "status_proses": "Berhasil", "sumber_data": "Import Offline", "catatan_sistem": if backup_id.is_empty() { "Import Offline".to_owned() } else { format!("Import Offline sebagai karyawan pengganti. ID Backup: {backup_id}") }, "keterangan": text(row, "keterangan"), "menit_terlambat": log_late, "menit_datang_awal": log_early, "id_referensi": if backup_id.is_empty() { &event_key } else { &backup_id }, "kode_operator": operator });
                transaction.execute("DELETE FROM log_scan WHERE tanggal_kerja = ? AND id_karyawan = ? AND jenis_scan = ? AND sumber_data = 'Import Offline' AND (COALESCE(id_referensi, '') = ? OR COALESCE(id_referensi, '') = ?);", params![&date, id, kind, &backup_id, &event_key]).map_err(|_| CommandError::internal())?;
                transaction.execute("INSERT INTO log_scan (id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data, catatan_sistem, keterangan, menit_terlambat, menit_datang_awal, id_referensi, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Berhasil', 'Import Offline', ?, ?, ?, ?, ?, ?);", params![sync::new_local_id(), log_timestamp, &date, log_time, id, name, division, kind, text(&log, "catatan_sistem"), text(row, "keterangan"), log_late, log_early, if backup_id.is_empty() { &event_key } else { &backup_id }, operator]).map_err(|_| CommandError::internal())?;
                logs.push(log);
            }
            let import = json!({ "event_key": event_key, "timestamp_input": now, "tanggal": &date, "id_unik": id, "nama": name, "divisi": division, "jam_masuk": check_in_time, "jam_pulang": check_out_time, "status_kehadiran": attendance_status, "status_absen": record_status, "keterangan": text(row, "keterangan"), "status_proses": "Sudah Diproses", "diproses_pada": now, "pesan_error": "", "kode_operator": operator });
            transaction.execute("INSERT INTO import_offline (id_import, event_key, timestamp_input, tanggal, id_unik, nama, divisi, jam_masuk, jam_pulang, status_kehadiran, status_absen, keterangan, status_proses, diproses_pada, pesan_error, kode_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sudah Diproses', ?, '', ?);", params![sync::new_local_id(), event_key, now, &date, id, name, division, check_in_time, check_out_time, attendance_status, record_status, text(row, "keterangan"), now, operator]).map_err(|_| CommandError::internal())?;

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
        let date_clause = if !text(filter, "tanggal_mulai").is_empty()
            && !text(filter, "tanggal_selesai").is_empty()
        {
            let start = text(filter, "tanggal_mulai").replace('\'', "''");
            let end = text(filter, "tanggal_selesai").replace('\'', "''");
            format!("tanggal_kerja BETWEEN '{start}' AND '{end}'")
        } else {
            let date = if text(filter, "tanggal").is_empty() {
                connection
                    .query_row("SELECT date('now','+7 hours');", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|_| CommandError::internal())?
            } else {
                text(filter, "tanggal").replace('\'', "''")
            };
            format!("tanggal_kerja = '{date}'")
        };
        let search = text(filter, "search").replace('\'', "''");
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
          SELECT json_object(
            'id_log', id_log,
            'timestamp_scan', timestamp_scan,
            'tanggal_kerja', tanggal_kerja,
            'jam_scan', jam_scan,
            'id_karyawan', id_karyawan,
            'nama', nama,
            'divisi', divisi,
            'jenis_scan', jenis_scan,
            'status_proses', status_proses,
            'sumber_data', sumber_data,
            'catatan_sistem', COALESCE(catatan_sistem,''),
            'keterangan', COALESCE(keterangan,''),
            'menit_terlambat', COALESCE(menit_terlambat, 0),
            'menit_datang_awal', COALESCE(menit_datang_awal, 0),
            'id_referensi', COALESCE(id_referensi,''),
            'kode_operator', COALESCE(kode_operator,'')
          )
          FROM log_scan WHERE {date_clause}
            AND ('{search}' = '' OR nama LIKE '%{search}%' OR id_karyawan LIKE '%{search}%'
              OR divisi LIKE '%{search}%' OR id_referensi LIKE '%{search}%' OR kode_operator LIKE '%{search}%')
          ORDER BY timestamp_scan DESC, id_log DESC LIMIT {limit} OFFSET {offset};
        "#
            ),
        );
    }
    if kind == "daily" {
        let date_clause = if !text(filter, "tanggal_mulai").is_empty()
            && !text(filter, "tanggal_selesai").is_empty()
        {
            let start = text(filter, "tanggal_mulai").replace('\'', "''");
            let end = text(filter, "tanggal_selesai").replace('\'', "''");
            format!("a.tanggal BETWEEN '{start}' AND '{end}'")
        } else {
            let date = if text(filter, "tanggal").is_empty() {
                connection
                    .query_row("SELECT date('now','+7 hours');", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|_| CommandError::internal())?
            } else {
                text(filter, "tanggal").replace('\'', "''")
            };
            format!("a.tanggal = '{date}'")
        };
        return rows_as_json(
            &connection,
            &format!(
                r#"
          SELECT json_object(
            'id_absensi', a.id_absensi,
            'tanggal', a.tanggal,
            'id_karyawan', a.id_karyawan,
            'nama', a.nama,
            'kelas_divisi', a.kelas_divisi,
            'jam_masuk', COALESCE(a.jam_masuk,''),
            'jam_pulang', COALESCE(a.jam_pulang,''),
            'status_kehadiran', a.status_kehadiran,
            'status_absen', a.status_absen,
            'keterangan', COALESCE(a.keterangan,''),
            'sumber', a.sumber,
            'update_terakhir', COALESCE(a.update_terakhir,''),
            'menit_terlambat', a.menit_terlambat,
            'menit_datang_awal', COALESCE(a.menit_datang_awal, 0),
            'jam_kerja', a.jam_kerja,
            'lembur', a.lembur,
            'jam_kerja_kurang', COALESCE(a.jam_kerja_kurang, 0),
            'id_shift', a.id_shift,
            'bulan', COALESCE(a.bulan,''),
            'tahun', a.tahun,
            'id_sesi', COALESCE(a.id_sesi,''),
            'mode_tugas', COALESCE(a.mode_tugas,'NORMAL'),
            'id_backup', COALESCE(a.id_backup,''),
            'id_karyawan_asal', COALESCE(a.id_karyawan_asal,''),
            'tanggal_tugas', COALESCE(a.tanggal_tugas,''),
            'kode_karyawan', COALESCE(m.kode_karyawan,''),
            'nama_shift', COALESCE(s.nama_shift,''),
            'kode_shift', COALESCE(s.kode_shift, a.id_shift)
          )
          FROM absensi_harian a LEFT JOIN master_data m ON a.id_karyawan = m.id_unik
          LEFT JOIN tbl_shift s ON a.id_shift = s.id_shift WHERE {date_clause}
          AND ('{division}' = '' OR a.kelas_divisi = '{division}') ORDER BY a.update_terakhir DESC, a.tanggal DESC, a.nama;
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

pub fn delete_correction(
    state: &DesktopState,
    id_referensi: &str,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let row: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id_karyawan, tanggal, nama FROM koreksi_admin WHERE id_referensi = ? LIMIT 1;",
            params![id_referensi],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let Some((id_karyawan, tanggal, nama)) = row else {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Data koreksi admin tidak ditemukan.",
        ));
    };

    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM koreksi_admin WHERE id_referensi = ?;",
            params![id_referensi],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM log_scan WHERE id_referensi = ?;",
            params![id_referensi],
        )
        .map_err(|_| CommandError::internal())?;

    let remaining_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ?;",
            params![id_karyawan, tanggal],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    let abs_row: Option<(String, i64)> = transaction
        .query_row(
            "SELECT id_sesi, id_shift FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
            params![id_karyawan, tanggal, tanggal, tanggal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    if let Some((id_sesi, id_shift)) = abs_row {
        if remaining_count == 0 {
            transaction
                .execute(
                    "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
                    params![id_karyawan, tanggal, tanggal],
                )
                .map_err(|_| CommandError::internal())?;
        } else {
            let in_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Masuk' ORDER BY timestamp_scan ASC LIMIT 1;",
                    params![id_karyawan, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            let out_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Pulang' ORDER BY timestamp_scan DESC LIMIT 1;",
                    params![id_karyawan, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);

            let in_val = in_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();
            let out_val = out_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();

            let shift_data: (String, String, i64, i64, i64) = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
                    params![id_shift],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0));

            let shift_in_min = parse_time_min(&shift_data.0).unwrap_or(420);
            let shift_out_min = parse_time_min(&shift_data.1).unwrap_or(900);
            let is_overnight = shift_out_min < shift_in_min;
            let normal_shift_min = shift_data.2;
            let break_shift_min = shift_data.3;
            let toleransi_shift_min = shift_data.4;

            let in_m = parse_time_min(&in_val);
            let out_m = parse_time_min(&out_val);

            let mut calculated_late = 0_i64;
            let mut calculated_early = 0_i64;
            let mut calculated_work = 0_i64;
            let mut calculated_overtime = 0_i64;
            let mut calculated_shortage = 0_i64;

            if let Some(user_in) = in_m {
                let mut user_in_timeline = user_in;
                if is_overnight && user_in_timeline < shift_in_min - 720 {
                    user_in_timeline += 1440;
                }
                if user_in_timeline > shift_in_min + toleransi_shift_min {
                    calculated_late = user_in_timeline - shift_in_min;
                } else if user_in_timeline < shift_in_min {
                    calculated_early = shift_in_min - user_in_timeline;
                }
            }

            if let (Some(in_val_min), Some(out_val_min)) = (in_m, out_m) {
                let mut duration = out_val_min - in_val_min;
                if duration < 0 {
                    duration += 1440;
                }
                calculated_work = (duration - break_shift_min).max(0);
                calculated_overtime = (calculated_work - normal_shift_min).max(0);
                calculated_shortage = (normal_shift_min - calculated_work).max(0);
            }

            let status_absen = if !in_val.is_empty() && !out_val.is_empty() {
                "Lengkap"
            } else if !in_val.is_empty() {
                "Belum Pulang"
            } else {
                "Perlu Verifikasi"
            };

            transaction
                .execute(
                    "UPDATE absensi_harian SET jam_masuk = ?, jam_pulang = ?, status_kehadiran = 'Hadir', status_absen = ?, update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ? WHERE id_sesi = ?;",
                    params![
                        in_val,
                        out_val,
                        status_absen,
                        now,
                        calculated_late,
                        calculated_early,
                        calculated_work,
                        calculated_overtime,
                        calculated_shortage,
                        id_sesi
                    ],
                )
                .map_err(|_| CommandError::internal())?;
        }
    }

    transaction
        .execute(
            "INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status) VALUES (?, 'Hapus Koreksi', ?, ?, ?, ?, ?, 'Berhasil');",
            params![now, tanggal, id_karyawan, nama, id_referensi, format!("Koreksi dihapus oleh Operator {operator}.")],
        )
        .map_err(|_| CommandError::internal())?;

    let current_revision = revision(&transaction, "correction", id_referensi);
    sync::enqueue(
        &transaction,
        &client_id,
        "correction",
        "delete",
        id_referensi,
        &json!({ "id_referensi": id_referensi }),
        current_revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": format!("Koreksi admin '{id_referensi}' berhasil dihapus.") }))
}

pub fn update_attendance(
    state: &DesktopState,
    id_sesi: &str,
    patch: &Value,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let current: Option<(
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
    )> = transaction
        .query_row(
            "SELECT id_karyawan, tanggal, nama, id_shift, COALESCE(jam_masuk, ''), COALESCE(jam_pulang, ''), COALESCE(status_kehadiran, 'Hadir'), COALESCE(status_absen, ''), COALESCE(keterangan, '') FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
            params![id_sesi],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let Some((
        id_karyawan,
        tanggal,
        nama,
        id_shift,
        cur_masuk,
        cur_pulang,
        cur_status,
        _cur_absen,
        cur_ket,
    )) = current
    else {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Data absensi harian tidak ditemukan.",
        ));
    };

    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    let next_date: String = transaction
        .query_row(
            "SELECT date(?, '+1 day');",
            params![&tanggal],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| tanggal.clone());

    let shift_data: (String, String, i64, i64, i64) = transaction
        .query_row(
            "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
            params![id_shift],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0));

    let shift_in_min = parse_time_min(&shift_data.0).unwrap_or(420);
    let shift_out_min = parse_time_min(&shift_data.1).unwrap_or(900);
    let is_overnight = shift_out_min < shift_in_min;
    let normal_shift_min = shift_data.2;
    let break_shift_min = shift_data.3;
    let toleransi_shift_min = shift_data.4;

    let patch_masuk = text(patch, "jam_masuk");
    let patch_pulang = text(patch, "jam_pulang");
    let patch_status = text(patch, "status_kehadiran");
    let patch_absen = text(patch, "status_absen");
    let patch_ket = text(patch, "keterangan");

    let status_kehadiran = if !patch_status.is_empty() {
        patch_status.to_owned()
    } else {
        cur_status
    };
    let keterangan = if !patch_ket.is_empty() {
        patch_ket.to_owned()
    } else {
        cur_ket
    };

    let mut check_in_val = if patch.get("jam_masuk").is_some() {
        if patch_masuk.is_empty() {
            String::new()
        } else {
            format_date_time_str(&tanggal, patch_masuk)
        }
    } else if !cur_masuk.is_empty() {
        format_date_time_str(&tanggal, &cur_masuk)
    } else {
        String::new()
    };

    let in_min = parse_time_min(&check_in_val);

    let mut check_out_val = if patch.get("jam_pulang").is_some() {
        if patch_pulang.is_empty() {
            String::new()
        } else {
            let out_min = parse_time_min(patch_pulang).unwrap_or(0);
            let is_cross = match in_min {
                Some(in_m) => out_min < in_m,
                None => is_overnight && out_min < shift_in_min,
            };
            let target_out_date = if is_cross { &next_date } else { &tanggal };
            format_date_time_str(target_out_date, patch_pulang)
        }
    } else if !cur_pulang.is_empty() {
        let out_min = parse_time_min(&cur_pulang).unwrap_or(0);
        let is_cross = match in_min {
            Some(in_m) => out_min < in_m,
            None => is_overnight && out_min < shift_in_min,
        };
        let target_out_date = if is_cross { &next_date } else { &tanggal };
        format_date_time_str(target_out_date, &cur_pulang)
    } else {
        String::new()
    };

    let mut calculated_late = 0_i64;
    let mut calculated_early = 0_i64;
    let mut calculated_work = 0_i64;
    let mut calculated_overtime = 0_i64;
    let mut calculated_shortage = 0_i64;

    if matches!(
        status_kehadiran.as_str(),
        "Sakit" | "Izin" | "Dispen" | "Alfa"
    ) {
        check_in_val = String::new();
        check_out_val = String::new();
    } else {
        let in_m = parse_time_min(&check_in_val);
        let out_m = parse_time_min(&check_out_val);

        if let Some(user_in) = in_m {
            let mut user_in_timeline = user_in;
            if is_overnight && user_in_timeline < shift_in_min - 720 {
                user_in_timeline += 1440;
            }
            if user_in_timeline > shift_in_min + toleransi_shift_min {
                calculated_late = user_in_timeline - shift_in_min;
            } else if user_in_timeline < shift_in_min {
                calculated_early = shift_in_min - user_in_timeline;
            }
        }

        if let (Some(in_val_min), Some(out_val_min)) = (in_m, out_m) {
            let mut duration = out_val_min - in_val_min;
            if duration < 0 {
                duration += 1440;
            } else if check_out_val.starts_with(&next_date)
                && check_in_val.starts_with(&tanggal)
                && next_date != tanggal
            {
                duration += 1440;
            }
            calculated_work = (duration - break_shift_min).max(0);
            calculated_overtime = (calculated_work - normal_shift_min).max(0);
            calculated_shortage = (normal_shift_min - calculated_work).max(0);
        }
    }

    let status_absen = if !patch_absen.is_empty() {
        patch_absen.to_owned()
    } else if matches!(
        status_kehadiran.as_str(),
        "Sakit" | "Izin" | "Dispen" | "Alfa"
    ) {
        "Tidak Hadir".to_owned()
    } else if !check_in_val.is_empty() && !check_out_val.is_empty() {
        "Lengkap".to_owned()
    } else if !check_in_val.is_empty() {
        "Belum Pulang".to_owned()
    } else {
        "Perlu Verifikasi".to_owned()
    };

    transaction
        .execute(
            r#"
            UPDATE absensi_harian SET
              jam_masuk = ?,
              jam_pulang = ?,
              status_kehadiran = ?,
              status_absen = ?,
              keterangan = ?,
              update_terakhir = ?,
              menit_terlambat = ?,
              menit_datang_awal = ?,
              jam_kerja = ?,
              lembur = ?,
              jam_kerja_kurang = ?
            WHERE id_sesi = ?;
            "#,
            params![
                check_in_val,
                check_out_val,
                status_kehadiran,
                status_absen,
                keterangan,
                now,
                calculated_late,
                calculated_early,
                calculated_work,
                calculated_overtime,
                calculated_shortage,
                id_sesi
            ],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status) VALUES (?, 'Edit Absensi', ?, ?, ?, ?, ?, 'Berhasil');",
            params![now, tanggal, id_karyawan, nama, id_sesi, format!("Diedit oleh Operator {operator}. Jam Masuk: '{check_in_val}', Jam Pulang: '{check_out_val}', Status: '{status_kehadiran}/{status_absen}'.")],
        )
        .map_err(|_| CommandError::internal())?;

    let current_revision = revision(&transaction, "attendance", id_sesi);
    sync::enqueue(
        &transaction,
        &client_id,
        "attendance",
        "update",
        id_sesi,
        &json!({
            "id_sesi": id_sesi,
            "jam_masuk": check_in_val,
            "jam_pulang": check_out_val,
            "status_kehadiran": status_kehadiran,
            "status_absen": status_absen,
            "keterangan": keterangan,
        }),
        current_revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": "Data absensi harian berhasil diperbarui." }))
}

pub fn delete_attendance(
    state: &DesktopState,
    id_sesi: &str,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let current: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id_karyawan, tanggal, nama FROM absensi_harian WHERE id_sesi = ? LIMIT 1;",
            params![id_sesi],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let Some((id_karyawan, tanggal, nama)) = current else {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Data absensi harian tidak ditemukan.",
        ));
    };

    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM absensi_harian WHERE id_sesi = ?;",
            params![id_sesi],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status) VALUES (?, 'Hapus Absensi', ?, ?, ?, ?, ?, 'Berhasil');",
            params![now, tanggal, id_karyawan, nama, id_sesi, format!("Dihapus oleh Operator {operator}.")],
        )
        .map_err(|_| CommandError::internal())?;

    let current_revision = revision(&transaction, "attendance", id_sesi);
    sync::enqueue(
        &transaction,
        &client_id,
        "attendance",
        "delete",
        id_sesi,
        &json!({ "id_sesi": id_sesi }),
        current_revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": "Data absensi harian berhasil dihapus." }))
}

pub fn delete_log_scan(
    state: &DesktopState,
    id_log: i64,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let current: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id_karyawan, tanggal_kerja, nama FROM log_scan WHERE id_log = ? LIMIT 1;",
            params![id_log],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let Some((id_karyawan, tanggal, nama)) = current else {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Log scan tidak ditemukan.",
        ));
    };

    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute("DELETE FROM log_scan WHERE id_log = ?;", params![id_log])
        .map_err(|_| CommandError::internal())?;

    let remaining_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ?;",
            params![id_karyawan, tanggal],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    let abs_row: Option<(String, i64)> = transaction
        .query_row(
            "SELECT id_sesi, id_shift FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
            params![id_karyawan, tanggal, tanggal, tanggal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    if let Some((id_sesi, id_shift)) = abs_row {
        if remaining_count == 0 {
            transaction
                .execute(
                    "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
                    params![id_karyawan, tanggal, tanggal],
                )
                .map_err(|_| CommandError::internal())?;
        } else {
            let in_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Masuk' ORDER BY timestamp_scan ASC LIMIT 1;",
                    params![id_karyawan, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            let out_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Pulang' ORDER BY timestamp_scan DESC LIMIT 1;",
                    params![id_karyawan, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);

            let in_val = in_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();
            let out_val = out_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();

            let shift_data: (String, String, i64, i64, i64) = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
                    params![id_shift],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0));

            let shift_in_min = parse_time_min(&shift_data.0).unwrap_or(420);
            let shift_out_min = parse_time_min(&shift_data.1).unwrap_or(900);
            let is_overnight = shift_out_min < shift_in_min;
            let normal_shift_min = shift_data.2;
            let break_shift_min = shift_data.3;
            let toleransi_shift_min = shift_data.4;

            let in_m = parse_time_min(&in_val);
            let out_m = parse_time_min(&out_val);

            let mut calculated_late = 0_i64;
            let mut calculated_early = 0_i64;
            let mut calculated_work = 0_i64;
            let mut calculated_overtime = 0_i64;
            let mut calculated_shortage = 0_i64;

            if let Some(user_in) = in_m {
                let mut user_in_timeline = user_in;
                if is_overnight && user_in_timeline < shift_in_min - 720 {
                    user_in_timeline += 1440;
                }
                if user_in_timeline > shift_in_min + toleransi_shift_min {
                    calculated_late = user_in_timeline - shift_in_min;
                } else if user_in_timeline < shift_in_min {
                    calculated_early = shift_in_min - user_in_timeline;
                }
            }

            if let (Some(in_val_min), Some(out_val_min)) = (in_m, out_m) {
                let mut duration = out_val_min - in_val_min;
                if duration < 0 {
                    duration += 1440;
                }
                calculated_work = (duration - break_shift_min).max(0);
                calculated_overtime = (calculated_work - normal_shift_min).max(0);
                calculated_shortage = (normal_shift_min - calculated_work).max(0);
            }

            let status_absen = if !in_val.is_empty() && !out_val.is_empty() {
                "Lengkap"
            } else if !in_val.is_empty() {
                "Belum Pulang"
            } else {
                "Perlu Verifikasi"
            };

            let _ = transaction.execute(
                "UPDATE absensi_harian SET jam_masuk = ?, jam_pulang = ?, status_absen = ?, update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ? WHERE id_sesi = ?;",
                params![
                    in_val,
                    out_val,
                    status_absen,
                    now,
                    calculated_late,
                    calculated_early,
                    calculated_work,
                    calculated_overtime,
                    calculated_shortage,
                    id_sesi
                ],
            );
        }
    }

    transaction
        .execute(
            "INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status) VALUES (?, 'Hapus Log Scan', ?, ?, ?, ?, ?, 'Berhasil');",
            params![now, tanggal, id_karyawan, nama, id_log.to_string(), format!("Dihapus oleh Operator {operator}.")],
        )
        .map_err(|_| CommandError::internal())?;

    let current_revision = revision(&transaction, "log-scan", &id_log.to_string());
    sync::enqueue(
        &transaction,
        &client_id,
        "log-scan",
        "delete",
        &id_log.to_string(),
        &json!({ "id_log": id_log }),
        current_revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": "Log scan berhasil dihapus." }))
}

pub fn delete_import_offline(
    state: &DesktopState,
    event_key: &str,
    operator: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let current: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT id_unik, tanggal, COALESCE(nama, '') FROM import_offline WHERE event_key = ? LIMIT 1;",
            params![event_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    let Some((id_unik, tanggal, nama)) = current else {
        return Err(CommandError::new(
            "OPERATIONAL_NOT_FOUND",
            "Data import offline tidak ditemukan.",
        ));
    };

    let now: String = transaction
        .query_row(
            "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
            [],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM import_offline WHERE event_key = ?;",
            params![event_key],
        )
        .map_err(|_| CommandError::internal())?;

    transaction
        .execute(
            "DELETE FROM log_scan WHERE id_referensi = ? OR (id_karyawan = ? AND tanggal_kerja = ? AND sumber_data = 'Import Offline');",
            params![event_key, id_unik, tanggal],
        )
        .map_err(|_| CommandError::internal())?;

    let remaining_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ?;",
            params![id_unik, tanggal],
            |r| r.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    let abs_row: Option<(String, i64)> = transaction
        .query_row(
            "SELECT id_sesi, id_shift FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day')) ORDER BY (CASE WHEN tanggal = ? THEN 0 ELSE 1 END) ASC LIMIT 1;",
            params![id_unik, tanggal, tanggal, tanggal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;

    if let Some((id_sesi, id_shift)) = abs_row {
        if remaining_count == 0 {
            transaction
                .execute(
                    "DELETE FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = ? OR tanggal = date(?, '-1 day'));",
                    params![id_unik, tanggal, tanggal],
                )
                .map_err(|_| CommandError::internal())?;
        } else {
            let in_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Masuk' ORDER BY timestamp_scan ASC LIMIT 1;",
                    params![id_unik, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            let out_log: Option<String> = transaction
                .query_row(
                    "SELECT jam_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = ? AND jenis_scan = 'Pulang' ORDER BY timestamp_scan DESC LIMIT 1;",
                    params![id_unik, tanggal],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);

            let in_val = in_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();
            let out_val = out_log
                .map(|t| format_date_time_str(&tanggal, &t))
                .unwrap_or_default();

            let shift_data: (String, String, i64, i64, i64) = transaction
                .query_row(
                    "SELECT jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, toleransi_masuk_menit FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
                    params![id_shift],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap_or_else(|_| ("07:00".to_owned(), "15:00".to_owned(), 480, 60, 0));

            let shift_in_min = parse_time_min(&shift_data.0).unwrap_or(420);
            let shift_out_min = parse_time_min(&shift_data.1).unwrap_or(900);
            let is_overnight = shift_out_min < shift_in_min;
            let normal_shift_min = shift_data.2;
            let break_shift_min = shift_data.3;
            let toleransi_shift_min = shift_data.4;

            let in_m = parse_time_min(&in_val);
            let out_m = parse_time_min(&out_val);

            let mut calculated_late = 0_i64;
            let mut calculated_early = 0_i64;
            let mut calculated_work = 0_i64;
            let mut calculated_overtime = 0_i64;
            let mut calculated_shortage = 0_i64;

            if let Some(user_in) = in_m {
                let mut user_in_timeline = user_in;
                if is_overnight && user_in_timeline < shift_in_min - 720 {
                    user_in_timeline += 1440;
                }
                if user_in_timeline > shift_in_min + toleransi_shift_min {
                    calculated_late = user_in_timeline - shift_in_min;
                } else if user_in_timeline < shift_in_min {
                    calculated_early = shift_in_min - user_in_timeline;
                }
            }

            if let (Some(in_val_min), Some(out_val_min)) = (in_m, out_m) {
                let mut duration = out_val_min - in_val_min;
                if duration < 0 {
                    duration += 1440;
                }
                calculated_work = (duration - break_shift_min).max(0);
                calculated_overtime = (calculated_work - normal_shift_min).max(0);
                calculated_shortage = (normal_shift_min - calculated_work).max(0);
            }

            let status_absen = if !in_val.is_empty() && !out_val.is_empty() {
                "Lengkap"
            } else if !in_val.is_empty() {
                "Belum Pulang"
            } else {
                "Perlu Verifikasi"
            };

            let _ = transaction.execute(
                "UPDATE absensi_harian SET jam_masuk = ?, jam_pulang = ?, status_absen = ?, update_terakhir = ?, menit_terlambat = ?, menit_datang_awal = ?, jam_kerja = ?, lembur = ?, jam_kerja_kurang = ? WHERE id_sesi = ?;",
                params![
                    in_val,
                    out_val,
                    status_absen,
                    now,
                    calculated_late,
                    calculated_early,
                    calculated_work,
                    calculated_overtime,
                    calculated_shortage,
                    id_sesi
                ],
            );
        }
    }

    transaction
        .execute(
            "INSERT INTO audit_absensi (waktu, jenis, tanggal, id_karyawan, nama, baris_referensi, detail, status) VALUES (?, 'Hapus Import Offline', ?, ?, ?, ?, ?, 'Berhasil');",
            params![now, tanggal, id_unik, nama, event_key, format!("Dihapus oleh Operator {operator}.")],
        )
        .map_err(|_| CommandError::internal())?;

    let current_revision = revision(&transaction, "offline-import", event_key);
    sync::enqueue(
        &transaction,
        &client_id,
        "offline-import",
        "delete",
        event_key,
        &json!({ "event_key": event_key }),
        current_revision,
    )?;

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "pesan": "Data import offline berhasil dihapus." }))
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, RwLock};

    use reqwest::Client;
    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::{
        create_backup, create_correction, dashboard_data, import_offline, storage, DesktopState,
    };

    fn fixture() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("temporary directory");
        storage::initialize(directory.path()).expect("local schema");
        let connection = storage::database(directory.path()).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          jam_kerja_normal_menit, istirahat_menit, awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit
        ) VALUES 
          (1, 1, 'Shift Pagi', '07:00', '15:00', 420, 60, 120, 60, 15, 240),
          (2, 2, 'Shift Siang', '15:00', '23:00', 420, 60, 120, 60, 15, 240);
        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif
        ) VALUES 
          ('K001', 'K001', 'Karyawan Test', 'Dapur', 1, 'Aktif'),
          ('K002', 'K002', 'Karyawan Pengganti', 'Dapur', 1, 'Aktif');
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
            api_base_url: RwLock::new(Url::parse("http://localhost:3000").expect("url")),
            server_origin: RwLock::new("http://localhost:3000".to_string()),
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

    #[test]
    fn create_backup_and_correction_workflow_in_rust() {
        let (_directory, state) = fixture();

        // 1. Buat Penugasan Backup
        let backup_draft = json!({
            "tanggal_tugas": "15/08/2026",
            "id_karyawan_asal": "K001",
            "id_karyawan_pengganti": "K002",
            "id_shift_backup": 2,
            "alasan_backup": "Sakit",
            "kode_operator": "SPD001",
        });
        let backup_res = create_backup(&state, &backup_draft, "SPD001").expect("create backup");
        assert!(backup_res["sukses"].as_bool().unwrap_or(false), "backup harus sukses");
        let id_backup = backup_res["id_backup"].as_str().expect("id_backup harus ada").to_owned();

        // 2. Buat Koreksi Admin Entri Manual untuk Karyawan Pengganti (Shift 2)
        // Jam 15:30 seharusnya masuk ke window Shift 2 (15:00-23:00) bukan Shift 1 (07:00-15:00)
        let correction_draft = json!({
            "tanggal": "15/08/2026",
            "id_karyawan": "K002",
            "jenis_koreksi": "Terlambat",
            "jam_koreksi": "15:30",
            "keterangan_admin": "Koreksi manual hadir shift 2",
            "kode_operator": "SPD001",
            "id_shift": 2,
            "mode_tugas": "PENGGANTI",
        });
        let corr_res = create_correction(&state, &correction_draft, "SPD001").expect("create correction");
        assert!(corr_res["sukses"].as_bool().unwrap_or(false), "koreksi harus sukses");

        // Verifikasi ke DB: absensi_harian harus mode PENGGANTI dengan shift 2
        let connection = storage::database(&state.data_dir).expect("db");
        let (mode, shift): (String, i64) = connection
            .query_row(
                "SELECT mode_tugas, id_shift FROM absensi_harian WHERE id_karyawan = 'K002' AND tanggal = '2026-08-15' LIMIT 1;",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("absensi harus ada setelah koreksi");
        assert_eq!(mode, "PENGGANTI", "mode_tugas harus PENGGANTI karena backup aktif");
        assert_eq!(shift, 2, "id_shift harus 2 (shift backup)");
        assert_eq!(id_backup.is_empty(), false, "id_backup tidak boleh kosong");
    }


    #[test]
    fn import_offline_persists_separate_rows_for_normal_and_backup_shifts() {
        let (_directory, state) = fixture();

        // 1. Buat penugasan backup
        let backup_draft = json!({
            "tanggal_tugas": "2026-08-15",
            "id_karyawan_asal": "K001",
            "id_karyawan_pengganti": "K002",
            "id_shift_backup": 2,
            "kode_operator": "SPD001",
        });
        create_backup(&state, &backup_draft, "SPD001").expect("create backup");

        // 2. Import offline 2 baris (Shift 1 & Shift 2) pada tanggal yang sama
        let rows = vec![
            json!({
                "tanggal": "15/08/2026",
                "id_unik": "K002",
                "jam_masuk": "07:00",
                "jam_pulang": "15:00",
                "status_kehadiran": "Hadir",
            }),
            json!({
                "tanggal": "15/08/2026",
                "id_unik": "K002",
                "jam_masuk": "15:00",
                "jam_pulang": "23:00",
                "status_kehadiran": "Hadir",
            }),
        ];
        let import_res = import_offline(&state, &rows, "SPD001").expect("import offline");
        assert_eq!(import_res["berhasil"], 2);
        assert_eq!(import_res["gagal"], 0);
    }

    #[test]
    fn test_shift_multi_session_crud() {
        let (_directory, state) = fixture();

        // 1. Update Shift 2 dengan izinkan_multi_sesi = 1
        let shift2_draft = json!({
            "kode_shift": 2,
            "nama_shift": "Shift 2 Siang",
            "jam_masuk": "15:00",
            "jam_pulang": "23:00",
            "awal_absen_menit": 120,
            "batas_masuk_menit": 60,
            "toleransi_masuk_menit": 15,
            "jam_kerja_normal_menit": 480,
            "istirahat_menit": 60,
            "batas_pulang_menit": 240,
            "offset_istirahat_mulai": 240,
            "offset_generate_alfa": 180,
            "buffer_shift_malam_menit": 120,
            "izinkan_multi_sesi": 1,
        });
        super::super::operational::update_shift(&state, 2, &shift2_draft).expect("update shift 2");

        // 2. List shifts dan verifikasi izinkan_multi_sesi bernilai 1
        let shifts = super::super::operational::list_shifts(&state).expect("list shifts");
        let shift2 = shifts
            .as_array()
            .and_then(|arr| arr.iter().find(|s| s["id_shift"] == 2))
            .expect("shift 2 must exist");
        assert_eq!(shift2["izinkan_multi_sesi"], 1, "izinkan_multi_sesi must be 1");
    }

    #[test]
    fn test_holiday_crud_and_alfa_settings() {
        let (_directory, state) = fixture();

        // 1. Create holiday
        let create_res = super::super::operational::create_holiday(
            &state,
            &json!({
                "tanggal": "2026-08-17",
                "nama_libur": "Hari Kemerdekaan RI",
                "jenis_libur": "Libur Nasional",
                "keterangan": "HUT RI ke-81",
                "status_aktif": 1,
            }),
        )
        .expect("create holiday");
        let id_libur = create_res["id_libur"].as_i64().expect("id_libur");

        // 2. List holidays
        let list = super::super::operational::list_holidays(&state).expect("list holidays");
        let list_arr = list.as_array().expect("array");
        assert_eq!(list_arr.len(), 1);
        assert_eq!(list_arr[0]["nama_libur"], "Hari Kemerdekaan RI");

        // 3. Update holiday
        super::super::operational::update_holiday(
            &state,
            id_libur,
            &json!({
                "tanggal": "2026-08-17",
                "nama_libur": "Hari Kemerdekaan RI",
                "jenis_libur": "Libur Nasional",
                "keterangan": "Updated",
                "status_aktif": 0,
            }),
        )
        .expect("update holiday");

        let list_after_update = super::super::operational::list_holidays(&state).expect("list holidays");
        assert_eq!(list_after_update.as_array().unwrap()[0]["status_aktif"], 0);

        // 4. Alfa settings
        let s1 = super::super::operational::get_alfa_settings(&state).expect("get alfa");
        assert_eq!(s1["enabled"], true);

        super::super::operational::save_alfa_settings(&state, false).expect("save alfa false");
        let s2 = super::super::operational::get_alfa_settings(&state).expect("get alfa");
        assert_eq!(s2["enabled"], false);

        // 5. Delete holiday
        super::super::operational::delete_holiday(&state, id_libur).expect("delete holiday");
        let list_empty = super::super::operational::list_holidays(&state).expect("list holidays");
        assert_eq!(list_empty.as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_scanner_holiday_rejection() {
        let (_directory, state) = fixture();

        // Add employee
        let emp_res = super::super::operational::create_employee(
            &state,
            &json!({
                "id_unik": "EMP_LIBUR_01",
                "kode_karyawan": "KW_LIBUR",
                "nama": "Karyawan Libur",
                "divisi": "Produksi",
                "id_shift": 1,
            }),
        )
        .expect("create employee");
        let token = emp_res["token_absensi"].as_str().unwrap();

        // Create active holiday on 2026-08-17
        let _ = super::super::operational::create_holiday(
            &state,
            &json!({
                "tanggal": "2026-08-17",
                "nama_libur": "HUT RI",
                "jenis_libur": "Libur Nasional",
                "status_aktif": 1,
            }),
        )
        .expect("create holiday");

        // Submit scan on holiday
        let moment = super::super::time_policy::LocalMoment {
            timestamp: "2026-08-17 07:00:00".to_owned(),
            date: "2026-08-17".to_owned(),
            time: "07:00:00".to_owned(),
        };
        let scan_res = super::super::scanner::submit_at(
            &state,
            &json!({
                "qrContent": format!("EMP_LIBUR_01|{token}"),
            }),
            "OP001",
            moment,
        )
        .expect("scanner submit");

        assert_eq!(scan_res["status"], "Ditolak");
        assert!(scan_res["pesan"].as_str().unwrap().contains("Hari Libur (HUT RI - Libur Nasional)"));
    }
}


