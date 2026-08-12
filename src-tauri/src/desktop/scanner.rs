use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Value};

use super::{config::DesktopState, models::CommandError, storage, sync};

#[derive(Clone)]
struct Employee {
    id: String,
    name: String,
    division: String,
    shift_id: i64,
    status: String,
    token: String,
}

#[derive(Clone)]
struct Shift {
    id: i64,
    start: String,
    normal_minutes: i64,
    break_minutes: i64,
    tolerance_minutes: i64,
}

#[derive(Clone)]
struct AttendanceState {
    check_in: String,
    updated_at: String,
    source: String,
    attendance_status: String,
}

#[derive(Serialize)]
struct ScanLog {
    timestamp_scan: String,
    tanggal_kerja: String,
    jam_scan: String,
    id_karyawan: String,
    nama: String,
    divisi: String,
    jenis_scan: String,
    status_proses: String,
    sumber_data: String,
    catatan_sistem: String,
    keterangan: String,
    menit_terlambat: i64,
    menit_datang_awal: i64,
    id_referensi: String,
    kode_operator: String,
}

fn failure(message: impl Into<String>, employee: Option<&Employee>) -> Value {
    json!({
        "sukses": false,
        "status": "Ditolak",
        "jenisScan": "Scan Ditolak",
        "idKaryawan": employee.map(|item| item.id.as_str()).unwrap_or(""),
        "nama": employee.map(|item| item.name.as_str()).unwrap_or("-"),
        "divisi": employee.map(|item| item.division.as_str()).unwrap_or("-"),
        "pesan": message.into(),
    })
}

fn minutes(value: &str) -> i64 {
    let mut parts = value.split(':').filter_map(|part| part.parse::<i64>().ok());
    parts.next().unwrap_or_default() * 60 + parts.next().unwrap_or_default()
}

fn distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> i64 {
    let radius = 6_371_000_f64;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    (radius * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())).round() as i64
}

fn insert_log(
    transaction: &Transaction<'_>,
    local_id: i64,
    log: &ScanLog,
) -> Result<(), CommandError> {
    transaction
        .execute(
            r#"
      INSERT INTO log_scan (
        id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama,
        divisi, jenis_scan, status_proses, sumber_data, catatan_sistem,
        keterangan, menit_terlambat, menit_datang_awal, id_referensi,
        kode_operator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      "#,
            params![
                local_id,
                log.timestamp_scan,
                log.tanggal_kerja,
                log.jam_scan,
                log.id_karyawan,
                log.nama,
                log.divisi,
                log.jenis_scan,
                log.status_proses,
                log.sumber_data,
                log.catatan_sistem,
                log.keterangan,
                log.menit_terlambat,
                log.menit_datang_awal,
                log.id_referensi,
                log.kode_operator,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

fn enqueue_scan(
    transaction: &Transaction<'_>,
    client_id: &str,
    local_log_id: i64,
    log: &ScanLog,
    attendance: Option<&Value>,
    attendance_base: Option<&str>,
) -> Result<(), CommandError> {
    sync::enqueue(
        transaction,
        client_id,
        "attendance",
        "scan",
        &format!("scan:{local_log_id}"),
        &json!({
            "log": log,
            "attendance": attendance,
            "attendanceBaseUpdatedAt": attendance_base,
        }),
        None,
    )?;
    Ok(())
}

fn rejected_log(
    timestamp: &str,
    date: &str,
    time: &str,
    employee: &Employee,
    operator: &str,
    system_note: impl Into<String>,
    detail: impl Into<String>,
) -> ScanLog {
    ScanLog {
        timestamp_scan: timestamp.to_owned(),
        tanggal_kerja: date.to_owned(),
        jam_scan: time.to_owned(),
        id_karyawan: employee.id.clone(),
        nama: employee.name.clone(),
        divisi: employee.division.clone(),
        jenis_scan: "Scan Ditolak".into(),
        status_proses: "Ditolak".into(),
        sumber_data: "Scanner".into(),
        catatan_sistem: system_note.into(),
        keterangan: detail.into(),
        menit_terlambat: 0,
        menit_datang_awal: 0,
        id_referensi: String::new(),
        kode_operator: operator.to_owned(),
    }
}

fn persist_rejection(
    transaction: &Transaction<'_>,
    client_id: &str,
    log: &ScanLog,
) -> Result<(), CommandError> {
    let local_id = sync::new_local_id();
    insert_log(transaction, local_id, log)?;
    enqueue_scan(transaction, client_id, local_id, log, None, None)
}

pub fn submit(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
) -> Result<Value, CommandError> {
    let qr = input
        .get("qrContent")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let parts = qr.split('|').map(str::trim).collect::<Vec<_>>();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Ok(failure(
            "Format QR tidak valid. Format harus: ID_Unik|Token.",
            None,
        ));
    }
    if qr.len() > 512 {
        return Ok(failure("Isi QR terlalu panjang.", None));
    }

    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let employee = transaction
        .query_row(
            r#"
      SELECT id_unik, nama, divisi, id_shift, status_aktif, token_absensi
      FROM master_data WHERE id_unik = ? OR kode_karyawan = ? LIMIT 1;
      "#,
            params![parts[0], parts[0]],
            |row| {
                Ok(Employee {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    division: row.get(2)?,
                    shift_id: row.get(3)?,
                    status: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    token: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    let Some(employee) = employee else {
        return Ok(failure(
            format!("Gagal: ID Karyawan '{}' tidak ditemukan.", parts[0]),
            None,
        ));
    };
    if employee.status.to_lowercase() != "aktif" {
        return Ok(failure(
            "Scan ditolak: Karyawan berstatus non-aktif.",
            Some(&employee),
        ));
    }
    if employee.token.trim() != parts[1] {
        return Ok(failure(
            "Akses ditolak: Token QR tidak valid / sudah diperbarui.",
            Some(&employee),
        ));
    }

    let (timestamp, date, time, year, month): (String, String, String, i64, i64) = transaction
        .query_row(
            r#"SELECT strftime('%Y-%m-%d %H:%M:%S','now','localtime'),
                      date('now','localtime'), time('now','localtime'),
                      CAST(strftime('%Y','now','localtime') AS INTEGER),
                      CAST(strftime('%m','now','localtime') AS INTEGER);"#,
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|_| CommandError::internal())?;
    let mut settings = HashMap::<String, String>::new();
    {
        let mut statement = transaction
            .prepare("SELECT key, value FROM setting_gex_system;")
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (key, value) = row.map_err(|_| CommandError::internal())?;
            settings.insert(key, value);
        }
    }

    let office_lat = settings
        .get("lat_kantor")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let office_lng = settings
        .get("lng_kantor")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let radius = settings
        .get("radius_meter")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100);
    let geofence_enabled = settings
        .get("geofence_enabled")
        .map(|value| value == "true")
        .unwrap_or(office_lat != 0.0 || office_lng != 0.0);
    if geofence_enabled {
        let lat = input.get("lat").and_then(Value::as_f64);
        let lng = input.get("lng").and_then(Value::as_f64);
        let (Some(lat), Some(lng)) = (lat, lng) else {
            let log = rejected_log(
                &timestamp,
                &date,
                &time,
                &employee,
                operator_code,
                "GPS Tidak Terdeteksi",
                "",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure(
                "Scan ditolak: Lokasi GPS HP Anda tidak terdeteksi. Wajib mengaktifkan izin lokasi.",
                Some(&employee),
            ));
        };
        let distance = distance_meters(lat, lng, office_lat, office_lng);
        if distance > radius {
            let log = rejected_log(
                &timestamp,
                &date,
                &time,
                &employee,
                operator_code,
                format!("Di luar radius kantor ({distance}m > {radius}m)"),
                "",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure(
                format!("Scan ditolak: Posisi Anda di luar area kantor ({distance}m dari kantor, batas max: {radius}m)."),
                Some(&employee),
            ));
        }
    }

    let cooldown = settings
        .get("anti_double_scan_seconds")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(60);
    let since_last: Option<i64> = transaction
        .query_row(
            r#"
      SELECT CAST((julianday(?) - julianday(timestamp_scan)) * 86400 AS INTEGER)
      FROM log_scan WHERE id_karyawan = ? AND sumber_data = 'Scanner'
        AND status_proses IN ('Berhasil', 'Perlu Verifikasi')
      ORDER BY timestamp_scan DESC, id_log ASC LIMIT 1;
      "#,
            params![timestamp, employee.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    if let Some(elapsed) = since_last {
        if elapsed >= 0 && elapsed < cooldown {
            let remaining = cooldown - elapsed;
            let log = rejected_log(
                &timestamp,
                &date,
                &time,
                &employee,
                operator_code,
                format!("Scan ganda dalam masa cooldown ({cooldown} detik)"),
                "Duplikat diabaikan",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure(
                format!(
                    "Scan ganda terdeteksi. Silakan tunggu {remaining} detik sebelum scan ulang."
                ),
                Some(&employee),
            ));
        }
    }

    let backup = transaction
        .query_row(
            r#"
      SELECT id_backup, id_karyawan_asal, nama_karyawan_pengganti,
             id_karyawan_pengganti, id_shift_backup
      FROM backup_karyawan
      WHERE (id_karyawan_asal = ? OR id_karyawan_pengganti = ?)
        AND tanggal_tugas = ? AND status_tugas = 'Aktif' LIMIT 1;
      "#,
            params![employee.id, employee.id, date],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    let mut mode = "NORMAL";
    let mut effective_shift = employee.shift_id;
    let mut backup_id = String::new();
    let mut original_employee = String::new();
    if let Some((id, original, replacement_name, replacement, backup_shift)) = backup {
        if original == employee.id {
            let mut log = rejected_log(
                &timestamp,
                &date,
                &time,
                &employee,
                operator_code,
                format!("Sedang digantikan. ID Backup: {id}"),
                "",
            );
            log.id_referensi = id.clone();
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure(
                format!("Scan ditolak: Anda sedang digantikan oleh {replacement_name} (ID Backup: {id})."),
                Some(&employee),
            ));
        }
        if replacement == employee.id {
            mode = "PENGGANTI";
            effective_shift = backup_shift;
            backup_id = id;
            original_employee = original;
        }
    }

    let shift = transaction
        .query_row(
            r#"
      SELECT id_shift, jam_masuk, jam_kerja_normal_menit,
             istirahat_menit, toleransi_masuk_menit
      FROM tbl_shift WHERE id_shift = ? LIMIT 1;
      "#,
            [effective_shift],
            |row| {
                Ok(Shift {
                    id: row.get(0)?,
                    start: row.get(1)?,
                    normal_minutes: row.get(2)?,
                    break_minutes: row.get(3)?,
                    tolerance_minutes: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .unwrap_or(Shift {
            id: effective_shift,
            start: "07:00".into(),
            normal_minutes: 480,
            break_minutes: 60,
            tolerance_minutes: 0,
        });
    let session_id = if mode == "PENGGANTI" {
        format!("{backup_id}-PENGGANTI-{}", employee.id)
    } else {
        format!(
            "NORMAL-{}-{}-{}",
            date.replace('-', ""),
            employee.id,
            shift.id
        )
    };
    let attendance_before = transaction
        .query_row(
            r#"
      SELECT COALESCE(jam_masuk, ''), update_terakhir, sumber, status_absen
      FROM absensi_harian WHERE id_sesi = ? LIMIT 1;
      "#,
            [&session_id],
            |row| {
                Ok(AttendanceState {
                    check_in: row.get(0)?,
                    updated_at: row.get(1)?,
                    source: row.get(2)?,
                    attendance_status: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    if attendance_before.as_ref().is_some_and(|item| {
        item.source == "Koreksi Admin" && item.attendance_status == "Tidak Hadir"
    }) {
        let log = rejected_log(
            &timestamp,
            &date,
            &time,
            &employee,
            operator_code,
            "Data absensi sudah dikoreksi admin",
            "Koreksi Admin memiliki prioritas tertinggi",
        );
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(failure(
            "Scan ditolak: data absensi sudah dikoreksi admin. Silakan hubungi operator.",
            Some(&employee),
        ));
    }

    let previous_update = attendance_before
        .as_ref()
        .map(|item| item.updated_at.clone());
    let is_check_in = attendance_before
        .as_ref()
        .map(|item| item.check_in.is_empty())
        .unwrap_or(true);
    let current_minutes = minutes(&time);
    let mut late = 0;
    let mut early = 0;
    let mut worked = 0;
    let mut overtime = 0;
    let mut shortage = 0;
    let (scan_type, status, detail) = if is_check_in {
        let difference = current_minutes - minutes(&shift.start);
        let detail = if difference > shift.tolerance_minutes {
            late = difference;
            "Terlambat"
        } else if difference < 0 {
            early = -difference;
            "Datang Lebih Awal"
        } else {
            "Tepat Waktu"
        };
        ("Masuk", "Belum Pulang", detail)
    } else {
        let check_in = attendance_before
            .as_ref()
            .map(|item| item.check_in.as_str())
            .unwrap_or("");
        let total: i64 = transaction
            .query_row(
                "SELECT MAX(0, CAST((julianday(?) - julianday(?)) * 1440 AS INTEGER));",
                params![timestamp, check_in],
                |row| row.get(0),
            )
            .unwrap_or_default();
        worked = (total - shift.break_minutes).max(0);
        let detail = if worked > shift.normal_minutes {
            overtime = worked - shift.normal_minutes;
            "Pulang Lembur"
        } else if worked < shift.normal_minutes {
            shortage = shift.normal_minutes - worked;
            "Pulang Lebih Awal"
        } else {
            "Pulang Normal"
        };
        ("Pulang", "Lengkap", detail)
    };
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
    let month_name = month_names
        .get(month.saturating_sub(1) as usize)
        .unwrap_or(&"Januari");
    let attendance_id = attendance_before
        .as_ref()
        .map(|_| 0)
        .unwrap_or_else(sync::new_local_id);
    if is_check_in {
        transaction
            .execute(
                r#"
        INSERT INTO absensi_harian (
          id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk,
          jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
          update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja,
          lembur, jam_kerja_kurang, id_shift, bulan, tahun, id_sesi,
          mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'Hadir', ?, ?, 'Scanner', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id_sesi) DO UPDATE SET
          jam_masuk = excluded.jam_masuk, status_kehadiran = 'Hadir',
          status_absen = excluded.status_absen, keterangan = excluded.keterangan,
          sumber = 'Scanner', update_terakhir = excluded.update_terakhir,
          menit_terlambat = excluded.menit_terlambat,
          menit_datang_awal = excluded.menit_datang_awal;
        "#,
                params![
                    attendance_id, date, employee.id, employee.name, employee.division,
                    timestamp, status, detail, timestamp, late, early, shift.id,
                    month_name, year, session_id, mode, backup_id, original_employee, date,
                ],
            )
            .map_err(|_| CommandError::internal())?;
    } else {
        transaction
            .execute(
                r#"
        UPDATE absensi_harian SET jam_pulang = ?, status_absen = 'Lengkap',
          keterangan = ?, sumber = 'Scanner', update_terakhir = ?, jam_kerja = ?,
          lembur = ?, jam_kerja_kurang = ? WHERE id_sesi = ?;
        "#,
                params![timestamp, detail, timestamp, worked, overtime, shortage, session_id],
            )
            .map_err(|_| CommandError::internal())?;
    }
    let attendance_json: String = transaction
        .query_row(
            r#"
      SELECT json_object(
        'tanggal', tanggal, 'id_karyawan', id_karyawan, 'nama', nama,
        'kelas_divisi', kelas_divisi, 'jam_masuk', COALESCE(jam_masuk, ''),
        'jam_pulang', COALESCE(jam_pulang, ''), 'status_kehadiran', status_kehadiran,
        'status_absen', status_absen, 'keterangan', COALESCE(keterangan, ''),
        'sumber', sumber, 'update_terakhir', update_terakhir,
        'menit_terlambat', menit_terlambat, 'menit_datang_awal', menit_datang_awal,
        'jam_kerja', jam_kerja, 'lembur', lembur,
        'jam_kerja_kurang', jam_kerja_kurang, 'id_shift', id_shift,
        'bulan', bulan, 'tahun', tahun, 'id_sesi', id_sesi,
        'mode_tugas', mode_tugas, 'id_backup', COALESCE(id_backup, ''),
        'id_karyawan_asal', COALESCE(id_karyawan_asal, ''),
        'tanggal_tugas', COALESCE(tanggal_tugas, '')
      ) FROM absensi_harian WHERE id_sesi = ?;
      "#,
            [&session_id],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    let attendance: Value =
        serde_json::from_str(&attendance_json).map_err(|_| CommandError::internal())?;
    let system_note = if mode == "PENGGANTI" {
        format!(
            "Scan {} sebagai karyawan pengganti. ID Backup: {backup_id}",
            scan_type.to_lowercase()
        )
    } else {
        format!("Scan {} berhasil", scan_type.to_lowercase())
    };
    let log = ScanLog {
        timestamp_scan: timestamp.clone(),
        tanggal_kerja: date.clone(),
        jam_scan: time,
        id_karyawan: employee.id.clone(),
        nama: employee.name.clone(),
        divisi: employee.division.clone(),
        jenis_scan: scan_type.into(),
        status_proses: "Berhasil".into(),
        sumber_data: "Scanner".into(),
        catatan_sistem: system_note.clone(),
        keterangan: detail.into(),
        menit_terlambat: late,
        menit_datang_awal: early,
        id_referensi: backup_id,
        kode_operator: operator_code.to_owned(),
    };
    let local_log_id = sync::new_local_id();
    insert_log(&transaction, local_log_id, &log)?;
    enqueue_scan(
        &transaction,
        &client_id,
        local_log_id,
        &log,
        Some(&attendance),
        previous_update.as_deref(),
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;

    let mut message = format!(
        "Jam {scan_type} {} ({}) berhasil dicatat.\nStatus: {detail}",
        employee.name, employee.id
    );
    if late > 0 {
        message.push_str(&format!("\nTerlambat: {late} menit."));
    }
    if early > 0 {
        message.push_str(&format!("\nDatang awal: {early} menit."));
    }
    if overtime > 0 {
        message.push_str(&format!("\nLembur: {overtime} menit."));
    }
    if shortage > 0 {
        message.push_str(&format!("\nJam kerja kurang: {shortage} menit."));
    }
    Ok(json!({
        "sukses": true,
        "status": "Berhasil",
        "jenisScan": scan_type,
        "idKaryawan": employee.id,
        "nama": employee.name,
        "divisi": employee.division,
        "pesan": message,
        "catatanSistem": system_note,
        "keterangan": detail,
        "menitTerlambat": late,
        "menitDatangAwal": early,
        "jamKerja": worked,
        "lembur": overtime,
        "jamKerjaKurang": shortage,
        "shiftEfektif": shift.id,
        "modeTugas": mode,
        "idSesi": session_id,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use reqwest::Client;
    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::{storage, submit, DesktopState};

    fn fixture() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("temporary directory");
        storage::initialize(directory.path()).expect("local schema");
        let connection = storage::database(directory.path()).expect("local database");
        connection
            .execute(
                r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          jam_kerja_normal_menit, istirahat_menit
        ) VALUES (1, 1, 'Shift Test', '00:00', '23:59', 480, 60);
        "#,
                [],
            )
            .expect("shift seed");
        connection
            .execute(
                r#"
        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
          token_absensi, qr_code
        ) VALUES ('K001', 'K001', 'Karyawan Test', 'Dapur', 1, 'Aktif',
                  'TOKEN-TEST', 'K001|TOKEN-TEST');
        "#,
                [],
            )
            .expect("employee seed");
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES ('anti_double_scan_seconds', '60');",
                [],
            )
            .expect("settings seed");
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
    fn duplicate_is_logged_without_changing_daily_attendance() {
        let (_directory, state) = fixture();
        let input = json!({ "qrContent": "K001|TOKEN-TEST" });
        let first = submit(&state, &input, "SPD001").expect("first scan");
        let duplicate = submit(&state, &input, "SPD001").expect("duplicate scan");
        assert_eq!(
            first.get("sukses").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            duplicate.get("sukses").and_then(|value| value.as_bool()),
            Some(false)
        );

        let connection = storage::database(&state.data_dir).expect("local database");
        let logs: i64 = connection
            .query_row("SELECT COUNT(*) FROM log_scan;", [], |row| row.get(0))
            .expect("log count");
        let rejected: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM log_scan WHERE status_proses = 'Ditolak' AND keterangan = 'Duplikat diabaikan';",
                [],
                |row| row.get(0),
            )
            .expect("duplicate log count");
        let attendance: i64 = connection
            .query_row("SELECT COUNT(*) FROM absensi_harian;", [], |row| row.get(0))
            .expect("attendance count");
        let outbox: i64 = connection
            .query_row("SELECT COUNT(*) FROM desktop_sync_outbox;", [], |row| {
                row.get(0)
            })
            .expect("outbox count");
        assert_eq!((logs, rejected, attendance, outbox), (2, 1, 1, 2));
    }
}
