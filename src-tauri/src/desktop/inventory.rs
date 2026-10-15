//! Modul Inventaris & Sarpras (Fase 1).
//!
//! Stok TIDAK pernah disimpan. Ia selalu dihitung dari `inventory_mutasi`
//! lewat view `inventory_saldo`, karena kolom stok yang ikut sync ditimpa
//! "siapa terakhir menang": dua perangkat offline yang sama-sama mengurangi
//! stok 10 sebanyak 2 dan 3 akan menghasilkan 8 atau 7, bukan 5. Mutasi
//! append-only tidak punya masalah itu — barisnya hanya bertambah.
//!
//! Aturan validasi di sini dieja kembar dengan `src/lib/validations/inventory.ts`
//! dan diuji dengan vektor yang sama di kedua bahasa.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{config::DesktopState, models::CommandError, storage, sync};

pub const TIPE_BARANG: [&str; 2] = ["Aset", "Habis Pakai"];
pub const JENIS_MUTASI: [&str; 3] = ["Masuk", "Keluar", "Pindah"];
/// Daftar ini WAJIB sama dengan CHECK `inventory_mutasi.alasan` di ketiga DDL.
pub const ALASAN_MUTASI: [&str; 13] = [
    "Saldo Awal",
    "Pengadaan",
    "Hibah",
    "Pengembalian",
    "Pemakaian",
    "Peminjaman",
    "Rusak/Afkir",
    "Hilang",
    "Kedaluwarsa",
    "Distribusi",
    "Perubahan Kondisi",
    "Selisih Opname",
    "Pembatalan",
];
pub const KONDISI_BARANG: [&str; 3] = ["Baik", "Rusak Ringan", "Rusak Berat"];
pub const PENERIMA_TIPE: [&str; 4] = ["Personil", "Divisi", "Unit", "Umum"];
/// Alasan yang bisa dicatat lewat `record_mutation`. Selisih Opname hanya
/// lewat `record_opname` (saldo sistemnya dihitung ulang di backend), dan
/// Pembatalan hanya lewat `cancel_mutation`.
pub const ALASAN_FORMULIR: [&str; 11] = [
    "Saldo Awal",
    "Pengadaan",
    "Hibah",
    "Pemakaian",
    "Peminjaman",
    "Pengembalian",
    "Rusak/Afkir",
    "Hilang",
    "Kedaluwarsa",
    "Distribusi",
    "Perubahan Kondisi",
];
pub const MAKS_JUMLAH: i64 = 1_000_000;
pub const MAKS_HARGA_SATUAN: i64 = 1_000_000_000_000;
pub const MAKS_PANJANG_TEMPAT: usize = 80;
pub const MAKS_BARIS_KARTU_STOK: usize = 1000;
pub const MAKS_BARIS_OPNAME: usize = 500;
pub const MAKS_BARIS_PINJAMAN: usize = 500;
/// Batch dengan sisa hari sebanyak ini atau kurang berstatus Waspada
/// (keputusan User, PRD §4.7). Cermin `INVENTORY_EXPIRY_WARNING_DAYS`.
pub const INVENTORY_EXPIRY_WARNING_DAYS: i64 = 30;

/// Izin yang dituntut sebuah alasan mutasi. Pembatalan, opname, dan
/// penghapusan stok mengurangi stok tanpa barangnya diterima siapa pun, jadi
/// butuh izin sensitif. Command memeriksanya SEBELUM menulis apa pun.
/// Cermin `izinUntukAlasan`.
pub fn izin_untuk_alasan(alasan: &str) -> &'static str {
    match alasan {
        "Rusak/Afkir" | "Hilang" | "Kedaluwarsa" | "Selisih Opname" | "Pembatalan" => {
            "inventory.adjust"
        }
        _ => "inventory.record",
    }
}

/// Cermin `statusKedaluwarsa`. Hari yang sama dengan tanggal kedaluwarsa
/// masih Waspada: label "ED" berarti boleh dipakai sampai tanggal itu.
pub fn status_kedaluwarsa(sisa_hari: i64) -> &'static str {
    if sisa_hari < 0 {
        "Kedaluwarsa"
    } else if sisa_hari <= INVENTORY_EXPIRY_WARNING_DAYS {
        "Waspada"
    } else {
        "Aman"
    }
}

/// Jenis berita acara untuk sebuah alasan mutasi. Cermin `jenisBeritaAcara`.
/// `None` berarti alasan itu tidak punya berita acara (misalnya Pengadaan).
pub fn jenis_berita_acara(alasan: &str) -> Option<&'static str> {
    match alasan {
        "Pemakaian" | "Peminjaman" | "Distribusi" => Some("Serah Terima"),
        "Kedaluwarsa" | "Rusak/Afkir" | "Hilang" => Some("Pemusnahan"),
        "Selisih Opname" => Some("Opname"),
        _ => None,
    }
}

pub const SUMBER_DANA_KOSONG: &str = "Tanpa sumber dana";

/// Satu baris rekap pengadaan per sumber dana.
#[derive(Debug, PartialEq)]
pub struct RekapSumberDana {
    pub sumber_dana: String,
    pub baris: i64,
    pub nilai: i64,
    pub tanpa_harga: i64,
}

/// Cermin `rekapSumberDana`. Masukan: (sumber dana, nilai, harga kosong?) per
/// baris pengadaan, urutan masukan dipertahankan per sumber. Sumber kosong
/// dikelompokkan sebagai "Tanpa sumber dana"; baris tanpa harga dihitung
/// terpisah supaya total nilai tidak terlihat lengkap padahal tidak.
pub fn rekap_sumber_dana(rows: &[(String, i64, bool)]) -> Vec<RekapSumberDana> {
    let mut hasil: Vec<RekapSumberDana> = Vec::new();
    for (sumber, nilai, tanpa_harga) in rows {
        let nama = if sumber.trim().is_empty() {
            SUMBER_DANA_KOSONG.to_owned()
        } else {
            sumber.trim().to_owned()
        };
        let index = match hasil.iter().position(|r| r.sumber_dana == nama) {
            Some(index) => index,
            None => {
                hasil.push(RekapSumberDana {
                    sumber_dana: nama,
                    baris: 0,
                    nilai: 0,
                    tanpa_harga: 0,
                });
                hasil.len() - 1
            }
        };
        let rekap = &mut hasil[index];
        rekap.baris += 1;
        rekap.nilai = rekap.nilai.saturating_add(*nilai);
        if *tanpa_harga {
            rekap.tanpa_harga += 1;
        }
    }
    hasil
}

/// Cermin `stokMenipis`. Stok minimum 0 berarti barang ini tidak dipantau.
pub fn stok_menipis(stok_baik: i64, stok_minimum: i64) -> bool {
    stok_minimum > 0 && stok_baik < stok_minimum
}
/// Daftar awalan kode barang, JSON array di `setting_gex_system`. Ikut sync:
/// awalan yang didaftarkan di laptop kantor harus muncul di HP gudang.
pub const KODE_PREFIX_SETTING_KEY: &str = "inventory_kode_prefix";
pub const KODE_PREFIX_BAWAAN: &str = "BRG";
pub const MAKS_KODE_PREFIX: usize = 20;

/// Cermin `normalizeKodePrefix`: 1 sampai 6 huruf atau angka, huruf besar.
pub fn normalize_kode_prefix(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_uppercase();
    let panjang = value.chars().count();
    ((1..=6).contains(&panjang)
        && value
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
    .then_some(value)
}

/// Cermin `parseKodePrefixes`. Nilai tersimpan yang rusak tidak boleh
/// mematikan penambahan barang: entri rusak dibuang, dan daftar kosong
/// kembali ke awalan bawaan.
pub fn parse_kode_prefixes(stored: Option<&str>) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = stored.and_then(|text| serde_json::from_str(text).ok()) {
        for item in items {
            if let Some(prefix) = item.as_str().and_then(normalize_kode_prefix) {
                if !list.contains(&prefix) && list.len() < MAKS_KODE_PREFIX {
                    list.push(prefix);
                }
            }
        }
    }
    if list.is_empty() {
        list.push(KODE_PREFIX_BAWAAN.to_owned());
    }
    list
}

/// Cermin `validateKodePrefixes`. Dipakai saat menyimpan, jadi entri rusak
/// ditolak dengan pesan, bukan dibuang diam-diam.
pub fn validate_kode_prefixes(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.is_empty() {
        return Err("Daftarkan minimal satu awalan kode.".into());
    }
    if raw.len() > MAKS_KODE_PREFIX {
        return Err("Awalan kode maksimal 20.".into());
    }
    let mut list: Vec<String> = Vec::new();
    for item in raw {
        let prefix = normalize_kode_prefix(item).ok_or_else(|| {
            format!(
                "Awalan \"{}\" tidak valid. Gunakan 1 sampai 6 huruf atau angka.",
                item.trim()
            )
        })?;
        if list.contains(&prefix) {
            return Err(format!("Awalan \"{prefix}\" terdaftar dua kali."));
        }
        list.push(prefix);
    }
    Ok(list)
}

/// Nomor urut berikutnya untuk sebuah awalan: nomor terbesar + 1. Hanya kode
/// berbentuk `AWALAN-angka` yang dihitung, jadi kode manual seperti
/// `UKS-LEMARI` tidak mengganggu urutan. Cermin `nomorKodeBerikutnya`.
pub fn next_kode_number(prefix: &str, existing: &[String]) -> u64 {
    let head = format!("{prefix}-");
    existing
        .iter()
        .filter_map(|kode| {
            let upper = kode.trim().to_ascii_uppercase();
            let nomor = upper.strip_prefix(&head)?;
            (!nomor.is_empty() && nomor.len() <= 9 && nomor.bytes().all(|b| b.is_ascii_digit()))
                .then(|| nomor.parse::<u64>().ok())
                .flatten()
        })
        .max()
        .unwrap_or(0)
        + 1
}

/// Cermin `formatKodeBarang`: `UKS-0001`.
pub fn format_kode_barang(prefix: &str, nomor: u64) -> String {
    format!("{prefix}-{nomor:0>4}")
}

pub fn alasan_sah_untuk(jenis: &str) -> &'static [&'static str] {
    match jenis {
        "Masuk" => &[
            "Saldo Awal",
            "Pengadaan",
            "Hibah",
            "Pengembalian",
            "Selisih Opname",
            "Pembatalan",
        ],
        "Keluar" => &[
            "Pemakaian",
            "Peminjaman",
            "Rusak/Afkir",
            "Hilang",
            "Kedaluwarsa",
            "Selisih Opname",
            "Pembatalan",
        ],
        "Pindah" => &["Distribusi", "Perubahan Kondisi", "Pembatalan"],
        _ => &[],
    }
}

/// Spasi di awal/akhir dibuang dan spasi ganda dirapatkan. Cermin `normalizeTempat`.
pub fn normalize_tempat(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Huruf kecil ASCII saja, sama dengan `LOWER()` milik SQLite. Memakai
/// `to_lowercase()` Unicode akan membuat aplikasi menganggap dua tempat sama
/// sementara view saldo menganggapnya berbeda.
pub fn ascii_lower(value: &str) -> String {
    value.to_ascii_lowercase()
}

pub fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &value[range];
        if part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    if year < 1900 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=max_day).contains(&day)
}

fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn clean_tempat(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(normalize_tempat)
        .filter(|text| !text.is_empty())
}

fn too_long(value: &Option<String>, max: usize) -> bool {
    value
        .as_deref()
        .is_some_and(|text| text.chars().count() > max)
}

// ── Barang ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarangDraft {
    #[serde(default)]
    pub id_barang: Option<String>,
    #[serde(default)]
    pub kode_barang: Option<String>,
    /// Awalan untuk kode otomatis bila `kode_barang` kosong. Kosong = awalan
    /// pertama di daftar.
    #[serde(default)]
    pub kode_prefix: Option<String>,
    #[serde(default)]
    pub nama_barang: String,
    #[serde(default)]
    pub kategori: Option<String>,
    #[serde(default)]
    pub tipe: String,
    #[serde(default)]
    pub satuan: String,
    #[serde(default)]
    pub bisa_expired: bool,
    #[serde(default)]
    pub stok_minimum: i64,
    #[serde(default)]
    pub tempat_utama: Option<String>,
    #[serde(default)]
    pub catatan: Option<String>,
    #[serde(default = "default_true")]
    pub status_aktif: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, PartialEq)]
pub struct BarangValid {
    pub kode_barang: Option<String>,
    pub nama_barang: String,
    pub kategori: Option<String>,
    pub tipe: String,
    pub satuan: String,
    pub bisa_expired: bool,
    pub stok_minimum: i64,
    pub tempat_utama: Option<String>,
    pub catatan: Option<String>,
    pub status_aktif: bool,
}

/// Cermin `validateBarang` di `validations/inventory.ts`.
pub fn validate_barang(draft: &BarangDraft) -> Result<BarangValid, String> {
    let kode_barang = clean(&draft.kode_barang);
    if too_long(&kode_barang, 30) {
        return Err("Kode barang maksimal 30 karakter.".into());
    }
    let nama_barang = draft.nama_barang.trim().to_owned();
    if nama_barang.is_empty() {
        return Err("Nama barang wajib diisi.".into());
    }
    if nama_barang.chars().count() > 120 {
        return Err("Nama barang maksimal 120 karakter.".into());
    }
    let kategori = clean_tempat(&draft.kategori);
    if too_long(&kategori, 60) {
        return Err("Kategori maksimal 60 karakter.".into());
    }
    if !TIPE_BARANG.contains(&draft.tipe.as_str()) {
        return Err("Tipe barang tidak dikenal.".into());
    }
    let satuan = draft.satuan.trim().to_owned();
    if satuan.is_empty() {
        return Err("Satuan wajib diisi.".into());
    }
    if satuan.chars().count() > 20 {
        return Err("Satuan maksimal 20 karakter.".into());
    }
    if !(0..=MAKS_JUMLAH).contains(&draft.stok_minimum) {
        return Err("Stok minimum tidak valid.".into());
    }
    let tempat_utama = clean_tempat(&draft.tempat_utama);
    if too_long(&tempat_utama, MAKS_PANJANG_TEMPAT) {
        return Err("Nama tempat maksimal 80 karakter.".into());
    }
    let catatan = clean(&draft.catatan);
    if too_long(&catatan, 500) {
        return Err("Catatan maksimal 500 karakter.".into());
    }
    Ok(BarangValid {
        kode_barang,
        nama_barang,
        kategori,
        tipe: draft.tipe.clone(),
        satuan,
        bisa_expired: draft.bisa_expired,
        stok_minimum: draft.stok_minimum,
        tempat_utama,
        catatan,
        status_aktif: draft.status_aktif,
    })
}

// ── Mutasi ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutasiDraft {
    #[serde(default)]
    pub id_barang: String,
    #[serde(default)]
    pub jenis: String,
    #[serde(default)]
    pub alasan: String,
    #[serde(default)]
    pub tanggal: Option<String>,
    #[serde(default)]
    pub jumlah: i64,
    #[serde(default)]
    pub tempat_asal: Option<String>,
    #[serde(default)]
    pub kondisi_asal: Option<String>,
    #[serde(default)]
    pub tempat_tujuan: Option<String>,
    #[serde(default)]
    pub kondisi_tujuan: Option<String>,
    #[serde(default)]
    pub id_batch: Option<String>,
    #[serde(default)]
    pub tanggal_expired: Option<String>,
    /// Pengembalian: id mutasi Peminjaman yang dikembalikan.
    #[serde(default)]
    pub id_ref: Option<String>,
    #[serde(default)]
    pub penerima_tipe: Option<String>,
    #[serde(default)]
    pub penerima_id: Option<String>,
    #[serde(default)]
    pub penerima_nama: Option<String>,
    #[serde(default)]
    pub keperluan: Option<String>,
    #[serde(default)]
    pub sumber_dana: Option<String>,
    #[serde(default)]
    pub nomor_dokumen: Option<String>,
    #[serde(default)]
    pub harga_satuan: Option<i64>,
    #[serde(default)]
    pub catatan: Option<String>,
    /// Barang yang dicatat per unit: unit yang dikeluarkan atau dipindah.
    #[serde(default)]
    pub unit: Vec<String>,
    /// Barang Masuk pertama yang memulai pencatatan per unit.
    #[serde(default)]
    pub per_unit: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct BarangInfo<'a> {
    pub tipe: &'a str,
    pub bisa_expired: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MutasiValid {
    pub jenis: String,
    pub alasan: String,
    pub tanggal: String,
    pub jumlah: i64,
    pub tempat_asal: Option<String>,
    pub kondisi_asal: Option<String>,
    pub tempat_tujuan: Option<String>,
    pub kondisi_tujuan: Option<String>,
    pub id_batch: Option<String>,
    pub tanggal_expired: Option<String>,
    pub id_ref: Option<String>,
    pub penerima_tipe: Option<String>,
    pub penerima_id: Option<String>,
    pub penerima_nama: Option<String>,
    pub keperluan: Option<String>,
    pub sumber_dana: Option<String>,
    pub nomor_dokumen: Option<String>,
    pub harga_satuan: Option<i64>,
    pub catatan: Option<String>,
}

fn kondisi_for(barang: BarangInfo<'_>, raw: &Option<String>) -> Result<String, String> {
    if barang.tipe == "Habis Pakai" {
        return Ok("Baik".into());
    }
    match clean(raw) {
        None => Ok("Baik".into()),
        Some(value) if KONDISI_BARANG.contains(&value.as_str()) => Ok(value),
        Some(_) => Err("Kondisi barang tidak dikenal.".into()),
    }
}

/// Cermin `validateMutasi` di `validations/inventory.ts`. Murni: pemeriksaan
/// yang butuh database (saldo, batch, nama penerima) ada di `record_mutation`.
pub fn validate_mutation(
    draft: &MutasiDraft,
    barang: BarangInfo<'_>,
    hari_ini: &str,
) -> Result<MutasiValid, String> {
    let jenis = draft.jenis.as_str();
    if !JENIS_MUTASI.contains(&jenis) {
        return Err("Jenis mutasi tidak dikenal.".into());
    }
    if !alasan_sah_untuk(jenis).contains(&draft.alasan.as_str()) {
        return Err("Alasan tidak berlaku untuk jenis mutasi ini.".into());
    }
    if !(1..=MAKS_JUMLAH).contains(&draft.jumlah) {
        return Err("Jumlah harus bilangan bulat 1 sampai 1.000.000.".into());
    }
    let tanggal = clean(&draft.tanggal).unwrap_or_else(|| hari_ini.to_owned());
    if !is_valid_date(&tanggal) {
        return Err("Tanggal tidak valid.".into());
    }
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal tidak boleh melewati hari ini.".into());
    }

    let mut valid = MutasiValid {
        jenis: jenis.to_owned(),
        alasan: draft.alasan.clone(),
        tanggal,
        jumlah: draft.jumlah,
        ..MutasiValid::default()
    };

    if jenis == "Keluar" || jenis == "Pindah" {
        let tempat = clean_tempat(&draft.tempat_asal)
            .ok_or_else(|| "Tempat asal wajib diisi.".to_owned())?;
        if tempat.chars().count() > MAKS_PANJANG_TEMPAT {
            return Err("Nama tempat maksimal 80 karakter.".into());
        }
        valid.tempat_asal = Some(tempat);
        valid.kondisi_asal = Some(kondisi_for(barang, &draft.kondisi_asal)?);
    }
    if jenis == "Masuk" || jenis == "Pindah" {
        let tempat = clean_tempat(&draft.tempat_tujuan)
            .ok_or_else(|| "Tempat tujuan wajib diisi.".to_owned())?;
        if tempat.chars().count() > MAKS_PANJANG_TEMPAT {
            return Err("Nama tempat maksimal 80 karakter.".into());
        }
        valid.tempat_tujuan = Some(tempat);
        valid.kondisi_tujuan = Some(kondisi_for(barang, &draft.kondisi_tujuan)?);
    }
    if jenis == "Pindah"
        && valid.tempat_asal.as_deref().map(ascii_lower)
            == valid.tempat_tujuan.as_deref().map(ascii_lower)
        && valid.kondisi_asal == valid.kondisi_tujuan
    {
        return Err("Tempat atau kondisi tujuan harus berbeda dari asal.".into());
    }

    if valid.alasan == "Pengembalian" {
        valid.id_ref = Some(
            clean(&draft.id_ref).ok_or_else(|| "Pilih peminjaman yang dikembalikan.".to_owned())?,
        );
    }

    if barang.bisa_expired {
        match (jenis, valid.alasan.as_str()) {
            // Barang pinjaman kembali ke batch asalnya, yang diambil dari
            // mutasi Peminjaman di `record_mutation`, bukan dari payload.
            ("Masuk", "Pengembalian") => {}
            ("Masuk", "Selisih Opname") => {
                valid.id_batch = Some(
                    clean(&draft.id_batch)
                        .ok_or_else(|| "Pilih batch tujuan barang ini.".to_owned())?,
                );
            }
            ("Masuk", _) => {
                let expired = clean(&draft.tanggal_expired).ok_or_else(|| {
                    "Tanggal kedaluwarsa wajib diisi untuk barang ini.".to_owned()
                })?;
                if !is_valid_date(&expired) {
                    return Err("Tanggal kedaluwarsa tidak valid.".into());
                }
                valid.tanggal_expired = Some(expired);
            }
            _ => {
                valid.id_batch = Some(
                    clean(&draft.id_batch)
                        .ok_or_else(|| "Pilih batch barang yang dikeluarkan.".to_owned())?,
                );
            }
        }
    }

    if valid.alasan == "Pemakaian" || valid.alasan == "Peminjaman" {
        let tipe = clean(&draft.penerima_tipe).ok_or_else(|| "Pilih tipe penerima.".to_owned())?;
        if !PENERIMA_TIPE.contains(&tipe.as_str()) {
            return Err("Tipe penerima tidak dikenal.".into());
        }
        match tipe.as_str() {
            "Personil" => {
                valid.penerima_id =
                    Some(clean(&draft.penerima_id).ok_or_else(|| "Pilih penerima.".to_owned())?);
            }
            // Divisi tidak punya tabel master: namanya diambil dari
            // `master_data.divisi`, jadi disimpan seperti Unit tanpa id.
            "Unit" | "Divisi" => {
                let nama = clean_tempat(&draft.penerima_nama).ok_or_else(|| {
                    if tipe == "Divisi" {
                        "Pilih divisi penerima.".to_owned()
                    } else {
                        "Nama unit penerima wajib diisi.".to_owned()
                    }
                })?;
                if nama.chars().count() > MAKS_PANJANG_TEMPAT {
                    return Err("Nama unit penerima maksimal 80 karakter.".into());
                }
                valid.penerima_nama = Some(nama);
            }
            _ => {
                valid.penerima_nama = Some("Umum".into());
            }
        }
        valid.penerima_tipe = Some(tipe);
        if clean(&draft.keperluan).is_none() {
            return Err("Keperluan wajib diisi.".into());
        }
    }
    valid.keperluan = clean(&draft.keperluan);
    if too_long(&valid.keperluan, 200) {
        return Err("Keperluan maksimal 200 karakter.".into());
    }

    if jenis == "Masuk" {
        if let Some(harga) = draft.harga_satuan {
            if !(0..=MAKS_HARGA_SATUAN).contains(&harga) {
                return Err("Harga satuan tidak valid.".into());
            }
            valid.harga_satuan = Some(harga);
        }
        valid.sumber_dana = clean(&draft.sumber_dana);
        if too_long(&valid.sumber_dana, 60) {
            return Err("Sumber dana maksimal 60 karakter.".into());
        }
    }
    valid.nomor_dokumen = clean(&draft.nomor_dokumen);
    if too_long(&valid.nomor_dokumen, 60) {
        return Err("Nomor dokumen maksimal 60 karakter.".into());
    }
    valid.catatan = clean(&draft.catatan);
    if too_long(&valid.catatan, 500) {
        return Err("Catatan maksimal 500 karakter.".into());
    }
    Ok(valid)
}

/// Baris mutasi yang tersimpan, cukup untuk menyusun kebalikannya.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MutasiAsal {
    pub id_mutasi: String,
    pub jenis: String,
    pub alasan: String,
    pub jumlah: i64,
    pub tempat_asal: Option<String>,
    pub kondisi_asal: Option<String>,
    pub tempat_tujuan: Option<String>,
    pub kondisi_tujuan: Option<String>,
    pub id_batch: Option<String>,
}

pub fn cancellation_id(id_mutasi: &str) -> String {
    format!("batal-{id_mutasi}")
}

/// Kebalikan sebuah mutasi: asal dan tujuan ditukar, jumlah dan batch sama.
/// Id-nya diturunkan dari mutasi asal, sehingga dua perangkat offline yang
/// membatalkan mutasi yang sama menghasilkan PK yang sama dan pembatalan kedua
/// tidak berefek. Cermin `susunPembatalan`.
pub fn build_cancellation(asal: &MutasiAsal) -> Result<MutasiAsal, String> {
    if asal.alasan == "Pembatalan" {
        return Err("Pembatalan tidak bisa dibatalkan lagi.".into());
    }
    // Distribusi di luar Pindah hanya ditulis oleh `register_units`. Membatalkan
    // sisi Keluar-nya mengembalikan stok lama sementara unitnya tetap ada,
    // sehingga barang yang sama terhitung dua kali.
    if asal.alasan == "Distribusi" && asal.jenis != "Pindah" {
        return Err("Pendaftaran unit tidak bisa dibatalkan.".into());
    }
    let jenis = match asal.jenis.as_str() {
        "Masuk" => "Keluar",
        "Keluar" => "Masuk",
        "Pindah" => "Pindah",
        _ => return Err("Jenis mutasi tidak dikenal.".into()),
    };
    Ok(MutasiAsal {
        id_mutasi: cancellation_id(&asal.id_mutasi),
        jenis: jenis.into(),
        alasan: "Pembatalan".into(),
        jumlah: asal.jumlah,
        tempat_asal: asal.tempat_tujuan.clone(),
        kondisi_asal: asal.kondisi_tujuan.clone(),
        tempat_tujuan: asal.tempat_asal.clone(),
        kondisi_tujuan: asal.kondisi_asal.clone(),
        id_batch: asal.id_batch.clone(),
    })
}

// ── Unit (registri aset per unit, v37) ─────────────────────────────────────
//
// Satu unit = satu "batch" berjumlah 1: `id_unit` adalah `id_mutasi` baris
// Masuk pembukanya, persis seperti batch barang ber-expired. Karena itu rumus
// stok, pemeriksaan batch, pengembalian ke batch asal, dan pembatalan bekerja
// per unit tanpa perubahan. `inventory_unit` hanya menyimpan identitasnya;
// tempat dan kondisinya selalu diturunkan dari mutasi.

/// Cermin `MAKS_UNIT_SEKALI`.
pub const MAKS_UNIT_SEKALI: usize = 200;
/// Batas `register_units` dalam satu kali tekan.
pub const MAKS_UNIT_DAFTAR: i64 = 1000;

/// Cermin `formatKodeUnit`: `LAP-0003-02`.
pub fn format_kode_unit(kode_barang: &str, nomor: u64) -> String {
    format!("{kode_barang}-{nomor:02}")
}

pub struct AturanUnit<'a> {
    pub dilacak: bool,
    pub per_unit: bool,
    pub tipe: &'a str,
    pub bisa_expired: bool,
    pub jenis: &'a str,
    pub alasan: &'a str,
    pub jumlah: i64,
    pub unit: &'a [String],
}

/// Cermin `validasiUnit`. Mengembalikan daftar unit yang sudah dirapikan.
pub fn validate_unit_rules(aturan: &AturanUnit<'_>) -> Result<Vec<String>, String> {
    if aturan.per_unit
        && !aturan.dilacak
        && (aturan.tipe != "Aset"
            || aturan.bisa_expired
            || aturan.jenis != "Masuk"
            || aturan.alasan == "Pengembalian")
    {
        return Err(
            "Pencatatan per unit hanya untuk aset tanpa kedaluwarsa yang dicatat masuk.".into(),
        );
    }
    if !(aturan.dilacak || aturan.per_unit) {
        if !aturan.unit.is_empty() {
            return Err("Barang ini tidak dicatat per unit.".into());
        }
        return Ok(Vec::new());
    }
    if aturan.jenis == "Masuk" {
        if !aturan.unit.is_empty() {
            return Err("Unit baru dibuat otomatis saat barang masuk.".into());
        }
        if aturan.alasan != "Pengembalian" && aturan.jumlah > MAKS_UNIT_SEKALI as i64 {
            return Err("Paling banyak 200 unit sekali catat.".into());
        }
        return Ok(Vec::new());
    }
    let unit: Vec<String> = aturan
        .unit
        .iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    if unit.is_empty() {
        return Err("Pilih unit yang dicatat.".into());
    }
    if unit.len() > MAKS_UNIT_SEKALI {
        return Err("Paling banyak 200 unit sekali catat.".into());
    }
    if unit.iter().collect::<HashSet<_>>().len() != unit.len() {
        return Err("Unit yang sama dipilih dua kali.".into());
    }
    if unit.len() as i64 != aturan.jumlah {
        return Err("Jumlah harus sama dengan banyaknya unit yang dipilih.".into());
    }
    Ok(unit)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitDraft {
    #[serde(default)]
    pub id_unit: String,
    #[serde(default)]
    pub nomor_seri: Option<String>,
    #[serde(default)]
    pub catatan: Option<String>,
}

/// Cermin `validasiUnitEdit`: `(nomor_seri, catatan)`.
pub fn validate_unit_edit(draft: &UnitDraft) -> Result<(Option<String>, Option<String>), String> {
    let nomor_seri = clean(&draft.nomor_seri);
    if too_long(&nomor_seri, 60) {
        return Err("Nomor seri maksimal 60 karakter.".into());
    }
    let catatan = clean(&draft.catatan);
    if too_long(&catatan, 200) {
        return Err("Catatan unit maksimal 200 karakter.".into());
    }
    Ok((nomor_seri, catatan))
}

// ── I/O ─────────────────────────────────────────────────────────────────────

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new("VALIDATION_ERROR", message)
}

fn new_hex_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let mut id = String::with_capacity(prefix.len() + 32);
    id.push_str(prefix);
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

fn read_kode_prefixes(connection: &Connection) -> Result<Vec<String>, CommandError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = ?;",
            params![KODE_PREFIX_SETTING_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    Ok(parse_kode_prefixes(stored.as_deref()))
}

/// Kode otomatis bernomor urut per awalan (keputusan User). ponytail: nomor
/// urut dihitung dari data LOKAL, jadi dua perangkat offline bisa menerbitkan
/// nomor yang sama; tidak ada UNIQUE yang bisa mengunci outbox, dan kembarannya
/// ditandai `kode_ganda` di daftar barang supaya dibetulkan manual.
fn next_item_code(
    transaction: &Transaction<'_>,
    prefix: &str,
    id_barang: &str,
) -> Result<String, CommandError> {
    let mut statement = transaction
        .prepare("SELECT kode_barang FROM inventory_barang WHERE kode_barang LIKE ? || '-%';")
        .map_err(|_| CommandError::internal())?;
    let existing: Vec<String> = statement
        .query_map(params![prefix], |row| row.get(0))
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;
    let mut nomor = next_kode_number(prefix, &existing);
    let mut kode = format_kode_barang(prefix, nomor);
    while kode_dipakai(transaction, &kode, id_barang)? {
        nomor += 1;
        kode = format_kode_barang(prefix, nomor);
    }
    Ok(kode)
}

pub fn save_code_prefixes(
    state: &DesktopState,
    prefixes: Vec<String>,
) -> Result<Value, CommandError> {
    let list = validate_kode_prefixes(&prefixes).map_err(invalid)?;
    let value = serde_json::to_string(&list).map_err(|_| CommandError::internal())?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![KODE_PREFIX_SETTING_KEY, value],
        )
        .map_err(|_| CommandError::internal())?;
    // Event lama untuk kunci yang sama sudah usang; hanya nilai terakhir yang
    // perlu sampai ke cloud. Pola yang sama dengan template WhatsApp.
    transaction
        .execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ?1 AND status IN ('pending', 'failed', 'conflict');",
            params![KODE_PREFIX_SETTING_KEY],
        )
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        &transaction,
        &client_id,
        "setting",
        "update",
        KODE_PREFIX_SETTING_KEY,
        &json!({ "key": KODE_PREFIX_SETTING_KEY, "value": value }),
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "kode_prefix": list }))
}

fn wib_today(connection: &Connection) -> String {
    connection
        .query_row("SELECT date('now', '+7 hours');", [], |row| row.get(0))
        .unwrap_or_default()
}

/// Ejaan tempat yang sudah ada, bila ada yang sama tanpa memandang huruf
/// besar-kecil. "ruang tu" disimpan sebagai "Ruang TU" yang sudah dipakai.
fn canonical_tempat(connection: &Connection, tempat: &str) -> Result<String, CommandError> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT tempat FROM (
                SELECT tempat_tujuan AS tempat FROM inventory_mutasi WHERE tempat_tujuan IS NOT NULL
                UNION ALL
                SELECT tempat_utama FROM inventory_barang WHERE tempat_utama IS NOT NULL
             ) WHERE LOWER(tempat) = LOWER(?) LIMIT 1;",
            params![tempat],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    Ok(existing.unwrap_or_else(|| tempat.to_owned()))
}

fn canonical_option(
    connection: &Connection,
    value: Option<String>,
) -> Result<Option<String>, CommandError> {
    value
        .map(|tempat| canonical_tempat(connection, &tempat))
        .transpose()
}

fn barang_json(connection: &Connection, id_barang: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
                    stok_minimum, tempat_utama, catatan, status_aktif, created_at, updated_at
             FROM inventory_barang WHERE id_barang = ?;",
            params![id_barang],
            |row| {
                Ok(json!({
                    "id_barang": row.get::<_, String>(0)?,
                    "kode_barang": row.get::<_, String>(1)?,
                    "nama_barang": row.get::<_, String>(2)?,
                    "kategori": row.get::<_, Option<String>>(3)?,
                    "tipe": row.get::<_, String>(4)?,
                    "satuan": row.get::<_, String>(5)?,
                    "bisa_expired": row.get::<_, i64>(6)?,
                    "stok_minimum": row.get::<_, i64>(7)?,
                    "tempat_utama": row.get::<_, Option<String>>(8)?,
                    "catatan": row.get::<_, Option<String>>(9)?,
                    "status_aktif": row.get::<_, i64>(10)?,
                    "created_at": row.get::<_, String>(11)?,
                    "updated_at": row.get::<_, String>(12)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

fn mutasi_json(connection: &Connection, id_mutasi: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_mutasi, id_barang, jenis, alasan, tanggal, jumlah, tempat_asal, kondisi_asal,
                    tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, id_ref, penerima_tipe,
                    penerima_id, penerima_nama, keperluan, sumber_dana, nomor_dokumen,
                    harga_satuan, catatan, dicatat_oleh, created_at
             FROM inventory_mutasi WHERE id_mutasi = ?;",
            params![id_mutasi],
            |row| {
                Ok(json!({
                    "id_mutasi": row.get::<_, String>(0)?,
                    "id_barang": row.get::<_, String>(1)?,
                    "jenis": row.get::<_, String>(2)?,
                    "alasan": row.get::<_, String>(3)?,
                    "tanggal": row.get::<_, String>(4)?,
                    "jumlah": row.get::<_, i64>(5)?,
                    "tempat_asal": row.get::<_, Option<String>>(6)?,
                    "kondisi_asal": row.get::<_, Option<String>>(7)?,
                    "tempat_tujuan": row.get::<_, Option<String>>(8)?,
                    "kondisi_tujuan": row.get::<_, Option<String>>(9)?,
                    "id_batch": row.get::<_, Option<String>>(10)?,
                    "tanggal_expired": row.get::<_, Option<String>>(11)?,
                    "id_ref": row.get::<_, Option<String>>(12)?,
                    "penerima_tipe": row.get::<_, Option<String>>(13)?,
                    "penerima_id": row.get::<_, Option<String>>(14)?,
                    "penerima_nama": row.get::<_, Option<String>>(15)?,
                    "keperluan": row.get::<_, Option<String>>(16)?,
                    "sumber_dana": row.get::<_, Option<String>>(17)?,
                    "nomor_dokumen": row.get::<_, Option<String>>(18)?,
                    "harga_satuan": row.get::<_, Option<i64>>(19)?,
                    "catatan": row.get::<_, Option<String>>(20)?,
                    "dicatat_oleh": row.get::<_, String>(21)?,
                    "created_at": row.get::<_, String>(22)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

/// Saldo satu posisi stok. `id_batch IS ?` supaya posisi tanpa batch (NULL)
/// juga cocok.
fn saldo_posisi(
    connection: &Connection,
    id_barang: &str,
    tempat: &str,
    kondisi: &str,
    id_batch: Option<&str>,
) -> Result<i64, CommandError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(saldo), 0) FROM inventory_saldo
             WHERE id_barang = ? AND LOWER(tempat) = LOWER(?) AND kondisi = ? AND id_batch IS ?;",
            params![id_barang, tempat, kondisi, id_batch],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

pub fn list_inventory(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;

    let mut posisi_statement = connection
        .prepare(
            "SELECT s.id_barang, s.tempat, s.kondisi, s.id_batch, s.saldo, m.tanggal_expired,
                    CAST(julianday(m.tanggal_expired) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa_hari,
                    u.kode_unit, u.nomor_seri, u.catatan
             FROM inventory_saldo s
             LEFT JOIN inventory_mutasi m ON m.id_mutasi = s.id_batch
             LEFT JOIN inventory_unit u ON u.id_unit = s.id_batch
             WHERE s.saldo <> 0
             ORDER BY s.id_barang, m.tanggal_expired IS NULL, m.tanggal_expired, u.kode_unit, s.tempat
             -- batas: satu baris per posisi stok (barang × tempat × kondisi × batch) yang saldonya bukan nol
             ;",
        )
        .map_err(|_| CommandError::internal())?;
    let posisi: Vec<(String, Value, String, i64)> = posisi_statement
        .query_map([], |row| {
            let id_barang: String = row.get(0)?;
            let kondisi: String = row.get(2)?;
            let saldo: i64 = row.get(4)?;
            // Sisa hari dihitung SQLite dengan tanggal WIB, tidak dengan jam
            // perangkat: jam HP yang salah tidak boleh menyembunyikan obat
            // yang sudah kedaluwarsa.
            let sisa_hari: Option<i64> = row.get(6)?;
            Ok((
                id_barang,
                json!({
                    "tempat": row.get::<_, String>(1)?,
                    "kondisi": kondisi.clone(),
                    "id_batch": row.get::<_, Option<String>>(3)?,
                    "saldo": saldo,
                    "tanggal_expired": row.get::<_, Option<String>>(5)?,
                    "sisa_hari": sisa_hari,
                    "status_kedaluwarsa": sisa_hari.map(status_kedaluwarsa),
                    "kode_unit": row.get::<_, Option<String>>(7)?,
                    "nomor_seri": row.get::<_, Option<String>>(8)?,
                    "catatan_unit": row.get::<_, Option<String>>(9)?,
                }),
                kondisi,
                saldo,
            ))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;

    let dilacak: HashSet<String> = connection
        .prepare("SELECT DISTINCT id_barang FROM inventory_unit;")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<_, _>>()
        })
        .map_err(|_| CommandError::internal())?;

    let mut barang_statement = connection
        .prepare(
            "SELECT id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
                    stok_minimum, tempat_utama, catatan, status_aktif
             FROM inventory_barang
             ORDER BY status_aktif DESC, nama_barang COLLATE NOCASE;",
        )
        .map_err(|_| CommandError::internal())?;
    let barang: Vec<Value> = barang_statement
        .query_map([], |row| {
            let id_barang: String = row.get(0)?;
            Ok((
                id_barang.clone(),
                json!({
                    "id_barang": id_barang,
                    "kode_barang": row.get::<_, String>(1)?,
                    "nama_barang": row.get::<_, String>(2)?,
                    "kategori": row.get::<_, Option<String>>(3)?,
                    "tipe": row.get::<_, String>(4)?,
                    "satuan": row.get::<_, String>(5)?,
                    "bisa_expired": row.get::<_, i64>(6)? == 1,
                    "stok_minimum": row.get::<_, i64>(7)?,
                    "tempat_utama": row.get::<_, Option<String>>(8)?,
                    "catatan": row.get::<_, Option<String>>(9)?,
                    "status_aktif": row.get::<_, i64>(10)? == 1,
                }),
            ))
        })
        .map_err(|_| CommandError::internal())?
        .map(|row| {
            row.map(|(id_barang, mut item)| {
                let mine: Vec<&(String, Value, String, i64)> =
                    posisi.iter().filter(|entry| entry.0 == id_barang).collect();
                let stok_baik = mine
                    .iter()
                    .filter(|entry| entry.2 == "Baik")
                    .map(|entry| entry.3)
                    .sum::<i64>();
                let stok_minimum = item["stok_minimum"].as_i64().unwrap_or(0);
                item["stok_total"] = json!(mine.iter().map(|entry| entry.3).sum::<i64>());
                item["stok_baik"] = json!(stok_baik);
                item["stok_menipis"] = json!(stok_menipis(stok_baik, stok_minimum));
                item["posisi"] = Value::Array(mine.iter().map(|entry| entry.1.clone()).collect());
                item["dilacak_unit"] = json!(dilacak.contains(&id_barang));
                item
            })
        })
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;

    let mut tempat_statement = connection
        .prepare(
            "SELECT tempat FROM inventory_saldo WHERE saldo <> 0
             UNION
             SELECT tempat_utama FROM inventory_barang
             WHERE tempat_utama IS NOT NULL AND status_aktif = 1
             ORDER BY 1 COLLATE NOCASE;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut tempat: Vec<String> = Vec::new();
    for value in tempat_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| CommandError::internal())?
    {
        let value = value.map_err(|_| CommandError::internal())?;
        if !tempat
            .iter()
            .any(|known| ascii_lower(known) == ascii_lower(&value))
        {
            tempat.push(value);
        }
    }

    let mut kategori_statement = connection
        .prepare(
            "SELECT DISTINCT kategori FROM inventory_barang
             WHERE kategori IS NOT NULL ORDER BY kategori COLLATE NOCASE;",
        )
        .map_err(|_| CommandError::internal())?;
    let kategori: Vec<String> = kategori_statement
        .query_map([], |row| row.get(0))
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;

    // Dua perangkat offline bisa menerbitkan nomor urut yang sama. Tanpa UNIQUE
    // di DB, kembarannya hanya bisa terlihat di sini. Huruf besar-kecil
    // diabaikan, sama dengan pengecekan `kode_dipakai`.
    let mut barang = barang;
    let kode: Vec<String> = barang
        .iter()
        .map(|item| ascii_lower(item["kode_barang"].as_str().unwrap_or_default()))
        .collect();
    for (index, item) in barang.iter_mut().enumerate() {
        let ganda = kode.iter().filter(|other| **other == kode[index]).count() > 1;
        item["kode_ganda"] = json!(ganda);
    }

    Ok(json!({
        "barang": barang,
        "tempat": tempat,
        "kategori": kategori,
        "kode_prefix": read_kode_prefixes(&connection)?,
        "hari_ini": wib_today(&connection),
        // Untuk label QR: profil perusahaan biasa menuntut `settings.manage`.
        "nama_perusahaan": kop_perusahaan(&connection)?["nama"].clone(),
    }))
}

/// Penerima yang bisa dipilih: personil aktif beserta divisinya, dan daftar
/// divisi dari personil aktif. Dibaca di sini, bukan lewat gateway personil,
/// supaya petugas gudang tidak perlu izin `employees.view` hanya untuk
/// mencatat barang keluar.
pub fn list_recipients(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut personil_statement = connection
        .prepare(
            "SELECT id_unik, nama, jenis_personil, divisi
             FROM master_data
             WHERE status_aktif = 'Aktif'
             ORDER BY nama COLLATE NOCASE;",
        )
        .map_err(|_| CommandError::internal())?;
    let personil: Vec<Value> = personil_statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "nama": row.get::<_, String>(1)?,
                "jenis": row.get::<_, Option<String>>(2)?,
                "divisi": row.get::<_, Option<String>>(3)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;

    let mut divisi_statement = connection
        .prepare(
            "SELECT MIN(TRIM(divisi)) FROM master_data
             WHERE status_aktif = 'Aktif' AND TRIM(COALESCE(divisi, '')) <> ''
             GROUP BY LOWER(TRIM(divisi))
             ORDER BY 1 COLLATE NOCASE;",
        )
        .map_err(|_| CommandError::internal())?;
    let divisi: Vec<String> = divisi_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;

    Ok(json!({ "personil": personil, "divisi": divisi }))
}

pub fn save_item(state: &DesktopState, draft: Value) -> Result<Value, CommandError> {
    let draft: BarangDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data barang tidak valid."))?;
    let valid = validate_barang(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;

    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let requested_id = clean(&draft.id_barang);
    let existing: Option<(String, i64)> = match requested_id.as_deref() {
        Some(id) => Some(
            transaction
                .query_row(
                    "SELECT satuan, bisa_expired FROM inventory_barang WHERE id_barang = ?;",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| CommandError::internal())?
                .ok_or_else(|| invalid("Barang tidak ditemukan."))?,
        ),
        None => None,
    };
    let id_barang = requested_id.unwrap_or_else(|| new_hex_id("brg-"));

    if let Some((satuan_lama, expired_lama)) = existing {
        let berubah = satuan_lama != valid.satuan || (expired_lama == 1) != valid.bisa_expired;
        if berubah {
            let punya_mutasi: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_barang = ? LIMIT 1);",
                    params![id_barang],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            if punya_mutasi {
                return Err(invalid(
                    "Satuan dan pengaturan kedaluwarsa tidak bisa diubah setelah barang punya riwayat mutasi.",
                ));
            }
        }
    }

    let kode_barang = match valid.kode_barang.clone() {
        Some(kode) => {
            if kode_dipakai(&transaction, &kode, &id_barang)? {
                return Err(invalid("Kode barang sudah dipakai barang lain."));
            }
            kode
        }
        None => {
            let prefixes = read_kode_prefixes(&transaction)?;
            let prefix = match clean(&draft.kode_prefix) {
                Some(raw) => normalize_kode_prefix(&raw)
                    .filter(|prefix| prefixes.contains(prefix))
                    .ok_or_else(|| invalid("Awalan kode tidak terdaftar."))?,
                None => prefixes[0].clone(),
            };
            next_item_code(&transaction, &prefix, &id_barang)?
        }
    };
    let tempat_utama = canonical_option(&transaction, valid.tempat_utama.clone())?;

    transaction
        .execute(
            "INSERT INTO inventory_barang (
                id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
                stok_minimum, tempat_utama, catatan, status_aktif, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_barang) DO UPDATE SET
                kode_barang = excluded.kode_barang,
                nama_barang = excluded.nama_barang,
                kategori = excluded.kategori,
                tipe = excluded.tipe,
                satuan = excluded.satuan,
                bisa_expired = excluded.bisa_expired,
                stok_minimum = excluded.stok_minimum,
                tempat_utama = excluded.tempat_utama,
                catatan = excluded.catatan,
                status_aktif = excluded.status_aktif,
                updated_at = excluded.updated_at;",
            params![
                id_barang,
                kode_barang,
                valid.nama_barang,
                valid.kategori,
                valid.tipe,
                valid.satuan,
                valid.bisa_expired as i64,
                valid.stok_minimum,
                tempat_utama,
                valid.catatan,
                valid.status_aktif as i64,
            ],
        )
        .map_err(|_| CommandError::internal())?;

    let payload = barang_json(&transaction, &id_barang)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-item",
        "save",
        &id_barang,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_barang": id_barang, "kode_barang": kode_barang }))
}

fn kode_dipakai(
    transaction: &Transaction<'_>,
    kode: &str,
    id_barang: &str,
) -> Result<bool, CommandError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_barang
                           WHERE LOWER(kode_barang) = LOWER(?) AND id_barang <> ?);",
            params![kode, id_barang],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

struct Pinjaman {
    jumlah: i64,
    id_batch: Option<String>,
    penerima_tipe: Option<String>,
    penerima_id: Option<String>,
    penerima_nama: Option<String>,
}

fn load_pinjaman(
    connection: &Connection,
    id_pinjam: &str,
    id_barang: &str,
) -> Result<Pinjaman, CommandError> {
    let pinjaman = connection
        .query_row(
            "SELECT jumlah, id_batch, penerima_tipe, penerima_id, penerima_nama
             FROM inventory_mutasi
             WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Keluar' AND alasan = 'Peminjaman';",
            params![id_pinjam, id_barang],
            |row| {
                Ok(Pinjaman {
                    jumlah: row.get(0)?,
                    id_batch: row.get(1)?,
                    penerima_tipe: row.get(2)?,
                    penerima_id: row.get(3)?,
                    penerima_nama: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Peminjaman tidak ditemukan."))?;
    let dibatalkan: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?);",
            params![cancellation_id(id_pinjam)],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if dibatalkan {
        return Err(invalid("Peminjaman ini sudah dibatalkan."));
    }
    Ok(pinjaman)
}

/// Jumlah yang sudah kembali untuk satu peminjaman, tanpa pengembalian yang
/// dibatalkan. Cermin `jumlahKembali` di service Web.
fn jumlah_kembali(connection: &Connection, id_pinjam: &str) -> Result<i64, CommandError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(r.jumlah), 0) FROM inventory_mutasi r
             WHERE r.id_ref = ? AND r.alasan = 'Pengembalian'
               AND NOT EXISTS (SELECT 1 FROM inventory_mutasi b WHERE b.id_mutasi = 'batal-' || r.id_mutasi);",
            params![id_pinjam],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

fn insert_mutasi(
    transaction: &Transaction<'_>,
    id_mutasi: &str,
    id_barang: &str,
    valid: &MutasiValid,
    id_ref: Option<&str>,
    dicatat_oleh: &str,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "INSERT INTO inventory_mutasi (
                id_mutasi, id_barang, jenis, alasan, tanggal, jumlah, tempat_asal, kondisi_asal,
                tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, id_ref, penerima_tipe,
                penerima_id, penerima_nama, keperluan, sumber_dana, nomor_dokumen, harga_satuan,
                catatan, dicatat_oleh, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));",
            params![
                id_mutasi,
                id_barang,
                valid.jenis,
                valid.alasan,
                valid.tanggal,
                valid.jumlah,
                valid.tempat_asal,
                valid.kondisi_asal,
                valid.tempat_tujuan,
                valid.kondisi_tujuan,
                valid.id_batch,
                valid.tanggal_expired,
                id_ref,
                valid.penerima_tipe,
                valid.penerima_id,
                valid.penerima_nama,
                valid.keperluan,
                valid.sumber_dana,
                valid.nomor_dokumen,
                valid.harga_satuan,
                valid.catatan,
                dicatat_oleh,
            ],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

fn assert_saldo_cukup(
    transaction: &Transaction<'_>,
    id_barang: &str,
    satuan: &str,
    tempat: &str,
    kondisi: &str,
    id_batch: Option<&str>,
    jumlah: i64,
) -> Result<(), CommandError> {
    let saldo = saldo_posisi(transaction, id_barang, tempat, kondisi, id_batch)?;
    if saldo < jumlah {
        return Err(invalid(format!(
            "Stok di {tempat} ({kondisi}) hanya {} {satuan}.",
            saldo.max(0)
        )));
    }
    Ok(())
}

pub fn record_mutation(
    state: &DesktopState,
    dicatat_oleh: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: MutasiDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data mutasi tidak valid."))?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let id_mutasi = record_mutation_tx(&transaction, &client_id, dicatat_oleh, &draft, None)?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_mutasi": id_mutasi }))
}

/// Inti `record_mutation` di dalam transaksi milik pemanggil, supaya modul
/// lain bisa menulis mutasi dan barisnya sendiri secara atomik.
/// `id_ref` menautkan mutasi ke catatan asalnya (saat ini selalu `None`);
/// untuk Pengembalian nilainya tetap datang dari draft.
pub(crate) fn record_mutation_tx(
    transaction: &Transaction<'_>,
    client_id: &str,
    dicatat_oleh: &str,
    draft: &MutasiDraft,
    id_ref: Option<&str>,
) -> Result<String, CommandError> {
    let id_barang = draft.id_barang.trim().to_owned();
    let (tipe, bisa_expired): (String, i64) = transaction
        .query_row(
            "SELECT tipe, bisa_expired FROM inventory_barang WHERE id_barang = ?;",
            params![id_barang],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Barang tidak ditemukan."))?;
    let dilacak = barang_dilacak(transaction, &id_barang)?;
    let unit = validate_unit_rules(&AturanUnit {
        dilacak,
        per_unit: draft.per_unit,
        tipe: &tipe,
        bisa_expired: bisa_expired == 1,
        jenis: &draft.jenis,
        alasan: &draft.alasan,
        jumlah: draft.jumlah,
        unit: &draft.unit,
    })
    .map_err(invalid)?;
    // Pengembalian unit membawa batch (= unit) dari peminjamannya sendiri.
    if !(dilacak || draft.per_unit) || draft.alasan == "Pengembalian" {
        return record_satu(transaction, client_id, dicatat_oleh, draft, id_ref, None, false);
    }

    // Beberapa unit dalam satu aksi berbagi satu nomor dokumen supaya berita
    // acaranya memuat semuanya.
    let mut satu = draft.clone();
    satu.jumlah = 1;
    satu.unit = Vec::new();
    satu.per_unit = false;
    if clean(&satu.nomor_dokumen).is_none() && draft.jumlah > 1 {
        satu.nomor_dokumen = Some(nomor_dokumen_unit(transaction));
    }
    let mut pertama: Option<String> = None;
    if draft.jenis == "Masuk" {
        for _ in 0..draft.jumlah {
            let id = record_satu(transaction, client_id, dicatat_oleh, &satu, id_ref, None, true)?;
            buat_unit(transaction, client_id, &id_barang, &id)?;
            pertama.get_or_insert(id);
        }
    } else {
        for id_unit in &unit {
            let milik: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_unit = ? AND id_barang = ?);",
                    params![id_unit, id_barang],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            if !milik {
                return Err(invalid("Unit tidak ditemukan."));
            }
            let id = record_satu(
                transaction,
                client_id,
                dicatat_oleh,
                &satu,
                id_ref,
                Some(id_unit),
                false,
            )?;
            pertama.get_or_insert(id);
        }
    }
    pertama.ok_or_else(CommandError::internal)
}

fn barang_dilacak(connection: &Connection, id_barang: &str) -> Result<bool, CommandError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_barang = ?);",
            params![id_barang],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())
}

fn nomor_dokumen_unit(connection: &Connection) -> String {
    let acak: String = new_hex_id("").chars().take(4).collect();
    format!(
        "UNT-{}-{}",
        wib_today(connection).replace('-', ""),
        acak.to_ascii_uppercase()
    )
}

fn unit_json(connection: &Connection, id_unit: &str) -> Result<Option<Value>, CommandError> {
    connection
        .query_row(
            "SELECT id_unit, id_barang, kode_unit, nomor_seri, catatan, created_at, updated_at
             FROM inventory_unit WHERE id_unit = ?;",
            params![id_unit],
            |row| {
                Ok(json!({
                    "id_unit": row.get::<_, String>(0)?,
                    "id_barang": row.get::<_, String>(1)?,
                    "kode_unit": row.get::<_, String>(2)?,
                    "nomor_seri": row.get::<_, Option<String>>(3)?,
                    "catatan": row.get::<_, Option<String>>(4)?,
                    "created_at": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

/// Nomor urut dihitung dari unit lokal, jadi dua perangkat offline bisa
/// menerbitkan kode kembar; sama dengan kode barang, kembarannya tidak ditolak.
fn buat_unit(
    transaction: &Transaction<'_>,
    client_id: &str,
    id_barang: &str,
    id_unit: &str,
) -> Result<(), CommandError> {
    let (kode_barang, jumlah): (String, i64) = transaction
        .query_row(
            "SELECT b.kode_barang, (SELECT COUNT(*) FROM inventory_unit u WHERE u.id_barang = b.id_barang)
             FROM inventory_barang b WHERE b.id_barang = ?;",
            params![id_barang],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| CommandError::internal())?;
    transaction
        .execute(
            "INSERT INTO inventory_unit (id_unit, id_barang, kode_unit, created_at, updated_at)
             VALUES (?, ?, ?, datetime('now'), datetime('now'));",
            params![id_unit, id_barang, format_kode_unit(&kode_barang, (jumlah + 1) as u64)],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = unit_json(transaction, id_unit)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(transaction, client_id, "inventory-unit", "save", id_unit, &payload, None)?;
    Ok(())
}

fn enqueue_mutasi(
    transaction: &Transaction<'_>,
    client_id: &str,
    id_mutasi: &str,
) -> Result<(), CommandError> {
    let payload = mutasi_json(transaction, id_mutasi)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        transaction,
        client_id,
        "inventory-mutation",
        "create",
        id_mutasi,
        &payload,
        None,
    )?;
    Ok(())
}

/// Memindahkan stok aset yang belum bernomor menjadi unit: satu baris Keluar
/// per posisi dan satu baris Masuk per unit, keduanya beralasan Distribusi di
/// tempat dan kondisi yang sama, sehingga jumlahnya tidak berubah. Alasan
/// baru sengaja tidak dipakai: CHECK `alasan` di perangkat yang belum
/// diperbarui akan menolak barisnya saat menarik data.
pub fn register_units(
    state: &DesktopState,
    dicatat_oleh: &str,
    id_barang: &str,
) -> Result<Value, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let id_barang = id_barang.trim();
    let (tipe, bisa_expired, status_aktif): (String, i64, i64) = transaction
        .query_row(
            "SELECT tipe, bisa_expired, status_aktif FROM inventory_barang WHERE id_barang = ?;",
            params![id_barang],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Barang tidak ditemukan."))?;
    if tipe != "Aset" || bisa_expired == 1 {
        return Err(invalid(
            "Hanya aset tanpa kedaluwarsa yang bisa dicatat per unit.",
        ));
    }
    if status_aktif != 1 {
        return Err(invalid("Barang sudah dinonaktifkan."));
    }
    let posisi: Vec<(String, String, i64)> = transaction
        .prepare(
            "SELECT tempat, kondisi, saldo FROM inventory_saldo
             WHERE id_barang = ? AND id_batch IS NULL AND saldo > 0
             ORDER BY tempat, kondisi;",
        )
        .and_then(|mut statement| {
            statement
                .query_map(params![id_barang], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<Result<_, _>>()
        })
        .map_err(|_| CommandError::internal())?;
    let total: i64 = posisi.iter().map(|entry| entry.2).sum();
    if total == 0 {
        return Err(invalid("Tidak ada stok yang belum terdaftar sebagai unit."));
    }
    if total > MAKS_UNIT_DAFTAR {
        return Err(invalid(
            "Stok terlalu banyak untuk didaftarkan sekaligus (maksimal 1000 unit).",
        ));
    }

    let tanggal = wib_today(&transaction);
    let nomor = nomor_dokumen_unit(&transaction);
    for (tempat, kondisi, saldo) in posisi {
        let keluar = MutasiValid {
            jenis: "Keluar".into(),
            alasan: "Distribusi".into(),
            tanggal: tanggal.clone(),
            jumlah: saldo,
            tempat_asal: Some(tempat.clone()),
            kondisi_asal: Some(kondisi.clone()),
            nomor_dokumen: Some(nomor.clone()),
            catatan: Some("Pendaftaran unit".into()),
            ..MutasiValid::default()
        };
        let id_keluar = new_hex_id("mts-");
        insert_mutasi(&transaction, &id_keluar, id_barang, &keluar, None, dicatat_oleh)?;
        enqueue_mutasi(&transaction, &client_id, &id_keluar)?;
        for _ in 0..saldo {
            let id_unit = new_hex_id("mts-");
            let masuk = MutasiValid {
                jenis: "Masuk".into(),
                alasan: "Distribusi".into(),
                tanggal: tanggal.clone(),
                jumlah: 1,
                tempat_tujuan: Some(tempat.clone()),
                kondisi_tujuan: Some(kondisi.clone()),
                id_batch: Some(id_unit.clone()),
                nomor_dokumen: Some(nomor.clone()),
                catatan: Some("Pendaftaran unit".into()),
                ..MutasiValid::default()
            };
            insert_mutasi(&transaction, &id_unit, id_barang, &masuk, None, dicatat_oleh)?;
            enqueue_mutasi(&transaction, &client_id, &id_unit)?;
            buat_unit(&transaction, &client_id, id_barang, &id_unit)?;
        }
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "jumlah": total, "nomor_dokumen": nomor }))
}

/// Menyunting nomor seri dan catatan sebuah unit. Kode unit tidak bisa diubah:
/// ia tercetak di label yang sudah ditempel.
pub fn save_unit(state: &DesktopState, draft: Value) -> Result<Value, CommandError> {
    let draft: UnitDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data unit tidak valid."))?;
    let (nomor_seri, catatan) = validate_unit_edit(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let id_unit = draft.id_unit.trim();
    let diubah = transaction
        .execute(
            "UPDATE inventory_unit SET nomor_seri = ?, catatan = ?, updated_at = datetime('now')
             WHERE id_unit = ?;",
            params![nomor_seri, catatan, id_unit],
        )
        .map_err(|_| CommandError::internal())?;
    if diubah == 0 {
        return Err(invalid("Unit tidak ditemukan."));
    }
    let payload = unit_json(&transaction, id_unit)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(&transaction, &client_id, "inventory-unit", "save", id_unit, &payload, None)?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// Inti satu baris mutasi. `unit` menimpa batch dengan unit yang dipilih;
/// `jadikan_batch` membuat baris Masuk menjadi batch/unit-nya sendiri.
#[allow(clippy::too_many_arguments)]
fn record_satu(
    transaction: &Transaction<'_>,
    client_id: &str,
    dicatat_oleh: &str,
    draft: &MutasiDraft,
    id_ref: Option<&str>,
    unit: Option<&str>,
    jadikan_batch: bool,
) -> Result<String, CommandError> {
    let (tipe, satuan, bisa_expired, status_aktif): (String, String, i64, i64) = transaction
        .query_row(
            "SELECT tipe, satuan, bisa_expired, status_aktif FROM inventory_barang WHERE id_barang = ?;",
            params![draft.id_barang.trim()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Barang tidak ditemukan."))?;
    let id_barang = draft.id_barang.trim().to_owned();

    let hari_ini = wib_today(&transaction);
    let barang = BarangInfo {
        tipe: &tipe,
        bisa_expired: bisa_expired == 1,
    };
    let mut valid = validate_mutation(draft, barang, &hari_ini).map_err(invalid)?;
    if let Some(unit) = unit {
        valid.id_batch = Some(unit.to_owned());
    }
    if let Some(ref_luar) = id_ref {
        valid.id_ref = Some(ref_luar.to_owned());
    }
    if !ALASAN_FORMULIR.contains(&valid.alasan.as_str()) {
        return Err(invalid("Alasan ini belum bisa dicatat dari formulir."));
    }
    if valid.jenis == "Masuk" && status_aktif != 1 {
        return Err(invalid("Barang sudah dinonaktifkan."));
    }

    valid.tempat_asal = canonical_option(&transaction, valid.tempat_asal.take())?;
    valid.tempat_tujuan = canonical_option(&transaction, valid.tempat_tujuan.take())?;

    match (valid.penerima_tipe.as_deref(), valid.penerima_id.as_deref()) {
        (Some("Personil"), Some(id)) => {
            let nama: Option<String> = transaction
                .query_row(
                    "SELECT nama FROM master_data WHERE id_unik = ?;",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| CommandError::internal())?;
            valid.penerima_nama = Some(nama.ok_or_else(|| invalid("Penerima tidak ditemukan."))?);
        }
        _ => {}
    }
    // Ejaan divisi diambil dari data personil, supaya "keuangan" dan
    // "Keuangan" tidak tercatat sebagai dua penerima.
    if valid.penerima_tipe.as_deref() == Some("Divisi") {
        let ketik = valid.penerima_nama.clone().unwrap_or_default();
        let nama: Option<String> = transaction
            .query_row(
                "SELECT TRIM(divisi) FROM master_data
                 WHERE status_aktif = 'Aktif' AND LOWER(TRIM(divisi)) = LOWER(?)
                 ORDER BY TRIM(divisi) LIMIT 1;",
                params![ketik],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        valid.penerima_nama = Some(nama.ok_or_else(|| invalid("Divisi tidak ditemukan."))?);
    }

    if let Some(id_pinjam) = valid
        .id_ref
        .clone()
        .filter(|_| valid.alasan == "Pengembalian")
    {
        let pinjaman = load_pinjaman(transaction, &id_pinjam, &id_barang)?;
        let sisa = pinjaman.jumlah - jumlah_kembali(transaction, &id_pinjam)?;
        if valid.jumlah > sisa {
            return Err(invalid(format!(
                "Sisa yang belum kembali hanya {} {satuan}.",
                sisa.max(0)
            )));
        }
        // Barang kembali ke batch asalnya dan membawa nama peminjamnya, supaya
        // kartu stok menunjukkan siapa yang mengembalikan.
        valid.id_batch = pinjaman.id_batch;
        valid.penerima_tipe = pinjaman.penerima_tipe;
        valid.penerima_id = pinjaman.penerima_id;
        valid.penerima_nama = pinjaman.penerima_nama;
    }

    if let Some(batch) = valid.id_batch.as_deref() {
        let ada: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM inventory_mutasi
                               WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Masuk');",
                params![batch, id_barang],
                |row| row.get(0),
            )
            .map_err(|_| CommandError::internal())?;
        if !ada {
            return Err(invalid("Batch tidak ditemukan."));
        }
    }

    if let (Some(tempat), Some(kondisi)) =
        (valid.tempat_asal.as_deref(), valid.kondisi_asal.as_deref())
    {
        assert_saldo_cukup(
            &transaction,
            &id_barang,
            &satuan,
            tempat,
            kondisi,
            valid.id_batch.as_deref(),
            valid.jumlah,
        )?;
    }

    let id_mutasi = new_hex_id("mts-");
    if valid.jenis == "Masuk" && (barang.bisa_expired || jadikan_batch) && valid.id_batch.is_none() {
        // Setiap barang masuk ber-expired menjadi batch-nya sendiri, sehingga
        // rumus saldo tidak butuh cabang khusus untuk baris pembuka batch.
        // Pengembalian sudah membawa batch asal dari peminjamannya.
        valid.id_batch = Some(id_mutasi.clone());
    }
    insert_mutasi(
        &transaction,
        &id_mutasi,
        &id_barang,
        &valid,
        valid.id_ref.as_deref(),
        dicatat_oleh,
    )?;

    let payload = mutasi_json(transaction, &id_mutasi)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        transaction,
        client_id,
        "inventory-mutation",
        "create",
        &id_mutasi,
        &payload,
        None,
    )?;
    Ok(id_mutasi)
}

pub fn cancel_mutation(
    state: &DesktopState,
    dicatat_oleh: &str,
    id_mutasi: &str,
    alasan_batal: &str,
) -> Result<Value, CommandError> {
    let alasan_batal = alasan_batal.trim();
    if alasan_batal.is_empty() {
        return Err(invalid("Alasan pembatalan wajib diisi."));
    }
    if alasan_batal.chars().count() > 500 {
        return Err(invalid("Alasan pembatalan maksimal 500 karakter."));
    }
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let asal: (MutasiAsal, String, String) = transaction
        .query_row(
            "SELECT m.id_mutasi, m.jenis, m.alasan, m.jumlah, m.tempat_asal, m.kondisi_asal,
                    m.tempat_tujuan, m.kondisi_tujuan, m.id_batch, m.id_barang, b.satuan
             FROM inventory_mutasi m
             JOIN inventory_barang b ON b.id_barang = m.id_barang
             WHERE m.id_mutasi = ?;",
            params![id_mutasi.trim()],
            |row| {
                Ok((
                    MutasiAsal {
                        id_mutasi: row.get(0)?,
                        jenis: row.get(1)?,
                        alasan: row.get(2)?,
                        jumlah: row.get(3)?,
                        tempat_asal: row.get(4)?,
                        kondisi_asal: row.get(5)?,
                        tempat_tujuan: row.get(6)?,
                        kondisi_tujuan: row.get(7)?,
                        id_batch: row.get(8)?,
                    },
                    row.get(9)?,
                    row.get(10)?,
                ))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Mutasi tidak ditemukan."))?;
    let (asal, id_barang, satuan) = asal;
    let kebalikan = build_cancellation(&asal).map_err(invalid)?;

    let sudah_batal: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?);",
            params![kebalikan.id_mutasi],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if sudah_batal {
        return Err(invalid("Mutasi ini sudah dibatalkan."));
    }
    // Membatalkan peminjaman yang sudah (sebagian) kembali memasukkan barang
    // yang sama dua kali: sekali lewat pengembalian, sekali lewat pembatalan.
    if asal.alasan == "Peminjaman" && jumlah_kembali(&transaction, &asal.id_mutasi)? > 0 {
        return Err(invalid("Batalkan dulu pengembalian peminjaman ini."));
    }

    if let (Some(tempat), Some(kondisi)) = (
        kebalikan.tempat_asal.as_deref(),
        kebalikan.kondisi_asal.as_deref(),
    ) {
        let saldo = saldo_posisi(
            &transaction,
            &id_barang,
            tempat,
            kondisi,
            kebalikan.id_batch.as_deref(),
        )?;
        if saldo < kebalikan.jumlah {
            return Err(invalid(format!(
                "Stok di {tempat} ({kondisi}) tinggal {} {satuan}, tidak cukup untuk membatalkan mutasi ini.",
                saldo.max(0)
            )));
        }
    }

    let valid = MutasiValid {
        jenis: kebalikan.jenis.clone(),
        alasan: kebalikan.alasan.clone(),
        tanggal: wib_today(&transaction),
        jumlah: kebalikan.jumlah,
        tempat_asal: kebalikan.tempat_asal.clone(),
        kondisi_asal: kebalikan.kondisi_asal.clone(),
        tempat_tujuan: kebalikan.tempat_tujuan.clone(),
        kondisi_tujuan: kebalikan.kondisi_tujuan.clone(),
        id_batch: kebalikan.id_batch.clone(),
        catatan: Some(alasan_batal.to_owned()),
        ..MutasiValid::default()
    };
    insert_mutasi(
        &transaction,
        &kebalikan.id_mutasi,
        &id_barang,
        &valid,
        Some(&asal.id_mutasi),
        dicatat_oleh,
    )?;
    let payload =
        mutasi_json(&transaction, &kebalikan.id_mutasi)?.ok_or_else(CommandError::internal)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-mutation",
        "create",
        &kebalikan.id_mutasi,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_mutasi": kebalikan.id_mutasi }))
}

/// Peminjaman yang belum kembali penuh, tertua lebih dulu.
pub fn list_loans(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT * FROM (
                SELECT p.id_mutasi, p.id_barang, b.nama_barang, b.kode_barang, b.satuan, b.tipe,
                       p.tanggal, p.jumlah, p.tempat_asal, p.kondisi_asal, p.id_batch,
                       p.penerima_tipe, p.penerima_nama, p.keperluan,
                       COALESCE((SELECT SUM(r.jumlah) FROM inventory_mutasi r
                                 WHERE r.id_ref = p.id_mutasi AND r.alasan = 'Pengembalian'
                                   AND NOT EXISTS (SELECT 1 FROM inventory_mutasi rb
                                                   WHERE rb.id_mutasi = 'batal-' || r.id_mutasi)), 0) AS kembali,
                       CAST(julianday(date('now', '+7 hours')) - julianday(p.tanggal) AS INTEGER) AS lama_hari,
                       p.created_at
                FROM inventory_mutasi p
                JOIN inventory_barang b ON b.id_barang = p.id_barang
                WHERE p.alasan = 'Peminjaman'
                  AND NOT EXISTS (SELECT 1 FROM inventory_mutasi pb WHERE pb.id_mutasi = 'batal-' || p.id_mutasi)
             ) WHERE jumlah > kembali
             ORDER BY tanggal, created_at, id_mutasi
             LIMIT 501;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut baris: Vec<Value> = statement
        .query_map([], |row| {
            let jumlah: i64 = row.get(7)?;
            let kembali: i64 = row.get(14)?;
            Ok(json!({
                "id_mutasi": row.get::<_, String>(0)?,
                "id_barang": row.get::<_, String>(1)?,
                "nama_barang": row.get::<_, String>(2)?,
                "kode_barang": row.get::<_, String>(3)?,
                "satuan": row.get::<_, String>(4)?,
                "tipe": row.get::<_, String>(5)?,
                "tanggal": row.get::<_, String>(6)?,
                "jumlah": jumlah,
                "tempat_asal": row.get::<_, Option<String>>(8)?,
                "kondisi_asal": row.get::<_, Option<String>>(9)?,
                "id_batch": row.get::<_, Option<String>>(10)?,
                "penerima_tipe": row.get::<_, Option<String>>(11)?,
                "penerima_nama": row.get::<_, Option<String>>(12)?,
                "keperluan": row.get::<_, Option<String>>(13)?,
                "kembali": kembali,
                "sisa": jumlah - kembali,
                "lama_hari": row.get::<_, i64>(15)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;
    let terpotong = baris.len() > MAKS_BARIS_PINJAMAN;
    baris.truncate(MAKS_BARIS_PINJAMAN);
    Ok(json!({ "baris": baris, "terpotong": terpotong }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpnameBarisDraft {
    #[serde(default)]
    pub id_barang: String,
    #[serde(default)]
    pub kondisi: Option<String>,
    #[serde(default)]
    pub id_batch: Option<String>,
    #[serde(default)]
    pub fisik: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpnameDraft {
    #[serde(default)]
    pub tempat: String,
    #[serde(default)]
    pub baris: Vec<OpnameBarisDraft>,
    #[serde(default)]
    pub catatan: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct OpnameBaris {
    pub id_barang: String,
    pub kondisi: String,
    pub id_batch: Option<String>,
    pub fisik: i64,
}

#[derive(Debug, PartialEq)]
pub struct OpnameValid {
    pub tempat: String,
    pub baris: Vec<OpnameBaris>,
    pub catatan: Option<String>,
}

/// Cermin `validateOpname`. Murni: saldo sistem dihitung ulang di
/// `record_opname` saat menyimpan, bukan diambil dari angka di layar.
pub fn validate_opname(draft: &OpnameDraft) -> Result<OpnameValid, String> {
    let tempat = clean_tempat(&Some(draft.tempat.clone()))
        .ok_or_else(|| "Pilih tempat yang diopname.".to_owned())?;
    if tempat.chars().count() > MAKS_PANJANG_TEMPAT {
        return Err("Nama tempat maksimal 80 karakter.".into());
    }
    if draft.baris.is_empty() {
        return Err("Belum ada barang yang dihitung.".into());
    }
    if draft.baris.len() > MAKS_BARIS_OPNAME {
        return Err("Satu opname maksimal 500 baris.".into());
    }
    let mut baris: Vec<OpnameBaris> = Vec::with_capacity(draft.baris.len());
    for item in &draft.baris {
        let id_barang = item.id_barang.trim().to_owned();
        if id_barang.is_empty() {
            return Err("Barang pada baris opname tidak valid.".into());
        }
        let kondisi = clean(&item.kondisi).unwrap_or_else(|| "Baik".into());
        if !KONDISI_BARANG.contains(&kondisi.as_str()) {
            return Err("Kondisi barang tidak dikenal.".into());
        }
        if !(0..=MAKS_JUMLAH).contains(&item.fisik) {
            return Err("Jumlah fisik harus 0 sampai 1.000.000.".into());
        }
        let id_batch = clean(&item.id_batch);
        if baris.iter().any(|known| {
            known.id_barang == id_barang && known.kondisi == kondisi && known.id_batch == id_batch
        }) {
            return Err("Barang yang sama tercatat dua kali dalam opname ini.".into());
        }
        baris.push(OpnameBaris {
            id_barang,
            kondisi,
            id_batch,
            fisik: item.fisik,
        });
    }
    let catatan = clean(&draft.catatan);
    if too_long(&catatan, 500) {
        return Err("Catatan maksimal 500 karakter.".into());
    }
    Ok(OpnameValid {
        tempat,
        baris,
        catatan,
    })
}

/// Menyimpan hasil hitung fisik satu tempat. Setiap selisih menjadi mutasi
/// Selisih Opname dengan nomor dokumen yang sama, dalam SATU transaksi.
pub fn record_opname(
    state: &DesktopState,
    dicatat_oleh: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: OpnameDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data opname tidak valid."))?;
    let valid = validate_opname(&draft).map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;

    let tempat = canonical_tempat(&transaction, &valid.tempat)?;
    let hari_ini = wib_today(&transaction);
    let acak: String = new_hex_id("").chars().take(4).collect();
    let nomor = format!(
        "OPN-{}-{}",
        hari_ini.replace('-', ""),
        acak.to_ascii_uppercase()
    );
    let mut jumlah_selisih = 0;

    for baris in &valid.baris {
        let (tipe, bisa_expired, nama): (String, i64, String) = transaction
            .query_row(
                "SELECT tipe, bisa_expired, nama_barang FROM inventory_barang WHERE id_barang = ?;",
                params![baris.id_barang],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?
            .ok_or_else(|| invalid("Barang pada baris opname tidak ditemukan."))?;
        let kondisi = if tipe == "Habis Pakai" {
            "Baik".to_owned()
        } else {
            baris.kondisi.clone()
        };
        let id_batch = if bisa_expired == 1 {
            let batch = baris
                .id_batch
                .clone()
                .ok_or_else(|| invalid(format!("Pilih batch untuk {nama}.")))?;
            let ada: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM inventory_mutasi
                                   WHERE id_mutasi = ? AND id_barang = ? AND jenis = 'Masuk');",
                    params![batch, baris.id_barang],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            if !ada {
                return Err(invalid(format!("Batch {nama} tidak ditemukan.")));
            }
            Some(batch)
        } else if let Some(unit) = baris.id_batch.clone() {
            // Barang per unit: tiap unit adalah batch-nya sendiri. Membuang
            // batch di sini membandingkan unit dengan stok tanpa nomor (0),
            // sehingga setiap unit tercatat sebagai Selisih Opname +1.
            let milik: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM inventory_unit WHERE id_unit = ? AND id_barang = ?);",
                    params![unit, baris.id_barang],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            if !milik {
                return Err(invalid(format!("Unit {nama} tidak ditemukan.")));
            }
            if baris.fisik > 1 {
                return Err(invalid(format!(
                    "Satu unit {nama} hanya bisa dihitung 0 atau 1."
                )));
            }
            Some(unit)
        } else {
            None
        };

        let sistem = saldo_posisi(
            &transaction,
            &baris.id_barang,
            &tempat,
            &kondisi,
            id_batch.as_deref(),
        )?;
        let selisih = baris.fisik - sistem;
        if selisih == 0 {
            continue;
        }
        let (jenis, asal, tujuan) = if selisih > 0 {
            ("Masuk", None, Some(tempat.clone()))
        } else {
            ("Keluar", Some(tempat.clone()), None)
        };
        let mutasi = MutasiValid {
            jenis: jenis.into(),
            alasan: "Selisih Opname".into(),
            tanggal: hari_ini.clone(),
            jumlah: selisih.abs(),
            kondisi_asal: asal.as_ref().map(|_| kondisi.clone()),
            tempat_asal: asal,
            kondisi_tujuan: tujuan.as_ref().map(|_| kondisi.clone()),
            tempat_tujuan: tujuan,
            id_batch,
            nomor_dokumen: Some(nomor.clone()),
            catatan: valid.catatan.clone(),
            ..MutasiValid::default()
        };
        let id_mutasi = new_hex_id("mts-");
        insert_mutasi(
            &transaction,
            &id_mutasi,
            &baris.id_barang,
            &mutasi,
            None,
            dicatat_oleh,
        )?;
        let payload = mutasi_json(&transaction, &id_mutasi)?.ok_or_else(CommandError::internal)?;
        sync::enqueue(
            &transaction,
            &client_id,
            "inventory-mutation",
            "create",
            &id_mutasi,
            &payload,
            None,
        )?;
        jumlah_selisih += 1;
    }

    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "nomor_dokumen": nomor, "jumlah_selisih": jumlah_selisih }))
}

pub const MAKS_BARIS_DOKUMEN: usize = 500;
pub const MAKS_BARIS_PENGADAAN: usize = 5000;

pub(crate) fn kop_perusahaan(connection: &Connection) -> Result<Value, CommandError> {
    let kop = connection
        .query_row(
            "SELECT company_name, branch_name, logo_url, address, phone, email, website,
                    leader_name, leader_title, leader_nip
             FROM company_profile ORDER BY id = 'default_company' DESC LIMIT 1;",
            [],
            |row| {
                Ok(json!({
                    "nama": row.get::<_, Option<String>>(0)?,
                    "cabang": row.get::<_, Option<String>>(1)?,
                    "logo_url": row.get::<_, Option<String>>(2)?,
                    "alamat": row.get::<_, Option<String>>(3)?,
                    "telepon": row.get::<_, Option<String>>(4)?,
                    "email": row.get::<_, Option<String>>(5)?,
                    "website": row.get::<_, Option<String>>(6)?,
                    "kepala_nama": row.get::<_, Option<String>>(7)?,
                    "kepala_jabatan": row.get::<_, Option<String>>(8)?,
                    "kepala_nip": row.get::<_, Option<String>>(9)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    Ok(kop.unwrap_or_else(|| json!({})))
}

/// Isi satu berita acara. Kop perusahaan ikut dikembalikan di sini, dengan izin
/// inventaris, karena membaca profil perusahaan biasa menuntut `settings.manage`
/// yang tidak dimiliki petugas Sarpras. Hanya kolom tampilan yang dikirim.
pub fn document(state: &DesktopState, id_mutasi: &str) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let (alasan, nomor): (String, Option<String>) = connection
        .query_row(
            "SELECT alasan, nomor_dokumen FROM inventory_mutasi WHERE id_mutasi = ?;",
            params![id_mutasi.trim()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Mutasi tidak ditemukan."))?;
    let jenis = jenis_berita_acara(&alasan)
        .ok_or_else(|| invalid("Mutasi ini tidak punya berita acara."))?;
    let dibatalkan: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_mutasi WHERE id_mutasi = ?);",
            params![cancellation_id(id_mutasi.trim())],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if dibatalkan {
        return Err(invalid(
            "Mutasi ini sudah dibatalkan, berita acaranya tidak bisa dicetak.",
        ));
    }

    // Satu nomor dokumen = satu berita acara. Baris yang dibatalkan dan baris
    // berjenis lain dalam nomor yang sama tidak ikut dicetak.
    let nomor = nomor.filter(|n| !n.trim().is_empty());
    let mut statement = connection
        .prepare(
            "SELECT m.id_mutasi, m.tanggal, m.alasan, m.jumlah, m.tempat_asal, m.kondisi_asal,
                    m.tempat_tujuan, m.kondisi_tujuan, bm.tanggal_expired, m.penerima_nama,
                    m.keperluan, m.catatan, m.dicatat_oleh, b.nama_barang, b.kode_barang, b.satuan
             FROM inventory_mutasi m
             JOIN inventory_barang b ON b.id_barang = m.id_barang
             LEFT JOIN inventory_mutasi bm ON bm.id_mutasi = m.id_batch
             WHERE (m.nomor_dokumen = ?1 OR (?1 IS NULL AND m.id_mutasi = ?2))
               AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
             ORDER BY m.created_at, m.id_mutasi
             LIMIT 501;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut baris: Vec<Value> = Vec::new();
    let mut terpotong = false;
    let rows = statement
        .query_map(params![nomor, id_mutasi.trim()], |row| {
            Ok((
                row.get::<_, String>(2)?,
                json!({
                    "id_mutasi": row.get::<_, String>(0)?,
                    "tanggal": row.get::<_, String>(1)?,
                    "alasan": row.get::<_, String>(2)?,
                    "jumlah": row.get::<_, i64>(3)?,
                    "tempat_asal": row.get::<_, Option<String>>(4)?,
                    "kondisi_asal": row.get::<_, Option<String>>(5)?,
                    "tempat_tujuan": row.get::<_, Option<String>>(6)?,
                    "kondisi_tujuan": row.get::<_, Option<String>>(7)?,
                    "tanggal_expired": row.get::<_, Option<String>>(8)?,
                    "penerima_nama": row.get::<_, Option<String>>(9)?,
                    "keperluan": row.get::<_, Option<String>>(10)?,
                    "catatan": row.get::<_, Option<String>>(11)?,
                    "dicatat_oleh": row.get::<_, String>(12)?,
                    "nama_barang": row.get::<_, String>(13)?,
                    "kode_barang": row.get::<_, String>(14)?,
                    "satuan": row.get::<_, String>(15)?,
                }),
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in rows {
        let (alasan_baris, item) = row.map_err(|_| CommandError::internal())?;
        if jenis_berita_acara(&alasan_baris) != Some(jenis) {
            continue;
        }
        if baris.len() == MAKS_BARIS_DOKUMEN {
            terpotong = true;
            break;
        }
        baris.push(item);
    }
    let pertama = baris.first().cloned().unwrap_or_else(|| json!({}));
    Ok(json!({
        "jenis": jenis,
        "nomor_dokumen": nomor,
        "tanggal": pertama["tanggal"],
        "dicatat_oleh": pertama["dicatat_oleh"],
        "penerima_nama": baris.iter().find_map(|b| b["penerima_nama"].as_str().map(str::to_owned)),
        "kop": kop_perusahaan(&connection)?,
        "baris": baris,
        "terpotong": terpotong,
    }))
}

/// 50 sesi opname terakhir yang punya selisih, untuk dicetak ulang.
pub fn opname_history(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT m.nomor_dokumen, MIN(m.tanggal), MIN(COALESCE(m.tempat_asal, m.tempat_tujuan)),
                    COUNT(*), MIN(m.dicatat_oleh), MIN(m.id_mutasi), MAX(m.created_at) AS dibuat
             FROM inventory_mutasi m
             WHERE m.alasan = 'Selisih Opname' AND m.nomor_dokumen IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
             GROUP BY m.nomor_dokumen
             ORDER BY dibuat DESC
             LIMIT 50;",
        )
        .map_err(|_| CommandError::internal())?;
    let riwayat: Vec<Value> = statement
        .query_map([], |row| {
            Ok(json!({
                "nomor_dokumen": row.get::<_, String>(0)?,
                "tanggal": row.get::<_, String>(1)?,
                "tempat": row.get::<_, Option<String>>(2)?,
                "jumlah_selisih": row.get::<_, i64>(3)?,
                "dicatat_oleh": row.get::<_, String>(4)?,
                "id_mutasi": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;
    Ok(json!({ "riwayat": riwayat }))
}

/// Barang masuk berbiaya (Pengadaan, Hibah, Saldo Awal) dalam rentang tanggal,
/// diurutkan per sumber dana. Nilai = jumlah × harga satuan, dalam rupiah bulat.
pub fn procurement(state: &DesktopState, dari: &str, sampai: &str) -> Result<Value, CommandError> {
    if !is_valid_date(dari) || !is_valid_date(sampai) {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    if dari > sampai {
        return Err(invalid("Tanggal awal tidak boleh setelah tanggal akhir."));
    }
    let connection = storage::database(&state.data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT m.tanggal, b.kode_barang, b.nama_barang, b.satuan, m.alasan, m.jumlah,
                    m.harga_satuan, COALESCE(m.sumber_dana, '') AS sumber_dana, m.nomor_dokumen,
                    m.tempat_tujuan, m.jumlah * COALESCE(m.harga_satuan, 0) AS nilai
             FROM inventory_mutasi m
             JOIN inventory_barang b ON b.id_barang = m.id_barang
             WHERE m.jenis = 'Masuk' AND m.alasan IN ('Pengadaan', 'Hibah', 'Saldo Awal')
               AND m.tanggal >= ? AND m.tanggal <= ?
               AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
             ORDER BY sumber_dana COLLATE NOCASE, m.tanggal, m.created_at
             LIMIT 5001;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut ringkas: Vec<(String, i64, bool)> = Vec::new();
    let mut baris: Vec<Value> = statement
        .query_map(params![dari, sampai], |row| {
            let harga: Option<i64> = row.get(6)?;
            let sumber: String = row.get(7)?;
            let nilai: i64 = row.get(10)?;
            Ok(json!({
                "tanggal": row.get::<_, String>(0)?,
                "kode_barang": row.get::<_, String>(1)?,
                "nama_barang": row.get::<_, String>(2)?,
                "satuan": row.get::<_, String>(3)?,
                "alasan": row.get::<_, String>(4)?,
                "jumlah": row.get::<_, i64>(5)?,
                "harga_satuan": harga,
                "sumber_dana": sumber,
                "nomor_dokumen": row.get::<_, Option<String>>(8)?,
                "tempat_tujuan": row.get::<_, Option<String>>(9)?,
                "nilai": nilai,
            }))
        })
        .map_err(|_| CommandError::internal())?
        .collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())?;
    let terpotong = baris.len() > MAKS_BARIS_PENGADAAN;
    baris.truncate(MAKS_BARIS_PENGADAAN);
    for item in &baris {
        ringkas.push((
            item["sumber_dana"].as_str().unwrap_or_default().to_owned(),
            item["nilai"].as_i64().unwrap_or(0),
            item["harga_satuan"].is_null(),
        ));
    }
    let rekap = rekap_sumber_dana(&ringkas);
    let total: i64 = rekap.iter().fold(0, |acc, r| acc.saturating_add(r.nilai));
    Ok(json!({
        "baris": baris,
        "rekap": rekap.iter().map(|r| json!({
            "sumber_dana": r.sumber_dana,
            "baris": r.baris,
            "nilai": r.nilai,
            "tanpa_harga": r.tanpa_harga,
        })).collect::<Vec<_>>(),
        "total_nilai": total,
        "terpotong": terpotong,
    }))
}

pub fn stock_card(
    state: &DesktopState,
    id_barang: &str,
    tempat: Option<String>,
    dari: &str,
    sampai: &str,
) -> Result<Value, CommandError> {
    if !is_valid_date(dari) || !is_valid_date(sampai) {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    if dari > sampai {
        return Err(invalid("Tanggal awal tidak boleh setelah tanggal akhir."));
    }
    let tempat = tempat
        .as_deref()
        .map(normalize_tempat)
        .filter(|text| !text.is_empty());
    let connection = storage::database(&state.data_dir)?;

    let saldo_awal: i64 = connection
        .query_row(
            "SELECT COALESCE(SUM(
                CASE WHEN tempat_tujuan IS NOT NULL AND (?2 IS NULL OR LOWER(tempat_tujuan) = LOWER(?2)) THEN jumlah ELSE 0 END
              - CASE WHEN tempat_asal IS NOT NULL AND (?2 IS NULL OR LOWER(tempat_asal) = LOWER(?2)) THEN jumlah ELSE 0 END
             ), 0)
             FROM inventory_mutasi
             WHERE id_barang = ?1 AND tanggal < ?3
             -- batas: agregat, selalu satu baris
             ;",
            params![id_barang, tempat, dari],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;

    let mut statement = connection
        .prepare(
            "SELECT * FROM (
                SELECT m.id_mutasi, m.tanggal, m.jenis, m.alasan, m.jumlah, m.tempat_asal,
                       m.kondisi_asal, m.tempat_tujuan, m.kondisi_tujuan, m.id_batch,
                       m.tanggal_expired, m.id_ref, m.penerima_tipe, m.penerima_nama, m.keperluan,
                       m.sumber_dana, m.nomor_dokumen, m.harga_satuan, m.catatan, m.dicatat_oleh,
                       m.created_at,
                       CASE WHEN m.tempat_tujuan IS NOT NULL AND (?2 IS NULL OR LOWER(m.tempat_tujuan) = LOWER(?2)) THEN m.jumlah ELSE 0 END AS masuk,
                       CASE WHEN m.tempat_asal IS NOT NULL AND (?2 IS NULL OR LOWER(m.tempat_asal) = LOWER(?2)) THEN m.jumlah ELSE 0 END AS keluar,
                       EXISTS(SELECT 1 FROM inventory_mutasi b WHERE b.id_mutasi = 'batal-' || m.id_mutasi) AS dibatalkan
                FROM inventory_mutasi m
                WHERE m.id_barang = ?1 AND m.tanggal >= ?3 AND m.tanggal <= ?4
             ) WHERE masuk > 0 OR keluar > 0
             ORDER BY tanggal, created_at, id_mutasi
             LIMIT 1001;",
        )
        .map_err(|_| CommandError::internal())?;
    let mut saldo = saldo_awal;
    let mut baris: Vec<Value> = Vec::new();
    let rows = statement
        .query_map(params![id_barang, tempat, dari, sampai], |row| {
            Ok((
                json!({
                    "id_mutasi": row.get::<_, String>(0)?,
                    "tanggal": row.get::<_, String>(1)?,
                    "jenis": row.get::<_, String>(2)?,
                    "alasan": row.get::<_, String>(3)?,
                    "jumlah": row.get::<_, i64>(4)?,
                    "tempat_asal": row.get::<_, Option<String>>(5)?,
                    "kondisi_asal": row.get::<_, Option<String>>(6)?,
                    "tempat_tujuan": row.get::<_, Option<String>>(7)?,
                    "kondisi_tujuan": row.get::<_, Option<String>>(8)?,
                    "id_batch": row.get::<_, Option<String>>(9)?,
                    "tanggal_expired": row.get::<_, Option<String>>(10)?,
                    "id_ref": row.get::<_, Option<String>>(11)?,
                    "penerima_tipe": row.get::<_, Option<String>>(12)?,
                    "penerima_nama": row.get::<_, Option<String>>(13)?,
                    "keperluan": row.get::<_, Option<String>>(14)?,
                    "sumber_dana": row.get::<_, Option<String>>(15)?,
                    "nomor_dokumen": row.get::<_, Option<String>>(16)?,
                    "harga_satuan": row.get::<_, Option<i64>>(17)?,
                    "catatan": row.get::<_, Option<String>>(18)?,
                    "dicatat_oleh": row.get::<_, String>(19)?,
                    "created_at": row.get::<_, String>(20)?,
                    "dibatalkan": row.get::<_, i64>(23)? == 1,
                }),
                row.get::<_, i64>(21)?,
                row.get::<_, i64>(22)?,
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in rows {
        let (mut item, masuk, keluar) = row.map_err(|_| CommandError::internal())?;
        if baris.len() == MAKS_BARIS_KARTU_STOK {
            return Ok(json!({ "saldo_awal": saldo_awal, "baris": baris, "terpotong": true }));
        }
        saldo += masuk - keluar;
        item["masuk"] = json!(masuk);
        item["keluar"] = json!(keluar);
        item["saldo"] = json!(saldo);
        baris.push(item);
    }
    Ok(json!({ "saldo_awal": saldo_awal, "baris": baris, "terpotong": false }))
}

// ── Cloud ───────────────────────────────────────────────────────────────────

fn payload_text(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn payload_kondisi(row: &Value, key: &str) -> Result<Option<String>, ()> {
    match payload_text(row, key) {
        None => Ok(None),
        Some(value) if KONDISI_BARANG.contains(&value.as_str()) => Ok(Some(value)),
        Some(_) => Err(()),
    }
}

/// Nilai kolom `inventory_barang` dari payload event, siap untuk upsert cloud.
/// `None` berarti payload tidak memenuhi CHECK cloud dan diabaikan, sama
/// seperti handler whitelist hari libur: menuliskannya akan ditolak cloud dan
/// mengunci outbox selamanya.
pub fn cloud_item_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_barang").unwrap_or_else(|| entity_key.trim().to_owned());
    let kode = payload_text(row, "kode_barang")?;
    let nama = payload_text(row, "nama_barang")?;
    let tipe = payload_text(row, "tipe").filter(|value| TIPE_BARANG.contains(&value.as_str()))?;
    let satuan = payload_text(row, "satuan")?;
    if id.is_empty() {
        return None;
    }
    let flag = |key: &str, default: i64| match row.get(key).and_then(Value::as_i64) {
        Some(0) => 0,
        Some(1) => 1,
        _ => default,
    };
    let stok_minimum = row
        .get("stok_minimum")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .unwrap_or(0);
    Some(vec![
        json!(id),
        json!(kode),
        json!(nama),
        json!(payload_text(row, "kategori")),
        json!(tipe),
        json!(satuan),
        json!(flag("bisa_expired", 0)),
        json!(stok_minimum),
        json!(payload_text(row, "tempat_utama")),
        json!(payload_text(row, "catatan")),
        json!(flag("status_aktif", 1)),
        json!(payload_text(row, "created_at")),
        json!(payload_text(row, "updated_at")),
    ])
}

pub const CLOUD_UPSERT_ITEM_SQL: &str = "INSERT INTO inventory_barang (
        id_barang, kode_barang, nama_barang, kategori, tipe, satuan, bisa_expired,
        stok_minimum, tempat_utama, catatan, status_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id_barang) DO UPDATE SET
        kode_barang = excluded.kode_barang,
        nama_barang = excluded.nama_barang,
        kategori = excluded.kategori,
        tipe = excluded.tipe,
        satuan = excluded.satuan,
        bisa_expired = excluded.bisa_expired,
        stok_minimum = excluded.stok_minimum,
        tempat_utama = excluded.tempat_utama,
        catatan = excluded.catatan,
        status_aktif = excluded.status_aktif,
        updated_at = excluded.updated_at;";

/// Nilai kolom `inventory_mutasi` dari payload event. Cloud TIDAK memeriksa
/// stok: dua perangkat offline bisa sah mengeluarkan barang terakhir yang
/// sama, dan menolak push kedua akan mengunci outbox padahal barangnya sudah
/// benar-benar keluar dari rak. Saldo minus ditampilkan sebagai peringatan.
pub fn cloud_mutation_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_mutasi").unwrap_or_else(|| entity_key.trim().to_owned());
    let id_barang = payload_text(row, "id_barang")?;
    let jenis =
        payload_text(row, "jenis").filter(|value| JENIS_MUTASI.contains(&value.as_str()))?;
    let alasan =
        payload_text(row, "alasan").filter(|value| ALASAN_MUTASI.contains(&value.as_str()))?;
    let tanggal = payload_text(row, "tanggal").filter(|value| is_valid_date(value))?;
    let jumlah = row
        .get("jumlah")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)?;
    let dicatat_oleh = payload_text(row, "dicatat_oleh")?;
    let kondisi_asal = payload_kondisi(row, "kondisi_asal").ok()?;
    let kondisi_tujuan = payload_kondisi(row, "kondisi_tujuan").ok()?;
    let penerima_tipe = match payload_text(row, "penerima_tipe") {
        None => None,
        Some(value) if PENERIMA_TIPE.contains(&value.as_str()) => Some(value),
        Some(_) => return None,
    };
    let harga_satuan = match row.get("harga_satuan") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64().filter(|harga| *harga >= 0)?),
    };
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(id_barang),
        json!(jenis),
        json!(alasan),
        json!(tanggal),
        json!(jumlah),
        json!(payload_text(row, "tempat_asal")),
        json!(kondisi_asal),
        json!(payload_text(row, "tempat_tujuan")),
        json!(kondisi_tujuan),
        json!(payload_text(row, "id_batch")),
        json!(payload_text(row, "tanggal_expired")),
        json!(payload_text(row, "id_ref")),
        json!(penerima_tipe),
        json!(payload_text(row, "penerima_id")),
        json!(payload_text(row, "penerima_nama")),
        json!(payload_text(row, "keperluan")),
        json!(payload_text(row, "sumber_dana")),
        json!(payload_text(row, "nomor_dokumen")),
        json!(harga_satuan),
        json!(payload_text(row, "catatan")),
        json!(dicatat_oleh),
        json!(payload_text(row, "created_at")),
    ])
}

/// Nilai kolom `inventory_unit` dari payload event. Hanya identitas unit;
/// posisinya diturunkan dari mutasi, jadi siapa terakhir menang di sini hanya
/// menyangkut nomor seri dan catatan.
pub fn cloud_unit_values(row: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(row, "id_unit").unwrap_or_else(|| entity_key.trim().to_owned());
    let id_barang = payload_text(row, "id_barang")?;
    let kode_unit = payload_text(row, "kode_unit")?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(id_barang),
        json!(kode_unit),
        json!(payload_text(row, "nomor_seri")),
        json!(payload_text(row, "catatan")),
        json!(payload_text(row, "created_at")),
        json!(payload_text(row, "updated_at")),
    ])
}

pub const CLOUD_UPSERT_UNIT_SQL: &str = "INSERT INTO inventory_unit (
        id_unit, id_barang, kode_unit, nomor_seri, catatan, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id_unit) DO UPDATE SET
        kode_unit = excluded.kode_unit,
        nomor_seri = excluded.nomor_seri,
        catatan = excluded.catatan,
        updated_at = excluded.updated_at;";

/// Mutasi tidak pernah diubah: event yang terkirim dua kali tidak berefek.
pub const CLOUD_INSERT_MUTATION_SQL: &str = "INSERT INTO inventory_mutasi (
        id_mutasi, id_barang, jenis, alasan, tanggal, jumlah, tempat_asal, kondisi_asal,
        tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, id_ref, penerima_tipe,
        penerima_id, penerima_nama, keperluan, sumber_dana, nomor_dokumen, harga_satuan,
        catatan, dicatat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_mutasi) DO NOTHING;";

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const HARI_INI: &str = "2026-10-07";

    fn setup_state() -> (tempfile::TempDir, DesktopState) {
        let directory = tempdir().expect("direktori sementara");
        storage::initialize(directory.path()).expect("inisialisasi database");
        let state = DesktopState {
            server_origin: std::sync::RwLock::new("http://localhost:3000".to_string()),
            offline_max_age_hours: 24,
            data_dir: directory.path().to_path_buf(),
            http: reqwest::Client::new(),
            turso_config: std::sync::RwLock::new(None),
            session: std::sync::Mutex::new(None),
            vault_lock: std::sync::Mutex::new(()),
        };
        (directory, state)
    }

    fn draft(value: Value) -> MutasiDraft {
        serde_json::from_value(value).expect("draft mutasi")
    }

    const HABIS_PAKAI: BarangInfo<'static> = BarangInfo {
        tipe: "Habis Pakai",
        bisa_expired: false,
    };
    const ASET: BarangInfo<'static> = BarangInfo {
        tipe: "Aset",
        bisa_expired: false,
    };
    const OBAT: BarangInfo<'static> = BarangInfo {
        tipe: "Habis Pakai",
        bisa_expired: true,
    };

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_TEMPAT).
    #[test]
    fn normalize_tempat_vectors() {
        for (input, expected) in [
            ("  Ruang   TU ", "Ruang TU"),
            ("UKS", "UKS"),
            ("\tGudang\nUtama  ", "Gudang Utama"),
            ("   ", ""),
        ] {
            assert_eq!(normalize_tempat(input), expected, "input {input:?}");
        }
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_TANGGAL).
    #[test]
    fn is_valid_date_vectors() {
        for (input, expected) in [
            ("2026-10-07", true),
            ("2024-02-29", true),
            ("2026-02-29", false),
            ("2026-13-01", false),
            ("2026-04-31", false),
            ("2026-1-07", false),
            ("abcd-ef-gh", false),
        ] {
            assert_eq!(is_valid_date(input), expected, "input {input:?}");
        }
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_MUTASI).
    // Setiap baris: barang, draft, dan pesan galat yang diharapkan (None = sah).
    #[test]
    fn validate_mutation_vectors() {
        let cases: Vec<(BarangInfo, Value, Option<&str>)> = vec![
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":10,"tempat_tujuan":"Gudang"}),
                None,
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Hapus","alasan":"Pengadaan","jumlah":10,"tempat_tujuan":"Gudang"}),
                Some("Jenis mutasi tidak dikenal."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pemakaian","jumlah":10,"tempat_tujuan":"Gudang"}),
                Some("Alasan tidak berlaku untuk jenis mutasi ini."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":0,"tempat_tujuan":"Gudang"}),
                Some("Jumlah harus bilangan bulat 1 sampai 1.000.000."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":10,"tempat_tujuan":"Gudang","tanggal":"2026-10-08"}),
                Some("Tanggal tidak boleh melewati hari ini."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":10,"tempat_tujuan":"Gudang","tanggal":"2026-02-30"}),
                Some("Tanggal tidak valid."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":10,"tempat_tujuan":"   "}),
                Some("Tempat tujuan wajib diisi."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"penerima_tipe":"Umum","keperluan":"Ujian"}),
                Some("Tempat asal wajib diisi."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","keperluan":"Ujian"}),
                Some("Pilih tipe penerima."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Tamu","keperluan":"Ujian"}),
                Some("Tipe penerima tidak dikenal."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Personil","keperluan":"Ujian"}),
                Some("Pilih penerima."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Unit","keperluan":"Ujian"}),
                Some("Nama unit penerima wajib diisi."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Divisi","keperluan":"Rapat"}),
                Some("Pilih divisi penerima."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Umum","keperluan":"  "}),
                Some("Keperluan wajib diisi."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Pemakaian","jumlah":1,"tempat_asal":"Gudang","penerima_tipe":"Umum","keperluan":"Ujian"}),
                None,
            ),
            (
                ASET,
                json!({"id_barang":"b","jenis":"Pindah","alasan":"Distribusi","jumlah":1,"tempat_asal":"Gudang","tempat_tujuan":"gudang"}),
                Some("Tempat atau kondisi tujuan harus berbeda dari asal."),
            ),
            (
                ASET,
                json!({"id_barang":"b","jenis":"Pindah","alasan":"Perubahan Kondisi","jumlah":1,"tempat_asal":"Gudang","tempat_tujuan":"gudang","kondisi_tujuan":"Rusak Ringan"}),
                None,
            ),
            (
                ASET,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Hibah","jumlah":1,"tempat_tujuan":"Gudang","kondisi_tujuan":"Patah"}),
                Some("Kondisi barang tidak dikenal."),
            ),
            (
                OBAT,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":5,"tempat_tujuan":"UKS"}),
                Some("Tanggal kedaluwarsa wajib diisi untuk barang ini."),
            ),
            (
                OBAT,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":5,"tempat_tujuan":"UKS","tanggal_expired":"2027-15-01"}),
                Some("Tanggal kedaluwarsa tidak valid."),
            ),
            (
                OBAT,
                json!({"id_barang":"b","jenis":"Pindah","alasan":"Distribusi","jumlah":5,"tempat_asal":"Gudang","tempat_tujuan":"UKS"}),
                Some("Pilih batch barang yang dikeluarkan."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengadaan","jumlah":1,"tempat_tujuan":"Gudang","harga_satuan":-5}),
                Some("Harga satuan tidak valid."),
            ),
        ];
        for (barang, value, expected) in cases {
            let label = value.to_string();
            let result = validate_mutation(&draft(value), barang, HARI_INI);
            match expected {
                None => assert!(result.is_ok(), "{label}: {result:?}"),
                Some(message) => assert_eq!(result.unwrap_err(), message, "{label}"),
            }
        }
    }

    #[test]
    fn validate_mutation_normalizes_irrelevant_fields() {
        let valid = validate_mutation(
            &draft(json!({
                "id_barang": "b", "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 3,
                "tempat_asal": "Gudang", "tempat_tujuan": "  Ruang   TU ", "kondisi_tujuan": "Rusak Berat",
                "id_batch": "x", "tanggal_expired": "2027-01-01", "penerima_tipe": "Umum"
            })),
            HABIS_PAKAI,
            HARI_INI,
        )
        .expect("sah");
        assert_eq!(valid.tanggal, HARI_INI);
        assert_eq!(valid.tempat_asal, None);
        assert_eq!(valid.tempat_tujuan.as_deref(), Some("Ruang TU"));
        // Barang habis pakai selalu berkondisi Baik.
        assert_eq!(valid.kondisi_tujuan.as_deref(), Some("Baik"));
        assert_eq!(valid.id_batch, None);
        assert_eq!(valid.tanggal_expired, None);
        assert_eq!(valid.penerima_tipe, None);
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_BARANG).
    #[test]
    fn validate_barang_vectors() {
        let cases: Vec<(Value, Option<&str>)> = vec![
            (
                json!({"nama_barang":"Spidol","tipe":"Habis Pakai","satuan":"pcs"}),
                None,
            ),
            (
                json!({"nama_barang":"  ","tipe":"Habis Pakai","satuan":"pcs"}),
                Some("Nama barang wajib diisi."),
            ),
            (
                json!({"nama_barang":"Spidol","tipe":"Medis","satuan":"pcs"}),
                Some("Tipe barang tidak dikenal."),
            ),
            (
                json!({"nama_barang":"Spidol","tipe":"Aset","satuan":""}),
                Some("Satuan wajib diisi."),
            ),
            (
                json!({"nama_barang":"Spidol","tipe":"Aset","satuan":"pcs","stok_minimum":-1}),
                Some("Stok minimum tidak valid."),
            ),
            (
                json!({"nama_barang":"Spidol","tipe":"Aset","satuan":"pcs","kode_barang":"K".repeat(31)}),
                Some("Kode barang maksimal 30 karakter."),
            ),
        ];
        for (value, expected) in cases {
            let label = value.to_string();
            let parsed: BarangDraft = serde_json::from_value(value).expect("draft barang");
            match expected {
                None => assert!(validate_barang(&parsed).is_ok(), "{label}"),
                Some(message) => {
                    assert_eq!(validate_barang(&parsed).unwrap_err(), message, "{label}")
                }
            }
        }
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_FASE_2).
    #[test]
    fn phase_two_rule_vectors() {
        for (alasan, izin) in [
            ("Pemakaian", "inventory.record"),
            ("Peminjaman", "inventory.record"),
            ("Pengembalian", "inventory.record"),
            ("Rusak/Afkir", "inventory.adjust"),
            ("Hilang", "inventory.adjust"),
            ("Kedaluwarsa", "inventory.adjust"),
            ("Selisih Opname", "inventory.adjust"),
            ("Pembatalan", "inventory.adjust"),
            ("", "inventory.record"),
        ] {
            assert_eq!(izin_untuk_alasan(alasan), izin, "alasan {alasan:?}");
        }
        for (sisa, status) in [
            (-1, "Kedaluwarsa"),
            (0, "Waspada"),
            (30, "Waspada"),
            (31, "Aman"),
        ] {
            assert_eq!(status_kedaluwarsa(sisa), status, "sisa {sisa}");
        }
        assert!(stok_menipis(4, 5));
        assert!(!stok_menipis(5, 5));
        assert!(!stok_menipis(0, 0));

        let cases: Vec<(BarangInfo, Value, Option<&str>)> = vec![
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengembalian","jumlah":1,"tempat_tujuan":"Gudang"}),
                Some("Pilih peminjaman yang dikembalikan."),
            ),
            (
                OBAT,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Pengembalian","jumlah":1,"tempat_tujuan":"UKS","id_ref":"mts-1"}),
                None,
            ),
            (
                OBAT,
                json!({"id_barang":"b","jenis":"Masuk","alasan":"Selisih Opname","jumlah":1,"tempat_tujuan":"UKS"}),
                Some("Pilih batch tujuan barang ini."),
            ),
            (
                HABIS_PAKAI,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Peminjaman","jumlah":1,"tempat_asal":"Gudang","keperluan":"KBM"}),
                Some("Pilih tipe penerima."),
            ),
            (
                ASET,
                json!({"id_barang":"b","jenis":"Keluar","alasan":"Hilang","jumlah":1,"tempat_asal":"Gudang"}),
                None,
            ),
        ];
        for (barang, value, expected) in cases {
            let label = value.to_string();
            let result = validate_mutation(&draft(value), barang, HARI_INI);
            match expected {
                None => assert!(result.is_ok(), "{label}: {result:?}"),
                Some(message) => assert_eq!(result.unwrap_err(), message, "{label}"),
            }
        }
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_OPNAME).
    #[test]
    fn validate_opname_vectors() {
        let cases: Vec<(Value, Option<&str>)> = vec![
            (
                json!({"tempat":" Gudang ","baris":[{"id_barang":"b","fisik":3}]}),
                None,
            ),
            (
                json!({"tempat":"","baris":[{"id_barang":"b","fisik":3}]}),
                Some("Pilih tempat yang diopname."),
            ),
            (
                json!({"tempat":"Gudang","baris":[]}),
                Some("Belum ada barang yang dihitung."),
            ),
            (
                json!({"tempat":"Gudang","baris":[{"id_barang":" ","fisik":3}]}),
                Some("Barang pada baris opname tidak valid."),
            ),
            (
                json!({"tempat":"Gudang","baris":[{"id_barang":"b","kondisi":"Patah","fisik":3}]}),
                Some("Kondisi barang tidak dikenal."),
            ),
            (
                json!({"tempat":"Gudang","baris":[{"id_barang":"b","fisik":-1}]}),
                Some("Jumlah fisik harus 0 sampai 1.000.000."),
            ),
            (
                json!({"tempat":"Gudang","baris":[{"id_barang":"b","fisik":1},{"id_barang":"b","kondisi":"Baik","fisik":2}]}),
                Some("Barang yang sama tercatat dua kali dalam opname ini."),
            ),
        ];
        for (value, expected) in cases {
            let label = value.to_string();
            let parsed: OpnameDraft = serde_json::from_value(value).expect("draft opname");
            match expected {
                None => assert!(validate_opname(&parsed).is_ok(), "{label}"),
                Some(message) => {
                    assert_eq!(validate_opname(&parsed).unwrap_err(), message, "{label}")
                }
            }
        }
    }

    #[test]
    fn divisi_penerima_memakai_ejaan_data_personil() {
        let (_directory, state) = setup_state();
        let connection = storage::database(&state.data_dir).expect("db");
        connection
            .execute_batch(
                "INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif)
                 VALUES ('k1', 'Ani', 'Keuangan', 1, 'Aktif'),
                        ('k2', 'Budi', 'keuangan ', 1, 'Aktif'),
                        ('k3', 'Cici', 'Gudang Lama', 1, 'Nonaktif');",
            )
            .expect("personil");
        let id_barang = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-awal", &id_barang, "Masuk", 10);

        let penerima = list_recipients(&state).expect("penerima");
        assert_eq!(penerima["divisi"], json!(["Keuangan"]));
        assert_eq!(penerima["personil"][0]["divisi"], "Keuangan");

        let keluar = |nama: &str| {
            record_mutation(
                &state,
                "admin",
                json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Pemakaian", "jumlah": 1,
                       "tempat_asal": "Gudang", "penerima_tipe": "Divisi", "penerima_nama": nama,
                       "keperluan": "Rapat"}),
            )
        };
        let id_mutasi = keluar("KEUANGAN").expect("divisi dikenal")["id_mutasi"]
            .as_str()
            .unwrap()
            .to_owned();
        let tersimpan: (String, Option<String>) = connection
            .query_row(
                "SELECT penerima_nama, penerima_id FROM inventory_mutasi WHERE id_mutasi = ?;",
                [&id_mutasi],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("mutasi");
        assert_eq!(tersimpan, ("Keuangan".to_owned(), None));

        // Divisi yang hanya dimiliki personil nonaktif tidak bisa dipilih.
        assert_eq!(keluar("Gudang Lama").unwrap_err().message, "Divisi tidak ditemukan.");
        assert_eq!(stok(&state, &id_barang), 9);
    }

    fn pinjamkan(state: &DesktopState, id_barang: &str, jumlah: i64) -> String {
        record_mutation(
            state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Peminjaman", "jumlah": jumlah,
                   "tempat_asal": "Gudang", "penerima_tipe": "Unit", "penerima_nama": "Lab IPA", "keperluan": "KBM"}),
        )
        .expect("pinjam")["id_mutasi"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn kembalikan(
        state: &DesktopState,
        id_barang: &str,
        id_pinjam: &str,
        jumlah: i64,
    ) -> Result<Value, CommandError> {
        record_mutation(
            state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengembalian", "jumlah": jumlah,
                   "tempat_tujuan": "Gudang", "id_ref": id_pinjam}),
        )
    }

    #[test]
    fn loans_track_partial_returns() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Aset", false);
        insert_raw_mutation(&state, "mts-awal", &id_barang, "Masuk", 10);
        let id_pinjam = pinjamkan(&state, &id_barang, 5);
        assert_eq!(stok(&state, &id_barang), 5);

        kembalikan(&state, &id_barang, &id_pinjam, 3).expect("kembali sebagian");
        let loans = list_loans(&state).unwrap();
        let baris = loans["baris"].as_array().unwrap();
        assert_eq!(baris.len(), 1);
        assert_eq!(baris[0]["sisa"], 2);
        assert_eq!(baris[0]["penerima_nama"], "Lab IPA");

        let lebih = kembalikan(&state, &id_barang, &id_pinjam, 3).unwrap_err();
        assert_eq!(lebih.message, "Sisa yang belum kembali hanya 2 pcs.");
        let batal = cancel_mutation(&state, "admin", &id_pinjam, "Salah").unwrap_err();
        assert_eq!(batal.message, "Batalkan dulu pengembalian peminjaman ini.");

        kembalikan(&state, &id_barang, &id_pinjam, 2).expect("kembali penuh");
        assert_eq!(
            list_loans(&state).unwrap()["baris"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(stok(&state, &id_barang), 10);
    }

    #[test]
    fn expirable_return_goes_back_to_its_batch() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", true);
        let masuk = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 6,
                   "tempat_tujuan": "Gudang", "tanggal_expired": "2027-03-01"}),
        )
        .unwrap();
        let batch = masuk["id_mutasi"].as_str().unwrap().to_owned();
        let id_pinjam = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Peminjaman", "jumlah": 2,
                   "tempat_asal": "Gudang", "id_batch": batch, "penerima_tipe": "Umum", "keperluan": "Praktik"}),
        )
        .unwrap()["id_mutasi"]
            .as_str()
            .unwrap()
            .to_owned();
        kembalikan(&state, &id_barang, &id_pinjam, 2).expect("kembali");
        let list = list_inventory(&state).unwrap();
        let item = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id_barang"] == id_barang)
            .unwrap()
            .clone();
        let posisi = item["posisi"].as_array().unwrap();
        assert_eq!(posisi.len(), 1, "tidak boleh lahir batch baru: {posisi:?}");
        assert_eq!(posisi[0]["saldo"], 6);
        assert_eq!(posisi[0]["id_batch"], batch.as_str());
    }

    #[test]
    fn opname_writes_differences_with_one_document_number() {
        let (_directory, state) = setup_state();
        let a = insert_item(&state, "Habis Pakai", false);
        let b = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-a", &a, "Masuk", 10);
        insert_raw_mutation(&state, "mts-b", &b, "Masuk", 4);
        let hasil = record_opname(
            &state,
            "admin",
            json!({"tempat": "gudang", "baris": [
                {"id_barang": a, "fisik": 7},
                {"id_barang": b, "fisik": 4}
            ]}),
        )
        .expect("opname");
        assert_eq!(hasil["jumlah_selisih"], 1);
        assert_eq!(stok(&state, &a), 7);
        assert_eq!(stok(&state, &b), 4);
        let nomor = hasil["nomor_dokumen"].as_str().unwrap().to_owned();
        assert!(nomor.starts_with("OPN-"), "{nomor}");
        let connection = storage::database(&state.data_dir).unwrap();
        let (alasan, jumlah, dokumen): (String, i64, String) = connection
            .query_row(
                "SELECT alasan, jumlah, nomor_dokumen FROM inventory_mutasi WHERE id_barang = ? AND jenis = 'Keluar';",
                params![a],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (alasan.as_str(), jumlah, dokumen.as_str()),
            ("Selisih Opname", 3, nomor.as_str())
        );
    }

    #[test]
    fn list_reports_expiry_status_and_low_stock() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", true);
        let connection = storage::database(&state.data_dir).unwrap();
        connection
            .execute(
                "UPDATE inventory_barang SET stok_minimum = 10 WHERE id_barang = ?;",
                params![id_barang],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
                    tempat_tujuan, kondisi_tujuan, id_batch, tanggal_expired, dicatat_oleh)
                 VALUES ('mts-lama', ?1, 'Masuk', 'Pengadaan', '2026-01-01', 3, 'UKS', 'Baik', 'mts-lama',
                         date('now', '+7 hours', '-1 day'), 'uji'),
                        ('mts-hampir', ?1, 'Masuk', 'Pengadaan', '2026-01-01', 2, 'UKS', 'Baik', 'mts-hampir',
                         date('now', '+7 hours'), 'uji');",
                params![id_barang],
            )
            .unwrap();
        let list = list_inventory(&state).unwrap();
        let item = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id_barang"] == id_barang)
            .unwrap()
            .clone();
        assert_eq!(item["stok_menipis"], true);
        let status: Vec<(&str, i64)> = item["posisi"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["status_kedaluwarsa"].as_str().unwrap(),
                    p["sisa_hari"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(status, vec![("Kedaluwarsa", -1), ("Waspada", 0)]);
        assert!(list["hari_ini"].as_str().is_some_and(is_valid_date));
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_FASE_3).
    #[test]
    fn phase_three_rule_vectors() {
        for (alasan, jenis) in [
            ("Pemakaian", Some("Serah Terima")),
            ("Peminjaman", Some("Serah Terima")),
            ("Distribusi", Some("Serah Terima")),
            ("Kedaluwarsa", Some("Pemusnahan")),
            ("Rusak/Afkir", Some("Pemusnahan")),
            ("Hilang", Some("Pemusnahan")),
            ("Selisih Opname", Some("Opname")),
            ("Pengadaan", None),
            ("Pembatalan", None),
        ] {
            assert_eq!(jenis_berita_acara(alasan), jenis, "alasan {alasan:?}");
        }
        let rows = vec![
            ("BOSP Reguler".to_owned(), 50_000, false),
            ("".to_owned(), 0, true),
            ("BOSP Reguler".to_owned(), 25_000, false),
            ("  ".to_owned(), 10_000, false),
            ("Komite".to_owned(), 0, true),
        ];
        assert_eq!(
            rekap_sumber_dana(&rows),
            vec![
                RekapSumberDana {
                    sumber_dana: "BOSP Reguler".into(),
                    baris: 2,
                    nilai: 75_000,
                    tanpa_harga: 0
                },
                RekapSumberDana {
                    sumber_dana: "Tanpa sumber dana".into(),
                    baris: 2,
                    nilai: 10_000,
                    tanpa_harga: 1
                },
                RekapSumberDana {
                    sumber_dana: "Komite".into(),
                    baris: 1,
                    nilai: 0,
                    tanpa_harga: 1
                },
            ]
        );
    }

    #[test]
    fn document_groups_by_number_and_skips_cancelled_rows() {
        let (_directory, state) = setup_state();
        let connection = storage::database(&state.data_dir).unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO company_profile (id, company_name, leader_name, leader_nip, updated_at)
                 VALUES ('default_company', 'SMK Contoh', 'Ibu Kepala', '1987', datetime('now'));",
                [],
            )
            .unwrap();
        let a = insert_item(&state, "Habis Pakai", false);
        let b = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-a", &a, "Masuk", 10);
        insert_raw_mutation(&state, "mts-b", &b, "Masuk", 10);
        let keluar = |id_barang: &str, nomor: &str| {
            record_mutation(
                &state,
                "admin",
                json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Pemakaian", "jumlah": 2,
                       "tempat_asal": "Gudang", "penerima_tipe": "Unit", "penerima_nama": "Panitia PTS",
                       "keperluan": "PTS Ganjil", "nomor_dokumen": nomor}),
            )
            .unwrap()["id_mutasi"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let pertama = keluar(&a, "BA-01");
        let kedua = keluar(&b, "BA-01");
        let lain = keluar(&a, "BA-02");
        cancel_mutation(&state, "admin", &kedua, "Salah barang").unwrap();

        let dok = document(&state, &pertama).unwrap();
        assert_eq!(dok["jenis"], "Serah Terima");
        assert_eq!(dok["nomor_dokumen"], "BA-01");
        assert_eq!(dok["penerima_nama"], "Panitia PTS");
        assert_eq!(dok["kop"]["nama"], "SMK Contoh");
        assert_eq!(dok["kop"]["kepala_nama"], "Ibu Kepala");
        let ids: Vec<&str> = dok["baris"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id_mutasi"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![pertama.as_str()],
            "baris yang dibatalkan dan nomor lain tidak ikut"
        );
        assert!(!ids.contains(&lain.as_str()));

        assert_eq!(
            document(&state, &kedua).unwrap_err().message,
            "Mutasi ini sudah dibatalkan, berita acaranya tidak bisa dicetak."
        );
        assert_eq!(
            document(&state, "mts-a").unwrap_err().message,
            "Mutasi ini tidak punya berita acara."
        );
    }

    #[test]
    fn procurement_sums_value_per_source_without_cancelled_rows() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        let masuk = |jumlah: i64, harga: Option<i64>, sumber: &str| {
            record_mutation(
                &state,
                "admin",
                json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": jumlah,
                       "tempat_tujuan": "Gudang", "harga_satuan": harga, "sumber_dana": sumber}),
            )
            .unwrap()["id_mutasi"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        masuk(10, Some(5_000), "BOSP Reguler");
        masuk(2, None, "Komite");
        let batal = masuk(4, Some(1_000), "BOSP Reguler");
        cancel_mutation(&state, "admin", &batal, "Dobel").unwrap();
        let hari_ini = wib_today(&storage::database(&state.data_dir).unwrap());
        let rekap = procurement(&state, "2000-01-01", &hari_ini).unwrap();
        assert_eq!(rekap["baris"].as_array().unwrap().len(), 2);
        assert_eq!(rekap["total_nilai"], 50_000);
        assert_eq!(rekap["rekap"][0]["sumber_dana"], "BOSP Reguler");
        assert_eq!(rekap["rekap"][1]["tanpa_harga"], 1);
        assert_eq!(
            procurement(&state, "2026-02-01", "2026-01-01")
                .unwrap_err()
                .message,
            "Tanggal awal tidak boleh setelah tanggal akhir."
        );
    }

    #[test]
    fn opname_history_lists_sessions_with_differences() {
        let (_directory, state) = setup_state();
        let a = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-a", &a, "Masuk", 10);
        let hasil = record_opname(
            &state,
            "admin",
            json!({"tempat": "Gudang", "baris": [{"id_barang": a, "fisik": 8}]}),
        )
        .unwrap();
        let riwayat = opname_history(&state).unwrap();
        let daftar = riwayat["riwayat"].as_array().unwrap();
        assert_eq!(daftar.len(), 1);
        assert_eq!(daftar[0]["nomor_dokumen"], hasil["nomor_dokumen"]);
        assert_eq!(daftar[0]["tempat"], "Gudang");
        let dok = document(&state, daftar[0]["id_mutasi"].as_str().unwrap()).unwrap();
        assert_eq!(dok["jenis"], "Opname");
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_AWALAN).
    #[test]
    fn kode_prefix_vectors() {
        for (input, expected) in [
            ("uks", Some("UKS")),
            (" Lab1 ", Some("LAB1")),
            ("ABCDEFG", None),
            ("", None),
            ("U-K", None),
            ("ÜKS", None),
        ] {
            assert_eq!(
                normalize_kode_prefix(input).as_deref(),
                expected,
                "input {input:?}"
            );
        }
        assert_eq!(parse_kode_prefixes(None), vec!["BRG"]);
        assert_eq!(parse_kode_prefixes(Some("bukan json")), vec!["BRG"]);
        assert_eq!(
            parse_kode_prefixes(Some(r#"["uks","UKS","x-y","lab"]"#)),
            vec!["UKS", "LAB"]
        );
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            validate_kode_prefixes(&list(&["brg", "uks"])),
            Ok(list(&["BRG", "UKS"]))
        );
        assert_eq!(
            validate_kode_prefixes(&[]).unwrap_err(),
            "Daftarkan minimal satu awalan kode."
        );
        assert_eq!(
            validate_kode_prefixes(&list(&["UKS", "uks"])).unwrap_err(),
            "Awalan \"UKS\" terdaftar dua kali."
        );
        assert_eq!(
            validate_kode_prefixes(&list(&["U K"])).unwrap_err(),
            "Awalan \"U K\" tidak valid. Gunakan 1 sampai 6 huruf atau angka."
        );
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_NOMOR_KODE).
    #[test]
    fn next_kode_number_vectors() {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(next_kode_number("UKS", &list(&[])), 1);
        assert_eq!(
            next_kode_number(
                "UKS",
                &list(&[
                    "UKS-0001",
                    "uks-0009",
                    "UKS-LEMARI",
                    "UKSX-0050",
                    "BRG-0100"
                ])
            ),
            10
        );
        assert_eq!(next_kode_number("LAB", &list(&["LAB-12345"])), 12346);
        assert_eq!(format_kode_barang("UKS", 7), "UKS-0007");
        assert_eq!(format_kode_barang("UKS", 12345), "UKS-12345");
    }

    #[test]
    fn automatic_codes_are_sequential_per_prefix() {
        let (_directory, state) = setup_state();
        save_code_prefixes(&state, vec!["BRG".into(), "UKS".into()]).expect("simpan awalan");
        let simpan = |prefix: Option<&str>| {
            save_item(
                &state,
                json!({"nama_barang": "Obat", "tipe": "Habis Pakai", "satuan": "strip", "kode_prefix": prefix}),
            )
        };
        assert_eq!(simpan(Some("uks")).unwrap()["kode_barang"], "UKS-0001");
        assert_eq!(simpan(Some("UKS")).unwrap()["kode_barang"], "UKS-0002");
        // Tanpa awalan, awalan pertama di daftar yang dipakai.
        assert_eq!(simpan(None).unwrap()["kode_barang"], "BRG-0001");
        assert_eq!(
            simpan(Some("LAB")).unwrap_err().message,
            "Awalan kode tidak terdaftar."
        );
        let list = list_inventory(&state).unwrap();
        assert_eq!(list["kode_prefix"], json!(["BRG", "UKS"]));
    }

    #[test]
    fn duplicate_codes_from_offline_devices_are_flagged() {
        let (_directory, state) = setup_state();
        let connection = storage::database(&state.data_dir).unwrap();
        // Dua perangkat offline sama-sama menerbitkan UKS-0005; baris keduanya
        // tiba lewat snapshot.
        connection
            .execute_batch(
                "INSERT INTO inventory_barang (id_barang, kode_barang, nama_barang, tipe, satuan)
                 VALUES ('brg-a', 'UKS-0005', 'Paracetamol', 'Habis Pakai', 'strip'),
                        ('brg-b', 'uks-0005', 'Betadine', 'Habis Pakai', 'botol'),
                        ('brg-c', 'UKS-0006', 'Perban', 'Habis Pakai', 'gulung');",
            )
            .unwrap();
        let list = list_inventory(&state).unwrap();
        let ganda: Vec<(String, bool)> = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["id_barang"].as_str().unwrap().to_owned(),
                    item["kode_ganda"].as_bool().unwrap(),
                )
            })
            .collect();
        assert!(ganda.contains(&("brg-a".into(), true)));
        assert!(ganda.contains(&("brg-b".into(), true)));
        assert!(ganda.contains(&("brg-c".into(), false)));
    }

    #[test]
    fn draft_rejects_unknown_keys() {
        // `dicatat_oleh` selalu diambil dari sesi; payload yang mencoba
        // mengisinya ditolak, sama dengan Zod `.strict()` di Web.
        let result: Result<MutasiDraft, _> = serde_json::from_value(json!({
            "id_barang": "b", "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 1,
            "tempat_tujuan": "Gudang", "dicatat_oleh": "orang-lain"
        }));
        assert!(result.is_err());
    }

    // Vektor kembar dengan `validations/inventory.test.ts` (VEKTOR_PEMBATALAN).
    #[test]
    fn build_cancellation_swaps_sides() {
        let asal = MutasiAsal {
            id_mutasi: "mts-1".into(),
            jenis: "Pindah".into(),
            alasan: "Distribusi".into(),
            jumlah: 30,
            tempat_asal: Some("Gudang".into()),
            kondisi_asal: Some("Baik".into()),
            tempat_tujuan: Some("Kelas X".into()),
            kondisi_tujuan: Some("Baik".into()),
            id_batch: None,
        };
        let kebalikan = build_cancellation(&asal).expect("bisa dibatalkan");
        assert_eq!(kebalikan.id_mutasi, "batal-mts-1");
        assert_eq!(kebalikan.jenis, "Pindah");
        assert_eq!(kebalikan.alasan, "Pembatalan");
        assert_eq!(kebalikan.tempat_asal.as_deref(), Some("Kelas X"));
        assert_eq!(kebalikan.tempat_tujuan.as_deref(), Some("Gudang"));

        let masuk = MutasiAsal {
            jenis: "Masuk".into(),
            alasan: "Pengadaan".into(),
            tempat_asal: None,
            kondisi_asal: None,
            ..asal.clone()
        };
        assert_eq!(build_cancellation(&masuk).unwrap().jenis, "Keluar");
        let batal = MutasiAsal {
            alasan: "Pembatalan".into(),
            ..asal
        };
        assert_eq!(
            build_cancellation(&batal).unwrap_err(),
            "Pembatalan tidak bisa dibatalkan lagi."
        );
    }

    fn insert_item(state: &DesktopState, tipe: &str, bisa_expired: bool) -> String {
        save_item(
            state,
            json!({
                "nama_barang": "Barang Uji", "tipe": tipe, "satuan": "pcs",
                "bisa_expired": bisa_expired, "tempat_utama": "Gudang"
            }),
        )
        .expect("simpan barang")["id_barang"]
            .as_str()
            .expect("id barang")
            .to_owned()
    }

    fn stok(state: &DesktopState, id_barang: &str) -> i64 {
        let list = list_inventory(state).expect("daftar");
        list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id_barang"] == id_barang)
            .map(|item| item["stok_total"].as_i64().unwrap())
            .unwrap()
    }

    fn insert_raw_mutation(
        state: &DesktopState,
        id: &str,
        id_barang: &str,
        jenis: &str,
        jumlah: i64,
    ) {
        let connection = storage::database(&state.data_dir).unwrap();
        let (asal, tujuan) = match jenis {
            "Masuk" => (None, Some("Gudang")),
            _ => (Some("Gudang"), None),
        };
        connection
            .execute(
                "INSERT INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
                    tempat_asal, kondisi_asal, tempat_tujuan, kondisi_tujuan, dicatat_oleh)
                 VALUES (?, ?, ?, ?, '2026-10-01', ?, ?, ?, ?, ?, 'uji');",
                params![
                    id,
                    id_barang,
                    jenis,
                    if jenis == "Masuk" { "Pengadaan" } else { "Pemakaian" },
                    jumlah,
                    asal,
                    asal.map(|_| "Baik"),
                    tujuan,
                    tujuan.map(|_| "Baik"),
                ],
            )
            .unwrap();
    }

    // Vektor kembar dengan `validasiUnit` / `validasiUnitEdit` di
    // `validations/inventory.test.ts`.
    #[test]
    fn unit_rule_vectors() {
        let units = |list: &[&str]| list.iter().map(|u| (*u).to_owned()).collect::<Vec<_>>();
        let cek = |dilacak: bool, per_unit: bool, tipe: &str, expired: bool, jenis: &str, alasan: &str, jumlah: i64, unit: Vec<String>| {
            validate_unit_rules(&AturanUnit {
                dilacak,
                per_unit,
                tipe,
                bisa_expired: expired,
                jenis,
                alasan,
                jumlah,
                unit: &unit,
            })
        };
        assert_eq!(cek(false, false, "Aset", false, "Keluar", "Pemakaian", 1, vec![]), Ok(vec![]));
        assert_eq!(
            cek(false, false, "Aset", false, "Keluar", "Pemakaian", 1, units(&["u1"])),
            Err("Barang ini tidak dicatat per unit.".into())
        );
        assert_eq!(
            cek(false, true, "Habis Pakai", false, "Masuk", "Pengadaan", 1, vec![]),
            Err("Pencatatan per unit hanya untuk aset tanpa kedaluwarsa yang dicatat masuk.".into())
        );
        assert_eq!(
            cek(false, true, "Aset", true, "Masuk", "Pengadaan", 1, vec![]),
            Err("Pencatatan per unit hanya untuk aset tanpa kedaluwarsa yang dicatat masuk.".into())
        );
        assert_eq!(
            cek(false, true, "Aset", false, "Keluar", "Pemakaian", 1, vec![]),
            Err("Pencatatan per unit hanya untuk aset tanpa kedaluwarsa yang dicatat masuk.".into())
        );
        assert_eq!(cek(false, true, "Aset", false, "Masuk", "Pengadaan", 3, vec![]), Ok(vec![]));
        assert_eq!(
            cek(true, false, "Aset", false, "Masuk", "Pengadaan", 201, vec![]),
            Err("Paling banyak 200 unit sekali catat.".into())
        );
        assert_eq!(
            cek(true, false, "Aset", false, "Masuk", "Pengadaan", 1, units(&["u1"])),
            Err("Unit baru dibuat otomatis saat barang masuk.".into())
        );
        assert_eq!(cek(true, false, "Aset", false, "Masuk", "Pengembalian", 1, vec![]), Ok(vec![]));
        assert_eq!(
            cek(true, false, "Aset", false, "Keluar", "Peminjaman", 1, vec![]),
            Err("Pilih unit yang dicatat.".into())
        );
        assert_eq!(
            cek(true, false, "Aset", false, "Pindah", "Distribusi", 2, units(&["u1", " u1 "])),
            Err("Unit yang sama dipilih dua kali.".into())
        );
        assert_eq!(
            cek(true, false, "Aset", false, "Keluar", "Hilang", 3, units(&["u1", "u2"])),
            Err("Jumlah harus sama dengan banyaknya unit yang dipilih.".into())
        );
        assert_eq!(
            cek(true, false, "Aset", false, "Keluar", "Hilang", 2, units(&[" u1", "u2 ", ""])),
            Ok(units(&["u1", "u2"]))
        );

        assert_eq!(format_kode_unit("LAP-0003", 2), "LAP-0003-02");
        assert_eq!(format_kode_unit("LAP-0003", 120), "LAP-0003-120");

        let edit = |seri: Option<&str>, catatan: Option<&str>| {
            validate_unit_edit(&UnitDraft {
                id_unit: "u1".into(),
                nomor_seri: seri.map(str::to_owned),
                catatan: catatan.map(str::to_owned),
            })
        };
        assert_eq!(edit(Some("  SN-01 "), Some(" ")), Ok((Some("SN-01".into()), None)));
        assert_eq!(edit(Some(&"x".repeat(61)), None), Err("Nomor seri maksimal 60 karakter.".into()));
        assert_eq!(edit(None, Some(&"x".repeat(201))), Err("Catatan unit maksimal 200 karakter.".into()));
    }

    #[test]
    fn registration_rows_cannot_be_cancelled() {
        let asal = |jenis: &str| MutasiAsal {
            id_mutasi: "m1".into(),
            jenis: jenis.into(),
            alasan: "Distribusi".into(),
            jumlah: 1,
            ..MutasiAsal::default()
        };
        assert_eq!(
            build_cancellation(&asal("Keluar")),
            Err("Pendaftaran unit tidak bisa dibatalkan.".into())
        );
        assert_eq!(
            build_cancellation(&asal("Masuk")),
            Err("Pendaftaran unit tidak bisa dibatalkan.".into())
        );
        assert!(build_cancellation(&asal("Pindah")).is_ok());
    }

    fn unit_barang(state: &DesktopState, id_barang: &str) -> Vec<(String, String, String, i64)> {
        let list = list_inventory(state).expect("daftar");
        let item = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id_barang"] == id_barang)
            .unwrap()
            .clone();
        item["posisi"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|posisi| !posisi["kode_unit"].is_null())
            .map(|posisi| {
                (
                    posisi["id_batch"].as_str().unwrap().to_owned(),
                    posisi["kode_unit"].as_str().unwrap().to_owned(),
                    posisi["tempat"].as_str().unwrap().to_owned(),
                    posisi["saldo"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn per_unit_entry_creates_units_and_moves_them_one_by_one() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Aset", false);
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 3,
                   "tempat_tujuan": "Lab", "per_unit": true}),
        )
        .expect("masuk per unit");
        let units = unit_barang(&state, &id_barang);
        assert_eq!(units.len(), 3);
        let kode: Vec<&str> = units.iter().map(|u| u.1.as_str()).collect();
        assert_eq!(kode, vec!["BRG-0001-01", "BRG-0001-02", "BRG-0001-03"]);
        assert!(units.iter().all(|u| u.3 == 1));
        let connection = storage::database(&state.data_dir).unwrap();
        let nomor: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT nomor_dokumen) FROM inventory_mutasi WHERE id_barang = ? AND nomor_dokumen LIKE 'UNT-%';",
                params![id_barang],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nomor, 1, "satu aksi berbagi satu nomor dokumen");
        let outbox: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE domain = 'inventory-unit';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(outbox, 3);

        // Barang yang sudah dilacak menolak keluar tanpa memilih unit.
        let galat = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Pindah", "alasan": "Distribusi", "jumlah": 1,
                   "tempat_asal": "Lab", "tempat_tujuan": "TU"}),
        )
        .unwrap_err();
        assert_eq!(galat.message, "Pilih unit yang dicatat.");

        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Pindah", "alasan": "Distribusi", "jumlah": 1,
                   "tempat_asal": "Lab", "tempat_tujuan": "TU", "unit": [units[1].0.clone()]}),
        )
        .expect("pindah satu unit");
        let sesudah = unit_barang(&state, &id_barang);
        let pindah = sesudah.iter().find(|u| u.0 == units[1].0).unwrap();
        assert_eq!(pindah.2, "TU");
        assert_eq!(stok(&state, &id_barang), 3);

        // Unit yang sudah pindah tidak bisa dikeluarkan lagi dari tempat lama.
        let galat = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Hilang", "jumlah": 1,
                   "tempat_asal": "Lab", "unit": [units[1].0.clone()]}),
        )
        .unwrap_err();
        assert_eq!(galat.message, "Stok di Lab (Baik) hanya 0 pcs.");

        // Peminjaman per unit kembali ke unit yang sama.
        let pinjam = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Peminjaman", "jumlah": 1,
                   "tempat_asal": "Lab", "unit": [units[0].0.clone()], "penerima_tipe": "Unit",
                   "penerima_nama": "Kelas X-A", "keperluan": "Presentasi"}),
        )
        .expect("pinjam unit")["id_mutasi"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!unit_barang(&state, &id_barang).iter().any(|u| u.0 == units[0].0));
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengembalian", "jumlah": 1,
                   "tempat_tujuan": "Lab", "id_ref": pinjam}),
        )
        .expect("kembali");
        assert!(unit_barang(&state, &id_barang).iter().any(|u| u.0 == units[0].0 && u.3 == 1));

        save_unit(&state, json!({"id_unit": units[2].0, "nomor_seri": "SN-778"})).expect("seri");
        let seri: String = connection
            .query_row(
                "SELECT nomor_seri FROM inventory_unit WHERE id_unit = ?;",
                params![units[2].0],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seri, "SN-778");
    }

    #[test]
    fn register_units_converts_pool_stock_without_changing_totals() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Aset", false);
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Saldo Awal", "jumlah": 2, "tempat_tujuan": "Lab"}),
        )
        .expect("masuk");
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Saldo Awal", "jumlah": 1,
                   "tempat_tujuan": "TU", "kondisi_tujuan": "Rusak Ringan"}),
        )
        .expect("masuk rusak");
        let hasil = register_units(&state, "admin", &id_barang).expect("daftar");
        assert_eq!(hasil["jumlah"], 3);
        assert_eq!(stok(&state, &id_barang), 3);
        let units = unit_barang(&state, &id_barang);
        assert_eq!(units.len(), 3);
        assert_eq!(units.iter().filter(|u| u.2 == "TU").count(), 1);
        let list = list_inventory(&state).unwrap();
        let item = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id_barang"] == id_barang)
            .unwrap()
            .clone();
        assert_eq!(item["dilacak_unit"], true);
        assert!(
            item["posisi"].as_array().unwrap().iter().all(|p| !p["kode_unit"].is_null()),
            "tidak ada stok tanpa unit yang tersisa"
        );

        assert_eq!(
            register_units(&state, "admin", &id_barang).unwrap_err().message,
            "Tidak ada stok yang belum terdaftar sebagai unit."
        );
        let connection = storage::database(&state.data_dir).unwrap();
        let keluar: String = connection
            .query_row(
                "SELECT id_mutasi FROM inventory_mutasi WHERE id_barang = ? AND jenis = 'Keluar' AND alasan = 'Distribusi' LIMIT 1;",
                params![id_barang],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            cancel_mutation(&state, "admin", &keluar, "salah").unwrap_err().message,
            "Pendaftaran unit tidak bisa dibatalkan."
        );
        let habis = insert_item(&state, "Habis Pakai", false);
        assert_eq!(
            register_units(&state, "admin", &habis).unwrap_err().message,
            "Hanya aset tanpa kedaluwarsa yang bisa dicatat per unit."
        );
    }

    /// Unit adalah batch-nya sendiri di opname. Sebelum diperbaiki, batch
    /// dibuang untuk barang tanpa kedaluwarsa, sehingga setiap unit (fisik 1)
    /// dibandingkan dengan stok tanpa nomor (0) dan tercatat +1.
    #[test]
    fn opname_counts_units_against_their_own_batch() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Aset", false);
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 2,
                   "tempat_tujuan": "Lab", "per_unit": true}),
        )
        .expect("masuk");
        let units = unit_barang(&state, &id_barang);
        let semua_ada = record_opname(
            &state,
            "admin",
            json!({"tempat": "Lab", "baris": [
                {"id_barang": id_barang, "kondisi": "Baik", "id_batch": units[0].0, "fisik": 1},
                {"id_barang": id_barang, "kondisi": "Baik", "id_batch": units[1].0, "fisik": 1}
            ]}),
        )
        .expect("opname lengkap");
        assert_eq!(semua_ada["jumlah_selisih"], 0);
        assert_eq!(stok(&state, &id_barang), 2);

        let galat = record_opname(
            &state,
            "admin",
            json!({"tempat": "Lab", "baris": [
                {"id_barang": id_barang, "kondisi": "Baik", "id_batch": units[0].0, "fisik": 2}
            ]}),
        )
        .unwrap_err();
        assert_eq!(galat.message, "Satu unit Barang Uji hanya bisa dihitung 0 atau 1.");

        let hilang = record_opname(
            &state,
            "admin",
            json!({"tempat": "Lab", "baris": [
                {"id_barang": id_barang, "kondisi": "Baik", "id_batch": units[0].0, "fisik": 1},
                {"id_barang": id_barang, "kondisi": "Baik", "id_batch": units[1].0, "fisik": 0}
            ]}),
        )
        .expect("opname satu hilang");
        assert_eq!(hilang["jumlah_selisih"], 1);
        assert_eq!(stok(&state, &id_barang), 1);
        let sisa = unit_barang(&state, &id_barang);
        assert_eq!(sisa.len(), 1);
        assert_eq!(sisa[0].0, units[0].0);
    }

    // Kriteria penerimaan PRD §12: dua perangkat offline mengeluarkan 2 dan 3
    // dari stok 10. Baris keduanya tiba lewat snapshot; hasilnya harus 5.
    #[test]
    fn two_offline_devices_sum_to_true_stock() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-masuk", &id_barang, "Masuk", 10);
        insert_raw_mutation(&state, "mts-hp-uks", &id_barang, "Keluar", 2);
        insert_raw_mutation(&state, "mts-laptop-tu", &id_barang, "Keluar", 3);
        assert_eq!(stok(&state, &id_barang), 5);
    }

    #[test]
    fn record_rejects_overdraw_and_canonicalizes_tempat() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 4, "tempat_tujuan": "gudang"}),
        )
        .expect("masuk");
        let error = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Pemakaian", "jumlah": 5,
                   "tempat_asal": "Gudang", "penerima_tipe": "Umum", "keperluan": "Rapat"}),
        )
        .unwrap_err();
        assert_eq!(error.message, "Stok di Gudang (Baik) hanya 4 pcs.");

        // "gudang" mengikuti ejaan "Gudang" milik tempat_utama barang.
        let list = list_inventory(&state).unwrap();
        assert_eq!(list["tempat"], json!(["Gudang"]));
    }

    #[test]
    fn record_mutation_takes_operator_from_session_and_enqueues() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        let result = record_mutation(
            &state,
            "petugas-uks",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Saldo Awal", "jumlah": 2, "tempat_tujuan": "UKS"}),
        )
        .expect("masuk");
        let id_mutasi = result["id_mutasi"].as_str().unwrap();
        let connection = storage::database(&state.data_dir).unwrap();
        let operator: String = connection
            .query_row(
                "SELECT dicatat_oleh FROM inventory_mutasi WHERE id_mutasi = ?;",
                params![id_mutasi],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operator, "petugas-uks");
        let queued: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_sync_outbox WHERE domain = 'inventory-mutation' AND entity_key = ?;",
                params![id_mutasi],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 1);
    }

    #[test]
    fn formulir_rejects_phase_two_reasons() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        let error = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Selisih Opname", "jumlah": 1, "tempat_tujuan": "Gudang"}),
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "Alasan ini belum bisa dicatat dari formulir."
        );
    }

    #[test]
    fn expirable_batches_follow_their_own_id() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", true);
        let masuk = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 10,
                   "tempat_tujuan": "Gudang", "tanggal_expired": "2027-01-31"}),
        )
        .expect("masuk");
        let batch = masuk["id_mutasi"].as_str().unwrap().to_owned();
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Pindah", "alasan": "Distribusi", "jumlah": 4,
                   "tempat_asal": "Gudang", "tempat_tujuan": "UKS", "id_batch": batch}),
        )
        .expect("pindah");
        let list = list_inventory(&state).unwrap();
        let item = list["barang"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id_barang"] == id_barang)
            .unwrap()
            .clone();
        assert_eq!(item["stok_total"], 10);
        let posisi = item["posisi"].as_array().unwrap();
        assert_eq!(posisi.len(), 2);
        assert!(posisi
            .iter()
            .all(|p| p["id_batch"] == batch.as_str() && p["tanggal_expired"] == "2027-01-31"));
    }

    #[test]
    fn cancellation_is_idempotent_and_guards_consumed_stock() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        let masuk = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 5, "tempat_tujuan": "Gudang"}),
        )
        .unwrap();
        let id_masuk = masuk["id_mutasi"].as_str().unwrap().to_owned();
        let keluar = record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Keluar", "alasan": "Pemakaian", "jumlah": 3,
                   "tempat_asal": "Gudang", "penerima_tipe": "Unit", "penerima_nama": "TU", "keperluan": "ATK"}),
        )
        .unwrap();
        let id_keluar = keluar["id_mutasi"].as_str().unwrap().to_owned();

        // Barang masuk yang sudah terpakai sebagian tidak bisa dibatalkan.
        let error = cancel_mutation(&state, "admin", &id_masuk, "Salah input").unwrap_err();
        assert!(
            error.message.contains("tidak cukup untuk membatalkan"),
            "{}",
            error.message
        );

        cancel_mutation(&state, "admin", &id_keluar, "Salah input").expect("batal");
        assert_eq!(stok(&state, &id_barang), 5);
        let again = cancel_mutation(&state, "admin", &id_keluar, "Salah input").unwrap_err();
        assert_eq!(again.message, "Mutasi ini sudah dibatalkan.");

        // Pembatalan dari perangkat lain tiba dengan PK yang sama dan diabaikan.
        let connection = storage::database(&state.data_dir).unwrap();
        let changed = connection
            .execute(
                "INSERT OR IGNORE INTO inventory_mutasi (id_mutasi, id_barang, jenis, alasan, tanggal, jumlah,
                    tempat_tujuan, kondisi_tujuan, dicatat_oleh)
                 VALUES (?, ?, 'Masuk', 'Pembatalan', '2026-10-01', 3, 'Gudang', 'Baik', 'perangkat-lain');",
                params![cancellation_id(&id_keluar), id_barang],
            )
            .unwrap();
        assert_eq!(changed, 0);
        assert_eq!(stok(&state, &id_barang), 5);
    }

    #[test]
    fn unit_change_locked_after_history() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        record_mutation(
            &state,
            "admin",
            json!({"id_barang": id_barang, "jenis": "Masuk", "alasan": "Pengadaan", "jumlah": 1, "tempat_tujuan": "Gudang"}),
        )
        .unwrap();
        let error = save_item(
            &state,
            json!({"id_barang": id_barang, "nama_barang": "Barang Uji", "tipe": "Habis Pakai", "satuan": "rim"}),
        )
        .unwrap_err();
        assert!(error
            .message
            .starts_with("Satuan dan pengaturan kedaluwarsa"));
    }

    #[test]
    fn stock_card_running_balance() {
        let (_directory, state) = setup_state();
        let id_barang = insert_item(&state, "Habis Pakai", false);
        insert_raw_mutation(&state, "mts-a", &id_barang, "Masuk", 10);
        insert_raw_mutation(&state, "mts-b", &id_barang, "Keluar", 4);
        let card = stock_card(&state, &id_barang, None, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(card["saldo_awal"], 0);
        let saldo: Vec<i64> = card["baris"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["saldo"].as_i64().unwrap())
            .collect();
        assert_eq!(saldo, vec![10, 6]);
        let later = stock_card(
            &state,
            &id_barang,
            Some("gudang".into()),
            "2026-10-02",
            "2026-10-31",
        )
        .unwrap();
        assert_eq!(later["saldo_awal"], 6);
        assert_eq!(later["baris"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn cloud_values_reject_check_violations() {
        let good = json!({
            "id_mutasi": "mts-1", "id_barang": "b", "jenis": "Keluar", "alasan": "Pemakaian",
            "tanggal": "2026-10-07", "jumlah": 2, "tempat_asal": "Gudang", "kondisi_asal": "Baik",
            "dicatat_oleh": "admin"
        });
        assert_eq!(cloud_mutation_values(&good, "mts-1").unwrap().len(), 23);
        let mut bad = good.clone();
        bad["kondisi_asal"] = json!("Patah");
        assert!(cloud_mutation_values(&bad, "mts-1").is_none());
        let mut zero = good;
        zero["jumlah"] = json!(0);
        assert!(cloud_mutation_values(&zero, "mts-1").is_none());
        assert!(cloud_item_values(
            &json!({"kode_barang":"K","nama_barang":"N","tipe":"Medis","satuan":"pcs"}),
            "brg-1"
        )
        .is_none());
    }
}
