use std::collections::HashMap;
use std::net::{IpAddr, UdpSocket};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Value};

use super::{
    config::DesktopState,
    models::CommandError,
    storage, sync,
    time_policy::{
        decide_scan, determine_work_date, is_checkout_window_expired, is_flexible_shift,
        DecisionReason, LocalMoment, ScanDecision, ScanHistory, ShiftKind, ShiftPolicy,
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
    presence_status: String,
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

/// Sakelar induk keamanan absensi, tingkat perusahaan.
///
/// Dua fitur baru — wajib foto bukti dan pembatasan alamat IP — TIDAK wajib
/// dipakai setiap perusahaan. Kunci ini yang menentukan apakah fiturnya hidup
/// sama sekali; sakelar per role di `app_role` hanya memilih role mana yang
/// terkena ketika fiturnya memang dihidupkan. Aturannya satu kalimat: fitur
/// berlaku hanya bila sakelar induk hidup DAN role-nya menyalakannya.
///
/// Bawaannya MATI (kunci belum ada = mati): pemasangan yang sudah berjalan
/// tidak boleh tiba-tiba menuntut foto pada absensi berikutnya hanya karena
/// aplikasinya diperbarui. Cerminan TypeScript-nya di
/// `src/lib/validations/scan-security.ts`.
pub const SCAN_PHOTO_ENABLED_KEY: &str = "scan_photo_enabled";
pub const SCAN_IP_RESTRICTION_ENABLED_KEY: &str = "scan_ip_restriction_enabled";

/// Kunci `setting_gex_system` berisi daftar IP yang boleh dipakai absensi.
///
/// Nilainya JSON array of string, mis. `["192.168.1.0/24","10.10.0.7"]`.
/// Sengaja disimpan di tabel setting yang ikut sinkronisasi: daftar ini adalah
/// kebijakan kantor, bukan konfigurasi per perangkat, jadi satu perubahan di
/// Desktop langsung berlaku juga di setiap APK.
pub const IP_ALLOWLIST_SETTING_KEY: &str = "scan_ip_allowlist";

/// Batas panjang foto bukti dalam karakter base64 (kira-kira 1,5 MB gambar).
///
/// Angka yang sama dipakai validator Zod `sync-schema.ts`. Foto yang lolos di
/// perangkat tetapi ditolak di batas sync akan macet selamanya di outbox.
pub const MAX_SCAN_PHOTO_BASE64: usize = 2_000_000;

/// Sakelar keamanan absensi milik role operator yang sedang memegang sesi.
///
/// Diambil dari `app_role` saat login dan ikut tersimpan pada vault offline,
/// sehingga perangkat yang login tanpa jaringan menegakkan aturan yang sama.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScanSecurityPolicy {
    pub require_photo: bool,
    pub require_ip_allowlist: bool,
}

/// Baca sakelar boolean dari peta `setting_gex_system`.
///
/// Kunci yang belum ada berarti MATI — itulah cara fitur baru tidak menyala
/// sendiri pada database lama.
pub fn setting_enabled(settings: &HashMap<String, String>, key: &str) -> bool {
    settings
        .get(key)
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}


// ─────────────────────────────────────────────────────────────────────────────
// Whitelist Shift/Divisi hari libur.
//
// Cerminan Rust dari `src/lib/validations/holiday-whitelist.ts`. Aturan yang
// sama dinilai dua kali — server Web memakai modul TypeScript, terminal
// Desktop/Mobile memakai fungsi di bawah — sehingga perbedaan sekecil apa pun
// akan tampak sebagai "karyawan yang sama boleh scan di satu jalur, ditolak di
// jalur lain". Satu-satunya penjaga paritasnya adalah vektor test kembar di
// `holiday_whitelist_vectors` dan `holiday-whitelist.test.ts`. Perlakukan
// keduanya sebagai satu berkas.
// ─────────────────────────────────────────────────────────────────────────────

/// Satu baris `hari_libur_whitelist`.
#[derive(Debug, Clone)]
pub struct HolidayWhitelistEntry {
    /// Dibaca sisi TypeScript/UI. Di Rust ia hanya ikut demi paritas bentuk
    /// baris dengan `HolidayWhitelistEntry` di `holiday-whitelist.ts`.
    #[allow(dead_code)]
    pub id: String,
    pub scope_type: String,
    pub scope_value: String,
    /// `None`/kosong = berlaku untuk SEMUA hari libur.
    pub tanggal_libur: Option<String>,
    pub status_aktif: i64,
}

/// Trim + rapatkan spasi ganda + lowercase. Untuk pembandingan saja.
pub fn fold_whitelist_text(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn normalize_whitelist_scope_type(raw: &str) -> Option<&'static str> {
    match raw.trim().to_uppercase().as_str() {
        "SHIFT" => Some("SHIFT"),
        "DIVISI" => Some("DIVISI"),
        _ => None,
    }
}

/// SHIFT  -> `kode_shift` desimal tanpa nol di depan ("04" -> "4").
/// DIVISI -> nama divisi yang dirapikan spasinya, huruf aslinya dipertahankan.
pub fn normalize_whitelist_scope_value(scope_type: &str, raw: &str) -> Option<String> {
    let trimmed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    if scope_type == "SHIFT" {
        if trimmed.len() > 9 || !trimmed.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let parsed = trimmed.parse::<i64>().ok()?;
        if parsed <= 0 {
            return None;
        }
        return Some(parsed.to_string());
    }
    Some(trimmed)
}

/// Menerima YYYY-MM-DD (opsional dengan bagian waktu). Selain itu `None`.
pub fn normalize_holiday_date(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim().split('T').next().unwrap_or("").trim().to_owned();
    if value.len() != 10 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits_ok = value
        .char_indices()
        .all(|(index, c)| index == 4 || index == 7 || c.is_ascii_digit());
    if !digits_ok {
        return None;
    }
    let month: u32 = value[5..7].parse().ok()?;
    let day: u32 = value[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(value)
}

/// Satu entri whitelist cocok dengan konteks scan?
pub fn matches_holiday_whitelist(
    entry: &HolidayWhitelistEntry,
    tanggal: &str,
    divisi: &str,
    kode_shift: Option<i64>,
) -> bool {
    if entry.status_aktif != 1 {
        return false;
    }
    let Some(scope) = normalize_whitelist_scope_type(&entry.scope_type) else {
        return false;
    };

    // tanggal_libur kosong = berlaku untuk setiap hari libur.
    if let Some(scoped) = normalize_holiday_date(entry.tanggal_libur.as_deref()) {
        match normalize_holiday_date(Some(tanggal)) {
            Some(target) if target == scoped => {}
            _ => return false,
        }
    }

    let Some(value) = normalize_whitelist_scope_value(scope, &entry.scope_value) else {
        return false;
    };

    if scope == "SHIFT" {
        return match kode_shift {
            Some(code) => value == code.to_string(),
            None => false,
        };
    }

    fold_whitelist_text(&value) == fold_whitelist_text(divisi)
}

/// Vonis akhir plus alasan siap-tampil.
///
/// Daftar KOSONG berarti tidak ada yang dikecualikan, jadi vonisnya MENOLAK.
/// Ini kebalikan dari `scan_ip_allowlist` (kosong = belum diatur = izinkan),
/// dan memang disengaja: perilaku aplikasi sejak dulu adalah menolak semua scan
/// di hari libur, sehingga daftar kosong harus mempertahankannya.
pub fn evaluate_holiday_scan(
    entries: &[HolidayWhitelistEntry],
    tanggal: &str,
    divisi: &str,
    kode_shift: Option<i64>,
) -> Option<String> {
    for entry in entries {
        if !matches_holiday_whitelist(entry, tanggal, divisi, kode_shift) {
            continue;
        }
        let scope = normalize_whitelist_scope_type(&entry.scope_type)?;
        let value = normalize_whitelist_scope_value(scope, &entry.scope_value)?;
        return Some(if scope == "SHIFT" {
            format!("Shift kode {value}")
        } else {
            format!("Divisi {value}")
        });
    }
    None
}

/// Membaca whitelist yang berlaku untuk satu tanggal libur dari SQLite lokal.
///
/// Filter tanggalnya sengaja longgar (`IS NULL OR = ?`) dan penilaian
/// sebenarnya tetap dilakukan `matches_holiday_whitelist`, supaya baris yang
/// tanggalnya belum kanonik (mis. berisi bagian waktu) tidak diam-diam hilang
/// di level SQL.
pub fn load_holiday_whitelist(
    transaction: &Transaction<'_>,
    tanggal: &str,
) -> Result<Vec<HolidayWhitelistEntry>, CommandError> {
    let mut statement = transaction
        .prepare(
            "SELECT id, scope_type, scope_value, tanggal_libur, status_aktif
             FROM hari_libur_whitelist
             WHERE status_aktif = 1
               AND (tanggal_libur IS NULL OR TRIM(tanggal_libur) = '' OR tanggal_libur LIKE ?);",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map([format!("{tanggal}%")], |row| {
            Ok(HolidayWhitelistEntry {
                id: row.get(0)?,
                scope_type: row.get(1)?,
                scope_value: row.get(2)?,
                tanggal_libur: row.get::<_, Option<String>>(3)?,
                status_aktif: row.get(4)?,
            })
        })
        .map_err(|_| CommandError::internal())?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|_| CommandError::internal())?);
    }
    Ok(entries)
}

/// `tbl_shift.kode_shift` milik satu `id_shift`. `None` bila shift tak dikenal.
pub fn load_kode_shift(transaction: &Transaction<'_>, shift_id: i64) -> Option<i64> {
    transaction
        .query_row(
            "SELECT kode_shift FROM tbl_shift WHERE id_shift = ? LIMIT 1;",
            [shift_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
}

/// Normalisasi satu entri daftar IP: alamat tunggal atau blok CIDR.
///
/// Mengembalikan `None` untuk entri yang tidak valid. Daftar yang memuat entri
/// sampah akan diam-diam memblokir semua orang, jadi entri seperti itu dibuang
/// saat disimpan, bukan saat scan.
pub fn normalize_ip_entry(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Some((address, prefix)) = value.split_once('/') {
        let ip = address.trim().parse::<IpAddr>().ok()?;
        let bits = prefix.trim().parse::<u8>().ok()?;
        let max_bits = if ip.is_ipv4() { 32 } else { 128 };
        if bits > max_bits {
            return None;
        }
        return Some(format!("{ip}/{bits}"));
    }
    value.parse::<IpAddr>().ok().map(|ip| ip.to_string())
}

/// Baca daftar IP dari nilai setting: JSON array, atau teks dipisah koma/baris.
pub fn parse_ip_allowlist(raw: &str) -> Vec<String> {
    let mut entries: Vec<String> = Vec::new();
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) {
        for item in items {
            if let Some(entry) = item.as_str().and_then(normalize_ip_entry) {
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
        }
        return entries;
    }
    for candidate in raw.split([',', ';', '\n']) {
        if let Some(entry) = normalize_ip_entry(candidate) {
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
    }
    entries
}

fn ip_matches_entry(ip: &IpAddr, entry: &str) -> bool {
    let Some((address, prefix)) = entry.split_once('/') else {
        return entry
            .parse::<IpAddr>()
            .map(|other| other == *ip)
            .unwrap_or(false);
    };
    let (Ok(network), Ok(bits)) = (address.parse::<IpAddr>(), prefix.parse::<u32>()) else {
        return false;
    };
    match (network, ip) {
        (IpAddr::V4(network), IpAddr::V4(candidate)) => {
            if bits > 32 {
                return false;
            }
            // Pergeseran sebanyak lebar tipe adalah perilaku tak terdefinisi di
            // Rust dan panik pada build debug, jadi /0 ditangani terpisah.
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
            u32::from(network) & mask == u32::from(*candidate) & mask
        }
        (IpAddr::V6(network), IpAddr::V6(candidate)) => {
            if bits > 128 {
                return false;
            }
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            u128::from(network) & mask == u128::from(*candidate) & mask
        }
        _ => false,
    }
}

/// Apakah salah satu alamat perangkat cocok dengan daftar yang diizinkan.
pub fn ip_matches_allowlist(addresses: &[IpAddr], allowlist: &[String]) -> bool {
    addresses
        .iter()
        .any(|ip| allowlist.iter().any(|entry| ip_matches_entry(ip, entry)))
}

/// Alamat IP perangkat ini, dilihat dari sisi jaringan lokalnya.
///
/// Memakai trik `UdpSocket::connect` ke alamat dokumentasi (RFC 5737 dan
/// RFC 3849): UDP tidak melakukan handshake, jadi TIDAK ADA paket yang dikirim
/// dan tidak ada koneksi internet yang dibutuhkan. Sistem operasi hanya mengisi
/// alamat lokal dari tabel routing. Pada mesin tanpa rute default hasilnya
/// kosong, dan pemanggil memperlakukan itu sebagai penolakan (fail-closed),
/// bukan sebagai izin.
pub fn detect_device_ip_addresses() -> Vec<IpAddr> {
    let mut found: Vec<IpAddr> = Vec::new();
    for (bind, target) in [("0.0.0.0:0", "192.0.2.1:9"), ("[::]:0", "[2001:db8::1]:9")] {
        let Ok(socket) = UdpSocket::bind(bind) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        if let Ok(address) = socket.local_addr() {
            let ip = address.ip();
            if !ip.is_unspecified() && !found.contains(&ip) {
                found.push(ip);
            }
        }
    }
    found
}

/// Ringkas alamat perangkat menjadi satu teks untuk kolom `ip_perangkat`.
fn describe_addresses(addresses: &[IpAddr]) -> String {
    addresses
        .iter()
        .map(IpAddr::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Foto bukti yang dikirim terminal, sudah lolos pemeriksaan bentuk.
struct ScanPhoto {
    base64: String,
    mime: String,
}

/// Baca foto bukti dari payload scan.
///
/// `Err` berarti foto ada tetapi bentuknya salah. Itu ditolak terang-terangan
/// alih-alih diam-diam tersimpan sebagai gambar rusak.
fn read_scan_photo(input: &Value) -> Result<Option<ScanPhoto>, String> {
    let base64 = input
        .get("fotoBase64")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if base64.is_empty() {
        return Ok(None);
    }
    if base64.len() > MAX_SCAN_PHOTO_BASE64 {
        return Err("Foto bukti absensi terlalu besar.".into());
    }
    if base64.starts_with("data:") {
        return Err("Foto bukti absensi harus base64 murni tanpa awalan data URL.".into());
    }
    let mime = input
        .get("fotoMime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| matches!(*value, "image/jpeg" | "image/png" | "image/webp"))
        .unwrap_or("image/jpeg")
        .to_owned();
    Ok(Some(ScanPhoto { base64, mime }))
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

/// Simpan foto bukti absensi ke SQLite lokal dan kembalikan barisnya.
///
/// Baris yang sama ikut event `attendance/scan` supaya sampai ke cloud lewat
/// jalur push yang sudah ada: tanpa route kanonik baru, dan tanpa pernah ikut
/// ditarik lagi oleh snapshot. Satu foto sekitar 40 KB, dan menariknya massal
/// akan membuat tiap siklus pull berukuran puluhan megabyte di setiap perangkat.
fn persist_scan_photo(
    transaction: &Transaction<'_>,
    client_id: &str,
    photo_id: &str,
    session_id: &str,
    log: &ScanLog,
    photo: &ScanPhoto,
    device_ip: &str,
) -> Result<Value, CommandError> {
    transaction
        .execute(
            r#"
      INSERT INTO absensi_foto (
        id_foto, id_sesi, tanggal_kerja, id_karyawan, nama, divisi, jenis_scan,
        timestamp_scan, sumber_data, kode_operator, ip_perangkat, client_id,
        foto_mime, foto_base64, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id_foto) DO NOTHING;
      "#,
            params![
                photo_id,
                session_id,
                log.tanggal_kerja,
                log.id_karyawan,
                log.nama,
                log.divisi,
                log.jenis_scan,
                log.timestamp_scan,
                log.sumber_data,
                log.kode_operator,
                device_ip,
                client_id,
                photo.mime,
                photo.base64,
                log.timestamp_scan,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(json!({
        "id_foto": photo_id,
        "id_sesi": session_id,
        "tanggal_kerja": log.tanggal_kerja,
        "id_karyawan": log.id_karyawan,
        "nama": log.nama,
        "divisi": log.divisi,
        "jenis_scan": log.jenis_scan,
        "timestamp_scan": log.timestamp_scan,
        "sumber_data": log.sumber_data,
        "kode_operator": log.kode_operator,
        "ip_perangkat": device_ip,
        "client_id": client_id,
        "foto_mime": photo.mime,
        "foto_base64": photo.base64,
        "created_at": log.timestamp_scan,
    }))
}

fn enqueue_scan(
    transaction: &Transaction<'_>,
    client_id: &str,
    local_log_id: i64,
    log: &ScanLog,
    attendance: Option<&Value>,
    attendance_base: Option<&str>,
    photo: Option<&Value>,
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
            "photo": photo,
        }),
        None,
    )?;
    Ok(())
}

/// Memindahkan karyawan ke shift lanjutan yang ditunjuk admin pada shift asal.
///
/// Perpindahan ini menyentuh `master_data`, tabel yang ikut disinkronkan, jadi
/// wajib mendaftarkan event outbox `employee/update` supaya terminal lain
/// melihat shift yang sama.
fn pindahkan_shift_karyawan(
    transaction: &Transaction<'_>,
    client_id: &str,
    employee_id: &str,
    shift_id: i64,
) -> Result<(), CommandError> {
    let changed = transaction
        .execute(
            "UPDATE master_data SET id_shift = ? WHERE id_unik = ? AND COALESCE(id_shift, 0) <> ?;",
            params![shift_id, employee_id, shift_id],
        )
        .map_err(|_| CommandError::internal())?;
    if changed == 0 {
        return Ok(());
    }

    // Payload dan pendaftaran outbox-nya dipakai bersama dengan pemeliharaan
    // status_backup di administration.rs, jadi satu helper untuk keduanya.
    sync::enqueue_employee_snapshot(transaction, client_id, employee_id)
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
    enqueue_scan(transaction, client_id, local_id, log, None, None, None)
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
                let normal_work_minutes = row.get::<_, Option<i64>>(10)?.unwrap_or_default();
                let start: String = row.get(2)?;
                let end: String = row.get(3)?;
                Ok(Shift {
                    policy: ShiftPolicy {
                        kind: if is_flexible_shift(&start, &end, normal_work_minutes) {
                            ShiftKind::Flexible
                        } else {
                            ShiftKind::Regular
                        },
                        start,
                        end,
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
    policy: ScanSecurityPolicy,
) -> Result<Value, CommandError> {
    submit_internal(state, input, operator_code, policy, None)
}

#[cfg(test)]
pub(crate) fn submit_at(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
    moment: LocalMoment,
) -> Result<Value, CommandError> {
    submit_internal(
        state,
        input,
        operator_code,
        ScanSecurityPolicy::default(),
        Some(&moment),
    )
}

#[cfg(test)]
pub(crate) fn submit_at_with_policy(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
    policy: ScanSecurityPolicy,
    moment: LocalMoment,
) -> Result<Value, CommandError> {
    submit_internal(state, input, operator_code, policy, Some(&moment))
}

fn submit_internal(
    state: &DesktopState,
    input: &Value,
    operator_code: &str,
    policy: ScanSecurityPolicy,
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
                "Scan ditolak: Lokasi GPS perangkat Anda tidak terdeteksi. Wajib mengaktifkan izin lokasi/GPS pada perangkat.",
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

    // ── Alamat IP perangkat ────────────────────────────────────────────────
    // Selalu dideteksi, bukan hanya saat pembatasan aktif: alamatnya ikut
    // tersimpan pada foto bukti sebagai jejak audit "scan ini datang dari mana".
    let device_addresses = detect_device_ip_addresses();
    let device_ip_text = describe_addresses(&device_addresses);

    // Fitur berlaku hanya bila perusahaan menghidupkannya DAN role-nya
    // menyalakannya. Sakelar induk dibaca dari setting yang ikut sinkronisasi,
    // jadi mematikannya di satu terminal langsung berlaku di semua terminal.
    let ip_restriction_required = policy.require_ip_allowlist
        && setting_enabled(&settings, SCAN_IP_RESTRICTION_ENABLED_KEY);
    let photo_required =
        policy.require_photo && setting_enabled(&settings, SCAN_PHOTO_ENABLED_KEY);

    if ip_restriction_required {
        let allowlist = settings
            .get(IP_ALLOWLIST_SETTING_KEY)
            .map(|value| parse_ip_allowlist(value))
            .unwrap_or_default();
        // Daftar kosong berarti BELUM DIATUR, bukan "tidak ada IP yang boleh":
        // pembatasan baru berlaku setelah Superadmin menuliskan jaringan mana
        // yang sah. Menolak semua scan selagi daftarnya kosong akan mengunci
        // seluruh terminal hanya karena sakelar dinyalakan lebih dulu daripada
        // daftarnya diisi. Halaman Pengaturan menandai keadaan ini dengan jelas
        // supaya sakelar menyala + daftar kosong tidak terbaca sebagai aman.
        //
        // Dua cabang sisanya tetap fail-closed: begitu daftarnya ada, alamat
        // yang tidak terdeteksi atau tidak cocok selalu ditolak.
        let rejection = if allowlist.is_empty() {
            None
        } else if device_addresses.is_empty() {
            Some((
                "Alamat IP perangkat tidak terdeteksi".to_owned(),
                "Scan ditolak: Alamat IP perangkat tidak terdeteksi. Pastikan perangkat terhubung ke jaringan kantor."
                    .to_owned(),
            ))
        } else if !ip_matches_allowlist(&device_addresses, &allowlist) {
            Some((
                format!("IP perangkat di luar daftar ({device_ip_text})"),
                format!(
                    "Scan ditolak: Alamat IP perangkat ({device_ip_text}) tidak terdaftar sebagai jaringan absensi yang diizinkan."
                ),
            ))
        } else {
            None
        };
        if let Some((note, message)) = rejection {
            let log = rejected_log(
                &moment.timestamp,
                &initial_work_date,
                &moment.time,
                &employee,
                operator_code,
                note.clone(),
                "",
            );
            persist_rejection(&transaction, &client_id, &log)?;
            transaction.commit().map_err(|_| CommandError::internal())?;
            return Ok(failure_with_context(
                message, &employee, note, "", None, None, None,
            ));
        }
    }

    // ── Foto bukti absensi ─────────────────────────────────────────────────
    // Foto yang dikirim SELALU disimpan, bahkan ketika role tidak mewajibkannya:
    // bukti yang sudah terlanjur diambil tidak ada gunanya dibuang.
    let scan_photo = match read_scan_photo(input) {
        Ok(value) => value,
        Err(message) => {
            let note = "Foto bukti absensi tidak valid";
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
                format!("Scan ditolak: {message}"),
                &employee,
                note,
                "",
                None,
                None,
                None,
            ));
        }
    };
    if photo_required && scan_photo.is_none() {
        let note = "Foto bukti absensi wajib";
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
            "Scan ditolak: Role Anda mewajibkan foto bukti absensi. Aktifkan kamera terminal lalu ulangi scan.",
            &employee,
            note,
            "",
            None,
            None,
            None,
        ));
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

    // Terisi ketika scan jatuh pada hari libur DAN karyawan lolos whitelist.
    // Dipakai untuk menandai jejak scan-nya, supaya laporan bisa menjelaskan
    // kenapa ada absensi pada tanggal yang terdaftar sebagai hari libur.
    let mut holiday_clearance: Option<String> = None;

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
                        mode: if open.4 == "PENGGANTI" {
                            "PENGGANTI"
                        } else {
                            "NORMAL"
                        },
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
                // Hari libur TIDAK lagi mematikan scanner untuk semua orang.
                // Sebagian peran memang tetap masuk saat libur — Satpam,
                // Keamanan, Maintenance, Teknisi — dan mereka didaftarkan lewat
                // whitelist Shift/Divisi. Yang di luar daftar tetap ditolak.
                //
                // Cakupan dinilai dari SHIFT DAN DIVISI milik karyawan menurut
                // `master_data`/`tbl_shift`, tidak pernah dari payload scan:
                // terminal yang dikuasai penyerang tidak boleh bisa
                // memasukkan dirinya sendiri ke whitelist lewat body request.
                let whitelist = load_holiday_whitelist(&transaction, &moment.date)?;
                let kode_shift = load_kode_shift(&transaction, employee.shift_id);
                let izin = evaluate_holiday_scan(
                    &whitelist,
                    &moment.date,
                    &employee.division,
                    kode_shift,
                );

                let Some(alasan_izin) = izin else {
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
                            "Hari ini Hari Libur ({nama_libur} - {jenis_libur}), jadi Anda tidak perlu absen. Selamat beristirahat! Bila Anda memang bertugas hari ini, minta Admin mendaftarkan Shift atau Divisi Anda pada Whitelist Hari Libur."
                        ),
                        &employee,
                        format!("Hari Libur: {nama_libur} ({jenis_libur})"),
                        "",
                        None,
                        None,
                        None,
                    ));
                };

                // Lolos whitelist: scan diteruskan seperti hari biasa. Jejak
                // izinnya dicatat supaya laporan bisa menjelaskan kenapa ada
                // absensi pada tanggal yang terdaftar sebagai hari libur.
                holiday_clearance = Some(format!(
                    "Hari Libur: {nama_libur} ({jenis_libur}) - Whitelist {alasan_izin}"
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
                // Flag multi-sesi dibaca dari shift ASAL karyawan, sesuai label
                // di form Shift: "karyawan yang selesai bekerja pada shift ini
                // dapat langsung scan masuk ke shift berikutnya". Sebelumnya
                // flag justru dibaca dari shift KANDIDAT (`izinkan_multi_sesi`
                // pada baris `id_shift != ?`), sehingga mengaktifkannya di
                // shift karyawan sendiri tidak berefek apa pun dan satu-satunya
                // cara scan lagi adalah memindahkan karyawan ke shift lain.
                let base_multi_session_raw: Option<String> = transaction
                    .query_row(
                        "SELECT CAST(COALESCE(izinkan_multi_sesi, 0) AS TEXT) FROM tbl_shift WHERE id_shift = ?;",
                        params![employee.shift_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| CommandError::internal())?;
                let base_allows_multi_session = matches!(
                    base_multi_session_raw.as_deref(),
                    Some("1") | Some("true") | Some("TRUE") | Some("True")
                );

                // Shift tujuan yang ditunjuk admin pada shift asal. 0 berarti
                // belum ditentukan, sehingga scanner kembali mencocokkan jendela
                // seluruh shift seperti perilaku sebelumnya.
                let continuation_shift_id: i64 = transaction
                    .query_row(
                        "SELECT COALESCE(shift_lanjutan_id, 0) FROM tbl_shift WHERE id_shift = ?;",
                        params![employee.shift_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| CommandError::internal())?
                    .unwrap_or(0);

                let candidate_shift_ids: Vec<i64> = if !base_allows_multi_session {
                    Vec::new()
                } else if continuation_shift_id > 0 && continuation_shift_id != employee.shift_id {
                    vec![continuation_shift_id]
                } else {
                    let mut statement = transaction
                        .prepare(
                            "SELECT id_shift FROM tbl_shift WHERE id_shift != ? ORDER BY id_shift ASC;",
                        )
                        .map_err(|_| CommandError::internal())?;
                    let ids = statement
                        .query_map(params![employee.shift_id], |row| row.get::<_, i64>(0))
                        .map_err(|_| CommandError::internal())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| CommandError::internal())?;
                    drop(statement);
                    ids
                };

                let mut matched_shift = None;
                let mut matched_shift_id = employee.shift_id;

                for c_id in candidate_shift_ids {
                    if let Ok(Some(cand_shift)) = load_shift(&transaction, c_id) {
                        // Shift fleksibel menerima jam berapa pun sehingga akan
                        // selalu "cocok" dan menelan setiap sesi lanjutan.
                        // Dulu ini dijaga `kode_shift != 4`, sebuah angka ajaib
                        // yang menghukum shift reguler mana pun berkode 4.
                        if cand_shift.policy.kind == ShiftKind::Flexible {
                            continue;
                        }
                        if is_check_in_window_matched(&moment.time, &cand_shift) {
                            matched_shift = Some(cand_shift);
                            matched_shift_id = c_id;
                            break;
                        }
                    }
                }

                if let Some(cand_shift) = matched_shift {
                    // Karyawan resmi berpindah ke shift lanjutan, sehingga
                    // hari-hari berikutnya memakai jadwal shift itu.
                    pindahkan_shift_karyawan(
                        &transaction,
                        &client_id,
                        &employee.id,
                        matched_shift_id,
                    )?;
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
             update_terakhir, sumber, COALESCE(status_kehadiran, '')
      FROM absensi_harian WHERE id_sesi = ? LIMIT 1;
      "#,
            [&session_id],
            |row| {
                Ok(AttendanceState {
                    check_in: row.get(0)?,
                    check_out: row.get(1)?,
                    updated_at: row.get(2)?,
                    source: row.get(3)?,
                    presence_status: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    // Perlindungan Koreksi Admin berlaku per KOLOM, bukan per baris. Scan baru
    // ditolak kalau tidak ada lagi kolom waktu yang kosong untuk diisi.
    // Sebelumnya seluruh baris terkunci, sehingga karyawan yang jam masuknya
    // dikoreksi admin tidak pernah bisa scan pulang dan admin terpaksa
    // mengoreksi jam pulang secara manual juga.
    if attendance_before.as_ref().is_some_and(|item| {
        item.source == "Koreksi Admin"
            // Koreksi Sakit/Izin/Dispen/Alfa mengosongkan kedua jam; scan tidak
            // boleh menghidupkan baris itu kembali menjadi Hadir.
            && (item.presence_status != "Hadir"
                || (!item.check_in.is_empty() && !item.check_out.is_empty()))
    }) {
        let note = "Absensi sudah lengkap dan dikoreksi admin";
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
            "Scan ditolak: Absensi hari ini sudah lengkap dan dikoreksi Admin, jadi tidak boleh ditimpa scanner.",
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
          status_absen = ?, keterangan = ?,
          sumber = CASE WHEN sumber = 'Koreksi Admin' THEN 'Koreksi Admin' ELSE 'Scanner' END,
          update_terakhir = ?,
          menit_terlambat = ?, menit_datang_awal = ?, id_shift = ?, mode_tugas = ?,
          id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
        WHERE id_sesi = ?
          AND (sumber <> 'Koreksi Admin'
               OR (status_kehadiran = 'Hadir' AND COALESCE(jam_masuk, '') = ''));
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
          status_absen = ?, keterangan = ?,
          sumber = CASE WHEN sumber = 'Koreksi Admin' THEN 'Koreksi Admin' ELSE 'Scanner' END,
          update_terakhir = ?,
          jam_kerja = ?, lembur = ?, jam_kerja_kurang = ?, id_shift = ?,
          mode_tugas = ?, id_backup = ?, id_karyawan_asal = ?, tanggal_tugas = ?
        WHERE id_sesi = ?
          AND (sumber <> 'Koreksi Admin'
               OR (status_kehadiran = 'Hadir' AND COALESCE(jam_pulang, '') = ''));
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
    let system_note = match holiday_clearance.as_ref() {
        Some(clearance) if system_note.trim().is_empty() => clearance.clone(),
        Some(clearance) => format!("{system_note}. {clearance}"),
        None => system_note,
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
    // `client_id` + id log lokal: unik lintas perangkat, dan stabil bila event
    // yang sama dikirim ulang sehingga cloud tidak pernah menyimpan foto ganda.
    let photo_row = match scan_photo.as_ref() {
        Some(photo) => Some(persist_scan_photo(
            &transaction,
            &client_id,
            &format!("{client_id}:{local_log_id}"),
            &session_id,
            &log,
            photo,
            &device_ip_text,
        )?),
        None => None,
    };
    enqueue_scan(
        &transaction,
        &client_id,
        local_log_id,
        &log,
        Some(&attendance),
        previous_update.as_deref(),
        photo_row.as_ref(),
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
    use std::sync::{Mutex, RwLock};

    use reqwest::Client;
    use serde_json::json;
    use tempfile::tempdir;

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

    /// Vektor di bawah dieja ULANG PERSIS pada
    /// `web-desktop/src/lib/validations/ip-allowlist.test.ts`.
    ///
    /// Daftar IP yang sama dibaca server Web (TypeScript) dan terminal
    /// Desktop/Mobile (Rust). Tanpa vektor bersama, kedua implementasi bisa
    /// menilai berbeda dan hasilnya tampak sebagai "scan yang sama diterima di
    /// satu terminal tetapi ditolak di terminal lain" tanpa pesan apa pun.
    #[test]
    fn normalisasi_entri_ip_sama_dengan_typescript() {
        use super::normalize_ip_entry;
        for (masukan, harapan) in [
            ("192.168.1.20", Some("192.168.1.20")),
            ("  10.0.0.5  ", Some("10.0.0.5")),
            ("192.168.1.0/24", Some("192.168.1.0/24")),
            ("0.0.0.0/0", Some("0.0.0.0/0")),
            ("2001:DB8::1", Some("2001:db8::1")),
            ("2001:db8:0:0:0:0:0:1/64", Some("2001:db8::1/64")),
            ("::ffff:192.168.1.1", Some("::ffff:192.168.1.1")),
            ("::", Some("::")),
            ("::1", Some("::1")),
            ("::c0a8:101", Some("::c0a8:101")),
            ("", None),
            ("   ", None),
            ("bukan-ip", None),
            ("256.1.1.1", None),
            ("192.168.1", None),
            ("01.2.3.4", None),
            ("192.168.1.0/33", None),
            ("2001:db8::1/129", None),
            ("fe80::1%eth0", None),
        ] {
            assert_eq!(
                normalize_ip_entry(masukan).as_deref(),
                harapan,
                "entri {masukan}"
            );
        }
    }

    #[test]
    fn daftar_ip_dibaca_dari_json_maupun_teks_bebas() {
        use super::parse_ip_allowlist;
        assert_eq!(
            parse_ip_allowlist(r#"["192.168.1.0/24","bukan-ip","10.0.0.5","10.0.0.5"]"#),
            vec!["192.168.1.0/24".to_string(), "10.0.0.5".to_string()]
        );
        assert_eq!(
            parse_ip_allowlist("192.168.1.20, 10.0.0.5\n172.16.0.0/12"),
            vec![
                "192.168.1.20".to_string(),
                "10.0.0.5".to_string(),
                "172.16.0.0/12".to_string()
            ]
        );
        assert!(parse_ip_allowlist("").is_empty());
        assert!(parse_ip_allowlist("[]").is_empty());
    }

    #[test]
    fn pencocokan_ip_sama_dengan_typescript() {
        use super::{ip_matches_allowlist, parse_ip_allowlist};
        let allowlist = parse_ip_allowlist(r#"["192.168.1.0/24","10.0.0.5","2001:db8::/32"]"#);
        let alamat = |value: &str| vec![value.parse::<std::net::IpAddr>().expect("alamat")];

        assert!(ip_matches_allowlist(&alamat("192.168.1.77"), &allowlist));
        assert!(ip_matches_allowlist(&alamat("10.0.0.5"), &allowlist));
        assert!(ip_matches_allowlist(&alamat("2001:db8:1234::9"), &allowlist));

        assert!(!ip_matches_allowlist(&alamat("192.168.2.77"), &allowlist));
        assert!(!ip_matches_allowlist(&alamat("10.0.0.6"), &allowlist));
        assert!(!ip_matches_allowlist(&alamat("2001:dbf::1"), &allowlist));
        // Beda keluarga alamat tidak boleh saling cocok.
        assert!(!ip_matches_allowlist(
            &alamat("192.168.1.77"),
            &parse_ip_allowlist(r#"["2001:db8::/32"]"#)
        ));
        assert!(!ip_matches_allowlist(
            &alamat("2001:db8::1"),
            &parse_ip_allowlist(r#"["192.168.1.0/24"]"#)
        ));
        // Fail-closed: tanpa alamat perangkat atau tanpa daftar, tidak ada yang lolos.
        assert!(!ip_matches_allowlist(&[], &allowlist));
        assert!(!ip_matches_allowlist(&alamat("192.168.1.77"), &[]));

        // Cukup satu alamat perangkat yang cocok.
        let ganda = vec![
            "203.0.113.9".parse::<std::net::IpAddr>().expect("alamat"),
            "192.168.1.77".parse::<std::net::IpAddr>().expect("alamat"),
        ];
        assert!(ip_matches_allowlist(&ganda, &allowlist));

        // Prefix /0 hanya mencakup keluarga alamatnya sendiri.
        let semua_v4 = parse_ip_allowlist(r#"["0.0.0.0/0"]"#);
        assert!(ip_matches_allowlist(&alamat("203.0.113.9"), &semua_v4));
        assert!(!ip_matches_allowlist(&alamat("2001:db8::1"), &semua_v4));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Vektor whitelist hari libur.
    //
    // Dieja ULANG PERSIS pada `src/lib/validations/holiday-whitelist.test.ts`.
    // Aturannya dinilai dua kali — server Web memakai modul TypeScript,
    // terminal Desktop/Mobile memakai fungsi di berkas ini — jadi perbedaan
    // sekecil apa pun muncul sebagai "karyawan yang sama boleh scan di Web tapi
    // ditolak di terminal". Vektor kembar inilah satu-satunya penjaganya.
    // ─────────────────────────────────────────────────────────────────────────

    fn entri(
        id: &str,
        scope_type: &str,
        scope_value: &str,
        tanggal_libur: Option<&str>,
        status_aktif: i64,
    ) -> super::HolidayWhitelistEntry {
        super::HolidayWhitelistEntry {
            id: id.to_owned(),
            scope_type: scope_type.to_owned(),
            scope_value: scope_value.to_owned(),
            tanggal_libur: tanggal_libur.map(str::to_owned),
            status_aktif,
        }
    }

    #[test]
    fn cakupan_whitelist_dinormalkan_sama_dengan_typescript() {
        use super::{normalize_whitelist_scope_type, normalize_whitelist_scope_value};

        assert_eq!(normalize_whitelist_scope_type("SHIFT"), Some("SHIFT"));
        assert_eq!(normalize_whitelist_scope_type("shift"), Some("SHIFT"));
        assert_eq!(normalize_whitelist_scope_type("  Divisi "), Some("DIVISI"));
        assert_eq!(normalize_whitelist_scope_type(""), None);
        assert_eq!(normalize_whitelist_scope_type("KARYAWAN"), None);
        assert_eq!(normalize_whitelist_scope_type("jabatan"), None);

        // SHIFT -> desimal tanpa nol di depan.
        assert_eq!(
            normalize_whitelist_scope_value("SHIFT", "4").as_deref(),
            Some("4")
        );
        assert_eq!(
            normalize_whitelist_scope_value("SHIFT", " 04 ").as_deref(),
            Some("4")
        );
        assert_eq!(
            normalize_whitelist_scope_value("SHIFT", "0012").as_deref(),
            Some("12")
        );
        assert_eq!(normalize_whitelist_scope_value("SHIFT", ""), None);
        assert_eq!(normalize_whitelist_scope_value("SHIFT", "0"), None);
        assert_eq!(normalize_whitelist_scope_value("SHIFT", "-1"), None);
        assert_eq!(normalize_whitelist_scope_value("SHIFT", "Satpam"), None);
        assert_eq!(normalize_whitelist_scope_value("SHIFT", "1.5"), None);

        // DIVISI -> spasi dirapikan, huruf asli dipertahankan.
        assert_eq!(
            normalize_whitelist_scope_value("DIVISI", "  Keamanan  ").as_deref(),
            Some("Keamanan")
        );
        assert_eq!(
            normalize_whitelist_scope_value("DIVISI", "Unit   Maintenance").as_deref(),
            Some("Unit Maintenance")
        );
        assert_eq!(normalize_whitelist_scope_value("DIVISI", "   "), None);
    }

    #[test]
    fn tanggal_libur_dinormalkan_sama_dengan_typescript() {
        use super::normalize_holiday_date;

        assert_eq!(
            normalize_holiday_date(Some("2026-08-17")).as_deref(),
            Some("2026-08-17")
        );
        assert_eq!(
            normalize_holiday_date(Some(" 2026-08-17T08:00:00 ")).as_deref(),
            Some("2026-08-17")
        );
        assert_eq!(normalize_holiday_date(None), None);
        assert_eq!(normalize_holiday_date(Some("")), None);
        assert_eq!(normalize_holiday_date(Some("17-08-2026")), None);
        assert_eq!(normalize_holiday_date(Some("2026-13-01")), None);
        assert_eq!(normalize_holiday_date(Some("2026-00-10")), None);
        assert_eq!(normalize_holiday_date(Some("2026-08-32")), None);
    }

    #[test]
    fn teks_whitelist_dibandingkan_tanpa_spasi_dan_kapitalisasi() {
        use super::fold_whitelist_text;

        assert_eq!(fold_whitelist_text("  Unit   Keamanan "), "unit keamanan");
        assert_eq!(fold_whitelist_text("UNIT KEAMANAN"), "unit keamanan");
    }

    #[test]
    fn entri_whitelist_dicocokkan_sama_dengan_typescript() {
        use super::matches_holiday_whitelist;

        let tanggal = "2026-08-17";
        let divisi = "Keamanan";
        let kode = Some(4_i64);

        // Cakupan DIVISI: tanpa peduli kapitalisasi.
        assert!(matches_holiday_whitelist(
            &entri("a", "DIVISI", "keamanan", None, 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(matches_holiday_whitelist(
            &entri("a", "DIVISI", "  KEAMANAN  ", None, 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(!matches_holiday_whitelist(
            &entri("a", "DIVISI", "Produksi", None, 1),
            tanggal,
            divisi,
            kode
        ));

        // Cakupan SHIFT: cocok pada kode_shift, bukan id_shift.
        assert!(matches_holiday_whitelist(
            &entri("s", "SHIFT", "4", None, 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(matches_holiday_whitelist(
            &entri("s", "SHIFT", "04", None, 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(!matches_holiday_whitelist(
            &entri("s", "SHIFT", "5", None, 1),
            tanggal,
            divisi,
            kode
        ));

        // Shift yang tidak dikenal tidak pernah cocok pada cakupan SHIFT.
        assert!(!matches_holiday_whitelist(
            &entri("s", "SHIFT", "4", None, 1),
            tanggal,
            divisi,
            None
        ));

        // Entri nonaktif tidak pernah mengizinkan.
        assert!(!matches_holiday_whitelist(
            &entri("a", "DIVISI", "Keamanan", None, 0),
            tanggal,
            divisi,
            kode
        ));

        // tanggal_libur kosong berlaku untuk semua hari libur.
        for kosong in [None, Some(""), Some("   ")] {
            assert!(matches_holiday_whitelist(
                &entri("a", "DIVISI", "Keamanan", kosong, 1),
                tanggal,
                divisi,
                kode
            ));
        }

        // tanggal_libur terisi hanya berlaku pada tanggal itu.
        assert!(matches_holiday_whitelist(
            &entri("a", "DIVISI", "Keamanan", Some("2026-08-17"), 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(!matches_holiday_whitelist(
            &entri("a", "DIVISI", "Keamanan", Some("2026-12-25"), 1),
            tanggal,
            divisi,
            kode
        ));

        // Cakupan dan nilai tidak sah diabaikan, bukan mengizinkan.
        assert!(!matches_holiday_whitelist(
            &entri("a", "JABATAN", "Keamanan", None, 1),
            tanggal,
            divisi,
            kode
        ));
        assert!(!matches_holiday_whitelist(
            &entri("a", "DIVISI", "  ", None, 1),
            tanggal,
            divisi,
            kode
        ));
    }

    #[test]
    fn vonis_whitelist_sama_dengan_typescript() {
        use super::evaluate_holiday_scan;

        let tanggal = "2026-08-17";
        let divisi = "Maintenance";
        let kode = Some(2_i64);

        // Daftar kosong menolak: bawaan aplikasi tetap "libur = tidak ada scan".
        assert_eq!(evaluate_holiday_scan(&[], tanggal, divisi, kode), None);

        // Satu entri yang cocok sudah cukup, dan alasannya siap tampil.
        let daftar = vec![
            entri("a", "DIVISI", "Produksi", None, 1),
            entri("b", "DIVISI", "maintenance", None, 1),
        ];
        assert_eq!(
            evaluate_holiday_scan(&daftar, tanggal, divisi, kode).as_deref(),
            Some("Divisi maintenance")
        );

        // Cakupan SHIFT juga memberi alasan yang siap tampil.
        let daftar_shift = vec![entri("s", "SHIFT", "02", None, 1)];
        assert_eq!(
            evaluate_holiday_scan(&daftar_shift, tanggal, divisi, kode).as_deref(),
            Some("Shift kode 2")
        );

        // Tidak ada yang cocok tetap menolak.
        let tak_cocok = vec![
            entri("a", "DIVISI", "Produksi", None, 1),
            entri("s", "SHIFT", "9", None, 1),
        ];
        assert_eq!(
            evaluate_holiday_scan(&tak_cocok, tanggal, divisi, kode),
            None
        );
    }

    /// Hidupkan sakelar induk sebuah fitur keamanan absensi.
    ///
    /// Tanpa ini fiturnya MATI, jadi setiap tes penegakan wajib memanggilnya —
    /// dan itu memang bagian yang diuji: perusahaan yang tidak memakai fitur
    /// ini tidak boleh terkena apa pun.
    fn aktifkan(state: &DesktopState, key: &str) {
        let connection = storage::database(&state.data_dir).expect("database lokal");
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true';",
                [key],
            )
            .expect("sakelar induk");
    }

    /// Sakelar induk mati: role yang mewajibkan foto pun tidak diminta foto.
    ///
    /// Inilah janji "perusahaan boleh tidak memakai fitur ini". Kalau tes ini
    /// jatuh, pemasangan yang tidak pernah meminta fitur foto akan menolak
    /// absensi karyawannya begitu aplikasinya diperbarui.
    #[test]
    fn fitur_foto_mati_membuat_sakelar_role_tidak_berlaku() {
        use super::{submit_at_with_policy, ScanSecurityPolicy};
        let (_directory, state) = fixture();
        let hasil = submit_at_with_policy(
            &state,
            &json!({ "qrContent": "K001|TOKEN-TEST" }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: true,
                require_ip_allowlist: true,
            },
            moment("2026-09-02", "07:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(
            hasil.get("sukses").and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn foto_wajib_menolak_scan_tanpa_foto_dan_tetap_tercatat() {
        use super::{submit_at_with_policy, ScanSecurityPolicy, SCAN_PHOTO_ENABLED_KEY};
        let (directory, state) = fixture();
        aktifkan(&state, SCAN_PHOTO_ENABLED_KEY);
        let hasil = submit_at_with_policy(
            &state,
            &json!({ "qrContent": "K001|TOKEN-TEST" }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: true,
                require_ip_allowlist: false,
            },
            moment("2026-09-02", "08:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(hasil.get("sukses").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(
            hasil.get("catatanSistem").and_then(|value| value.as_str()),
            Some("Foto bukti absensi wajib")
        );

        // Penolakan tetap masuk log_scan untuk audit, tanpa membuat baris absensi.
        let connection = storage::database(directory.path()).expect("database lokal");
        let (log, absensi): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM log_scan), (SELECT COUNT(*) FROM absensi_harian);",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("jumlah baris");
        assert_eq!(log, 1);
        assert_eq!(absensi, 0);
    }

    /// Daftar kosong = belum diatur, jadi pembatasan belum berlaku.
    ///
    /// Kalau ini berubah menjadi "tolak semua", satu sakelar yang dinyalakan
    /// sebelum daftarnya diisi akan mengunci seluruh terminal di luar.
    #[test]
    fn daftar_ip_kosong_tidak_membatasi_scan() {
        use super::{submit_at_with_policy, ScanSecurityPolicy};
        let (_directory, state) = fixture();
        let hasil = submit_at_with_policy(
            &state,
            &json!({ "qrContent": "K001|TOKEN-TEST" }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: false,
                require_ip_allowlist: true,
            },
            moment("2026-09-02", "07:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(
            hasil.get("sukses").and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    /// Begitu daftarnya ada, alamat yang tidak cocok tetap ditolak.
    ///
    /// Alamat uji memakai blok dokumentasi TEST-NET-3 (RFC 5737) yang tidak
    /// mungkin menjadi alamat mesin mana pun, jadi hasilnya sama di mesin
    /// pengembang maupun CI: entah IP-nya tidak terdeteksi (mesin tanpa rute)
    /// atau terdeteksi tetapi di luar daftar. Keduanya WAJIB menolak.
    #[test]
    fn daftar_ip_terisi_menolak_alamat_di_luar_daftar() {
        use super::{
            submit_at_with_policy, ScanSecurityPolicy, SCAN_IP_RESTRICTION_ENABLED_KEY,
        };
        let (_directory, state) = fixture();
        aktifkan(&state, SCAN_IP_RESTRICTION_ENABLED_KEY);
        let connection = storage::database(&state.data_dir).expect("database lokal");
        connection
            .execute(
                "INSERT INTO setting_gex_system (key, value) VALUES ('scan_ip_allowlist', ?);",
                [r#"["203.0.113.7"]"#],
            )
            .expect("daftar ip");

        let hasil = submit_at_with_policy(
            &state,
            &json!({ "qrContent": "K001|TOKEN-TEST" }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: false,
                require_ip_allowlist: true,
            },
            moment("2026-09-02", "07:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(
            hasil.get("sukses").and_then(|value| value.as_bool()),
            Some(false)
        );
        let catatan = hasil
            .get("catatanSistem")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        assert!(
            catatan.starts_with("IP perangkat di luar daftar")
                || catatan == "Alamat IP perangkat tidak terdeteksi",
            "catatan tak terduga: {catatan}"
        );
    }

    #[test]
    fn foto_bukti_tersimpan_lokal_dan_ikut_outbox() {
        use super::{submit_at_with_policy, ScanSecurityPolicy};
        let (directory, state) = fixture();
        let hasil = submit_at_with_policy(
            &state,
            &json!({
                "qrContent": "K001|TOKEN-TEST",
                "fotoBase64": "Zm90by1idWt0aQ==",
                "fotoMime": "image/jpeg",
            }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: true,
                require_ip_allowlist: false,
            },
            moment("2026-09-02", "07:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(hasil.get("sukses").and_then(|value| value.as_bool()), Some(true));

        let connection = storage::database(directory.path()).expect("database lokal");
        let (jumlah_foto, base64): (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(foto_base64), '') FROM absensi_foto;",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("baris foto");
        assert_eq!(jumlah_foto, 1);
        assert_eq!(base64, "Zm90by1idWt0aQ==");

        // Foto WAJIB ikut event outbox: tanpa itu ia hanya hidup di satu
        // perangkat dan tidak pernah bisa ditinjau dari terminal lain.
        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox WHERE domain = 'attendance' AND operation = 'scan' LIMIT 1;",
                [],
                |row| row.get(0),
            )
            .expect("event outbox");
        assert!(payload.contains("Zm90by1idWt0aQ=="));
    }

    #[test]
    fn foto_ditolak_bila_dikirim_sebagai_data_url() {
        use super::{submit_at_with_policy, ScanSecurityPolicy};
        let (_directory, state) = fixture();
        let hasil = submit_at_with_policy(
            &state,
            &json!({
                "qrContent": "K001|TOKEN-TEST",
                "fotoBase64": "data:image/jpeg;base64,Zm90bw==",
            }),
            "OP001",
            ScanSecurityPolicy {
                require_photo: true,
                require_ip_allowlist: false,
            },
            moment("2026-09-02", "08:00:00"),
        )
        .expect("scan diproses");
        assert_eq!(hasil.get("sukses").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(
            hasil.get("catatanSistem").and_then(|value| value.as_str()),
            Some("Foto bukti absensi tidak valid")
        );
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

    fn seed_shift_sore(state: &DesktopState, flag_shift_asal: i64) {
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute_batch(&format!(
                r#"
        UPDATE tbl_shift SET izinkan_multi_sesi = {flag_shift_asal} WHERE id_shift = 1;
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
          jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
          offset_istirahat_mulai, buffer_shift_malam_menit, izinkan_multi_sesi
        ) VALUES (2, 2, 'Shift Sore', '16:00', '22:00', 60, 15, 30,
                  360, 0, 120, 240, 120, 0);
        "#
            ))
            .expect("seed shift sore");
    }

    #[test]
    fn multi_sesi_dibaca_dari_shift_asal_karyawan() {
        let (_directory, state) = fixture();
        // Flag hanya ada di shift 1 (shift asal karyawan); shift 2 sengaja 0.
        seed_shift_sore(&state, 1);

        let masuk = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        assert_eq!(masuk["jenisScan"], "Masuk");
        let pulang = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:05:00"));
        assert_eq!(pulang["jenisScan"], "Pulang");

        // Sesi shift 1 tuntas, jam 16:05 masuk jendela scan masuk shift 2.
        let sesi_kedua = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "16:05:00"));
        assert_eq!(
            sesi_kedua["sukses"], true,
            "scan lanjutan seharusnya diterima: {sesi_kedua}"
        );
        assert_eq!(sesi_kedua["idSesi"], "NORMAL-20260812-K001-2");
    }

    #[test]
    fn tanpa_flag_di_shift_asal_sesi_lanjutan_ditolak() {
        let (_directory, state) = fixture();
        // Flag dimatikan di shift asal. Dulu flag dibaca dari shift KANDIDAT,
        // sehingga mengaktifkannya di shift karyawan sendiri tidak berpengaruh.
        seed_shift_sore(&state, 0);

        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:05:00"));

        let sesi_kedua = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "16:05:00"));
        assert_eq!(sesi_kedua["sukses"], false);
        assert_ne!(sesi_kedua["idSesi"], "NORMAL-20260812-K001-2");
    }

    #[test]
    fn shift_lanjutan_eksplisit_memindahkan_shift_karyawan() {
        let (_directory, state) = fixture();
        seed_shift_sore(&state, 1);
        {
            let connection = storage::database(&state.data_dir).expect("local database");
            connection
                .execute(
                    "UPDATE tbl_shift SET shift_lanjutan_id = 2 WHERE id_shift = 1;",
                    [],
                )
                .expect("set shift lanjutan");
        }

        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:05:00"));

        let sesi_kedua = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "16:05:00"));
        assert_eq!(sesi_kedua["idSesi"], "NORMAL-20260812-K001-2");

        let connection = storage::database(&state.data_dir).expect("local database");
        // Kolom shift karyawan ikut berpindah ke shift lanjutan.
        let shift_karyawan: i64 = connection
            .query_row(
                "SELECT id_shift FROM master_data WHERE id_unik = 'K001';",
                [],
                |row| row.get(0),
            )
            .expect("shift karyawan");
        assert_eq!(shift_karyawan, 2);

        // master_data ikut disinkronkan, jadi perpindahan wajib punya event outbox.
        let event_karyawan: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE domain = 'employee' AND operation = 'update';",
                [],
                |row| row.get(0),
            )
            .expect("outbox employee");
        assert_eq!(event_karyawan, 1);
    }

    #[test]
    fn shift_lanjutan_tidak_diterapkan_saat_multi_sesi_mati() {
        let (_directory, state) = fixture();
        // Shift lanjutan diisi, tetapi togglenya mati: tidak boleh berpindah.
        seed_shift_sore(&state, 0);
        {
            let connection = storage::database(&state.data_dir).expect("local database");
            connection
                .execute(
                    "UPDATE tbl_shift SET shift_lanjutan_id = 2 WHERE id_shift = 1;",
                    [],
                )
                .expect("set shift lanjutan");
        }

        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:05:00"));
        let sesi_kedua = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "16:05:00"));
        assert_eq!(sesi_kedua["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        let shift_karyawan: i64 = connection
            .query_row(
                "SELECT id_shift FROM master_data WHERE id_unik = 'K001';",
                [],
                |row| row.get(0),
            )
            .expect("shift karyawan");
        assert_eq!(shift_karyawan, 1);
    }

    #[test]
    fn shift_fleksibel_tidak_menelan_sesi_lanjutan() {
        let (_directory, state) = fixture();
        seed_shift_sore(&state, 1);
        {
            // Shift fleksibel ber-id lebih kecil dari shift sore. Jendela masuknya
            // sepanjang hari sehingga ia selalu cocok lebih dulu dan merebut setiap
            // sesi lanjutan. Dulu ini hanya disaring angka ajaib `kode_shift != 4`.
            let connection = storage::database(&state.data_dir).expect("local database");
            connection
                .execute_batch(
                    r#"
        INSERT INTO tbl_shift (
          id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
          awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
          jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
          offset_istirahat_mulai, buffer_shift_malam_menit, izinkan_multi_sesi
        ) VALUES (0, 9, 'Shift Fleksibel', '00:00', '23:59', 0, 0, 0,
                  0, 0, 0, 0, 0, 1);
        "#,
                )
                .expect("seed shift fleksibel");
        }

        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:05:00"));

        let sesi_kedua = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "16:05:00"));
        assert_eq!(sesi_kedua["idSesi"], "NORMAL-20260812-K001-2");
    }

    fn kunci_sebagai_koreksi_admin(state: &DesktopState) {
        let connection = storage::database(&state.data_dir).expect("local database");
        connection
            .execute(
                "UPDATE absensi_harian SET sumber = 'Koreksi Admin', keterangan = 'Dikunci admin' WHERE id_karyawan = 'K001';",
                [],
            )
            .expect("admin correction");
    }

    #[test]
    fn koreksi_admin_jam_masuk_masih_bisa_diselesaikan_scan_pulang() {
        // Admin mengoreksi jam masuk; jam pulang masih kosong. Scan pulang
        // hanya MENGISI kolom kosong itu, jadi harus diterima. Dulu seluruh
        // baris terkunci sehingga karyawan tidak pernah bisa scan pulang.
        let (_directory, state) = fixture();
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        kunci_sebagai_koreksi_admin(&state);

        let hasil = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:00:00"));
        assert_eq!(hasil["sukses"], true, "scan pulang ditolak: {hasil}");

        let connection = storage::database(&state.data_dir).expect("local database");
        let (sumber, jam_masuk, jam_pulang): (String, String, String) = connection
            .query_row(
                "SELECT sumber, COALESCE(jam_masuk, ''), COALESCE(jam_pulang, '') FROM absensi_harian WHERE id_karyawan = 'K001';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("attendance row");
        // Jam masuk hasil koreksi tidak boleh berubah, dan prioritas baris
        // tetap Koreksi Admin agar tidak turun kasta menjadi Scanner.
        assert_eq!(sumber, "Koreksi Admin");
        assert_eq!(jam_masuk, "2026-08-12 07:00:00");
        assert!(!jam_pulang.is_empty(), "jam pulang seharusnya terisi");
    }

    #[test]
    fn koreksi_admin_yang_sudah_lengkap_tidak_bisa_ditimpa_scanner() {
        let (_directory, state) = fixture();
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "07:00:00"));
        scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:00:00"));
        kunci_sebagai_koreksi_admin(&state);

        let sebelum: (String, String) = {
            let connection = storage::database(&state.data_dir).expect("local database");
            connection
                .query_row(
                    "SELECT COALESCE(jam_masuk, ''), COALESCE(jam_pulang, '') FROM absensi_harian WHERE id_karyawan = 'K001';",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("attendance row")
        };

        let hasil = scan(&state, "K001", "TOKEN-TEST", moment("2026-08-12", "15:30:00"));
        assert_eq!(hasil["sukses"], false);

        let connection = storage::database(&state.data_dir).expect("local database");
        let sesudah: (String, String, String) = connection
            .query_row(
                "SELECT sumber, COALESCE(jam_masuk, ''), COALESCE(jam_pulang, '') FROM absensi_harian WHERE id_karyawan = 'K001';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("attendance row");
        assert_eq!(sesudah.0, "Koreksi Admin");
        assert_eq!((sesudah.1, sesudah.2), sebelum);
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
