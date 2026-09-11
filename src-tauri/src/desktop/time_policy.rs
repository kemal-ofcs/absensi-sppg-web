#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShiftKind {
    Regular,
    Flexible,
}

#[derive(Clone, Debug)]
pub struct ShiftPolicy {
    pub kind: ShiftKind,
    pub start: String,
    pub end: String,
    pub early_window_minutes: i64,
    pub normal_entry_minutes: i64,
    pub late_tolerance_minutes: i64,
    pub checkout_limit_minutes: i64,
    pub night_buffer_minutes: i64,
    pub break_offset_minutes: i64,
    pub normal_work_minutes: i64,
    pub break_minutes: i64,
}

#[derive(Clone, Debug, Default)]
pub struct ScanHistory {
    pub check_in: Option<String>,
    pub check_out: Option<String>,
    pub last_scan: Option<String>,
    pub last_scan_kind: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LocalMoment {
    pub timestamp: String,
    pub date: String,
    pub time: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WorkMetrics {
    pub presence_minutes: i64,
    pub break_deduction_minutes: i64,
    pub work_minutes: i64,
    pub overtime_minutes: i64,
    pub shortage_minutes: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecisionReason {
    FlexEntry,
    FlexExit,
    AlreadyCheckedOut,
    TooEarly,
    EarlyEntry,
    OnTimeEntry,
    LateEntry,
    EntryWindowClosed,
    MultiScan,
    EarlyCheckout,
    NormalCheckout,
    OvertimeCheckout,
    CheckoutTooLate,
    CheckoutWithoutEntry,
    InvalidHistory,
}

#[derive(Clone, Debug)]
pub struct ScanDecision {
    pub allowed: bool,
    pub reason: DecisionReason,
    pub scan_type: String,
    pub process_status: String,
    pub detail: String,
    pub system_note: String,
    pub work_date: String,
    pub late_minutes: i64,
    pub early_minutes: i64,
    pub metrics: WorkMetrics,
}

pub fn determine_work_date(moment: &LocalMoment, shift: &ShiftPolicy) -> Result<String, String> {
    validate_shift(shift)?;
    if shift.kind == ShiftKind::Flexible {
        return Ok(moment.date.clone());
    }
    let start = clock_minutes(&shift.start)?;
    let end = clock_minutes(&shift.end)?;
    if end >= start {
        return Ok(moment.date.clone());
    }
    let current = clock_minutes(&moment.time)?;
    let night_detection_end = end + shift.checkout_limit_minutes + shift.night_buffer_minutes;
    if current <= night_detection_end {
        add_days(&moment.date, -1)
    } else {
        Ok(moment.date.clone())
    }
}

/// Jam Kerja Normal sebuah shift: (Jam Pulang − Jam Masuk) − Istirahat.
///
/// Shift malam (jam pulang < jam masuk) melewati tengah malam, jadi jam
/// pulangnya digeser +1440. Cerminan TS: `hitungJamKerjaNormalMenit`.
pub fn calculate_normal_work_minutes(start: &str, end: &str, break_minutes: i64) -> i64 {
    let start_min = match clock_minutes(start) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    let mut end_min = match clock_minutes(end) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if end_min < start_min {
        end_min += 1440;
    }
    (end_min - start_min - break_minutes).max(0)
}

/// Batas-batas jendela scan masuk dalam menit RELATIF terhadap Jam Masuk:
/// `(buka, mulai_tepat_waktu, tutup)`.
///
/// Jendelanya tersusun mundur dari Jam Masuk, lalu maju sebatas toleransi
/// (contoh 07:00, awal 120, batas 60, toleransi 30):
///
/// ```text
/// 04:00 ─ Awal Absen Masuk ─ 06:00 ─ Tepat Waktu ─ 07:00 ─ Terlambat ─ 07:30
/// buka = -(batas + awal)     mulai = -batas        0      tutup = +toleransi
/// ```
///
/// Sebelum `buka` absensi belum dibuka; setelah `tutup` scan masuk ditolak dan
/// karyawannya harus menghubungi Admin/Operator. Cerminan TS: `jendelaScanMasuk`.
pub fn entry_window_offsets(
    early_window_minutes: i64,
    normal_entry_minutes: i64,
    late_tolerance_minutes: i64,
) -> (i64, i64, i64) {
    (
        -(normal_entry_minutes + early_window_minutes),
        -normal_entry_minutes,
        late_tolerance_minutes,
    )
}

/// Apakah selisih (menit scan − Jam Masuk) masih di dalam jendela scan masuk.
pub fn is_within_entry_window(
    diff_minutes: i64,
    early_window_minutes: i64,
    normal_entry_minutes: i64,
    late_tolerance_minutes: i64,
) -> bool {
    let (open, _, close) = entry_window_offsets(
        early_window_minutes,
        normal_entry_minutes,
        late_tolerance_minutes,
    );
    diff_minutes >= open && diff_minutes <= close
}

/// `(menit_terlambat, menit_datang_awal)`, keduanya diukur dari Jam Masuk.
///
/// Jendela Tepat Waktu kini berada SEBELUM Jam Masuk, sehingga menit pertama
/// setelah Jam Masuk sudah terhitung terlambat. Cerminan TS:
/// `hitungTerlambatDanDatangAwal`.
pub fn late_and_early_minutes(check_in_minute: i64, shift_start_minute: i64) -> (i64, i64) {
    (
        (check_in_minute - shift_start_minute).max(0),
        (shift_start_minute - check_in_minute).max(0),
    )
}

/// Inti perhitungan jam kerja shift reguler. Ketiga argumen waktunya dalam
/// DETIK pada garis waktu yang sama, supaya pemanggil yang hanya punya jam
/// "HH:mm" (koreksi admin, import) dan scanner memakai rumus yang sama persis.
///
/// - Jam kerja dimulai dari Jam Masuk shift: datang lebih awal tidak menambah
///   jam kerja maupun lembur. Datang terlambat tetap dihitung dari jam scan.
/// - Istirahat dimulai pada Jam Masuk + Offset Potong Istirahat. Pulang setelah
///   titik itu memotong istirahat PENUH; pulang sebelum atau tepat pada titik
///   itu tidak dipotong sama sekali.
///
/// Cerminan TS: `hitungMenitKerjaPadaGarisWaktu`.
pub fn calculate_work_on_timeline(
    check_in_seconds: i64,
    check_out_seconds: i64,
    shift_start_seconds: i64,
    break_offset_minutes: i64,
    break_minutes: i64,
    normal_work_minutes: i64,
) -> WorkMetrics {
    let presence_minutes = ((check_out_seconds - check_in_seconds) / 60).max(0);
    let work_start = check_in_seconds.max(shift_start_seconds);
    let break_start = shift_start_seconds + break_offset_minutes * 60;
    let break_end = break_start + break_minutes * 60;
    let break_deduction_minutes = if check_out_seconds > break_start && work_start < break_end {
        break_minutes
    } else {
        0
    };
    let work_minutes =
        ((check_out_seconds - work_start).max(0) / 60 - break_deduction_minutes).max(0);
    WorkMetrics {
        presence_minutes,
        break_deduction_minutes,
        work_minutes,
        overtime_minutes: (work_minutes - normal_work_minutes).max(0),
        shortage_minutes: (normal_work_minutes - work_minutes).max(0),
    }
}

/// Rentang jam masuk yang boleh dicatat lewat KOREKSI ADMIN: sejak absensi
/// dibuka sampai sebelum Jam Pulang.
///
/// Sengaja lebih longgar daripada `is_within_entry_window`: karyawan yang
/// datang melewati toleransi keterlambatan ditolak scanner dan diarahkan ke
/// Admin/Operator, jadi koreksi adalah satu-satunya jalan mencatat kehadirannya.
/// Cerminan TS: `diDalamRentangKoreksiMasuk`.
pub fn is_within_correction_entry_range(
    diff_minutes: i64,
    early_window_minutes: i64,
    normal_entry_minutes: i64,
    late_tolerance_minutes: i64,
    start: &str,
    end: &str,
) -> bool {
    let (open, _, close) = entry_window_offsets(
        early_window_minutes,
        normal_entry_minutes,
        late_tolerance_minutes,
    );
    if diff_minutes < open {
        return false;
    }
    let (Ok(start_minute), Ok(mut end_minute)) = (clock_minutes(start), clock_minutes(end)) else {
        return diff_minutes <= close;
    };
    if end_minute <= start_minute {
        end_minute += 1440;
    }
    diff_minutes < end_minute - start_minute || diff_minutes <= close
}

/// Menempatkan jam masuk "HH:mm" (menit-dalam-hari) pada garis waktu shift:
/// selisihnya terhadap Jam Masuk dinormalkan ke ±12 jam. Cerminan TS:
/// `menitMasukPadaGarisWaktuShift`.
pub fn check_in_minute_on_shift_timeline(check_in_minute: i64, shift_start_minute: i64) -> i64 {
    let mut diff = check_in_minute - shift_start_minute;
    if diff < -720 {
        diff += 1440;
    }
    if diff > 720 {
        diff -= 1440;
    }
    shift_start_minute + diff
}

/// Aturan shift yang dibutuhkan jalur admin untuk menghitung ulang absensi.
pub struct ClockRules<'a> {
    pub start: &'a str,
    pub end: &'a str,
    pub normal_work_minutes: i64,
    pub break_minutes: i64,
    pub break_offset_minutes: i64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ClockRecalc {
    pub late_minutes: i64,
    pub early_minutes: i64,
    pub work_minutes: i64,
    pub overtime_minutes: i64,
    pub shortage_minutes: i64,
}

/// Perhitungan ulang untuk jalur admin (koreksi, import, hapus log) yang hanya
/// memegang jam masuk "HH:mm" dan durasi hadir yang sudah dihitung pemanggilnya.
/// Rumusnya sama dengan scanner. Shift fleksibel: terlambat/datang awal 0 dan
/// jam kerja = durasi − istirahat, seperti sebelumnya.
/// Cerminan TS: `hitungUlangAbsensiDariJam`.
pub fn recalculate_from_clock(
    check_in_minute: Option<i64>,
    duration_minutes: Option<i64>,
    rules: &ClockRules<'_>,
) -> ClockRecalc {
    let mut result = ClockRecalc::default();
    let Some(check_in_minute) = check_in_minute else {
        return result;
    };
    let normal = rules.normal_work_minutes;
    if is_flexible_shift(rules.start, rules.end, normal) {
        if let Some(duration) = duration_minutes {
            result.work_minutes = (duration - rules.break_minutes).max(0);
            result.overtime_minutes = (result.work_minutes - normal).max(0);
            result.shortage_minutes = (normal - result.work_minutes).max(0);
        }
        return result;
    }
    let Ok(shift_start) = clock_minutes(rules.start) else {
        return result;
    };
    let check_in = check_in_minute_on_shift_timeline(check_in_minute, shift_start);
    let (late, early) = late_and_early_minutes(check_in, shift_start);
    result.late_minutes = late;
    result.early_minutes = early;
    if let Some(duration) = duration_minutes {
        let metrics = calculate_work_on_timeline(
            check_in * 60,
            (check_in + duration) * 60,
            shift_start * 60,
            rules.break_offset_minutes,
            rules.break_minutes,
            normal,
        );
        result.work_minutes = metrics.work_minutes;
        result.overtime_minutes = metrics.overtime_minutes;
        result.shortage_minutes = metrics.shortage_minutes;
    }
    result
}

pub fn calculate_work(
    check_in: &str,
    check_out: &str,
    shift: &ShiftPolicy,
) -> Result<WorkMetrics, String> {
    validate_shift(shift)?;
    let check_in_seconds = timestamp_seconds(check_in)?;
    let check_out_seconds = timestamp_seconds(check_out)?;
    if shift.kind == ShiftKind::Flexible {
        let presence_minutes = ((check_out_seconds - check_in_seconds) / 60).max(0);
        return Ok(WorkMetrics {
            presence_minutes,
            work_minutes: presence_minutes,
            ..WorkMetrics::default()
        });
    }
    // Jam Masuk shift pada tanggal kerja scan masuk, di garis waktu yang sama
    // dengan `timestamp_seconds`.
    let work_date = determine_work_date(&timestamp_to_moment(check_in)?, shift)?;
    let shift_start_seconds = parse_date(&work_date)? * 86_400 + clock_minutes(&shift.start)? * 60;
    Ok(calculate_work_on_timeline(
        check_in_seconds,
        check_out_seconds,
        shift_start_seconds,
        shift.break_offset_minutes,
        shift.break_minutes,
        shift.normal_work_minutes,
    ))
}

pub fn decide_scan(
    moment: &LocalMoment,
    shift: &ShiftPolicy,
    history: &ScanHistory,
    multi_scan_minutes: i64,
) -> Result<ScanDecision, String> {
    validate_shift(shift)?;
    if multi_scan_minutes < 0 {
        return Err("Batas multi-scan tidak boleh negatif.".into());
    }
    let work_date = if let Some(check_in) = history.check_in.as_deref() {
        let m = timestamp_to_moment(check_in)?;
        determine_work_date(&m, shift)?
    } else if let Some(check_out) = history.check_out.as_deref() {
        let m = timestamp_to_moment(check_out)?;
        determine_work_date(&m, shift)?
    } else {
        determine_work_date(moment, shift)?
    };

    if history
        .check_out
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        return Ok(decision(
            false,
            DecisionReason::AlreadyCheckedOut,
            "Pulang Ditolak",
            "Ditolak",
            "",
            "Scan pulang sudah tercatat sebelumnya",
            work_date,
        ));
    }

    if let Some(check_in) = history.check_in.as_deref() {
        if timestamp_seconds(&moment.timestamp)? < timestamp_seconds(check_in)? {
            return Ok(decision(
                false,
                DecisionReason::InvalidHistory,
                "Scan Ditolak",
                "Ditolak",
                "",
                "Waktu scan lebih awal daripada riwayat masuk",
                work_date,
            ));
        }
    }

    if history.check_in.is_some()
        && history.last_scan_kind.as_deref() == Some("Masuk")
        && multi_scan_minutes > 0
    {
        if let Some(last_scan) = history.last_scan.as_deref() {
            let difference = timestamp_seconds(&moment.timestamp)? - timestamp_seconds(last_scan)?;
            if difference < 0 {
                return Ok(decision(
                    false,
                    DecisionReason::InvalidHistory,
                    "Scan Ditolak",
                    "Ditolak",
                    "",
                    "Waktu scan lebih awal daripada scan terakhir",
                    work_date,
                ));
            }
            if difference <= multi_scan_minutes * 60 {
                return Ok(decision(
                    false,
                    DecisionReason::MultiScan,
                    "Multi Scan Ditolak",
                    "Ditolak",
                    "",
                    &format!("Kemungkinan scan masuk ganda dalam {multi_scan_minutes} menit"),
                    work_date,
                ));
            }
        }
    }

    let check_in = history
        .check_in
        .as_deref()
        .filter(|value| !value.is_empty());
    if shift.kind == ShiftKind::Flexible {
        if check_in.is_none() {
            return Ok(decision(
                true,
                DecisionReason::FlexEntry,
                "Masuk",
                "Berhasil",
                "Fleksibel",
                "Scan masuk shift fleksibel",
                work_date,
            ));
        }
        let mut result = decision(
            true,
            DecisionReason::FlexExit,
            "Pulang",
            "Berhasil",
            "Fleksibel",
            "Scan pulang shift fleksibel",
            work_date,
        );
        result.metrics = calculate_work(check_in.unwrap_or_default(), &moment.timestamp, shift)?;
        return Ok(result);
    }

    let current = days_between(&work_date, &moment.date)? * 1440 + clock_minutes(&moment.time)?;
    let start = clock_minutes(&shift.start)?;
    let raw_end = clock_minutes(&shift.end)?;
    let end = if raw_end < start {
        raw_end + 1440
    } else {
        raw_end
    };
    let (open_offset, on_time_offset, close_offset) = entry_window_offsets(
        shift.early_window_minutes,
        shift.normal_entry_minutes,
        shift.late_tolerance_minutes,
    );
    let entry_open = start + open_offset;
    let on_time_start = start + on_time_offset;
    let final_entry_end = start + close_offset;
    let final_checkout = end + shift.checkout_limit_minutes;
    let (late_minutes, early_minutes) = late_and_early_minutes(current, start);

    if check_in.is_none() {
        if current >= end && current <= final_checkout {
            return Ok(decision(
                true,
                DecisionReason::CheckoutWithoutEntry,
                "Pulang",
                "Perlu Verifikasi",
                "Perlu Verifikasi",
                "Scan pulang tanpa data scan masuk",
                work_date,
            ));
        }
        if current < entry_open {
            return Ok(decision(
                false,
                DecisionReason::TooEarly,
                "Masuk Ditolak - Terlalu Awal",
                "Ditolak",
                "",
                "Scan sebelum jendela Awal Absen Masuk dibuka",
                work_date,
            ));
        }
        if current < on_time_start {
            let mut result = decision(
                true,
                DecisionReason::EarlyEntry,
                "Masuk",
                "Berhasil",
                "Datang Lebih Awal",
                "Scan masuk dalam jendela Awal Absen Masuk",
                work_date,
            );
            result.early_minutes = early_minutes;
            return Ok(result);
        }
        if current <= start {
            let mut result = decision(
                true,
                DecisionReason::OnTimeEntry,
                "Masuk",
                "Berhasil",
                "Tepat Waktu",
                "Scan masuk tepat waktu",
                work_date,
            );
            result.early_minutes = early_minutes;
            return Ok(result);
        }
        if current <= final_entry_end {
            let mut result = decision(
                true,
                DecisionReason::LateEntry,
                "Masuk",
                "Berhasil",
                "Terlambat",
                "Scan masuk dalam toleransi keterlambatan",
                work_date,
            );
            result.late_minutes = late_minutes;
            return Ok(result);
        }
        return Ok(decision(
            false,
            DecisionReason::EntryWindowClosed,
            "Masuk Ditolak",
            "Ditolak",
            "",
            "Melewati batas toleransi keterlambatan, perlu Admin/Operator",
            work_date,
        ));
    }

    if current > final_checkout {
        return Ok(decision(
            false,
            DecisionReason::CheckoutTooLate,
            "Pulang Ditolak",
            "Ditolak",
            "",
            "Melewati batas waktu pulang shift",
            work_date,
        ));
    }

    let metrics = calculate_work(check_in.unwrap_or_default(), &moment.timestamp, shift)?;
    if current < end {
        let mut result = decision(
            true,
            DecisionReason::EarlyCheckout,
            "Pulang",
            "Berhasil",
            "Pulang Lebih Awal",
            "Pulang lebih awal",
            work_date,
        );
        result.metrics = metrics;
        return Ok(result);
    }
    if metrics.overtime_minutes > 0 {
        let mut result = decision(
            true,
            DecisionReason::OvertimeCheckout,
            "Pulang",
            "Berhasil",
            "Pulang Lembur",
            "Pulang lembur",
            work_date,
        );
        result.metrics = metrics;
        return Ok(result);
    }
    let detail = if metrics.shortage_minutes > 0 {
        "Pulang Lebih Awal"
    } else {
        "Pulang Normal"
    };
    let mut result = decision(
        true,
        DecisionReason::NormalCheckout,
        "Pulang",
        "Berhasil",
        detail,
        "Pulang dalam jendela normal",
        work_date,
    );
    result.metrics = metrics;
    Ok(result)
}

fn decision(
    allowed: bool,
    reason: DecisionReason,
    scan_type: &str,
    process_status: &str,
    detail: &str,
    system_note: &str,
    work_date: String,
) -> ScanDecision {
    ScanDecision {
        allowed,
        reason,
        scan_type: scan_type.into(),
        process_status: process_status.into(),
        detail: detail.into(),
        system_note: system_note.into(),
        work_date,
        late_minutes: 0,
        early_minutes: 0,
        metrics: WorkMetrics::default(),
    }
}

fn validate_shift(shift: &ShiftPolicy) -> Result<(), String> {
    clock_minutes(&shift.start)?;
    clock_minutes(&shift.end)?;
    for value in [
        shift.early_window_minutes,
        shift.normal_entry_minutes,
        shift.late_tolerance_minutes,
        shift.checkout_limit_minutes,
        shift.night_buffer_minutes,
        shift.break_offset_minutes,
        shift.normal_work_minutes,
        shift.break_minutes,
    ] {
        if value < 0 {
            return Err("Konfigurasi menit shift tidak boleh negatif.".into());
        }
    }
    Ok(())
}

fn clock_minutes(value: &str) -> Result<i64, String> {
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() < 2 || parts.len() > 3 {
        return Err("Jam shift harus berformat HH:mm.".into());
    }
    let hour = parts[0]
        .parse::<i64>()
        .map_err(|_| "Jam shift tidak valid.".to_owned())?;
    let minute = parts[1]
        .parse::<i64>()
        .map_err(|_| "Menit shift tidak valid.".to_owned())?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return Err("Jam shift berada di luar rentang 24 jam.".into());
    }
    Ok(hour * 60 + minute)
}

fn timestamp_seconds(value: &str) -> Result<i64, String> {
    let normalized = value.replace('T', " ");
    let mut parts = normalized.split_whitespace();
    let date = parts
        .next()
        .ok_or_else(|| "Tanggal timestamp tidak tersedia.".to_owned())?;
    let time = parts
        .next()
        .ok_or_else(|| "Jam timestamp tidak tersedia.".to_owned())?;
    if parts.next().is_some() {
        return Err("Timestamp lokal tidak valid.".into());
    }
    let time_parts = time.split(':').collect::<Vec<_>>();
    if time_parts.len() != 3 {
        return Err("Timestamp harus memuat detik.".into());
    }
    let hour = time_parts[0]
        .parse::<i64>()
        .map_err(|_| "Jam timestamp tidak valid.".to_owned())?;
    let minute = time_parts[1]
        .parse::<i64>()
        .map_err(|_| "Menit timestamp tidak valid.".to_owned())?;
    let second = time_parts[2]
        .parse::<i64>()
        .map_err(|_| "Detik timestamp tidak valid.".to_owned())?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=59).contains(&second) {
        return Err("Timestamp berada di luar rentang waktu.".into());
    }
    Ok(parse_date(date)? * 86_400 + hour * 3600 + minute * 60 + second)
}

pub fn timestamp_to_moment(value: &str) -> Result<LocalMoment, String> {
    let normalized = value.replace('T', " ");
    let mut parts = normalized.split_whitespace();
    let date = parts
        .next()
        .ok_or_else(|| "Tanggal timestamp tidak tersedia.".to_owned())?;
    let time = parts
        .next()
        .ok_or_else(|| "Jam timestamp tidak tersedia.".to_owned())?;
    Ok(LocalMoment {
        timestamp: value.to_owned(),
        date: date.to_owned(),
        time: time.to_owned(),
    })
}

pub fn days_between(from: &str, to: &str) -> Result<i64, String> {
    Ok(parse_date(to)? - parse_date(from)?)
}

pub fn add_days(date: &str, amount: i64) -> Result<String, String> {
    let days = parse_date(date)? + amount;
    let (year, month, day) = civil_from_days(days);
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

fn parse_date(value: &str) -> Result<i64, String> {
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err("Tanggal harus berformat YYYY-MM-DD.".into());
    }
    let year = parts[0]
        .parse::<i64>()
        .map_err(|_| "Tahun tidak valid.".to_owned())?;
    let month = parts[1]
        .parse::<i64>()
        .map_err(|_| "Bulan tidak valid.".to_owned())?;
    let day = parts[2]
        .parse::<i64>()
        .map_err(|_| "Hari tidak valid.".to_owned())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("Tanggal berada di luar rentang kalender.".into());
    }
    let ordinal = days_from_civil(year, month, day);
    let (parsed_year, parsed_month, parsed_day) = civil_from_days(ordinal);
    if (parsed_year, parsed_month, parsed_day) != (year, month, day) {
        return Err("Tanggal kalender tidak valid.".into());
    }
    Ok(ordinal)
}

fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

/// Menit terakhir sebuah hari kalender (23:59).
///
/// Dipakai sebagai penutup jendela untuk shift fleksibel: shift itu berjalan
/// 00:00-23:59 tanpa aturan, sehingga satu-satunya batas yang masuk akal
/// adalah pergantian hari.
pub const END_OF_DAY_MINUTE: i64 = 1439;

/// Shift "tanpa kewajiban jam tetap" (lihat `05-business-logic-edge-cases.md` §2).
///
/// Sengaja TIDAK melihat `kode_shift`: kolom itu adalah *stable business key*
/// untuk rekonsiliasi shift offline (`03-schema-4layer-consistency.md`), bukan
/// penanda fleksibel. Porting lama menyamakan `kode_shift == 4` dengan
/// fleksibel, sehingga shift reguler apa pun yang kebetulan memakai kode 4
/// diam-diam dilewati scanner dan Generate Alfa.
pub fn shift_kind_of(start: &str, end: &str, normal_work_minutes: i64) -> ShiftKind {
    if is_flexible_shift(start, end, normal_work_minutes) {
        ShiftKind::Flexible
    } else {
        ShiftKind::Regular
    }
}

pub fn is_flexible_shift(start: &str, end: &str, normal_work_minutes: i64) -> bool {
    if normal_work_minutes <= 0 {
        return true;
    }
    let (Ok(start_minute), Ok(end_minute)) = (clock_minutes(start), clock_minutes(end)) else {
        return false;
    };
    // Rentang yang menutupi satu hari penuh: tidak ada jam masuk/pulang efektif.
    start_minute == end_minute || (start_minute == 0 && end_minute == 1439)
}

/// Menit pada garis waktu tanggal kerja saat jendela scan pulang tertutup.
///
/// Untuk shift malam jam pulang berada di hari berikutnya, sehingga nilainya
/// melewati 1440. `None` berarti jam shift tidak dapat diurai.
pub fn latest_checkout_minute(shift: &ShiftPolicy) -> Option<i64> {
    // Shift fleksibel tidak punya jam pulang efektif: kewajibannya berakhir
    // bersama hari kalendernya. Memakai rumus reguler di sini akan menambahkan
    // batas_pulang ke 23:59 dan mendorong penilaian jauh ke hari berikutnya.
    if shift.kind == ShiftKind::Flexible {
        return Some(END_OF_DAY_MINUTE);
    }
    let shift_in = clock_minutes(&shift.start).ok()?;
    let shift_out_base = clock_minutes(&shift.end).ok()?;
    let is_night = shift_out_base < shift_in;
    let shift_out = if is_night {
        shift_out_base + 1440
    } else {
        shift_out_base
    };
    let buffer = if is_night {
        shift.night_buffer_minutes
    } else {
        0
    };
    Some(shift_out + shift.checkout_limit_minutes + buffer)
}

/// Menit pada garis waktu tanggal kerja saat Alfa otomatis boleh dibuat.
///
/// Anchor-nya adalah penutupan jendela scan pulang (jam pulang + batas pulang
/// + buffer shift malam), lalu ditambah `offset_generate_alfa`. Offset
/// DITAMBAHKAN, bukan dikurangi, supaya Alfa tidak pernah dibuat selagi
/// karyawan masih berhak scan pulang.
pub fn alfa_generation_minute(shift: &ShiftPolicy, alfa_offset_minutes: i64) -> Option<i64> {
    Some(latest_checkout_minute(shift)? + alfa_offset_minutes.max(0))
}

/// Menit pada garis waktu tanggal kerja saat jendela scan masuk tertutup.
///
/// Sama dengan `final_entry_end` di `decide_scan`: Jam Masuk + Toleransi
/// Keterlambatan. Setelah menit ini scanner menolak scan masuk, jadi karyawan
/// yang belum punya baris absensi memang benar-benar "belum absen padahal jam
/// absen sudah lewat".
pub fn entry_window_close_minute(shift: &ShiftPolicy) -> Option<i64> {
    // Karyawan shift fleksibel bebas datang jam berapa pun, jadi tidak ada
    // menit di tengah hari yang membuatnya "belum absen padahal sudah lewat".
    // Baru setelah harinya habis ketidakhadiran itu bisa dinilai.
    if shift.kind == ShiftKind::Flexible {
        return Some(END_OF_DAY_MINUTE);
    }
    let start = clock_minutes(&shift.start).ok()?;
    let (_, _, close) = entry_window_offsets(
        shift.early_window_minutes,
        shift.normal_entry_minutes,
        shift.late_tolerance_minutes,
    );
    Some(start + close)
}

pub fn is_checkout_window_expired(
    session_date: &str,
    moment: &LocalMoment,
    shift: &ShiftPolicy,
) -> bool {
    if shift.kind == ShiftKind::Flexible {
        return false;
    }
    let Some(latest_checkout) = latest_checkout_minute(shift) else {
        return true;
    };

    let diff_days = days_between(session_date, &moment.date).unwrap_or(0);
    let moment_min = clock_minutes(&moment.time).unwrap_or(0);
    let current_minute_on_timeline = diff_days * 1440 + moment_min;
    current_minute_on_timeline > latest_checkout
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regular() -> ShiftPolicy {
        ShiftPolicy {
            kind: ShiftKind::Regular,
            start: "07:00".into(),
            end: "15:00".into(),
            early_window_minutes: 60,
            normal_entry_minutes: 15,
            late_tolerance_minutes: 30,
            checkout_limit_minutes: 120,
            night_buffer_minutes: 120,
            break_offset_minutes: 240,
            normal_work_minutes: 420,
            break_minutes: 60,
        }
    }

    #[test]
    fn jendela_masuk_tutup_pada_jam_masuk_ditambah_toleransi() {
        let mut shift = regular();
        shift.start = "07:00".into();
        shift.normal_entry_minutes = 15;
        shift.late_tolerance_minutes = 30;

        // 07:00 (420) + toleransi 30 = 07:30 (450) — persis `final_entry_end`
        // yang dipakai decide_scan. Batas Tepat Waktu tidak lagi ikut
        // dijumlahkan: jendelanya kini berada SEBELUM jam masuk.
        assert_eq!(entry_window_close_minute(&shift), Some(450));

        let tolak = decide_scan(
            &moment("2026-08-19", "07:31"),
            &shift,
            &ScanHistory::default(),
            0,
        )
        .expect("keputusan scan");
        assert_eq!(tolak.reason, DecisionReason::EntryWindowClosed);
    }

    #[test]
    fn jendela_masuk_disusun_mundur_dari_jam_masuk() {
        // Vektor yang sama dengan `time-policy.test.ts`: awal 120, batas 60,
        // toleransi 30 → buka −180, tepat waktu −60, tutup +30.
        assert_eq!(entry_window_offsets(120, 60, 30), (-180, -60, 30));
        assert!(!is_within_entry_window(-181, 120, 60, 30));
        assert!(is_within_entry_window(-180, 120, 60, 30));
        assert!(is_within_entry_window(0, 120, 60, 30));
        assert!(is_within_entry_window(30, 120, 60, 30));
        assert!(!is_within_entry_window(31, 120, 60, 30));
        assert_eq!(late_and_early_minutes(430, 420), (10, 0));
        assert_eq!(late_and_early_minutes(400, 420), (0, 20));
    }

    #[test]
    fn koreksi_admin_boleh_mencatat_masuk_setelah_toleransi_sebelum_pulang() {
        // Vektor yang sama dengan `time-policy.test.ts`.
        let range = |diff| is_within_correction_entry_range(diff, 120, 60, 0, "07:00", "15:00");
        assert!(!range(-181));
        assert!(range(45));
        assert!(range(479));
        assert!(!range(480));
    }

    #[test]
    fn perhitungan_ulang_jalur_admin_sama_dengan_scanner() {
        let rules = ClockRules {
            start: "07:00",
            end: "15:00",
            normal_work_minutes: 420,
            break_minutes: 60,
            break_offset_minutes: 240,
        };
        assert_eq!(
            recalculate_from_clock(Some(360), Some(540), &rules),
            ClockRecalc {
                late_minutes: 0,
                early_minutes: 60,
                work_minutes: 420,
                overtime_minutes: 0,
                shortage_minutes: 0,
            }
        );
        assert_eq!(
            recalculate_from_clock(Some(430), None, &rules),
            ClockRecalc {
                late_minutes: 10,
                ..ClockRecalc::default()
            }
        );
        let night = ClockRules {
            start: "22:00",
            end: "06:00",
            ..rules
        };
        assert_eq!(recalculate_from_clock(Some(10), None, &night).late_minutes, 130);
        let flexible = ClockRules {
            start: "00:00",
            end: "23:59",
            normal_work_minutes: 1439,
            break_minutes: 0,
            ..rules
        };
        assert_eq!(recalculate_from_clock(Some(780), Some(240), &flexible).late_minutes, 0);
    }

    #[test]
    fn jam_kerja_normal_tidak_lagi_ditambah_batas_masuk() {
        assert_eq!(calculate_normal_work_minutes("07:00", "15:00", 60), 420);
        assert_eq!(calculate_normal_work_minutes("22:00", "06:00", 60), 420);
        assert_eq!(calculate_normal_work_minutes("07:00", "07:30", 60), 0);
        assert_eq!(calculate_normal_work_minutes("bukan-jam", "15:00", 60), 0);
    }

    #[test]
    fn jam_kerja_dimulai_dari_jam_masuk_shift() {
        // Datang 06:00 (jendela Tepat Waktu) pulang 15:00: satu jam sebelum
        // jam masuk tidak menjadi jam kerja maupun lembur.
        let early = calculate_work("2026-08-12 06:00:00", "2026-08-12 15:00:00", &regular())
            .expect("datang awal");
        assert_eq!(
            (early.presence_minutes, early.work_minutes, early.overtime_minutes),
            (540, 420, 0)
        );
        // Terlambat tetap dihitung dari jam scan sebenarnya.
        let late = calculate_work("2026-08-12 07:10:00", "2026-08-12 15:00:00", &regular())
            .expect("terlambat");
        assert_eq!((late.work_minutes, late.shortage_minutes), (410, 10));
    }

    #[test]
    fn istirahat_dipotong_penuh_setelah_jam_masuk_ditambah_offset() {
        // Istirahat mulai 07:00 + 240 = 11:00, lamanya 60 menit.
        let cases = [
            ("10:30", 0, 210),
            ("11:00", 0, 240),
            ("11:01", 60, 181),
            ("11:30", 60, 210),
            ("12:00", 60, 240),
        ];
        for (out, deduction, work) in cases {
            let metrics = calculate_work(
                "2026-08-12 07:00:00",
                &format!("2026-08-12 {out}:00"),
                &regular(),
            )
            .expect("metrics");
            assert_eq!(
                (metrics.break_deduction_minutes, metrics.work_minutes),
                (deduction, work),
                "pulang {out}"
            );
        }
        // Offset diukur dari JAM MASUK SHIFT, bukan dari jam scan: datang
        // 06:00 lalu pulang 10:30 belum melewati 11:00, jadi tidak dipotong.
        let early = calculate_work("2026-08-12 06:00:00", "2026-08-12 10:30:00", &regular())
            .expect("datang awal");
        assert_eq!((early.break_deduction_minutes, early.work_minutes), (0, 210));
    }

    #[test]
    fn jam_kerja_shift_malam_dimulai_dari_jam_masuk() {
        let mut shift = regular();
        shift.start = "22:00".into();
        shift.end = "06:00".into();
        let metrics = calculate_work("2026-08-12 21:00:00", "2026-08-13 06:00:00", &shift)
            .expect("shift malam");
        assert_eq!(
            (metrics.presence_minutes, metrics.break_deduction_minutes, metrics.work_minutes),
            (540, 60, 420)
        );
    }

    fn fleksibel() -> ShiftPolicy {
        ShiftPolicy {
            kind: ShiftKind::Flexible,
            start: "00:00".into(),
            end: "23:59".into(),
            early_window_minutes: 0,
            normal_entry_minutes: 0,
            late_tolerance_minutes: 0,
            checkout_limit_minutes: 0,
            night_buffer_minutes: 0,
            break_offset_minutes: 0,
            normal_work_minutes: 0,
            break_minutes: 0,
        }
    }

    #[test]
    fn jendela_shift_fleksibel_tutup_di_akhir_hari() {
        let shift = fleksibel();
        // Bebas datang dan pulang jam berapa pun sepanjang harinya, jadi tidak
        // ada menit di tengah hari yang bisa dipakai menyalahkan karyawan.
        assert_eq!(entry_window_close_minute(&shift), Some(END_OF_DAY_MINUTE));
        assert_eq!(latest_checkout_minute(&shift), Some(END_OF_DAY_MINUTE));
    }

    #[test]
    fn batas_pulang_tidak_memperpanjang_hari_shift_fleksibel() {
        // Shift fleksibel warisan kerap menyimpan batas_pulang besar (mis. 1440).
        // Rumus reguler akan mendorong penutupan ke 23:59 + 1440, sehingga
        // ketidakhadiran sehari penuh tidak pernah dinilai.
        let mut shift = fleksibel();
        shift.checkout_limit_minutes = 1440;
        shift.night_buffer_minutes = 120;
        assert_eq!(latest_checkout_minute(&shift), Some(END_OF_DAY_MINUTE));
    }

    #[test]
    fn cutoff_alfa_shift_fleksibel_jatuh_setelah_tengah_malam() {
        let shift = fleksibel();
        // 23:59 + 0 = akhir hari itu sendiri.
        assert_eq!(alfa_generation_minute(&shift, 0), Some(END_OF_DAY_MINUTE));
        // Offset menjadi jeda setelah pergantian hari: 23:59 + 61 = 01:00 H+1.
        assert_eq!(alfa_generation_minute(&shift, 61), Some(1500));
    }

    #[test]
    fn shift_kind_of_mengikuti_deteksi_fleksibel() {
        assert_eq!(shift_kind_of("00:00", "23:59", 1439), ShiftKind::Flexible);
        assert_eq!(shift_kind_of("08:00", "17:00", 0), ShiftKind::Flexible);
        assert_eq!(shift_kind_of("07:00", "15:00", 420), ShiftKind::Regular);
        // Jam rusak tetap diperlakukan reguler agar tidak diam-diam dilewati.
        assert_eq!(shift_kind_of("bukan-jam", "15:00", 420), ShiftKind::Regular);
    }

    #[test]
    fn kode_shift_bukan_penanda_fleksibel() {
        // Shift reguler pendek: dulu shift apa pun dengan kode 4 dianggap
        // fleksibel dan diam-diam dilewati Generate Alfa.
        assert!(!is_flexible_shift("07:00", "09:40", 160));
        assert!(!is_flexible_shift("07:00", "15:00", 420));
        assert!(!is_flexible_shift("22:00", "06:00", 480));
    }

    #[test]
    fn shift_tanpa_jam_tetap_dianggap_fleksibel() {
        assert!(is_flexible_shift("08:00", "17:00", 0));
        assert!(is_flexible_shift("00:00", "23:59", 540));
        assert!(is_flexible_shift("09:00", "09:00", 540));
    }

    #[test]
    fn jam_shift_rusak_tidak_dianggap_fleksibel() {
        // Fail-closed: jam tak terurai bukan alasan melewatkan Generate Alfa
        // secara diam-diam; `alfa_generation_minute` yang akan melaporkannya.
        assert!(!is_flexible_shift("bukan-jam", "17:00", 540));
    }

    #[test]
    fn cutoff_alfa_menambahkan_batas_pulang_dan_offset() {
        let mut shift = regular();
        shift.end = "09:40".into();
        shift.checkout_limit_minutes = 5;

        // 09:40 (580) + batas pulang 5 + offset 5 = 09:50 (590).
        assert_eq!(alfa_generation_minute(&shift, 5), Some(590));
        // Anchor-nya adalah penutupan jendela scan pulang, bukan jam pulang.
        assert_eq!(latest_checkout_minute(&shift), Some(585));
    }

    #[test]
    fn cutoff_alfa_shift_malam_melewati_tengah_malam() {
        let mut shift = regular();
        shift.start = "22:00".into();
        shift.end = "06:00".into();
        shift.checkout_limit_minutes = 60;
        shift.night_buffer_minutes = 120;

        // 06:00 hari berikutnya (360 + 1440) + 60 + 120 + offset 30.
        assert_eq!(alfa_generation_minute(&shift, 30), Some(1800 + 60 + 120 + 30));
    }

    #[test]
    fn cutoff_alfa_menolak_jam_shift_rusak() {
        let mut shift = regular();
        shift.end = "25:99".into();
        assert_eq!(alfa_generation_minute(&shift, 30), None);
    }

    fn moment(date: &str, time: &str) -> LocalMoment {
        LocalMoment {
            timestamp: format!("{date} {time}:00"),
            date: date.into(),
            time: format!("{time}:00"),
        }
    }

    fn decide(time: &str, history: ScanHistory) -> ScanDecision {
        decide_scan(&moment("2026-08-12", time), &regular(), &history, 10).expect("decision")
    }

    #[test]
    fn regular_entry_matrix_matches_web() {
        // Shift 07:00, awal 60, batas tepat waktu 15, toleransi 30:
        // 05:45 ─ awal absen ─ 06:45 ─ tepat waktu ─ 07:00 ─ terlambat ─ 07:30.
        assert_eq!(
            decide("05:44", ScanHistory::default()).reason,
            DecisionReason::TooEarly
        );
        let early = decide("06:00", ScanHistory::default());
        assert_eq!(
            (early.reason, early.early_minutes),
            (DecisionReason::EarlyEntry, 60)
        );
        let on_time = decide("06:50", ScanHistory::default());
        assert_eq!(
            (on_time.reason, on_time.early_minutes, on_time.late_minutes),
            (DecisionReason::OnTimeEntry, 10, 0)
        );
        assert_eq!(
            decide("07:00", ScanHistory::default()).reason,
            DecisionReason::OnTimeEntry
        );
        let late = decide("07:20", ScanHistory::default());
        assert_eq!(
            (late.reason, late.late_minutes),
            (DecisionReason::LateEntry, 20)
        );
        assert_eq!(
            decide("07:31", ScanHistory::default()).reason,
            DecisionReason::EntryWindowClosed
        );
    }

    #[test]
    fn multi_scan_checkout_and_third_scan_match_web() {
        let check_in = "2026-08-12 07:00:00".to_owned();
        let multi = decide(
            "07:10",
            ScanHistory {
                check_in: Some(check_in.clone()),
                last_scan: Some(check_in.clone()),
                last_scan_kind: Some("Masuk".into()),
                ..ScanHistory::default()
            },
        );
        assert_eq!(multi.reason, DecisionReason::MultiScan);

        let early = decide(
            "14:00",
            ScanHistory {
                check_in: Some(check_in.clone()),
                ..ScanHistory::default()
            },
        );
        assert_eq!(early.reason, DecisionReason::EarlyCheckout);
        assert_eq!(early.metrics.shortage_minutes, 60);

        let normal = decide(
            "15:00",
            ScanHistory {
                check_in: Some(check_in.clone()),
                ..ScanHistory::default()
            },
        );
        assert_eq!(normal.reason, DecisionReason::NormalCheckout);
        assert_eq!(normal.metrics.work_minutes, 420);

        assert_eq!(
            decide(
                "17:01",
                ScanHistory {
                    check_in: Some(check_in.clone()),
                    ..ScanHistory::default()
                }
            )
            .reason,
            DecisionReason::CheckoutTooLate
        );
        assert_eq!(
            decide(
                "16:00",
                ScanHistory {
                    check_in: Some(check_in),
                    check_out: Some("2026-08-12 15:00:00".into()),
                    ..ScanHistory::default()
                }
            )
            .reason,
            DecisionReason::AlreadyCheckedOut
        );
    }

    #[test]
    fn checkout_without_entry_needs_verification() {
        let result = decide("15:30", ScanHistory::default());
        assert_eq!(result.reason, DecisionReason::CheckoutWithoutEntry);
        assert_eq!(result.process_status, "Perlu Verifikasi");
    }

    #[test]
    fn night_shift_keeps_entry_date_after_midnight() {
        let mut shift = regular();
        shift.start = "23:00".into();
        shift.end = "07:00".into();
        assert_eq!(
            determine_work_date(&moment("2026-08-12", "23:15"), &shift).expect("before midnight"),
            "2026-08-12"
        );
        let result = decide_scan(
            &moment("2026-08-13", "07:00"),
            &shift,
            &ScanHistory {
                check_in: Some("2026-08-12 23:00:00".into()),
                ..ScanHistory::default()
            },
            10,
        )
        .expect("after midnight");
        assert_eq!(result.work_date, "2026-08-12");
        assert_eq!(result.reason, DecisionReason::NormalCheckout);
    }

    #[test]
    fn flexible_shift_and_break_threshold_match_web() {
        let mut flexible = regular();
        flexible.kind = ShiftKind::Flexible;
        flexible.normal_work_minutes = 0;
        flexible.break_minutes = 0;
        flexible.break_offset_minutes = 0;
        let entry = decide_scan(
            &moment("2026-08-12", "13:00"),
            &flexible,
            &ScanHistory::default(),
            10,
        )
        .expect("flex entry");
        assert_eq!(entry.reason, DecisionReason::FlexEntry);
        let exit = decide_scan(
            &moment("2026-08-12", "17:00"),
            &flexible,
            &ScanHistory {
                check_in: Some("2026-08-12 13:00:00".into()),
                ..ScanHistory::default()
            },
            10,
        )
        .expect("flex exit");
        assert_eq!(exit.metrics.work_minutes, 240);

        let before = calculate_work("2026-08-12 07:00:00", "2026-08-12 11:00:00", &regular())
            .expect("before break");
        let after = calculate_work("2026-08-12 07:00:00", "2026-08-12 11:01:00", &regular())
            .expect("after break");
        assert_eq!(
            (before.break_deduction_minutes, before.work_minutes),
            (0, 240)
        );
        assert_eq!(
            (after.break_deduction_minutes, after.work_minutes),
            (60, 181)
        );
    }

    #[test]
    fn calendar_helpers_handle_month_and_leap_boundaries() {
        assert_eq!(add_days("2024-03-01", -1).expect("leap"), "2024-02-29");
        assert_eq!(days_between("2026-12-31", "2027-01-01").expect("year"), 1);
    }
}
