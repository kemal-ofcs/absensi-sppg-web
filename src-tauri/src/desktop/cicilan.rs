//! Pembelian barang secara cicilan (v31, port dari Manajemen Sekolah v65).
//!
//! Kontrak selalu lahir dari pengajuan pembelian bercara bayar `Cicilan`
//! (id `cil-<id_pengajuan>`). Syaratnya diisi saat pengajuan, di-ACC bersama
//! barisnya lewat `sidik_syarat`, lalu dibekukan saat barang diterima penuh.
//! Status, sisa, dan angsuran ke berapa TIDAK disimpan: semuanya diturunkan
//! dari jadwal dan pembayaran yang tidak dibatalkan, pola kasbon.
//!
//! Bunga tidak pernah dihitung dari persen: bunga = total bayar − harga tunai,
//! dibagi proporsional terhadap angsuran dengan pembulatan kumulatif (§4.2).
//!
//! Aturan murni dieja kembar dengan `validations/cicilan.ts` dan
//! `services/cicilan.ts`, diuji dengan vektor yang sama.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    accounting::{self, format_rupiah, MAKS_NOMINAL},
    config::DesktopState,
    inventory::{
        clean, invalid, is_valid_date, new_hex_id, payload_text, wib_today, NILAI_MUTASI_SQL,
    },
    inventory_pengajuan::{validate_alasan, validate_pemutus, DITERIMA_BARIS_SQL},
    models::CommandError,
    storage, sync, time_policy,
};

pub const MAKS_KREDITUR: usize = 100;
pub const MAKS_NOMOR_KONTRAK: usize = 50;
pub const MAKS_TENOR: i64 = 360;
pub const MAKS_SETIAP: i64 = 365;
/// Alasan potongan dan keterangan denda.
pub const MAKS_ALASAN_BAYAR: usize = 150;
pub const MAKS_REFERENSI: usize = 50;
/// Cermin `MAKS_DAFTAR_CICILAN`.
pub const MAKS_DAFTAR_CICILAN: usize = 500;
pub const POLA_JADWAL: [&str; 2] = ["Berkala", "Manual"];
/// WAJIB sama dengan CHECK `keu_cicilan.satuan`.
pub const SATUAN_JADWAL: [&str; 4] = ["Hari", "Minggu", "Bulan", "Tahun"];
/// WAJIB sama dengan CHECK `keu_cicilan_bayar.jenis`.
pub const JENIS_BAYAR: [&str; 2] = ["Bayar", "Denda"];
pub const AKUN_UTANG_CICILAN: &str = "akun-utang-cicilan";
pub const AKUN_BEBAN_BUNGA: &str = "akun-beban-bunga";
pub const AKUN_BEBAN_DENDA: &str = "akun-beban-denda";
/// Potongan yang melebihi bunga selalu masuk akun ini (PRD §4.4).
pub const AKUN_PENDAPATAN_LAIN: &str = "akun-pendapatan-lain";

// Aturan murni

/// Cermin `idCicilan`. Satu kontrak per pengajuan.
pub fn id_cicilan(id_pengajuan: &str) -> String {
    format!("cil-{id_pengajuan}")
}

/// Cermin `idPengajuanDariCicilan`. Dipakai penjaga tarikan snapshot.
pub fn id_pengajuan_dari_cicilan(id_cicilan: &str) -> Option<&str> {
    id_cicilan.strip_prefix("cil-").filter(|id| !id.is_empty())
}

/// Cermin `idJadwal`. Deterministik supaya menyimpan ulang syarat menimpa
/// barisnya di cloud alih-alih menumpuk.
pub fn id_jadwal(id_cicilan: &str, ke: i64) -> String {
    format!("{id_cicilan}-{ke}")
}

/// Cermin `idCicilanDariJadwal`.
pub fn id_cicilan_dari_jadwal(id_jadwal: &str) -> Option<&str> {
    let (induk, ke) = id_jadwal.rsplit_once('-')?;
    (induk.starts_with("cil-") && !ke.is_empty() && ke.bytes().all(|b| b.is_ascii_digit()))
        .then_some(induk)
}

/// Cermin `idJurnalCicilan`.
pub fn id_jurnal_cicilan(id_bayar: &str) -> String {
    format!("jrn-{id_bayar}")
}

fn panjang(text: &str) -> usize {
    text.chars().count()
}

fn hari_dalam_bulan(tahun: i64, bulan: i64) -> i64 {
    let kabisat = (tahun % 4 == 0 && tahun % 100 != 0) || tahun % 400 == 0;
    match bulan {
        2 if kabisat => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Selalu dihitung dari tanggal pertama, tidak berantai: 31 Jan → 28/29 Feb →
/// 31 Mar. 29 Feb + 12 bulan → 28 Feb.
fn tambah_bulan(tanggal: &str, bulan: i64) -> String {
    let tahun: i64 = tanggal[0..4].parse().unwrap_or(0);
    let bln: i64 = tanggal[5..7].parse().unwrap_or(1);
    let hari: i64 = tanggal[8..10].parse().unwrap_or(1);
    let total = tahun * 12 + (bln - 1) + bulan;
    let (tahun_baru, bulan_baru) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    let hari_baru = hari.min(hari_dalam_bulan(tahun_baru, bulan_baru));
    format!("{tahun_baru:04}-{bulan_baru:02}-{hari_baru:02}")
}

/// Cermin `susunJadwal` (PRD §3.2): baris angsuran ke-1..tenor.
pub fn susun_jadwal(
    pertama: &str,
    setiap: i64,
    satuan: &str,
    tenor: i64,
    nominal: i64,
) -> Result<Vec<(String, i64)>, String> {
    if !is_valid_date(pertama) {
        return Err("Jatuh tempo pertama tidak valid.".into());
    }
    if !(1..=MAKS_SETIAP).contains(&setiap) {
        return Err(format!("Jarak angsuran harus 1–{MAKS_SETIAP}."));
    }
    if !SATUAN_JADWAL.contains(&satuan) {
        return Err("Satuan jarak angsuran tidak dikenal.".into());
    }
    if !(1..=MAKS_TENOR).contains(&tenor) {
        return Err(format!("Tenor harus 1–{MAKS_TENOR} kali."));
    }
    if nominal <= 0 {
        return Err("Nominal per angsuran harus lebih dari 0.".into());
    }
    if nominal > MAKS_NOMINAL {
        return Err("Nominal per angsuran terlalu besar.".into());
    }
    let mut baris = Vec::with_capacity(tenor as usize);
    for indeks in 0..tenor {
        let langkah = indeks * setiap;
        let tanggal = match satuan {
            "Hari" => time_policy::add_days(pertama, langkah)?,
            "Minggu" => time_policy::add_days(pertama, langkah * 7)?,
            "Bulan" => tambah_bulan(pertama, langkah),
            _ => tambah_bulan(pertama, langkah * 12),
        };
        if !is_valid_date(&tanggal) {
            return Err("Jadwal terlalu panjang.".into());
        }
        baris.push((tanggal, nominal));
    }
    Ok(baris)
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JadwalDraft {
    #[serde(default)]
    pub jatuh_tempo: String,
    #[serde(default)]
    pub nominal: i64,
}

/// Cermin `syaratDraftSchema`. Isian Berkala dipakai bila `pola` Berkala,
/// `jadwal` bila Manual; yang lain diabaikan.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyaratDraft {
    #[serde(default)]
    pub kreditur: String,
    #[serde(default)]
    pub nomor_kontrak: Option<String>,
    #[serde(default)]
    pub uang_muka: i64,
    #[serde(default)]
    pub pola: String,
    #[serde(default)]
    pub jatuh_tempo_pertama: Option<String>,
    #[serde(default)]
    pub setiap: Option<i64>,
    #[serde(default)]
    pub satuan: Option<String>,
    #[serde(default)]
    pub tenor: Option<i64>,
    #[serde(default)]
    pub nominal: Option<i64>,
    #[serde(default)]
    pub jadwal: Vec<JadwalDraft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisJadwal {
    pub ke: i64,
    pub jatuh_tempo: String,
    pub nominal: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Syarat {
    pub kreditur: String,
    pub nomor_kontrak: Option<String>,
    pub uang_muka: i64,
    pub pola: String,
    pub setiap: Option<i64>,
    pub satuan: Option<String>,
    /// Urut `ke`; ke-0 = DP.
    pub jadwal: Vec<BarisJadwal>,
}

/// Cermin `validasiSyarat` (PRD §3.2, keputusan K). `tanggal_awal` = tanggal
/// pengajuan; `tanggal_dp` = jatuh tempo baris DP (tanggal pengajuan selama
/// Draf, tanggal terima saat aktivasi).
pub fn validate_syarat(
    draft: &SyaratDraft,
    harga_tunai: i64,
    tanggal_awal: &str,
    tanggal_dp: &str,
) -> Result<Syarat, String> {
    let kreditur = draft.kreditur.trim().to_owned();
    if kreditur.is_empty() {
        return Err("Kreditur wajib diisi.".into());
    }
    if panjang(&kreditur) > MAKS_KREDITUR {
        return Err(format!("Kreditur maksimal {MAKS_KREDITUR} karakter."));
    }
    let nomor_kontrak = clean(&draft.nomor_kontrak);
    if nomor_kontrak
        .as_deref()
        .is_some_and(|n| panjang(n) > MAKS_NOMOR_KONTRAK)
    {
        return Err(format!(
            "Nomor kontrak maksimal {MAKS_NOMOR_KONTRAK} karakter."
        ));
    }
    if harga_tunai <= 0 {
        return Err("Harga tunai harus lebih dari 0 untuk pembelian cicilan.".into());
    }
    if draft.uang_muka < 0 || draft.uang_muka >= harga_tunai {
        return Err("Uang muka harus 0 atau lebih dan lebih kecil dari harga tunai.".into());
    }
    let (pola, setiap, satuan, angsuran) = match draft.pola.trim() {
        "Berkala" => {
            let satuan = clean(&draft.satuan).unwrap_or_default();
            let setiap = draft.setiap.unwrap_or(0);
            let baris = susun_jadwal(
                draft
                    .jatuh_tempo_pertama
                    .as_deref()
                    .unwrap_or_default()
                    .trim(),
                setiap,
                &satuan,
                draft.tenor.unwrap_or(0),
                draft.nominal.unwrap_or(0),
            )?;
            ("Berkala", Some(setiap), Some(satuan), baris)
        }
        "Manual" => {
            if draft.jadwal.is_empty() {
                return Err("Isi minimal satu angsuran.".into());
            }
            if draft.jadwal.len() as i64 > MAKS_TENOR {
                return Err(format!("Tenor harus 1–{MAKS_TENOR} kali."));
            }
            let mut baris = Vec::with_capacity(draft.jadwal.len());
            for (indeks, isian) in draft.jadwal.iter().enumerate() {
                let nomor = indeks + 1;
                let tanggal = isian.jatuh_tempo.trim().to_owned();
                if !is_valid_date(&tanggal) {
                    return Err(format!(
                        "Angsuran {nomor}: tanggal jatuh tempo tidak valid."
                    ));
                }
                if isian.nominal <= 0 {
                    return Err(format!("Angsuran {nomor}: nominal harus lebih dari 0."));
                }
                if isian.nominal > MAKS_NOMINAL {
                    return Err(format!("Angsuran {nomor}: nominal terlalu besar."));
                }
                baris.push((tanggal, isian.nominal));
            }
            ("Manual", None, None, baris)
        }
        _ => return Err("Pola jadwal tidak dikenal.".into()),
    };
    for indeks in 1..angsuran.len() {
        if angsuran[indeks].0 <= angsuran[indeks - 1].0 {
            return Err(format!(
                "Angsuran {}: jatuh tempo harus setelah angsuran sebelumnya.",
                indeks + 1
            ));
        }
    }
    if angsuran[0].0.as_str() < tanggal_awal {
        return Err("Jatuh tempo angsuran pertama tidak boleh sebelum tanggal pengajuan.".into());
    }
    let total_angsuran: i128 = angsuran.iter().map(|(_, n)| i128::from(*n)).sum();
    if i128::from(draft.uang_muka) + total_angsuran > i128::from(MAKS_NOMINAL) {
        return Err("Total bayar terlalu besar.".into());
    }
    if total_angsuran < i128::from(harga_tunai - draft.uang_muka) {
        return Err(
            "Total angsuran kurang dari harga tunai dikurangi uang muka (bunga tidak boleh negatif)."
                .into(),
        );
    }
    let mut jadwal = Vec::with_capacity(angsuran.len() + 1);
    jadwal.push(BarisJadwal {
        ke: 0,
        jatuh_tempo: tanggal_dp.to_owned(),
        nominal: draft.uang_muka,
    });
    for (indeks, (jatuh_tempo, nominal)) in angsuran.into_iter().enumerate() {
        jadwal.push(BarisJadwal {
            ke: indeks as i64 + 1,
            jatuh_tempo,
            nominal,
        });
    }
    Ok(Syarat {
        kreditur,
        nomor_kontrak,
        uang_muka: draft.uang_muka,
        pola: pola.to_owned(),
        setiap,
        satuan,
        jadwal,
    })
}

/// Cermin `sidikSyarat` (PRD §6.2): SHA-256 bentuk kanonik syarat, pemisah
/// sama dengan `sidik_baris`.
pub fn sidik_syarat(syarat: &Syarat) -> String {
    let mut jadwal: Vec<&BarisJadwal> = syarat.jadwal.iter().collect();
    jadwal.sort_by_key(|b| b.ke);
    let kepala = [
        syarat.kreditur.clone(),
        syarat.nomor_kontrak.clone().unwrap_or_default(),
        syarat.uang_muka.to_string(),
        syarat.pola.clone(),
        syarat.setiap.map(|n| n.to_string()).unwrap_or_default(),
        syarat.satuan.clone().unwrap_or_default(),
    ]
    .join("\u{1f}");
    let kanonik = std::iter::once(kepala)
        .chain(jadwal.iter().map(|b| {
            [
                b.ke.to_string(),
                b.jatuh_tempo.clone(),
                b.nominal.to_string(),
            ]
            .join("\u{1f}")
        }))
        .collect::<Vec<_>>()
        .join("\u{1e}");
    hex::encode(Sha256::digest(kanonik.as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Besaran {
    pub harga_tunai: i64,
    pub uang_muka: i64,
    pub total_angsuran: i64,
    pub total_bayar: i64,
    pub bunga: i64,
}

/// Cermin `besaranCicilan` (PRD §4.1).
pub fn besaran(harga_tunai: i64, jadwal: &[BarisJadwal]) -> Besaran {
    let uang_muka: i64 = jadwal.iter().filter(|b| b.ke == 0).map(|b| b.nominal).sum();
    let total_angsuran: i64 = jadwal.iter().filter(|b| b.ke > 0).map(|b| b.nominal).sum();
    let total_bayar = uang_muka.saturating_add(total_angsuran);
    Besaran {
        harga_tunai,
        uang_muka,
        total_angsuran,
        total_bayar,
        bunga: (total_bayar - harga_tunai).max(0),
    }
}

/// Bunga yang sudah diakui saat jadwal tertutup sebesar `c`, dibulatkan
/// setengah ke atas. Saat jadwal tertutup penuh hasilnya tepat `bunga`.
/// Cermin `bungaKumulatif`.
pub fn bunga_kumulatif(b: &Besaran, tertutup: i64) -> i64 {
    if b.total_angsuran <= 0 {
        return 0;
    }
    let angsuran = i128::from((tertutup - b.uang_muka).clamp(0, b.total_angsuran));
    let tj = i128::from(b.total_angsuran);
    ((2 * angsuran * i128::from(b.bunga) + tj) / (2 * tj)) as i64
}

/// Cermin `bagiPokokBunga` (PRD §4.2): `(pokok, bunga)` untuk satu
/// pembayaran yang menggeser tertutup dari `c0` ke `c1`.
pub fn bagi_pokok_bunga(b: &Besaran, c0: i64, c1: i64) -> (i64, i64) {
    let bunga = bunga_kumulatif(b, c1) - bunga_kumulatif(b, c0);
    ((c1 - c0) - bunga, bunga)
}

pub struct AkunJurnalCicilan<'a> {
    pub utang: &'a str,
    pub bunga: &'a str,
    pub denda: &'a str,
    pub bayar: &'a str,
}

/// Cermin `susunJurnalCicilan` (PRD §4.3): `(id_akun, debit, kredit)`,
/// baris bernilai 0 dibuang. Seimbang karena konstruksinya.
pub fn susun_jurnal_cicilan(
    jenis: &str,
    nominal: i64,
    potongan: i64,
    c0: i64,
    b: &Besaran,
    akun: &AkunJurnalCicilan<'_>,
) -> Vec<(String, i64, i64)> {
    let baris = if jenis == "Denda" {
        vec![(akun.denda, nominal, 0), (akun.bayar, 0, nominal)]
    } else {
        let (pokok, bunga) = bagi_pokok_bunga(b, c0, c0 + nominal + potongan);
        vec![
            (akun.utang, pokok, 0),
            (akun.bunga, (bunga - potongan).max(0), 0),
            (akun.bayar, 0, nominal),
            (AKUN_PENDAPATAN_LAIN, 0, (potongan - bunga).max(0)),
        ]
    };
    baris
        .into_iter()
        .filter(|(_, debit, kredit)| *debit != 0 || *kredit != 0)
        .map(|(id, debit, kredit)| (id.to_owned(), debit, kredit))
        .collect()
}

/// Cermin `keteranganJurnalCicilan`, dipotong ke batas keterangan jurnal.
pub fn keterangan_jurnal_cicilan(
    jenis: &str,
    kreditur: &str,
    nomor_pengajuan: &str,
    keterangan: Option<&str>,
) -> String {
    let teks = if jenis == "Denda" {
        format!(
            "Denda cicilan {kreditur}: {}",
            keterangan.unwrap_or_default()
        )
    } else {
        format!("Bayar cicilan {kreditur} ({nomor_pengajuan})")
    };
    teks.chars().take(accounting::MAKS_KETERANGAN).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisAlokasi {
    pub terbayar: i64,
    pub status: &'static str,
}

/// Cermin `alokasiJadwal`: tertutup mengisi baris dari `ke` terkecil.
pub fn alokasi_jadwal(jadwal: &[BarisJadwal], tertutup: i64, hari_ini: &str) -> Vec<BarisAlokasi> {
    let mut sisa = tertutup.max(0);
    jadwal
        .iter()
        .map(|baris| {
            let terbayar = sisa.min(baris.nominal);
            sisa -= terbayar;
            let status = if terbayar >= baris.nominal {
                "Lunas"
            } else if baris.jatuh_tempo.as_str() < hari_ini {
                "Terlambat"
            } else if terbayar > 0 {
                "Sebagian"
            } else {
                "Belum"
            };
            BarisAlokasi { terbayar, status }
        })
        .collect()
}

/// Cermin `perluAccUlang` (PRD §3.4).
pub fn perlu_acc_ulang(
    total_bayar: i64,
    total_disetujui: Option<i64>,
    sidik: &str,
    sidik_disetujui_ulang: Option<&str>,
) -> bool {
    total_disetujui.is_some_and(|t| total_bayar > t) && sidik_disetujui_ulang != Some(sidik)
}

pub struct KeadaanCicilan {
    /// Pengajuan Dibatalkan atau Ditolak.
    pub pengajuan_batal: bool,
    pub pengajuan_menunggu: bool,
    pub pengajuan_ditutup: bool,
    pub diterima_penuh: bool,
    pub diaktifkan: bool,
    pub ditutup: bool,
    pub perlu_acc_ulang: bool,
    pub tertutup: i64,
    pub total_bayar: i64,
    pub ada_terlambat: bool,
}

/// Cermin `statusCicilan` (PRD §3.8), diperiksa berurutan. Kontrak aktif =
/// diterima penuh dan syarat finalnya sudah dibekukan; mutasi penerimaan yang
/// dibatalkan sebelum ada pembayaran mengembalikannya ke Menunggu barang.
pub fn status_cicilan(k: &KeadaanCicilan) -> &'static str {
    let aktif = k.diterima_penuh && k.diaktifkan;
    if k.pengajuan_batal || (!aktif && k.pengajuan_ditutup) {
        return "Dibatalkan";
    }
    if k.ditutup {
        return "Ditutup";
    }
    if k.pengajuan_menunggu {
        return "Draf";
    }
    if !aktif {
        return "Menunggu barang";
    }
    if k.perlu_acc_ulang {
        return "Menunggu ACC ulang";
    }
    if k.tertutup >= k.total_bayar {
        return "Lunas";
    }
    if k.ada_terlambat {
        return "Menunggak";
    }
    "Berjalan"
}

/// Cermin `wajibTerimaPenuh` (keputusan C): setiap baris diterima sejumlah
/// sisa ACC-nya. `acc` = (id_baris, urutan, sisa); `kiriman` = (id_baris, jumlah).
pub fn wajib_terima_penuh(acc: &[(&str, i64, i64)], kiriman: &[(&str, i64)]) -> Result<(), String> {
    for (id_baris, urutan, sisa) in acc {
        let jumlah: i64 = kiriman
            .iter()
            .filter(|(id, _)| id.trim() == *id_baris)
            .map(|(_, n)| *n)
            .sum();
        if jumlah != *sisa {
            return Err(format!(
                "Baris {urutan}: pengajuan cicilan wajib diterima penuh sesuai ACC dalam satu penerimaan."
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BayarDraft {
    #[serde(default)]
    pub id_cicilan: String,
    #[serde(default)]
    pub jenis: String,
    #[serde(default)]
    pub tanggal: String,
    #[serde(default)]
    pub nominal: i64,
    #[serde(default)]
    pub potongan: i64,
    #[serde(default)]
    pub alasan_potongan: Option<String>,
    #[serde(default)]
    pub keterangan: Option<String>,
    #[serde(default)]
    pub referensi: Option<String>,
    #[serde(default)]
    pub id_akun_bayar: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct BayarValid {
    pub jenis: &'static str,
    pub tanggal: String,
    pub nominal: i64,
    pub potongan: i64,
    pub alasan_potongan: Option<String>,
    pub keterangan: Option<String>,
    pub referensi: Option<String>,
}

/// Cermin `validasiBayar` (PRD §3.6). `sisa` = total jadwal − tertutup, hanya
/// diperiksa di perangkat; cloud tidak pernah menolak pembayaran.
pub fn validate_bayar(
    draft: &BayarDraft,
    tanggal_awal: &str,
    hari_ini: &str,
    sisa: i64,
) -> Result<BayarValid, String> {
    let tanggal = draft.tanggal.trim().to_owned();
    if !is_valid_date(&tanggal) {
        return Err("Tanggal bayar tidak valid.".into());
    }
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal bayar tidak boleh setelah hari ini.".into());
    }
    if tanggal.as_str() < tanggal_awal {
        return Err("Tanggal bayar tidak boleh sebelum tanggal pengajuan.".into());
    }
    let referensi = clean(&draft.referensi);
    if referensi
        .as_deref()
        .is_some_and(|r| panjang(r) > MAKS_REFERENSI)
    {
        return Err(format!("Referensi maksimal {MAKS_REFERENSI} karakter."));
    }
    match draft.jenis.trim() {
        "Bayar" => {
            if !(0..=MAKS_NOMINAL).contains(&draft.nominal) {
                return Err("Nominal dibayar tidak valid.".into());
            }
            if !(0..=MAKS_NOMINAL).contains(&draft.potongan) {
                return Err("Potongan tidak valid.".into());
            }
            let alasan_potongan = if draft.potongan > 0 {
                let alasan = clean(&draft.alasan_potongan)
                    .ok_or_else(|| "Alasan potongan wajib diisi.".to_owned())?;
                if panjang(&alasan) > MAKS_ALASAN_BAYAR {
                    return Err(format!(
                        "Alasan potongan maksimal {MAKS_ALASAN_BAYAR} karakter."
                    ));
                }
                Some(alasan)
            } else {
                None
            };
            let total = draft.nominal + draft.potongan;
            if total == 0 {
                return Err("Isi nominal dibayar atau potongan.".into());
            }
            if total > sisa {
                return Err(format!(
                    "Nominal ditambah potongan melebihi sisa jadwal ({}).",
                    format_rupiah(sisa.max(0))
                ));
            }
            Ok(BayarValid {
                jenis: "Bayar",
                tanggal,
                nominal: draft.nominal,
                potongan: draft.potongan,
                alasan_potongan,
                keterangan: None,
                referensi,
            })
        }
        "Denda" => {
            if draft.nominal <= 0 {
                return Err("Nominal denda harus lebih dari 0.".into());
            }
            if draft.nominal > MAKS_NOMINAL {
                return Err("Nominal denda terlalu besar.".into());
            }
            if draft.potongan != 0 {
                return Err("Denda tidak memakai potongan.".into());
            }
            let keterangan = clean(&draft.keterangan)
                .ok_or_else(|| "Keterangan denda wajib diisi.".to_owned())?;
            if panjang(&keterangan) > MAKS_ALASAN_BAYAR {
                return Err(format!(
                    "Keterangan denda maksimal {MAKS_ALASAN_BAYAR} karakter."
                ));
            }
            Ok(BayarValid {
                jenis: "Denda",
                tanggal,
                nominal: draft.nominal,
                potongan: 0,
                alasan_potongan: None,
                keterangan: Some(keterangan),
                referensi,
            })
        }
        _ => Err("Jenis pembayaran tidak dikenal.".into()),
    }
}

/// Sidik kiriman layar: 64 hex huruf kecil, atau `None` bila kosong/cacat.
pub fn normal_sidik(sidik: Option<&str>) -> Option<String> {
    let sidik = sidik?.trim().to_ascii_lowercase();
    (sidik.len() == 64 && sidik.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sidik)
}

// SQL bersama

/// Jumlah nominal + potongan pembayaran jenis Bayar yang tidak dibatalkan
/// (alias `c` = keu_cicilan). Cermin `TERTUTUP_CICILAN_SQL`.
pub const TERTUTUP_CICILAN_SQL: &str = "COALESCE((SELECT SUM(y.nominal + y.potongan) FROM keu_cicilan_bayar y
        WHERE y.id_cicilan = c.id_cicilan AND y.jenis = 'Bayar'
          AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar)), 0)";

/// Mutasi Masuk Pengadaan (alias `m`, barang `b`) dari pengajuan `p` yang
/// belum dibatalkan.
fn mutasi_penerimaan_sql(syarat_tambahan: &str) -> String {
    format!(
        "SELECT 1 FROM inventory_mutasi m
         JOIN inventory_barang b ON b.id_barang = m.id_barang
         JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
         WHERE r.id_pengajuan = p.id_pengajuan AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
           AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
           {syarat_tambahan}"
    )
}

/// Harga tunai final = nilai barang yang sudah diterima (alias `p`).
/// Cermin `hargaDiterimaSql`.
pub fn harga_diterima_sql() -> String {
    format!(
        "COALESCE((SELECT SUM({NILAI_MUTASI_SQL}) FROM inventory_mutasi m
           JOIN inventory_barang b ON b.id_barang = m.id_barang
           JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
           WHERE r.id_pengajuan = p.id_pengajuan AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
             AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)), 0)"
    )
}

/// Semua mutasi penerimaan berharga dari pengajuan `p` sudah dijurnal (§3.5).
/// Cermin `penerimaanDijurnalSql`.
pub fn penerimaan_dijurnal_sql() -> String {
    format!(
        "NOT EXISTS ({})",
        mutasi_penerimaan_sql(&format!(
            "AND {NILAI_MUTASI_SQL} > 0
             AND NOT EXISTS (SELECT 1 FROM keu_jurnal j WHERE j.id_jurnal = 'jrn-inv-' || m.id_mutasi)"
        ))
    )
}

/// Kontrak dari mutasi yang mau dibatalkan, bila kontraknya sudah punya
/// pembayaran (§3.4). Parameter: id mutasi. Cermin `KONTRAK_BERBAYAR_MUTASI_SQL`.
pub const KONTRAK_BERBAYAR_MUTASI_SQL: &str = "SELECT COALESCE(c.nomor_kontrak, p.nomor)
    FROM inventory_mutasi m
    JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
    JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
    JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
    WHERE m.id_mutasi = ? AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
      AND EXISTS (SELECT 1 FROM keu_cicilan_bayar y
        WHERE y.id_cicilan = c.id_cicilan
          AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar))
    LIMIT 1;";

/// Akun utang kontrak untuk mutasi penerimaan bercicilan; dipakai
/// `journal_post` sebagai akun kredit yang dikunci (§3.5). Parameter: id mutasi.
/// Cermin `AKUN_UTANG_MUTASI_SQL`.
pub const AKUN_UTANG_MUTASI_SQL: &str = "SELECT c.id_akun_utang
    FROM inventory_mutasi m
    JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
    JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
    JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
    WHERE m.id_mutasi = ? AND m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
    LIMIT 1;";

/// Barang dari kontrak yang belum Lunas/Ditutup (tanda Belum lunas, §7.2).
/// Cermin `barangBelumLunasSql`.
pub fn barang_belum_lunas_sql() -> String {
    format!(
        "SELECT DISTINCT m.id_barang, COALESCE(c.nomor_kontrak, p.nomor) AS kontrak, c.kreditur
         FROM inventory_mutasi m
         JOIN inventory_pengajuan_baris r ON r.id_baris = m.id_ref
         JOIN inventory_pengajuan p ON p.id_pengajuan = r.id_pengajuan AND p.cara_bayar = 'Cicilan'
         JOIN keu_cicilan c ON c.id_pengajuan = p.id_pengajuan
         WHERE m.jenis = 'Masuk' AND m.alasan = 'Pengadaan'
           AND NOT EXISTS (SELECT 1 FROM inventory_mutasi x WHERE x.id_mutasi = 'batal-' || m.id_mutasi)
           AND c.ditutup_pada IS NULL AND p.dibatalkan_pada IS NULL AND p.ditolak_pada IS NULL
           AND {TERTUTUP_CICILAN_SQL} < (SELECT COALESCE(SUM(j.nominal), 0) FROM keu_cicilan_jadwal j WHERE j.id_cicilan = c.id_cicilan)
         ORDER BY m.id_barang
         LIMIT {MAKS_DAFTAR_CICILAN};"
    )
}

/// Kolom `keu_cicilan`, urutan payload dan snapshot.
pub const KOLOM_CICILAN: &[&str] = &[
    "id_cicilan",
    "id_pengajuan",
    "kreditur",
    "nomor_kontrak",
    "uang_muka",
    "pola",
    "setiap",
    "satuan",
    "id_akun_utang",
    "id_akun_bunga",
    "id_akun_denda",
    "sidik_syarat",
    "total_disetujui",
    "diaktifkan_pada",
    "disetujui_ulang_pada",
    "disetujui_ulang_oleh",
    "sidik_disetujui_ulang",
    "ditutup_pada",
    "ditutup_oleh",
    "alasan_tutup",
    "created_at",
    "updated_at",
];

pub const KOLOM_BAYAR: &[&str] = &[
    "id_bayar",
    "id_cicilan",
    "jenis",
    "tanggal",
    "nominal",
    "potongan",
    "alasan_potongan",
    "keterangan",
    "referensi",
    "id_akun_bayar",
    "dicatat_oleh",
    "created_at",
];

// I/O lokal

fn nilai_json(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Integer(n) => json!(n),
        rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        _ => Value::Null,
    }
}

fn baris_objek(
    row: &rusqlite::Row<'_>,
    kolom: &[&str],
) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut objek = serde_json::Map::new();
    for (indeks, nama) in kolom.iter().enumerate() {
        objek.insert((*nama).to_owned(), nilai_json(row.get_ref(indeks)?));
    }
    Ok(objek)
}

fn jadwal_lokal(
    connection: &Connection,
    id_cicilan: &str,
) -> Result<Vec<BarisJadwal>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT ke, jatuh_tempo, nominal FROM keu_cicilan_jadwal WHERE id_cicilan = ? ORDER BY ke
             -- batas: satu kontrak, paling banyak 361 baris (DP + tenor 360)
             ;",
        )
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(params![id_cicilan], |row| {
            Ok(BarisJadwal {
                ke: row.get(0)?,
                jatuh_tempo: row.get(1)?,
                nominal: row.get(2)?,
            })
        })
        .map_err(|_| CommandError::internal())?;
    rows.collect::<Result<_, _>>()
        .map_err(|_| CommandError::internal())
}

fn jadwal_json(jadwal: &[BarisJadwal]) -> Vec<Value> {
    jadwal
        .iter()
        .map(|b| json!({ "ke": b.ke, "jatuh_tempo": b.jatuh_tempo, "nominal": b.nominal }))
        .collect()
}

/// Payload outbox kontrak: header utuh dan seluruh jadwalnya.
pub fn cicilan_payload(
    transaction: &Transaction<'_>,
    id_cicilan: &str,
) -> Result<Value, CommandError> {
    let header = transaction
        .query_row(
            &format!(
                "SELECT {} FROM keu_cicilan WHERE id_cicilan = ?;",
                KOLOM_CICILAN.join(", ")
            ),
            params![id_cicilan],
            |row| baris_objek(row, KOLOM_CICILAN),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    let Some(header) = header else {
        return Ok(Value::Null);
    };
    Ok(json!({ "cicilan": header, "jadwal": jadwal_json(&jadwal_lokal(transaction, id_cicilan)?) }))
}

fn tulis_jadwal(
    transaction: &Transaction<'_>,
    id_cicilan: &str,
    jadwal: &[BarisJadwal],
) -> Result<(), CommandError> {
    transaction
        .execute(
            "DELETE FROM keu_cicilan_jadwal WHERE id_cicilan = ?;",
            params![id_cicilan],
        )
        .map_err(|_| CommandError::internal())?;
    for baris in jadwal {
        transaction
            .execute(
                "INSERT INTO keu_cicilan_jadwal (id_jadwal, id_cicilan, ke, jatuh_tempo, nominal)
                 VALUES (?, ?, ?, ?, ?);",
                params![
                    id_jadwal(id_cicilan, baris.ke),
                    id_cicilan,
                    baris.ke,
                    baris.jatuh_tempo,
                    baris.nominal
                ],
            )
            .map_err(|_| CommandError::internal())?;
    }
    Ok(())
}

/// Menyimpan syarat Draf (dipanggil `save_request`). Akun bawaan hanya diisi
/// saat kontrak pertama kali dibuat; ACC yang memilih akun finalnya.
pub fn simpan_syarat_tx(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
    syarat: &Syarat,
) -> Result<(), CommandError> {
    let id = id_cicilan(id_pengajuan);
    transaction
        .execute(
            "INSERT INTO keu_cicilan (
                id_cicilan, id_pengajuan, kreditur, nomor_kontrak, uang_muka, pola, setiap, satuan,
                id_akun_utang, id_akun_bunga, id_akun_denda, sidik_syarat, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id_cicilan) DO UPDATE SET
                kreditur = excluded.kreditur,
                nomor_kontrak = excluded.nomor_kontrak,
                uang_muka = excluded.uang_muka,
                pola = excluded.pola,
                setiap = excluded.setiap,
                satuan = excluded.satuan,
                sidik_syarat = excluded.sidik_syarat,
                updated_at = datetime('now');",
            params![
                id,
                id_pengajuan,
                syarat.kreditur,
                syarat.nomor_kontrak,
                syarat.uang_muka,
                syarat.pola,
                syarat.setiap,
                syarat.satuan,
                AKUN_UTANG_CICILAN,
                AKUN_BEBAN_BUNGA,
                AKUN_BEBAN_DENDA,
                sidik_syarat(syarat)
            ],
        )
        .map_err(|_| CommandError::internal())?;
    tulis_jadwal(transaction, &id, &syarat.jadwal)
}

/// Syarat final saat penerimaan penuh (dipanggil `receive_request`). Mendaftarkan
/// event `installment/activate` di transaksi yang sama.
pub fn aktifkan_tx(
    transaction: &Transaction<'_>,
    client_id: &str,
    id_pengajuan: &str,
    syarat: &Syarat,
) -> Result<(), CommandError> {
    let id = id_cicilan(id_pengajuan);
    let berubah = transaction
        .execute(
            "UPDATE keu_cicilan SET kreditur = ?, nomor_kontrak = ?, uang_muka = ?, pola = ?,
                    setiap = ?, satuan = ?, sidik_syarat = ?,
                    diaktifkan_pada = datetime('now', '+7 hours'), updated_at = datetime('now')
             WHERE id_cicilan = ?;",
            params![
                syarat.kreditur,
                syarat.nomor_kontrak,
                syarat.uang_muka,
                syarat.pola,
                syarat.setiap,
                syarat.satuan,
                sidik_syarat(syarat),
                id
            ],
        )
        .map_err(|_| CommandError::internal())?;
    if berubah == 0 {
        return Err(invalid(
            "Kontrak cicilan pengajuan ini tidak ditemukan. Muat ulang daftarnya.",
        ));
    }
    tulis_jadwal(transaction, &id, &syarat.jadwal)?;
    let payload = cicilan_payload(transaction, &id)?;
    sync::enqueue(
        transaction,
        client_id,
        "installment",
        "activate",
        &id,
        &payload,
        None,
    )?;
    Ok(())
}

/// Menetapkan total yang di-ACC dan akun kontrak saat pengajuan di-ACC
/// (dipanggil `decide_request`). Akun kosong = akun bawaan.
pub fn setujui_tx(
    transaction: &Transaction<'_>,
    id_pengajuan: &str,
    sidik_dilihat: Option<&str>,
    akun: [Option<String>; 3],
) -> Result<(), CommandError> {
    let id = id_cicilan(id_pengajuan);
    let sidik: Option<String> = transaction
        .query_row(
            "SELECT sidik_syarat FROM keu_cicilan WHERE id_cicilan = ?;",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CommandError::internal())?;
    if sidik.is_none() || normal_sidik(sidik_dilihat) != sidik {
        return Err(invalid(
            "Syarat cicilan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
        ));
    }
    let [utang, bunga, denda] = akun;
    let utang = utang.unwrap_or_else(|| AKUN_UTANG_CICILAN.to_owned());
    let bunga = bunga.unwrap_or_else(|| AKUN_BEBAN_BUNGA.to_owned());
    let denda = denda.unwrap_or_else(|| AKUN_BEBAN_DENDA.to_owned());
    assert_akun(transaction, &utang, "Kewajiban", "Akun utang")?;
    assert_akun(transaction, &bunga, "Beban", "Akun beban bunga")?;
    assert_akun(transaction, &denda, "Beban", "Akun beban denda")?;
    transaction
        .execute(
            "UPDATE keu_cicilan SET
                total_disetujui = (SELECT COALESCE(SUM(j.nominal), 0) FROM keu_cicilan_jadwal j
                                   WHERE j.id_cicilan = keu_cicilan.id_cicilan),
                id_akun_utang = ?, id_akun_bunga = ?, id_akun_denda = ?, updated_at = datetime('now')
             WHERE id_cicilan = ?;",
            params![utang, bunga, denda, id],
        )
        .map_err(|_| CommandError::internal())?;
    Ok(())
}

fn assert_akun(
    connection: &Connection,
    id_akun: &str,
    kelompok: &str,
    label: &str,
) -> Result<(), CommandError> {
    let sah: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM keu_akun WHERE id_akun = ? AND kelompok = ? AND is_aktif = 1);",
            params![id_akun, kelompok],
            |row| row.get(0),
        )
        .map_err(|_| CommandError::internal())?;
    if !sah {
        return Err(invalid(format!(
            "{label} harus akun {kelompok} yang aktif."
        )));
    }
    Ok(())
}

/// Syarat per pengajuan untuk daftar pengajuan. `pilih` = CTE `pilih`
/// (`id_pengajuan`) milik `list_requests`, berparameter ?1/?2.
pub fn syarat_per_pengajuan(
    transaction: &Transaction<'_>,
    pilih: &str,
    dari: &str,
    sampai: &str,
) -> Result<HashMap<String, Value>, CommandError> {
    let mut hasil: HashMap<String, Value> = HashMap::new();
    {
        let mut statement = transaction
            .prepare(&format!(
                "{pilih}
                 SELECT c.id_pengajuan, c.kreditur, c.nomor_kontrak, c.uang_muka, c.pola, c.setiap,
                        c.satuan, c.sidik_syarat, c.id_akun_utang, c.id_akun_bunga, c.id_akun_denda,
                        c.total_disetujui, c.diaktifkan_pada
                 FROM keu_cicilan c
                 WHERE c.id_pengajuan IN (SELECT id_pengajuan FROM pilih);"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![dari, sampai], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    json!({
                        "kreditur": row.get::<_, String>(1)?,
                        "nomor_kontrak": row.get::<_, Option<String>>(2)?,
                        "uang_muka": row.get::<_, i64>(3)?,
                        "pola": row.get::<_, String>(4)?,
                        "setiap": row.get::<_, Option<i64>>(5)?,
                        "satuan": row.get::<_, Option<String>>(6)?,
                        "sidik_syarat": row.get::<_, String>(7)?,
                        "id_akun_utang": row.get::<_, String>(8)?,
                        "id_akun_bunga": row.get::<_, String>(9)?,
                        "id_akun_denda": row.get::<_, String>(10)?,
                        "total_disetujui": row.get::<_, Option<i64>>(11)?,
                        "diaktifkan_pada": row.get::<_, Option<String>>(12)?,
                        "jadwal": [],
                    }),
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (id, syarat) = row.map_err(|_| CommandError::internal())?;
            hasil.insert(id, syarat);
        }
    }
    let mut statement = transaction
        .prepare(&format!(
            "{pilih}
             SELECT c.id_pengajuan, j.ke, j.jatuh_tempo, j.nominal
             FROM keu_cicilan_jadwal j
             JOIN keu_cicilan c ON c.id_cicilan = j.id_cicilan
             WHERE c.id_pengajuan IN (SELECT id_pengajuan FROM pilih)
             ORDER BY c.id_pengajuan, j.ke;"
        ))
        .map_err(|_| CommandError::internal())?;
    let rows = statement
        .query_map(params![dari, sampai], |row| {
            Ok((
                row.get::<_, String>(0)?,
                json!({
                    "ke": row.get::<_, i64>(1)?,
                    "jatuh_tempo": row.get::<_, String>(2)?,
                    "nominal": row.get::<_, i64>(3)?,
                }),
            ))
        })
        .map_err(|_| CommandError::internal())?;
    for row in rows {
        let (id, baris) = row.map_err(|_| CommandError::internal())?;
        if let Some(Value::Array(jadwal)) = hasil.get_mut(&id).and_then(|s| s.get_mut("jadwal")) {
            jadwal.push(baris);
        }
    }
    Ok(hasil)
}

/// Satu kontrak beserta semua turunannya.
pub struct Kontrak {
    pub json: serde_json::Map<String, Value>,
    pub id_cicilan: String,
    pub tanggal_pengajuan: String,
    pub nomor_pengajuan: String,
    pub diajukan_oleh: String,
    pub kreditur: String,
    pub sidik_syarat: String,
    pub id_akun_utang: String,
    pub id_akun_bunga: String,
    pub id_akun_denda: String,
    pub besaran: Besaran,
    pub tertutup: i64,
    pub status: &'static str,
    pub dijurnal: bool,
}

const KOLOM_DAFTAR: &[&str] = &[
    "id_cicilan",
    "id_pengajuan",
    "kreditur",
    "nomor_kontrak",
    "uang_muka",
    "pola",
    "setiap",
    "satuan",
    "id_akun_utang",
    "id_akun_bunga",
    "id_akun_denda",
    "sidik_syarat",
    "total_disetujui",
    "diaktifkan_pada",
    "disetujui_ulang_pada",
    "disetujui_ulang_oleh",
    "sidik_disetujui_ulang",
    "ditutup_pada",
    "ditutup_oleh",
    "alasan_tutup",
];

/// Kontrak berstatus turunan: semua (daftar), atau satu (`id`). Cermin
/// `muatKontrak`.
pub fn muat_kontrak(
    connection: &Connection,
    id: Option<&str>,
    hari_ini: &str,
) -> Result<(Vec<Kontrak>, bool), CommandError> {
    let pilih = format!(
        "WITH pilih AS (
            SELECT c.id_cicilan FROM keu_cicilan c
            JOIN inventory_pengajuan p ON p.id_pengajuan = c.id_pengajuan
            WHERE p.cara_bayar = 'Cicilan' AND (?1 IS NULL OR c.id_cicilan = ?1)
            ORDER BY p.tanggal DESC, c.id_cicilan DESC
            LIMIT {}
         )",
        MAKS_DAFTAR_CICILAN + 1
    );
    let kolom_c = KOLOM_DAFTAR
        .iter()
        .map(|k| format!("c.{k}"))
        .collect::<Vec<_>>()
        .join(", ");
    struct Kepala {
        json: serde_json::Map<String, Value>,
        tanggal: String,
        nomor: String,
        diajukan_oleh: String,
        batal: bool,
        menunggu: bool,
        pengajuan_ditutup: bool,
        diterima_penuh: bool,
        total_pengajuan: i64,
        harga_diterima: i64,
        tertutup: i64,
        dijurnal: bool,
    }
    let mut kepala: Vec<Kepala> = {
        let mut statement = connection
            .prepare(&format!(
                "{pilih}
                 SELECT {kolom_c}, p.tanggal, p.nomor, p.keperluan, p.diajukan_oleh,
                        p.dibatalkan_pada IS NOT NULL OR p.ditolak_pada IS NOT NULL,
                        p.disetujui_pada IS NULL, p.ditutup_pada IS NOT NULL,
                        NOT EXISTS (SELECT 1 FROM inventory_pengajuan_baris r
                                    WHERE r.id_pengajuan = p.id_pengajuan AND {DITERIMA_BARIS_SQL} < r.jumlah),
                        COALESCE((SELECT SUM(CASE WHEN r.desimal = 1 THEN (r.jumlah * r.harga_satuan + 50) / 100
                                                  ELSE r.jumlah * r.harga_satuan END)
                                  FROM inventory_pengajuan_baris r WHERE r.id_pengajuan = p.id_pengajuan), 0),
                        {harga}, {TERTUTUP_CICILAN_SQL}, {dijurnal},
                        (SELECT group_concat(r.nama_barang, ', ') FROM inventory_pengajuan_baris r
                         WHERE r.id_pengajuan = p.id_pengajuan)
                 FROM keu_cicilan c
                 JOIN inventory_pengajuan p ON p.id_pengajuan = c.id_pengajuan
                 WHERE c.id_cicilan IN (SELECT id_cicilan FROM pilih)
                 ORDER BY p.tanggal DESC, c.id_cicilan DESC;",
                harga = harga_diterima_sql(),
                dijurnal = penerimaan_dijurnal_sql(),
            ))
            .map_err(|_| CommandError::internal())?;
        let n = KOLOM_DAFTAR.len();
        let rows = statement
            .query_map(params![id], |row| {
                let mut json = baris_objek(row, KOLOM_DAFTAR)?;
                json.insert("keperluan".into(), json!(row.get::<_, String>(n + 2)?));
                json.insert(
                    "barang".into(),
                    json!(row.get::<_, Option<String>>(n + 12)?.unwrap_or_default()),
                );
                Ok(Kepala {
                    json,
                    tanggal: row.get(n)?,
                    nomor: row.get(n + 1)?,
                    diajukan_oleh: row.get(n + 3)?,
                    batal: row.get(n + 4)?,
                    menunggu: row.get(n + 5)?,
                    pengajuan_ditutup: row.get(n + 6)?,
                    diterima_penuh: row.get(n + 7)?,
                    total_pengajuan: row.get(n + 8)?,
                    harga_diterima: row.get(n + 9)?,
                    tertutup: row.get(n + 10)?,
                    dijurnal: row.get(n + 11)?,
                })
            })
            .map_err(|_| CommandError::internal())?;
        rows.collect::<Result<_, _>>()
            .map_err(|_| CommandError::internal())?
    };
    let terpotong = kepala.len() > MAKS_DAFTAR_CICILAN;
    kepala.truncate(MAKS_DAFTAR_CICILAN);

    let mut jadwal_per: HashMap<String, Vec<BarisJadwal>> = HashMap::new();
    {
        let mut statement = connection
            .prepare(&format!(
                "{pilih}
                 SELECT j.id_cicilan, j.ke, j.jatuh_tempo, j.nominal FROM keu_cicilan_jadwal j
                 WHERE j.id_cicilan IN (SELECT id_cicilan FROM pilih)
                 ORDER BY j.id_cicilan, j.ke;"
            ))
            .map_err(|_| CommandError::internal())?;
        let rows = statement
            .query_map(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    BarisJadwal {
                        ke: row.get(1)?,
                        jatuh_tempo: row.get(2)?,
                        nominal: row.get(3)?,
                    },
                ))
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let (id_c, baris) = row.map_err(|_| CommandError::internal())?;
            jadwal_per.entry(id_c).or_default().push(baris);
        }
    }
    let mut bayar_per: HashMap<String, Vec<Value>> = HashMap::new();
    let mut denda_per: HashMap<String, i64> = HashMap::new();
    {
        let kolom_b = KOLOM_BAYAR
            .iter()
            .map(|k| format!("y.{k}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection
            .prepare(&format!(
                "{pilih}
                 SELECT {kolom_b}, x.alasan, x.dibatalkan_oleh, x.created_at, j.nomor
                 FROM keu_cicilan_bayar y
                 LEFT JOIN keu_cicilan_bayar_batal x ON x.id_bayar = y.id_bayar
                 LEFT JOIN keu_jurnal j ON j.id_jurnal = 'jrn-' || y.id_bayar
                 WHERE y.id_cicilan IN (SELECT id_cicilan FROM pilih)
                 ORDER BY y.id_cicilan, y.created_at, y.rowid;"
            ))
            .map_err(|_| CommandError::internal())?;
        let n = KOLOM_BAYAR.len();
        let rows = statement
            .query_map(params![id], |row| {
                let mut objek = baris_objek(row, KOLOM_BAYAR)?;
                let alasan: Option<String> = row.get(n)?;
                objek.insert(
                    "batal".into(),
                    match alasan {
                        Some(alasan) => json!({
                            "alasan": alasan,
                            "oleh": row.get::<_, String>(n + 1)?,
                            "pada": row.get::<_, String>(n + 2)?,
                        }),
                        None => Value::Null,
                    },
                );
                objek.insert(
                    "nomor_jurnal".into(),
                    json!(row.get::<_, Option<String>>(n + 3)?),
                );
                Ok(objek)
            })
            .map_err(|_| CommandError::internal())?;
        for row in rows {
            let objek = row.map_err(|_| CommandError::internal())?;
            let id_c = objek["id_cicilan"].as_str().unwrap_or_default().to_owned();
            if objek["jenis"] == "Denda" && objek["batal"].is_null() {
                *denda_per.entry(id_c.clone()).or_default() +=
                    objek["nominal"].as_i64().unwrap_or(0);
            }
            bayar_per
                .entry(id_c)
                .or_default()
                .push(Value::Object(objek));
        }
    }

    let kontrak = kepala
        .into_iter()
        .map(|k| {
            let mut json = k.json;
            let id_cicilan = json["id_cicilan"].as_str().unwrap_or_default().to_owned();
            let jadwal = jadwal_per.remove(&id_cicilan).unwrap_or_default();
            let aktif = k.diterima_penuh && !json["diaktifkan_pada"].is_null();
            let harga = if aktif {
                k.harga_diterima
            } else {
                k.total_pengajuan
            };
            let b = besaran(harga, &jadwal);
            let alokasi = alokasi_jadwal(&jadwal, k.tertutup, hari_ini);
            let sidik = json["sidik_syarat"].as_str().unwrap_or_default().to_owned();
            let status = status_cicilan(&KeadaanCicilan {
                pengajuan_batal: k.batal,
                pengajuan_menunggu: k.menunggu,
                pengajuan_ditutup: k.pengajuan_ditutup,
                diterima_penuh: k.diterima_penuh,
                diaktifkan: !json["diaktifkan_pada"].is_null(),
                ditutup: !json["ditutup_pada"].is_null(),
                perlu_acc_ulang: perlu_acc_ulang(
                    b.total_bayar,
                    json["total_disetujui"].as_i64(),
                    &sidik,
                    json["sidik_disetujui_ulang"].as_str(),
                ),
                tertutup: k.tertutup,
                total_bayar: b.total_bayar,
                ada_terlambat: alokasi.iter().any(|a| a.status == "Terlambat"),
            });
            let bunga_kum = bunga_kumulatif(&b, k.tertutup);
            let pokok_terbayar = k.tertutup.min(b.total_bayar) - bunga_kum;
            json.remove("sidik_disetujui_ulang");
            json.insert("tanggal_pengajuan".into(), json!(k.tanggal));
            json.insert("nomor_pengajuan".into(), json!(k.nomor));
            json.insert("diajukan_oleh".into(), json!(k.diajukan_oleh));
            json.insert("status".into(), json!(status));
            json.insert("harga_tunai".into(), json!(b.harga_tunai));
            json.insert("total_angsuran".into(), json!(b.total_angsuran));
            json.insert("total_bayar".into(), json!(b.total_bayar));
            json.insert("bunga".into(), json!(b.bunga));
            json.insert("tertutup".into(), json!(k.tertutup));
            json.insert(
                "sisa_pokok".into(),
                json!(((b.total_bayar - b.bunga) - pokok_terbayar).max(0)),
            );
            json.insert("sisa_bunga".into(), json!(b.bunga - bunga_kum));
            json.insert(
                "lebih_bayar".into(),
                json!((k.tertutup - b.total_bayar).max(0)),
            );
            json.insert(
                "total_denda".into(),
                json!(denda_per.remove(&id_cicilan).unwrap_or(0)),
            );
            json.insert("penerimaan_dijurnal".into(), json!(k.dijurnal));
            json.insert(
                "jadwal".into(),
                Value::Array(
                    jadwal
                        .iter()
                        .zip(&alokasi)
                        .map(|(baris, a)| {
                            json!({
                                "ke": baris.ke,
                                "jatuh_tempo": baris.jatuh_tempo,
                                "nominal": baris.nominal,
                                "terbayar": a.terbayar,
                                "status": a.status,
                            })
                        })
                        .collect(),
                ),
            );
            json.insert(
                "bayar".into(),
                Value::Array(bayar_per.remove(&id_cicilan).unwrap_or_default()),
            );
            Kontrak {
                id_cicilan,
                tanggal_pengajuan: k.tanggal,
                nomor_pengajuan: k.nomor,
                diajukan_oleh: k.diajukan_oleh,
                kreditur: json["kreditur"].as_str().unwrap_or_default().to_owned(),
                sidik_syarat: sidik,
                id_akun_utang: json["id_akun_utang"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                id_akun_bunga: json["id_akun_bunga"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                id_akun_denda: json["id_akun_denda"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                besaran: b,
                tertutup: k.tertutup,
                status,
                dijurnal: k.dijurnal,
                json,
            }
        })
        .collect();
    Ok((kontrak, terpotong))
}

/// Daftar untuk tab Cicilan di Keuangan. Cermin `listCicilan`.
pub fn list_installments(state: &DesktopState) -> Result<Value, CommandError> {
    let connection = storage::database(&state.data_dir)?;
    let hari_ini = wib_today(&connection);
    let (kontrak, terpotong) = muat_kontrak(&connection, None, &hari_ini)?;
    Ok(json!({
        "kontrak": kontrak.into_iter().map(|k| Value::Object(k.json)).collect::<Vec<_>>(),
        "terpotong": terpotong,
        "hari_ini": hari_ini,
    }))
}

fn satu_kontrak(
    connection: &Connection,
    id: &str,
    hari_ini: &str,
) -> Result<Kontrak, CommandError> {
    muat_kontrak(connection, Some(id.trim()), hari_ini)?
        .0
        .pop()
        .ok_or_else(|| invalid("Kontrak cicilan tidak ditemukan."))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccUlangDraft {
    #[serde(default)]
    pub id_cicilan: String,
    #[serde(default)]
    pub sidik_syarat: String,
}

/// ACC ulang syarat final yang lebih mahal dari yang di-ACC. Cermin
/// `reapproveCicilan`.
pub fn reapprove(
    state: &DesktopState,
    operator: &str,
    superadmin: bool,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: AccUlangDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data ACC ulang tidak valid."))?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let hari_ini = wib_today(&transaction);
    let kontrak = satu_kontrak(&transaction, &draft.id_cicilan, &hari_ini)?;
    if kontrak.status != "Menunggu ACC ulang" {
        return Err(invalid(format!(
            "Kontrak ini berstatus {}, bukan Menunggu ACC ulang.",
            kontrak.status
        )));
    }
    if normal_sidik(Some(&draft.sidik_syarat)).as_deref() != Some(kontrak.sidik_syarat.as_str()) {
        return Err(invalid(
            "Syarat cicilan berubah sejak daftar ini dimuat. Muat ulang lalu periksa lagi.",
        ));
    }
    validate_pemutus(&kontrak.diajukan_oleh, operator, superadmin).map_err(invalid)?;
    transaction
        .execute(
            "UPDATE keu_cicilan SET disetujui_ulang_pada = datetime('now', '+7 hours'),
                    disetujui_ulang_oleh = ?, sidik_disetujui_ulang = sidik_syarat,
                    updated_at = datetime('now')
             WHERE id_cicilan = ?;",
            params![operator, kontrak.id_cicilan],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = cicilan_payload(&transaction, &kontrak.id_cicilan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "installment",
        "reapprove",
        &kontrak.id_cicilan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

/// Menutup kontrak (barang ditarik, retur, putus kontrak). Sisa utang
/// dibereskan dengan jurnal manual. Cermin `closeCicilan`.
pub fn close(
    state: &DesktopState,
    operator: &str,
    id_cicilan: &str,
    alasan: &str,
) -> Result<Value, CommandError> {
    let alasan = validate_alasan(alasan, "Alasan penutupan").map_err(invalid)?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let hari_ini = wib_today(&transaction);
    let kontrak = satu_kontrak(&transaction, id_cicilan, &hari_ini)?;
    if !matches!(
        kontrak.status,
        "Menunggu barang" | "Menunggu ACC ulang" | "Berjalan" | "Menunggak"
    ) {
        return Err(invalid(format!(
            "Kontrak berstatus {} tidak bisa ditutup.",
            kontrak.status
        )));
    }
    transaction
        .execute(
            "UPDATE keu_cicilan SET ditutup_pada = datetime('now', '+7 hours'), ditutup_oleh = ?,
                    alasan_tutup = ?, updated_at = datetime('now')
             WHERE id_cicilan = ?;",
            params![operator, alasan, kontrak.id_cicilan],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = cicilan_payload(&transaction, &kontrak.id_cicilan)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "installment",
        "close",
        &kontrak.id_cicilan,
        &payload,
        None,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

fn bayar_payload(transaction: &Transaction<'_>, id_bayar: &str) -> Result<Value, CommandError> {
    transaction
        .query_row(
            &format!(
                "SELECT {} FROM keu_cicilan_bayar WHERE id_bayar = ?;",
                KOLOM_BAYAR.join(", ")
            ),
            params![id_bayar],
            |row| baris_objek(row, KOLOM_BAYAR).map(Value::Object),
        )
        .map_err(|_| CommandError::internal())
}

/// Mencatat satu pembayaran (Bayar atau Denda) beserta jurnalnya dalam satu
/// transaksi. Cermin `catatBayarCicilan`.
pub fn record_payment(
    state: &DesktopState,
    operator: &str,
    draft: Value,
) -> Result<Value, CommandError> {
    let draft: BayarDraft =
        serde_json::from_value(draft).map_err(|_| invalid("Data pembayaran tidak valid."))?;
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let hari_ini = wib_today(&transaction);
    let kontrak = satu_kontrak(&transaction, &draft.id_cicilan, &hari_ini)?;
    let boleh = if draft.jenis.trim() == "Denda" {
        matches!(kontrak.status, "Berjalan" | "Menunggak" | "Lunas")
    } else {
        matches!(kontrak.status, "Berjalan" | "Menunggak")
    };
    if !boleh {
        return Err(invalid(format!(
            "Kontrak ini berstatus {}; pembayaran belum bisa dicatat.",
            kontrak.status
        )));
    }
    if !kontrak.dijurnal {
        return Err(invalid(
            "Jurnal penerimaan barang kontrak ini belum dicatat. Catat dulu di tab Dari Inventaris.",
        ));
    }
    let sisa = kontrak.besaran.total_bayar - kontrak.tertutup;
    let valid =
        validate_bayar(&draft, &kontrak.tanggal_pengajuan, &hari_ini, sisa).map_err(invalid)?;
    let id_akun_bayar = draft.id_akun_bayar.trim().to_owned();
    accounting::assert_akun_bayar(&transaction, &id_akun_bayar)?;

    let id_bayar = new_hex_id("cby-");
    transaction
        .execute(
            "INSERT INTO keu_cicilan_bayar (
                id_bayar, id_cicilan, jenis, tanggal, nominal, potongan, alasan_potongan, keterangan,
                referensi, id_akun_bayar, dicatat_oleh, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'));",
            params![
                id_bayar,
                kontrak.id_cicilan,
                valid.jenis,
                valid.tanggal,
                valid.nominal,
                valid.potongan,
                valid.alasan_potongan,
                valid.keterangan,
                valid.referensi,
                id_akun_bayar,
                operator
            ],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = bayar_payload(&transaction, &id_bayar)?;
    sync::enqueue(
        &transaction,
        &client_id,
        "installment-payment",
        "create",
        &id_bayar,
        &payload,
        None,
    )?;

    let akun = AkunJurnalCicilan {
        utang: &kontrak.id_akun_utang,
        bunga: &kontrak.id_akun_bunga,
        denda: &kontrak.id_akun_denda,
        bayar: &id_akun_bayar,
    };
    let id_jurnal = id_jurnal_cicilan(&id_bayar);
    let baris: Vec<accounting::BarisTulis> = susun_jurnal_cicilan(
        valid.jenis,
        valid.nominal,
        valid.potongan,
        kontrak.tertutup,
        &kontrak.besaran,
        &akun,
    )
    .into_iter()
    .enumerate()
    .map(
        |(indeks, (id_akun, debit, kredit))| accounting::BarisTulis {
            id_baris: format!("{id_jurnal}-{}", indeks + 1),
            id_akun,
            debit,
            kredit,
            keterangan: None,
            urutan: indeks as i64 + 1,
        },
    )
    .collect();
    accounting::tulis_jurnal_tx(
        &transaction,
        state,
        &client_id,
        accounting::HeaderTulis {
            id_jurnal,
            tanggal: valid.tanggal.clone(),
            keterangan: keterangan_jurnal_cicilan(
                valid.jenis,
                &kontrak.kreditur,
                &kontrak.nomor_pengajuan,
                valid.keterangan.as_deref(),
            ),
            sumber: "Cicilan",
            id_sumber: Some(id_bayar.clone()),
            id_jurnal_batal: None,
            dibuat_oleh: operator.to_owned(),
        },
        &baris,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true, "id_bayar": id_bayar }))
}

/// Membatalkan pembayaran: baris pembatal + jurnal pembalik. Bayar hanya yang
/// terakhir (pemisahan pokok/bunga bergantung pada urutan); denda kapan saja
/// karena tidak menggeser jadwal. Cermin `batalBayarCicilan`.
/// "Terakhir" = `created_at` (milidetik) lalu `rowid`, urutan pencatatan.
pub fn cancel_payment(
    state: &DesktopState,
    operator: &str,
    id_bayar: &str,
    alasan: &str,
) -> Result<Value, CommandError> {
    let alasan = validate_alasan(alasan, "Alasan pembatalan").map_err(invalid)?;
    let id_bayar = id_bayar.trim();
    let client_id = sync::ensure_client_id(state)?;
    let mut connection = storage::database(&state.data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|_| CommandError::internal())?;
    let (id_cicilan, jenis, batal): (String, String, bool) = transaction
        .query_row(
            "SELECT y.id_cicilan, y.jenis,
                    EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar)
             FROM keu_cicilan_bayar y WHERE y.id_bayar = ?;",
            params![id_bayar],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| CommandError::internal())?
        .ok_or_else(|| invalid("Pembayaran tidak ditemukan."))?;
    if batal {
        return Err(invalid("Pembayaran ini sudah dibatalkan."));
    }
    if jenis == "Bayar" {
        let terakhir: Option<String> = transaction
            .query_row(
                "SELECT y.id_bayar FROM keu_cicilan_bayar y
                 WHERE y.id_cicilan = ? AND y.jenis = 'Bayar'
                   AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar)
                 ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1;",
                params![id_cicilan],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| CommandError::internal())?;
        if terakhir.as_deref() != Some(id_bayar) {
            return Err(invalid(
                "Hanya pembayaran terakhir yang bisa dibatalkan. Batalkan dulu pembayaran sesudahnya.",
            ));
        }
    }
    transaction
        .execute(
            "INSERT INTO keu_cicilan_bayar_batal (id_bayar, alasan, dibatalkan_oleh, created_at)
             VALUES (?, ?, ?, datetime('now'));",
            params![id_bayar, alasan, operator],
        )
        .map_err(|_| CommandError::internal())?;
    let payload = transaction
        .query_row(
            "SELECT id_bayar, alasan, dibatalkan_oleh, created_at FROM keu_cicilan_bayar_batal WHERE id_bayar = ?;",
            params![id_bayar],
            |row| {
                Ok(json!({
                    "id_bayar": row.get::<_, String>(0)?,
                    "alasan": row.get::<_, String>(1)?,
                    "dibatalkan_oleh": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )
        .map_err(|_| CommandError::internal())?;
    sync::enqueue(
        &transaction,
        &client_id,
        "installment-payment-cancel",
        "create",
        id_bayar,
        &payload,
        None,
    )?;
    accounting::balik_jurnal_tx(
        &transaction,
        state,
        &client_id,
        &id_jurnal_cicilan(id_bayar),
        format!("Pembatalan pembayaran cicilan: {alasan}")
            .chars()
            .take(accounting::MAKS_KETERANGAN)
            .collect(),
        operator,
    )?;
    transaction.commit().map_err(|_| CommandError::internal())?;
    Ok(json!({ "sukses": true }))
}

// Cloud

/// Kontrak Draf ikut event `inventory-request/save`: ditulis hanya selama
/// pengajuan cloud masih Menunggu. Cermin `CLOUD_UPSERT_CICILAN_SQL`.
pub const CLOUD_UPSERT_CICILAN_SQL: &str = "INSERT INTO keu_cicilan (
        id_cicilan, id_pengajuan, kreditur, nomor_kontrak, uang_muka, pola, setiap, satuan,
        id_akun_utang, id_akun_bunga, id_akun_denda, sidik_syarat, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now')
    WHERE EXISTS (SELECT 1 FROM inventory_pengajuan p WHERE p.id_pengajuan = ?
        AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL)
    ON CONFLICT(id_cicilan) DO UPDATE SET
        kreditur = excluded.kreditur,
        nomor_kontrak = excluded.nomor_kontrak,
        uang_muka = excluded.uang_muka,
        pola = excluded.pola,
        setiap = excluded.setiap,
        satuan = excluded.satuan,
        sidik_syarat = excluded.sidik_syarat,
        updated_at = datetime('now')
    WHERE keu_cicilan.diaktifkan_pada IS NULL;";

/// Syarat final saat penerimaan: berlaku selama kontrak belum ditutup dan
/// belum punya pembayaran (keputusan D). Cermin `CLOUD_AKTIFKAN_CICILAN_SQL`.
pub const CLOUD_AKTIFKAN_CICILAN_SQL: &str = "UPDATE keu_cicilan SET
        kreditur = ?, nomor_kontrak = ?, uang_muka = ?, pola = ?, setiap = ?, satuan = ?,
        sidik_syarat = ?, diaktifkan_pada = ?, updated_at = datetime('now')
    WHERE id_cicilan = ? AND ditutup_pada IS NULL
      AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar y WHERE y.id_cicilan = keu_cicilan.id_cicilan
        AND NOT EXISTS (SELECT 1 FROM keu_cicilan_bayar_batal x WHERE x.id_bayar = y.id_bayar));";

/// Baris jadwal hanya ikut bila kontraknya di cloud memegang versi ini.
/// Parameter terakhir: id cicilan, sidik. Cermin `CLOUD_UPSERT_JADWAL_SQL`.
pub const CLOUD_UPSERT_JADWAL_SQL: &str = "INSERT INTO keu_cicilan_jadwal (
        id_jadwal, id_cicilan, ke, jatuh_tempo, nominal
    ) SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM keu_cicilan c WHERE c.id_cicilan = ? AND c.sidik_syarat = ?)
    ON CONFLICT(id_jadwal) DO UPDATE SET
        ke = excluded.ke,
        jatuh_tempo = excluded.jatuh_tempo,
        nominal = excluded.nominal;";

/// Parameter: id cicilan, ke terakhir, id cicilan, sidik.
pub const CLOUD_BUANG_JADWAL_SQL: &str = "DELETE FROM keu_cicilan_jadwal
    WHERE id_cicilan = ? AND ke > ?
      AND EXISTS (SELECT 1 FROM keu_cicilan c WHERE c.id_cicilan = ? AND c.sidik_syarat = ?);";

/// Statement kedua event approve: total yang di-ACC dan akun kontrak, hanya
/// bila ACC pengajuannya barusan berlaku. Parameter: tiga akun, id cicilan,
/// sidik syarat, disetujui_pada. Cermin `CLOUD_SETUJUI_CICILAN_SQL`.
pub const CLOUD_SETUJUI_CICILAN_SQL: &str = "UPDATE keu_cicilan SET
        total_disetujui = (SELECT COALESCE(SUM(j.nominal), 0) FROM keu_cicilan_jadwal j
                           WHERE j.id_cicilan = keu_cicilan.id_cicilan),
        id_akun_utang = ?, id_akun_bunga = ?, id_akun_denda = ?, updated_at = datetime('now')
    WHERE id_cicilan = ? AND sidik_syarat = ? AND total_disetujui IS NULL
      AND EXISTS (SELECT 1 FROM inventory_pengajuan p WHERE p.id_pengajuan = keu_cicilan.id_pengajuan
        AND p.cara_bayar = 'Cicilan' AND p.disetujui_pada = ?);";

pub const CLOUD_ACC_ULANG_SQL: &str = "UPDATE keu_cicilan SET
        disetujui_ulang_pada = ?, disetujui_ulang_oleh = ?, sidik_disetujui_ulang = ?,
        updated_at = datetime('now')
    WHERE id_cicilan = ? AND sidik_syarat = ? AND ditutup_pada IS NULL;";

pub const CLOUD_TUTUP_CICILAN_SQL: &str = "UPDATE keu_cicilan SET
        ditutup_pada = ?, ditutup_oleh = ?, alasan_tutup = ?, updated_at = datetime('now')
    WHERE id_cicilan = ? AND ditutup_pada IS NULL;";

/// Pembayaran dan pembatalan append-only: event yang terkirim dua kali
/// berhenti di PK. Cloud tidak pernah menolak karena sisa atau tanggal.
pub const CLOUD_INSERT_BAYAR_SQL: &str = "INSERT INTO keu_cicilan_bayar (
        id_bayar, id_cicilan, jenis, tanggal, nominal, potongan, alasan_potongan, keterangan,
        referensi, id_akun_bayar, dicatat_oleh, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_bayar) DO NOTHING;";

pub const CLOUD_INSERT_BATAL_SQL: &str = "INSERT INTO keu_cicilan_bayar_batal (
        id_bayar, alasan, dibatalkan_oleh, created_at
    ) VALUES (?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(id_bayar) DO NOTHING;";

/// Syarat dari payload (`cicilan` + `jadwal`). Bentuk cacat = `None`, supaya
/// handler melewatinya tanpa menolak event.
fn syarat_payload(payload: &Value) -> Option<(String, &Value, Syarat)> {
    let header = payload.get("cicilan")?;
    let id = payload_text(header, "id_cicilan")?;
    let pola = payload_text(header, "pola").filter(|p| POLA_JADWAL.contains(&p.as_str()))?;
    let satuan = payload_text(header, "satuan");
    if satuan
        .as_deref()
        .is_some_and(|s| !SATUAN_JADWAL.contains(&s))
    {
        return None;
    }
    let rows = payload.get("jadwal")?.as_array()?;
    if rows.len() < 2 || rows.len() as i64 > MAKS_TENOR + 1 {
        return None;
    }
    let mut jadwal = Vec::with_capacity(rows.len());
    for (indeks, row) in rows.iter().enumerate() {
        let ke = row.get("ke").and_then(Value::as_i64)?;
        let nominal = row.get("nominal").and_then(Value::as_i64)?;
        let jatuh_tempo = payload_text(row, "jatuh_tempo").filter(|t| is_valid_date(t))?;
        if ke != indeks as i64 || nominal < 0 {
            return None;
        }
        jadwal.push(BarisJadwal {
            ke,
            jatuh_tempo,
            nominal,
        });
    }
    let uang_muka = header.get("uang_muka").and_then(Value::as_i64)?;
    if uang_muka != jadwal[0].nominal {
        return None;
    }
    let syarat = Syarat {
        kreditur: payload_text(header, "kreditur")?,
        nomor_kontrak: payload_text(header, "nomor_kontrak"),
        uang_muka,
        pola,
        setiap: header.get("setiap").and_then(Value::as_i64),
        satuan,
        jadwal,
    };
    Some((id, header, syarat))
}

fn jadwal_statements(id: &str, syarat: &Syarat, sidik: &str) -> Vec<(&'static str, Vec<Value>)> {
    let mut statements: Vec<(&'static str, Vec<Value>)> = syarat
        .jadwal
        .iter()
        .map(|b| {
            (
                CLOUD_UPSERT_JADWAL_SQL,
                vec![
                    json!(id_jadwal(id, b.ke)),
                    json!(id),
                    json!(b.ke),
                    json!(b.jatuh_tempo),
                    json!(b.nominal),
                    json!(id),
                    json!(sidik),
                ],
            )
        })
        .collect();
    statements.push((
        CLOUD_BUANG_JADWAL_SQL,
        vec![
            json!(id),
            json!(syarat.jadwal.len() as i64 - 1),
            json!(id),
            json!(sidik),
        ],
    ));
    statements
}

/// Tambahan statement event `inventory-request/save` untuk pengajuan Cicilan.
/// Sidik dihitung ulang dari kiriman.
pub fn cloud_draf_statements(
    payload: &Value,
    id_pengajuan: &str,
) -> Vec<(&'static str, Vec<Value>)> {
    let Some((id, header, syarat)) = syarat_payload(payload) else {
        return Vec::new();
    };
    if id != id_cicilan(id_pengajuan) {
        return Vec::new();
    }
    let sidik = sidik_syarat(&syarat);
    let akun = |kolom: &str, bawaan: &str| {
        payload_text(header, kolom).unwrap_or_else(|| bawaan.to_owned())
    };
    let mut statements = vec![(
        CLOUD_UPSERT_CICILAN_SQL,
        vec![
            json!(id),
            json!(id_pengajuan),
            json!(syarat.kreditur),
            json!(syarat.nomor_kontrak),
            json!(syarat.uang_muka),
            json!(syarat.pola),
            json!(syarat.setiap),
            json!(syarat.satuan),
            json!(akun("id_akun_utang", AKUN_UTANG_CICILAN)),
            json!(akun("id_akun_bunga", AKUN_BEBAN_BUNGA)),
            json!(akun("id_akun_denda", AKUN_BEBAN_DENDA)),
            json!(sidik),
            json!(payload_text(header, "created_at")),
            json!(id_pengajuan),
        ],
    )];
    statements.extend(jadwal_statements(&id, &syarat, &sidik));
    statements
}

/// Statement event `installment/activate`.
pub fn cloud_activate_statements(
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let (id, header, syarat) = syarat_payload(payload)?;
    if id != entity_key.trim() {
        return None;
    }
    let sidik = sidik_syarat(&syarat);
    let mut statements = vec![(
        CLOUD_AKTIFKAN_CICILAN_SQL,
        vec![
            json!(syarat.kreditur),
            json!(syarat.nomor_kontrak),
            json!(syarat.uang_muka),
            json!(syarat.pola),
            json!(syarat.setiap),
            json!(syarat.satuan),
            json!(sidik),
            json!(payload_text(header, "diaktifkan_pada")?),
            json!(id),
        ],
    )];
    statements.extend(jadwal_statements(&id, &syarat, &sidik));
    Some(statements)
}

/// Statement kedua event `inventory-request/approve` untuk pengajuan Cicilan.
pub fn cloud_setujui_values(
    payload: &Value,
    id_pengajuan: &str,
    disetujui_pada: &str,
) -> Option<Vec<Value>> {
    let header = payload.get("cicilan")?.get("cicilan")?;
    let id = payload_text(header, "id_cicilan").filter(|id| *id == id_cicilan(id_pengajuan))?;
    Some(vec![
        json!(payload_text(header, "id_akun_utang")?),
        json!(payload_text(header, "id_akun_bunga")?),
        json!(payload_text(header, "id_akun_denda")?),
        json!(id),
        json!(payload_text(header, "sidik_syarat")?),
        json!(disetujui_pada),
    ])
}

pub fn cloud_reapprove_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let header = payload.get("cicilan")?;
    let id = payload_text(header, "id_cicilan").unwrap_or_else(|| entity_key.trim().to_owned());
    let sidik = payload_text(header, "sidik_disetujui_ulang")?;
    Some(vec![
        json!(payload_text(header, "disetujui_ulang_pada")?),
        json!(payload_text(header, "disetujui_ulang_oleh")?),
        json!(sidik),
        json!(id),
        json!(sidik),
    ])
}

pub fn cloud_close_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let header = payload.get("cicilan")?;
    let id = payload_text(header, "id_cicilan").unwrap_or_else(|| entity_key.trim().to_owned());
    Some(vec![
        json!(payload_text(header, "ditutup_pada")?),
        json!(payload_text(header, "ditutup_oleh")?),
        json!(payload_text(header, "alasan_tutup")?),
        json!(id),
    ])
}

/// Nilai yang melanggar CHECK dilewati, tidak ditolak: outbox akan macet.
pub fn cloud_payment_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(payload, "id_bayar").unwrap_or_else(|| entity_key.trim().to_owned());
    let jenis = payload_text(payload, "jenis").filter(|j| JENIS_BAYAR.contains(&j.as_str()))?;
    let nominal = payload
        .get("nominal")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)?;
    let potongan = payload
        .get("potongan")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)?;
    let tanggal = payload_text(payload, "tanggal").filter(|t| is_valid_date(t))?;
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(payload, "id_cicilan")?),
        json!(jenis),
        json!(tanggal),
        json!(nominal),
        json!(potongan),
        json!(payload_text(payload, "alasan_potongan")),
        json!(payload_text(payload, "keterangan")),
        json!(payload_text(payload, "referensi")),
        json!(payload_text(payload, "id_akun_bayar")?),
        json!(payload_text(payload, "dicatat_oleh")?),
        json!(payload_text(payload, "created_at")),
    ])
}

pub fn cloud_payment_cancel_values(payload: &Value, entity_key: &str) -> Option<Vec<Value>> {
    let id = payload_text(payload, "id_bayar").unwrap_or_else(|| entity_key.trim().to_owned());
    if id.is_empty() {
        return None;
    }
    Some(vec![
        json!(id),
        json!(payload_text(payload, "alasan")?),
        json!(payload_text(payload, "dibatalkan_oleh")?),
        json!(payload_text(payload, "created_at")),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor yang sama dengan `cicilan.test.ts`.

    fn draft_berkala(uang_muka: i64, tenor: i64, nominal: i64) -> SyaratDraft {
        SyaratDraft {
            kreditur: " Toko Maju ".into(),
            nomor_kontrak: Some("K-01".into()),
            uang_muka,
            pola: "Berkala".into(),
            jatuh_tempo_pertama: Some("2026-11-28".into()),
            setiap: Some(1),
            satuan: Some("Bulan".into()),
            tenor: Some(tenor),
            nominal: Some(nominal),
            jadwal: vec![],
        }
    }

    fn tanggal(baris: &[(String, i64)]) -> Vec<&str> {
        baris.iter().map(|(t, _)| t.as_str()).collect()
    }

    #[test]
    fn jadwal_bulanan_mengikuti_tanggal_pertama() {
        let baris = susun_jadwal("2027-01-31", 1, "Bulan", 4, 100).expect("susun");
        assert_eq!(
            tanggal(&baris),
            ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]
        );
        let kabisat = susun_jadwal("2028-01-31", 1, "Bulan", 2, 100).expect("susun");
        assert_eq!(tanggal(&kabisat), ["2028-01-31", "2028-02-29"]);
        let tahunan = susun_jadwal("2028-02-29", 1, "Tahun", 2, 100).expect("susun");
        assert_eq!(tanggal(&tahunan), ["2028-02-29", "2029-02-28"]);
        let mingguan = susun_jadwal("2026-12-28", 2, "Minggu", 2, 100).expect("susun");
        assert_eq!(tanggal(&mingguan), ["2026-12-28", "2027-01-11"]);
        let harian = susun_jadwal("2026-12-31", 1, "Hari", 2, 100).expect("susun");
        assert_eq!(tanggal(&harian), ["2026-12-31", "2027-01-01"]);
    }

    #[test]
    fn jadwal_menolak_isian_cacat() {
        assert_eq!(
            susun_jadwal("2026-11-28", 1, "Bulan", 361, 100).unwrap_err(),
            "Tenor harus 1–360 kali."
        );
        assert_eq!(
            susun_jadwal("2026-11-28", 0, "Bulan", 1, 100).unwrap_err(),
            "Jarak angsuran harus 1–365."
        );
        assert_eq!(
            susun_jadwal("2026-11-28", 1, "Dekade", 1, 100).unwrap_err(),
            "Satuan jarak angsuran tidak dikenal."
        );
        assert_eq!(
            susun_jadwal("2026-11-28", 1, "Bulan", 1, 0).unwrap_err(),
            "Nominal per angsuran harus lebih dari 0."
        );
        assert_eq!(
            susun_jadwal("9999-01-01", 365, "Tahun", 2, 100).unwrap_err(),
            "Jadwal terlalu panjang."
        );
    }

    #[test]
    fn syarat_contoh_prd() {
        let syarat = validate_syarat(
            &draft_berkala(2_000_000, 10, 1_150_000),
            12_000_000,
            "2026-10-28",
            "2026-10-28",
        )
        .expect("sah");
        assert_eq!(syarat.kreditur, "Toko Maju");
        assert_eq!(syarat.jadwal.len(), 11);
        assert_eq!(
            syarat.jadwal[0],
            BarisJadwal {
                ke: 0,
                jatuh_tempo: "2026-10-28".into(),
                nominal: 2_000_000
            }
        );
        assert_eq!(syarat.jadwal[10].jatuh_tempo, "2027-08-28");
        let b = besaran(12_000_000, &syarat.jadwal);
        assert_eq!(b.total_bayar, 13_500_000);
        assert_eq!(b.bunga, 1_500_000);
        // Nomor kontrak ikut sidik: mengubahnya saja sudah butuh sidik baru.
        let mut lain = syarat.clone();
        lain.nomor_kontrak = Some("K-02".into());
        assert_ne!(sidik_syarat(&syarat), sidik_syarat(&lain));
    }

    #[test]
    fn syarat_menolak_bunga_negatif_tanggal_mundur_dan_dp() {
        assert_eq!(
            validate_syarat(&draft_berkala(2_000_000, 10, 900_000), 12_000_000, "2026-10-28", "2026-10-28")
                .unwrap_err(),
            "Total angsuran kurang dari harga tunai dikurangi uang muka (bunga tidak boleh negatif)."
        );
        assert_eq!(
            validate_syarat(
                &draft_berkala(12_000_000, 10, 1_150_000),
                12_000_000,
                "2026-10-28",
                "2026-10-28"
            )
            .unwrap_err(),
            "Uang muka harus 0 atau lebih dan lebih kecil dari harga tunai."
        );
        assert_eq!(
            validate_syarat(
                &draft_berkala(0, 361, 1_150_000),
                12_000_000,
                "2026-10-28",
                "2026-10-28"
            )
            .unwrap_err(),
            "Tenor harus 1–360 kali."
        );
        let manual = SyaratDraft {
            kreditur: "Toko".into(),
            pola: "Manual".into(),
            jadwal: vec![
                JadwalDraft {
                    jatuh_tempo: "2026-12-01".into(),
                    nominal: 6_000_000,
                },
                JadwalDraft {
                    jatuh_tempo: "2026-12-01".into(),
                    nominal: 6_000_000,
                },
            ],
            ..SyaratDraft::default()
        };
        assert_eq!(
            validate_syarat(&manual, 12_000_000, "2026-10-28", "2026-10-28").unwrap_err(),
            "Angsuran 2: jatuh tempo harus setelah angsuran sebelumnya."
        );
        let awal = SyaratDraft {
            kreditur: "Toko".into(),
            pola: "Manual".into(),
            jadwal: vec![JadwalDraft {
                jatuh_tempo: "2026-10-27".into(),
                nominal: 12_000_000,
            }],
            ..SyaratDraft::default()
        };
        assert_eq!(
            validate_syarat(&awal, 12_000_000, "2026-10-28", "2026-10-28").unwrap_err(),
            "Jatuh tempo angsuran pertama tidak boleh sebelum tanggal pengajuan."
        );
        assert_eq!(
            validate_syarat(
                &SyaratDraft {
                    pola: "Manual".into(),
                    ..SyaratDraft::default()
                },
                1,
                "2026-10-28",
                "2026-10-28"
            )
            .unwrap_err(),
            "Kreditur wajib diisi."
        );
    }

    #[test]
    fn sidik_syarat_vektor() {
        let syarat = Syarat {
            kreditur: "Toko Maju".into(),
            nomor_kontrak: None,
            uang_muka: 100,
            pola: "Manual".into(),
            setiap: None,
            satuan: None,
            jadwal: vec![
                BarisJadwal {
                    ke: 1,
                    jatuh_tempo: "2026-12-01".into(),
                    nominal: 50,
                },
                BarisJadwal {
                    ke: 0,
                    jatuh_tempo: "2026-11-01".into(),
                    nominal: 100,
                },
            ],
        };
        // Kanonik: "Toko Maju␟␟100␟Manual␟␟␞0␟2026-11-01␟100␞1␟2026-12-01␟50".
        let kanonik = "Toko Maju\u{1f}\u{1f}100\u{1f}Manual\u{1f}\u{1f}\u{1e}0\u{1f}2026-11-01\u{1f}100\u{1e}1\u{1f}2026-12-01\u{1f}50";
        assert_eq!(
            sidik_syarat(&syarat),
            hex::encode(Sha256::digest(kanonik.as_bytes()))
        );
    }

    fn contoh() -> Besaran {
        Besaran {
            harga_tunai: 12_000_000,
            uang_muka: 2_000_000,
            total_angsuran: 11_500_000,
            total_bayar: 13_500_000,
            bunga: 1_500_000,
        }
    }

    #[test]
    fn pokok_bunga_contoh_prd() {
        let b = contoh();
        assert_eq!(bagi_pokok_bunga(&b, 0, 2_000_000), (2_000_000, 0));
        assert_eq!(
            bagi_pokok_bunga(&b, 2_000_000, 3_150_000),
            (1_000_000, 150_000)
        );
        assert_eq!(
            bagi_pokok_bunga(&b, 8_900_000, 13_500_000),
            (4_000_000, 600_000)
        );
        assert_eq!(bunga_kumulatif(&b, 13_500_000), 1_500_000);
        // Lebih bayar: bunga dibatasi B.
        assert_eq!(bagi_pokok_bunga(&b, 13_500_000, 14_000_000), (500_000, 0));
        // Pembulatan kumulatif: 1/3 bunga tiap angsuran tetap berjumlah tepat B.
        let ganjil = Besaran {
            harga_tunai: 100,
            uang_muka: 0,
            total_angsuran: 300,
            total_bayar: 300,
            bunga: 200,
        };
        let bagian: Vec<i64> = [(0, 100), (100, 200), (200, 300)]
            .iter()
            .map(|(c0, c1)| bagi_pokok_bunga(&ganjil, *c0, *c1).1)
            .collect();
        assert_eq!(bagian, vec![67, 66, 67]);
    }

    fn akun() -> AkunJurnalCicilan<'static> {
        AkunJurnalCicilan {
            utang: "U",
            bunga: "B",
            denda: "D",
            bayar: "K",
        }
    }

    #[test]
    fn jurnal_cicilan_seimbang() {
        let b = contoh();
        assert_eq!(
            susun_jurnal_cicilan("Bayar", 4_200_000, 400_000, 8_900_000, &b, &akun()),
            vec![
                ("U".to_owned(), 4_000_000, 0),
                ("B".to_owned(), 200_000, 0),
                ("K".to_owned(), 0, 4_200_000),
            ]
        );
        // Potongan melebihi bunga bagian: sisanya Pendapatan Lain-lain.
        assert_eq!(
            susun_jurnal_cicilan("Bayar", 1_000_000, 200_000, 2_000_000, &b, &akun()),
            vec![
                ("U".to_owned(), 1_043_478, 0),
                ("K".to_owned(), 0, 1_000_000),
                (AKUN_PENDAPATAN_LAIN.to_owned(), 0, 43_478),
            ]
        );
        assert_eq!(
            susun_jurnal_cicilan("Denda", 50_000, 0, 0, &b, &akun()),
            vec![("D".to_owned(), 50_000, 0), ("K".to_owned(), 0, 50_000)]
        );
        for baris in [
            susun_jurnal_cicilan("Bayar", 1_150_000, 0, 2_000_000, &b, &akun()),
            susun_jurnal_cicilan("Bayar", 0, 300_000, 3_150_000, &b, &akun()),
        ] {
            let debit: i64 = baris.iter().map(|(_, d, _)| d).sum();
            let kredit: i64 = baris.iter().map(|(_, _, k)| k).sum();
            assert_eq!(debit, kredit);
        }
    }

    fn jadwal_contoh() -> Vec<BarisJadwal> {
        vec![
            BarisJadwal {
                ke: 0,
                jatuh_tempo: "2026-10-28".into(),
                nominal: 2_000_000,
            },
            BarisJadwal {
                ke: 1,
                jatuh_tempo: "2026-11-28".into(),
                nominal: 1_150_000,
            },
            BarisJadwal {
                ke: 2,
                jatuh_tempo: "2026-12-28".into(),
                nominal: 1_150_000,
            },
        ]
    }

    #[test]
    fn alokasi_dan_status() {
        let alokasi = alokasi_jadwal(&jadwal_contoh(), 2_500_000, "2026-12-01");
        let status: Vec<&str> = alokasi.iter().map(|a| a.status).collect();
        assert_eq!(status, ["Lunas", "Terlambat", "Belum"]);
        assert_eq!(alokasi[1].terbayar, 500_000);
        let sebagian = alokasi_jadwal(&jadwal_contoh(), 2_500_000, "2026-11-28");
        assert_eq!(sebagian[1].status, "Sebagian");

        let dasar = KeadaanCicilan {
            pengajuan_batal: false,
            pengajuan_menunggu: false,
            pengajuan_ditutup: false,
            diterima_penuh: true,
            diaktifkan: true,
            ditutup: false,
            perlu_acc_ulang: false,
            tertutup: 0,
            total_bayar: 100,
            ada_terlambat: false,
        };
        assert_eq!(status_cicilan(&dasar), "Berjalan");
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                ada_terlambat: true,
                ..dasar
            }),
            "Menunggak"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                tertutup: 100,
                ada_terlambat: true,
                ..dasar
            }),
            "Lunas"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                perlu_acc_ulang: true,
                ..dasar
            }),
            "Menunggu ACC ulang"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                diterima_penuh: false,
                ..dasar
            }),
            "Menunggu barang"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                diterima_penuh: false,
                pengajuan_ditutup: true,
                ..dasar
            }),
            "Dibatalkan"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                pengajuan_menunggu: true,
                diaktifkan: false,
                ..dasar
            }),
            "Draf"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                ditutup: true,
                ..dasar
            }),
            "Ditutup"
        );
        assert_eq!(
            status_cicilan(&KeadaanCicilan {
                pengajuan_batal: true,
                ..dasar
            }),
            "Dibatalkan"
        );

        assert!(perlu_acc_ulang(110, Some(100), "a", None));
        assert!(!perlu_acc_ulang(110, Some(100), "a", Some("a")));
        assert!(perlu_acc_ulang(110, Some(100), "b", Some("a")));
        assert!(!perlu_acc_ulang(100, Some(100), "a", None));
    }

    #[test]
    fn terima_penuh_dan_bayar() {
        let acc = [("pgj-a-1", 1, 2), ("pgj-a-2", 2, 0)];
        assert!(wajib_terima_penuh(&acc, &[("pgj-a-1", 2)]).is_ok());
        assert_eq!(
            wajib_terima_penuh(&acc, &[("pgj-a-1", 1)]).unwrap_err(),
            "Baris 1: pengajuan cicilan wajib diterima penuh sesuai ACC dalam satu penerimaan."
        );

        let bayar = |jenis: &str, nominal: i64, potongan: i64, alasan: Option<&str>| BayarDraft {
            jenis: jenis.into(),
            tanggal: "2026-11-30".into(),
            nominal,
            potongan,
            alasan_potongan: alasan.map(str::to_owned),
            keterangan: Some(" telat 5 hari ".into()),
            ..BayarDraft::default()
        };
        let cek = |d: &BayarDraft| validate_bayar(d, "2026-10-28", "2026-12-01", 1_000_000);
        assert_eq!(
            cek(&bayar("Bayar", 900_000, 100_000, None)).unwrap_err(),
            "Alasan potongan wajib diisi."
        );
        assert_eq!(
            cek(&bayar("Bayar", 900_000, 100_001, Some("x"))).unwrap_err(),
            "Nominal ditambah potongan melebihi sisa jadwal (Rp1.000.000)."
        );
        assert_eq!(
            cek(&bayar("Bayar", 0, 0, None)).unwrap_err(),
            "Isi nominal dibayar atau potongan."
        );
        let sah = cek(&bayar(
            "Bayar",
            900_000,
            100_000,
            Some("pelunasan dipercepat"),
        ))
        .expect("sah");
        assert_eq!(sah.alasan_potongan.as_deref(), Some("pelunasan dipercepat"));
        assert_eq!(sah.keterangan, None);
        let denda = cek(&bayar("Denda", 50_000, 0, None)).expect("sah");
        assert_eq!(denda.keterangan.as_deref(), Some("telat 5 hari"));
        assert_eq!(
            cek(&bayar("Denda", 0, 0, None)).unwrap_err(),
            "Nominal denda harus lebih dari 0."
        );
        let mut mundur = bayar("Bayar", 1, 0, None);
        mundur.tanggal = "2026-10-27".into();
        assert_eq!(
            cek(&mundur).unwrap_err(),
            "Tanggal bayar tidak boleh sebelum tanggal pengajuan."
        );
        let mut depan = bayar("Bayar", 1, 0, None);
        depan.tanggal = "2026-12-02".into();
        assert_eq!(
            cek(&depan).unwrap_err(),
            "Tanggal bayar tidak boleh setelah hari ini."
        );
    }

    #[test]
    fn id_turunan() {
        assert_eq!(id_cicilan("pgj-a"), "cil-pgj-a");
        assert_eq!(id_pengajuan_dari_cicilan("cil-pgj-a"), Some("pgj-a"));
        assert_eq!(id_cicilan_dari_jadwal("cil-pgj-a-12"), Some("cil-pgj-a"));
        assert_eq!(id_cicilan_dari_jadwal("pgj-a-12"), None);
        assert_eq!(
            keterangan_jurnal_cicilan("Bayar", "Toko", "PGJ/2026/WEB/0001", None),
            "Bayar cicilan Toko (PGJ/2026/WEB/0001)"
        );
        assert_eq!(
            keterangan_jurnal_cicilan("Denda", "Toko", "PGJ", Some("telat")),
            "Denda cicilan Toko: telat"
        );
    }

    fn setup_state() -> (tempfile::TempDir, DesktopState) {
        let directory = tempfile::tempdir().expect("direktori sementara");
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

    /// Ajukan Cicilan → ACC → terima penuh → bayar ditolak sebelum jurnal
    /// penerimaan → jurnal (kredit dikunci ke utang) → DP + angsuran →
    /// batal yang bukan terakhir ditolak → batal terakhir. Skenario yang sama
    /// dengan `cicilan.test.ts`.
    #[test]
    fn alur_kontrak_cicilan() {
        use super::super::{inventory, inventory_pengajuan as pgj};
        let (_directory, state) = setup_state();
        let connection = storage::database(&state.data_dir).expect("db");
        let hari = wib_today(&connection);
        let syarat = json!({"kreditur": "Toko Maju", "uang_muka": 2_000_000, "pola": "Berkala",
            "jatuh_tempo_pertama": hari, "setiap": 1, "satuan": "Bulan", "tenor": 10, "nominal": 1_150_000});
        let id = pgj::save_request(
            &state,
            "pengaju",
            json!({"tanggal": hari, "keperluan": "Laptop staf", "cara_bayar": "Cicilan", "cicilan": syarat,
                "baris": [{"nama_barang": "Laptop", "satuan": "unit", "jumlah": 1, "harga_satuan": 12_000_000}]}),
        )
        .expect("ajukan")["id_pengajuan"]
            .as_str()
            .expect("id")
            .to_owned();
        let p = pgj::list_requests(&state, &hari, &hari).expect("daftar")["pengajuan"][0].clone();
        assert_eq!(p["cara_bayar"], "Cicilan");
        assert_eq!(p["cicilan"]["jadwal"].as_array().map(Vec::len), Some(11));
        let id_c = id_cicilan(&id);
        assert_eq!(
            list_installments(&state).expect("kontrak")["kontrak"][0]["status"],
            "Draf"
        );

        // ACC tanpa sidik syarat ditolak; dengan sidik yang dilihat berlaku.
        let keputusan = |sidik_syarat: Value| {
            json!({"id_pengajuan": id, "keputusan": "ACC", "sidik_baris": p["sidik_baris"],
                "sidik_syarat": sidik_syarat})
        };
        assert!(
            pgj::decide_request(&state, "bendahara", false, keputusan(Value::Null))
                .unwrap_err()
                .message
                .contains("Syarat cicilan berubah")
        );
        pgj::decide_request(
            &state,
            "bendahara",
            false,
            keputusan(p["cicilan"]["sidik_syarat"].clone()),
        )
        .expect("acc");
        let k = list_installments(&state).expect("kontrak")["kontrak"][0].clone();
        assert_eq!(k["status"], "Menunggu barang");
        assert_eq!(k["total_disetujui"], 13_500_000);

        let foto = json!([{"mime_type": "image/jpeg", "data_base64": "QUJD"}]);
        pgj::receive_request(
            &state,
            "pengaju",
            json!({"id_pengajuan": id, "tanggal": hari, "cicilan": syarat, "foto": foto, "baris": [
                {"id_baris": format!("{id}-1"), "jumlah": 1, "harga_satuan": 12_000_000,
                 "tempat": "Ruang Staf", "tipe": "Aset", "kategori": "Elektronik"}]}),
        )
        .expect("terima");
        let k = list_installments(&state).expect("kontrak")["kontrak"][0].clone();
        assert_eq!(k["status"], "Berjalan");
        assert_eq!(k["bunga"], 1_500_000);
        assert_eq!(k["penerimaan_dijurnal"], false);

        let bayar = |nominal: i64| {
            json!({"id_cicilan": id_c, "jenis": "Bayar", "tanggal": hari, "nominal": nominal,
                "id_akun_bayar": "akun-kas"})
        };
        assert!(record_payment(&state, "bendahara", bayar(2_000_000))
            .unwrap_err()
            .message
            .contains("Jurnal penerimaan"));

        let id_mutasi: String = connection
            .query_row(
                "SELECT id_mutasi FROM inventory_mutasi WHERE alasan = 'Pengadaan';",
                [],
                |row| row.get(0),
            )
            .expect("mutasi");
        inventory::journal_post(
            &state,
            "bendahara",
            json!({"id_mutasi": [id_mutasi], "akun_debit_aset": "akun-peralatan",
                "akun_debit_habis_pakai": "akun-beban-atk", "akun_kredit_bayar": "akun-kas"}),
        )
        .expect("jurnal penerimaan");
        let kredit: String = connection
            .query_row(
                "SELECT id_akun FROM keu_jurnal_baris WHERE id_jurnal = ? AND kredit > 0;",
                params![format!("jrn-inv-{id_mutasi}")],
                |row| row.get(0),
            )
            .expect("kredit");
        assert_eq!(kredit, AKUN_UTANG_CICILAN);

        let dp = record_payment(&state, "bendahara", bayar(2_000_000)).expect("dp")["id_bayar"]
            .as_str()
            .expect("id")
            .to_owned();
        let angsuran = record_payment(&state, "bendahara", bayar(1_150_000)).expect("angsuran")
            ["id_bayar"]
            .as_str()
            .expect("id")
            .to_owned();
        let bunga: i64 = connection
            .query_row(
                "SELECT debit FROM keu_jurnal_baris WHERE id_jurnal = ? AND id_akun = ?;",
                params![id_jurnal_cicilan(&angsuran), AKUN_BEBAN_BUNGA],
                |row| row.get(0),
            )
            .expect("bunga");
        assert_eq!(bunga, 150_000);
        assert!(record_payment(&state, "bendahara", bayar(11_000_000))
            .unwrap_err()
            .message
            .contains("melebihi sisa jadwal"));
        assert!(
            inventory::cancel_mutation(&state, "pengaju", &id_mutasi, "Salah harga")
                .unwrap_err()
                .message
                .contains("sudah punya pembayaran")
        );

        assert!(cancel_payment(&state, "bendahara", &dp, "Salah")
            .unwrap_err()
            .message
            .contains("Hanya pembayaran terakhir"));
        cancel_payment(&state, "bendahara", &angsuran, "Salah nominal").expect("batal");
        let k = list_installments(&state).expect("kontrak")["kontrak"][0].clone();
        assert_eq!(k["tertutup"], 2_000_000);
        assert_eq!(k["bayar"][1]["batal"]["alasan"], "Salah nominal");

        let event: Vec<(String, String)> = connection
            .prepare(
                "SELECT domain, operation FROM desktop_sync_outbox
                 WHERE domain LIKE 'installment%' ORDER BY rowid;",
            )
            .expect("prepare")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("baris");
        let event: Vec<(&str, &str)> = event
            .iter()
            .map(|(d, o)| (d.as_str(), o.as_str()))
            .collect();
        assert_eq!(
            event,
            vec![
                ("installment", "activate"),
                ("installment-payment", "create"),
                ("installment-payment", "create"),
                ("installment-payment-cancel", "create"),
            ]
        );

        // Payload tersimpan diterima penyusun statement cloud.
        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox WHERE domain = 'installment';",
                [],
                |row| row.get(0),
            )
            .expect("payload");
        let payload: Value = serde_json::from_str(&payload).expect("json");
        let statements = cloud_activate_statements(&payload, &id_c).expect("statement");
        assert_eq!(statements.len(), 1 + 11 + 1);
        assert_eq!(statements[0].1[6], k["sidik_syarat"]);
        let simpan: String = connection
            .query_row(
                "SELECT payload_json FROM desktop_sync_outbox
                 WHERE domain = 'inventory-request' AND operation = 'save';",
                [],
                |row| row.get(0),
            )
            .expect("payload");
        let simpan: Value = serde_json::from_str(&simpan).expect("json");
        assert_eq!(
            pgj::cloud_save_statements(&simpan, &id)
                .expect("statement")
                .len(),
            3 + 1 + 11 + 1
        );
    }
}
