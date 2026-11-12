//! HRIS fase 7 (skema v42): pelatihan, peserta, dan sertifikat.
//!
//! `hr_pelatihan` dan `hr_pelatihan_peserta` KHUSUS CLOUD (Q-87): sertifikat
//! peserta adalah `hr_dokumen` berjenis `dok-sertifikat` (Q-97), yang sudah
//! khusus cloud, jadi layar ini tetap butuh koneksi. Status pelatihan tidak
//! disimpan; pembatalan adalah kolom yang diisi sekali. Biaya satu angka total
//! per pelatihan (Q-98), tanpa jurnal.
//!
//! Aturan murni dan pesan galat cermin `validations/hr-pelatihan.ts`, diuji
//! dengan vektor yang sama (`prd-hris.md` §22.7).

use std::collections::HashSet;

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

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

fn teks_opsional(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<Option<String>, String> {
    match payload_text(draft, kunci) {
        Some(t) if panjang(&t) > maks => Err(format!("{label} maksimal {maks} karakter.")),
        lain => Ok(lain),
    }
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
}

/// Cermin `validasiPelatihan`. Tanggal boleh di masa depan (terjadwal).
pub fn validasi_pelatihan(draft: &Value) -> Result<PelatihanSah, String> {
    let nama = payload_text(draft, "nama")
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .ok_or("Nama pelatihan wajib diisi.")?;
    if panjang(&nama) > MAKS_NAMA_PELATIHAN {
        return Err(format!("Nama pelatihan maksimal {MAKS_NAMA_PELATIHAN} karakter."));
    }
    let tanggal_mulai = payload_text(draft, "tanggal_mulai")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal mulai tidak valid.")?;
    let tanggal_selesai = payload_text(draft, "tanggal_selesai")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal selesai tidak valid.")?;
    if tanggal_selesai < tanggal_mulai {
        return Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into());
    }
    let biaya = match draft.get("biaya") {
        None | Some(Value::Null) => 0,
        Some(v) => v
            .as_i64()
            .filter(|n| (0..=MAKS_BIAYA).contains(n))
            .ok_or("Biaya harus bilangan bulat 0–1.000.000.000.")?,
    };
    Ok(PelatihanSah {
        id_pelatihan: payload_text(draft, "id_pelatihan"),
        nama,
        penyelenggara: teks_opsional(draft, "penyelenggara", "Penyelenggara", MAKS_PENYELENGGARA)?,
        tanggal_mulai,
        tanggal_selesai,
        lokasi: teks_opsional(draft, "lokasi", "Lokasi", MAKS_LOKASI)?,
        biaya,
        keterangan: teks_opsional(draft, "keterangan", "Keterangan", MAKS_KETERANGAN)?,
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

// ── Khusus cloud (Q-87) ────────────────────────────────────────────────────

pub const DAFTAR_PELATIHAN_SQL: &str = "SELECT l.*, (SELECT COUNT(*) FROM hr_pelatihan_peserta p WHERE p.id_pelatihan = l.id_pelatihan) AS jumlah_peserta FROM hr_pelatihan l WHERE strftime('%Y', l.tanggal_mulai) = ?1 ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";
pub const PESERTA_SQL: &str = "SELECT p.*, m.nama, m.divisi, m.jabatan_status, m.status_aktif, d.nomor, d.tanggal_terbit, d.tanggal_kedaluwarsa, d.catatan AS catatan_sertifikat FROM hr_pelatihan_peserta p LEFT JOIN master_data m ON m.id_unik = p.id_karyawan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY m.nama, p.id_karyawan;";
pub const BERKAS_PESERTA_SQL: &str = "SELECT b.id_berkas, b.id_dokumen, b.urutan, b.nama_berkas, b.mime_type, length(b.data_base64) AS panjang FROM hr_dokumen_berkas b JOIN hr_pelatihan_peserta p ON p.id_dokumen = b.id_dokumen WHERE p.id_pelatihan = ?1 ORDER BY b.id_dokumen, b.urutan;";
/// Riwayat satu karyawan: pelatihan yang tidak dibatalkan (§22.7).
pub const RIWAYAT_SQL: &str = "SELECT l.id_pelatihan, l.nama, l.penyelenggara, l.tanggal_mulai, l.tanggal_selesai, l.lokasi, p.hasil, p.catatan, p.id_dokumen, d.nomor, d.tanggal_kedaluwarsa FROM hr_pelatihan_peserta p JOIN hr_pelatihan l ON l.id_pelatihan = p.id_pelatihan LEFT JOIN hr_dokumen d ON d.id_dokumen = p.id_dokumen WHERE p.id_karyawan = ?1 AND l.dibatalkan_pada IS NULL ORDER BY l.tanggal_mulai DESC, l.id_pelatihan DESC;";
pub const INSERT_PELATIHAN_SQL: &str = "INSERT INTO hr_pelatihan (id_pelatihan, nama, penyelenggara, tanggal_mulai, tanggal_selesai, lokasi, biaya, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);";
pub const UBAH_PELATIHAN_SQL: &str = "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now') WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;";
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
    Ok(json!({
        "pelatihan": data,
        "peserta": peserta,
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
        assert_eq!((sah.nama.as_str(), sah.biaya, sah.lokasi), ("K3 Dasar", 3_000_000, None));
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
}
