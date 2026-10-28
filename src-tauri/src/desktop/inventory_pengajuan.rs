//! Pengajuan pembelian barang inventaris (v30, port dari Manajemen Sekolah v64).
//!
//! Pengaju mencatat pengajuan, akuntansi meng-ACC atau menolak, lalu penerimaan barang
//! menulis Masuk `Pengadaan` ber-`id_ref` = id baris pengajuan. Status TIDAK
//! disimpan: diturunkan dari kolom waktu dan jumlah yang sudah diterima, pola
//! kasbon, rapel, dan servis.
//!
//! ACC mengikat isi yang dilihat akuntansi lewat `sidik_baris`. Cloud hanya
//! menerima ACC bila sidiknya masih sama, sehingga suntingan offline yang lebih
//! dulu sampai menggugurkan ACC atas versi lama tanpa ada event yang ditolak.
//!
//! Aturan murni dieja kembar dengan `validations/inventory-pengajuan.ts` dan
//! `services/inventory-pengajuan.ts`, diuji dengan vektor yang sama.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    accounting,
    config::DesktopState,
    inventory::{
        self, clean, invalid, is_valid_date, new_hex_id, payload_text, wib_today, BarangDraft,
        MutasiDraft, MAKS_HARGA_SATUAN, MAKS_JUMLAH, MAKS_NILAI_MUTASI,
    },
    license,
    models::CommandError,
    storage, sync,
};

pub const MAKS_BARIS_PENGAJUAN: usize = 100;
pub const MAKS_KEPERLUAN: usize = 200;
pub const MAKS_CATATAN_PENGAJUAN: usize = 500;
pub const MAKS_SUMBER_DANA: usize = 60;
pub const MAKS_NAMA_BARANG: usize = 120;
pub const MAKS_SATUAN: usize = 20;
/// Cermin `MAKS_DAFTAR_PENGAJUAN`.
pub const MAKS_DAFTAR_PENGAJUAN: usize = 500;

// Aturan murni

/// Cermin `formatNomorPengajuan`. Seri mengikuti nomor jurnal (`seri_perangkat`,
/// Web `WEB`), jadi dua perangkat offline tidak pernah berebut nomor.
pub fn format_nomor_pengajuan(tahun: &str, seri: &str, nomor_urut: i64) -> String {
    format!("PGJ/{tahun}/{seri}/{nomor_urut:04}")
}

/// Cermin `idBarisPengajuan`. Deterministik supaya mengubah pengajuan menimpa
/// barisnya di cloud alih-alih menumpuk baris baru.
pub fn id_baris_pengajuan(id_pengajuan: &str, urutan: i64) -> String {
    format!("{id_pengajuan}-{urutan}")
}

/// Cermin `idPengajuanDariBaris`. Dipakai penjaga tarikan snapshot: baris
/// mengikuti outbox header-nya, karena event-nya satu.
pub fn id_pengajuan_dari_baris(id_baris: &str) -> Option<&str> {
    let (induk, urutan) = id_baris.rsplit_once('-')?;
    (!induk.is_empty() && !urutan.is_empty() && urutan.bytes().all(|b| b.is_ascii_digit()))
        .then_some(induk)
}

/// Cermin `nilaiBaris`: aturan `NILAI_MUTASI_SQL`. Barang desimal menyimpan
/// jumlah ×100, harga tetap per 1 satuan.
pub fn nilai_baris(jumlah: i64, harga_satuan: i64, desimal: bool) -> i64 {
    let kali = i128::from(jumlah) * i128::from(harga_satuan);
    let nilai = if desimal { (kali + 50) / 100 } else { kali };
    i64::try_from(nilai).unwrap_or(i64::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisValid {
    pub id_barang: Option<String>,
    pub nama_barang: String,
    pub satuan: String,
    pub desimal: bool,
    pub jumlah: i64,
    pub harga_satuan: i64,
}

/// Cermin `sidikBaris`: SHA-256 dari bentuk kanonik baris berurutan. Pemisah
/// karakter kontrol tidak bisa diketik di isian mana pun, jadi dua isi berbeda
/// tidak bisa menghasilkan teks kanonik yang sama.
pub fn sidik_baris(baris: &[BarisValid]) -> String {
    let kanonik = baris
        .iter()
        .enumerate()
        .map(|(indeks, b)| {
            [
                (indeks + 1).to_string(),
                b.id_barang.clone().unwrap_or_default(),
                b.nama_barang.clone(),
                b.satuan.clone(),
                if b.desimal { "1" } else { "0" }.to_owned(),
                b.jumlah.to_string(),
                b.harga_satuan.to_string(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");
    hex::encode(Sha256::digest(kanonik.as_bytes()))
}

pub struct KeadaanPengajuan<'a> {
    pub dibatalkan: bool,
    pub ditolak: bool,
    pub disetujui: bool,
    pub ditutup: bool,
    /// (jumlah di-ACC, jumlah diterima) per baris.
    pub baris: &'a [(i64, i64)],
}

/// Cermin `statusPengajuan` (PRD §3.6), diperiksa berurutan.
pub fn status_pengajuan(keadaan: &KeadaanPengajuan<'_>) -> &'static str {
    if keadaan.dibatalkan {
        return "Dibatalkan";
    }
    if keadaan.ditolak {
        return "Ditolak";
    }
    if !keadaan.disetujui {
        return "Menunggu";
    }
    let penuh = !keadaan.baris.is_empty()
        && keadaan
            .baris
            .iter()
            .all(|(jumlah, diterima)| diterima >= jumlah);
    if keadaan.ditutup || penuh {
        return "Selesai";
    }
    if keadaan.baris.iter().any(|(_, diterima)| *diterima > 0) {
        return "Diterima sebagian";
    }
    "Disetujui"
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarisDraft {
    #[serde(default)]
    pub id_barang: Option<String>,
    #[serde(default)]
    pub nama_barang: Option<String>,
    #[serde(default)]
    pub satuan: Option<String>,
    #[serde(default)]
    pub desimal: bool,
    #[serde(default)]
    pub jumlah: i64,
    #[serde(default)]
    pub harga_satuan: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PengajuanDraft {
    #[serde(default)]
    pub id_pengajuan: Option<String>,
    #[serde(default)]
    pub tanggal: String,
    #[serde(default)]
    pub keperluan: String,
    #[serde(default)]
    pub sumber_dana: Option<String>,
    #[serde(default)]
    pub catatan: Option<String>,
    #[serde(default)]
    pub baris: Vec<BarisDraft>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PengajuanValid {
    pub tanggal: String,
    pub keperluan: String,
    pub sumber_dana: Option<String>,
    pub catatan: Option<String>,
    /// Baris barang terdaftar membawa nama, satuan, dan desimal kosong; I/O
    /// mengisinya dari `inventory_barang`.
    pub baris: Vec<BarisValid>,
}

fn panjang(text: &str) -> usize {
    text.chars().count()
}

/// Cermin `validatePengajuan`.
pub fn validate_pengajuan(
    draft: &PengajuanDraft,
    hari_ini: &str,
) -> Result<PengajuanValid, String> {
    let tanggal = draft.tanggal.trim().to_owned();
    if !is_valid_date(&tanggal) {
        return Err("Tanggal pengajuan tidak valid.".into());
    }
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal pengajuan tidak boleh setelah hari ini.".into());
    }
    let keperluan = draft.keperluan.trim().to_owned();
    if keperluan.is_empty() {
        return Err("Keperluan wajib diisi.".into());
    }
    if panjang(&keperluan) > MAKS_KEPERLUAN {
        return Err(format!("Keperluan maksimal {MAKS_KEPERLUAN} karakter."));
    }
    let sumber_dana = clean(&draft.sumber_dana);
    if sumber_dana
        .as_deref()
        .is_some_and(|s| panjang(s) > MAKS_SUMBER_DANA)
    {
        return Err(format!("Sumber dana maksimal {MAKS_SUMBER_DANA} karakter."));
    }
    let catatan = clean(&draft.catatan);
    if catatan
        .as_deref()
        .is_some_and(|s| panjang(s) > MAKS_CATATAN_PENGAJUAN)
    {
        return Err(format!(
            "Catatan maksimal {MAKS_CATATAN_PENGAJUAN} karakter."
        ));
    }
    if draft.baris.is_empty() {
        return Err("Isi minimal satu barang.".into());
    }
    if draft.baris.len() > MAKS_BARIS_PENGAJUAN {
        return Err(format!(
            "Paling banyak {MAKS_BARIS_PENGAJUAN} barang dalam satu pengajuan."
        ));
    }

    let mut baris = Vec::with_capacity(draft.baris.len());
    let mut terdaftar: HashMap<String, usize> = HashMap::new();
    let mut total: i128 = 0;
    for (indeks, isian) in draft.baris.iter().enumerate() {
        let nomor = indeks + 1;
        let id_barang = clean(&isian.id_barang);
        let (nama_barang, satuan, desimal) = match &id_barang {
            Some(id) => {
                if let Some(sebelumnya) = terdaftar.insert(id.clone(), nomor) {
                    return Err(format!(
                        "Baris {nomor}: barang ini sudah ada di baris {sebelumnya}."
                    ));
                }
                (String::new(), String::new(), false)
            }
            None => {
                let nama = clean(&isian.nama_barang).unwrap_or_default();
                if nama.is_empty() {
                    return Err(format!("Baris {nomor}: nama barang wajib diisi."));
                }
                if panjang(&nama) > MAKS_NAMA_BARANG {
                    return Err(format!(
                        "Baris {nomor}: nama barang maksimal {MAKS_NAMA_BARANG} karakter."
                    ));
                }
                let satuan = clean(&isian.satuan).unwrap_or_default();
                if satuan.is_empty() {
                    return Err(format!("Baris {nomor}: satuan wajib diisi."));
                }
                if panjang(&satuan) > MAKS_SATUAN {
                    return Err(format!(
                        "Baris {nomor}: satuan maksimal {MAKS_SATUAN} karakter."
                    ));
                }
                (nama, satuan, isian.desimal)
            }
        };
        if !(1..=MAKS_JUMLAH).contains(&isian.jumlah) {
            return Err(format!("Baris {nomor}: jumlah harus lebih dari 0."));
        }
        if !(0..=MAKS_HARGA_SATUAN).contains(&isian.harga_satuan) {
            return Err(format!("Baris {nomor}: harga satuan tidak valid."));
        }
        let kali = i128::from(isian.jumlah) * i128::from(isian.harga_satuan);
        if kali > i128::from(MAKS_NILAI_MUTASI) {
            return Err(format!(
                "Baris {nomor}: nilai (jumlah × harga satuan) terlalu besar."
            ));
        }
        total += kali;
        baris.push(BarisValid {
            id_barang,
            nama_barang,
            satuan,
            desimal,
            jumlah: isian.jumlah,
            harga_satuan: isian.harga_satuan,
        });
    }
    if total > i128::from(MAKS_NILAI_MUTASI) {
        return Err("Total pengajuan terlalu besar.".into());
    }
    Ok(PengajuanValid {
        tanggal,
        keperluan,
        sumber_dana,
        catatan,
        baris,
    })
}

/// Cermin `validateAlasan`. `label` = "Alasan pembatalan", "Alasan penolakan", dst.
pub fn validate_alasan(alasan: &str, label: &str) -> Result<String, String> {
    let isi = alasan.trim();
    if isi.is_empty() {
        return Err(format!("{label} wajib diisi."));
    }
    if panjang(isi) > MAKS_CATATAN_PENGAJUAN {
        return Err(format!(
            "{label} maksimal {MAKS_CATATAN_PENGAJUAN} karakter."
        ));
    }
    Ok(isi.to_owned())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeputusanDraft {
    #[serde(default)]
    pub id_pengajuan: String,
    #[serde(default)]
    pub keputusan: String,
    #[serde(default)]
    pub sidik_baris: String,
    #[serde(default)]
    pub catatan: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeputusanValid {
    Acc {
        sidik: String,
        catatan: Option<String>,
    },
    Tolak {
        alasan: String,
    },
}

/// Cermin `validatePemutus`: pengaju tidak memutuskan pengajuannya sendiri
/// (pemisahan tugas). Superadmin dikecualikan supaya lembaga dengan satu
/// pengelola tetap bisa berjalan. Hanya diperiksa di perangkat; pelakunya
/// selalu dari sesi.
pub fn validate_pemutus(
    diajukan_oleh: &str,
    operator: &str,
    superadmin: bool,
) -> Result<(), String> {
    if !superadmin && diajukan_oleh.trim().eq_ignore_ascii_case(operator.trim()) {
        return Err(
            "Pengajuan ini kamu ajukan sendiri. Minta pemegang Keuangan lain untuk memutuskannya."
                .into(),
        );
    }
    Ok(())
}

/// Cermin `validateKeputusan`. ACC wajib membawa sidik isi yang dilihat;
/// penolakan wajib beralasan.
pub fn validate_keputusan(draft: &KeputusanDraft) -> Result<KeputusanValid, String> {
    match draft.keputusan.trim() {
        "ACC" => {
            let sidik = draft.sidik_baris.trim().to_ascii_lowercase();
            if sidik.len() != 64 || !sidik.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Pengajuan tidak valid. Muat ulang daftarnya.".into());
            }
            let catatan = clean(&draft.catatan);
            if catatan
                .as_deref()
                .is_some_and(|c| panjang(c) > MAKS_CATATAN_PENGAJUAN)
            {
                return Err(format!(
                    "Catatan persetujuan maksimal {MAKS_CATATAN_PENGAJUAN} karakter."
                ));
            }
            Ok(KeputusanValid::Acc { sidik, catatan })
        }
        "Tolak" => Ok(KeputusanValid::Tolak {
            alasan: validate_alasan(
                draft.catatan.as_deref().unwrap_or_default(),
                "Alasan penolakan",
            )?,
        }),
        _ => Err("Keputusan tidak dikenal.".into()),
    }
}

// Penerimaan (langkah 2)

/// Cermin `MAKS_FOTO_PENERIMAAN`.
pub const MAKS_FOTO_PENERIMAAN: usize = 5;
/// Cermin `MAKS_FOTO_BASE64`: ±450 KB setelah didekode, sehingga lima foto
/// muat dalam satu permintaan Web (batas body route 3,2 MB).
pub const MAKS_FOTO_BASE64: usize = 600_000;
/// WAJIB sama dengan CHECK `inventory_penerimaan_foto.mime_type`.
pub const MIME_FOTO: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];

/// Cermin `idBarangBaru`: barang baru dari baris pengajuan berid tetap, jadi
/// penerimaan kedua (atau perangkat lain) memakai barang yang sama.
pub fn id_barang_baru(id_baris: &str) -> String {
    format!("brg-{id_baris}")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FotoDraft {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarisTerimaDraft {
    #[serde(default)]
    pub id_baris: String,
    #[serde(default)]
    pub jumlah: i64,
    #[serde(default)]
    pub harga_satuan: i64,
    #[serde(default)]
    pub tempat: Option<String>,
    #[serde(default)]
    pub kondisi: Option<String>,
    #[serde(default)]
    pub tanggal_expired: Option<String>,
    /// Barang Masuk pertama yang memulai pencatatan per unit.
    #[serde(default)]
    pub per_unit: bool,
    // Hanya untuk barang baru.
    #[serde(default)]
    pub tipe: Option<String>,
    #[serde(default)]
    pub kategori: Option<String>,
    #[serde(default)]
    pub bisa_expired: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PenerimaanDraft {
    #[serde(default)]
    pub id_pengajuan: String,
    #[serde(default)]
    pub tanggal: String,
    #[serde(default)]
    pub catatan: Option<String>,
    #[serde(default)]
    pub baris: Vec<BarisTerimaDraft>,
    #[serde(default)]
    pub foto: Vec<FotoDraft>,
}

/// Satu baris pengajuan yang di-ACC beserta yang sudah diterima.
pub struct BarisAcc<'a> {
    pub id_baris: &'a str,
    pub urutan: i64,
    pub jumlah: i64,
    pub diterima: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PenerimaanValid {
    pub tanggal: String,
    pub catatan: Option<String>,
    /// Indeks `draft.baris` yang jumlahnya > 0, berurutan seperti kiriman.
    pub dicatat: Vec<usize>,
}

fn base64_sah(isi: &str) -> bool {
    let tanpa_isi = isi.trim_end_matches('=');
    !isi.is_empty()
        && isi.len() % 4 == 0
        && isi.len() - tanpa_isi.len() <= 2
        && tanpa_isi
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// Cermin `validateFotoPenerimaan`. Diperiksa sebelum menulis apa pun supaya
/// CHECK cloud tidak pernah menolak event foto (outbox macet).
pub fn validate_foto_penerimaan(foto: &[FotoDraft]) -> Result<(), String> {
    if foto.is_empty() {
        return Err("Lampirkan minimal satu foto barang yang diterima.".into());
    }
    if foto.len() > MAKS_FOTO_PENERIMAAN {
        return Err(format!("Paling banyak {MAKS_FOTO_PENERIMAAN} foto."));
    }
    for (indeks, item) in foto.iter().enumerate() {
        let nomor = indeks + 1;
        if !MIME_FOTO.contains(&item.mime_type.as_str()) {
            return Err(format!("Foto {nomor}: format harus JPEG, PNG, atau WebP."));
        }
        if item.data_base64.len() > MAKS_FOTO_BASE64 {
            return Err(format!(
                "Foto {nomor} terlalu besar. Kompres ulang atau pilih foto lain."
            ));
        }
        if !base64_sah(&item.data_base64) {
            return Err(format!("Foto {nomor} tidak terbaca."));
        }
    }
    Ok(())
}

/// Cermin `validatePenerimaan`. Batas "tidak melebihi ACC" hanya diperiksa di
/// perangkat; cloud tidak pernah menolak penerimaan (PRD §5.3).
pub fn validate_penerimaan(
    draft: &PenerimaanDraft,
    tanggal_acc: &str,
    hari_ini: &str,
    acc: &[BarisAcc<'_>],
) -> Result<PenerimaanValid, String> {
    let tanggal = draft.tanggal.trim().to_owned();
    if !is_valid_date(&tanggal) {
        return Err("Tanggal terima tidak valid.".into());
    }
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal terima tidak boleh setelah hari ini.".into());
    }
    if tanggal.as_str() < tanggal_acc {
        return Err("Tanggal terima tidak boleh sebelum tanggal ACC.".into());
    }
    let catatan = clean(&draft.catatan);
    if catatan
        .as_deref()
        .is_some_and(|c| panjang(c) > MAKS_CATATAN_PENGAJUAN)
    {
        return Err(format!(
            "Catatan maksimal {MAKS_CATATAN_PENGAJUAN} karakter."
        ));
    }
    let mut terlihat = HashSet::new();
    let mut dicatat = Vec::new();
    for (indeks, isian) in draft.baris.iter().enumerate() {
        let id_baris = isian.id_baris.trim();
        let baris = acc
            .iter()
            .find(|b| b.id_baris == id_baris)
            .ok_or_else(|| "Barang penerimaan tidak dikenal. Muat ulang daftarnya.".to_owned())?;
        if !terlihat.insert(id_baris) {
            return Err(format!("Baris {}: diisi dua kali.", baris.urutan));
        }
        if isian.jumlah < 0 {
            return Err(format!(
                "Baris {}: jumlah diterima tidak valid.",
                baris.urutan
            ));
        }
        if isian.jumlah == 0 {
            continue;
        }
        if isian.jumlah > baris.jumlah - baris.diterima {
            return Err(format!(
                "Baris {}: jumlah diterima melebihi sisa yang di-ACC.",
                baris.urutan
            ));
        }
        if !(0..=MAKS_HARGA_SATUAN).contains(&isian.harga_satuan) {
            return Err(format!("Baris {}: harga satuan tidak valid.", baris.urutan));
        }
        if i128::from(isian.jumlah) * i128::from(isian.harga_satuan) > i128::from(MAKS_NILAI_MUTASI)
        {
            return Err(format!(
                "Baris {}: nilai (jumlah × harga satuan) terlalu besar.",
                baris.urutan
            ));
        }
        dicatat.push(indeks);
    }
    if dicatat.is_empty() {
        return Err("Isi jumlah diterima minimal satu barang.".into());
    }
    validate_foto_penerimaan(&draft.foto)?;
    Ok(PenerimaanValid {
        tanggal,
        catatan,
        dicatat,
    })
}

// SQL bersama

/// Jumlah yang sudah diterima satu baris pengajuan (alias `r`): Masuk
/// Pengadaan ber-`id_ref` = id baris yang belum dibatalkan. Cermin
/// `DITERIMA_BARIS_SQL`.
pub const DITERIMA_BARIS_SQL: &str = "COALESCE((SELECT SUM(m.jumlah) FROM inventory_mutasi m
        WHERE m.id_ref = r.id_baris AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
          AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)), 0)";

/// Pengajuan (alias `p`) yang masih menunggu tindakan: belum diputuskan,
/// atau di-ACC dan belum diterima penuh. Cermin `PENGAJUAN_TERBUKA_SQL`.
fn pengajuan_terbuka_sql() -> String {
    format!(
        "p.dibatalkan_pada IS NULL AND p.ditolak_pada IS NULL AND p.ditutup_pada IS NULL
         AND (p.disetujui_pada IS NULL OR EXISTS (
             SELECT 1 FROM inventory_pengajuan_baris r
             WHERE r.id_pengajuan = p.id_pengajuan AND {DITERIMA_BARIS_SQL} < r.jumlah))"
    )
}

/// Yang terbuka selalu ikut; yang sudah selesai hanya dalam rentang tanggal.
/// Satu baris lebih dari batas untuk mendeteksi `terpotong`. Cermin `pilihSql`.
fn pilih_sql() -> String {
    format!(
        "WITH pilih AS (
            SELECT p.id_pengajuan FROM inventory_pengajuan p
            WHERE ({}) OR (p.tanggal >= ?1 AND p.tanggal <= ?2)
            ORDER BY p.tanggal DESC, p.id_pengajuan DESC
            LIMIT {}
         )",
        pengajuan_terbuka_sql(),
        MAKS_DAFTAR_PENGAJUAN + 1
    )
}

const KOLOM_PENGAJUAN: &[&str] = &[
    "id_pengajuan",
    "tanggal",
    "seri",
    "nomor_urut",
    "nomor",
    "keperluan",
    "sumber_dana",
    "catatan",
    "sidik_baris",
    "diajukan_oleh",
    "disetujui_pada",
    "disetujui_oleh",
    "sidik_disetujui",
    "catatan_persetujuan",
    "ditolak_pada",
    "ditolak_oleh",
    "alasan_tolak",
    "dibatalkan_pada",
    "dibatalkan_oleh",
    "alasan_batal",
    "ditutup_pada",
    "ditutup_oleh",
    "alasan_tutup",
    "created_at",
    "updated_at",
];

// I/O lokal

fn header_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut objek = serde_json::Map::new();
    for (indeks, kolom) in KOLOM_PENGAJUAN.iter().enumerate() {
        let nilai = match row.get_ref(indeks)? {
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
            _ => Value::Null,
        };
        objek.insert((*kolom).to_owned(), nilai);
    }
    Ok(Value::Object(objek))
}

fn baris_json(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
) -> Result<Vec<Value>, CommandError> {
    let mut statement = transaction
        .prepare(
            "SELECT id_baris, urutan, id_barang, nama_barang, satuan, desimal, jumlah, harga_satuan
             FROM inventory_pengajuan_baris WHERE id_pengajuan = ? ORDER BY urutan;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(params![id_pengajuan], |row| {
            Ok(json!({
                "id_baris": row.get::<_, String>(0)?,
                "id_pengajuan": id_pengajuan,
                "urutan": row.get::<_, i64>(1)?,
                "id_barang": row.get::<_, Option<String>>(2)?,
                "nama_barang": row.get::<_, String>(3)?,
                "satuan": row.get::<_, String>(4)?,
                "desimal": row.get::<_, i64>(5)?,
                "jumlah": row.get::<_, i64>(6)?,
                "harga_satuan": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|_| CommandError::internal())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| CommandError::internal())
}

/// Payload outbox: header utuh dan seluruh barisnya. Dipakai setiap event,
/// handler cloud masing-masing hanya membaca kolom miliknya.
fn pengajuan_payload(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
) -> Result<Value, CommandError> {
    let header = transaction
        .query_row(
            &format!(
                "SELECT {} FROM inventory_pengajuan WHERE id_pengajuan = ?;",
                KOLOM_PENGAJUAN.join(", ")
            ),
            params![id_pengajuan],
            header_json,
        )
        .map_err(|_| CommandError::internal())?;
    Ok(json!({ "pengajuan": header, "baris": baris_json(transaction, id_pengajuan)? }))
}

/// Status satu pengajuan menurut database lokal.
fn status_lokal(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
) -> Result<&'static str, CommandError> {
    let header: Option<(bool, bool, bool, bool)> = transaction
        .query_row(
            "SELECT dibatalkan_pada IS NOT NULL, ditolak_pada IS NOT NULL,
                    disetujui_pada IS NOT NULL, ditutup_pada IS NOT NULL
             FROM inventory_pengajuan WHERE id_pengajuan = ?;",
            params![id_pengajuan],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    let (dibatalkan, ditolak, disetujui, ditutup) =
        header.ok_or_else(|| invalid("Pengajuan tidak ditemukan."))?;
    let mut statement = transaction
        .prepare(&format!(
            "SELECT r.jumlah, {DITERIMA_BARIS_SQL} FROM inventory_pengajuan_baris r
             WHERE r.id_pengajuan = ? ORDER BY r.urutan;"
        ))
        .map_err(|_| CommandError::internal())?;
    let baris = statement
        .query_map(params![id_pengajuan], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| CommandError::internal())?
        .collect::<Result<Vec<(i64, i64)>, _>>()
        .map_err(|_| CommandError::internal())?;
    Ok(status_pengajuan(&KeadaanPengajuan {
        dibatalkan,
        ditolak,
        disetujui,
        ditutup,
        baris: &baris,
    }))
}

fn wajib_menunggu(transaction: &Transaction<'_>, id_pengajuan: &str) -> Result<(), CommandError> {
    let status = status_lokal(transaction, id_pengajuan)?;
    if status != "Menunggu" {
        return Err(invalid(format!(
            "Pengajuan ini berstatus {status} dan tidak bisa diubah lagi."
        )));
    }
    Ok(())
}

/// Nama, satuan, dan desimal barang terdaftar selalu dari data barangnya,
/// tidak pernah dari kiriman layar. Cermin `isiBarangTerdaftar`.
fn isi_barang_terdaftar(
    transaction: &Transaction<'_>,
    baris: &mut [BarisValid],
) -> Result<(), CommandError> {
    for (indeks, item) in baris.iter_mut().enumerate() {
        let Some(id_barang) = item.id_barang.clone() else {
            continue;
        };
        let barang: Option<(String, String, i64, i64)> = transaction
            .query_row(
                "SELECT nama_barang, satuan, desimal, status_aktif
                 FROM inventory_barang WHERE id_barang = ?;",
                params![id_barang],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        let nomor = indeks + 1;
        let (nama, satuan, desimal, aktif) =
            barang.ok_or_else(|| invalid(format!("Baris {nomor}: barang tidak ditemukan.")))?;
        if aktif != 1 {
            return Err(invalid(format!(
                "Baris {nomor}: {nama} sudah dinonaktifkan."
            )));
        }
        item.nama_barang = nama;
        item.satuan = satuan;
        item.desimal = desimal == 1;
    }
    Ok(())
}

fn tulis_baris(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
    baris: &[BarisValid],
) -> Result<(), CommandError> {
    transaction
        .execute(
            "DELETE FROM inventory_pengajuan_baris WHERE id_pengajuan = ?;",
            params![id_pengajuan],
        )
        .map_err(|_| CommandError::internal())?;
    for (indeks, item) in baris.iter().enumerate() {
        let urutan = indeks as i64 + 1;
        transaction
            .execute(
                "INSERT INTO inventory_pengajuan_baris (
                    id_baris, id_pengajuan, urutan, id_barang, nama_barang, satuan, desimal,
                    jumlah, harga_satuan
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
                params![
                    id_baris_pengajuan(id_pengajuan, urutan),
                    id_pengajuan,
                    urutan,
                    item.id_barang,
                    item.nama_barang,
                    item.satuan,
                    item.desimal as i64,
                    item.jumlah,
                    item.harga_satuan
                ],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
}

/// Mengajukan, atau mengubah pengajuan yang masih Menunggu (seluruh barisnya
/// diganti). Cermin `savePengajuan`.
pub fn save_request(
    state: &DesktopState,
    operator: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: PengajuanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data pengajuan tidak valid."))?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let hari_ini = wib_today(&transaction);
    let mut valid = validate_pengajuan(&draft, &hari_ini).map_err(invalid)?;
    isi_barang_terdaftar(&transaction, &mut valid.baris)?;
    let sidik = sidik_baris(&valid.baris);

    let id_pengajuan = match clean(&draft.id_pengajuan) {
        Some(id) => {
            wajib_menunggu(&transaction, &id)?;
            transaction
                .execute(
                    "UPDATE inventory_pengajuan SET tanggal = ?, keperluan = ?, sumber_dana = ?,
                            catatan = ?, sidik_baris = ?, updated_at = datetime('now')
                     WHERE id_pengajuan = ?;",
                    params![
                        valid.tanggal,
                        valid.keperluan,
                        valid.sumber_dana,
                        valid.catatan,
                        sidik,
                        id
                    ],
                )
                .map_err(|_| CommandError::internal())?;
            id
        }
        None => {
            let id = new_hex_id("pgj-");
            let seri = accounting::seri_perangkat(&license::current_device_code(state)?);
            let tahun: String = valid.tanggal.chars().take(4).collect();
            let nomor_urut: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(nomor_urut), 0) + 1 FROM inventory_pengajuan
                     WHERE seri = ? AND substr(tanggal, 1, 4) = ?;",
                    params![seri, tahun],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            transaction
                .execute(
                    "INSERT INTO inventory_pengajuan (
                        id_pengajuan, tanggal, seri, nomor_urut, nomor, keperluan, sumber_dana,
                        catatan, sidik_baris, diajukan_oleh, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'));",
                    params![
                        id,
                        valid.tanggal,
                        seri,
                        nomor_urut,
                        format_nomor_pengajuan(&tahun, &seri, nomor_urut),
                        valid.keperluan,
                        valid.sumber_dana,
                        valid.catatan,
                        sidik,
                        operator
                    ],
                )
                .map_err(|_| CommandError::internal())?;
            id
        }
    };
    tulis_baris(&transaction, &id_pengajuan, &valid.baris)?;

    let payload = pengajuan_payload(&transaction, &id_pengajuan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-request",
        "save",
        &id_pengajuan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_pengajuan": id_pengajuan }))
}

/// Membatalkan pengajuan yang masih Menunggu. Cermin `cancelPengajuan`.
pub fn cancel_request(
    state: &DesktopState,
    operator: &str,
    id_pengajuan: &str,
    alasan: &str,
) -> Result<Value, CommandError> {
    let alasan = validate_alasan(alasan, "Alasan pembatalan").map_err(invalid)?;
    let id_pengajuan = id_pengajuan.trim();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    wajib_menunggu(&transaction, id_pengajuan)?;
    transaction
        .execute(
            "UPDATE inventory_pengajuan SET dibatalkan_pada = datetime('now', '+7 hours'),
                    dibatalkan_oleh = ?, alasan_batal = ?, updated_at = datetime('now')
             WHERE id_pengajuan = ?;",
            params![operator, alasan, id_pengajuan],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = pengajuan_payload(&transaction, id_pengajuan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-request",
        "cancel",
        id_pengajuan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// ACC atau Tolak. ACC hanya atas isi yang dilihat (sidik sama), dan tidak
/// oleh pengajunya sendiri kecuali Superadmin. Cermin `decidePengajuan`.
pub fn decide_request(
    state: &DesktopState,
    operator: &str,
    superadmin: bool,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: KeputusanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data keputusan tidak valid."))?;
    let keputusan = validate_keputusan(&draft).map_err(invalid)?;
    let id_pengajuan = draft.id_pengajuan.trim();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let status = status_lokal(&transaction, id_pengajuan)?;
    if status != "Menunggu" {
        return Err(invalid(format!(
            "Pengajuan ini berstatus {status}, bukan Menunggu."
        )));
    }
    let diajukan_oleh: String = transaction
        .query_row(
            "SELECT diajukan_oleh FROM inventory_pengajuan WHERE id_pengajuan = ?;",
            params![id_pengajuan],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    validate_pemutus(&diajukan_oleh, operator, superadmin).map_err(invalid)?;
    let operasi = match keputusan {
        KeputusanValid::Acc { sidik, catatan } => {
            let sidik_lokal: String = transaction
                .query_row(
                    "SELECT sidik_baris FROM inventory_pengajuan WHERE id_pengajuan = ?;",
                    params![id_pengajuan],
                    |row| row.get(0),
                )
                .map_err(|_| CommandError::internal())?;
            if sidik_lokal != sidik {
                return Err(invalid(
                    "Isi pengajuan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
                ));
            }
            transaction
                .execute(
                    "UPDATE inventory_pengajuan SET disetujui_pada = datetime('now', '+7 hours'),
                            disetujui_oleh = ?, sidik_disetujui = ?, catatan_persetujuan = ?,
                            updated_at = datetime('now')
                     WHERE id_pengajuan = ?;",
                    params![operator, sidik, catatan, id_pengajuan],
                )
                .map_err(|_| CommandError::internal())?;
            "approve"
        }
        KeputusanValid::Tolak { alasan } => {
            transaction
                .execute(
                    "UPDATE inventory_pengajuan SET ditolak_pada = datetime('now', '+7 hours'),
                            ditolak_oleh = ?, alasan_tolak = ?, updated_at = datetime('now')
                     WHERE id_pengajuan = ?;",
                    params![operator, alasan, id_pengajuan],
                )
                .map_err(|_| CommandError::internal())?;
            "reject"
        }
    };
    let payload = pengajuan_payload(&transaction, id_pengajuan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-request",
        operasi,
        id_pengajuan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// Menutup pengajuan yang sisanya tidak akan datang. Penerimaan yang sudah
/// ada tidak berubah. Cermin `closePengajuan`.
pub fn close_request(
    state: &DesktopState,
    operator: &str,
    id_pengajuan: &str,
    alasan: &str,
) -> Result<Value, CommandError> {
    let alasan = validate_alasan(alasan, "Alasan penutupan").map_err(invalid)?;
    let id_pengajuan = id_pengajuan.trim();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let status = status_lokal(&transaction, id_pengajuan)?;
    if !matches!(status, "Disetujui" | "Diterima sebagian") {
        return Err(invalid(
            "Hanya pengajuan Disetujui atau Diterima sebagian yang bisa ditutup.",
        ));
    }
    transaction
        .execute(
            "UPDATE inventory_pengajuan SET ditutup_pada = datetime('now', '+7 hours'),
                    ditutup_oleh = ?, alasan_tutup = ?, updated_at = datetime('now')
             WHERE id_pengajuan = ?;",
            params![operator, alasan, id_pengajuan],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = pengajuan_payload(&transaction, id_pengajuan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-request",
        "close",
        id_pengajuan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// Daftar untuk tab Pengajuan dan Keuangan. Cermin `listPengajuan`.
pub fn list_requests(
    state: &DesktopState,
    dari: &str,
    sampai: &str,
) -> Result<Value, CommandError> {
    if !is_valid_date(dari) || !is_valid_date(sampai) || dari > sampai {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let hari_ini = wib_today(&transaction);
    let pilih = pilih_sql();

    let mut headers: Vec<serde_json::Map<String, Value>> = {
        let mut statement = transaction
            .prepare(&format!(
                "{pilih}
                 SELECT {}, (SELECT COUNT(*) FROM inventory_pengajuan y WHERE y.nomor = p.nomor) > 1
                 FROM inventory_pengajuan p
                 WHERE p.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
                 ORDER BY p.tanggal DESC, p.id_pengajuan DESC;",
                KOLOM_PENGAJUAN
                    .iter()
                    .map(|kolom| format!("p.{kolom}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![dari, sampai], |row| {
                let Value::Object(mut objek) = header_json(row)? else {
                    unreachable!()
                };
                objek.insert(
                    "nomor_ganda".into(),
                    json!(row.get::<_, bool>(KOLOM_PENGAJUAN.len())?),
                );
                Ok(objek)
            })
            .map_err(|_| CommandError::internal())?;
        rows.collect::<Result<_, _>>()
            .map_err(|_| CommandError::internal())?
    };

    let mut per_pengajuan: HashMap<String, Vec<Value>> = HashMap::new();
    {
        let mut statement = transaction
            .prepare(&format!(
                "{pilih}
                 SELECT r.id_pengajuan, r.id_baris, r.urutan, r.id_barang, b.kode_barang,
                        r.nama_barang, r.satuan, r.desimal, r.jumlah, r.harga_satuan,
                        {DITERIMA_BARIS_SQL}, b.id_barang
                 FROM inventory_pengajuan_baris r
                 LEFT JOIN inventory_barang b ON b.id_barang = COALESCE(r.id_barang, 'brg-' || r.id_baris)
                 WHERE r.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
                 ORDER BY r.id_pengajuan, r.urutan;"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![dari, sampai], |row| {
                let desimal = row.get::<_, i64>(7)? == 1;
                let jumlah: i64 = row.get(8)?;
                let harga: i64 = row.get(9)?;
                Ok((
                    row.get::<_, String>(0)?,
                    json!({
                        "id_baris": row.get::<_, String>(1)?,
                        "urutan": row.get::<_, i64>(2)?,
                        "id_barang": row.get::<_, Option<String>>(3)?,
                        "kode_barang": row.get::<_, Option<String>>(4)?,
                        "nama_barang": row.get::<_, String>(5)?,
                        "satuan": row.get::<_, String>(6)?,
                        "desimal": desimal,
                        "jumlah": jumlah,
                        "harga_satuan": harga,
                        "nilai": nilai_baris(jumlah, harga, desimal),
                        "diterima": row.get::<_, i64>(10)?,
                        "barang_terdaftar": row.get::<_, Option<String>>(11)?,
                        "harga_diterima": [],
                    }),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (id, baris) = row.map_err(|_| CommandError::internal())?;
            per_pengajuan.entry(id).or_default().push(baris);
        }
    }

    // Harga sebenarnya per baris, dikelompokkan, untuk tanda selisih (§3.5).
    let mut harga_per_baris: HashMap<String, Vec<Value>> = HashMap::new();
    {
        let mut statement = transaction
            .prepare(&format!(
                "{pilih}
                 SELECT m.id_ref, COALESCE(m.harga_satuan, 0), SUM(m.jumlah)
                 FROM inventory_mutasi m
                 JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
                 WHERE r.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
                   AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
                   AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
                 GROUP BY m.id_ref, COALESCE(m.harga_satuan, 0)
                 ORDER BY m.id_ref, COALESCE(m.harga_satuan, 0);"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![dari, sampai], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    json!({ "harga_satuan": row.get::<_, i64>(1)?, "jumlah": row.get::<_, i64>(2)? }),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (id_baris, harga) = row.map_err(|_| CommandError::internal())?;
            harga_per_baris.entry(id_baris).or_default().push(harga);
        }
    }
    let mut penerimaan_per: HashMap<String, Vec<Value>> = HashMap::new();
    {
        let mut statement = transaction
            .prepare(&format!(
                "{pilih}
                 SELECT t.id_pengajuan, t.id_penerimaan, t.tanggal, t.catatan, t.jumlah_foto, t.dicatat_oleh
                 FROM inventory_penerimaan t
                 WHERE t.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
                 ORDER BY t.tanggal, t.created_at, t.id_penerimaan;"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![dari, sampai], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    json!({
                        "id_penerimaan": row.get::<_, String>(1)?,
                        "tanggal": row.get::<_, String>(2)?,
                        "catatan": row.get::<_, Option<String>>(3)?,
                        "jumlah_foto": row.get::<_, i64>(4)?,
                        "dicatat_oleh": row.get::<_, String>(5)?,
                    }),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (id, penerimaan) = row.map_err(|_| CommandError::internal())?;
            penerimaan_per.entry(id).or_default().push(penerimaan);
        }
    }

    let terpotong = headers.len() > MAKS_DAFTAR_PENGAJUAN;
    headers.truncate(MAKS_DAFTAR_PENGAJUAN);
    let pengajuan = headers
        .into_iter()
        .map(|mut header| {
            let id = header["id_pengajuan"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let mut baris = per_pengajuan.remove(&id).unwrap_or_default();
            for item in &mut baris {
                let id_baris = item["id_baris"].as_str().unwrap_or_default().to_owned();
                if let Some(harga) = harga_per_baris.remove(&id_baris) {
                    item["harga_diterima"] = Value::Array(harga);
                }
            }
            let jumlah: Vec<(i64, i64)> = baris
                .iter()
                .map(|b| {
                    (
                        b["jumlah"].as_i64().unwrap_or(0),
                        b["diterima"].as_i64().unwrap_or(0),
                    )
                })
                .collect();
            let terisi = |kolom: &str| !header[kolom].is_null();
            let status = status_pengajuan(&KeadaanPengajuan {
                dibatalkan: terisi("dibatalkan_pada"),
                ditolak: terisi("ditolak_pada"),
                disetujui: terisi("disetujui_pada"),
                ditutup: terisi("ditutup_pada"),
                baris: &jumlah,
            });
            let total = baris
                .iter()
                .map(|b| i128::from(b["nilai"].as_i64().unwrap_or(0)))
                .sum::<i128>();
            for kolom in [
                "seri",
                "nomor_urut",
                "sidik_disetujui",
                "created_at",
                "updated_at",
            ] {
                header.remove(kolom);
            }
            header.insert("status".into(), json!(status));
            header.insert(
                "total".into(),
                json!(i64::try_from(total).unwrap_or(i64::MAX)),
            );
            header.insert("baris".into(), Value::Array(baris));
            header.insert(
                "penerimaan".into(),
                Value::Array(penerimaan_per.remove(&id).unwrap_or_default()),
            );
            Value::Object(header)
        })
        .collect::<Vec<_>>();
    Ok(json!({ "pengajuan": pengajuan, "terpotong": terpotong, "hari_ini": hari_ini }))
}

fn galat_baris(urutan: i64, galat: CommandError) -> CommandError {
    if galat.code == "VALIDATION_ERROR" {
        invalid(format!("Baris {urutan}: {}", galat.message))
    } else {
        galat
    }
}

fn mutasi_baris(
    transaction: &Transaction<'_>,
    id_baris: &str,
) -> Result<HashSet<String>, CommandError> {
    let mut statement = transaction
        .prepare(
            "SELECT id_mutasi FROM inventory_mutasi WHERE id_ref = ? AND jenis = 'Masuk'
             -- batas: satu baris pengajuan, paling banyak sejumlah unit yang di-ACC
             ;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(params![id_baris], |row| row.get::<_, String>(0))
        .map_err(|_| CommandError::internal())?;
    rows.collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())
}

struct BarisAccLokal {
    id_baris: String,
    urutan: i64,
    id_barang: Option<String>,
    nama_barang: String,
    satuan: String,
    desimal: bool,
    jumlah: i64,
    diterima: i64,
}

/// Mencatat penerimaan barang dalam SATU transaksi: barang baru (bila perlu),
/// Masuk Pengadaan per baris ber-`id_ref` = id baris, header, dan fotonya.
/// Mutasi dan barang mendaftarkan event-nya sendiri lewat inti yang sudah
/// ada; header dan foto menyusul di outbox. Cermin `receivePengajuan`.
pub fn receive_request(
    state: &DesktopState,
    operator: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: PenerimaanDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data penerimaan tidak valid."))?;
    let id_pengajuan = draft.id_pengajuan.trim().to_owned();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let status = status_lokal(&transaction, &id_pengajuan)?;
    if !matches!(status, "Disetujui" | "Diterima sebagian") {
        return Err(invalid(
            "Penerimaan hanya untuk pengajuan Disetujui atau Diterima sebagian.",
        ));
    }
    let (nomor, sumber_dana, disetujui_pada): (String, Option<String>, String) = transaction
        .query_row(
            "SELECT nomor, sumber_dana, disetujui_pada FROM inventory_pengajuan WHERE id_pengajuan = ?;",
            params![id_pengajuan],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| CommandError::internal())?;
    let acc: Vec<BarisAccLokal> = {
        let mut statement = transaction
            .prepare(&format!(
                "SELECT r.id_baris, r.urutan, r.id_barang, r.nama_barang, r.satuan, r.desimal,
                        r.jumlah, {DITERIMA_BARIS_SQL}
                 FROM inventory_pengajuan_baris r WHERE r.id_pengajuan = ? ORDER BY r.urutan;"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![id_pengajuan], |row| {
                Ok(BarisAccLokal {
                    id_baris: row.get(0)?,
                    urutan: row.get(1)?,
                    id_barang: row.get(2)?,
                    nama_barang: row.get(3)?,
                    satuan: row.get(4)?,
                    desimal: row.get::<_, i64>(5)? == 1,
                    jumlah: row.get(6)?,
                    diterima: row.get(7)?,
                })
            })
            .map_err(|_| CommandError::internal())?;
        rows.collect::<Result<_, _>>()
            .map_err(|_| CommandError::internal())?
    };
    let ringkas: Vec<BarisAcc<'_>> = acc
        .iter()
        .map(|b| BarisAcc {
            id_baris: &b.id_baris,
            urutan: b.urutan,
            jumlah: b.jumlah,
            diterima: b.diterima,
        })
        .collect();
    let hari_ini = wib_today(&transaction);
    let tanggal_acc: String = disetujui_pada.chars().take(10).collect();
    let valid = validate_penerimaan(&draft, &tanggal_acc, &hari_ini, &ringkas).map_err(invalid)?;

    let mut label = Vec::with_capacity(valid.dicatat.len());
    for indeks in &valid.dicatat {
        let isian = &draft.baris[*indeks];
        let baris = acc
            .iter()
            .find(|b| b.id_baris == isian.id_baris.trim())
            .ok_or_else(CommandError::internal)?;
        let id_barang = match &baris.id_barang {
            Some(id) => id.clone(),
            None => {
                let id_baru = id_barang_baru(&baris.id_baris);
                let ada: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM inventory_barang WHERE id_barang = ?);",
                        params![id_baru],
                        |row| row.get(0),
                    )
                    .map_err(|_| CommandError::internal())?;
                if !ada {
                    let barang = BarangDraft {
                        nama_barang: baris.nama_barang.clone(),
                        satuan: baris.satuan.clone(),
                        desimal: baris.desimal,
                        tipe: isian.tipe.clone().unwrap_or_default(),
                        kategori: isian.kategori.clone(),
                        bisa_expired: isian.bisa_expired,
                        tempat_utama: isian.tempat.clone(),
                        status_aktif: true,
                        ..BarangDraft::default()
                    };
                    inventory::save_item_tx(&transaction, &client_id, &barang, Some(&id_baru))
                        .map_err(|e| galat_baris(baris.urutan, e))?;
                }
                id_baru
            }
        };
        let sebelum = mutasi_baris(&transaction, &baris.id_baris)?;
        let mutasi = MutasiDraft {
            id_barang: id_barang.clone(),
            jenis: "Masuk".into(),
            alasan: "Pengadaan".into(),
            tanggal: Some(valid.tanggal.clone()),
            jumlah: isian.jumlah,
            tempat_tujuan: isian.tempat.clone(),
            kondisi_tujuan: Some(clean(&isian.kondisi).unwrap_or_else(|| "Baik".to_owned())),
            tanggal_expired: isian.tanggal_expired.clone(),
            sumber_dana: sumber_dana.clone(),
            nomor_dokumen: Some(nomor.clone()),
            harga_satuan: Some(isian.harga_satuan),
            catatan: valid.catatan.clone(),
            per_unit: isian.per_unit,
            ..MutasiDraft::default()
        };
        inventory::record_mutation_tx(
            &transaction,
            &client_id,
            operator,
            &mutasi,
            Some(&baris.id_baris),
        )
        .map_err(|e| galat_baris(baris.urutan, e))?;
        let mut baru: Vec<String> = mutasi_baris(&transaction, &baris.id_baris)?
            .difference(&sebelum)
            .cloned()
            .collect();
        baru.sort();
        label.push(json!({ "id_barang": id_barang, "jumlah": isian.jumlah, "mutasi": baru }));
    }

    let id_penerimaan = new_hex_id("trm-");
    transaction
        .execute(
            "INSERT INTO inventory_penerimaan (
                id_penerimaan, id_pengajuan, tanggal, catatan, jumlah_foto, dicatat_oleh, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'));",
            params![
                id_penerimaan,
                id_pengajuan,
                valid.tanggal,
                valid.catatan,
                draft.foto.len() as i64,
                operator
            ],
        )
        .map_err(|_| CommandError::internal())?;
    let header = transaction
        .query_row(
            "SELECT id_penerimaan, id_pengajuan, tanggal, catatan, jumlah_foto, dicatat_oleh, created_at
             FROM inventory_penerimaan WHERE id_penerimaan = ?;",
            params![id_penerimaan],
            |row| {
                Ok(json!({
                    "id_penerimaan": row.get::<_, String>(0)?,
                    "id_pengajuan": row.get::<_, String>(1)?,
                    "tanggal": row.get::<_, String>(2)?,
                    "catatan": row.get::<_, Option<String>>(3)?,
                    "jumlah_foto": row.get::<_, i64>(4)?,
                    "dicatat_oleh": row.get::<_, String>(5)?,
                    "created_at": row.get::<_, String>(6)?,
                }))
            },
        )
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        &transaction,
        &client_id,
        "inventory-receipt",
        "create",
        &id_penerimaan,
        &header,
        None,
    )?;
    for (indeks, foto) in draft.foto.iter().enumerate() {
        let urutan = indeks as i64 + 1;
        let id_foto = format!("{id_penerimaan}-{urutan}");
        transaction
            .execute(
                "INSERT INTO inventory_penerimaan_foto (
                    id_foto, id_penerimaan, urutan, mime_type, data_base64, created_at
                 ) VALUES (?, ?, ?, ?, ?, datetime('now'));",
                params![
                    id_foto,
                    id_penerimaan,
                    urutan,
                    foto.mime_type,
                    foto.data_base64
                ],
            )
            .map_err(|_| CommandError::internal())?;
        // Satu event per foto supaya satu event tidak berukuran megabita.
        let payload = json!({
            "id_foto": id_foto,
            "id_penerimaan": id_penerimaan,
            "urutan": urutan,
            "mime_type": foto.mime_type,
            "data_base64": foto.data_base64,
        });
        sync::enqueue(
            &transaction,
            &client_id,
            "inventory-receipt-photo",
            "save",
            &id_foto,
            &payload,
            None,
        )?;
    }
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_penerimaan": id_penerimaan, "label": label }))
}

/// Foto penerimaan dari SQLite lokal; `None` bila perangkat ini tidak
/// mencatatnya. Pemanggil lalu menariknya dari cloud.
pub fn receipt_photo_local(
    state: &DesktopState,
    id_foto: &str,
) -> Result<Option<Value>, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    connection
        .query_row(
            "SELECT mime_type, data_base64 FROM inventory_penerimaan_foto WHERE id_foto = ?;",
            params![id_foto.trim()],
            |row| {
                Ok(json!({
                    "mime_type": row.get::<_, String>(0)?,
                    "data_base64": row.get::<_, String>(1)?,
                }))
            },
        )
        .optional()
        .map_err(|_| CommandError::internal())
}

// Cloud

/// Mengajukan, atau mengubah selama cloud masih Menunggu. Cermin
/// `CLOUD_UPSERT_PENGAJUAN_SQL`.
pub const CLOUD_UPSERT_PENGAJUAN_SQL: &str = "INSERT INTO inventory_pengajuan (
        id_pengajuan, tanggal, seri, nomor_urut, nomor, keperluan, sumber_dana, catatan,
        sidik_baris, diajukan_oleh, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    ON CONFLICT(id_pengajuan) DO UPDATE SET
        tanggal = excluded.tanggal,
        keperluan = excluded.keperluan,
        sumber_dana = excluded.sumber_dana,
        catatan = excluded.catatan,
        sidik_baris = excluded.sidik_baris,
        updated_at = datetime('now')
    WHERE inventory_pengajuan.disetujui_pada IS NULL AND inventory_pengajuan.ditolak_pada IS NULL
      AND inventory_pengajuan.dibatalkan_pada IS NULL;";

/// Baris hanya ikut bila header-nya di cloud memegang versi ini: header yang
/// sudah diputuskan menolak upsert di atas, dan sidiknya jadi tidak cocok.
/// Parameter terakhir: id pengajuan, sidik. Cermin `CLOUD_UPSERT_BARIS_SQL`.
pub const CLOUD_UPSERT_BARIS_SQL: &str = "INSERT INTO inventory_pengajuan_baris (
        id_baris, id_pengajuan, urutan, id_barang, nama_barang, satuan, desimal, jumlah, harga_satuan
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM inventory_pengajuan p WHERE p.id_pengajuan = ? AND p.sidik_baris = ?
        AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL)
    ON CONFLICT(id_baris) DO UPDATE SET
        urutan = excluded.urutan,
        id_barang = excluded.id_barang,
        nama_barang = excluded.nama_barang,
        satuan = excluded.satuan,
        desimal = excluded.desimal,
        jumlah = excluded.jumlah,
        harga_satuan = excluded.harga_satuan;";

/// Baris lebih dari jumlah kiriman dibuang (trigger tombstone menyebarkannya).
/// Parameter: id pengajuan, jumlah baris, id pengajuan, sidik. Cermin
/// `CLOUD_BUANG_BARIS_SQL`.
pub const CLOUD_BUANG_BARIS_SQL: &str = "DELETE FROM inventory_pengajuan_baris
    WHERE id_pengajuan = ? AND urutan > ?
      AND EXISTS (SELECT 1 FROM inventory_pengajuan p WHERE p.id_pengajuan = ? AND p.sidik_baris = ?
        AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL);";

/// ACC yang pertama sampai berlaku, dan hanya atas isi yang dilihat.
pub const CLOUD_APPROVE_PENGAJUAN_SQL: &str = "UPDATE inventory_pengajuan
    SET disetujui_pada = ?, disetujui_oleh = ?, sidik_disetujui = ?, catatan_persetujuan = ?,
        updated_at = datetime('now')
    WHERE id_pengajuan = ? AND sidik_baris = ?
      AND disetujui_pada IS NULL AND ditolak_pada IS NULL AND dibatalkan_pada IS NULL;";

pub const CLOUD_REJECT_PENGAJUAN_SQL: &str = "UPDATE inventory_pengajuan
    SET ditolak_pada = ?, ditolak_oleh = ?, alasan_tolak = ?, updated_at = datetime('now')
    WHERE id_pengajuan = ? AND disetujui_pada IS NULL AND ditolak_pada IS NULL AND dibatalkan_pada IS NULL;";

pub const CLOUD_CANCEL_PENGAJUAN_SQL: &str = "UPDATE inventory_pengajuan
    SET dibatalkan_pada = ?, dibatalkan_oleh = ?, alasan_batal = ?, updated_at = datetime('now')
    WHERE id_pengajuan = ? AND disetujui_pada IS NULL AND ditolak_pada IS NULL AND dibatalkan_pada IS NULL;";

pub const CLOUD_CLOSE_PENGAJUAN_SQL: &str = "UPDATE inventory_pengajuan
    SET ditutup_pada = ?, ditutup_oleh = ?, alasan_tutup = ?, updated_at = datetime('now')
    WHERE id_pengajuan = ? AND disetujui_pada IS NOT NULL AND ditutup_pada IS NULL
      AND dibatalkan_pada IS NULL AND ditolak_pada IS NULL;";

fn header_payload<'a>(payload: &'a Value, entity_key: &str) -> Option<(&'a Value, String)> {
    let header = payload.get("pengajuan")?;
    let id = payload_text(header, "id_pengajuan").unwrap_or_else(|| entity_key.trim().to_owned());
    (!id.is_empty()).then_some((header, id))
}

/// Statement event `inventory-request/save`, dijalankan atomik dalam satu event
/// seperti jurnal. Sidik dihitung ulang dari baris kiriman. Payload cacat
/// dilewati, tidak ditolak, supaya outbox tidak macet.
pub fn cloud_save_statements(
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let (header, id) = header_payload(payload, entity_key)?;
    let tanggal = payload_text(header, "tanggal").filter(|t| is_valid_date(t))?;
    let nomor_urut = header
        .get("nomor_urut")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)?;
    let rows = payload.get("baris")?.as_array()?;
    if rows.is_empty() || rows.len() > MAKS_BARIS_PENGAJUAN {
        return None;
    }
    let mut baris = Vec::with_capacity(rows.len());
    for (indeks, row) in rows.iter().enumerate() {
        let urutan = row.get("urutan").and_then(Value::as_i64)?;
        if urutan != indeks as i64 + 1 {
            return None;
        }
        baris.push(BarisValid {
            id_barang: payload_text(row, "id_barang"),
            nama_barang: payload_text(row, "nama_barang")?,
            satuan: payload_text(row, "satuan")?,
            desimal: match row.get("desimal").and_then(Value::as_i64)? {
                0 => false,
                1 => true,
                _ => return None,
            },
            jumlah: row
                .get("jumlah")
                .and_then(Value::as_i64)
                .filter(|n| *n > 0)?,
            harga_satuan: row
                .get("harga_satuan")
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0)?,
        });
    }
    let sidik = sidik_baris(&baris);

    let mut statements = vec![(
        CLOUD_UPSERT_PENGAJUAN_SQL,
        vec![
            json!(id),
            json!(tanggal),
            json!(payload_text(header, "seri")?),
            json!(nomor_urut),
            json!(payload_text(header, "nomor")?),
            json!(payload_text(header, "keperluan")?),
            json!(payload_text(header, "sumber_dana")),
            json!(payload_text(header, "catatan")),
            json!(sidik),
            json!(payload_text(header, "diajukan_oleh")?),
            json!(payload_text(header, "created_at")),
        ],
    )];
    for (indeks, item) in baris.iter().enumerate() {
        let urutan = indeks as i64 + 1;
        statements.push((
            CLOUD_UPSERT_BARIS_SQL,
            vec![
                json!(id_baris_pengajuan(&id, urutan)),
                json!(id),
                json!(urutan),
                json!(item.id_barang),
                json!(item.nama_barang),
                json!(item.satuan),
                json!(item.desimal as i64),
                json!(item.jumlah),
                json!(item.harga_satuan),
                json!(id),
                json!(sidik),
            ],
        ));
    }
    statements.push((
        CLOUD_BUANG_BARIS_SQL,
        vec![
            json!(id),
            json!(baris.len() as i64),
            json!(id),
            json!(sidik),
        ],
    ));
    Some(statements)
}

pub fn cloud_approve_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let (header, id) = header_payload(payload, entity_key)?;
    let sidik = payload_text(header, "sidik_disetujui")?;
    Some(vec![
        json!(payload_text(header, "disetujui_pada")?),
        json!(payload_text(header, "disetujui_oleh")?),
        json!(sidik),
        json!(payload_text(header, "catatan_persetujuan")),
        json!(id),
        json!(sidik),
    ])
}

pub fn cloud_reject_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let (header, id) = header_payload(payload, entity_key)?;
    Some(vec![
        json!(payload_text(header, "ditolak_pada")?),
        json!(payload_text(header, "ditolak_oleh")?),
        json!(payload_text(header, "alasan_tolak")?),
        json!(id),
    ])
}

pub fn cloud_cancel_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let (header, id) = header_payload(payload, entity_key)?;
    Some(vec![
        json!(payload_text(header, "dibatalkan_pada")?),
        json!(payload_text(header, "dibatalkan_oleh")?),
        json!(payload_text(header, "alasan_batal")?),
        json!(id),
    ])
}

pub fn cloud_close_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let (header, id) = header_payload(payload, entity_key)?;
    Some(vec![
        json!(payload_text(header, "ditutup_pada")?),
        json!(payload_text(header, "ditutup_oleh")?),
        json!(payload_text(header, "alasan_tutup")?),
        json!(id),
    ])
}

/// Penerimaan bersifat append-only; event yang terkirim dua kali berhenti di PK.
pub const CLOUD_INSERT_PENERIMAAN_SQL: &str = "INSERT INTO inventory_penerimaan (
        id_penerimaan, id_pengajuan, tanggal, catatan, jumlah_foto, dicatat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_penerimaan) DO NOTHING;";

pub const CLOUD_INSERT_FOTO_SQL: &str = "INSERT INTO inventory_penerimaan_foto (
        id_foto, id_penerimaan, urutan, mime_type, data_base64, created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id_foto) DO NOTHING;";

pub fn cloud_receipt_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(payload, "id_penerimaan").unwrap_or_else(|| entity_key.trim().to_owned());
    let tanggal = payload_text(payload, "tanggal").filter(|t| is_valid_date(t))?;
    let jumlah_foto = payload
        .get("jumlah_foto")
        .and_then(Value::as_i64)
        .filter(|n| (1..=MAKS_FOTO_PENERIMAAN as i64).contains(n))?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(payload, "id_pengajuan")?),
        json!(tanggal),
        json!(payload_text(payload, "catatan")),
        json!(jumlah_foto),
        json!(payload_text(payload, "dicatat_oleh")?),
        json!(payload_text(payload, "created_at")),
    ])
}

/// Foto yang tidak lolos aturan lokal dilewati, tidak ditolak: CHECK cloud
/// yang menolaknya akan membuat outbox macet selamanya.
pub fn cloud_photo_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(payload, "id_foto").unwrap_or_else(|| entity_key.trim().to_owned());
    let urutan = payload
        .get("urutan")
        .and_then(Value::as_i64)
        .filter(|n| (1..=MAKS_FOTO_PENERIMAAN as i64).contains(n))?;
    let foto = FotoDraft {
        mime_type: payload_text(payload, "mime_type")?,
        data_base64: payload.get("data_base64")?.as_str()?.to_owned(),
    };
    validate_foto_penerimaan(std::slice::from_ref(&foto)).ok()?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(payload, "id_penerimaan")?),
        json!(urutan),
        json!(foto.mime_type),
        json!(foto.data_base64),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // Vektor yang sama dengan `inventory-pengajuan.test.ts`.

    fn baris(
        id_barang: Option<&str>,
        nama: &str,
        satuan: &str,
        desimal: bool,
        jumlah: i64,
        harga: i64,
    ) -> BarisValid {
        BarisValid {
            id_barang: id_barang.map(str::to_owned),
            nama_barang: nama.into(),
            satuan: satuan.into(),
            desimal,
            jumlah,
            harga_satuan: harga,
        }
    }

    fn draft(value: Value) -> PengajuanDraft {
        serde_json::from_value(value).expect("draft pengajuan")
    }

    #[test]
    fn nomor_id_dan_nilai() {
        assert_eq!(
            format_nomor_pengajuan("2026", "WAB12", 7),
            "PGJ/2026/WAB12/0007"
        );
        assert_eq!(
            format_nomor_pengajuan("2026", "WEB", 12345),
            "PGJ/2026/WEB/12345"
        );
        assert_eq!(id_baris_pengajuan("pgj-ab", 3), "pgj-ab-3");
        assert_eq!(id_pengajuan_dari_baris("pgj-ab-3"), Some("pgj-ab"));
        assert_eq!(id_pengajuan_dari_baris("pgj-ab-x"), None);
        assert_eq!(id_pengajuan_dari_baris("tanpa"), None);
        assert_eq!(nilai_baris(3, 55_000, false), 165_000);
        assert_eq!(nilai_baris(250, 12_000, true), 30_000);
        assert_eq!(nilai_baris(125, 999, true), 1_249);
    }

    #[test]
    fn sidik_vektor() {
        let isi = vec![
            baris(Some("brg-1"), "Spidol", "pcs", false, 10, 8_500),
            baris(None, "Kertas HVS", "rim", false, 5, 55_000),
        ];
        assert_eq!(
            sidik_baris(&isi),
            "92c7711b15b5bfc3dba4f63580b615ee35b6da937bf9d2b7e7fb585e19597620"
        );
        let mut ubah = isi.clone();
        ubah[1].harga_satuan = 60_000;
        assert_ne!(sidik_baris(&ubah), sidik_baris(&isi));
    }

    #[test]
    fn status_vektor() {
        let k = |dibatalkan, ditolak, disetujui, ditutup, baris: &[(i64, i64)]| {
            status_pengajuan(&KeadaanPengajuan {
                dibatalkan,
                ditolak,
                disetujui,
                ditutup,
                baris,
            })
            .to_owned()
        };
        assert_eq!(k(true, false, false, false, &[(5, 0)]), "Dibatalkan");
        assert_eq!(k(false, true, false, false, &[(5, 0)]), "Ditolak");
        assert_eq!(k(false, false, false, false, &[(5, 0)]), "Menunggu");
        assert_eq!(k(false, false, true, false, &[(5, 0), (2, 0)]), "Disetujui");
        assert_eq!(
            k(false, false, true, false, &[(5, 5), (2, 0)]),
            "Diterima sebagian"
        );
        assert_eq!(k(false, false, true, false, &[(5, 5), (2, 3)]), "Selesai");
        assert_eq!(k(false, false, true, true, &[(5, 0)]), "Selesai");
    }

    #[test]
    fn validasi_vektor() {
        let hari = "2026-10-28";
        let galat = |value: Value| validate_pengajuan(&draft(value), hari).unwrap_err();
        let satu =
            json!([{"nama_barang": "Kertas", "satuan": "rim", "jumlah": 5, "harga_satuan": 55000}]);
        assert_eq!(
            galat(json!({"tanggal": "2026-10-29", "keperluan": "ATK", "baris": satu})),
            "Tanggal pengajuan tidak boleh setelah hari ini."
        );
        assert_eq!(
            galat(json!({"tanggal": "2026-02-30", "keperluan": "ATK", "baris": satu})),
            "Tanggal pengajuan tidak valid."
        );
        assert_eq!(
            galat(json!({"tanggal": hari, "keperluan": "  ", "baris": satu})),
            "Keperluan wajib diisi."
        );
        assert_eq!(
            galat(json!({"tanggal": hari, "keperluan": "ATK", "baris": []})),
            "Isi minimal satu barang."
        );
        assert_eq!(
            galat(json!({"tanggal": hari, "keperluan": "ATK", "baris": [
                {"id_barang": "brg-1", "jumlah": 1, "harga_satuan": 0},
                {"id_barang": "brg-1", "jumlah": 2, "harga_satuan": 0}]})),
            "Baris 2: barang ini sudah ada di baris 1."
        );
        assert_eq!(
            galat(
                json!({"tanggal": hari, "keperluan": "ATK", "baris": [{"satuan": "rim", "jumlah": 1, "harga_satuan": 0}]})
            ),
            "Baris 1: nama barang wajib diisi."
        );
        assert_eq!(
            galat(
                json!({"tanggal": hari, "keperluan": "ATK", "baris": [{"nama_barang": "Kertas", "jumlah": 1, "harga_satuan": 0}]})
            ),
            "Baris 1: satuan wajib diisi."
        );
        assert_eq!(
            galat(
                json!({"tanggal": hari, "keperluan": "ATK", "baris": [{"nama_barang": "Kertas", "satuan": "rim", "jumlah": 0, "harga_satuan": 0}]})
            ),
            "Baris 1: jumlah harus lebih dari 0."
        );
        assert_eq!(
            galat(
                json!({"tanggal": hari, "keperluan": "ATK", "baris": [{"nama_barang": "Kertas", "satuan": "rim", "jumlah": 1, "harga_satuan": -1}]})
            ),
            "Baris 1: harga satuan tidak valid."
        );
        assert_eq!(
            galat(
                json!({"tanggal": hari, "keperluan": "ATK", "baris": [{"nama_barang": "Kertas", "satuan": "rim", "jumlah": 1_000_000_000, "harga_satuan": 1_000_000_000_000_i64}]})
            ),
            "Baris 1: nilai (jumlah × harga satuan) terlalu besar."
        );

        let valid = validate_pengajuan(
            &draft(json!({"tanggal": hari, "keperluan": " ATK ", "sumber_dana": " ", "baris": [
                {"id_barang": "brg-1", "nama_barang": "diabaikan", "jumlah": 10, "harga_satuan": 8500},
                {"nama_barang": " Kertas HVS ", "satuan": "rim", "desimal": false, "jumlah": 5, "harga_satuan": 55000}]})),
            hari,
        )
        .expect("valid");
        assert_eq!(valid.keperluan, "ATK");
        assert_eq!(valid.sumber_dana, None);
        assert_eq!(
            valid.baris[0],
            baris(Some("brg-1"), "", "", false, 10, 8_500)
        );
        assert_eq!(
            valid.baris[1],
            baris(None, "Kertas HVS", "rim", false, 5, 55_000)
        );
    }

    #[test]
    fn pemutus_vektor() {
        let pesan = Err(
            "Pengajuan ini kamu ajukan sendiri. Minta pemegang Keuangan lain untuk memutuskannya."
                .to_owned(),
        );
        assert_eq!(validate_pemutus("sarpras", "sarpras", false), pesan);
        assert_eq!(validate_pemutus("Sarpras", " sarpras ", false), pesan);
        assert_eq!(validate_pemutus("sarpras", "sarpras", true), Ok(()));
        assert_eq!(validate_pemutus("sarpras", "bendahara", false), Ok(()));
    }

    #[test]
    fn keputusan_vektor() {
        let k = |value: Value| validate_keputusan(&serde_json::from_value(value).expect("draft"));
        let sidik = "a".repeat(64);
        assert_eq!(
            k(
                json!({"id_pengajuan": "p", "keputusan": "ACC", "sidik_baris": sidik.to_uppercase()})
            ),
            Ok(KeputusanValid::Acc {
                sidik: sidik.clone(),
                catatan: None
            })
        );
        assert_eq!(
            k(json!({"id_pengajuan": "p", "keputusan": "ACC", "sidik_baris": "abc"})),
            Err("Pengajuan tidak valid. Muat ulang daftarnya.".to_owned())
        );
        assert_eq!(
            k(json!({"id_pengajuan": "p", "keputusan": "Tolak", "catatan": " "})),
            Err("Alasan penolakan wajib diisi.".to_owned())
        );
        assert_eq!(
            k(
                json!({"id_pengajuan": "p", "keputusan": "Tolak", "catatan": " Harga terlalu mahal "})
            ),
            Ok(KeputusanValid::Tolak {
                alasan: "Harga terlalu mahal".into()
            })
        );
        assert_eq!(
            k(json!({"id_pengajuan": "p", "keputusan": "Setuju"})),
            Err("Keputusan tidak dikenal.".to_owned())
        );
    }

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

    /// Ajukan → ubah → ACC dengan sidik basi ditolak → ACC → tutup. Setiap
    /// langkah masuk outbox. Skenario yang sama dengan
    /// `inventory-pengajuan.test.ts`.
    #[test]
    fn alur_ajukan_ubah_acc_tutup() {
        let (_directory, state) = setup_state();
        let id_barang = super::super::inventory::save_item(
            &state,
            json!({"nama_barang": "Spidol", "tipe": "Habis Pakai", "satuan": "pcs", "tempat_utama": "Gudang"}),
        )
        .expect("barang")["id_barang"]
            .as_str()
            .expect("id")
            .to_owned();
        let connection = storage::database(&state.data_dir).expect("db");
        let hari = wib_today(&connection);

        let id = save_request(
            &state,
            "sarpras",
            json!({"tanggal": hari, "keperluan": "ATK semester ganjil", "baris": [
                {"id_barang": id_barang, "nama_barang": "Spidol palsu", "jumlah": 10, "harga_satuan": 8500},
                {"nama_barang": "Kertas HVS", "satuan": "rim", "jumlah": 5, "harga_satuan": 55000},
                {"nama_barang": "Map", "satuan": "pcs", "jumlah": 20, "harga_satuan": 2000}]}),
        )
        .expect("ajukan")["id_pengajuan"]
            .as_str()
            .expect("id")
            .to_owned();
        let daftar = list_requests(&state, &hari, &hari).expect("daftar");
        let p = &daftar["pengajuan"][0];
        assert_eq!(p["status"], "Menunggu");
        assert_eq!(p["total"], 85_000 + 275_000 + 40_000);
        assert_eq!(p["baris"][0]["nama_barang"], "Spidol");
        assert_eq!(p["baris"][2]["id_baris"], format!("{id}-3"));
        let sidik_lama = p["sidik_baris"].as_str().expect("sidik").to_owned();

        save_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "keperluan": "ATK", "baris": [
                {"nama_barang": "Kertas HVS", "satuan": "rim", "jumlah": 5, "harga_satuan": 60000}]}),
        )
        .expect("ubah");
        let jumlah_baris: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inventory_pengajuan_baris WHERE id_pengajuan = ?;",
                params![id],
                |row| row.get(0),
            )
            .expect("hitung");
        assert_eq!(jumlah_baris, 1);

        let basi = decide_request(
            &state,
            "bendahara",
            false,
            json!({"id_pengajuan": id, "keputusan": "ACC", "sidik_baris": sidik_lama}),
        )
        .unwrap_err();
        assert!(basi.message.contains("berubah sejak"), "{}", basi.message);
        let daftar = list_requests(&state, &hari, &hari).expect("daftar");
        let sidik = daftar["pengajuan"][0]["sidik_baris"]
            .as_str()
            .expect("sidik")
            .to_owned();
        let sendiri = decide_request(
            &state,
            "sarpras",
            false,
            json!({"id_pengajuan": id, "keputusan": "ACC", "sidik_baris": sidik}),
        )
        .unwrap_err();
        assert!(
            sendiri.message.contains("kamu ajukan sendiri"),
            "{}",
            sendiri.message
        );
        decide_request(
            &state,
            "bendahara",
            false,
            json!({"id_pengajuan": id, "keputusan": "ACC", "sidik_baris": sidik}),
        )
        .expect("acc");
        assert!(save_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "keperluan": "ATK", "baris": [
                {"nama_barang": "Kertas HVS", "satuan": "rim", "jumlah": 1, "harga_satuan": 1}]}),
        )
        .unwrap_err()
        .message
        .contains("berstatus Disetujui"));
        assert!(cancel_request(&state, "sarpras", &id, "Salah").is_err());

        close_request(&state, "sarpras", &id, "Toko tutup").expect("tutup");
        let daftar = list_requests(&state, &hari, &hari).expect("daftar");
        assert_eq!(daftar["pengajuan"][0]["status"], "Selesai");
        assert_eq!(daftar["pengajuan"][0]["alasan_tutup"], "Toko tutup");

        let event: Vec<String> = connection
            .prepare(
                "SELECT operation FROM desktop_sync_outbox WHERE domain = 'inventory-request' ORDER BY rowid;",
            )
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("baris");
        assert_eq!(event, vec!["save", "save", "approve", "close"]);
    }

    /// Payload event tersimpan diterima oleh penyusun statement cloud, dan
    /// sidik hasil hitung ulang cloud sama dengan sidik lokal.
    #[test]
    fn payload_outbox_cocok_dengan_handler_cloud() {
        let (_directory, state) = setup_state();
        let connection = storage::database(&state.data_dir).expect("db");
        let hari = wib_today(&connection);
        let id = save_request(
            &state,
            "sarpras",
            json!({"tanggal": hari, "keperluan": "ATK", "baris": [
                {"nama_barang": "Kertas HVS", "satuan": "rim", "jumlah": 5, "harga_satuan": 55000},
                {"nama_barang": "Beras", "satuan": "kg", "desimal": true, "jumlah": 250, "harga_satuan": 12000}]}),
        )
        .expect("ajukan")["id_pengajuan"]
            .as_str()
            .expect("id")
            .to_owned();
        let (payload, sidik): (String, String) = connection
            .query_row(
                "SELECT o.payload_json, p.sidik_baris FROM desktop_sync_outbox o
                 JOIN inventory_pengajuan p ON p.id_pengajuan = o.entity_key
                 WHERE o.domain = 'inventory-request';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("outbox");
        let payload: Value = serde_json::from_str(&payload).expect("json");
        let statements = cloud_save_statements(&payload, &id).expect("statement");
        assert_eq!(statements.len(), 4);
        assert_eq!(statements[0].1[8], json!(sidik));
        assert_eq!(statements[2].1[6], json!(1));
        assert_eq!(
            statements[3].1,
            vec![json!(id), json!(2), json!(id), json!(sidik)]
        );
        assert!(cloud_approve_values(&payload, &id).is_none());

        let mut cacat = payload.clone();
        cacat["baris"][0]["jumlah"] = json!(0);
        assert!(cloud_save_statements(&cacat, &id).is_none());
    }

    fn foto(mime: &str, isi: &str) -> FotoDraft {
        FotoDraft {
            mime_type: mime.into(),
            data_base64: isi.into(),
        }
    }

    #[test]
    fn validasi_foto_vektor() {
        assert_eq!(
            validate_foto_penerimaan(&[]),
            Err("Lampirkan minimal satu foto barang yang diterima.".to_owned())
        );
        let enam: Vec<FotoDraft> = (0..6).map(|_| foto("image/jpeg", "QUJD")).collect();
        assert_eq!(
            validate_foto_penerimaan(&enam),
            Err("Paling banyak 5 foto.".to_owned())
        );
        assert_eq!(
            validate_foto_penerimaan(&[foto("image/jpeg", "QUJD"), foto("image/gif", "QUJD")]),
            Err("Foto 2: format harus JPEG, PNG, atau WebP.".to_owned())
        );
        assert_eq!(
            validate_foto_penerimaan(&[foto("image/jpeg", &"A".repeat(600_004))]),
            Err("Foto 1 terlalu besar. Kompres ulang atau pilih foto lain.".to_owned())
        );
        for rusak in ["", "QUJ", "QU=D", "QUJD===", "QU*D"] {
            assert_eq!(
                validate_foto_penerimaan(&[foto("image/png", rusak)]),
                Err("Foto 1 tidak terbaca.".to_owned()),
                "{rusak}"
            );
        }
        assert!(
            validate_foto_penerimaan(&[foto("image/webp", "QUI="), foto("image/png", "QQ==")])
                .is_ok()
        );
    }

    #[test]
    fn validasi_penerimaan_vektor() {
        let acc = [
            BarisAcc {
                id_baris: "p-1",
                urutan: 1,
                jumlah: 10,
                diterima: 4,
            },
            BarisAcc {
                id_baris: "p-2",
                urutan: 2,
                jumlah: 5,
                diterima: 0,
            },
        ];
        let d = |value: Value| -> PenerimaanDraft { serde_json::from_value(value).expect("draft") };
        let f = json!([{"mime_type": "image/jpeg", "data_base64": "QUJD"}]);
        let cek = |value: Value| validate_penerimaan(&d(value), "2026-10-20", "2026-10-28", &acc);
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-19", "baris": [{"id_baris": "p-1", "jumlah": 1}], "foto": f})
            ),
            Err("Tanggal terima tidak boleh sebelum tanggal ACC.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-29", "baris": [{"id_baris": "p-1", "jumlah": 1}], "foto": f})
            ),
            Err("Tanggal terima tidak boleh setelah hari ini.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-28", "baris": [{"id_baris": "p-9", "jumlah": 1}], "foto": f})
            ),
            Err("Barang penerimaan tidak dikenal. Muat ulang daftarnya.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-28", "baris": [{"id_baris": "p-1", "jumlah": 7}], "foto": f})
            ),
            Err("Baris 1: jumlah diterima melebihi sisa yang di-ACC.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-28", "baris": [{"id_baris": "p-1", "jumlah": 0}], "foto": f})
            ),
            Err("Isi jumlah diterima minimal satu barang.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-28", "baris": [{"id_baris": "p-2", "jumlah": 5}], "foto": []})
            ),
            Err("Lampirkan minimal satu foto barang yang diterima.".to_owned())
        );
        assert_eq!(
            cek(
                json!({"tanggal": "2026-10-28", "catatan": " Kardus penyok ", "baris": [
                {"id_baris": "p-1", "jumlah": 0}, {"id_baris": "p-2", "jumlah": 5, "harga_satuan": 60000}], "foto": f})
            ),
            Ok(PenerimaanValid {
                tanggal: "2026-10-28".into(),
                catatan: Some("Kardus penyok".into()),
                dicatat: vec![1],
            })
        );
        assert_eq!(id_barang_baru("pgj-a-2"), "brg-pgj-a-2");
    }

    /// Penerimaan bertahap: barang baru terbuat sekali, Masuk ber-`id_ref`,
    /// status mengikuti, dan outbox berurutan barang → mutasi → header → foto.
    /// Skenario yang sama dengan `inventory-pengajuan.test.ts`.
    #[test]
    fn penerimaan_bertahap_membuat_barang_sekali() {
        let (_directory, state) = setup_state();
        let id_barang = super::super::inventory::save_item(
            &state,
            json!({"nama_barang": "Spidol", "tipe": "Habis Pakai", "satuan": "pcs", "tempat_utama": "Gudang"}),
        )
        .expect("barang")["id_barang"]
            .as_str()
            .expect("id")
            .to_owned();
        let connection = storage::database(&state.data_dir).expect("db");
        let hari = wib_today(&connection);
        let id = save_request(
            &state,
            "sarpras",
            json!({"tanggal": hari, "keperluan": "ATK", "baris": [
                {"id_barang": id_barang, "jumlah": 10, "harga_satuan": 8500},
                {"nama_barang": "Kertas HVS", "satuan": "rim", "jumlah": 5, "harga_satuan": 55000},
                {"nama_barang": "Proyektor", "satuan": "unit", "jumlah": 2, "harga_satuan": 4000000}]}),
        )
        .expect("ajukan")["id_pengajuan"]
            .as_str()
            .expect("id")
            .to_owned();
        let foto = json!([{"mime_type": "image/jpeg", "data_base64": "QUJD"}, {"mime_type": "image/jpeg", "data_base64": "QUJD"}]);
        assert!(receive_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "baris": [{"id_baris": format!("{id}-1"), "jumlah": 1}], "foto": foto}),
        )
        .unwrap_err()
        .message
        .contains("Disetujui atau Diterima sebagian"));

        let sidik = list_requests(&state, &hari, &hari).expect("daftar")["pengajuan"][0]
            ["sidik_baris"]
            .as_str()
            .expect("sidik")
            .to_owned();
        decide_request(
            &state,
            "bendahara",
            false,
            json!({"id_pengajuan": id, "keputusan": "ACC", "sidik_baris": sidik}),
        )
        .expect("acc");

        let terima = receive_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "baris": [
                {"id_baris": format!("{id}-1"), "jumlah": 10, "harga_satuan": 9000, "tempat": "Gudang"},
                {"id_baris": format!("{id}-3"), "jumlah": 2, "harga_satuan": 4000000, "tempat": "Lab",
                 "tipe": "Aset", "kategori": "Elektronik", "per_unit": true}], "foto": foto}),
        )
        .expect("terima pertama");
        assert_eq!(terima["label"][1]["id_barang"], format!("brg-{id}-3"));
        assert_eq!(
            terima["label"][1]["mutasi"].as_array().map(Vec::len),
            Some(2)
        );

        let daftar = list_requests(&state, &hari, &hari).expect("daftar");
        let p = &daftar["pengajuan"][0];
        assert_eq!(p["status"], "Diterima sebagian");
        assert_eq!(p["baris"][0]["diterima"], 10);
        assert_eq!(p["baris"][0]["harga_diterima"][0]["harga_satuan"], 9000);
        assert_eq!(p["baris"][2]["barang_terdaftar"], format!("brg-{id}-3"));
        assert_eq!(p["penerimaan"][0]["jumlah_foto"], 2);

        assert!(receive_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "baris": [{"id_baris": format!("{id}-2"), "jumlah": 6, "harga_satuan": 55000, "tempat": "Gudang", "tipe": "Habis Pakai"}], "foto": foto}),
        )
        .unwrap_err()
        .message
        .contains("melebihi sisa"));
        receive_request(
            &state,
            "sarpras",
            json!({"id_pengajuan": id, "tanggal": hari, "baris": [{"id_baris": format!("{id}-2"), "jumlah": 5, "harga_satuan": 55000, "tempat": "Gudang", "tipe": "Habis Pakai"}], "foto": foto}),
        )
        .expect("terima kedua");
        let daftar = list_requests(&state, &hari, &hari).expect("daftar");
        assert_eq!(daftar["pengajuan"][0]["status"], "Selesai");

        let barang_baru: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM inventory_barang WHERE id_barang LIKE 'brg-pgj-%';",
                [],
                |row| row.get(0),
            )
            .expect("hitung");
        assert_eq!(barang_baru, 2);
        let foto_lokal = receipt_photo_local(
            &state,
            &format!("{}-2", terima["id_penerimaan"].as_str().unwrap()),
        )
        .expect("foto");
        assert_eq!(foto_lokal.expect("ada")["data_base64"], "QUJD");

        let urutan: Vec<String> = connection
            .prepare(
                "SELECT domain FROM desktop_sync_outbox
                 WHERE domain IN ('inventory-item', 'inventory-mutation', 'inventory-receipt', 'inventory-receipt-photo')
                 ORDER BY rowid;",
            )
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("baris");
        // Barang awal, lalu penerimaan pertama: mutasi spidol, barang proyektor,
        // dua unit, header, dua foto.
        let pertama: Vec<&str> = urutan.iter().skip(1).take(7).map(String::as_str).collect();
        assert_eq!(
            pertama,
            vec![
                "inventory-mutation",
                "inventory-item",
                "inventory-mutation",
                "inventory-mutation",
                "inventory-receipt",
                "inventory-receipt-photo",
                "inventory-receipt-photo"
            ]
        );
        let header: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox WHERE domain = 'inventory-receipt' ORDER BY rowid LIMIT 1;",
                [],
                |row| row.get(0),
            )
            .expect("header");
        let header: Value = serde_json::from_str(&header).expect("json");
        assert!(cloud_receipt_values(&header, "").is_some());
        let foto_event: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox WHERE domain = 'inventory-receipt-photo' ORDER BY rowid LIMIT 1;",
                [],
                |row| row.get(0),
            )
            .expect("foto");
        let foto_event: Value = serde_json::from_str(&foto_event).expect("json");
        assert!(cloud_photo_values(&foto_event, "").is_some());
    }
}
