//! HRIS fase 1 (v36): organisasi, kontrak, profil, dan dokumen karyawan.
//!
//! - Organisasi (`hr_cabang`, `hr_divisi`, `hr_divisi_nama`, `hr_jabatan`) dan
//!   kontrak (`hr_kontrak`) tersinkron. Tidak ada baris yang dihapus:
//!   nonaktif = hapus, kontrak dibatalkan lewat baris `batal-<id>`.
//! - `master_data.divisi`/`jabatan_status` tetap teks nama SEKARANG supaya
//!   scanner, kartu ID, dan kueri lama tetap jalan. Riwayat tidak ditulis
//!   ulang; laporan memetakan teks lama lewat `DIVISI_KINI_SQL`.
//! - Profil (`hr_profil`) dan dokumen (`hr_dokumen*`) KHUSUS CLOUD (Q-30,
//!   Q-45): tidak pernah ada di SQLite perangkat, tidak lewat outbox.
//!
//! Aturan murni dan SQL dieja kembar dengan `validations/hris.ts` dan diuji
//! dengan vektor yang sama (`hris.test.ts` ↔ `mod tests`). Pesan galat pun
//! wajib identik.

use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

use super::inventory::{invalid, is_valid_date, new_hex_id, payload_text};
use super::inventory_pengajuan::base64_sah;
use super::turso::{is_valid_operator_phone, normalize_operator_phone, Statement, TursoClient};
use super::{config::DesktopState, models::CommandError, storage, sync};

// ── Konstanta ──────────────────────────────────────────────────────────────

pub const MAKS_NAMA: usize = 100;
pub const MAKS_TEKS: usize = 255;
pub const MAKS_CATATAN: usize = 1000;
pub const MAKS_BERKAS_PER_DOKUMEN: i64 = 5;
/// 1 MB setelah didekode (⌈1.048.576 / 3⌉ × 4).
pub const MAKS_BERKAS_BASE64: usize = 1_398_104;
/// WAJIB sama dengan CHECK `hr_dokumen_berkas.mime_type`.
pub const MIME_BERKAS: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
/// WAJIB sama dengan CHECK `hr_profil`.
pub const AGAMA: [&str; 7] = ["Islam", "Kristen", "Katolik", "Hindu", "Buddha", "Konghucu", "Lainnya"];
pub const STATUS_NIKAH: [&str; 4] = ["Belum Kawin", "Kawin", "Cerai Hidup", "Cerai Mati"];
pub const PENDIDIKAN: [&str; 11] = [
    "SD", "SMP", "SMA/SMK", "D1", "D2", "D3", "D4", "S1", "S2", "S3", "Lainnya",
];
/// WAJIB sama dengan CHECK `hr_kontrak.jenis` (tanpa `Pembatalan`).
pub const JENIS_KONTRAK: [&str; 4] = ["PKWTT", "PKWT", "Harian Lepas", "Magang"];

pub const KUNCI_PERCOBAAN_MAKS_BULAN: &str = "hr_percobaan_maks_bulan";
pub const KUNCI_PKWT_MAKS_BULAN: &str = "hr_pkwt_maks_bulan";
pub const KUNCI_HARIAN_BATAS_HARI: &str = "hr_harian_batas_hari";
pub const KUNCI_HARIAN_BATAS_BULAN: &str = "hr_harian_batas_bulan";
/// Masa berlaku SP dalam bulan (fase 5); dibekukan per SP saat dibuat.
pub const KUNCI_SP_MASA_BULAN: &str = "hr_sp_masa_bulan";
/// Masa simpan data pelamar yang tidak menjadi karyawan, dihitung dari tutup
/// efektif lowongannya (fase 7, Q-33). Berlaku surut saat diubah.
pub const KUNCI_PELAMAR_RETENSI_BULAN: &str = "hr_pelamar_retensi_bulan";
/// Angka pengingat HR (fase 9, §24.3, Q-114): dibaca SQL pengingat Telegram
/// dan kartu "Perlu perhatian" lewat fragmen `ingat_*_sql!`.
pub const KUNCI_INGAT_KONTRAK_JAUH: &str = "hr_ingat_kontrak_jauh";
pub const KUNCI_INGAT_KONTRAK_DEKAT: &str = "hr_ingat_kontrak_dekat";
pub const KUNCI_INGAT_PERCOBAAN: &str = "hr_ingat_percobaan";
pub const KUNCI_INGAT_DOKUMEN: &str = "hr_ingat_dokumen";
pub const KUNCI_INGAT_MENUNGGU: &str = "hr_ingat_menunggu";
pub const KUNCI_INGAT_JAM: &str = "hr_ingat_jam";

/// Kolom kelompok pribadi `hr_profil`, urutan tetap.
pub const KOLOM_PRIBADI: [&str; 12] = [
    "nik",
    "no_kk",
    "tempat_lahir",
    "tanggal_lahir",
    "agama",
    "status_nikah",
    "alamat_ktp",
    "alamat_domisili",
    "pendidikan",
    "darurat_nama",
    "darurat_hubungan",
    "darurat_hp",
];
/// Kolom kelompok keuangan `hr_profil`, urutan tetap.
pub const KOLOM_KEUANGAN: [&str; 6] = [
    "bank",
    "no_rekening",
    "nama_rekening",
    "npwp",
    "bpjs_kesehatan",
    "bpjs_ketenagakerjaan",
];

// ── SQL kembar (diperiksa harfiah oleh `hris.test.ts`) ─────────────────────

/// Jenis dokumen bawaan (khusus cloud).
pub const SEED_JENIS_DOKUMEN_SQL: &str = "INSERT OR IGNORE INTO hr_dokumen_jenis (id_jenis, nama) VALUES
    ('dok-ktp', 'KTP'),
    ('dok-kk', 'KK'),
    ('dok-npwp', 'NPWP'),
    ('dok-ijazah', 'Ijazah'),
    ('dok-kontrak', 'Kontrak Kerja'),
    ('dok-sertifikat', 'Sertifikat'),
    ('dok-sim', 'SIM'),
    ('dok-surat-dokter', 'Surat Dokter'),
    ('dok-lainnya', 'Lainnya');";

/// Migrasi teks divisi/jabatan → master (v36), hanya di cloud. Id
/// deterministik dari nama, jadi Rust dan Web menghasilkan id yang sama.
pub const MIGRASI_ORGANISASI_SQL: &[&str] = &[
    "INSERT OR IGNORE INTO hr_cabang (id_cabang, nama) SELECT 'cab-pusat', 'Pusat' WHERE EXISTS (SELECT 1 FROM master_data);",
    "INSERT OR IGNORE INTO hr_divisi (id_divisi, nama) SELECT 'div-' || lower(hex(lower(trim(divisi)))), MIN(TRIM(divisi)) FROM master_data WHERE TRIM(COALESCE(divisi, '')) <> '' GROUP BY lower(trim(divisi));",
    "INSERT OR IGNORE INTO hr_divisi_nama (id_nama, id_divisi, nama) SELECT d.id_divisi || ':awal', d.id_divisi, d.nama FROM hr_divisi d WHERE NOT EXISTS (SELECT 1 FROM hr_divisi_nama n WHERE n.id_divisi = d.id_divisi);",
    "INSERT OR IGNORE INTO hr_jabatan (id_jabatan, nama) SELECT 'jab-' || lower(hex(lower(trim(jabatan_status)))), MIN(TRIM(jabatan_status)) FROM master_data WHERE TRIM(COALESCE(jabatan_status, '')) NOT IN ('', '-') GROUP BY lower(trim(jabatan_status));",
    "UPDATE master_data SET id_cabang = 'cab-pusat' WHERE COALESCE(id_cabang, '') = '' AND EXISTS (SELECT 1 FROM hr_cabang WHERE id_cabang = 'cab-pusat');",
    "UPDATE master_data SET id_divisi = 'div-' || lower(hex(lower(trim(divisi)))) WHERE COALESCE(id_divisi, '') = '' AND EXISTS (SELECT 1 FROM hr_divisi d WHERE d.id_divisi = 'div-' || lower(hex(lower(trim(master_data.divisi)))));",
    "UPDATE master_data SET id_jabatan = 'jab-' || lower(hex(lower(trim(jabatan_status)))) WHERE COALESCE(id_jabatan, '') = '' AND EXISTS (SELECT 1 FROM hr_jabatan j WHERE j.id_jabatan = 'jab-' || lower(hex(lower(trim(master_data.jabatan_status)))));",
];

/// Nama divisi SEKARANG untuk teks divisi riwayat. `{kolom}` diganti nama
/// kolom; teks yang tidak terpetakan tampil apa adanya.
pub const DIVISI_KINI_SQL: &str = "COALESCE((SELECT d.nama FROM hr_divisi_nama n JOIN hr_divisi d ON d.id_divisi = n.id_divisi WHERE LOWER(TRIM(n.nama)) = LOWER(TRIM({kolom})) ORDER BY n.created_at, n.id_nama LIMIT 1), {kolom})";

pub fn divisi_kini(kolom: &str) -> String {
    DIVISI_KINI_SQL.replace("{kolom}", kolom)
}

pub const UPSERT_CABANG_SQL: &str = "INSERT INTO hr_cabang (id_cabang, nama, alamat, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), datetime('now'))
    ON CONFLICT(id_cabang) DO UPDATE SET nama = excluded.nama, alamat = excluded.alamat, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;";

pub const UPSERT_DIVISI_SQL: &str = "INSERT INTO hr_divisi (id_divisi, nama, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')), datetime('now'))
    ON CONFLICT(id_divisi) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;";

pub const INSERT_NAMA_DIVISI_SQL: &str = "INSERT INTO hr_divisi_nama (id_nama, id_divisi, nama, created_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')))
    ON CONFLICT(id_nama) DO NOTHING;";

pub const UPSERT_JABATAN_SQL: &str = "INSERT INTO hr_jabatan (id_jabatan, nama, is_aktif, created_at, updated_at)
    VALUES (?1, ?2, ?3, COALESCE(?4, datetime('now')), datetime('now'))
    ON CONFLICT(id_jabatan) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = excluded.updated_at;";

/// Sesudah divisi `?1` disimpan: tautkan karyawan bertekas nama divisi itu
/// yang belum punya master, lalu samakan teks data kini dengan nama sekarang.
/// Riwayat (absensi, log scan, koreksi, backup) TIDAK disentuh.
pub const SELARASKAN_DIVISI_SQL: [&str; 3] = [
    "UPDATE master_data SET id_divisi = ?1 WHERE COALESCE(id_divisi, '') = '' AND LOWER(TRIM(divisi)) IN (SELECT LOWER(TRIM(nama)) FROM hr_divisi_nama WHERE id_divisi = ?1);",
    "UPDATE master_data SET divisi = (SELECT nama FROM hr_divisi WHERE id_divisi = ?1) WHERE id_divisi = ?1;",
    "UPDATE id_card SET divisi = (SELECT nama FROM hr_divisi WHERE id_divisi = ?1) WHERE id_unik IN (SELECT id_unik FROM master_data WHERE id_divisi = ?1);",
];

/// Sesudah jabatan `?1` disimpan (tanpa riwayat nama, Q-39).
pub const SELARASKAN_JABATAN_SQL: [&str; 2] = [
    "UPDATE master_data SET id_jabatan = ?1 WHERE COALESCE(id_jabatan, '') = '' AND LOWER(TRIM(jabatan_status)) = (SELECT LOWER(TRIM(nama)) FROM hr_jabatan WHERE id_jabatan = ?1);",
    "UPDATE master_data SET jabatan_status = (SELECT nama FROM hr_jabatan WHERE id_jabatan = ?1) WHERE id_jabatan = ?1;",
];

/// Handler cloud `employee/*`: `?1` = `id_divisi` payload (kosong = tidak
/// dibawa), `?2` = `id_jabatan` payload, `?3` = `id_unik`. Id yang tidak
/// dikenal cloud jatuh ke pemetaan teks; teks lalu dinormalkan ke nama
/// sekarang, jadi event lama yang telat tidak mengembalikan nama lama.
pub const CLOUD_ORG_KARYAWAN_SQL: [&str; 1] = [
    "UPDATE master_data SET
        id_divisi = COALESCE((SELECT d.id_divisi FROM hr_divisi d WHERE d.id_divisi = NULLIF(?1, '')), (SELECT n.id_divisi FROM hr_divisi_nama n WHERE LOWER(TRIM(n.nama)) = LOWER(TRIM(master_data.divisi)) ORDER BY n.created_at, n.id_nama LIMIT 1)),
        id_jabatan = COALESCE((SELECT j.id_jabatan FROM hr_jabatan j WHERE j.id_jabatan = NULLIF(?2, '')), (SELECT j.id_jabatan FROM hr_jabatan j WHERE LOWER(TRIM(j.nama)) = LOWER(TRIM(master_data.jabatan_status)) ORDER BY j.created_at, j.id_jabatan LIMIT 1))
     WHERE id_unik = ?3;",
];

/// Sesudah `CLOUD_ORG_KARYAWAN_SQL`: teks data kini mengikuti master. `?1` = id_unik.
pub const CLOUD_TEKS_KARYAWAN_SQL: [&str; 2] = [
    "UPDATE master_data SET divisi = (SELECT d.nama FROM hr_divisi d WHERE d.id_divisi = master_data.id_divisi) WHERE id_unik = ?1 AND EXISTS (SELECT 1 FROM hr_divisi d WHERE d.id_divisi = master_data.id_divisi);",
    "UPDATE master_data SET jabatan_status = (SELECT j.nama FROM hr_jabatan j WHERE j.id_jabatan = master_data.id_jabatan) WHERE id_unik = ?1 AND EXISTS (SELECT 1 FROM hr_jabatan j WHERE j.id_jabatan = master_data.id_jabatan);",
];

/// `jenis_personil` mengikuti kontrak tidak dibatalkan dengan tanggal mulai
/// terakhir (Q-40). Tanpa kontrak, nilai lama dipertahankan. `?1` = id_unik.
pub const JENIS_DARI_KONTRAK_SQL: &str = "UPDATE master_data SET jenis_personil = COALESCE((SELECT CASE k.jenis WHEN 'PKWTT' THEN 'Pegawai' WHEN 'PKWT' THEN 'Kontrak' WHEN 'Harian Lepas' THEN 'Harian' ELSE 'Magang' END FROM hr_kontrak k WHERE k.id_karyawan = master_data.id_unik AND k.jenis <> 'Pembatalan' AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak) ORDER BY k.tanggal_mulai DESC, k.id_kontrak DESC LIMIT 1), jenis_personil) WHERE id_unik = ?1;";

/// Simpan data dokumen (baru atau ubah). Dipakai `simpan_dokumen` dan
/// sertifikat pelatihan (fase 7), yang menuliskannya satu batch bersama
/// tautan pesertanya.
pub const SIMPAN_DOKUMEN_SQL: &str = "INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, nomor, tanggal_terbit, tanggal_kedaluwarsa, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id_dokumen) DO UPDATE SET id_jenis = excluded.id_jenis, nomor = excluded.nomor, tanggal_terbit = excluded.tanggal_terbit, tanggal_kedaluwarsa = excluded.tanggal_kedaluwarsa, catatan = excluded.catatan, updated_at = datetime('now');";

pub const INSERT_BERKAS_DOKUMEN_SQL: &str = "INSERT INTO hr_dokumen_berkas (id_berkas, id_dokumen, urutan, nama_berkas, mime_type, data_base64) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";

/// Menghapus dokumen juga melepas tautan sertifikat peserta pelatihan (fase
/// 7), supaya tab Dokumen tidak meninggalkan tautan mati.
pub const HAPUS_DOKUMEN_SQL: [&str; 3] = [
    "DELETE FROM hr_dokumen_berkas WHERE id_dokumen = ?1;",
    "UPDATE hr_pelatihan_peserta SET id_dokumen = NULL WHERE id_dokumen = ?1;",
    "DELETE FROM hr_dokumen WHERE id_dokumen = ?1;",
];

pub const INSERT_KONTRAK_SQL: &str = "INSERT INTO hr_kontrak (
        id_kontrak, id_karyawan, jenis, id_ref, nomor, tanggal_mulai, tanggal_selesai,
        percobaan_selesai, catatan, dicatat_oleh, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, datetime('now')))
    ON CONFLICT(id_kontrak) DO NOTHING;";

// ── Aturan murni ───────────────────────────────────────────────────────────

/// Nama master: spasi dirapikan, wajib, maks `MAKS_NAMA`.
pub fn nama_master(masukan: &str) -> Result<String, String> {
    let nama = masukan.split_whitespace().collect::<Vec<_>>().join(" ");
    if nama.is_empty() {
        return Err("Nama wajib diisi.".into());
    }
    if nama.chars().count() > MAKS_NAMA {
        return Err(format!("Nama maksimal {MAKS_NAMA} karakter."));
    }
    Ok(nama)
}

/// Kunci pembanding nama tanpa beda huruf besar/kecil dan spasi.
pub fn kunci_nama(nama: &str) -> String {
    nama.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Nomor identitas: tanda baca (spasi . - /) dibuang, sisanya wajib angka
/// dengan panjang yang diizinkan. Kosong = `None`.
pub fn nomor_identitas(
    masukan: Option<&str>,
    label: &str,
    panjang: &[usize],
) -> Result<Option<String>, String> {
    let Some(teks) = masukan.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let digit: String = teks
        .chars()
        .filter(|c| !matches!(c, ' ' | '.' | '-' | '/'))
        .collect();
    if !digit.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{label} hanya boleh berisi angka."));
    }
    if !panjang.contains(&digit.len()) {
        return Err(match panjang {
            [n] => format!("{label} harus {n} digit."),
            [a, b] => format!("{label} harus {a} atau {b} digit."),
            _ => format!(
                "{label} harus {}–{} digit.",
                panjang.first().unwrap_or(&0),
                panjang.last().unwrap_or(&0)
            ),
        });
    }
    Ok(Some(digit))
}

const PANJANG_REKENING: [usize; 16] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

fn label_kolom(kolom: &str) -> &'static str {
    match kolom {
        "nik" => "NIK",
        "no_kk" => "Nomor KK",
        "tempat_lahir" => "Tempat lahir",
        "tanggal_lahir" => "Tanggal lahir",
        "agama" => "Agama",
        "status_nikah" => "Status nikah",
        "alamat_ktp" => "Alamat KTP",
        "alamat_domisili" => "Alamat domisili",
        "pendidikan" => "Pendidikan",
        "darurat_nama" => "Nama kontak darurat",
        "darurat_hubungan" => "Hubungan kontak darurat",
        "darurat_hp" => "Nomor HP kontak darurat",
        "bank" => "Bank",
        "no_rekening" => "Nomor rekening",
        "nama_rekening" => "Nama pemilik rekening",
        "npwp" => "NPWP",
        "bpjs_kesehatan" => "Nomor BPJS Kesehatan",
        "bpjs_ketenagakerjaan" => "Nomor BPJS Ketenagakerjaan",
        _ => "Isian",
    }
}

/// Isian objek berkunci tetap: kunci asing ditolak, nilai harus teks/null.
fn isian_objek(draft: &Value, kolom: &[&str]) -> Result<HashMap<String, Option<String>>, String> {
    let objek = draft.as_object().ok_or("Isian tidak valid.")?;
    let mut hasil = HashMap::new();
    for (kunci, nilai) in objek {
        if !kolom.contains(&kunci.as_str()) {
            return Err(format!("Isian '{kunci}' tidak dikenal."));
        }
        let teks = match nilai {
            Value::Null => None,
            Value::String(t) => Some(t.trim().to_owned()).filter(|t| !t.is_empty()),
            _ => return Err(format!("{} tidak valid.", label_kolom(kunci))),
        };
        hasil.insert(kunci.clone(), teks);
    }
    Ok(hasil)
}

fn teks_terbatas(nilai: Option<String>, label: &str, maks: usize) -> Result<Option<String>, String> {
    match nilai {
        Some(t) if t.chars().count() > maks => Err(format!("{label} maksimal {maks} karakter.")),
        lain => Ok(lain),
    }
}

fn pilihan(nilai: Option<String>, label: &str, daftar: &[&str]) -> Result<Option<String>, String> {
    match nilai {
        Some(t) if !daftar.contains(&t.as_str()) => Err(format!("{label} tidak dikenal.")),
        lain => Ok(lain),
    }
}

/// Cermin `validasiPribadi`. Hasil berurutan `KOLOM_PRIBADI`.
pub fn validasi_pribadi(draft: &Value) -> Result<Vec<Option<String>>, String> {
    let mut isian = isian_objek(draft, &KOLOM_PRIBADI)?;
    let mut ambil = |k: &str| isian.remove(k).flatten();
    let nik = nomor_identitas(ambil("nik").as_deref(), "NIK", &[16])?;
    let no_kk = nomor_identitas(ambil("no_kk").as_deref(), "Nomor KK", &[16])?;
    let tempat_lahir = teks_terbatas(ambil("tempat_lahir"), "Tempat lahir", MAKS_NAMA)?;
    let tanggal_lahir = ambil("tanggal_lahir");
    if let Some(t) = &tanggal_lahir {
        if !is_valid_date(t) {
            return Err("Tanggal lahir tidak valid.".into());
        }
    }
    let agama = pilihan(ambil("agama"), "Agama", &AGAMA)?;
    let status_nikah = pilihan(ambil("status_nikah"), "Status nikah", &STATUS_NIKAH)?;
    let alamat_ktp = teks_terbatas(ambil("alamat_ktp"), "Alamat KTP", MAKS_TEKS)?;
    let alamat_domisili = teks_terbatas(ambil("alamat_domisili"), "Alamat domisili", MAKS_TEKS)?;
    let pendidikan = pilihan(ambil("pendidikan"), "Pendidikan", &PENDIDIKAN)?;
    let darurat_nama = teks_terbatas(ambil("darurat_nama"), "Nama kontak darurat", MAKS_NAMA)?;
    let darurat_hubungan =
        teks_terbatas(ambil("darurat_hubungan"), "Hubungan kontak darurat", MAKS_NAMA)?;
    let darurat_hp = match ambil("darurat_hp") {
        None => None,
        Some(t) => {
            let normal = normalize_operator_phone(&t);
            if !is_valid_operator_phone(&normal) {
                return Err("Nomor HP kontak darurat tidak valid.".into());
            }
            Some(normal)
        }
    };
    Ok(vec![
        nik,
        no_kk,
        tempat_lahir,
        tanggal_lahir,
        agama,
        status_nikah,
        alamat_ktp,
        alamat_domisili,
        pendidikan,
        darurat_nama,
        darurat_hubungan,
        darurat_hp,
    ])
}

/// Cermin `validasiKeuangan`. Hasil berurutan `KOLOM_KEUANGAN`.
pub fn validasi_keuangan(draft: &Value) -> Result<Vec<Option<String>>, String> {
    let mut isian = isian_objek(draft, &KOLOM_KEUANGAN)?;
    let mut ambil = |k: &str| isian.remove(k).flatten();
    let bank = teks_terbatas(ambil("bank"), "Bank", MAKS_NAMA)?;
    let no_rekening =
        nomor_identitas(ambil("no_rekening").as_deref(), "Nomor rekening", &PANJANG_REKENING)?;
    let nama_rekening = teks_terbatas(ambil("nama_rekening"), "Nama pemilik rekening", MAKS_NAMA)?;
    let npwp = nomor_identitas(ambil("npwp").as_deref(), "NPWP", &[15, 16])?;
    let bpjs_kesehatan = nomor_identitas(
        ambil("bpjs_kesehatan").as_deref(),
        "Nomor BPJS Kesehatan",
        &PANJANG_REKENING,
    )?;
    let bpjs_ketenagakerjaan = nomor_identitas(
        ambil("bpjs_ketenagakerjaan").as_deref(),
        "Nomor BPJS Ketenagakerjaan",
        &PANJANG_REKENING,
    )?;
    Ok(vec![
        bank,
        no_rekening,
        nama_rekening,
        npwp,
        bpjs_kesehatan,
        bpjs_ketenagakerjaan,
    ])
}

/// Kontrak yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct Kontrak {
    pub id_kontrak: String,
    pub jenis: String,
    pub id_ref: Option<String>,
    pub tanggal_mulai: String,
    pub tanggal_selesai: Option<String>,
    pub percobaan_selesai: Option<String>,
}

/// Isian kontrak baru yang sah.
#[derive(Clone, Debug, PartialEq)]
pub struct KontrakSah {
    pub id_karyawan: String,
    pub jenis: String,
    pub nomor: Option<String>,
    pub tanggal_mulai: String,
    pub tanggal_selesai: Option<String>,
    pub percobaan_selesai: Option<String>,
    pub catatan: Option<String>,
}

/// Cermin `validasiKontrak`. Hanya kelengkapan; angka hukum = tanda.
pub fn validasi_kontrak(draft: &Value) -> Result<KontrakSah, String> {
    let teks = |k: &str| payload_text(draft, k);
    let id_karyawan = teks("id_karyawan").ok_or("Karyawan wajib dipilih.")?;
    let jenis = teks("jenis")
        .filter(|j| JENIS_KONTRAK.contains(&j.as_str()))
        .ok_or("Jenis kontrak tidak dikenal.")?;
    let tanggal_mulai = teks("tanggal_mulai")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal mulai tidak valid.")?;
    let tanggal_selesai = teks("tanggal_selesai");
    if let Some(t) = &tanggal_selesai {
        if !is_valid_date(t) {
            return Err("Tanggal selesai tidak valid.".into());
        }
        if *t < tanggal_mulai {
            return Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into());
        }
    }
    match (jenis.as_str(), &tanggal_selesai) {
        ("PKWT" | "Magang", None) => {
            return Err("Kontrak PKWT dan Magang wajib punya tanggal selesai.".into())
        }
        ("PKWTT", Some(_)) => return Err("Kontrak PKWTT tidak punya tanggal selesai.".into()),
        _ => {}
    }
    let percobaan_selesai = teks("percobaan_selesai");
    if let Some(t) = &percobaan_selesai {
        if jenis != "PKWTT" {
            return Err("Masa percobaan hanya untuk PKWTT.".into());
        }
        if !is_valid_date(t) || *t < tanggal_mulai {
            return Err("Akhir masa percobaan tidak valid.".into());
        }
    }
    Ok(KontrakSah {
        id_karyawan,
        jenis,
        nomor: teks_terbatas(teks("nomor"), "Nomor kontrak", MAKS_NAMA)?,
        tanggal_mulai,
        tanggal_selesai,
        percobaan_selesai,
        catatan: teks_terbatas(teks("catatan"), "Catatan", MAKS_CATATAN)?,
    })
}

/// Kontrak yang berlaku (bukan pembatalan, tidak dibatalkan), urut mulai.
pub fn kontrak_aktif(kontrak: &[Kontrak]) -> Vec<&Kontrak> {
    let batal: HashSet<&str> = kontrak
        .iter()
        .filter(|k| k.jenis == "Pembatalan")
        .filter_map(|k| k.id_ref.as_deref())
        .collect();
    let mut hasil: Vec<&Kontrak> = kontrak
        .iter()
        .filter(|k| k.jenis != "Pembatalan" && !batal.contains(k.id_kontrak.as_str()))
        .collect();
    hasil.sort_by(|a, b| (&a.tanggal_mulai, &a.id_kontrak).cmp(&(&b.tanggal_mulai, &b.id_kontrak)));
    hasil
}

/// Cermin `statusKerja`: tidak disimpan, diturunkan dari kontrak.
pub fn status_kerja(kontrak: &[Kontrak], tanggal: &str) -> Value {
    let Some(k) = kontrak_aktif(kontrak)
        .into_iter()
        .filter(|k| k.tanggal_mulai.as_str() <= tanggal)
        .last()
    else {
        return json!({ "keadaan": "Tanpa kontrak" });
    };
    let berakhir = k.tanggal_selesai.as_deref().is_some_and(|s| s < tanggal);
    json!({
        "keadaan": if berakhir { "Berakhir" } else { "Berlaku" },
        "jenis": k.jenis,
        "id_kontrak": k.id_kontrak,
        "sampai": k.tanggal_selesai,
        "percobaan_sampai": k.percobaan_selesai.as_deref().filter(|p| *p >= tanggal),
    })
}

fn tanggal_ke_ymd(tanggal: &str) -> Option<(i64, i64, i64)> {
    if !is_valid_date(tanggal) {
        return None;
    }
    let mut bagian = tanggal.split('-').map(|b| b.parse::<i64>().ok());
    Some((bagian.next()??, bagian.next()??, bagian.next()??))
}

fn hari_dalam_bulan(tahun: i64, bulan: i64) -> i64 {
    match bulan {
        2 if (tahun % 4 == 0 && tahun % 100 != 0) || tahun % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Tanggal ditambah `n` bulan; hari dipotong ke akhir bulan (31 Jan + 1 = 28/29 Feb).
pub fn tambah_bulan(tanggal: &str, n: i64) -> Option<String> {
    let (y, m, d) = tanggal_ke_ymd(tanggal)?;
    let total = y * 12 + (m - 1) + n;
    let (ty, tm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    Some(format!("{ty:04}-{tm:02}-{:02}", d.min(hari_dalam_bulan(ty, tm))))
}

/// Nomor hari sejak 1970-01-01 (algoritme civil-from-days).
pub fn nomor_hari(tanggal: &str) -> Option<i64> {
    let (y, m, d) = tanggal_ke_ymd(tanggal)?;
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Angka bawaan kontrak (Q-46). Kosong/rusak = bawaan.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PengaturanKontrak {
    pub percobaan_maks_bulan: i64,
    pub pkwt_maks_bulan: i64,
    pub harian_batas_hari: i64,
    pub harian_batas_bulan: i64,
    pub sp_masa_bulan: i64,
    pub pelamar_retensi_bulan: i64,
    pub ingat_kontrak_jauh: i64,
    pub ingat_kontrak_dekat: i64,
    pub ingat_percobaan: i64,
    pub ingat_dokumen: i64,
    pub ingat_menunggu: i64,
    pub ingat_jam: i64,
}

impl Default for PengaturanKontrak {
    fn default() -> Self {
        Self {
            percobaan_maks_bulan: 3,
            pkwt_maks_bulan: 60,
            harian_batas_hari: 21,
            harian_batas_bulan: 3,
            sp_masa_bulan: 6,
            pelamar_retensi_bulan: 12,
            ingat_kontrak_jauh: 30,
            ingat_kontrak_dekat: 7,
            ingat_percobaan: 7,
            ingat_dokumen: 30,
            ingat_menunggu: 2,
            ingat_jam: 7,
        }
    }
}

/// Batas setiap angka: (kunci, label, min, maks).
pub const BATAS_PENGATURAN: [(&str, &str, i64, i64); 12] = [
    (KUNCI_PERCOBAAN_MAKS_BULAN, "Masa percobaan maksimal", 1, 12),
    (KUNCI_PKWT_MAKS_BULAN, "Total PKWT maksimal", 1, 120),
    (KUNCI_HARIAN_BATAS_HARI, "Batas hari kerja harian lepas", 1, 31),
    (KUNCI_HARIAN_BATAS_BULAN, "Batas bulan berturut-turut harian lepas", 1, 12),
    (KUNCI_SP_MASA_BULAN, "Masa berlaku SP (bulan)", 1, 12),
    (KUNCI_PELAMAR_RETENSI_BULAN, "Masa simpan data pelamar (bulan)", 1, 60),
    (KUNCI_INGAT_KONTRAK_JAUH, "Pengingat pertama PKWT berakhir (hari sebelumnya)", 8, 90),
    (KUNCI_INGAT_KONTRAK_DEKAT, "Pengingat kedua PKWT berakhir (hari sebelumnya)", 1, 30),
    (KUNCI_INGAT_PERCOBAAN, "Pengingat masa percobaan berakhir (hari sebelumnya)", 1, 30),
    (KUNCI_INGAT_DOKUMEN, "Pengingat dokumen kedaluwarsa (hari sebelumnya)", 1, 90),
    (KUNCI_INGAT_MENUNGGU, "Pengajuan dianggap lama menunggu (hari)", 1, 14),
    (KUNCI_INGAT_JAM, "Jam mulai pengingat HR (WIB)", 0, 23),
];

/// Aturan silang (§24.3): pengingat kedua harus lebih dekat ke hari berakhir.
pub const PESAN_INGAT_KONTRAK: &str =
    "Pengingat kedua PKWT harus lebih kecil dari pengingat pertama.";

// Angka pengingat dibaca SQL di database (aturan 19) lewat subkueri berbatas
// pola `retensi_bulan_sql!`: kosong atau di luar batas `BATAS_PENGATURAN` =
// bawaan `PengaturanKontrak::default`. Cermin `INGAT_*_SQL`; teksnya diuji
// sama dengan batas dan bawaan oleh `fragmen_ingat_sql`.
macro_rules! ingat_kontrak_jauh_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_kontrak_jauh' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 8 AND 90), 30)"
    };
}
macro_rules! ingat_kontrak_dekat_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_kontrak_dekat' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 30), 7)"
    };
}
macro_rules! ingat_percobaan_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_percobaan' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 30), 7)"
    };
}
macro_rules! ingat_dokumen_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_dokumen' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 90), 30)"
    };
}
macro_rules! ingat_menunggu_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_menunggu' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 14), 2)"
    };
}
macro_rules! ingat_jam_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_ingat_jam' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 0 AND 23), 7)"
    };
}
pub(crate) use {
    ingat_dokumen_sql, ingat_jam_sql, ingat_kontrak_dekat_sql, ingat_kontrak_jauh_sql,
    ingat_menunggu_sql, ingat_percobaan_sql,
};

impl PengaturanKontrak {
    pub fn dari_peta(peta: &HashMap<String, String>) -> Self {
        let bawaan = Self::default();
        let angka = |kunci: &str, cadangan: i64| {
            let (_, _, min, maks) = BATAS_PENGATURAN
                .iter()
                .find(|(k, ..)| *k == kunci)
                .copied()
                .unwrap_or((kunci, "", 1, i64::MAX));
            peta.get(kunci)
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|n| (min..=maks).contains(n))
                .unwrap_or(cadangan)
        };
        Self {
            percobaan_maks_bulan: angka(KUNCI_PERCOBAAN_MAKS_BULAN, bawaan.percobaan_maks_bulan),
            pkwt_maks_bulan: angka(KUNCI_PKWT_MAKS_BULAN, bawaan.pkwt_maks_bulan),
            harian_batas_hari: angka(KUNCI_HARIAN_BATAS_HARI, bawaan.harian_batas_hari),
            harian_batas_bulan: angka(KUNCI_HARIAN_BATAS_BULAN, bawaan.harian_batas_bulan),
            sp_masa_bulan: angka(KUNCI_SP_MASA_BULAN, bawaan.sp_masa_bulan),
            pelamar_retensi_bulan: angka(KUNCI_PELAMAR_RETENSI_BULAN, bawaan.pelamar_retensi_bulan),
            ingat_kontrak_jauh: angka(KUNCI_INGAT_KONTRAK_JAUH, bawaan.ingat_kontrak_jauh),
            ingat_kontrak_dekat: angka(KUNCI_INGAT_KONTRAK_DEKAT, bawaan.ingat_kontrak_dekat),
            ingat_percobaan: angka(KUNCI_INGAT_PERCOBAAN, bawaan.ingat_percobaan),
            ingat_dokumen: angka(KUNCI_INGAT_DOKUMEN, bawaan.ingat_dokumen),
            ingat_menunggu: angka(KUNCI_INGAT_MENUNGGU, bawaan.ingat_menunggu),
            ingat_jam: angka(KUNCI_INGAT_JAM, bawaan.ingat_jam),
        }
    }

    pub fn ke_json(&self) -> Value {
        json!({
            KUNCI_PERCOBAAN_MAKS_BULAN: self.percobaan_maks_bulan,
            KUNCI_PKWT_MAKS_BULAN: self.pkwt_maks_bulan,
            KUNCI_HARIAN_BATAS_HARI: self.harian_batas_hari,
            KUNCI_HARIAN_BATAS_BULAN: self.harian_batas_bulan,
            KUNCI_SP_MASA_BULAN: self.sp_masa_bulan,
            KUNCI_PELAMAR_RETENSI_BULAN: self.pelamar_retensi_bulan,
            KUNCI_INGAT_KONTRAK_JAUH: self.ingat_kontrak_jauh,
            KUNCI_INGAT_KONTRAK_DEKAT: self.ingat_kontrak_dekat,
            KUNCI_INGAT_PERCOBAAN: self.ingat_percobaan,
            KUNCI_INGAT_DOKUMEN: self.ingat_dokumen,
            KUNCI_INGAT_MENUNGGU: self.ingat_menunggu,
            KUNCI_INGAT_JAM: self.ingat_jam,
        })
    }
}

/// Cermin `validasiPengaturanKontrak`: setiap kunci wajib bilangan bulat
/// dalam batasnya, dan pengingat kedua PKWT < pengingat pertama. Hasil
/// berurutan `BATAS_PENGATURAN`.
pub fn validasi_pengaturan(draft: &Value) -> Result<Vec<(&'static str, i64)>, String> {
    let objek = draft.as_object().ok_or("Isian tidak valid.")?;
    if let Some(asing) = objek
        .keys()
        .find(|k| !BATAS_PENGATURAN.iter().any(|(kunci, ..)| kunci == k))
    {
        return Err(format!("Isian '{asing}' tidak dikenal."));
    }
    let hasil: Vec<(&'static str, i64)> = BATAS_PENGATURAN
        .iter()
        .map(|(kunci, label, min, maks)| {
            objek
                .get(*kunci)
                .and_then(Value::as_i64)
                .filter(|n| (*min..=*maks).contains(n))
                .map(|n| (*kunci, n))
                .ok_or_else(|| format!("{label} harus bilangan bulat {min}–{maks}."))
        })
        .collect::<Result<_, _>>()?;
    let nilai = |kunci: &str| hasil.iter().find(|(k, _)| *k == kunci).map(|(_, n)| *n);
    if nilai(KUNCI_INGAT_KONTRAK_DEKAT) >= nilai(KUNCI_INGAT_KONTRAK_JAUH) {
        return Err(PESAN_INGAT_KONTRAK.to_owned());
    }
    Ok(hasil)
}

/// `n` bulan penuh sebelum bulan `hari_ini`, terlama dulu: (awal, akhir).
pub fn bulan_penuh_terakhir(hari_ini: &str, n: i64) -> Vec<(String, String)> {
    let Some(awal_bulan_ini) = hari_ini.get(0..7).map(|ym| format!("{ym}-01")) else {
        return Vec::new();
    };
    (1..=n)
        .rev()
        .filter_map(|i| {
            let awal = tambah_bulan(&awal_bulan_ini, -i)?;
            let (y, m, _) = tanggal_ke_ymd(&awal)?;
            Some((awal.clone(), format!("{y:04}-{m:02}-{:02}", hari_dalam_bulan(y, m))))
        })
        .collect()
}

/// Cermin `tandaKontrak`. `hadir_bulanan` = hari hadir per bulan penuh
/// terakhir (`bulan_penuh_terakhir`), hanya dibutuhkan untuk Harian Lepas.
pub fn tanda_kontrak(
    kontrak: &[Kontrak],
    aturan: &PengaturanKontrak,
    hari_ini: &str,
    hadir_bulanan: &[i64],
) -> Vec<&'static str> {
    let aktif = kontrak_aktif(kontrak);
    let mut tanda = Vec::new();
    let percobaan_lewat = aktif.iter().any(|k| {
        k.percobaan_selesai.as_deref().is_some_and(|p| {
            tambah_bulan(&k.tanggal_mulai, aturan.percobaan_maks_bulan)
                .is_some_and(|batas| p > batas.as_str())
        })
    });
    if percobaan_lewat {
        tanda.push("percobaan_lewat");
    }
    // Rangkaian PKWT sejak PKWTT terakhir; jumlah hari kontraknya dibanding
    // lama `pkwt_maks_bulan` dari awal rangkaian.
    let sejak = aktif
        .iter()
        .rposition(|k| k.jenis == "PKWTT")
        .map(|i| i + 1)
        .unwrap_or(0);
    let pkwt: Vec<&&Kontrak> = aktif[sejak..].iter().filter(|k| k.jenis == "PKWT").collect();
    if let Some(awal) = pkwt.first() {
        let total: i64 = pkwt
            .iter()
            .filter_map(|k| {
                Some(nomor_hari(k.tanggal_selesai.as_deref()?)? - nomor_hari(&k.tanggal_mulai)? + 1)
            })
            .sum();
        let batas = tambah_bulan(&awal.tanggal_mulai, aturan.pkwt_maks_bulan)
            .and_then(|b| Some(nomor_hari(&b)? - nomor_hari(&awal.tanggal_mulai)?));
        if batas.is_some_and(|b| total > b) {
            tanda.push("pkwt_lewat");
        }
    }
    let harian = status_kerja(kontrak, hari_ini);
    let n = aturan.harian_batas_bulan as usize;
    if harian["keadaan"] == "Berlaku"
        && harian["jenis"] == "Harian Lepas"
        && hadir_bulanan.len() >= n
        && hadir_bulanan[hadir_bulanan.len() - n..]
            .iter()
            .all(|h| *h >= aturan.harian_batas_hari)
    {
        tanda.push("harian_perlu_pkwtt");
    }
    tanda
}

/// Cermin `periksaAtasan`. `peta` = id karyawan → id atasannya.
pub fn periksa_atasan(
    id_karyawan: &str,
    id_atasan: &str,
    peta: &HashMap<String, Option<String>>,
) -> Result<(), String> {
    if id_atasan == id_karyawan {
        return Err("Atasan tidak boleh dirinya sendiri.".into());
    }
    if !peta.contains_key(id_atasan) {
        return Err("Atasan tidak ditemukan.".into());
    }
    let mut kini = Some(id_atasan.to_owned());
    for _ in 0..=peta.len() {
        match kini {
            Some(id) if id == id_karyawan => {
                return Err("Pilihan atasan membentuk lingkaran atasan.".into())
            }
            Some(id) => kini = peta.get(&id).cloned().flatten(),
            None => return Ok(()),
        }
    }
    Ok(())
}

/// Cermin `dalamSiklusAtasan`: karyawan yang rantai atasannya kembali ke
/// dirinya (lahir dari dua perangkat offline).
pub fn dalam_siklus_atasan(peta: &HashMap<String, Option<String>>) -> HashSet<String> {
    peta.keys()
        .filter(|id| {
            let mut kini = peta.get(*id).cloned().flatten();
            for _ in 0..peta.len() {
                match kini {
                    Some(ref a) if a == *id => return true,
                    Some(a) => kini = peta.get(&a).cloned().flatten(),
                    None => return false,
                }
            }
            false
        })
        .cloned()
        .collect()
}

/// Cermin `validasiBerkas`: MIME, ukuran, base64, dan tanda tangan bita.
pub fn validasi_berkas(mime: &str, data_base64: &str) -> Result<(), String> {
    if !MIME_BERKAS.contains(&mime) {
        return Err("Jenis berkas harus JPEG, PNG, WEBP, atau PDF.".into());
    }
    if data_base64.len() > MAKS_BERKAS_BASE64 {
        return Err("Berkas maksimal 1 MB.".into());
    }
    if !base64_sah(data_base64) {
        return Err("Isi berkas tidak terbaca.".into());
    }
    let awal: String = data_base64.chars().take(24).collect();
    let bita = base64::engine::general_purpose::STANDARD
        .decode(awal)
        .map_err(|_| "Isi berkas tidak terbaca.".to_owned())?;
    let cocok = match mime {
        "application/pdf" => bita.starts_with(b"%PDF"),
        "image/jpeg" => bita.starts_with(&[0xFF, 0xD8]),
        "image/png" => bita.starts_with(&[0x89, 0x50, 0x4E, 0x47]),
        _ => bita.len() >= 12 && bita.starts_with(b"RIFF") && &bita[8..12] == b"WEBP",
    };
    if !cocok {
        return Err("Isi berkas tidak cocok dengan jenisnya.".into());
    }
    Ok(())
}

/// Isian dokumen yang sah.
#[derive(Clone, Debug, PartialEq)]
pub struct DokumenSah {
    pub id_dokumen: Option<String>,
    pub id_karyawan: String,
    pub id_jenis: String,
    pub nomor: Option<String>,
    pub tanggal_terbit: Option<String>,
    pub tanggal_kedaluwarsa: Option<String>,
    pub catatan: Option<String>,
}

/// Cermin `validasiDokumen`.
pub fn validasi_dokumen(draft: &Value) -> Result<DokumenSah, String> {
    let teks = |k: &str| payload_text(draft, k);
    let id_karyawan = teks("id_karyawan").ok_or("Karyawan wajib dipilih.")?;
    let id_jenis = teks("id_jenis").ok_or("Jenis dokumen wajib dipilih.")?;
    let tanggal = |k: &str, label: &str| -> Result<Option<String>, String> {
        match teks(k) {
            Some(t) if !is_valid_date(&t) => Err(format!("{label} tidak valid.")),
            lain => Ok(lain),
        }
    };
    let tanggal_terbit = tanggal("tanggal_terbit", "Tanggal terbit")?;
    let tanggal_kedaluwarsa = tanggal("tanggal_kedaluwarsa", "Tanggal kedaluwarsa")?;
    if let (Some(t), Some(k)) = (&tanggal_terbit, &tanggal_kedaluwarsa) {
        if k < t {
            return Err("Tanggal kedaluwarsa tidak boleh sebelum tanggal terbit.".into());
        }
    }
    Ok(DokumenSah {
        id_dokumen: teks("id_dokumen"),
        id_karyawan,
        id_jenis,
        nomor: teks_terbatas(teks("nomor"), "Nomor dokumen", MAKS_NAMA)?,
        tanggal_terbit,
        tanggal_kedaluwarsa,
        catatan: teks_terbatas(teks("catatan"), "Catatan", MAKS_CATATAN)?,
    })
}

/// Satu master organisasi (cabang, divisi, jabatan).
pub struct Master {
    pub tabel: &'static str,
    pub kolom_id: &'static str,
    pub awalan_id: &'static str,
    pub domain: &'static str,
    pub label: &'static str,
    pub upsert_sql: &'static str,
}

pub const MASTER_CABANG: Master = Master {
    tabel: "hr_cabang",
    kolom_id: "id_cabang",
    awalan_id: "cb-",
    domain: "hr-branch",
    label: "Cabang",
    upsert_sql: UPSERT_CABANG_SQL,
};
pub const MASTER_DIVISI: Master = Master {
    tabel: "hr_divisi",
    kolom_id: "id_divisi",
    awalan_id: "dv-",
    domain: "hr-division",
    label: "Divisi",
    upsert_sql: UPSERT_DIVISI_SQL,
};
pub const MASTER_JABATAN: Master = Master {
    tabel: "hr_jabatan",
    kolom_id: "id_jabatan",
    awalan_id: "jb-",
    domain: "hr-position",
    label: "Jabatan",
    upsert_sql: UPSERT_JABATAN_SQL,
};

/// Cermin `namaBentrok`: nama sudah dipakai master lain (atau, untuk divisi,
/// pernah dipakai divisi lain). `lain` = (id, nama) semua nama yang ada.
pub fn nama_bentrok(id: Option<&str>, nama: &str, lain: &[(String, String)]) -> bool {
    let kunci = kunci_nama(nama);
    lain.iter()
        .any(|(id_lain, nama_lain)| Some(id_lain.as_str()) != id && kunci_nama(nama_lain) == kunci)
}

// ── Penulisan lokal: SQLite + outbox satu transaksi ────────────────────────

fn internal<E>(_: E) -> CommandError {
    CommandError::internal()
}

pub(super) fn dalam_transaksi<T>(
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

/// Setiap baris hasil kueri sebagai objek JSON berkunci nama kolom. Payload
/// outbox = baris lokal apa adanya, jadi handler cloud membaca kolom yang sama.
pub(super) fn baris_json(conn: &Connection, sql: &str, arg: Option<&str>) -> Result<Vec<Value>, CommandError> {
    let mut statement = conn.prepare(sql).map_err(internal)?;
    let kolom: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let ubah = |row: &rusqlite::Row<'_>| {
        let mut objek = Map::new();
        for (i, nama) in kolom.iter().enumerate() {
            let nilai = match row.get_ref(i)? {
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                _ => Value::Null,
            };
            objek.insert(nama.clone(), nilai);
        }
        Ok(Value::Object(objek))
    };
    let baris = match arg {
        Some(a) => statement.query_map(params![a], ubah),
        None => statement.query_map([], ubah),
    }
    .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

pub(super) fn satu_baris(conn: &Connection, sql: &str, id: &str) -> Result<Value, CommandError> {
    baris_json(conn, sql, Some(id))?
        .into_iter()
        .next()
        .ok_or_else(CommandError::internal)
}

fn semua_nama(conn: &Connection, sql: &str, arg: Option<&str>) -> Result<Vec<(String, String)>, CommandError> {
    let mut statement = conn.prepare(sql).map_err(internal)?;
    let ubah = |r: &rusqlite::Row<'_>| Ok((r.get(0)?, r.get(1)?));
    let baris = match arg {
        Some(a) => statement.query_map(params![a], ubah),
        None => statement.query_map([], ubah),
    }
    .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

pub(super) fn hari_ini_wib(conn: &Connection) -> Result<String, CommandError> {
    conn.query_row("SELECT date('now', '+7 hours');", [], |r| r.get(0))
        .map_err(internal)
}

fn aktif_dari(draft: &Value) -> Result<i64, CommandError> {
    match draft.get("is_aktif") {
        None | Some(Value::Null) => Ok(1),
        Some(Value::Bool(b)) => Ok(i64::from(*b)),
        Some(v) => v
            .as_i64()
            .filter(|n| *n == 0 || *n == 1)
            .ok_or_else(|| invalid("Status aktif tidak valid.")),
    }
}

/// Simpan cabang, divisi, atau jabatan. Divisi juga mencatat nama barunya ke
/// `hr_divisi_nama`; divisi dan jabatan menyelaraskan teks di `master_data`.
pub fn simpan_master(state: &DesktopState, master: &Master, draft: &Value) -> Result<Value, CommandError> {
    let nama = nama_master(payload_text(draft, "nama").as_deref().unwrap_or("")).map_err(invalid)?;
    let alamat = teks_terbatas(payload_text(draft, "alamat"), "Alamat", MAKS_TEKS).map_err(invalid)?;
    let is_aktif = aktif_dari(draft)?;
    let id_masuk = payload_text(draft, master.kolom_id);
    dalam_transaksi(state, |tx, client_id| {
        if let Some(id) = &id_masuk {
            let ada: bool = tx
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {} WHERE {} = ?1);", master.tabel, master.kolom_id),
                    params![id],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            if !ada {
                return Err(invalid(format!("{} tidak ditemukan.", master.label)));
            }
        }
        let mut nama_lain = semua_nama(
            tx,
            &format!("SELECT {}, nama FROM {};", master.kolom_id, master.tabel),
            None,
        )?;
        if master.tabel == "hr_divisi" {
            nama_lain.extend(semua_nama(tx, "SELECT id_divisi, nama FROM hr_divisi_nama;", None)?);
        }
        if nama_bentrok(id_masuk.as_deref(), &nama, &nama_lain) {
            return Err(invalid(format!(
                "{} \"{nama}\" sudah ada atau pernah dipakai.",
                master.label
            )));
        }
        let id = id_masuk.clone().unwrap_or_else(|| new_hex_id(master.awalan_id));
        if master.tabel == "hr_cabang" {
            tx.execute(master.upsert_sql, params![id, nama, alamat, is_aktif, Option::<String>::None])
                .map_err(internal)?;
        } else {
            tx.execute(master.upsert_sql, params![id, nama, is_aktif, Option::<String>::None])
                .map_err(internal)?;
        }
        let baris = satu_baris(tx, &format!("SELECT * FROM {} WHERE {} = ?1;", master.tabel, master.kolom_id), &id)?;
        let payload = match master.tabel {
            "hr_divisi" => {
                let nama_baru = !semua_nama(tx, "SELECT id_divisi, nama FROM hr_divisi_nama WHERE id_divisi = ?1;", Some(&id))?
                    .iter()
                    .any(|(_, n)| kunci_nama(n) == kunci_nama(&nama));
                let baris_nama = if nama_baru {
                    let id_nama = new_hex_id("dn-");
                    tx.execute(
                        INSERT_NAMA_DIVISI_SQL,
                        params![id_nama, id, nama, Option::<String>::None],
                    )
                    .map_err(internal)?;
                    satu_baris(tx, "SELECT * FROM hr_divisi_nama WHERE id_nama = ?1;", &id_nama)?
                } else {
                    Value::Null
                };
                for sql in SELARASKAN_DIVISI_SQL {
                    tx.execute(sql, params![id]).map_err(internal)?;
                }
                json!({ "divisi": baris, "nama": baris_nama })
            }
            "hr_jabatan" => {
                for sql in SELARASKAN_JABATAN_SQL {
                    tx.execute(sql, params![id]).map_err(internal)?;
                }
                baris
            }
            _ => baris,
        };
        sync::enqueue(tx, client_id, master.domain, "save", &id, &payload, None)?;
        Ok(json!({ "sukses": true, master.kolom_id: id }))
    })
}

pub(super) fn baca_kontrak(conn: &Connection, id_karyawan: Option<&str>) -> Result<Vec<(String, Kontrak, Value)>, CommandError> {
    let sql = "SELECT id_kontrak, id_karyawan, jenis, id_ref, nomor, tanggal_mulai, tanggal_selesai, percobaan_selesai, catatan, dicatat_oleh, created_at FROM hr_kontrak WHERE (?1 IS NULL OR id_karyawan = ?1) ORDER BY id_karyawan, tanggal_mulai, id_kontrak;";
    let mut statement = conn.prepare(sql).map_err(internal)?;
    let baris = statement
        .query_map(params![id_karyawan], |r| {
            let kontrak = Kontrak {
                id_kontrak: r.get(0)?,
                jenis: r.get(2)?,
                id_ref: r.get(3)?,
                tanggal_mulai: r.get(5)?,
                tanggal_selesai: r.get(6)?,
                percobaan_selesai: r.get(7)?,
            };
            let lengkap = json!({
                "id_kontrak": kontrak.id_kontrak,
                "id_karyawan": r.get::<_, String>(1)?,
                "jenis": kontrak.jenis,
                "id_ref": kontrak.id_ref,
                "nomor": r.get::<_, Option<String>>(4)?,
                "tanggal_mulai": kontrak.tanggal_mulai,
                "tanggal_selesai": kontrak.tanggal_selesai,
                "percobaan_selesai": kontrak.percobaan_selesai,
                "catatan": r.get::<_, Option<String>>(8)?,
                "dicatat_oleh": r.get::<_, String>(9)?,
                "created_at": r.get::<_, String>(10)?,
            });
            Ok((r.get::<_, String>(1)?, kontrak, lengkap))
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn baca_pengaturan(conn: &Connection) -> Result<PengaturanKontrak, CommandError> {
    let mut statement = conn
        .prepare("SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_%' ESCAPE '\\';")
        .map_err(internal)?;
    let peta = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(internal)?;
    Ok(PengaturanKontrak::dari_peta(&peta))
}

/// Catat kontrak baru (`hr.contract.manage`). `jenis_personil` mengikutinya.
pub fn catat_kontrak(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let sah = validasi_kontrak(draft).map_err(invalid)?;
    let id = new_hex_id("ktr-");
    dalam_transaksi(state, |tx, client_id| catat_kontrak_tx(tx, client_id, oleh, &sah, &id))
}

/// Inti `catat_kontrak` di transaksi pemanggil, ber-id dari pemanggil.
/// Jadikan karyawan (fase 7) memakai `ktr-<id_pelamar>`: kiriman ulang
/// berhenti di PK lokal (`ON CONFLICT DO NOTHING`) dan di cloud.
pub fn catat_kontrak_tx(tx: &Transaction<'_>, client_id: &str, oleh: &str, sah: &KontrakSah, id: &str) -> Result<Value, CommandError> {
    let ada: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM master_data WHERE id_unik = ?1);",
            params![sah.id_karyawan],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if !ada {
        return Err(invalid("Karyawan tidak ditemukan."));
    }
    tx.execute(
        INSERT_KONTRAK_SQL,
        params![
            id,
            sah.id_karyawan,
            sah.jenis,
            Option::<String>::None,
            sah.nomor,
            sah.tanggal_mulai,
            sah.tanggal_selesai,
            sah.percobaan_selesai,
            sah.catatan,
            oleh,
            Option::<String>::None
        ],
    )
    .map_err(internal)?;
    tx.execute(JENIS_DARI_KONTRAK_SQL, params![sah.id_karyawan])
        .map_err(internal)?;
    let baris = satu_baris(tx, "SELECT * FROM hr_kontrak WHERE id_kontrak = ?1;", id)?;
    sync::enqueue(tx, client_id, "hr-contract", "create", id, &baris, None)?;
    Ok(json!({ "sukses": true, "id_kontrak": id }))
}

/// Batalkan kontrak (`batal-<id>`, alasan wajib). Bukan menghapus.
pub fn batal_kontrak(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_kontrak = payload_text(draft, "id_kontrak").ok_or_else(|| invalid("Kontrak tidak ditemukan."))?;
    let alasan = teks_terbatas(payload_text(draft, "alasan"), "Alasan", MAKS_CATATAN)
        .map_err(invalid)?
        .ok_or_else(|| invalid("Alasan pembatalan wajib diisi."))?;
    dalam_transaksi(state, |tx, client_id| {
        let asal: Option<(String, String)> = tx
            .query_row(
                "SELECT id_karyawan, jenis FROM hr_kontrak WHERE id_kontrak = ?1;",
                params![id_kontrak],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(internal)?;
        let Some((id_karyawan, _)) = asal.filter(|(_, j)| j != "Pembatalan") else {
            return Err(invalid("Kontrak tidak ditemukan."));
        };
        let id = format!("batal-{id_kontrak}");
        let sudah: bool = tx
            .query_row("SELECT EXISTS(SELECT 1 FROM hr_kontrak WHERE id_kontrak = ?1);", params![id], |r| r.get(0))
            .map_err(internal)?;
        if sudah {
            return Err(invalid("Kontrak sudah dibatalkan."));
        }
        let hari_ini = hari_ini_wib(tx)?;
        tx.execute(
            INSERT_KONTRAK_SQL,
            params![
                id,
                id_karyawan,
                "Pembatalan",
                id_kontrak,
                Option::<String>::None,
                hari_ini,
                Option::<String>::None,
                Option::<String>::None,
                alasan,
                oleh,
                Option::<String>::None
            ],
        )
        .map_err(internal)?;
        tx.execute(JENIS_DARI_KONTRAK_SQL, params![id_karyawan])
            .map_err(internal)?;
        let baris = satu_baris(tx, "SELECT * FROM hr_kontrak WHERE id_kontrak = ?1;", &id)?;
        sync::enqueue(tx, client_id, "hr-contract", "create", &id, &baris, None)?;
        Ok(json!({ "sukses": true, "id_kontrak": id }))
    })
}

/// Simpan angka bawaan kontrak lewat rute `setting/update` yang sudah ada.
pub fn simpan_pengaturan(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let isian: Vec<(&str, String)> = validasi_pengaturan(draft)
        .map_err(invalid)?
        .into_iter()
        .map(|(kunci, nilai)| (kunci, nilai.to_string()))
        .collect();
    dalam_transaksi(state, |tx, client_id| tulis_pengaturan(tx, client_id, &isian))
}

/// Upsert `setting_gex_system` + outbox `setting/update`, satu transaksi.
/// Dipakai juga pengaturan kinerja (v41), yang validatornya sendiri.
pub(super) fn tulis_pengaturan(tx: &Transaction<'_>, client_id: &str, isian: &[(&str, String)]) -> Result<Value, CommandError> {
    for (kunci, nilai) in isian {
        tx.execute(
            "INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![kunci, nilai],
        )
        .map_err(internal)?;
        // Hanya nilai terakhir yang perlu sampai ke cloud (pola `sj_prefix`).
        tx.execute(
            "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ?1
               AND status IN ('pending', 'failed', 'conflict');",
            params![kunci],
        )
        .map_err(internal)?;
        sync::enqueue(
            tx,
            client_id,
            "setting",
            "update",
            kunci,
            &json!({ "key": kunci, "value": nilai }),
            None,
        )?;
    }
    Ok(json!({ "sukses": true }))
}

// ── Data organisasi karyawan (dipakai `operational.rs`) ────────────────────

/// Organisasi karyawan yang sudah dipetakan ke master.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrgKaryawan {
    pub id_cabang: Option<String>,
    pub id_divisi: Option<String>,
    pub divisi: String,
    pub id_jabatan: Option<String>,
    pub jabatan_status: Option<String>,
    pub id_atasan: Option<String>,
}

/// Nilai lama karyawan yang sedang diubah.
fn org_lama(conn: &Connection, id: &str) -> Result<Option<OrgKaryawan>, CommandError> {
    conn.query_row(
        "SELECT id_cabang, id_divisi, divisi, id_jabatan, jabatan_status, id_atasan FROM master_data WHERE id_unik = ?1;",
        params![id],
        |r| {
            Ok(OrgKaryawan {
                id_cabang: r.get::<_, Option<String>>(0)?.filter(|s| !s.is_empty()),
                id_divisi: r.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()),
                divisi: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                id_jabatan: r.get::<_, Option<String>>(3)?.filter(|s| !s.is_empty()),
                jabatan_status: r.get::<_, Option<String>>(4)?,
                id_atasan: r.get::<_, Option<String>>(5)?.filter(|s| !s.is_empty()),
            })
        },
    )
    .optional()
    .map_err(internal)
}

/// Master (id, nama, aktif) berdasarkan id.
fn master_by_id(conn: &Connection, master: &Master, id: &str) -> Result<Option<(String, bool)>, CommandError> {
    conn.query_row(
        &format!("SELECT nama, is_aktif FROM {} WHERE {} = ?1;", master.tabel, master.kolom_id),
        params![id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? == 1)),
    )
    .optional()
    .map_err(internal)
}

/// Master divisi/jabatan berdasarkan teks (divisi termasuk nama lama).
fn master_by_teks(conn: &Connection, master: &Master, teks: &str) -> Result<Option<String>, CommandError> {
    let sql = if master.tabel == "hr_divisi" {
        "SELECT id_divisi, nama FROM hr_divisi_nama ORDER BY created_at, id_nama;"
    } else {
        "SELECT id_jabatan, nama FROM hr_jabatan ORDER BY created_at, id_jabatan;"
    };
    let kunci = kunci_nama(teks);
    Ok(semua_nama(conn, sql, None)?
        .into_iter()
        .find(|(_, n)| kunci_nama(n) == kunci)
        .map(|(id, _)| id))
}

/// `None` = kunci tidak dibawa (absen atau `null`: perangkat lama, atau
/// perangkat yang belum menarik hasil migrasi), `Some(None)` = dikosongkan
/// (`""`), `Some(Some(id))` = diisi.
fn kunci_dibawa(draft: &Value, kunci: &str) -> Option<Option<String>> {
    draft.get(kunci).and_then(Value::as_str).map(|v| {
        Some(v.trim())
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    })
}

/// Petakan isian organisasi form/impor ke master. `id_karyawan` kosong =
/// karyawan baru (divisi wajib). Teks yang tidak dikenal ditolak, kecuali
/// sama dengan teks lama karyawan itu (data lama yang belum dipetakan).
pub fn org_dari_draft(conn: &Connection, id_karyawan: &str, draft: &Value) -> Result<OrgKaryawan, CommandError> {
    let lama = if id_karyawan.is_empty() { None } else { org_lama(conn, id_karyawan)? };
    let baru = lama.is_none();
    let lama = lama.unwrap_or_default();
    let pilih_master = |master: &Master, id: &str, id_lama: &Option<String>| -> Result<String, CommandError> {
        let (nama, aktif) = master_by_id(conn, master, id)?
            .ok_or_else(|| invalid(format!("{} tidak ditemukan.", master.label)))?;
        if !aktif && id_lama.as_deref() != Some(id) {
            return Err(invalid(format!("{} \"{nama}\" sudah nonaktif.", master.label)));
        }
        Ok(nama)
    };

    // Divisi: id dari master, atau teks yang dipetakan.
    let (id_divisi, divisi) = match payload_text(draft, "id_divisi") {
        Some(id) => {
            let nama = pilih_master(&MASTER_DIVISI, &id, &lama.id_divisi)?;
            (Some(id), nama)
        }
        None => match payload_text(draft, "divisi") {
            Some(teks) => match master_by_teks(conn, &MASTER_DIVISI, &teks)? {
                Some(id) => {
                    let nama = pilih_master(&MASTER_DIVISI, &id, &lama.id_divisi)?;
                    (Some(id), nama)
                }
                None if !baru && kunci_nama(&teks) == kunci_nama(&lama.divisi) => (lama.id_divisi.clone(), lama.divisi.clone()),
                None => {
                    return Err(invalid(format!(
                        "Divisi '{teks}' belum terdaftar di Pengaturan → Organisasi."
                    )))
                }
            },
            None if baru => return Err(invalid("Divisi wajib dipilih.")),
            None => (lama.id_divisi.clone(), lama.divisi.clone()),
        },
    };

    // Jabatan: opsional.
    let (id_jabatan, jabatan_status) = match kunci_dibawa(draft, "id_jabatan") {
        Some(Some(id)) => {
            let nama = pilih_master(&MASTER_JABATAN, &id, &lama.id_jabatan)?;
            (Some(id), Some(nama))
        }
        Some(None) => (None, lama.jabatan_status.clone()),
        None => match payload_text(draft, "jabatan_status").filter(|t| t != "-") {
            Some(teks) => match master_by_teks(conn, &MASTER_JABATAN, &teks)? {
                Some(id) => {
                    let nama = pilih_master(&MASTER_JABATAN, &id, &lama.id_jabatan)?;
                    (Some(id), Some(nama))
                }
                None if lama.jabatan_status.as_deref().is_some_and(|l| kunci_nama(l) == kunci_nama(&teks)) => {
                    (lama.id_jabatan.clone(), lama.jabatan_status.clone())
                }
                None => {
                    return Err(invalid(format!(
                        "Jabatan '{teks}' belum terdaftar di Pengaturan → Organisasi."
                    )))
                }
            },
            None => (lama.id_jabatan.clone(), lama.jabatan_status.clone()),
        },
    };

    let id_cabang = match kunci_dibawa(draft, "id_cabang") {
        Some(Some(id)) => {
            pilih_master(&MASTER_CABANG, &id, &lama.id_cabang)?;
            Some(id)
        }
        Some(None) => None,
        None => lama.id_cabang.clone(),
    };

    let id_atasan = match kunci_dibawa(draft, "id_atasan") {
        Some(Some(id)) => {
            let mut statement = conn
                .prepare("SELECT id_unik, id_atasan FROM master_data;")
                .map_err(internal)?;
            let peta = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()),
                    ))
                })
                .map_err(internal)?
                .collect::<Result<HashMap<_, _>, _>>()
                .map_err(internal)?;
            let diri = if id_karyawan.is_empty() {
                payload_text(draft, "id_unik").unwrap_or_default()
            } else {
                id_karyawan.to_owned()
            };
            periksa_atasan(&diri, &id, &peta).map_err(invalid)?;
            Some(id)
        }
        Some(None) => None,
        None => lama.id_atasan.clone(),
    };

    Ok(OrgKaryawan {
        id_cabang,
        id_divisi,
        divisi,
        id_jabatan,
        jabatan_status,
        id_atasan,
    })
}

/// Kolom organisasi untuk payload outbox `employee/*`. Cabang dan atasan
/// yang kosong dikirim `""` HANYA bila draft sengaja mengosongkannya; selain
/// itu `null` (= tidak dibawa), supaya perangkat yang belum menarik hasil
/// migrasi tidak pernah menghapus nilai di cloud.
pub fn isi_payload_org(payload: &mut Value, draft: &Value, org: &OrgKaryawan) {
    let Some(objek) = payload.as_object_mut() else {
        return;
    };
    for (kolom, nilai) in [("id_cabang", &org.id_cabang), ("id_atasan", &org.id_atasan)] {
        let isi = match (nilai, kunci_dibawa(draft, kolom)) {
            (Some(id), _) => json!(id),
            (None, Some(None)) => json!(""),
            (None, _) => Value::Null,
        };
        objek.insert(kolom.into(), isi);
    }
    objek.insert("id_divisi".into(), json!(org.id_divisi));
    objek.insert("id_jabatan".into(), json!(org.id_jabatan));
    objek.insert("divisi".into(), json!(org.divisi));
    if let Some(jabatan) = &org.jabatan_status {
        objek.insert("jabatan_status".into(), json!(jabatan));
    }
}

/// Tulis kolom organisasi ke `master_data` (sesudah insert/update baris).
pub fn tulis_org(tx: &Transaction<'_>, id_karyawan: &str, org: &OrgKaryawan) -> Result<(), CommandError> {
    tx.execute(
        "UPDATE master_data SET id_cabang = ?1, id_divisi = ?2, divisi = ?3, id_jabatan = ?4,
            jabatan_status = COALESCE(?5, jabatan_status), id_atasan = ?6 WHERE id_unik = ?7;",
        params![
            org.id_cabang,
            org.id_divisi,
            org.divisi,
            org.id_jabatan,
            org.jabatan_status,
            org.id_atasan,
            id_karyawan
        ],
    )
    .map_err(internal)?;
    // Karyawan berkontrak: `jenis_personil` mengikuti kontrak (Q-40).
    tx.execute(JENIS_DARI_KONTRAK_SQL, params![id_karyawan])
        .map_err(internal)?;
    Ok(())
}

// ── Pembacaan untuk layar ──────────────────────────────────────────────────

/// Master organisasi, nama lama, tanda, teks tanpa master, dan pengaturan.
pub fn organisasi(state: &DesktopState) -> Result<Value, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let jumlah = |kolom: &str| -> Result<HashMap<String, i64>, CommandError> {
        let mut st = conn
            .prepare(&format!(
                "SELECT {kolom}, COUNT(*) FROM master_data WHERE COALESCE({kolom}, '') <> '' AND status_aktif = 'Aktif' GROUP BY {kolom};"
            ))
            .map_err(internal)?;
        let peta = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(internal)?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(internal);
        peta
    };
    let daftar = |master: &Master, kolom_karyawan: &str, nama_lama: &[(String, String)]| -> Result<Vec<Value>, CommandError> {
        let semua = baris_json(&conn, &format!("SELECT * FROM {} ORDER BY is_aktif DESC, nama;", master.tabel), None)?;
        let hitung = jumlah(kolom_karyawan)?;
        let mut pembanding: Vec<(String, String)> = semua
            .iter()
            .map(|b| (b[master.kolom_id].as_str().unwrap_or("").to_owned(), b["nama"].as_str().unwrap_or("").to_owned()))
            .collect();
        pembanding.extend(nama_lama.iter().cloned());
        Ok(semua
            .into_iter()
            .map(|mut b| {
                let id = b[master.kolom_id].as_str().unwrap_or("").to_owned();
                let nama = b["nama"].as_str().unwrap_or("").to_owned();
                b["jumlah"] = json!(hitung.get(&id).copied().unwrap_or(0));
                b["nama_ganda"] = json!(nama_bentrok(Some(&id), &nama, &pembanding));
                if master.tabel == "hr_divisi" {
                    b["nama_lama"] = json!(nama_lama
                        .iter()
                        .filter(|(i, n)| *i == id && kunci_nama(n) != kunci_nama(&nama))
                        .map(|(_, n)| n.clone())
                        .collect::<Vec<_>>());
                }
                b
            })
            .collect())
    };
    let nama_divisi = semua_nama(&conn, "SELECT id_divisi, nama FROM hr_divisi_nama ORDER BY created_at, id_nama;", None)?;
    let cabang = daftar(&MASTER_CABANG, "id_cabang", &[])?;
    let divisi = daftar(&MASTER_DIVISI, "id_divisi", &nama_divisi)?;
    let jabatan = daftar(&MASTER_JABATAN, "id_jabatan", &[])?;
    let tanpa_master = baris_json(
        &conn,
        "SELECT MIN(TRIM(divisi)) AS teks, COUNT(*) AS jumlah FROM master_data WHERE COALESCE(id_divisi, '') = '' AND TRIM(COALESCE(divisi, '')) <> '' GROUP BY LOWER(TRIM(divisi)) ORDER BY teks;",
        None,
    )?;
    let mut st = conn
        .prepare("SELECT id_unik, id_atasan FROM master_data;")
        .map_err(internal)?;
    let peta = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()))))
        .map_err(internal)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(internal)?;
    let mut siklus: Vec<String> = dalam_siklus_atasan(&peta).into_iter().collect();
    siklus.sort();
    Ok(json!({
        "cabang": cabang,
        "divisi": divisi,
        "jabatan": jabatan,
        "tanpa_master": tanpa_master,
        "atasan_siklus": siklus,
        "pengaturan": baca_pengaturan(&conn)?.ke_json(),
    }))
}

/// Kontrak satu karyawan (lengkap) atau ringkasan semua karyawan aktif:
/// status kerja dan tanda.
pub fn kontrak(state: &DesktopState, id_karyawan: Option<&str>) -> Result<Value, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let hari_ini = hari_ini_wib(&conn)?;
    let aturan = baca_pengaturan(&conn)?;
    let semua = baca_kontrak(&conn, id_karyawan)?;
    let mut per: HashMap<String, (Vec<Kontrak>, Vec<Value>)> = HashMap::new();
    for (id, k, lengkap) in semua {
        let isi = per.entry(id).or_default();
        isi.0.push(k);
        isi.1.push(lengkap);
    }
    let bulan = bulan_penuh_terakhir(&hari_ini, aturan.harian_batas_bulan);
    let ringkas = |id: &str, kontrak: &[Kontrak]| -> Result<Value, CommandError> {
        let status = status_kerja(kontrak, &hari_ini);
        let hadir = if status["jenis"] == "Harian Lepas" {
            bulan
                .iter()
                .map(|(awal, akhir)| {
                    conn.query_row(
                        &format!("SELECT {} FROM master_data md WHERE md.id_unik = ?3;", super::driver::HARI_HADIR_SQL),
                        params![awal, akhir, id],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()
                    .map(|n| n.unwrap_or(0))
                    .map_err(internal)
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        Ok(json!({
            "id_karyawan": id,
            "status": status,
            "tanda": tanda_kontrak(kontrak, &aturan, &hari_ini, &hadir),
        }))
    };
    match id_karyawan {
        Some(id) => {
            let (k, lengkap) = per.remove(id).unwrap_or_default();
            let mut hasil = ringkas(id, &k)?;
            hasil["kontrak"] = json!(lengkap);
            hasil["hari_ini"] = json!(hari_ini);
            Ok(hasil)
        }
        None => {
            let mut ids: Vec<&String> = per.keys().collect();
            ids.sort();
            let daftar = ids
                .into_iter()
                .map(|id| ringkas(id, &per[id].0))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "karyawan": daftar, "hari_ini": hari_ini }))
        }
    }
}

// ── Handler cloud (tidak pernah menolak karena master) ─────────────────────

pub(super) fn id_dari(row: &Value, kolom: &str, entity_key: &str) -> Option<String> {
    payload_text(row, kolom)
        .or_else(|| Some(entity_key.trim().to_owned()))
        .filter(|id| !id.is_empty())
}

fn aktif_cloud(row: &Value) -> i64 {
    row.get("is_aktif").and_then(Value::as_i64).filter(|n| *n == 0).unwrap_or(1)
}

/// `hr-branch/save`, `hr-division/save`, `hr-position/save`.
pub fn cloud_master_statements(
    domain: &str,
    payload: &Value,
    entity_key: &str,
) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let master = match domain {
        "hr-branch" => &MASTER_CABANG,
        "hr-division" => &MASTER_DIVISI,
        "hr-position" => &MASTER_JABATAN,
        _ => return None,
    };
    let row = if domain == "hr-division" { payload.get("divisi")? } else { payload };
    let id = id_dari(row, master.kolom_id, entity_key)?;
    let nama = nama_master(&payload_text(row, "nama")?).ok()?;
    let created = payload_text(row, "created_at");
    let mut statements = vec![if domain == "hr-branch" {
        (
            UPSERT_CABANG_SQL,
            vec![json!(id), json!(nama), json!(payload_text(row, "alamat")), json!(aktif_cloud(row)), json!(created)],
        )
    } else {
        (master.upsert_sql, vec![json!(id), json!(nama), json!(aktif_cloud(row)), json!(created)])
    }];
    match domain {
        "hr-division" => {
            if let Some(n) = payload.get("nama").filter(|n| !n.is_null()) {
                statements.push((
                    INSERT_NAMA_DIVISI_SQL,
                    vec![
                        json!(payload_text(n, "id_nama")?),
                        json!(id),
                        json!(nama_master(&payload_text(n, "nama")?).ok()?),
                        json!(payload_text(n, "created_at")),
                    ],
                ));
            }
            statements.extend(SELARASKAN_DIVISI_SQL.iter().map(|sql| (*sql, vec![json!(id)])));
        }
        "hr-position" => {
            statements.extend(SELARASKAN_JABATAN_SQL.iter().map(|sql| (*sql, vec![json!(id)])));
        }
        _ => {}
    }
    Some(statements)
}

/// `hr-contract/create`: append-only, kiriman ulang berhenti di PK. Hanya
/// bentuk dan CHECK yang diperiksa.
pub fn cloud_kontrak_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = id_dari(payload, "id_kontrak", entity_key)?;
    let jenis = payload_text(payload, "jenis")
        .filter(|j| JENIS_KONTRAK.contains(&j.as_str()) || j == "Pembatalan")?;
    let id_ref = payload_text(payload, "id_ref");
    if (jenis == "Pembatalan") != id_ref.is_some() {
        return None;
    }
    let id_karyawan = payload_text(payload, "id_karyawan")?;
    let tanggal_mulai = payload_text(payload, "tanggal_mulai").filter(|t| is_valid_date(t))?;
    Some(vec![
        (
            INSERT_KONTRAK_SQL,
            vec![
                json!(id),
                json!(id_karyawan),
                json!(jenis),
                json!(id_ref),
                json!(payload_text(payload, "nomor")),
                json!(tanggal_mulai),
                json!(payload_text(payload, "tanggal_selesai")),
                json!(payload_text(payload, "percobaan_selesai")),
                json!(payload_text(payload, "catatan")),
                json!(payload_text(payload, "dicatat_oleh").unwrap_or_else(|| "-".into())),
                json!(payload_text(payload, "created_at")),
            ],
        ),
        (JENIS_DARI_KONTRAK_SQL, vec![json!(id_karyawan)]),
    ])
}

/// Sesudah handler cloud `employee/create|update` menulis barisnya:
/// kolom organisasi (hanya bila payload membawa kuncinya), pemetaan teks
/// divisi/jabatan, dan `jenis_personil` dari kontrak.
pub fn cloud_org_karyawan_statements(row: &Value, id_unik: &str) -> Vec<(String, Vec<Value>)> {
    let mut statements = Vec::new();
    for kolom in ["id_cabang", "id_atasan"] {
        if let Some(nilai) = kunci_dibawa(row, kolom) {
            statements.push((
                format!("UPDATE master_data SET {kolom} = ?1 WHERE id_unik = ?2;"),
                vec![json!(nilai), json!(id_unik)],
            ));
        }
    }
    let id_divisi = payload_text(row, "id_divisi").unwrap_or_default();
    let id_jabatan = payload_text(row, "id_jabatan").unwrap_or_default();
    for sql in CLOUD_ORG_KARYAWAN_SQL {
        statements.push((sql.to_owned(), vec![json!(id_divisi), json!(id_jabatan), json!(id_unik)]));
    }
    for sql in CLOUD_TEKS_KARYAWAN_SQL {
        statements.push((sql.to_owned(), vec![json!(id_unik)]));
    }
    statements.push((JENIS_DARI_KONTRAK_SQL.to_owned(), vec![json!(id_unik)]));
    statements
}

// ── Khusus cloud: profil dan dokumen (Q-30, Q-45) ──────────────────────────

/// Belum dikonfigurasi dan jaringan putus (HP tanpa sinyal, fase 10) sama-sama
/// berarti "butuh koneksi"; galat jaringan mentah memuat alamat database.
/// Kodenya dipertahankan, kode lain diteruskan apa adanya.
pub(super) fn tak_terhubung(error: CommandError) -> CommandError {
    if matches!(error.code, "TURSO_NOT_CONFIGURED" | "TURSO_NETWORK_ERROR") {
        return CommandError::new(
            error.code,
            "Data ini hanya tersimpan di database pusat dan butuh koneksi ke database.",
        );
    }
    error
}

pub(super) async fn siap(turso: &TursoClient) -> Result<(), CommandError> {
    turso.ensure_schema_current().await.map_err(tak_terhubung)
}

pub(super) async fn objek(turso: &TursoClient, sql: &str, args: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, CommandError> {
    Ok(turso.query_one(sql, args).await.map_err(tak_terhubung)?.to_objects())
}

async fn karyawan_ada(turso: &TursoClient, id: &str) -> Result<(), CommandError> {
    if objek(turso, "SELECT 1 AS ada FROM master_data WHERE id_unik = ?1;", vec![json!(id)])
        .await?
        .is_empty()
    {
        return Err(invalid("Karyawan tidak ditemukan."));
    }
    Ok(())
}

/// Profil satu karyawan; hanya kelompok yang izinnya dipegang.
pub async fn profil(turso: &TursoClient, id: &str, pribadi: bool, keuangan: bool) -> Result<Value, CommandError> {
    siap(turso).await?;
    let baris = objek(turso, "SELECT * FROM hr_profil WHERE id_karyawan = ?1;", vec![json!(id)])
        .await?
        .into_iter()
        .next()
        .unwrap_or_default();
    let ambil = |kolom: &[&str], jejak: [&str; 2]| -> Value {
        let isi: Map<String, Value> = kolom
            .iter()
            .chain(jejak.iter())
            .map(|k| ((*k).to_owned(), baris.get(*k).cloned().unwrap_or(Value::Null)))
            .collect();
        Value::Object(isi)
    };
    Ok(json!({
        "id_karyawan": id,
        "pribadi": if pribadi { ambil(&KOLOM_PRIBADI, ["pribadi_diubah_oleh", "pribadi_diubah_pada"]) } else { Value::Null },
        "keuangan": if keuangan { ambil(&KOLOM_KEUANGAN, ["keuangan_diubah_oleh", "keuangan_diubah_pada"]) } else { Value::Null },
    }))
}

fn sql_simpan_profil(kolom: &[&str], jejak: &str) -> String {
    let semua: Vec<String> = kolom
        .iter()
        .map(|k| (*k).to_owned())
        .chain([format!("{jejak}_diubah_oleh"), format!("{jejak}_diubah_pada")])
        .collect();
    let tanda: Vec<String> = (2..=kolom.len() + 2).map(|i| format!("?{i}")).collect();
    let set: Vec<String> = semua.iter().map(|k| format!("{k} = excluded.{k}")).collect();
    format!(
        "INSERT INTO hr_profil (id_karyawan, {}) VALUES (?1, {}, datetime('now')) ON CONFLICT(id_karyawan) DO UPDATE SET {};",
        semua.join(", "),
        tanda.join(", "),
        set.join(", ")
    )
}

/// Simpan kelompok `pribadi` atau `keuangan` profil.
pub async fn simpan_profil(
    turso: &TursoClient,
    id: &str,
    kelompok: &str,
    draft: &Value,
    oleh: &str,
) -> Result<Value, CommandError> {
    let (nilai, kolom) = match kelompok {
        "pribadi" => (validasi_pribadi(draft).map_err(invalid)?, &KOLOM_PRIBADI[..]),
        _ => (validasi_keuangan(draft).map_err(invalid)?, &KOLOM_KEUANGAN[..]),
    };
    siap(turso).await?;
    karyawan_ada(turso, id).await?;
    let mut args = vec![json!(id)];
    args.extend(nilai.into_iter().map(|v| json!(v)));
    args.push(json!(oleh));
    turso
        .query_one(sql_simpan_profil(kolom, kelompok), args)
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

/// Jenis dokumen (Organisasi dan form dokumen).
pub async fn jenis_dokumen(turso: &TursoClient) -> Result<Value, CommandError> {
    siap(turso).await?;
    Ok(json!(objek(turso, "SELECT * FROM hr_dokumen_jenis ORDER BY is_aktif DESC, nama;", vec![]).await?))
}

/// Simpan jenis dokumen (nama unik di aplikasi, tanpa hapus).
pub async fn simpan_jenis_dokumen(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    let nama = nama_master(payload_text(draft, "nama").as_deref().unwrap_or("")).map_err(invalid)?;
    let is_aktif = aktif_dari(draft)?;
    let id_masuk = payload_text(draft, "id_jenis");
    siap(turso).await?;
    let lain: Vec<(String, String)> = objek(turso, "SELECT id_jenis, nama FROM hr_dokumen_jenis;", vec![])
        .await?
        .into_iter()
        .map(|b| {
            (
                b.get("id_jenis").and_then(Value::as_str).unwrap_or("").to_owned(),
                b.get("nama").and_then(Value::as_str).unwrap_or("").to_owned(),
            )
        })
        .collect();
    if let Some(id) = &id_masuk {
        if !lain.iter().any(|(i, _)| i == id) {
            return Err(invalid("Jenis dokumen tidak ditemukan."));
        }
    }
    if nama_bentrok(id_masuk.as_deref(), &nama, &lain) {
        return Err(invalid(format!("Jenis dokumen \"{nama}\" sudah ada.")));
    }
    let id = id_masuk.unwrap_or_else(|| new_hex_id("dok-"));
    turso
        .query_one(
            "INSERT INTO hr_dokumen_jenis (id_jenis, nama, is_aktif) VALUES (?1, ?2, ?3)
             ON CONFLICT(id_jenis) DO UPDATE SET nama = excluded.nama, is_aktif = excluded.is_aktif, updated_at = datetime('now');",
            vec![json!(id), json!(nama), json!(is_aktif)],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_jenis": id }))
}

/// Dokumen satu karyawan beserta daftar berkasnya, tanpa isi berkas.
pub async fn dokumen(turso: &TursoClient, id_karyawan: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let mut daftar = objek(
        turso,
        "SELECT d.*, j.nama AS nama_jenis FROM hr_dokumen d LEFT JOIN hr_dokumen_jenis j ON j.id_jenis = d.id_jenis WHERE d.id_karyawan = ?1 ORDER BY j.nama, d.created_at;",
        vec![json!(id_karyawan)],
    )
    .await?;
    let berkas = objek(
        turso,
        "SELECT b.id_berkas, b.id_dokumen, b.urutan, b.nama_berkas, b.mime_type, length(b.data_base64) AS panjang FROM hr_dokumen_berkas b JOIN hr_dokumen d ON d.id_dokumen = b.id_dokumen WHERE d.id_karyawan = ?1 ORDER BY b.id_dokumen, b.urutan;",
        vec![json!(id_karyawan)],
    )
    .await?;
    for d in &mut daftar {
        let id = d.get("id_dokumen").cloned().unwrap_or(Value::Null);
        d.insert(
            "berkas".into(),
            json!(berkas.iter().filter(|b| b.get("id_dokumen") == Some(&id)).collect::<Vec<_>>()),
        );
    }
    Ok(json!({ "dokumen": daftar, "jenis": jenis_dokumen(turso).await? }))
}

/// Simpan data dokumen (baru atau ubah).
pub async fn simpan_dokumen(turso: &TursoClient, draft: &Value, oleh: &str) -> Result<Value, CommandError> {
    let sah = validasi_dokumen(draft).map_err(invalid)?;
    siap(turso).await?;
    karyawan_ada(turso, &sah.id_karyawan).await?;
    let lama = match &sah.id_dokumen {
        Some(id) => Some(
            objek(turso, "SELECT id_jenis, id_karyawan FROM hr_dokumen WHERE id_dokumen = ?1;", vec![json!(id)])
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| invalid("Dokumen tidak ditemukan."))?,
        ),
        None => None,
    };
    if lama
        .as_ref()
        .is_some_and(|l| l.get("id_karyawan").and_then(Value::as_str) != Some(sah.id_karyawan.as_str()))
    {
        return Err(invalid("Dokumen tidak ditemukan."));
    }
    let jenis = objek(turso, "SELECT is_aktif FROM hr_dokumen_jenis WHERE id_jenis = ?1;", vec![json!(sah.id_jenis)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Jenis dokumen tidak ditemukan."))?;
    let jenis_lama = lama
        .as_ref()
        .and_then(|l| l.get("id_jenis").and_then(Value::as_str))
        == Some(sah.id_jenis.as_str());
    if jenis.get("is_aktif").and_then(Value::as_i64) != Some(1) && !jenis_lama {
        return Err(invalid("Jenis dokumen sudah nonaktif."));
    }
    let id = sah.id_dokumen.clone().unwrap_or_else(|| new_hex_id("hd-"));
    turso
        .query_one(
            SIMPAN_DOKUMEN_SQL,
            vec![
                json!(id),
                json!(sah.id_karyawan),
                json!(sah.id_jenis),
                json!(sah.nomor),
                json!(sah.tanggal_terbit),
                json!(sah.tanggal_kedaluwarsa),
                json!(sah.catatan),
                json!(oleh),
            ],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_dokumen": id }))
}

/// Hapus dokumen beserta berkasnya dalam satu transaksi, dan lepaskan
/// tautan sertifikat peserta pelatihan. Khusus cloud, jadi tidak ada
/// perangkat yang bisa menghidupkannya kembali.
pub async fn hapus_dokumen(turso: &TursoClient, id: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    turso
        .execute_atomic(HAPUS_DOKUMEN_SQL.iter().map(|sql| Statement::new(*sql, vec![json!(id)])).collect())
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

/// Tambah satu berkas (maks `MAKS_BERKAS_PER_DOKUMEN`), urutan kosong terkecil.
pub async fn tambah_berkas(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    let id_dokumen = payload_text(draft, "id_dokumen").ok_or_else(|| invalid("Dokumen tidak ditemukan."))?;
    let mime = payload_text(draft, "mime_type").unwrap_or_default();
    let data = draft.get("data_base64").and_then(Value::as_str).unwrap_or("");
    validasi_berkas(&mime, data).map_err(invalid)?;
    let nama_berkas = teks_terbatas(payload_text(draft, "nama_berkas"), "Nama berkas", MAKS_TEKS).map_err(invalid)?;
    siap(turso).await?;
    if objek(turso, "SELECT 1 AS ada FROM hr_dokumen WHERE id_dokumen = ?1;", vec![json!(id_dokumen)])
        .await?
        .is_empty()
    {
        return Err(invalid("Dokumen tidak ditemukan."));
    }
    let terpakai: HashSet<i64> = objek(turso, "SELECT urutan FROM hr_dokumen_berkas WHERE id_dokumen = ?1;", vec![json!(id_dokumen)])
        .await?
        .iter()
        .filter_map(|b| b.get("urutan").and_then(Value::as_i64))
        .collect();
    let urutan = (1..=MAKS_BERKAS_PER_DOKUMEN)
        .find(|u| !terpakai.contains(u))
        .ok_or_else(|| invalid(format!("Satu dokumen maksimal {MAKS_BERKAS_PER_DOKUMEN} berkas.")))?;
    let id = new_hex_id("hb-");
    turso
        .query_one(
            INSERT_BERKAS_DOKUMEN_SQL,
            vec![json!(id), json!(id_dokumen), json!(urutan), json!(nama_berkas), json!(mime), json!(data)],
        )
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_berkas": id }))
}

/// Isi satu berkas.
pub async fn berkas(turso: &TursoClient, id: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    objek(
        turso,
        "SELECT id_berkas, nama_berkas, mime_type, data_base64 FROM hr_dokumen_berkas WHERE id_berkas = ?1;",
        vec![json!(id)],
    )
    .await?
    .into_iter()
    .next()
    .map(|b| json!(b))
    .ok_or_else(|| invalid("Berkas tidak ditemukan."))
}

pub async fn hapus_berkas(turso: &TursoClient, id: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    turso
        .query_one("DELETE FROM hr_dokumen_berkas WHERE id_berkas = ?1;", vec![json!(id)])
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(id: &str, jenis: &str, mulai: &str, selesai: Option<&str>) -> Kontrak {
        Kontrak {
            id_kontrak: id.into(),
            jenis: jenis.into(),
            id_ref: None,
            tanggal_mulai: mulai.into(),
            tanggal_selesai: selesai.map(str::to_owned),
            percobaan_selesai: None,
        }
    }

    fn batal(id_ref: &str) -> Kontrak {
        Kontrak {
            id_kontrak: format!("batal-{id_ref}"),
            jenis: "Pembatalan".into(),
            id_ref: Some(id_ref.into()),
            tanggal_mulai: "2026-01-01".into(),
            tanggal_selesai: None,
            percobaan_selesai: None,
        }
    }

    #[test]
    fn tak_terhubung_menyamakan_pesan_tanpa_koneksi() {
        let pesan = "Data ini hanya tersimpan di database pusat dan butuh koneksi ke database.";
        let belum = tak_terhubung(CommandError::new("TURSO_NOT_CONFIGURED", "x"));
        let putus = tak_terhubung(CommandError::new(
            "TURSO_NETWORK_ERROR",
            "Gagal menghubungi database Turso: error sending request for url (https://db.example.turso.io/v2/pipeline)",
        ));
        assert_eq!((belum.code, belum.message.as_str()), ("TURSO_NOT_CONFIGURED", pesan));
        assert_eq!((putus.code, putus.message.as_str()), ("TURSO_NETWORK_ERROR", pesan));
        let lain = tak_terhubung(CommandError::new("FORBIDDEN", "Tidak berwenang."));
        assert_eq!((lain.code, lain.message.as_str()), ("FORBIDDEN", "Tidak berwenang."));
    }

    // Vektor yang sama diuji di `validations/hris.test.ts`.

    #[test]
    fn nomor_identitas_dan_nama() {
        assert_eq!(nomor_identitas(Some("3201.0101-0101 0001"), "NIK", &[16]), Ok(Some("3201010101010001".into())));
        assert_eq!(nomor_identitas(Some("  "), "NIK", &[16]), Ok(None));
        assert_eq!(nomor_identitas(Some("12A4"), "NIK", &[16]), Err("NIK hanya boleh berisi angka.".into()));
        assert_eq!(nomor_identitas(Some("123"), "NIK", &[16]), Err("NIK harus 16 digit.".into()));
        assert_eq!(nomor_identitas(Some("12.345.678.9-012.345"), "NPWP", &[15, 16]), Ok(Some("123456789012345".into())));
        assert_eq!(nomor_identitas(Some("1234"), "NPWP", &[15, 16]), Err("NPWP harus 15 atau 16 digit.".into()));
        assert_eq!(
            nomor_identitas(Some("1234"), "Nomor rekening", &PANJANG_REKENING),
            Err("Nomor rekening harus 5–20 digit.".into())
        );
        assert_eq!(nama_master("  Gudang   Utama "), Ok("Gudang Utama".into()));
        assert_eq!(nama_master(" "), Err("Nama wajib diisi.".into()));
        assert_eq!(nama_master(&"a".repeat(101)), Err("Nama maksimal 100 karakter.".into()));
        assert_eq!(kunci_nama(" GUDANG  utama"), "gudang utama");
        let lain = vec![("d1".to_owned(), "Gudang".to_owned()), ("d2".to_owned(), "Kantor".to_owned())];
        assert!(nama_bentrok(Some("d2"), "gudang", &lain));
        assert!(!nama_bentrok(Some("d1"), "GUDANG", &lain));
        assert!(!nama_bentrok(None, "Produksi", &lain));
    }

    #[test]
    fn profil_pribadi_dan_keuangan() {
        let pribadi = validasi_pribadi(&json!({
            "nik": "3201010101010001", "agama": "Islam", "status_nikah": "Kawin",
            "pendidikan": "S1", "tanggal_lahir": "1990-02-28", "darurat_hp": "0812-3456-7890",
            "alamat_ktp": null
        }))
        .unwrap();
        assert_eq!(pribadi[0].as_deref(), Some("3201010101010001"));
        assert_eq!(pribadi[11].as_deref(), Some("+6281234567890"));
        assert_eq!(pribadi[6], None);
        assert_eq!(validasi_pribadi(&json!({ "agama": "Lain" })), Err("Agama tidak dikenal.".into()));
        assert_eq!(validasi_pribadi(&json!({ "tanggal_lahir": "1990-02-30" })), Err("Tanggal lahir tidak valid.".into()));
        assert_eq!(validasi_pribadi(&json!({ "gaji": "1" })), Err("Isian 'gaji' tidak dikenal.".into()));
        assert_eq!(validasi_pribadi(&json!({ "darurat_hp": "12" })), Err("Nomor HP kontak darurat tidak valid.".into()));
        let keuangan = validasi_keuangan(&json!({ "npwp": "12.345.678.9-012.345", "no_rekening": "0123 4567 89" })).unwrap();
        assert_eq!(keuangan[3].as_deref(), Some("123456789012345"));
        assert_eq!(keuangan[1].as_deref(), Some("0123456789"));
        assert_eq!(validasi_keuangan(&json!({ "nik": "1" })), Err("Isian 'nik' tidak dikenal.".into()));
    }

    #[test]
    fn validasi_kontrak_kelengkapan() {
        let dasar = |jenis: &str, selesai: Value, coba: Value| {
            validasi_kontrak(&json!({
                "id_karyawan": "K1", "jenis": jenis, "tanggal_mulai": "2026-01-01",
                "tanggal_selesai": selesai, "percobaan_selesai": coba
            }))
        };
        assert!(dasar("PKWTT", Value::Null, json!("2026-03-31")).is_ok());
        assert_eq!(dasar("PKWT", Value::Null, Value::Null), Err("Kontrak PKWT dan Magang wajib punya tanggal selesai.".into()));
        assert_eq!(dasar("PKWTT", json!("2026-12-31"), Value::Null), Err("Kontrak PKWTT tidak punya tanggal selesai.".into()));
        assert_eq!(dasar("PKWT", json!("2025-12-31"), Value::Null), Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into()));
        assert_eq!(dasar("PKWT", json!("2026-12-31"), json!("2026-02-01")), Err("Masa percobaan hanya untuk PKWTT.".into()));
        assert_eq!(dasar("Borongan", Value::Null, Value::Null), Err("Jenis kontrak tidak dikenal.".into()));
        assert!(dasar("Harian Lepas", Value::Null, Value::Null).is_ok());
    }

    #[test]
    fn status_kerja_turunan() {
        let kontrak = vec![
            k("a", "PKWT", "2025-01-01", Some("2025-12-31")),
            k("b", "PKWT", "2026-01-01", Some("2026-06-30")),
            batal("b"),
        ];
        assert_eq!(status_kerja(&kontrak, "2026-03-01")["keadaan"], "Berakhir");
        assert_eq!(status_kerja(&kontrak, "2025-06-01")["keadaan"], "Berlaku");
        assert_eq!(status_kerja(&kontrak, "2024-06-01")["keadaan"], "Tanpa kontrak");
        let mut tetap = k("c", "PKWTT", "2026-02-01", None);
        tetap.percobaan_selesai = Some("2026-04-30".into());
        let kontrak = vec![k("a", "PKWT", "2025-01-01", Some("2025-12-31")), tetap];
        let s = status_kerja(&kontrak, "2026-03-01");
        assert_eq!((s["jenis"].as_str(), s["percobaan_sampai"].as_str()), (Some("PKWTT"), Some("2026-04-30")));
        assert_eq!(status_kerja(&kontrak, "2026-05-01")["percobaan_sampai"], Value::Null);
    }

    #[test]
    fn kalender_dan_tanda_kontrak() {
        assert_eq!(tambah_bulan("2026-01-31", 1).as_deref(), Some("2026-02-28"));
        assert_eq!(tambah_bulan("2024-01-31", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(tambah_bulan("2026-03-15", -3).as_deref(), Some("2025-12-15"));
        assert_eq!(nomor_hari("1970-01-01"), Some(0));
        assert_eq!(nomor_hari("2026-11-10"), Some(20_767));
        assert_eq!(
            bulan_penuh_terakhir("2026-03-10", 3),
            vec![
                ("2025-12-01".to_owned(), "2025-12-31".to_owned()),
                ("2026-01-01".to_owned(), "2026-01-31".to_owned()),
                ("2026-02-01".to_owned(), "2026-02-28".to_owned()),
            ]
        );
        let aturan = PengaturanKontrak::default();
        let mut coba = k("c", "PKWTT", "2026-01-01", None);
        coba.percobaan_selesai = Some("2026-04-02".into());
        assert_eq!(tanda_kontrak(&[coba.clone()], &aturan, "2026-02-01", &[]), vec!["percobaan_lewat"]);
        coba.percobaan_selesai = Some("2026-04-01".into());
        assert!(tanda_kontrak(&[coba], &aturan, "2026-02-01", &[]).is_empty());
        // Tiga PKWT 2 tahun berturut-turut = 6 tahun > 5 tahun.
        let pkwt = vec![
            k("p1", "PKWT", "2020-01-01", Some("2021-12-31")),
            k("p2", "PKWT", "2022-01-01", Some("2023-12-31")),
            k("p3", "PKWT", "2024-01-01", Some("2025-12-31")),
        ];
        assert_eq!(tanda_kontrak(&pkwt, &aturan, "2025-06-01", &[]), vec!["pkwt_lewat"]);
        // PKWTT di tengah memutus rangkaian.
        let putus = vec![pkwt[0].clone(), k("t", "PKWTT", "2022-01-01", None), pkwt[2].clone()];
        assert!(tanda_kontrak(&putus, &aturan, "2025-06-01", &[]).is_empty());
        let harian = vec![k("h", "Harian Lepas", "2025-01-01", None)];
        assert_eq!(tanda_kontrak(&harian, &aturan, "2026-03-10", &[21, 22, 21]), vec!["harian_perlu_pkwtt"]);
        assert!(tanda_kontrak(&harian, &aturan, "2026-03-10", &[21, 20, 25]).is_empty());
        assert!(tanda_kontrak(&harian, &aturan, "2026-03-10", &[25, 25]).is_empty());
    }

    #[test]
    fn pengaturan_kontrak() {
        let peta: HashMap<String, String> = [("hr_pkwt_maks_bulan".to_owned(), "36".to_owned()), ("hr_harian_batas_hari".to_owned(), "99".to_owned())].into();
        let p = PengaturanKontrak::dari_peta(&peta);
        assert_eq!((p.pkwt_maks_bulan, p.harian_batas_hari), (36, 21));
        // Bawaan = draf sah; setiap kasus mengubah satu atau dua angka.
        let bawaan = PengaturanKontrak::default().ke_json();
        let dengan = |ubah: &[(&str, i64)]| {
            let mut draf = bawaan.clone();
            for (kunci, nilai) in ubah {
                draf[*kunci] = json!(nilai);
            }
            validasi_pengaturan(&draf)
        };
        assert_eq!(dengan(&[]).map(|v| v.len()), Ok(12));
        assert_eq!(
            dengan(&[("hr_percobaan_maks_bulan", 0)]),
            Err("Masa percobaan maksimal harus bilangan bulat 1–12.".into())
        );
        assert_eq!(
            dengan(&[("hr_pelamar_retensi_bulan", 61)]),
            Err("Masa simpan data pelamar (bulan) harus bilangan bulat 1–60.".into())
        );
        let retensi: HashMap<String, String> = [("hr_pelamar_retensi_bulan".to_owned(), "0".to_owned())].into();
        assert_eq!(PengaturanKontrak::dari_peta(&retensi).pelamar_retensi_bulan, 12);

        // Angka pengingat (§24.3): bawaan, diubah, batas, dan dekat < jauh.
        assert_eq!(
            bawaan,
            json!({
                "hr_percobaan_maks_bulan": 3, "hr_pkwt_maks_bulan": 60, "hr_harian_batas_hari": 21, "hr_harian_batas_bulan": 3, "hr_sp_masa_bulan": 6,
                "hr_pelamar_retensi_bulan": 12, "hr_ingat_kontrak_jauh": 30, "hr_ingat_kontrak_dekat": 7, "hr_ingat_percobaan": 7,
                "hr_ingat_dokumen": 30, "hr_ingat_menunggu": 2, "hr_ingat_jam": 7
            })
        );
        let diubah = dengan(&[("hr_ingat_kontrak_jauh", 14), ("hr_ingat_kontrak_dekat", 3), ("hr_ingat_jam", 0)]).unwrap();
        assert!(diubah.contains(&("hr_ingat_kontrak_jauh", 14)) && diubah.contains(&("hr_ingat_jam", 0)));
        assert_eq!(
            dengan(&[("hr_ingat_kontrak_jauh", 7)]),
            Err("Pengingat pertama PKWT berakhir (hari sebelumnya) harus bilangan bulat 8–90.".into())
        );
        assert_eq!(
            dengan(&[("hr_ingat_jam", 24)]),
            Err("Jam mulai pengingat HR (WIB) harus bilangan bulat 0–23.".into())
        );
        assert_eq!(
            dengan(&[("hr_ingat_menunggu", 15)]),
            Err("Pengajuan dianggap lama menunggu (hari) harus bilangan bulat 1–14.".into())
        );
        assert_eq!(dengan(&[("hr_ingat_kontrak_jauh", 10), ("hr_ingat_kontrak_dekat", 10)]), Err(PESAN_INGAT_KONTRAK.into()));
        assert_eq!(dengan(&[("hr_ingat_kontrak_jauh", 10), ("hr_ingat_kontrak_dekat", 20)]), Err(PESAN_INGAT_KONTRAK.into()));
        assert!(dengan(&[("hr_ingat_kontrak_jauh", 10), ("hr_ingat_kontrak_dekat", 9)]).is_ok());
        // Tersimpan rusak = bawaan per angka; aturan silang hanya saat disimpan.
        let rusak: HashMap<String, String> = [
            ("hr_ingat_kontrak_jauh".to_owned(), "x".to_owned()),
            ("hr_ingat_kontrak_dekat".to_owned(), " 20 ".to_owned()),
            ("hr_ingat_jam".to_owned(), "0".to_owned()),
            ("hr_ingat_menunggu".to_owned(), "-1".to_owned()),
        ]
        .into();
        let p = PengaturanKontrak::dari_peta(&rusak);
        assert_eq!((p.ingat_kontrak_jauh, p.ingat_kontrak_dekat, p.ingat_jam, p.ingat_menunggu), (30, 20, 0, 2));
    }

    /// Fragmen `ingat_*_sql!` = batas `BATAS_PENGATURAN` + bawaan, dan
    /// dijalankan SQLite: kosong, rusak, atau di luar batas = bawaan.
    #[test]
    fn fragmen_ingat_sql() {
        let b = PengaturanKontrak::default();
        let fragmen = [
            (ingat_kontrak_jauh_sql!(), KUNCI_INGAT_KONTRAK_JAUH, b.ingat_kontrak_jauh),
            (ingat_kontrak_dekat_sql!(), KUNCI_INGAT_KONTRAK_DEKAT, b.ingat_kontrak_dekat),
            (ingat_percobaan_sql!(), KUNCI_INGAT_PERCOBAAN, b.ingat_percobaan),
            (ingat_dokumen_sql!(), KUNCI_INGAT_DOKUMEN, b.ingat_dokumen),
            (ingat_menunggu_sql!(), KUNCI_INGAT_MENUNGGU, b.ingat_menunggu),
            (ingat_jam_sql!(), KUNCI_INGAT_JAM, b.ingat_jam),
        ];
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE setting_gex_system (key TEXT PRIMARY KEY, value TEXT NOT NULL);", []).unwrap();
        for (sql, kunci, bawaan) in fragmen {
            let (_, _, min, maks) = BATAS_PENGATURAN.iter().find(|(k, ..)| *k == kunci).copied().unwrap();
            assert_eq!(
                sql,
                format!("COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = '{kunci}' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN {min} AND {maks}), {bawaan})")
            );
            let baca = |nilai: Option<String>| -> i64 {
                conn.execute("DELETE FROM setting_gex_system;", []).unwrap();
                if let Some(v) = nilai {
                    conn.execute("INSERT INTO setting_gex_system VALUES (?1, ?2);", params![kunci, v]).unwrap();
                }
                conn.query_row(&format!("SELECT {sql};"), [], |r| r.get(0)).unwrap()
            };
            let tengah = (min + maks) / 2;
            assert_eq!(
                [
                    baca(None),
                    baca(Some(format!(" {tengah} "))),
                    baca(Some(min.to_string())),
                    baca(Some(maks.to_string())),
                    baca(Some((maks + 1).to_string())),
                    baca(Some("-1".into())),
                    baca(Some("7x".into())),
                    baca(Some(String::new())),
                ],
                [bawaan, tengah, min, maks, bawaan, bawaan, bawaan, bawaan],
                "{kunci}"
            );
        }
    }

    #[test]
    fn atasan_dan_siklus() {
        let peta: HashMap<String, Option<String>> = [
            ("A".to_owned(), None),
            ("B".to_owned(), Some("A".to_owned())),
            ("C".to_owned(), Some("B".to_owned())),
        ]
        .into();
        assert_eq!(periksa_atasan("C", "A", &peta), Ok(()));
        assert_eq!(periksa_atasan("A", "A", &peta), Err("Atasan tidak boleh dirinya sendiri.".into()));
        assert_eq!(periksa_atasan("A", "C", &peta), Err("Pilihan atasan membentuk lingkaran atasan.".into()));
        assert_eq!(periksa_atasan("A", "Z", &peta), Err("Atasan tidak ditemukan.".into()));
        let siklus: HashMap<String, Option<String>> = [
            ("A".to_owned(), Some("B".to_owned())),
            ("B".to_owned(), Some("A".to_owned())),
            ("C".to_owned(), Some("A".to_owned())),
        ]
        .into();
        let mut hasil: Vec<String> = dalam_siklus_atasan(&siklus).into_iter().collect();
        hasil.sort();
        assert_eq!(hasil, vec!["A", "B"]);
    }

    #[test]
    fn berkas_dan_dokumen() {
        let pdf = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7 isi");
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]);
        assert_eq!(validasi_berkas("application/pdf", &pdf), Ok(()));
        assert_eq!(validasi_berkas("image/png", &png), Ok(()));
        assert_eq!(validasi_berkas("image/jpeg", &pdf), Err("Isi berkas tidak cocok dengan jenisnya.".into()));
        assert_eq!(validasi_berkas("image/bmp", &pdf), Err("Jenis berkas harus JPEG, PNG, WEBP, atau PDF.".into()));
        assert_eq!(validasi_berkas("application/pdf", "@@@@"), Err("Isi berkas tidak terbaca.".into()));
        assert_eq!(validasi_berkas("application/pdf", &"A".repeat(MAKS_BERKAS_BASE64 + 4)), Err("Berkas maksimal 1 MB.".into()));
        assert_eq!(
            validasi_dokumen(&json!({ "id_karyawan": "K1", "id_jenis": "dok-ktp", "tanggal_terbit": "2026-01-02", "tanggal_kedaluwarsa": "2026-01-01" })),
            Err("Tanggal kedaluwarsa tidak boleh sebelum tanggal terbit.".into())
        );
        assert_eq!(validasi_dokumen(&json!({ "id_karyawan": "K1" })), Err("Jenis dokumen wajib dipilih.".into()));
    }

    #[test]
    fn sql_kembar_dan_handler_cloud() {
        assert!(divisi_kini("a.kelas_divisi").ends_with(", a.kelas_divisi)"));
        assert!(!divisi_kini("x").contains("{kolom}"));
        let statements = cloud_master_statements(
            "hr-division",
            &json!({ "divisi": { "id_divisi": "dv-1", "nama": "Logistik", "is_aktif": 1 }, "nama": { "id_nama": "dn-1", "nama": "Logistik" } }),
            "dv-1",
        )
        .unwrap();
        assert_eq!(statements.len(), 2 + SELARASKAN_DIVISI_SQL.len());
        assert!(cloud_master_statements("hr-division", &json!({ "divisi": { "nama": " " } }), "dv-1").is_none());
        assert!(cloud_kontrak_statements(&json!({ "id_kontrak": "x", "jenis": "Pembatalan", "id_karyawan": "K1", "tanggal_mulai": "2026-01-01" }), "x").is_none());
        let org = cloud_org_karyawan_statements(&json!({ "id_unik": "K1", "id_cabang": "" }), "K1");
        assert_eq!(org[0].1[0], Value::Null);
        assert_eq!(org.len(), 1 + CLOUD_ORG_KARYAWAN_SQL.len() + CLOUD_TEKS_KARYAWAN_SQL.len() + 1);
    }
}
