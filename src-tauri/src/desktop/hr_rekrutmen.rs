//! HRIS fase 7 (skema v42): rekrutmen — lowongan, pelamar, tahap seleksi,
//! berkas lamaran, jadikan karyawan, dan retensi data pelamar.
//!
//! `hr_lowongan`, `hr_pelamar`, `hr_pelamar_tahap`, dan `hr_pelamar_berkas`
//! KHUSUS CLOUD (Q-86): data orang yang bukan karyawan wajib benar-benar
//! hilang saat masa simpannya habis (Q-33), jadi tidak pernah tersalin ke
//! SQLite perangkat, tanpa outbox dan tanpa snapshot. Status lowongan dan
//! pelamar tidak disimpan; tutup, pembatalan tahap, dan klaim "Jadikan
//! karyawan" adalah kolom yang diisi sekali.
//!
//! Aturan murni, pesan galat, dan SQL cermin `validations/hr-rekrutmen.ts`,
//! diuji dengan vektor yang sama (`prd-hris.md` §22.3–§22.6).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::hr_keluar::{angka_baris, hari_ini_cloud, teks_baris, Baris};
use super::hris::{self, kunci_nama, objek, siap, tak_terhubung};
use super::inventory::{invalid, is_valid_date, new_hex_id, payload_text};
use super::models::{CommandError, OperatorUser};
use super::{config::DesktopState, operational, storage, sync};
use super::turso::{
    is_valid_operator_email, is_valid_operator_phone, normalize_operator_email, normalize_operator_phone, Statement,
    TursoClient,
};

// ── Konstanta ──────────────────────────────────────────────────────────────

pub const MAKS_JUDUL: usize = 100;
pub const MAKS_JUMLAH: i64 = 999;
pub const MAKS_KETERANGAN: usize = 2000;
pub const MIN_NAMA_PELAMAR: usize = 2;
/// Sama dengan `hris::MAKS_TEKS`: alamat pelamar menjadi isian awal
/// `hr_profil.alamat_domisili` saat dijadikan karyawan (Q-94).
pub const MAKS_ALAMAT: usize = hris::MAKS_TEKS;
pub const MAKS_SUMBER: usize = 100;
pub const MAKS_CATATAN_PELAMAR: usize = 2000;
pub const MAKS_CATATAN_TAHAP: usize = 1000;
pub const MAKS_BERKAS_PER_PELAMAR: i64 = 3;

/// Tahap yang masih berjalan; boleh berpindah ke tahap mana pun (Q-91).
pub const TAHAP_PROSES: [&str; 5] = ["Lamaran", "Seleksi Berkas", "Wawancara", "Tes", "Penawaran"];
/// Tahap akhir: sesudahnya tidak ada tahap baru.
pub const TAHAP_AKHIR: [&str; 3] = ["Diterima", "Ditolak", "Mundur"];
/// Tahap yang catatannya wajib diisi.
pub const TAHAP_BERCATATAN: [&str; 2] = ["Ditolak", "Mundur"];

pub const IZIN_VIEW: &str = "hr.recruit.view";
pub const IZIN_MANAGE: &str = "hr.recruit.manage";
pub const IZIN_DELETE: &str = "hr.recruit.delete";
/// Jadikan karyawan menulis data pelamar, karyawan, dan kontrak sekaligus,
/// jadi wajib ketiganya (Q-100, aturan 44); tanpa izin baru.
pub const IZIN_JADIKAN_KARYAWAN: [&str; 3] = [IZIN_MANAGE, "employees.manage", "hr.contract.manage"];

pub const PESAN_SUDAH_KARYAWAN: &str =
    "Pelamar ini sudah dijadikan karyawan; datanya tidak bisa diubah.";

// ── SQL kembar (diperiksa harfiah oleh `hr-rekrutmen.test.ts`) ─────────────

// Tanggal tutup efektif lowongan beralias `l` (§22.3, tanggal WIB jam
// database): yang lebih awal di antara tanggal tombol Tutup ditekan dan
// `tanggal_tutup` yang sudah lewat; NULL selama lowongan belum Ditutup.
// Cermin `TUTUP_EFEKTIF_SQL`.
macro_rules! tutup_efektif_sql {
    () => {
        "(CASE WHEN l.ditutup_pada IS NULL AND (l.tanggal_tutup IS NULL OR l.tanggal_tutup >= date('now', '+7 hours')) THEN NULL WHEN l.ditutup_pada IS NULL THEN l.tanggal_tutup WHEN l.tanggal_tutup IS NOT NULL AND l.tanggal_tutup < date('now', '+7 hours') AND l.tanggal_tutup < date(l.ditutup_pada, '+7 hours') THEN l.tanggal_tutup ELSE date(l.ditutup_pada, '+7 hours') END)"
    };
}

// Masa simpan data pelamar dalam bulan; kosong atau di luar 1–60 = 12, sama
// dengan `PengaturanKontrak::dari_peta`. Cermin `RETENSI_BULAN_SQL`.
macro_rules! retensi_bulan_sql {
    () => {
        "COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = 'hr_pelamar_retensi_bulan' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN 1 AND 60), 12)"
    };
}

// Tanggal data pelamar lowongan `l` dihapus: hari sesudah tutup efektif +
// masa simpan, sehingga "dihapus pada" yang tampil sama persis dengan yang
// dihapus `HAPUS_PELAMAR_LAMA_SQL`. Bulan dihitung SQLite (`+N months`), bukan
// `hris::tambah_bulan`, karena hanya SQL ini yang menentukan penghapusan.
macro_rules! tanggal_hapus_sql {
    () => {
        concat!("date(", tutup_efektif_sql!(), ", '+' || ", retensi_bulan_sql!(), " || ' months', '+1 day')")
    };
}

// Pelamar beralias `p` yang dihapus: belum dijadikan karyawan, dan `?1` =
// id pelamar itu (Hapus lebih cepat, kapan saja) atau `?1` NULL dan masa
// simpan lowongannya sudah habis (retensi, §22.6).
macro_rules! pelamar_dihapus_sql {
    () => {
        concat!(
            "p.id_karyawan IS NULL AND (p.id_pelamar = ?1 OR (?1 IS NULL AND EXISTS (SELECT 1 FROM hr_lowongan l WHERE l.id_lowongan = p.id_lowongan AND ",
            tutup_efektif_sql!(),
            " IS NOT NULL AND ",
            tanggal_hapus_sql!(),
            " <= date('now', '+7 hours'))))"
        )
    };
}

// Ekspresi di atas dipakai lewat makro; konstanta ini hanya untuk tes yang
// membuktikan SQL sama dengan aturan murni.
#[cfg(test)]
pub const TUTUP_EFEKTIF_SQL: &str = tutup_efektif_sql!();
#[cfg(test)]
pub const RETENSI_BULAN_SQL: &str = retensi_bulan_sql!();
pub const PELAMAR_DIHAPUS_SQL: &str = pelamar_dihapus_sql!();

// Tahap berlaku pelamar beralias `p` (`status_pelamar`). Cermin `STATUS_PELAMAR_SQL`.
macro_rules! status_pelamar_sql {
    () => {
        "(SELECT t.tahap FROM hr_pelamar_tahap t WHERE t.id_pelamar = p.id_pelamar AND t.dibatalkan_pada IS NULL ORDER BY t.urutan DESC LIMIT 1)"
    };
}


/// Semua lowongan dengan nama master hidup (Q-12), tutup efektif, dan
/// tanggal data pelamarnya dihapus.
pub const DAFTAR_LOWONGAN_SQL: &str = concat!(
    "SELECT l.*, j.nama AS jabatan_nama, d.nama AS divisi_nama, c.nama AS cabang_nama, date(l.ditutup_pada, '+7 hours') AS tanggal_ditutup, ",
    tutup_efektif_sql!(),
    " AS tutup_efektif, ",
    tanggal_hapus_sql!(),
    " AS tanggal_hapus FROM hr_lowongan l LEFT JOIN hr_jabatan j ON j.id_jabatan = l.id_jabatan LEFT JOIN hr_divisi d ON d.id_divisi = l.id_divisi LEFT JOIN hr_cabang c ON c.id_cabang = l.id_cabang ORDER BY l.tanggal_buka DESC, l.id_lowongan DESC;"
);

/// Status setiap pelamar, untuk hitungan per lowongan.
pub const STATUS_SEMUA_PELAMAR_SQL: &str = concat!(
    "SELECT p.id_lowongan, p.id_karyawan, ",
    status_pelamar_sql!(),
    " AS status FROM hr_pelamar p;"
);

// Kolom daftar pelamar; tanpa isi berkas. `karyawan_ada` = baris
// `master_data` hasil Jadikan karyawan sudah ada di cloud.
macro_rules! pilih_pelamar_sql {
    () => {
        concat!(
            "SELECT p.*, ",
            status_pelamar_sql!(),
            " AS status, (SELECT COUNT(*) FROM hr_pelamar_berkas b WHERE b.id_pelamar = p.id_pelamar) AS jumlah_berkas, EXISTS (SELECT 1 FROM master_data m WHERE m.id_unik = p.id_karyawan) AS karyawan_ada FROM hr_pelamar p WHERE "
        )
    };
}

pub const PELAMAR_LOWONGAN_SQL: &str =
    concat!(pilih_pelamar_sql!(), "p.id_lowongan = ?1 ORDER BY p.tanggal_lamaran DESC, p.id_pelamar;");
pub const PELAMAR_SATU_SQL: &str = concat!(pilih_pelamar_sql!(), "p.id_pelamar = ?1;");

pub const INSERT_LOWONGAN_SQL: &str = "INSERT INTO hr_lowongan (id_lowongan, judul, id_jabatan, id_divisi, id_cabang, jumlah, tanggal_buka, tanggal_tutup, keterangan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";
/// Ubah lowongan selama belum ditutup lewat tombol.
pub const UBAH_LOWONGAN_SQL: &str = "UPDATE hr_lowongan SET judul = ?2, id_jabatan = ?3, id_divisi = ?4, id_cabang = ?5, jumlah = ?6, tanggal_buka = ?7, tanggal_tutup = ?8, keterangan = ?9, diubah_oleh = ?10, diubah_pada = datetime('now') WHERE id_lowongan = ?1 AND ditutup_pada IS NULL;";
pub const TUTUP_LOWONGAN_SQL: &str = "UPDATE hr_lowongan SET ditutup_pada = datetime('now'), ditutup_oleh = ?2 WHERE id_lowongan = ?1 AND ditutup_pada IS NULL;";
/// Buka lagi: tutup tombol dikosongkan dan tanggal tutup diganti, sehingga jam
/// retensi mulai dari nol.
pub const BUKA_LOWONGAN_SQL: &str = "UPDATE hr_lowongan SET ditutup_pada = NULL, ditutup_oleh = NULL, tanggal_tutup = ?2, diubah_oleh = ?3, diubah_pada = datetime('now') WHERE id_lowongan = ?1;";

pub const INSERT_PELAMAR_SQL: &str = "INSERT INTO hr_pelamar (id_pelamar, id_lowongan, nama, no_hp, email, lp, tanggal_lahir, alamat, pendidikan, sumber, tanggal_lamaran, catatan, dicatat_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13);";
/// Ubah pelamar selama belum dijadikan karyawan; lowongannya tetap.
pub const UBAH_PELAMAR_SQL: &str = "UPDATE hr_pelamar SET nama = ?2, no_hp = ?3, email = ?4, lp = ?5, tanggal_lahir = ?6, alamat = ?7, pendidikan = ?8, sumber = ?9, tanggal_lamaran = ?10, catatan = ?11, diubah_oleh = ?12, diubah_pada = datetime('now') WHERE id_pelamar = ?1 AND id_karyawan IS NULL;";
/// Tahap baru ber-`urutan` dari bacaan terakhir: dua sesi yang mencatat
/// bersamaan bertabrakan di PK, bukan menghasilkan dua tahap terakhir.
pub const INSERT_TAHAP_SQL: &str = "INSERT INTO hr_pelamar_tahap (id_tahap, id_pelamar, urutan, tahap, tanggal, catatan, oleh) SELECT ?1 || ':' || ?2, ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?1 AND id_karyawan IS NULL);";
/// Batalkan tahap terakhir yang berlaku (`?2` = urutannya), sekali.
pub const BATAL_TAHAP_SQL: &str = "UPDATE hr_pelamar_tahap SET dibatalkan_oleh = ?3, dibatalkan_pada = datetime('now'), alasan_batal = ?4 WHERE id_pelamar = ?1 AND urutan = ?2 AND urutan > 1 AND dibatalkan_pada IS NULL AND NOT EXISTS (SELECT 1 FROM hr_pelamar_tahap t WHERE t.id_pelamar = ?1 AND t.urutan > ?2 AND t.dibatalkan_pada IS NULL) AND EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?1 AND id_karyawan IS NULL);";
pub const INSERT_BERKAS_SQL: &str = "INSERT INTO hr_pelamar_berkas (id_berkas, id_pelamar, urutan, nama_berkas, mime_type, data_base64) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM hr_pelamar WHERE id_pelamar = ?2 AND id_karyawan IS NULL);";
pub const HAPUS_BERKAS_SQL: &str = "DELETE FROM hr_pelamar_berkas WHERE id_berkas = ?1 AND id_pelamar IN (SELECT id_pelamar FROM hr_pelamar WHERE id_karyawan IS NULL);";

/// Retensi (`?1` NULL) atau hapus satu pelamar (`?1` = id), satu batch:
/// hitungan anonim dulu, lalu berkas, tahap, dan pelamarnya terakhir. Dua
/// sesi yang menjalankannya bersamaan: yang kedua tidak menemukan apa-apa.
pub const HAPUS_PELAMAR_LAMA_SQL: [&str; 4] = [
    concat!(
        "UPDATE hr_lowongan SET pelamar_dihapus = pelamar_dihapus + (SELECT COUNT(*) FROM hr_pelamar p WHERE p.id_lowongan = hr_lowongan.id_lowongan AND ",
        pelamar_dihapus_sql!(),
        ") WHERE id_lowongan IN (SELECT p.id_lowongan FROM hr_pelamar p WHERE ",
        pelamar_dihapus_sql!(),
        ");"
    ),
    concat!(
        "DELETE FROM hr_pelamar_berkas WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ",
        pelamar_dihapus_sql!(),
        ");"
    ),
    concat!(
        "DELETE FROM hr_pelamar_tahap WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ",
        pelamar_dihapus_sql!(),
        ");"
    ),
    concat!(
        "DELETE FROM hr_pelamar WHERE id_pelamar IN (SELECT p.id_pelamar FROM hr_pelamar p WHERE ",
        pelamar_dihapus_sql!(),
        ");"
    ),
];

/// Klaim "Jadikan karyawan" (§22.5 langkah 3): `?1` = id pelamar, `?2` =
/// id karyawan (`id_dari_pelamar`), `?3` = pencatat. Hanya pelamar yang
/// belum diklaim dan berstatus `Diterima`. Isian awal `hr_profil` (Q-94)
/// hanya bila profilnya belum ada dan pelamar memang membawa isinya, dijaga
/// klaim yang sama.
pub const KLAIM_PELAMAR_SQL: [&str; 2] = [
    "UPDATE hr_pelamar SET id_karyawan = ?2, dijadikan_oleh = ?3, dijadikan_pada = datetime('now') WHERE id_pelamar = ?1 AND id_karyawan IS NULL AND (SELECT t.tahap FROM hr_pelamar_tahap t WHERE t.id_pelamar = ?1 AND t.dibatalkan_pada IS NULL ORDER BY t.urutan DESC LIMIT 1) = 'Diterima';",
    "INSERT INTO hr_profil (id_karyawan, tanggal_lahir, alamat_domisili, pendidikan, pribadi_diubah_oleh, pribadi_diubah_pada) SELECT p.id_karyawan, p.tanggal_lahir, p.alamat, p.pendidikan, ?3, datetime('now') FROM hr_pelamar p WHERE p.id_pelamar = ?1 AND p.id_karyawan = ?2 AND (p.tanggal_lahir IS NOT NULL OR p.alamat IS NOT NULL OR p.pendidikan IS NOT NULL) ON CONFLICT(id_karyawan) DO NOTHING;",
];

// ── Aturan murni ───────────────────────────────────────────────────────────

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

fn teks_opsional(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<Option<String>, String> {
    match payload_text(draft, kunci) {
        Some(t) if panjang(&t) > maks => Err(format!("{label} maksimal {maks} karakter.")),
        lain => Ok(lain),
    }
}

fn spasi_rapi(teks: &str) -> String {
    teks.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Bilangan bulat JSON; `null`/absen = `None`, selain angka bulat = galat.
fn bulat(draft: &Value, kunci: &str) -> Result<Option<i64>, ()> {
    match draft.get(kunci) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or(()),
    }
}

/// Lowongan yang sudah divalidasi. Master organisasi diperiksa pemanggil.
#[derive(Clone, Debug, PartialEq)]
pub struct LowonganSah {
    pub id_lowongan: Option<String>,
    pub judul: String,
    pub id_jabatan: Option<String>,
    pub id_divisi: Option<String>,
    pub id_cabang: Option<String>,
    pub jumlah: i64,
    pub tanggal_buka: String,
    pub tanggal_tutup: Option<String>,
    pub keterangan: Option<String>,
}

/// Cermin `validasiLowongan`.
pub fn validasi_lowongan(draft: &Value) -> Result<LowonganSah, String> {
    let judul = payload_text(draft, "judul").map(|t| spasi_rapi(&t)).ok_or("Judul lowongan wajib diisi.")?;
    if panjang(&judul) > MAKS_JUDUL {
        return Err(format!("Judul lowongan maksimal {MAKS_JUDUL} karakter."));
    }
    let jumlah = bulat(draft, "jumlah")
        .ok()
        .flatten()
        .filter(|n| (1..=MAKS_JUMLAH).contains(n))
        .ok_or("Jumlah dibutuhkan harus bilangan bulat 1–999.")?;
    let tanggal_buka = payload_text(draft, "tanggal_buka")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal buka tidak valid.")?;
    let tanggal_tutup = payload_text(draft, "tanggal_tutup");
    if let Some(t) = &tanggal_tutup {
        if !is_valid_date(t) {
            return Err("Tanggal tutup tidak valid.".into());
        }
        if *t < tanggal_buka {
            return Err("Tanggal tutup tidak boleh sebelum tanggal buka.".into());
        }
    }
    Ok(LowonganSah {
        id_lowongan: payload_text(draft, "id_lowongan"),
        judul,
        id_jabatan: payload_text(draft, "id_jabatan"),
        id_divisi: payload_text(draft, "id_divisi"),
        id_cabang: payload_text(draft, "id_cabang"),
        jumlah,
        tanggal_buka,
        tanggal_tutup,
        keterangan: teks_opsional(draft, "keterangan", "Keterangan", MAKS_KETERANGAN)?,
    })
}

/// Cermin `statusLowongan` (Q-88). Tidak disimpan; `hari_ini` tanggal WIB.
pub fn status_lowongan(tanggal_buka: &str, tanggal_tutup: Option<&str>, ditutup: bool, hari_ini: &str) -> &'static str {
    if ditutup || tanggal_tutup.is_some_and(|t| t < hari_ini) {
        "Ditutup"
    } else if tanggal_buka > hari_ini {
        "Dijadwalkan"
    } else {
        "Dibuka"
    }
}

/// Cermin `tutupEfektif`, padanan murni `TUTUP_EFEKTIF_SQL`. Yang berlaku di
/// cloud adalah SQL-nya; ini hanya pembanding di tes.
#[cfg(test)]
/// `tanggal_ditutup` = tanggal WIB saat tombol Tutup ditekan.
pub fn tutup_efektif(tanggal_tutup: Option<&str>, tanggal_ditutup: Option<&str>, hari_ini: &str) -> Option<String> {
    let lewat = tanggal_tutup.filter(|t| *t < hari_ini);
    match (lewat, tanggal_ditutup) {
        (Some(a), Some(b)) => Some(a.min(b).to_owned()),
        (a, b) => a.or(b).map(str::to_owned),
    }
}

/// Pelamar yang sudah divalidasi. Lowongannya diperiksa pemanggil.
#[derive(Clone, Debug, PartialEq)]
pub struct PelamarSah {
    pub id_pelamar: Option<String>,
    pub id_lowongan: String,
    pub nama: String,
    pub no_hp: Option<String>,
    pub email: Option<String>,
    pub lp: Option<String>,
    pub tanggal_lahir: Option<String>,
    pub alamat: Option<String>,
    pub pendidikan: Option<String>,
    pub sumber: Option<String>,
    pub tanggal_lamaran: String,
    pub catatan: Option<String>,
}

/// Cermin `validasiPelamar`. `tanggal_buka` milik lowongannya, sehingga
/// lowongan Dijadwalkan tidak bisa menerima pelamar (lamaran ≤ hari ini).
pub fn validasi_pelamar(draft: &Value, tanggal_buka: &str, hari_ini: &str) -> Result<PelamarSah, String> {
    let id_lowongan = payload_text(draft, "id_lowongan").ok_or("Lowongan wajib dipilih.")?;
    let nama = payload_text(draft, "nama").map(|t| spasi_rapi(&t)).unwrap_or_default();
    if panjang(&nama) < MIN_NAMA_PELAMAR {
        return Err("Nama pelamar minimal 2 karakter.".into());
    }
    if panjang(&nama) > hris::MAKS_NAMA {
        return Err(format!("Nama pelamar maksimal {} karakter.", hris::MAKS_NAMA));
    }
    let no_hp = match payload_text(draft, "no_hp") {
        None => None,
        Some(t) => {
            let normal = normalize_operator_phone(&t);
            if !is_valid_operator_phone(&normal) {
                return Err("Nomor HP tidak valid.".into());
            }
            Some(normal)
        }
    };
    let email = match payload_text(draft, "email") {
        None => None,
        Some(t) if is_valid_operator_email(&t) => Some(normalize_operator_email(&t)),
        Some(_) => return Err("Email tidak valid.".into()),
    };
    let lp = payload_text(draft, "lp");
    if lp.as_deref().is_some_and(|v| v != "L" && v != "P") {
        return Err("Jenis kelamin tidak dikenal.".into());
    }
    let tanggal_lahir = payload_text(draft, "tanggal_lahir");
    if let Some(t) = &tanggal_lahir {
        if !is_valid_date(t) || t.as_str() > hari_ini {
            return Err("Tanggal lahir tidak valid.".into());
        }
    }
    let pendidikan = payload_text(draft, "pendidikan");
    if pendidikan.as_deref().is_some_and(|p| !hris::PENDIDIKAN.contains(&p)) {
        return Err("Pendidikan tidak dikenal.".into());
    }
    let tanggal_lamaran = payload_text(draft, "tanggal_lamaran")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal lamaran tidak valid.")?;
    if tanggal_lamaran.as_str() > hari_ini {
        return Err("Tanggal lamaran tidak boleh di masa depan.".into());
    }
    if tanggal_lamaran.as_str() < tanggal_buka {
        return Err("Tanggal lamaran tidak boleh sebelum lowongan dibuka.".into());
    }
    Ok(PelamarSah {
        id_pelamar: payload_text(draft, "id_pelamar"),
        id_lowongan,
        nama,
        no_hp,
        email,
        lp,
        tanggal_lahir,
        alamat: teks_opsional(draft, "alamat", "Alamat", MAKS_ALAMAT)?,
        pendidikan,
        sumber: teks_opsional(draft, "sumber", "Sumber", MAKS_SUMBER)?,
        tanggal_lamaran,
        catatan: teks_opsional(draft, "catatan", "Catatan", MAKS_CATATAN_PELAMAR)?,
    })
}

/// Satu baris `hr_pelamar_tahap` yang dibutuhkan aturan status.
#[derive(Clone, Debug, PartialEq)]
pub struct TahapRingkas {
    pub urutan: i64,
    pub tahap: String,
    pub dibatalkan: bool,
}

/// Cermin `statusPelamar`: tahap ber-`urutan` terbesar yang tidak dibatalkan.
pub fn status_pelamar(tahap: &[TahapRingkas]) -> Option<&TahapRingkas> {
    tahap.iter().filter(|t| !t.dibatalkan).max_by_key(|t| t.urutan)
}

/// Tahap baru yang sudah divalidasi.
#[derive(Clone, Debug, PartialEq)]
pub struct TahapSah {
    pub tahap: String,
    pub tanggal: String,
    pub catatan: Option<String>,
}

/// Cermin `periksaTahap` (Q-91): dari tahap proses ke tahap mana pun; dari
/// tahap akhir tidak ada tahap baru. `status` = tahap berlaku sekarang.
pub fn periksa_tahap(draft: &Value, status: &str, tanggal_lamaran: &str, hari_ini: &str) -> Result<TahapSah, String> {
    if TAHAP_AKHIR.contains(&status) {
        return Err(format!("Pelamar sudah {status}; tahap baru tidak bisa dicatat."));
    }
    let tahap = payload_text(draft, "tahap")
        .filter(|t| TAHAP_PROSES.contains(&t.as_str()) || TAHAP_AKHIR.contains(&t.as_str()))
        .ok_or("Tahap tidak dikenal.")?;
    let tanggal = payload_text(draft, "tanggal")
        .filter(|t| is_valid_date(t))
        .ok_or("Tanggal tahap tidak valid.")?;
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal tahap tidak boleh di masa depan.".into());
    }
    if tanggal.as_str() < tanggal_lamaran {
        return Err("Tanggal tahap tidak boleh sebelum tanggal lamaran.".into());
    }
    let catatan = teks_opsional(draft, "catatan", "Catatan", MAKS_CATATAN_TAHAP)?;
    if catatan.is_none() && TAHAP_BERCATATAN.contains(&tahap.as_str()) {
        return Err("Catatan wajib diisi untuk tahap Ditolak dan Mundur.".into());
    }
    Ok(TahapSah { tahap, tanggal, catatan })
}

/// Cermin `periksaBatalTahap`: hanya tahap terakhir yang berlaku, bukan
/// `Lamaran` urutan 1, dan pelamar belum dijadikan karyawan. Hasil = urutan
/// baris yang dibatalkan beserta alasannya.
pub fn periksa_batal_tahap(tahap: &[TahapRingkas], sudah_karyawan: bool, draft: &Value) -> Result<(i64, String), String> {
    if sudah_karyawan {
        return Err(PESAN_SUDAH_KARYAWAN.into());
    }
    let terakhir = status_pelamar(tahap).ok_or("Pelamar belum punya tahap.")?;
    if terakhir.urutan <= 1 {
        return Err("Tahap Lamaran tidak bisa dibatalkan.".into());
    }
    let alasan = teks_opsional(draft, "alasan", "Alasan pembatalan", MAKS_CATATAN_TAHAP)?
        .ok_or("Alasan pembatalan wajib diisi.")?;
    Ok((terakhir.urutan, alasan))
}

/// Id deterministik karyawan dan kontrak pertama dari satu pelamar (§22.5).
#[derive(Clone, Debug, PartialEq)]
pub struct IdDariPelamar {
    pub id_unik: String,
    pub kode_karyawan: String,
    pub id_kontrak: String,
}

/// Cermin `idDariPelamar`: `createEmployeeIdentifiers` atas bagian acak id
/// pelamar (`plm-<hex>`), jadi satu pelamar tidak pernah menjadi dua
/// karyawan. `kode_karyawan` hanya usulan; HRD boleh menggantinya.
pub fn id_dari_pelamar(id_pelamar: &str) -> Result<IdDariPelamar, String> {
    let acak = id_pelamar.strip_prefix("plm-").unwrap_or(id_pelamar);
    let ringkas: String = acak
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if ringkas.len() < 12 {
        return Err("Id pelamar tidak valid.".into());
    }
    Ok(IdDariPelamar {
        id_unik: format!("EMP_{}", &ringkas[..12]),
        kode_karyawan: format!("K{}", &ringkas[ringkas.len() - 8..]),
        id_kontrak: format!("ktr-{id_pelamar}"),
    })
}

/// Cermin `pelamarGanda`: pelamar satu lowongan dengan nama (tanpa beda
/// huruf/spasi) dan nomor HP yang sama. Hanya tanda, tidak ditolak.
/// Masukan `(id_pelamar, nama, no_hp)`; hasil berurutan masukan.
pub fn pelamar_ganda(pelamar: &[(String, String, Option<String>)]) -> Vec<String> {
    let mut hitung: HashMap<(String, &str), usize> = HashMap::new();
    for (_, nama, hp) in pelamar {
        if let Some(hp) = hp.as_deref() {
            *hitung.entry((kunci_nama(nama), hp)).or_default() += 1;
        }
    }
    let mut sudah = HashSet::new();
    pelamar
        .iter()
        .filter(|(_, nama, hp)| hp.as_deref().is_some_and(|hp| hitung[&(kunci_nama(nama), hp)] > 1))
        .filter(|(id, ..)| sudah.insert(id.clone()))
        .map(|(id, ..)| id.clone())
        .collect()
}

// ── Khusus cloud (Q-86) ────────────────────────────────────────────────────

fn tak_ditemukan(apa: &str) -> CommandError {
    invalid(format!("{apa} tidak ditemukan."))
}

/// PK `hr_pelamar_tahap` bertabrakan = sesi lain baru saja mencatat tahap.
fn tahap_bentrok(error: CommandError) -> CommandError {
    if error.message.contains("UNIQUE constraint failed") {
        return invalid("Tahap pelamar ini baru saja diubah orang lain. Muat ulang lalu coba lagi.");
    }
    tak_terhubung(error)
}

async fn satu(turso: &TursoClient, sql: &str, args: Vec<Value>) -> Result<Option<Baris>, CommandError> {
    Ok(objek(turso, sql, args).await?.into_iter().next())
}

fn status_dari_baris(lowongan: &Baris, hari_ini: &str) -> &'static str {
    status_lowongan(
        &teks_baris(lowongan, "tanggal_buka").unwrap_or_default(),
        teks_baris(lowongan, "tanggal_tutup").as_deref(),
        teks_baris(lowongan, "ditutup_pada").is_some(),
        hari_ini,
    )
}

async fn tahap_pelamar(turso: &TursoClient, id_pelamar: &str) -> Result<Vec<Baris>, CommandError> {
    objek(turso, "SELECT * FROM hr_pelamar_tahap WHERE id_pelamar = ?1 ORDER BY urutan;", vec![json!(id_pelamar)]).await
}

fn ringkas_tahap(baris: &[Baris]) -> Vec<TahapRingkas> {
    baris
        .iter()
        .map(|t| TahapRingkas {
            urutan: angka_baris(t, "urutan"),
            tahap: teks_baris(t, "tahap").unwrap_or_default(),
            dibatalkan: teks_baris(t, "dibatalkan_pada").is_some(),
        })
        .collect()
}

/// Daftar lowongan beserta status turunan, hitungan pelamar per status,
/// `lewat_kuota`, pelamar yang menggantung di lowongan Ditutup, dan tanggal
/// data pelamarnya dihapus (§22.3, §22.6).
pub async fn daftar_lowongan(turso: &TursoClient) -> Result<Value, CommandError> {
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let mut lowongan = objek(turso, DAFTAR_LOWONGAN_SQL, vec![]).await?;
    let pelamar = objek(turso, STATUS_SEMUA_PELAMAR_SQL, vec![]).await?;
    for l in &mut lowongan {
        let id = teks_baris(l, "id_lowongan").unwrap_or_default();
        let status = status_dari_baris(l, &hari_ini);
        let milik: Vec<&Baris> = pelamar.iter().filter(|p| teks_baris(p, "id_lowongan").as_deref() == Some(&id)).collect();
        let mut hitungan: HashMap<String, i64> = HashMap::new();
        for p in &milik {
            *hitungan.entry(teks_baris(p, "status").unwrap_or_default()).or_default() += 1;
        }
        let diterima = hitungan.get("Diterima").copied().unwrap_or(0);
        // Pelamar yang masih di tahap proses pada lowongan Ditutup: retensi
        // tetap berjalan atas mereka. Pelamar ber-`id_karyawan` tidak terhapus.
        let menggantung = if status == "Ditutup" {
            milik
                .iter()
                .filter(|p| teks_baris(p, "id_karyawan").is_none())
                .filter(|p| teks_baris(p, "status").is_some_and(|s| TAHAP_PROSES.contains(&s.as_str())))
                .count()
        } else {
            0
        };
        l.insert("status".into(), json!(status));
        l.insert("jumlah_pelamar".into(), json!(milik.len()));
        l.insert("jadi_karyawan".into(), json!(milik.iter().filter(|p| teks_baris(p, "id_karyawan").is_some()).count()));
        l.insert("lewat_kuota".into(), json!(diterima > angka_baris(l, "jumlah")));
        l.insert("menggantung".into(), json!(menggantung));
        l.insert("hitungan".into(), json!(hitungan));
    }
    Ok(json!({ "lowongan": lowongan, "hari_ini": hari_ini }))
}

/// Master organisasi lowongan: bila diisi harus ada, dan aktif bila berbeda
/// dari yang tersimpan (master tidak pernah dihapus, Q-12).
async fn periksa_org(turso: &TursoClient, sah: &LowonganSah, lama: Option<&Baris>) -> Result<(), CommandError> {
    for (tabel, kolom, nilai, label) in [
        ("hr_jabatan", "id_jabatan", &sah.id_jabatan, "Jabatan"),
        ("hr_divisi", "id_divisi", &sah.id_divisi, "Divisi"),
        ("hr_cabang", "id_cabang", &sah.id_cabang, "Cabang"),
    ] {
        let Some(id) = nilai else { continue };
        let tetap = lama.and_then(|l| teks_baris(l, kolom)).as_deref() == Some(id.as_str());
        let baris = satu(turso, &format!("SELECT is_aktif FROM {tabel} WHERE {kolom} = ?1;"), vec![json!(id)])
            .await?
            .ok_or_else(|| tak_ditemukan(label))?;
        if !tetap && angka_baris(&baris, "is_aktif") != 1 {
            return Err(invalid(format!("{label} sudah nonaktif.")));
        }
    }
    Ok(())
}

/// Buat atau ubah lowongan (`aksi` kosong/`simpan`), `tutup`, atau `buka`.
pub async fn simpan_lowongan(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let aksi = payload_text(draft, "aksi").unwrap_or_else(|| "simpan".into());
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let lama = match payload_text(draft, "id_lowongan") {
        Some(id) => Some(
            satu(
                turso,
                "SELECT l.*, (SELECT MIN(tanggal_lamaran) FROM hr_pelamar p WHERE p.id_lowongan = l.id_lowongan) AS lamaran_pertama FROM hr_lowongan l WHERE l.id_lowongan = ?1;",
                vec![json!(id)],
            )
            .await?
            .ok_or_else(|| tak_ditemukan("Lowongan"))?,
        ),
        None => None,
    };
    let status = lama.as_ref().map(|l| status_dari_baris(l, &hari_ini));
    let id = lama.as_ref().and_then(|l| teks_baris(l, "id_lowongan"));
    match (aksi.as_str(), &lama, id) {
        ("tutup", Some(_), Some(id)) => {
            if status == Some("Ditutup") {
                return Err(invalid("Lowongan sudah ditutup."));
            }
            turso.query_one(TUTUP_LOWONGAN_SQL, vec![json!(id), json!(oleh)]).await.map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_lowongan": id }))
        }
        ("buka", Some(l), Some(id)) => {
            if status != Some("Ditutup") {
                return Err(invalid("Lowongan ini tidak sedang ditutup."));
            }
            let tutup = payload_text(draft, "tanggal_tutup");
            if let Some(t) = &tutup {
                let buka = teks_baris(l, "tanggal_buka").unwrap_or_default();
                if !is_valid_date(t) || *t < hari_ini || *t < buka {
                    return Err(invalid("Tanggal tutup baru harus hari ini atau sesudahnya."));
                }
            }
            turso
                .query_one(BUKA_LOWONGAN_SQL, vec![json!(id), json!(tutup), json!(oleh)])
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_lowongan": id }))
        }
        ("simpan", _, _) => {
            let sah = validasi_lowongan(draft).map_err(invalid)?;
            if status == Some("Ditutup") {
                return Err(invalid("Lowongan sudah ditutup; buka lagi dulu untuk mengubahnya."));
            }
            if let Some(pertama) = lama.as_ref().and_then(|l| teks_baris(l, "lamaran_pertama")) {
                if sah.tanggal_buka > pertama {
                    return Err(invalid(format!("Tanggal buka tidak boleh sesudah lamaran pertama ({pertama}).")));
                }
            }
            periksa_org(turso, &sah, lama.as_ref()).await?;
            let (sql, id) = match lama.as_ref().and_then(|l| teks_baris(l, "id_lowongan")) {
                Some(id) => (UBAH_LOWONGAN_SQL, id),
                None => (INSERT_LOWONGAN_SQL, new_hex_id("low-")),
            };
            turso
                .query_one(
                    sql,
                    vec![
                        json!(id),
                        json!(sah.judul),
                        json!(sah.id_jabatan),
                        json!(sah.id_divisi),
                        json!(sah.id_cabang),
                        json!(sah.jumlah),
                        json!(sah.tanggal_buka),
                        json!(sah.tanggal_tutup),
                        json!(sah.keterangan),
                        json!(oleh),
                    ],
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_lowongan": id }))
        }
        ("tutup" | "buka", _, _) => Err(tak_ditemukan("Lowongan")),
        _ => Err(invalid("Aksi lowongan tidak dikenal.")),
    }
}

/// Pelamar satu lowongan, dengan tanda `mungkin_ganda` (§22.3).
pub async fn daftar_pelamar(turso: &TursoClient, id_lowongan: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let semua = daftar_lowongan(turso).await?;
    let lowongan = semua["lowongan"]
        .as_array()
        .and_then(|d| d.iter().find(|l| l["id_lowongan"].as_str() == Some(id_lowongan)).cloned())
        .ok_or_else(|| tak_ditemukan("Lowongan"))?;
    let mut pelamar = objek(turso, PELAMAR_LOWONGAN_SQL, vec![json!(id_lowongan)]).await?;
    let ganda: HashSet<String> = pelamar_ganda(
        &pelamar
            .iter()
            .map(|p| (teks_baris(p, "id_pelamar").unwrap_or_default(), teks_baris(p, "nama").unwrap_or_default(), teks_baris(p, "no_hp")))
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .collect();
    for p in &mut pelamar {
        let id = teks_baris(p, "id_pelamar").unwrap_or_default();
        p.insert("mungkin_ganda".into(), json!(ganda.contains(&id)));
    }
    Ok(json!({ "lowongan": lowongan, "pelamar": pelamar, "hari_ini": semua["hari_ini"] }))
}

/// Rincian satu pelamar: data, riwayat tahap, dan daftar berkas tanpa isi.
pub async fn rincian_pelamar(turso: &TursoClient, id_pelamar: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let pelamar = satu(turso, PELAMAR_SATU_SQL, vec![json!(id_pelamar)]).await?.ok_or_else(|| tak_ditemukan("Pelamar"))?;
    let tahap = tahap_pelamar(turso, id_pelamar).await?;
    let berkas = objek(
        turso,
        "SELECT id_berkas, urutan, nama_berkas, mime_type, length(data_base64) AS panjang, created_at FROM hr_pelamar_berkas WHERE id_pelamar = ?1 ORDER BY urutan;",
        vec![json!(id_pelamar)],
    )
    .await?;
    Ok(json!({ "pelamar": pelamar, "tahap": tahap, "berkas": berkas }))
}

/// Catat pelamar baru (beserta tahap `Lamaran` urutan 1, satu batch) atau
/// ubah pelamar yang belum dijadikan karyawan.
pub async fn simpan_pelamar(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_lowongan = payload_text(draft, "id_lowongan").ok_or_else(|| invalid("Lowongan wajib dipilih."))?;
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let lowongan = satu(turso, "SELECT tanggal_buka FROM hr_lowongan WHERE id_lowongan = ?1;", vec![json!(id_lowongan)])
        .await?
        .ok_or_else(|| tak_ditemukan("Lowongan"))?;
    let sah = validasi_pelamar(draft, &teks_baris(&lowongan, "tanggal_buka").unwrap_or_default(), &hari_ini).map_err(invalid)?;
    if let Some(id) = &sah.id_pelamar {
        let lama = satu(
            turso,
            "SELECT id_lowongan, id_karyawan, (SELECT MIN(t.tanggal) FROM hr_pelamar_tahap t WHERE t.id_pelamar = p.id_pelamar AND t.urutan > 1 AND t.dibatalkan_pada IS NULL) AS tahap_pertama FROM hr_pelamar p WHERE p.id_pelamar = ?1;",
            vec![json!(id)],
        )
        .await?
        .ok_or_else(|| tak_ditemukan("Pelamar"))?;
        if teks_baris(&lama, "id_karyawan").is_some() {
            return Err(invalid(PESAN_SUDAH_KARYAWAN));
        }
        if teks_baris(&lama, "id_lowongan").as_deref() != Some(sah.id_lowongan.as_str()) {
            return Err(invalid("Lowongan pelamar tidak bisa dipindah; hapus lalu catat ulang di lowongan yang benar."));
        }
        if teks_baris(&lama, "tahap_pertama").is_some_and(|t| t < sah.tanggal_lamaran) {
            return Err(invalid("Tanggal lamaran tidak boleh sesudah tahap yang sudah dicatat."));
        }
        turso
            .query_one(
                UBAH_PELAMAR_SQL,
                vec![
                    json!(id),
                    json!(sah.nama),
                    json!(sah.no_hp),
                    json!(sah.email),
                    json!(sah.lp),
                    json!(sah.tanggal_lahir),
                    json!(sah.alamat),
                    json!(sah.pendidikan),
                    json!(sah.sumber),
                    json!(sah.tanggal_lamaran),
                    json!(sah.catatan),
                    json!(oleh),
                ],
            )
            .await
            .map_err(tak_terhubung)?;
        return Ok(json!({ "sukses": true, "id_pelamar": id }));
    }
    let id = new_hex_id("plm-");
    turso
        .execute_atomic(vec![
            Statement::new(
                INSERT_PELAMAR_SQL,
                vec![
                    json!(id),
                    json!(sah.id_lowongan),
                    json!(sah.nama),
                    json!(sah.no_hp),
                    json!(sah.email),
                    json!(sah.lp),
                    json!(sah.tanggal_lahir),
                    json!(sah.alamat),
                    json!(sah.pendidikan),
                    json!(sah.sumber),
                    json!(sah.tanggal_lamaran),
                    json!(sah.catatan),
                    json!(oleh),
                ],
            ),
            Statement::new(
                INSERT_TAHAP_SQL,
                vec![
                    json!(id),
                    json!(1),
                    json!("Lamaran"),
                    json!(sah.tanggal_lamaran),
                    Value::Null,
                    json!(oleh),
                ],
            ),
        ])
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_pelamar": id }))
}

/// Catat tahap (`aksi` kosong/`catat`) atau batalkan tahap terakhir (`batal`).
/// Hasil membawa status pelamar yang dibaca ulang.
pub async fn catat_tahap(turso: &TursoClient, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_pelamar = payload_text(draft, "id_pelamar").ok_or_else(|| tak_ditemukan("Pelamar"))?;
    siap(turso).await?;
    let hari_ini = hari_ini_cloud(turso).await?;
    let pelamar = satu(turso, "SELECT tanggal_lamaran, id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;", vec![json!(id_pelamar)])
        .await?
        .ok_or_else(|| tak_ditemukan("Pelamar"))?;
    let sudah_karyawan = teks_baris(&pelamar, "id_karyawan").is_some();
    let tahap = ringkas_tahap(&tahap_pelamar(turso, &id_pelamar).await?);
    match payload_text(draft, "aksi").as_deref().unwrap_or("catat") {
        "catat" => {
            if sudah_karyawan {
                return Err(invalid(PESAN_SUDAH_KARYAWAN));
            }
            let status = status_pelamar(&tahap).map(|t| t.tahap.clone()).ok_or_else(|| invalid("Pelamar belum punya tahap."))?;
            let sah = periksa_tahap(draft, &status, &teks_baris(&pelamar, "tanggal_lamaran").unwrap_or_default(), &hari_ini)
                .map_err(invalid)?;
            let urutan = tahap.iter().map(|t| t.urutan).max().unwrap_or(0) + 1;
            turso
                .query_one(
                    INSERT_TAHAP_SQL,
                    vec![json!(id_pelamar), json!(urutan), json!(sah.tahap), json!(sah.tanggal), json!(sah.catatan), json!(oleh)],
                )
                .await
                .map_err(tahap_bentrok)?;
        }
        "batal" => {
            let (urutan, alasan) = periksa_batal_tahap(&tahap, sudah_karyawan, draft).map_err(invalid)?;
            turso
                .query_one(BATAL_TAHAP_SQL, vec![json!(id_pelamar), json!(urutan), json!(oleh), json!(alasan)])
                .await
                .map_err(tak_terhubung)?;
        }
        _ => return Err(invalid("Aksi tahap tidak dikenal.")),
    }
    let sekarang = ringkas_tahap(&tahap_pelamar(turso, &id_pelamar).await?);
    Ok(json!({ "sukses": true, "status": status_pelamar(&sekarang).map(|t| t.tahap.clone()) }))
}

/// Isi satu berkas lamaran.
pub async fn berkas_pelamar(turso: &TursoClient, id_berkas: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    satu(
        turso,
        "SELECT id_berkas, nama_berkas, mime_type, data_base64 FROM hr_pelamar_berkas WHERE id_berkas = ?1;",
        vec![json!(id_berkas)],
    )
    .await?
    .map(|b| json!(b))
    .ok_or_else(|| tak_ditemukan("Berkas"))
}

/// Tambah berkas lamaran (`aksi` kosong/`tambah`, maks 3, slot kosong
/// terkecil, aturan berkas dokumen karyawan) atau `hapus`.
pub async fn simpan_berkas(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    match payload_text(draft, "aksi").as_deref().unwrap_or("tambah") {
        "tambah" => {
            let id_pelamar = payload_text(draft, "id_pelamar").ok_or_else(|| tak_ditemukan("Pelamar"))?;
            let mime = payload_text(draft, "mime_type").unwrap_or_default();
            let data = draft.get("data_base64").and_then(Value::as_str).unwrap_or("");
            hris::validasi_berkas(&mime, data).map_err(invalid)?;
            let nama_berkas = teks_opsional(draft, "nama_berkas", "Nama berkas", hris::MAKS_TEKS).map_err(invalid)?;
            siap(turso).await?;
            let pelamar = satu(turso, "SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;", vec![json!(id_pelamar)])
                .await?
                .ok_or_else(|| tak_ditemukan("Pelamar"))?;
            if teks_baris(&pelamar, "id_karyawan").is_some() {
                return Err(invalid(PESAN_SUDAH_KARYAWAN));
            }
            let terpakai: HashSet<i64> = objek(turso, "SELECT urutan FROM hr_pelamar_berkas WHERE id_pelamar = ?1;", vec![json!(id_pelamar)])
                .await?
                .iter()
                .map(|b| angka_baris(b, "urutan"))
                .collect();
            let urutan = (1..=MAKS_BERKAS_PER_PELAMAR)
                .find(|u| !terpakai.contains(u))
                .ok_or_else(|| invalid(format!("Satu pelamar maksimal {MAKS_BERKAS_PER_PELAMAR} berkas.")))?;
            let id = new_hex_id("pb-");
            turso
                .query_one(
                    INSERT_BERKAS_SQL,
                    vec![json!(id), json!(id_pelamar), json!(urutan), json!(nama_berkas), json!(mime), json!(data)],
                )
                .await
                .map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true, "id_berkas": id }))
        }
        "hapus" => {
            let id_berkas = payload_text(draft, "id_berkas").ok_or_else(|| tak_ditemukan("Berkas"))?;
            siap(turso).await?;
            let baris = satu(
                turso,
                "SELECT p.id_karyawan FROM hr_pelamar_berkas b JOIN hr_pelamar p ON p.id_pelamar = b.id_pelamar WHERE b.id_berkas = ?1;",
                vec![json!(id_berkas)],
            )
            .await?
            .ok_or_else(|| tak_ditemukan("Berkas"))?;
            if teks_baris(&baris, "id_karyawan").is_some() {
                return Err(invalid(PESAN_SUDAH_KARYAWAN));
            }
            turso.query_one(HAPUS_BERKAS_SQL, vec![json!(id_berkas)]).await.map_err(tak_terhubung)?;
            Ok(json!({ "sukses": true }))
        }
        _ => Err(invalid("Aksi berkas tidak dikenal.")),
    }
}

/// Hapus satu pelamar lebih cepat (`hr.recruit.delete`, §22.6): statement
/// retensi yang sama untuk satu id, tetap menambah hitungan anonim.
pub async fn hapus_pelamar(turso: &TursoClient, id_pelamar: &str) -> Result<Value, CommandError> {
    siap(turso).await?;
    let pelamar = satu(turso, "SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;", vec![json!(id_pelamar)])
        .await?
        .ok_or_else(|| tak_ditemukan("Pelamar"))?;
    if teks_baris(&pelamar, "id_karyawan").is_some() {
        return Err(invalid("Pelamar yang sudah dijadikan karyawan tidak bisa dihapus."));
    }
    turso
        .execute_atomic(HAPUS_PELAMAR_LAMA_SQL.iter().map(|sql| Statement::new(*sql, vec![json!(id_pelamar)])).collect())
        .await
        .map_err(tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

/// Retensi (Q-33, Q-93): hapus pelamar yang masa simpan lowongannya habis,
/// berjam database. Hasil hanya hitungan; tidak menulis apa pun bila nol.
pub async fn bersihkan_pelamar(turso: &TursoClient) -> Result<Value, CommandError> {
    siap(turso).await?;
    let n = satu(turso, &format!("SELECT COUNT(*) AS n FROM hr_pelamar p WHERE {PELAMAR_DIHAPUS_SQL};"), vec![Value::Null])
        .await?
        .map(|b| angka_baris(&b, "n"))
        .unwrap_or(0);
    if n > 0 {
        turso
            .execute_atomic(HAPUS_PELAMAR_LAMA_SQL.iter().map(|sql| Statement::new(*sql, vec![Value::Null])).collect())
            .await
            .map_err(tak_terhubung)?;
    }
    Ok(json!({ "dihapus": n }))
}

// ── Jadikan karyawan (§22.5, Q-92) ─────────────────────────────────────────

/// Penjaga kedua di samping `require_permission` command: aksi ini menulis
/// data pelamar, karyawan, dan kontrak sekaligus (Q-100, aturan 44).
fn periksa_izin_jadikan(operator: &OperatorUser) -> Result<(), CommandError> {
    let lengkap = IZIN_JADIKAN_KARYAWAN
        .iter()
        .all(|izin| operator.permissions.iter().any(|p| p == izin));
    if operator.is_superadmin || lengkap {
        return Ok(());
    }
    Err(CommandError::new("DESKTOP_ACCESS_DENIED", "Akses ditolak untuk tindakan ini."))
}

/// Pemeriksaan SQLite perangkat tanpa menulis apa pun, sebelum klaim cloud.
/// Hasil = `master_data` ber-id itu sudah ada di perangkat (jalur Lanjutkan
/// yang cukup menarik data). Koneksi dibuka dan ditutup di sini.
fn periksa_lokal(state: &DesktopState, karyawan: &Value, id_unik: &str) -> Result<bool, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let ada = |sql: &str, arg: &str| -> Result<bool, CommandError> {
        conn.query_row(sql, [arg], |r| r.get(0)).map_err(|_| CommandError::internal())
    };
    if ada("SELECT EXISTS(SELECT 1 FROM master_data WHERE id_unik = ?1);", id_unik)? {
        return Ok(true);
    }
    hris::org_dari_draft(&conn, "", karyawan)?;
    let kode = payload_text(karyawan, "kode_karyawan").unwrap_or_default();
    if ada("SELECT EXISTS(SELECT 1 FROM master_data WHERE kode_karyawan = ?1);", &kode)? {
        return Err(invalid(format!("Kode karyawan {kode} sudah dipakai karyawan lain.")));
    }
    Ok(false)
}

/// Karyawan + kontrak pertama + dua outbox dalam SATU transaksi SQLite.
fn tulis_lokal(
    state: &DesktopState,
    oleh: &str,
    karyawan: &Value,
    kontrak: &hris::KontrakSah,
    id_kontrak: &str,
) -> Result<(Value, Value), CommandError> {
    let client_id = sync::ensure_client_id(state)?;
    let mut conn = storage::database(&state.data_dir)?;
    let tx = conn.transaction().map_err(|_| CommandError::internal())?;
    let hasil = operational::create_employee_tx(&tx, &client_id, karyawan)?;
    let kontrak = hris::catat_kontrak_tx(&tx, &client_id, oleh, kontrak, id_kontrak)?;
    tx.commit().map_err(|_| CommandError::internal())?;
    Ok((hasil, kontrak))
}

/// Jadikan pelamar `Diterima` karyawan (Desktop/Mobile, Q-92 (a)).
///
/// `draft` = `{ id_pelamar, karyawan: {…isian form karyawan…}, kontrak:
/// {…kontrak pertama…} }`. Semua validasi dulu tanpa menulis; lalu klaim di
/// cloud (`KLAIM_PELAMAR_SQL`), lalu karyawan + kontrak di SQLite lokal dalam
/// satu transaksi. Id karyawan dan kontrak diturunkan dari id pelamar, jadi
/// pelamar yang klaimnya terisi tetapi karyawannya belum ada (aplikasi
/// tertutup di tengah) diselesaikan dengan memanggil ulang ini (Lanjutkan).
pub async fn jadikan_karyawan(
    state: &DesktopState,
    turso: &TursoClient,
    operator: &OperatorUser,
    draft: &Value,
) -> Result<Value, CommandError> {
    periksa_izin_jadikan(operator)?;
    let id_pelamar = payload_text(draft, "id_pelamar").ok_or_else(|| tak_ditemukan("Pelamar"))?;
    let id = id_dari_pelamar(&id_pelamar).map_err(invalid)?;
    let mut karyawan = draft
        .get("karyawan")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| invalid("Data karyawan wajib diisi."))?;
    karyawan.insert("id_unik".into(), json!(id.id_unik));
    if karyawan.get("kode_karyawan").and_then(Value::as_str).is_none_or(|k| k.trim().is_empty()) {
        karyawan.insert("kode_karyawan".into(), json!(id.kode_karyawan));
    }
    let karyawan = Value::Object(karyawan);
    let mut kontrak = draft
        .get("kontrak")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| invalid("Kontrak pertama wajib diisi."))?;
    kontrak.insert("id_karyawan".into(), json!(id.id_unik));
    let kontrak = hris::validasi_kontrak(&Value::Object(kontrak)).map_err(invalid)?;
    operational::periksa_draft_karyawan(&karyawan)?;
    let ada_lokal = periksa_lokal(state, &karyawan, &id.id_unik)?;

    siap(turso).await?;
    let pelamar = satu(turso, PELAMAR_SATU_SQL, vec![json!(id_pelamar)])
        .await?
        .ok_or_else(|| tak_ditemukan("Pelamar"))?;
    let klaim = teks_baris(&pelamar, "id_karyawan");
    let lanjutan = match klaim.as_deref() {
        None => {
            if teks_baris(&pelamar, "status").as_deref() != Some("Diterima") {
                return Err(invalid("Hanya pelamar berstatus Diterima yang bisa dijadikan karyawan."));
            }
            let args = vec![json!(id_pelamar), json!(id.id_unik), json!(operator.username)];
            let menang = turso.query_one(KLAIM_PELAMAR_SQL[0], args).await.map_err(tak_terhubung)?.rows_affected;
            if menang == 0 {
                return Err(invalid("Pelamar ini sudah dijadikan karyawan."));
            }
            false
        }
        Some(diklaim) if diklaim == id.id_unik => true,
        Some(_) => return Err(invalid("Pelamar ini sudah dijadikan karyawan.")),
    };
    // Isian awal profil (Q-94), juga pada Lanjutkan: idempoten dan dijaga klaim.
    turso
        .query_one(KLAIM_PELAMAR_SQL[1], vec![json!(id_pelamar), json!(id.id_unik), json!(operator.username)])
        .await
        .map_err(tak_terhubung)?;
    if lanjutan {
        // `employee/create` cloud menimpa token dan QR, jadi karyawan yang sudah
        // ada di perangkat atau di cloud tidak pernah ditulis ulang.
        let di_cloud = satu(turso, "SELECT 1 AS ada FROM master_data WHERE id_unik = ?1;", vec![json!(id.id_unik)])
            .await?
            .is_some();
        if ada_lokal || di_cloud {
            return Ok(json!({
                "sukses": true,
                "id_unik": id.id_unik,
                "sudah_ada": if ada_lokal { "perangkat" } else { "cloud" },
            }));
        }
    } else if ada_lokal {
        return Err(invalid("Data karyawan untuk pelamar ini sudah ada di perangkat."));
    }
    let (hasil, ktr) = tulis_lokal(state, &operator.username, &karyawan, &kontrak, &id.id_kontrak)?;
    Ok(json!({
        "sukses": true,
        "id_unik": id.id_unik,
        "token_absensi": hasil["token_absensi"],
        "id_kontrak": ktr["id_kontrak"],
        "lanjutan": lanjutan,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor yang sama diuji di `validations/hr-rekrutmen.test.ts`.

    const HARI: &str = "2026-11-12";

    fn t(urutan: i64, tahap: &str, dibatalkan: bool) -> TahapRingkas {
        TahapRingkas { urutan, tahap: tahap.into(), dibatalkan }
    }

    #[test]
    fn lowongan_validasi_dan_status() {
        let sah = validasi_lowongan(&json!({
            "judul": "  Staf   Gudang ", "jumlah": 2, "tanggal_buka": "2026-11-01", "tanggal_tutup": "2026-11-30", "id_divisi": "div-1"
        }))
        .unwrap();
        assert_eq!((sah.judul.as_str(), sah.jumlah, sah.id_divisi.as_deref(), sah.id_jabatan), ("Staf Gudang", 2, Some("div-1"), None));
        assert_eq!(validasi_lowongan(&json!({ "jumlah": 1, "tanggal_buka": "2026-11-01" })), Err("Judul lowongan wajib diisi.".into()));
        assert_eq!(validasi_lowongan(&json!({ "judul": "A", "jumlah": 0, "tanggal_buka": "2026-11-01" })), Err("Jumlah dibutuhkan harus bilangan bulat 1–999.".into()));
        assert_eq!(validasi_lowongan(&json!({ "judul": "A", "jumlah": 1.5, "tanggal_buka": "2026-11-01" })), Err("Jumlah dibutuhkan harus bilangan bulat 1–999.".into()));
        assert_eq!(validasi_lowongan(&json!({ "judul": "A", "jumlah": 1, "tanggal_buka": "2026-11-31" })), Err("Tanggal buka tidak valid.".into()));
        assert_eq!(
            validasi_lowongan(&json!({ "judul": "A", "jumlah": 1, "tanggal_buka": "2026-11-10", "tanggal_tutup": "2026-11-09" })),
            Err("Tanggal tutup tidak boleh sebelum tanggal buka.".into())
        );
        assert_eq!(validasi_lowongan(&json!({ "judul": "a".repeat(101), "jumlah": 1, "tanggal_buka": "2026-11-01" })), Err("Judul lowongan maksimal 100 karakter.".into()));

        assert_eq!(status_lowongan("2026-11-01", None, false, HARI), "Dibuka");
        assert_eq!(status_lowongan("2026-11-13", None, false, HARI), "Dijadwalkan");
        assert_eq!(status_lowongan("2026-11-01", Some("2026-11-12"), false, HARI), "Dibuka");
        assert_eq!(status_lowongan("2026-11-01", Some("2026-11-11"), false, HARI), "Ditutup");
        assert_eq!(status_lowongan("2026-11-13", None, true, HARI), "Ditutup");

        assert_eq!(tutup_efektif(None, None, HARI), None);
        assert_eq!(tutup_efektif(Some("2026-11-12"), None, HARI), None);
        assert_eq!(tutup_efektif(Some("2026-11-10"), None, HARI).as_deref(), Some("2026-11-10"));
        assert_eq!(tutup_efektif(Some("2026-11-20"), Some("2026-11-05"), HARI).as_deref(), Some("2026-11-05"));
        assert_eq!(tutup_efektif(Some("2026-11-03"), Some("2026-11-05"), HARI).as_deref(), Some("2026-11-03"));
        assert_eq!(tutup_efektif(None, Some("2026-11-05"), HARI).as_deref(), Some("2026-11-05"));
    }

    #[test]
    fn pelamar_validasi() {
        let dasar = json!({
            "id_lowongan": "low-1", "nama": " Budi  Santoso ", "no_hp": "0812-3456-7890", "email": " Budi@Contoh.ID ",
            "lp": "L", "pendidikan": "S1", "tanggal_lamaran": "2026-11-05", "sumber": "Jobstreet"
        });
        let sah = validasi_pelamar(&dasar, "2026-11-01", HARI).unwrap();
        assert_eq!(
            (sah.nama.as_str(), sah.no_hp.as_deref(), sah.email.as_deref()),
            ("Budi Santoso", Some("+6281234567890"), Some("budi@contoh.id"))
        );
        let ubah = |kunci: &str, nilai: Value| {
            let mut d = dasar.clone();
            d[kunci] = nilai;
            validasi_pelamar(&d, "2026-11-01", HARI)
        };
        assert_eq!(ubah("id_lowongan", Value::Null), Err("Lowongan wajib dipilih.".into()));
        assert_eq!(ubah("nama", json!("B")), Err("Nama pelamar minimal 2 karakter.".into()));
        assert_eq!(ubah("no_hp", json!("12")), Err("Nomor HP tidak valid.".into()));
        assert_eq!(ubah("email", json!("budi@contoh")), Err("Email tidak valid.".into()));
        assert_eq!(ubah("lp", json!("X")), Err("Jenis kelamin tidak dikenal.".into()));
        assert_eq!(ubah("tanggal_lahir", json!("2026-11-13")), Err("Tanggal lahir tidak valid.".into()));
        assert_eq!(ubah("pendidikan", json!("SMA")), Err("Pendidikan tidak dikenal.".into()));
        assert_eq!(ubah("tanggal_lamaran", json!("2026-11-13")), Err("Tanggal lamaran tidak boleh di masa depan.".into()));
        assert_eq!(ubah("tanggal_lamaran", json!("2026-10-31")), Err("Tanggal lamaran tidak boleh sebelum lowongan dibuka.".into()));
        assert_eq!(ubah("alamat", json!("a".repeat(256))), Err("Alamat maksimal 255 karakter.".into()));
        assert_eq!(ubah("sumber", json!("a".repeat(101))), Err("Sumber maksimal 100 karakter.".into()));
        // Lowongan Dijadwalkan (buka besok) tidak bisa menerima pelamar.
        assert_eq!(
            validasi_pelamar(&json!({ "id_lowongan": "low-1", "nama": "Budi", "tanggal_lamaran": HARI }), "2026-11-13", HARI),
            Err("Tanggal lamaran tidak boleh sebelum lowongan dibuka.".into())
        );
    }

    #[test]
    fn tahap_status_urutan_dan_batal() {
        let riwayat = vec![t(1, "Lamaran", false), t(2, "Wawancara", false), t(3, "Tes", true)];
        assert_eq!(status_pelamar(&riwayat).map(|s| s.tahap.as_str()), Some("Wawancara"));
        assert_eq!(status_pelamar(&[]), None);

        let tahap = |tahap: &str, catatan: Value| json!({ "tahap": tahap, "tanggal": "2026-11-10", "catatan": catatan });
        assert!(periksa_tahap(&tahap("Wawancara", Value::Null), "Wawancara", "2026-11-05", HARI).is_ok());
        assert!(periksa_tahap(&tahap("Lamaran", Value::Null), "Tes", "2026-11-05", HARI).is_ok());
        assert!(periksa_tahap(&tahap("Diterima", Value::Null), "Lamaran", "2026-11-05", HARI).is_ok());
        assert_eq!(periksa_tahap(&tahap("Tes", Value::Null), "Ditolak", "2026-11-05", HARI), Err("Pelamar sudah Ditolak; tahap baru tidak bisa dicatat.".into()));
        assert_eq!(periksa_tahap(&tahap("Psikotes", Value::Null), "Lamaran", "2026-11-05", HARI), Err("Tahap tidak dikenal.".into()));
        assert_eq!(periksa_tahap(&tahap("Mundur", json!(" ")), "Tes", "2026-11-05", HARI), Err("Catatan wajib diisi untuk tahap Ditolak dan Mundur.".into()));
        assert!(periksa_tahap(&tahap("Ditolak", json!("Tidak lulus tes")), "Tes", "2026-11-05", HARI).is_ok());
        assert_eq!(periksa_tahap(&tahap("Tes", Value::Null), "Lamaran", "2026-11-11", HARI), Err("Tanggal tahap tidak boleh sebelum tanggal lamaran.".into()));
        assert_eq!(
            periksa_tahap(&json!({ "tahap": "Tes", "tanggal": "2026-11-13" }), "Lamaran", "2026-11-05", HARI),
            Err("Tanggal tahap tidak boleh di masa depan.".into())
        );

        let alasan = json!({ "alasan": "Salah tekan" });
        assert_eq!(periksa_batal_tahap(&riwayat, false, &alasan), Ok((2, "Salah tekan".into())));
        assert_eq!(periksa_batal_tahap(&riwayat, false, &json!({})), Err("Alasan pembatalan wajib diisi.".into()));
        assert_eq!(periksa_batal_tahap(&riwayat, true, &alasan), Err(PESAN_SUDAH_KARYAWAN.into()));
        assert_eq!(periksa_batal_tahap(&[t(1, "Lamaran", false)], false, &alasan), Err("Tahap Lamaran tidak bisa dibatalkan.".into()));
    }

    #[test]
    fn id_deterministik_dan_ganda() {
        let id = id_dari_pelamar("plm-0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(
            id,
            IdDariPelamar {
                id_unik: "EMP_0123456789AB".into(),
                kode_karyawan: "K89ABCDEF".into(),
                id_kontrak: "ktr-plm-0123456789abcdef0123456789abcdef".into(),
            }
        );
        assert_eq!(id_dari_pelamar("plm-abc"), Err("Id pelamar tidak valid.".into()));

        let p = |id: &str, nama: &str, hp: Option<&str>| (id.to_owned(), nama.to_owned(), hp.map(str::to_owned));
        let daftar = vec![
            p("a", "Budi Santoso", Some("+6281")),
            p("b", " budi  SANTOSO", Some("+6281")),
            p("c", "Budi Santoso", Some("+6282")),
            p("d", "Ani", None),
            p("e", "Ani", None),
        ];
        assert_eq!(pelamar_ganda(&daftar), vec!["a", "b"]);
    }

    /// `TUTUP_EFEKTIF_SQL` dan `tutup_efektif` sepakat, diuji relatif terhadap
    /// tanggal WIB database supaya tidak bergantung jam pengujian.
    #[test]
    fn tutup_efektif_sql_sama_dengan_aturan_murni() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let hari_ini: String = conn.query_row("SELECT date('now', '+7 hours');", [], |r| r.get(0)).unwrap();
        let geser = |n: i64| -> String {
            conn.query_row("SELECT date(?1, ?2 || ' days');", rusqlite::params![hari_ini, n], |r| r.get(0)).unwrap()
        };
        // (tanggal_tutup, hari tombol Tutup relatif hari ini)
        let kasus: [(Option<i64>, Option<i64>); 7] =
            [(None, None), (Some(0), None), (Some(-2), None), (Some(5), Some(-3)), (Some(-5), Some(-3)), (None, Some(-1)), (Some(-1), Some(-4))];
        for (tutup, ditekan) in kasus {
            let tanggal_tutup = tutup.map(geser);
            let tanggal_ditutup = ditekan.map(geser);
            // 12.00 WIB pada hari itu = 05.00 UTC.
            let ditutup_pada = tanggal_ditutup.as_ref().map(|d| format!("{d} 05:00:00"));
            let sql: Option<String> = conn
                .query_row(
                    &format!("SELECT {TUTUP_EFEKTIF_SQL} FROM (SELECT ?1 AS tanggal_tutup, ?2 AS ditutup_pada) l;"),
                    rusqlite::params![tanggal_tutup, ditutup_pada],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                sql,
                tutup_efektif(tanggal_tutup.as_deref(), tanggal_ditutup.as_deref(), &hari_ini),
                "kasus {tutup:?} {ditekan:?}"
            );
        }
        let retensi = |nilai: Option<&str>| -> i64 {
            conn.execute("DROP TABLE IF EXISTS setting_gex_system;", []).unwrap();
            conn.execute("CREATE TABLE setting_gex_system (key TEXT PRIMARY KEY, value TEXT NOT NULL);", []).unwrap();
            if let Some(v) = nilai {
                conn.execute("INSERT INTO setting_gex_system VALUES ('hr_pelamar_retensi_bulan', ?1);", [v]).unwrap();
            }
            conn.query_row(&format!("SELECT {RETENSI_BULAN_SQL};"), [], |r| r.get(0)).unwrap()
        };
        assert_eq!(
            [retensi(None), retensi(Some(" 24 ")), retensi(Some("0")), retensi(Some("61")), retensi(Some("6x")), retensi(Some("-3"))],
            [12, 24, 12, 12, 12, 12]
        );
        for sql in HAPUS_PELAMAR_LAMA_SQL.iter().chain(KLAIM_PELAMAR_SQL.iter()) {
            assert!(!sql.contains("{"), "SQL kembar tidak boleh berisi penanda");
        }
    }

    /// Transaksi cloud rekrutmen di `TursoClient::local_file` (§22.11 langkah
    /// 4): tahap sesudah tahap akhir ditolak, batalkan tahap terakhir,
    /// berkas maksimal tiga, retensi menghapus pelamar + tahap + berkas,
    /// menambah `pelamar_dihapus`, melewati pelamar ber-`id_karyawan`, dan
    /// dijalankan dua kali hasilnya sama; hapus satu pelamar lebih cepat.
    #[test]
    fn rekrutmen_cloud_tahap_berkas_dan_retensi() {
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
            let tanggal = |hari: i64| -> String {
                conn.query_row("SELECT date('now', '+7 hours', ?1 || ' days');", [hari], |r| r.get(0)).unwrap()
            };
            let angka = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            let galat = |hasil: Result<Value, CommandError>| hasil.expect_err("harus ditolak").message;
            let id_dari = |hasil: Value, kunci: &str| hasil[kunci].as_str().expect("id").to_owned();

            // Lowongan dibuka 30 hari lalu.
            let low = id_dari(
                simpan_lowongan(&turso, "hrd", &json!({ "judul": "Staf Gudang", "jumlah": 1, "tanggal_buka": tanggal(-30) }))
                    .await
                    .unwrap(),
                "id_lowongan",
            );
            let pelamar = |nama: &str| json!({ "id_lowongan": low, "nama": nama, "no_hp": "081234567890", "tanggal_lamaran": tanggal(-20) });
            let a = id_dari(simpan_pelamar(&turso, "hrd", &pelamar("Ani")).await.unwrap(), "id_pelamar");
            assert_eq!(angka("SELECT COUNT(*) FROM hr_pelamar_tahap WHERE urutan = 1 AND tahap = 'Lamaran';"), 1);

            // Tahap: Wawancara, Ditolak, lalu Tes ditolak karena tahap akhir.
            let tahap = |nama: &str, catatan: Option<&str>| {
                json!({ "id_pelamar": a, "tahap": nama, "tanggal": tanggal(-10), "catatan": catatan })
            };
            assert_eq!(catat_tahap(&turso, "hrd", &tahap("Wawancara", None)).await.unwrap()["status"], "Wawancara");
            assert_eq!(catat_tahap(&turso, "hrd", &tahap("Ditolak", Some("Tidak cocok"))).await.unwrap()["status"], "Ditolak");
            assert_eq!(
                galat(catat_tahap(&turso, "hrd", &tahap("Tes", None)).await),
                "Pelamar sudah Ditolak; tahap baru tidak bisa dicatat."
            );

            // Batalkan tahap terakhir dua kali; Lamaran tidak bisa dibatalkan.
            let batal = json!({ "id_pelamar": a, "aksi": "batal", "alasan": "Salah tekan" });
            assert_eq!(catat_tahap(&turso, "hrd", &batal).await.unwrap()["status"], "Wawancara");
            assert_eq!(catat_tahap(&turso, "hrd", &batal).await.unwrap()["status"], "Lamaran");
            assert_eq!(galat(catat_tahap(&turso, "hrd", &batal).await), "Tahap Lamaran tidak bisa dibatalkan.");
            // Tahap baru sesudah pembatalan memakai urutan berikutnya, bukan mengisi celah.
            catat_tahap(&turso, "hrd", &tahap("Tes", None)).await.unwrap();
            assert_eq!(angka("SELECT MAX(urutan) FROM hr_pelamar_tahap;"), 4);

            // Berkas: tiga diterima, keempat ditolak.
            let pdf = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"%PDF-1.7 cv");
            let berkas = json!({ "id_pelamar": a, "mime_type": "application/pdf", "data_base64": pdf });
            for _ in 0..3 {
                simpan_berkas(&turso, &berkas).await.unwrap();
            }
            assert_eq!(galat(simpan_berkas(&turso, &berkas).await), "Satu pelamar maksimal 3 berkas.");

            // Pelamar B sudah dijadikan karyawan: terkunci dan tidak pernah dihapus.
            let b = id_dari(simpan_pelamar(&turso, "hrd", &pelamar("Budi")).await.unwrap(), "id_pelamar");
            conn.execute("UPDATE hr_pelamar SET id_karyawan = 'EMP_B' WHERE id_pelamar = ?1;", [&b]).unwrap();
            let ubah_b = json!({ "id_pelamar": b, "id_lowongan": low, "nama": "Budi S", "tanggal_lamaran": tanggal(-20) });
            assert_eq!(galat(simpan_pelamar(&turso, "hrd", &ubah_b).await), PESAN_SUDAH_KARYAWAN);
            assert_eq!(galat(hapus_pelamar(&turso, &b).await), "Pelamar yang sudah dijadikan karyawan tidak bisa dihapus.");
            let isi = daftar_pelamar(&turso, &low).await.unwrap();
            assert_eq!(isi["pelamar"].as_array().map(Vec::len), Some(2));
            assert!(isi["pelamar"].as_array().unwrap().iter().all(|p| p["mungkin_ganda"] == json!(false)));

            // Lowongan masih dibuka: retensi tidak menyentuh apa pun.
            assert_eq!(bersihkan_pelamar(&turso).await.unwrap()["dihapus"], 0);
            // Tutup, lalu mundurkan jam tutup 13 bulan: masa 24 bulan belum habis, 12 bulan sudah.
            simpan_lowongan(&turso, "hrd", &json!({ "id_lowongan": low, "aksi": "tutup" })).await.unwrap();
            assert_eq!(
                galat(simpan_lowongan(&turso, "hrd", &json!({ "id_lowongan": low, "aksi": "tutup" })).await),
                "Lowongan sudah ditutup."
            );
            conn.execute("UPDATE hr_lowongan SET ditutup_pada = datetime('now', '-13 months');", []).unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES ('hr_pelamar_retensi_bulan', '24');",
                [],
            )
            .unwrap();
            assert_eq!(bersihkan_pelamar(&turso).await.unwrap()["dihapus"], 0);
            let daftar = daftar_lowongan(&turso).await.unwrap();
            assert_eq!(daftar["lowongan"][0]["status"], "Ditutup");
            assert_eq!(daftar["lowongan"][0]["menggantung"], 1);
            assert!(daftar["lowongan"][0]["tanggal_hapus"].as_str().is_some());
            conn.execute("UPDATE setting_gex_system SET value = '12' WHERE key = 'hr_pelamar_retensi_bulan';", []).unwrap();
            assert_eq!(bersihkan_pelamar(&turso).await.unwrap()["dihapus"], 1);
            assert_eq!(bersihkan_pelamar(&turso).await.unwrap()["dihapus"], 0);
            assert_eq!(
                (
                    angka("SELECT COUNT(*) FROM hr_pelamar;"),
                    angka("SELECT COUNT(*) FROM hr_pelamar_tahap;"),
                    angka("SELECT COUNT(*) FROM hr_pelamar_berkas;"),
                    angka("SELECT pelamar_dihapus FROM hr_lowongan;"),
                ),
                (1, 1, 0, 1),
                "hanya Budi (karyawan) dan tahap Lamaran-nya yang tersisa"
            );

            // Buka lagi mengulang jam retensi; pelamar baru lalu dihapus lebih cepat.
            simpan_lowongan(&turso, "hrd", &json!({ "id_lowongan": low, "aksi": "buka" })).await.unwrap();
            assert_eq!(daftar_lowongan(&turso).await.unwrap()["lowongan"][0]["tanggal_hapus"], Value::Null);
            let c = id_dari(simpan_pelamar(&turso, "hrd", &pelamar("Citra")).await.unwrap(), "id_pelamar");
            hapus_pelamar(&turso, &c).await.unwrap();
            assert_eq!(
                (angka("SELECT COUNT(*) FROM hr_pelamar;"), angka("SELECT pelamar_dihapus FROM hr_lowongan;")),
                (1, 2)
            );
        });
    }
}


#[cfg(test)]
mod tests_alur {
    use super::*;

    fn state_uji() -> (tempfile::TempDir, DesktopState) {
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

    fn operator(izin: &[&str]) -> OperatorUser {
        OperatorUser {
            id: 1,
            kode_operator: "hrd".into(),
            nama_operator: "hrd".into(),
            username: "hrd".into(),
            role: "Uji".into(),
            role_id: 9,
            role_key: "uji".into(),
            is_superadmin: false,
            permissions: izin.iter().map(|s| s.to_string()).collect(),
            permission_revision: 1,
            require_scan_photo: false,
            require_scan_ip_allowlist: false,
            totp_enabled: false,
            id_karyawan: None,
            login_at: None,
        }
    }

    /// Alur §22.11 langkah 5: klaim, karyawan + kontrak + dua outbox dalam
    /// satu transaksi, QR `id|token`, tekan kedua tidak menulis ulang, klaim
    /// tanpa karyawan lalu Lanjutkan, pelamar terkunci, kode bentrok ditolak
    /// sebelum klaim, salah satu izin kurang ditolak.
    #[test]
    fn alur_fase7_jadikan_karyawan() {
        let (dir, state) = state_uji();
        let lokal = storage::database(&state.data_dir).expect("db lokal");
        lokal
            .execute_batch(
                "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit)
                   VALUES (1, 1, 'Pagi', '07:00', '15:00', 480);
                 INSERT INTO hr_divisi (id_divisi, nama, is_aktif) VALUES ('div-1', 'Gudang', 1);
                 INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif)
                   VALUES ('EMP_LAMA', 'KLAMA', 'Lama', 'Gudang', 1, 'Aktif');",
            )
            .expect("data lokal");
        let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime uji");
        runtime.block_on(async {
            let hub = dir.path().join("sppg-hub.db");
            let turso = TursoClient::local_file(
                url::Url::parse(super::super::turso::LOCAL_FILE_ORIGIN).expect("origin lokal"),
                &hub,
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("provisioning lokal");
            let cloud = rusqlite::Connection::open(&hub).expect("buka hub");
            let tanggal = |ubah: &str| -> String {
                cloud.query_row("SELECT date('now', '+7 hours', ?1);", [ubah], |r| r.get(0)).unwrap()
            };
            let galat = |hasil: Result<Value, CommandError>| hasil.expect_err("harus ditolak").message;
            let hrd = operator(&IZIN_JADIKAN_KARYAWAN);

            let low = simpan_lowongan(&turso, "hrd", &json!({ "judul": "Staf", "jumlah": 2, "tanggal_buka": tanggal("-30 days") }))
                .await
                .unwrap()["id_lowongan"]
                .as_str()
                .unwrap()
                .to_owned();
            let pelamar_baru = |nama: &str| {
                json!({
                    "id_lowongan": low, "nama": nama, "no_hp": "081234567890", "tanggal_lamaran": tanggal("-20 days"),
                    "tanggal_lahir": "1995-05-05", "alamat": "Jl. Mawar 1", "pendidikan": "S1"
                })
            };
            let p = simpan_pelamar(&turso, "hrd", &pelamar_baru("Ani")).await.unwrap()["id_pelamar"].as_str().unwrap().to_owned();
            let draft = |id_pelamar: &str, kode: Option<&str>| {
                json!({
                    "id_pelamar": id_pelamar,
                    "karyawan": { "nama": "Ani", "kode_karyawan": kode, "id_shift": 1, "id_divisi": "div-1", "lp": "P", "tanggal_daftar": tanggal("+0 days") },
                    "kontrak": { "jenis": "PKWT", "tanggal_mulai": tanggal("+0 days"), "tanggal_selesai": tanggal("+1 year") },
                })
            };

            // Belum Diterima, lalu izin kurang: keduanya ditolak tanpa menulis.
            assert_eq!(
                galat(jadikan_karyawan(&state, &turso, &hrd, &draft(&p, None)).await),
                "Hanya pelamar berstatus Diterima yang bisa dijadikan karyawan."
            );
            catat_tahap(&turso, "hrd", &json!({ "id_pelamar": p, "tahap": "Diterima", "tanggal": tanggal("-1 days") }))
                .await
                .unwrap();
            let kurang = operator(&[IZIN_MANAGE, "employees.manage"]);
            assert_eq!(galat(jadikan_karyawan(&state, &turso, &kurang, &draft(&p, None)).await), "Akses ditolak untuk tindakan ini.");
            // Kode bentrok ditolak di perangkat SEBELUM klaim cloud.
            assert_eq!(
                galat(jadikan_karyawan(&state, &turso, &hrd, &draft(&p, Some("KLAMA"))).await),
                "Kode karyawan KLAMA sudah dipakai karyawan lain."
            );
            let klaim = |id: &str| -> Option<String> {
                cloud.query_row("SELECT id_karyawan FROM hr_pelamar WHERE id_pelamar = ?1;", [id], |r| r.get(0)).unwrap()
            };
            assert_eq!(klaim(&p), None);

            // Jadikan karyawan.
            let id = id_dari_pelamar(&p).unwrap();
            let hasil = jadikan_karyawan(&state, &turso, &hrd, &draft(&p, None)).await.unwrap();
            assert_eq!((hasil["id_unik"].as_str(), hasil["lanjutan"].as_bool()), (Some(id.id_unik.as_str()), Some(false)));
            assert_eq!(hasil["id_kontrak"], json!(id.id_kontrak));
            assert_eq!(klaim(&p).as_deref(), Some(id.id_unik.as_str()));
            let (kode, qr, token, jenis): (String, String, String, String) = lokal
                .query_row(
                    "SELECT kode_karyawan, qr_code, token_absensi, jenis_personil FROM master_data WHERE id_unik = ?1;",
                    [&id.id_unik],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .expect("karyawan lokal");
            assert_eq!(kode, id.kode_karyawan);
            assert_eq!(qr, format!("{}|{token}", id.id_unik), "QR wajib id|token (aturan 31)");
            assert_eq!(jenis, "Kontrak", "jenis personil mengikuti kontrak pertama");
            let outbox = |domain: &str| -> i64 {
                lokal
                    .query_row("SELECT COUNT(*) FROM desktop_sync_outbox WHERE domain = ?1 AND operation = 'create';", [domain], |r| r.get(0))
                    .unwrap()
            };
            assert_eq!((outbox("employee"), outbox("hr-contract")), (1, 1));
            let id_card: i64 = lokal.query_row("SELECT COUNT(*) FROM id_card WHERE id_unik = ?1;", [&id.id_unik], |r| r.get(0)).unwrap();
            assert_eq!(id_card, 1);
            let alamat: String = cloud
                .query_row("SELECT alamat_domisili FROM hr_profil WHERE id_karyawan = ?1;", [&id.id_unik], |r| r.get(0))
                .expect("isian awal profil");
            assert_eq!(alamat, "Jl. Mawar 1");

            // Tekan kedua: karyawan sudah ada di perangkat, tidak ada yang ditulis ulang.
            let lagi = jadikan_karyawan(&state, &turso, &hrd, &draft(&p, None)).await.unwrap();
            assert_eq!(lagi["sudah_ada"], "perangkat");
            assert_eq!((outbox("employee"), outbox("hr-contract")), (1, 1));

            // Pelamar terkunci sesudah menjadi karyawan.
            let ubah = json!({ "id_pelamar": p, "id_lowongan": low, "nama": "Ani B", "tanggal_lamaran": tanggal("-20 days") });
            assert_eq!(galat(simpan_pelamar(&turso, "hrd", &ubah).await), PESAN_SUDAH_KARYAWAN);
            let batal = json!({ "id_pelamar": p, "aksi": "batal", "alasan": "x" });
            assert_eq!(galat(catat_tahap(&turso, "hrd", &batal).await), PESAN_SUDAH_KARYAWAN);
            assert_eq!(galat(hapus_pelamar(&turso, &p).await), "Pelamar yang sudah dijadikan karyawan tidak bisa dihapus.");

            // Klaim terisi tetapi karyawan belum ditulis (aplikasi tertutup di
            // tengah): memanggil ulang = Lanjutkan, dengan id yang sama.
            let q = simpan_pelamar(&turso, "hrd", &pelamar_baru("Budi")).await.unwrap()["id_pelamar"].as_str().unwrap().to_owned();
            catat_tahap(&turso, "hrd", &json!({ "id_pelamar": q, "tahap": "Diterima", "tanggal": tanggal("-1 days") }))
                .await
                .unwrap();
            let id_q = id_dari_pelamar(&q).unwrap();
            cloud
                .execute(KLAIM_PELAMAR_SQL[0], rusqlite::params![q, id_q.id_unik, "perangkat-lain"])
                .expect("klaim saja");
            let mut budi = draft(&q, None);
            budi["karyawan"]["nama"] = json!("Budi");
            let lanjut = jadikan_karyawan(&state, &turso, &hrd, &budi).await.unwrap();
            assert_eq!(lanjut["lanjutan"], json!(true));
            assert_eq!((outbox("employee"), outbox("hr-contract")), (2, 2));

            // Klaim milik karyawan lain (tidak mungkin dari id deterministik,
            // tetapi data lama bisa saja): ditolak.
            let r = simpan_pelamar(&turso, "hrd", &pelamar_baru("Citra")).await.unwrap()["id_pelamar"].as_str().unwrap().to_owned();
            cloud.execute("UPDATE hr_pelamar SET id_karyawan = 'EMP_LAIN' WHERE id_pelamar = ?1;", [&r]).unwrap();
            assert_eq!(galat(jadikan_karyawan(&state, &turso, &hrd, &draft(&r, None)).await), "Pelamar ini sudah dijadikan karyawan.");
        });
    }
}
