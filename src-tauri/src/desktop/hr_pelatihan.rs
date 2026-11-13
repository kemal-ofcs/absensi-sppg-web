//! HRIS fase 7 (skema v42): pelatihan, peserta, dan sertifikat.
//!
//! `hr_pelatihan` dan `hr_pelatihan_peserta` KHUSUS CLOUD (Q-87): sertifikat
//! peserta adalah `hr_dokumen` berjenis `dok-sertifikat` (Q-97), yang sudah
//! khusus cloud, jadi layar ini tetap butuh koneksi. Status pelatihan tidak
//! disimpan; pembatalan adalah kolom yang diisi sekali. Biaya satu angka total
//! per pelatihan (Q-98), tanpa jurnal.
//!
//! Fase 11 (skema v43): pagu per divisi per tahun dan rencana pelatihan,
//! juga khusus cloud. Status rencana, realisasi, dan tanda tidak disimpan;
//! melewati pagu hanya ditandai (§26.4).
//!
//! Aturan murni dan pesan galat cermin `validations/hr-pelatihan.ts`, diuji
//! dengan vektor yang sama (`prd-hris.md` §22.7, §26.3, §26.4).

use std::collections::HashSet;
use std::ops::RangeInclusive;

use serde_json::{json, Value};

use super::hr_keluar::{angka_baris, hari_ini_cloud, teks_baris, Baris};
use super::hris::{self, objek, siap, tak_terhubung};
use super::inventory::{invalid, is_valid_date, new_hex_id, payload_text};
use super::models::CommandError;
use super::turso::{Statement, TursoClient};

pub const IZIN_VIEW: &str = "hr.training.view";
pub const IZIN_MANAGE: &str = "hr.training.manage";

pub const MAKS_NAMA_PELATIHAN: usize = 100;
pub const MAKS_PENYELENGGARA: usize = 100;
pub const MAKS_LOKASI: usize = 100;
pub const MAKS_BIAYA: i64 = 1_000_000_000;
pub const MAKS_KETERANGAN: usize = 2000;
pub const MAKS_CATATAN_PESERTA: usize = 1000;
/// WAJIB sama dengan CHECK `hr_pelatihan_peserta.hasil`.
pub const HASIL_PESERTA: [&str; 3] = ["Lulus", "Tidak Lulus", "Tidak Hadir"];
/// Jenis dokumen sertifikat, ditanam fase 1 (`hris::SEED_JENIS_DOKUMEN_SQL`).
pub const JENIS_SERTIFIKAT: &str = "dok-sertifikat";

pub const PESAN_SERTIFIKAT_NONAKTIF: &str = "Aktifkan jenis dokumen Sertifikat di Organisasi.";
pub const PESAN_PELATIHAN_BATAL: &str = "Pelatihan ini sudah dibatalkan.";
pub const PESAN_PESERTA_BERSERTIFIKAT: &str =
    "Peserta ini punya sertifikat; hapus sertifikatnya dulu.";

pub const MAKS_PESERTA_RENCANA: i64 = 9_999;
pub const MAKS_PAGU: i64 = 100_000_000_000;
pub const MAKS_CATATAN_PAGU: usize = 1000;
/// Kunci kelompok tanpa divisi; tidak bertabrakan dengan id `div-…`.
pub const KELOMPOK_UMUM: &str = "umum";

pub const PESAN_RENCANA_TAHUN: &str =
    "Tahun rencana harus sama dengan tahun tanggal mulai pelatihan; lepas tautan rencananya dulu.";
pub const PESAN_RENCANA_TERTAUT: &str =
    "Rencana ini masih punya pelatihan yang tidak dibatalkan; lepas tautannya atau batalkan pelatihannya dulu.";
pub const PESAN_RENCANA_BATAL: &str = "Rencana ini sudah dibatalkan.";
pub const PESAN_RENCANA_TAHUN_TERKUNCI: &str =
    "Tahun rencana tidak bisa diubah selama ada pelatihan yang tertaut.";

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

fn teks_opsional(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<Option<String>, String> {
    match payload_text(draft, kunci) {
        Some(t) if panjang(&t) > maks => Err(format!("{label} maksimal {maks} karakter.")),
        lain => Ok(lain),
    }
}

/// Bilangan bulat dalam `rentang`; absen atau null = `bawaan`.
fn bulat(draft: &Value, kunci: &str, rentang: RangeInclusive<i64>, bawaan: Option<i64>, pesan: &str) -> Result<Option<i64>, String> {
    match draft.get(kunci) {
        None | Some(Value::Null) => Ok(bawaan),
        Some(v) => v.as_i64().filter(|n| rentang.contains(n)).map(Some).ok_or_else(|| pesan.to_owned()),
    }
}

/// Nama wajib, spasi dirapikan, maksimal `MAKS_NAMA_PELATIHAN`.
fn nama_wajib(draft: &Value, label: &str) -> Result<String, String> {
    let nama = payload_text(draft, "nama")
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .ok_or_else(|| format!("{label} wajib diisi."))?;
    if panjang(&nama) > MAKS_NAMA_PELATIHAN {
        return Err(format!("{label} maksimal {MAKS_NAMA_PELATIHAN} karakter."));
    }
    Ok(nama)
}

/// Tahun dari tanggal `YYYY-MM-DD`; 0 bila rusak.
fn tahun_dari(tanggal: &str) -> i64 {
    tanggal.chars().take(4).collect::<String>().parse().unwrap_or(0)
}

/// Pelatihan yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct PelatihanSah {
    pub id_pelatihan: Option<String>,
    pub nama: String,
    pub penyelenggara: Option<String>,
    pub tanggal_mulai: String,
    pub tanggal_selesai: String,
    pub lokasi: Option<String>,
    pub biaya: i64,
    pub keterangan: Option<String>,
    /// Kosong = di luar rencana (dibebankan ke Umum).
    pub id_rencana: Option<String>,
}

/// Cermin `validasiPelatihan`. Tanggal boleh di masa depan (terjadwal).
/// Rencana tertaut diperiksa pemanggil (`periksa_rencana_pelatihan`).
pub fn validasi_pelatihan(draft: &Value) -> Result<PelatihanSah, String> {
    let nama = nama_wajib(draft, "Nama pelatihan")?;
    let tanggal_mulai = payload_text(draft, "tanggal_mulai")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal mulai tidak valid.")?;
    let tanggal_selesai = payload_text(draft, "tanggal_selesai")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal selesai tidak valid.")?;
    if tanggal_selesai < tanggal_mulai {
        return Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into());
    }
    let biaya = bulat(draft, "biaya", 0..=MAKS_BIAYA, Some(0), "Biaya harus bilangan bulat 0–1.000.000.000.")?.unwrap_or(0);
    Ok(PelatihanSah {
        id_pelatihan: payload_text(draft, "id_pelatihan"),
        nama,
        penyelenggara: teks_opsional(draft, "penyelenggara", "Penyelenggara", MAKS_PENYELENGGARA)?,
        tanggal_mulai,
        tanggal_selesai,
        lokasi: teks_opsional(draft, "lokasi", "Lokasi", MAKS_LOKASI)?,
        biaya,
        keterangan: teks_opsional(draft, "keterangan", "Keterangan", MAKS_KETERANGAN)?,
        id_rencana: payload_text(draft, "id_rencana"),
    })
}

/// Cermin `statusPelatihan`. Tidak disimpan; `hari_ini` tanggal WIB.
pub fn status_pelatihan(tanggal_mulai: &str, tanggal_selesai: &str, dibatalkan: bool, hari_ini: &str) -> &'static str {
    if dibatalkan {
        "Dibatalkan"
    } else if tanggal_mulai > hari_ini {
        "Dijadwalkan"
    } else if tanggal_selesai < hari_ini {
        "Selesai"
    } else {
        "Berlangsung"
    }
}

/// Cermin `idPeserta`: satu karyawan sekali per pelatihan, tanpa `UNIQUE`.
pub fn id_peserta(id_pelatihan: &str, id_karyawan: &str) -> String {
    format!("{id_pelatihan}:{id_karyawan}")
}

/// Isian hasil satu peserta yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct PesertaSah {
    pub id_karyawan: String,
    pub hasil: Option<String>,
    pub catatan: Option<String>,
}

/// Cermin `validasiPeserta`. Status Aktif karyawan diperiksa pemanggil di
/// transaksi yang sama.
pub fn validasi_peserta(draft: &Value) -> Result<PesertaSah, String> {
    let id_karyawan = payload_text(draft, "id_karyawan").ok_or("Karyawan wajib dipilih.")?;
    let hasil = payload_text(draft, "hasil");
    if hasil.as_deref().is_some_and(|h| !HASIL_PESERTA.contains(&h)) {
        return Err("Hasil pelatihan tidak dikenal.".into());
    }
    Ok(PesertaSah {
        id_karyawan,
        hasil,
        catatan: teks_opsional(draft, "catatan", "Catatan", MAKS_CATATAN_PESERTA)?,
    })
}

/// Cermin `validasiBatalPelatihan`: alasan wajib, sekali.
pub fn validasi_batal_pelatihan(draft: &Value, sudah_dibatalkan: bool) -> Result<String, String> {
    if sudah_dibatalkan {
        return Err(PESAN_PELATIHAN_BATAL.into());
    }
    teks_opsional(draft, "alasan", "Alasan pembatalan", MAKS_KETERANGAN)?
        .ok_or_else(|| "Alasan pembatalan wajib diisi.".into())
}

// ── Rencana dan pagu (fase 11) ─────────────────────────────────────────────

/// Rencana yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct RencanaSah {
    pub id_rencana: Option<String>,
    pub tahun: i64,
    pub nama: String,
    /// Kosong = Umum. Ada dan aktif diperiksa pemanggil.
    pub id_divisi: Option<String>,
    pub bulan: Option<i64>,
    pub peserta_rencana: i64,
    pub biaya_rencana: i64,
    pub penyelenggara: Option<String>,
    pub keterangan: Option<String>,
}

fn tahun_wajib(draft: &Value) -> Result<i64, String> {
    const PESAN: &str = "Tahun harus 2000–2100.";
    bulat(draft, "tahun", 2000..=2100, None, PESAN)?.ok_or_else(|| PESAN.into())
}

/// Cermin `validasiRencana` (§26.3, Q-144).
pub fn validasi_rencana(draft: &Value) -> Result<RencanaSah, String> {
    Ok(RencanaSah {
        id_rencana: payload_text(draft, "id_rencana"),
        tahun: tahun_wajib(draft)?,
        nama: nama_wajib(draft, "Nama rencana")?,
        id_divisi: payload_text(draft, "id_divisi"),
        bulan: bulat(draft, "bulan", 1..=12, None, "Bulan harus 1–12.")?,
        peserta_rencana: bulat(
            draft,
            "peserta_rencana",
            0..=MAKS_PESERTA_RENCANA,
            Some(0),
            "Jumlah peserta rencana harus bilangan bulat 0–9.999.",
        )?
        .unwrap_or(0),
        biaya_rencana: bulat(
            draft,
            "biaya_rencana",
            0..=MAKS_BIAYA,
            Some(0),
            "Estimasi biaya harus bilangan bulat 0–1.000.000.000.",
        )?
        .unwrap_or(0),
        penyelenggara: teks_opsional(draft, "penyelenggara", "Penyelenggara", MAKS_PENYELENGGARA)?,
        keterangan: teks_opsional(draft, "keterangan", "Keterangan", MAKS_KETERANGAN)?,
    })
}

/// Pagu yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct PaguSah {
    pub tahun: i64,
    pub id_divisi: Option<String>,
    pub nominal: i64,
    pub catatan: Option<String>,
}

/// Cermin `validasiPagu` (§26.4, Q-140). Divisi aktif diperiksa pemanggil.
pub fn validasi_pagu(draft: &Value) -> Result<PaguSah, String> {
    const PESAN: &str = "Pagu harus bilangan bulat 0–100.000.000.000.";
    Ok(PaguSah {
        tahun: tahun_wajib(draft)?,
        id_divisi: payload_text(draft, "id_divisi"),
        nominal: bulat(draft, "nominal", 0..=MAKS_PAGU, None, PESAN)?.ok_or(PESAN)?,
        catatan: teks_opsional(draft, "catatan", "Catatan", MAKS_CATATAN_PAGU)?,
    })
}

/// Cermin `idAnggaran`: satu pagu per tahun per divisi (atau Umum), jadi dua
/// sesi yang mengisi pagu yang sama menulis baris yang sama.
pub fn id_anggaran(tahun: i64, id_divisi: Option<&str>) -> String {
    format!("{tahun}:{}", id_divisi.unwrap_or(KELOMPOK_UMUM))
}

/// Cermin `periksaRencanaPelatihan`: rencana yang ditautkan ke pelatihan.
pub fn periksa_rencana_pelatihan(tanggal_mulai: &str, tahun_rencana: i64, dibatalkan: bool) -> Result<(), String> {
    if dibatalkan {
        return Err(PESAN_RENCANA_BATAL.into());
    }
    if tahun_dari(tanggal_mulai) != tahun_rencana {
        return Err(PESAN_RENCANA_TAHUN.into());
    }
    Ok(())
}

/// Cermin `periksaUbahRencana`: rencana batal terkunci, tahun terkunci
/// selama ada pelatihan tertaut yang tidak dibatalkan.
pub fn periksa_ubah_rencana(tahun_lama: i64, tahun_baru: i64, dibatalkan: bool, tertaut: i64) -> Result<(), String> {
    if dibatalkan {
        return Err(PESAN_RENCANA_BATAL.into());
    }
    if tahun_lama != tahun_baru && tertaut > 0 {
        return Err(PESAN_RENCANA_TAHUN_TERKUNCI.into());
    }
    Ok(())
}

/// Cermin `validasiBatalRencana`: alasan wajib, sekali, tanpa pelatihan
/// tertaut yang tidak dibatalkan.
pub fn validasi_batal_rencana(draft: &Value, sudah_dibatalkan: bool, tertaut: i64) -> Result<String, String> {
    if sudah_dibatalkan {
        return Err(PESAN_RENCANA_BATAL.into());
    }
    if tertaut > 0 {
        return Err(PESAN_RENCANA_TERTAUT.into());
    }
    teks_opsional(draft, "alasan", "Alasan pembatalan", MAKS_KETERANGAN)?
        .ok_or_else(|| "Alasan pembatalan wajib diisi.".into())
}

/// Cermin `statusRencana` (§26.3). `status_tertaut` = status pelatihan yang
/// menautkan rencana ini; `hari_ini` tanggal WIB jam database.
pub fn status_rencana(dibatalkan: bool, tahun: i64, bulan: Option<i64>, status_tertaut: &[&str], hari_ini: &str) -> &'static str {
    let ada = |s: &str| status_tertaut.contains(&s);
    if dibatalkan {
        return "Dibatalkan";
    }
    if ada("Selesai") {
        return "Terlaksana";
    }
    if ada("Berlangsung") {
        return "Berlangsung";
    }
    if ada("Dijadwalkan") {
        return "Dijadwalkan";
    }
    let tahun_ini = tahun_dari(hari_ini);
    let bulan_ini: i64 = hari_ini.chars().skip(5).take(2).collect::<String>().parse().unwrap_or(0);
    if tahun < tahun_ini || bulan.is_some_and(|b| (tahun, b) < (tahun_ini, bulan_ini)) {
        "Terlewat"
    } else {
        "Belum dijadwalkan"
    }
}

/// Tanda pagu satu kelompok atau total: melewati pagu tidak pernah ditolak.
fn tanda_pagu(pagu: Option<i64>, direncanakan: i64, terikat: i64, terpakai: i64) -> Vec<&'static str> {
    let mut tanda = Vec::new();
    match pagu {
        Some(p) => {
            if terikat + terpakai > p {
                tanda.push("lewat_pagu");
            }
            if direncanakan > p {
                tanda.push("rencana_lewat_pagu");
            }
        }
        None if terikat + terpakai > 0 => tanda.push("tanpa_pagu"),
        None => {}
    }
    tanda
}

struct Kelompok {
    kunci: String,
    id_divisi: Option<String>,
    nama: String,
    divisi_aktif: Option<bool>,
    id_anggaran: Option<String>,
    pagu: Option<i64>,
    catatan: Option<String>,
    direncanakan: i64,
    terikat: i64,
    terpakai: i64,
}

/// Kelompok untuk `id_divisi` baris itu (kosong = Umum), dibuat bila belum ada.
fn kelompok<'a>(daftar: &'a mut Vec<Kelompok>, baris: &Baris) -> &'a mut Kelompok {
    let id_divisi = teks_baris(baris, "id_divisi");
    let kunci = id_divisi.clone().unwrap_or_else(|| KELOMPOK_UMUM.into());
    let posisi = match daftar.iter().position(|k| k.kunci == kunci) {
        Some(i) => i,
        None => {
            daftar.push(Kelompok {
                nama: match &id_divisi {
                    Some(id) => teks_baris(baris, "nama_divisi").unwrap_or_else(|| id.clone()),
                    None => "Umum".into(),
                },
                divisi_aktif: id_divisi
                    .as_ref()
                    .and_then(|_| baris.get("divisi_aktif").and_then(Value::as_i64))
                    .map(|a| a == 1),
                kunci,
                id_divisi,
                id_anggaran: None,
                pagu: None,
                catatan: None,
                direncanakan: 0,
                terikat: 0,
                terpakai: 0,
            });
            daftar.len() - 1
        }
    };
    &mut daftar[posisi]
}

/// Cermin `ringkasAnggaran` (§26.4, Q-140 sampai Q-143). Masukannya baris
/// `PAGU_SQL`, `RENCANA_SQL`, dan `REALISASI_SQL` untuk `tahun`. Realisasi
/// kelompok hanya pelatihan bertahun mulai `tahun` yang tidak dibatalkan:
/// Terikat = Dijadwalkan, Terpakai = Berlangsung + Selesai, Sisa = Pagu −
/// keduanya (boleh minus). Beban divisi = divisi rencananya; tanpa rencana =
/// Umum dan baris "Di luar rencana". Per rencana dihitung dari semua
/// pelatihan tertautnya, apa pun tahunnya (`beda_tahun` bila tahunnya lain).
/// Kelompok: Umum lebih dulu, lalu urut nama dan id divisi (urutan bita).
pub fn ringkas_anggaran(pagu: &[Baris], rencana: &[Baris], pelatihan: &[Baris], tahun: i64, hari_ini: &str) -> Value {
    let mut daftar: Vec<Kelompok> = Vec::new();
    kelompok(&mut daftar, &Baris::new());
    for baris in pagu {
        let k = kelompok(&mut daftar, baris);
        k.id_anggaran = teks_baris(baris, "id_anggaran");
        k.pagu = Some(angka_baris(baris, "nominal"));
        k.catatan = teks_baris(baris, "catatan");
    }
    let status: Vec<&'static str> = pelatihan
        .iter()
        .map(|l| {
            status_pelatihan(
                &teks_baris(l, "tanggal_mulai").unwrap_or_default(),
                &teks_baris(l, "tanggal_selesai").unwrap_or_default(),
                teks_baris(l, "dibatalkan_pada").is_some(),
                hari_ini,
            )
        })
        .collect();
    let tahun_pelatihan = |i: usize| tahun_dari(&teks_baris(&pelatihan[i], "tanggal_mulai").unwrap_or_default());
    let mut rincian_rencana = Vec::new();
    for r in rencana {
        let id = teks_baris(r, "id_rencana");
        let dibatalkan = teks_baris(r, "dibatalkan_pada").is_some();
        let biaya_rencana = angka_baris(r, "biaya_rencana");
        if !dibatalkan {
            kelompok(&mut daftar, r).direncanakan += biaya_rencana;
        }
        let tertaut: Vec<usize> = (0..pelatihan.len())
            .filter(|&i| status[i] != "Dibatalkan" && id.is_some() && teks_baris(&pelatihan[i], "id_rencana") == id)
            .collect();
        let realisasi: i64 = tertaut.iter().map(|&i| angka_baris(&pelatihan[i], "biaya")).sum();
        let tahun_rencana = angka_baris(r, "tahun");
        let mut tanda = Vec::new();
        if realisasi > biaya_rencana {
            tanda.push("lewat_estimasi");
        }
        if tertaut.iter().any(|&i| tahun_pelatihan(i) != tahun_rencana) {
            tanda.push("beda_tahun");
        }
        let status_tertaut: Vec<&str> = tertaut.iter().map(|&i| status[i]).collect();
        let bulan = r.get("bulan").and_then(Value::as_i64);
        let mut baris = r.clone();
        baris.insert("status".into(), json!(status_rencana(dibatalkan, tahun_rencana, bulan, &status_tertaut, hari_ini)));
        baris.insert("realisasi".into(), json!(realisasi));
        baris.insert("jumlah_pelatihan".into(), json!(tertaut.len()));
        baris.insert(
            "peserta_aktual".into(),
            json!(tertaut.iter().map(|&i| angka_baris(&pelatihan[i], "jumlah_peserta")).sum::<i64>()),
        );
        let ringkas_pelatihan: Vec<Value> = tertaut
            .iter()
            .map(|&i| {
                json!({
                    "id_pelatihan": teks_baris(&pelatihan[i], "id_pelatihan"),
                    "nama": teks_baris(&pelatihan[i], "nama"),
                    "tanggal_mulai": teks_baris(&pelatihan[i], "tanggal_mulai"),
                    "biaya": angka_baris(&pelatihan[i], "biaya"),
                    "jumlah_peserta": angka_baris(&pelatihan[i], "jumlah_peserta"),
                    "status": status[i],
                })
            })
            .collect();
        baris.insert("pelatihan".into(), json!(ringkas_pelatihan));
        baris.insert("tanda".into(), json!(tanda));
        rincian_rencana.push(baris);
    }
    let (mut luar_jumlah, mut luar_realisasi, mut luar_peserta) = (0_i64, 0_i64, 0_i64);
    for (i, l) in pelatihan.iter().enumerate() {
        if status[i] == "Dibatalkan" || tahun_pelatihan(i) != tahun {
            continue;
        }
        let biaya = angka_baris(l, "biaya");
        if teks_baris(l, "id_rencana").is_none() {
            luar_jumlah += 1;
            luar_realisasi += biaya;
            luar_peserta += angka_baris(l, "jumlah_peserta");
        }
        let k = kelompok(&mut daftar, l);
        if status[i] == "Dijadwalkan" {
            k.terikat += biaya;
        } else {
            k.terpakai += biaya;
        }
    }
    daftar[1..].sort_by(|a, b| (&a.nama, &a.kunci).cmp(&(&b.nama, &b.kunci)));
    let jumlah = |f: fn(&Kelompok) -> i64| daftar.iter().map(f).sum::<i64>();
    let total_pagu = daftar.iter().any(|k| k.pagu.is_some()).then(|| jumlah(|k| k.pagu.unwrap_or(0)));
    let (direncanakan, terikat, terpakai) = (jumlah(|k| k.direncanakan), jumlah(|k| k.terikat), jumlah(|k| k.terpakai));
    let kelompok_json: Vec<Value> = daftar
        .iter()
        .map(|k| {
            json!({
                "kunci": k.kunci,
                "id_divisi": k.id_divisi,
                "nama": k.nama,
                "divisi_aktif": k.divisi_aktif,
                "id_anggaran": k.id_anggaran,
                "pagu": k.pagu,
                "catatan": k.catatan,
                "direncanakan": k.direncanakan,
                "terikat": k.terikat,
                "terpakai": k.terpakai,
                "sisa": k.pagu.map(|p| p - k.terikat - k.terpakai),
                "tanda": tanda_pagu(k.pagu, k.direncanakan, k.terikat, k.terpakai),
            })
        })
        .collect();
    json!({
        "kelompok": kelompok_json,
        "total": {
            "pagu": total_pagu,
            "direncanakan": direncanakan,
            "terikat": terikat,
            "terpakai": terpakai,
            "sisa": total_pagu.map(|p| p - terikat - terpakai),
            "tanda": tanda_pagu(total_pagu, direncanakan, terikat, terpakai),
        },
        "rencana": rincian_rencana,
        "di_luar_rencana": { "jumlah_pelatihan": luar_jumlah, "realisasi": luar_realisasi, "peserta_aktual": luar_peserta },
    })
}

// ── Khusus cloud (Q-87) ────────────────────────────────────────────────────

pub const DAFTAR_PELATIHAN_SQL: &str = "SELECT l.*, (SELECT COUNT(*) FROM hr_pelatihan_peserta p WHERE p.id_pelatihan = l.id_pelatihan) AS jumlah_peserta FROM hr_pelatihan l WHERE strftime('%Y', l.tanggal_mulai) = ?1 ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";
pub const PESERTA_SQL: &str = "SELECT p.*, m.nama, m.divisi, m.jabatan_status, m.status_aktif, d.nomor, d.tanggal_terbit, d.tanggal_kedaluwarsa, d.catatan AS catatan_sertifikat FROM hr_pelatihan_peserta p LEFT JOIN master_data m ON m.id_unik = p.id_karyawan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY m.nama, p.id_karyawan;";
pub const BERKAS_PESERTA_SQL: &str = "SELECT b.id_berkas, b.id_dokumen, b.urutan, b.nama_berkas, b.mime_type, length(b.data_base64) AS panjang FROM hr_dokumen_berkas b JOIN hr_pelatihan_peserta p ON p.id_dokumen = b.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY b.id_dokumen, b.urutan;";
/// Riwayat satu karyawan: pelatihan yang tidak dibatalkan (§22.7).
pub const RIWAYAT_SQL: &str = "SELECT l.id_pelatihan, l.nama, l.penyelenggara, l.tanggal_mulai, l.tanggal_selesai, l.lokasi, p.hasil, p.catatan, p.id_dokumen, d.nomor, d.tanggal_kedaluwarsa FROM hr_pelatihan_peserta p JOIN hr_pelatihan l ON l.id_pelatihan = p.id_pelatihan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_karyawan = ?1 AND l.dibatalkan_pada IS NULL ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";
pub const INSERT_PELATIHAN_SQL: &str = "INSERT INTO hr_pelatihan (id_pelatihan, nama, penyelenggara, tanggal_mulai, tanggal_selesai, lokasi, biaya, keterangan, dicatat_oleh, id_rencana) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";
pub const UBAH_PELATIHAN_SQL: &str = "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now'), id_rencana = ?10 WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";
pub const BATAL_PELATIHAN_SQL: &str = "UPDATE hr_pelatihan SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";
/// Peserta hanya karyawan Aktif di cloud, dibaca di statement yang sama;
/// PK `<id_pelatihan>:<id_karyawan>` menahan duplikat.
pub const TAMBAH_PESERTA_SQL: &str = "INSERT INTO hr_pelatihan_peserta (id_peserta, id_pelatihan, id_karyawan, dicatat_oleh) SELECT ?1 || ':' || m.id_unik, ?1, m.id_unik, ?3 FROM master_data m WHERE m.id_unik = ?2 AND m.status_aktif = 'Aktif' AND EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_pelatihan = ?1 AND l.dibatalkan_pada IS NULL) ON CONFLICT(id_peserta) DO NOTHING;";
pub const LEPAS_PESERTA_SQL: &str = "DELETE FROM hr_pelatihan_peserta WHERE id_peserta = ?1 AND id_dokumen IS NULL;";
pub const HASIL_PESERTA_SQL: &str = "UPDATE hr_pelatihan_peserta SET hasil = ?2, catatan = ?3 WHERE id_peserta = ?1;";
pub const TAUT_SERTIFIKAT_SQL: &str = "UPDATE hr_pelatihan_peserta SET id_dokumen = ?2 WHERE id_peserta = ?1 AND (id_dokumen IS NULL OR id_dokumen = ?2);";
/// Isi berkas sertifikat hanya bila dokumennya tertaut ke peserta: izin
/// pelatihan tidak membuka dokumen karyawan lain (§22.8).
pub const BERKAS_SERTIFIKAT_SQL: &str = "SELECT b.id_berkas, b.nama_berkas, b.mime_type, b.data_base64 FROM hr_dokumen_berkas b WHERE b.id_berkas = ?1 AND EXISTS (SELECT 1 FROM hr_pelatihan_peserta p WHERE p.id_dokumen = b.id_dokumen);";

// Fase 11. `?1` = tahun (INTEGER). Nama divisi dibaca hidup lewat LEFT JOIN.
pub const PAGU_SQL: &str = "SELECT a.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_anggaran a LEFT JOIN hr_divisi d ON d.id_divisi = a.id_divisi WHERE a.tahun = ?1 ORDER BY a.id_anggaran;";
pub const RENCANA_SQL: &str = "SELECT r.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_rencana r LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE r.tahun = ?1 ORDER BY r.bulan IS NULL, r.bulan, r.nama, r.id_rencana;";
/// Pelatihan bertahun mulai `?1`, ditambah pelatihan tahun lain yang menautkan
/// rencana `?1` (realisasi per rencana). `id_rencana`/`id_divisi` diambil dari
/// rencana yang benar-benar ada, jadi tautan patah terbaca di luar rencana.
pub const REALISASI_SQL: &str = "SELECT l.id_pelatihan, l.nama, l.tanggal_mulai, l.tanggal_selesai, l.biaya, l.dibatalkan_pada, r.id_rencana, r.id_divisi, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif, (SELECT COUNT(*) FROM hr_pelatihan_peserta p WHERE p.id_pelatihan = l.id_pelatihan) AS jumlah_peserta FROM hr_pelatihan l LEFT JOIN hr_pelatihan_rencana r ON r.id_rencana = l.id_rencana LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE CAST(strftime('%Y', l.tanggal_mulai) AS INTEGER) = ?1 OR r.tahun = ?1 ORDER BY l.tanggal_mulai, l.id_pelatihan;";
/// Upsert berid `<tahun>:<id_divisi|umum>`: yang terakhir menang (Q-149).
pub const SIMPAN_PAGU_SQL: &str = "INSERT INTO hr_pelatihan_anggaran (id_anggaran, tahun, id_divisi, nominal, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id_anggaran) DO UPDATE SET nominal = excluded.nominal, catatan = excluded.catatan, diubah_oleh = excluded.dicatat_oleh, diubah_pada = datetime('now');";
pub const HAPUS_PAGU_SQL: &str = "DELETE FROM hr_pelatihan_anggaran WHERE id_anggaran = ?1;";
pub const RENCANA_SATU_SQL: &str = "SELECT r.*, d.nama AS nama_divisi, d.is_aktif AS divisi_aktif FROM hr_pelatihan_rencana r LEFT JOIN hr_divisi d ON d.id_divisi = r.id_divisi WHERE r.id_rencana = ?1;";
/// Semua pelatihan yang menautkan satu rencana, untuk status dan larangan
/// batal/ubah tahun (yang tidak dibatalkan saja yang menghalangi).
pub const TAUTAN_RENCANA_SQL: &str = "SELECT tanggal_mulai, tanggal_selesai, dibatalkan_pada FROM hr_pelatihan WHERE id_rencana = ?1;";
pub const INSERT_RENCANA_SQL: &str = "INSERT INTO hr_pelatihan_rencana (id_rencana, tahun, nama, id_divisi, bulan, peserta_rencana, biaya_rencana, penyelenggara, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";
/// Tahun berubah hanya tanpa pelatihan tertaut, diperiksa lagi di statement
/// yang sama supaya tautan yang lahir di sela pemeriksaan tetap menang.
pub const UBAH_RENCANA_SQL: &str = "UPDATE hr_pelatihan_rencana SET tahun = ?2, nama = ?3, id_divisi = ?4, bulan = ?5, peserta_rencana = ?6, biaya_rencana = ?7, penyelenggara = ?8, keterangan = ?9, diubah_oleh = ?10, diubah_pada = datetime('now') WHERE id_rencana = ?1 AND dibatalkan_pada IS NULL AND (tahun = ?2 OR NOT EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_rencana = ?1 AND l.dibatalkan_pada IS NULL));";
pub const BATAL_RENCANA_SQL: &str = "UPDATE hr_pelatihan_rencana SET dibatalkan_oleh = ?2, dibatalkan_pada = datetime('now'), alasan_batal = ?3 WHERE id_rencana = ?1 AND dibatalkan_pada IS NULL AND NOT EXISTS (SELECT 1 FROM hr_pelatihan l WHERE l.id_rencana = ?1 AND l.dibatalkan_pada IS NULL);";

fn tak_ditemukan(apa: &str) -> CommandError {
    invalid(format!("{apa} tidak ditemukan."))
}

async fn satu(turso: &TursoClient, sql: &str, args: Vec<Value>) -> Result<Option<Baris>, CommandError> {
    Ok(objek(turso, sql, args).await?.into_iter().next())
}

fn dengan_status(baris: &mut Baris, hari_ini: &str) {
    let status = status_pelatihan(
        &teks_baris(baris, "tanggal_mulai").unwrap_or_default(),
        &teks_baris(baris, "tanggal_selesai").unwrap_or_default(),
        teks_baris(baris, "dibatalkan_pada").is_some(),
        hari_ini,
    );
    baris.insert("status".into(), json!(status));
}

async fn pelatihan(turso: &TursoClient, id: &str) -> Result<Baris, CommandError> {
    satu(turso, "SELECT * FROM hr_pelatihan WHERE id_pelatihan = ?1;", vec![json!(id)])
        .await?
        .ok_or_else(|| tak_ditemukan("Pelatihan"))
}

/// Pelatihan satu tahun (bawaan tahun berjalan WIB).
pub async fn daftar(turso: &TursoClient, tahun: Option<i64>) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let tahun = tahun.unwrap_or_else(|| hari_ini.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0));
    let mut daftar = objek(turso, DAFTAR_PELATIHAN_SQL, vec![json!(format!("{tahun:04}"))]).await?;
    for baris in &mut daftar {
        dengan_status(baris, &hari_ini);
    }
    Ok(json!({ "pelatihan": daftar, "tahun": tahun, "hari_ini": hari_ini }))
}

/// Rincian satu pelatihan: peserta, hasil, sertifikat, dan daftar berkasnya.
pub async fn rincian(turso: &TursoClient, id_pelatihan: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let mut data = pelatihan(turso, id_pelatihan).await?;
    dengan_status(&mut data, &hari_ini);
    let mut peserta = objek(turso, PESERTA_SQL, vec![json!(id_pelatihan)]).await?;
    let berkas = objek(turso, BERKAS_PESERTA_SQL, vec![json!(id_pelatihan)]).await?;
    for p in &mut peserta {
        let id_dokumen = p.get("id_dokumen").cloned().unwrap_or(Value::Null);
        let milik: Vec<&Baris> = berkas.iter().filter(|b| !id_dokumen.is_null() && b.get("id_dokumen") == Some(&id_dokumen)).collect();
        p.insert("berkas".into(), json!(milik));
    }
    let jenis = satu(turso, "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;", vec![json!(JENIS_SERTIFIKAT)]).await?;
    let rencana = match teks_baris(&data, "id_rencana") {
        Some(id) => match satu(turso, RENCANA_SATU_SQL, vec![json!(id)]).await? {
            Some(mut r) => {
                let status = status_tautan(turso, &id, &hari_ini).await?;
                let nilai = status_rencana(
                    teks_baris(&r, "dibatalkan_pada").is_some(),
                    angka_baris(&r, "tahun"),
                    r.get("bulan").and_then(Value::as_i64),
                    &status,
                    &hari_ini,
                );
                r.insert("status".into(), json!(nilai));
                json!(r)
            }
            None => Value::Null,
        },
        None => Value::Null,
    };
    Ok(json!({
        "pelatihan": data,
        "peserta": peserta,
        "rencana": rencana,
        "sertifikat_aktif": jenis.is_some_and(|j| angka_baris(&j, "is_aktif") == 1),
    }))
}

/// Riwayat pelatihan satu karyawan (tab Pelatihan rincian karyawan).
pub async fn riwayat(turso: &TursoClient, id_karyawan: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let mut daftar = objek(turso, RIWAYAT_SQL, vec![json!(id_karyawan)]).await?;
    for baris in &mut daftar {
        dengan_status(baris, &hari_ini);
    }
    Ok(json!({ "riwayat": daftar }))
}

/// Buat atau ubah pelatihan (`aksi` kosong/`simpan`), atau `batal`.
pub async fn simpan(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let aksi = payload_text(draft, "aksi").unwrap_or_else(|| "simpan".into());
    siap(turso).await?;
    let lama = match payload_text(draft, "id_pelatihan") {
        Some(id) => Some(pelatihan(turso, &id).await?),
        None => None,
    };
    let dibatalkan = lama.as_ref().is_some_and(|l| teks_baris(l, "dibatalkan_pada").is_some());
    match (aksi.as_str(), lama.as_ref().and_then(|l| teks_baris(l, "id_pelatihan"))) {
        ("batal", Some(id)) => {
            let alasan = validasi_batal_pelatihan(draft, dibatalkan).map_err(invalid)?;
            turso
                .query_one(BATAL_PELATIHAN_SQL, vec![json!(id), json!(oleh), json!(alasan)])
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_pelatihan": id }))
        }
        ("batal", None) => Err(tak_ditemukan("Pelatihan")),
        ("simpan", lama_id) => {
            let sah = validasi_pelatihan(draft).map_err(invalid)?;
            if dibatalkan {
                return Err(invalid(PESAN_PELATIHAN_BATAL));
            }
            // Juga saat tautannya tetap: tanggal yang pindah tahun ditolak (§26.3).
            if let Some(id_rencana) = &sah.id_rencana {
                let rencana = rencana_satu(turso, id_rencana).await?;
                periksa_rencana_pelatihan(
                    &sah.tanggal_mulai,
                    angka_baris(&rencana, "tahun"),
                    teks_baris(&rencana, "dibatalkan_pada").is_some(),
                )
                .map_err(invalid)?;
            }
            let (sql, id) = match lama_id {
                Some(id) => (UBAH_PELATIHAN_SQL, id),
                None => (INSERT_PELATIHAN_SQL, new_hex_id("plt-")),
            };
            turso
                .query_one(
                    sql,
                    vec![
                        json!(id),
                        json!(sah.nama),
                        json!(sah.penyelenggara),
                        json!(sah.tanggal_mulai),
                        json!(sah.tanggal_selesai),
                        json!(sah.lokasi),
                        json!(sah.biaya),
                        json!(sah.keterangan),
                        json!(oleh),
                        json!(sah.id_rencana),
                    ],
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_pelatihan": id }))
        }
        _ => Err(invalid("Aksi pelatihan tidak dikenal.")),
    }
}

/// Peserta: `tambah` (`id_karyawan` = daftar id), `lepas`, atau `hasil`.
pub async fn simpan_peserta(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_pelatihan = payload_text(draft, "id_pelatihan").ok_or_else(|| tak_ditemukan("Pelatihan"))?;
    siap(turso).await?;
    let data = pelatihan(turso, &id_pelatihan).await?;
    if teks_baris(&data, "dibatalkan_pada").is_some() {
        return Err(invalid(PESAN_PELATIHAN_BATAL));
    }
    match payload_text(draft, "aksi").as_deref().unwrap_or("") {
        "tambah" => {
            let daftar: Vec<String> = draft
                .get("id_karyawan")
                .and_then(Value::as_array)
                .map(|d| d.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect())
                .unwrap_or_default();
            if daftar.is_empty() {
                return Err(invalid("Karyawan wajib dipilih."));
            }
            if daftar.len() > 500 {
                return Err(invalid("Maksimal 500 peserta sekali tambah."));
            }
            for id in &daftar {
                let karyawan = satu(turso, "SELECT nama, status_aktif FROM master_data WHERE id_unik = ?1;", vec![json!(id)])
                    .await?
                    .ok_or_else(|| tak_ditemukan("Karyawan"))?;
                if teks_baris(&karyawan, "status_aktif").as_deref() != Some("Aktif") {
                    let nama = teks_baris(&karyawan, "nama").unwrap_or_default();
                    return Err(invalid(format!("{nama} tidak aktif dan tidak bisa menjadi peserta.")));
                }
            }
            turso
                .execute_atomic(
                    daftar
                        .iter()
                        .map(|id| Statement::new(TAMBAH_PESERTA_SQL, vec![json!(id_pelatihan), json!(id), json!(oleh)]))
                        .collect(),
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true }))
        }
        "lepas" => {
            let sah = validasi_peserta(draft).map_err(invalid)?;
            let id = id_peserta(&id_pelatihan, &sah.id_karyawan);
            let peserta = satu(turso, "SELECT id_dokumen FROM hr_pelatihan_peserta WHERE id_peserta = ?1;", vec![json!(id)])
                .await?
                .ok_or_else(|| tak_ditemukan("Peserta"))?;
            if teks_baris(&peserta, "id_dokumen").is_some() {
                return Err(invalid(PESAN_PESERTA_BERSERTIFIKAT));
            }
            turso.query_one(LEPAS_PESERTA_SQL, vec![json!(id)]).await.map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true }))
        }
        "hasil" => {
            let sah = validasi_peserta(draft).map_err(invalid)?;
            let id = id_peserta(&id_pelatihan, &sah.id_karyawan);
            if satu(turso, "SELECT 1 AS ada FROM hr_pelatihan_peserta WHERE id_peserta = ?1;", vec![json!(id)]).await?.is_none() {
                return Err(tak_ditemukan("Peserta"));
            }
            turso
                .query_one(HASIL_PESERTA_SQL, vec![json!(id), json!(sah.hasil), json!(sah.catatan)])
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true }))
        }
        _ => Err(invalid("Aksi peserta tidak dikenal.")),
    }
}

/// Peserta yang sertifikatnya diubah: (id_peserta, id_karyawan, id_dokumen).
async fn peserta_sertifikat(turso: &TursoClient, draft: &Value) -> Result<(String, String, Option<String>, Baris), CommandError> {
    let id_pelatihan = payload_text(draft, "id_pelatihan").ok_or_else(|| tak_ditemukan("Pelatihan"))?;
    let id_karyawan = payload_text(draft, "id_karyawan").ok_or_else(|| invalid("Karyawan wajib dipilih."))?;
    let id = id_peserta(&id_pelatihan, &id_karyawan);
    let data = pelatihan(turso, &id_pelatihan).await?;
    let peserta = satu(turso, "SELECT id_dokumen FROM hr_pelatihan_peserta WHERE id_peserta = ?1;", vec![json!(id)])
        .await?
        .ok_or_else(|| tak_ditemukan("Peserta"))?;
    Ok((id, id_karyawan, teks_baris(&peserta, "id_dokumen"), data))
}

/// Sertifikat peserta lewat inti dokumen (Q-97): `simpan` (data + berkas
/// baru, satu batch bersama tautannya), `hapus` (lewat `hris::hapus_dokumen`,
/// yang melepas tautan), atau `hapus_berkas`. `id_jenis` dikunci
/// `dok-sertifikat` dan `id_karyawan` = peserta.
pub async fn simpan_sertifikat(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    siap(turso).await?;
    let (id, id_karyawan, id_dokumen, data) = peserta_sertifikat(turso, draft).await?;
    match payload_text(draft, "aksi").as_deref().unwrap_or("simpan") {
        "simpan" => {
            let mut isian = draft.as_object().cloned().unwrap_or_default();
            isian.insert("id_karyawan".into(), json!(id_karyawan));
            isian.insert("id_jenis".into(), json!(JENIS_SERTIFIKAT));
            isian.insert("id_dokumen".into(), json!(id_dokumen));
            if payload_text(draft, "catatan").is_none() {
                isian.insert("catatan".into(), json!(teks_baris(&data, "nama")));
            }
            let sah = hris::validasi_dokumen(&Value::Object(isian)).map_err(invalid)?;
            let berkas_baru: Vec<&Value> = draft.get("berkas").and_then(Value::as_array).map(|b| b.iter().collect()).unwrap_or_default();
            for b in &berkas_baru {
                hris::validasi_berkas(
                    &payload_text(b, "mime_type").unwrap_or_default(),
                    b.get("data_base64").and_then(Value::as_str).unwrap_or(""),
                )
                .map_err(invalid)?;
                if payload_text(b, "nama_berkas").is_some_and(|n| n.chars().count() > hris::MAKS_TEKS) {
                    return Err(invalid(format!("Nama berkas maksimal {} karakter.", hris::MAKS_TEKS)));
                }
            }
            if id_dokumen.is_none() {
                let jenis = satu(turso, "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;", vec![json!(JENIS_SERTIFIKAT)]).await?;
                if !jenis.is_some_and(|j| angka_baris(&j, "is_aktif") == 1) {
                    return Err(invalid(PESAN_SERTIFIKAT_NONAKTIF));
                }
            }
            let id_dok = id_dokumen.clone().unwrap_or_else(|| new_hex_id("hd-"));
            let terpakai: HashSet<i64> = match &id_dokumen {
                Some(d) => objek(turso, "SELECT urutan FROM hr_dokumen_berkas WHERE id_dokumen = ?1;", vec![json!(d)])
                    .await?
                    .iter()
                    .map(|b| angka_baris(b, "urutan"))
                    .collect(),
                None => HashSet::new(),
            };
            let mut slot = (1..=hris::MAKS_BERKAS_PER_DOKUMEN).filter(|u| !terpakai.contains(u));
            let mut statements = vec![Statement::new(
                hris::SIMPAN_DOKUMEN_SQL,
                vec![
                    json!(id_dok),
                    json!(sah.id_karyawan),
                    json!(sah.id_jenis),
                    json!(sah.nomor),
                    json!(sah.tanggal_terbit),
                    json!(sah.tanggal_kedaluwarsa),
                    json!(sah.catatan),
                    json!(oleh),
                ],
            )];
            for b in &berkas_baru {
                let urutan = slot.next().ok_or_else(|| {
                    invalid(format!("Satu dokumen maksimal {} berkas.", hris::MAKS_BERKAS_PER_DOKUMEN))
                })?;
                statements.push(Statement::new(
                    hris::INSERT_BERKAS_DOKUMEN_SQL,
                    vec![
                        json!(new_hex_id("hb-")),
                        json!(id_dok),
                        json!(urutan),
                        json!(payload_text(b, "nama_berkas")),
                        json!(payload_text(b, "mime_type")),
                        json!(b.get("data_base64").and_then(Value::as_str)),
                    ],
                ));
            }
            statements.push(Statement::new(TAUT_SERTIFIKAT_SQL, vec![json!(id), json!(id_dok)]));
            turso.execute_atomic(statements).await.map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_dokumen": id_dok }))
        }
        "hapus" => {
            let id_dok = id_dokumen.ok_or_else(|| tak_ditemukan("Sertifikat"))?;
            hris::hapus_dokumen(turso, &id_dok).await
        }
        "hapus_berkas" => {
            let id_dok = id_dokumen.ok_or_else(|| tak_ditemukan("Sertifikat"))?;
            let id_berkas = payload_text(draft, "id_berkas").ok_or_else(|| tak_ditemukan("Berkas"))?;
            turso
                .query_one(
                    "DELETE FROM hr_dokumen_berkas WHERE id_berkas = ?1 AND id_dokumen = ?2;",
                    vec![json!(id_berkas), json!(id_dok)],
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true }))
        }
        _ => Err(invalid("Aksi sertifikat tidak dikenal.")),
    }
}

async fn rencana_satu(turso: &TursoClient, id: &str) -> Result<Baris, CommandError> {
    satu(turso, RENCANA_SATU_SQL, vec![json!(id)]).await?.ok_or_else(|| tak_ditemukan("Rencana"))
}

/// Status setiap pelatihan yang menautkan rencana `id`.
async fn status_tautan(turso: &TursoClient, id: &str, hari_ini: &str) -> Result<Vec<&'static str>, CommandError> {
    Ok(objek(turso, TAUTAN_RENCANA_SQL, vec![json!(id)])
        .await?
        .iter()
        .map(|l| {
            status_pelatihan(
                &teks_baris(l, "tanggal_mulai").unwrap_or_default(),
                &teks_baris(l, "tanggal_selesai").unwrap_or_default(),
                teks_baris(l, "dibatalkan_pada").is_some(),
                hari_ini,
            )
        })
        .collect())
}

fn jumlah_tertaut(status: &[&str]) -> i64 {
    status.iter().filter(|s| **s != "Dibatalkan").count() as i64
}

/// Divisi rencana atau pagu: bila diisi harus ada, dan aktif kecuali tidak
/// berubah dari yang tersimpan (pola lowongan, §22.15).
async fn periksa_divisi(turso: &TursoClient, id_divisi: Option<&str>, tetap: bool) -> Result<(), CommandError> {
    let Some(id) = id_divisi else { return Ok(()) };
    let baris = satu(turso, "SELECT is_aktif FROM hr_divisi WHERE id_divisi = ?1;", vec![json!(id)])
        .await?
        .ok_or_else(|| tak_ditemukan("Divisi"))?;
    if !tetap && angka_baris(&baris, "is_aktif") != 1 {
        return Err(invalid("Divisi sudah nonaktif."));
    }
    Ok(())
}

/// Rencana dan anggaran satu tahun (bawaan tahun berjalan WIB jam database):
/// pagu, rencana + status + tanda, dan ringkasan per kelompok.
pub async fn rencana_tahun(turso: &TursoClient, tahun: Option<i64>) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let tahun = tahun.unwrap_or_else(|| tahun_dari(&hari_ini));
    if !(2000..=2100).contains(&tahun) {
        return Err(invalid("Tahun harus 2000–2100."));
    }
    let pagu = objek(turso, PAGU_SQL, vec![json!(tahun)]).await?;
    let rencana = objek(turso, RENCANA_SQL, vec![json!(tahun)]).await?;
    let pelatihan = objek(turso, REALISASI_SQL, vec![json!(tahun)]).await?;
    let mut hasil = ringkas_anggaran(&pagu, &rencana, &pelatihan, tahun, &hari_ini);
    hasil["tahun"] = json!(tahun);
    hasil["hari_ini"] = json!(hari_ini);
    Ok(hasil)
}

/// Rencana (`aksi` `simpan` bawaan, `batal`) atau pagu (`pagu`,
/// `hapus_pagu`). Melewati pagu tidak pernah ditolak (Q-143).
pub async fn simpan_rencana(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let aksi = payload_text(draft, "aksi").unwrap_or_else(|| "simpan".into());
    siap(turso).await?;
    match aksi.as_str() {
        "pagu" => {
            let sah = validasi_pagu(draft).map_err(invalid)?;
            let id = id_anggaran(sah.tahun, sah.id_divisi.as_deref());
            let ada = satu(turso, "SELECT 1 AS ada FROM hr_pelatihan_anggaran WHERE id_anggaran = ?1;", vec![json!(id)])
                .await?
                .is_some();
            periksa_divisi(turso, sah.id_divisi.as_deref(), ada).await?;
            turso
                .query_one(
                    SIMPAN_PAGU_SQL,
                    vec![json!(id), json!(sah.tahun), json!(sah.id_divisi), json!(sah.nominal), json!(sah.catatan), json!(oleh)],
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_anggaran": id }))
        }
        "hapus_pagu" => {
            let tahun = tahun_wajib(draft).map_err(invalid)?;
            let id = id_anggaran(tahun, payload_text(draft, "id_divisi").as_deref());
            let hasil = turso.query_one(HAPUS_PAGU_SQL, vec![json!(id)]).await.map_err(tak_terhubung)?;
            if hasil.rows_affected == 0 {
                return Err(tak_ditemukan("Pagu"));
            }
            Ok(json!({ "sukses": true, "id_anggaran": id }))
        }
        "simpan" | "batal" => {
            let hari_ini = hari_ini_cloud(turso).await?;
            let lama = match payload_text(draft, "id_rencana") {
                Some(id) => Some(rencana_satu(turso, &id).await?),
                None => None,
            };
            let id_lama = lama.as_ref().and_then(|l| teks_baris(l, "id_rencana"));
            let dibatalkan = lama.as_ref().is_some_and(|l| teks_baris(l, "dibatalkan_pada").is_some());
            let tertaut = match &id_lama {
                Some(id) => jumlah_tertaut(&status_tautan(turso, id, &hari_ini).await?),
                None => 0,
            };
            if aksi == "batal" {
                let id = id_lama.ok_or_else(|| tak_ditemukan("Rencana"))?;
                let alasan = validasi_batal_rencana(draft, dibatalkan, tertaut).map_err(invalid)?;
                let hasil = turso
                    .query_one(BATAL_RENCANA_SQL, vec![json!(id), json!(oleh), json!(alasan)])
                    .await
                    .map_err(tak_terhubung)?;
                if hasil.rows_affected == 0 {
                    // Pelatihan tertaut lahir di sela pemeriksaan, atau sudah dibatalkan sesi lain.
                    let ulang = rencana_satu(turso, &id).await?;
                    let pesan = if teks_baris(&ulang, "dibatalkan_pada").is_some() { PESAN_RENCANA_BATAL } else { PESAN_RENCANA_TERTAUT };
                    return Err(invalid(pesan));
                }
                return Ok(json!({ "sukses": true, "id_rencana": id }));
            }
            let sah = validasi_rencana(draft).map_err(invalid)?;
            if let Some(l) = &lama {
                periksa_ubah_rencana(angka_baris(l, "tahun"), sah.tahun, dibatalkan, tertaut).map_err(invalid)?;
            }
            let tetap = lama.is_some() && lama.as_ref().and_then(|l| teks_baris(l, "id_divisi")) == sah.id_divisi;
            periksa_divisi(turso, sah.id_divisi.as_deref(), tetap).await?;
            let (sql, id) = match id_lama {
                Some(id) => (UBAH_RENCANA_SQL, id),
                None => (INSERT_RENCANA_SQL, new_hex_id("rcn-")),
            };
            let hasil = turso
                .query_one(
                    sql,
                    vec![
                        json!(id),
                        json!(sah.tahun),
                        json!(sah.nama),
                        json!(sah.id_divisi),
                        json!(sah.bulan),
                        json!(sah.peserta_rencana),
                        json!(sah.biaya_rencana),
                        json!(sah.penyelenggara),
                        json!(sah.keterangan),
                        json!(oleh),
                    ],
                )
                .await
                .map_err(tak_terhubung)?;
            if hasil.rows_affected == 0 {
                let ulang = rencana_satu(turso, &id).await?;
                let pesan = if teks_baris(&ulang, "dibatalkan_pada").is_some() { PESAN_RENCANA_BATAL } else { PESAN_RENCANA_TAHUN_TERKUNCI };
                return Err(invalid(pesan));
            }
            Ok(json!({ "sukses": true, "id_rencana": id }))
        }
        _ => Err(invalid("Aksi rencana tidak dikenal.")),
    }
}

/// Isi satu berkas sertifikat yang tertaut ke peserta.
pub async fn berkas_sertifikat(turso: &TursoClient, id_berkas: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    satu(turso, BERKAS_SERTIFIKAT_SQL, vec![json!(id_berkas)])
        .await?
        .map(|b| json!(b))
        .ok_or_else(|| tak_ditemukan("Berkas"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor yang sama diuji di `validations/hr-pelatihan.test.ts`.

    const HARI: &str = "2026-11-12";

    #[test]
    fn pelatihan_validasi_dan_status() {
        let sah = validasi_pelatihan(&json!({
            "nama": " K3  Dasar ", "tanggal_mulai": "2026-12-01", "tanggal_selesai": "2026-12-02", "biaya": 3_000_000
        }))
        .unwrap();
        assert_eq!((sah.nama.as_str(), sah.biaya, sah.lokasi, sah.id_rencana), ("K3 Dasar", 3_000_000, None, None));
        let bertaut = validasi_pelatihan(&json!({
            "nama": "K3", "tanggal_mulai": "2026-12-01", "tanggal_selesai": "2026-12-01", "id_rencana": " rcn-1 "
        }))
        .unwrap();
        assert_eq!(bertaut.id_rencana.as_deref(), Some("rcn-1"));
        let tanpa_biaya = validasi_pelatihan(&json!({ "nama": "K3", "tanggal_mulai": "2026-12-01", "tanggal_selesai": "2026-12-01" })).unwrap();
        assert_eq!(tanpa_biaya.biaya, 0);
        let dasar = |biaya: Value, selesai: &str| {
            validasi_pelatihan(&json!({ "nama": "K3", "tanggal_mulai": "2026-12-01", "tanggal_selesai": selesai, "biaya": biaya }))
        };
        assert_eq!(dasar(json!(-1), "2026-12-01"), Err("Biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar(json!(1.5), "2026-12-01"), Err("Biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar(json!(1_000_000_001_i64), "2026-12-01"), Err("Biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar(json!("5000"), "2026-12-01"), Err("Biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar(json!(0), "2026-11-30"), Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into()));
        assert_eq!(validasi_pelatihan(&json!({ "tanggal_mulai": "2026-12-01", "tanggal_selesai": "2026-12-01" })), Err("Nama pelatihan wajib diisi.".into()));
        assert_eq!(validasi_pelatihan(&json!({ "nama": "K3", "tanggal_mulai": "2026-02-30", "tanggal_selesai": "2026-12-01" })), Err("Tanggal mulai tidak valid.".into()));
        assert_eq!(
            validasi_pelatihan(&json!({ "nama": "K3", "tanggal_mulai": "2026-12-01", "tanggal_selesai": "2026-12-01", "lokasi": "a".repeat(101) })),
            Err("Lokasi maksimal 100 karakter.".into())
        );

        assert_eq!(status_pelatihan("2026-11-13", "2026-11-14", false, HARI), "Dijadwalkan");
        assert_eq!(status_pelatihan("2026-11-12", "2026-11-12", false, HARI), "Berlangsung");
        assert_eq!(status_pelatihan("2026-11-10", "2026-11-11", false, HARI), "Selesai");
        assert_eq!(status_pelatihan("2026-11-10", "2026-11-11", true, HARI), "Dibatalkan");
    }

    #[test]
    fn peserta_dan_batal() {
        assert_eq!(id_peserta("plt-1", "EMP_A"), "plt-1:EMP_A");
        assert_eq!(
            validasi_peserta(&json!({ "id_karyawan": "EMP_A", "hasil": "Lulus" })),
            Ok(PesertaSah { id_karyawan: "EMP_A".into(), hasil: Some("Lulus".into()), catatan: None })
        );
        assert_eq!(validasi_peserta(&json!({ "id_karyawan": "EMP_A", "hasil": "Gagal" })), Err("Hasil pelatihan tidak dikenal.".into()));
        assert_eq!(validasi_peserta(&json!({ "hasil": "Lulus" })), Err("Karyawan wajib dipilih.".into()));
        assert_eq!(validasi_batal_pelatihan(&json!({ "alasan": " Ditunda " }), false), Ok("Ditunda".into()));
        assert_eq!(validasi_batal_pelatihan(&json!({}), false), Err("Alasan pembatalan wajib diisi.".into()));
        assert_eq!(validasi_batal_pelatihan(&json!({ "alasan": "x" }), true), Err(PESAN_PELATIHAN_BATAL.into()));
    }

    #[test]
    fn rencana_dan_pagu_validasi() {
        let sah = validasi_rencana(&json!({
            "tahun": 2026, "nama": " K3  Gudang ", "id_divisi": "div-a", "bulan": 3,
            "peserta_rencana": 10, "biaya_rencana": 4_000_000, "penyelenggara": " LSP "
        }))
        .unwrap();
        assert_eq!(
            sah,
            RencanaSah {
                id_rencana: None,
                tahun: 2026,
                nama: "K3 Gudang".into(),
                id_divisi: Some("div-a".into()),
                bulan: Some(3),
                peserta_rencana: 10,
                biaya_rencana: 4_000_000,
                penyelenggara: Some("LSP".into()),
                keterangan: None,
            }
        );
        let minimal = validasi_rencana(&json!({ "tahun": 2027, "nama": "Etika", "bulan": null })).unwrap();
        assert_eq!((minimal.id_divisi, minimal.bulan, minimal.peserta_rencana, minimal.biaya_rencana), (None, None, 0, 0));
        let dasar = |kunci: &str, nilai: Value| {
            let mut d = json!({ "tahun": 2026, "nama": "K3" });
            d[kunci] = nilai;
            validasi_rencana(&d)
        };
        assert_eq!(dasar("tahun", json!(1999)), Err("Tahun harus 2000–2100.".into()));
        assert_eq!(dasar("tahun", json!(null)), Err("Tahun harus 2000–2100.".into()));
        assert_eq!(dasar("tahun", json!("2026")), Err("Tahun harus 2000–2100.".into()));
        assert_eq!(dasar("nama", json!("  ")), Err("Nama rencana wajib diisi.".into()));
        assert_eq!(dasar("nama", json!("a".repeat(101))), Err("Nama rencana maksimal 100 karakter.".into()));
        assert_eq!(dasar("bulan", json!(13)), Err("Bulan harus 1–12.".into()));
        assert_eq!(dasar("bulan", json!(0)), Err("Bulan harus 1–12.".into()));
        assert_eq!(dasar("peserta_rencana", json!(10_000)), Err("Jumlah peserta rencana harus bilangan bulat 0–9.999.".into()));
        assert_eq!(dasar("biaya_rencana", json!(-1)), Err("Estimasi biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar("biaya_rencana", json!(2.5)), Err("Estimasi biaya harus bilangan bulat 0–1.000.000.000.".into()));
        assert_eq!(dasar("keterangan", json!("a".repeat(2001))), Err("Keterangan maksimal 2000 karakter.".into()));

        assert_eq!(
            validasi_pagu(&json!({ "tahun": 2026, "nominal": 0, "catatan": " Belum dianggarkan " })),
            Ok(PaguSah { tahun: 2026, id_divisi: None, nominal: 0, catatan: Some("Belum dianggarkan".into()) })
        );
        assert_eq!(validasi_pagu(&json!({ "tahun": 2026, "id_divisi": "div-a", "nominal": MAKS_PAGU })).map(|p| p.nominal), Ok(MAKS_PAGU));
        let pesan_pagu: Result<PaguSah, String> = Err("Pagu harus bilangan bulat 0–100.000.000.000.".into());
        assert_eq!(validasi_pagu(&json!({ "tahun": 2026 })), pesan_pagu);
        assert_eq!(validasi_pagu(&json!({ "tahun": 2026, "nominal": MAKS_PAGU + 1 })), pesan_pagu);
        assert_eq!(validasi_pagu(&json!({ "tahun": 2026, "nominal": -5 })), pesan_pagu);
        assert_eq!(validasi_pagu(&json!({ "nominal": 5 })), Err("Tahun harus 2000–2100.".into()));
        assert_eq!(
            validasi_pagu(&json!({ "tahun": 2026, "nominal": 5, "catatan": "a".repeat(1001) })),
            Err("Catatan maksimal 1000 karakter.".into())
        );
        assert_eq!(id_anggaran(2026, Some("div-a")), "2026:div-a");
        assert_eq!(id_anggaran(2026, None), "2026:umum");
    }

    #[test]
    fn rencana_tautan_batal_dan_status() {
        assert_eq!(periksa_rencana_pelatihan("2026-03-02", 2026, false), Ok(()));
        assert_eq!(periksa_rencana_pelatihan("2027-01-05", 2026, false), Err(PESAN_RENCANA_TAHUN.into()));
        assert_eq!(periksa_rencana_pelatihan("2026-03-02", 2026, true), Err(PESAN_RENCANA_BATAL.into()));
        assert_eq!(periksa_ubah_rencana(2026, 2026, false, 3), Ok(()));
        assert_eq!(periksa_ubah_rencana(2026, 2027, false, 0), Ok(()));
        assert_eq!(periksa_ubah_rencana(2026, 2027, false, 1), Err(PESAN_RENCANA_TAHUN_TERKUNCI.into()));
        assert_eq!(periksa_ubah_rencana(2026, 2026, true, 0), Err(PESAN_RENCANA_BATAL.into()));
        assert_eq!(validasi_batal_rencana(&json!({ "alasan": " Ditunda " }), false, 0), Ok("Ditunda".into()));
        assert_eq!(validasi_batal_rencana(&json!({ "alasan": "x" }), false, 1), Err(PESAN_RENCANA_TERTAUT.into()));
        assert_eq!(validasi_batal_rencana(&json!({ "alasan": "x" }), true, 0), Err(PESAN_RENCANA_BATAL.into()));
        assert_eq!(validasi_batal_rencana(&json!({}), false, 0), Err("Alasan pembatalan wajib diisi.".into()));

        let s = |dibatalkan, tahun, bulan, tertaut: &[&str]| status_rencana(dibatalkan, tahun, bulan, tertaut, HARI);
        assert_eq!(s(true, 2026, None, &["Selesai"]), "Dibatalkan");
        assert_eq!(s(false, 2026, None, &["Dijadwalkan", "Selesai", "Berlangsung"]), "Terlaksana");
        assert_eq!(s(false, 2026, None, &["Dijadwalkan", "Berlangsung"]), "Berlangsung");
        assert_eq!(s(false, 2025, Some(1), &["Dijadwalkan"]), "Dijadwalkan");
        assert_eq!(s(false, 2026, Some(10), &["Dibatalkan"]), "Terlewat");
        assert_eq!(s(false, 2025, None, &[]), "Terlewat");
        assert_eq!(s(false, 2026, Some(11), &[]), "Belum dijadwalkan");
        assert_eq!(s(false, 2026, None, &[]), "Belum dijadwalkan");
        assert_eq!(s(false, 2027, Some(1), &[]), "Belum dijadwalkan");
    }

    /// Vektor bersama `validations/hr-pelatihan-anggaran.vektor.json`.
    #[test]
    fn ringkas_anggaran_vektor_bersama() {
        let vektor: Value =
            serde_json::from_str(include_str!("../../../src/lib/validations/hr-pelatihan-anggaran.vektor.json")).expect("vektor");
        let baris = |kunci: &str| -> Vec<Baris> { serde_json::from_value(vektor[kunci].clone()).expect("baris vektor") };
        let hasil = ringkas_anggaran(
            &baris("pagu"),
            &baris("rencana"),
            &baris("pelatihan"),
            vektor["tahun"].as_i64().unwrap(),
            vektor["hari_ini"].as_str().unwrap(),
        );
        let harapan = &vektor["harapan"];
        assert_eq!(hasil["kelompok"], harapan["kelompok"]);
        assert_eq!(hasil["total"], harapan["total"]);
        assert_eq!(hasil["di_luar_rencana"], harapan["di_luar_rencana"]);
        let rencana: Vec<Value> = hasil["rencana"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                json!({
                    "id_rencana": r["id_rencana"], "status": r["status"], "realisasi": r["realisasi"],
                    "jumlah_pelatihan": r["jumlah_pelatihan"], "peserta_aktual": r["peserta_aktual"], "tanda": r["tanda"],
                })
            })
            .collect();
        assert_eq!(json!(rencana), harapan["rencana"]);
        assert_eq!(hasil["rencana"][0]["pelatihan"], harapan["pelatihan_rcn_1"]);
        assert_eq!(hasil["rencana"][0]["nama_divisi"], "Gudang", "baris rencana dibawa utuh");

        // Tanpa data sama sekali: hanya Umum, tanpa pagu dan tanpa tanda.
        let kosong = ringkas_anggaran(&[], &[], &[], 2026, HARI);
        assert_eq!(kosong["kelompok"].as_array().map(Vec::len), Some(1));
        assert_eq!(kosong["total"], json!({ "pagu": null, "direncanakan": 0, "terikat": 0, "terpakai": 0, "sisa": null, "tanda": [] }));
    }

    /// Transaksi cloud pelatihan di `TursoClient::local_file` (§22.11 langkah
    /// 6): peserta ganda berhenti di PK, karyawan nonaktif ditolak, sertifikat
    /// tampil di `hris::dokumen`, berkas hanya terbaca bila tertaut peserta,
    /// lepas peserta bersertifikat ditolak, hapus dokumen mengosongkan
    /// `id_dokumen`, jenis Sertifikat nonaktif ditolak, dan pelatihan batal
    /// keluar dari riwayat serta mengunci pesertanya.
    #[test]
    fn pelatihan_cloud_peserta_dan_sertifikat() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let hub = dir.path().join("sppg-hub.db");
            let turso = TursoClient::local_file(
                url::Url::parse(super::super::turso::LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("provisioning lokal");
            let conn = rusqlite::Connection::open(&hub).expect("buka hub");
            conn.execute_batch(
                "INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
                   ('K1', 'E1', 'Ani', 'Gudang', 1, 'Aktif'), ('K2', 'E2', 'Budi', 'Gudang', 1, 'Nonaktif');
                 INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, dicatat_oleh) VALUES ('hd-ktp', 'K1', 'dok-ktp', 'hrd');
                 INSERT INTO hr_dokumen_berkas (id_berkas, id_dokumen, urutan, mime_type, data_base64) VALUES ('hb-ktp', 'hd-ktp', 1, 'application/pdf', 'JVBERi0=');",
            )
            .expect("data awal");
            let angka = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            let galat = |hasil: Result<Value, CommandError>| hasil.expect_err("harus ditolak").message;

            let id = simpan(
                &turso,
                "hrd",
                &json!({ "nama": "K3 Dasar", "tanggal_mulai": "2026-01-10", "tanggal_selesai": "2026-01-11", "biaya": 3_000_000 }),
            )
            .await
            .unwrap()["id_pelatihan"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_eq!(daftar(&turso, Some(2026)).await.unwrap()["pelatihan"][0]["status"], "Selesai");

            // Peserta: ganda berhenti di PK, nonaktif ditolak.
            let peserta = |aksi: &str, isi: Value| {
                let mut d = json!({ "id_pelatihan": id, "aksi": aksi });
                for (k, v) in isi.as_object().unwrap() {
                    d[k] = v.clone();
                }
                d
            };
            simpan_peserta(&turso, "hrd", &peserta("tambah", json!({ "id_karyawan": ["K1", "K1"] }))).await.unwrap();
            simpan_peserta(&turso, "hrd", &peserta("tambah", json!({ "id_karyawan": ["K1"] }))).await.unwrap();
            assert_eq!(angka("SELECT COUNT(*) FROM hr_pelatihan_peserta;"), 1);
            assert_eq!(
                galat(simpan_peserta(&turso, "hrd", &peserta("tambah", json!({ "id_karyawan": ["K2"] }))).await),
                "Budi tidak aktif dan tidak bisa menjadi peserta."
            );
            simpan_peserta(&turso, "hrd", &peserta("hasil", json!({ "id_karyawan": "K1", "hasil": "Lulus" }))).await.unwrap();

            // Sertifikat lewat inti dokumen, satu batch bersama tautannya.
            let pdf = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"%PDF-1.7 sertifikat");
            let sert = simpan_sertifikat(
                &turso,
                "hrd",
                &peserta(
                    "simpan",
                    json!({ "id_karyawan": "K1", "nomor": "K3/001", "tanggal_terbit": "2026-01-11", "tanggal_kedaluwarsa": "2029-01-11",
                            "berkas": [{ "nama_berkas": "sertifikat.pdf", "mime_type": "application/pdf", "data_base64": pdf }] }),
                ),
            )
            .await
            .unwrap();
            let id_dok = sert["id_dokumen"].as_str().unwrap().to_owned();
            let dokumen = hris::dokumen(&turso, "K1").await.unwrap();
            let tampil = dokumen["dokumen"].as_array().unwrap().iter().find(|d| d["id_dokumen"] == json!(id_dok)).cloned().expect("tampil di tab Dokumen");
            assert_eq!((tampil["id_jenis"].as_str(), tampil["catatan"].as_str()), (Some(JENIS_SERTIFIKAT), Some("K3 Dasar")));
            let id_berkas = tampil["berkas"][0]["id_berkas"].as_str().unwrap().to_owned();
            assert_eq!(berkas_sertifikat(&turso, &id_berkas).await.unwrap()["data_base64"], json!(pdf));
            assert_eq!(galat(berkas_sertifikat(&turso, "hb-ktp").await), "Berkas tidak ditemukan.", "dokumen lain tidak terbuka");
            let rinci = rincian(&turso, &id).await.unwrap();
            assert_eq!(rinci["peserta"][0]["berkas"].as_array().map(Vec::len), Some(1));
            assert_eq!(rinci["peserta"][0]["tanggal_kedaluwarsa"], "2029-01-11");

            // Lepas peserta bersertifikat ditolak; hapus dokumen melepas tautan.
            let lepas = peserta("lepas", json!({ "id_karyawan": "K1" }));
            assert_eq!(galat(simpan_peserta(&turso, "hrd", &lepas).await), PESAN_PESERTA_BERSERTIFIKAT);
            hris::hapus_dokumen(&turso, &id_dok).await.unwrap();
            assert_eq!(angka("SELECT COUNT(*) FROM hr_pelatihan_peserta WHERE id_dokumen IS NOT NULL;"), 0);
            assert_eq!(angka("SELECT COUNT(*) FROM hr_dokumen_berkas WHERE id_dokumen <> 'hd-ktp';"), 0);

            // Jenis Sertifikat nonaktif: sertifikat baru ditolak.
            conn.execute("UPDATE hr_dokumen_jenis SET is_aktif = 0 WHERE id_jenis = 'dok-sertifikat';", []).unwrap();
            assert_eq!(
                galat(simpan_sertifikat(&turso, "hrd", &peserta("simpan", json!({ "id_karyawan": "K1" }))).await),
                PESAN_SERTIFIKAT_NONAKTIF
            );
            assert_eq!(riwayat(&turso, "K1").await.unwrap()["riwayat"].as_array().map(Vec::len), Some(1));
            simpan_peserta(&turso, "hrd", &lepas).await.unwrap();
            simpan_peserta(&turso, "hrd", &peserta("tambah", json!({ "id_karyawan": ["K1"] }))).await.unwrap();

            // Batal: keluar dari riwayat, peserta terkunci, sekali saja.
            simpan(&turso, "hrd", &json!({ "id_pelatihan": id, "aksi": "batal", "alasan": "Ditunda" })).await.unwrap();
            assert_eq!(riwayat(&turso, "K1").await.unwrap()["riwayat"].as_array().map(Vec::len), Some(0));
            assert_eq!(galat(simpan_peserta(&turso, "hrd", &lepas).await), PESAN_PELATIHAN_BATAL);
            assert_eq!(
                galat(simpan(&turso, "hrd", &json!({ "id_pelatihan": id, "aksi": "batal", "alasan": "x" })).await),
                PESAN_PELATIHAN_BATAL
            );
            assert_eq!(daftar(&turso, Some(2026)).await.unwrap()["pelatihan"][0]["status"], "Dibatalkan");
        });
    }

    /// Transaksi cloud rencana dan pagu (§26.9 langkah 4) di
    /// `TursoClient::local_file`. Tahun 2099 = semua pelatihan Dijadwalkan
    /// (Terikat); pelatihan sepanjang tahun berjalan = Berlangsung (Terpakai),
    /// jadi tes tidak bergantung pada tanggal hari ini.
    #[test]
    fn rencana_cloud_pagu_dan_realisasi() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let hub = dir.path().join("sppg-hub.db");
            let turso = TursoClient::local_file(
                url::Url::parse(super::super::turso::LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("provisioning lokal");
            let conn = rusqlite::Connection::open(&hub).expect("buka hub");
            conn.execute_batch(
                "INSERT INTO hr_divisi (id_divisi, nama, is_aktif) VALUES ('div-1', 'Gudang', 1), ('div-2', 'Lama', 0);",
            )
            .expect("data awal");
            let angka = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            let galat = |hasil: Result<Value, CommandError>| hasil.expect_err("harus ditolak").message;
            let id_dari = |v: Value, kunci: &str| v[kunci].as_str().unwrap().to_owned();

            // Pagu: upsert berid sama menimpa; divisi nonaktif hanya untuk pagu lama.
            let pagu = |nominal: i64, divisi: Value| json!({ "aksi": "pagu", "tahun": 2099, "id_divisi": divisi, "nominal": nominal });
            simpan_rencana(&turso, "hrd", &pagu(1_000_000, json!("div-1"))).await.unwrap();
            simpan_rencana(&turso, "admin", &pagu(2_000_000, json!("div-1"))).await.unwrap();
            assert_eq!(angka("SELECT COUNT(*) FROM hr_pelatihan_anggaran;"), 1);
            let (nominal, pengubah): (i64, String) = conn
                .query_row("SELECT nominal, diubah_oleh FROM hr_pelatihan_anggaran WHERE id_anggaran = '2099:div-1';", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!((nominal, pengubah.as_str()), (2_000_000, "admin"));
            assert_eq!(galat(simpan_rencana(&turso, "hrd", &pagu(5, json!("div-2"))).await), "Divisi sudah nonaktif.");
            assert_eq!(galat(simpan_rencana(&turso, "hrd", &pagu(5, json!("div-x"))).await), "Divisi tidak ditemukan.");
            conn.execute(
                "INSERT INTO hr_pelatihan_anggaran (id_anggaran, tahun, id_divisi, nominal, dicatat_oleh) VALUES ('2099:div-2', 2099, 'div-2', 1, 'hrd');",
                [],
            )
            .unwrap();
            simpan_rencana(&turso, "hrd", &pagu(7, json!("div-2"))).await.expect("pagu lama divisi nonaktif boleh diubah");
            simpan_rencana(&turso, "hrd", &json!({ "aksi": "hapus_pagu", "tahun": 2099, "id_divisi": "div-2" })).await.unwrap();
            assert_eq!(
                galat(simpan_rencana(&turso, "hrd", &json!({ "aksi": "hapus_pagu", "tahun": 2099, "id_divisi": "div-2" })).await),
                "Pagu tidak ditemukan."
            );
            simpan_rencana(&turso, "hrd", &pagu(300_000, Value::Null)).await.unwrap();

            // Rencana dan tautan: beda tahun ditolak, pindah tahun ditolak.
            let rcn = id_dari(
                simpan_rencana(
                    &turso,
                    "hrd",
                    &json!({ "tahun": 2099, "nama": "K3 Gudang", "id_divisi": "div-1", "bulan": 3, "peserta_rencana": 5, "biaya_rencana": 1_500_000 }),
                )
                .await
                .unwrap(),
                "id_rencana",
            );
            let pelatihan = |isi: Value| {
                let mut d = json!({ "nama": "K3", "tanggal_mulai": "2099-03-01", "tanggal_selesai": "2099-03-02", "biaya": 1_800_000 });
                for (k, v) in isi.as_object().unwrap() {
                    d[k] = v.clone();
                }
                d
            };
            assert_eq!(
                galat(simpan(&turso, "hrd", &pelatihan(json!({ "id_rencana": rcn, "tanggal_mulai": "2098-12-30" }))).await),
                PESAN_RENCANA_TAHUN
            );
            assert_eq!(galat(simpan(&turso, "hrd", &pelatihan(json!({ "id_rencana": "rcn-x" }))).await), "Rencana tidak ditemukan.");
            let plt_a = id_dari(simpan(&turso, "hrd", &pelatihan(json!({ "id_rencana": rcn }))).await.unwrap(), "id_pelatihan");
            assert_eq!(
                galat(
                    simpan(
                        &turso,
                        "hrd",
                        &pelatihan(json!({ "id_pelatihan": plt_a, "id_rencana": rcn, "tanggal_mulai": "2100-01-02", "tanggal_selesai": "2100-01-02" }))
                    )
                    .await
                ),
                PESAN_RENCANA_TAHUN
            );
            assert_eq!(
                galat(simpan_rencana(&turso, "hrd", &json!({ "id_rencana": rcn, "tahun": 2100, "nama": "K3 Gudang" })).await),
                PESAN_RENCANA_TAHUN_TERKUNCI
            );
            let plt_b = id_dari(
                simpan(&turso, "hrd", &pelatihan(json!({ "nama": "Di luar rencana", "biaya": 400_000 }))).await.unwrap(),
                "id_pelatihan",
            );
            let rinci = rincian(&turso, &plt_a).await.unwrap();
            assert_eq!((rinci["rencana"]["nama"].as_str(), rinci["rencana"]["status"].as_str()), (Some("K3 Gudang"), Some("Dijadwalkan")));
            assert_eq!(rincian(&turso, &plt_b).await.unwrap()["rencana"], Value::Null);

            // Ringkasan 2099: semua Terikat, Sisa = Pagu − Terikat − Terpakai.
            let ringkas = rencana_tahun(&turso, Some(2099)).await.unwrap();
            let kelompok = |r: &Value, kunci: &str| r["kelompok"].as_array().unwrap().iter().find(|k| k["kunci"] == kunci).cloned().unwrap();
            let gudang = kelompok(&ringkas, "div-1");
            assert_eq!(
                (&gudang["pagu"], &gudang["direncanakan"], &gudang["terikat"], &gudang["terpakai"], &gudang["sisa"]),
                (&json!(2_000_000), &json!(1_500_000), &json!(1_800_000), &json!(0), &json!(200_000))
            );
            assert_eq!(gudang["tanda"], json!([]));
            let umum = kelompok(&ringkas, "umum");
            assert_eq!((&umum["pagu"], &umum["terikat"], &umum["sisa"]), (&json!(300_000), &json!(400_000), &json!(-100_000)));
            assert_eq!(umum["tanda"], json!(["lewat_pagu"]));
            assert_eq!(ringkas["di_luar_rencana"]["realisasi"], json!(400_000));
            assert_eq!(ringkas["rencana"][0]["tanda"], json!(["lewat_estimasi"]));
            assert_eq!(ringkas["total"]["sisa"], json!(100_000));

            // Pelatihan batal keluar dari realisasi.
            simpan(&turso, "hrd", &json!({ "id_pelatihan": plt_b, "aksi": "batal", "alasan": "Ditunda" })).await.unwrap();
            let ringkas = rencana_tahun(&turso, Some(2099)).await.unwrap();
            assert_eq!((&kelompok(&ringkas, "umum")["terikat"], &kelompok(&ringkas, "umum")["tanda"]), (&json!(0), &json!([])));

            // Tahun berjalan: pelatihan sepanjang tahun = Berlangsung (Terpakai), tanpa pagu.
            let tahun_ini = tahun_dari(&hari_ini_cloud(&turso).await.unwrap());
            simpan(
                &turso,
                "hrd",
                &json!({ "nama": "Sepanjang tahun", "tanggal_mulai": format!("{tahun_ini}-01-01"), "tanggal_selesai": format!("{tahun_ini}-12-31"), "biaya": 250_000 }),
            )
            .await
            .unwrap();
            let berjalan = rencana_tahun(&turso, None).await.unwrap();
            assert_eq!(berjalan["tahun"], json!(tahun_ini));
            let umum = kelompok(&berjalan, "umum");
            assert_eq!((&umum["terpakai"], &umum["terikat"], &umum["sisa"]), (&json!(250_000), &json!(0), &Value::Null));
            assert_eq!(umum["tanda"], json!(["tanpa_pagu"]));

            // UBAH_PELATIHAN_SQL v42 (teks lama, tanpa kolom) mempertahankan tautan.
            const UBAH_V42: &str = "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now') WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";
            turso
                .query_one(
                    UBAH_V42,
                    vec![
                        json!(plt_a), json!("K3 (v42)"), Value::Null, json!("2099-03-01"), json!("2099-03-02"),
                        Value::Null, json!(1_800_000), Value::Null, json!("hrd-lama"),
                    ],
                )
                .await
                .unwrap();
            let tautan: Option<String> = conn
                .query_row("SELECT id_rencana FROM hr_pelatihan WHERE id_pelatihan = ?1;", [&plt_a], |r| r.get(0))
                .unwrap();
            assert_eq!(tautan.as_deref(), Some(rcn.as_str()));

            // Batal rencana bertaut ditolak; sesudah pelatihannya batal, boleh, sekali.
            let batal = json!({ "aksi": "batal", "id_rencana": rcn, "alasan": "Diganti" });
            assert_eq!(galat(simpan_rencana(&turso, "hrd", &batal).await), PESAN_RENCANA_TERTAUT);
            simpan(&turso, "hrd", &json!({ "id_pelatihan": plt_a, "aksi": "batal", "alasan": "Ditunda" })).await.unwrap();
            simpan_rencana(&turso, "hrd", &batal).await.unwrap();
            assert_eq!(galat(simpan_rencana(&turso, "hrd", &batal).await), PESAN_RENCANA_BATAL);
            assert_eq!(galat(simpan(&turso, "hrd", &pelatihan(json!({ "id_rencana": rcn }))).await), PESAN_RENCANA_BATAL);
            let ringkas = rencana_tahun(&turso, Some(2099)).await.unwrap();
            assert_eq!(ringkas["rencana"][0]["status"], "Dibatalkan");
            assert_eq!((&kelompok(&ringkas, "div-1")["direncanakan"], &kelompok(&ringkas, "div-1")["terikat"]), (&json!(0), &json!(0)));
        });
    }
}
