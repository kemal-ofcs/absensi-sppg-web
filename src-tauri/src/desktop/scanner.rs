use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Value};

use super::{
    config::DesktopState,
    models::CommandError,
    storage, sync,
    time_policy::{
        decide_scan, determine_work_date, is_checkout_window_expired, DecisionReason,
        LocalMoment, ScanDecision, ScanHistory, ShiftKind, ShiftPolicy,
    },
};

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
    policy: ShiftPolicy,
}

#[derive(Clone)]
struct AttendanceState {
    check_in: String,
    check_out: String,
    updated_at: String,
    source: String,
}

struct Backup {
    id: String,
    task_date: String,
    original_id: String,
    replacement_name: String,
    replacement_id: String,
    shift_id: i64,
    shift: Option<Shift>,
}

struct Session {
    mode: &'static str,
    shift_id: i64,
    backup_id: String,
    original_employee_id: String,
    task_date: String,
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

fn failure_with_context(
    message: impl Into<String>,
    employee: &Employee,
    system_note: impl Into<String>,
    detail: impl Into<String>,
    session_id: Option<&str>,
    shift_id: Option<i64>,
    mode: Option<&str>,
) -> Value {
    json!({
        "sukses": false,
        "status": "Ditolak",
        "jenisScan": "Scan Ditolak",
        "idKaryawan": employee.id,
        "nama": employee.name,
        "divisi": employee.division,
        "pesan": message.into(),
        "catatanSistem": system_note.into(),
        "keterangan": detail.into(),
        "idSesi": session_id,
        "shiftEfektif": shift_id,
        "modeTugas": mode,
    })
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

fn decision_log(
    moment: &LocalMoment,
    employee: &Employee,
    operator: &str,
    decision: &ScanDecision,
    reference_id: &str,
    system_note: String,
) -> ScanLog {
    ScanLog {
        timestamp_scan: moment.timestamp.clone(),
        tanggal_kerja: decision.work_date.clone(),
        jam_scan: moment.time.clone(),
        id_karyawan: employee.id.clone(),
        nama: employee.name.clone(),
        divisi: employee.division.clone(),
        jenis_scan: decision.scan_type.clone(),
        status_proses: decision.process_status.clone(),
        sumber_data: "Scanner".into(),
        catatan_sistem: system_note,
        keterangan: decision.detail.clone(),
        menit_terlambat: decision.late_minutes,
        menit_datang_awal: decision.early_minutes,
        id_referensi: reference_id.to_owned(),
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

fn current_jakarta_moment(transaction: &Transaction<'_>) -> Result<LocalMoment, CommandError> {
    transaction
        .query_row(
            r#"SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours'),
                      date('now','+7 hours'), time('now','+7 hours');"#,
            [],
            |row| {
                Ok(LocalMoment {
                    timestamp: row.get(0)?,
                    date: row.get(1)?,
                    time: row.get(2)?,
                })
            },
        )
        .map_err(|_| CommandError::internal())
}

fn load_shift(transaction: &Transaction<'_>, shift_id: i64) -> Result<Option<Shift>, CommandError> {
    transaction
        .query_row(
            r#"
      SELECT id_shift, kode_shift, jam_masuk, jam_pulang, awal_absen_menit,
             batas_masuk_menit, toleransi_masuk_menit, batas_pulang_menit,
             buffer_shift_malam_menit, offset_istirahat_mulai,
             jam_kerja_normal_menit, istirahat_menit
      FROM tbl_shift WHERE id_shift = ? OR kode_shift = ? LIMIT 1;
      "#,
            params![shift_id, shift_id],
            |row| {
                let code = row.get::<_, i64>(1)?;
                let normal_work_minutes = row.get::<_, Option<i64>>(10)?.unwrap_or_default();
                Ok(Shift {
                    policy: ShiftPolicy {
                        kind: if code == 4 || normal_work_minutes == 0 {
                            ShiftKind::Flexible
                        } else {
                            ShiftKind::Regular
                        },
                        start: row.get(2)?,
                        end: row.get(3)?,
                        early_window_minutes: row.get::<_, Option<i64>>(4)?.unwrap_or(60),
                        normal_entry_minutes: row.get::<_, Option<i64>>(5)?.unwrap_or(120),
                        late_tolerance_minutes: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        checkout_limit_minutes: row.get::<_, Option<i64>>(7)?.unwrap_or(240),
                        night_buffer_minutes: row.get::<_, Option<i64>>(8)?.unwrap_or(120),
                        break_offset_minutes: row.get::<_, Option<i64>>(9)?.unwrap_or(240),
                        normal_work_minutes,
                        break_minutes: row.get::<_, Option<i64>>(11)?.unwrap_or(60),
                    },
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

fn is_check_in_window_matched(time_str: &str, shift: &Shift) -> bool {
    let parse_min = |val: &str| -> i64 {
        let clean = if val.contains(' ') {
            val.split(' ').nth(1).unwrap_or(val)
        } else if val.contains('T') {
            val.split('T').nth(1).unwrap_or(val)
        } else {
            val
        };
        clean
            .split(':')
            .filter_map(|p| p.parse::<i64>().ok())
            .take(2)
            .enumerate()
            .map(|(idx, v)| if idx == 0 { v * 60 } else { v })
            .sum()
    };
    let user_min = parse_min(time_str);
    let shift_in = parse_min(&shift.policy.start);
    let mut diff = user_min - shift_in;
    if diff < -720 {
        diff += 1440;
    }
    if diff > 720 {
        diff -= 1440;
    }
    diff >= -shift.policy.early_window_minutes
        && diff <= (shift.policy.normal_entry_minutes + shift.policy.late_tolerance_minutes)
}

fn find_effective_backup(

    transaction: &Transaction<'_>,
    employee_id: &str,
    moment: &LocalMoment,
) -> Result<Option<Backup>, CommandError> {
    let previous_date: String = transaction
        .query_row("SELECT date(?, '-1 day');", [&moment.date], |row| {
            row.get(0)
        })
        .map_err(|_| CommandError::internal())?;
    let mut statement = transaction
        .prepare(
            r#"
      SELECT id_backup, tanggal_tugas, id_karyawan_asal,
             nama_karyawan_pengganti, id_karyawan_pengganti, id_shift_backup
      FROM backup_karyawan
      WHERE status_tugas = 'Aktif' AND tanggal_tugas IN (?, ?)
        AND (id_karyawan_asal = ? OR id_karyawan_pengganti = ?)
      ORDER BY tanggal_tugas DESC, id_backup DESC;
      "#,
        )
        .map_err(|_| CommandError::internal())?;
    let candidates = statement
        .query_map(
            params![moment.date, previous_date, employee_id, employee_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())?;
    drop(statement);

    for (id, task_date, original_id, replacement_name, replacement_id, shift_id) in candidates {
        let shift = load_shift(transaction, shift_id)?;
        let Some(shift_val) = shift.as_ref() else {
            continue;
        };

        if original_id == employee_id {
            let matches = determine_work_date(moment, &shift_val.policy)
                .map(|date| date == task_date)
                .unwrap_or(task_date == moment.date);
            if matches {
                return Ok(Some(Backup {
                    id,
                    task_date,
                    original_id,
                    replacement_name,
                    replacement_id,
                    shift_id,
                    shift,
                }));
            }
            continue;
        }

        // Employee is replacement_id (pengganti)
        let backup_session_id = format!("{id}-PENGGANTI-{employee_id}");
        let has_open_checkin: bool = transaction
            .query_row(
                "SELECT 1 FROM absensi_harian WHERE id_sesi = ? AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '') LIMIT 1;",
                [&backup_session_id],
                |_| Ok(true),
            )
            .optional()
            .unwrap_or(None)
            .unwrap_or(false);

        if has_open_checkin {
            let expired = is_checkout_window_expired(&task_date, moment, &shift_val.policy);
            if !expired {
                let work_date = determine_work_date(moment, &shift_val.policy)
                    .unwrap_or_else(|_| task_date.clone());
                if work_date == task_date || task_date == moment.date {
                    return Ok(Some(Backup {
                        id,
                        task_date,
                        original_id,
                        replacement_name,
                        replacement_id,
                        shift_id,
                        shift,
                    }));
                }
            }
        }

        let calculated_work_date = determine_work_date(moment, &shift_val.policy);
        if let Ok(calc_date) = calculated_work_date {
            if calc_date == task_date {
                return Ok(Some(Backup {
                    id,
                    task_date,
                    original_id,
                    replacement_name,
                    replacement_id,
                    shift_id,
                    shift,
                }));
            }
        }
    }

    Ok(None)
}

fn rejected_decision_message(reason: DecisionReason) -> &'static str {
    match reason {
        DecisionReason::TooEarly => "Absensi belum dibuka untuk shift ini.",
        DecisionReason::EntryWindowClosed => {
            "Waktu absensi masuk sudah ditutup. Silakan hubungi operator."
        }
        DecisionReason::MultiScan => "Scan ditolak. Kemungkinan Anda melakukan scan masuk ulang.",
        DecisionReason::CheckoutTooLate => "Scan ditolak. Batas waktu pulang shift sudah berakhir.",
        DecisionReason::AlreadyCheckedOut => "Scan pulang sudah tercatat sebelumnya.",
        _ => "Scan ditolak oleh aturan waktu shift.",
    }
}

fn result_from_decision(
    decision: &ScanDecision,
    employee: &Employee,
    session: &Session,
    session_id: &str,
) -> Value {
    let mut message = if decision.allowed {
        format!(
            "Jam {} {} ({}) berhasil dicatat.\nStatus: {}",
            decision.scan_type, employee.name, employee.id, decision.detail
        )
    } else {
        rejected_decision_message(decision.reason).to_owned()
    };
    if decision.late_minutes > 0 {
        message.push_str(&format!("\nTerlambat: {} menit.", decision.late_minutes));
    }
    if decision.early_minutes > 0 {
        message.push_str(&format!("\nDatang awal: {} menit.", decision.early_minutes));
    }
    if decision.metrics.overtime_minutes > 0 {
        message.push_str(&format!(
            "\nLembur: {} menit.",
            decision.metrics.overtime_minutes
        ));
    }
    if decision.metrics.shortage_minutes > 0 {
        message.push_str(&format!(
            "\nJam kerja kurang: {} menit.",
            decision.metrics.shortage_minutes
        ));
    }
    json!({
        "sukses": decision.allowed,
        "status": decision.process_status,
        "jenisScan": decision.scan_type,
        "idKaryawan": employee.id,
        "nama": employee.name,
        "divisi": employee.division,
        "pesan": message,
        "catatanSistem": decision.system_note,
        "keterangan": decision.detail,
        "menitTerlambat": decision.late_minutes,
        "menitDatangAwal": decision.early_minutes,
        "jamKerja": decision.metrics.work_minutes,
        "lembur": decision.metrics.overtime_minutes,
        "jamKerjaKurang": decision.metrics.shortage_minutes,
        "shiftEfektif": session.shift_id,
        "modeTugas": session.mode,
        "idSesi": session_id,
    })
}

pub fn submit(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
) -> Result<Value, CommandError> {
    submit_internal(state, input, operator_code, None)
}

#[cfg(test)]
pub(crate) fn submit_at(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
    moment: LocalMoment,
) -> Result<Value, CommandError> {
    submit_internal(state, input, operator_code, Some(&moment))
}

fn submit_internal(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
    moment_override: Option<&LocalMoment>,
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
    let moment = match moment_override {
        Some(value) => value.clone(),
        None => current_jakarta_moment(&transaction)?,
    };
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
    let base_shift = load_shift(&transaction, employee.shift_id)?;
    let initial_work_date = base_shift
        .as_ref()
        .and_then(|shift| determine_work_date(&moment, &shift.policy).ok())
        .unwrap_or_else(|| moment.date.clone());

    if employee.status.to_lowercase() != "aktif" {
        let note = "Karyawan berstatus nonaktif";
        let log = rejected_log(
            &moment.timestamp,
            &initial_work_date,
            &moment.time,
            &employee,
            operator_code,
            note,
            "",
        );
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(failure_with_context(
            "Scan ditolak: Karyawan berstatus non-aktif.",
            &employee,
            note,
            "",
            None,
            None,
            None,
        ));
    }
    if employee.token.trim() != parts[1] {
        let note = "Token QR tidak valid atau sudah diperbarui";
        let log = rejected_log(
            &moment.timestamp,
            &initial_work_date,
            &moment.time,
            &employee,
            operator_code,
            note,
            "",
        );
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(failure_with_context(
            "Akses ditolak: Token QR tidak valid / sudah diperbarui.",
            &employee,
            note,
            "",
            None,
            None,
            None,
        ));
    }
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
                &moment.timestamp,
                &initial_work_date,
                &moment.time,
                &employee,
                operator_code,
                "GPS Tidak Terdeteksi",
                "",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                "Scan ditolak: Lokasi GPS HP Anda tidak terdeteksi. Wajib mengaktifkan izin lokasi.",
                &employee,
                "GPS Tidak Terdeteksi",
                "",
                None,
                None,
                None,
            ));
        };
        let distance = distance_meters(lat, lng, office_lat, office_lng);
        if distance > radius {
            let log = rejected_log(
                &moment.timestamp,
                &initial_work_date,
                &moment.time,
                &employee,
                operator_code,
                format!("Di luar radius kantor ({distance}m > {radius}m)"),
                "",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                format!("Scan ditolak: Posisi Anda di luar area kantor ({distance}m dari kantor, batas max: {radius}m)."),
                &employee,
                format!("Di luar radius kantor ({distance}m > {radius}m)"),
                "",
                None,
                None,
                None,
            ));
        }
    }

    let backup = find_effective_backup(&transaction, &employee.id, &moment)?;
    if let Some(backup) = backup.as_ref() {
        if backup.original_id == employee.id {
            let mut log = rejected_log(
                &moment.timestamp,
                &backup.task_date,
                &moment.time,
                &employee,
                operator_code,
                format!("Karyawan asal sedang digantikan. ID Backup: {}", backup.id),
                "",
            );
            log.id_referensi = backup.id.clone();
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                format!(
                    "Scan ditolak: Anda sedang digantikan oleh {} (ID Backup: {}).",
                    backup.replacement_name, backup.id
                ),
                &employee,
                format!("Karyawan asal sedang digantikan. ID Backup: {}", backup.id),
                "",
                None,
                None,
                None,
            ));
        }
    }

    let (session, shift) = if let Some(backup) = backup
        .as_ref()
        .filter(|value| value.replacement_id == employee.id && value.original_id != employee.id)
    {
        (
            Session {
                mode: "PENGGANTI",
                shift_id: backup.shift_id,
                backup_id: backup.id.clone(),
                original_employee_id: backup.original_id.clone(),
                task_date: backup.task_date.clone(),
            },
            backup.shift.clone(),
        )
    } else {
        let open_session: Option<(String, i64, String, String, String, String, String)> = transaction
            .query_row(
                r#"
                SELECT id_sesi, id_shift, tanggal, jam_masuk, mode_tugas, id_backup, id_karyawan_asal
                FROM absensi_harian
                WHERE id_karyawan = ? AND jam_masuk != '' AND (jam_pulang IS NULL OR jam_pulang = '')
                  AND (sumber IS NULL OR sumber != 'Koreksi Admin')
                ORDER BY tanggal DESC LIMIT 1;
                "#,
                params![employee.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, Option<String>>(4)?.unwrap_or_else(|| "NORMAL".to_owned()),
                        row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    ))
                },
            )
            .optional()
            .map_err(|_| CommandError::internal())?;

        let open_valid = if let Some(open) = open_session {
            let open_shift = load_shift(&transaction, open.1)?;
            let expired = open_shift
                .as_ref()
                .map(|s| is_checkout_window_expired(&open.2, &moment, &s.policy))
                .unwrap_or(true);
            if expired {
                let now: String = transaction
                    .query_row(
                        "SELECT strftime('%Y-%m-%d %H:%M:%S','now','+7 hours');",
                        [],
                        |result| result.get(0),
                    )
                    .unwrap_or_default();
                let _ = transaction.execute(
                    "UPDATE absensi_harian SET status_absen = 'Belum Pulang', keterangan = CASE WHEN keterangan IS NULL OR keterangan = '' OR keterangan = '-' THEN 'Belum Pulang' ELSE keterangan END, update_terakhir = ? WHERE id_sesi = ?;",
                    params![now, &open.0],
                );
                None
            } else {
                Some((
                    Session {
                        mode: if open.4 == "PENGGANTI" { "PENGGANTI" } else { "NORMAL" },
                        shift_id: open.1,
                        backup_id: open.5,
                        original_employee_id: open.6,
                        task_date: open.2,
                    },
                    open_shift,
                ))
            }
        } else {
            None
        };

        if let Some((valid_session, valid_shift)) = open_valid {
            (valid_session, valid_shift)
        } else {
            let holiday: Option<(String, String)> = transaction
                .query_row(
                    "SELECT nama_libur, COALESCE(jenis_libur, 'Libur Nasional') FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
                    [&moment.date],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .unwrap_or(None);

            if let Some((nama_libur, jenis_libur)) = holiday {
                let log = rejected_log(
                    &moment.timestamp,
                    &moment.date,
                    &moment.time,
                    &employee,
                    operator_code,
                    format!("Hari Libur: {nama_libur} ({jenis_libur})"),
                    "",
                );
                persist_rejection(&transaction, &client_id, &log)?;
                transaction.commit().map_err(|_| CommandError::internal())?;
                return Ok(failure_with_context(
                    format!(
                        "Scan ditolak: Hari ini Hari Libur ({nama_libur} - {jenis_libur}). Scanner dinonaktifkan. Silakan hubungi Admin jika terdapat penugasan khusus."
                    ),
                    &employee,
                    format!("Hari Libur: {nama_libur} ({jenis_libur})"),
                    "",
                    None,
                    None,
                    None,
                ));
            }

            let base_date = match base_shift.as_ref() {
                Some(s) => match determine_work_date(&moment, &s.policy) {
                    Ok(d) => d,
                    Err(_) => moment.date.clone(),
                },
                None => moment.date.clone(),
            };
            let base_session_id = format!(
                "NORMAL-{}-{}-{}",
                base_date.replace('-', ""),
                employee.id,
                employee.shift_id
            );
            let base_completed: bool = transaction
                .query_row(
                    "SELECT 1 FROM absensi_harian WHERE id_sesi = ? AND jam_masuk != '' AND jam_pulang != '' LIMIT 1;",
                    params![base_session_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|_| CommandError::internal())?
                .unwrap_or(false);

            if base_completed {
                let mut statement = transaction
                    .prepare(
                        "SELECT id_shift FROM tbl_shift WHERE id_shift != ? AND kode_shift != 4 AND jam_kerja_normal_menit > 0 AND (izinkan_multi_sesi = 1 OR izinkan_multi_sesi = '1' OR izinkan_multi_sesi = 'true') ORDER BY id_shift ASC;"
                    )
                    .map_err(|_| CommandError::internal())?;

                let candidate_shift_ids = statement
                    .query_map(params![employee.shift_id], |row| row.get::<_, i64>(0))
                    .map_err(|_| CommandError::internal())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| CommandError::internal())?;
                drop(statement);

                let mut matched_shift = None;
                let mut matched_shift_id = employee.shift_id;

                for c_id in candidate_shift_ids {
                    if let Ok(Some(cand_shift)) = load_shift(&transaction, c_id) {
                        if is_check_in_window_matched(&moment.time, &cand_shift) {
                            matched_shift = Some(cand_shift);
                            matched_shift_id = c_id;
                            break;
                        }
                    }
                }

                if let Some(cand_shift) = matched_shift {
                    (
                        Session {
                            mode: "NORMAL",
                            shift_id: matched_shift_id,
                            backup_id: String::new(),
                            original_employee_id: String::new(),
                            task_date: String::new(),
                        },
                        Some(cand_shift),
                    )
                } else {
                    (
                        Session {
                            mode: "NORMAL",
                            shift_id: employee.shift_id,
                            backup_id: String::new(),
                            original_employee_id: String::new(),
                            task_date: String::new(),
                        },
                        base_shift,
                    )
                }
            } else {
                (
                    Session {
                        mode: "NORMAL",
                        shift_id: employee.shift_id,
                        backup_id: String::new(),
                        original_employee_id: String::new(),
                        task_date: String::new(),
                    },
                    base_shift,
                )
            }
        }
    };

    let Some(shift) = shift else {
        let note = format!("Konfigurasi shift {} tidak ditemukan", session.shift_id);
        let mut log = rejected_log(
            &moment.timestamp,
            &moment.date,
            &moment.time,
            &employee,
            operator_code,
            &note,
            "",
        );
        log.id_referensi = session.backup_id.clone();
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(failure_with_context(
            "Absensi ditolak. Konfigurasi shift tidak valid.",
            &employee,
            note,
            "",
            None,
            Some(session.shift_id),
            Some(session.mode),
        ));
    };

    let work_date = match determine_work_date(&moment, &shift.policy) {
        Ok(value) => value,
        Err(error) => {
            let note = format!("Konfigurasi shift tidak valid: {error}");
            let mut log = rejected_log(
                &moment.timestamp,
                &moment.date,
                &moment.time,
                &employee,
                operator_code,
                &note,
                "",
            );
            log.id_referensi = session.backup_id.clone();
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                "Absensi ditolak. Konfigurasi shift tidak valid.",
                &employee,
                note,
                "",
                None,
                Some(session.shift_id),
                Some(session.mode),
            ));
        }
    };

    let session_id = if session.mode == "PENGGANTI" {
        format!("{}-PENGGANTI-{}", session.backup_id, employee.id)
    } else {
        format!(
            "NORMAL-{}-{}-{}",
            work_date.replace('-', ""),
            employee.id,
            session.shift_id
        )
    };

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
      ORDER BY id_log DESC LIMIT 1;
      "#,
            params![moment.timestamp, employee.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    if cooldown > 0 {
        if let Some(elapsed) = since_last.filter(|value| *value >= 0 && *value < cooldown) {
            let remaining = cooldown - elapsed;
            let note = format!("Scan ganda dalam masa cooldown ({cooldown} detik)");
            let mut log = rejected_log(
                &moment.timestamp,
                &work_date,
                &moment.time,
                &employee,
                operator_code,
                &note,
                "Duplikat diabaikan",
            );
            log.id_referensi = session.backup_id.clone();
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                format!(
                    "Scan ganda terdeteksi. Silakan tunggu {remaining} detik sebelum scan ulang."
                ),
                &employee,
                note,
                "Duplikat diabaikan",
                Some(&session_id),
                Some(session.shift_id),
                Some(session.mode),
            ));
        }
    }

    let attendance_before = transaction
        .query_row(
            r#"
      SELECT COALESCE(jam_masuk, ''), COALESCE(jam_pulang, ''),
             update_terakhir, sumber
      FROM absensi_harian WHERE id_sesi = ? LIMIT 1;
      "#,
            [&session_id],
            |row| {
                Ok(AttendanceState {
                    check_in: row.get(0)?,
                    check_out: row.get(1)?,
                    updated_at: row.get(2)?,
                    source: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    if attendance_before
        .as_ref()
        .is_some_and(|item| item.source == "Koreksi Admin")
    {
        let note = "Data absensi sudah dikoreksi admin";
        let mut log = rejected_log(
            &moment.timestamp,
            &work_date,
            &moment.time,
            &employee,
            operator_code,
            note,
            "",
        );
        log.id_referensi = session.backup_id.clone();
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(failure_with_context(
            "Scan ditolak: Data absensi sudah dikoreksi Admin dan tidak boleh ditimpa scanner.",
            &employee,
            note,
            "",
            Some(&session_id),
            Some(session.shift_id),
            Some(session.mode),
        ));
    }

    let previous_update = attendance_before
        .as_ref()
        .map(|item| item.updated_at.clone());
    let latest_history: Option<(String, String)> = transaction
        .query_row(
            r#"
      SELECT timestamp_scan, jenis_scan FROM log_scan
      WHERE tanggal_kerja = ? AND id_karyawan = ?
        AND COALESCE(id_referensi, '') = ?
        AND status_proses IN ('Berhasil', 'Perlu Verifikasi')
        AND jenis_scan IN ('Masuk', 'Pulang')
      ORDER BY id_log DESC LIMIT 1;
      "#,
            params![work_date, employee.id, session.backup_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    let history = ScanHistory {
        check_in: attendance_before
            .as_ref()
            .and_then(|item| (!item.check_in.is_empty()).then(|| item.check_in.clone())),
        check_out: attendance_before
            .as_ref()
            .and_then(|item| (!item.check_out.is_empty()).then(|| item.check_out.clone())),
        last_scan: latest_history.as_ref().map(|item| item.0.clone()),
        last_scan_kind: latest_history.as_ref().map(|item| item.1.clone()),
    };
    let multi_scan_minutes = settings
        .get("batas_multi_scan_menit")
        .or_else(|| settings.get("BATAS_MULTI_SCAN_MENIT"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(5)
        .max(0);
    let decision = match decide_scan(&moment, &shift.policy, &history, multi_scan_minutes) {
        Ok(value) => value,
        Err(error) => {
            let note = format!("Konfigurasi shift tidak valid: {error}");
            let mut log = rejected_log(
                &moment.timestamp,
                &moment.date,
                &moment.time,
                &employee,
                operator_code,
                &note,
                "",
            );
            log.id_referensi = session.backup_id.clone();
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                "Absensi ditolak. Konfigurasi shift tidak valid.",
                &employee,
                note,
                "",
                Some(&session_id),
                Some(session.shift_id),
                Some(session.mode),
            ));
        }
    };
    if !decision.allowed {
        let log = decision_log(
            &moment,
            &employee,
            operator_code,
            &decision,
            &session.backup_id,
            decision.system_note.clone(),
        );
        persist_rejection(&transaction, &client_id, &log)?;
        transaction.commit().map_err(|_| CommandError::internal())?;
        return Ok(result_from_decision(
            &decision,
            &employee,
            &session,
            &session_id,
        ));
    }

    let is_check_in = decision.scan_type == "Masuk";
    let status = if is_check_in {
        "Belum Pulang"
    } else if decision.process_status == "Perlu Verifikasi" {
        "Perlu Verifikasi"
    } else {
        "Lengkap"
    };
    let date_parts = decision
        .work_date
        .split('-')
        .filter_map(|part| part.parse::<i64>().ok())
        .collect::<Vec<_>>();
    let year = *date_parts.first().ok_or_else(CommandError::internal)?;
    let month = *date_parts.get(1).ok_or_else(CommandError::internal)?;
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
    let task_date = if session.task_date.is_empty() {
        decision.work_date.as_str()
    } else {
        session.task_date.as_str()
    };
    if attendance_before.is_none() {
        transaction.execute(
                r#"
        INSERT INTO absensi_harian (
          id_absensi, tanggal, id_karyawan, nama, kelas_divisi, jam_masuk,
          jam_pulang, status_kehadiran, status_absen, keterangan, sumber,
          update_terakhir, menit_terlambat, menit_datang_awal, jam_kerja,
          lembur, jam_kerja_kurang, id_shift, bulan, tahun, id_sesi,
          mode_tugas, id_backup, id_karyawan_asal, tanggal_tugas
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Hadir', ?, ?, 'Scanner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        "#,
                params![
                    sync::new_local_id(), decision.work_date, employee.id, employee.name,
                    employee.division,
                    if is_check_in { moment.timestamp.as_str() } else { "" },
                    if is_check_in { "" } else { moment.timestamp.as_str() },
                    status, decision.detail, moment.timestamp, decision.late_minutes,
                    decision.early_minutes, decision.metrics.work_minutes,
                    decision.metrics.overtime_minutes, decision.metrics.shortage_minutes,
                    session.shift_id, month_name, year, session_id, session.mode,
                    session.backup_id, session.original_employee_id, task_date,
                ],
            )
            .map_err(|_| CommandError::internal())?;
    } else if is_check_in {
        let updated = transaction
            .execute(
                r#"
        UPDATE absensi_harian SET jam_masuk = ?, status_kehadiran = 'Hadir',
          status_absen = ?, keterangan = ?, sumber = 'Scanner', update_terakhir = ?,
          menit_terlambat = ?, menit_datang_awal = ?, id_shift = ?, mode_tugas = ?,
          id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
        WHERE id_sesi = ? AND sumber <> 'Koreksi Admin';
        "#,
                params![
                    moment.timestamp,
                    status,
                    decision.detail,
                    moment.timestamp,
                    decision.late_minutes,
                    decision.early_minutes,
                    session.shift_id,
                    session.mode,
                    session.backup_id,
                    session.original_employee_id,
                    task_date,
                    session_id,
                ],
            )
            .map_err(|_| CommandError::internal())?;
        if updated != 1 {
            return Err(CommandError::internal());
        }
    } else {
        let updated = transaction
            .execute(
                r#"
        UPDATE absensi_harian SET jam_pulang = ?, status_kehadiran = 'Hadir',
          status_absen = ?, keterangan = ?, sumber = 'Scanner', update_terakhir = ?,
          jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?, id_shift = ?,
          mode_tugas = ?, id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
        WHERE id_sesi = ? AND sumber <> 'Koreksi Admin';
        "#,
                params![
                    moment.timestamp,
                    status,
                    decision.detail,
                    moment.timestamp,
                    decision.metrics.work_minutes,
                    decision.metrics.overtime_minutes,
                    decision.metrics.shortage_minutes,
                    session.shift_id,
                    session.mode,
                    session.backup_id,
                    session.original_employee_id,
                    task_date,
                    session_id,
                ],
            )
            .map_err(|_| CommandError::internal())?;
        if updated != 1 {
            return Err(CommandError::internal());
        }
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
    let system_note = if session.mode == "PENGGANTI" {
        format!("{}. ID Backup: {}", decision.system_note, session.backup_id)
    } else {
        decision.system_note.clone()
    };
    let log = decision_log(
        &moment,
        &employee,
        operator_code,
        &decision,
        &session.backup_id,
        system_note,
    );
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
    Ok(result_from_decision(
        &decision,
        &employee,
        &session,
        &session_id,
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use reqwest::Client;
    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::{storage, submit_at, DesktopState, LocalMoment};

    fn fixture() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("temporary directory");
        storage::initialize(directory.path()).expect("local schema");
        let connection = storage::database(directory.path()).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
          jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
          offset_istirahat_mulai, buffer_shift_malam_menit
        ) VALUES (1, 1, 'Shift Test', '07:00', '15:00', 60, 15, 30,
                  420, 60, 120, 240, 120);

        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
          token_absensi, qr_code
        ) VALUES ('K001', 'K001', 'Karyawan Test', 'Dapur', 1, 'Aktif',
                  'TOKEN-TEST', 'K001|TOKEN-TEST');

        INSERT INTO setting_gex_system (key, value) VALUES
          ('anti_double_scan_seconds', '60'),
          ('batas_multi_scan_menit', '5');
        "#,
            )
            .expect("fixture seed");
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

    fn moment(date: &str, time: &str) -> LocalMoment {
        LocalMoment {
            timestamp: format!("{date} {time}"),
            date: date.into(),
            time: time.into(),
        }
    }

    fn scan(
        state: &DesktopState,
        employee: &str,
        token: &str,
        at: LocalMoment,
    ) -> serde_json::Value {
        submit_at(
            state,
            &json!({ "qrContent": format!("{employee}|{token}") }),
            "SPD001",
            at,
        )
        .expect("scan result")
    }

    #[test]
    fn duplicate_is_logged_without_changing_daily_attendance() {
        let (_directory, state) = fixture();
        let first = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:00"),
        );
        let duplicate = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:30"),
        );
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
        let payload_json: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox WHERE json_type(payload_json, '$.attendance') = 'object' LIMIT 1;",
                [],
                |row| row.get(0),
            )
            .expect("successful scanner payload");
        let payload: serde_json::Value =
            serde_json::from_str(&payload_json).expect("valid outbox JSON");
        assert_eq!((logs, rejected, attendance, outbox), (2, 1, 1, 2));
        assert_eq!(payload["log"]["jenis_scan"], "Masuk");
        assert_eq!(payload["attendance"]["id_sesi"], first["idSesi"]);
    }

    #[test]
    fn policy_rejection_is_logged_and_enqueued_without_attendance() {
        let (_directory, state) = fixture();
        let result = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "05:59:00"),
        );
        assert_eq!(result["jenisScan"], "Masuk Ditolak - Terlalu Awal");
        assert_eq!(result["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM log_scan), (SELECT COUNT(*) FROM absensi_harian), (SELECT COUNT(*) FROM desktop_sync_outbox);",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("counts");
        assert_eq!(counts, (1, 0, 1));
    }

    #[test]
    fn known_employee_rejections_are_logged_and_enqueued() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE master_data SET status_aktif = 'Nonaktif' WHERE id_unik = 'K001';",
                [],
            )
            .expect("disable employee");
        drop(connection);

        let inactive = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:00"),
        );
        assert_eq!(inactive["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE master_data SET status_aktif = 'Aktif' WHERE id_unik = 'K001';",
                [],
            )
            .expect("enable employee");
        drop(connection);
        let invalid_token = scan(&state, "K001", "SALAH", moment("2026-08-12", "07:01:00"));
        assert_eq!(invalid_token["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM log_scan), (SELECT COUNT(*) FROM absensi_harian), (SELECT COUNT(*) FROM desktop_sync_outbox);",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("known rejection counts");
        assert_eq!(counts, (2, 0, 2));
    }

    #[test]
    fn desktop_geofence_rejection_is_logged_without_attendance() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES
          ('geofence_enabled', 'true'),
          ('lat_kantor', '-6.200000'),
          ('lng_kantor', '106.816666'),
          ('radius_meter', '100');
        "#,
            )
            .expect("geofence settings");
        drop(connection);

        let result = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:00"),
        );
        assert_eq!(result["sukses"], false);
        assert_eq!(result["catatanSistem"], "GPS Tidak Terdeteksi");

        let connection = storage::database(&state.data_dir).expect("local database");
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM log_scan), (SELECT COUNT(*) FROM absensi_harian), (SELECT COUNT(*) FROM desktop_sync_outbox);",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("geofence counts");
        assert_eq!(counts, (1, 0, 1));
    }

    #[test]
    fn multi_scan_uses_policy_after_cooldown() {
        let (_directory, state) = fixture();
        let first = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:00"),
        );
        let second = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:03:00"),
        );
        assert_eq!(first["jenisScan"], "Masuk");
        assert_eq!(second["jenisScan"], "Multi Scan Ditolak");

        let connection = storage::database(&state.data_dir).expect("local database");
        let rejected: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM log_scan WHERE jenis_scan = 'Multi Scan Ditolak' AND status_proses = 'Ditolak';",
                [],
                |row| row.get(0),
            )
            .expect("multi-scan log");
        assert_eq!(rejected, 1);
    }

    #[test]
    fn night_shift_keeps_one_session_on_the_entry_work_date() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE tbl_shift SET jam_masuk = '23:00', jam_pulang = '07:00' WHERE id_shift = 1;",
                [],
            )
            .expect("night shift");
        drop(connection);

        let entry = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "23:00:00"),
        );
        let exit = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-13", "07:00:00"),
        );
        assert_eq!(entry["idSesi"], "NORMAL-20260812-K001-1");
        assert_eq!(exit["idSesi"], "NORMAL-20260812-K001-1");
        assert_eq!(exit["jenisScan"], "Pulang");
        assert_eq!(exit["jamKerja"], 420);

        let connection = storage::database(&state.data_dir).expect("local database");
        let stored: (String, String, String) = connection
            .query_row(
                "SELECT tanggal, jam_masuk, jam_pulang FROM absensi_harian;",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("night attendance");
        assert_eq!(
            stored,
            (
                "2026-08-12".into(),
                "2026-08-12 23:00:00".into(),
                "2026-08-13 07:00:00".into()
            )
        );
    }

    #[test]
    fn admin_correction_cannot_be_overwritten_by_scanner() {
        let (_directory, state) = fixture();
        scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "07:00:00"),
        );
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE absensi_harian SET sumber = 'Koreksi Admin', keterangan = 'Dikunci admin' WHERE id_karyawan = 'K001';",
                [],
            )
            .expect("admin correction");
        drop(connection);

        let result = scan(
            &state,
            "K001",
            "TOKEN-TEST",
            moment("2026-08-12", "15:00:00"),
        );
        assert_eq!(result["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        let stored: (String, String, i64) = connection
            .query_row(
                "SELECT sumber, COALESCE(jam_pulang, ''), (SELECT COUNT(*) FROM desktop_sync_outbox) FROM absensi_harian WHERE id_karyawan = 'K001';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("protected attendance");
        assert_eq!(stored, ("Koreksi Admin".into(), "".into(), 2));
    }

    #[test]
    fn previous_day_night_backup_is_resolved_for_replacement() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute_batch(
                r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
          jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
          offset_istirahat_mulai, buffer_shift_malam_menit
        ) VALUES (2, 2, 'Shift Malam', '23:00', '07:00', 60, 15, 30,
                  420, 60, 120, 240, 120);

        INSERT INTO master_data (
          id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
          token_absensi, qr_code
        ) VALUES ('K002', 'K002', 'Karyawan Pengganti', 'Dapur', 1, 'Aktif',
                  'TOKEN-002', 'K002|TOKEN-002');

        INSERT INTO backup_karyawan (
          id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal,
          divisi_asal, id_shift_asal, id_karyawan_pengganti,
          nama_karyawan_pengganti, divisi_pengganti, id_shift_normal_pengganti,
          id_shift_backup, status_tugas, kode_operator, waktu_input
        ) VALUES ('B001', '2026-08-12', 'K001', 'Karyawan Test', 'Dapur', 1,
                  'K002', 'Karyawan Pengganti', 'Dapur', 1, 2, 'Aktif',
                  'SPD001', '2026-08-12 08:00:00');
        "#,
            )
            .expect("backup seed");
        drop(connection);

        let result = scan(
            &state,
            "K002",
            "TOKEN-002",
            moment("2026-08-13", "07:00:00"),
        );
        assert_eq!(result["sukses"], true);
        assert_eq!(result["status"], "Perlu Verifikasi");
        assert_eq!(result["modeTugas"], "PENGGANTI");
        assert_eq!(result["shiftEfektif"], 2);
        assert_eq!(result["idSesi"], "B001-PENGGANTI-K002");

        let connection = storage::database(&state.data_dir).expect("local database");
        let stored: (String, String, String, String) = connection
            .query_row(
                "SELECT tanggal, mode_tugas, id_backup, tanggal_tugas FROM absensi_harian WHERE id_karyawan = 'K002';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("backup attendance");
        assert_eq!(
            stored,
            (
                "2026-08-12".into(),
                "PENGGANTI".into(),
                "B001".into(),
                "2026-08-12".into()
            )
        );
    }

    #[test]
    fn attendance_log_and_outbox_are_rolled_back_together() {
        let (_directory, state) = fixture();
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute_batch(
                r#"
        CREATE TRIGGER reject_scanner_outbox
        BEFORE INSERT ON desktop_sync_outbox
        BEGIN
          SELECT RAISE(ABORT, 'outbox failure');
        END;
        "#,
            )
            .expect("failure trigger");
        drop(connection);

        let result = submit_at(
            &state,
            &json!({ "qrContent": "K001|TOKEN-TEST" }),
            "SPD001",
            moment("2026-08-12", "07:00:00"),
        );
        assert!(result.is_err());

        let connection = storage::database(&state.data_dir).expect("local database");
        let counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM absensi_harian), (SELECT COUNT(*) FROM log_scan), (SELECT COUNT(*) FROM desktop_sync_outbox);",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("rolled back counts");
        assert_eq!(counts, (0, 0, 0));
    }
}
