//! HRIS fase 5 (skema v40): surat peringatan dan karyawan keluar.
//!
//! `hr_sp`, `hr_keluar`, `hr_keluar_rincian`, dan `hr_keluar_alasan` KHUSUS
//! CLOUD (Q-63): tidak pernah ada di SQLite perangkat, tanpa outbox. Yang
//! tersinkron hanya `master_data.id_keluar`, ditulis transaksi cloud
//! Berlakukan/Batal dan ditarik perangkat lewat snapshot.
//!
//! Aturan murninya cermin `src/lib/validations/hr-keluar.ts` dan diuji dengan
//! vektor yang sama.

use std::collections::HashMap;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::hris::{self, objek, siap, tak_terhubung, tambah_bulan};
use super::inventory::{invalid, is_valid_date, new_hex_id, payload_text};
use super::turso::{Statement, TursoClient};
use super::{config::DesktopState, hr_pengajuan, loan, models::CommandError, storage, time_policy};

/// Satu alasan keluar bawaan. Pengali dalam persen dari kelipatan UP/UPMK.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AlasanBawaan {
    pub id_alasan: String,
    pub nama: String,
    pub pengali_up: i64,
    pub pengali_upmk: i64,
    pub uph: bool,
    pub kompensasi_pkwt: bool,
    pub uang_pisah: bool,
    pub dasar_hukum: Option<String>,
}

/// Alasan keluar bawaan dari berkas JSON yang SAMA dengan yang diimpor
/// `validations/hr-keluar.ts`. Angkanya dari PP 35/2021 dan wajib dicek ulang
/// klien; semuanya bisa disunting.
pub fn alasan_bawaan() -> &'static [AlasanBawaan] {
    static ALASAN: OnceLock<Vec<AlasanBawaan>> = OnceLock::new();
    ALASAN.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/lib/validations/hr-keluar-alasan-bawaan.json"
        ))
        .expect("hr-keluar-alasan-bawaan.json tidak valid")
    })
}

/// Cermin `SEED_ALASAN_SQL`. Tabel khusus cloud, jadi aman di-seed; alasan
/// yang sudah disunting tidak ditimpa.
pub const SEED_ALASAN_SQL: &str = "INSERT OR IGNORE INTO hr_keluar_alasan (id_alasan, nama, pengali_up, pengali_upmk, uph, kompensasi_pkwt, uang_pisah, dasar_hukum) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);";

pub fn seed_alasan_args(alasan: &AlasanBawaan) -> Vec<Value> {
    vec![
        json!(alasan.id_alasan),
        json!(alasan.nama),
        json!(alasan.pengali_up),
        json!(alasan.pengali_upmk),
        json!(i64::from(alasan.uph)),
        json!(i64::from(alasan.kompensasi_pkwt)),
        json!(i64::from(alasan.uang_pisah)),
        json!(alasan.dasar_hukum),
    ]
}

// ── Aturan murni (cermin `validations/hr-keluar.ts`) ───────────────────────

pub const TINGKAT_SP: [&str; 3] = ["SP1", "SP2", "SP3"];
/// WAJIB sama dengan CHECK `hr_keluar_rincian.komponen`; urutannya urutan tampil.
pub const KOMPONEN_RINCIAN: [&str; 8] = [
    "UP",
    "UPMK",
    "UPH Cuti",
    "UPH Ongkos Pulang",
    "UPH Lainnya",
    "Kompensasi PKWT",
    "Uang Pisah",
    "Lainnya",
];
pub const MAKS_PELANGGARAN: usize = 2000;
pub const MAKS_TEKS_KELUAR: usize = 1000;
pub const MAKS_NOMOR_SP: usize = 100;
pub const MAKS_NAMA_KELUAR: usize = 100;
pub const MAKS_UPAH: i64 = 1_000_000_000;
pub const MAKS_NOMINAL_RINCIAN: i64 = 100_000_000_000;
pub const MAKS_PENGALI: i64 = 1000;
/// Upah sebulan pekerja harian = 30 × upah sehari (Q-66).
pub const HARI_UPAH_SEBULAN: i64 = 30;
/// Upah sebulan pekerja per jam = tarif × 173 (Q-66).
pub const JAM_UPAH_SEBULAN: i64 = 173;

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

fn teks_opsional(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<Option<String>, String> {
    match payload_text(draft, kunci) {
        Some(t) if panjang(&t) > maks => Err(format!("{label} maksimal {maks} karakter.")),
        lain => Ok(lain),
    }
}

fn teks_wajib(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<String, String> {
    teks_opsional(draft, kunci, label, maks)?.ok_or_else(|| format!("{label} wajib diisi."))
}

fn tambah_hari(tanggal: &str, n: i64) -> Option<String> {
    time_policy::add_days(tanggal, n).ok()
}

/// Cermin `akhirMasaSp`: hari terakhir SP berlaku (inklusif).
pub fn akhir_masa_sp(tanggal: &str, masa_bulan: i64) -> Option<String> {
    tambah_hari(&tambah_bulan(tanggal, masa_bulan)?, -1)
}

/// Cermin `statusSp`. Tidak disimpan.
pub fn status_sp(tanggal: &str, berlaku_sampai: &str, dicabut: bool, hari_ini: &str) -> &'static str {
    if dicabut {
        "Dicabut"
    } else if tanggal <= hari_ini && hari_ini <= berlaku_sampai {
        "Berlaku"
    } else {
        "Berakhir"
    }
}

#[derive(Clone, Debug)]
pub struct SpRingkas {
    pub tingkat: String,
    pub tanggal: String,
    pub berlaku_sampai: String,
    pub dicabut: bool,
}

/// Cermin `usulanTingkat`: SP Berlaku tertinggi pada `tanggal` + 1, maksimal
/// SP3. Nilai kedua benar bila SP3 masih Berlaku (saatnya proses keluar).
pub fn usulan_tingkat(sp: &[SpRingkas], tanggal: &str) -> (&'static str, bool) {
    let tertinggi = sp
        .iter()
        .filter(|s| status_sp(&s.tanggal, &s.berlaku_sampai, s.dicabut, tanggal) == "Berlaku")
        .filter_map(|s| TINGKAT_SP.iter().position(|t| *t == s.tingkat))
        .max();
    match tertinggi {
        None => ("SP1", false),
        Some(0) => ("SP2", false),
        Some(1) => ("SP3", false),
        Some(_) => ("SP3", true),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpSah {
    pub id_sp: Option<String>,
    pub id_karyawan: String,
    pub tingkat: String,
    pub tanggal: String,
    pub nomor: Option<String>,
    pub pelanggaran: String,
    pub harapan: Option<String>,
    pub alasan_tingkat: Option<String>,
    pub penanda_nama: String,
    pub penanda_jabatan: String,
}

/// Cermin `validasiSp`. Usulan tingkat dan tanggal masuk diperiksa pemanggil.
pub fn validasi_sp(draft: &Value, hari_ini: &str) -> Result<SpSah, String> {
    let id_karyawan = payload_text(draft, "id_karyawan").ok_or("Karyawan wajib dipilih.")?;
    let tingkat = payload_text(draft, "tingkat")
        .filter(|t| TINGKAT_SP.contains(&t.as_str()))
        .ok_or("Tingkat SP tidak dikenal.")?;
    let tanggal = payload_text(draft, "tanggal")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal SP tidak valid.")?;
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal SP tidak boleh di masa depan.".into());
    }
    Ok(SpSah {
        id_sp: payload_text(draft, "id_sp"),
        id_karyawan,
        tingkat,
        tanggal,
        nomor: teks_opsional(draft, "nomor", "Nomor surat", MAKS_NOMOR_SP)?,
        pelanggaran: teks_wajib(draft, "pelanggaran", "Pelanggaran", MAKS_PELANGGARAN)?,
        harapan: teks_opsional(draft, "harapan", "Perbaikan yang diminta", MAKS_TEKS_KELUAR)?,
        alasan_tingkat: teks_opsional(draft, "alasan_tingkat", "Alasan tingkat", MAKS_TEKS_KELUAR)?,
        penanda_nama: teks_wajib(draft, "penanda_nama", "Nama penanda tangan", MAKS_NAMA_KELUAR)?,
        penanda_jabatan: teks_wajib(draft, "penanda_jabatan", "Jabatan penanda tangan", MAKS_NAMA_KELUAR)?,
    })
}

/// Cermin `periksaTingkat`: tingkat lain dari usulan wajib beralasan.
pub fn periksa_tingkat(tingkat: &str, usulan: &str, alasan: Option<&str>) -> Result<(), String> {
    if tingkat != usulan && alasan.is_none() {
        return Err(format!("Tingkat berbeda dari usulan ({usulan}); alasannya wajib diisi."));
    }
    Ok(())
}

/// Cermin `statusKeluar`. Tidak disimpan.
pub fn status_keluar(tanggal_terakhir: &str, berlaku: bool, dibatalkan: bool, hari_ini: &str) -> &'static str {
    if dibatalkan {
        "Dibatalkan"
    } else if berlaku {
        "Berlaku"
    } else if tanggal_terakhir <= hari_ini {
        "Jatuh tempo"
    } else {
        "Dijadwalkan"
    }
}

/// Cermin `bulanPenuh`: n terbesar dengan `tambah_bulan(mulai, n)` ≤ `akhir`.
pub fn bulan_penuh(mulai: &str, akhir: &str) -> i64 {
    let ym = |t: &str| -> Option<i64> {
        Some(t.get(0..4)?.parse::<i64>().ok()? * 12 + t.get(5..7)?.parse::<i64>().ok()?)
    };
    let (Some(a), Some(b)) = (ym(mulai), ym(akhir)) else {
        return 0;
    };
    let mut n = b - a;
    while n > 0 && tambah_bulan(mulai, n).map_or(true, |t| t.as_str() > akhir) {
        n -= 1;
    }
    n.max(0)
}

/// Cermin `masaKerjaBulan`: bulan penuh dari `mulai` sampai hari sesudah
/// `tanggal_terakhir` (eksklusif).
pub fn masa_kerja_bulan(mulai: &str, tanggal_terakhir: &str) -> i64 {
    if !is_valid_date(mulai) || !is_valid_date(tanggal_terakhir) {
        return 0;
    }
    tambah_hari(tanggal_terakhir, 1).map(|akhir| bulan_penuh(mulai, &akhir)).unwrap_or(0)
}

/// Cermin `usulanUpahPokok` (Q-66).
pub fn usulan_upah_pokok(salary_type: &str, daily_rate: i64, rate_per_hour: i64) -> i64 {
    let upah = if salary_type == "FLAT_DAILY" {
        daily_rate.max(0) * HARI_UPAH_SEBULAN
    } else {
        rate_per_hour.max(0) * JAM_UPAH_SEBULAN
    };
    upah.min(MAKS_UPAH)
}

/// Kelipatan UP menurut tahun masa kerja (PP 35/2021 Pasal 40 ayat 2).
pub fn kelipatan_up(tahun: i64) -> i64 {
    (tahun + 1).clamp(1, 9)
}

/// Kelipatan UPMK menurut tahun masa kerja (PP 35/2021 Pasal 40 ayat 3).
pub fn kelipatan_upmk(tahun: i64) -> i64 {
    if tahun < 3 {
        0
    } else if tahun >= 24 {
        10
    } else {
        tahun / 3 + 1
    }
}

#[derive(Clone, Debug, Default)]
pub struct MasukanPesangon {
    /// Upah pokok + tunjangan tetap.
    pub upah: i64,
    pub masa_kerja_mulai: Option<String>,
    pub tanggal_terakhir: String,
    pub pengali_up: i64,
    pub pengali_upmk: i64,
    pub uph: bool,
    pub kompensasi_pkwt: bool,
    pub uang_pisah: bool,
    pub sisa_cuti: i64,
    pub upah_harian: i64,
    /// Tanggal mulai kontrak PKWT yang berlaku pada tanggal terakhir.
    pub pkwt_mulai: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Usulan {
    pub komponen: &'static str,
    pub dasar: Option<String>,
    pub usulan: i64,
}

/// Cermin `usulanPesangon` (§20.5). Bilangan bulat, dibulatkan ke rupiah
/// terdekat (setengah ke atas). Urutan hasil = urutan `KOMPONEN_RINCIAN`.
pub fn usulan_pesangon(m: &MasukanPesangon) -> Vec<Usulan> {
    let upah = m.upah.clamp(0, MAKS_UPAH);
    let mut hasil = Vec::new();
    let mulai = m.masa_kerja_mulai.as_deref().filter(|t| is_valid_date(t));
    match mulai {
        Some(mulai) => {
            let tahun = masa_kerja_bulan(mulai, &m.tanggal_terakhir) / 12;
            for (komponen, kelipatan, pengali) in [
                ("UP", kelipatan_up(tahun), m.pengali_up),
                ("UPMK", kelipatan_upmk(tahun), m.pengali_upmk),
            ] {
                hasil.push(Usulan {
                    komponen,
                    dasar: Some(format!("Masa kerja {tahun} tahun: {kelipatan} × upah × {pengali}%")),
                    usulan: (upah * kelipatan * pengali + 50) / 100,
                });
            }
        }
        None => {
            for komponen in ["UP", "UPMK"] {
                hasil.push(Usulan { komponen, dasar: Some("Tanggal masuk kosong".into()), usulan: 0 });
            }
        }
    }
    if m.uph {
        let sisa = m.sisa_cuti.max(0);
        hasil.push(Usulan {
            komponen: "UPH Cuti",
            dasar: Some(format!("Sisa cuti {sisa} hari × upah harian")),
            usulan: sisa * m.upah_harian.max(0),
        });
        for komponen in ["UPH Ongkos Pulang", "UPH Lainnya"] {
            hasil.push(Usulan { komponen, dasar: None, usulan: 0 });
        }
    }
    if m.kompensasi_pkwt {
        if let Some(pkwt) = m.pkwt_mulai.as_deref().filter(|t| is_valid_date(t)) {
            let bulan = masa_kerja_bulan(pkwt, &m.tanggal_terakhir).max(1);
            hasil.push(Usulan {
                komponen: "Kompensasi PKWT",
                dasar: Some(format!("PKWT {bulan} bulan: upah × {bulan} / 12")),
                usulan: (upah * bulan + 6) / 12,
            });
        }
    }
    if m.uang_pisah {
        hasil.push(Usulan { komponen: "Uang Pisah", dasar: None, usulan: 0 });
    }
    hasil.push(Usulan { komponen: "Lainnya", dasar: None, usulan: 0 });
    hasil
}

#[derive(Clone, Debug, PartialEq)]
pub struct IsianRincian {
    pub komponen: String,
    pub nominal: i64,
    pub alasan_ubah: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RincianSah {
    pub komponen: &'static str,
    pub dasar: Option<String>,
    pub usulan: i64,
    pub nominal: i64,
    pub alasan_ubah: Option<String>,
    pub urutan: i64,
}

/// Cermin `susunRincian`: setiap baris usulan mendapat nominalnya (bawaan =
/// usulan); nominal lain dari usulan wajib beralasan.
pub fn susun_rincian(usulan: &[Usulan], isian: &[IsianRincian]) -> Result<Vec<RincianSah>, String> {
    if let Some(asing) = isian.iter().find(|i| !usulan.iter().any(|u| u.komponen == i.komponen)) {
        return Err(format!("Komponen '{}' tidak berlaku untuk alasan ini.", asing.komponen));
    }
    usulan
        .iter()
        .enumerate()
        .map(|(urutan, u)| {
            let isi = isian.iter().find(|i| i.komponen == u.komponen);
            let nominal = isi.map(|i| i.nominal).unwrap_or(u.usulan);
            if !(0..=MAKS_NOMINAL_RINCIAN).contains(&nominal) {
                return Err(format!("Nominal {} tidak valid.", u.komponen));
            }
            let alasan_ubah = isi.and_then(|i| i.alasan_ubah.clone()).filter(|_| nominal != u.usulan);
            if nominal != u.usulan && alasan_ubah.is_none() {
                return Err(format!("Nominal {} berbeda dari usulan; alasannya wajib diisi.", u.komponen));
            }
            Ok(RincianSah {
                komponen: u.komponen,
                dasar: u.dasar.clone(),
                usulan: u.usulan,
                nominal,
                alasan_ubah,
                urutan: urutan as i64 + 1,
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeluarSah {
    pub id_keluar: Option<String>,
    pub id_karyawan: String,
    pub id_alasan: String,
    pub id_sp: Option<String>,
    pub tanggal_pemberitahuan: Option<String>,
    pub tanggal_terakhir: String,
    pub keterangan: Option<String>,
    /// Kosong = pakai usulan.
    pub upah_pokok: Option<i64>,
    pub alasan_upah: Option<String>,
    pub tunjangan_tetap: i64,
    pub kartu_ditarik: bool,
    pub catatan_checklist: Option<String>,
    pub rincian: Vec<IsianRincian>,
}

fn rupiah(draft: &Value, kunci: &str, label: &str, maks: i64) -> Result<Option<i64>, String> {
    match draft.get(kunci) {
        None | Some(Value::Null) => Ok(None),
        Some(nilai) => nilai
            .as_i64()
            .filter(|n| (0..=maks).contains(n))
            .map(Some)
            .ok_or_else(|| format!("{label} tidak valid.")),
    }
}

/// Cermin `validasiKeluar`. Hanya bentuk isian; usulan dihitung pemanggil.
pub fn validasi_keluar(draft: &Value) -> Result<KeluarSah, String> {
    let id_karyawan = payload_text(draft, "id_karyawan").ok_or("Karyawan wajib dipilih.")?;
    let id_alasan = payload_text(draft, "id_alasan").ok_or("Alasan keluar wajib dipilih.")?;
    let tanggal_terakhir = payload_text(draft, "tanggal_terakhir")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal hari kerja terakhir tidak valid.")?;
    let tanggal_pemberitahuan = payload_text(draft, "tanggal_pemberitahuan");
    if let Some(t) = &tanggal_pemberitahuan {
        if !is_valid_date(t) {
            return Err("Tanggal pemberitahuan tidak valid.".into());
        }
        if *t > tanggal_terakhir {
            return Err("Tanggal pemberitahuan tidak boleh sesudah hari kerja terakhir.".into());
        }
    }
    let upah_pokok = rupiah(draft, "upah_pokok", "Upah pokok", MAKS_UPAH)?;
    let tunjangan_tetap = rupiah(draft, "tunjangan_tetap", "Tunjangan tetap", MAKS_UPAH)?.unwrap_or(0);
    if upah_pokok.unwrap_or(0) + tunjangan_tetap > MAKS_UPAH {
        return Err("Upah pokok + tunjangan tetap terlalu besar.".into());
    }
    let mut rincian = Vec::new();
    if let Some(daftar) = draft.get("rincian").filter(|v| !v.is_null()) {
        for baris in daftar.as_array().ok_or("Rincian tidak valid.")? {
            let komponen = payload_text(baris, "komponen")
                .filter(|k| KOMPONEN_RINCIAN.contains(&k.as_str()))
                .ok_or("Komponen rincian tidak dikenal.")?;
            if rincian.iter().any(|r: &IsianRincian| r.komponen == komponen) {
                return Err(format!("Komponen {komponen} tercantum dua kali."));
            }
            let nominal = rupiah(baris, "nominal", &format!("Nominal {komponen}"), MAKS_NOMINAL_RINCIAN)?
                .ok_or_else(|| format!("Nominal {komponen} tidak valid."))?;
            rincian.push(IsianRincian {
                alasan_ubah: teks_opsional(baris, "alasan_ubah", "Alasan perubahan", MAKS_TEKS_KELUAR)?,
                komponen,
                nominal,
            });
        }
    }
    Ok(KeluarSah {
        id_keluar: payload_text(draft, "id_keluar"),
        id_karyawan,
        id_alasan,
        id_sp: payload_text(draft, "id_sp"),
        tanggal_pemberitahuan,
        tanggal_terakhir,
        keterangan: teks_opsional(draft, "keterangan", "Keterangan", MAKS_TEKS_KELUAR)?,
        upah_pokok,
        alasan_upah: teks_opsional(draft, "alasan_upah", "Alasan upah", MAKS_TEKS_KELUAR)?,
        tunjangan_tetap,
        kartu_ditarik: draft.get("kartu_ditarik").and_then(Value::as_bool).unwrap_or(false),
        catatan_checklist: teks_opsional(draft, "catatan_checklist", "Catatan checklist", MAKS_TEKS_KELUAR)?,
        rincian,
    })
}

/// Cermin `periksaUpah`: upah pokok lain dari usulan wajib beralasan.
pub fn periksa_upah(upah_pokok: i64, usulan: i64, alasan: Option<&str>) -> Result<(), String> {
    if upah_pokok != usulan && alasan.is_none() {
        return Err("Upah pokok berbeda dari usulan; alasannya wajib diisi.".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct AlasanSah {
    pub id_alasan: Option<String>,
    pub nama: String,
    pub pengali_up: i64,
    pub pengali_upmk: i64,
    pub uph: bool,
    pub kompensasi_pkwt: bool,
    pub uang_pisah: bool,
    pub dasar_hukum: Option<String>,
    pub is_aktif: bool,
}

/// Cermin `validasiAlasan`.
pub fn validasi_alasan(draft: &Value) -> Result<AlasanSah, String> {
    let pengali = |kunci: &str, label: &str| -> Result<i64, String> {
        draft
            .get(kunci)
            .and_then(Value::as_i64)
            .filter(|n| (0..=MAKS_PENGALI).contains(n))
            .ok_or_else(|| format!("{label} harus bilangan bulat 0–{MAKS_PENGALI} (persen)."))
    };
    let benar = |kunci: &str, bawaan: bool| draft.get(kunci).and_then(Value::as_bool).unwrap_or(bawaan);
    Ok(AlasanSah {
        id_alasan: payload_text(draft, "id_alasan"),
        nama: teks_wajib(draft, "nama", "Nama alasan", MAKS_NAMA_KELUAR)?,
        pengali_up: pengali("pengali_up", "Pengali UP")?,
        pengali_upmk: pengali("pengali_upmk", "Pengali UPMK")?,
        uph: benar("uph", true),
        kompensasi_pkwt: benar("kompensasi_pkwt", false),
        uang_pisah: benar("uang_pisah", false),
        dasar_hukum: teks_opsional(draft, "dasar_hukum", "Dasar hukum", MAKS_TEKS_KELUAR)?,
        is_aktif: benar("is_aktif", true),
    })
}

// ── SQL kembar (teks diperiksa identik oleh `hr-keluar.test.ts`) ───────────

/// Barang yang dipinjam satu personil dan belum kembali penuh (`?1` = id).
pub const PINJAMAN_PERSONIL_SQL: &str = "SELECT * FROM (SELECT p.id_mutasi, b.nama_barang, b.kode_barang, b.satuan, p.tanggal, p.jumlah, COALESCE((SELECT SUM(r.jumlah) FROM inventory_mutasi r WHERE r.id_ref = p.id_mutasi AND r.alasan = 'Pengembalian' AND NOT EXISTS (SELECT 1 FROM inventory_mutasi rb WHERE rb.id_mutasi = 'batal-' || r.id_mutasi)), 0) AS kembali, b.desimal FROM inventory_mutasi p JOIN inventory_barang b ON b.id_barang = p.id_barang WHERE p.alasan = 'Peminjaman' AND p.penerima_tipe = 'Personil' AND p.penerima_id = ?1 AND NOT EXISTS (SELECT 1 FROM inventory_mutasi pb WHERE pb.id_mutasi = 'batal-' || p.id_mutasi)) WHERE jumlah > kembali ORDER BY tanggal, id_mutasi LIMIT 200;";

/// Karyawan yang ikut rekap gaji (Q-67): Aktif, atau sudah keluar dengan hari
/// kerja terakhir pada/sesudah awal periode. `{mulai}` = awal periode.
pub const KARYAWAN_REKAP_SQL: &str = "(md.status_aktif = 'Aktif' OR (COALESCE(md.id_keluar, '') <> '' AND md.tanggal_selesai_aktif >= {mulai}))";

pub fn karyawan_rekap(mulai: &str) -> String {
    KARYAWAN_REKAP_SQL.replace("{mulai}", mulai)
}

/// Status yang boleh ditulis jalur `employee/*` (melawan zombie, aturan 33):
/// selama `id_keluar` terisi, status tetap Nonaktif. `{baru}` = nilai kiriman.
pub const STATUS_AKTIF_KELUAR_SQL: &str = "CASE WHEN COALESCE(master_data.id_keluar, '') <> '' THEN 'Nonaktif' ELSE {baru} END";
/// Padanan untuk `tanggal_selesai_aktif`.
pub const TANGGAL_SELESAI_KELUAR_SQL: &str = "CASE WHEN COALESCE(master_data.id_keluar, '') <> '' THEN master_data.tanggal_selesai_aktif ELSE {baru} END";

pub fn status_aktif_keluar(baru: &str) -> String {
    STATUS_AKTIF_KELUAR_SQL.replace("{baru}", baru)
}

pub fn tanggal_selesai_keluar(baru: &str) -> String {
    TANGGAL_SELESAI_KELUAR_SQL.replace("{baru}", baru)
}

pub const PESAN_SUDAH_KELUAR: &str =
    "Karyawan ini sudah keluar. Batalkan proses keluarnya di HRIS untuk mengaktifkannya lagi.";

// ── Data lokal: usulan pesangon dan checklist (§20.4, §20.5) ───────────────
//
// Semua masukannya tabel tersinkron, jadi dibaca dari SQLite perangkat lalu
// dikirim ke fungsi cloud sebagai nilai biasa: koneksi rusqlite tidak boleh
// hidup melewati `await`.

/// Pengajuan yang tidak dibatalkan/ditolak dan masih berjalan sesudah hari
/// kerja terakhir (`?1` = karyawan, `?2` = tanggal terakhir).
pub const PENGAJUAN_SESUDAH_SQL: &str = "SELECT p.id_pengajuan, p.tanggal_mulai, p.tanggal_selesai, COALESCE(j.nama, p.kelompok) AS jenis FROM hr_pengajuan p LEFT JOIN hr_jenis_pengajuan j ON j.id_jenis = p.id_jenis WHERE p.id_karyawan = ?1 AND p.tanggal_selesai > ?2 AND p.kelompok <> 'Reimburse' AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis IN ('Batal', 'Tolak')) ORDER BY p.tanggal_mulai, p.id_pengajuan LIMIT 100;";

/// Masukan usulan pesangon yang dibaca dari data karyawan.
#[derive(Clone, Debug, Default)]
pub struct DataKaryawan {
    pub tanggal_daftar: Option<String>,
    pub usulan_upah_pokok: i64,
    pub sisa_cuti: i64,
    pub upah_harian: i64,
    pub pkwt_mulai: Option<String>,
    /// Komponen tunjangan aktif karyawan itu, hanya acuan bagi HRD.
    pub tunjangan_acuan: Vec<Value>,
}

fn internal<E>(_: E) -> CommandError {
    CommandError::internal()
}

/// Cermin `dataKaryawan` (`services/hr-keluar.ts`).
pub fn data_karyawan(conn: &Connection, id_karyawan: &str, tanggal_terakhir: &str) -> Result<DataKaryawan, CommandError> {
    let tanggal_daftar: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(tanggal_daftar), '') FROM master_data WHERE id_unik = ?1;",
            params![id_karyawan],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?
        .flatten();
    let gaji: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(salary_type, 'HOURLY'), COALESCE(daily_rate, 0), COALESCE(rate_per_hour, 0) FROM salary_configs
             WHERE id_karyawan = ?1 AND effective_date <= ?2 ORDER BY effective_date DESC LIMIT 1;",
            params![id_karyawan, tanggal_terakhir],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(internal)?;
    let (sisa_cuti, upah_harian) = hr_pengajuan::sisa_cuti_keluar(conn, id_karyawan, tanggal_terakhir)?;
    let kontrak: Vec<hris::Kontrak> = hris::baca_kontrak(conn, Some(id_karyawan))?
        .into_iter()
        .map(|(_, k, _)| k)
        .collect();
    let status = hris::status_kerja(&kontrak, tanggal_terakhir);
    let pkwt_mulai = (status["jenis"] == "PKWT")
        .then(|| status["id_kontrak"].as_str().map(str::to_owned))
        .flatten()
        .and_then(|id| kontrak.iter().find(|k| k.id_kontrak == id).map(|k| k.tanggal_mulai.clone()));
    let tunjangan_acuan = hris::baris_json(
        conn,
        "SELECT name, calc_type, default_value FROM payroll_components WHERE category = 'ALLOWANCE' AND is_active = 1 AND applies_to IN ('ALL', ?1) ORDER BY name;",
        Some(id_karyawan),
    )?;
    Ok(DataKaryawan {
        tanggal_daftar,
        usulan_upah_pokok: gaji.map(|(t, d, r)| usulan_upah_pokok(&t, d, r)).unwrap_or(0),
        sisa_cuti,
        upah_harian,
        pkwt_mulai,
        tunjangan_acuan,
    })
}

/// Checklist keluar dari modul yang ada (cermin `checklistKeluar`). Tidak
/// menolak apa pun: hanya daftar untuk dibereskan.
pub fn checklist_lokal(conn: &Connection, id_karyawan: &str, tanggal_terakhir: &str) -> Result<Value, CommandError> {
    let barang = hris::baris_json(conn, PINJAMAN_PERSONIL_SQL, Some(id_karyawan))?;
    let kasbon = loan::sisa_kasbon_karyawan(conn, id_karyawan)?;
    let (pembayaran, baris) = hr_pengajuan::muat_bayar(conn)?;
    let gaji = hr_pengajuan::muat_gaji_reimburse(conn)?;
    let klaim: Vec<Value> = hr_pengajuan::muat_klaim(conn, "9999-12-31")?
        .into_iter()
        .filter(|k| k.id_karyawan == id_karyawan)
        .filter_map(|k| {
            let status = hr_pengajuan::status_bayar(&k.id_klaim, &pembayaran, &baris, &gaji);
            (status != hr_pengajuan::STATUS_DIBAYAR).then(|| {
                json!({
                    "id_klaim": k.id_klaim, "sumber": k.sumber, "tanggal": k.tanggal,
                    "nominal": k.nominal, "keterangan": k.keterangan, "status_bayar": status,
                })
            })
        })
        .collect();
    let mut st = conn.prepare(PENGAJUAN_SESUDAH_SQL).map_err(internal)?;
    let pengajuan: Vec<Value> = st
        .query_map(params![id_karyawan, tanggal_terakhir], |r| {
            Ok(json!({
                "id_pengajuan": r.get::<_, String>(0)?,
                "tanggal_mulai": r.get::<_, String>(1)?,
                "tanggal_selesai": r.get::<_, String>(2)?,
                "jenis": r.get::<_, String>(3)?,
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let sisa_kasbon: i64 = kasbon.iter().filter_map(|k| k["sisa"].as_i64()).sum();
    Ok(json!({
        "barang": barang,
        "kasbon": kasbon,
        "sisa_kasbon": sisa_kasbon,
        "klaim": klaim,
        "pengajuan": pengajuan,
    }))
}

/// Data usulan dan checklist satu karyawan dari SQLite perangkat. Koneksinya
/// dibuka dan ditutup di sini, tidak pernah melewati `await`.
pub fn muat_lokal(state: &DesktopState, id_karyawan: &str, tanggal_terakhir: &str) -> Result<(DataKaryawan, Value), CommandError> {
    let conn = storage::database(&state.data_dir)?;
    Ok((
        data_karyawan(&conn, id_karyawan, tanggal_terakhir)?,
        checklist_lokal(&conn, id_karyawan, tanggal_terakhir)?,
    ))
}

// ── Khusus cloud (Q-63) ────────────────────────────────────────────────────

type Baris = HashMap<String, Value>;

fn teks_baris(baris: &Baris, kunci: &str) -> Option<String> {
    baris
        .get(kunci)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

fn angka_baris(baris: &Baris, kunci: &str) -> i64 {
    baris.get(kunci).and_then(Value::as_i64).unwrap_or(0)
}

async fn hari_ini_cloud(turso: &TursoClient) -> Result<String, CommandError> {
    objek(turso, "SELECT date('now', '+7 hours') AS hari;", vec![])
        .await?
        .first()
        .and_then(|b| teks_baris(b, "hari"))
        .ok_or_else(CommandError::internal)
}

async fn karyawan_cloud(turso: &TursoClient, id: &str) -> Result<Baris, CommandError> {
    objek(
        turso,
        "SELECT id_unik, nama, divisi, jabatan_status, status_aktif, tanggal_daftar, id_keluar FROM master_data WHERE id_unik = ?1;",
        vec![json!(id)],
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| invalid("Karyawan tidak ditemukan."))
}

fn tolak_diri_sendiri(sesi_karyawan: Option<&str>, id_karyawan: &str) -> Result<(), CommandError> {
    if sesi_karyawan == Some(id_karyawan) {
        return Err(invalid("Tindakan ini tidak bisa dilakukan untuk diri sendiri."));
    }
    Ok(())
}

async fn masa_sp(turso: &TursoClient) -> Result<i64, CommandError> {
    Ok(objek(turso, "SELECT value FROM setting_gex_system WHERE key = ?1;", vec![json!(hris::KUNCI_SP_MASA_BULAN)])
        .await?
        .first()
        .and_then(|b| teks_baris(b, "value"))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|n| (1..=12).contains(n))
        .unwrap_or(hris::PengaturanKontrak::default().sp_masa_bulan))
}

fn sp_ringkas(baris: &[Baris]) -> Vec<SpRingkas> {
    baris
        .iter()
        .map(|b| SpRingkas {
            tingkat: teks_baris(b, "tingkat").unwrap_or_default(),
            tanggal: teks_baris(b, "tanggal").unwrap_or_default(),
            berlaku_sampai: teks_baris(b, "berlaku_sampai").unwrap_or_default(),
            dicabut: teks_baris(b, "dicabut_pada").is_some(),
        })
        .collect()
}

fn dengan_status_sp(mut baris: Baris, hari_ini: &str) -> Baris {
    let status = status_sp(
        &teks_baris(&baris, "tanggal").unwrap_or_default(),
        &teks_baris(&baris, "berlaku_sampai").unwrap_or_default(),
        teks_baris(&baris, "dicabut_pada").is_some(),
        hari_ini,
    );
    baris.insert("status".into(), json!(status));
    baris
}

/// SP satu karyawan (riwayat, usulan tingkat, kop cetak), atau seluruh SP
/// bersama nama karyawannya bila `id_karyawan` kosong.
pub async fn daftar_sp(turso: &TursoClient, id_karyawan: Option<&str>) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let Some(id) = id_karyawan else {
        let semua = objek(
            turso,
            "SELECT s.*, m.nama, m.divisi FROM hr_sp s LEFT JOIN master_data m ON m.id_unik = s.id_karyawan ORDER BY s.tanggal DESC, s.created_at DESC LIMIT 500;",
            vec![],
        )
        .await?;
        let sp: Vec<Baris> = semua.into_iter().map(|b| dengan_status_sp(b, &hari_ini)).collect();
        return Ok(json!({ "sp": sp, "hari_ini": hari_ini }));
    };
    let baris = objek(
        turso,
        "SELECT * FROM hr_sp WHERE id_karyawan = ?1 ORDER BY tanggal DESC, created_at DESC;",
        vec![json!(id)],
    )
    .await?;
    let (tingkat, sp3_berlaku) = usulan_tingkat(&sp_ringkas(&baris), &hari_ini);
    let penanda = baris.first().map(|b| {
        json!({ "nama": b.get("penanda_nama"), "jabatan": b.get("penanda_jabatan") })
    });
    let kop = objek(
        turso,
        "SELECT company_name, logo_url, address FROM company_profile WHERE id = 'default_company';",
        vec![],
    )
    .await?
    .into_iter()
    .next();
    let sp: Vec<Baris> = baris.into_iter().map(|b| dengan_status_sp(b, &hari_ini)).collect();
    Ok(json!({
        "sp": sp,
        "usulan": { "tingkat": tingkat, "sp3_berlaku": sp3_berlaku },
        "masa_bulan": masa_sp(turso).await?,
        "penanda_terakhir": penanda,
        "kop": kop,
        "hari_ini": hari_ini,
    }))
}

/// Buat SP baru, atau ubah teks SP yang belum dicabut (`hr.warning.manage`).
pub async fn simpan_sp(
    turso: &TursoClient,
    sesi_karyawan: Option<&str>,
    oleh: &str,
    draft: &Value,
) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let sah = validasi_sp(draft, &hari_ini).map_err(invalid)?;
    tolak_diri_sendiri(sesi_karyawan, &sah.id_karyawan)?;
    if let Some(id_sp) = &sah.id_sp {
        let lama = objek(turso, "SELECT * FROM hr_sp WHERE id_sp = ?1;", vec![json!(id_sp)])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| invalid("SP tidak ditemukan."))?;
        if teks_baris(&lama, "dicabut_pada").is_some() {
            return Err(invalid("SP ini sudah dicabut."));
        }
        if teks_baris(&lama, "id_karyawan").as_deref() != Some(sah.id_karyawan.as_str())
            || teks_baris(&lama, "tingkat").as_deref() != Some(sah.tingkat.as_str())
            || teks_baris(&lama, "tanggal").as_deref() != Some(sah.tanggal.as_str())
        {
            return Err(invalid("Tingkat dan tanggal SP tidak bisa diubah. Cabut SP ini lalu buat yang baru."));
        }
        turso
            .query_one(
                "UPDATE hr_sp SET nomor = ?2, pelanggaran = ?3, harapan = ?4, penanda_nama = ?5, penanda_jabatan = ?6,
                        diubah_oleh = ?7, diubah_pada = datetime('now')
                 WHERE id_sp = ?1 AND dicabut_pada IS NULL;",
                vec![
                    json!(id_sp),
                    json!(sah.nomor),
                    json!(sah.pelanggaran),
                    json!(sah.harapan),
                    json!(sah.penanda_nama),
                    json!(sah.penanda_jabatan),
                    json!(oleh),
                ],
            )
            .await
            .map_err(tak_terhubung)?;
        return Ok(json!({ "sukses": true, "id_sp": id_sp }));
    }
    let karyawan = karyawan_cloud(turso, &sah.id_karyawan).await?;
    if teks_baris(&karyawan, "status_aktif").as_deref() != Some("Aktif") {
        return Err(invalid("SP hanya untuk karyawan aktif."));
    }
    if teks_baris(&karyawan, "tanggal_daftar").is_some_and(|masuk| sah.tanggal < masuk) {
        return Err(invalid("Tanggal SP tidak boleh sebelum tanggal masuk karyawan."));
    }
    let riwayat = objek(
        turso,
        "SELECT tingkat, tanggal, berlaku_sampai, dicabut_pada FROM hr_sp WHERE id_karyawan = ?1;",
        vec![json!(sah.id_karyawan)],
    )
    .await?;
    let (usulan, _) = usulan_tingkat(&sp_ringkas(&riwayat), &sah.tanggal);
    periksa_tingkat(&sah.tingkat, usulan, sah.alasan_tingkat.as_deref()).map_err(invalid)?;
    let masa_bulan = masa_sp(turso).await?;
    let berlaku_sampai = akhir_masa_sp(&sah.tanggal, masa_bulan).ok_or_else(|| invalid("Tanggal SP tidak valid."))?;
    let id_sp = new_hex_id("sp-");
    turso
        .query_one(
            "INSERT INTO hr_sp (id_sp, id_karyawan, tingkat, tanggal, masa_bulan, berlaku_sampai, nomor, pelanggaran, harapan,
                                usulan_tingkat, alasan_tingkat, penanda_nama, penanda_jabatan, dicatat_oleh)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14);",
            vec![
                json!(id_sp),
                json!(sah.id_karyawan),
                json!(sah.tingkat),
                json!(sah.tanggal),
                json!(masa_bulan),
                json!(berlaku_sampai),
                json!(sah.nomor),
                json!(sah.pelanggaran),
                json!(sah.harapan),
                json!(usulan),
                json!(sah.alasan_tingkat.filter(|_| sah.tingkat != usulan)),
                json!(sah.penanda_nama),
                json!(sah.penanda_jabatan),
                json!(oleh),
            ],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_sp": id_sp }))
}

fn alasan_wajib(draft: &Value, label: &str) -> Result<String, CommandError> {
    teks_wajib(draft, "alasan", label, MAKS_TEKS_KELUAR).map_err(invalid)
}

/// Cabut SP dengan alasan (`hr.warning.cancel`), sekali.
pub async fn cabut_sp(
    turso: &TursoClient,
    sesi_karyawan: Option<&str>,
    oleh: &str,
    draft: &Value,
) -> Result<Value, CommandError> {
    let id_sp = payload_text(draft, "id_sp").ok_or_else(|| invalid("SP tidak ditemukan."))?;
    let alasan = alasan_wajib(draft, "Alasan pencabutan")?;
    siap(turso).await?;
    let lama = objek(turso, "SELECT id_karyawan, dicabut_pada FROM hr_sp WHERE id_sp = ?1;", vec![json!(id_sp)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("SP tidak ditemukan."))?;
    tolak_diri_sendiri(sesi_karyawan, &teks_baris(&lama, "id_karyawan").unwrap_or_default())?;
    if teks_baris(&lama, "dicabut_pada").is_some() {
        return Err(invalid("SP ini sudah dicabut."));
    }
    turso
        .query_one(
            "UPDATE hr_sp SET dicabut_oleh = ?2, dicabut_pada = datetime('now'), alasan_cabut = ?3 WHERE id_sp = ?1 AND dicabut_pada IS NULL;",
            vec![json!(id_sp), json!(oleh), json!(alasan)],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

/// Simpan alasan keluar (`hr.offboard.manage`); nama unik di aplikasi, tanpa hapus.
pub async fn simpan_alasan(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    let sah = validasi_alasan(draft).map_err(invalid)?;
    siap(turso).await?;
    let kembar = objek(
        turso,
        "SELECT 1 AS ada FROM hr_keluar_alasan WHERE LOWER(TRIM(nama)) = LOWER(?1) AND id_alasan <> COALESCE(?2, '');",
        vec![json!(sah.nama), json!(sah.id_alasan)],
    )
    .await?;
    if !kembar.is_empty() {
        return Err(invalid("Nama alasan itu sudah dipakai."));
    }
    let id = sah.id_alasan.clone().unwrap_or_else(|| new_hex_id("klr-"));
    turso
        .query_one(
            "INSERT INTO hr_keluar_alasan (id_alasan, nama, pengali_up, pengali_upmk, uph, kompensasi_pkwt, uang_pisah, dasar_hukum, is_aktif)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id_alasan) DO UPDATE SET nama = excluded.nama, pengali_up = excluded.pengali_up,
                pengali_upmk = excluded.pengali_upmk, uph = excluded.uph, kompensasi_pkwt = excluded.kompensasi_pkwt,
                uang_pisah = excluded.uang_pisah, dasar_hukum = excluded.dasar_hukum, is_aktif = excluded.is_aktif,
                updated_at = datetime('now');",
            vec![
                json!(id),
                json!(sah.nama),
                json!(sah.pengali_up),
                json!(sah.pengali_upmk),
                json!(i64::from(sah.uph)),
                json!(i64::from(sah.kompensasi_pkwt)),
                json!(i64::from(sah.uang_pisah)),
                json!(sah.dasar_hukum),
                json!(i64::from(sah.is_aktif)),
            ],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_alasan": id }))
}

fn dengan_status_keluar(mut baris: Baris, hari_ini: &str) -> Baris {
    let status = status_keluar(
        &teks_baris(&baris, "tanggal_terakhir").unwrap_or_default(),
        teks_baris(&baris, "berlaku_pada").is_some(),
        teks_baris(&baris, "dibatalkan_pada").is_some(),
        hari_ini,
    );
    baris.insert("status".into(), json!(status));
    baris
}

/// Daftar proses keluar dengan status turunan dan total rinciannya.
pub async fn daftar_keluar(turso: &TursoClient) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let baris = objek(
        turso,
        "SELECT k.id_keluar, k.id_karyawan, k.alasan_nama, k.tanggal_pemberitahuan, k.tanggal_terakhir, k.dicatat_oleh, k.created_at,
                k.berlaku_oleh, k.berlaku_pada, k.dibatalkan_oleh, k.dibatalkan_pada, k.alasan_batal, m.nama, m.divisi,
                COALESCE((SELECT SUM(r.nominal) FROM hr_keluar_rincian r WHERE r.id_keluar = k.id_keluar), 0) AS total
         FROM hr_keluar k LEFT JOIN master_data m ON m.id_unik = k.id_karyawan
         ORDER BY k.tanggal_terakhir DESC, k.created_at DESC LIMIT 500;",
        vec![],
    )
    .await?;
    let keluar: Vec<Baris> = baris.into_iter().map(|b| dengan_status_keluar(b, &hari_ini)).collect();
    let alasan = objek(turso, "SELECT * FROM hr_keluar_alasan ORDER BY is_aktif DESC, nama;", vec![]).await?;
    Ok(json!({ "keluar": keluar, "alasan": alasan, "hari_ini": hari_ini }))
}

async fn akun_tertaut(turso: &TursoClient, id_karyawan: &str) -> Result<Vec<Baris>, CommandError> {
    objek(
        turso,
        "SELECT m.id, m.username, m.nama_operator, m.status, COALESCE(r.is_superadmin, 0) AS is_superadmin
         FROM master_operator m LEFT JOIN app_role r ON r.id = m.role_id WHERE m.id_karyawan = ?1 ORDER BY m.username;",
        vec![json!(id_karyawan)],
    )
    .await
}

async fn alasan_satu(turso: &TursoClient, id: &str) -> Result<Baris, CommandError> {
    objek(turso, "SELECT * FROM hr_keluar_alasan WHERE id_alasan = ?1;", vec![json!(id)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Alasan keluar tidak ditemukan."))
}

fn masukan_pesangon(alasan: &Baris, data: &DataKaryawan, upah: i64, tanggal_terakhir: &str) -> MasukanPesangon {
    MasukanPesangon {
        upah,
        masa_kerja_mulai: data.tanggal_daftar.clone(),
        tanggal_terakhir: tanggal_terakhir.to_owned(),
        pengali_up: angka_baris(alasan, "pengali_up"),
        pengali_upmk: angka_baris(alasan, "pengali_upmk"),
        uph: angka_baris(alasan, "uph") == 1,
        kompensasi_pkwt: angka_baris(alasan, "kompensasi_pkwt") == 1,
        uang_pisah: angka_baris(alasan, "uang_pisah") == 1,
        sisa_cuti: data.sisa_cuti,
        upah_harian: data.upah_harian,
        pkwt_mulai: data.pkwt_mulai.clone(),
    }
}

fn usulan_json(usulan: &[Usulan]) -> Vec<Value> {
    usulan
        .iter()
        .map(|u| json!({ "komponen": u.komponen, "dasar": u.dasar, "usulan": u.usulan }))
        .collect()
}

fn data_json(data: &DataKaryawan) -> Value {
    json!({
        "tanggal_daftar": data.tanggal_daftar,
        "usulan_upah_pokok": data.usulan_upah_pokok,
        "sisa_cuti": data.sisa_cuti,
        "upah_harian": data.upah_harian,
        "pkwt_mulai": data.pkwt_mulai,
        "tunjangan_acuan": data.tunjangan_acuan,
    })
}

/// Rincian satu proses keluar: header, rincian tersimpan, usulan terkini,
/// checklist, dan akun tertaut. `data` dan `checklist` dibaca pemanggil dari
/// SQLite lokal untuk `tanggal_terakhir` proses itu.
pub async fn rincian_keluar(
    turso: &TursoClient,
    id_keluar: &str,
    muat_lokal: impl FnOnce(&str, &str) -> Result<(DataKaryawan, Value), CommandError>,
) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let header = objek(turso, "SELECT * FROM hr_keluar WHERE id_keluar = ?1;", vec![json!(id_keluar)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Proses keluar tidak ditemukan."))?;
    let id_karyawan = teks_baris(&header, "id_karyawan").unwrap_or_default();
    let tanggal_terakhir = teks_baris(&header, "tanggal_terakhir").unwrap_or_default();
    let (data, checklist) = muat_lokal(&id_karyawan, &tanggal_terakhir)?;
    let rincian = objek(
        turso,
        "SELECT * FROM hr_keluar_rincian WHERE id_keluar = ?1 ORDER BY urutan;",
        vec![json!(id_keluar)],
    )
    .await?;
    let alasan = alasan_satu(turso, &teks_baris(&header, "id_alasan").unwrap_or_default()).await?;
    let upah = angka_baris(&header, "upah_pokok") + angka_baris(&header, "tunjangan_tetap");
    let usulan = usulan_pesangon(&masukan_pesangon(&alasan, &data, upah, &tanggal_terakhir));
    let karyawan = karyawan_cloud(turso, &id_karyawan).await?;
    let akun = akun_tertaut(turso, &id_karyawan).await?;
    Ok(json!({
        "keluar": dengan_status_keluar(header, &hari_ini),
        "karyawan": karyawan,
        "rincian": rincian,
        "usulan": usulan_json(&usulan),
        "data": data_json(&data),
        "checklist": checklist,
        "akun": akun,
        "alasan": alasan,
        "hari_ini": hari_ini,
    }))
}

/// Pratinjau sebelum dicatat: usulan upah dan pesangon, checklist, dan akun
/// untuk satu karyawan, alasan, dan tanggal terakhir.
pub async fn pratinjau_keluar(
    turso: &TursoClient,
    id_karyawan: &str,
    id_alasan: &str,
    tanggal_terakhir: &str,
    data: DataKaryawan,
    checklist: Value,
) -> Result<Value, CommandError> {
    if !is_valid_date(tanggal_terakhir) {
        return Err(invalid("Tanggal hari kerja terakhir tidak valid."));
    }
    siap(turso).await?;
    let alasan = alasan_satu(turso, id_alasan).await?;
    let usulan = usulan_pesangon(&masukan_pesangon(&alasan, &data, data.usulan_upah_pokok, tanggal_terakhir));
    Ok(json!({
        "karyawan": karyawan_cloud(turso, id_karyawan).await?,
        "usulan": usulan_json(&usulan),
        "data": data_json(&data),
        "checklist": checklist,
        "akun": akun_tertaut(turso, id_karyawan).await?,
        "alasan": alasan,
        "hari_ini": hari_ini_cloud(turso).await?,
    }))
}

/// Catat proses keluar baru atau ubah yang belum berlaku (`hr.offboard.manage`).
/// `data` dibaca pemanggil dari SQLite lokal untuk karyawan dan tanggal di draf.
pub async fn simpan_keluar(
    turso: &TursoClient,
    sesi_karyawan: Option<&str>,
    oleh: &str,
    sah: KeluarSah,
    data: DataKaryawan,
) -> Result<Value, CommandError> {
    tolak_diri_sendiri(sesi_karyawan, &sah.id_karyawan)?;
    siap(turso).await?;
    let karyawan = karyawan_cloud(turso, &sah.id_karyawan).await?;
    if data.tanggal_daftar.as_deref().is_some_and(|masuk| sah.tanggal_terakhir.as_str() < masuk) {
        return Err(invalid("Hari kerja terakhir tidak boleh sebelum tanggal masuk karyawan."));
    }
    let terbuka = objek(
        turso,
        "SELECT id_keluar, berlaku_pada FROM hr_keluar WHERE id_karyawan = ?1 AND dibatalkan_pada IS NULL;",
        vec![json!(sah.id_karyawan)],
    )
    .await?;
    match &sah.id_keluar {
        Some(id) => {
            let lama = terbuka
                .iter()
                .find(|b| teks_baris(b, "id_keluar").as_deref() == Some(id.as_str()))
                .ok_or_else(|| invalid("Proses keluar tidak ditemukan atau sudah dibatalkan."))?;
            if teks_baris(lama, "berlaku_pada").is_some() {
                return Err(invalid("Proses keluar yang sudah berlaku tidak bisa diubah."));
            }
        }
        None => {
            if !terbuka.is_empty() {
                return Err(invalid("Karyawan ini sudah punya proses keluar yang belum dibatalkan."));
            }
            if teks_baris(&karyawan, "status_aktif").as_deref() != Some("Aktif") {
                return Err(invalid("Proses keluar hanya untuk karyawan aktif."));
            }
        }
    }
    let alasan = alasan_satu(turso, &sah.id_alasan).await?;
    if angka_baris(&alasan, "is_aktif") != 1 && sah.id_keluar.is_none() {
        return Err(invalid("Alasan keluar sudah nonaktif."));
    }
    let upah_pokok = sah.upah_pokok.unwrap_or(data.usulan_upah_pokok);
    periksa_upah(upah_pokok, data.usulan_upah_pokok, sah.alasan_upah.as_deref()).map_err(invalid)?;
    let upah = upah_pokok + sah.tunjangan_tetap;
    if upah > MAKS_UPAH {
        return Err(invalid("Upah pokok + tunjangan tetap terlalu besar."));
    }
    let usulan = usulan_pesangon(&masukan_pesangon(&alasan, &data, upah, &sah.tanggal_terakhir));
    let rincian = susun_rincian(&usulan, &sah.rincian).map_err(invalid)?;

    let id = sah.id_keluar.clone().unwrap_or_else(|| new_hex_id("klr-"));
    let mut statements = vec![Statement::new(
        "INSERT INTO hr_keluar (id_keluar, id_karyawan, id_alasan, alasan_nama, id_sp, tanggal_pemberitahuan, tanggal_terakhir,
                                keterangan, masa_kerja_mulai, upah_pokok, usulan_upah_pokok, alasan_upah, tunjangan_tetap,
                                kartu_ditarik, catatan_checklist, dicatat_oleh)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id_keluar) DO UPDATE SET id_alasan = excluded.id_alasan, alasan_nama = excluded.alasan_nama,
            id_sp = excluded.id_sp, tanggal_pemberitahuan = excluded.tanggal_pemberitahuan,
            tanggal_terakhir = excluded.tanggal_terakhir, keterangan = excluded.keterangan,
            masa_kerja_mulai = excluded.masa_kerja_mulai, upah_pokok = excluded.upah_pokok,
            usulan_upah_pokok = excluded.usulan_upah_pokok, alasan_upah = excluded.alasan_upah,
            tunjangan_tetap = excluded.tunjangan_tetap, kartu_ditarik = excluded.kartu_ditarik,
            catatan_checklist = excluded.catatan_checklist, diubah_oleh = excluded.dicatat_oleh,
            diubah_pada = datetime('now')
         WHERE hr_keluar.berlaku_pada IS NULL AND hr_keluar.dibatalkan_pada IS NULL;",
        vec![
            json!(id),
            json!(sah.id_karyawan),
            json!(sah.id_alasan),
            json!(teks_baris(&alasan, "nama").unwrap_or_default()),
            json!(sah.id_sp),
            json!(sah.tanggal_pemberitahuan),
            json!(sah.tanggal_terakhir),
            json!(sah.keterangan),
            json!(data.tanggal_daftar),
            json!(upah_pokok),
            json!(data.usulan_upah_pokok),
            json!(sah.alasan_upah.filter(|_| upah_pokok != data.usulan_upah_pokok)),
            json!(sah.tunjangan_tetap),
            json!(i64::from(sah.kartu_ditarik)),
            json!(sah.catatan_checklist),
            json!(oleh),
        ],
    )];
    // Rincian ditulis ulang utuh; dijaga keadaan header yang sama supaya
    // proses yang sudah berlaku tidak pernah berubah.
    const BELUM_BERLAKU: &str = "EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.berlaku_pada IS NULL AND k.dibatalkan_pada IS NULL)";
    statements.push(Statement::new(
        format!("DELETE FROM hr_keluar_rincian WHERE id_keluar = ?1 AND {BELUM_BERLAKU};"),
        vec![json!(id)],
    ));
    for r in &rincian {
        statements.push(Statement::new(
            format!(
                "INSERT INTO hr_keluar_rincian (id_keluar, id_rincian, komponen, dasar, usulan, nominal, alasan_ubah, urutan)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE {BELUM_BERLAKU};"
            ),
            vec![
                json!(id),
                json!(format!("{id}:{}", r.komponen)),
                json!(r.komponen),
                json!(r.dasar),
                json!(r.usulan),
                json!(r.nominal),
                json!(r.alasan_ubah),
                json!(r.urutan),
            ],
        ));
    }
    turso.execute_atomic(statements).await.map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_keluar": id }))
}

/// Statement Berlakukan (cermin `BERLAKUKAN_SQL`): `?1` id keluar, `?2`
/// operator, `?3` potret checklist, `?4` id karyawan. Statement kedua dan
/// seterusnya hanya berjalan bila statement pertama (atau tekan sebelumnya
/// oleh operator yang sama) sudah memberlakukan proses itu.
pub const BERLAKUKAN_SQL: [&str; 4] = [
    "UPDATE hr_keluar SET berlaku_oleh = ?2, berlaku_pada = datetime('now'), checklist_saat_berlaku = ?3 WHERE id_keluar = ?1 AND berlaku_pada IS NULL AND dibatalkan_pada IS NULL AND tanggal_terakhir <= date('now', '+7 hours');",
    "UPDATE master_data SET status_aktif = 'Nonaktif', tanggal_selesai_aktif = (SELECT k.tanggal_terakhir FROM hr_keluar k WHERE k.id_keluar = ?1), id_keluar = ?1 WHERE id_unik = ?4 AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
    "UPDATE master_operator SET status = 'Nonaktif', updated_at = datetime('now') WHERE id_karyawan = ?4 AND status = 'Aktif' AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
    "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'employee-offboarded' WHERE revoked_at IS NULL AND operator_id IN (SELECT id FROM master_operator WHERE id_karyawan = ?4) AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.id_karyawan = ?4 AND k.berlaku_pada IS NOT NULL AND k.dibatalkan_pada IS NULL);",
];

/// Statement Batalkan (cermin `BATALKAN_SQL`): `?1` id keluar, `?2` operator,
/// `?3` alasan. `master_data` hanya dikembalikan bila proses itu yang
/// menonaktifkannya; akun operator tidak pernah diaktifkan lagi (Q-65).
pub const BATALKAN_SQL: [&str; 2] = [
    "UPDATE master_data SET status_aktif = 'Aktif', tanggal_selesai_aktif = NULL, id_keluar = NULL WHERE id_keluar = ?1 AND EXISTS (SELECT 1 FROM hr_keluar k WHERE k.id_keluar = ?1 AND k.dibatalkan_pada IS NULL);",
    "UPDATE hr_keluar SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_keluar = ?1 AND dibatalkan_pada IS NULL;",
];

pub const PESAN_SUPERADMIN_TERAKHIR: &str =
    "Karyawan ini tertaut ke akun Superadmin aktif terakhir. Pindahkan peran Superadmin ke akun lain lebih dulu.";

/// Berlakukan proses keluar (`hr.offboard.manage`): satu transaksi cloud
/// menonaktifkan karyawan, mengisi tanggal keluar, dan menonaktifkan akunnya.
pub async fn berlakukan(
    turso: &TursoClient,
    sesi_karyawan: Option<&str>,
    id_operator: i64,
    oleh: &str,
    id_keluar: &str,
    muat_checklist: impl FnOnce(&str, &str) -> Result<Value, CommandError>,
) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let header = objek(turso, "SELECT * FROM hr_keluar WHERE id_keluar = ?1;", vec![json!(id_keluar)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Proses keluar tidak ditemukan."))?;
    let id_karyawan = teks_baris(&header, "id_karyawan").unwrap_or_default();
    let tanggal_terakhir = teks_baris(&header, "tanggal_terakhir").unwrap_or_default();
    tolak_diri_sendiri(sesi_karyawan, &id_karyawan)?;
    match status_keluar(
        &tanggal_terakhir,
        teks_baris(&header, "berlaku_pada").is_some(),
        teks_baris(&header, "dibatalkan_pada").is_some(),
        &hari_ini,
    ) {
        "Jatuh tempo" => {}
        "Dijadwalkan" => return Err(invalid("Proses keluar baru bisa diberlakukan pada hari kerja terakhir.")),
        "Berlaku" => return Err(invalid("Proses keluar ini sudah berlaku.")),
        _ => return Err(invalid("Proses keluar ini sudah dibatalkan.")),
    }
    let akun = akun_tertaut(turso, &id_karyawan).await?;
    if akun.iter().any(|a| angka_baris(a, "id") == id_operator) {
        return Err(invalid("Tindakan ini tidak bisa dilakukan untuk diri sendiri."));
    }
    let super_tertaut = akun
        .iter()
        .filter(|a| angka_baris(a, "is_superadmin") == 1 && teks_baris(a, "status").as_deref() == Some("Aktif"))
        .count() as i64;
    if super_tertaut > 0 {
        let total = objek(
            turso,
            "SELECT COUNT(*) AS total FROM master_operator m JOIN app_role r ON r.id = m.role_id WHERE r.is_superadmin = 1 AND m.status = 'Aktif';",
            vec![],
        )
        .await?
        .first()
        .map(|b| angka_baris(b, "total"))
        .unwrap_or(0);
        if total <= super_tertaut {
            return Err(invalid(PESAN_SUPERADMIN_TERAKHIR));
        }
    }
    let mut potret = muat_checklist(&id_karyawan, &tanggal_terakhir)?;
    let total = objek(
        turso,
        "SELECT COALESCE(SUM(nominal), 0) AS total FROM hr_keluar_rincian WHERE id_keluar = ?1;",
        vec![json!(id_keluar)],
    )
    .await?
    .first()
    .map(|b| angka_baris(b, "total"))
    .unwrap_or(0);
    potret["total_rincian"] = json!(total);
    potret["akun"] = json!(akun);
    // Statement pertama tidak memakai `?4`; jumlah argumen wajib pas.
    let args = vec![json!(id_keluar), json!(oleh), json!(potret.to_string()), json!(id_karyawan)];
    turso
        .execute_atomic(
            BERLAKUKAN_SQL
                .iter()
                .enumerate()
                .map(|(i, sql)| Statement::new(*sql, args[..if i == 0 { 3 } else { 4 }].to_vec()))
                .collect(),
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

/// Batalkan proses keluar dengan alasan (`hr.offboard.manage`), kapan saja.
pub async fn batalkan(
    turso: &TursoClient,
    sesi_karyawan: Option<&str>,
    oleh: &str,
    draft: &Value,
) -> Result<Value, CommandError> {
    let id_keluar = payload_text(draft, "id_keluar").ok_or_else(|| invalid("Proses keluar tidak ditemukan."))?;
    let alasan = alasan_wajib(draft, "Alasan pembatalan")?;
    siap(turso).await?;
    let header = objek(turso, "SELECT id_karyawan, dibatalkan_pada FROM hr_keluar WHERE id_keluar = ?1;", vec![json!(id_keluar)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Proses keluar tidak ditemukan."))?;
    tolak_diri_sendiri(sesi_karyawan, &teks_baris(&header, "id_karyawan").unwrap_or_default())?;
    if teks_baris(&header, "dibatalkan_pada").is_some() {
        return Err(invalid("Proses keluar ini sudah dibatalkan."));
    }
    let args = vec![json!(id_keluar), json!(oleh), json!(alasan)];
    turso
        .execute_atomic(
            BATALKAN_SQL
                .iter()
                .enumerate()
                .map(|(i, sql)| Statement::new(*sql, args[..if i == 0 { 1 } else { 3 }].to_vec()))
                .collect(),
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor yang sama diuji di `validations/hr-keluar.test.ts`.

    fn sp(tingkat: &str, tanggal: &str, sampai: &str, dicabut: bool) -> SpRingkas {
        SpRingkas { tingkat: tingkat.into(), tanggal: tanggal.into(), berlaku_sampai: sampai.into(), dicabut }
    }

    #[test]
    fn masa_dan_status_sp() {
        assert_eq!(akhir_masa_sp("2026-01-10", 6).as_deref(), Some("2026-07-09"));
        assert_eq!(akhir_masa_sp("2026-08-31", 6).as_deref(), Some("2027-02-27"));
        assert_eq!(status_sp("2026-01-10", "2026-07-09", false, "2026-07-09"), "Berlaku");
        assert_eq!(status_sp("2026-01-10", "2026-07-09", false, "2026-07-10"), "Berakhir");
        assert_eq!(status_sp("2026-01-10", "2026-07-09", true, "2026-03-01"), "Dicabut");
    }

    #[test]
    fn eskalasi_sp() {
        assert_eq!(usulan_tingkat(&[], "2026-03-01"), ("SP1", false));
        let satu = sp("SP1", "2026-01-10", "2026-07-09", false);
        assert_eq!(usulan_tingkat(&[satu.clone()], "2026-03-01"), ("SP2", false));
        assert_eq!(usulan_tingkat(&[satu.clone()], "2026-08-01"), ("SP1", false));
        assert_eq!(usulan_tingkat(&[sp("SP1", "2026-01-10", "2026-07-09", true)], "2026-03-01"), ("SP1", false));
        let dua = sp("SP2", "2026-02-01", "2026-07-31", false);
        assert_eq!(usulan_tingkat(&[satu.clone(), dua.clone()], "2026-03-01"), ("SP3", false));
        let tiga = sp("SP3", "2026-02-15", "2026-08-14", false);
        assert_eq!(usulan_tingkat(&[satu, dua, tiga], "2026-03-01"), ("SP3", true));
        assert!(periksa_tingkat("SP2", "SP2", None).is_ok());
        assert_eq!(
            periksa_tingkat("SP1", "SP2", None).unwrap_err(),
            "Tingkat berbeda dari usulan (SP2); alasannya wajib diisi."
        );
        assert!(periksa_tingkat("SP1", "SP2", Some("Pelanggaran ringan")).is_ok());
    }

    #[test]
    fn validasi_sp_vektor() {
        let dasar = json!({
            "id_karyawan": "K1", "tingkat": "SP1", "tanggal": "2026-03-01",
            "pelanggaran": " Terlambat 5 kali ", "penanda_nama": "Sari", "penanda_jabatan": "HRD"
        });
        let sah = validasi_sp(&dasar, "2026-03-01").unwrap();
        assert_eq!(sah.pelanggaran, "Terlambat 5 kali");
        assert_eq!(sah.nomor, None);
        let ubah = |kunci: &str, nilai: Value| {
            let mut d = dasar.clone();
            d[kunci] = nilai;
            validasi_sp(&d, "2026-03-01").unwrap_err()
        };
        assert_eq!(ubah("tingkat", json!("SP4")), "Tingkat SP tidak dikenal.");
        assert_eq!(ubah("tanggal", json!("2026-03-02")), "Tanggal SP tidak boleh di masa depan.");
        assert_eq!(ubah("pelanggaran", json!(" ")), "Pelanggaran wajib diisi.");
        assert_eq!(ubah("penanda_nama", Value::Null), "Nama penanda tangan wajib diisi.");
        assert_eq!(ubah("nomor", json!("x".repeat(101))), "Nomor surat maksimal 100 karakter.");
    }

    #[test]
    fn status_keluar_vektor() {
        assert_eq!(status_keluar("2026-03-31", false, false, "2026-03-30"), "Dijadwalkan");
        assert_eq!(status_keluar("2026-03-31", false, false, "2026-03-31"), "Jatuh tempo");
        assert_eq!(status_keluar("2026-03-31", true, false, "2026-04-02"), "Berlaku");
        assert_eq!(status_keluar("2026-03-31", true, true, "2026-04-02"), "Dibatalkan");
    }

    #[test]
    fn masa_kerja_dan_kelipatan() {
        assert_eq!(masa_kerja_bulan("2020-03-15", "2026-03-14"), 72);
        assert_eq!(masa_kerja_bulan("2020-03-15", "2026-03-13"), 71);
        assert_eq!(masa_kerja_bulan("2024-01-31", "2024-02-27"), 0);
        assert_eq!(masa_kerja_bulan("2024-01-31", "2024-02-28"), 1);
        assert_eq!(masa_kerja_bulan("2026-05-01", "2026-04-01"), 0);
        assert_eq!([0, 1, 7, 8, 30].map(kelipatan_up), [1, 2, 8, 9, 9]);
        assert_eq!([2, 3, 5, 6, 21, 23, 24].map(kelipatan_upmk), [0, 2, 2, 3, 8, 8, 10]);
        assert_eq!(usulan_upah_pokok("FLAT_DAILY", 150_000, 99), 4_500_000);
        assert_eq!(usulan_upah_pokok("HOURLY", 99, 20_000), 3_460_000);
    }

    fn masukan() -> MasukanPesangon {
        MasukanPesangon {
            upah: 5_000_000,
            masa_kerja_mulai: Some("2020-03-15".into()),
            tanggal_terakhir: "2026-03-14".into(),
            pengali_up: 50,
            pengali_upmk: 100,
            uph: true,
            sisa_cuti: 4,
            upah_harian: 200_000,
            ..MasukanPesangon::default()
        }
    }

    #[test]
    fn usulan_pesangon_vektor() {
        let hasil = usulan_pesangon(&masukan());
        let ringkas: Vec<(&str, i64)> = hasil.iter().map(|u| (u.komponen, u.usulan)).collect();
        assert_eq!(
            ringkas,
            vec![
                ("UP", 17_500_000),
                ("UPMK", 15_000_000),
                ("UPH Cuti", 800_000),
                ("UPH Ongkos Pulang", 0),
                ("UPH Lainnya", 0),
                ("Lainnya", 0),
            ]
        );
        assert_eq!(hasil[0].dasar.as_deref(), Some("Masa kerja 6 tahun: 7 × upah × 50%"));
        assert_eq!(hasil[2].dasar.as_deref(), Some("Sisa cuti 4 hari × upah harian"));

        // PKWT 7 bulan, pembulatan setengah ke atas: 3.333.333 × 7 / 12.
        let pkwt = usulan_pesangon(&MasukanPesangon {
            upah: 3_333_333,
            masa_kerja_mulai: None,
            tanggal_terakhir: "2026-07-31".into(),
            kompensasi_pkwt: true,
            uang_pisah: true,
            pkwt_mulai: Some("2026-01-01".into()),
            ..MasukanPesangon::default()
        });
        let ringkas: Vec<(&str, i64)> = pkwt.iter().map(|u| (u.komponen, u.usulan)).collect();
        assert_eq!(
            ringkas,
            vec![("UP", 0), ("UPMK", 0), ("Kompensasi PKWT", 1_944_444), ("Uang Pisah", 0), ("Lainnya", 0)]
        );
        assert_eq!(pkwt[0].dasar.as_deref(), Some("Tanggal masuk kosong"));
        assert_eq!(pkwt[2].dasar.as_deref(), Some("PKWT 7 bulan: upah × 7 / 12"));

        // Pengali 175% atas upah ganjil: 1.234.567 × 2 × 175 / 100 = 4.320.984,5.
        let pensiun = usulan_pesangon(&MasukanPesangon {
            upah: 1_234_567,
            masa_kerja_mulai: Some("2025-01-01".into()),
            tanggal_terakhir: "2026-06-30".into(),
            pengali_up: 175,
            pengali_upmk: 100,
            ..MasukanPesangon::default()
        });
        assert_eq!(pensiun[0].usulan, 4_320_985);
        assert_eq!(pensiun[1].usulan, 0);
    }

    #[test]
    fn susun_rincian_vektor() {
        let usulan = usulan_pesangon(&masukan());
        let apa_adanya = susun_rincian(&usulan, &[]).unwrap();
        assert_eq!(apa_adanya.len(), 6);
        assert_eq!((apa_adanya[0].nominal, apa_adanya[0].urutan), (17_500_000, 1));
        let isi = |komponen: &str, nominal: i64, alasan: Option<&str>| IsianRincian {
            komponen: komponen.into(),
            nominal,
            alasan_ubah: alasan.map(str::to_owned),
        };
        assert_eq!(
            susun_rincian(&usulan, &[isi("UP", 20_000_000, None)]).unwrap_err(),
            "Nominal UP berbeda dari usulan; alasannya wajib diisi."
        );
        let diubah = susun_rincian(&usulan, &[isi("UP", 20_000_000, Some("PKB")), isi("UPMK", 15_000_000, Some("x"))]).unwrap();
        assert_eq!(diubah[0].alasan_ubah.as_deref(), Some("PKB"));
        assert_eq!(diubah[1].alasan_ubah, None);
        assert_eq!(
            susun_rincian(&usulan, &[isi("Uang Pisah", 1, Some("x"))]).unwrap_err(),
            "Komponen 'Uang Pisah' tidak berlaku untuk alasan ini."
        );
    }

    #[test]
    fn validasi_keluar_vektor() {
        let dasar = json!({ "id_karyawan": "K1", "id_alasan": "klr-resign", "tanggal_terakhir": "2026-03-31" });
        let sah = validasi_keluar(&dasar).unwrap();
        assert_eq!((sah.upah_pokok, sah.tunjangan_tetap, sah.kartu_ditarik), (None, 0, false));
        let ubah = |kunci: &str, nilai: Value| {
            let mut d = dasar.clone();
            d[kunci] = nilai;
            validasi_keluar(&d).unwrap_err()
        };
        assert_eq!(ubah("tanggal_terakhir", json!("31-03-2026")), "Tanggal hari kerja terakhir tidak valid.");
        assert_eq!(
            ubah("tanggal_pemberitahuan", json!("2026-04-01")),
            "Tanggal pemberitahuan tidak boleh sesudah hari kerja terakhir."
        );
        assert_eq!(ubah("upah_pokok", json!(-1)), "Upah pokok tidak valid.");
        assert_eq!(ubah("upah_pokok", json!(1.5)), "Upah pokok tidak valid.");
        assert_eq!(ubah("tunjangan_tetap", json!(1_000_000_001)), "Tunjangan tetap tidak valid.");
        assert_eq!(ubah("rincian", json!([{ "komponen": "Bonus", "nominal": 1 }])), "Komponen rincian tidak dikenal.");
        assert_eq!(
            ubah("rincian", json!([{ "komponen": "UP", "nominal": 1 }, { "komponen": "UP", "nominal": 2 }])),
            "Komponen UP tercantum dua kali."
        );
        assert_eq!(periksa_upah(1, 2, None).unwrap_err(), "Upah pokok berbeda dari usulan; alasannya wajib diisi.");
        assert!(periksa_upah(2, 2, None).is_ok());
    }

    #[test]
    fn validasi_alasan_vektor() {
        let sah = validasi_alasan(&json!({ "nama": " Mutasi ", "pengali_up": 100, "pengali_upmk": 0 })).unwrap();
        assert_eq!((sah.nama.as_str(), sah.uph, sah.kompensasi_pkwt, sah.is_aktif), ("Mutasi", true, false, true));
        assert_eq!(
            validasi_alasan(&json!({ "nama": "X", "pengali_up": 1001, "pengali_upmk": 0 })).unwrap_err(),
            "Pengali UP harus bilangan bulat 0–1000 (persen)."
        );
        assert_eq!(alasan_bawaan().len(), 8);
        assert!(alasan_bawaan().iter().all(|a| (0..=MAKS_PENGALI).contains(&a.pengali_up)));
    }
}
