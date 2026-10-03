//! Lisensi offline Ed25519 (format `LIS1`) untuk build Desktop dan Mobile.
//!
//! Penerbitnya hidup DI LUAR repo ini (folder `lisensi` milik pemilik aplikasi,
//! dipakai lintas produk) dan satu-satunya yang tahu private
//! key. Aplikasi hanya memegang PUBLIC key, jadi lisensi bisa diperiksa tanpa
//! jaringan: janji offline-first tidak berkurang, dan mayoritas pemasangan
//! (server sendiri / Database Lokal) memang tidak pernah bisa menjangkau server
//! aktivasi mana pun.
//!
//! Aturan validasi isi lisensi di sini WAJIB identik dengan `validasiLisensi`
//! di `lisensi/src/format.ts`. `VECTOR_V1`..`VECTOR_V3` di bawah dibuat oleh
//! `tandaTangani` alat penerbit dengan kunci uji yang sama dengan `KUNCI_UJI`
//! di `lisensi/test/format.test.ts`, untuk produk `kos-absensi-perusahaan`.
//!
//! Lisensinya disimpan di kunci `app_license` tabel `setting_gex_system` yang
//! ikut sinkronisasi: dipasang SEKALI per lembaga, perangkat lain menerimanya
//! lewat pull.
//!
//! Lisensi yang sama juga bisa mencakup versi Web self-hosted lewat dua kolom
//! opsional, `instance_web` dan `website`. Yang MENEGAKKAN keduanya adalah
//! server Web (`src/lib/server/license.ts`); di sini keduanya hanya divalidasi
//! bentuknya, karena Desktop dan Mobile menarik lisensi yang sama lewat sync dan
//! akan menolaknya sebagai "kolom tidak dikenal" bila tidak mengenal kolom itu.

use base64::prelude::*;
use ring::signature::{UnparsedPublicKey, ED25519};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{config::DesktopState, models::CommandError, storage, sync, time_policy};

/// Kode produk aplikasi ini di alat lisensi. Setiap aplikasi penerbit punya
/// kode (dan pasangan kunci) sendiri, supaya lisensi satu aplikasi tidak sah
/// di aplikasi lain.
pub const LICENSE_PRODUCT: &str = "kos-absensi-perusahaan";
pub const LICENSE_SETTING_KEY: &str = "app_license";
/// Penerbit lisensi yang disebut di pesan untuk klien. Padanannya di UI:
/// `LICENSE_ISSUER` di `lib/gateways/license.ts`.
pub const LICENSE_ISSUER: &str = "Kemal Office Studio";

/// Public key produk `kos-absensi-perusahaan`, hasil
/// `bun run keygen kos-absensi-perusahaan` di folder alat lisensi (dibuat 2026-10-02). Aman dibagikan. Mengganti nilainya
/// membuat SEMUA lisensi yang sudah diterbitkan tidak sah lagi.
const PRODUCT_PUBLIC_KEY_HEX: &str =
    "cc2865415a6c7e3bf9ccf647b4ffcd01f6f0abc0ef036f08366e936e00bc731f";

/// Tanggal build (WIB), ditulis `build.rs`. Dibandingkan dengan
/// `pembaruan_sampai`: versi yang dibangun setelah masa pembaruan habis tidak
/// tercakup lisensinya, sementara versi lama tetap bisa dipakai selamanya.
pub const BUILD_DATE: &str = env!("SPPG_BUILD_DATE");

const LICENSE_PREFIX: &str = "LIS1";
const MAX_LICENSE_TEXT: usize = 16_384;
const MAX_DEVICES: usize = 200;
const MAX_HOLDER_CHARS: usize = 120;
const MAX_WEBSITES: usize = 10;
const LICENSE_KINDS: [&str; 2] = ["beli_putus", "sewa"];
const LICENSE_KEYS: [&str; 12] = [
    "v",
    "produk",
    "id",
    "pemegang",
    "jenis",
    "terbit",
    "pembaruan_sampai",
    "berlaku_sampai",
    "perangkat",
    "kunci_mobile",
    "instance_web",
    "website",
];

/// Izin yang tetap boleh dalam mode baca-saja selain semua `*.view`.
/// Sinkronisasi harus tetap jalan supaya data yang masih tertahan di outbox
/// sampai ke cloud, dan ekspor harus tetap jalan karena datanya milik klien —
/// lisensi yang habis tidak boleh menyandera data absensi dan gaji mereka.
const READ_ONLY_EXTRA_PERMISSIONS: [&str; 2] = ["sync.retry", "database_backup.export"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub id: String,
    pub holder: String,
    pub kind: String,
    pub issued: String,
    pub updates_until: String,
    pub valid_until: Option<String>,
    pub devices: Vec<String>,
    pub lock_mobile: bool,
    /// Kode instance server Web yang dicakup; `None` = lisensi tidak berlaku di
    /// Web. Tidak memengaruhi Desktop/Mobile.
    pub web_instance: Option<String>,
    /// Alamat tempat versi Web boleh dilayani; kosong = alamat apa pun.
    pub websites: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseState {
    Active,
    ReadOnly,
    Missing,
    Invalid,
    DeviceNotListed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyReason {
    Expired,
    VersionNotCovered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation {
    pub state: LicenseState,
    pub read_only_reason: Option<ReadOnlyReason>,
    pub message: Option<String>,
    pub payload: Option<LicensePayload>,
}

/// Hak yang dibawa sesi login. `read_only` dihitung saat login; `valid_until`
/// dibandingkan ulang di setiap gerbang izin karena terminal pemindai bisa
/// tetap login berbulan-bulan melewati tanggal berakhirnya sewa.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LicenseGrant {
    pub read_only: Option<ReadOnlyReason>,
    pub valid_until: Option<String>,
    pub updates_until: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub state: LicenseState,
    pub read_only_reason: Option<ReadOnlyReason>,
    pub message: Option<String>,
    pub license: Option<LicensePayload>,
    /// Sisa hari sewa (hari ini ikut dihitung); `None` untuk beli putus.
    pub days_left: Option<i64>,
    pub device_code: String,
    /// Nama perangkat yang dikenali manusia (nama komputer, merek + model HP),
    /// hanya untuk dibaca; `None` bila platform tidak memberikannya.
    pub device_name: Option<String>,
    pub device_bound: bool,
    pub build_date: String,
}

fn is_product_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=40).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn is_license_id(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn is_device_code(value: &str) -> bool {
    is_code_shape(value, |prefix| matches!(prefix, b'W' | b'L' | b'A' | b'M'))
}

fn is_code_shape(value: &str, prefix_ok: impl Fn(u8) -> bool) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 21
        && prefix_ok(bytes[0])
        && bytes.iter().enumerate().skip(1).all(|(index, byte)| {
            if index % 5 == 1 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'A'..=b'F').contains(byte)
            }
        })
}

/// Kode instance server Web: bentuknya sama dengan kode perangkat, berawalan
/// `S`. Sengaja BUKAN anggota `is_device_code`: kode `S` di daftar `perangkat`
/// membuat daftar itu tidak kosong, lalu semua Desktop ikut wajib terdaftar.
pub fn is_instance_code(value: &str) -> bool {
    is_code_shape(value, |prefix| prefix == b'S')
}

/// Cermin `alamatWebsiteSah` (TS), baris demi baris: nama domain lengkap, huruf
/// kecil, tanpa skema, port, atau wildcard. Alamat IP ditolak (label terakhir
/// wajib memuat huruf) karena IP jaringan lokal tidak unik antarlembaga.
pub fn is_website_host(value: &str) -> bool {
    if !(4..=253).contains(&value.len()) {
        return false;
    }
    let labels = value.split('.').collect::<Vec<_>>();
    if labels.len() < 2 {
        return false;
    }
    for label in &labels {
        let bytes = label.as_bytes();
        if !(1..=63).contains(&bytes.len())
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
            || bytes[0] == b'-'
            || bytes[bytes.len() - 1] == b'-'
        {
            return false;
        }
    }
    labels
        .last()
        .is_some_and(|label| label.bytes().any(|byte| byte.is_ascii_lowercase()))
}

fn string_field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// Cermin `validasiLisensi` (TS): urutan pemeriksaan dan pesannya sama.
fn validate_payload(value: &Value) -> Result<(String, LicensePayload), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Isi lisensi harus berupa objek JSON.".to_owned())?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !LICENSE_KEYS.contains(&key.as_str()))
    {
        return Err(format!("Kolom lisensi tidak dikenal: {unknown}."));
    }
    if object.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("Versi lisensi tidak didukung.".into());
    }
    let product = string_field(object, "produk")
        .filter(|value| is_product_code(value))
        .ok_or_else(|| "Kode produk tidak sah.".to_owned())?;
    let id = string_field(object, "id")
        .filter(|value| is_license_id(value))
        .ok_or_else(|| "ID lisensi tidak sah.".to_owned())?;
    let holder = string_field(object, "pemegang")
        .filter(|value| {
            !value.is_empty()
                && value.trim() == *value
                && value.chars().count() <= MAX_HOLDER_CHARS
                && !value
                    .chars()
                    .any(|character| matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'))
        })
        .ok_or_else(|| "Nama pemegang lisensi tidak sah.".to_owned())?;
    let kind = string_field(object, "jenis")
        .filter(|value| LICENSE_KINDS.contains(value))
        .ok_or_else(|| "Jenis lisensi tidak dikenal.".to_owned())?;
    let issued = string_field(object, "terbit")
        .filter(|value| time_policy::is_calendar_date(value))
        .ok_or_else(|| "Tanggal terbit tidak sah.".to_owned())?;
    let updates_until = string_field(object, "pembaruan_sampai")
        .filter(|value| time_policy::is_calendar_date(value))
        .ok_or_else(|| "Tanggal pembaruan_sampai tidak sah.".to_owned())?;
    if updates_until < issued {
        return Err("pembaruan_sampai tidak boleh sebelum tanggal terbit.".into());
    }
    let valid_until = if kind == "beli_putus" {
        if object.get("berlaku_sampai") != Some(&Value::Null) {
            return Err("Lisensi beli_putus tidak punya berlaku_sampai.".into());
        }
        None
    } else {
        let until = string_field(object, "berlaku_sampai")
            .filter(|value| time_policy::is_calendar_date(value))
            .ok_or_else(|| "Lisensi sewa wajib punya berlaku_sampai.".to_owned())?;
        if until < issued {
            return Err("berlaku_sampai tidak boleh sebelum tanggal terbit.".into());
        }
        Some(until.to_owned())
    };
    let devices = object
        .get("perangkat")
        .and_then(Value::as_array)
        .filter(|devices| devices.len() <= MAX_DEVICES)
        .ok_or_else(|| {
            format!("Daftar perangkat harus berupa array berisi maksimal {MAX_DEVICES} kode.")
        })?;
    let mut codes: Vec<String> = Vec::with_capacity(devices.len());
    for device in devices {
        let code = device
            .as_str()
            .filter(|code| is_device_code(code))
            .ok_or_else(|| format!("Kode perangkat tidak sah: {device}."))?;
        if codes.iter().any(|seen| seen == code) {
            return Err(format!("Kode perangkat ganda: {code}."));
        }
        codes.push(code.to_owned());
    }
    let lock_mobile = object
        .get("kunci_mobile")
        .and_then(Value::as_bool)
        .ok_or_else(|| "kunci_mobile harus true atau false.".to_owned())?;
    let web_instance = match object.get("instance_web") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|code| is_instance_code(code))
                .ok_or_else(|| "Kode instance Web tidak sah.".to_owned())?
                .to_owned(),
        ),
    };
    let mut websites: Vec<String> = Vec::new();
    if let Some(value) = object.get("website") {
        if web_instance.is_none() {
            return Err("website hanya berlaku bersama instance_web.".into());
        }
        let entries = value
            .as_array()
            .filter(|entries| (1..=MAX_WEBSITES).contains(&entries.len()))
            .ok_or_else(|| {
                format!("Daftar website harus berupa array berisi 1-{MAX_WEBSITES} alamat.")
            })?;
        for entry in entries {
            let host = entry
                .as_str()
                .filter(|host| is_website_host(host))
                .ok_or_else(|| format!("Alamat website tidak sah: {entry}."))?;
            if websites.iter().any(|seen| seen == host) {
                return Err(format!("Alamat website ganda: {host}."));
            }
            websites.push(host.to_owned());
        }
    }
    Ok((
        product.to_owned(),
        LicensePayload {
            id: id.to_owned(),
            holder: holder.to_owned(),
            kind: kind.to_owned(),
            issued: issued.to_owned(),
            updates_until: updates_until.to_owned(),
            valid_until,
            devices: codes,
            lock_mobile,
            web_instance,
            websites,
        },
    ))
}

/// Buang SEMUA spasi, tab, dan baris baru. Teks yang disalin dari terminal atau
/// WhatsApp sering terpotong di tengah; base64url tidak pernah memuat spasi,
/// jadi membuangnya tidak mungkin mengubah lisensi yang sah.
/// Cermin `rapikanTeks` di `lisensi/src/format.ts`.
pub fn compact_license_text(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

/// Verifikasi tanda tangan lalu validasi isi. Tanda tangan dihitung atas byte
/// `LIS1.<payload>` persis seperti tertulis, jadi JSON-nya tidak pernah disusun
/// ulang dan urutan kunci tidak memengaruhi keabsahan.
pub fn parse_license(text: &str, public_key: &[u8]) -> Result<LicensePayload, String> {
    if text.len() > MAX_LICENSE_TEXT * 4 {
        return Err("Teks lisensi terlalu panjang.".into());
    }
    let text = compact_license_text(text);
    if text.len() > MAX_LICENSE_TEXT {
        return Err("Teks lisensi terlalu panjang.".into());
    }
    let parts = text.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != LICENSE_PREFIX {
        return Err("Teks bukan lisensi LIS1.".into());
    }
    let signature = BASE64_URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "Tanda tangan lisensi rusak.".to_owned())?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "Tanda tangan lisensi tidak cocok.".to_owned())?;
    let payload = BASE64_URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Isi lisensi rusak.".to_owned())?;
    let value: Value =
        serde_json::from_slice(&payload).map_err(|_| "Isi lisensi rusak.".to_owned())?;
    let (product, license) = validate_payload(&value)?;
    if product != LICENSE_PRODUCT {
        return Err(format!(
            "Lisensi ini diterbitkan untuk produk lain ({product})."
        ));
    }
    Ok(license)
}

/// Apakah perangkat ini WAJIB tercantum di daftar perangkat lisensi.
pub fn device_must_be_listed(license: &LicensePayload, is_mobile: bool) -> bool {
    !license.devices.is_empty() && (!is_mobile || license.lock_mobile)
}

pub fn evaluate(
    text: Option<&str>,
    public_key: &[u8],
    device_code: &str,
    is_mobile: bool,
    build_date: &str,
    today: &str,
) -> Evaluation {
    let blocked =
        |state: LicenseState, message: String, payload: Option<LicensePayload>| Evaluation {
            state,
            read_only_reason: None,
            message: Some(message),
            payload,
        };
    let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) else {
        return blocked(
            LicenseState::Missing,
            format!("Aplikasi ini belum memiliki lisensi. Kirim kode perangkat di bawah kepada {LICENSE_ISSUER} untuk mendapatkannya."),
            None,
        );
    };
    if public_key.iter().all(|byte| *byte == 0) {
        return blocked(
            LicenseState::Invalid,
            format!(
                "Build aplikasi ini belum diberi public key lisensi. Hubungi {LICENSE_ISSUER}."
            ),
            None,
        );
    }
    let license = match parse_license(text, public_key) {
        Ok(license) => license,
        Err(reason) => {
            return blocked(
                LicenseState::Invalid,
                format!("Lisensi tidak sah: {reason}"),
                None,
            )
        }
    };
    if device_must_be_listed(&license, is_mobile)
        && !license.devices.iter().any(|code| code == device_code)
    {
        let message = format!(
            "Perangkat ini ({device_code}) tidak terdaftar di lisensi {}. Kirim kode perangkat ini kepada {LICENSE_ISSUER} untuk ditambahkan.",
            license.holder
        );
        return blocked(LicenseState::DeviceNotListed, message, Some(license));
    }
    let read_only = |reason: ReadOnlyReason, message: String, license: LicensePayload| Evaluation {
        state: LicenseState::ReadOnly,
        read_only_reason: Some(reason),
        message: Some(message),
        payload: Some(license),
    };
    if let Some(until) = license.valid_until.as_deref() {
        if today > until {
            let message = expired_message(until);
            return read_only(ReadOnlyReason::Expired, message, license);
        }
    }
    if build_date > license.updates_until.as_str() {
        let message = version_message(&license.updates_until, build_date);
        return read_only(ReadOnlyReason::VersionNotCovered, message, license);
    }
    Evaluation {
        state: LicenseState::Active,
        read_only_reason: None,
        message: None,
        payload: Some(license),
    }
}

fn expired_message(until: &str) -> String {
    format!(
        "Masa berlaku lisensi berakhir pada {until}. Aplikasi berjalan dalam mode baca-saja: data tetap bisa dilihat, diekspor, dan disinkronkan. Aktifkan lisensi baru untuk kembali mengubah data."
    )
}

fn version_message(updates_until: &str, build_date: &str) -> String {
    format!(
        "Versi aplikasi ini (build {build_date}) lebih baru dari masa pembaruan lisensi (sampai {updates_until}). Aplikasi berjalan dalam mode baca-saja. Perpanjang paket pembaruan, atau pasang kembali versi yang dirilis sebelum tanggal itu."
    )
}

/// Hak sesi dari hasil evaluasi. `None` = lisensi tidak mengizinkan login sama sekali.
pub fn grant_from(evaluation: &Evaluation) -> Option<LicenseGrant> {
    if !matches!(
        evaluation.state,
        LicenseState::Active | LicenseState::ReadOnly
    ) {
        return None;
    }
    let license = evaluation.payload.as_ref()?;
    Some(LicenseGrant {
        read_only: evaluation.read_only_reason,
        valid_until: license.valid_until.clone(),
        updates_until: license.updates_until.clone(),
    })
}

pub fn read_only_allows(permission: &str) -> bool {
    permission.ends_with(".view") || READ_ONLY_EXTRA_PERMISSIONS.contains(&permission)
}

pub fn grant_allows(grant: &LicenseGrant, permission: &str, today: &str) -> bool {
    if read_only_allows(permission) {
        return true;
    }
    grant.read_only.is_none()
        && grant
            .valid_until
            .as_deref()
            .map_or(true, |until| today <= until)
}

fn read_only_error(grant: &LicenseGrant) -> CommandError {
    let message = match (grant.read_only, grant.valid_until.as_deref()) {
        (Some(ReadOnlyReason::VersionNotCovered), _) => {
            version_message(&grant.updates_until, BUILD_DATE)
        }
        (_, Some(until)) => expired_message(until),
        _ => "Lisensi berada dalam mode baca-saja.".to_owned(),
    };
    CommandError::new("LICENSE_READ_ONLY", message)
}

/// Kode perangkat: 16 hex pertama SHA-256 id mentah, diawali huruf platform.
/// Id mentahnya di-hash supaya MachineGuid asli tidak pernah bocor, dan nama
/// produk ikut di-hash supaya PC yang sama memberi kode berbeda untuk tiap
/// aplikasi milik penerbit yang sama.
pub fn device_code(platform_prefix: char, raw_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"lisensi-perangkat-v1:");
    hash.update(LICENSE_PRODUCT.as_bytes());
    hash.update(b":");
    hash.update(raw_id.as_bytes());
    let hex = hex::encode_upper(&hash.finalize()[..8]);
    format!(
        "{platform_prefix}-{}-{}-{}-{}",
        &hex[0..4],
        &hex[4..8],
        &hex[8..12],
        &hex[12..16]
    )
}

// ---------------------------------------------------------------------------
// I/O: identitas perangkat, penyimpanan, dan gerbang.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const PLATFORM_PREFIX: char = 'W';
#[cfg(all(target_os = "linux", not(target_os = "android")))]
const PLATFORM_PREFIX: char = 'L';
#[cfg(target_os = "android")]
const PLATFORM_PREFIX: char = 'A';
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PLATFORM_PREFIX: char = 'M';

const IS_MOBILE: bool = cfg!(any(target_os = "android", target_os = "ios"));

/// Id mesin yang bertahan melewati instal ulang aplikasi. Windows: MachineGuid
/// (berubah bila Windows diinstal ulang, dan SAMA pada PC hasil kloning image).
/// Linux: machine-id. Platform lain — dan kegagalan membaca — jatuh ke id acak
/// aplikasi, yang hilang bila aplikasi dihapus beserta datanya.
fn hardware_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_registry::LOCAL_MACHINE
            .open("SOFTWARE\\Microsoft\\Cryptography")
            .and_then(|key| key.get_string("MachineGuid"))
            .ok()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
    }
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"]
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok())
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
    }
    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "linux", not(target_os = "android"))
    )))]
    {
        None
    }
}

pub fn current_device_code(state: &DesktopState) -> Result<String, CommandError> {
    let raw = match hardware_id() {
        Some(raw) => raw,
        None => storage::get_or_create_device_id(&state.data_dir)?,
    };
    Ok(device_code(PLATFORM_PREFIX, &raw))
}

const MAX_DEVICE_NAME_CHARS: usize = 64;

/// Rapikan nama perangkat mentah: buang karakter kontrol dan spasi berlebih,
/// potong ke 64 karakter. Kosong = tidak ada nama.
fn tidy_device_name(raw: &str) -> Option<String> {
    let name = raw
        .split(|character: char| character.is_whitespace() || character.is_control())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name = name.chars().take(MAX_DEVICE_NAME_CHARS).collect::<String>();
    (!name.is_empty()).then_some(name)
}

/// Label HP Android dari properti sistem. Nama pasar (`ro.product.marketname`,
/// mis. "Redmi Note 12") lebih dikenali daripada kode model, tetapi tidak
/// semua merek mengisinya. Merek tidak diulang bila model sudah memuatnya.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn android_device_label(market_name: &str, manufacturer: &str, model: &str) -> Option<String> {
    if let Some(name) = tidy_device_name(market_name) {
        return Some(name);
    }
    let model = tidy_device_name(model)?;
    match tidy_device_name(manufacturer) {
        Some(brand) if !model.to_lowercase().starts_with(&brand.to_lowercase()) => {
            let mut letters = brand.chars();
            let brand = letters
                .next()
                .map(|first| first.to_uppercase().chain(letters).collect::<String>())
                .unwrap_or_default();
            tidy_device_name(&format!("{brand} {model}"))
        }
        _ => Some(model),
    }
}

#[cfg(target_os = "android")]
fn android_property(name: &str) -> String {
    std::process::Command::new("getprop")
        .arg(name)
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

/// Nama perangkat untuk layar aktivasi dan kartu Lisensi, supaya klien dan
/// `LICENSE_ISSUER` tahu kode perangkat mana milik PC atau HP yang mana.
/// Lisensi TIDAK pernah mengikat nama ini: pemiliknya bisa menggantinya kapan
/// saja, sedangkan kode perangkat tidak berubah.
pub fn device_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMPUTERNAME")
            .ok()
            .and_then(|name| tidy_device_name(&name))
    }
    #[cfg(target_os = "android")]
    {
        android_device_label(
            &android_property("ro.product.marketname"),
            &android_property("ro.product.manufacturer"),
            &android_property("ro.product.model"),
        )
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .and_then(|name| tidy_device_name(&name))
    }
    #[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
    {
        None
    }
}

pub fn today_wib() -> String {
    time_policy::wib_date_from_epoch(storage::now_epoch_seconds())
}

fn product_public_key() -> Vec<u8> {
    hex::decode(PRODUCT_PUBLIC_KEY_HEX).unwrap_or_default()
}

fn stored_license(state: &DesktopState) -> Result<Option<String>, CommandError> {
    storage::get_system_setting(&state.data_dir, LICENSE_SETTING_KEY)
}

fn evaluate_text(text: Option<&str>, device_code: &str) -> Evaluation {
    evaluate(
        text,
        &product_public_key(),
        device_code,
        IS_MOBILE,
        BUILD_DATE,
        &today_wib(),
    )
}

/// Ambil lisensi dari cloud bila salinan lokal belum sah — perangkat baru yang
/// bergabung ke database yang sudah berlisensi belum pernah menarik snapshot.
/// Baris lokal yang event outbox-nya masih menggantung (lisensi yang baru saja
/// dipasang saat offline) tidak ditimpa, sama seperti aturan pull biasa.
async fn refresh_from_cloud(state: &DesktopState) -> Result<(), CommandError> {
    let Ok(client) = state.get_turso_client() else {
        return Ok(());
    };
    let pending: bool = storage::database(&state.data_dir)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict') LIMIT 1);",
            params![LICENSE_SETTING_KEY],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if pending {
        return Ok(());
    }
    let cloud = client
        .query_one(
            "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
            vec![json!(LICENSE_SETTING_KEY)],
        )
        .await?
        .to_objects()
        .into_iter()
        .next()
        .and_then(|row| row.get("value").and_then(Value::as_str).map(str::to_owned))
        .filter(|value| !value.trim().is_empty());
    if let Some(value) = cloud {
        storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, &value)?;
    }
    Ok(())
}

/// Evaluasi lisensi perangkat ini. Membaca lokal lebih dulu; cloud hanya
/// ditanya bila salinan lokal tidak aktif, supaya layar login pemasangan yang
/// sehat tidak pernah menunggu jaringan.
pub async fn resolve(state: &DesktopState) -> Result<(Evaluation, String), CommandError> {
    let code = current_device_code(state)?;
    let local = evaluate_text(stored_license(state)?.as_deref(), &code);
    if local.state == LicenseState::Active {
        return Ok((local, code));
    }
    if let Err(error) = refresh_from_cloud(state).await {
        eprintln!("[license] Lisensi cloud tidak terbaca: {}", error.code);
        return Ok((local, code));
    }
    Ok((
        evaluate_text(stored_license(state)?.as_deref(), &code),
        code,
    ))
}

/// Sisa hari sewa dengan hari ini ikut dihitung: hari terakhir sewa = 1, sewa
/// yang sudah lewat = 0. Sama dengan cara alat penerbit menghitung `--hari`,
/// sehingga sewa 30 hari menampilkan "30 hari" pada hari terbitnya.
pub fn rental_days_left(valid_until: &str, today: &str) -> Option<i64> {
    time_policy::days_between(today, valid_until)
        .ok()
        .map(|days| (days + 1).max(0))
}

fn to_status(evaluation: Evaluation, device_code: String) -> LicenseStatus {
    let device_bound = evaluation
        .payload
        .as_ref()
        .is_some_and(|license| device_must_be_listed(license, IS_MOBILE));
    let days_left = evaluation
        .payload
        .as_ref()
        .and_then(|license| license.valid_until.as_deref())
        .and_then(|until| rental_days_left(until, &today_wib()));
    LicenseStatus {
        state: evaluation.state,
        read_only_reason: evaluation.read_only_reason,
        message: evaluation.message,
        license: evaluation.payload,
        days_left,
        device_code,
        device_name: device_name(),
        device_bound,
        build_date: BUILD_DATE.to_owned(),
    }
}

pub async fn status(state: &DesktopState) -> Result<LicenseStatus, CommandError> {
    let (evaluation, code) = resolve(state).await?;
    Ok(to_status(evaluation, code))
}

/// Gerbang login: tanpa lisensi, lisensi tidak sah, atau perangkat yang tidak
/// terdaftar tidak boleh membuat sesi sama sekali. Lisensi yang habis tetap
/// boleh masuk — dalam mode baca-saja.
pub async fn gate_login(state: &DesktopState) -> Result<LicenseGrant, CommandError> {
    let (evaluation, _) = resolve(state).await?;
    if let Some(grant) = grant_from(&evaluation) {
        return Ok(grant);
    }
    let code = match evaluation.state {
        LicenseState::DeviceNotListed => "LICENSE_DEVICE_NOT_LISTED",
        LicenseState::Missing => "LICENSE_MISSING",
        _ => "LICENSE_INVALID",
    };
    Err(CommandError::new(
        code,
        evaluation
            .message
            .unwrap_or_else(|| "Lisensi tidak sah.".into()),
    ))
}

/// Verifikasi lisensi yang akan dipasang: hanya lisensi yang AKTIF penuh untuk
/// perangkat ini yang diterima, supaya tidak ada yang bisa mengunci dirinya
/// sendiri keluar dengan memasang lisensi yang tidak mencantumkan perangkatnya.
pub fn check_installable(text: &str, device_code: &str) -> Result<LicensePayload, CommandError> {
    let evaluation = evaluate_text(Some(text), device_code);
    match (evaluation.state, evaluation.payload) {
        (LicenseState::Active, Some(license)) => Ok(license),
        (_, _) => Err(CommandError::new(
            "LICENSE_REJECTED",
            evaluation
                .message
                .unwrap_or_else(|| "Lisensi tidak sah.".into()),
        )),
    }
}

/// Fungsi sinkron terpisah: koneksi rusqlite tidak `Send`, jadi ia wajib sudah
/// tertutup sebelum `install` menunggu jaringan.
fn store_local_and_enqueue(state: &DesktopState, text: &str) -> Result<(), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![LICENSE_SETTING_KEY, text],
        )
        .map_err(|_| CommandError::internal())?;
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_conflict WHERE domain = 'setting' AND entity_key = ?;",
        params![LICENSE_SETTING_KEY],
    );
    let _ = transaction.execute(
        "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ? AND status IN ('pending', 'failed', 'conflict');",
        params![LICENSE_SETTING_KEY],
    );
    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "update",
        LICENSE_SETTING_KEY,
        &json!({ "key": LICENSE_SETTING_KEY, "value": text }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())
}

/// Pasang lisensi di perangkat ini dan antrekan ke cloud lewat rute kanonik
/// `setting/update`. Juga ditulis langsung ke cloud bila terjangkau, supaya
/// perangkat lain menerimanya tanpa menunggu siapa pun login di sini.
pub async fn install(state: &DesktopState, text: &str) -> Result<LicenseStatus, CommandError> {
    let text = compact_license_text(text);
    let code = current_device_code(state)?;
    let license = check_installable(&text, &code)?;
    let (current, _) = resolve(state).await?;
    let operator = state
        .session
        .lock()
        .map_err(|_| CommandError::internal())?
        .as_ref()
        .map(|session| session.operator.clone());
    if current.state == LicenseState::Active
        && !operator
            .as_ref()
            .is_some_and(|operator| operator.is_superadmin)
    {
        return Err(CommandError::new(
            "LICENSE_REPLACE_FORBIDDEN",
            "Lisensi yang masih aktif hanya bisa diganti oleh Superadmin setelah login.",
        ));
    }

    // Pemasangan baru memasang lisensi SEBELUM database diatur. Belum ada
    // tujuan sync, jadi lisensi cukup disimpan lokal; bootstrap Superadmin atau
    // "gabung ke database yang sudah ada" yang kemudian membawanya ke cloud.
    if state.turso_config().is_none() {
        storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, &text)?;
    } else {
        store_local_and_enqueue(state, &text)?;
    }

    if let Ok(client) = state.get_turso_client() {
        let _ = client
            .query_one(
                "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                vec![json!(LICENSE_SETTING_KEY), json!(text)],
            )
            .await;
    }

    let (evaluation, code) = resolve(state).await?;
    if let Some(grant) = grant_from(&evaluation) {
        if let Some(session) = state
            .session
            .lock()
            .map_err(|_| CommandError::internal())?
            .as_mut()
        {
            session.license = grant;
        }
    }
    storage::audit(
        &state.data_dir,
        operator.map(|operator| operator.id),
        "license-installed",
        Some(&license.id),
    );
    Ok(to_status(evaluation, code))
}

/// Teks lisensi untuk bootstrap Superadmin: yang diketik di formulir bila ada,
/// selain itu lisensi yang sudah dipasang di layar aktivasi sebelum provisioning.
pub fn bootstrap_license_text(
    state: &DesktopState,
    provided: Option<String>,
) -> Result<String, CommandError> {
    let provided = provided
        .map(|text| compact_license_text(&text))
        .unwrap_or_default();
    if !provided.is_empty() {
        return Ok(provided);
    }
    Ok(stored_license(state)?.unwrap_or_default())
}

/// Tulis lisensi yang sudah terverifikasi ke database cloud yang baru saja
/// diprovisioning. Dipanggil dari bootstrap Superadmin, sebelum pull pertama.
pub async fn store_bootstrap_license(
    state: &DesktopState,
    client: &super::turso::TursoClient,
    text: &str,
) -> Result<(), CommandError> {
    client
        .query_one(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            vec![json!(LICENSE_SETTING_KEY), json!(text)],
        )
        .await?;
    storage::set_system_setting(&state.data_dir, LICENSE_SETTING_KEY, text)
}

/// Perangkat yang memasang lisensi sebelum provisioning lalu bergabung ke
/// database yang SUDAH ADA: bila database itu belum berlisensi (misalnya dibuat
/// lewat Web), lisensi perangkat ini dibawa ke sana. Tanpa ini, pull pertama
/// menimpa salinan lokalnya dan perangkat terkunci di login berikutnya.
/// Lisensi yang sudah ada di database tidak pernah ditimpa.
pub async fn publish_local_if_cloud_missing(
    state: &DesktopState,
    client: &super::turso::TursoClient,
) -> Result<(), CommandError> {
    let Some(local) = stored_license(state)? else {
        return Ok(());
    };
    let code = current_device_code(state)?;
    if grant_from(&evaluate_text(Some(&local), &code)).is_none() {
        return Ok(());
    }
    client
        .query_one(
            "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING;",
            vec![json!(LICENSE_SETTING_KEY), json!(local)],
        )
        .await?;
    Ok(())
}

/// Gerbang mode baca-saja untuk satu izin. Perpanjangan bisa tiba lewat sync
/// atau dipasang di perangkat lain saat sesi ini masih berjalan, jadi sebelum
/// menolak, lisensi lokal dibaca ulang sekali — hanya di jalur penolakan,
/// supaya jalur normal tidak pernah menyentuh disk.
pub fn enforce_any(
    state: &DesktopState,
    grant: &mut LicenseGrant,
    permissions: &[&str],
) -> Result<(), CommandError> {
    let today = today_wib();
    if permissions
        .iter()
        .any(|permission| grant_allows(grant, permission, &today))
    {
        return Ok(());
    }
    let fresh = current_device_code(state).ok().and_then(|code| {
        let text = stored_license(state).ok().flatten();
        grant_from(&evaluate_text(text.as_deref(), &code))
    });
    if let Some(fresh) = fresh {
        *grant = fresh;
        if permissions
            .iter()
            .any(|permission| grant_allows(grant, permission, &today))
        {
            return Ok(());
        }
    }
    Err(read_only_error(grant))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    /// Kunci uji: seed 32 byte bernilai 0x01 — sama dengan `KUNCI_UJI` di
    /// `lisensi/test/format.test.ts`.
    fn test_key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[1_u8; 32]).expect("seed uji")
    }
    const TEST_PUBLIC_HEX: &str =
        "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

    /// Vektor kembar hasil `tandaTangani` alat penerbit (kunci uji di atas,
    /// produk `kos-absensi-perusahaan`). Buat ulang lewat alat itu, jangan diketik.
    const VECTOR_V1: &str = "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAxIiwicGVtZWdhbmciOiJQVCBVamkgVmVrdG9yIiwiamVuaXMiOiJzZXdhIiwidGVyYml0IjoiMjAyNi0wOS0yMyIsInBlbWJhcnVhbl9zYW1wYWkiOiIyMDI3LTA5LTIzIiwiYmVybGFrdV9zYW1wYWkiOiIyMDI3LTA5LTIzIiwicGVyYW5na2F0IjpbIlctMUEyQi0zQzRELTVFNkYtN0E4QiJdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.Lj_wjeQ6wjc2iOTDncDbBoUk6NqjkFggWetWloj38D17zayOFUTnAJRweB0RLsEWzjHbrauo0lp_zpC2_JZNAQ";
    const VECTOR_V2: &str = "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAyIiwicGVtZWdhbmciOiJQVCBOdXNhbnRhcmEg4oCUIENhYmFuZyBUaW11ciIsImplbmlzIjoiYmVsaV9wdXR1cyIsInRlcmJpdCI6IjIwMjYtMDktMjMiLCJwZW1iYXJ1YW5fc2FtcGFpIjoiMjAyNy0wOS0yMyIsImJlcmxha3Vfc2FtcGFpIjpudWxsLCJwZXJhbmdrYXQiOltdLCJrdW5jaV9tb2JpbGUiOmZhbHNlfQ.dtKhJorN-g17bzs4Cdnk23XLHVvsvw_tzuV4QSsZfX--MgCc4jqFX5ssGqcFEN9Q8lE02H-aPfT6S_747JpKAw";
    const VECTOR_V3: &str = "LIS1.eyJ2IjoxLCJwcm9kdWsiOiJrb3MtYWJzZW5zaS1wZXJ1c2FoYWFuIiwiaWQiOiJMSVMtMjAyNi0wMDAzIiwicGVtZWdhbmciOiJQVCBVamkgV2ViIiwiamVuaXMiOiJiZWxpX3B1dHVzIiwidGVyYml0IjoiMjAyNi0xMC0wMSIsInBlbWJhcnVhbl9zYW1wYWkiOiIyMDI3LTEwLTAxIiwiYmVybGFrdV9zYW1wYWkiOm51bGwsInBlcmFuZ2thdCI6W10sImt1bmNpX21vYmlsZSI6ZmFsc2UsImluc3RhbmNlX3dlYiI6IlMtNEMxRC04OEFBLTAyRjMtN0IxOSIsIndlYnNpdGUiOlsiYWJzZW5zaS5wdC11amkuY28uaWQiXX0.frjI0Y828KRjFd0wIeD_tCNbafejcvguSa7TPaS3knH8pJWzb5npW_ESeb91O0w9AYJIj8Ow75aRDbVOr_olAA";
    const INSTANCE: &str = "S-4C1D-88AA-02F3-7B19";
    const DEVICE: &str = "W-1A2B-3C4D-5E6F-7A8B";
    const OTHER_DEVICE: &str = "W-0000-1111-2222-3333";

    fn public_key() -> Vec<u8> {
        hex::decode(TEST_PUBLIC_HEX).unwrap()
    }

    fn sign(payload: &Value) -> String {
        let body = BASE64_URL_SAFE_NO_PAD.encode(payload.to_string());
        let input = format!("LIS1.{body}");
        let signature = test_key().sign(input.as_bytes());
        format!(
            "{input}.{}",
            BASE64_URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }

    fn base_payload() -> Value {
        json!({
            "v": 1, "produk": "kos-absensi-perusahaan", "id": "LIS-UJI", "pemegang": "PT Uji",
            "jenis": "beli_putus", "terbit": "2026-09-23", "pembaruan_sampai": "2027-09-23",
            "berlaku_sampai": null, "perangkat": [], "kunci_mobile": false
        })
    }

    fn with(changes: Value) -> String {
        let mut payload = base_payload();
        for (key, value) in changes.as_object().unwrap() {
            payload[key] = value.clone();
        }
        sign(&payload)
    }

    fn eval(text: &str, device: &str, mobile: bool, build: &str, today: &str) -> Evaluation {
        evaluate(Some(text), &public_key(), device, mobile, build, today)
    }

    #[test]
    fn test_key_matches_issuer_vector() {
        assert_eq!(
            hex::encode(test_key().public_key().as_ref()),
            TEST_PUBLIC_HEX
        );
    }

    #[test]
    fn twin_vectors_verify_and_parse() {
        let v1 = parse_license(VECTOR_V1, &public_key()).expect("V1 sah");
        assert_eq!(
            v1,
            LicensePayload {
                id: "LIS-2026-0001".into(),
                holder: "PT Uji Vektor".into(),
                kind: "sewa".into(),
                issued: "2026-09-23".into(),
                updates_until: "2027-09-23".into(),
                valid_until: Some("2027-09-23".into()),
                devices: vec![DEVICE.into()],
                lock_mobile: false,
                web_instance: None,
                websites: vec![],
            }
        );
        let v2 = parse_license(VECTOR_V2, &public_key()).expect("V2 sah");
        assert_eq!(v2.holder, "PT Nusantara — Cabang Timur");
        assert_eq!(v2.kind, "beli_putus");
        assert_eq!(v2.valid_until, None);
        assert!(v2.devices.is_empty());
        assert_eq!(v2.web_instance, None);

        let v3 = parse_license(VECTOR_V3, &public_key()).expect("V3 sah");
        assert_eq!(v3.holder, "PT Uji Web");
        assert_eq!(v3.web_instance.as_deref(), Some(INSTANCE));
        assert_eq!(v3.websites, vec!["absensi.pt-uji.co.id".to_owned()]);
    }

    /// Vektor aturan versi Web: daftar yang sama dengan `describe("versi Web")`
    /// di `lisensi/test/format.test.ts` dan `license.test.ts` di server Web.
    #[test]
    fn web_fields_match_issuer() {
        let reject = |changes: Value| parse_license(&with(changes), &public_key()).unwrap_err();
        let accept = |changes: Value| parse_license(&with(changes), &public_key()).expect("sah");

        // Instance saja sudah sah; website opsional.
        let lan = accept(json!({ "instance_web": INSTANCE }));
        assert_eq!(lan.web_instance.as_deref(), Some(INSTANCE));
        assert!(lan.websites.is_empty());

        for code in [
            json!("W-4C1D-88AA-02F3-7B19"),
            json!("s-4c1d-88aa-02f3-7b19"),
            Value::Null,
        ] {
            assert_eq!(
                reject(json!({ "instance_web": code })),
                "Kode instance Web tidak sah."
            );
        }
        // Kode instance tidak boleh menumpang di daftar perangkat.
        assert!(reject(json!({ "perangkat": [INSTANCE] })).starts_with("Kode perangkat tidak sah"));

        assert_eq!(
            reject(json!({ "website": ["absensi.smk-uji.sch.id"] })),
            "website hanya berlaku bersama instance_web."
        );
        let with_instance = |website: Value| {
            reject(json!({ "instance_web": INSTANCE, "website": website }))
        };
        assert_eq!(
            with_instance(json!([])),
            "Daftar website harus berupa array berisi 1-10 alamat."
        );
        assert!(with_instance(json!("absensi.smk-uji.sch.id")).starts_with("Daftar website"));
        let eleven = (0..11).map(|i| format!("a{i}.sch.id")).collect::<Vec<_>>();
        assert!(with_instance(json!(eleven)).starts_with("Daftar website"));
        assert_eq!(
            with_instance(json!(["a.sch.id", "a.sch.id"])),
            "Alamat website ganda: a.sch.id."
        );
        assert!(with_instance(json!(["192.168.1.10"])).starts_with("Alamat website tidak sah"));

        for host in [
            "absensi.smk-uji.sch.id",
            "sekolah.id",
            "a1.b2.co",
            "xn--80ak6aa92e.com",
        ] {
            assert!(is_website_host(host), "{host} harus sah");
        }
        let too_long = format!("{}.id", "a".repeat(64));
        for host in [
            "192.168.1.10",
            "localhost",
            "Absensi.Sekolah.id",
            "https://sekolah.id",
            "sekolah.id:3000",
            "sekolah.id/",
            "*.sekolah.id",
            "-a.sekolah.id",
            "a-.sekolah.id",
            "sekolah..id",
            "sekolah.id.",
            "sekolah.123",
            "a.b",
            too_long.as_str(),
            "",
        ] {
            assert!(!is_website_host(host), "{host} harus ditolak");
        }
    }

    /// Kolom Web tidak mengubah apa pun bagi Desktop dan Mobile: lisensi yang
    /// sama, dengan atau tanpa kolom itu, dinilai persis sama.
    #[test]
    fn web_fields_do_not_affect_device_evaluation() {
        let plain = with(json!({ "perangkat": [DEVICE] }));
        let web = with(json!({
            "perangkat": [DEVICE], "instance_web": INSTANCE,
            "website": ["absensi.smk-uji.sch.id"]
        }));
        for (device, mobile) in [(DEVICE, false), (OTHER_DEVICE, false), (OTHER_DEVICE, true)] {
            assert_eq!(
                eval(&web, device, mobile, "2026-09-30", "2026-10-01").state,
                eval(&plain, device, mobile, "2026-09-30", "2026-10-01").state
            );
        }
    }

    #[test]
    fn rust_signing_reproduces_issuer_vector_bytes() {
        // Ed25519 deterministik: payload JSON yang sama byte demi byte harus
        // menghasilkan tanda tangan yang sama dengan penerbit TypeScript.
        let body = VECTOR_V1.split('.').nth(1).unwrap();
        let input = format!("LIS1.{body}");
        let signature = BASE64_URL_SAFE_NO_PAD.encode(test_key().sign(input.as_bytes()).as_ref());
        assert_eq!(format!("{input}.{signature}"), VECTOR_V1);
    }

    #[test]
    fn tampering_and_foreign_keys_are_rejected() {
        let mut parts = VECTOR_V1.split('.').map(str::to_owned).collect::<Vec<_>>();
        let replacement = if &parts[1][10..11] == "A" { "B" } else { "A" };
        parts[1].replace_range(10..11, replacement);
        assert!(parse_license(&parts.join("."), &public_key()).is_err());

        let other = Ed25519KeyPair::from_seed_unchecked(&[2_u8; 32]).unwrap();
        assert_eq!(
            parse_license(VECTOR_V1, other.public_key().as_ref()),
            Err("Tanda tangan lisensi tidak cocok.".into())
        );
        assert_eq!(
            parse_license(&VECTOR_V1.replacen("LIS1", "LIS2", 1), &public_key()),
            Err("Teks bukan lisensi LIS1.".into())
        );
    }

    #[test]
    fn payload_rules_match_issuer() {
        let reject = |changes: Value| parse_license(&with(changes), &public_key()).unwrap_err();
        assert_eq!(
            reject(json!({ "maks_perangkat": 9 })),
            "Kolom lisensi tidak dikenal: maks_perangkat."
        );
        assert_eq!(reject(json!({ "v": 2 })), "Versi lisensi tidak didukung.");
        assert_eq!(
            reject(json!({ "produk": "Absensi" })),
            "Kode produk tidak sah."
        );
        assert_eq!(
            reject(json!({ "pemegang": " PT" })),
            "Nama pemegang lisensi tidak sah."
        );
        assert_eq!(
            reject(json!({ "pemegang": "A\u{7}" })),
            "Nama pemegang lisensi tidak sah."
        );
        assert_eq!(
            reject(json!({ "jenis": "gratis" })),
            "Jenis lisensi tidak dikenal."
        );
        assert_eq!(
            reject(json!({ "terbit": "2026-02-30" })),
            "Tanggal terbit tidak sah."
        );
        assert_eq!(
            reject(json!({ "terbit": "2026-9-23" })),
            "Tanggal terbit tidak sah."
        );
        assert_eq!(
            reject(json!({ "pembaruan_sampai": "2026-01-01" })),
            "pembaruan_sampai tidak boleh sebelum tanggal terbit."
        );
        assert_eq!(
            reject(json!({ "berlaku_sampai": "2027-01-01" })),
            "Lisensi beli_putus tidak punya berlaku_sampai."
        );
        assert_eq!(
            reject(json!({ "jenis": "sewa" })),
            "Lisensi sewa wajib punya berlaku_sampai."
        );
        assert_eq!(
            reject(json!({ "perangkat": ["w-1a2b-3c4d-5e6f-7a8b"] })),
            "Kode perangkat tidak sah: \"w-1a2b-3c4d-5e6f-7a8b\"."
        );
        assert_eq!(
            reject(json!({ "perangkat": [DEVICE, DEVICE] })),
            format!("Kode perangkat ganda: {DEVICE}.")
        );
        assert_eq!(
            reject(json!({ "kunci_mobile": "ya" })),
            "kunci_mobile harus true atau false."
        );
        assert_eq!(
            reject(json!({ "produk": "produk-lain" })),
            "Lisensi ini diterbitkan untuk produk lain (produk-lain)."
        );

        let mut missing = base_payload();
        missing.as_object_mut().unwrap().remove("berlaku_sampai");
        assert!(parse_license(&sign(&missing), &public_key()).is_err());
    }

    #[test]
    fn evaluation_states() {
        let today = "2026-10-01";
        let build = "2026-09-30";
        let perpetual = with(json!({}));
        assert_eq!(
            eval(&perpetual, DEVICE, false, build, today).state,
            LicenseState::Active
        );

        let expired = with(json!({ "jenis": "sewa", "berlaku_sampai": "2026-09-30" }));
        let evaluation = eval(&expired, DEVICE, false, build, today);
        assert_eq!(evaluation.state, LicenseState::ReadOnly);
        assert_eq!(evaluation.read_only_reason, Some(ReadOnlyReason::Expired));
        // Hari terakhir masih berlaku penuh.
        assert_eq!(
            eval(&expired, DEVICE, false, build, "2026-09-30").state,
            LicenseState::Active
        );

        let old_maintenance = with(json!({ "pembaruan_sampai": "2026-09-29" }));
        let evaluation = eval(&old_maintenance, DEVICE, false, build, today);
        assert_eq!(
            evaluation.read_only_reason,
            Some(ReadOnlyReason::VersionNotCovered)
        );
        // Versi yang dibangun sebelum masa pembaruan habis tetap penuh selamanya.
        assert_eq!(
            eval(&old_maintenance, DEVICE, false, "2026-09-29", "2030-01-01").state,
            LicenseState::Active
        );

        assert_eq!(
            evaluate(None, &public_key(), DEVICE, false, build, today).state,
            LicenseState::Missing
        );
        assert_eq!(
            eval("sampah", DEVICE, false, build, today).state,
            LicenseState::Invalid
        );
        assert_eq!(
            evaluate(Some(&perpetual), &[0_u8; 32], DEVICE, false, build, today).state,
            LicenseState::Invalid
        );
    }

    #[test]
    fn device_binding_respects_mobile_flag() {
        let today = "2026-10-01";
        let build = "2026-09-30";
        let bound = with(json!({ "perangkat": [DEVICE] }));
        assert_eq!(
            eval(&bound, DEVICE, false, build, today).state,
            LicenseState::Active
        );
        let other = eval(&bound, OTHER_DEVICE, false, build, today);
        assert_eq!(other.state, LicenseState::DeviceNotListed);
        assert!(other.message.unwrap().contains(OTHER_DEVICE));
        // HP bebas selama kunci_mobile mati...
        assert_eq!(
            eval(&bound, "A-9999-8888-7777-6666", true, build, today).state,
            LicenseState::Active
        );
        // ...dan ikut dikunci bila dinyalakan.
        let bound_mobile = with(json!({ "perangkat": [DEVICE], "kunci_mobile": true }));
        assert_eq!(
            eval(&bound_mobile, "A-9999-8888-7777-6666", true, build, today).state,
            LicenseState::DeviceNotListed
        );
        // Daftar kosong = tidak dikunci sama sekali.
        assert_eq!(
            eval(&with(json!({})), OTHER_DEVICE, false, build, today).state,
            LicenseState::Active
        );
    }

    #[test]
    fn read_only_gate() {
        assert!(read_only_allows("payroll.view"));
        assert!(read_only_allows("sync.retry"));
        assert!(read_only_allows("database_backup.export"));
        assert!(!read_only_allows("scanner.use"));
        assert!(!read_only_allows("payroll.run.create"));
        assert!(!read_only_allows("database_backup.restore"));

        let active = LicenseGrant {
            read_only: None,
            valid_until: Some("2026-10-31".into()),
            updates_until: "2027-01-01".into(),
        };
        assert!(grant_allows(&active, "scanner.use", "2026-10-31"));
        // Langganan yang habis saat sesi masih berjalan.
        assert!(!grant_allows(&active, "scanner.use", "2026-11-01"));
        assert!(grant_allows(&active, "home.view", "2026-11-01"));
        let read_only = LicenseGrant {
            read_only: Some(ReadOnlyReason::VersionNotCovered),
            ..active
        };
        assert!(!grant_allows(&read_only, "employees.manage", "2026-10-01"));
        assert_eq!(read_only_error(&read_only).code, "LICENSE_READ_ONLY");
    }

    #[test]
    fn grant_only_for_usable_states() {
        let evaluation = eval(&with(json!({})), DEVICE, false, "2026-09-30", "2026-10-01");
        assert_eq!(
            grant_from(&evaluation),
            Some(LicenseGrant {
                read_only: None,
                valid_until: None,
                updates_until: "2027-09-23".into(),
            })
        );
        let missing = evaluate(
            None,
            &public_key(),
            DEVICE,
            false,
            "2026-09-30",
            "2026-10-01",
        );
        assert_eq!(grant_from(&missing), None);
    }

    /// Vektor yang sama dengan `instanceCodeFromId` di `server/license.ts`:
    /// server Web menurunkan kodenya dengan rumus ini, berawalan `S`.
    #[test]
    fn instance_code_matches_web_server() {
        let code = device_code('S', "web-instance-uji");
        assert_eq!(code, "S-D95C-854B-9E1B-0BCF");
        assert!(is_instance_code(&code));
        assert!(!is_device_code(&code));
    }

    #[test]
    fn device_code_is_stable_and_well_formed() {
        let code = device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3432");
        assert!(is_device_code(&code), "{code}");
        assert_eq!(
            code,
            device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3432")
        );
        assert_ne!(
            code,
            device_code('W', "4c4c4544-0042-3510-8052-b4c04f4e3433")
        );
        assert!(code.starts_with("W-"));
        assert!(!is_device_code("W-1A2B-3C4D-5E6F-7A8"));
        assert!(!is_device_code("X-1A2B-3C4D-5E6F-7A8B"));
        assert!(!is_device_code("W-1A2B-3C4D-5E6F-7a8b"));
    }

    #[test]
    fn device_name_is_tidied_and_android_label_is_readable() {
        assert_eq!(tidy_device_name("  KANTOR-PC01\r\n"), Some("KANTOR-PC01".into()));
        assert_eq!(tidy_device_name("a\tb\u{7}  c"), Some("a b c".into()));
        assert_eq!(tidy_device_name(" \n "), None);
        assert_eq!(tidy_device_name(&"x".repeat(100)).unwrap().chars().count(), 64);

        assert_eq!(
            android_device_label("Redmi Note 12\n", "Xiaomi", "23021RAAEG"),
            Some("Redmi Note 12".into())
        );
        assert_eq!(
            android_device_label("", "samsung\n", "SM-A515F\n"),
            Some("Samsung SM-A515F".into())
        );
        // Model yang sudah memuat mereknya tidak diulang.
        assert_eq!(
            android_device_label("", "OPPO", "OPPO A57"),
            Some("OPPO A57".into())
        );
        assert_eq!(android_device_label("", "", "Pixel 7"), Some("Pixel 7".into()));
        assert_eq!(android_device_label("", "Google", ""), None);
    }

    #[test]
    fn build_date_is_a_calendar_date() {
        assert!(time_policy::is_calendar_date(BUILD_DATE), "{BUILD_DATE}");
    }

    #[test]
    fn whitespace_inside_license_is_ignored() {
        // Cermin tes "spasi dan baris baru di tengah teks dibuang" di
        // `lisensi/test/format.test.ts`: salinan dari terminal/WhatsApp.
        let broken = format!(
            "  {}\r\n{} \t{}\n",
            &VECTOR_V1[..120],
            &VECTOR_V1[120..200],
            &VECTOR_V1[200..]
        );
        assert_eq!(
            parse_license(&broken, &public_key()),
            parse_license(VECTOR_V1, &public_key())
        );
        assert_eq!(compact_license_text(&broken), VECTOR_V1);
    }

    #[test]
    fn rental_days_left_counts_today() {
        // Sewa 30 hari terbit 24 Sep berakhir 23 Okt (lihat `akhirSewa` di alat
        // penerbit): hari pertama = 30, hari terakhir = 1, sesudahnya = 0.
        assert_eq!(rental_days_left("2026-10-23", "2026-09-24"), Some(30));
        assert_eq!(rental_days_left("2026-10-23", "2026-10-23"), Some(1));
        assert_eq!(rental_days_left("2026-10-23", "2026-10-24"), Some(0));
        assert_eq!(rental_days_left("2026-10-23", "2027-01-01"), Some(0));
        assert_eq!(rental_days_left("bukan-tanggal", "2026-10-01"), None);
        assert_eq!(
            time_policy::days_between("2028-02-28", "2028-03-01"),
            Ok(2)
        );
    }

    #[test]
    fn wib_date_rolls_over_at_17_utc() {
        // 2026-09-23 16:59:59 UTC = 23:59:59 WIB; satu detik kemudian sudah besok.
        assert_eq!(
            time_policy::wib_date_from_epoch(1_790_182_799),
            "2026-09-23"
        );
        assert_eq!(
            time_policy::wib_date_from_epoch(1_790_182_800),
            "2026-09-24"
        );
    }
}
