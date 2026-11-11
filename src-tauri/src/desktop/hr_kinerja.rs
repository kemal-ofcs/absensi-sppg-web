//! HRIS fase 6 (skema v41): penilaian kinerja (prd-hris.md §21).
//!
//! Enam tabel tersinkron (Q-71). Status, nilai berlaku, dan tanda TIDAK
//! disimpan: semuanya diturunkan dari keputusan append-only. Aturan murni dan
//! SQL di sini cermin `src/lib/validations/hr-kinerja.ts`, diuji dengan vektor
//! yang sama; teks SQL diperiksa harfiah oleh `hr-kinerja.test.ts`.


use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::hr_pengajuan::{self, Kalender, KELOMPOK_TIDAK_HADIR};
use super::{hari_kerja, hris, inventory, scanner, time_policy};

// ── Konstanta (WAJIB sama dengan CHECK DDL v41) ────────────────────────────

pub const PERIODE_JENIS: [&str; 4] = ["Bulanan", "Kuartal", "Semester", "Tahunan"];
pub const TIPE_MANUAL: &str = "Manual";
pub const TIPE_DISIPLIN: &str = "Otomatis Disiplin";
pub const TIPE_ASPEK: [&str; 2] = [TIPE_MANUAL, TIPE_DISIPLIN];
pub const JENIS_KEPUTUSAN: [&str; 4] = ["Ajukan", "Kembalikan", "Final", "Batal"];
pub const AKSI_KINERJA: [&str; 6] = ["Simpan", "Koreksi", "Ajukan", "Kembalikan", "Final", "Batal"];

pub const STATUS_DRAF: &str = "Draf";
pub const STATUS_DIAJUKAN: &str = "Diajukan";
pub const STATUS_FINAL: &str = "Final";
pub const STATUS_DIBATALKAN: &str = "Dibatalkan";

pub const MAKS_NAMA_TEMPLATE: usize = 100;
pub const MAKS_KETERANGAN: usize = 1000;
pub const MAKS_ASPEK: usize = 100;
pub const MAKS_ASPEK_AKTIF: usize = 20;
pub const MAKS_NAMA_ASPEK: usize = 100;
pub const MAKS_PANDUAN: usize = 1000;
pub const MAKS_JABATAN_TEMPLATE: usize = 500;
pub const TOTAL_BOBOT: i64 = 100;
pub const MAKS_CATATAN_ASPEK: usize = 1000;
pub const MAKS_CATATAN: usize = 2000;
pub const MAKS_ALASAN: usize = 500;
pub const MAKS_ALASAN_KOREKSI: usize = 1000;
/// Nilai akhir ×100 (Q-74): 0 sampai 10.000.
pub const NILAI_MAKS: i64 = 10_000;

pub const KUNCI_PERIODE: &str = "hr_kinerja_periode";
pub const KUNCI_AMBANG: &str = "hr_kinerja_ambang_disiplin";
pub const KUNCI_PREDIKAT: &str = "hr_kinerja_predikat";
pub const PERIODE_BAWAAN: &str = "Semester";
/// Permil minimal untuk skor 5, 4, 3, 2.
pub const AMBANG_BAWAAN: [i64; 4] = [950, 900, 800, 700];
pub const PREDIKAT_BAWAAN: &str = "9000:Sangat Baik|7500:Baik|6000:Cukup|4000:Kurang|0:Sangat Kurang";
pub const MAKS_NAMA_PREDIKAT: usize = 50;

pub const PESAN_DIRI_SENDIRI: &str = "Penilaian kinerja dirimu sendiri harus dikerjakan orang lain.";
pub const PESAN_IZIN: &str = "Kamu tidak punya izin untuk aksi penilaian ini.";
pub const PESAN_DISIPLIN_BERUBAH: &str = "Angka disiplin berubah sejak draf disimpan. Periksa angka barunya, lalu ajukan sekali lagi.";
pub const PESAN_AMBANG: &str = "Ambang disiplin harus empat bilangan bulat 1 sampai 1000 yang turun, misalnya 950,900,800,700.";
pub const PESAN_DISIPLIN_MANUAL: &str = "Tidak ada hari yang bisa dinilai untuk aspek disiplin; isi catatan alasan skornya.";

// ── SQL masukan disiplin (§21.6). Argumen selalu ?1 mulai, ?2 selesai, ?3 id.

/// Jadwal satu karyawan, pola `LAPORAN_KEHADIRAN_SQL.karyawan`.
pub const DISIPLIN_KARYAWAN_SQL: &str = "SELECT json_object('id', m.id_unik, 'divisi', COALESCE(m.divisi, ''), 'hari_kerja', sh.hari_kerja, 'kode_shift', sh.kode_shift) FROM master_data m LEFT JOIN tbl_shift sh ON sh.id_shift = m.id_shift WHERE m.id_unik = ?3;";

/// Kolom sama dengan `LAPORAN_KEHADIRAN_SQL.hari`, disaring satu karyawan.
pub const DISIPLIN_HARI_SQL: &str = "SELECT json_object('id', id_karyawan, 'tanggal', tanggal, 'hadir', MAX(CASE WHEN (COALESCE(TRIM(jam_masuk), '') <> '' AND COALESCE(status_kehadiran, '') <> 'Alfa') OR status_kehadiran IN ('Hadir', 'Terlambat') THEN 1 ELSE 0 END), 'telat', MAX(COALESCE(menit_terlambat, 0)), 'menit', SUM(COALESCE(menit_terlambat, 0)), 'sakit', MAX(CASE WHEN status_kehadiran = 'Sakit' THEN 1 ELSE 0 END), 'izin', MAX(CASE WHEN status_kehadiran = 'Izin' THEN 1 ELSE 0 END), 'dispensasi', MAX(CASE WHEN status_kehadiran IN ('Dispen', 'Dispensasi') THEN 1 ELSE 0 END), 'alfa', MAX(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END)) FROM absensi_harian WHERE id_karyawan = ?3 AND tanggal BETWEEN ?1 AND ?2 GROUP BY id_karyawan, tanggal ORDER BY tanggal;";

/// `LAPORAN_PENGAJUAN_SQL` disaring satu karyawan.
pub const DISIPLIN_PENGAJUAN_SQL: &str = concat!(
    "SELECT json_object('id', p.id_karyawan, 'mulai', p.tanggal_mulai, 'selesai', p.tanggal_selesai, 'kelompok', p.kelompok) FROM hr_pengajuan p WHERE p.id_karyawan = ?3 AND p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ",
    super::hr_pengajuan::berlaku_sql!(),
    " ORDER BY p.tanggal_mulai, p.id_pengajuan;"
);

/// `LAPORAN_TUKAR_SQL` disaring satu karyawan.
pub const DISIPLIN_TUKAR_SQL: &str = concat!(
    "SELECT json_object('id', t.id, 'tanggal', t.tanggal, 'hari_kerja', s.hari_kerja, 'kode_shift', s.kode_shift) FROM (SELECT p.id_karyawan AS id, p.tanggal_mulai AS tanggal, p.id_shift_tukar AS id_shift, p.id_pengajuan AS urut FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    super::hr_pengajuan::berlaku_sql!(),
    " UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    super::hr_pengajuan::berlaku_sql!(),
    ") t JOIN tbl_shift s ON s.id_shift = t.id_shift WHERE t.id = ?3 ORDER BY t.tanggal, t.urut;"
);

/// Tanggal WIB laporan perjalanan karyawan ini; batasnya sama dengan
/// `PELAPOR_PERJALANAN_SQL` (D 00:00 WIB = D − 7 jam UTC).
pub const DISIPLIN_PERJALANAN_SQL: &str = "SELECT DISTINCT json_object('tanggal', date(waktu_perangkat, '+7 hours')) FROM drv_laporan WHERE id_karyawan = ?3 AND waktu_perangkat >= datetime(?1, '-7 hours') AND waktu_perangkat < datetime(?2, '+17 hours');";

// ── Pembantu isian ─────────────────────────────────────────────────────────

fn teks(draft: &Value, kunci: &str) -> String {
    match draft.get(kunci) {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn bendera(draft: &Value, kunci: &str) -> bool {
    match draft.get(kunci) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        _ => false,
    }
}

fn panjang(teks: &str) -> usize {
    teks.chars().count()
}

/// Bilangan bulat JSON (bukan teks).
fn bulat(nilai: Option<&Value>) -> Option<i64> {
    let n = nilai?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

fn opsional(draft: &Value, kunci: &str, label: &str, maks: usize) -> Result<Option<String>, String> {
    let t = teks(draft, kunci);
    if panjang(&t) > maks {
        return Err(format!("{label} maksimal {maks} karakter."));
    }
    Ok((!t.is_empty()).then_some(t))
}

fn nama_rapi(masukan: &str, label: &str, maks: usize) -> Result<String, String> {
    let nama = masukan.split_whitespace().collect::<Vec<_>>().join(" ");
    if nama.is_empty() {
        return Err(format!("{label} wajib diisi."));
    }
    if panjang(&nama) > maks {
        return Err(format!("{label} maksimal {maks} karakter."));
    }
    Ok(nama)
}

fn sama_orang(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

// ── Template, aspek, pemetaan (§21.3) ──────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AspekSah {
    /// Kosong = aspek baru; id dibuat pemanggil (`<id_template>:<acak>`).
    pub id_aspek: String,
    pub nama: String,
    pub tipe: String,
    pub bobot: i64,
    pub panduan: Option<String>,
    pub urutan: i64,
    pub is_aktif: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateSah {
    pub nama: String,
    pub keterangan: Option<String>,
    pub is_bawaan: bool,
    pub is_aktif: bool,
    pub aspek: Vec<AspekSah>,
    /// Jabatan yang dipetakan ke template ini.
    pub jabatan: Vec<String>,
}

/// Cermin `validasiTemplate`. Keunikan nama template dan aspek lama dinilai
/// terpisah (`nama_template_dipakai`, `periksa_aspek_lama`).
pub fn validasi_template(draft: &Value) -> Result<TemplateSah, String> {
    let nama = nama_rapi(&teks(draft, "nama"), "Nama template", MAKS_NAMA_TEMPLATE)?;
    let keterangan = opsional(draft, "keterangan", "Keterangan", MAKS_KETERANGAN)?;
    let is_aktif = draft.get("is_aktif").is_none() || bendera(draft, "is_aktif");
    let is_bawaan = bendera(draft, "is_bawaan");
    if is_bawaan && !is_aktif {
        return Err("Template bawaan tidak bisa dinonaktifkan. Jadikan template lain bawaan dulu.".into());
    }
    let daftar = draft.get("aspek").and_then(Value::as_array).cloned().unwrap_or_default();
    if daftar.len() > MAKS_ASPEK {
        return Err(format!("Paling banyak {MAKS_ASPEK} aspek per template."));
    }
    let mut aspek = Vec::new();
    let (mut id_dipakai, mut nama_dipakai) = (HashSet::new(), HashSet::new());
    for (i, a) in daftar.iter().enumerate() {
        let nama = nama_rapi(&teks(a, "nama"), "Nama aspek", MAKS_NAMA_ASPEK)?;
        let id_aspek = teks(a, "id_aspek");
        if !id_aspek.is_empty() && !id_dipakai.insert(id_aspek.clone()) {
            return Err("Aspek ganda dalam satu template.".into());
        }
        let tipe = teks(a, "tipe");
        if !TIPE_ASPEK.contains(&tipe.as_str()) {
            return Err("Tipe aspek harus Manual atau Otomatis Disiplin.".into());
        }
        let bobot = bulat(a.get("bobot"))
            .filter(|b| (1..=TOTAL_BOBOT).contains(b))
            .ok_or_else(|| format!("Bobot aspek {nama} harus bilangan bulat 1 sampai 100."))?;
        let panduan = opsional(a, "panduan", "Panduan aspek", MAKS_PANDUAN)?;
        let is_aktif = a.get("is_aktif").is_none() || bendera(a, "is_aktif");
        if is_aktif && !nama_dipakai.insert(hris::kunci_nama(&nama)) {
            return Err(format!("Nama aspek {nama} dipakai dua kali."));
        }
        aspek.push(AspekSah { id_aspek, nama, tipe, bobot, panduan, urutan: i as i64, is_aktif });
    }
    let aktif: Vec<&AspekSah> = aspek.iter().filter(|a| a.is_aktif).collect();
    if aktif.is_empty() {
        return Err("Template butuh minimal satu aspek aktif.".into());
    }
    if aktif.len() > MAKS_ASPEK_AKTIF {
        return Err(format!("Paling banyak {MAKS_ASPEK_AKTIF} aspek aktif."));
    }
    let total: i64 = aktif.iter().map(|a| a.bobot).sum();
    if total != TOTAL_BOBOT {
        return Err(format!("Total bobot aspek aktif harus 100, sekarang {total}."));
    }
    if aktif.iter().filter(|a| a.tipe == TIPE_DISIPLIN).count() > 1 {
        return Err("Paling banyak satu aspek Otomatis Disiplin.".into());
    }
    let jabatan = match draft.get("jabatan") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(isi)) => {
            let mut hasil: Vec<String> = Vec::new();
            for j in isi {
                let id = j.as_str().map(str::trim).filter(|s| !s.is_empty());
                let Some(id) = id else { return Err("Daftar jabatan tidak valid.".into()) };
                if !hasil.iter().any(|h| h == id) {
                    hasil.push(id.to_owned());
                }
            }
            hasil
        }
        Some(_) => return Err("Daftar jabatan tidak valid.".into()),
    };
    if jabatan.len() > MAKS_JABATAN_TEMPLATE {
        return Err(format!("Paling banyak {MAKS_JABATAN_TEMPLATE} jabatan per template."));
    }
    Ok(TemplateSah { nama, keterangan, is_bawaan, is_aktif, aspek, jabatan })
}

/// Cermin `periksaAspekLama`: aspek tidak pernah dihapus dan tipenya terkunci
/// sejak dibuat (§21.3). `lama` = `(id_aspek, tipe)` yang tersimpan.
pub fn periksa_aspek_lama(baru: &[AspekSah], lama: &[(String, String)]) -> Result<(), String> {
    for a in baru.iter().filter(|a| !a.id_aspek.is_empty()) {
        if !lama.iter().any(|(id, _)| *id == a.id_aspek) {
            return Err("Aspek tidak dikenal; muat ulang template.".into());
        }
    }
    for (id, tipe) in lama {
        match baru.iter().find(|a| a.id_aspek == *id) {
            None => return Err("Aspek lama tidak boleh dihapus; nonaktifkan saja.".into()),
            Some(a) if a.tipe != *tipe => {
                return Err(format!("Tipe aspek {} tidak bisa diubah setelah dibuat.", a.nama))
            }
            _ => {}
        }
    }
    Ok(())
}

/// Cermin `namaTemplateDipakai`: nama dipakai template lain (tanpa `UNIQUE`).
pub fn nama_template_dipakai(nama: &str, id_template: &str, lain: &[(String, String)]) -> bool {
    let kunci = hris::kunci_nama(nama);
    lain.iter().any(|(id, n)| id != id_template && hris::kunci_nama(n) == kunci)
}

/// Cermin `namaGanda`: template yang namanya kembar (kembaran offline).
pub fn nama_ganda(template: &[(String, String)]) -> HashSet<String> {
    template
        .iter()
        .filter(|(id, nama)| nama_template_dipakai(nama, id, template))
        .map(|(id, _)| id.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct TemplateRingkas {
    pub id_template: String,
    pub is_aktif: bool,
    pub is_bawaan: bool,
}

/// Cermin `templateKaryawan` (Q-79): template aktif jabatannya, lalu template
/// bawaan aktif, lalu `None` = belum bisa dinilai.
pub fn template_karyawan(
    id_jabatan: Option<&str>,
    pemetaan: &HashMap<String, Option<String>>,
    template: &[TemplateRingkas],
) -> Option<String> {
    let aktif = |id: &str| template.iter().any(|t| t.id_template == id && t.is_aktif);
    let dipetakan = id_jabatan
        .map(str::trim)
        .filter(|j| !j.is_empty())
        .and_then(|j| pemetaan.get(j))
        .and_then(|t| t.as_deref())
        .filter(|t| aktif(t));
    if let Some(t) = dipetakan {
        return Some(t.to_owned());
    }
    // Dua bawaan hanya mungkin sebelum cloud menyelaraskannya; ambil yang terkecil.
    template
        .iter()
        .filter(|t| t.is_aktif && t.is_bawaan)
        .map(|t| t.id_template.as_str())
        .min()
        .map(str::to_owned)
}

// ── Periode (§21.4) ────────────────────────────────────────────────────────

fn bulan_periode(jenis: &str) -> Option<i64> {
    match jenis {
        "Bulanan" => Some(1),
        "Kuartal" => Some(3),
        "Semester" => Some(6),
        "Tahunan" => Some(12),
        _ => None,
    }
}

fn tahun_bulan_hari(tanggal: &str) -> Option<(i64, i64, i64)> {
    let mut bagian = tanggal.split('-').map(|s| s.parse::<i64>().ok());
    Some((bagian.next()??, bagian.next()??, bagian.next()??))
}

/// Cermin `periodeRentang`: `(mulai, selesai)` kalender; tanggal mulai yang
/// bukan awal periode ditolak.
pub fn periode_rentang(jenis: &str, mulai: &str) -> Result<(String, String), String> {
    let n = bulan_periode(jenis).ok_or("Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.")?;
    let ymd = inventory::is_valid_date(mulai).then(|| tahun_bulan_hari(mulai)).flatten();
    let Some((_, bulan, hari)) = ymd else {
        return Err("Tanggal mulai periode tidak valid.".into());
    };
    if hari != 1 || (bulan - 1) % n != 0 {
        return Err(format!("Tanggal {mulai} bukan awal periode {}.", jenis.to_lowercase()));
    }
    let selesai = hris::tambah_bulan(mulai, n)
        .and_then(|t| time_policy::add_days(&t, -1).ok())
        .ok_or("Tanggal mulai periode tidak valid.")?;
    Ok((mulai.to_owned(), selesai))
}

/// Cermin `awalPeriode`: tanggal mulai periode `jenis` yang memuat `tanggal`.
pub fn awal_periode(jenis: &str, tanggal: &str) -> Option<String> {
    let n = bulan_periode(jenis)?;
    let (tahun, bulan, _) = inventory::is_valid_date(tanggal).then(|| tahun_bulan_hari(tanggal)).flatten()?;
    Some(format!("{tahun:04}-{:02}-01", (bulan - 1) / n * n + 1))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RentangAktif {
    pub mulai: String,
    pub akhir: String,
    /// `false` = tanda `periode_tidak_penuh`.
    pub penuh: bool,
}

/// Cermin `rentangAktif` (Q-80): periode dipotong tanggal masuk dan tanggal
/// selesai aktif. `None` = tidak aktif sama sekali di periode itu.
pub fn rentang_aktif(
    periode_mulai: &str,
    periode_selesai: &str,
    tanggal_daftar: Option<&str>,
    tanggal_selesai_aktif: Option<&str>,
) -> Option<RentangAktif> {
    fn sah(t: Option<&str>) -> Option<&str> {
        t.map(str::trim).filter(|t| inventory::is_valid_date(t))
    }
    let mulai = sah(tanggal_daftar).map_or(periode_mulai, |t| t.max(periode_mulai));
    let akhir = sah(tanggal_selesai_aktif).map_or(periode_selesai, |t| t.min(periode_selesai));
    (mulai <= akhir).then(|| RentangAktif {
        mulai: mulai.to_owned(),
        akhir: akhir.to_owned(),
        penuh: mulai == periode_mulai && akhir == periode_selesai,
    })
}

/// Cermin `periksaBuat` (§21.4): hanya untuk penilaian akar baru.
pub fn periksa_buat(
    aktif: bool,
    sudah_keluar: bool,
    periode_mulai: &str,
    hari_ini: &str,
    rentang: Option<&RentangAktif>,
) -> Result<(), String> {
    if sudah_keluar {
        return Err("Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat.".into());
    }
    if !aktif {
        return Err("Karyawan nonaktif tidak bisa dinilai.".into());
    }
    if periode_mulai > hari_ini {
        return Err("Periode ini belum dimulai.".into());
    }
    if rentang.is_none() {
        return Err("Karyawan ini tidak aktif selama periode itu.".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct RingkasPenilaian {
    pub id_penilaian: String,
    pub id_karyawan: String,
    pub id_ref: Option<String>,
    pub periode_mulai: String,
    pub periode_selesai: String,
    pub dibatalkan: bool,
}

fn akar_hidup(p: &RingkasPenilaian) -> bool {
    p.id_ref.is_none() && !p.dibatalkan
}

/// Cermin `bentrokPeriode` (Q-73): penilaian akar lain karyawan yang sama
/// yang rentangnya bertumpuk, jenis periode apa pun.
pub fn bentrok_periode<'a>(baru: &RingkasPenilaian, lain: &'a [RingkasPenilaian]) -> Option<&'a RingkasPenilaian> {
    if baru.id_ref.is_some() {
        return None;
    }
    lain.iter().find(|p| {
        p.id_penilaian != baru.id_penilaian
            && akar_hidup(p)
            && p.id_karyawan == baru.id_karyawan
            && p.periode_mulai <= baru.periode_selesai
            && p.periode_selesai >= baru.periode_mulai
    })
}

/// Cermin `penilaianGanda`: kembaran offline, tanda `penilaian_ganda`.
pub fn penilaian_ganda(semua: &[RingkasPenilaian]) -> HashSet<String> {
    semua
        .iter()
        .filter(|p| akar_hidup(p) && bentrok_periode(p, semua).is_some())
        .map(|p| p.id_penilaian.clone())
        .collect()
}

/// Cermin `pesanBertumpuk`.
pub fn pesan_bertumpuk(mulai: &str, selesai: &str) -> String {
    format!("Karyawan ini sudah punya penilaian untuk periode {mulai} s.d. {selesai}.")
}

// ── Isian penilaian dan baris nilai (§21.5) ────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct IsianNilai {
    pub id_aspek: String,
    pub skor: Option<i64>,
    pub catatan: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PenilaianSah {
    pub id_karyawan: String,
    pub id_ref: Option<String>,
    pub alasan_koreksi: Option<String>,
    pub periode_jenis: String,
    pub periode_mulai: String,
    pub periode_selesai: String,
    pub catatan: Option<String>,
    pub nilai: Vec<IsianNilai>,
}

/// Cermin `validasiPenilaian`: bentuk isian, tanpa data template.
pub fn validasi_penilaian(draft: &Value) -> Result<PenilaianSah, String> {
    let id_karyawan = teks(draft, "id_karyawan");
    if id_karyawan.is_empty() {
        return Err("Pilih karyawan.".into());
    }
    let periode_jenis = teks(draft, "periode_jenis");
    let (periode_mulai, periode_selesai) = periode_rentang(&periode_jenis, &teks(draft, "periode_mulai"))?;
    let catatan = opsional(draft, "catatan", "Catatan penilaian", MAKS_CATATAN)?;
    let id_ref = Some(teks(draft, "id_ref")).filter(|s| !s.is_empty());
    let alasan = opsional(draft, "alasan_koreksi", "Alasan koreksi", MAKS_ALASAN_KOREKSI)?;
    if id_ref.is_some() && alasan.is_none() {
        return Err("Alasan koreksi wajib diisi.".into());
    }
    let daftar = match draft.get("nilai") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(isi)) => isi.clone(),
        Some(_) => return Err("Isian nilai tidak valid.".into()),
    };
    if daftar.len() > MAKS_ASPEK {
        return Err("Isian nilai tidak valid.".into());
    }
    let mut nilai: Vec<IsianNilai> = Vec::new();
    for n in &daftar {
        let id_aspek = teks(n, "id_aspek");
        if id_aspek.is_empty() {
            return Err("Isian nilai tidak valid.".into());
        }
        if nilai.iter().any(|x| x.id_aspek == id_aspek) {
            return Err("Aspek ganda dalam isian nilai.".into());
        }
        let skor = match n.get("skor") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.trim().is_empty() => None,
            lain => Some(bulat(lain).filter(|s| (1..=5).contains(s)).ok_or("Skor harus bilangan bulat 1 sampai 5.")?),
        };
        let catatan = opsional(n, "catatan", "Catatan aspek", MAKS_CATATAN_ASPEK)?;
        nilai.push(IsianNilai { id_aspek, skor, catatan });
    }
    Ok(PenilaianSah {
        id_karyawan,
        alasan_koreksi: id_ref.as_ref().and(alasan),
        id_ref,
        periode_jenis,
        periode_mulai,
        periode_selesai,
        catatan,
        nilai,
    })
}

/// Satu baris `hr_kinerja_nilai` tanpa `id_nilai`/`id_penilaian`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BarisNilai {
    pub id_aspek: String,
    pub aspek_nama: String,
    pub tipe: String,
    pub bobot: i64,
    pub urutan: i64,
    pub skor: Option<i64>,
    pub catatan: Option<String>,
    pub rincian: Option<String>,
}

pub fn id_nilai(id_penilaian: &str, id_aspek: &str) -> String {
    format!("{id_penilaian}:{id_aspek}")
}

/// Cermin `salinanAspek` (Q-78): aspek aktif template disalin saat dibuat.
pub fn salinan_aspek(aspek: &[AspekSah]) -> Vec<BarisNilai> {
    let mut aktif: Vec<&AspekSah> = aspek.iter().filter(|a| a.is_aktif).collect();
    aktif.sort_by(|a, b| (a.urutan, &a.id_aspek).cmp(&(b.urutan, &b.id_aspek)));
    aktif
        .into_iter()
        .map(|a| BarisNilai {
            id_aspek: a.id_aspek.clone(),
            aspek_nama: a.nama.clone(),
            tipe: a.tipe.clone(),
            bobot: a.bobot,
            urutan: a.urutan,
            skor: None,
            catatan: None,
            rincian: None,
        })
        .collect()
}

/// Cermin `muatUlangTemplate`: baris dari template kini; skor dan catatan
/// aspek yang masih ada dipertahankan.
pub fn muat_ulang_template(baru: Vec<BarisNilai>, lama: &[BarisNilai]) -> Vec<BarisNilai> {
    baru.into_iter()
        .map(|mut b| {
            if let Some(l) = lama.iter().find(|l| l.id_aspek == b.id_aspek) {
                b.skor = l.skor;
                b.catatan = l.catatan.clone();
            }
            b
        })
        .collect()
}

/// Cermin `susunNilai`: isian dipasang ke baris salinan. Aspek Otomatis
/// Disiplin diisi sistem, kecuali tidak ada hari yang dinilai (D = 0).
pub fn susun_nilai(baris: &[BarisNilai], isian: &[IsianNilai], disiplin: Option<&Disiplin>) -> Result<Vec<BarisNilai>, String> {
    if isian.iter().any(|i| !baris.iter().any(|b| b.id_aspek == i.id_aspek)) {
        return Err("Aspek penilaian tidak dikenal; muat ulang template.".into());
    }
    let mut hasil = Vec::new();
    for b in baris {
        let isi = isian.iter().find(|i| i.id_aspek == b.id_aspek);
        let mut baru = b.clone();
        baru.skor = isi.and_then(|i| i.skor);
        baru.catatan = isi.and_then(|i| i.catatan.clone());
        baru.rincian = None;
        if b.tipe == TIPE_DISIPLIN {
            let d = disiplin.ok_or("Angka disiplin belum dihitung.")?;
            baru.rincian = Some(d.rincian.clone());
            match d.skor {
                Some(skor) => baru.skor = Some(skor),
                None if baru.skor.is_some() && baru.catatan.is_none() => return Err(PESAN_DISIPLIN_MANUAL.into()),
                None => {}
            }
        }
        hasil.push(baru);
    }
    Ok(hasil)
}

pub fn skor_lengkap(baris: &[BarisNilai]) -> bool {
    !baris.is_empty() && baris.iter().all(|b| b.skor.is_some())
}

/// Isi yang ikut sidik. Penilai tidak ikut.
#[derive(Debug, Clone, PartialEq)]
pub struct IsiPenilaian<'a> {
    pub id_karyawan: &'a str,
    pub id_ref: Option<&'a str>,
    pub periode_mulai: &'a str,
    pub periode_selesai: &'a str,
    pub id_template: &'a str,
    pub catatan: Option<&'a str>,
    pub nilai: &'a [BarisNilai],
}

/// Cermin `kanonikPenilaian`: digabung `\u{1f}`, baris nilai urut
/// `(urutan, id_aspek)`.
pub fn kanonik_penilaian(isi: &IsiPenilaian<'_>) -> String {
    let mut bagian: Vec<String> = [
        isi.id_karyawan,
        isi.id_ref.unwrap_or(""),
        isi.periode_mulai,
        isi.periode_selesai,
        isi.id_template,
        isi.catatan.unwrap_or(""),
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let mut nilai: Vec<&BarisNilai> = isi.nilai.iter().collect();
    nilai.sort_by(|a, b| (a.urutan, &a.id_aspek).cmp(&(b.urutan, &b.id_aspek)));
    for n in nilai {
        bagian.extend([
            n.id_aspek.clone(),
            n.tipe.clone(),
            n.bobot.to_string(),
            n.skor.map(|s| s.to_string()).unwrap_or_default(),
            n.catatan.clone().unwrap_or_default(),
            n.rincian.clone().unwrap_or_default(),
        ]);
    }
    bagian.join("\u{1f}")
}

/// Cermin `sidikPenilaian` (service TS): SHA-256 hex teks kanonik.
pub fn sidik_penilaian(isi: &IsiPenilaian<'_>) -> String {
    hex::encode(Sha256::digest(kanonik_penilaian(isi).as_bytes()))
}

// ── Status, aksi, tanda (§21.5) ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct KeputusanKinerja {
    pub id_keputusan: String,
    pub jenis: String,
    pub sidik: String,
    pub oleh: String,
    pub waktu_perangkat: String,
    pub diterima_cloud: Option<String>,
    #[serde(default)]
    pub nilai_akhir: Option<i64>,
    #[serde(default)]
    pub predikat: Option<String>,
}

/// Urutan sama dengan `hr_pengajuan::urut_keputusan`: jam cloud dulu.
fn urut(a: &KeputusanKinerja, b: &KeputusanKinerja) -> Ordering {
    (a.diterima_cloud.is_none(), &a.diterima_cloud, &a.waktu_perangkat, &a.id_keputusan).cmp(&(
        b.diterima_cloud.is_none(),
        &b.diterima_cloud,
        &b.waktu_perangkat,
        &b.id_keputusan,
    ))
}

/// Cermin `finalBerlaku`: `Final` pertama yang sidiknya cocok.
pub fn final_berlaku<'a>(sidik: &str, keputusan: &'a [KeputusanKinerja]) -> Option<&'a KeputusanKinerja> {
    keputusan
        .iter()
        .filter(|k| k.jenis == "Final" && k.sidik == sidik)
        .min_by(|a, b| urut(a, b))
}

/// Cermin `statusKinerja` (§21.5, berurutan).
pub fn status_kinerja(sidik: &str, keputusan: &[KeputusanKinerja]) -> &'static str {
    if keputusan.iter().any(|k| k.jenis == "Batal") {
        return STATUS_DIBATALKAN;
    }
    if final_berlaku(sidik, keputusan).is_some() {
        return STATUS_FINAL;
    }
    let terakhir = |jenis: &str| {
        keputusan
            .iter()
            .filter(|k| k.jenis == jenis && k.sidik == sidik)
            .max_by(|a, b| urut(a, b))
    };
    match (terakhir("Ajukan"), terakhir("Kembalikan")) {
        (Some(a), Some(k)) if urut(a, k) == Ordering::Greater => STATUS_DIAJUKAN,
        (Some(_), None) => STATUS_DIAJUKAN,
        _ => STATUS_DRAF,
    }
}

/// Keadaan yang menentukan boleh-tidaknya satu aksi. Semua dinilai backend.
#[derive(Debug, Clone, Default)]
pub struct KeadaanKinerja {
    /// Status penilaian; kosong = belum ada (penilaian baru).
    pub status: String,
    /// Penilaian ini koreksi (`id_ref` terisi).
    pub koreksi: bool,
    /// `master_operator.id_karyawan` sesi = karyawan yang dinilai.
    pub karyawan_sendiri: bool,
    pub boleh_assess: bool,
    pub boleh_finalize: bool,
    pub skor_lengkap: bool,
    /// `periode_selesai` ≤ hari ini (tanggal WIB perangkat).
    pub periode_selesai: bool,
    /// `rincian` disiplin tersimpan = hitungan saat ini.
    pub disiplin_sama: bool,
    /// Untuk `Koreksi`: akar berstatus Final dan belum punya koreksi terbuka.
    pub akar_final: bool,
    pub koreksi_terbuka: bool,
}

/// Cermin `periksaAksiKinerja` (§21.5). `Koreksi` = membuat koreksi atas akar.
pub fn periksa_aksi_kinerja(aksi: &str, alasan: &str, k: &KeadaanKinerja) -> Result<(), String> {
    if !AKSI_KINERJA.contains(&aksi) {
        return Err("Aksi penilaian tidak dikenal.".into());
    }
    if panjang(alasan.trim()) > MAKS_ALASAN {
        return Err(format!("Alasan maksimal {MAKS_ALASAN} karakter."));
    }
    if k.karyawan_sendiri {
        return Err(PESAN_DIRI_SENDIRI.into());
    }
    let tanpa_alasan = alasan.trim().is_empty();
    // Koreksi diisi pemegang assess atau finalize (§21.7).
    let pengisi = k.boleh_assess || (k.koreksi && k.boleh_finalize);
    match aksi {
        "Simpan" => {
            if !pengisi {
                return Err(PESAN_IZIN.into());
            }
            if !(k.status.is_empty() || k.status == STATUS_DRAF) {
                return Err("Penilaian yang sudah diajukan atau selesai tidak bisa disunting.".into());
            }
        }
        "Koreksi" => {
            if !k.boleh_finalize {
                return Err(PESAN_IZIN.into());
            }
            if !k.akar_final {
                return Err("Koreksi hanya untuk penilaian yang sudah final.".into());
            }
            if k.koreksi_terbuka {
                return Err("Penilaian ini masih punya koreksi yang belum selesai.".into());
            }
        }
        "Ajukan" => {
            if !pengisi {
                return Err(PESAN_IZIN.into());
            }
            if k.status != STATUS_DRAF {
                return Err("Hanya draf yang bisa diajukan.".into());
            }
            if !k.skor_lengkap {
                return Err("Isi skor semua aspek sebelum mengajukan.".into());
            }
            if !k.periode_selesai {
                return Err("Penilaian baru bisa diajukan sejak hari terakhir periode.".into());
            }
            if !k.disiplin_sama {
                return Err(PESAN_DISIPLIN_BERUBAH.into());
            }
        }
        "Kembalikan" | "Final" => {
            if !k.boleh_finalize {
                return Err(PESAN_IZIN.into());
            }
            if k.status != STATUS_DIAJUKAN {
                return Err("Penilaian ini tidak sedang diajukan.".into());
            }
            if aksi == "Kembalikan" && tanpa_alasan {
                return Err("Alasan pengembalian wajib diisi.".into());
            }
        }
        _ => {
            if !(k.boleh_assess || k.boleh_finalize) {
                return Err(PESAN_IZIN.into());
            }
            if k.status == STATUS_FINAL {
                return Err("Penilaian final tidak bisa dibatalkan; buat koreksi.".into());
            }
            if k.status != STATUS_DRAF && k.status != STATUS_DIAJUKAN {
                return Err("Penilaian ini sudah dibatalkan.".into());
            }
            if tanpa_alasan {
                return Err("Alasan pembatalan wajib diisi.".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct InfoTanda<'a> {
    pub sidik: &'a str,
    pub keputusan: &'a [KeputusanKinerja],
    pub penilai_oleh: &'a str,
    pub id_penilai: Option<&'a str>,
    /// `master_data.id_atasan` karyawan yang dinilai.
    pub id_atasan: Option<&'a str>,
    /// `rincian` baris Otomatis Disiplin, bila ada.
    pub rincian_disiplin: Option<&'a str>,
    pub periode_penuh: bool,
    /// Hasil `penilaian_ganda`.
    pub ganda: bool,
}

/// Cermin `tandaKinerja`. `disiplin_berubah` dihitung terpisah di rincian.
pub fn tanda_kinerja(i: &InfoTanda<'_>) -> Vec<&'static str> {
    let status = status_kinerja(i.sidik, i.keputusan);
    let ada_final = i.keputusan.iter().any(|k| k.jenis == "Final");
    let mut tanda = Vec::new();
    if i.ganda {
        tanda.push("penilaian_ganda");
    }
    if status != STATUS_DIBATALKAN && ada_final && final_berlaku(i.sidik, i.keputusan).is_none() {
        tanda.push("final_gugur");
    }
    if status == STATUS_DIBATALKAN && ada_final {
        tanda.push("final_dibatalkan");
    }
    if status == STATUS_FINAL
        && final_berlaku(i.sidik, i.keputusan).is_some_and(|k| sama_orang(&k.oleh, i.penilai_oleh))
    {
        tanda.push("dinilai_dan_difinalkan_sama");
    }
    if let Some(atasan) = i.id_atasan.map(str::trim).filter(|a| !a.is_empty()) {
        if i.id_penilai.map(str::trim) != Some(atasan) {
            tanda.push("bukan_atasan_langsung");
        }
    }
    if i.rincian_disiplin.is_some_and(|r| r.starts_with("0|")) {
        tanda.push("disiplin_manual");
    }
    if !i.periode_penuh {
        tanda.push("periode_tidak_penuh");
    }
    tanda
}

/// Cermin `kinerjaBerlaku` (§21.7): di antara akar dan koreksinya yang Final,
/// yang keputusan `Final`-nya paling akhir.
pub fn kinerja_berlaku<'a>(kandidat: &[(&'a str, &KeputusanKinerja)]) -> Option<&'a str> {
    kandidat.iter().max_by(|a, b| urut(a.1, b.1)).map(|(id, _)| *id)
}

// ── Disiplin otomatis (§21.6) ──────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct KaryawanDisiplin {
    pub divisi: String,
    pub hari_kerja: Option<String>,
    pub kode_shift: Option<i64>,
}

/// Satu tanggal `DISIPLIN_HARI_SQL`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HariDisiplin {
    pub tanggal: String,
    pub hadir: bool,
    /// `MAX(menit_terlambat) > 0`.
    pub telat: bool,
    pub sakit: bool,
    pub izin: bool,
    pub dispensasi: bool,
    pub alfa: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PengajuanDisiplin {
    pub mulai: String,
    pub selesai: String,
    pub kelompok: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TukarDisiplin {
    pub tanggal: String,
    pub hari_kerja: Option<String>,
    pub kode_shift: Option<i64>,
}

fn angka_json(nilai: Option<&Value>) -> Option<i64> {
    match nilai? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn teks_json(nilai: Option<&Value>) -> Option<String> {
    nilai.and_then(Value::as_str).map(str::to_owned)
}

impl KaryawanDisiplin {
    pub fn dari_json(v: &Value) -> Self {
        Self {
            divisi: teks_json(v.get("divisi")).unwrap_or_default(),
            hari_kerja: teks_json(v.get("hari_kerja")),
            kode_shift: angka_json(v.get("kode_shift")),
        }
    }
}

impl HariDisiplin {
    pub fn dari_json(v: &Value) -> Self {
        let satu = |k: &str| angka_json(v.get(k)) == Some(1);
        Self {
            tanggal: teks_json(v.get("tanggal")).unwrap_or_default(),
            hadir: satu("hadir"),
            telat: angka_json(v.get("telat")).unwrap_or(0) > 0,
            sakit: satu("sakit"),
            izin: satu("izin"),
            dispensasi: satu("dispensasi"),
            alfa: satu("alfa"),
        }
    }
}

impl PengajuanDisiplin {
    pub fn dari_json(v: &Value) -> Self {
        Self {
            mulai: teks_json(v.get("mulai")).unwrap_or_default(),
            selesai: teks_json(v.get("selesai")).unwrap_or_default(),
            kelompok: teks_json(v.get("kelompok")).unwrap_or_default(),
        }
    }
}

impl TukarDisiplin {
    pub fn dari_json(v: &Value) -> Self {
        Self {
            tanggal: teks_json(v.get("tanggal")).unwrap_or_default(),
            hari_kerja: teks_json(v.get("hari_kerja")),
            kode_shift: angka_json(v.get("kode_shift")),
        }
    }
}

pub struct MasukanDisiplin<'a> {
    /// Rentang aktif (§21.4); dipotong `hari_ini`.
    pub mulai: &'a str,
    pub selesai: &'a str,
    pub hari_ini: &'a str,
    pub karyawan: &'a KaryawanDisiplin,
    pub hari: &'a [HariDisiplin],
    pub pengajuan: &'a [PengajuanDisiplin],
    pub tukar: &'a [TukarDisiplin],
    /// Tanggal WIB berlaporan perjalanan.
    pub perjalanan: &'a HashSet<String>,
    pub kalender: &'a Kalender,
    pub ambang: [i64; 4],
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Disiplin {
    /// D = tepat + telat + alfa + kosong.
    pub hari: i64,
    pub tepat: i64,
    pub telat: i64,
    pub alfa: i64,
    pub kosong: i64,
    pub dikecualikan: i64,
    /// Permil; `None` bila D = 0.
    pub permil: Option<i64>,
    pub ambang: [i64; 4],
    /// `None` bila D = 0: penilai mengisi manual dengan catatan.
    pub skor: Option<i64>,
    /// `D|tepat|telat|alfa|kosong|dikecualikan|P|a5,a4,a3,a2`; P kosong bila D = 0.
    pub rincian: String,
}

/// Kode catatan satu tanggal, sama dengan `kodeTercatat` laporan kehadiran.
fn kode_tercatat(hari: Option<&HariDisiplin>) -> Option<&'static str> {
    let h = hari?;
    if h.hadir {
        return Some(if h.telat { "T" } else { "H" });
    }
    [(h.sakit, "S"), (h.izin, "I"), (h.dispensasi, "D"), (h.alfa, "A")]
        .into_iter()
        .find(|(ada, _)| *ada)
        .map(|(_, kode)| kode)
}

/// Cermin `skorDisiplin`: permil ke skor lewat ambang (a5, a4, a3, a2).
pub fn skor_disiplin(permil: i64, ambang: [i64; 4]) -> i64 {
    ambang.iter().position(|a| permil >= *a).map_or(1, |i| 5 - i as i64)
}

/// Cermin `hitungDisiplin` (Q-75, Q-76). Urutan klasifikasi per tanggal sama
/// dengan `susunLaporanKehadiran`, ditambah hari perjalanan sebagai tepat.
pub fn hitung_disiplin(m: &MasukanDisiplin<'_>) -> Disiplin {
    let akhir = m.selesai.min(m.hari_ini);
    let tanggal = if m.mulai <= akhir { hr_pengajuan::tanggal_rentang(m.mulai, akhir) } else { Vec::new() };
    let catatan: HashMap<&str, &HariDisiplin> = m.hari.iter().map(|h| (h.tanggal.as_str(), h)).collect();
    let mut tukar: HashMap<&str, &TukarDisiplin> = HashMap::new();
    for t in m.tukar {
        tukar.entry(t.tanggal.as_str()).or_insert(t);
    }
    let dijadwalkan = |t: &str| {
        let (hari_kerja, kode_shift) = tukar
            .get(t)
            .map_or((m.karyawan.hari_kerja.as_deref(), m.karyawan.kode_shift), |x| {
                (x.hari_kerja.as_deref(), x.kode_shift)
            });
        let libur = m.kalender.libur.contains(t);
        let masuk_saat_libur = libur
            && scanner::evaluate_holiday_scan(&m.kalender.whitelist, t, &m.karyawan.divisi, kode_shift).is_some();
        hari_kerja::wajib_masuk(t, &hari_kerja::parse_hari_kerja(hari_kerja), libur, masuk_saat_libur)
    };
    let ajuan = |t: &str| {
        m.pengajuan.iter().any(|p| {
            KELOMPOK_TIDAK_HADIR.contains(&p.kelompok.as_str()) && p.mulai.as_str() <= t && t <= p.selesai.as_str()
        })
    };
    let (mut tepat, mut telat, mut alfa, mut kosong, mut dikecualikan) = (0, 0, 0, 0, 0);
    for t in &tanggal {
        let t = t.as_str();
        match kode_tercatat(catatan.get(t).copied()) {
            Some("H") => tepat += 1,
            Some("T") => telat += 1,
            _ if m.perjalanan.contains(t) => tepat += 1,
            kode if ajuan(t) && (kode.is_some() || dijadwalkan(t)) => dikecualikan += 1,
            Some("S" | "I" | "D") => dikecualikan += 1,
            Some(_) => alfa += 1,
            None if dijadwalkan(t) => kosong += 1,
            None => {}
        }
    }
    let hari = tepat + telat + alfa + kosong;
    let permil = (hari > 0).then(|| (2 * tepat + telat) * 1000 / (2 * hari));
    let a = m.ambang;
    let rincian = format!(
        "{hari}|{tepat}|{telat}|{alfa}|{kosong}|{dikecualikan}|{}|{},{},{},{}",
        permil.map(|p| p.to_string()).unwrap_or_default(),
        a[0],
        a[1],
        a[2],
        a[3]
    );
    Disiplin {
        hari,
        tepat,
        telat,
        alfa,
        kosong,
        dikecualikan,
        permil,
        ambang: a,
        skor: permil.map(|p| skor_disiplin(p, a)),
        rincian,
    }
}

/// Cermin `rincianSah`: bentuk `rincian` yang diterima backend dan cloud.
pub fn rincian_sah(rincian: &str) -> bool {
    let bagian: Vec<&str> = rincian.split('|').collect();
    if bagian.len() != 8 {
        return false;
    }
    let digit = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let angka: Option<Vec<i64>> = bagian[..6]
        .iter()
        .map(|s| if digit(s) { s.parse::<i64>().ok() } else { None })
        .collect();
    let Some(angka) = angka else {
        return false;
    };
    if angka[0] != angka[1] + angka[2] + angka[3] + angka[4] {
        return false;
    }
    let permil_sah = match (angka[0], bagian[6]) {
        (0, p) => p.is_empty(),
        (_, p) => digit(p) && p.parse::<i64>().is_ok_and(|n| n <= 1000),
    };
    permil_sah && baca_ambang(bagian[7]).is_ok()
}

// ── Nilai akhir dan predikat (§21.7) ───────────────────────────────────────

/// Cermin `nilaiAkhir` (Q-74): Σ bobot × 25 × (skor − 1), ×100, tanpa
/// pembulatan. `None` bila ada skor kosong.
pub fn nilai_akhir(baris: &[BarisNilai]) -> Option<i64> {
    baris.iter().try_fold(0, |total, b| Some(total + b.bobot * 25 * (b.skor? - 1)))
}

/// Cermin `formatNilai`: 7750 → `77,50`.
pub fn format_nilai(nilai: i64) -> String {
    format!("{},{:02}", nilai / 100, nilai % 100)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Predikat {
    /// Nilai akhir ×100 minimal.
    pub ambang: i64,
    pub nama: String,
}

/// Cermin `predikatNilai`: pasangan pertama yang ambangnya ≤ nilai.
pub fn predikat(nilai: i64, daftar: &[Predikat]) -> String {
    daftar
        .iter()
        .find(|p| p.ambang <= nilai)
        .or(daftar.last())
        .map(|p| p.nama.clone())
        .unwrap_or_default()
}

// ── Pengaturan (§21.2) ─────────────────────────────────────────────────────

/// Cermin `bacaAmbang`.
pub fn baca_ambang(teks: &str) -> Result<[i64; 4], String> {
    let angka: Vec<Option<i64>> = teks.split(',').map(|s| s.trim().parse::<i64>().ok()).collect();
    let angka: Option<Vec<i64>> = angka.into_iter().collect();
    match angka.as_deref() {
        Some([a5, a4, a3, a2])
            if (1..=1000).contains(a5) && a5 > a4 && a4 > a3 && a3 > a2 && *a2 >= 1 =>
        {
            Ok([*a5, *a4, *a3, *a2])
        }
        _ => Err(PESAN_AMBANG.into()),
    }
}

/// Cermin `bacaPredikat`.
pub fn baca_predikat(teks: &str) -> Result<Vec<Predikat>, String> {
    let bagian: Vec<&str> = teks.split('|').collect();
    if !(2..=7).contains(&bagian.len()) {
        return Err("Predikat harus 2 sampai 7 tingkat.".into());
    }
    let mut hasil: Vec<Predikat> = Vec::new();
    for b in bagian {
        let Some((ambang, nama)) = b.split_once(':') else {
            return Err("Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.".into());
        };
        let Some(ambang) = ambang.trim().parse::<i64>().ok().filter(|a| (0..=NILAI_MAKS).contains(a)) else {
            return Err("Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.".into());
        };
        let nama = nama.trim();
        if nama.is_empty() || panjang(nama) > MAKS_NAMA_PREDIKAT || nama.contains(':') {
            return Err("Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.".into());
        }
        if hasil.last().is_some_and(|p| p.ambang <= ambang) {
            return Err("Ambang predikat harus turun dan yang terakhir 0.".into());
        }
        hasil.push(Predikat { ambang, nama: nama.to_owned() });
    }
    if hasil.last().map(|p| p.ambang) != Some(0) {
        return Err("Ambang predikat harus turun dan yang terakhir 0.".into());
    }
    Ok(hasil)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PengaturanKinerja {
    pub periode: String,
    pub ambang: [i64; 4],
    pub predikat: Vec<Predikat>,
}

impl PengaturanKinerja {
    /// Cermin `pengaturanKinerjaDariPeta`. Kosong atau rusak = bawaan.
    pub fn dari_peta(peta: &HashMap<String, String>) -> Self {
        let periode = peta
            .get(KUNCI_PERIODE)
            .map(|v| v.trim())
            .filter(|v| PERIODE_JENIS.contains(v))
            .unwrap_or(PERIODE_BAWAAN)
            .to_owned();
        let ambang = peta.get(KUNCI_AMBANG).and_then(|v| baca_ambang(v).ok()).unwrap_or(AMBANG_BAWAAN);
        let predikat = peta
            .get(KUNCI_PREDIKAT)
            .and_then(|v| baca_predikat(v).ok())
            .unwrap_or_else(|| baca_predikat(PREDIKAT_BAWAAN).expect("predikat bawaan sah"));
        Self { periode, ambang, predikat }
    }
}

/// Cermin `validasiPengaturanKinerja`: pasangan kunci-nilai kanonik siap
/// disimpan lewat `setting/update`. Tidak lewat `BATAS_PENGATURAN`.
pub fn validasi_pengaturan_kinerja(draft: &Value) -> Result<Vec<(&'static str, String)>, String> {
    let periode = teks(draft, KUNCI_PERIODE);
    if !PERIODE_JENIS.contains(&periode.as_str()) {
        return Err("Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.".into());
    }
    let ambang = baca_ambang(&teks(draft, KUNCI_AMBANG))?;
    let predikat = baca_predikat(&teks(draft, KUNCI_PREDIKAT))?;
    Ok(vec![
        (KUNCI_PERIODE, periode),
        (KUNCI_AMBANG, ambang.map(|a| a.to_string()).join(",")),
        (
            KUNCI_PREDIKAT,
            predikat.iter().map(|p| format!("{}:{}", p.ambang, p.nama)).collect::<Vec<_>>().join("|"),
        ),
    ])
}

// ── Handler cloud (§21.2; tidak pernah menolak karena aturan bisnis) ───────
//
// Hanya bentuk dan CHECK yang diperiksa; payload cacat = tanpa statement
// (konflik, aturan 5). Aturan bisnis sudah dinilai perangkat pengirim.

/// Upsert template; nama, keterangan, status, dan bawaan siapa terakhir menang.
pub const CLOUD_UPSERT_TEMPLATE_SQL: &str = "INSERT INTO hr_kinerja_template (id_template, nama, keterangan, is_bawaan, is_aktif, diubah_oleh, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, datetime('now')), datetime('now')) ON CONFLICT(id_template) DO UPDATE SET nama = excluded.nama, keterangan = excluded.keterangan, is_bawaan = excluded.is_bawaan, is_aktif = excluded.is_aktif, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now');";

/// Paling banyak satu bawaan (aturan 34): yang terakhir sampai menang.
pub const CLOUD_SATU_BAWAAN_SQL: &str = "UPDATE hr_kinerja_template SET is_bawaan = 0, updated_at = datetime('now') WHERE is_bawaan = 1 AND id_template <> ?1;";

/// `tipe` dan `id_template` aspek terkunci sejak dibuat (§21.3).
pub const CLOUD_UPSERT_ASPEK_SQL: &str = "INSERT INTO hr_kinerja_aspek (id_aspek, id_template, nama, tipe, bobot, panduan, urutan, is_aktif, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, datetime('now')), datetime('now')) ON CONFLICT(id_aspek) DO UPDATE SET nama = excluded.nama, bobot = excluded.bobot, panduan = excluded.panduan, urutan = excluded.urutan, is_aktif = excluded.is_aktif, updated_at = datetime('now');";

/// Pemetaan jabatan. Melepas (`id_template` kosong) hanya berlaku bila
/// jabatan itu masih milik template pengirim (`?4`): pemindahan dari
/// perangkat lain tidak ikut terlepas.
pub const CLOUD_UPSERT_JABATAN_SQL: &str = "INSERT INTO hr_kinerja_jabatan (id_jabatan, id_template, diubah_oleh, updated_at) VALUES (?1, ?2, ?3, datetime('now')) ON CONFLICT(id_jabatan) DO UPDATE SET id_template = excluded.id_template, diubah_oleh = excluded.diubah_oleh, updated_at = datetime('now') WHERE excluded.id_template IS NOT NULL OR hr_kinerja_jabatan.id_template = ?4;";

/// Penilaian ditulis hanya selama belum punya `Final`/`Batal` di cloud (pola
/// servis); event yang kalah dilewati, tidak ditolak. Karyawan, koreksi,
/// periode, dan pembuat tidak pernah berubah.
pub const CLOUD_UPSERT_PENILAIAN_SQL: &str = "INSERT INTO hr_kinerja_penilaian (id_penilaian, id_karyawan, id_ref, alasan_koreksi, periode_jenis, periode_mulai, periode_selesai, id_template, template_nama, id_jabatan, jabatan_nama, id_penilai, penilai_oleh, catatan, sidik, dibuat_oleh, waktu_perangkat, created_at, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, COALESCE(?18, datetime('now')), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?1 AND k.jenis IN ('Final', 'Batal')) ON CONFLICT(id_penilaian) DO UPDATE SET alasan_koreksi = excluded.alasan_koreksi, id_template = excluded.id_template, template_nama = excluded.template_nama, id_jabatan = excluded.id_jabatan, jabatan_nama = excluded.jabatan_nama, id_penilai = excluded.id_penilai, penilai_oleh = excluded.penilai_oleh, catatan = excluded.catatan, sidik = excluded.sidik, waktu_perangkat = excluded.waktu_perangkat, updated_at = datetime('now');";

/// Baris nilai yang tidak ada di payload dibuang (muat ulang template).
pub const CLOUD_BUANG_NILAI_SQL: &str = "DELETE FROM hr_kinerja_nilai WHERE id_penilaian = ?1 AND id_nilai NOT IN (SELECT value FROM json_each(?2)) AND NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?1 AND k.jenis IN ('Final', 'Batal'));";

pub const CLOUD_UPSERT_NILAI_SQL: &str = "INSERT INTO hr_kinerja_nilai (id_nilai, id_penilaian, id_aspek, aspek_nama, tipe, bobot, urutan, skor, catatan, rincian) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan k WHERE k.id_penilaian = ?2 AND k.jenis IN ('Final', 'Batal')) ON CONFLICT(id_nilai) DO UPDATE SET aspek_nama = excluded.aspek_nama, tipe = excluded.tipe, bobot = excluded.bobot, urutan = excluded.urutan, skor = excluded.skor, catatan = excluded.catatan, rincian = excluded.rincian;";

/// Append-only, kiriman ulang berhenti di PK; `diterima_cloud` jam cloud.
pub const CLOUD_INSERT_KEPUTUSAN_SQL: &str = "INSERT INTO hr_kinerja_keputusan (id_keputusan, id_penilaian, jenis, sidik, alasan, nilai_akhir, predikat, oleh, waktu_perangkat, diterima_cloud, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), COALESCE(?10, datetime('now'))) ON CONFLICT(id_keputusan) DO NOTHING;";

type Statements = Vec<(&'static str, Vec<Value>)>;

fn nol_satu(row: &Value, kunci: &str) -> Option<i64> {
    row.get(kunci).and_then(Value::as_i64).filter(|n| *n == 0 || *n == 1)
}

fn dalam(row: &Value, kunci: &str, min: i64, maks: i64) -> Option<i64> {
    row.get(kunci).and_then(Value::as_i64).filter(|n| (min..=maks).contains(n))
}

/// Teks opsional: absen/`null` = kosong; selain teks = cacat.
fn teks_opsional(row: &Value, kunci: &str) -> Option<Option<String>> {
    match row.get(kunci) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(_)) => Some(inventory::payload_text(row, kunci)),
        Some(_) => None,
    }
}

/// `hr-performance-template/save`: `{ template, aspek: [...], jabatan: [...] }`.
pub fn cloud_template_statements(payload: &Value, entity_key: &str) -> Option<Statements> {
    let t = payload.get("template")?;
    let id = hris::id_dari(t, "id_template", entity_key)?;
    let bawaan = nol_satu(t, "is_bawaan")?;
    let mut hasil: Statements = vec![(
        CLOUD_UPSERT_TEMPLATE_SQL,
        vec![
            Value::from(id.clone()),
            Value::from(inventory::payload_text(t, "nama")?),
            Value::from(teks_opsional(t, "keterangan")?),
            Value::from(bawaan),
            Value::from(nol_satu(t, "is_aktif")?),
            Value::from(inventory::payload_text(t, "diubah_oleh")?),
            Value::from(inventory::payload_text(t, "created_at")),
        ],
    )];
    if bawaan == 1 {
        hasil.push((CLOUD_SATU_BAWAAN_SQL, vec![Value::from(id.clone())]));
    }
    let aspek = payload.get("aspek")?.as_array()?;
    if aspek.is_empty() || aspek.len() > MAKS_ASPEK {
        return None;
    }
    let awalan = format!("{id}:");
    for a in aspek {
        let id_aspek = inventory::payload_text(a, "id_aspek").filter(|x| x.starts_with(&awalan))?;
        let tipe = inventory::payload_text(a, "tipe").filter(|x| TIPE_ASPEK.contains(&x.as_str()))?;
        hasil.push((
            CLOUD_UPSERT_ASPEK_SQL,
            vec![
                Value::from(id_aspek),
                Value::from(id.clone()),
                Value::from(inventory::payload_text(a, "nama")?),
                Value::from(tipe),
                Value::from(dalam(a, "bobot", 1, TOTAL_BOBOT)?),
                Value::from(teks_opsional(a, "panduan")?),
                Value::from(dalam(a, "urutan", 0, MAKS_ASPEK as i64)?),
                Value::from(nol_satu(a, "is_aktif")?),
                Value::from(inventory::payload_text(a, "created_at")),
            ],
        ));
    }
    let jabatan = match payload.get("jabatan") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => v.as_array()?.clone(),
    };
    if jabatan.len() > MAKS_JABATAN_TEMPLATE {
        return None;
    }
    for j in &jabatan {
        let tujuan = teks_opsional(j, "id_template")?;
        if tujuan.as_deref().is_some_and(|x| x != id) {
            return None;
        }
        hasil.push((
            CLOUD_UPSERT_JABATAN_SQL,
            vec![
                Value::from(inventory::payload_text(j, "id_jabatan")?),
                Value::from(tujuan),
                Value::from(inventory::payload_text(j, "diubah_oleh")?),
                Value::from(id.clone()),
            ],
        ));
    }
    Some(hasil)
}

/// `hr-performance/save`: `{ penilaian, nilai: [...] }`, header dan seluruh
/// nilai satu event.
pub fn cloud_penilaian_statements(payload: &Value, entity_key: &str) -> Option<Statements> {
    let p = payload.get("penilaian")?;
    let id = hris::id_dari(p, "id_penilaian", entity_key)?;
    let jenis = inventory::payload_text(p, "periode_jenis").filter(|j| PERIODE_JENIS.contains(&j.as_str()))?;
    let mulai = inventory::payload_text(p, "periode_mulai").filter(|t| inventory::is_valid_date(t))?;
    let selesai = inventory::payload_text(p, "periode_selesai").filter(|t| inventory::is_valid_date(t) && *t >= mulai)?;
    let mut hasil: Statements = vec![(
        CLOUD_UPSERT_PENILAIAN_SQL,
        vec![
            Value::from(id.clone()),
            Value::from(inventory::payload_text(p, "id_karyawan")?),
            Value::from(teks_opsional(p, "id_ref")?),
            Value::from(teks_opsional(p, "alasan_koreksi")?),
            Value::from(jenis),
            Value::from(mulai),
            Value::from(selesai),
            Value::from(inventory::payload_text(p, "id_template")?),
            Value::from(inventory::payload_text(p, "template_nama")?),
            Value::from(teks_opsional(p, "id_jabatan")?),
            Value::from(teks_opsional(p, "jabatan_nama")?),
            Value::from(teks_opsional(p, "id_penilai")?),
            Value::from(inventory::payload_text(p, "penilai_oleh")?),
            Value::from(teks_opsional(p, "catatan")?),
            Value::from(inventory::payload_text(p, "sidik")?),
            Value::from(inventory::payload_text(p, "dibuat_oleh")?),
            Value::from(inventory::payload_text(p, "waktu_perangkat")?),
            Value::from(inventory::payload_text(p, "created_at")),
        ],
    )];
    let nilai = payload.get("nilai")?.as_array()?;
    if nilai.is_empty() || nilai.len() > MAKS_ASPEK {
        return None;
    }
    let mut id_nilai_semua = Vec::new();
    let mut baris = Vec::new();
    for n in nilai {
        let id_aspek = inventory::payload_text(n, "id_aspek")?;
        let id_n = inventory::payload_text(n, "id_nilai").filter(|x| *x == id_nilai(&id, &id_aspek))?;
        let tipe = inventory::payload_text(n, "tipe").filter(|x| TIPE_ASPEK.contains(&x.as_str()))?;
        let skor = match n.get("skor") {
            None | Some(Value::Null) => None,
            Some(_) => Some(dalam(n, "skor", 1, 5)?),
        };
        let rincian = teks_opsional(n, "rincian")?;
        let rincian_benar = match (tipe.as_str(), rincian.as_deref()) {
            (TIPE_DISIPLIN, Some(r)) => rincian_sah(r),
            (TIPE_DISIPLIN, None) => true,
            (_, r) => r.is_none(),
        };
        if !rincian_benar {
            return None;
        }
        id_nilai_semua.push(id_n.clone());
        baris.push((
            CLOUD_UPSERT_NILAI_SQL,
            vec![
                Value::from(id_n),
                Value::from(id.clone()),
                Value::from(id_aspek),
                Value::from(inventory::payload_text(n, "aspek_nama")?),
                Value::from(tipe),
                Value::from(dalam(n, "bobot", 1, TOTAL_BOBOT)?),
                Value::from(dalam(n, "urutan", 0, MAKS_ASPEK as i64)?),
                Value::from(skor),
                Value::from(teks_opsional(n, "catatan")?),
                Value::from(rincian),
            ],
        ));
    }
    hasil.push((
        CLOUD_BUANG_NILAI_SQL,
        vec![Value::from(id), Value::from(Value::from(id_nilai_semua).to_string())],
    ));
    hasil.extend(baris);
    Some(hasil)
}

/// `hr-performance-decision/create`: append-only, tidak pernah ditolak karena
/// urutan; nilai akhir dan predikat hanya ada pada `Final`.
pub fn cloud_keputusan_statements(payload: &Value, entity_key: &str) -> Option<Statements> {
    let id = hris::id_dari(payload, "id_keputusan", entity_key)?;
    let jenis = inventory::payload_text(payload, "jenis").filter(|j| JENIS_KEPUTUSAN.contains(&j.as_str()))?;
    let nilai = match payload.get("nilai_akhir") {
        None | Some(Value::Null) => None,
        Some(_) => Some(dalam(payload, "nilai_akhir", 0, NILAI_MAKS)?),
    };
    let predikat = teks_opsional(payload, "predikat")?;
    let final_lengkap = nilai.is_some() && predikat.is_some();
    let tanpa_nilai = nilai.is_none() && predikat.is_none();
    if (jenis == "Final" && !final_lengkap) || (jenis != "Final" && !tanpa_nilai) {
        return None;
    }
    Some(vec![(
        CLOUD_INSERT_KEPUTUSAN_SQL,
        vec![
            Value::from(id),
            Value::from(inventory::payload_text(payload, "id_penilaian")?),
            Value::from(jenis),
            Value::from(inventory::payload_text(payload, "sidik")?),
            Value::from(teks_opsional(payload, "alasan")?),
            Value::from(nilai),
            Value::from(predikat),
            Value::from(inventory::payload_text(payload, "oleh")?),
            Value::from(inventory::payload_text(payload, "waktu_perangkat")?),
            Value::from(inventory::payload_text(payload, "created_at")),
        ],
    )])
}

// ── Baca dan tulis lokal (SQLite + outbox satu transaksi, §21.9) ───────────

use rusqlite::{params, types::ValueRef, Connection};
use serde_json::json;

use super::config::DesktopState;
use super::inventory::{invalid, new_hex_id};
use super::models::{CommandError, OperatorUser};
use super::{storage, sync};

pub const IZIN_VIEW: &str = "hr.performance.view";
pub const IZIN_ASSESS: &str = "hr.performance.assess";
pub const IZIN_CONFIG: &str = "hr.performance.config";
pub const IZIN_FINALIZE: &str = "hr.performance.finalize";

pub const PESAN_TANPA_TEMPLATE: &str =
    "Belum ada template untuk jabatan karyawan ini, dan belum ada template bawaan.";
pub const PESAN_FINAL_LAMA: &str =
    "Penilaian ini punya keputusan Final versi lama; isinya tidak bisa diubah lagi. Ajukan lalu finalkan versi sekarang.";
pub const PESAN_BELUM_FINAL_SENDIRI: &str = "Penilaian atas dirimu sendiri baru bisa dilihat setelah final.";
pub const PESAN_SP_OFFLINE: &str = "SP butuh koneksi ke database pusat.";

/// SP yang tidak dicabut dan masa berlakunya menyentuh periode (Q-77, info saja).
pub const SP_PERIODE_SQL: &str = "SELECT id_sp, tingkat, tanggal, berlaku_sampai, nomor, pelanggaran FROM hr_sp WHERE id_karyawan = ?1 AND dicabut_pada IS NULL AND tanggal <= ?3 AND berlaku_sampai >= ?2 ORDER BY tanggal, id_sp;";

/// Keputusan lokal: `diterima_cloud` kosong sampai cloud mengisinya.
pub const INSERT_KEPUTUSAN_SQL: &str = "INSERT INTO hr_kinerja_keputusan (id_keputusan, id_penilaian, jenis, sidik, alasan, nilai_akhir, predikat, oleh, waktu_perangkat, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now')) ON CONFLICT(id_keputusan) DO NOTHING;";

/// Jam perangkat keputusan berpresisi milidetik, selalu sesudah keputusan
/// sebelumnya atas penilaian yang sama: status membandingkan urutan Ajukan
/// dan Kembalikan, dan keduanya bisa jatuh di detik yang sama.
pub const WAKTU_KEPUTUSAN_SQL: &str = "SELECT strftime('%Y-%m-%d %H:%M:%f', MAX(julianday('now'), COALESCE((SELECT julianday(MAX(waktu_perangkat)) FROM hr_kinerja_keputusan WHERE id_penilaian = ?1), 0) + 0.0015 / 86400.0));";

pub const KARYAWAN_KINERJA_SQL: &str = "SELECT m.id_unik, m.nama, COALESCE(m.divisi, ''), COALESCE(m.status_aktif, 'Aktif'), m.id_keluar, m.tanggal_daftar, m.tanggal_selesai_aktif, m.id_jabatan, COALESCE(j.nama, m.jabatan_status), m.id_atasan FROM master_data m LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan WHERE (?1 IS NULL OR m.id_unik = ?1) ORDER BY m.nama;";

fn internal<E>(_: E) -> CommandError {
    CommandError::internal()
}

fn punya(operator: &OperatorUser, izin: &str) -> bool {
    operator.is_superadmin || operator.permissions.iter().any(|p| p == izin)
}

fn sendiri(operator: &OperatorUser, id_karyawan: &str) -> bool {
    operator.id_karyawan.as_deref() == Some(id_karyawan)
}

fn ditolak(pesan: &str) -> CommandError {
    CommandError::new("DESKTOP_ACCESS_DENIED", pesan)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn so(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned)
}

fn n(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

/// Setiap baris hasil kueri sebagai objek JSON berkunci nama kolom.
fn kueri(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, CommandError> {
    let mut st = conn.prepare(sql).map_err(internal)?;
    let kolom: Vec<String> = st.column_names().into_iter().map(str::to_owned).collect();
    let baris = st
        .query_map(p, |row| {
            let mut objek = serde_json::Map::new();
            for (i, nama) in kolom.iter().enumerate() {
                let nilai = match row.get_ref(i)? {
                    ValueRef::Integer(x) => json!(x),
                    ValueRef::Real(x) => json!(x),
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

/// Baris `json_object` satu kolom dari SQL `DISIPLIN_*`.
fn kueri_json(conn: &Connection, sql: &str, mulai: &str, selesai: &str, id: &str) -> Result<Vec<Value>, CommandError> {
    let mut st = conn.prepare(sql).map_err(internal)?;
    let baris = st
        .query_map(params![mulai, selesai, id], |r| r.get::<_, String>(0))
        .map_err(internal)?
        .map(|t| t.map(|t| serde_json::from_str(&t).unwrap_or(Value::Null)))
        .collect::<Result<Vec<Value>, _>>()
        .map_err(internal)?;
    Ok(baris)
}

fn baca_pengaturan(conn: &Connection) -> Result<PengaturanKinerja, CommandError> {
    let mut st = conn
        .prepare("SELECT key, value FROM setting_gex_system WHERE key IN (?1, ?2, ?3);")
        .map_err(internal)?;
    let peta = st
        .query_map(params![KUNCI_PERIODE, KUNCI_AMBANG, KUNCI_PREDIKAT], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(internal)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(internal)?;
    Ok(PengaturanKinerja::dari_peta(&peta))
}

#[derive(Debug, Clone)]
struct InfoKaryawan {
    id: String,
    nama: String,
    divisi: String,
    aktif: bool,
    keluar: bool,
    tanggal_daftar: Option<String>,
    tanggal_selesai_aktif: Option<String>,
    id_jabatan: Option<String>,
    jabatan_nama: Option<String>,
    id_atasan: Option<String>,
}

fn baca_karyawan(conn: &Connection, id: Option<&str>) -> Result<Vec<InfoKaryawan>, CommandError> {
    let mut st = conn.prepare(KARYAWAN_KINERJA_SQL).map_err(internal)?;
    let isi = |r: &rusqlite::Row<'_>, i: usize| -> rusqlite::Result<Option<String>> {
        Ok(r.get::<_, Option<String>>(i)?.filter(|t| !t.trim().is_empty()))
    };
    let baris = st
        .query_map(params![id], |r| {
            Ok(InfoKaryawan {
                id: r.get(0)?,
                nama: r.get(1)?,
                divisi: r.get(2)?,
                aktif: r.get::<_, String>(3)? == "Aktif",
                keluar: isi(r, 4)?.is_some(),
                tanggal_daftar: isi(r, 5)?,
                tanggal_selesai_aktif: isi(r, 6)?,
                id_jabatan: isi(r, 7)?,
                jabatan_nama: isi(r, 8)?,
                id_atasan: isi(r, 9)?,
            })
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn satu_karyawan(conn: &Connection, id: &str) -> Result<InfoKaryawan, CommandError> {
    baca_karyawan(conn, Some(id))?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Karyawan tidak ditemukan."))
}

fn rentang_karyawan(k: &InfoKaryawan, mulai: &str, selesai: &str) -> Option<RentangAktif> {
    rentang_aktif(mulai, selesai, k.tanggal_daftar.as_deref(), k.tanggal_selesai_aktif.as_deref())
}

fn pemetaan(conn: &Connection) -> Result<HashMap<String, Option<String>>, CommandError> {
    Ok(kueri(conn, "SELECT id_jabatan, id_template FROM hr_kinerja_jabatan;", [])?
        .iter()
        .map(|r| (s(r, "id_jabatan"), so(r, "id_template")))
        .collect())
}

fn ringkas_template(template: &[Value]) -> Vec<TemplateRingkas> {
    template
        .iter()
        .map(|t| TemplateRingkas {
            id_template: s(t, "id_template"),
            is_aktif: n(t, "is_aktif") == 1,
            is_bawaan: n(t, "is_bawaan") == 1,
        })
        .collect()
}

fn aspek_template(conn: &Connection, id_template: &str) -> Result<Vec<AspekSah>, CommandError> {
    Ok(kueri(
        conn,
        "SELECT * FROM hr_kinerja_aspek WHERE id_template = ?1 ORDER BY urutan, id_aspek;",
        params![id_template],
    )?
    .iter()
    .map(|a| AspekSah {
        id_aspek: s(a, "id_aspek"),
        nama: s(a, "nama"),
        tipe: s(a, "tipe"),
        bobot: n(a, "bobot"),
        panduan: so(a, "panduan"),
        urutan: n(a, "urutan"),
        is_aktif: n(a, "is_aktif") == 1,
    })
    .collect())
}

fn satu_penilaian(conn: &Connection, id: &str) -> Result<Value, CommandError> {
    kueri(conn, "SELECT * FROM hr_kinerja_penilaian WHERE id_penilaian = ?1;", params![id])?
        .into_iter()
        .next()
        .ok_or_else(|| invalid("Penilaian tidak ditemukan."))
}

fn peta_keputusan(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<KeputusanKinerja>>, CommandError> {
    let mut peta: HashMap<String, Vec<KeputusanKinerja>> = HashMap::new();
    for k in kueri(
        conn,
        "SELECT * FROM hr_kinerja_keputusan WHERE id_penilaian IN (SELECT value FROM json_each(?1)) ORDER BY id_keputusan;",
        params![json!(ids).to_string()],
    )? {
        let keputusan: KeputusanKinerja = serde_json::from_value(k.clone()).map_err(internal)?;
        peta.entry(s(&k, "id_penilaian")).or_default().push(keputusan);
    }
    Ok(peta)
}

fn peta_nilai(conn: &Connection, ids: &[String]) -> Result<HashMap<String, Vec<BarisNilai>>, CommandError> {
    let mut peta: HashMap<String, Vec<BarisNilai>> = HashMap::new();
    for b in kueri(
        conn,
        "SELECT * FROM hr_kinerja_nilai WHERE id_penilaian IN (SELECT value FROM json_each(?1)) ORDER BY id_penilaian, urutan, id_aspek;",
        params![json!(ids).to_string()],
    )? {
        let baris: BarisNilai = serde_json::from_value(b.clone()).map_err(internal)?;
        peta.entry(s(&b, "id_penilaian")).or_default().push(baris);
    }
    Ok(peta)
}

fn ringkas_penilaian(p: &Value, status: &str) -> RingkasPenilaian {
    RingkasPenilaian {
        id_penilaian: s(p, "id_penilaian"),
        id_karyawan: s(p, "id_karyawan"),
        id_ref: so(p, "id_ref"),
        periode_mulai: s(p, "periode_mulai"),
        periode_selesai: s(p, "periode_selesai"),
        dibatalkan: status == STATUS_DIBATALKAN,
    }
}

/// Q-85: penilaian atas diri sesi hanya terbaca setelah Final, lewat `view`.
fn boleh_lihat(operator: &OperatorUser, id_karyawan: &str, status: &str) -> bool {
    !sendiri(operator, id_karyawan) || (status == STATUS_FINAL && punya(operator, IZIN_VIEW))
}

fn rincian_disiplin(nilai: &[BarisNilai]) -> Option<&str> {
    nilai.iter().find(|b| b.tipe == TIPE_DISIPLIN).and_then(|b| b.rincian.as_deref())
}

/// Hitungan disiplin hidup dari SQLite perangkat (§21.6).
fn muat_disiplin(
    conn: &Connection,
    id_karyawan: &str,
    rentang: Option<&RentangAktif>,
    hari_ini: &str,
    ambang: [i64; 4],
) -> Result<Disiplin, CommandError> {
    // Tidak aktif sama sekali di periode itu = tidak ada hari dinilai.
    let (mulai, selesai) = rentang.map_or(("9999-12-31", "0000-01-01"), |r| (r.mulai.as_str(), r.akhir.as_str()));
    let karyawan = kueri_json(conn, DISIPLIN_KARYAWAN_SQL, mulai, selesai, id_karyawan)?
        .first()
        .map(KaryawanDisiplin::dari_json)
        .unwrap_or_default();
    let hari: Vec<HariDisiplin> = kueri_json(conn, DISIPLIN_HARI_SQL, mulai, selesai, id_karyawan)?
        .iter()
        .map(HariDisiplin::dari_json)
        .collect();
    let pengajuan: Vec<PengajuanDisiplin> = kueri_json(conn, DISIPLIN_PENGAJUAN_SQL, mulai, selesai, id_karyawan)?
        .iter()
        .map(PengajuanDisiplin::dari_json)
        .collect();
    let tukar: Vec<TukarDisiplin> = kueri_json(conn, DISIPLIN_TUKAR_SQL, mulai, selesai, id_karyawan)?
        .iter()
        .map(TukarDisiplin::dari_json)
        .collect();
    let perjalanan: HashSet<String> = kueri_json(conn, DISIPLIN_PERJALANAN_SQL, mulai, selesai, id_karyawan)?
        .iter()
        .filter_map(|v| teks_json(v.get("tanggal")))
        .collect();
    // Sama dengan `LAPORAN_KEHADIRAN_SQL.libur`/`.whitelist`: libur aktif di
    // rentang dan whitelist aktif.
    let kalender = hr_pengajuan::muat_kalender(conn, mulai, selesai)?;
    Ok(hitung_disiplin(&MasukanDisiplin {
        mulai,
        selesai,
        hari_ini,
        karyawan: &karyawan,
        hari: &hari,
        pengajuan: &pengajuan,
        tukar: &tukar,
        perjalanan: &perjalanan,
        kalender: &kalender,
        ambang,
    }))
}

fn disiplin_penilaian(
    conn: &Connection,
    p: &Value,
    k: &InfoKaryawan,
    hari_ini: &str,
    ambang: [i64; 4],
) -> Result<Disiplin, CommandError> {
    let rentang = rentang_karyawan(k, &s(p, "periode_mulai"), &s(p, "periode_selesai"));
    muat_disiplin(conn, &k.id, rentang.as_ref(), hari_ini, ambang)
}

/// Satu penilaian untuk daftar dan rincian: status, nilai final, tanda.
fn ringkasan(
    p: &Value,
    keputusan: &[KeputusanKinerja],
    nilai: &[BarisNilai],
    k: Option<&InfoKaryawan>,
    ganda: bool,
    operator: &OperatorUser,
) -> Value {
    let sidik = s(p, "sidik");
    let status = status_kinerja(&sidik, keputusan);
    let berlaku = final_berlaku(&sidik, keputusan).filter(|_| status == STATUS_FINAL);
    let penuh = match k {
        Some(k) => rentang_karyawan(k, &s(p, "periode_mulai"), &s(p, "periode_selesai")).is_some_and(|r| r.penuh),
        None => true,
    };
    let id_penilai = so(p, "id_penilai");
    let id_atasan = k.and_then(|k| k.id_atasan.clone());
    let penilai_oleh = s(p, "penilai_oleh");
    let tanda = tanda_kinerja(&InfoTanda {
        sidik: &sidik,
        keputusan,
        penilai_oleh: &penilai_oleh,
        id_penilai: id_penilai.as_deref(),
        id_atasan: id_atasan.as_deref(),
        rincian_disiplin: rincian_disiplin(nilai),
        periode_penuh: penuh,
        ganda,
    });
    let nilai_akhir = berlaku.and_then(|k| k.nilai_akhir);
    let mut v = p.clone();
    v["status"] = json!(status);
    v["tanda"] = json!(tanda);
    v["nilai_akhir"] = json!(nilai_akhir);
    v["nilai_teks"] = json!(nilai_akhir.map(format_nilai));
    v["predikat"] = json!(berlaku.and_then(|k| k.predikat.clone()));
    v["nama"] = json!(k.map(|k| k.nama.clone()));
    v["divisi"] = json!(k.map(|k| k.divisi.clone()));
    v["atasan_saya"] = json!(id_atasan.is_some() && id_atasan == operator.id_karyawan);
    v
}

/// Template, aspek, pemetaan jabatan, dan pengaturan (keempat izin).
pub fn templates(state: &DesktopState) -> Result<Value, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let template = kueri(&conn, "SELECT * FROM hr_kinerja_template ORDER BY nama, id_template;", [])?;
    let aspek = kueri(&conn, "SELECT * FROM hr_kinerja_aspek ORDER BY id_template, urutan, id_aspek;", [])?;
    let peta = pemetaan(&conn)?;
    let pasangan: Vec<(String, String)> = template.iter().map(|t| (s(t, "id_template"), s(t, "nama"))).collect();
    let ganda = nama_ganda(&pasangan);
    let daftar: Vec<Value> = template
        .into_iter()
        .map(|mut t| {
            let id = s(&t, "id_template");
            let mut jabatan: Vec<&String> =
                peta.iter().filter(|(_, x)| x.as_deref() == Some(id.as_str())).map(|(j, _)| j).collect();
            jabatan.sort();
            t["aspek"] = json!(aspek.iter().filter(|a| s(a, "id_template") == id).collect::<Vec<_>>());
            t["jabatan"] = json!(jabatan);
            t["nama_ganda"] = json!(ganda.contains(&id));
            t
        })
        .collect();
    let jabatan = kueri(
        &conn,
        "SELECT j.id_jabatan, j.nama, j.is_aktif, k.id_template FROM hr_jabatan j LEFT JOIN hr_kinerja_jabatan k ON k.id_jabatan = j.id_jabatan ORDER BY j.nama, j.id_jabatan;",
        [],
    )?;
    Ok(json!({ "template": daftar, "jabatan": jabatan, "pengaturan": baca_pengaturan(&conn)? }))
}

/// Simpan template, aspek, dan pemetaan jabatan (`config`), satu event.
pub fn simpan_template(state: &DesktopState, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let sah = validasi_template(draft).map_err(invalid)?;
    let id_masuk = inventory::payload_text(draft, "id_template");
    hris::dalam_transaksi(state, |tx, client_id| {
        let semua = kueri(tx, "SELECT id_template, nama FROM hr_kinerja_template;", [])?;
        if let Some(id) = &id_masuk {
            if !semua.iter().any(|t| s(t, "id_template") == *id) {
                return Err(invalid("Template tidak ditemukan."));
            }
        }
        let id = id_masuk.clone().unwrap_or_else(|| new_hex_id("ktp-"));
        let pasangan: Vec<(String, String)> = semua.iter().map(|t| (s(t, "id_template"), s(t, "nama"))).collect();
        if nama_template_dipakai(&sah.nama, &id, &pasangan) {
            return Err(invalid(format!("Template \"{}\" sudah ada.", sah.nama)));
        }
        let lama: Vec<(String, String)> = aspek_template(tx, &id)?.into_iter().map(|a| (a.id_aspek, a.tipe)).collect();
        periksa_aspek_lama(&sah.aspek, &lama).map_err(invalid)?;
        for j in &sah.jabatan {
            let ada: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM hr_jabatan WHERE id_jabatan = ?1);", params![j], |r| r.get(0))
                .map_err(internal)?;
            if !ada {
                return Err(invalid("Jabatan tidak ditemukan."));
            }
        }
        tx.execute(
            CLOUD_UPSERT_TEMPLATE_SQL,
            params![
                id,
                sah.nama,
                sah.keterangan,
                i64::from(sah.is_bawaan),
                i64::from(sah.is_aktif),
                operator.username,
                Option::<String>::None
            ],
        )
        .map_err(internal)?;
        if sah.is_bawaan {
            tx.execute(CLOUD_SATU_BAWAAN_SQL, params![id]).map_err(internal)?;
        }
        for a in &sah.aspek {
            let id_aspek = if a.id_aspek.is_empty() { format!("{id}:{}", new_hex_id("")) } else { a.id_aspek.clone() };
            tx.execute(
                CLOUD_UPSERT_ASPEK_SQL,
                params![id_aspek, id, a.nama, a.tipe, a.bobot, a.panduan, a.urutan, i64::from(a.is_aktif), Option::<String>::None],
            )
            .map_err(internal)?;
        }
        // Hanya baris pemetaan yang berubah ikut event.
        let peta = pemetaan(tx)?;
        let mut berubah: Vec<String> = Vec::new();
        for j in &sah.jabatan {
            if peta.get(j).and_then(|t| t.as_deref()) != Some(id.as_str()) {
                tx.execute(CLOUD_UPSERT_JABATAN_SQL, params![j, id, operator.username, id]).map_err(internal)?;
                berubah.push(j.clone());
            }
        }
        for (j, t) in &peta {
            if t.as_deref() == Some(id.as_str()) && !sah.jabatan.contains(j) {
                tx.execute(CLOUD_UPSERT_JABATAN_SQL, params![j, Option::<String>::None, operator.username, id])
                    .map_err(internal)?;
                berubah.push(j.clone());
            }
        }
        let template = kueri(tx, "SELECT * FROM hr_kinerja_template WHERE id_template = ?1;", params![id])?;
        let aspek = kueri(tx, "SELECT * FROM hr_kinerja_aspek WHERE id_template = ?1 ORDER BY urutan, id_aspek;", params![id])?;
        let jabatan = kueri(
            tx,
            "SELECT * FROM hr_kinerja_jabatan WHERE id_jabatan IN (SELECT value FROM json_each(?1)) ORDER BY id_jabatan;",
            params![json!(berubah).to_string()],
        )?;
        let payload = json!({ "template": template.first(), "aspek": aspek, "jabatan": jabatan });
        sync::enqueue(tx, client_id, "hr-performance-template", "save", &id, &payload, None)?;
        Ok(json!({ "sukses": true, "id_template": id }))
    })
}

/// Simpan pengaturan kinerja (`config`) lewat rute `setting/update`.
pub fn simpan_pengaturan(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let isian = validasi_pengaturan_kinerja(draft).map_err(invalid)?;
    hris::dalam_transaksi(state, |tx, client_id| hris::tulis_pengaturan(tx, client_id, &isian))
}

fn periode_filter(conn: &Connection, filter: &Value, pengaturan: &PengaturanKinerja) -> Result<(String, String, String), CommandError> {
    let jenis = so(filter, "periode_jenis").unwrap_or_else(|| pengaturan.periode.clone());
    let mulai = match so(filter, "periode_mulai") {
        Some(m) => m,
        None => awal_periode(&jenis, &hris::hari_ini_wib(conn)?)
            .ok_or_else(|| invalid("Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan."))?,
    };
    let (mulai, selesai) = periode_rentang(&jenis, &mulai).map_err(invalid)?;
    Ok((jenis, mulai, selesai))
}

/// Daftar satu periode: penilaian (status, tanda, nilai final) dan karyawan
/// yang belum dinilai. Penilaian atas diri sesi disaring (Q-85).
pub fn daftar(state: &DesktopState, operator: &OperatorUser, filter: &Value) -> Result<Value, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let pengaturan = baca_pengaturan(&conn)?;
    let (jenis, mulai, selesai) = periode_filter(&conn, filter, &pengaturan)?;
    let hari_ini = hris::hari_ini_wib(&conn)?;
    // `id_karyawan` = riwayat satu karyawan di semua periode (tab Kinerja
    // rincian karyawan); tanpa itu = satu periode.
    let id_karyawan = so(filter, "id_karyawan");
    let semua = match &id_karyawan {
        Some(id) => kueri(
            &conn,
            "SELECT * FROM hr_kinerja_penilaian WHERE id_karyawan = ?1 ORDER BY periode_mulai DESC, created_at, id_penilaian;",
            params![id],
        )?,
        None => kueri(
            &conn,
            "SELECT * FROM hr_kinerja_penilaian WHERE periode_mulai <= ?2 AND periode_selesai >= ?1 ORDER BY periode_mulai, id_penilaian;",
            params![mulai, selesai],
        )?,
    };
    let ids: Vec<String> = semua.iter().map(|p| s(p, "id_penilaian")).collect();
    let keputusan = peta_keputusan(&conn, &ids)?;
    let nilai = peta_nilai(&conn, &ids)?;
    let karyawan: HashMap<String, InfoKaryawan> =
        baca_karyawan(&conn, None)?.into_iter().map(|k| (k.id.clone(), k)).collect();
    let kosong: Vec<KeputusanKinerja> = Vec::new();
    let kep = |id: &str| keputusan.get(id).unwrap_or(&kosong);
    let ringkas: Vec<RingkasPenilaian> = semua
        .iter()
        .map(|p| ringkas_penilaian(p, status_kinerja(&s(p, "sidik"), kep(&s(p, "id_penilaian")))))
        .collect();
    let ganda = penilaian_ganda(&ringkas);
    // Nilai berlaku per akar (§21.7): akar dan koreksinya ada di periode
    // yang sama, jadi semuanya ikut termuat.
    let mut keluarga_final: HashMap<String, Vec<(String, KeputusanKinerja)>> = HashMap::new();
    for p in &semua {
        let id = s(p, "id_penilaian");
        let sidik = s(p, "sidik");
        if status_kinerja(&sidik, kep(&id)) == STATUS_FINAL {
            if let Some(f) = final_berlaku(&sidik, kep(&id)) {
                let akar = so(p, "id_ref").unwrap_or_else(|| id.clone());
                keluarga_final.entry(akar).or_default().push((id, f.clone()));
            }
        }
    }
    let berlaku: HashSet<String> = keluarga_final
        .values()
        .filter_map(|anggota| {
            let pasangan: Vec<(&str, &KeputusanKinerja)> = anggota.iter().map(|(id, k)| (id.as_str(), k)).collect();
            kinerja_berlaku(&pasangan).map(str::to_owned)
        })
        .collect();
    let penilaian: Vec<Value> = semua
        .iter()
        .filter(|p| boleh_lihat(operator, &s(p, "id_karyawan"), status_kinerja(&s(p, "sidik"), kep(&s(p, "id_penilaian")))))
        .map(|p| {
            let id = s(p, "id_penilaian");
            let mut v = ringkasan(
                p,
                kep(&id),
                nilai.get(&id).map(Vec::as_slice).unwrap_or(&[]),
                karyawan.get(&s(p, "id_karyawan")),
                ganda.contains(&id),
                operator,
            );
            v["berlaku"] = json!(berlaku.contains(&id));
            v
        })
        .collect();
    let template = kueri(&conn, "SELECT id_template, nama, is_aktif, is_bawaan FROM hr_kinerja_template;", [])?;
    let ringkas_t = ringkas_template(&template);
    let peta = pemetaan(&conn)?;
    let mut belum: Vec<&InfoKaryawan> = karyawan
        .values()
        .filter(|k| k.aktif && !k.keluar && !sendiri(operator, &k.id))
        .filter(|k| id_karyawan.as_ref().is_none_or(|id| *id == k.id))
        .filter(|k| rentang_karyawan(k, &mulai, &selesai).is_some())
        .filter(|k| !ringkas.iter().any(|r| r.id_karyawan == k.id && akar_hidup(r)))
        .collect();
    belum.sort_by(|a, b| (&a.nama, &a.id).cmp(&(&b.nama, &b.id)));
    let belum_dinilai: Vec<Value> = belum
        .into_iter()
        .map(|k| {
            let t = template_karyawan(k.id_jabatan.as_deref(), &peta, &ringkas_t);
            let nama_t = t.as_deref().and_then(|t| template.iter().find(|x| s(x, "id_template") == t)).map(|x| s(x, "nama"));
            json!({
                "id_karyawan": k.id,
                "nama": k.nama,
                "divisi": k.divisi,
                "jabatan_nama": k.jabatan_nama,
                "id_template": t,
                "template_nama": nama_t,
                "atasan_saya": k.id_atasan.is_some() && k.id_atasan == operator.id_karyawan,
            })
        })
        .collect();
    Ok(json!({
        "periode": { "jenis": jenis, "mulai": mulai, "selesai": selesai, "bisa_diajukan": selesai <= hari_ini },
        "pengaturan": pengaturan,
        "penilaian": penilaian,
        "belum_dinilai": belum_dinilai,
    }))
}

fn keadaan(
    operator: &OperatorUser,
    p: &Value,
    status: &str,
    nilai: &[BarisNilai],
    hari_ini: &str,
    disiplin_sama: bool,
) -> KeadaanKinerja {
    KeadaanKinerja {
        status: status.to_owned(),
        koreksi: so(p, "id_ref").is_some(),
        karyawan_sendiri: sendiri(operator, &s(p, "id_karyawan")),
        boleh_assess: punya(operator, IZIN_ASSESS),
        boleh_finalize: punya(operator, IZIN_FINALIZE),
        skor_lengkap: skor_lengkap(nilai),
        periode_selesai: s(p, "periode_selesai").as_str() <= hari_ini,
        disiplin_sama,
        akar_final: false,
        koreksi_terbuka: false,
    }
}

/// Keluarga koreksi satu akar: `(akar_final, koreksi_terbuka, id_berlaku, anggota)`.
fn keluarga(conn: &Connection, id_akar: &str) -> Result<(bool, bool, Option<String>, Vec<Value>), CommandError> {
    let anggota = kueri(
        conn,
        "SELECT * FROM hr_kinerja_penilaian WHERE id_penilaian = ?1 OR id_ref = ?1 ORDER BY created_at, id_penilaian;",
        params![id_akar],
    )?;
    let ids: Vec<String> = anggota.iter().map(|p| s(p, "id_penilaian")).collect();
    let keputusan = peta_keputusan(conn, &ids)?;
    let mut akar_final = false;
    let mut terbuka = false;
    let mut kandidat: Vec<(String, KeputusanKinerja)> = Vec::new();
    for p in &anggota {
        let id = s(p, "id_penilaian");
        let kep = keputusan.get(&id).map(Vec::as_slice).unwrap_or(&[]);
        let sidik = s(p, "sidik");
        let status = status_kinerja(&sidik, kep);
        if id == id_akar {
            akar_final = status == STATUS_FINAL;
        } else if status == STATUS_DRAF || status == STATUS_DIAJUKAN {
            terbuka = true;
        }
        if status == STATUS_FINAL {
            if let Some(f) = final_berlaku(&sidik, kep) {
                kandidat.push((id, f.clone()));
            }
        }
    }
    let pasangan: Vec<(&str, &KeputusanKinerja)> = kandidat.iter().map(|(id, k)| (id.as_str(), k)).collect();
    let berlaku = kinerja_berlaku(&pasangan).map(str::to_owned);
    Ok((akar_final, terbuka, berlaku, anggota))
}

/// Rincian satu penilaian dari SQLite perangkat: nilai, keputusan, hitungan
/// disiplin hidup, riwayat koreksi, dan aksi yang terbuka untuk sesi ini.
pub fn rincian(state: &DesktopState, operator: &OperatorUser, id: &str) -> Result<Value, CommandError> {
    let conn = storage::database(&state.data_dir)?;
    let p = satu_penilaian(&conn, id)?;
    let ids = vec![id.to_owned()];
    let mut kep = peta_keputusan(&conn, &ids)?.remove(id).unwrap_or_default();
    kep.sort_by(urut);
    let nilai = peta_nilai(&conn, &ids)?.remove(id).unwrap_or_default();
    let status = status_kinerja(&s(&p, "sidik"), &kep);
    if !boleh_lihat(operator, &s(&p, "id_karyawan"), status) {
        return Err(ditolak(PESAN_BELUM_FINAL_SENDIRI));
    }
    let k = baca_karyawan(&conn, Some(&s(&p, "id_karyawan")))?.into_iter().next();
    let pengaturan = baca_pengaturan(&conn)?;
    let hari_ini = hris::hari_ini_wib(&conn)?;
    let disiplin = match (&k, rincian_disiplin(&nilai).is_some() || nilai.iter().any(|b| b.tipe == TIPE_DISIPLIN)) {
        (Some(k), true) => Some(disiplin_penilaian(&conn, &p, k, &hari_ini, pengaturan.ambang)?),
        _ => None,
    };
    let disiplin_berubah = disiplin.as_ref().is_some_and(|d| rincian_disiplin(&nilai) != Some(d.rincian.as_str()));
    let id_akar = so(&p, "id_ref").unwrap_or_else(|| id.to_owned());
    let (akar_final, koreksi_terbuka, id_berlaku, anggota) = keluarga(&conn, &id_akar)?;
    let ids_kel: Vec<String> = anggota.iter().map(|x| s(x, "id_penilaian")).collect();
    let kep_kel = peta_keputusan(&conn, &ids_kel)?;
    let nilai_kel = peta_nilai(&conn, &ids_kel)?;
    let riwayat: Vec<Value> = anggota
        .iter()
        .filter_map(|x| {
            let idx = s(x, "id_penilaian");
            let kx = kep_kel.get(&idx).map(Vec::as_slice).unwrap_or(&[]);
            let st = status_kinerja(&s(x, "sidik"), kx);
            boleh_lihat(operator, &s(x, "id_karyawan"), st).then(|| {
                ringkasan(x, kx, nilai_kel.get(&idx).map(Vec::as_slice).unwrap_or(&[]), k.as_ref(), false, operator)
            })
        })
        .collect();
    let mut kd = keadaan(operator, &p, status, &nilai, &hari_ini, !disiplin_berubah);
    kd.akar_final = akar_final;
    kd.koreksi_terbuka = koreksi_terbuka;
    let boleh: serde_json::Map<String, Value> = AKSI_KINERJA
        .iter()
        .map(|aksi| {
            // Koreksi selalu dinilai atas akarnya, bukan baris ini.
            let mut k2 = kd.clone();
            if *aksi == "Koreksi" {
                k2.koreksi = false;
            }
            ((*aksi).to_owned(), json!(periksa_aksi_kinerja(aksi, "-", &k2).is_ok()))
        })
        .collect();
    Ok(json!({
        "penilaian": ringkasan(&p, &kep, &nilai, k.as_ref(), false, operator),
        "nilai": nilai,
        "keputusan": kep,
        "disiplin": disiplin,
        "disiplin_berubah": disiplin_berubah,
        "riwayat": riwayat,
        "id_akar": id_akar,
        "id_berlaku": id_berlaku,
        "boleh": boleh,
        "pengaturan": pengaturan,
    }))
}

/// Rincian + SP Berlaku periode itu dari cloud, SESUDAH koneksi SQLite
/// perangkat ditutup (`rincian` sudah kembali). Offline = "butuh koneksi".
pub async fn rincian_lengkap(state: &DesktopState, operator: &OperatorUser, id: &str) -> Result<Value, CommandError> {
    let mut hasil = rincian(state, operator, id)?;
    let p = hasil["penilaian"].clone();
    let args = vec![json!(s(&p, "id_karyawan")), json!(s(&p, "periode_mulai")), json!(s(&p, "periode_selesai"))];
    let sp = match state.get_turso_client() {
        Ok(turso) => match hris::siap(&turso).await {
            Ok(()) => hris::objek(&turso, SP_PERIODE_SQL, args).await.ok(),
            Err(_) => None,
        },
        Err(_) => None,
    };
    match sp {
        Some(sp) => hasil["sp"] = json!(sp),
        None => {
            hasil["sp"] = Value::Null;
            hasil["sp_pesan"] = json!(PESAN_SP_OFFLINE);
        }
    }
    Ok(hasil)
}

struct Dasar {
    id: String,
    id_ref: Option<String>,
    alasan_koreksi: Option<String>,
    id_template: String,
    template_nama: String,
    id_jabatan: Option<String>,
    jabatan_nama: Option<String>,
    dibuat_oleh: String,
    baris: Vec<BarisNilai>,
}

/// Template dan baris salinan untuk karyawan menurut jabatan kini (Q-80).
fn dasar_template(conn: &Connection, k: &InfoKaryawan) -> Result<(String, String, Vec<BarisNilai>), CommandError> {
    let template = kueri(conn, "SELECT id_template, nama, is_aktif, is_bawaan FROM hr_kinerja_template;", [])?;
    let id = template_karyawan(k.id_jabatan.as_deref(), &pemetaan(conn)?, &ringkas_template(&template))
        .ok_or_else(|| invalid(PESAN_TANPA_TEMPLATE))?;
    let nama = template.iter().find(|t| s(t, "id_template") == id).map(|t| s(t, "nama")).unwrap_or_default();
    let baris = salinan_aspek(&aspek_template(conn, &id)?);
    if baris.is_empty() {
        return Err(invalid(PESAN_TANPA_TEMPLATE));
    }
    Ok((id, nama, baris))
}

/// Buat penilaian, ubah draf, muat ulang template, atau buat koreksi
/// (§21.4, §21.5, §21.7). Disiplin dihitung ulang setiap simpan.
pub fn simpan(state: &DesktopState, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let sah = validasi_penilaian(draft).map_err(invalid)?;
    let id_masuk = inventory::payload_text(draft, "id_penilaian");
    let muat_ulang = bendera(draft, "muat_ulang");
    hris::dalam_transaksi(state, |tx, client_id| {
        let hari_ini = hris::hari_ini_wib(tx)?;
        let k = satu_karyawan(tx, &sah.id_karyawan)?;
        let pengaturan = baca_pengaturan(tx)?;
        let dasar_keadaan = KeadaanKinerja {
            karyawan_sendiri: sendiri(operator, &k.id),
            boleh_assess: punya(operator, IZIN_ASSESS),
            boleh_finalize: punya(operator, IZIN_FINALIZE),
            ..Default::default()
        };
        let dasar = match (&id_masuk, &sah.id_ref) {
            (Some(id), _) => {
                let p = satu_penilaian(tx, id)?;
                if s(&p, "id_karyawan") != sah.id_karyawan
                    || s(&p, "periode_jenis") != sah.periode_jenis
                    || s(&p, "periode_mulai") != sah.periode_mulai
                    || so(&p, "id_ref") != sah.id_ref
                {
                    return Err(invalid("Karyawan, periode, dan rujukan penilaian tidak bisa diubah."));
                }
                let kep = peta_keputusan(tx, &[id.clone()])?.remove(id).unwrap_or_default();
                let status = status_kinerja(&s(&p, "sidik"), &kep);
                let kd = KeadaanKinerja { status: status.to_owned(), koreksi: sah.id_ref.is_some(), ..dasar_keadaan.clone() };
                periksa_aksi_kinerja("Simpan", "", &kd).map_err(invalid)?;
                // Cloud melewati save sesudah Final/Batal; jangan simpan diam-diam.
                if kep.iter().any(|x| x.jenis == "Final" || x.jenis == "Batal") {
                    return Err(invalid(PESAN_FINAL_LAMA));
                }
                let lama = peta_nilai(tx, &[id.clone()])?.remove(id).unwrap_or_default();
                let (id_template, template_nama, id_jabatan, jabatan_nama, baris) = if muat_ulang {
                    if sah.id_ref.is_some() {
                        return Err(invalid("Koreksi tidak memuat ulang template; nilainya disalin dari penilaian yang berlaku."));
                    }
                    let (t, nama, baru) = dasar_template(tx, &k)?;
                    (t, nama, k.id_jabatan.clone(), k.jabatan_nama.clone(), muat_ulang_template(baru, &lama))
                } else {
                    (s(&p, "id_template"), s(&p, "template_nama"), so(&p, "id_jabatan"), so(&p, "jabatan_nama"), lama)
                };
                Dasar {
                    id: id.clone(),
                    id_ref: sah.id_ref.clone(),
                    alasan_koreksi: sah.alasan_koreksi.clone(),
                    id_template,
                    template_nama,
                    id_jabatan,
                    jabatan_nama,
                    dibuat_oleh: s(&p, "dibuat_oleh"),
                    baris,
                }
            }
            (None, None) => {
                periksa_aksi_kinerja("Simpan", "", &KeadaanKinerja { status: String::new(), ..dasar_keadaan.clone() })
                    .map_err(invalid)?;
                let rentang = rentang_karyawan(&k, &sah.periode_mulai, &sah.periode_selesai);
                periksa_buat(k.aktif, k.keluar, &sah.periode_mulai, &hari_ini, rentang.as_ref()).map_err(invalid)?;
                let milik = kueri(tx, "SELECT * FROM hr_kinerja_penilaian WHERE id_karyawan = ?1;", params![k.id])?;
                let ids: Vec<String> = milik.iter().map(|p| s(p, "id_penilaian")).collect();
                let kep = peta_keputusan(tx, &ids)?;
                let lain: Vec<RingkasPenilaian> = milik
                    .iter()
                    .map(|p| {
                        let kx = kep.get(&s(p, "id_penilaian")).map(Vec::as_slice).unwrap_or(&[]);
                        ringkas_penilaian(p, status_kinerja(&s(p, "sidik"), kx))
                    })
                    .collect();
                let baru = RingkasPenilaian {
                    id_penilaian: String::new(),
                    id_karyawan: k.id.clone(),
                    id_ref: None,
                    periode_mulai: sah.periode_mulai.clone(),
                    periode_selesai: sah.periode_selesai.clone(),
                    dibatalkan: false,
                };
                if let Some(x) = bentrok_periode(&baru, &lain) {
                    return Err(invalid(pesan_bertumpuk(&x.periode_mulai, &x.periode_selesai)));
                }
                let (id_template, template_nama, baris) = dasar_template(tx, &k)?;
                Dasar {
                    id: new_hex_id("knj-"),
                    id_ref: None,
                    alasan_koreksi: None,
                    id_template,
                    template_nama,
                    id_jabatan: k.id_jabatan.clone(),
                    jabatan_nama: k.jabatan_nama.clone(),
                    dibuat_oleh: operator.username.clone(),
                    baris,
                }
            }
            (None, Some(id_ref)) => {
                let asal = satu_penilaian(tx, id_ref)?;
                let id_akar = so(&asal, "id_ref").unwrap_or_else(|| id_ref.clone());
                let (akar_final, koreksi_terbuka, id_berlaku, anggota) = keluarga(tx, &id_akar)?;
                let kd = KeadaanKinerja { akar_final, koreksi_terbuka, ..dasar_keadaan.clone() };
                periksa_aksi_kinerja("Koreksi", "", &kd).map_err(invalid)?;
                let akar = anggota
                    .iter()
                    .find(|x| s(x, "id_penilaian") == id_akar)
                    .ok_or_else(|| invalid("Penilaian tidak ditemukan."))?;
                if s(akar, "id_karyawan") != sah.id_karyawan
                    || s(akar, "periode_jenis") != sah.periode_jenis
                    || s(akar, "periode_mulai") != sah.periode_mulai
                {
                    return Err(invalid("Karyawan dan periode koreksi harus sama dengan penilaian asal."));
                }
                // Baris disalin dari penilaian yang berlaku, bukan dari template.
                let id_sumber = id_berlaku.unwrap_or_else(|| id_akar.clone());
                let sumber = anggota
                    .iter()
                    .find(|x| s(x, "id_penilaian") == id_sumber)
                    .ok_or_else(|| invalid("Penilaian tidak ditemukan."))?;
                Dasar {
                    id: new_hex_id("knj-"),
                    id_ref: Some(id_akar),
                    alasan_koreksi: sah.alasan_koreksi.clone(),
                    id_template: s(sumber, "id_template"),
                    template_nama: s(sumber, "template_nama"),
                    id_jabatan: so(sumber, "id_jabatan"),
                    jabatan_nama: so(sumber, "jabatan_nama"),
                    dibuat_oleh: operator.username.clone(),
                    baris: peta_nilai(tx, &[id_sumber.clone()])?.remove(&id_sumber).unwrap_or_default(),
                }
            }
        };
        // Isian kosong atau muat ulang = pertahankan skor yang sudah ada.
        let isian: Vec<IsianNilai> = if muat_ulang || sah.nilai.is_empty() {
            dasar
                .baris
                .iter()
                .map(|b| IsianNilai { id_aspek: b.id_aspek.clone(), skor: b.skor, catatan: b.catatan.clone() })
                .collect()
        } else {
            sah.nilai.clone()
        };
        let disiplin = if dasar.baris.iter().any(|b| b.tipe == TIPE_DISIPLIN) {
            let rentang = rentang_karyawan(&k, &sah.periode_mulai, &sah.periode_selesai);
            Some(muat_disiplin(tx, &k.id, rentang.as_ref(), &hari_ini, pengaturan.ambang)?)
        } else {
            None
        };
        let hasil = susun_nilai(&dasar.baris, &isian, disiplin.as_ref()).map_err(invalid)?;
        let sidik = sidik_penilaian(&IsiPenilaian {
            id_karyawan: &k.id,
            id_ref: dasar.id_ref.as_deref(),
            periode_mulai: &sah.periode_mulai,
            periode_selesai: &sah.periode_selesai,
            id_template: &dasar.id_template,
            catatan: sah.catatan.as_deref(),
            nilai: &hasil,
        });
        let waktu: String = tx.query_row("SELECT datetime('now');", [], |r| r.get(0)).map_err(internal)?;
        let id = dasar.id.clone();
        tx.execute(
            CLOUD_UPSERT_PENILAIAN_SQL,
            params![
                id,
                k.id,
                dasar.id_ref,
                dasar.alasan_koreksi,
                sah.periode_jenis,
                sah.periode_mulai,
                sah.periode_selesai,
                dasar.id_template,
                dasar.template_nama,
                dasar.id_jabatan,
                dasar.jabatan_nama,
                operator.id_karyawan,
                operator.username,
                sah.catatan,
                sidik,
                dasar.dibuat_oleh,
                waktu,
                Option::<String>::None
            ],
        )
        .map_err(internal)?;
        let id_nilai_semua: Vec<String> = hasil.iter().map(|b| id_nilai(&id, &b.id_aspek)).collect();
        tx.execute(CLOUD_BUANG_NILAI_SQL, params![id, json!(id_nilai_semua).to_string()]).map_err(internal)?;
        for b in &hasil {
            tx.execute(
                CLOUD_UPSERT_NILAI_SQL,
                params![id_nilai(&id, &b.id_aspek), id, b.id_aspek, b.aspek_nama, b.tipe, b.bobot, b.urutan, b.skor, b.catatan, b.rincian],
            )
            .map_err(internal)?;
        }
        let penilaian = kueri(tx, "SELECT * FROM hr_kinerja_penilaian WHERE id_penilaian = ?1;", params![id])?;
        let nilai = kueri(tx, "SELECT * FROM hr_kinerja_nilai WHERE id_penilaian = ?1 ORDER BY urutan, id_aspek;", params![id])?;
        sync::enqueue(tx, client_id, "hr-performance", "save", &id, &json!({ "penilaian": penilaian.first(), "nilai": nilai }), None)?;
        Ok(json!({ "sukses": true, "id_penilaian": id, "sidik": sidik, "disiplin": disiplin, "status": STATUS_DRAF }))
    })
}

/// Ajukan, Kembalikan, Final, atau Batal (§21.5). `Final` membekukan nilai
/// akhir dan predikat ke baris keputusan.
pub fn putuskan(state: &DesktopState, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let id = inventory::payload_text(draft, "id_penilaian").ok_or_else(|| invalid("Penilaian tidak ditemukan."))?;
    let aksi = teks(draft, "aksi");
    let alasan = teks(draft, "alasan");
    if !JENIS_KEPUTUSAN.contains(&aksi.as_str()) {
        return Err(invalid("Aksi penilaian tidak dikenal."));
    }
    hris::dalam_transaksi(state, |tx, client_id| {
        let p = satu_penilaian(tx, &id)?;
        let kep = peta_keputusan(tx, &[id.clone()])?.remove(&id).unwrap_or_default();
        let nilai = peta_nilai(tx, &[id.clone()])?.remove(&id).unwrap_or_default();
        let sidik = s(&p, "sidik");
        let status = status_kinerja(&sidik, &kep);
        let hari_ini = hris::hari_ini_wib(tx)?;
        let pengaturan = baca_pengaturan(tx)?;
        // Penjaga backend Q-72: angka disiplin yang diajukan harus hitungan kini.
        let disiplin_sama = if aksi == "Ajukan" && nilai.iter().any(|b| b.tipe == TIPE_DISIPLIN) {
            let k = satu_karyawan(tx, &s(&p, "id_karyawan"))?;
            let d = disiplin_penilaian(tx, &p, &k, &hari_ini, pengaturan.ambang)?;
            rincian_disiplin(&nilai) == Some(d.rincian.as_str())
        } else {
            true
        };
        let kd = keadaan(operator, &p, status, &nilai, &hari_ini, disiplin_sama);
        periksa_aksi_kinerja(&aksi, &alasan, &kd).map_err(invalid)?;
        let (akhir, nama_predikat) = if aksi == "Final" {
            let n = nilai_akhir(&nilai).ok_or_else(|| invalid("Isi skor semua aspek sebelum mengajukan."))?;
            (Some(n), Some(predikat(n, &pengaturan.predikat)))
        } else {
            (None, None)
        };
        // Batal berid tetap: dua perangkat yang membatalkan menghasilkan PK sama.
        let id_keputusan = if aksi == "Batal" { format!("batal-{id}") } else { new_hex_id("kkn-") };
        let waktu: String = tx.query_row(WAKTU_KEPUTUSAN_SQL, params![id], |r| r.get(0)).map_err(internal)?;
        let alasan_simpan = Some(alasan.as_str()).filter(|a| !a.is_empty());
        tx.execute(
            INSERT_KEPUTUSAN_SQL,
            params![id_keputusan, id, aksi, sidik, alasan_simpan, akhir, nama_predikat, operator.username, waktu],
        )
        .map_err(internal)?;
        let baris = kueri(tx, "SELECT * FROM hr_kinerja_keputusan WHERE id_keputusan = ?1;", params![id_keputusan])?
            .into_iter()
            .next()
            .ok_or_else(CommandError::internal)?;
        sync::enqueue(tx, client_id, "hr-performance-decision", "create", &id_keputusan, &baris, None)?;
        let semua: Vec<KeputusanKinerja> = peta_keputusan(tx, &[id.clone()])?.remove(&id).unwrap_or_default();
        Ok(json!({ "sukses": true, "id_keputusan": id_keputusan, "status": status_kinerja(&sidik, &semua) }))
    })
}

#[cfg(test)]
mod tests_alur {
    use super::*;
    use crate::desktop::turso::TursoClient;

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

    fn operator(username: &str, izin: &[&str], id_karyawan: Option<&str>) -> OperatorUser {
        OperatorUser {
            id: 1,
            kode_operator: username.into(),
            nama_operator: username.into(),
            username: username.into(),
            role: "Uji".into(),
            role_id: 9,
            role_key: "uji".into(),
            is_superadmin: false,
            permissions: izin.iter().map(|s| s.to_string()).collect(),
            permission_revision: 1,
            require_scan_photo: false,
            require_scan_ip_allowlist: false,
            totp_enabled: false,
            id_karyawan: id_karyawan.map(str::to_owned),
            login_at: None,
        }
    }

    fn hadir(conn: &Connection, tanggal: &str) {
        conn.execute(
            "INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, status_kehadiran, status_absen, sumber,
               update_terakhir, id_shift, bulan, tahun, id_sesi, jam_masuk)
             VALUES (?1, 'K1', 'Ani', 'Gudang', 'Hadir', 'Valid', 'Scanner', ?1, 1, 'Januari', 2025, 'S-' || ?1, '07:55');",
            params![tanggal],
        )
        .expect("absensi");
    }

    fn pesan(hasil: Result<Value, CommandError>) -> String {
        hasil.err().map(|e| e.message).unwrap_or_default()
    }

    /// Alur lengkap §21.11 langkah 4: buat, isi, ajukan (ditolak saat rincian
    /// basi lalu lolos setelah simpan ulang), kembalikan, final, koreksi, diri
    /// sendiri ditolak, keluar berlaku; lalu outbox diterapkan ke cloud.
    #[test]
    fn alur_fase6_kinerja() {
        let (_dir, state) = state_uji();
        let conn = storage::database(&state.data_dir).expect("db");
        conn.execute_batch(
            "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit,
               istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
             VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');
             INSERT INTO hr_jabatan (id_jabatan, nama, is_aktif) VALUES ('jbt-1', 'Staf Gudang', 1), ('jbt-2', 'Sopir', 1);
             INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, id_atasan) VALUES
               ('K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02', 'jbt-1', 'K9'),
               ('K2', 'Budi', 'Gudang', 1, 'Aktif', '2024-01-02', 'jbt-2', 'K9'),
               ('K9', 'Sari', 'Gudang', 1, 'Aktif', '2020-01-02', NULL, NULL);",
        )
        .expect("data awal");
        let hrd = operator("hrd", &[IZIN_VIEW, IZIN_ASSESS, IZIN_CONFIG, IZIN_FINALIZE], None);
        let atasan = operator("atasan", &[IZIN_ASSESS], Some("K9"));
        let ani = operator("ani", &[IZIN_ASSESS], Some("K1"));

        // Template untuk Staf Gudang; Sopir tanpa template dan tanpa bawaan.
        let t = simpan_template(
            &state,
            &hrd,
            &json!({"nama": "Staf", "jabatan": ["jbt-1"], "aspek": [
                {"nama": "Kerja sama", "tipe": "Manual", "bobot": 60},
                {"nama": "Disiplin", "tipe": "Otomatis Disiplin", "bobot": 40}
            ]}),
        )
        .expect("template");
        let id_t = t["id_template"].as_str().unwrap().to_owned();
        assert_eq!(
            pesan(simpan_template(&state, &hrd, &json!({"nama": " staf ", "aspek": [{"nama": "A", "tipe": "Manual", "bobot": 100}]}))),
            "Template \"staf\" sudah ada."
        );
        let daftar_t = templates(&state).expect("template");
        assert_eq!(daftar_t["template"][0]["jabatan"], json!(["jbt-1"]));
        simpan_pengaturan(
            &state,
            &json!({ KUNCI_PERIODE: "Bulanan", KUNCI_AMBANG: "950,900,800,700", KUNCI_PREDIKAT: PREDIKAT_BAWAAN }),
        )
        .expect("pengaturan");

        // Januari 2025: 23 hari kerja, hadir dua hari → D 23, P 86, skor 1.
        hadir(&conn, "2025-01-02");
        hadir(&conn, "2025-01-03");
        let draf = |nilai: Value| {
            json!({"id_karyawan": "K1", "periode_jenis": "Bulanan", "periode_mulai": "2025-01-01", "nilai": nilai})
        };
        let id_aspek: Vec<String> = templates(&state).unwrap()["template"][0]["aspek"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| s(a, "id_aspek"))
            .collect();
        let isian = json!([{"id_aspek": id_aspek[0], "skor": 4, "catatan": "Rapi"}]);
        assert_eq!(pesan(simpan(&state, &ani, &draf(isian.clone()))), PESAN_DIRI_SENDIRI);
        let hasil = simpan(&state, &atasan, &draf(isian.clone())).expect("buat");
        let id = hasil["id_penilaian"].as_str().unwrap().to_owned();
        assert_eq!(hasil["disiplin"]["rincian"], "23|2|0|0|21|0|86|950,900,800,700");
        let mut kuartal = draf(isian.clone());
        kuartal["periode_jenis"] = json!("Kuartal");
        assert_eq!(pesan(simpan(&state, &atasan, &kuartal)), pesan_bertumpuk("2025-01-01", "2025-01-31"));
        let mut sopir = draf(json!([]));
        sopir["id_karyawan"] = json!("K2");
        assert_eq!(pesan(simpan(&state, &atasan, &sopir)), PESAN_TANPA_TEMPLATE);

        // Absensi baru tertarik sesudah draf disimpan: Ajukan ditolak, lalu
        // lolos setelah simpan ulang menghitung disiplin dari data baru.
        hadir(&conn, "2025-01-06");
        let aksi = |op: &OperatorUser, aksi: &str, alasan: &str| {
            putuskan(&state, op, &json!({"id_penilaian": id, "aksi": aksi, "alasan": alasan}))
        };
        assert_eq!(pesan(aksi(&atasan, "Ajukan", "")), PESAN_DISIPLIN_BERUBAH);
        let mut ubah = draf(isian.clone());
        ubah["id_penilaian"] = json!(id);
        let ulang = simpan(&state, &atasan, &ubah).expect("simpan ulang");
        assert_eq!(ulang["disiplin"]["tepat"], 3);
        assert_eq!(aksi(&atasan, "Ajukan", "").expect("ajukan")["status"], STATUS_DIAJUKAN);
        assert_eq!(pesan(simpan(&state, &atasan, &ubah)), "Penilaian yang sudah diajukan atau selesai tidak bisa disunting.");
        assert_eq!(pesan(aksi(&atasan, "Final", "")), PESAN_IZIN);
        assert_eq!(pesan(aksi(&hrd, "Kembalikan", "")), "Alasan pengembalian wajib diisi.");
        assert_eq!(aksi(&hrd, "Kembalikan", "Skor kerja sama terlalu tinggi").expect("kembali")["status"], STATUS_DRAF);
        assert_eq!(aksi(&atasan, "Ajukan", "").expect("ajukan lagi")["status"], STATUS_DIAJUKAN);
        assert_eq!(aksi(&hrd, "Final", "").expect("final")["status"], STATUS_FINAL);
        // 60 × 25 × 3 + 40 × 25 × 0 = 4.500 → Kurang.
        let r = rincian(&state, &hrd, &id).expect("rincian");
        assert_eq!((r["penilaian"]["nilai_teks"].as_str(), r["penilaian"]["predikat"].as_str()), (Some("45,00"), Some("Kurang")));
        assert_eq!(r["boleh"]["Koreksi"], true);
        assert_eq!(pesan(aksi(&hrd, "Batal", "x")), "Penilaian final tidak bisa dibatalkan; buat koreksi.");
        // Diri sendiri: tanpa `view` tidak terbaca, dengan `view` terbaca setelah Final.
        assert_eq!(pesan(rincian(&state, &ani, &id)), PESAN_BELUM_FINAL_SENDIRI);
        let ani_view = operator("ani", &[IZIN_VIEW], Some("K1"));
        assert!(rincian(&state, &ani_view, &id).is_ok());

        // Koreksi: hanya `finalize`, merujuk akar, nilai disalin dari yang berlaku.
        let mut koreksi = draf(json!([]));
        koreksi["id_ref"] = json!(id);
        koreksi["alasan_koreksi"] = json!("Salah ketik skor");
        assert_eq!(pesan(simpan(&state, &atasan, &koreksi)), PESAN_IZIN);
        let k1 = simpan(&state, &hrd, &koreksi).expect("koreksi");
        let id_k = k1["id_penilaian"].as_str().unwrap().to_owned();
        assert_eq!(pesan(simpan(&state, &hrd, &koreksi)), "Penilaian ini masih punya koreksi yang belum selesai.");
        let rk = rincian(&state, &hrd, &id_k).expect("rincian koreksi");
        assert_eq!(rk["nilai"][0]["skor"], 4);
        assert_eq!(rk["id_akar"], id);
        let mut isi_k = koreksi.clone();
        isi_k["id_penilaian"] = json!(id_k);
        isi_k["nilai"] = json!([{"id_aspek": id_aspek[0], "skor": 5}]);
        simpan(&state, &hrd, &isi_k).expect("isi koreksi");
        let putus_k = |a: &str| putuskan(&state, &hrd, &json!({"id_penilaian": id_k, "aksi": a}));
        putus_k("Ajukan").expect("ajukan koreksi");
        putus_k("Final").expect("final koreksi");
        let rk = rincian(&state, &hrd, &id_k).expect("rincian koreksi");
        assert_eq!(rk["id_berlaku"], json!(id_k));
        assert_eq!(rk["penilaian"]["nilai_teks"], "60,00");
        assert_eq!(rk["penilaian"]["tanda"], json!(["dinilai_dan_difinalkan_sama", "bukan_atasan_langsung"]));

        // Daftar: K2 belum dinilai (tanpa template), K9 (sesi atasan) tidak ikut.
        let d = daftar(&state, &atasan, &json!({"periode_jenis": "Bulanan", "periode_mulai": "2025-01-01"})).expect("daftar");
        assert_eq!(d["penilaian"].as_array().unwrap().len(), 2);
        assert_eq!(d["penilaian"][0]["atasan_saya"], true);
        assert_eq!(d["belum_dinilai"], json!([{"id_karyawan": "K2", "nama": "Budi", "divisi": "Gudang", "jabatan_nama": "Sopir",
            "id_template": null, "template_nama": null, "atasan_saya": true}]));
        let d_ani = daftar(&state, &ani, &json!({"periode_mulai": "2025-01-01"})).expect("daftar ani");
        assert!(d_ani["penilaian"].as_array().unwrap().is_empty());

        // Keluar berlaku: penilaian baru ditolak, draf yang ada tetap selesai.
        let feb = simpan(&state, &atasan, &json!({"id_karyawan": "K1", "periode_jenis": "Bulanan", "periode_mulai": "2025-02-01",
            "nilai": [{"id_aspek": id_aspek[0], "skor": 3}]}))
        .expect("draf februari");
        let id_feb = feb["id_penilaian"].as_str().unwrap().to_owned();
        conn.execute("UPDATE master_data SET id_keluar = 'klr-1', status_aktif = 'Nonaktif' WHERE id_unik = 'K1';", [])
            .unwrap();
        assert_eq!(
            pesan(simpan(&state, &atasan, &json!({"id_karyawan": "K1", "periode_jenis": "Bulanan", "periode_mulai": "2025-03-01"}))),
            "Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat."
        );
        putuskan(&state, &atasan, &json!({"id_penilaian": id_feb, "aksi": "Ajukan"})).expect("ajukan februari");
        putuskan(&state, &hrd, &json!({"id_penilaian": id_feb, "aksi": "Final"})).expect("final februari");

        // Riwayat satu karyawan (tab Kinerja rincian karyawan): koreksi
        // menggantikan akarnya sebagai nilai berlaku.
        let riwayat = daftar(&state, &hrd, &json!({"id_karyawan": "K1"})).expect("riwayat");
        let berlaku: Vec<(String, bool)> = riwayat["penilaian"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (s(p, "id_penilaian"), p["berlaku"].as_bool().unwrap()))
            .collect();
        assert_eq!(berlaku.len(), 3);
        for harap in [(id.clone(), false), (id_k.clone(), true), (id_feb.clone(), true)] {
            assert!(berlaku.contains(&harap), "{harap:?}");
        }
        assert!(riwayat["belum_dinilai"].as_array().unwrap().is_empty());

        // Outbox apa adanya diterapkan handler cloud; jam cloud terisi.
        let outbox: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT domain, entity_key, payload_json FROM desktop_sync_outbox WHERE domain LIKE 'hr-performance%' ORDER BY rowid;")
                .unwrap();
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(outbox[0].0, "hr-performance-template");
        assert_eq!(outbox[0].1, id_t);
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            let hub_dir = tempfile::tempdir().unwrap();
            let hub = hub_dir.path().join("sppg-hub.db");
            let client = TursoClient::local_file(
                url::Url::parse("https://hr-kinerja.sppg.invalid").unwrap(),
                &hub,
                reqwest::Client::new(),
            );
            client.ensure_schema().await.expect("skema cloud");
            for (domain, key, payload) in &outbox {
                let payload: Value = serde_json::from_str(payload).unwrap();
                let statements = match domain.as_str() {
                    "hr-performance-template" => cloud_template_statements(&payload, key),
                    "hr-performance" => cloud_penilaian_statements(&payload, key),
                    _ => cloud_keputusan_statements(&payload, key),
                }
                .unwrap_or_else(|| panic!("payload {domain} {key} sah"));
                for (sql, args) in statements {
                    client.query_one(sql, args).await.expect("terapkan");
                }
            }
            let hub = Connection::open(&hub).unwrap();
            let hitung = |sql: &str| -> i64 { hub.query_row(sql, [], |r| r.get(0)).unwrap() };
            assert_eq!(hitung("SELECT COUNT(*) FROM hr_kinerja_penilaian;"), 3);
            assert_eq!(hitung("SELECT COUNT(*) FROM hr_kinerja_keputusan WHERE diterima_cloud IS NULL;"), 0);
            assert_eq!(hitung("SELECT COUNT(*) FROM hr_kinerja_jabatan WHERE id_template IS NOT NULL;"), 1);
            let sidik_lokal: String = conn
                .query_row("SELECT sidik FROM hr_kinerja_penilaian WHERE id_penilaian = ?1;", params![id], |r| r.get(0))
                .unwrap();
            let sidik_cloud: String = hub
                .query_row("SELECT sidik FROM hr_kinerja_penilaian WHERE id_penilaian = ?1;", params![id], |r| r.get(0))
                .unwrap();
            assert_eq!(sidik_lokal, sidik_cloud);
        });
    }
}

#[cfg(test)]
mod tests {
    // Vektor yang sama dengan `validations/hr-kinerja.test.ts`.
    use super::*;
    use serde_json::json;

    fn hari(tanggal: &str, kode: &str) -> HariDisiplin {
        HariDisiplin {
            tanggal: tanggal.into(),
            hadir: kode == "H" || kode == "T",
            telat: kode == "T",
            sakit: kode == "S",
            izin: kode == "I",
            dispensasi: kode == "D",
            alfa: kode == "A",
        }
    }

    fn tanggal_maret(n: usize) -> Vec<String> {
        (1..=n).map(|d| format!("2026-03-{d:02}")).collect()
    }

    fn hitung(
        mulai: &str,
        selesai: &str,
        hari_ini: &str,
        karyawan: &KaryawanDisiplin,
        hari: &[HariDisiplin],
        pengajuan: &[PengajuanDisiplin],
        tukar: &[TukarDisiplin],
        perjalanan: &[&str],
        kalender: &Kalender,
    ) -> Disiplin {
        let perjalanan: HashSet<String> = perjalanan.iter().map(|s| (*s).to_owned()).collect();
        hitung_disiplin(&MasukanDisiplin {
            mulai,
            selesai,
            hari_ini,
            karyawan,
            hari,
            pengajuan,
            tukar,
            perjalanan: &perjalanan,
            kalender,
            ambang: AMBANG_BAWAAN,
        })
    }

    fn setiap_hari() -> KaryawanDisiplin {
        KaryawanDisiplin { divisi: "Gudang".into(), hari_kerja: None, kode_shift: Some(1) }
    }

    #[test]
    fn vektor_disiplin_21_6() {
        let k = setiap_hari();
        let kal = Kalender::default();
        // D = 20 (tepat 17, telat 2, alfa 1) → P = 900 → skor 4.
        let t = tanggal_maret(20);
        let mut h: Vec<HariDisiplin> = t[..17].iter().map(|d| hari(d, "H")).collect();
        h.extend(t[17..19].iter().map(|d| hari(d, "T")));
        h.push(hari(&t[19], "A"));
        let d = hitung("2026-03-01", "2026-03-20", "2026-12-31", &k, &h, &[], &[], &[], &kal);
        assert_eq!((d.hari, d.permil, d.skor), (20, Some(900), Some(4)));
        assert_eq!(d.rincian, "20|17|2|1|0|0|900|950,900,800,700");
        // D = 21 (tepat 20, telat 1) → P = 976 → skor 5.
        let t = tanggal_maret(21);
        let mut h: Vec<HariDisiplin> = t[..20].iter().map(|d| hari(d, "H")).collect();
        h.push(hari(&t[20], "T"));
        let d = hitung("2026-03-01", "2026-03-21", "2026-12-31", &k, &h, &[], &[], &[], &kal);
        assert_eq!((d.hari, d.permil, d.skor), (21, Some(976), Some(5)));
        // D = 3 (kosong 3) → P = 0 → skor 1.
        let d = hitung("2026-03-01", "2026-03-03", "2026-12-31", &k, &[], &[], &[], &[], &kal);
        assert_eq!((d.hari, d.kosong, d.permil, d.skor), (3, 3, Some(0), Some(1)));
        // Tepat 10 + 4 hari cuti berlaku → D = 10, P = 1000 → skor 5.
        let t = tanggal_maret(14);
        let h: Vec<HariDisiplin> = t[..10].iter().map(|d| hari(d, "H")).collect();
        let cuti = [PengajuanDisiplin { mulai: "2026-03-11".into(), selesai: "2026-03-14".into(), kelompok: "Cuti".into() }];
        let d = hitung("2026-03-01", "2026-03-14", "2026-12-31", &k, &h, &cuti, &[], &[], &kal);
        assert_eq!((d.hari, d.dikecualikan, d.permil, d.skor), (10, 4, Some(1000), Some(5)));
        // D = 0: skor tidak dihitung, P kosong di rincian.
        let d = hitung("2026-03-05", "2026-03-04", "2026-12-31", &k, &[], &[], &[], &[], &kal);
        assert_eq!((d.hari, d.permil, d.skor), (0, None, None));
        assert_eq!(d.rincian, "0|0|0|0|0|0||950,900,800,700");
        assert!(rincian_sah(&d.rincian));
    }

    /// Semua baris klasifikasi §21.6 dalam satu rentang (2026-11-02 Senin).
    #[test]
    fn vektor_disiplin_campuran() {
        let k = KaryawanDisiplin { divisi: "Gudang".into(), hari_kerja: Some("1,2,3,4,5".into()), kode_shift: Some(1) };
        let kal = Kalender {
            libur: ["2026-11-09", "2026-11-13"].iter().map(|s| (*s).to_owned()).collect(),
            whitelist: vec![scanner::HolidayWhitelistEntry {
                id: "w1".into(),
                scope_type: "DIVISI".into(),
                scope_value: "Gudang".into(),
                tanggal_libur: Some("2026-11-13".into()),
                status_aktif: 1,
            }],
        };
        let h = vec![
            hari("2026-11-02", "H"),
            hari("2026-11-03", "T"),
            hari("2026-11-05", "S"),
            hari("2026-11-06", "A"),
            hari("2026-11-08", "H"),
            hari("2026-11-10", "A"),
        ];
        let cuti = [PengajuanDisiplin { mulai: "2026-11-06".into(), selesai: "2026-11-06".into(), kelompok: "Cuti".into() }];
        let lembur = [PengajuanDisiplin { mulai: "2026-11-11".into(), selesai: "2026-11-11".into(), kelompok: "Lembur".into() }];
        let tukar = [TukarDisiplin { tanggal: "2026-11-12".into(), hari_kerja: Some("6,7".into()), kode_shift: Some(2) }];
        let ajuan = [cuti[0].clone(), lembur[0].clone()];
        let d = hitung("2026-11-02", "2026-11-15", "2026-11-13", &k, &h, &ajuan, &tukar, &["2026-11-04"], &kal);
        assert_eq!(
            (d.tepat, d.telat, d.alfa, d.kosong, d.dikecualikan, d.hari, d.permil, d.skor),
            (3, 1, 1, 2, 2, 7, Some(500), Some(1))
        );
        assert_eq!(d.rincian, "7|3|1|1|2|2|500|950,900,800,700");
    }

    #[test]
    fn json_baris_disiplin() {
        let h = HariDisiplin::dari_json(&json!({"tanggal": "2026-11-03", "hadir": 1, "telat": 12, "menit": 20, "sakit": 0, "izin": 0, "dispensasi": 0, "alfa": 0}));
        assert_eq!(h, hari("2026-11-03", "T"));
        let k = KaryawanDisiplin::dari_json(&json!({"divisi": "Gudang", "hari_kerja": null, "kode_shift": "2"}));
        assert_eq!(k, KaryawanDisiplin { divisi: "Gudang".into(), hari_kerja: None, kode_shift: Some(2) });
    }

    fn baris(id: &str, tipe: &str, bobot: i64, urutan: i64, skor: Option<i64>) -> BarisNilai {
        BarisNilai {
            id_aspek: id.into(),
            aspek_nama: id.to_uppercase(),
            tipe: tipe.into(),
            bobot,
            urutan,
            skor,
            catatan: None,
            rincian: None,
        }
    }

    #[test]
    fn vektor_nilai_akhir_21_7() {
        let predikat_bawaan = baca_predikat(PREDIKAT_BAWAAN).expect("bawaan");
        let b = [
            baris("a", TIPE_MANUAL, 40, 0, Some(4)),
            baris("b", TIPE_MANUAL, 35, 1, Some(5)),
            baris("c", TIPE_MANUAL, 25, 2, Some(3)),
        ];
        assert_eq!(nilai_akhir(&b), Some(7750));
        assert_eq!(format_nilai(7750), "77,50");
        assert_eq!(predikat(7750, &predikat_bawaan), "Baik");
        let semua = |s| b.iter().map(|x| BarisNilai { skor: Some(s), ..x.clone() }).collect::<Vec<_>>();
        assert_eq!(nilai_akhir(&semua(5)), Some(10_000));
        assert_eq!(predikat(10_000, &predikat_bawaan), "Sangat Baik");
        assert_eq!(nilai_akhir(&semua(1)), Some(0));
        assert_eq!(predikat(0, &predikat_bawaan), "Sangat Kurang");
        assert_eq!(format_nilai(0), "0,00");
        let mut kurang = b.to_vec();
        kurang[1].skor = None;
        assert_eq!(nilai_akhir(&kurang), None);
        assert_eq!(skor_disiplin(899, AMBANG_BAWAAN), 3);
        assert_eq!(skor_disiplin(699, AMBANG_BAWAAN), 1);
    }

    fn draf_template() -> Value {
        json!({
            "nama": "  Staf   Gudang ",
            "aspek": [
                {"nama": "Kerja sama", "tipe": "Manual", "bobot": 40},
                {"nama": "Disiplin", "tipe": "Otomatis Disiplin", "bobot": 35, "panduan": "Dari absensi"},
                {"nama": "Lama", "tipe": "Manual", "bobot": 90, "is_aktif": false},
                {"nama": "Ketelitian", "tipe": "Manual", "bobot": 25}
            ],
            "jabatan": ["jbt-1", " jbt-2 ", "jbt-1"]
        })
    }

    fn pesan<T>(hasil: Result<T, String>) -> String {
        hasil.err().unwrap_or_default()
    }

    #[test]
    fn validasi_template_21_3() {
        let t = validasi_template(&draf_template()).expect("sah");
        assert_eq!(t.nama, "Staf Gudang");
        assert!(t.is_aktif && !t.is_bawaan);
        assert_eq!(t.aspek.iter().map(|a| a.urutan).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        assert_eq!(t.jabatan, vec!["jbt-1", "jbt-2"]);
        let ubah = |f: &dyn Fn(&mut Value)| {
            let mut d = draf_template();
            f(&mut d);
            pesan(validasi_template(&d))
        };
        assert_eq!(ubah(&|d| d["aspek"][0]["bobot"] = json!(41)), "Total bobot aspek aktif harus 100, sekarang 101.");
        assert_eq!(ubah(&|d| d["aspek"][0]["bobot"] = json!(0)), "Bobot aspek Kerja sama harus bilangan bulat 1 sampai 100.");
        assert_eq!(ubah(&|d| d["aspek"][3]["tipe"] = json!("Otomatis Disiplin")), "Paling banyak satu aspek Otomatis Disiplin.");
        assert_eq!(ubah(&|d| d["aspek"][3]["nama"] = json!("kerja  SAMA")), "Nama aspek kerja SAMA dipakai dua kali.");
        assert_eq!(ubah(&|d| d["aspek"][0]["tipe"] = json!("Angka")), "Tipe aspek harus Manual atau Otomatis Disiplin.");
        assert_eq!(ubah(&|d| d["nama"] = json!(" ")), "Nama template wajib diisi.");
        assert_eq!(ubah(&|d| d["aspek"] = json!([])), "Template butuh minimal satu aspek aktif.");
        assert_eq!(
            ubah(&|d| {
                d["is_bawaan"] = json!(true);
                d["is_aktif"] = json!(false);
            }),
            "Template bawaan tidak bisa dinonaktifkan. Jadikan template lain bawaan dulu."
        );
        assert_eq!(ubah(&|d| d["jabatan"] = json!([""])), "Daftar jabatan tidak valid.");
        // Aspek lama tidak boleh hilang, tipenya terkunci.
        let mut aspek = t.aspek.clone();
        aspek[0].id_aspek = "ktp-1:a".into();
        let lama = vec![("ktp-1:a".to_owned(), TIPE_MANUAL.to_owned())];
        assert!(periksa_aspek_lama(&aspek, &lama).is_ok());
        aspek[0].tipe = TIPE_DISIPLIN.into();
        assert_eq!(pesan(periksa_aspek_lama(&aspek, &lama)), "Tipe aspek Kerja sama tidak bisa diubah setelah dibuat.");
        assert_eq!(pesan(periksa_aspek_lama(&t.aspek, &lama)), "Aspek lama tidak boleh dihapus; nonaktifkan saja.");
        aspek[0].id_aspek = "ktp-1:x".into();
        assert_eq!(pesan(periksa_aspek_lama(&aspek, &lama)), "Aspek tidak dikenal; muat ulang template.");
        let semua = vec![("t1".to_owned(), "Staf".to_owned()), ("t2".to_owned(), " staf ".to_owned()), ("t3".to_owned(), "Sopir".to_owned())];
        assert!(nama_template_dipakai("STAF", "t3", &semua));
        assert!(!nama_template_dipakai("Sopir", "t3", &semua));
        let mut ganda: Vec<String> = nama_ganda(&semua).into_iter().collect();
        ganda.sort();
        assert_eq!(ganda, vec!["t1", "t2"]);
    }

    #[test]
    fn template_karyawan_q79() {
        let t = |id: &str, aktif: bool, bawaan: bool| TemplateRingkas { id_template: id.into(), is_aktif: aktif, is_bawaan: bawaan };
        let daftar = [t("ktp-a", true, false), t("ktp-b", false, false), t("ktp-z", true, true), t("ktp-y", true, true)];
        let peta: HashMap<String, Option<String>> = [
            ("jbt-1".to_owned(), Some("ktp-a".to_owned())),
            ("jbt-2".to_owned(), Some("ktp-b".to_owned())),
            ("jbt-3".to_owned(), None),
        ]
        .into_iter()
        .collect();
        assert_eq!(template_karyawan(Some("jbt-1"), &peta, &daftar).as_deref(), Some("ktp-a"));
        assert_eq!(template_karyawan(Some("jbt-2"), &peta, &daftar).as_deref(), Some("ktp-y"));
        assert_eq!(template_karyawan(Some("jbt-3"), &peta, &daftar).as_deref(), Some("ktp-y"));
        assert_eq!(template_karyawan(None, &peta, &daftar).as_deref(), Some("ktp-y"));
        assert_eq!(template_karyawan(Some("jbt-2"), &peta, &daftar[..2]), None);
    }

    #[test]
    fn periode_dan_rentang_aktif() {
        let r = |j: &str, m: &str| periode_rentang(j, m);
        assert_eq!(r("Bulanan", "2026-02-01"), Ok(("2026-02-01".into(), "2026-02-28".into())));
        assert_eq!(r("Kuartal", "2026-10-01"), Ok(("2026-10-01".into(), "2026-12-31".into())));
        assert_eq!(r("Semester", "2026-07-01"), Ok(("2026-07-01".into(), "2026-12-31".into())));
        assert_eq!(r("Tahunan", "2028-01-01"), Ok(("2028-01-01".into(), "2028-12-31".into())));
        assert_eq!(pesan(r("Kuartal", "2026-02-01")), "Tanggal 2026-02-01 bukan awal periode kuartal.");
        assert_eq!(pesan(r("Bulanan", "2026-02-02")), "Tanggal 2026-02-02 bukan awal periode bulanan.");
        assert_eq!(pesan(r("Mingguan", "2026-02-01")), "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.");
        assert_eq!(pesan(r("Bulanan", "2026-02-30")), "Tanggal mulai periode tidak valid.");
        assert_eq!(awal_periode("Semester", "2026-11-12").as_deref(), Some("2026-07-01"));
        assert_eq!(awal_periode("Kuartal", "2026-05-31").as_deref(), Some("2026-04-01"));
        assert_eq!(awal_periode("Tahunan", "2026-05-31").as_deref(), Some("2026-01-01"));

        let penuh = rentang_aktif("2026-01-01", "2026-06-30", Some("2020-01-01"), None).expect("aktif");
        assert!(penuh.penuh);
        let masuk = rentang_aktif("2026-01-01", "2026-06-30", Some("2026-03-15"), Some("2026-05-31")).expect("aktif");
        assert_eq!((masuk.mulai.as_str(), masuk.akhir.as_str(), masuk.penuh), ("2026-03-15", "2026-05-31", false));
        assert_eq!(rentang_aktif("2026-01-01", "2026-06-30", Some("2026-07-01"), None), None);
        assert!(rentang_aktif("2026-01-01", "2026-06-30", Some("rusak"), Some("")).expect("aktif").penuh);

        let ok = Some(&penuh);
        assert_eq!(pesan(periksa_buat(false, true, "2026-01-01", "2026-11-12", ok)), "Karyawan ini sudah keluar; penilaian baru tidak bisa dibuat.");
        assert_eq!(pesan(periksa_buat(false, false, "2026-01-01", "2026-11-12", ok)), "Karyawan nonaktif tidak bisa dinilai.");
        assert_eq!(pesan(periksa_buat(true, false, "2027-01-01", "2026-11-12", ok)), "Periode ini belum dimulai.");
        assert_eq!(pesan(periksa_buat(true, false, "2026-01-01", "2026-11-12", None)), "Karyawan ini tidak aktif selama periode itu.");
        assert!(periksa_buat(true, false, "2026-11-01", "2026-11-12", ok).is_ok());
    }

    #[test]
    fn bertumpuk_dan_ganda_q73() {
        let p = |id: &str, kar: &str, r: Option<&str>, m: &str, s: &str, batal: bool| RingkasPenilaian {
            id_penilaian: id.into(),
            id_karyawan: kar.into(),
            id_ref: r.map(str::to_owned),
            periode_mulai: m.into(),
            periode_selesai: s.into(),
            dibatalkan: batal,
        };
        let semua = vec![
            p("knj-1", "K1", None, "2026-01-01", "2026-06-30", false),
            p("knj-2", "K1", None, "2026-04-01", "2026-06-30", false),
            p("knj-3", "K1", Some("knj-1"), "2026-01-01", "2026-06-30", false),
            p("knj-4", "K1", None, "2026-07-01", "2026-12-31", true),
            p("knj-5", "K2", None, "2026-01-01", "2026-06-30", false),
        ];
        let baru = p("baru", "K1", None, "2026-07-01", "2026-09-30", false);
        assert_eq!(bentrok_periode(&baru, &semua), None);
        let baru = p("baru", "K1", None, "2026-06-01", "2026-06-30", false);
        assert_eq!(bentrok_periode(&baru, &semua).map(|x| x.id_penilaian.as_str()), Some("knj-1"));
        let mut ganda: Vec<String> = penilaian_ganda(&semua).into_iter().collect();
        ganda.sort();
        assert_eq!(ganda, vec!["knj-1", "knj-2"]);
        assert_eq!(pesan_bertumpuk("2026-01-01", "2026-06-30"), "Karyawan ini sudah punya penilaian untuk periode 2026-01-01 s.d. 2026-06-30.");
    }

    #[test]
    fn validasi_dan_susun_nilai() {
        let draf = json!({
            "id_karyawan": "K1",
            "periode_jenis": "Semester",
            "periode_mulai": "2026-07-01",
            "catatan": " Baik ",
            "alasan_koreksi": "tidak dipakai",
            "nilai": [
                {"id_aspek": "a", "skor": 4, "catatan": "Rapi"},
                {"id_aspek": "d", "skor": 2},
                {"id_aspek": "c", "skor": ""}
            ]
        });
        let p = validasi_penilaian(&draf).expect("sah");
        assert_eq!((p.periode_selesai.as_str(), p.catatan.as_deref(), p.alasan_koreksi.as_deref()), ("2026-12-31", Some("Baik"), None));
        assert_eq!(p.nilai[2].skor, None);
        let ubah = |f: &dyn Fn(&mut Value)| {
            let mut d = draf.clone();
            f(&mut d);
            pesan(validasi_penilaian(&d))
        };
        assert_eq!(ubah(&|d| d["nilai"][0]["skor"] = json!(6)), "Skor harus bilangan bulat 1 sampai 5.");
        assert_eq!(ubah(&|d| d["nilai"][0]["skor"] = json!("4")), "Skor harus bilangan bulat 1 sampai 5.");
        assert_eq!(ubah(&|d| d["nilai"][1]["id_aspek"] = json!("a")), "Aspek ganda dalam isian nilai.");
        assert_eq!(ubah(&|d| d["id_ref"] = json!("knj-1")), "");
        assert_eq!(
            ubah(&|d| {
                d["id_ref"] = json!("knj-1");
                d["alasan_koreksi"] = json!(" ");
            }),
            "Alasan koreksi wajib diisi."
        );
        assert_eq!(ubah(&|d| d["id_karyawan"] = json!("")), "Pilih karyawan.");

        let salinan = vec![
            baris("a", TIPE_MANUAL, 40, 0, None),
            baris("d", TIPE_DISIPLIN, 35, 1, None),
            baris("c", TIPE_MANUAL, 25, 2, None),
        ];
        let disiplin = |skor: Option<i64>, rincian: &str| Disiplin {
            hari: 0,
            tepat: 0,
            telat: 0,
            alfa: 0,
            kosong: 0,
            dikecualikan: 0,
            permil: None,
            ambang: AMBANG_BAWAAN,
            skor,
            rincian: rincian.into(),
        };
        let d4 = disiplin(Some(4), "20|17|2|1|0|0|900|950,900,800,700");
        let hasil = susun_nilai(&salinan, &p.nilai, Some(&d4)).expect("susun");
        assert_eq!(hasil[0].skor, Some(4));
        assert_eq!((hasil[1].skor, hasil[1].rincian.as_deref()), (Some(4), Some("20|17|2|1|0|0|900|950,900,800,700")));
        assert!(!skor_lengkap(&hasil));
        let d0 = disiplin(None, "0|0|0|0|0|5||950,900,800,700");
        assert_eq!(pesan(susun_nilai(&salinan, &p.nilai, Some(&d0))), PESAN_DISIPLIN_MANUAL);
        let mut isian = p.nilai.clone();
        isian[1].catatan = Some("Cuti panjang".into());
        assert_eq!(susun_nilai(&salinan, &isian, Some(&d0)).expect("manual")[1].skor, Some(2));
        isian.push(IsianNilai { id_aspek: "x".into(), skor: None, catatan: None });
        assert_eq!(pesan(susun_nilai(&salinan, &isian, Some(&d0))), "Aspek penilaian tidak dikenal; muat ulang template.");

        // Muat ulang: skor aspek yang masih ada dipertahankan.
        let ulang = muat_ulang_template(vec![baris("c", TIPE_MANUAL, 60, 0, None), baris("e", TIPE_MANUAL, 40, 1, None)], &hasil);
        assert_eq!(ulang.iter().map(|b| b.skor).collect::<Vec<_>>(), vec![None, None]);
        let ulang = muat_ulang_template(vec![baris("a", TIPE_MANUAL, 60, 0, None)], &hasil);
        assert_eq!(ulang[0].skor, Some(4));
        assert_eq!(ulang[0].bobot, 60);
    }

    #[test]
    fn kanonik_dan_sidik() {
        let mut d = baris("d", TIPE_DISIPLIN, 35, 1, Some(4));
        d.rincian = Some("20|17|2|1|0|0|900|950,900,800,700".into());
        let mut a = baris("a", TIPE_MANUAL, 65, 0, Some(5));
        a.catatan = Some("Rapi".into());
        let nilai = [d, a];
        let isi = IsiPenilaian {
            id_karyawan: "K1",
            id_ref: None,
            periode_mulai: "2026-07-01",
            periode_selesai: "2026-12-31",
            id_template: "ktp-1",
            catatan: Some("Baik"),
            nilai: &nilai,
        };
        let kanonik = "K1\u{1f}\u{1f}2026-07-01\u{1f}2026-12-31\u{1f}ktp-1\u{1f}Baik\u{1f}a\u{1f}Manual\u{1f}65\u{1f}5\u{1f}Rapi\u{1f}\u{1f}d\u{1f}Otomatis Disiplin\u{1f}35\u{1f}4\u{1f}\u{1f}20|17|2|1|0|0|900|950,900,800,700";
        assert_eq!(kanonik_penilaian(&isi), kanonik);
        assert_eq!(sidik_penilaian(&isi), hex::encode(Sha256::digest(kanonik.as_bytes())));
    }

    fn kep(id: &str, jenis: &str, sidik: &str, waktu: &str, cloud: Option<&str>) -> KeputusanKinerja {
        KeputusanKinerja {
            id_keputusan: id.into(),
            jenis: jenis.into(),
            sidik: sidik.into(),
            oleh: "hrd".into(),
            waktu_perangkat: waktu.into(),
            diterima_cloud: cloud.map(str::to_owned),
            nilai_akhir: None,
            predikat: None,
        }
    }

    #[test]
    fn status_tanda_dan_berlaku() {
        let w = |n: u8| format!("2026-12-31 10:0{n}:00");
        assert_eq!(status_kinerja("s1", &[]), STATUS_DRAF);
        let ajukan = kep("k1", "Ajukan", "s1", &w(1), Some(&w(1)));
        assert_eq!(status_kinerja("s1", std::slice::from_ref(&ajukan)), STATUS_DIAJUKAN);
        // Ajukan atas isi lama tidak berlaku untuk isi sekarang.
        assert_eq!(status_kinerja("s2", std::slice::from_ref(&ajukan)), STATUS_DRAF);
        let kembali = kep("k2", "Kembalikan", "s1", &w(2), Some(&w(2)));
        assert_eq!(status_kinerja("s1", &[ajukan.clone(), kembali.clone()]), STATUS_DRAF);
        let ajukan2 = kep("k3", "Ajukan", "s1", &w(3), None);
        assert_eq!(status_kinerja("s1", &[ajukan.clone(), kembali.clone(), ajukan2.clone()]), STATUS_DIAJUKAN);
        let final1 = kep("k4", "Final", "s1", &w(4), Some(&w(4)));
        let semua = vec![ajukan.clone(), kembali, ajukan2, final1.clone()];
        assert_eq!(status_kinerja("s1", &semua), STATUS_FINAL);
        assert_eq!(status_kinerja("s9", &semua), STATUS_DRAF);
        let mut batal = semua.clone();
        batal.push(kep("k5", "Batal", "s1", &w(5), None));
        assert_eq!(status_kinerja("s1", &batal), STATUS_DIBATALKAN);

        fn info<'a>(sidik: &'a str, keputusan: &'a [KeputusanKinerja]) -> InfoTanda<'a> {
            InfoTanda {
                sidik,
                keputusan,
                penilai_oleh: "atasan",
                id_penilai: Some("K9"),
                id_atasan: Some("K9"),
                rincian_disiplin: Some("20|17|2|1|0|0|900|950,900,800,700"),
                periode_penuh: true,
                ganda: false,
            }
        }
        assert!(tanda_kinerja(&info("s1", &semua)).is_empty());
        assert_eq!(tanda_kinerja(&info("s9", &semua)), vec!["final_gugur"]);
        assert_eq!(tanda_kinerja(&info("s1", &batal)), vec!["final_dibatalkan"]);
        let lain = InfoTanda {
            penilai_oleh: " HRD ",
            id_penilai: None,
            rincian_disiplin: Some("0|0|0|0|0|3||950,900,800,700"),
            periode_penuh: false,
            ganda: true,
            ..info("s1", &semua)
        };
        assert_eq!(
            tanda_kinerja(&lain),
            vec!["penilaian_ganda", "dinilai_dan_difinalkan_sama", "bukan_atasan_langsung", "disiplin_manual", "periode_tidak_penuh"]
        );

        // Nilai berlaku = Final paling akhir di antara akar dan koreksinya.
        let f_akar = kep("f1", "Final", "s1", "2026-12-31 10:00:00", Some("2027-01-02 08:00:00"));
        let f_koreksi = kep("f2", "Final", "s2", "2027-01-01 09:00:00", Some("2027-01-05 08:00:00"));
        assert_eq!(kinerja_berlaku(&[("knj-1", &f_akar), ("knj-2", &f_koreksi)]), Some("knj-2"));
        assert_eq!(kinerja_berlaku(&[]), None);
        assert_eq!(final_berlaku("s1", &[final1.clone(), kep("k0", "Final", "s1", &w(0), Some(&w(0)))]).map(|k| k.id_keputusan.as_str()), Some("k0"));
    }

    #[test]
    fn aksi_kinerja_21_5() {
        let dasar = KeadaanKinerja {
            status: STATUS_DRAF.into(),
            boleh_assess: true,
            skor_lengkap: true,
            periode_selesai: true,
            disiplin_sama: true,
            ..Default::default()
        };
        let cek = |aksi: &str, alasan: &str, ubah: &dyn Fn(&mut KeadaanKinerja)| {
            let mut k = dasar.clone();
            ubah(&mut k);
            pesan(periksa_aksi_kinerja(aksi, alasan, &k))
        };
        assert_eq!(cek("Simpan", "", &|_| {}), "");
        assert_eq!(cek("Simpan", "", &|k| k.status = String::new()), "");
        assert_eq!(cek("Simpan", "", &|k| k.status = STATUS_DIAJUKAN.into()), "Penilaian yang sudah diajukan atau selesai tidak bisa disunting.");
        assert_eq!(cek("Simpan", "", &|k| k.karyawan_sendiri = true), PESAN_DIRI_SENDIRI);
        assert_eq!(cek("Simpan", "", &|k| k.boleh_assess = false), PESAN_IZIN);
        assert_eq!(
            cek("Simpan", "", &|k| {
                k.boleh_assess = false;
                k.boleh_finalize = true;
                k.koreksi = true;
            }),
            ""
        );
        assert_eq!(cek("Ajukan", "", &|_| {}), "");
        assert_eq!(cek("Ajukan", "", &|k| k.skor_lengkap = false), "Isi skor semua aspek sebelum mengajukan.");
        assert_eq!(cek("Ajukan", "", &|k| k.periode_selesai = false), "Penilaian baru bisa diajukan sejak hari terakhir periode.");
        assert_eq!(cek("Ajukan", "", &|k| k.disiplin_sama = false), PESAN_DISIPLIN_BERUBAH);
        assert_eq!(cek("Ajukan", "", &|k| k.status = STATUS_FINAL.into()), "Hanya draf yang bisa diajukan.");
        let diajukan = |k: &mut KeadaanKinerja| {
            k.status = STATUS_DIAJUKAN.into();
            k.boleh_finalize = true;
        };
        assert_eq!(cek("Final", "", &diajukan), "");
        assert_eq!(cek("Final", "", &|k| k.status = STATUS_DIAJUKAN.into()), PESAN_IZIN);
        assert_eq!(cek("Kembalikan", " ", &diajukan), "Alasan pengembalian wajib diisi.");
        assert_eq!(cek("Kembalikan", "Skor tidak sesuai", &diajukan), "");
        assert_eq!(cek("Final", "", &|k| k.boleh_finalize = true), "Penilaian ini tidak sedang diajukan.");
        assert_eq!(cek("Batal", "Salah karyawan", &|_| {}), "");
        assert_eq!(cek("Batal", "", &|_| {}), "Alasan pembatalan wajib diisi.");
        assert_eq!(cek("Batal", "x", &|k| k.status = STATUS_FINAL.into()), "Penilaian final tidak bisa dibatalkan; buat koreksi.");
        assert_eq!(cek("Batal", "x", &|k| k.status = STATUS_DIBATALKAN.into()), "Penilaian ini sudah dibatalkan.");
        assert_eq!(cek("Koreksi", "", &|k| k.akar_final = true), PESAN_IZIN);
        let koreksi = |k: &mut KeadaanKinerja| {
            k.boleh_finalize = true;
            k.akar_final = true;
        };
        assert_eq!(cek("Koreksi", "", &koreksi), "");
        assert_eq!(cek("Koreksi", "", &|k| k.boleh_finalize = true), "Koreksi hanya untuk penilaian yang sudah final.");
        assert_eq!(
            cek("Koreksi", "", &|k| {
                koreksi(k);
                k.koreksi_terbuka = true;
            }),
            "Penilaian ini masih punya koreksi yang belum selesai."
        );
        assert_eq!(cek("Hapus", "", &|_| {}), "Aksi penilaian tidak dikenal.");
        assert_eq!(cek("Batal", &"x".repeat(501), &|_| {}), "Alasan maksimal 500 karakter.");
    }

    #[test]
    fn pengaturan_kinerja() {
        let bawaan = PengaturanKinerja::dari_peta(&HashMap::new());
        assert_eq!(bawaan.periode, "Semester");
        assert_eq!(bawaan.ambang, [950, 900, 800, 700]);
        assert_eq!(bawaan.predikat.len(), 5);
        let rusak: HashMap<String, String> = [
            (KUNCI_PERIODE.to_owned(), "Mingguan".to_owned()),
            (KUNCI_AMBANG.to_owned(), "900,950,800,700".to_owned()),
            (KUNCI_PREDIKAT.to_owned(), "5000:Baik".to_owned()),
        ]
        .into_iter()
        .collect();
        assert_eq!(PengaturanKinerja::dari_peta(&rusak), bawaan);
        let sah = validasi_pengaturan_kinerja(&json!({
            KUNCI_PERIODE: "Kuartal",
            KUNCI_AMBANG: " 990, 950 ,900,850 ",
            KUNCI_PREDIKAT: "8000: Baik | 0:Perlu Bimbingan"
        }))
        .expect("sah");
        assert_eq!(
            sah,
            vec![
                (KUNCI_PERIODE, "Kuartal".to_owned()),
                (KUNCI_AMBANG, "990,950,900,850".to_owned()),
                (KUNCI_PREDIKAT, "8000:Baik|0:Perlu Bimbingan".to_owned()),
            ]
        );
        let peta: HashMap<String, String> = sah.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        assert_eq!(PengaturanKinerja::dari_peta(&peta).ambang, [990, 950, 900, 850]);
        let salah = |kunci: &str, nilai: &str| {
            let mut d = json!({ KUNCI_PERIODE: "Semester", KUNCI_AMBANG: "950,900,800,700", KUNCI_PREDIKAT: PREDIKAT_BAWAAN });
            d[kunci] = json!(nilai);
            pesan(validasi_pengaturan_kinerja(&d))
        };
        assert_eq!(salah(KUNCI_PERIODE, "Mingguan"), "Jenis periode harus Bulanan, Kuartal, Semester, atau Tahunan.");
        assert_eq!(salah(KUNCI_AMBANG, "950,950,800,700"), PESAN_AMBANG);
        assert_eq!(salah(KUNCI_AMBANG, "1001,900,800,700"), PESAN_AMBANG);
        assert_eq!(salah(KUNCI_AMBANG, "950,900,800"), PESAN_AMBANG);
        assert_eq!(salah(KUNCI_AMBANG, "950,900,800,0"), PESAN_AMBANG);
        assert_eq!(salah(KUNCI_PREDIKAT, "0:Kurang"), "Predikat harus 2 sampai 7 tingkat.");
        assert_eq!(salah(KUNCI_PREDIKAT, "9000:Baik|100:Kurang"), "Ambang predikat harus turun dan yang terakhir 0.");
        assert_eq!(salah(KUNCI_PREDIKAT, "4000:Baik|9000:Kurang|0:X"), "Ambang predikat harus turun dan yang terakhir 0.");
        assert_eq!(salah(KUNCI_PREDIKAT, "9000:Baik|0:"), "Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.");
        assert_eq!(salah(KUNCI_PREDIKAT, "9000:A:B|0:C"), "Nama predikat 1 sampai 50 karakter, tanpa tanda : dan |.");
        assert_eq!(salah(KUNCI_PREDIKAT, "Baik|0:C"), "Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.");
        assert_eq!(salah(KUNCI_PREDIKAT, "10001:Baik|0:C"), "Setiap predikat berbentuk ambang:nama, misalnya 7500:Baik.");

        assert!(rincian_sah("7|3|1|1|2|2|500|950,900,800,700"));
        assert!(!rincian_sah("7|3|1|1|1|2|500|950,900,800,700"));
        assert!(!rincian_sah("0|0|0|0|0|0|0|950,900,800,700"));
        assert!(!rincian_sah("7|3|1|1|2|2|1001|950,900,800,700"));
        assert!(!rincian_sah("7|3|1|1|2|2|500|950,900,800"));
        assert!(!rincian_sah("7|+3|1|1|2|2|500|950,900,800,700"));
        assert!(!rincian_sah("7|3|1|1|2|2|+500|950,900,800,700"));
    }
}
