//! Perjalanan driver / surat jalan (v34).
//!
//! Status, kendaraan, dan driver yang bertugas TIDAK disimpan: diturunkan dari
//! `drv_laporan` (append-only). Cloud tidak pernah menolak laporan karena
//! urutan; urutan diperiksa di perangkat (`periksa_urutan`), dan kejanggalan
//! dari offline muncul sebagai tanda tinjau (`tanda_tinjau`).
//!
//! Aturan murni dieja kembar dengan `validations/driver.ts` dan diuji dengan
//! vektor yang sama (`driver.test.ts` ↔ `mod tests`). Pesan galatnya pun
//! wajib identik. Penulisan lokal (SQLite + outbox dalam satu transaksi) dan
//! pembangun statement cloud ada di bagian bawah berkas.

// Aturan turunan untuk layar (tanda tinjau, penerima upah, ganti menunggu)
// baru dipanggil di langkah 6 dan 7; sampai itu hanya tes yang memakainya.
#![allow(dead_code)]

use base64::Engine as _;
use rusqlite::{params, types::ValueRef, OptionalExtension, ToSql, Transaction};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::inventory::{clean, invalid, is_valid_date, new_hex_id, payload_text, MAKS_JUMLAH};
use super::inventory_pengajuan::base64_sah;
use super::{accounting, config::DesktopState, license, models::CommandError, storage, sync};

pub const JENIS_LAPORAN: [&str; 13] = [
    "Berangkat",
    "Tiba Muat",
    "Selesai Muat",
    "Tiba Bongkar",
    "Selesai Bongkar",
    "Kendala",
    "Ganti Kendaraan",
    "Ganti Driver",
    "Disetujui",
    "Ditolak",
    "Tidak Jalan",
    "Dibatalkan",
    "Selesai",
];
pub const JENIS_KENDALA: [&str; 7] = [
    "Macet",
    "Kendaraan Rusak",
    "Ban",
    "Kecelakaan",
    "Cuaca",
    "Antre Muat/Bongkar",
    "Lainnya",
];
pub const JENIS_LOKASI: [&str; 4] = ["Pool", "Muat", "Bongkar", "Lainnya"];

/// Jenis yang dikirim dari HP driver (`trip.report`). Sisanya milik dispatcher.
const JENIS_DRIVER: [&str; 9] = [
    "Berangkat",
    "Tiba Muat",
    "Selesai Muat",
    "Tiba Bongkar",
    "Selesai Bongkar",
    "Kendala",
    "Ganti Kendaraan",
    "Ganti Driver",
    "Selesai",
];
const JENIS_DISPATCHER: [&str; 7] = [
    "Ganti Kendaraan",
    "Ganti Driver",
    "Disetujui",
    "Ditolak",
    "Tidak Jalan",
    "Dibatalkan",
    "Selesai",
];

pub const MAKS_NAMA_DAFTAR: usize = 60;
pub const MAKS_TARIF: i64 = 100_000_000;
pub const MAKS_IDENTITAS: usize = 20;
pub const MAKS_NAMA_KENDARAAN: usize = 60;
pub const MAKS_CATATAN: usize = 500;
pub const MAKS_NAMA_LOKASI: usize = 120;
pub const MAKS_BARIS_MUATAN: usize = 100;
pub const MAKS_TEMPAT: usize = 120;
pub const MAKS_NAMA_BARANG: usize = 120;
pub const MAKS_JENIS_BARANG: usize = 60;
pub const MAKS_SATUAN: usize = 20;
/// Berat ×100 (dua desimal): 1.000 ton.
pub const MAKS_BERAT_X100: i64 = 100_000_000;
pub const MAKS_KETERANGAN: usize = 500;
pub const MAKS_TERLAMBAT_MENIT: i64 = 10_080;
/// ±150 KB setelah didekode; foto 960 px kualitas 0,6 rata-rata ±100 KB.
pub const MAKS_FOTO_BASE64: usize = 200_000;
pub const MIME_FOTO: &str = "image/jpeg";
pub const PREFIX_BAWAAN: &str = "SJ";
pub const MAKS_PREFIX: usize = 8;
pub const AKURASI_PERINGATAN_M: f64 = 100.0;
pub const KECEPATAN_MUSTAHIL_KMJ: f64 = 150.0;
/// Jam perangkat boleh mendahului jam cloud sebanyak ini sebelum ditandai.
pub const TOLERANSI_JAM_MAJU_DETIK: i64 = 300;

fn panjang(text: &str) -> usize {
    text.chars().count()
}

fn teks(value: &Option<String>, maks: usize, pesan: &str) -> Result<Option<String>, String> {
    let bersih = clean(value);
    if bersih.as_deref().is_some_and(|s| panjang(s) > maks) {
        return Err(pesan.to_owned());
    }
    Ok(bersih)
}

fn wajib(
    value: &Option<String>,
    maks: usize,
    kosong: &str,
    kepanjangan: &str,
) -> Result<String, String> {
    teks(value, maks, kepanjangan)?.ok_or_else(|| kosong.to_owned())
}

// ── Nomor surat jalan ──────────────────────────────────────────────────────

/// Cermin `normalisasiPrefix`. Tanda hubung di ujung dibuang karena format
/// nomor menambahkannya sendiri (`KRS-` dan `KRS` sama).
pub fn normalisasi_prefix(masukan: &str) -> Result<String, String> {
    let prefix = masukan.trim().trim_end_matches('-').to_ascii_uppercase();
    if prefix.is_empty() {
        return Err("Awalan nomor surat jalan wajib diisi.".into());
    }
    if panjang(&prefix) > MAKS_PREFIX || !prefix.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!(
            "Awalan nomor surat jalan hanya huruf dan angka, maksimal {MAKS_PREFIX} karakter."
        ));
    }
    Ok(prefix)
}

/// Cermin `prefixTersimpan`. Nilai tersimpan yang rusak jatuh ke bawaan
/// alih-alih menggagalkan pembuatan surat jalan.
pub fn prefix_tersimpan(nilai: Option<&str>) -> String {
    nilai
        .and_then(|v| normalisasi_prefix(v).ok())
        .unwrap_or_else(|| PREFIX_BAWAAN.to_owned())
}

/// Cermin `formatNomorSuratJalan`: `KRS-2611-WAB12-001`. Nomor urut dihitung
/// per seri perangkat (`accounting::seri_perangkat`, Web `WEB`) per bulan
/// tanggal surat jalan, jadi dua perangkat offline tidak pernah berebut nomor.
pub fn format_nomor_surat_jalan(
    prefix: &str,
    tanggal: &str,
    seri: &str,
    nomor_urut: i64,
) -> String {
    let yymm: String = tanggal
        .chars()
        .skip(2)
        .take(2)
        .chain(tanggal.chars().skip(5).take(2))
        .collect();
    format!("{prefix}-{yymm}-{seri}-{nomor_urut:03}")
}

/// Cermin `idMuatan`. Deterministik supaya menyunting surat jalan menimpa
/// barisnya di cloud alih-alih menumpuk baris baru.
pub fn id_muatan(id_perjalanan: &str, urutan: usize) -> String {
    format!("{id_perjalanan}-{urutan}")
}

// ── Upah ───────────────────────────────────────────────────────────────────

/// Cermin `upahSuratJalan`: tarif jenis kendaraan + tarif kategori tujuan,
/// keduanya dikunci saat surat jalan dibuat.
pub fn upah_surat_jalan(tarif_kendaraan: i64, tarif_tujuan: i64) -> i64 {
    tarif_kendaraan.saturating_add(tarif_tujuan)
}

/// Cermin `penerimaUpah`. Hanya surat jalan `Selesai` yang dibayar. Urutan:
/// pilihan dispatcher, driver yang melapor `Selesai`, driver yang bertugas.
pub fn penerima_upah(
    status: &str,
    id_karyawan_upah: Option<&str>,
    laporan: &[Laporan<'_>],
    bertugas: &str,
) -> Option<String> {
    if status != "Selesai" {
        return None;
    }
    let penutup = urutkan(laporan)
        .into_iter()
        .rev()
        .find(|l| l.jenis == "Selesai")
        .and_then(|l| l.id_karyawan);
    Some(id_karyawan_upah.or(penutup).unwrap_or(bertugas).to_owned())
}

// ── Status dan penugasan turunan ───────────────────────────────────────────

/// Satu baris `drv_laporan` sebanyak yang dibutuhkan aturan turunan.
#[derive(Debug, Clone, Default)]
pub struct Laporan<'a> {
    pub id_laporan: &'a str,
    pub jenis: &'a str,
    pub mode_ganti: Option<&'a str>,
    pub id_ref: Option<&'a str>,
    pub waktu_perangkat: &'a str,
    pub diterima_cloud: Option<&'a str>,
    pub id_karyawan: Option<&'a str>,
    pub id_karyawan_baru: Option<&'a str>,
    pub id_kendaraan_baru: Option<&'a str>,
    pub id_lokasi: Option<&'a str>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub akurasi_m: Option<f64>,
    pub foto_sha256: Option<&'a str>,
}

/// Cermin `urutkan`: urutan kejadian = jam perangkat, id sebagai penentu seri.
pub fn urutkan<'b, 'a>(laporan: &'b [Laporan<'a>]) -> Vec<&'b Laporan<'a>> {
    let mut urut: Vec<_> = laporan.iter().collect();
    urut.sort_by(|a, b| (a.waktu_perangkat, a.id_laporan).cmp(&(b.waktu_perangkat, b.id_laporan)));
    urut
}

const JENIS_JALAN: [&str; 5] = [
    "Berangkat",
    "Tiba Muat",
    "Selesai Muat",
    "Tiba Bongkar",
    "Selesai Bongkar",
];

/// Cermin `statusPerjalanan`, diperiksa berurutan.
pub fn status_perjalanan(laporan: &[Laporan<'_>]) -> &'static str {
    let ada = |jenis: &str| laporan.iter().any(|l| l.jenis == jenis);
    if ada("Tidak Jalan") {
        "Tidak Jalan"
    } else if ada("Dibatalkan") {
        "Dibatalkan"
    } else if ada("Selesai") {
        "Selesai"
    } else if laporan.iter().any(|l| JENIS_JALAN.contains(&l.jenis)) {
        "Berjalan"
    } else {
        "Direncanakan"
    }
}

fn keputusan_terakhir<'a>(laporan: &[Laporan<'a>], id_ganti: &str) -> Option<&'a str> {
    urutkan(laporan)
        .into_iter()
        .rev()
        .find(|l| matches!(l.jenis, "Disetujui" | "Ditolak") && l.id_ref == Some(id_ganti))
        .map(|l| l.jenis)
}

/// Cermin `gantiBerlaku`. `Langsung` dan `Darurat` berlaku seketika (ganti
/// darurat yang ditolak dibetulkan dispatcher dengan ganti baru); `Minta Izin`
/// hanya bila keputusan terakhirnya `Disetujui`.
pub fn ganti_berlaku(laporan: &[Laporan<'_>], ganti: &Laporan<'_>) -> bool {
    match ganti.mode_ganti {
        Some("Langsung" | "Darurat") => true,
        Some("Minta Izin") => keputusan_terakhir(laporan, ganti.id_laporan) == Some("Disetujui"),
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Penugasan {
    pub id_karyawan: String,
    pub id_kendaraan: String,
}

/// Cermin `penugasan`: driver dan kendaraan dari ganti berlaku terakhir.
pub fn penugasan(awal_karyawan: &str, awal_kendaraan: &str, laporan: &[Laporan<'_>]) -> Penugasan {
    let mut hasil = Penugasan {
        id_karyawan: awal_karyawan.to_owned(),
        id_kendaraan: awal_kendaraan.to_owned(),
    };
    for l in urutkan(laporan) {
        if !ganti_berlaku(laporan, l) {
            continue;
        }
        match (l.jenis, l.id_karyawan_baru, l.id_kendaraan_baru) {
            ("Ganti Driver", Some(baru), _) => hasil.id_karyawan = baru.to_owned(),
            ("Ganti Kendaraan", _, Some(baru)) => hasil.id_kendaraan = baru.to_owned(),
            _ => {}
        }
    }
    hasil
}

/// Cermin `gantiMenunggu`: ganti dari driver yang belum diputuskan dispatcher.
pub fn ganti_menunggu<'a>(laporan: &[Laporan<'a>]) -> Vec<&'a str> {
    urutkan(laporan)
        .into_iter()
        .filter(|l| matches!(l.mode_ganti, Some("Darurat" | "Minta Izin")))
        .filter(|l| keputusan_terakhir(laporan, l.id_laporan).is_none())
        .map(|l| l.id_laporan)
        .collect()
}

/// Cermin `jenisTitik`: titik yang disentuh laporan, `muat` atau `bongkar`.
fn jenis_titik(jenis: &str) -> Option<&'static str> {
    match jenis {
        "Tiba Muat" | "Selesai Muat" => Some("muat"),
        "Tiba Bongkar" | "Selesai Bongkar" => Some("bongkar"),
        _ => None,
    }
}

/// Cermin `titikTerbuka`: `muat`/`bongkar` bila laporan titik terakhir `Tiba`.
pub fn titik_terbuka(laporan: &[Laporan<'_>]) -> Option<&'static str> {
    urutkan(laporan)
        .into_iter()
        .rev()
        .find(|l| jenis_titik(l.jenis).is_some())
        .filter(|l| l.jenis.starts_with("Tiba "))
        .and_then(|l| jenis_titik(l.jenis))
}

/// Cermin `periksaUrutan`. HANYA di perangkat: cloud tidak pernah menolak
/// laporan karena urutan (outbox akan macet permanen).
pub fn periksa_urutan(laporan: &[Laporan<'_>], jenis: &str) -> Result<(), String> {
    if matches!(jenis, "Disetujui" | "Ditolak") {
        return Ok(());
    }
    let status = status_perjalanan(laporan);
    if matches!(status, "Selesai" | "Dibatalkan" | "Tidak Jalan") {
        return Err("Perjalanan sudah ditutup.".into());
    }
    let berangkat = status == "Berjalan";
    let terbuka = titik_terbuka(laporan);
    let titik_dulu = |k: &str| format!("Selesaikan dulu titik {k} yang sedang terbuka.");
    match jenis {
        "Berangkat" if berangkat => Err("Perjalanan sudah berangkat.".into()),
        "Tidak Jalan" if berangkat => Err(
            "Perjalanan yang sudah berangkat tidak bisa ditandai Tidak Jalan. Pakai Dibatalkan."
                .into(),
        ),
        "Dibatalkan" if !berangkat => Err("Perjalanan belum berangkat. Pakai Tidak Jalan.".into()),
        "Tiba Muat" | "Tiba Bongkar" | "Selesai" if !berangkat => {
            Err("Laporkan Berangkat lebih dulu.".into())
        }
        "Tiba Muat" | "Tiba Bongkar" | "Selesai" if terbuka.is_some() => {
            Err(titik_dulu(terbuka.unwrap_or_default()))
        }
        "Selesai Muat" if terbuka != Some("muat") => Err("Laporkan Tiba Muat lebih dulu.".into()),
        "Selesai Bongkar" if terbuka != Some("bongkar") => {
            Err("Laporkan Tiba Bongkar lebih dulu.".into())
        }
        _ => Ok(()),
    }
}

/// Cermin `validateKeputusan`: dispatcher memutuskan ganti dari driver.
pub fn validate_keputusan(laporan: &[Laporan<'_>], id_ref: &str) -> Result<(), String> {
    let ganti = laporan
        .iter()
        .find(|l| l.id_laporan == id_ref && l.jenis.starts_with("Ganti "))
        .ok_or("Laporan ganti tidak ditemukan.")?;
    if !matches!(ganti.mode_ganti, Some("Darurat" | "Minta Izin")) {
        return Err("Ganti ini tidak memerlukan persetujuan.".into());
    }
    if keputusan_terakhir(laporan, id_ref).is_some() {
        return Err("Ganti ini sudah diputuskan.".into());
    }
    Ok(())
}

// ── Waktu dan jarak ────────────────────────────────────────────────────────

/// Cermin `detikUtc`: `YYYY-MM-DD HH:MM:SS` (bentuk `datetime('now')`, UTC)
/// menjadi detik epoch. Dihitung manual supaya tidak ada tafsir zona waktu.
pub fn detik_utc(waktu: &str) -> Option<i64> {
    // ASCII saja, jadi setiap indeks byte di bawah adalah batas karakter (aturan 39).
    let b = waktu.as_bytes();
    if !waktu.is_ascii() || b.len() != 19 || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let tanggal = &waktu[..10];
    if !is_valid_date(tanggal) {
        return None;
    }
    let angka = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = &waktu[r];
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (jam, menit, detik) = (angka(11..13)?, angka(14..16)?, angka(17..19)?);
    if jam > 23 || menit > 59 || detik > 59 {
        return None;
    }
    let (y, m, d) = (angka(0..4)?, angka(5..7)?, angka(8..10)?);
    // days_from_civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let hari = era * 146_097 + doe - 719_468;
    Some(hari * 86_400 + jam * 3_600 + menit * 60 + detik)
}

/// Cermin `jarakMeter` (Haversine, jari-jari bumi 6.371 km).
pub fn jarak_meter(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let rad = |v: f64| v * std::f64::consts::PI / 180.0;
    let dlat = rad(lat2 - lat1);
    let dlng = rad(lng2 - lng1);
    let a =
        (dlat / 2.0).sin().powi(2) + rad(lat1).cos() * rad(lat2).cos() * (dlng / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

// ── Tanda tinjau ───────────────────────────────────────────────────────────

pub struct LokasiTerdaftar<'a> {
    pub id_lokasi: &'a str,
    pub lat: f64,
    pub lng: f64,
    pub radius_m: i64,
}

pub struct MuatanRencana<'a> {
    pub id_muatan: &'a str,
    pub qty: i64,
}

pub struct MuatanLapor<'a> {
    pub id_laporan: &'a str,
    pub id_muatan: &'a str,
    pub qty: i64,
}

/// Satu temuan "Perlu ditinjau". `id` = id laporan, atau id muatan untuk
/// `muat_beda` dan `sisa_muatan`.
#[derive(Debug, PartialEq, Eq)]
pub struct Tanda {
    pub kode: &'static str,
    pub id: String,
}

fn tanda(kode: &'static str, id: &str) -> Tanda {
    Tanda {
        kode,
        id: id.to_owned(),
    }
}

/// Cermin `tandaTinjau`. Tidak ada yang ditolak: semua berakhir di daftar
/// "Perlu ditinjau" dispatcher, karena GPS di gudang memang sering meleset.
pub fn tanda_tinjau(
    laporan: &[Laporan<'_>],
    lokasi: &[LokasiTerdaftar<'_>],
    rencana: &[MuatanRencana<'_>],
    dilapor: &[MuatanLapor<'_>],
    ambang_akurasi_m: f64,
) -> Vec<Tanda> {
    let urut = urutkan(laporan);
    let mut hasil = Vec::new();

    // Urutan menurut jam perangkat yang melanggar urutan yang dipaksa di
    // perangkat = jam diubah mundur (atau laporan offline dua HP bertabrakan).
    let (mut jalan, mut tutup, mut terbuka): (bool, bool, Option<&str>) = (false, false, None);
    for l in &urut {
        let janggal = match l.jenis {
            "Berangkat" => {
                let j = jalan || tutup;
                jalan = true;
                j
            }
            "Tiba Muat" | "Tiba Bongkar" => {
                let j = !jalan || tutup || terbuka.is_some();
                terbuka = jenis_titik(l.jenis);
                j
            }
            "Selesai Muat" | "Selesai Bongkar" => {
                let j = terbuka != jenis_titik(l.jenis);
                terbuka = None;
                j
            }
            "Selesai" | "Dibatalkan" => {
                let j = !jalan || tutup || terbuka.is_some();
                tutup = true;
                j
            }
            "Tidak Jalan" => {
                let j = jalan || tutup;
                tutup = true;
                j
            }
            _ => false,
        };
        if janggal {
            hasil.push(tanda("urutan_janggal", l.id_laporan));
        }
    }

    for l in &urut {
        if let (Some(perangkat), Some(cloud)) = (
            detik_utc(l.waktu_perangkat),
            l.diterima_cloud.and_then(detik_utc),
        ) {
            if perangkat - cloud > TOLERANSI_JAM_MAJU_DETIK {
                hasil.push(tanda("jam_maju", l.id_laporan));
            }
        }
        let dari_driver = l.id_karyawan.is_some();
        if dari_driver && (l.lat.is_none() || l.lng.is_none()) {
            hasil.push(tanda("tanpa_gps", l.id_laporan));
        }
        if dari_driver && l.foto_sha256.is_none() {
            hasil.push(tanda("tanpa_foto", l.id_laporan));
        }
        match l.akurasi_m {
            Some(a) if a == 0.0 => hasil.push(tanda("akurasi_nol", l.id_laporan)),
            Some(a) if a > ambang_akurasi_m => hasil.push(tanda("akurasi_buruk", l.id_laporan)),
            _ => {}
        }
        if let (Some(id), Some(lat), Some(lng)) = (l.id_lokasi, l.lat, l.lng) {
            if let Some(titik) = lokasi.iter().find(|t| t.id_lokasi == id) {
                let jarak =
                    jarak_meter(lat, lng, titik.lat, titik.lng) - l.akurasi_m.unwrap_or(0.0);
                if jarak > titik.radius_m as f64 {
                    hasil.push(tanda("luar_radius", l.id_laporan));
                }
            }
        }
    }

    // Kecepatan antara dua laporan berkoordinat berurutan. Akurasi keduanya
    // dikurangkan dulu supaya GPS yang meleset tidak terbaca sebagai lompatan.
    let berkoordinat: Vec<_> = urut
        .iter()
        .filter_map(|l| Some((*l, l.lat?, l.lng?, detik_utc(l.waktu_perangkat)?)))
        .collect();
    for pasangan in berkoordinat.windows(2) {
        let (a, lat1, lng1, t1) = pasangan[0];
        let (b, lat2, lng2, t2) = pasangan[1];
        let meleset = a.akurasi_m.unwrap_or(0.0) + b.akurasi_m.unwrap_or(0.0);
        let jarak = (jarak_meter(lat1, lng1, lat2, lng2) - meleset).max(0.0);
        let kmj = jarak / (t2 - t1).max(1) as f64 * 3.6;
        if kmj > KECEPATAN_MUSTAHIL_KMJ {
            hasil.push(tanda("kecepatan_mustahil", b.id_laporan));
        }
    }

    for id in ganti_menunggu(laporan) {
        hasil.push(tanda("menunggu_persetujuan", id));
    }

    let jumlah = |jenis: &str, id_muatan: &str| -> (bool, i64) {
        let baris: Vec<i64> = dilapor
            .iter()
            .filter(|m| m.id_muatan == id_muatan)
            .filter(|m| {
                laporan
                    .iter()
                    .any(|l| l.id_laporan == m.id_laporan && l.jenis == jenis)
            })
            .map(|m| m.qty)
            .collect();
        (!baris.is_empty(), baris.iter().sum())
    };
    let selesai = status_perjalanan(laporan) == "Selesai";
    for m in rencana {
        let (dikonfirmasi, dimuat) = jumlah("Selesai Muat", m.id_muatan);
        if (dikonfirmasi || selesai) && dimuat != m.qty {
            hasil.push(tanda("muat_beda", m.id_muatan));
        }
        if selesai && dimuat != jumlah("Selesai Bongkar", m.id_muatan).1 {
            hasil.push(tanda("sisa_muatan", m.id_muatan));
        }
    }
    hasil
}

// ── Validasi isian ─────────────────────────────────────────────────────────

/// Cermin `daftarTarifDraftSchema`: jenis kendaraan dan kategori tujuan.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DaftarTarifDraft {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub nama: Option<String>,
    #[serde(default)]
    pub tarif: i64,
    #[serde(default = "aktif")]
    pub status_aktif: bool,
}

fn aktif() -> bool {
    true
}

#[derive(Debug, PartialEq, Eq)]
pub struct DaftarTarifValid {
    pub nama: String,
    pub tarif: i64,
    pub status_aktif: bool,
}

/// Cermin `validateDaftarTarif`. `label`: "jenis kendaraan" / "kategori tujuan".
pub fn validate_daftar_tarif(
    draft: &DaftarTarifDraft,
    label: &str,
) -> Result<DaftarTarifValid, String> {
    let nama = wajib(
        &draft.nama,
        MAKS_NAMA_DAFTAR,
        &format!("Nama {label} wajib diisi."),
        &format!("Nama {label} maksimal {MAKS_NAMA_DAFTAR} karakter."),
    )?;
    if !(0..=MAKS_TARIF).contains(&draft.tarif) {
        return Err("Tarif harus 0 sampai Rp100.000.000.".into());
    }
    Ok(DaftarTarifValid {
        nama,
        tarif: draft.tarif,
        status_aktif: draft.status_aktif,
    })
}

/// Cermin `normalisasiIdentitas`: huruf besar, spasi tunggal. Dipakai juga
/// untuk memeriksa plat kembar di aplikasi (tanpa UNIQUE, aturan 32).
pub fn normalisasi_identitas(identitas: &str) -> String {
    identitas
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KendaraanDraft {
    #[serde(default)]
    pub id_kendaraan: Option<String>,
    #[serde(default)]
    pub id_jenis: Option<String>,
    #[serde(default)]
    pub identitas: Option<String>,
    #[serde(default)]
    pub nama: Option<String>,
    #[serde(default)]
    pub catatan: Option<String>,
    #[serde(default = "aktif")]
    pub status_aktif: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct KendaraanValid {
    pub id_jenis: String,
    pub identitas: String,
    pub nama: Option<String>,
    pub catatan: Option<String>,
    pub status_aktif: bool,
}

/// Cermin `validateKendaraan`.
pub fn validate_kendaraan(draft: &KendaraanDraft) -> Result<KendaraanValid, String> {
    let id_jenis = clean(&draft.id_jenis).ok_or("Pilih jenis kendaraan.")?;
    let identitas = normalisasi_identitas(draft.identitas.as_deref().unwrap_or_default());
    if identitas.is_empty() {
        return Err("Plat atau nomor kendaraan wajib diisi.".into());
    }
    if panjang(&identitas) > MAKS_IDENTITAS {
        return Err(format!(
            "Plat atau nomor kendaraan maksimal {MAKS_IDENTITAS} karakter."
        ));
    }
    let nama = teks(
        &draft.nama,
        MAKS_NAMA_KENDARAAN,
        &format!("Nama kendaraan maksimal {MAKS_NAMA_KENDARAAN} karakter."),
    )?;
    let catatan = teks(
        &draft.catatan,
        MAKS_CATATAN,
        &format!("Catatan maksimal {MAKS_CATATAN} karakter."),
    )?;
    Ok(KendaraanValid {
        id_jenis,
        identitas,
        nama,
        catatan,
        status_aktif: draft.status_aktif,
    })
}

fn koordinat_sah(lat: f64, lng: f64) -> bool {
    lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LokasiDraft {
    #[serde(default)]
    pub id_lokasi: Option<String>,
    #[serde(default)]
    pub nama: Option<String>,
    #[serde(default)]
    pub jenis: String,
    #[serde(default)]
    pub lat: f64,
    #[serde(default)]
    pub lng: f64,
    #[serde(default = "radius_bawaan")]
    pub radius_m: i64,
    #[serde(default = "aktif")]
    pub status_aktif: bool,
}

fn radius_bawaan() -> i64 {
    200
}

#[derive(Debug, PartialEq)]
pub struct LokasiValid {
    pub nama: String,
    pub jenis: String,
    pub lat: f64,
    pub lng: f64,
    pub radius_m: i64,
    pub status_aktif: bool,
}

/// Cermin `validateLokasi`.
pub fn validate_lokasi(draft: &LokasiDraft) -> Result<LokasiValid, String> {
    let nama = wajib(
        &draft.nama,
        MAKS_NAMA_LOKASI,
        "Nama lokasi wajib diisi.",
        &format!("Nama lokasi maksimal {MAKS_NAMA_LOKASI} karakter."),
    )?;
    if !JENIS_LOKASI.contains(&draft.jenis.as_str()) {
        return Err("Pilih jenis lokasi.".into());
    }
    if !koordinat_sah(draft.lat, draft.lng) {
        return Err("Koordinat tidak valid.".into());
    }
    if draft.lat == 0.0 && draft.lng == 0.0 {
        return Err("Ambil koordinat lokasi lebih dulu.".into());
    }
    if !(10..=10_000).contains(&draft.radius_m) {
        return Err("Radius 10 sampai 10.000 meter.".into());
    }
    Ok(LokasiValid {
        nama,
        jenis: draft.jenis.clone(),
        lat: draft.lat,
        lng: draft.lng,
        radius_m: draft.radius_m,
        status_aktif: draft.status_aktif,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MuatanDraft {
    #[serde(default)]
    pub tempat_muat: Option<String>,
    #[serde(default)]
    pub tempat_bongkar: Option<String>,
    #[serde(default)]
    pub nama_barang: Option<String>,
    #[serde(default)]
    pub jenis_barang: Option<String>,
    #[serde(default)]
    pub qty: i64,
    #[serde(default)]
    pub satuan: Option<String>,
    #[serde(default)]
    pub berat_kg_x100: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerjalananDraft {
    #[serde(default)]
    pub id_perjalanan: Option<String>,
    #[serde(default)]
    pub tanggal: String,
    #[serde(default)]
    pub id_karyawan: Option<String>,
    #[serde(default)]
    pub id_kendaraan: Option<String>,
    #[serde(default)]
    pub id_kategori: Option<String>,
    #[serde(default)]
    pub catatan: Option<String>,
    #[serde(default)]
    pub muatan: Vec<MuatanDraft>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MuatanValid {
    pub tempat_muat: String,
    pub tempat_bongkar: Option<String>,
    pub nama_barang: String,
    pub jenis_barang: Option<String>,
    pub qty: i64,
    pub satuan: String,
    pub berat_kg_x100: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PerjalananValid {
    pub tanggal: String,
    pub id_karyawan: String,
    pub id_kendaraan: String,
    pub id_kategori: String,
    pub catatan: Option<String>,
    pub muatan: Vec<MuatanValid>,
}

fn berat_sah(berat: Option<i64>) -> bool {
    berat.is_none_or(|b| (0..=MAKS_BERAT_X100).contains(&b))
}

/// Cermin `validatePerjalanan`.
pub fn validate_perjalanan(draft: &PerjalananDraft) -> Result<PerjalananValid, String> {
    let tanggal = draft.tanggal.trim().to_owned();
    if !is_valid_date(&tanggal) {
        return Err("Tanggal surat jalan tidak valid.".into());
    }
    let id_karyawan = clean(&draft.id_karyawan).ok_or("Pilih driver.")?;
    let id_kendaraan = clean(&draft.id_kendaraan).ok_or("Pilih kendaraan.")?;
    let id_kategori = clean(&draft.id_kategori).ok_or("Pilih kategori tujuan.")?;
    let catatan = teks(
        &draft.catatan,
        MAKS_CATATAN,
        &format!("Catatan maksimal {MAKS_CATATAN} karakter."),
    )?;
    if draft.muatan.is_empty() {
        return Err("Isi minimal satu barang muatan.".into());
    }
    if draft.muatan.len() > MAKS_BARIS_MUATAN {
        return Err(format!("Paling banyak {MAKS_BARIS_MUATAN} baris muatan."));
    }
    let mut muatan = Vec::with_capacity(draft.muatan.len());
    for (indeks, m) in draft.muatan.iter().enumerate() {
        let n = indeks + 1;
        let kepanjangan =
            |label: &str, maks: usize| format!("Baris {n}: {label} maksimal {maks} karakter.");
        let tempat_muat = wajib(
            &m.tempat_muat,
            MAKS_TEMPAT,
            &format!("Baris {n}: tempat muat wajib diisi."),
            &kepanjangan("tempat muat", MAKS_TEMPAT),
        )?;
        let tempat_bongkar = teks(
            &m.tempat_bongkar,
            MAKS_TEMPAT,
            &kepanjangan("tempat bongkar", MAKS_TEMPAT),
        )?;
        let nama_barang = wajib(
            &m.nama_barang,
            MAKS_NAMA_BARANG,
            &format!("Baris {n}: nama barang wajib diisi."),
            &kepanjangan("nama barang", MAKS_NAMA_BARANG),
        )?;
        let jenis_barang = teks(
            &m.jenis_barang,
            MAKS_JENIS_BARANG,
            &kepanjangan("jenis barang", MAKS_JENIS_BARANG),
        )?;
        if !(1..=MAKS_JUMLAH).contains(&m.qty) {
            return Err(format!("Baris {n}: jumlah harus lebih dari 0."));
        }
        let satuan = wajib(
            &m.satuan,
            MAKS_SATUAN,
            &format!("Baris {n}: satuan wajib diisi."),
            &kepanjangan("satuan", MAKS_SATUAN),
        )?;
        if !berat_sah(m.berat_kg_x100) {
            return Err(format!("Baris {n}: berat tidak valid."));
        }
        muatan.push(MuatanValid {
            tempat_muat,
            tempat_bongkar,
            nama_barang,
            jenis_barang,
            qty: m.qty,
            satuan,
            berat_kg_x100: m.berat_kg_x100,
        });
    }
    Ok(PerjalananValid {
        tanggal,
        id_karyawan,
        id_kendaraan,
        id_kategori,
        catatan,
        muatan,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaporanMuatanDraft {
    #[serde(default)]
    pub id_muatan: Option<String>,
    #[serde(default)]
    pub qty: i64,
    #[serde(default)]
    pub berat_kg_x100: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaporanDraft {
    #[serde(default)]
    pub id_laporan: Option<String>,
    #[serde(default)]
    pub id_perjalanan: Option<String>,
    #[serde(default)]
    pub jenis: String,
    #[serde(default)]
    pub mode_ganti: Option<String>,
    #[serde(default)]
    pub id_ref: Option<String>,
    #[serde(default)]
    pub jenis_kendala: Option<String>,
    #[serde(default)]
    pub terlambat_menit: Option<i64>,
    #[serde(default)]
    pub id_lokasi: Option<String>,
    #[serde(default)]
    pub nama_lokasi: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    #[serde(default)]
    pub akurasi_m: Option<f64>,
    #[serde(default)]
    pub waktu_perangkat: String,
    #[serde(default)]
    pub waktu_gps: Option<String>,
    #[serde(default)]
    pub id_karyawan_baru: Option<String>,
    #[serde(default)]
    pub id_kendaraan_baru: Option<String>,
    #[serde(default)]
    pub keterangan: Option<String>,
    #[serde(default)]
    pub muatan: Vec<LaporanMuatanDraft>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LaporanMuatanValid {
    pub id_muatan: String,
    pub qty: i64,
    pub berat_kg_x100: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub struct LaporanValid {
    pub id_perjalanan: String,
    pub jenis: String,
    pub mode_ganti: Option<String>,
    pub id_ref: Option<String>,
    pub jenis_kendala: Option<String>,
    pub terlambat_menit: Option<i64>,
    pub id_lokasi: Option<String>,
    pub nama_lokasi: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub akurasi_m: Option<f64>,
    pub waktu_perangkat: String,
    pub waktu_gps: Option<String>,
    pub id_karyawan_baru: Option<String>,
    pub id_kendaraan_baru: Option<String>,
    pub keterangan: Option<String>,
    pub muatan: Vec<LaporanMuatanValid>,
}

/// Cermin `validateLaporan`. `oleh_driver`: dari HP driver (`trip.report`,
/// wajib GPS dan foto) atau dari dispatcher. Kepemilikan perjalanan, urutan,
/// dan keberadaan id yang dirujuk diperiksa terpisah terhadap database.
pub fn validate_laporan(
    draft: &LaporanDraft,
    oleh_driver: bool,
    ada_foto: bool,
) -> Result<LaporanValid, String> {
    let jenis = draft.jenis.as_str();
    if !JENIS_LAPORAN.contains(&jenis) {
        return Err("Jenis laporan tidak dikenal.".into());
    }
    if oleh_driver && !JENIS_DRIVER.contains(&jenis) {
        return Err("Jenis laporan ini hanya untuk dispatcher.".into());
    }
    if !oleh_driver && !JENIS_DISPATCHER.contains(&jenis) {
        return Err("Jenis laporan ini hanya dari HP driver.".into());
    }
    let id_perjalanan = clean(&draft.id_perjalanan).ok_or("Surat jalan wajib dipilih.")?;
    let keterangan = teks(
        &draft.keterangan,
        MAKS_KETERANGAN,
        &format!("Keterangan maksimal {MAKS_KETERANGAN} karakter."),
    )?;

    let ganti = jenis.starts_with("Ganti ");
    let mode_ganti = match (ganti, oleh_driver) {
        (false, _) => None,
        (true, false) => Some("Langsung".to_owned()),
        (true, true) => match draft.mode_ganti.as_deref() {
            Some(mode @ ("Darurat" | "Minta Izin")) => Some(mode.to_owned()),
            _ => return Err("Pilih Darurat atau Minta Izin.".into()),
        },
    };
    let id_karyawan_baru = (jenis == "Ganti Driver")
        .then(|| clean(&draft.id_karyawan_baru).ok_or("Pilih driver pengganti."))
        .transpose()?;
    let id_kendaraan_baru = (jenis == "Ganti Kendaraan")
        .then(|| clean(&draft.id_kendaraan_baru).ok_or("Pilih kendaraan pengganti."))
        .transpose()?;
    let id_ref = matches!(jenis, "Disetujui" | "Ditolak")
        .then(|| clean(&draft.id_ref).ok_or("Laporan yang diputuskan wajib dipilih."))
        .transpose()?;

    let (jenis_kendala, terlambat_menit) = if jenis == "Kendala" {
        let kendala = draft
            .jenis_kendala
            .as_deref()
            .filter(|k| JENIS_KENDALA.contains(k))
            .ok_or("Pilih jenis kendala.")?;
        if kendala == "Lainnya" && keterangan.is_none() {
            return Err("Keterangan kendala wajib diisi.".into());
        }
        if draft
            .terlambat_menit
            .is_some_and(|m| !(0..=MAKS_TERLAMBAT_MENIT).contains(&m))
        {
            return Err(format!(
                "Perkiraan terlambat 0 sampai {MAKS_TERLAMBAT_MENIT} menit."
            ));
        }
        (Some(kendala.to_owned()), draft.terlambat_menit)
    } else {
        (None, None)
    };

    let butuh_alasan = matches!(jenis, "Tidak Jalan" | "Dibatalkan" | "Ditolak")
        || (ganti && oleh_driver)
        || (jenis == "Selesai" && !oleh_driver);
    if butuh_alasan && keterangan.is_none() {
        return Err("Alasan wajib diisi.".into());
    }

    let (lat, lng, akurasi_m) = if oleh_driver {
        let (Some(lat), Some(lng)) = (draft.lat, draft.lng) else {
            return Err("Lokasi GPS belum didapat. Nyalakan GPS lalu coba lagi.".into());
        };
        if !koordinat_sah(lat, lng) {
            return Err("Koordinat tidak valid.".into());
        }
        let akurasi = draft
            .akurasi_m
            .filter(|a| a.is_finite() && *a >= 0.0)
            .ok_or("Akurasi GPS tidak valid.")?;
        (Some(lat), Some(lng), Some(akurasi))
    } else {
        (None, None, None)
    };
    let id_lokasi = if oleh_driver {
        clean(&draft.id_lokasi)
    } else {
        None
    };
    let nama_lokasi = if oleh_driver {
        teks(
            &draft.nama_lokasi,
            MAKS_NAMA_LOKASI,
            &format!("Nama tempat maksimal {MAKS_NAMA_LOKASI} karakter."),
        )?
    } else {
        None
    };
    if matches!(jenis, "Tiba Muat" | "Tiba Bongkar") && nama_lokasi.is_none() {
        return Err("Nama tempat wajib diisi.".into());
    }

    let waktu_perangkat = draft.waktu_perangkat.trim().to_owned();
    if detik_utc(&waktu_perangkat).is_none() {
        return Err("Waktu laporan tidak valid.".into());
    }
    let waktu_gps = clean(&draft.waktu_gps);
    if oleh_driver && waktu_gps.as_deref().is_some_and(|w| detik_utc(w).is_none()) {
        return Err("Waktu GPS tidak valid.".into());
    }
    let waktu_gps = if oleh_driver { waktu_gps } else { None };

    let catat_muatan = matches!(jenis, "Selesai Muat" | "Selesai Bongkar");
    if !catat_muatan && !draft.muatan.is_empty() {
        return Err("Rincian muatan hanya untuk Selesai Muat atau Selesai Bongkar.".into());
    }
    if catat_muatan && draft.muatan.is_empty() {
        return Err(if jenis == "Selesai Muat" {
            "Konfirmasi jumlah barang yang dimuat.".into()
        } else {
            "Catat barang yang diturunkan.".into()
        });
    }
    if draft.muatan.len() > MAKS_BARIS_MUATAN {
        return Err(format!("Paling banyak {MAKS_BARIS_MUATAN} baris muatan."));
    }
    let mut muatan: Vec<LaporanMuatanValid> = Vec::with_capacity(draft.muatan.len());
    for m in &draft.muatan {
        let id_muatan = clean(&m.id_muatan).ok_or("Barang muatan tidak dikenal.")?;
        if muatan.iter().any(|x| x.id_muatan == id_muatan) {
            return Err("Barang yang sama tercatat dua kali.".into());
        }
        if !(0..=MAKS_JUMLAH).contains(&m.qty) {
            return Err("Jumlah barang tidak valid.".into());
        }
        if !berat_sah(m.berat_kg_x100) {
            return Err("Berat barang tidak valid.".into());
        }
        muatan.push(LaporanMuatanValid {
            id_muatan,
            qty: m.qty,
            berat_kg_x100: m.berat_kg_x100,
        });
    }

    if oleh_driver && !ada_foto {
        return Err("Ambil foto lebih dulu.".into());
    }

    Ok(LaporanValid {
        id_perjalanan,
        jenis: jenis.to_owned(),
        mode_ganti,
        id_ref,
        jenis_kendala,
        terlambat_menit,
        id_lokasi,
        nama_lokasi,
        lat,
        lng,
        akurasi_m,
        waktu_perangkat,
        waktu_gps,
        id_karyawan_baru,
        id_kendaraan_baru,
        keterangan,
        muatan,
    })
}

/// Cermin `validateFotoLaporan`. Diperiksa sebelum menulis apa pun supaya
/// CHECK cloud tidak pernah menolak event foto (aturan 43).
pub fn validate_foto_laporan(mime_type: &str, data_base64: &str) -> Result<(), String> {
    if mime_type != MIME_FOTO {
        return Err("Foto harus JPEG.".into());
    }
    if data_base64.len() > MAKS_FOTO_BASE64 {
        return Err("Foto terlalu besar. Ambil ulang.".into());
    }
    if !base64_sah(data_base64) {
        return Err("Foto tidak terbaca.".into());
    }
    Ok(())
}

/// SHA-256 isi berkas JPEG (bukan teks base64-nya), supaya bisa dicocokkan
/// dengan berkas hasil unduhan.
pub fn sidik_foto(data_base64: &str) -> Option<String> {
    let isi = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .ok()?;
    Some(hex::encode(Sha256::digest(&isi)))
}

// ── Absensi dan gaji harian (PRD §7.4, Q-26/Q-29/Q-30) ─────────────────────
//
// Di pool tidak ada terminal scan. Laporan perjalanan (`id_karyawan` = driver
// pelapor) pada tanggal WIB D berarti personil itu bekerja pada D: tidak
// di-Alfa-kan, tidak dinilai audit absensi, dan D dihitung hari hadir gaji
// harian. Laporan dispatcher (`id_karyawan` NULL) tidak dihitung. Waktu
// laporan disimpan UTC, jadi tanggal WIB D = [D 00:00 − 7 jam, D+1 − 7 jam).

/// Cermin `PELAPOR_PERJALANAN_SQL`. `?1` = tanggal WIB `YYYY-MM-DD`.
pub const PELAPOR_PERJALANAN_SQL: &str = "SELECT DISTINCT id_karyawan FROM drv_laporan
     WHERE id_karyawan IS NOT NULL
       AND waktu_perangkat >= datetime(?1, '-7 hours')
       AND waktu_perangkat < datetime(?1, '+17 hours');";

/// Cermin `HARI_HADIR_SQL`: jumlah tanggal unik berstatus hadir ATAU berlaporan
/// perjalanan dalam periode `?1`..`?2`, untuk baris `md` (master_data).
/// `UNION` membuang tanggal yang punya keduanya, jadi tidak dihitung dua kali.
pub const HARI_HADIR_SQL: &str = "(SELECT COUNT(*) FROM (
                SELECT a.tanggal FROM absensi_harian a
                WHERE a.id_karyawan = md.id_unik AND a.tanggal >= ?1 AND a.tanggal <= ?2
                  AND a.status_kehadiran IN ('Hadir', 'PRESENT')
                UNION
                SELECT date(l.waktu_perangkat, '+7 hours') FROM drv_laporan l
                WHERE l.id_karyawan = md.id_unik
                  AND l.waktu_perangkat >= datetime(?1, '-7 hours')
                  AND l.waktu_perangkat < datetime(?2, '+17 hours')
            ))";

/// Personil yang melapor perjalanan pada tanggal WIB `tanggal`.
pub fn pelapor_perjalanan(
    connection: &rusqlite::Connection,
    tanggal: &str,
) -> Result<std::collections::HashSet<String>, CommandError> {
    let mut statement = connection
        .prepare(PELAPOR_PERJALANAN_SQL)
        .map_err(internal)?;
    let baris = statement
        .query_map(params![tanggal], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

// ── Penulisan lokal: SQLite + outbox dalam satu transaksi (aturan 3) ───────

fn internal<E>(_: E) -> CommandError {
    CommandError::internal()
}

/// Setiap baris hasil kueri sebagai objek JSON berkunci nama kolom. Payload
/// outbox = baris lokal apa adanya, jadi handler cloud membaca kolom yang sama.
fn kueri_json(
    tx: &rusqlite::Connection,
    sql: &str,
    args: &[&dyn ToSql],
) -> Result<Vec<Value>, CommandError> {
    let mut statement = tx.prepare(sql).map_err(internal)?;
    let kolom: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let baris = statement
        .query_map(args, |row| {
            let mut objek = Map::new();
            for (indeks, nama) in kolom.iter().enumerate() {
                let nilai = match row.get_ref(indeks)? {
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    _ => Value::Null,
                };
                objek.insert(nama.clone(), nilai);
            }
            Ok(Value::Object(objek))
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn satu_json(
    tx: &rusqlite::Connection,
    sql: &str,
    args: &[&dyn ToSql],
) -> Result<Value, CommandError> {
    kueri_json(tx, sql, args)?
        .into_iter()
        .next()
        .ok_or_else(CommandError::internal)
}

fn ada(tx: &rusqlite::Connection, sql: &str, args: &[&dyn ToSql]) -> Result<bool, CommandError> {
    tx.query_row(sql, args, |_| Ok(()))
        .optional()
        .map(|baris| baris.is_some())
        .map_err(internal)
}

fn dalam_transaksi<T>(
    state: &DesktopState,
    kerja: impl FnOnce(&Transaction<'_>, &str) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let tx = connection.transaction().map_err(internal)?;
    let hasil = kerja(&tx, &client_id)?;
    tx.commit().map_err(internal)?;
    Ok(hasil)
}

fn ditolak_tarif() -> CommandError {
    CommandError::new(
        "DESKTOP_ACCESS_DENIED",
        "Mengubah tarif butuh izin tarif surat jalan.",
    )
}

/// Jenis kendaraan dan kategori tujuan: daftar bertarif yang bentuknya sama.
pub struct DaftarTarif {
    pub tabel: &'static str,
    pub kolom_id: &'static str,
    pub awalan_id: &'static str,
    pub label: &'static str,
    pub judul: &'static str,
    pub domain: &'static str,
    pub sql_cloud: &'static str,
}

pub const DAFTAR_JENIS_KENDARAAN: DaftarTarif = DaftarTarif {
    tabel: "drv_jenis_kendaraan",
    kolom_id: "id_jenis",
    awalan_id: "jkd-",
    label: "jenis kendaraan",
    judul: "Jenis kendaraan",
    domain: "vehicle-type",
    sql_cloud: CLOUD_UPSERT_JENIS_SQL,
};

pub const DAFTAR_KATEGORI_TUJUAN: DaftarTarif = DaftarTarif {
    tabel: "drv_kategori_tujuan",
    kolom_id: "id_kategori",
    awalan_id: "ktj-",
    label: "kategori tujuan",
    judul: "Kategori tujuan",
    domain: "trip-destination",
    sql_cloud: CLOUD_UPSERT_KATEGORI_SQL,
};

/// Simpan jenis kendaraan atau kategori tujuan. Tarif baru atau tarif yang
/// berubah butuh `trip.tariff` (`boleh_ubah_tarif`); nama unik di aplikasi.
pub fn simpan_daftar_tarif(
    state: &DesktopState,
    daftar: &DaftarTarif,
    boleh_ubah_tarif: bool,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: DaftarTarifDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data tidak valid."))?;
    let valid = validate_daftar_tarif(&draft, daftar.label).map_err(invalid)?;
    let DaftarTarif {
        tabel, kolom_id, ..
    } = daftar;
    dalam_transaksi(state, |tx, client_id| {
        let id = match clean(&draft.id) {
            Some(id) => {
                let tarif_lama: i64 = tx
                    .query_row(
                        &format!("SELECT tarif FROM {tabel} WHERE {kolom_id} = ?;"),
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(internal)?
                    .ok_or_else(|| invalid(format!("{} tidak ditemukan.", daftar.judul)))?;
                if tarif_lama != valid.tarif && !boleh_ubah_tarif {
                    return Err(ditolak_tarif());
                }
                id
            }
            None => {
                if valid.tarif != 0 && !boleh_ubah_tarif {
                    return Err(ditolak_tarif());
                }
                new_hex_id(daftar.awalan_id)
            }
        };
        if ada(
            tx,
            &format!(
                "SELECT 1 FROM {tabel} WHERE lower(trim(nama)) = lower(?) AND {kolom_id} <> ?;"
            ),
            &[&valid.nama, &id],
        )? {
            return Err(invalid(format!("Nama {} sudah dipakai.", daftar.label)));
        }
        tx.execute(
            &format!(
                "INSERT INTO {tabel} ({kolom_id}, nama, tarif, status_aktif, created_at, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
                 ON CONFLICT({kolom_id}) DO UPDATE SET nama = excluded.nama,
                    tarif = excluded.tarif, status_aktif = excluded.status_aktif,
                    updated_at = datetime('now');"
            ),
            params![id, valid.nama, valid.tarif, valid.status_aktif as i64],
        )
        .map_err(internal)?;
        let payload = satu_json(
            tx,
            &format!("SELECT * FROM {tabel} WHERE {kolom_id} = ?;"),
            &[&id],
        )?;
        sync::enqueue(tx, client_id, daftar.domain, "save", &id, &payload, None)?;
        Ok(json!({ "sukses": true, "id": id }))
    })
}

pub fn simpan_kendaraan(state: &DesktopState, draft: Value) -> Result<Value, CommandError> {
    let draft: KendaraanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data kendaraan tidak valid."))?;
    let valid = validate_kendaraan(&draft).map_err(invalid)?;
    dalam_transaksi(state, |tx, client_id| {
        let id = match clean(&draft.id_kendaraan) {
            Some(id) => {
                if !ada(
                    tx,
                    "SELECT 1 FROM drv_kendaraan WHERE id_kendaraan = ?;",
                    &[&id],
                )? {
                    return Err(invalid("Kendaraan tidak ditemukan."));
                }
                id
            }
            None => new_hex_id("knd-"),
        };
        // Jenis yang sudah nonaktif tetap boleh dipertahankan kendaraan lamanya.
        if !ada(
            tx,
            "SELECT 1 FROM drv_jenis_kendaraan WHERE id_jenis = ? AND (status_aktif = 1
                OR id_jenis = (SELECT id_jenis FROM drv_kendaraan WHERE id_kendaraan = ?));",
            &[&valid.id_jenis, &id],
        )? {
            return Err(invalid("Jenis kendaraan tidak ditemukan atau nonaktif."));
        }
        if ada(
            tx,
            "SELECT 1 FROM drv_kendaraan WHERE identitas = ? AND id_kendaraan <> ?;",
            &[&valid.identitas, &id],
        )? {
            return Err(invalid("Plat atau nomor kendaraan sudah terdaftar."));
        }
        tx.execute(
            "INSERT INTO drv_kendaraan (id_kendaraan, id_jenis, identitas, nama, catatan,
                status_aktif, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_kendaraan) DO UPDATE SET id_jenis = excluded.id_jenis,
                identitas = excluded.identitas, nama = excluded.nama,
                catatan = excluded.catatan, status_aktif = excluded.status_aktif,
                updated_at = datetime('now');",
            params![
                id,
                valid.id_jenis,
                valid.identitas,
                valid.nama,
                valid.catatan,
                valid.status_aktif as i64
            ],
        )
        .map_err(internal)?;
        let payload = satu_json(
            tx,
            "SELECT * FROM drv_kendaraan WHERE id_kendaraan = ?;",
            &[&id],
        )?;
        sync::enqueue(tx, client_id, "vehicle", "save", &id, &payload, None)?;
        Ok(json!({ "sukses": true, "id": id }))
    })
}

pub fn simpan_lokasi(state: &DesktopState, draft: Value) -> Result<Value, CommandError> {
    let draft: LokasiDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data lokasi tidak valid."))?;
    let valid = validate_lokasi(&draft).map_err(invalid)?;
    dalam_transaksi(state, |tx, client_id| {
        let id = match clean(&draft.id_lokasi) {
            Some(id) => {
                if !ada(tx, "SELECT 1 FROM drv_lokasi WHERE id_lokasi = ?;", &[&id])? {
                    return Err(invalid("Lokasi tidak ditemukan."));
                }
                id
            }
            None => new_hex_id("lok-"),
        };
        tx.execute(
            "INSERT INTO drv_lokasi (id_lokasi, nama, jenis, lat, lng, radius_m, status_aktif,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_lokasi) DO UPDATE SET nama = excluded.nama, jenis = excluded.jenis,
                lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
                status_aktif = excluded.status_aktif, updated_at = datetime('now');",
            params![
                id,
                valid.nama,
                valid.jenis,
                valid.lat,
                valid.lng,
                valid.radius_m,
                valid.status_aktif as i64
            ],
        )
        .map_err(internal)?;
        let payload = satu_json(tx, "SELECT * FROM drv_lokasi WHERE id_lokasi = ?;", &[&id])?;
        sync::enqueue(tx, client_id, "trip-place", "save", &id, &payload, None)?;
        Ok(json!({ "sukses": true, "id": id }))
    })
}

/// Baris `drv_laporan` milik sendiri; `pinjam` memberi bentuk aturan turunan.
struct LaporanMilik {
    id_laporan: String,
    jenis: String,
    mode_ganti: Option<String>,
    id_ref: Option<String>,
    waktu_perangkat: String,
    diterima_cloud: Option<String>,
    id_karyawan: Option<String>,
    id_karyawan_baru: Option<String>,
    id_kendaraan_baru: Option<String>,
    id_lokasi: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    akurasi_m: Option<f64>,
    foto_sha256: Option<String>,
}

impl LaporanMilik {
    fn pinjam(&self) -> Laporan<'_> {
        Laporan {
            id_laporan: &self.id_laporan,
            jenis: &self.jenis,
            mode_ganti: self.mode_ganti.as_deref(),
            id_ref: self.id_ref.as_deref(),
            waktu_perangkat: &self.waktu_perangkat,
            diterima_cloud: self.diterima_cloud.as_deref(),
            id_karyawan: self.id_karyawan.as_deref(),
            id_karyawan_baru: self.id_karyawan_baru.as_deref(),
            id_kendaraan_baru: self.id_kendaraan_baru.as_deref(),
            id_lokasi: self.id_lokasi.as_deref(),
            lat: self.lat,
            lng: self.lng,
            akurasi_m: self.akurasi_m,
            foto_sha256: self.foto_sha256.as_deref(),
        }
    }
}

fn baca_laporan(
    tx: &rusqlite::Connection,
    id_perjalanan: &str,
) -> Result<Vec<LaporanMilik>, CommandError> {
    Ok(baca_laporan_where(tx, "id_perjalanan = ?1", &[&id_perjalanan])?
        .into_iter()
        .map(|(_, laporan)| laporan)
        .collect())
}

/// Laporan beserta id surat jalannya untuk saringan `syarat` atas `drv_laporan`.
fn baca_laporan_where(
    tx: &rusqlite::Connection,
    syarat: &str,
    args: &[&dyn ToSql],
) -> Result<Vec<(String, LaporanMilik)>, CommandError> {
    let mut statement = tx
        .prepare(&format!(
            "SELECT id_laporan, jenis, mode_ganti, id_ref, waktu_perangkat, diterima_cloud,
                    id_karyawan, id_karyawan_baru, id_kendaraan_baru, id_lokasi, lat, lng,
                    akurasi_m, foto_sha256, id_perjalanan
             FROM drv_laporan WHERE {syarat}
             -- batas: laporan surat jalan yang dibaca saja, belasan per surat jalan
             ;"
        ))
        .map_err(internal)?;
    let baris = statement
        .query_map(args, |row| {
            Ok((
                row.get(14)?,
                LaporanMilik {
                    id_laporan: row.get(0)?,
                    jenis: row.get(1)?,
                    mode_ganti: row.get(2)?,
                    id_ref: row.get(3)?,
                    waktu_perangkat: row.get(4)?,
                    diterima_cloud: row.get(5)?,
                    id_karyawan: row.get(6)?,
                    id_karyawan_baru: row.get(7)?,
                    id_kendaraan_baru: row.get(8)?,
                    id_lokasi: row.get(9)?,
                    lat: row.get(10)?,
                    lng: row.get(11)?,
                    akurasi_m: row.get(12)?,
                    foto_sha256: row.get(13)?,
                },
            ))
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn enqueue_perjalanan(tx: &Transaction<'_>, client_id: &str, id: &str) -> Result<(), CommandError> {
    let payload = json!({
        "perjalanan": satu_json(tx, "SELECT * FROM drv_perjalanan WHERE id_perjalanan = ?;", &[&id])?,
        "muatan": kueri_json(
            tx,
            "SELECT * FROM drv_muatan WHERE id_perjalanan = ? ORDER BY urutan;",
            &[&id],
        )?,
    });
    sync::enqueue(tx, client_id, "trip", "save", id, &payload, None)?;
    Ok(())
}

/// Header + status turunan satu surat jalan di database perangkat.
struct KeadaanPerjalanan {
    id_karyawan: String,
    id_kendaraan: String,
    laporan: Vec<LaporanMilik>,
}

impl KeadaanPerjalanan {
    fn baca(tx: &Transaction<'_>, id: &str) -> Result<Self, CommandError> {
        let (id_karyawan, id_kendaraan): (String, String) = tx
            .query_row(
                "SELECT id_karyawan, id_kendaraan FROM drv_perjalanan WHERE id_perjalanan = ?;",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| invalid("Surat jalan tidak ditemukan."))?;
        Ok(Self {
            id_karyawan,
            id_kendaraan,
            laporan: baca_laporan(tx, id)?,
        })
    }

    fn laporan(&self) -> Vec<Laporan<'_>> {
        self.laporan.iter().map(LaporanMilik::pinjam).collect()
    }
}

/// Buat atau ubah surat jalan beserta seluruh muatannya (satu event
/// `trip/save`). Hanya selama Direncanakan. Tarif dikunci dari daftar saat
/// dibuat, dan hanya dibaca ulang bila jenis kendaraan atau kategorinya
/// berganti. Mengubah surat jalan mengosongkan `dicetak_pada`: cetak ulang.
pub fn simpan_perjalanan(
    state: &DesktopState,
    operator: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: PerjalananDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data surat jalan tidak valid."))?;
    let valid = validate_perjalanan(&draft).map_err(invalid)?;
    let seri = accounting::seri_perangkat(&license::current_device_code(state)?);
    dalam_transaksi(state, |tx, client_id| {
        if !ada(
            tx,
            "SELECT 1 FROM master_data WHERE id_unik = ? AND status_aktif = 'Aktif';",
            &[&valid.id_karyawan],
        )? {
            return Err(invalid("Driver tidak ditemukan atau nonaktif."));
        }
        let (id_jenis, tarif_jenis): (String, i64) = tx
            .query_row(
                "SELECT k.id_jenis, j.tarif FROM drv_kendaraan k
                 JOIN drv_jenis_kendaraan j ON j.id_jenis = k.id_jenis
                 WHERE k.id_kendaraan = ? AND k.status_aktif = 1;",
                params![valid.id_kendaraan],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| invalid("Kendaraan tidak ditemukan atau nonaktif."))?;
        let tarif_kategori: i64 = tx
            .query_row(
                "SELECT tarif FROM drv_kategori_tujuan WHERE id_kategori = ? AND status_aktif = 1;",
                params![valid.id_kategori],
                |row| row.get(0),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| invalid("Kategori tujuan tidak ditemukan atau nonaktif."))?;

        let id = match clean(&draft.id_perjalanan) {
            Some(id) => {
                let keadaan = KeadaanPerjalanan::baca(tx, &id)?;
                if status_perjalanan(&keadaan.laporan()) != "Direncanakan" {
                    return Err(invalid(
                        "Surat jalan yang sudah berjalan atau ditutup tidak bisa diubah.",
                    ));
                }
                tx.execute(
                    "UPDATE drv_perjalanan SET tanggal = ?, id_karyawan = ?, id_kendaraan = ?,
                        tarif_kendaraan = CASE WHEN id_jenis = ? THEN tarif_kendaraan ELSE ? END,
                        tarif_tujuan = CASE WHEN id_kategori = ? THEN tarif_tujuan ELSE ? END,
                        id_jenis = ?, id_kategori = ?, catatan = ?, dicetak_pada = NULL,
                        updated_at = datetime('now')
                     WHERE id_perjalanan = ?;",
                    params![
                        valid.tanggal,
                        valid.id_karyawan,
                        valid.id_kendaraan,
                        id_jenis,
                        tarif_jenis,
                        valid.id_kategori,
                        tarif_kategori,
                        id_jenis,
                        valid.id_kategori,
                        valid.catatan,
                        id
                    ],
                )
                .map_err(internal)?;
                id
            }
            None => {
                let id = new_hex_id("trp-");
                let prefix_setelan: Option<String> = tx
                    .query_row(
                        "SELECT value FROM setting_gex_system WHERE key = 'sj_prefix';",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(internal)?;
                let prefix = prefix_tersimpan(prefix_setelan.as_deref());
                let nomor_urut: i64 = tx
                    .query_row(
                        "SELECT COALESCE(MAX(nomor_urut), 0) + 1 FROM drv_perjalanan
                         WHERE seri = ? AND substr(tanggal, 1, 7) = substr(?, 1, 7);",
                        params![seri, valid.tanggal],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                tx.execute(
                    "INSERT INTO drv_perjalanan (id_perjalanan, tanggal, seri, nomor_urut, nomor,
                        id_karyawan, id_kendaraan, id_jenis, id_kategori, tarif_kendaraan,
                        tarif_tujuan, catatan, dibuat_oleh, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'));",
                    params![
                        id,
                        valid.tanggal,
                        seri,
                        nomor_urut,
                        format_nomor_surat_jalan(&prefix, &valid.tanggal, &seri, nomor_urut),
                        valid.id_karyawan,
                        valid.id_kendaraan,
                        id_jenis,
                        valid.id_kategori,
                        tarif_jenis,
                        tarif_kategori,
                        valid.catatan,
                        operator
                    ],
                )
                .map_err(internal)?;
                id
            }
        };
        for (indeks, m) in valid.muatan.iter().enumerate() {
            let urutan = indeks + 1;
            tx.execute(
                "INSERT INTO drv_muatan (id_muatan, id_perjalanan, urutan, tempat_muat,
                    tempat_bongkar, nama_barang, jenis_barang, qty, satuan, berat_kg_x100)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id_muatan) DO UPDATE SET tempat_muat = excluded.tempat_muat,
                    tempat_bongkar = excluded.tempat_bongkar, nama_barang = excluded.nama_barang,
                    jenis_barang = excluded.jenis_barang, qty = excluded.qty,
                    satuan = excluded.satuan, berat_kg_x100 = excluded.berat_kg_x100;",
                params![
                    id_muatan(&id, urutan),
                    id,
                    urutan as i64,
                    m.tempat_muat,
                    m.tempat_bongkar,
                    m.nama_barang,
                    m.jenis_barang,
                    m.qty,
                    m.satuan,
                    m.berat_kg_x100
                ],
            )
            .map_err(internal)?;
        }
        tx.execute(
            "DELETE FROM drv_muatan WHERE id_perjalanan = ? AND urutan > ?;",
            params![id, valid.muatan.len() as i64],
        )
        .map_err(internal)?;
        enqueue_perjalanan(tx, client_id, &id)?;
        Ok(json!({ "sukses": true, "id_perjalanan": id }))
    })
}

/// Menandai surat jalan sudah dicetak (dikosongkan lagi bila disunting).
pub fn tandai_dicetak(state: &DesktopState, id_perjalanan: &str) -> Result<Value, CommandError> {
    let id = id_perjalanan.trim();
    dalam_transaksi(state, |tx, client_id| {
        KeadaanPerjalanan::baca(tx, id)?;
        tx.execute(
            "UPDATE drv_perjalanan SET dicetak_pada = datetime('now'), updated_at = datetime('now')
             WHERE id_perjalanan = ?;",
            params![id],
        )
        .map_err(internal)?;
        enqueue_perjalanan(tx, client_id, id)?;
        Ok(json!({ "sukses": true }))
    })
}

/// Memindahkan upah surat jalan `Selesai` ke driver lain (`trip.tariff`).
/// `None` mengembalikannya ke aturan bawaan (`penerima_upah`).
pub fn atur_penerima_upah(
    state: &DesktopState,
    id_perjalanan: &str,
    id_karyawan: Option<&str>,
) -> Result<Value, CommandError> {
    let id = id_perjalanan.trim();
    let penerima = id_karyawan.map(str::trim).filter(|s| !s.is_empty());
    dalam_transaksi(state, |tx, client_id| {
        let keadaan = KeadaanPerjalanan::baca(tx, id)?;
        if status_perjalanan(&keadaan.laporan()) != "Selesai" {
            return Err(invalid("Upah hanya untuk surat jalan yang Selesai."));
        }
        if let Some(penerima) = penerima {
            if !ada(
                tx,
                "SELECT 1 FROM master_data WHERE id_unik = ?;",
                &[&penerima],
            )? {
                return Err(invalid("Penerima upah tidak ditemukan."));
            }
        }
        tx.execute(
            "UPDATE drv_perjalanan SET id_karyawan_upah = ?, updated_at = datetime('now')
             WHERE id_perjalanan = ?;",
            params![penerima, id],
        )
        .map_err(internal)?;
        enqueue_perjalanan(tx, client_id, id)?;
        Ok(json!({ "sukses": true }))
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FotoLaporanDraft {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub data_base64: String,
}

/// Catat satu laporan. `id_karyawan_sesi` = personil milik akun Driver yang
/// login (laporan dari HP driver), `None` = dispatcher. Driver hanya boleh
/// melapor di surat jalan yang sedang ditugaskan kepadanya, kecuali mengambil
/// alih lewat `Ganti Driver` atas namanya sendiri (aturan 44).
///
/// `id_laporan` dibuat klien sekali per penekanan tombol: kiriman ulang
/// dengan id yang sama tidak mencatat dua kali.
pub fn catat_laporan(
    state: &DesktopState,
    operator: &str,
    id_karyawan_sesi: Option<&str>,
    draft: Value,
    foto: Option<FotoLaporanDraft>,
) -> Result<Value, CommandError> {
    let draft: LaporanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data laporan tidak valid."))?;
    if let Some(foto) = &foto {
        validate_foto_laporan(&foto.mime_type, &foto.data_base64).map_err(invalid)?;
    }
    let oleh_driver = id_karyawan_sesi.is_some();
    let valid = validate_laporan(&draft, oleh_driver, foto.is_some()).map_err(invalid)?;
    let foto_sha256 = match &foto {
        Some(foto) => {
            Some(sidik_foto(&foto.data_base64).ok_or_else(|| invalid("Foto tidak terbaca."))?)
        }
        None => None,
    };
    let id_laporan = clean(&draft.id_laporan).unwrap_or_else(|| new_hex_id("lap-"));

    dalam_transaksi(state, |tx, client_id| {
        if ada(
            tx,
            "SELECT 1 FROM drv_laporan WHERE id_laporan = ?;",
            &[&id_laporan],
        )? {
            return Ok(json!({ "sukses": true, "id_laporan": id_laporan, "sudah_tercatat": true }));
        }
        let keadaan = KeadaanPerjalanan::baca(tx, &valid.id_perjalanan)?;
        let laporan = keadaan.laporan();
        periksa_urutan(&laporan, &valid.jenis).map_err(invalid)?;
        let bertugas = penugasan(&keadaan.id_karyawan, &keadaan.id_kendaraan, &laporan);
        if let Some(sesi) = id_karyawan_sesi {
            // Personil yang dinonaktifkan setelah login (sesi offline) ikut ditolak.
            if !ada(
                tx,
                "SELECT 1 FROM master_data WHERE id_unik = ? AND status_aktif = 'Aktif';",
                &[&sesi],
            )? {
                return Err(CommandError::new(
                    "DESKTOP_ACCESS_DENIED",
                    "Data personil akun ini nonaktif.",
                ));
            }
            let ambil_alih =
                valid.jenis == "Ganti Driver" && valid.id_karyawan_baru.as_deref() == Some(sesi);
            if bertugas.id_karyawan != sesi && !ambil_alih {
                return Err(CommandError::new(
                    "DESKTOP_ACCESS_DENIED",
                    "Surat jalan ini tidak sedang ditugaskan kepada Anda.",
                ));
            }
        }
        if let Some(id_ref) = &valid.id_ref {
            validate_keputusan(&laporan, id_ref).map_err(invalid)?;
        }
        if let Some(baru) = &valid.id_karyawan_baru {
            if *baru == bertugas.id_karyawan {
                return Err(invalid(
                    "Driver pengganti sama dengan driver yang bertugas.",
                ));
            }
            if !ada(
                tx,
                "SELECT 1 FROM master_data WHERE id_unik = ? AND status_aktif = 'Aktif';",
                &[baru],
            )? {
                return Err(invalid("Driver pengganti tidak ditemukan atau nonaktif."));
            }
        }
        if let Some(baru) = &valid.id_kendaraan_baru {
            if *baru == bertugas.id_kendaraan {
                return Err(invalid(
                    "Kendaraan pengganti sama dengan kendaraan yang bertugas.",
                ));
            }
            if !ada(
                tx,
                "SELECT 1 FROM drv_kendaraan WHERE id_kendaraan = ? AND status_aktif = 1;",
                &[baru],
            )? {
                return Err(invalid(
                    "Kendaraan pengganti tidak ditemukan atau nonaktif.",
                ));
            }
        }
        if let Some(lokasi) = &valid.id_lokasi {
            if !ada(
                tx,
                "SELECT 1 FROM drv_lokasi WHERE id_lokasi = ?;",
                &[lokasi],
            )? {
                return Err(invalid("Lokasi tidak ditemukan."));
            }
        }
        for m in &valid.muatan {
            if !ada(
                tx,
                "SELECT 1 FROM drv_muatan WHERE id_muatan = ? AND id_perjalanan = ?;",
                &[&m.id_muatan, &valid.id_perjalanan],
            )? {
                return Err(invalid("Barang muatan tidak dikenal."));
            }
        }
        drop(laporan);

        tx.execute(
            "INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, mode_ganti, id_ref,
                jenis_kendala, terlambat_menit, id_lokasi, nama_lokasi, lat, lng, akurasi_m,
                waktu_perangkat, waktu_gps, id_karyawan, id_karyawan_baru, id_kendaraan_baru,
                keterangan, foto_sha256, dilaporkan_oleh, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'));",
            params![
                id_laporan,
                valid.id_perjalanan,
                valid.jenis,
                valid.mode_ganti,
                valid.id_ref,
                valid.jenis_kendala,
                valid.terlambat_menit,
                valid.id_lokasi,
                valid.nama_lokasi,
                valid.lat,
                valid.lng,
                valid.akurasi_m,
                valid.waktu_perangkat,
                valid.waktu_gps,
                id_karyawan_sesi,
                valid.id_karyawan_baru,
                valid.id_kendaraan_baru,
                valid.keterangan,
                foto_sha256,
                operator
            ],
        )
        .map_err(internal)?;
        for (indeks, m) in valid.muatan.iter().enumerate() {
            tx.execute(
                "INSERT INTO drv_laporan_muatan (id_baris, id_laporan, id_muatan, qty, berat_kg_x100)
                 VALUES (?, ?, ?, ?, ?);",
                params![
                    format!("{id_laporan}-{}", indeks + 1),
                    id_laporan,
                    m.id_muatan,
                    m.qty,
                    m.berat_kg_x100
                ],
            )
            .map_err(internal)?;
        }
        let payload = json!({
            "laporan": satu_json(tx, "SELECT * FROM drv_laporan WHERE id_laporan = ?;", &[&id_laporan])?,
            "muatan": kueri_json(
                tx,
                "SELECT * FROM drv_laporan_muatan WHERE id_laporan = ? ORDER BY id_baris;",
                &[&id_laporan],
            )?,
        });
        sync::enqueue(
            tx,
            client_id,
            "trip-report",
            "create",
            &id_laporan,
            &payload,
            None,
        )?;
        if let Some(foto) = &foto {
            tx.execute(
                "INSERT INTO drv_laporan_foto (id_laporan, mime_type, data_base64, created_at)
                 VALUES (?, ?, ?, datetime('now'));",
                params![id_laporan, foto.mime_type, foto.data_base64],
            )
            .map_err(internal)?;
            // Event foto terpisah supaya event laporan tetap kecil (pola foto penerimaan).
            let payload = json!({
                "id_laporan": id_laporan,
                "mime_type": foto.mime_type,
                "data_base64": foto.data_base64,
            });
            sync::enqueue(
                tx,
                client_id,
                "trip-report-photo",
                "save",
                &id_laporan,
                &payload,
                None,
            )?;
        }
        Ok(json!({ "sukses": true, "id_laporan": id_laporan }))
    })
}

// ── Pengaturan dan pembacaan untuk layar dispatcher ────────────────────────

pub const KUNCI_PREFIX_SJ: &str = "sj_prefix";
/// Cermin `MAKS_DAFTAR_PERJALANAN`.
pub const MAKS_DAFTAR_PERJALANAN: usize = 500;

/// Simpan awalan nomor surat jalan. Nomor yang sudah ada tidak berubah.
pub fn simpan_prefix(state: &DesktopState, masukan: &str) -> Result<Value, CommandError> {
    let prefix = normalisasi_prefix(masukan).map_err(invalid)?;
    dalam_transaksi(state, |tx, client_id| {
        tx.execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![KUNCI_PREFIX_SJ, prefix],
        )
        .map_err(internal)?;
        // Hanya nilai terakhir yang perlu sampai ke cloud (pola kode prefix inventaris).
        tx.execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ?1
               AND status IN ('pending', 'failed', 'conflict');",
            params![KUNCI_PREFIX_SJ],
        )
        .map_err(internal)?;
        sync::enqueue(
            tx,
            client_id,
            "setting",
            "update",
            KUNCI_PREFIX_SJ,
            &json!({ "key": KUNCI_PREFIX_SJ, "value": prefix }),
            None,
        )?;
        Ok(json!({ "sukses": true, "prefix": prefix }))
    })
}

/// Cermin `masterPerjalanan`: daftar pilihan untuk formulir dan nama tampilan.
pub fn master_perjalanan(state: &DesktopState) -> Result<Value, CommandError> {
    let c = storage::database(&state.data_dir)?;
    let prefix: Option<String> = c
        .query_row(
            "SELECT value FROM setting_gex_system WHERE key = ?1;",
            params![KUNCI_PREFIX_SJ],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    Ok(json!({
        "prefix": prefix_tersimpan(prefix.as_deref()),
        "jenis": kueri_json(&c, "SELECT id_jenis, nama, tarif, status_aktif FROM drv_jenis_kendaraan ORDER BY nama;", &[])?,
        "kategori": kueri_json(&c, "SELECT id_kategori, nama, tarif, status_aktif FROM drv_kategori_tujuan ORDER BY nama;", &[])?,
        "kendaraan": kueri_json(&c, "SELECT id_kendaraan, id_jenis, identitas, nama, catatan, status_aktif FROM drv_kendaraan ORDER BY identitas;", &[])?,
        "lokasi": kueri_json(&c, "SELECT id_lokasi, nama, jenis, lat, lng, radius_m, status_aktif FROM drv_lokasi ORDER BY nama;", &[])?,
        "personil": kueri_json(&c, "SELECT id_unik, nama, divisi FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;", &[])?,
    }))
}

fn teks_json(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn nama_dari(peta: &std::collections::HashMap<String, String>, id: Option<&str>) -> Value {
    id.and_then(|id| peta.get(id)).map_or(Value::Null, |nama| json!(nama))
}

fn peta_nama(
    c: &rusqlite::Connection,
    sql: &str,
) -> Result<std::collections::HashMap<String, String>, CommandError> {
    let mut statement = c.prepare(sql).map_err(internal)?;
    let baris = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

/// Satu item surat jalan + turunannya, untuk daftar dan rincian. `syarat` =
/// saringan atas `drv_perjalanan p`. Cermin `kumpulkanPerjalanan`.
fn kumpulkan(
    c: &rusqlite::Connection,
    syarat: &str,
    args: &[&dyn ToSql],
) -> Result<Vec<Value>, CommandError> {
    use std::collections::HashMap;
    let headers = kueri_json(
        c,
        &format!(
            "SELECT p.* FROM drv_perjalanan p WHERE {syarat}
             ORDER BY p.tanggal DESC, p.nomor DESC
             LIMIT {MAKS_DAFTAR_PERJALANAN};"
        ),
        args,
    )?;
    let dalam = format!("id_perjalanan IN (SELECT p.id_perjalanan FROM drv_perjalanan p WHERE {syarat})");
    let mut laporan: HashMap<String, Vec<LaporanMilik>> = HashMap::new();
    for (id, l) in baca_laporan_where(c, &dalam, args)? {
        laporan.entry(id).or_default().push(l);
    }
    let mut rencana: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for row in kueri_json(
        c,
        &format!("SELECT id_perjalanan, id_muatan, qty FROM drv_muatan WHERE {dalam};"),
        args,
    )? {
        rencana
            .entry(teks_json(&row, "id_perjalanan").unwrap_or_default())
            .or_default()
            .push((
                teks_json(&row, "id_muatan").unwrap_or_default(),
                row["qty"].as_i64().unwrap_or(0),
            ));
    }
    let mut dilapor: HashMap<String, Vec<(String, String, i64)>> = HashMap::new();
    for row in kueri_json(
        c,
        &format!(
            "SELECT l.id_perjalanan, m.id_laporan, m.id_muatan, m.qty
             FROM drv_laporan_muatan m JOIN drv_laporan l ON l.id_laporan = m.id_laporan
             WHERE l.{dalam};"
        ),
        args,
    )? {
        dilapor
            .entry(teks_json(&row, "id_perjalanan").unwrap_or_default())
            .or_default()
            .push((
                teks_json(&row, "id_laporan").unwrap_or_default(),
                teks_json(&row, "id_muatan").unwrap_or_default(),
                row["qty"].as_i64().unwrap_or(0),
            ));
    }
    let lokasi_rows = kueri_json(c, "SELECT id_lokasi, lat, lng, radius_m FROM drv_lokasi;", &[])?;
    let lokasi_id: Vec<String> = lokasi_rows
        .iter()
        .map(|r| teks_json(r, "id_lokasi").unwrap_or_default())
        .collect();
    let lokasi: Vec<LokasiTerdaftar<'_>> = lokasi_rows
        .iter()
        .zip(&lokasi_id)
        .map(|(r, id)| LokasiTerdaftar {
            id_lokasi: id,
            lat: r["lat"].as_f64().unwrap_or(0.0),
            lng: r["lng"].as_f64().unwrap_or(0.0),
            radius_m: r["radius_m"].as_i64().unwrap_or(0),
        })
        .collect();
    let nama_personil = peta_nama(c, "SELECT id_unik, nama FROM master_data;")?;
    let identitas = peta_nama(c, "SELECT id_kendaraan, identitas FROM drv_kendaraan;")?;
    let nama_kategori = peta_nama(c, "SELECT id_kategori, nama FROM drv_kategori_tujuan;")?;

    let kosong_laporan = Vec::new();
    let kosong_rencana = Vec::new();
    let kosong_dilapor = Vec::new();
    let mut items = Vec::with_capacity(headers.len());
    for h in headers {
        let id = teks_json(&h, "id_perjalanan").unwrap_or_default();
        let milik = laporan.get(&id).unwrap_or(&kosong_laporan);
        let refs: Vec<Laporan<'_>> = milik.iter().map(LaporanMilik::pinjam).collect();
        let awal_karyawan = teks_json(&h, "id_karyawan").unwrap_or_default();
        let awal_kendaraan = teks_json(&h, "id_kendaraan").unwrap_or_default();
        let status = status_perjalanan(&refs);
        let tugas = penugasan(&awal_karyawan, &awal_kendaraan, &refs);
        let rencana_trip: Vec<MuatanRencana<'_>> = rencana
            .get(&id)
            .unwrap_or(&kosong_rencana)
            .iter()
            .map(|(id_muatan, qty)| MuatanRencana { id_muatan, qty: *qty })
            .collect();
        let dilapor_trip: Vec<MuatanLapor<'_>> = dilapor
            .get(&id)
            .unwrap_or(&kosong_dilapor)
            .iter()
            .map(|(id_laporan, id_muatan, qty)| MuatanLapor { id_laporan, id_muatan, qty: *qty })
            .collect();
        let tanda: Vec<Value> = tanda_tinjau(&refs, &lokasi, &rencana_trip, &dilapor_trip, AKURASI_PERINGATAN_M)
            .into_iter()
            .map(|t| json!({ "kode": t.kode, "id": t.id }))
            .collect();
        let tarif_kendaraan = h["tarif_kendaraan"].as_i64().unwrap_or(0);
        let tarif_tujuan = h["tarif_tujuan"].as_i64().unwrap_or(0);
        let id_upah = teks_json(&h, "id_karyawan_upah");
        let penerima = penerima_upah(status, id_upah.as_deref(), &refs, &tugas.id_karyawan);
        let terakhir = urutkan(&refs)
            .last()
            .map(|l| json!({ "jenis": l.jenis, "waktu_perangkat": l.waktu_perangkat }))
            .unwrap_or(Value::Null);
        items.push(json!({
            "id_perjalanan": id,
            "tanggal": h["tanggal"],
            "nomor": h["nomor"],
            "status": status,
            "catatan": h["catatan"],
            "dicetak_pada": h["dicetak_pada"],
            "dibuat_oleh": h["dibuat_oleh"],
            "id_karyawan_awal": awal_karyawan,
            "id_kendaraan_awal": awal_kendaraan,
            "id_karyawan": tugas.id_karyawan,
            "nama_karyawan": nama_dari(&nama_personil, Some(&tugas.id_karyawan)),
            "id_kendaraan": tugas.id_kendaraan,
            "identitas_kendaraan": nama_dari(&identitas, Some(&tugas.id_kendaraan)),
            "id_jenis": h["id_jenis"],
            "id_kategori": h["id_kategori"],
            "nama_kategori": nama_dari(&nama_kategori, h["id_kategori"].as_str()),
            "tarif_kendaraan": tarif_kendaraan,
            "tarif_tujuan": tarif_tujuan,
            "upah": upah_surat_jalan(tarif_kendaraan, tarif_tujuan),
            "id_karyawan_upah": id_upah,
            "penerima_upah": penerima,
            "nama_penerima_upah": nama_dari(&nama_personil, penerima.as_deref()),
            "jumlah_muatan": rencana_trip.len(),
            "laporan_terakhir": terakhir,
            "menunggu_persetujuan": ganti_menunggu(&refs),
            "tanda": tanda,
        }));
    }
    Ok(items)
}

/// Cermin `daftarPerjalanan`: surat jalan bertanggal `dari`..`sampai`.
pub fn daftar_perjalanan(state: &DesktopState, dari: &str, sampai: &str) -> Result<Value, CommandError> {
    let (dari, sampai) = (dari.trim(), sampai.trim());
    if !is_valid_date(dari) || !is_valid_date(sampai) || dari > sampai {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    let c = storage::database(&state.data_dir)?;
    Ok(json!({ "items": kumpulkan(&c, "p.tanggal BETWEEN ?1 AND ?2", &[&dari, &sampai])? }))
}

/// Cermin `rincianPerjalanan`: item + muatan + linimasa laporan beserta
/// rincian muatannya. `foto_lokal` = foto tersedia di perangkat ini.
pub fn rincian_perjalanan(state: &DesktopState, id_perjalanan: &str) -> Result<Value, CommandError> {
    let id = id_perjalanan.trim();
    let c = storage::database(&state.data_dir)?;
    let item = kumpulkan(&c, "p.id_perjalanan = ?1", &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Surat jalan tidak ditemukan."))?;
    let mut laporan = kueri_json(
        &c,
        "SELECT l.*, EXISTS (SELECT 1 FROM drv_laporan_foto f WHERE f.id_laporan = l.id_laporan) AS foto_lokal
         FROM drv_laporan l WHERE l.id_perjalanan = ?1
         ORDER BY l.waktu_perangkat, l.id_laporan
         -- batas: laporan satu surat jalan, belasan baris
         ;",
        &[&id],
    )?;
    let rincian = kueri_json(
        &c,
        "SELECT m.id_laporan, m.id_muatan, m.qty, m.berat_kg_x100
         FROM drv_laporan_muatan m JOIN drv_laporan l ON l.id_laporan = m.id_laporan
         WHERE l.id_perjalanan = ?1 ORDER BY m.id_baris;",
        &[&id],
    )?;
    for l in &mut laporan {
        let milik: Vec<Value> = rincian
            .iter()
            .filter(|m| m["id_laporan"] == l["id_laporan"])
            .cloned()
            .collect();
        l["muatan"] = json!(milik);
    }
    Ok(json!({
        "item": item,
        "muatan": kueri_json(&c, "SELECT * FROM drv_muatan WHERE id_perjalanan = ?1 ORDER BY urutan;", &[&id])?,
        "laporan": laporan,
    }))
}

// ── Masa simpan foto 90 hari (PRD §6.3, Q-9) ───────────────────────────────
//
// Foto dihapus, baris laporan + koordinat + `foto_sha256` tetap. Batasnya jam
// database (aturan 19). Cloud dan salinan lokal perangkat masing-masing
// menghapus sendiri; penghapusan tidak masuk outbox (foto di luar snapshot).
// Foto yang masih mengantre di outbox tetap terkirim: isinya ada di payload.

/// Cermin `HAPUS_FOTO_LAMA_SQL`.
pub const HAPUS_FOTO_LAMA_SQL: &str =
    "DELETE FROM drv_laporan_foto WHERE created_at < datetime('now', '-90 days');";

/// Cermin `FOTO_SEGERA_DIHAPUS_SQL`: foto yang terhapus dalam 7 hari ke depan,
/// beserta tanggal WIB laporan tertuanya untuk rentang unduhan.
pub const FOTO_SEGERA_DIHAPUS_SQL: &str = "SELECT COUNT(*) AS jumlah,
        MIN(date(l.waktu_perangkat, '+7 hours')) AS tanggal_tertua
     FROM drv_laporan_foto f LEFT JOIN drv_laporan l ON l.id_laporan = f.id_laporan
     WHERE f.created_at < datetime('now', '-83 days');";

pub fn hapus_foto_lama_lokal(state: &DesktopState) -> Result<i64, CommandError> {
    let c = storage::database(&state.data_dir)?;
    let terhapus = c.execute(HAPUS_FOTO_LAMA_SQL, []).map_err(internal)?;
    Ok(terhapus as i64)
}

pub fn foto_segera_dihapus_lokal(state: &DesktopState) -> Result<Value, CommandError> {
    let c = storage::database(&state.data_dir)?;
    satu_json(&c, FOTO_SEGERA_DIHAPUS_SQL, &[])
}

// ── Layar driver: hanya perjalanan miliknya (PRD §6.4, disaring di backend) ─

/// Perjalanan yang sedang ditugaskan kepada `id_karyawan` dalam rentang, plus
/// daftar ringkas perjalanan terbuka milik driver lain (untuk ambil alih
/// darurat) dan pilihan yang dibutuhkan formulir laporan.
pub fn perjalanan_saya(
    state: &DesktopState,
    id_karyawan: &str,
    dari: &str,
    sampai: &str,
) -> Result<Value, CommandError> {
    let (dari, sampai) = (dari.trim(), sampai.trim());
    if !is_valid_date(dari) || !is_valid_date(sampai) || dari > sampai {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    let c = storage::database(&state.data_dir)?;
    let (saya, lain): (Vec<Value>, Vec<Value>) =
        kumpulkan(&c, "p.tanggal BETWEEN ?1 AND ?2", &[&dari, &sampai])?
            .into_iter()
            .partition(|item| item["id_karyawan"] == id_karyawan);
    let lain: Vec<Value> = lain
        .into_iter()
        .filter(|item| matches!(item["status"].as_str(), Some("Direncanakan" | "Berjalan")))
        .map(|item| {
            json!({
                "id_perjalanan": item["id_perjalanan"],
                "tanggal": item["tanggal"],
                "nomor": item["nomor"],
                "status": item["status"],
                "nama_karyawan": item["nama_karyawan"],
                "identitas_kendaraan": item["identitas_kendaraan"],
            })
        })
        .collect();
    let nama: Option<String> = c
        .query_row(
            "SELECT nama FROM master_data WHERE id_unik = ?1;",
            params![id_karyawan],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    Ok(json!({
        "id_karyawan": id_karyawan,
        "nama": nama,
        "saya": saya,
        "lain": lain,
        "lokasi": kueri_json(&c, "SELECT id_lokasi, nama, jenis, lat, lng, radius_m FROM drv_lokasi WHERE status_aktif = 1 ORDER BY nama;", &[])?,
        "kendaraan": kueri_json(
            &c,
            "SELECT k.id_kendaraan, k.identitas, j.nama AS nama_jenis
             FROM drv_kendaraan k LEFT JOIN drv_jenis_kendaraan j ON j.id_jenis = k.id_jenis
             WHERE k.status_aktif = 1 ORDER BY k.identitas;",
            &[],
        )?,
        "personil": kueri_json(&c, "SELECT id_unik, nama FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;", &[])?,
    }))
}

/// Rincian satu perjalanan untuk driver yang sedang bertugas di sana saja.
pub fn rincian_saya(
    state: &DesktopState,
    id_karyawan: &str,
    id_perjalanan: &str,
) -> Result<Value, CommandError> {
    let rincian = rincian_perjalanan(state, id_perjalanan)?;
    if rincian["item"]["id_karyawan"] != id_karyawan {
        return Err(CommandError::new(
            "DESKTOP_ACCESS_DENIED",
            "Surat jalan ini tidak sedang ditugaskan kepada Anda.",
        ));
    }
    Ok(rincian)
}

/// Foto laporan dari SQLite lokal; `None` bila perangkat ini tidak memilikinya
/// (diambil dari cloud oleh command-nya).
pub fn foto_laporan_lokal(state: &DesktopState, id_laporan: &str) -> Result<Option<Value>, CommandError> {
    let c = storage::database(&state.data_dir)?;
    c.query_row(
        "SELECT mime_type, data_base64 FROM drv_laporan_foto WHERE id_laporan = ?1;",
        params![id_laporan.trim()],
        |row| {
            Ok(json!({
                "mime_type": row.get::<_, String>(0)?,
                "data_base64": row.get::<_, String>(1)?,
            }))
        },
    )
    .optional()
    .map_err(internal)
}

// ── Statement cloud ────────────────────────────────────────────────────────
//
// Payload yang tidak lolos CHECK cloud menghasilkan `None`: event-nya menjadi
// konflik (aturan 5), tidak ditolak berulang yang membuat outbox macet. Laporan
// TIDAK PERNAH ditolak karena urutan, status, atau driver yang sudah diganti.

pub const CLOUD_UPSERT_JENIS_SQL: &str = "INSERT INTO drv_jenis_kendaraan (
        id_jenis, nama, tarif, status_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_jenis) DO UPDATE SET nama = excluded.nama, tarif = excluded.tarif,
        status_aktif = excluded.status_aktif, updated_at = datetime('now');";

pub const CLOUD_UPSERT_KATEGORI_SQL: &str = "INSERT INTO drv_kategori_tujuan (
        id_kategori, nama, tarif, status_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_kategori) DO UPDATE SET nama = excluded.nama, tarif = excluded.tarif,
        status_aktif = excluded.status_aktif, updated_at = datetime('now');";

pub const CLOUD_UPSERT_KENDARAAN_SQL: &str = "INSERT INTO drv_kendaraan (
        id_kendaraan, id_jenis, identitas, nama, catatan, status_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_kendaraan) DO UPDATE SET id_jenis = excluded.id_jenis,
        identitas = excluded.identitas, nama = excluded.nama, catatan = excluded.catatan,
        status_aktif = excluded.status_aktif, updated_at = datetime('now');";

pub const CLOUD_UPSERT_LOKASI_SQL: &str = "INSERT INTO drv_lokasi (
        id_lokasi, nama, jenis, lat, lng, radius_m, status_aktif, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_lokasi) DO UPDATE SET nama = excluded.nama, jenis = excluded.jenis,
        lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
        status_aktif = excluded.status_aktif, updated_at = datetime('now');";

/// Nomor, seri, pembuat, dan waktu buat tidak pernah berubah setelah lahir.
pub const CLOUD_UPSERT_PERJALANAN_SQL: &str = "INSERT INTO drv_perjalanan (
        id_perjalanan, tanggal, seri, nomor_urut, nomor, id_karyawan, id_kendaraan, id_jenis,
        id_kategori, tarif_kendaraan, tarif_tujuan, id_karyawan_upah, catatan, dicetak_pada,
        dibuat_oleh, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_perjalanan) DO UPDATE SET tanggal = excluded.tanggal,
        id_karyawan = excluded.id_karyawan, id_kendaraan = excluded.id_kendaraan,
        id_jenis = excluded.id_jenis, id_kategori = excluded.id_kategori,
        tarif_kendaraan = excluded.tarif_kendaraan, tarif_tujuan = excluded.tarif_tujuan,
        id_karyawan_upah = excluded.id_karyawan_upah, catatan = excluded.catatan,
        dicetak_pada = excluded.dicetak_pada, updated_at = datetime('now');";

pub const CLOUD_UPSERT_MUATAN_SQL: &str = "INSERT INTO drv_muatan (
        id_muatan, id_perjalanan, urutan, tempat_muat, tempat_bongkar, nama_barang,
        jenis_barang, qty, satuan, berat_kg_x100
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_muatan) DO UPDATE SET tempat_muat = excluded.tempat_muat,
        tempat_bongkar = excluded.tempat_bongkar, nama_barang = excluded.nama_barang,
        jenis_barang = excluded.jenis_barang, qty = excluded.qty, satuan = excluded.satuan,
        berat_kg_x100 = excluded.berat_kg_x100;";

pub const CLOUD_BUANG_MUATAN_SQL: &str =
    "DELETE FROM drv_muatan WHERE id_perjalanan = ? AND urutan > ?;";

/// `diterima_cloud` selalu jam database cloud (aturan 19).
pub const CLOUD_INSERT_LAPORAN_SQL: &str = "INSERT INTO drv_laporan (
        id_laporan, id_perjalanan, jenis, mode_ganti, id_ref, jenis_kendala, terlambat_menit,
        id_lokasi, nama_lokasi, lat, lng, akurasi_m, waktu_perangkat, waktu_gps, diterima_cloud,
        id_karyawan, id_karyawan_baru, id_kendaraan_baru, keterangan, foto_sha256,
        dilaporkan_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?,
        COALESCE(?, datetime('now')))
    ON CONFLICT(id_laporan) DO NOTHING;";

pub const CLOUD_INSERT_LAPORAN_MUATAN_SQL: &str = "INSERT INTO drv_laporan_muatan (
        id_baris, id_laporan, id_muatan, qty, berat_kg_x100
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id_baris) DO NOTHING;";

pub const CLOUD_INSERT_FOTO_LAPORAN_SQL: &str = "INSERT INTO drv_laporan_foto (
        id_laporan, mime_type, data_base64, created_at
    ) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id_laporan) DO NOTHING;";

const MODE_GANTI: [&str; 3] = ["Langsung", "Darurat", "Minta Izin"];

/// `Some(None)` = kosong; `None` = ada isinya tetapi bukan angka (payload cacat).
fn angka_opsional(row: &Value, key: &str) -> Option<Option<f64>> {
    match row.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(nilai) => nilai.as_f64().filter(|f| f.is_finite()).map(Some),
    }
}

fn bulat_opsional(row: &Value, key: &str) -> Option<Option<i64>> {
    match row.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(nilai) => nilai.as_i64().map(Some),
    }
}

fn aktif_payload(row: &Value) -> Option<bool> {
    match row.get("status_aktif").and_then(Value::as_i64)? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn id_payload(row: &Value, kolom: &str, entity_key: &str) -> Option<String> {
    payload_text(row, kolom)
        .or_else(|| Some(entity_key.trim().to_owned()))
        .filter(|id| !id.is_empty())
}

/// `vehicle-type/save` dan `trip-destination/save`.
pub fn cloud_daftar_tarif_values(
    daftar: &DaftarTarif,
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<Value>> {
    let id = id_payload(payload, daftar.kolom_id, entity_key)?;
    let draft = DaftarTarifDraft {
        id: None,
        nama: payload_text(payload, "nama"),
        tarif: payload.get("tarif")?.as_i64()?,
        status_aktif: aktif_payload(payload)?,
    };
    let valid = validate_daftar_tarif(&draft, daftar.label).ok()?;
    Some(vec![
        json!(id),
        json!(valid.nama),
        json!(valid.tarif),
        json!(valid.status_aktif as i64),
        json!(payload_text(payload, "created_at")),
    ])
}

pub fn cloud_kendaraan_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = id_payload(payload, "id_kendaraan", entity_key)?;
    let draft = KendaraanDraft {
        id_kendaraan: None,
        id_jenis: payload_text(payload, "id_jenis"),
        identitas: payload_text(payload, "identitas"),
        nama: payload_text(payload, "nama"),
        catatan: payload_text(payload, "catatan"),
        status_aktif: aktif_payload(payload)?,
    };
    let valid = validate_kendaraan(&draft).ok()?;
    Some(vec![
        json!(id),
        json!(valid.id_jenis),
        json!(valid.identitas),
        json!(valid.nama),
        json!(valid.catatan),
        json!(valid.status_aktif as i64),
        json!(payload_text(payload, "created_at")),
    ])
}

pub fn cloud_lokasi_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = id_payload(payload, "id_lokasi", entity_key)?;
    let draft = LokasiDraft {
        id_lokasi: None,
        nama: payload_text(payload, "nama"),
        jenis: payload_text(payload, "jenis")?,
        lat: payload.get("lat")?.as_f64()?,
        lng: payload.get("lng")?.as_f64()?,
        radius_m: payload.get("radius_m")?.as_i64()?,
        status_aktif: aktif_payload(payload)?,
    };
    let valid = validate_lokasi(&draft).ok()?;
    Some(vec![
        json!(id),
        json!(valid.nama),
        json!(valid.jenis),
        json!(valid.lat),
        json!(valid.lng),
        json!(valid.radius_m),
        json!(valid.status_aktif as i64),
        json!(payload_text(payload, "created_at")),
    ])
}

/// `trip/save`: header dan seluruh muatan dalam SATU event, pola jurnal.
/// Muatan yang dibuang saat disunting ikut dihapus di cloud.
pub fn cloud_perjalanan_statements(
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let header = payload.get("perjalanan")?;
    let id = id_payload(header, "id_perjalanan", entity_key)?;
    let tanggal = payload_text(header, "tanggal").filter(|t| is_valid_date(t))?;
    let nomor_urut = header.get("nomor_urut")?.as_i64().filter(|n| *n > 0)?;
    let tarif = |key: &str| header.get(key)?.as_i64().filter(|n| *n >= 0);
    let mut statements = vec![(
        CLOUD_UPSERT_PERJALANAN_SQL,
        vec![
            json!(id),
            json!(tanggal),
            json!(payload_text(header, "seri")?),
            json!(nomor_urut),
            json!(payload_text(header, "nomor")?),
            json!(payload_text(header, "id_karyawan")?),
            json!(payload_text(header, "id_kendaraan")?),
            json!(payload_text(header, "id_jenis")?),
            json!(payload_text(header, "id_kategori")?),
            json!(tarif("tarif_kendaraan")?),
            json!(tarif("tarif_tujuan")?),
            json!(payload_text(header, "id_karyawan_upah")),
            json!(payload_text(header, "catatan")),
            json!(payload_text(header, "dicetak_pada")),
            json!(payload_text(header, "dibuat_oleh")?),
            json!(payload_text(header, "created_at")),
        ],
    )];
    let muatan = payload.get("muatan")?.as_array()?;
    if muatan.is_empty() || muatan.len() > MAKS_BARIS_MUATAN {
        return None;
    }
    for (indeks, row) in muatan.iter().enumerate() {
        let urutan = indeks + 1;
        if row.get("urutan")?.as_i64()? != urutan as i64
            || payload_text(row, "id_muatan")? != id_muatan(&id, urutan)
        {
            return None;
        }
        let berat = bulat_opsional(row, "berat_kg_x100")?;
        if !berat_sah(berat) {
            return None;
        }
        statements.push((
            CLOUD_UPSERT_MUATAN_SQL,
            vec![
                json!(id_muatan(&id, urutan)),
                json!(id),
                json!(urutan),
                json!(payload_text(row, "tempat_muat")?),
                json!(payload_text(row, "tempat_bongkar")),
                json!(payload_text(row, "nama_barang")?),
                json!(payload_text(row, "jenis_barang")),
                json!(row.get("qty")?.as_i64().filter(|n| *n > 0)?),
                json!(payload_text(row, "satuan")?),
                json!(berat),
            ],
        ));
    }
    statements.push((
        CLOUD_BUANG_MUATAN_SQL,
        vec![json!(id), json!(muatan.len() as i64)],
    ));
    Some(statements)
}

/// `trip-report/create`: append-only, kiriman ulang berhenti di PK. Hanya
/// CHECK cloud yang diperiksa; urutan dan penugasan tidak pernah.
pub fn cloud_laporan_statements(
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let row = payload.get("laporan")?;
    let id = id_payload(row, "id_laporan", entity_key)?;
    let jenis = payload_text(row, "jenis").filter(|j| JENIS_LAPORAN.contains(&j.as_str()))?;
    let mode_ganti = payload_text(row, "mode_ganti");
    let jenis_kendala = payload_text(row, "jenis_kendala");
    if mode_ganti
        .as_deref()
        .is_some_and(|m| !MODE_GANTI.contains(&m))
        || jenis_kendala
            .as_deref()
            .is_some_and(|k| !JENIS_KENDALA.contains(&k))
    {
        return None;
    }
    let terlambat = bulat_opsional(row, "terlambat_menit")?;
    let (lat, lng) = (angka_opsional(row, "lat")?, angka_opsional(row, "lng")?);
    let akurasi = angka_opsional(row, "akurasi_m")?;
    if terlambat.is_some_and(|m| m < 0)
        || lat.is_some_and(|v| !(-90.0..=90.0).contains(&v))
        || lng.is_some_and(|v| !(-180.0..=180.0).contains(&v))
        || akurasi.is_some_and(|a| a < 0.0)
    {
        return None;
    }
    let mut statements = vec![(
        CLOUD_INSERT_LAPORAN_SQL,
        vec![
            json!(id),
            json!(payload_text(row, "id_perjalanan")?),
            json!(jenis),
            json!(mode_ganti),
            json!(payload_text(row, "id_ref")),
            json!(jenis_kendala),
            json!(terlambat),
            json!(payload_text(row, "id_lokasi")),
            json!(payload_text(row, "nama_lokasi")),
            json!(lat),
            json!(lng),
            json!(akurasi),
            json!(payload_text(row, "waktu_perangkat")?),
            json!(payload_text(row, "waktu_gps")),
            json!(payload_text(row, "id_karyawan")),
            json!(payload_text(row, "id_karyawan_baru")),
            json!(payload_text(row, "id_kendaraan_baru")),
            json!(payload_text(row, "keterangan")),
            json!(payload_text(row, "foto_sha256")),
            json!(payload_text(row, "dilaporkan_oleh")?),
            json!(payload_text(row, "created_at")),
        ],
    )];
    let muatan = match payload.get("muatan") {
        None | Some(Value::Null) => &[][..],
        Some(nilai) => nilai.as_array()?.as_slice(),
    };
    if muatan.len() > MAKS_BARIS_MUATAN {
        return None;
    }
    for m in muatan {
        let berat = bulat_opsional(m, "berat_kg_x100")?;
        if !berat_sah(berat) {
            return None;
        }
        statements.push((
            CLOUD_INSERT_LAPORAN_MUATAN_SQL,
            vec![
                json!(payload_text(m, "id_baris")?),
                json!(id),
                json!(payload_text(m, "id_muatan")?),
                json!(m.get("qty")?.as_i64().filter(|n| *n >= 0)?),
                json!(berat),
            ],
        ));
    }
    Some(statements)
}

/// `trip-report-photo/save`. Foto yang tidak lolos aturan lokal dilewati.
pub fn cloud_foto_laporan_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = id_payload(payload, "id_laporan", entity_key)?;
    let mime_type = payload_text(payload, "mime_type")?;
    let data = payload.get("data_base64")?.as_str()?;
    validate_foto_laporan(&mime_type, data).ok()?;
    Some(vec![json!(id), json!(mime_type), json!(data)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor yang sama dengan `validations/driver.test.ts`.

    fn lap<'a>(id: &'a str, jenis: &'a str, waktu: &'a str) -> Laporan<'a> {
        Laporan {
            id_laporan: id,
            jenis,
            waktu_perangkat: waktu,
            ..Default::default()
        }
    }

    #[test]
    fn nomor_prefix_dan_upah() {
        assert_eq!(
            format_nomor_surat_jalan("KRS", "2026-11-09", "WAB12", 7),
            "KRS-2611-WAB12-007"
        );
        assert_eq!(
            format_nomor_surat_jalan("SJ", "2027-01-31", "WEB", 1234),
            "SJ-2701-WEB-1234"
        );
        assert_eq!(normalisasi_prefix(" krs- ").unwrap(), "KRS");
        assert_eq!(
            normalisasi_prefix("-").unwrap_err(),
            "Awalan nomor surat jalan wajib diisi."
        );
        assert_eq!(
            normalisasi_prefix("KR S").unwrap_err(),
            "Awalan nomor surat jalan hanya huruf dan angka, maksimal 8 karakter."
        );
        assert!(normalisasi_prefix("ABCDEFGHI").is_err());
        assert_eq!(prefix_tersimpan(Some("kos")), "KOS");
        assert_eq!(prefix_tersimpan(Some("rusak!")), "SJ");
        assert_eq!(prefix_tersimpan(None), "SJ");
        assert_eq!(id_muatan("trp-1", 3), "trp-1-3");
        assert_eq!(upah_surat_jalan(150_000, 200_000), 350_000);
    }

    #[test]
    fn status_dan_penugasan() {
        assert_eq!(status_perjalanan(&[]), "Direncanakan");
        let kendala = [lap("a", "Kendala", "2026-11-09 01:00:00")];
        assert_eq!(status_perjalanan(&kendala), "Direncanakan");
        let jalan = [lap("a", "Berangkat", "2026-11-09 01:00:00")];
        assert_eq!(status_perjalanan(&jalan), "Berjalan");
        let tutup = [
            lap("a", "Berangkat", "2026-11-09 01:00:00"),
            lap("b", "Selesai", "2026-11-09 05:00:00"),
            lap("c", "Dibatalkan", "2026-11-09 04:00:00"),
        ];
        assert_eq!(status_perjalanan(&tutup), "Dibatalkan");

        let ganti = [
            Laporan {
                mode_ganti: Some("Langsung"),
                id_kendaraan_baru: Some("k2"),
                ..lap("g1", "Ganti Kendaraan", "2026-11-09 02:00:00")
            },
            Laporan {
                mode_ganti: Some("Minta Izin"),
                id_karyawan_baru: Some("d2"),
                ..lap("g2", "Ganti Driver", "2026-11-09 03:00:00")
            },
            Laporan {
                mode_ganti: Some("Darurat"),
                id_kendaraan_baru: Some("k3"),
                ..lap("g3", "Ganti Kendaraan", "2026-11-09 04:00:00")
            },
        ];
        let p = penugasan("d1", "k1", &ganti);
        assert_eq!(
            p,
            Penugasan {
                id_karyawan: "d1".into(),
                id_kendaraan: "k3".into()
            }
        );
        assert_eq!(ganti_menunggu(&ganti), vec!["g2", "g3"]);

        let mut disetujui = ganti.to_vec();
        disetujui.push(Laporan {
            id_ref: Some("g2"),
            ..lap("s1", "Disetujui", "2026-11-09 03:30:00")
        });
        disetujui.push(Laporan {
            id_ref: Some("g3"),
            ..lap("s2", "Ditolak", "2026-11-09 04:30:00")
        });
        assert_eq!(penugasan("d1", "k1", &disetujui).id_karyawan, "d2");
        // Darurat yang ditolak tetap berlaku sampai dispatcher mencatat ganti baru.
        assert_eq!(penugasan("d1", "k1", &disetujui).id_kendaraan, "k3");
        assert!(ganti_menunggu(&disetujui).is_empty());
        assert_eq!(
            validate_keputusan(&disetujui, "g2").unwrap_err(),
            "Ganti ini sudah diputuskan."
        );
        assert_eq!(
            validate_keputusan(&ganti, "g1").unwrap_err(),
            "Ganti ini tidak memerlukan persetujuan."
        );
        assert_eq!(
            validate_keputusan(&ganti, "x").unwrap_err(),
            "Laporan ganti tidak ditemukan."
        );
        assert!(validate_keputusan(&ganti, "g2").is_ok());

        let selesai = [
            Laporan {
                id_karyawan: Some("d1"),
                ..lap("a", "Berangkat", "2026-11-09 01:00:00")
            },
            Laporan {
                id_karyawan: Some("d2"),
                ..lap("b", "Selesai", "2026-11-09 05:00:00")
            },
        ];
        assert_eq!(
            penerima_upah("Selesai", None, &selesai, "d9").as_deref(),
            Some("d2")
        );
        assert_eq!(
            penerima_upah("Selesai", Some("d5"), &selesai, "d9").as_deref(),
            Some("d5")
        );
        let oleh_dispatcher = [lap("b", "Selesai", "2026-11-09 05:00:00")];
        assert_eq!(
            penerima_upah("Selesai", None, &oleh_dispatcher, "d9").as_deref(),
            Some("d9")
        );
        assert_eq!(
            penerima_upah("Dibatalkan", Some("d5"), &selesai, "d9"),
            None
        );
    }

    #[test]
    fn urutan_di_perangkat() {
        let mut l = vec![];
        assert_eq!(
            periksa_urutan(&l, "Tiba Muat").unwrap_err(),
            "Laporkan Berangkat lebih dulu."
        );
        assert_eq!(
            periksa_urutan(&l, "Dibatalkan").unwrap_err(),
            "Perjalanan belum berangkat. Pakai Tidak Jalan."
        );
        assert!(periksa_urutan(&l, "Tidak Jalan").is_ok());
        assert!(periksa_urutan(&l, "Kendala").is_ok());
        l.push(lap("a", "Berangkat", "2026-11-09 01:00:00"));
        assert_eq!(
            periksa_urutan(&l, "Berangkat").unwrap_err(),
            "Perjalanan sudah berangkat."
        );
        assert_eq!(
            periksa_urutan(&l, "Tidak Jalan").unwrap_err(),
            "Perjalanan yang sudah berangkat tidak bisa ditandai Tidak Jalan. Pakai Dibatalkan."
        );
        assert_eq!(
            periksa_urutan(&l, "Selesai Muat").unwrap_err(),
            "Laporkan Tiba Muat lebih dulu."
        );
        l.push(lap("b", "Tiba Muat", "2026-11-09 02:00:00"));
        assert_eq!(titik_terbuka(&l), Some("muat"));
        assert_eq!(
            periksa_urutan(&l, "Tiba Bongkar").unwrap_err(),
            "Selesaikan dulu titik muat yang sedang terbuka."
        );
        assert_eq!(
            periksa_urutan(&l, "Selesai").unwrap_err(),
            "Selesaikan dulu titik muat yang sedang terbuka."
        );
        assert_eq!(
            periksa_urutan(&l, "Selesai Bongkar").unwrap_err(),
            "Laporkan Tiba Bongkar lebih dulu."
        );
        assert!(periksa_urutan(&l, "Selesai Muat").is_ok());
        l.push(lap("c", "Selesai Muat", "2026-11-09 03:00:00"));
        assert_eq!(titik_terbuka(&l), None);
        assert!(periksa_urutan(&l, "Tiba Muat").is_ok());
        assert!(periksa_urutan(&l, "Selesai").is_ok());
        l.push(lap("d", "Selesai", "2026-11-09 04:00:00"));
        assert_eq!(
            periksa_urutan(&l, "Kendala").unwrap_err(),
            "Perjalanan sudah ditutup."
        );
        assert!(periksa_urutan(&l, "Disetujui").is_ok());
    }

    #[test]
    fn waktu_dan_jarak() {
        assert_eq!(detik_utc("1970-01-01 00:00:00"), Some(0));
        assert_eq!(detik_utc("2026-11-09 07:30:15"), Some(1_794_209_415));
        assert_eq!(detik_utc("2024-02-29 23:59:59"), Some(1_709_251_199));
        assert_eq!(detik_utc("2026-02-29 00:00:00"), None);
        assert_eq!(detik_utc("2026-11-09T07:30:15"), None);
        assert_eq!(detik_utc("2026-11-09 24:00:00"), None);
        // Monas → Bundaran HI ±2,2 km.
        let jarak = jarak_meter(-6.175392, 106.827153, -6.194988, 106.823050);
        assert!((jarak - 2226.0).abs() < 5.0, "{jarak}");
        assert_eq!(jarak_meter(-6.2, 106.8, -6.2, 106.8), 0.0);
    }

    #[test]
    fn tanda_tinjau_vektor() {
        let titik = |id, jenis, waktu, lat: f64, lng: f64, akurasi: f64| Laporan {
            id_karyawan: Some("d1"),
            foto_sha256: Some("f"),
            lat: Some(lat),
            lng: Some(lng),
            akurasi_m: Some(akurasi),
            ..lap(id, jenis, waktu)
        };
        let laporan = [
            titik("a", "Berangkat", "2026-11-09 01:00:00", -6.2, 106.8, 10.0),
            // Jam mundur: Selesai Muat lebih awal dari Tiba Muat-nya.
            Laporan {
                id_lokasi: Some("gudang"),
                ..titik("c", "Selesai Muat", "2026-11-09 01:30:00", -6.2, 106.8, 0.0)
            },
            titik("b", "Tiba Muat", "2026-11-09 02:00:00", -6.2, 106.8, 150.0),
            // 2,2 km dalam 10 detik.
            titik(
                "d",
                "Tiba Bongkar",
                "2026-11-09 02:00:10",
                -6.219596,
                106.795897,
                10.0,
            ),
            Laporan {
                diterima_cloud: Some("2026-11-09 02:00:00"),
                foto_sha256: None,
                lat: None,
                lng: None,
                ..titik("e", "Selesai Bongkar", "2026-11-09 02:30:00", 0.0, 0.0, 5.0)
            },
            titik(
                "f",
                "Selesai",
                "2026-11-09 03:00:00",
                -6.219596,
                106.795897,
                5.0,
            ),
        ];
        let lokasi = [LokasiTerdaftar {
            id_lokasi: "gudang",
            lat: -6.21,
            lng: 106.8,
            radius_m: 200,
        }];
        let rencana = [
            MuatanRencana {
                id_muatan: "m1",
                qty: 10,
            },
            MuatanRencana {
                id_muatan: "m2",
                qty: 5,
            },
        ];
        let dilapor = [
            MuatanLapor {
                id_laporan: "c",
                id_muatan: "m1",
                qty: 10,
            },
            MuatanLapor {
                id_laporan: "c",
                id_muatan: "m2",
                qty: 4,
            },
            MuatanLapor {
                id_laporan: "e",
                id_muatan: "m1",
                qty: 10,
            },
            MuatanLapor {
                id_laporan: "e",
                id_muatan: "m2",
                qty: 3,
            },
        ];
        let hasil: Vec<String> =
            tanda_tinjau(&laporan, &lokasi, &rencana, &dilapor, AKURASI_PERINGATAN_M)
                .iter()
                .map(|t| format!("{}:{}", t.kode, t.id))
                .collect();
        assert_eq!(
            hasil,
            [
                "urutan_janggal:c",
                "urutan_janggal:d",
                "akurasi_nol:c",
                "luar_radius:c",
                "akurasi_buruk:b",
                "jam_maju:e",
                "tanpa_gps:e",
                "tanpa_foto:e",
                "kecepatan_mustahil:d",
                "muat_beda:m2",
                "sisa_muatan:m2",
            ]
        );
    }

    fn laporan_draft(v: serde_json::Value) -> LaporanDraft {
        serde_json::from_value(v).expect("draft laporan")
    }

    #[test]
    fn validasi_laporan() {
        let dasar = json!({
            "id_perjalanan": "trp-1", "jenis": "Tiba Muat", "nama_lokasi": " Gudang A ",
            "lat": -6.2, "lng": 106.8, "akurasi_m": 12.5, "waktu_perangkat": "2026-11-09 01:00:00",
        });
        let ok = validate_laporan(&laporan_draft(dasar.clone()), true, true).unwrap();
        assert_eq!(ok.nama_lokasi.as_deref(), Some("Gudang A"));
        assert_eq!(ok.mode_ganti, None);

        let galat = |patch: serde_json::Value, driver: bool, foto: bool| {
            let mut v = dasar.clone();
            for (k, isi) in patch.as_object().unwrap() {
                v[k] = isi.clone();
            }
            validate_laporan(&laporan_draft(v), driver, foto).unwrap_err()
        };
        assert_eq!(
            galat(json!({"jenis": "Pulang"}), true, true),
            "Jenis laporan tidak dikenal."
        );
        assert_eq!(
            galat(json!({"jenis": "Disetujui"}), true, true),
            "Jenis laporan ini hanya untuk dispatcher."
        );
        assert_eq!(
            galat(json!({}), false, false),
            "Jenis laporan ini hanya dari HP driver."
        );
        assert_eq!(
            galat(json!({"lat": null}), true, true),
            "Lokasi GPS belum didapat. Nyalakan GPS lalu coba lagi."
        );
        assert_eq!(
            galat(json!({"lat": 91.0}), true, true),
            "Koordinat tidak valid."
        );
        assert_eq!(
            galat(json!({"akurasi_m": -1.0}), true, true),
            "Akurasi GPS tidak valid."
        );
        assert_eq!(
            galat(json!({"nama_lokasi": "  "}), true, true),
            "Nama tempat wajib diisi."
        );
        assert_eq!(
            galat(json!({"waktu_perangkat": "2026-11-09"}), true, true),
            "Waktu laporan tidak valid."
        );
        assert_eq!(galat(json!({}), true, false), "Ambil foto lebih dulu.");
        assert_eq!(
            galat(
                json!({"muatan": [{"id_muatan": "m1", "qty": 1}]}),
                true,
                true
            ),
            "Rincian muatan hanya untuk Selesai Muat atau Selesai Bongkar."
        );
        assert_eq!(
            galat(json!({"jenis": "Selesai Muat"}), true, true),
            "Konfirmasi jumlah barang yang dimuat."
        );
        assert_eq!(
            galat(
                json!({"jenis": "Selesai Bongkar", "muatan": [{"id_muatan": "m1", "qty": 1}, {"id_muatan": "m1", "qty": 2}]}),
                true,
                true
            ),
            "Barang yang sama tercatat dua kali."
        );
        assert_eq!(
            galat(json!({"jenis": "Kendala"}), true, true),
            "Pilih jenis kendala."
        );
        assert_eq!(
            galat(
                json!({"jenis": "Kendala", "jenis_kendala": "Lainnya"}),
                true,
                true
            ),
            "Keterangan kendala wajib diisi."
        );
        assert_eq!(
            galat(
                json!({"jenis": "Kendala", "jenis_kendala": "Macet", "terlambat_menit": 10081}),
                true,
                true
            ),
            "Perkiraan terlambat 0 sampai 10080 menit."
        );
        assert_eq!(
            galat(json!({"jenis": "Ganti Driver"}), true, true),
            "Pilih Darurat atau Minta Izin."
        );
        assert_eq!(
            galat(
                json!({"jenis": "Ganti Driver", "mode_ganti": "Darurat"}),
                true,
                true
            ),
            "Pilih driver pengganti."
        );
        assert_eq!(
            galat(
                json!({"jenis": "Ganti Driver", "mode_ganti": "Darurat", "id_karyawan_baru": "d2"}),
                true,
                true
            ),
            "Alasan wajib diisi."
        );
        assert_eq!(
            galat(json!({"jenis": "Ditolak"}), false, false),
            "Laporan yang diputuskan wajib dipilih."
        );
        assert_eq!(
            galat(json!({"jenis": "Tidak Jalan"}), false, false),
            "Alasan wajib diisi."
        );

        // Dispatcher: tanpa GPS dan foto; mode ganti selalu Langsung.
        let dispatcher = validate_laporan(
            &laporan_draft(json!({
                "id_perjalanan": "trp-1", "jenis": "Ganti Kendaraan", "mode_ganti": "Darurat",
                "id_kendaraan_baru": "k2", "lat": -6.2, "lng": 106.8,
                "waktu_perangkat": "2026-11-09 01:00:00",
            })),
            false,
            false,
        )
        .unwrap();
        assert_eq!(dispatcher.mode_ganti.as_deref(), Some("Langsung"));
        assert_eq!((dispatcher.lat, dispatcher.lng), (None, None));

        assert_eq!(
            validate_foto_laporan("image/png", "AAAA").unwrap_err(),
            "Foto harus JPEG."
        );
        assert_eq!(
            validate_foto_laporan("image/jpeg", &"A".repeat(MAKS_FOTO_BASE64 + 4)).unwrap_err(),
            "Foto terlalu besar. Ambil ulang."
        );
        assert_eq!(
            validate_foto_laporan("image/jpeg", "AA=").unwrap_err(),
            "Foto tidak terbaca."
        );
        assert!(validate_foto_laporan("image/jpeg", "/9j/").is_ok());
    }

    #[test]
    fn validasi_master_dan_perjalanan() {
        let tarif = |v| serde_json::from_value::<DaftarTarifDraft>(v).unwrap();
        assert_eq!(
            validate_daftar_tarif(&tarif(json!({"nama": " "})), "jenis kendaraan").unwrap_err(),
            "Nama jenis kendaraan wajib diisi."
        );
        assert_eq!(
            validate_daftar_tarif(
                &tarif(json!({"nama": "Truk", "tarif": -1})),
                "jenis kendaraan"
            )
            .unwrap_err(),
            "Tarif harus 0 sampai Rp100.000.000."
        );
        assert_eq!(
            validate_daftar_tarif(
                &tarif(json!({"nama": " Truk ", "tarif": 150000})),
                "jenis kendaraan"
            )
            .unwrap(),
            DaftarTarifValid {
                nama: "Truk".into(),
                tarif: 150_000,
                status_aktif: true
            }
        );

        assert_eq!(normalisasi_identitas("  b 1234\txyz "), "B 1234 XYZ");
        let kendaraan = |v| serde_json::from_value::<KendaraanDraft>(v).unwrap();
        assert_eq!(
            validate_kendaraan(&kendaraan(json!({"identitas": "B 1"}))).unwrap_err(),
            "Pilih jenis kendaraan."
        );
        assert_eq!(
            validate_kendaraan(&kendaraan(json!({"id_jenis": "j1", "identitas": " "})))
                .unwrap_err(),
            "Plat atau nomor kendaraan wajib diisi."
        );
        assert_eq!(
            validate_kendaraan(&kendaraan(json!({"id_jenis": "j1", "identitas": "b  1 x"})))
                .unwrap()
                .identitas,
            "B 1 X"
        );

        let lokasi = |v| serde_json::from_value::<LokasiDraft>(v).unwrap();
        assert_eq!(
            validate_lokasi(&lokasi(json!({"nama": "Pool", "jenis": "Pool"}))).unwrap_err(),
            "Ambil koordinat lokasi lebih dulu."
        );
        assert_eq!(
            validate_lokasi(&lokasi(
                json!({"nama": "Pool", "jenis": "Kantor", "lat": -6.2, "lng": 106.8})
            ))
            .unwrap_err(),
            "Pilih jenis lokasi."
        );
        assert_eq!(
            validate_lokasi(&lokasi(
                json!({"nama": "Pool", "jenis": "Pool", "lat": -6.2, "lng": 106.8, "radius_m": 5})
            ))
            .unwrap_err(),
            "Radius 10 sampai 10.000 meter."
        );
        assert_eq!(
            validate_lokasi(&lokasi(
                json!({"nama": "Pool", "jenis": "Pool", "lat": -6.2, "lng": 106.8})
            ))
            .unwrap()
            .radius_m,
            200
        );

        let perjalanan = |v| serde_json::from_value::<PerjalananDraft>(v).unwrap();
        let dasar = json!({
            "tanggal": "2026-11-09", "id_karyawan": "d1", "id_kendaraan": "k1", "id_kategori": "t1",
            "muatan": [{"tempat_muat": "Gudang A", "nama_barang": "Semen", "qty": 10, "satuan": "sak", "berat_kg_x100": 50000}],
        });
        assert_eq!(
            validate_perjalanan(&perjalanan(dasar.clone()))
                .unwrap()
                .muatan
                .len(),
            1
        );
        let mut v = dasar.clone();
        v["muatan"] = json!([]);
        assert_eq!(
            validate_perjalanan(&perjalanan(v)).unwrap_err(),
            "Isi minimal satu barang muatan."
        );
        let mut v = dasar.clone();
        v["muatan"][0]["qty"] = json!(0);
        assert_eq!(
            validate_perjalanan(&perjalanan(v)).unwrap_err(),
            "Baris 1: jumlah harus lebih dari 0."
        );
        let mut v = dasar.clone();
        v["muatan"][0]["satuan"] = json!("x".repeat(21));
        assert_eq!(
            validate_perjalanan(&perjalanan(v)).unwrap_err(),
            "Baris 1: satuan maksimal 20 karakter."
        );
        let mut v = dasar;
        v["id_kategori"] = json!(null);
        assert_eq!(
            validate_perjalanan(&perjalanan(v)).unwrap_err(),
            "Pilih kategori tujuan."
        );
    }
}

#[cfg(test)]
mod tests_lokal {
    use super::*;
    use tempfile::tempdir;

    fn siapkan() -> (tempfile::TempDir, DesktopState) {
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
        let connection = storage::database(&state.data_dir).expect("database");
        connection
            .execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif)
                 VALUES ('d1', 'K1', 'Budi', 'Armada', 1, 'Aktif'),
                        ('d2', 'K2', 'Joko', 'Armada', 1, 'Aktif'),
                        ('d3', 'K3', 'Lama', 'Armada', 1, 'Nonaktif');
                 INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES ('sj_prefix', 'krs');",
            )
            .expect("data awal");
        (directory, state)
    }

    fn galat(hasil: Result<Value, CommandError>) -> String {
        hasil.expect_err("diharapkan galat").message
    }

    fn id_dari(hasil: Result<Value, CommandError>, kunci: &str) -> String {
        hasil.expect("berhasil")[kunci]
            .as_str()
            .expect("id")
            .to_owned()
    }

    const FOTO: &str = "/9j/4AAQ";

    fn lapor(
        state: &DesktopState,
        sesi: Option<&str>,
        draft: Value,
    ) -> Result<Value, CommandError> {
        let foto = sesi.map(|_| FotoLaporanDraft {
            mime_type: "image/jpeg".into(),
            data_base64: FOTO.into(),
        });
        catat_laporan(state, "operator", sesi, draft, foto)
    }

    fn titik(id_perjalanan: &str, jenis: &str, waktu: &str) -> Value {
        json!({
            "id_perjalanan": id_perjalanan, "jenis": jenis, "nama_lokasi": "Gudang A",
            "lat": -6.2, "lng": 106.8, "akurasi_m": 8.0, "waktu_perangkat": waktu,
        })
    }

    #[test]
    fn alur_lokal_outbox_dan_statement_cloud() {
        let (_dir, state) = siapkan();

        // Master dan tarif.
        let tanpa_izin = simpan_daftar_tarif(
            &state,
            &DAFTAR_JENIS_KENDARAAN,
            false,
            json!({"nama": "Truk", "tarif": 150000}),
        )
        .expect_err("tarif tanpa izin");
        assert_eq!(tanpa_izin.code, "DESKTOP_ACCESS_DENIED");
        let jenis = id_dari(
            simpan_daftar_tarif(
                &state,
                &DAFTAR_JENIS_KENDARAAN,
                true,
                json!({"nama": "Truk", "tarif": 150000}),
            ),
            "id",
        );
        let kategori = id_dari(
            simpan_daftar_tarif(
                &state,
                &DAFTAR_KATEGORI_TUJUAN,
                true,
                json!({"nama": "Luar Kota", "tarif": 200000}),
            ),
            "id",
        );
        assert_eq!(
            galat(simpan_daftar_tarif(
                &state,
                &DAFTAR_KATEGORI_TUJUAN,
                true,
                json!({"nama": " luar kota "}),
            )),
            "Nama kategori tujuan sudah dipakai."
        );
        let k1 = id_dari(
            simpan_kendaraan(
                &state,
                json!({"id_jenis": jenis, "identitas": "b 1234 xyz"}),
            ),
            "id",
        );
        assert_eq!(
            galat(simpan_kendaraan(
                &state,
                json!({"id_jenis": jenis, "identitas": "B 1234  XYZ"})
            )),
            "Plat atau nomor kendaraan sudah terdaftar."
        );
        let k2 = id_dari(
            simpan_kendaraan(
                &state,
                json!({"id_jenis": jenis, "identitas": "B 5678 ABC"}),
            ),
            "id",
        );
        simpan_lokasi(
            &state,
            json!({"nama": "Pool Cikarang", "jenis": "Pool", "lat": -6.28, "lng": 107.17}),
        )
        .unwrap();

        // Surat jalan: nomor per seri perangkat per bulan, tarif dikunci.
        let muatan = json!([
            {"tempat_muat": "Gudang A", "tempat_bongkar": "Toko B", "nama_barang": "Semen",
             "qty": 10, "satuan": "sak", "berat_kg_x100": 50000},
            {"tempat_muat": "Gudang A", "nama_barang": "Pasir", "qty": 2, "satuan": "karung"},
        ]);
        let surat = |id: Option<&str>, driver: &str, muatan: &Value| {
            json!({
                "id_perjalanan": id, "tanggal": "2026-11-09", "id_karyawan": driver,
                "id_kendaraan": k1, "id_kategori": kategori, "muatan": muatan,
            })
        };
        assert_eq!(
            galat(simpan_perjalanan(
                &state,
                "admin",
                surat(None, "d3", &muatan)
            )),
            "Driver tidak ditemukan atau nonaktif."
        );
        let trp = id_dari(
            simpan_perjalanan(&state, "admin", surat(None, "d1", &muatan)),
            "id_perjalanan",
        );
        simpan_perjalanan(&state, "admin", surat(None, "d2", &muatan)).unwrap();
        let connection = storage::database(&state.data_dir).unwrap();
        let nomor: Vec<(String, i64, i64)> = connection
            .prepare(
                "SELECT nomor, tarif_kendaraan, tarif_tujuan FROM drv_perjalanan ORDER BY nomor_urut;",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            nomor[0].0.starts_with("KRS-2611-") && nomor[0].0.ends_with("-001"),
            "{}",
            nomor[0].0
        );
        assert!(nomor[1].0.ends_with("-002"));
        assert_eq!((nomor[0].1, nomor[0].2), (150_000, 200_000));

        // Sunting selama Direncanakan: muatan yang dibuang ikut hilang.
        simpan_perjalanan(
            &state,
            "admin",
            surat(Some(&trp), "d1", &json!([muatan[0]])),
        )
        .unwrap();
        let jumlah_muatan: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM drv_muatan WHERE id_perjalanan = ?;",
                params![trp],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jumlah_muatan, 1);

        // Laporan: cakupan driver yang bertugas, idempoten per id.
        assert_eq!(
            galat(lapor(
                &state,
                Some("d2"),
                titik(&trp, "Berangkat", "2026-11-09 01:00:00")
            )),
            "Surat jalan ini tidak sedang ditugaskan kepada Anda."
        );
        let mut berangkat = titik(&trp, "Berangkat", "2026-11-09 01:00:00");
        berangkat["id_laporan"] = json!("lap-1");
        lapor(&state, Some("d1"), berangkat.clone()).unwrap();
        assert_eq!(
            lapor(&state, Some("d1"), berangkat).unwrap()["sudah_tercatat"],
            true
        );
        assert_eq!(
            galat(simpan_perjalanan(
                &state,
                "admin",
                surat(Some(&trp), "d1", &muatan)
            )),
            "Surat jalan yang sudah berjalan atau ditutup tidak bisa diubah."
        );
        let mut selesai_muat = titik(&trp, "Selesai Muat", "2026-11-09 03:00:00");
        selesai_muat["muatan"] = json!([{"id_muatan": id_muatan(&trp, 1), "qty": 9}]);
        assert_eq!(
            galat(lapor(&state, Some("d1"), selesai_muat.clone())),
            "Laporkan Tiba Muat lebih dulu."
        );
        lapor(
            &state,
            Some("d1"),
            titik(&trp, "Tiba Muat", "2026-11-09 02:00:00"),
        )
        .unwrap();
        selesai_muat["muatan"] = json!([{"id_muatan": "lain-1", "qty": 9}]);
        assert_eq!(
            galat(lapor(&state, Some("d1"), selesai_muat.clone())),
            "Barang muatan tidak dikenal."
        );
        selesai_muat["muatan"] = json!([{"id_muatan": id_muatan(&trp, 1), "qty": 9}]);
        lapor(&state, Some("d1"), selesai_muat).unwrap();

        // Ambil alih darurat dari HP driver pengganti; driver lama tidak bisa lagi melapor.
        let mut ambil_alih = titik(&trp, "Ganti Driver", "2026-11-09 04:00:00");
        ambil_alih["mode_ganti"] = json!("Darurat");
        ambil_alih["id_karyawan_baru"] = json!("d2");
        ambil_alih["keterangan"] = json!("Driver sakit");
        lapor(&state, Some("d2"), ambil_alih).unwrap();
        let mut kendala = titik(&trp, "Kendala", "2026-11-09 05:00:00");
        kendala["jenis_kendala"] = json!("Macet");
        assert_eq!(
            galat(lapor(&state, Some("d1"), kendala.clone())),
            "Surat jalan ini tidak sedang ditugaskan kepada Anda."
        );
        lapor(&state, Some("d2"), kendala).unwrap();

        // Dispatcher: ganti kendaraan Langsung, tanpa GPS dan foto.
        lapor(
            &state,
            None,
            json!({"id_perjalanan": trp, "jenis": "Ganti Kendaraan", "id_kendaraan_baru": k2,
                   "waktu_perangkat": "2026-11-09 06:00:00"}),
        )
        .unwrap();

        // Outbox lengkap, dan setiap event menghasilkan statement cloud.
        let events: Vec<(String, String, String, String)> = connection
            .prepare(
                "SELECT domain, operation, entity_key, payload_json FROM desktop_sync_outbox
                 WHERE domain IN ('vehicle-type', 'trip-destination', 'vehicle', 'trip-place',
                                  'trip', 'trip-report', 'trip-report-photo')
                 ORDER BY rowid;",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let hitung = |domain: &str| events.iter().filter(|e| e.0 == domain).count();
        assert_eq!(
            [
                hitung("vehicle-type"),
                hitung("trip-destination"),
                hitung("vehicle"),
                hitung("trip-place"),
                hitung("trip"),
                hitung("trip-report"),
                hitung("trip-report-photo"),
            ],
            [1, 1, 2, 1, 3, 6, 5]
        );
        for (domain, operation, key, payload) in &events {
            let payload: Value = serde_json::from_str(payload).unwrap();
            let jumlah = match domain.as_str() {
                "vehicle-type" => {
                    cloud_daftar_tarif_values(&DAFTAR_JENIS_KENDARAAN, &payload, key).map(|_| 1)
                }
                "trip-destination" => {
                    cloud_daftar_tarif_values(&DAFTAR_KATEGORI_TUJUAN, &payload, key).map(|_| 1)
                }
                "vehicle" => cloud_kendaraan_values(&payload, key).map(|_| 1),
                "trip-place" => cloud_lokasi_values(&payload, key).map(|_| 1),
                "trip" => cloud_perjalanan_statements(&payload, key).map(|s| s.len()),
                "trip-report" => cloud_laporan_statements(&payload, key).map(|s| s.len()),
                "trip-report-photo" => cloud_foto_laporan_values(&payload, key).map(|_| 1),
                _ => None,
            };
            assert!(
                jumlah.is_some(),
                "{domain}/{operation} {key} tidak menghasilkan statement"
            );
        }
        let laporan_muat: Value = events
            .iter()
            .filter(|e| e.0 == "trip-report")
            .nth(2)
            .map(|e| serde_json::from_str(&e.3).unwrap())
            .unwrap();
        assert_eq!(laporan_muat["laporan"]["jenis"], "Selesai Muat");
        assert_eq!(
            cloud_laporan_statements(&laporan_muat, "").unwrap().len(),
            2
        );
        assert_eq!(
            laporan_muat["laporan"]["foto_sha256"],
            json!(sidik_foto(FOTO).unwrap())
        );

        // Payload cacat menjadi konflik (None), bukan galat yang diulang.
        let mut cacat = laporan_muat.clone();
        cacat["laporan"]["jenis"] = json!("Pulang");
        assert!(cloud_laporan_statements(&cacat, "").is_none());
        let mut cacat = laporan_muat;
        cacat["laporan"]["lat"] = json!(95.0);
        assert!(cloud_laporan_statements(&cacat, "").is_none());
        assert!(cloud_foto_laporan_values(
            &json!({"id_laporan": "x", "mime_type": "image/png", "data_base64": FOTO}),
            "x"
        )
        .is_none());

        // Pembacaan layar dispatcher.
        let master = master_perjalanan(&state).unwrap();
        assert_eq!(master["prefix"], "KRS");
        assert_eq!(master["personil"].as_array().unwrap().len(), 2);
        let daftar = daftar_perjalanan(&state, "2026-11-01", "2026-11-30").unwrap();
        let items = daftar["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let item = items.iter().find(|i| i["id_perjalanan"] == trp.as_str()).unwrap();
        assert_eq!(item["status"], "Berjalan");
        // Ambil alih darurat dan ganti kendaraan Langsung sudah berlaku.
        assert_eq!(item["id_karyawan"], "d2");
        assert_eq!(item["nama_karyawan"], "Joko");
        assert_eq!(item["identitas_kendaraan"], "B 5678 ABC");
        assert_eq!(item["upah"], 350_000);
        assert_eq!(item["menunggu_persetujuan"].as_array().unwrap().len(), 1);
        assert_eq!(item["laporan_terakhir"]["jenis"], "Ganti Kendaraan");
        let kode: Vec<&str> = item["tanda"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["kode"].as_str())
            .collect();
        assert!(kode.contains(&"muat_beda"), "{kode:?}");
        assert!(kode.contains(&"menunggu_persetujuan"), "{kode:?}");
        let rincian = rincian_perjalanan(&state, &trp).unwrap();
        let laporan = rincian["laporan"].as_array().unwrap();
        assert_eq!(laporan.len(), 6);
        assert_eq!(laporan[0]["jenis"], "Berangkat");
        assert_eq!(laporan[0]["foto_lokal"], 1);
        assert_eq!(laporan[2]["muatan"].as_array().unwrap().len(), 1);
        assert!(foto_laporan_lokal(&state, "lap-1").unwrap().is_some());
        assert_eq!(
            daftar_perjalanan(&state, "2026-11-30", "2026-11-01")
                .unwrap_err()
                .message,
            "Rentang tanggal tidak valid."
        );
        simpan_prefix(&state, "kos-").unwrap();
        assert_eq!(master_perjalanan(&state).unwrap()["prefix"], "KOS");

        // Layar driver: hanya perjalanan yang sedang ditugaskan kepadanya.
        let d2 = perjalanan_saya(&state, "d2", "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(d2["saya"].as_array().unwrap().len(), 2);
        assert_eq!(d2["nama"], "Joko");
        let d1 = perjalanan_saya(&state, "d1", "2026-11-01", "2026-11-30").unwrap();
        assert!(d1["saya"].as_array().unwrap().is_empty());
        assert_eq!(d1["lain"].as_array().unwrap().len(), 2);
        assert!(d1["lain"][0].get("upah").is_none());
        assert!(rincian_saya(&state, "d2", &trp).is_ok());
        assert_eq!(
            rincian_saya(&state, "d1", &trp).unwrap_err().code,
            "DESKTOP_ACCESS_DENIED"
        );
    }
}

#[cfg(test)]
mod tests_absensi {
    use super::*;
    use tempfile::tempdir;

    // Vektor yang sama dengan `services/driver-absensi.test.ts`: laporan
    // perjalanan driver pada tanggal WIB D = bekerja pada D (PRD §7.4).

    fn siapkan() -> (tempfile::TempDir, DesktopState) {
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
        let lapor = |id: &str, karyawan: Option<&str>, waktu: &str| {
            format!(
                "INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, waktu_perangkat,
                   id_karyawan, dilaporkan_oleh)
                 VALUES ('{id}', 'trp-1', 'Berangkat', '{waktu}', {}, 'uji');",
                karyawan.map_or("NULL".to_owned(), |k| format!("'{k}'"))
            )
        };
        let connection = storage::database(&state.data_dir).expect("database");
        connection
            .execute_batch(&[
                "INSERT INTO tbl_shift (
                   id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                   awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
                   jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
                   offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
                   izinkan_multi_sesi
                 ) VALUES (1, 1, 'Shift Pagi', '07:00', '15:00', 60, 15, 30, 420, 60, 60, 240, 60, 120, 0);"
                    .to_owned(),
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
                   ('K001', 'E1', 'Driver Pagi', 'Armada', 1, 'Aktif'),
                   ('K002', 'E2', 'Tanpa Laporan', 'Armada', 1, 'Aktif'),
                   ('K004', 'E4', 'Driver Subuh', 'Armada', 1, 'Aktif'),
                   ('K005', 'E5', 'Lapor Kemarin', 'Armada', 1, 'Aktif');"
                    .to_owned(),
                lapor("l1", Some("K001"), "2026-08-18 01:00:00"),
                lapor("l2", None, "2026-08-18 02:00:00"),
                lapor("l3", Some("K004"), "2026-08-17 18:00:00"),
                lapor("l4", Some("K005"), "2026-08-17 16:59:59"),
                lapor("l5", Some("K001"), "2026-08-17 03:00:00"),
                lapor("l6", Some("K001"), "2026-08-31 17:30:00"),
                "INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, jam_masuk,
                   jam_pulang, status_kehadiran, status_absen, sumber, update_terakhir, jam_kerja,
                   lembur, id_shift, bulan, tahun, id_sesi, mode_tugas)
                 VALUES ('2026-08-17', 'K001', 'Driver Pagi', 'Armada', '07:00', '15:00', 'Hadir',
                   'Tepat Waktu', 'Scanner', 'x', 420, 0, 1, 'Agustus', 2026, 'S-17', 'NORMAL');"
                    .to_owned(),
            ]
            .join("
"))
            .expect("data awal");
        sync::ensure_client_id(&state).expect("identitas klien");
        (directory, state)
    }

    #[test]
    fn laporan_perjalanan_sebagai_kehadiran() {
        let (_dir, state) = siapkan();
        let connection = storage::database(&state.data_dir).expect("database");

        let mut pelapor: Vec<String> = pelapor_perjalanan(&connection, "2026-08-18")
            .expect("pelapor")
            .into_iter()
            .collect();
        pelapor.sort();
        assert_eq!(pelapor, ["K001", "K004"]);

        let hari_hadir: i64 = connection
            .query_row(
                &format!("SELECT {HARI_HADIR_SQL} FROM master_data md WHERE md.id_unik = 'K001';"),
                params!["2026-08-01", "2026-08-31"],
                |row| row.get(0),
            )
            .expect("hari hadir");
        assert_eq!(hari_hadir, 2);

        let audit = super::super::operational::get_attendance_audit(
            &state,
            Some("2026-08-18".to_owned()),
        )
        .expect("audit");
        assert_eq!(audit["ringkasan"]["wajibAbsen"], 2);

        let alfa = super::super::operational::generate_alfa_harian(
            &state,
            Some("2026-08-18 18:00:00".to_owned()),
        )
        .expect("alfa");
        assert_eq!(alfa["jumlahLaporPerjalanan"], 2);
        assert_eq!(alfa["jumlahAlfaDibuat"], 2);
        let mut di_alfa: Vec<String> = connection
            .prepare("SELECT id_karyawan FROM absensi_harian WHERE status_kehadiran = 'Alfa';")
            .expect("kueri")
            .query_map([], |row| row.get(0))
            .expect("baris")
            .collect::<Result<_, _>>()
            .expect("hasil");
        di_alfa.sort();
        assert_eq!(di_alfa, ["K002", "K005"]);
    }

    #[test]
    fn foto_dihapus_setelah_90_hari_menurut_jam_database() {
        let (_dir, state) = siapkan();
        let connection = storage::database(&state.data_dir).expect("database");
        connection
            .execute_batch(
                "INSERT INTO drv_laporan_foto (id_laporan, mime_type, data_base64, created_at) VALUES
                   ('l1', 'image/jpeg', 'AAAA', datetime('now', '-91 days')),
                   ('l3', 'image/jpeg', 'AAAA', datetime('now', '-85 days')),
                   ('l5', 'image/jpeg', 'AAAA', datetime('now', '-10 days'));",
            )
            .expect("foto");
        let segera = foto_segera_dihapus_lokal(&state).unwrap();
        assert_eq!(segera["jumlah"], 2);
        // l3: 2026-08-17 18:00 UTC = 18 Agustus WIB; l1: 18 Agustus WIB juga.
        assert_eq!(segera["tanggal_tertua"], "2026-08-18");
        assert_eq!(hapus_foto_lama_lokal(&state).unwrap(), 1);
        assert!(foto_laporan_lokal(&state, "l1").unwrap().is_none());
        assert!(foto_laporan_lokal(&state, "l3").unwrap().is_some());
        assert_eq!(foto_segera_dihapus_lokal(&state).unwrap()["jumlah"], 1);
        // Baris laporan tidak ikut terhapus.
        let laporan: i64 = connection
            .query_row("SELECT COUNT(*) FROM drv_laporan;", [], |r| r.get(0))
            .unwrap();
        assert_eq!(laporan, 6);
    }
}
