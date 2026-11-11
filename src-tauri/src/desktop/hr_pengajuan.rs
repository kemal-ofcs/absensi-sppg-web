//! HRIS fase 2: pengajuan cuti, izin, sakit dan jatah cuti (prd-hris.md §17).
//!
//! Status pengajuan dan jatah cuti TIDAK disimpan: status diturunkan dari
//! keputusan append-only yang sidiknya cocok dengan isi pengajuan, jatah dari
//! pengajuan berlaku dan penyesuaian. Cermin `validations/hr-pengajuan.ts` +
//! `services/hr-pengajuan.ts`, diuji dengan vektor yang sama.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{hari_kerja, hris, models::CommandError, scanner, time_policy};

#[derive(Debug, Clone, Deserialize)]
pub struct JenisBawaan {
    pub id_jenis: String,
    pub nama: String,
    pub kelompok: String,
    pub potong_jatah: bool,
    pub dampak_gaji: String,
    pub boleh_urgent: bool,
    pub maks_hari: Option<i64>,
    pub satuan_maks: String,
    pub wajib_dokumen: bool,
    /// Kosong = `hr.request.decide` (v39).
    #[serde(default)]
    pub izin_pemutus: Option<String>,
    #[serde(default)]
    pub batas_bulanan: Option<i64>,
}

/// Jenis pengajuan bawaan (§6.3) dari berkas JSON yang SAMA dengan yang
/// diimpor `validations/hr-pengajuan.ts`.
pub fn jenis_bawaan() -> &'static [JenisBawaan] {
    static JENIS: OnceLock<Vec<JenisBawaan>> = OnceLock::new();
    JENIS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/lib/validations/hr-jenis-bawaan.json"
        ))
        .expect("hr-jenis-bawaan.json tidak valid")
    })
}

/// Cermin `SEED_JENIS_SQL`. Idempoten: jenis yang sudah disunting tidak ditimpa.
pub const SEED_JENIS_SQL: &str = "INSERT OR IGNORE INTO hr_jenis_pengajuan (id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif, batas_bulanan) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11);";

impl JenisBawaan {
    fn pemutus(&self) -> &str {
        self.izin_pemutus.as_deref().unwrap_or(IZIN_PEMUTUS_AKTIF)
    }
}

/// Argumen `SEED_JENIS_SQL` untuk satu jenis, dipakai seed lokal dan cloud.
pub fn seed_jenis_args(jenis: &JenisBawaan) -> Vec<Value> {
    vec![
        json!(jenis.id_jenis),
        json!(jenis.nama),
        json!(jenis.kelompok),
        json!(jenis.pemutus()),
        json!(i64::from(jenis.boleh_urgent)),
        json!(i64::from(jenis.potong_jatah)),
        json!(jenis.dampak_gaji),
        json!(jenis.maks_hari),
        json!(jenis.satuan_maks),
        json!(i64::from(jenis.wajib_dokumen)),
        json!(jenis.batas_bulanan),
    ]
}

/// Menanam jenis bawaan ke SQLite lokal. Barisnya TIDAK masuk outbox: cloud
/// menanam seed yang sama, jadi mendorongnya hanya akan menimpa jenis yang
/// sudah disunting perusahaan.
pub fn seed_jenis_bawaan(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(SEED_JENIS_SQL)?;
    for jenis in jenis_bawaan() {
        statement.execute(params![
            jenis.id_jenis,
            jenis.nama,
            jenis.kelompok,
            jenis.pemutus(),
            i64::from(jenis.boleh_urgent),
            i64::from(jenis.potong_jatah),
            jenis.dampak_gaji,
            jenis.maks_hari,
            jenis.satuan_maks,
            i64::from(jenis.wajib_dokumen),
            jenis.batas_bulanan,
        ])?;
    }
    Ok(())
}

// ── Konstanta ──────────────────────────────────────────────────────────────

/// Kelompok yang bisa diajukan (fase 2–4).
pub const KELOMPOK_AKTIF: [&str; 7] = ["Cuti", "Izin", "Sakit", "Lembur", "Tukar Shift", "Dinas Luar", "Reimburse"];
/// Kelompok yang menutup hari kerja (Alfa, audit, laporan, `cuti_dibayar`).
/// Lembur, Tukar Shift, dan Reimburse TIDAK: karyawannya tetap wajib masuk (§18.3).
pub const KELOMPOK_TIDAK_HADIR: [&str; 4] = ["Cuti", "Izin", "Sakit", "Dinas Luar"];
/// Kelompok tanpa dampak gaji dan tanpa jatah: dipaksa saat jenis disimpan.
pub const KELOMPOK_TANPA_GAJI: [&str; 3] = ["Lembur", "Tukar Shift", "Reimburse"];
pub const DAMPAK_GAJI: [&str; 3] = ["Dibayar", "Potong Gaji", "Tidak Berpengaruh"];
pub const SATUAN_MAKS: [&str; 2] = ["Hari Kerja", "Hari Kalender"];
/// Pemutus bawaan; jenis boleh memilih salah satu dari `IZIN_PEMUTUS` (Q-2).
pub const IZIN_PEMUTUS_AKTIF: &str = "hr.request.decide";
pub const IZIN_REIMBURSE: &str = "reimburse.decide";
pub const IZIN_PEMUTUS: [&str; 2] = [IZIN_PEMUTUS_AKTIF, IZIN_REIMBURSE];
/// Nominal klaim dan batas bulanan reimbursement, rupiah (aturan 13).
pub const MAKS_NOMINAL: i64 = 1_000_000_000;
pub const PESAN_NOMINAL: &str = "Nominal harus 1 sampai 1.000.000.000 rupiah.";
pub const KEPUTUSAN_FINAL: [&str; 3] = ["Setujui", "Tolak", "Setujui Urgent"];
pub const AKSI_KEPUTUSAN: [&str; 4] = ["Setujui", "Tolak", "Diketahui", "Batal"];
pub const MAKS_ALASAN: usize = 500;
pub const MAKS_RENTANG_HARI: i64 = 366;
pub const MAKS_HARI_JENIS: i64 = 366;

// ── Potongan SQL kembar (teks diperiksa identik oleh tes TS) ───────────────

macro_rules! berlaku_sql {
    () => {
        "NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal') AND (SELECT k.jenis FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY k.diterima_cloud IS NULL, k.diterima_cloud, k.waktu_perangkat, k.id_keputusan LIMIT 1) IN ('Setujui', 'Setujui Urgent')"
    };
}

// Predikat "pengajuan berlaku" atas alias `p` (§17.3), cermin
// `PENGAJUAN_BERLAKU_SQL`. Satu-satunya bentuk SQL status; dipakai lewat
// `concat!` oleh `PENGAJUAN_RENTANG_SQL`, `LAPORAN_PENGAJUAN_SQL`, dan rekap bulanan.
pub(crate) use berlaku_sql;

/// Pengajuan berlaku yang bertumpuk dengan rentang `?1`..`?2`.
/// Hanya kelompok ketidakhadiran (`KELOMPOK_TIDAK_HADIR`).
pub const PENGAJUAN_RENTANG_SQL: &str = concat!(
    "SELECT p.id_pengajuan, p.id_karyawan, p.tanggal_mulai, p.tanggal_selesai, p.kelompok, p.dampak_gaji, p.potong_jatah, p.setengah_hari FROM hr_pengajuan p WHERE p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ",
    berlaku_sql!(),
    " ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;"
);

/// Pengajuan berlaku untuk laporan kehadiran `?1`..`?2`, satu objek JSON per baris.
pub const LAPORAN_PENGAJUAN_SQL: &str = concat!(
    "SELECT json_object('id', p.id_karyawan, 'mulai', p.tanggal_mulai, 'selesai', p.tanggal_selesai, 'kelompok', p.kelompok) FROM hr_pengajuan p WHERE p.tanggal_mulai <= ?2 AND p.tanggal_selesai >= ?1 AND p.kelompok IN ('Cuti', 'Izin', 'Sakit', 'Dinas Luar') AND ",
    berlaku_sql!(),
    " ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;"
);

/// SPL berlaku dengan tanggal kerja dalam `?1`..`?2` (§18.4).
pub const SPL_RENTANG_SQL: &str = concat!(
    "SELECT p.id_karyawan, p.tanggal_mulai, p.jam_mulai, p.jam_selesai FROM hr_pengajuan p WHERE p.kelompok = 'Lembur' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    berlaku_sql!(),
    " ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;"
);

/// Tukar shift berlaku dalam `?1`..`?2`, satu baris per karyawan: shift yang
/// dipakai karyawan itu di tanggal tukar (§18.5).
pub const TUKAR_RENTANG_SQL: &str = concat!(
    "SELECT p.id_karyawan, p.tanggal_mulai, p.id_shift_tukar, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    berlaku_sql!(),
    " UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    berlaku_sql!(),
    " ORDER BY 1, 2, 4;"
);

/// Tukar shift berlaku untuk laporan kehadiran `?1`..`?2`: hari kerja dan
/// kode shift yang dipakai tiap karyawan di tanggal tukar.
pub const LAPORAN_TUKAR_SQL: &str = concat!(
    "SELECT json_object('id', t.id, 'tanggal', t.tanggal, 'hari_kerja', s.hari_kerja, 'kode_shift', s.kode_shift) FROM (SELECT p.id_karyawan AS id, p.tanggal_mulai AS tanggal, p.id_shift_tukar AS id_shift, p.id_pengajuan AS urut FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    berlaku_sql!(),
    " UNION ALL SELECT p.id_karyawan_tukar, p.tanggal_mulai, p.id_shift_asal, p.id_pengajuan FROM hr_pengajuan p WHERE p.kelompok = 'Tukar Shift' AND p.tanggal_mulai >= ?1 AND p.tanggal_mulai <= ?2 AND ",
    berlaku_sql!(),
    ") t JOIN tbl_shift s ON s.id_shift = t.id_shift WHERE t.id IS NOT NULL ORDER BY t.id, t.tanggal, t.urut;"
);

/// Penugasan backup aktif salah satu dari dua karyawan di satu tanggal.
pub const BACKUP_TUKAR_SQL: &str = "SELECT id_backup FROM backup_karyawan WHERE status_tugas = 'Aktif' AND tanggal_tugas = ?1 AND (id_karyawan_asal IN (?2, ?3) OR id_karyawan_pengganti IN (?2, ?3)) LIMIT 1;";

/// Tanggal hadir `(id_karyawan, tanggal)` dalam `?1`..`?2`: definisi
/// `HARI_HADIR_SQL` (scan Hadir atau laporan perjalanan), sebagai daftar.
pub const TANGGAL_HADIR_SQL: &str = "SELECT a.id_karyawan, a.tanggal FROM absensi_harian a WHERE a.tanggal >= ?1 AND a.tanggal <= ?2 AND a.status_kehadiran IN ('Hadir', 'PRESENT') UNION SELECT l.id_karyawan, date(l.waktu_perangkat, '+7 hours') FROM drv_laporan l WHERE l.id_karyawan IS NOT NULL AND l.waktu_perangkat >= datetime(?1, '-7 hours') AND l.waktu_perangkat < datetime(?2, '+17 hours');";

/// Proses gaji `PAID` yang periodenya menyentuh `?1`..`?2`.
pub const PERIODE_DIBAYAR_SQL: &str = "SELECT period_start, period_end FROM payroll_runs WHERE status = 'PAID' AND period_start <= ?2 AND period_end >= ?1 ORDER BY period_start LIMIT 1;";

/// Klaim Reimburse berlaku bertanggal ≤ `?1` + nominal berlakunya (§19.3):
/// `nominal_disetujui` keputusan yang berlaku (urutan sama dengan
/// `berlaku_sql!`), kosong = nominal diajukan.
pub const KLAIM_BERLAKU_SQL: &str = concat!(
    "SELECT p.id_pengajuan, p.id_karyawan, p.tanggal_mulai, COALESCE((SELECT k.nominal_disetujui FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY k.diterima_cloud IS NULL, k.diterima_cloud, k.waktu_perangkat, k.id_keputusan LIMIT 1), p.nominal, 0), COALESCE((SELECT j.nama FROM hr_jenis_pengajuan j WHERE j.id_jenis = p.id_jenis), p.id_jenis) || ': ' || p.alasan FROM hr_pengajuan p WHERE p.kelompok = 'Reimburse' AND p.tanggal_mulai <= ?1 AND ",
    berlaku_sql!(),
    " ORDER BY p.id_karyawan, p.tanggal_mulai, p.id_pengajuan;"
);

/// Cuti diuangkan yang tidak dibatalkan (Q-62), dibayar lewat pembayaran terpisah.
pub const UANG_BERLAKU_SQL: &str = "SELECT u.id_penyesuaian, u.id_karyawan, u.periode, COALESCE(u.nominal, 0), 'Cuti diuangkan periode ' || u.periode FROM hr_cuti_penyesuaian u WHERE u.jenis = 'Diuangkan' AND NOT EXISTS (SELECT 1 FROM hr_cuti_penyesuaian b WHERE b.jenis = 'Pembatalan' AND b.id_ref = u.id_penyesuaian) ORDER BY u.id_karyawan, u.periode, u.id_penyesuaian;";

/// Klaim di `breakdown_snapshot.reimburse` proses gaji yang tidak ditolak.
pub const GAJI_REIMBURSE_SQL: &str = "SELECT r.id, r.status, json_extract(k.value, '$.id_pengajuan'), CAST(json_extract(k.value, '$.nominal') AS INTEGER) FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id, json_each(i.breakdown_snapshot, '$.reimburse') k WHERE r.status <> 'REJECTED' ORDER BY r.id;";

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

fn tambah_hari(tanggal: &str, n: i64) -> Option<String> {
    time_policy::add_days(tanggal, n).ok()
}

/// Setiap tanggal dari `mulai` sampai `selesai`, inklusif (paling banyak 400).
pub fn tanggal_rentang(mulai: &str, selesai: &str) -> Vec<String> {
    let mut hasil = Vec::new();
    let mut t = mulai.to_owned();
    while t.as_str() <= selesai && hasil.len() < 400 {
        hasil.push(t.clone());
        match tambah_hari(&t, 1) {
            Some(berikut) => t = berikut,
            None => break,
        }
    }
    hasil
}

fn selisih_hari(dari: &str, ke: &str) -> i64 {
    time_policy::days_between(dari, ke).unwrap_or(0)
}

// ── Jenis pengajuan ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JenisPengajuan {
    pub id_jenis: String,
    pub nama: String,
    pub kelompok: String,
    pub izin_pemutus: String,
    pub boleh_urgent: bool,
    pub potong_jatah: bool,
    pub dampak_gaji: String,
    pub maks_hari: Option<i64>,
    pub satuan_maks: String,
    pub wajib_dokumen: bool,
    pub is_aktif: bool,
    /// Rupiah per karyawan per bulan, hanya Reimburse; peringatan saja (v39).
    pub batas_bulanan: Option<i64>,
}

/// Bilangan bulat opsional dari isian: kosong = `None`, selain bilangan bulat
/// dalam `min..=maks` = `Err(())`.
fn angka_opsional(draft: &Value, kunci: &str, min: i64, maks: i64) -> Result<Option<i64>, ()> {
    match draft.get(kunci) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(nilai) => match nilai.as_f64() {
            Some(n) if n.fract() == 0.0 && (min as f64..=maks as f64).contains(&n) => Ok(Some(n as i64)),
            _ => Err(()),
        },
    }
}

/// Cermin `validasiJenis`. `id_jenis` diisi pemanggil.
pub fn validasi_jenis(draft: &Value) -> Result<JenisPengajuan, String> {
    let nama = hris::nama_master(&teks(draft, "nama"))?;
    let kelompok = teks(draft, "kelompok");
    if !KELOMPOK_AKTIF.contains(&kelompok.as_str()) {
        return Err("Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, Dinas Luar, atau Reimburse.".into());
    }
    let reimburse = kelompok == "Reimburse";
    let pemutus = teks(draft, "izin_pemutus");
    let izin_pemutus = if pemutus.is_empty() { IZIN_PEMUTUS_AKTIF.to_owned() } else { pemutus };
    if !IZIN_PEMUTUS.contains(&izin_pemutus.as_str()) {
        return Err("Pemutus pengajuan tidak dikenal.".into());
    }
    let batas_bulanan = if reimburse {
        angka_opsional(draft, "batas_bulanan", 1, MAKS_NOMINAL)
            .map_err(|_| "Batas bulanan harus 1 sampai 1.000.000.000 rupiah.".to_owned())?
    } else {
        None
    };
    let tanpa_gaji = KELOMPOK_TANPA_GAJI.contains(&kelompok.as_str());
    let dampak_gaji = if tanpa_gaji { "Tidak Berpengaruh".to_owned() } else { teks(draft, "dampak_gaji") };
    if !DAMPAK_GAJI.contains(&dampak_gaji.as_str()) {
        return Err("Dampak gaji tidak dikenal.".into());
    }
    let satuan = teks(draft, "satuan_maks");
    let satuan_maks = if satuan.is_empty() { "Hari Kerja".to_owned() } else { satuan };
    if !SATUAN_MAKS.contains(&satuan_maks.as_str()) {
        return Err("Satuan batas hari tidak dikenal.".into());
    }
    let potong_jatah = bendera(draft, "potong_jatah");
    if potong_jatah && kelompok != "Cuti" {
        return Err("Hanya kelompok Cuti yang bisa memotong jatah cuti.".into());
    }
    let maks_hari = match draft.get("maks_hari") {
        _ if tanpa_gaji => None,
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(nilai) => match nilai.as_f64() {
            Some(n) if n.fract() == 0.0 && (1.0..=MAKS_HARI_JENIS as f64).contains(&n) => {
                Some(n as i64)
            }
            _ => return Err(format!("Batas hari harus 1 sampai {MAKS_HARI_JENIS}.")),
        },
    };
    Ok(JenisPengajuan {
        id_jenis: String::new(),
        nama,
        kelompok,
        izin_pemutus,
        // Urgent = atasan menyetujui sendiri, melewati Keuangan (§19.3).
        boleh_urgent: !reimburse && bendera(draft, "boleh_urgent"),
        potong_jatah,
        dampak_gaji,
        maks_hari,
        satuan_maks,
        wajib_dokumen: bendera(draft, "wajib_dokumen"),
        is_aktif: draft.get("is_aktif").is_none() || bendera(draft, "is_aktif"),
        batas_bulanan,
    })
}

// ── Isian pengajuan ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PengajuanSah {
    pub id_karyawan: String,
    pub id_jenis: String,
    pub tanggal_mulai: String,
    pub tanggal_selesai: String,
    pub setengah_hari: bool,
    pub alasan: String,
    pub urgent: bool,
    /// Lembur: `HH:MM`, kosong untuk kelompok lain.
    pub jam_mulai: String,
    pub jam_selesai: String,
    /// Tukar Shift: karyawan kedua, kosong untuk kelompok lain.
    pub id_karyawan_tukar: String,
    /// Reimburse: rupiah yang diajukan.
    pub nominal: Option<i64>,
}

/// Cermin `validasiPengajuan`: kelengkapan isian, tanpa data jenis.
pub fn validasi_pengajuan(draft: &Value) -> Result<PengajuanSah, String> {
    let id_karyawan = teks(draft, "id_karyawan");
    if id_karyawan.is_empty() {
        return Err("Pilih karyawan.".into());
    }
    let id_jenis = teks(draft, "id_jenis");
    if id_jenis.is_empty() {
        return Err("Pilih jenis pengajuan.".into());
    }
    let tanggal_mulai = teks(draft, "tanggal_mulai");
    let tanggal_selesai = teks(draft, "tanggal_selesai");
    if !hari_kerja::tanggal_valid(&tanggal_mulai) || !hari_kerja::tanggal_valid(&tanggal_selesai) {
        return Err("Tanggal pengajuan tidak valid.".into());
    }
    if tanggal_selesai < tanggal_mulai {
        return Err("Tanggal selesai tidak boleh sebelum tanggal mulai.".into());
    }
    if selisih_hari(&tanggal_mulai, &tanggal_selesai) >= MAKS_RENTANG_HARI {
        return Err(format!("Rentang pengajuan paling panjang {MAKS_RENTANG_HARI} hari."));
    }
    let setengah_hari = bendera(draft, "setengah_hari");
    if setengah_hari && tanggal_mulai != tanggal_selesai {
        return Err("Setengah hari hanya untuk satu tanggal.".into());
    }
    let alasan = teks(draft, "alasan");
    if alasan.is_empty() {
        return Err("Alasan wajib diisi.".into());
    }
    if panjang(&alasan) > MAKS_ALASAN {
        return Err(format!("Alasan maksimal {MAKS_ALASAN} karakter."));
    }
    let nominal = angka_opsional(draft, "nominal", i64::MIN, i64::MAX)
        .map_err(|_| "Nominal harus bilangan bulat rupiah.".to_owned())?;
    Ok(PengajuanSah {
        id_karyawan,
        id_jenis,
        tanggal_mulai,
        tanggal_selesai,
        setengah_hari,
        alasan,
        urgent: bendera(draft, "urgent"),
        jam_mulai: teks(draft, "jam_mulai"),
        jam_selesai: teks(draft, "jam_selesai"),
        id_karyawan_tukar: teks(draft, "id_karyawan_tukar"),
        nominal,
    })
}

/// Cermin `periksaTanggalBiaya`: nota tidak boleh bertanggal di masa depan.
pub fn periksa_tanggal_biaya(tanggal: &str, hari_ini: &str) -> Result<(), String> {
    if tanggal > hari_ini {
        return Err("Tanggal biaya tidak boleh setelah hari ini.".into());
    }
    Ok(())
}

/// Cermin `periksaJenis`: isian dibanding jenisnya.
pub fn periksa_jenis(p: &PengajuanSah, jenis: &JenisPengajuan) -> Result<(), String> {
    if !jenis.is_aktif {
        return Err("Jenis pengajuan ini sudah nonaktif.".into());
    }
    if !KELOMPOK_AKTIF.contains(&jenis.kelompok.as_str()) {
        return Err("Jenis pengajuan ini belum bisa diajukan.".into());
    }
    if p.setengah_hari && jenis.kelompok != "Izin" {
        return Err("Setengah hari hanya untuk kelompok Izin.".into());
    }
    if p.urgent && !jenis.boleh_urgent {
        return Err("Jenis pengajuan ini tidak boleh urgent.".into());
    }
    let satu_tanggal = p.tanggal_mulai == p.tanggal_selesai;
    match jenis.kelompok.as_str() {
        "Lembur" => {
            if !satu_tanggal {
                return Err("Lembur diajukan per tanggal kerja.".into());
            }
            durasi_lembur(&p.jam_mulai, &p.jam_selesai)?;
        }
        "Tukar Shift" => {
            if !satu_tanggal {
                return Err("Tukar shift diajukan per tanggal.".into());
            }
            if p.id_karyawan_tukar.is_empty() {
                return Err("Pilih karyawan yang diajak bertukar.".into());
            }
            if p.id_karyawan_tukar == p.id_karyawan {
                return Err("Tukar shift harus dengan karyawan lain.".into());
            }
        }
        "Reimburse" => {
            if !satu_tanggal {
                return Err("Reimburse diajukan per nota, satu tanggal biaya.".into());
            }
            if !p.nominal.is_some_and(|n| (1..=MAKS_NOMINAL).contains(&n)) {
                return Err(PESAN_NOMINAL.into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Menit dalam hari dari `HH:MM` (00:00–23:59).
pub fn menit_jam(jam: &str) -> Option<i64> {
    let (h, m) = jam.split_once(':')?;
    if h.len() != 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m) = (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Cermin `durasiLembur`: menit SPL. Selesai ≤ mulai = lewat tengah malam.
pub fn durasi_lembur(jam_mulai: &str, jam_selesai: &str) -> Result<i64, String> {
    let (Some(a), Some(b)) = (menit_jam(jam_mulai), menit_jam(jam_selesai)) else {
        return Err("Jam lembur harus berformat JJ:MM.".into());
    };
    if a == b {
        return Err("Jam mulai dan selesai lembur tidak boleh sama.".into());
    }
    Ok(if b > a { b - a } else { b + 1440 - a })
}

/// Ringkasan pengajuan untuk `bentrok_pengajuan`.
#[derive(Debug, Clone, PartialEq)]
pub struct Ringkas<'a> {
    pub kelompok: &'a str,
    pub id_karyawan: &'a str,
    pub id_karyawan_tukar: Option<&'a str>,
    pub tanggal_mulai: &'a str,
    pub tanggal_selesai: &'a str,
    pub setengah_hari: bool,
    pub jam_mulai: Option<&'a str>,
    pub jam_selesai: Option<&'a str>,
}

impl Ringkas<'_> {
    fn orang(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.id_karyawan).chain(self.id_karyawan_tukar)
    }
    fn tidak_hadir(&self) -> bool {
        KELOMPOK_TIDAK_HADIR.contains(&self.kelompok)
    }
    /// `[mulai, akhir)` menit SPL di garis waktu tanggal kerjanya.
    fn rentang_jam(&self) -> Option<(i64, i64)> {
        let (a, b) = (self.jam_mulai?, self.jam_selesai?);
        let mulai = menit_jam(a)?;
        Some((mulai, mulai + durasi_lembur(a, b).ok()?))
    }
}

/// Cermin `bentrokPengajuan`: matriks §18.3. Keduanya Menunggu atau berlaku.
pub fn bentrok_pengajuan(a: &Ringkas<'_>, b: &Ringkas<'_>) -> bool {
    // Klaim biaya tidak pernah bertumpuk: nota di hari cuti atau lembur sah (§19.3).
    if a.kelompok == "Reimburse" || b.kelompok == "Reimburse" {
        return false;
    }
    let orang_sama = a.orang().any(|x| b.orang().any(|y| x == y));
    if !orang_sama || a.tanggal_mulai > b.tanggal_selesai || b.tanggal_mulai > a.tanggal_selesai {
        return false;
    }
    match (a.kelompok, b.kelompok) {
        ("Lembur", "Lembur") => {
            a.id_karyawan == b.id_karyawan
                && match (a.rentang_jam(), b.rentang_jam()) {
                    (Some((a0, a1)), Some((b0, b1))) => a0 < b1 && b0 < a1,
                    _ => true,
                }
        }
        ("Lembur", "Tukar Shift") | ("Tukar Shift", "Lembur") => false,
        ("Lembur", _) => !(b.kelompok == "Izin" && b.setengah_hari),
        (_, "Lembur") => !(a.kelompok == "Izin" && a.setengah_hari),
        _ => a.tidak_hadir() || b.tidak_hadir() || (a.kelompok == "Tukar Shift" && b.kelompok == "Tukar Shift"),
    }
}

/// Cermin `seninDari`: Senin minggu ISO tanggal itu.
pub fn senin_dari(tanggal: &str) -> Option<String> {
    tambah_hari(tanggal, 1 - hari_kerja::hari_iso(tanggal)?)
}

/// Cermin `lemburLewatBatas`: `spl` = (tanggal, menit) SPL Menunggu/berlaku
/// satu karyawan; tanggal yang jumlah hariannya > batas harian atau minggunya
/// > batas mingguan (menit).
pub fn lembur_lewat_batas(spl: &[(String, i64)], maks_harian: i64, maks_mingguan: i64) -> HashSet<String> {
    let mut hari: HashMap<&str, i64> = HashMap::new();
    let mut minggu: HashMap<String, i64> = HashMap::new();
    for (t, m) in spl {
        *hari.entry(t.as_str()).or_default() += m;
        *minggu.entry(senin_dari(t).unwrap_or_default()).or_default() += m;
    }
    spl.iter()
        .filter(|(t, _)| {
            hari.get(t.as_str()).copied().unwrap_or(0) > maks_harian
                || minggu.get(&senin_dari(t).unwrap_or_default()).copied().unwrap_or(0) > maks_mingguan
        })
        .map(|(t, _)| t.clone())
        .collect()
}

/// Satu tanggal kerja di rekap gaji mode `spl` (§18.4, Q-56), dalam menit.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct HariLembur {
    /// Lembur absensi di hari kerja biasa.
    pub lembur: i64,
    /// Seluruh jam (kerja + lembur) di tanggal libur.
    pub libur_total: i64,
    /// Bagian jam kerja dari `libur_total`.
    pub libur_jam_kerja: i64,
    /// Jumlah menit SPL berlaku tanggal itu.
    pub spl: i64,
}

/// Potongan mode `spl` untuk satu karyawan, dalam menit.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct PotongLembur {
    pub lembur: i64,
    pub libur_total: i64,
    pub libur_jam_kerja: i64,
    /// Jam lembur (dan jam hari libur) di tanggal tanpa SPL sama sekali.
    pub tanpa_spl: i64,
}

/// Cermin `potongLemburSpl`: dibayar `min(SPL, jam)` per tanggal. Di hari
/// libur potongan diambil dari bagian lembur dulu, baru jam kerja, supaya
/// `apply_holiday_fallback` tetap membayar sisa jam kerja sebagai reguler.
pub fn potong_lembur_spl(hari: &[HariLembur]) -> PotongLembur {
    let mut hasil = PotongLembur::default();
    for h in hari {
        hasil.lembur += (h.lembur - h.spl).max(0);
        let lebih_libur = (h.libur_total - h.spl).max(0);
        let dari_lembur = lebih_libur.min((h.libur_total - h.libur_jam_kerja).max(0));
        hasil.libur_total += lebih_libur;
        hasil.libur_jam_kerja += lebih_libur - dari_lembur;
        if h.spl == 0 {
            hasil.tanpa_spl += h.lembur + h.libur_total;
        }
    }
    hasil
}

/// Cermin `periksaMaks`: `maks_hari` dibanding hari kerja atau hari kalender.
pub fn periksa_maks(jenis: &JenisPengajuan, hari_kerja: i64, hari_kalender: i64) -> Result<(), String> {
    let Some(maks) = jenis.maks_hari else {
        return Ok(());
    };
    let kalender = jenis.satuan_maks == "Hari Kalender";
    let jumlah = if kalender { hari_kalender } else { hari_kerja };
    if jumlah > maks {
        let satuan = if kalender { "hari kalender" } else { "hari kerja" };
        return Err(format!("{} paling lama {maks} {satuan}.", jenis.nama));
    }
    Ok(())
}

/// Isi yang ikut sidik, termasuk salinan jenis saat diajukan.
#[derive(Debug, Clone, PartialEq)]
pub struct IsiPengajuan<'a> {
    pub id_karyawan: &'a str,
    pub id_jenis: &'a str,
    pub kelompok: &'a str,
    pub potong_jatah: bool,
    pub dampak_gaji: &'a str,
    pub tanggal_mulai: &'a str,
    pub tanggal_selesai: &'a str,
    pub setengah_hari: bool,
    pub alasan: &'a str,
    pub jam_mulai: Option<&'a str>,
    pub jam_selesai: Option<&'a str>,
    pub id_karyawan_tukar: Option<&'a str>,
    pub id_shift_asal: Option<i64>,
    pub id_shift_tukar: Option<i64>,
    pub nominal: Option<i64>,
}

/// Cermin `sidikPengajuan`: SHA-256 isi kanonik (§17.3). Sembilan bagian fase
/// 2 tidak berubah, jadi sidik dan keputusan lama tetap sah; Lembur, Tukar
/// Shift, dan Reimburse menambah isiannya sendiri (§18.3, §19.3).
pub fn sidik_pengajuan(isi: &IsiPengajuan<'_>) -> String {
    let angka = |s: Option<i64>| s.map(|n| n.to_string()).unwrap_or_default();
    let (asal, tukar, nominal) = (angka(isi.id_shift_asal), angka(isi.id_shift_tukar), angka(isi.nominal));
    let mut kanonik = vec![
        isi.id_karyawan,
        isi.id_jenis,
        isi.kelompok,
        if isi.potong_jatah { "1" } else { "0" },
        isi.dampak_gaji,
        isi.tanggal_mulai,
        isi.tanggal_selesai,
        if isi.setengah_hari { "1" } else { "0" },
        isi.alasan,
    ];
    match isi.kelompok {
        "Lembur" => kanonik.extend([isi.jam_mulai.unwrap_or(""), isi.jam_selesai.unwrap_or("")]),
        "Tukar Shift" => kanonik.extend([isi.id_karyawan_tukar.unwrap_or(""), asal.as_str(), tukar.as_str()]),
        "Reimburse" => kanonik.push(nominal.as_str()),
        _ => {}
    }
    let kanonik = kanonik.join("\u{1f}");
    hex::encode(Sha256::digest(kanonik.as_bytes()))
}

// ── Status dan tanda ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Keputusan {
    pub id_keputusan: String,
    pub jenis: String,
    pub sidik: String,
    pub oleh: String,
    pub waktu_perangkat: String,
    pub diterima_cloud: Option<String>,
    /// Hanya `Setujui` atas Reimburse (v39).
    #[serde(default)]
    pub nominal_disetujui: Option<i64>,
}

/// Cermin `nominalBerlaku`: nominal disetujui keputusan yang berlaku; kosong
/// (keputusan dari perangkat v38) = nominal diajukan.
pub fn nominal_berlaku(nominal: i64, berlaku: Option<&Keputusan>) -> i64 {
    berlaku.and_then(|k| k.nominal_disetujui).unwrap_or(nominal)
}

/// Cermin `urutKeputusan`, sama dengan ORDER BY `PENGAJUAN_BERLAKU_SQL`.
pub fn urut_keputusan(a: &Keputusan, b: &Keputusan) -> Ordering {
    (a.diterima_cloud.is_none(), &a.diterima_cloud, &a.waktu_perangkat, &a.id_keputusan).cmp(&(
        b.diterima_cloud.is_none(),
        &b.diterima_cloud,
        &b.waktu_perangkat,
        &b.id_keputusan,
    ))
}

/// Keputusan final pertama yang sidiknya cocok dengan isi sekarang.
pub fn keputusan_berlaku<'a>(sidik: &str, keputusan: &'a [Keputusan]) -> Option<&'a Keputusan> {
    let mut sah: Vec<&Keputusan> = keputusan
        .iter()
        .filter(|k| KEPUTUSAN_FINAL.contains(&k.jenis.as_str()) && k.sidik == sidik)
        .collect();
    sah.sort_by(|a, b| urut_keputusan(a, b));
    sah.into_iter().next()
}

/// Cermin `statusPengajuan` (§17.3, berurutan).
pub fn status_pengajuan(sidik: &str, keputusan: &[Keputusan]) -> &'static str {
    if keputusan.iter().any(|k| k.jenis == "Batal") {
        return "Dibatalkan";
    }
    match keputusan_berlaku(sidik, keputusan).map(|k| k.jenis.as_str()) {
        Some("Tolak") => "Ditolak",
        Some("Setujui") => "Disetujui",
        Some("Setujui Urgent") => "Disetujui (urgent)",
        _ => "Menunggu",
    }
}

pub fn status_berlaku(status: &str) -> bool {
    status == "Disetujui" || status == "Disetujui (urgent)"
}

fn sama_orang(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Cermin `tandaKeputusan`: tanda yang hanya bergantung pada keputusan.
pub fn tanda_keputusan(sidik: &str, diajukan_oleh: &str, keputusan: &[Keputusan]) -> Vec<&'static str> {
    let status = status_pengajuan(sidik, keputusan);
    let mut tanda = Vec::new();
    if status == "Disetujui (urgent)" && !keputusan.iter().any(|k| k.jenis == "Diketahui") {
        tanda.push("perlu_diketahui");
    }
    let finals: Vec<&Keputusan> = keputusan
        .iter()
        .filter(|k| KEPUTUSAN_FINAL.contains(&k.jenis.as_str()))
        .collect();
    let sah: Vec<&&Keputusan> = finals.iter().filter(|k| k.sidik == sidik).collect();
    if sah.iter().any(|k| k.jenis == "Tolak") && sah.iter().any(|k| k.jenis != "Tolak") {
        tanda.push("keputusan_ganda");
    }
    if status != "Dibatalkan" && !finals.is_empty() && sah.is_empty() {
        tanda.push("keputusan_gugur");
    }
    if status != "Dibatalkan" {
        if let Some(k) = keputusan_berlaku(sidik, keputusan) {
            // Urgent memang diputus pengajunya; Q-28 hanya untuk Setujui/Tolak.
            if k.jenis != "Setujui Urgent" && sama_orang(&k.oleh, diajukan_oleh) {
                tanda.push("diputus_sendiri");
            }
        }
    }
    tanda
}

// ── Aturan aksi (§17.4) ────────────────────────────────────────────────────

/// Keadaan yang menentukan boleh-tidaknya satu aksi. Semua dinilai backend.
#[derive(Debug, Clone, Default)]
pub struct KeadaanAksi {
    pub status: String,
    pub sudah_diketahui: bool,
    /// Username sesi = `diajukan_oleh`.
    pub pengaju_sendiri: bool,
    pub superadmin: bool,
    /// `master_operator.id_karyawan` sesi = karyawan pengajuan.
    pub karyawan_sendiri: bool,
    /// Sesi memegang `izin_pemutus` jenisnya.
    pub boleh_putus: bool,
    /// Kelompok Reimburse dan nominal yang diajukan (v39).
    pub reimburse: bool,
    pub nominal: i64,
}

const PESAN_IZIN_PUTUS: &str = "Kamu tidak punya izin memutus jenis pengajuan ini.";
const PESAN_DIRI_SENDIRI: &str = "Pengajuan untuk dirimu sendiri harus diputus orang lain.";

/// Cermin `periksaAksi`. `nominal_disetujui` hanya untuk `Setujui` Reimburse.
pub fn periksa_aksi(aksi: &str, alasan: &str, nominal_disetujui: Option<i64>, k: &KeadaanAksi) -> Result<(), String> {
    if !AKSI_KEPUTUSAN.contains(&aksi) {
        return Err("Keputusan tidak dikenal.".into());
    }
    if panjang(alasan.trim()) > MAKS_ALASAN {
        return Err(format!("Alasan maksimal {MAKS_ALASAN} karakter."));
    }
    let tanpa_alasan = alasan.trim().is_empty();
    if nominal_disetujui.is_some() && !(aksi == "Setujui" && k.reimburse) {
        return Err("Nominal disetujui hanya untuk menyetujui reimbursement.".into());
    }
    match aksi {
        "Setujui" | "Tolak" => {
            if k.status != "Menunggu" {
                return Err("Pengajuan ini tidak lagi menunggu keputusan.".into());
            }
            if !k.boleh_putus {
                return Err(PESAN_IZIN_PUTUS.into());
            }
            if k.karyawan_sendiri {
                return Err(PESAN_DIRI_SENDIRI.into());
            }
            if aksi == "Tolak" && tanpa_alasan {
                return Err("Alasan penolakan wajib diisi.".into());
            }
            if aksi == "Setujui" && k.reimburse {
                match nominal_disetujui {
                    Some(n) if n >= 1 && n <= k.nominal => {
                        if n < k.nominal && tanpa_alasan {
                            return Err("Alasan wajib diisi bila nominal disetujui lebih kecil dari yang diajukan.".into());
                        }
                    }
                    _ => {
                        return Err(format!(
                            "Nominal disetujui harus 1 sampai {}.",
                            super::accounting::format_rupiah(k.nominal)
                        ))
                    }
                }
            }
        }
        "Diketahui" => {
            if k.status != "Disetujui (urgent)" || k.sudah_diketahui {
                return Err("Hanya pengajuan urgent yang belum diketahui yang bisa ditandai.".into());
            }
            if !k.boleh_putus {
                return Err(PESAN_IZIN_PUTUS.into());
            }
            if k.karyawan_sendiri {
                return Err(PESAN_DIRI_SENDIRI.into());
            }
        }
        _ => {
            if tanpa_alasan {
                return Err("Alasan pembatalan wajib diisi.".into());
            }
            if k.status == "Menunggu" {
                if !k.pengaju_sendiri && !k.superadmin {
                    return Err("Hanya pengaju yang bisa membatalkan pengajuan yang masih menunggu.".into());
                }
            } else if status_berlaku(&k.status) {
                if !k.boleh_putus {
                    return Err(PESAN_IZIN_PUTUS.into());
                }
                if k.karyawan_sendiri {
                    return Err(PESAN_DIRI_SENDIRI.into());
                }
            } else {
                return Err("Pengajuan yang ditolak atau dibatalkan tidak bisa dibatalkan lagi.".into());
            }
        }
    }
    Ok(())
}

/// Cermin `periksaSunting`: hanya pengaju (atau Superadmin), hanya selama Menunggu.
pub fn periksa_sunting(status: &str, pengaju_sendiri: bool, superadmin: bool) -> Result<(), String> {
    if status != "Menunggu" {
        return Err("Pengajuan yang sudah diputus tidak bisa disunting.".into());
    }
    if !pengaju_sendiri && !superadmin {
        return Err("Hanya pengaju yang bisa menyunting pengajuan ini.".into());
    }
    Ok(())
}

/// Cermin `periksaUrgent`: urgent sama dengan menyetujui (§6.1).
pub fn periksa_urgent(karyawan_sendiri: bool) -> Result<(), String> {
    if karyawan_sendiri {
        return Err("Pengajuan urgent untuk dirimu sendiri tidak bisa disetujui sendiri.".into());
    }
    Ok(())
}

/// Cermin `pesanPeriodeDibayar`.
pub fn pesan_periode_dibayar(mulai: &str, selesai: &str) -> String {
    format!("Gaji periode {mulai} s.d. {selesai} sudah dibayar; pengajuan di tanggal itu tidak bisa diubah.")
}

/// Cermin `pesanBertumpuk`.
pub fn pesan_bertumpuk(mulai: &str, selesai: &str) -> String {
    format!("Tanggal itu bertumpuk dengan pengajuan lain karyawan ini ({mulai} s.d. {selesai}).")
}

// ── Reimbursement dan pembayaran terpisah (§19.3, §19.4) ───────────────────

pub const KUNCI_REIMBURSE_BAYAR: &str = "hr_reimburse_bayar";
pub const MODE_REIMBURSE: [&str; 2] = ["gaji", "terpisah"];
/// Bawaan `terpisah`: gaji tidak berubah sampai pemilik memilih (§19.8).
pub const MODE_REIMBURSE_BAWAAN: &str = "terpisah";
pub const SUMBER_REIMBURSE: &str = "Reimburse";
pub const SUMBER_UANG: &str = "Cuti Diuangkan";
pub const MAKS_KLAIM_PER_BAYAR: usize = 200;
pub const STATUS_DIBAYAR: &str = "Dibayar";
pub const STATUS_PROSES_GAJI: &str = "Dalam proses gaji";
pub const STATUS_BELUM_DIBAYAR: &str = "Belum dibayar";
pub const PESAN_KLAIM_DIBAYAR: &str =
    "Klaim ini sudah dibayar atau masih ada di proses gaji. Batalkan pembayarannya atau tolak proses gaji itu dulu.";
pub const PESAN_UANG_DIBAYAR: &str = "Cuti diuangkan ini sudah dibayar. Batalkan pembayarannya dulu.";

/// Cermin `modeReimburseDariTeks`: kosong atau tidak dikenal = bawaan.
pub fn mode_reimburse(nilai: Option<&str>) -> &'static str {
    match nilai.map(str::trim) {
        Some("gaji") => "gaji",
        _ => MODE_REIMBURSE_BAWAAN,
    }
}

/// Cermin `validasiAturanReimburse`: kunci absen = tidak disimpan.
pub fn validasi_aturan_reimburse(draft: &Value) -> Result<Vec<(&'static str, String)>, String> {
    if draft.get(KUNCI_REIMBURSE_BAYAR).is_none() {
        return Ok(Vec::new());
    }
    let mode = teks(draft, KUNCI_REIMBURSE_BAYAR);
    if !MODE_REIMBURSE.contains(&mode.as_str()) {
        return Err("Cara bayar reimbursement harus gaji atau terpisah.".into());
    }
    Ok(vec![(KUNCI_REIMBURSE_BAYAR, mode)])
}

/// Satu klaim yang bisa dibayar: Reimburse berlaku atau cuti diuangkan.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Klaim {
    pub id_klaim: String,
    pub sumber: String,
    pub id_karyawan: String,
    pub tanggal: String,
    /// Nominal berlaku (Reimburse) atau nominal beku (cuti diuangkan).
    pub nominal: i64,
    pub keterangan: String,
}

/// Satu baris `hr_reimburse_bayar`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BayarReimburse {
    pub id_bayar: String,
    pub jenis: String,
    pub id_ref: Option<String>,
    pub id_karyawan: String,
    pub tanggal: String,
    pub total: i64,
    pub keterangan: Option<String>,
    pub dicatat_oleh: String,
    pub created_at: String,
}

/// Satu baris `hr_reimburse_bayar_baris`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BarisReimburse {
    pub id_baris: String,
    pub id_bayar: String,
    pub sumber: String,
    pub id_klaim: String,
    pub nominal: i64,
}

/// Satu entri `breakdown_snapshot.reimburse` proses gaji yang tidak ditolak.
#[derive(Debug, Clone, PartialEq)]
pub struct GajiReimburse {
    pub id_run: String,
    pub status: String,
    pub id_klaim: String,
    pub nominal: i64,
}

/// Cermin `bayarAktifReimburse`: id pembayaran terpisah `Bayar` yang memuat
/// klaim ini dan belum dibatalkan, terurut.
pub fn bayar_aktif_reimburse<'a>(id_klaim: &str, pembayaran: &'a [BayarReimburse], baris: &[BarisReimburse]) -> Vec<&'a str> {
    let mut aktif: Vec<&'a str> = pembayaran
        .iter()
        .filter(|p| p.jenis == "Bayar")
        .filter(|p| baris.iter().any(|b| b.id_bayar == p.id_bayar && b.id_klaim == id_klaim))
        .filter(|p| !pembayaran.iter().any(|x| x.jenis == "Pembatalan" && x.id_ref.as_deref() == Some(p.id_bayar.as_str())))
        .map(|p| p.id_bayar.as_str())
        .collect();
    aktif.sort_unstable();
    aktif.dedup();
    aktif
}

/// Cermin `statusBayar` (§19.4).
pub fn status_bayar(id_klaim: &str, pembayaran: &[BayarReimburse], baris: &[BarisReimburse], gaji: &[GajiReimburse]) -> &'static str {
    let di_gaji = |paid: bool| gaji.iter().any(|g| g.id_klaim == id_klaim && (g.status == "PAID") == paid);
    if !bayar_aktif_reimburse(id_klaim, pembayaran, baris).is_empty() || di_gaji(true) {
        STATUS_DIBAYAR
    } else if di_gaji(false) {
        STATUS_PROSES_GAJI
    } else {
        STATUS_BELUM_DIBAYAR
    }
}

/// Cermin `dibayarGanda`: lebih dari satu pembayaran aktif (dua terpisah, atau
/// terpisah + proses gaji tidak ditolak).
pub fn dibayar_ganda(id_klaim: &str, pembayaran: &[BayarReimburse], baris: &[BarisReimburse], gaji: &[GajiReimburse]) -> bool {
    bayar_aktif_reimburse(id_klaim, pembayaran, baris).len() + gaji.iter().filter(|g| g.id_klaim == id_klaim).count() > 1
}

/// Cermin `kunciBatas`: karyawan, jenis, dan bulan tanggal biaya.
pub fn kunci_batas(id_karyawan: &str, id_jenis: &str, tanggal: &str) -> String {
    format!("{id_karyawan}|{id_jenis}|{}", tanggal.chars().take(7).collect::<String>())
}

/// Cermin `lewatBatas`: kunci (`kunci_batas`) yang jumlah klaimnya melewati
/// `batas_bulanan` jenisnya. `klaim` = (karyawan, jenis, tanggal, nominal)
/// klaim Menunggu (nominal diajukan) dan berlaku (nominal berlaku).
pub fn lewat_batas(klaim: &[(&str, &str, &str, i64)], batas: &HashMap<String, i64>) -> HashSet<String> {
    let mut jumlah: HashMap<String, i64> = HashMap::new();
    for (karyawan, jenis, tanggal, nominal) in klaim {
        *jumlah.entry(kunci_batas(karyawan, jenis, tanggal)).or_default() += nominal;
    }
    jumlah
        .into_iter()
        .filter(|(kunci, total)| {
            let jenis = kunci.split('|').nth(1).unwrap_or_default();
            batas.get(jenis).is_some_and(|b| total > b)
        })
        .map(|(kunci, _)| kunci)
        .collect()
}

/// Isian pembayaran terpisah yang sudah divalidasi.
#[derive(Debug, Clone, PartialEq)]
pub struct BayarReimburseValid {
    pub id_karyawan: String,
    pub id_klaim: Vec<String>,
    pub tanggal: String,
    pub keterangan: Option<String>,
}

/// Cermin `validasiBayarReimburse`. Tanggal kosong = hari ini (WIB).
pub fn validasi_bayar_reimburse(draft: &Value, hari_ini: &str) -> Result<BayarReimburseValid, String> {
    let id_karyawan = teks(draft, "id_karyawan");
    if id_karyawan.is_empty() {
        return Err("Pilih karyawan.".into());
    }
    let mut id_klaim: Vec<String> = Vec::new();
    for nilai in draft.get("id_klaim").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = nilai.as_str().map(str::trim).unwrap_or_default();
        if id.is_empty() {
            return Err("Klaim yang dipilih tidak valid.".into());
        }
        if id_klaim.iter().any(|x| x == id) {
            return Err("Klaim yang sama terpilih dua kali.".into());
        }
        id_klaim.push(id.to_owned());
    }
    if id_klaim.is_empty() {
        return Err("Pilih klaim yang dibayar.".into());
    }
    if id_klaim.len() > MAKS_KLAIM_PER_BAYAR {
        return Err(format!("Satu pembayaran paling banyak {MAKS_KLAIM_PER_BAYAR} klaim."));
    }
    let tanggal = match teks(draft, "tanggal") {
        t if t.is_empty() => hari_ini.to_owned(),
        t => t,
    };
    if !hari_kerja::tanggal_valid(&tanggal) {
        return Err("Tanggal bayar tidak valid.".into());
    }
    if tanggal.as_str() > hari_ini {
        return Err("Tanggal bayar tidak boleh setelah hari ini.".into());
    }
    let keterangan = Some(teks(draft, "keterangan")).filter(|k| !k.is_empty());
    if keterangan.as_deref().is_some_and(|k| panjang(k) > MAKS_ALASAN) {
        return Err(format!("Keterangan maksimal {MAKS_ALASAN} karakter."));
    }
    Ok(BayarReimburseValid { id_karyawan, id_klaim, tanggal, keterangan })
}

/// Cermin `periksaBayarReimburse`. Hanya di perangkat; mengembalikan klaim
/// sesuai urutan isian (totalnya = jumlah nominal berlakunya saat ini).
pub fn periksa_bayar_reimburse<'a>(
    valid: &BayarReimburseValid,
    klaim: &'a [Klaim],
    pembayaran: &[BayarReimburse],
    baris: &[BarisReimburse],
    gaji: &[GajiReimburse],
) -> Result<Vec<&'a Klaim>, String> {
    let mut hasil = Vec::with_capacity(valid.id_klaim.len());
    for id in &valid.id_klaim {
        let k = klaim
            .iter()
            .find(|k| &k.id_klaim == id)
            .ok_or("Klaim tidak ditemukan atau belum disetujui.")?;
        if k.id_karyawan != valid.id_karyawan {
            return Err("Klaim itu bukan milik karyawan ini.".into());
        }
        let status = status_bayar(id, pembayaran, baris, gaji);
        if status != STATUS_BELUM_DIBAYAR {
            return Err(format!("Klaim tanggal {} berstatus {}.", k.tanggal, status.to_lowercase()));
        }
        hasil.push(k);
    }
    Ok(hasil)
}

/// Cermin `periksaBatalBayarReimburse`. Hanya di perangkat.
pub fn periksa_batal_bayar_reimburse(pembayaran: &[BayarReimburse], id_bayar: &str) -> Result<(), String> {
    if !pembayaran.iter().any(|p| p.id_bayar == id_bayar && p.jenis == "Bayar") {
        return Err("Pembayaran tidak ditemukan.".into());
    }
    if pembayaran
        .iter()
        .any(|p| p.jenis == "Pembatalan" && p.id_ref.as_deref() == Some(id_bayar))
    {
        return Err("Pembayaran ini sudah dibatalkan.".into());
    }
    Ok(())
}

/// Cermin `periksaReimbursePayroll`: saat proses gaji `id_run` ditandai PAID,
/// setiap klaim di `breakdown_snapshot.reimburse`-nya harus masih berlaku
/// dengan nominal yang sama, dan belum dibayar di tempat lain.
pub fn periksa_reimburse_payroll(
    id_run: &str,
    entri: &[(String, i64)],
    klaim: &[Klaim],
    pembayaran: &[BayarReimburse],
    baris: &[BarisReimburse],
    gaji: &[GajiReimburse],
) -> Result<(), String> {
    for (id, nominal) in entri {
        let Some(k) = klaim.iter().find(|k| &k.id_klaim == id && k.sumber == SUMBER_REIMBURSE) else {
            return Err(format!(
                "Klaim reimbursement {id} sudah tidak berlaku. Tolak proses gaji ini lalu buat ulang."
            ));
        };
        if k.nominal != *nominal {
            return Err(format!(
                "Nominal klaim reimbursement tanggal {} berubah. Tolak proses gaji ini lalu buat ulang.",
                k.tanggal
            ));
        }
        let paid_lain = gaji
            .iter()
            .any(|g| &g.id_klaim == id && g.status == "PAID" && g.id_run != id_run);
        if paid_lain || !bayar_aktif_reimburse(id, pembayaran, baris).is_empty() {
            return Err(format!(
                "Klaim reimbursement tanggal {} sudah dibayar. Tolak proses gaji ini lalu buat ulang.",
                k.tanggal
            ));
        }
    }
    Ok(())
}

/// Id pembayaran baru, baris, dan pembatalannya (dua perangkat yang
/// membatalkan pembayaran yang sama menghasilkan PK yang sama).
pub fn id_baris_reimburse(id_bayar: &str, id_klaim: &str) -> String {
    format!("{id_bayar}:{id_klaim}")
}

pub fn id_batal_reimburse(id_bayar: &str) -> String {
    format!("batal-{id_bayar}")
}

pub const CLOUD_INSERT_BAYAR_REIMBURSE_SQL: &str = "INSERT INTO hr_reimburse_bayar (id_bayar, jenis, id_ref, id_karyawan, tanggal, total, keterangan, dicatat_oleh, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, datetime('now'))) ON CONFLICT(id_bayar) DO NOTHING;";

pub const CLOUD_INSERT_BARIS_REIMBURSE_SQL: &str = "INSERT INTO hr_reimburse_bayar_baris (id_baris, id_bayar, sumber, id_klaim, nominal) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id_baris) DO NOTHING;";

// ── Hari wajib (§17.5) ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Jadwal {
    pub hari_masuk: Vec<i64>,
    pub divisi: String,
    pub kode_shift: Option<i64>,
    pub jam_normal_menit: i64,
}

#[derive(Debug, Clone, Default)]
pub struct Kalender {
    pub libur: HashSet<String>,
    pub whitelist: Vec<scanner::HolidayWhitelistEntry>,
}

/// Cermin `tanggalWajib`: tanggal dalam rentang yang `wajib_masuk`, sama
/// dengan keputusan Generate Alfa.
pub fn tanggal_wajib(jadwal: &Jadwal, kalender: &Kalender, mulai: &str, selesai: &str) -> Vec<String> {
    tanggal_rentang(mulai, selesai)
        .into_iter()
        .filter(|t| {
            let libur = kalender.libur.contains(t);
            let masuk_saat_libur = libur
                && scanner::evaluate_holiday_scan(&kalender.whitelist, t, &jadwal.divisi, jadwal.kode_shift)
                    .is_some();
            hari_kerja::wajib_masuk(t, &jadwal.hari_masuk, libur, masuk_saat_libur)
        })
        .collect()
}

// ── Dampak gaji (§17.6) ────────────────────────────────────────────────────

/// Cermin `hitungCutiDibayar`: `(hari, menit)` dari tanggal pengajuan
/// `Dibayar` (sudah tanggal wajib), satu tanggal sekali. Hari penuh menang
/// atas setengah hari di tanggal yang sama.
pub fn hitung_cuti_dibayar(tanggal: &[(String, bool)], hadir: &HashSet<String>, jam_normal_menit: i64) -> (i64, i64) {
    let mut per_tanggal: BTreeMap<&str, bool> = BTreeMap::new();
    for (t, setengah) in tanggal {
        per_tanggal
            .entry(t.as_str())
            .and_modify(|s| *s = *s && *setengah)
            .or_insert(*setengah);
    }
    let normal = jam_normal_menit.max(0);
    let (mut hari, mut menit) = (0, 0);
    for (t, setengah) in per_tanggal {
        let sudah_hadir = hadir.contains(t);
        if setengah {
            menit += normal / 2;
            if !sudah_hadir {
                hari += 1;
            }
        } else if !sudah_hadir {
            hari += 1;
            menit += normal;
        }
    }
    (hari, menit)
}

/// Cermin `upahHarian`: dasar nominal cuti diuangkan (§17.7).
pub fn upah_harian(salary_type: &str, daily_rate: i64, rate_per_hour: i64, jam_normal_menit: i64) -> i64 {
    if salary_type == "FLAT_DAILY" {
        return daily_rate.max(0);
    }
    (rate_per_hour.max(0) * jam_normal_menit.max(0) + 30) / 60
}

// ── Jatah cuti (§17.7) ─────────────────────────────────────────────────────

pub const KUNCI_CUTI_PERIODE: &str = "hr_cuti_periode";
pub const KUNCI_CUTI_HAK: &str = "hr_cuti_hak";
pub const KUNCI_CUTI_SYARAT_BULAN: &str = "hr_cuti_syarat_bulan";
pub const KUNCI_CUTI_PRORATA: &str = "hr_cuti_prorata";
pub const KUNCI_CUTI_SISA: &str = "hr_cuti_sisa";
pub const KUNCI_CUTI_BAWA_MAKS: &str = "hr_cuti_bawa_maks";
pub const KUNCI_CUTI_BAWA_BULAN: &str = "hr_cuti_bawa_bulan";
pub const PERIODE_CUTI: [&str; 2] = ["kalender", "ulang_tahun_kerja"];
pub const SISA_CUTI: [&str; 3] = ["hangus", "dibawa", "diuangkan"];

/// Batas angka aturan cuti: (kunci, label, min, maks).
pub const BATAS_CUTI: [(&str, &str, i64, i64); 5] = [
    (KUNCI_CUTI_HAK, "Hak cuti tahunan", 0, 60),
    (KUNCI_CUTI_SYARAT_BULAN, "Masa kerja minimum", 0, 24),
    (KUNCI_CUTI_PRORATA, "Prorata", 0, 1),
    (KUNCI_CUTI_BAWA_MAKS, "Sisa maksimal dibawa", 0, 60),
    (KUNCI_CUTI_BAWA_BULAN, "Batas pakai sisa dibawa", 1, 12),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AturanCuti {
    pub periode: String,
    pub hak: i64,
    pub syarat_bulan: i64,
    pub prorata: bool,
    pub sisa: String,
    pub bawa_maks: i64,
    pub bawa_bulan: i64,
}

impl Default for AturanCuti {
    fn default() -> Self {
        Self {
            periode: "ulang_tahun_kerja".into(),
            hak: 12,
            syarat_bulan: 12,
            prorata: false,
            sisa: "hangus".into(),
            bawa_maks: 6,
            bawa_bulan: 3,
        }
    }
}

impl AturanCuti {
    /// Cermin `aturanCutiDariPeta`. Kosong atau di luar batas = bawaan.
    pub fn dari_peta(peta: &HashMap<String, String>) -> Self {
        let bawaan = Self::default();
        let angka = |kunci: &str, nilai_bawaan: i64| -> i64 {
            let (_, _, min, maks) = BATAS_CUTI
                .iter()
                .find(|(k, ..)| *k == kunci)
                .copied()
                .unwrap_or((kunci, "", i64::MIN, i64::MAX));
            peta.get(kunci)
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|n| (min..=maks).contains(n))
                .unwrap_or(nilai_bawaan)
        };
        let pilih = |kunci: &str, daftar: &[&str], nilai_bawaan: &str| -> String {
            peta.get(kunci)
                .map(|v| v.trim())
                .filter(|v| daftar.contains(v))
                .unwrap_or(nilai_bawaan)
                .to_owned()
        };
        Self {
            periode: pilih(KUNCI_CUTI_PERIODE, &PERIODE_CUTI, &bawaan.periode),
            hak: angka(KUNCI_CUTI_HAK, bawaan.hak),
            syarat_bulan: angka(KUNCI_CUTI_SYARAT_BULAN, bawaan.syarat_bulan),
            prorata: angka(KUNCI_CUTI_PRORATA, i64::from(bawaan.prorata)) == 1,
            sisa: pilih(KUNCI_CUTI_SISA, &SISA_CUTI, &bawaan.sisa),
            bawa_maks: angka(KUNCI_CUTI_BAWA_MAKS, bawaan.bawa_maks),
            bawa_bulan: angka(KUNCI_CUTI_BAWA_BULAN, bawaan.bawa_bulan),
        }
    }
}

/// Cermin `validasiAturanCuti`: pasangan kunci-nilai siap disimpan.
pub fn validasi_aturan_cuti(draft: &Value) -> Result<Vec<(&'static str, String)>, String> {
    let periode = teks(draft, KUNCI_CUTI_PERIODE);
    if !PERIODE_CUTI.contains(&periode.as_str()) {
        return Err("Periode cuti harus kalender atau ulang tahun kerja.".into());
    }
    let sisa = teks(draft, KUNCI_CUTI_SISA);
    if !SISA_CUTI.contains(&sisa.as_str()) {
        return Err("Sisa cuti harus hangus, dibawa, atau diuangkan.".into());
    }
    let mut hasil = vec![(KUNCI_CUTI_PERIODE, periode), (KUNCI_CUTI_SISA, sisa)];
    for (kunci, label, min, maks) in BATAS_CUTI {
        let nilai = draft.get(kunci).and_then(Value::as_f64);
        match nilai {
            Some(n) if n.fract() == 0.0 && (min as f64..=maks as f64).contains(&n) => {
                hasil.push((kunci, (n as i64).to_string()));
            }
            _ => return Err(format!("{label} harus {min} sampai {maks}.")),
        }
    }
    Ok(hasil)
}

pub const KUNCI_LEMBUR_MODE: &str = "hr_lembur_mode";
pub const KUNCI_LEMBUR_MAKS_HARIAN: &str = "hr_lembur_maks_harian";
pub const KUNCI_LEMBUR_MAKS_MINGGUAN: &str = "hr_lembur_maks_mingguan";
pub const MODE_LEMBUR: [&str; 2] = ["otomatis", "spl"];

/// Batas angka aturan lembur dalam JAM: (kunci, label, min, maks, bawaan).
/// Bawaan PP 35/2021, bisa diubah perusahaan.
pub const BATAS_LEMBUR: [(&str, &str, i64, i64, i64); 2] = [
    (KUNCI_LEMBUR_MAKS_HARIAN, "Batas lembur harian", 1, 12, 4),
    (KUNCI_LEMBUR_MAKS_MINGGUAN, "Batas lembur mingguan", 1, 72, 18),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AturanLembur {
    pub mode: String,
    /// Jam.
    pub maks_harian: i64,
    /// Jam.
    pub maks_mingguan: i64,
}

impl AturanLembur {
    /// Cermin `aturanLemburDariPeta`. Kosong atau di luar batas = bawaan.
    pub fn dari_peta(peta: &HashMap<String, String>) -> Self {
        let angka = |i: usize| -> i64 {
            let (kunci, _, min, maks, bawaan) = BATAS_LEMBUR[i];
            peta.get(kunci)
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|n| (min..=maks).contains(n))
                .unwrap_or(bawaan)
        };
        let mode = peta
            .get(KUNCI_LEMBUR_MODE)
            .map(|v| v.trim())
            .filter(|v| MODE_LEMBUR.contains(v))
            .unwrap_or("otomatis")
            .to_owned();
        Self { mode, maks_harian: angka(0), maks_mingguan: angka(1) }
    }
}

/// Cermin `validasiAturanLembur`: pasangan kunci-nilai siap disimpan.
pub fn validasi_aturan_lembur(draft: &Value) -> Result<Vec<(&'static str, String)>, String> {
    let mode = teks(draft, KUNCI_LEMBUR_MODE);
    if !MODE_LEMBUR.contains(&mode.as_str()) {
        return Err("Mode lembur harus otomatis atau SPL.".into());
    }
    let mut hasil = vec![(KUNCI_LEMBUR_MODE, mode)];
    for (kunci, label, min, maks, _) in BATAS_LEMBUR {
        match draft.get(kunci).and_then(Value::as_f64) {
            Some(n) if n.fract() == 0.0 && (min as f64..=maks as f64).contains(&n) => {
                hasil.push((kunci, (n as i64).to_string()));
            }
            _ => return Err(format!("{label} harus {min} sampai {maks} jam.")),
        }
    }
    Ok(hasil)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PeriodeCuti {
    /// Kunci periode (`hr_cuti_penyesuaian.periode`).
    pub mulai: String,
    /// Inklusif.
    pub selesai: String,
    /// Periode sebelum tanggal berhak: hak 0, tidak membawa sisa.
    pub sebelum_berhak: bool,
    pub hak: i64,
    pub bawaan: i64,
    pub bawaan_hangus: i64,
    pub bawaan_sampai: Option<String>,
    pub penyesuaian: i64,
    pub terpakai: i64,
    pub sisa: i64,
}

/// Cermin `periodeCuti`. `terpakai` = tanggal pemakaian (tanggal wajib dari
/// pengajuan berlaku `potong_jatah`, sudah dikurangi tanggal hadir), unik.
/// `penyesuaian` = (periode, hari) yang tidak dibatalkan.
pub fn periode_cuti(
    tanggal_masuk: Option<&str>,
    aturan: &AturanCuti,
    terpakai: &[String],
    penyesuaian: &[(String, i64)],
    hari_ini: &str,
) -> Vec<PeriodeCuti> {
    let Some(masuk) = tanggal_masuk.filter(|t| hari_kerja::tanggal_valid(t)) else {
        return Vec::new();
    };
    let Some(berhak) = hris::tambah_bulan(masuk, aturan.syarat_bulan) else {
        return Vec::new();
    };
    let mut akhir = hari_ini.to_owned();
    for t in terpakai {
        if *t > akhir {
            akhir = t.clone();
        }
    }
    for (p, _) in penyesuaian {
        if *p > akhir {
            akhir = p.clone();
        }
    }

    // (mulai, selesai, hak, sebelum_berhak)
    let mut batas: Vec<(String, String, i64, bool)> = Vec::new();
    let pemakaian_awal = terpakai.iter().any(|t| *t < berhak);
    if masuk < berhak.as_str() || pemakaian_awal {
        let mulai = terpakai
            .iter()
            .filter(|t| t.as_str() < masuk)
            .min()
            .cloned()
            .unwrap_or_else(|| masuk.to_owned());
        if let Some(selesai) = tambah_hari(&berhak, -1) {
            if mulai <= selesai {
                batas.push((mulai, selesai, 0, true));
            }
        }
    }
    if aturan.periode == "kalender" {
        let tahun: i64 = berhak.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
        let bulan: i64 = berhak.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
        let hari: i64 = berhak.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(1);
        let tersisa = if hari == 1 { 13 - bulan } else { 12 - bulan };
        let hak_pertama = if aturan.prorata { aturan.hak * tersisa / 12 } else { aturan.hak };
        batas.push((berhak.clone(), format!("{tahun:04}-12-31"), hak_pertama, false));
        let mut y = tahun + 1;
        while format!("{y:04}-01-01") <= akhir && batas.len() < 200 {
            batas.push((format!("{y:04}-01-01"), format!("{y:04}-12-31"), aturan.hak, false));
            y += 1;
        }
    } else {
        let mut k = 0;
        while batas.len() < 200 {
            let (Some(mulai), Some(berikut)) = (
                hris::tambah_bulan(&berhak, 12 * k),
                hris::tambah_bulan(&berhak, 12 * (k + 1)),
            ) else {
                break;
            };
            if mulai > akhir {
                break;
            }
            let selesai = tambah_hari(&berikut, -1).unwrap_or(berikut);
            batas.push((mulai, selesai, aturan.hak, false));
            k += 1;
        }
    }

    let mut hasil: Vec<PeriodeCuti> = Vec::with_capacity(batas.len());
    for (mulai, selesai, hak, sebelum_berhak) in batas {
        let dalam = |t: &str| t >= mulai.as_str() && t <= selesai.as_str();
        let pakai = terpakai.iter().filter(|t| dalam(t)).count() as i64;
        let adj: i64 = penyesuaian.iter().filter(|(p, _)| *p == mulai).map(|(_, h)| h).sum();
        let sebelumnya = hasil.last().filter(|p| !p.sebelum_berhak);
        let bawaan = match sebelumnya {
            Some(p) if aturan.sisa == "dibawa" => p.sisa.max(0).min(aturan.bawa_maks),
            _ => 0,
        };
        let (mut hangus, mut sampai) = (0, None);
        if bawaan > 0 {
            if let Some(batas_bawa) = hris::tambah_bulan(&mulai, aturan.bawa_bulan) {
                let awal = terpakai
                    .iter()
                    .filter(|t| t.as_str() >= mulai.as_str() && t.as_str() < batas_bawa.as_str())
                    .count() as i64;
                if hari_ini >= batas_bawa.as_str() {
                    hangus = bawaan - bawaan.min(awal);
                }
                sampai = tambah_hari(&batas_bawa, -1);
            }
        }
        hasil.push(PeriodeCuti {
            sisa: hak + adj + bawaan - hangus - pakai,
            mulai,
            selesai,
            sebelum_berhak,
            hak,
            bawaan,
            bawaan_hangus: hangus,
            bawaan_sampai: sampai,
            penyesuaian: adj,
            terpakai: pakai,
        });
    }
    // Periode sebelum berhak hanya tampil bila ada isinya.
    hasil.retain(|p| !p.sebelum_berhak || p.terpakai != 0 || p.penyesuaian != 0);
    hasil
}

// ── Pembaca data (SQLite lokal) ────────────────────────────────────────────

fn internal<E>(_: E) -> CommandError {
    CommandError::internal()
}

/// Libur dan whitelist untuk satu rentang.
pub fn muat_kalender(conn: &Connection, mulai: &str, selesai: &str) -> Result<Kalender, CommandError> {
    let mut libur = HashSet::new();
    let mut st = conn
        .prepare("SELECT tanggal FROM tbl_hari_libur WHERE status_aktif = 1 AND tanggal >= ?1 AND tanggal <= ?2;")
        .map_err(internal)?;
    for t in st.query_map(params![mulai, selesai], |r| r.get::<_, String>(0)).map_err(internal)? {
        libur.insert(t.map_err(internal)?);
    }
    let mut st = conn
        .prepare("SELECT id, scope_type, scope_value, tanggal_libur, status_aktif FROM hari_libur_whitelist WHERE status_aktif = 1;")
        .map_err(internal)?;
    let whitelist = st
        .query_map([], |r| {
            Ok(scanner::HolidayWhitelistEntry {
                id: r.get(0)?,
                scope_type: r.get(1)?,
                scope_value: r.get(2)?,
                tanggal_libur: r.get(3)?,
                status_aktif: r.get(4)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(Kalender { libur, whitelist })
}

/// Jadwal SAAT INI setiap karyawan (shift `master_data.id_shift`).
pub fn muat_jadwal(conn: &Connection) -> Result<HashMap<String, Jadwal>, CommandError> {
    let mut st = conn
        .prepare(
            "SELECT m.id_unik, COALESCE(m.divisi, ''), s.hari_kerja, s.kode_shift, COALESCE(s.jam_kerja_normal_menit, 0)
             FROM master_data m LEFT JOIN tbl_shift s ON s.id_shift = m.id_shift;",
        )
        .map_err(internal)?;
    let baris = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Jadwal {
                    divisi: r.get(1)?,
                    hari_masuk: hari_kerja::parse_hari_kerja(r.get::<_, Option<String>>(2)?.as_deref()),
                    kode_shift: r.get::<_, Option<i64>>(3).unwrap_or(None),
                    jam_normal_menit: r.get(4)?,
                },
            ))
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PengajuanBerlaku {
    pub id_pengajuan: String,
    pub id_karyawan: String,
    pub tanggal_mulai: String,
    pub tanggal_selesai: String,
    pub kelompok: String,
    pub dampak_gaji: String,
    pub potong_jatah: bool,
    pub setengah_hari: bool,
}

/// Pengajuan berlaku yang bertumpuk dengan rentang (`PENGAJUAN_RENTANG_SQL`).
pub fn muat_berlaku(conn: &Connection, mulai: &str, selesai: &str) -> Result<Vec<PengajuanBerlaku>, CommandError> {
    let mut st = conn.prepare(PENGAJUAN_RENTANG_SQL).map_err(internal)?;
    let baris = st
        .query_map(params![mulai, selesai], |r| {
            Ok(PengajuanBerlaku {
                id_pengajuan: r.get(0)?,
                id_karyawan: r.get(1)?,
                tanggal_mulai: r.get(2)?,
                tanggal_selesai: r.get(3)?,
                kelompok: r.get(4)?,
                dampak_gaji: r.get(5)?,
                potong_jatah: r.get::<_, i64>(6)? == 1,
                setengah_hari: r.get::<_, i64>(7)? == 1,
            })
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

/// Karyawan yang ditutup pengajuan berlaku pada `tanggal` (Generate Alfa dan
/// audit absensi, pola `pelapor_perjalanan`).
pub fn pengaju_tanggal(conn: &Connection, tanggal: &str) -> Result<HashSet<String>, CommandError> {
    Ok(muat_berlaku(conn, tanggal, tanggal)?
        .into_iter()
        .map(|p| p.id_karyawan)
        .collect())
}

/// Tanggal hadir per karyawan (`TANGGAL_HADIR_SQL`).
pub fn muat_hadir(conn: &Connection, mulai: &str, selesai: &str) -> Result<HashMap<String, HashSet<String>>, CommandError> {
    let mut st = conn.prepare(TANGGAL_HADIR_SQL).map_err(internal)?;
    let mut hasil: HashMap<String, HashSet<String>> = HashMap::new();
    for baris in st
        .query_map(params![mulai, selesai], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?
    {
        let (id, tanggal) = baris.map_err(internal)?;
        hasil.entry(id).or_default().insert(tanggal);
    }
    Ok(hasil)
}

/// Kait rekap gaji (§17.6): `(hari, menit)` per karyawan untuk periode.
pub fn cuti_dibayar(conn: &Connection, mulai: &str, akhir: &str) -> Result<HashMap<String, (i64, i64)>, CommandError> {
    let berlaku: Vec<PengajuanBerlaku> = muat_berlaku(conn, mulai, akhir)?
        .into_iter()
        .filter(|p| p.dampak_gaji == "Dibayar")
        .collect();
    if berlaku.is_empty() {
        return Ok(HashMap::new());
    }
    let jadwal = muat_jadwal(conn)?;
    let kalender = muat_kalender(conn, mulai, akhir)?;
    let hadir = muat_hadir(conn, mulai, akhir)?;
    let mut tanggal: HashMap<&str, Vec<(String, bool)>> = HashMap::new();
    for p in &berlaku {
        let Some(j) = jadwal.get(&p.id_karyawan) else { continue };
        let dari = p.tanggal_mulai.as_str().max(mulai);
        let sampai = p.tanggal_selesai.as_str().min(akhir);
        for t in tanggal_wajib(j, &kalender, dari, sampai) {
            tanggal.entry(p.id_karyawan.as_str()).or_default().push((t, p.setengah_hari));
        }
    }
    let kosong = HashSet::new();
    Ok(tanggal
        .into_iter()
        .map(|(id, daftar)| {
            let normal = jadwal.get(id).map(|j| j.jam_normal_menit).unwrap_or(0);
            let hitung = hitung_cuti_dibayar(&daftar, hadir.get(id).unwrap_or(&kosong), normal);
            (id.to_owned(), hitung)
        })
        .collect())
}

/// Jam absensi per karyawan per tanggal kerja `?1`..`?2`: lembur hari biasa,
/// jam total dan jam kerja di tanggal libur. Definisi libur SAMA dengan
/// rekap gaji (`tbl_hari_libur` aktif atau di luar hari kerja shift baris).
pub const LEMBUR_HARIAN_SQL: &str = "SELECT ah.id_karyawan, ah.tanggal, COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0) THEN 0 ELSE COALESCE(ah.lembur, 0) END), 0), COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0) THEN COALESCE(ah.jam_kerja, 0) + COALESCE(ah.lembur, 0) ELSE 0 END), 0), COALESCE(SUM(CASE WHEN (hl.tanggal IS NOT NULL OR COALESCE(instr(COALESCE(NULLIF(TRIM(sh.hari_kerja), ''), '1,2,3,4,5,6,7'), replace(strftime('%w', ah.tanggal), '0', '7')), 1) = 0) THEN COALESCE(ah.jam_kerja, 0) ELSE 0 END), 0) FROM absensi_harian ah LEFT JOIN tbl_hari_libur hl ON hl.tanggal = ah.tanggal AND hl.status_aktif = 1 LEFT JOIN tbl_shift sh ON sh.id_shift = ah.id_shift WHERE ah.tanggal >= ?1 AND ah.tanggal <= ?2 GROUP BY ah.id_karyawan, ah.tanggal;";

fn baca_aturan_lembur(conn: &Connection) -> Result<AturanLembur, CommandError> {
    let mut st = conn
        .prepare("SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_lembur\\_%' ESCAPE '\\';")
        .map_err(internal)?;
    let peta = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(internal)?;
    Ok(AturanLembur::dari_peta(&peta))
}

/// Menit SPL berlaku per `(karyawan, tanggal kerja)`.
pub fn muat_spl(conn: &Connection, mulai: &str, akhir: &str) -> Result<HashMap<(String, String), i64>, CommandError> {
    let mut st = conn.prepare(SPL_RENTANG_SQL).map_err(internal)?;
    let mut hasil: HashMap<(String, String), i64> = HashMap::new();
    for baris in st
        .query_map(params![mulai, akhir], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })
        .map_err(internal)?
    {
        let (id, tanggal, a, b) = baris.map_err(internal)?;
        *hasil.entry((id, tanggal)).or_default() += durasi_lembur(&a, &b).unwrap_or(0);
    }
    Ok(hasil)
}

/// Kait rekap gaji (§18.4): mode lembur, dan potongan per karyawan bila mode
/// `spl` (kosong untuk `otomatis`). Mode dibaca saat rekap dihitung (Q-57).
pub fn lembur_spl(conn: &Connection, mulai: &str, akhir: &str) -> Result<(String, HashMap<String, PotongLembur>), CommandError> {
    let aturan = baca_aturan_lembur(conn)?;
    if aturan.mode != "spl" {
        return Ok((aturan.mode, HashMap::new()));
    }
    let spl = muat_spl(conn, mulai, akhir)?;
    let mut hari: HashMap<String, Vec<HariLembur>> = HashMap::new();
    let mut st = conn.prepare(LEMBUR_HARIAN_SQL).map_err(internal)?;
    for baris in st
        .query_map(params![mulai, akhir], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
        })
        .map_err(internal)?
    {
        let (id, tanggal, lembur, libur_total, libur_jam_kerja) = baris.map_err(internal)?;
        let menit_spl = spl.get(&(id.clone(), tanggal)).copied().unwrap_or(0);
        hari.entry(id).or_default().push(HariLembur { lembur, libur_total, libur_jam_kerja, spl: menit_spl });
    }
    Ok((aturan.mode, hari.into_iter().map(|(id, h)| (id, potong_lembur_spl(&h))).collect()))
}

/// Shift tukar berlaku per `(karyawan, tanggal)` (`TUKAR_RENTANG_SQL`). Bila
/// dua tukar berlaku lahir offline untuk orang dan tanggal yang sama, yang
/// ber-id terkecil dipakai di semua perangkat.
pub fn muat_tukar(conn: &Connection, mulai: &str, akhir: &str) -> Result<HashMap<(String, String), i64>, CommandError> {
    let mut st = conn.prepare(TUKAR_RENTANG_SQL).map_err(internal)?;
    let mut hasil: HashMap<(String, String), i64> = HashMap::new();
    for baris in st
        .query_map(params![mulai, akhir], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))
        })
        .map_err(internal)?
    {
        if let (Some(id), tanggal, Some(shift)) = baris.map_err(internal)? {
            hasil.entry((id, tanggal)).or_insert(shift);
        }
    }
    Ok(hasil)
}

/// Klaim yang bisa dibayar: Reimburse berlaku bertanggal ≤ `sampai`
/// (`KLAIM_BERLAKU_SQL`) lalu cuti diuangkan (`UANG_BERLAKU_SQL`).
pub fn muat_klaim(conn: &Connection, sampai: &str) -> Result<Vec<Klaim>, CommandError> {
    let mut hasil = Vec::new();
    for (sql, sumber) in [(KLAIM_BERLAKU_SQL, SUMBER_REIMBURSE), (UANG_BERLAKU_SQL, SUMBER_UANG)] {
        let mut st = conn.prepare(sql).map_err(internal)?;
        let ubah = |r: &rusqlite::Row<'_>| {
            Ok(Klaim {
                id_klaim: r.get(0)?,
                sumber: sumber.to_owned(),
                id_karyawan: r.get(1)?,
                tanggal: r.get(2)?,
                nominal: r.get(3)?,
                keterangan: r.get(4)?,
            })
        };
        let baris = if sumber == SUMBER_REIMBURSE {
            st.query_map(params![sampai], ubah)
        } else {
            st.query_map([], ubah)
        }
        .map_err(internal)?;
        for k in baris {
            hasil.push(k.map_err(internal)?);
        }
    }
    Ok(hasil)
}

/// Seluruh pembayaran terpisah dan barisnya.
// ponytail: dibaca utuh tiap kali; saring per karyawan bila tabelnya membesar.
pub fn muat_bayar(conn: &Connection) -> Result<(Vec<BayarReimburse>, Vec<BarisReimburse>), CommandError> {
    let mut st = conn
        .prepare(
            "SELECT id_bayar, jenis, id_ref, id_karyawan, tanggal, total, keterangan, dicatat_oleh, created_at
             FROM hr_reimburse_bayar ORDER BY tanggal, created_at, id_bayar;",
        )
        .map_err(internal)?;
    let bayar = st
        .query_map([], |r| {
            Ok(BayarReimburse {
                id_bayar: r.get(0)?,
                jenis: r.get(1)?,
                id_ref: r.get(2)?,
                id_karyawan: r.get(3)?,
                tanggal: r.get(4)?,
                total: r.get(5)?,
                keterangan: r.get(6)?,
                dicatat_oleh: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let mut st = conn
        .prepare("SELECT id_baris, id_bayar, sumber, id_klaim, nominal FROM hr_reimburse_bayar_baris ORDER BY id_bayar, id_baris;")
        .map_err(internal)?;
    let baris = st
        .query_map([], |r| {
            Ok(BarisReimburse {
                id_baris: r.get(0)?,
                id_bayar: r.get(1)?,
                sumber: r.get(2)?,
                id_klaim: r.get(3)?,
                nominal: r.get(4)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok((bayar, baris))
}

/// Klaim di proses gaji yang tidak ditolak (`GAJI_REIMBURSE_SQL`).
pub fn muat_gaji_reimburse(conn: &Connection) -> Result<Vec<GajiReimburse>, CommandError> {
    let mut st = conn.prepare(GAJI_REIMBURSE_SQL).map_err(internal)?;
    let baris = st
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<i64>>(3)?))
        })
        .map_err(internal)?;
    let mut hasil = Vec::new();
    for b in baris {
        if let (id_run, status, Some(id_klaim), nominal) = b.map_err(internal)? {
            hasil.push(GajiReimburse { id_run, status, id_klaim, nominal: nominal.unwrap_or(0) });
        }
    }
    Ok(hasil)
}

pub fn baca_mode_reimburse(conn: &Connection) -> Result<&'static str, CommandError> {
    let nilai: Option<String> = conn
        .query_row("SELECT value FROM setting_gex_system WHERE key = ?1;", params![KUNCI_REIMBURSE_BAYAR], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    Ok(mode_reimburse(nilai.as_deref()))
}

/// Kait rekap gaji mode `gaji` (§19.4): per karyawan, klaim Reimburse berlaku
/// bertanggal ≤ `akhir` yang Belum dibayar. Kosong di mode `terpisah`; mode
/// dibaca saat rekap dihitung, termasuk pembekuan (pola Q-57).
pub fn reimburse_gaji(conn: &Connection, akhir: &str) -> Result<HashMap<String, Vec<(String, i64)>>, CommandError> {
    let mut hasil: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    if baca_mode_reimburse(conn)? != "gaji" {
        return Ok(hasil);
    }
    let klaim = muat_klaim(conn, akhir)?;
    let (pembayaran, baris) = muat_bayar(conn)?;
    let gaji = muat_gaji_reimburse(conn)?;
    for k in klaim.into_iter().filter(|k| k.sumber == SUMBER_REIMBURSE) {
        if status_bayar(&k.id_klaim, &pembayaran, &baris, &gaji) == STATUS_BELUM_DIBAYAR {
            hasil.entry(k.id_karyawan).or_default().push((k.id_klaim, k.nominal));
        }
    }
    Ok(hasil)
}

/// `breakdown_snapshot.reimburse`: yang dibaca saat proses gaji dibayar.
pub fn rincian_reimburse_json(klaim: &[(String, i64)]) -> Vec<Value> {
    klaim
        .iter()
        .map(|(id, nominal)| json!({ "id_pengajuan": id, "nominal": nominal }))
        .collect()
}

/// Pemeriksaan `periksa_reimburse_payroll` atas data lokal, dipanggil di
/// transaksi transisi PAID.
pub fn periksa_reimburse_run(conn: &Connection, id_run: &str, entri: &[(String, i64)]) -> Result<(), CommandError> {
    if entri.is_empty() {
        return Ok(());
    }
    let klaim = muat_klaim(conn, "9999-12-31")?;
    let (pembayaran, baris) = muat_bayar(conn)?;
    let gaji = muat_gaji_reimburse(conn)?;
    periksa_reimburse_payroll(id_run, entri, &klaim, &pembayaran, &baris, &gaji).map_err(invalid)
}

// ── SQL tulis (kembar `services/hr-pengajuan.ts`) ──────────────────────────

pub const UPSERT_JENIS_SQL: &str = "INSERT INTO hr_jenis_pengajuan (id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif, created_at, updated_at, batas_bulanan) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(?12, datetime('now')), datetime('now'), ?13) ON CONFLICT(id_jenis) DO UPDATE SET nama = excluded.nama, kelompok = excluded.kelompok, izin_pemutus = excluded.izin_pemutus, boleh_urgent = excluded.boleh_urgent, potong_jatah = excluded.potong_jatah, dampak_gaji = excluded.dampak_gaji, maks_hari = excluded.maks_hari, satuan_maks = excluded.satuan_maks, wajib_dokumen = excluded.wajib_dokumen, is_aktif = excluded.is_aktif, updated_at = datetime('now'), batas_bulanan = CASE WHEN ?14 = 1 THEN excluded.batas_bulanan ELSE hr_jenis_pengajuan.batas_bulanan END;";

/// Pengaju dan `created_at` tidak pernah ditimpa suntingan.
pub const UPSERT_PENGAJUAN_SQL: &str = "INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, potong_jatah, dampak_gaji, tanggal_mulai, tanggal_selesai, setengah_hari, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, updated_at, jam_mulai, jam_selesai, id_karyawan_tukar, id_shift_asal, id_shift_tukar, nominal) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE(?14, datetime('now')), datetime('now'), ?15, ?16, ?17, ?18, ?19, ?20) ON CONFLICT(id_pengajuan) DO UPDATE SET id_karyawan = excluded.id_karyawan, id_jenis = excluded.id_jenis, kelompok = excluded.kelompok, potong_jatah = excluded.potong_jatah, dampak_gaji = excluded.dampak_gaji, tanggal_mulai = excluded.tanggal_mulai, tanggal_selesai = excluded.tanggal_selesai, setengah_hari = excluded.setengah_hari, alasan = excluded.alasan, sidik = excluded.sidik, waktu_perangkat = excluded.waktu_perangkat, updated_at = datetime('now'), jam_mulai = excluded.jam_mulai, jam_selesai = excluded.jam_selesai, id_karyawan_tukar = excluded.id_karyawan_tukar, id_shift_asal = excluded.id_shift_asal, id_shift_tukar = excluded.id_shift_tukar, nominal = excluded.nominal;";

/// Lokal: `diterima_cloud` kosong sampai tertarik dari cloud.
pub const INSERT_KEPUTUSAN_SQL: &str = "INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud, created_at, nominal_disetujui) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, COALESCE(?8, datetime('now')), ?9) ON CONFLICT(id_keputusan) DO NOTHING;";

/// Cloud dan Web: `diterima_cloud` selalu jam database cloud (aturan 19).
pub const CLOUD_INSERT_KEPUTUSAN_SQL: &str = "INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud, created_at, nominal_disetujui) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), COALESCE(?8, datetime('now')), ?9) ON CONFLICT(id_keputusan) DO NOTHING;";

pub const INSERT_PENYESUAIAN_SQL: &str = "INSERT INTO hr_cuti_penyesuaian (id_penyesuaian, id_karyawan, periode, jenis, id_ref, hari, nominal, alasan, dicatat_oleh, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, datetime('now'))) ON CONFLICT(id_penyesuaian) DO NOTHING;";

pub const PESAN_TANPA_HARI_KERJA: &str = "Rentang itu tidak berisi hari kerja karyawan ini.";
pub const JENIS_PENYESUAIAN: [&str; 2] = ["Saldo Awal", "Koreksi"];

/// Cermin `validasiPenyesuaian`: (id_karyawan, periode, jenis, hari, alasan).
pub fn validasi_penyesuaian(draft: &Value) -> Result<(String, String, String, i64, String), String> {
    let id_karyawan = teks(draft, "id_karyawan");
    if id_karyawan.is_empty() {
        return Err("Pilih karyawan.".into());
    }
    let periode = teks(draft, "periode");
    if !hari_kerja::tanggal_valid(&periode) {
        return Err("Periode tidak valid.".into());
    }
    let jenis = teks(draft, "jenis");
    if !JENIS_PENYESUAIAN.contains(&jenis.as_str()) {
        return Err("Jenis penyesuaian harus Saldo Awal atau Koreksi.".into());
    }
    let hari = match draft.get("hari").and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && n != 0.0 && n.abs() <= MAKS_HARI_JENIS as f64 => n as i64,
        _ => return Err(format!("Jumlah hari harus bilangan bulat selain 0, paling banyak {MAKS_HARI_JENIS}.")),
    };
    let alasan = teks(draft, "alasan");
    if alasan.is_empty() {
        return Err("Alasan wajib diisi.".into());
    }
    if panjang(&alasan) > MAKS_ALASAN {
        return Err(format!("Alasan maksimal {MAKS_ALASAN} karakter."));
    }
    Ok((id_karyawan, periode, jenis, hari, alasan))
}

/// Id penyesuaian diuangkan: dua perangkat menghasilkan PK yang sama.
pub fn id_uang(id_karyawan: &str, periode: &str) -> String {
    format!("uang:{id_karyawan}:{periode}")
}

// ── Baca dan tulis lokal ───────────────────────────────────────────────────

use super::inventory::{invalid, new_hex_id, payload_text};
use super::models::OperatorUser;
use super::{config::DesktopState, sync};
use rusqlite::{OptionalExtension, Transaction};

fn punya(operator: &OperatorUser, izin: &str) -> bool {
    operator.is_superadmin || operator.permissions.iter().any(|p| p == izin)
}

fn karyawan_sendiri(operator: &OperatorUser, id_karyawan: &str) -> bool {
    operator.id_karyawan.as_deref() == Some(id_karyawan)
}

fn ditolak(pesan: &str) -> CommandError {
    CommandError::new("DESKTOP_ACCESS_DENIED", pesan)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BarisPengajuan {
    pub id_pengajuan: String,
    pub id_karyawan: String,
    pub id_jenis: String,
    pub kelompok: String,
    pub potong_jatah: bool,
    pub dampak_gaji: String,
    pub tanggal_mulai: String,
    pub tanggal_selesai: String,
    pub setengah_hari: bool,
    pub alasan: String,
    pub sidik: String,
    pub diajukan_oleh: String,
    pub waktu_perangkat: String,
    pub created_at: String,
    pub jam_mulai: Option<String>,
    pub jam_selesai: Option<String>,
    pub id_karyawan_tukar: Option<String>,
    pub id_shift_asal: Option<i64>,
    pub id_shift_tukar: Option<i64>,
    /// Reimburse (v39).
    pub nominal: Option<i64>,
}

impl BarisPengajuan {
    fn ringkas(&self) -> Ringkas<'_> {
        Ringkas {
            kelompok: &self.kelompok,
            id_karyawan: &self.id_karyawan,
            id_karyawan_tukar: self.id_karyawan_tukar.as_deref(),
            tanggal_mulai: &self.tanggal_mulai,
            tanggal_selesai: &self.tanggal_selesai,
            setengah_hari: self.setengah_hari,
            jam_mulai: self.jam_mulai.as_deref(),
            jam_selesai: self.jam_selesai.as_deref(),
        }
    }
}

const KOLOM_PENGAJUAN: &str = "p.id_pengajuan, p.id_karyawan, p.id_jenis, p.kelompok, p.potong_jatah, p.dampak_gaji, p.tanggal_mulai, p.tanggal_selesai, p.setengah_hari, p.alasan, p.sidik, p.diajukan_oleh, p.waktu_perangkat, p.created_at, p.jam_mulai, p.jam_selesai, p.id_karyawan_tukar, p.id_shift_asal, p.id_shift_tukar, p.nominal";

fn baris_pengajuan(r: &rusqlite::Row<'_>) -> rusqlite::Result<BarisPengajuan> {
    Ok(BarisPengajuan {
        id_pengajuan: r.get(0)?,
        id_karyawan: r.get(1)?,
        id_jenis: r.get(2)?,
        kelompok: r.get(3)?,
        potong_jatah: r.get::<_, i64>(4)? == 1,
        dampak_gaji: r.get(5)?,
        tanggal_mulai: r.get(6)?,
        tanggal_selesai: r.get(7)?,
        setengah_hari: r.get::<_, i64>(8)? == 1,
        alasan: r.get(9)?,
        sidik: r.get(10)?,
        diajukan_oleh: r.get(11)?,
        waktu_perangkat: r.get(12)?,
        created_at: r.get(13)?,
        jam_mulai: r.get(14)?,
        jam_selesai: r.get(15)?,
        id_karyawan_tukar: r.get(16)?,
        id_shift_asal: r.get(17)?,
        id_shift_tukar: r.get(18)?,
        nominal: r.get(19)?,
    })
}

/// Pengajuan satu karyawan (atau semua) yang bertumpuk dengan rentang.
fn baca_pengajuan(
    conn: &Connection,
    id_karyawan: Option<&str>,
    mulai: &str,
    selesai: &str,
) -> Result<Vec<BarisPengajuan>, CommandError> {
    let mut st = conn
        .prepare(&format!(
            "SELECT {KOLOM_PENGAJUAN} FROM hr_pengajuan p
             WHERE (?1 IS NULL OR p.id_karyawan = ?1 OR p.id_karyawan_tukar = ?1) AND p.tanggal_mulai <= ?3 AND p.tanggal_selesai >= ?2
             ORDER BY p.tanggal_mulai DESC, p.id_pengajuan LIMIT 2000;"
        ))
        .map_err(internal)?;
    let baris = st
        .query_map(params![id_karyawan, mulai, selesai], baris_pengajuan)
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn baca_satu_pengajuan(conn: &Connection, id: &str) -> Result<Option<BarisPengajuan>, CommandError> {
    conn.query_row(
        &format!("SELECT {KOLOM_PENGAJUAN} FROM hr_pengajuan p WHERE p.id_pengajuan = ?1;"),
        params![id],
        baris_pengajuan,
    )
    .optional()
    .map_err(internal)
}

/// Keputusan per pengajuan untuk daftar id.
fn baca_keputusan(conn: &Connection, ids: &[&str]) -> Result<HashMap<String, Vec<Keputusan>>, CommandError> {
    let mut hasil: HashMap<String, Vec<Keputusan>> = HashMap::new();
    if ids.is_empty() {
        return Ok(hasil);
    }
    let mut st = conn
        .prepare(
            "SELECT id_pengajuan, id_keputusan, jenis, sidik, oleh, waktu_perangkat, diterima_cloud, alasan, nominal_disetujui
             FROM hr_pengajuan_keputusan
             WHERE id_pengajuan IN (SELECT value FROM json_each(?1))
             ORDER BY id_pengajuan, id_keputusan;",
        )
        .map_err(internal)?;
    let ids_json = serde_json::to_string(ids).map_err(internal)?;
    for baris in st
        .query_map(params![ids_json], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Keputusan {
                    id_keputusan: r.get(1)?,
                    jenis: r.get(2)?,
                    sidik: r.get(3)?,
                    oleh: r.get(4)?,
                    waktu_perangkat: r.get(5)?,
                    diterima_cloud: r.get(6)?,
                    nominal_disetujui: r.get(8)?,
                },
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(internal)?
    {
        let (id, keputusan, _) = baris.map_err(internal)?;
        hasil.entry(id).or_default().push(keputusan);
    }
    Ok(hasil)
}

/// Riwayat keputusan lengkap satu pengajuan (dengan alasan), terurut.
fn riwayat_keputusan(conn: &Connection, id: &str) -> Result<Vec<Value>, CommandError> {
    let mut st = conn
        .prepare(
            "SELECT id_keputusan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud, nominal_disetujui
             FROM hr_pengajuan_keputusan WHERE id_pengajuan = ?1
             ORDER BY diterima_cloud IS NULL, diterima_cloud, waktu_perangkat, id_keputusan;",
        )
        .map_err(internal)?;
    let baris = st
        .query_map(params![id], |r| {
            Ok(json!({
                "id_keputusan": r.get::<_, String>(0)?,
                "jenis": r.get::<_, String>(1)?,
                "sidik": r.get::<_, String>(2)?,
                "alasan": r.get::<_, Option<String>>(3)?,
                "oleh": r.get::<_, String>(4)?,
                "waktu_perangkat": r.get::<_, String>(5)?,
                "diterima_cloud": r.get::<_, Option<String>>(6)?,
                "nominal_disetujui": r.get::<_, Option<i64>>(7)?,
            }))
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn baca_jenis_semua(conn: &Connection) -> Result<Vec<JenisPengajuan>, CommandError> {
    let mut st = conn
        .prepare(
            "SELECT id_jenis, nama, kelompok, izin_pemutus, boleh_urgent, potong_jatah, dampak_gaji, maks_hari, satuan_maks, wajib_dokumen, is_aktif, batas_bulanan
             FROM hr_jenis_pengajuan ORDER BY kelompok, nama, id_jenis;",
        )
        .map_err(internal)?;
    let baris = st
        .query_map([], |r| {
            Ok(JenisPengajuan {
                id_jenis: r.get(0)?,
                nama: r.get(1)?,
                kelompok: r.get(2)?,
                izin_pemutus: r.get(3)?,
                boleh_urgent: r.get::<_, i64>(4)? == 1,
                potong_jatah: r.get::<_, i64>(5)? == 1,
                dampak_gaji: r.get(6)?,
                maks_hari: r.get(7)?,
                satuan_maks: r.get(8)?,
                wajib_dokumen: r.get::<_, i64>(9)? == 1,
                is_aktif: r.get::<_, i64>(10)? == 1,
                batas_bulanan: r.get(11)?,
            })
        })
        .map_err(internal)?;
    baris.collect::<Result<_, _>>().map_err(internal)
}

fn waktu_sekarang(conn: &Connection) -> Result<String, CommandError> {
    conn.query_row("SELECT datetime('now');", [], |r| r.get(0)).map_err(internal)
}

fn periode_dibayar(conn: &Connection, mulai: &str, selesai: &str) -> Result<Option<(String, String)>, CommandError> {
    conn.query_row(PERIODE_DIBAYAR_SQL, params![mulai, selesai], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(internal)
}

fn tolak_bila_dibayar(conn: &Connection, mulai: &str, selesai: &str) -> Result<(), CommandError> {
    match periode_dibayar(conn, mulai, selesai)? {
        Some((a, b)) => Err(invalid(pesan_periode_dibayar(&a, &b))),
        None => Ok(()),
    }
}

fn jadwal_satu(conn: &Connection, id_karyawan: &str) -> Result<Option<Jadwal>, CommandError> {
    Ok(muat_jadwal(conn)?.remove(id_karyawan))
}

fn tulis_keputusan(
    tx: &Transaction<'_>,
    client_id: &str,
    id_keputusan: &str,
    id_pengajuan: &str,
    jenis: &str,
    sidik: &str,
    alasan: Option<&str>,
    oleh: &str,
    nominal_disetujui: Option<i64>,
) -> Result<(), CommandError> {
    let waktu = waktu_sekarang(tx)?;
    tx.execute(
        INSERT_KEPUTUSAN_SQL,
        params![id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu, Option::<String>::None, nominal_disetujui],
    )
    .map_err(internal)?;
    let baris = hris::satu_baris(tx, "SELECT * FROM hr_pengajuan_keputusan WHERE id_keputusan = ?1;", id_keputusan)?;
    sync::enqueue(tx, client_id, "hr-request-decision", "create", id_keputusan, &baris, None)?;
    Ok(())
}

/// Simpan jenis pengajuan (`hr.org.manage`).
pub fn simpan_jenis(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let mut jenis = validasi_jenis(draft).map_err(invalid)?;
    let id_masuk = payload_text(draft, "id_jenis");
    hris::dalam_transaksi(state, |tx, client_id| {
        let semua = baca_jenis_semua(tx)?;
        if let Some(id) = &id_masuk {
            if !semua.iter().any(|j| &j.id_jenis == id) {
                return Err(invalid("Jenis pengajuan tidak ditemukan."));
            }
        }
        let lain: Vec<(String, String)> = semua.iter().map(|j| (j.id_jenis.clone(), j.nama.clone())).collect();
        if hris::nama_bentrok(id_masuk.as_deref(), &jenis.nama, &lain) {
            return Err(invalid(format!("Jenis pengajuan \"{}\" sudah ada.", jenis.nama)));
        }
        jenis.id_jenis = id_masuk.clone().unwrap_or_else(|| new_hex_id("jns-"));
        tx.execute(
            UPSERT_JENIS_SQL,
            params![
                jenis.id_jenis,
                jenis.nama,
                jenis.kelompok,
                jenis.izin_pemutus,
                i64::from(jenis.boleh_urgent),
                i64::from(jenis.potong_jatah),
                jenis.dampak_gaji,
                jenis.maks_hari,
                jenis.satuan_maks,
                i64::from(jenis.wajib_dokumen),
                i64::from(jenis.is_aktif),
                Option::<String>::None,
                jenis.batas_bulanan,
                1
            ],
        )
        .map_err(internal)?;
        let baris = hris::satu_baris(tx, "SELECT * FROM hr_jenis_pengajuan WHERE id_jenis = ?1;", &jenis.id_jenis)?;
        sync::enqueue(tx, client_id, "hr-request-type", "save", &jenis.id_jenis, &baris, None)?;
        Ok(json!({ "sukses": true, "id_jenis": jenis.id_jenis }))
    })
}

pub const PESAN_TUKAR_NONAKTIF: &str = "Karyawan yang diajak bertukar tidak ditemukan atau nonaktif.";
pub const PESAN_TUKAR_SHIFT_SAMA: &str = "Kedua karyawan memakai shift yang sama; tidak ada yang ditukar.";
pub const PESAN_TUKAR_SHIFT_HILANG: &str = "Shift salah satu karyawan tidak ditemukan.";
pub const PESAN_TUKAR_BACKUP: &str = "Salah satu karyawan punya penugasan backup aktif di tanggal itu.";

/// Shift kedua karyawan tukar shift saat diajukan (§18.2), setelah memeriksa
/// karyawan kedua aktif, shift keduanya ada dan berbeda, dan tidak ada backup.
fn shift_tukar_baru(tx: &Connection, id_karyawan: &str, id_tukar: &str, tanggal: &str) -> Result<(i64, i64), CommandError> {
    let shift = |id: &str, wajib_aktif: bool| -> Result<Option<i64>, CommandError> {
        tx.query_row(
            "SELECT id_shift FROM master_data WHERE id_unik = ?1 AND (?2 = 0 OR status_aktif = 'Aktif');",
            params![id, i64::from(wajib_aktif)],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(internal)
    };
    let asal = shift(id_karyawan, false)?.ok_or_else(|| invalid(PESAN_TUKAR_SHIFT_HILANG))?;
    let lain = shift(id_tukar, true)?.ok_or_else(|| invalid(PESAN_TUKAR_NONAKTIF))?;
    if asal == lain {
        return Err(invalid(PESAN_TUKAR_SHIFT_SAMA));
    }
    let ada: i64 = tx
        .query_row("SELECT COUNT(*) FROM tbl_shift WHERE id_shift IN (?1, ?2);", params![asal, lain], |r| r.get(0))
        .map_err(internal)?;
    if ada != 2 {
        return Err(invalid(PESAN_TUKAR_SHIFT_HILANG));
    }
    let backup: Option<String> = tx
        .query_row(BACKUP_TUKAR_SQL, params![tanggal, id_karyawan, id_tukar], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    if backup.is_some() {
        return Err(invalid(PESAN_TUKAR_BACKUP));
    }
    Ok((asal, lain))
}

/// Ajukan atau sunting pengajuan (§17.4). Urgent juga menulis keputusan
/// `urgent-<id>` di transaksi yang sama.
pub fn simpan_pengajuan(state: &DesktopState, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let sah = validasi_pengajuan(draft).map_err(invalid)?;
    let id_masuk = payload_text(draft, "id_pengajuan");
    if sah.urgent {
        if id_masuk.is_some() {
            return Err(invalid("Pengajuan urgent hanya bisa dibuat baru."));
        }
        if !punya(operator, "hr.request.urgent") {
            return Err(ditolak("Kamu tidak punya izin mengajukan urgent."));
        }
    }
    hris::dalam_transaksi(state, |tx, client_id| {
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
        let jenis = baca_jenis_semua(tx)?
            .into_iter()
            .find(|j| j.id_jenis == sah.id_jenis)
            .ok_or_else(|| invalid("Jenis pengajuan tidak ditemukan."))?;
        periksa_jenis(&sah, &jenis).map_err(invalid)?;
        let reimburse = jenis.kelompok == "Reimburse";
        if reimburse {
            periksa_tanggal_biaya(&sah.tanggal_mulai, &hris::hari_ini_wib(tx)?).map_err(invalid)?;
        }
        let nominal = if reimburse { sah.nominal } else { None };
        let lembur = jenis.kelompok == "Lembur";
        let (jam_mulai, jam_selesai) = if lembur {
            (Some(sah.jam_mulai.as_str()), Some(sah.jam_selesai.as_str()))
        } else {
            (None, None)
        };
        let id_tukar = (jenis.kelompok == "Tukar Shift").then_some(sah.id_karyawan_tukar.as_str());
        if sah.urgent {
            let sendiri = karyawan_sendiri(operator, &sah.id_karyawan) || id_tukar.is_some_and(|t| karyawan_sendiri(operator, t));
            periksa_urgent(sendiri).map_err(invalid)?;
        }
        let (id_shift_asal, id_shift_tukar) = match id_tukar {
            Some(tukar) => {
                let (asal, lain) = shift_tukar_baru(tx, &sah.id_karyawan, tukar, &sah.tanggal_mulai)?;
                (Some(asal), Some(lain))
            }
            None => (None, None),
        };
        let jadwal = jadwal_satu(tx, &sah.id_karyawan)?.ok_or_else(|| invalid("Karyawan tidak ditemukan."))?;
        let kalender = muat_kalender(tx, &sah.tanggal_mulai, &sah.tanggal_selesai)?;
        let wajib = tanggal_wajib(&jadwal, &kalender, &sah.tanggal_mulai, &sah.tanggal_selesai);
        // Lembur dan tukar shift sah di hari libur karyawan itu.
        if KELOMPOK_TIDAK_HADIR.contains(&jenis.kelompok.as_str()) {
            if wajib.is_empty() {
                return Err(invalid(PESAN_TANPA_HARI_KERJA));
            }
            let kalender_hari = selisih_hari(&sah.tanggal_mulai, &sah.tanggal_selesai) + 1;
            periksa_maks(&jenis, wajib.len() as i64, kalender_hari).map_err(invalid)?;
        }
        // Nota bulan lalu yang gajinya sudah dibayar adalah kasus biasa (§19.3).
        if !reimburse {
            tolak_bila_dibayar(tx, &sah.tanggal_mulai, &sah.tanggal_selesai)?;
        }

        let mut pengaju = operator.username.clone();
        let mut created_at: Option<String> = None;
        if let Some(id) = &id_masuk {
            let lama = baca_satu_pengajuan(tx, id)?.ok_or_else(|| invalid("Pengajuan tidak ditemukan."))?;
            let keputusan = baca_keputusan(tx, &[id.as_str()])?.remove(id).unwrap_or_default();
            let status = status_pengajuan(&lama.sidik, &keputusan);
            periksa_sunting(status, sama_orang(&lama.diajukan_oleh, &operator.username), operator.is_superadmin)
                .map_err(invalid)?;
            if lama.kelompok != "Reimburse" {
                tolak_bila_dibayar(tx, &lama.tanggal_mulai, &lama.tanggal_selesai)?;
            }
            pengaju = lama.diajukan_oleh;
            created_at = Some(lama.created_at);
        }

        // Bertumpuk dengan pengajuan lain yang masih menunggu atau berlaku,
        // menurut matriks §18.3 dan untuk kedua karyawan tukar shift.
        let baru = Ringkas {
            kelompok: &jenis.kelompok,
            id_karyawan: &sah.id_karyawan,
            id_karyawan_tukar: id_tukar,
            tanggal_mulai: &sah.tanggal_mulai,
            tanggal_selesai: &sah.tanggal_selesai,
            setengah_hari: sah.setengah_hari,
            jam_mulai,
            jam_selesai,
        };
        let mut lain: Vec<BarisPengajuan> = Vec::new();
        for orang in std::iter::once(sah.id_karyawan.as_str()).chain(id_tukar) {
            for p in baca_pengajuan(tx, Some(orang), &sah.tanggal_mulai, &sah.tanggal_selesai)? {
                if Some(&p.id_pengajuan) != id_masuk.as_ref() && !lain.iter().any(|q| q.id_pengajuan == p.id_pengajuan) {
                    lain.push(p);
                }
            }
        }
        let ids: Vec<&str> = lain.iter().map(|p| p.id_pengajuan.as_str()).collect();
        let keputusan_lain = baca_keputusan(tx, &ids)?;
        for p in &lain {
            let status = status_pengajuan(&p.sidik, keputusan_lain.get(&p.id_pengajuan).map(Vec::as_slice).unwrap_or(&[]));
            if (status == "Menunggu" || status_berlaku(status)) && bentrok_pengajuan(&baru, &p.ringkas()) {
                return Err(invalid(pesan_bertumpuk(&p.tanggal_mulai, &p.tanggal_selesai)));
            }
        }

        let id = id_masuk.clone().unwrap_or_else(|| new_hex_id("pgn-"));
        let sidik = sidik_pengajuan(&IsiPengajuan {
            id_karyawan: &sah.id_karyawan,
            id_jenis: &sah.id_jenis,
            kelompok: &jenis.kelompok,
            potong_jatah: jenis.potong_jatah,
            dampak_gaji: &jenis.dampak_gaji,
            tanggal_mulai: &sah.tanggal_mulai,
            tanggal_selesai: &sah.tanggal_selesai,
            setengah_hari: sah.setengah_hari,
            alasan: &sah.alasan,
            jam_mulai,
            jam_selesai,
            id_karyawan_tukar: id_tukar,
            id_shift_asal,
            id_shift_tukar,
            nominal,
        });
        let waktu = waktu_sekarang(tx)?;
        tx.execute(
            UPSERT_PENGAJUAN_SQL,
            params![
                id,
                sah.id_karyawan,
                sah.id_jenis,
                jenis.kelompok,
                i64::from(jenis.potong_jatah),
                jenis.dampak_gaji,
                sah.tanggal_mulai,
                sah.tanggal_selesai,
                i64::from(sah.setengah_hari),
                sah.alasan,
                sidik,
                pengaju,
                waktu,
                created_at,
                jam_mulai,
                jam_selesai,
                id_tukar,
                id_shift_asal,
                id_shift_tukar,
                nominal
            ],
        )
        .map_err(internal)?;
        let baris = hris::satu_baris(tx, "SELECT * FROM hr_pengajuan WHERE id_pengajuan = ?1;", &id)?;
        sync::enqueue(tx, client_id, "hr-request", "save", &id, &baris, None)?;
        if sah.urgent {
            tulis_keputusan(tx, client_id, &format!("urgent-{id}"), &id, "Setujui Urgent", &sidik, None, &operator.username, None)?;
        }
        Ok(json!({ "sukses": true, "id_pengajuan": id, "hari_kerja": wajib.len() }))
    })
}

/// Setujui, Tolak, Diketahui, atau Batal (§17.4).
pub fn putuskan(state: &DesktopState, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let id = payload_text(draft, "id_pengajuan").ok_or_else(|| invalid("Pengajuan tidak ditemukan."))?;
    let aksi = teks(draft, "aksi");
    let alasan = teks(draft, "alasan");
    let nominal_disetujui = angka_opsional(draft, "nominal_disetujui", i64::MIN, i64::MAX)
        .map_err(|_| invalid("Nominal disetujui harus bilangan bulat rupiah."))?;
    hris::dalam_transaksi(state, |tx, client_id| {
        let p = baca_satu_pengajuan(tx, &id)?.ok_or_else(|| invalid("Pengajuan tidak ditemukan."))?;
        let reimburse = p.kelompok == "Reimburse";
        let keputusan = baca_keputusan(tx, &[id.as_str()])?.remove(&id).unwrap_or_default();
        let status = status_pengajuan(&p.sidik, &keputusan);
        let izin_pemutus = baca_jenis_semua(tx)?
            .into_iter()
            .find(|j| j.id_jenis == p.id_jenis)
            .map(|j| j.izin_pemutus)
            .unwrap_or_else(|| IZIN_PEMUTUS_AKTIF.to_owned());
        let keadaan = KeadaanAksi {
            status: status.to_owned(),
            sudah_diketahui: keputusan.iter().any(|k| k.jenis == "Diketahui"),
            pengaju_sendiri: sama_orang(&p.diajukan_oleh, &operator.username),
            superadmin: operator.is_superadmin,
            karyawan_sendiri: karyawan_sendiri(operator, &p.id_karyawan)
                || p.id_karyawan_tukar.as_deref().is_some_and(|t| karyawan_sendiri(operator, t)),
            boleh_putus: punya(operator, &izin_pemutus),
            reimburse,
            nominal: p.nominal.unwrap_or(0),
        };
        periksa_aksi(&aksi, &alasan, nominal_disetujui, &keadaan).map_err(invalid)?;
        if reimburse {
            // Klaim yang sudah dibayar atau ada di proses gaji tidak dibatalkan (§19.3).
            if aksi == "Batal" {
                let (pembayaran, baris) = muat_bayar(tx)?;
                if status_bayar(&id, &pembayaran, &baris, &muat_gaji_reimburse(tx)?) != STATUS_BELUM_DIBAYAR {
                    return Err(invalid(PESAN_KLAIM_DIBAYAR));
                }
            }
        } else if aksi == "Setujui" || aksi == "Batal" {
            tolak_bila_dibayar(tx, &p.tanggal_mulai, &p.tanggal_selesai)?;
        }
        let id_keputusan = match aksi.as_str() {
            "Diketahui" => format!("tahu-{id}"),
            "Batal" => format!("batal-{id}"),
            _ => new_hex_id("kpt-"),
        };
        let alasan_simpan = Some(alasan.as_str()).filter(|a| !a.is_empty());
        tulis_keputusan(tx, client_id, &id_keputusan, &id, &aksi, &p.sidik, alasan_simpan, &operator.username, nominal_disetujui)?;
        Ok(json!({ "sukses": true, "id_keputusan": id_keputusan }))
    })
}

/// Status bayar, dibayar ganda, dan lewat batas klaim Reimburse di `baris`.
struct InfoKlaim {
    status_bayar: HashMap<String, &'static str>,
    ganda: HashSet<String>,
    lewat_batas: HashSet<String>,
}

fn info_klaim(conn: &Connection, baris: &[BarisPengajuan], jenis: &[JenisPengajuan]) -> Result<InfoKlaim, CommandError> {
    let mut info = InfoKlaim { status_bayar: HashMap::new(), ganda: HashSet::new(), lewat_batas: HashSet::new() };
    let klaim: Vec<&BarisPengajuan> = baris.iter().filter(|p| p.kelompok == "Reimburse").collect();
    let (Some(awal), Some(akhir)) = (
        klaim.iter().map(|p| p.tanggal_mulai.as_str()).min(),
        klaim.iter().map(|p| p.tanggal_mulai.as_str()).max(),
    ) else {
        return Ok(info);
    };
    let (pembayaran, baris_bayar) = muat_bayar(conn)?;
    let gaji = muat_gaji_reimburse(conn)?;
    for p in &klaim {
        let id = p.id_pengajuan.as_str();
        info.status_bayar.insert(id.to_owned(), status_bayar(id, &pembayaran, &baris_bayar, &gaji));
        if dibayar_ganda(id, &pembayaran, &baris_bayar, &gaji) {
            info.ganda.insert(id.to_owned());
        }
    }
    // Batas dihitung atas seluruh klaim di bulan-bulan itu, bukan hanya yang tersaring.
    let bulan = |t: &str, akhir: &str| format!("{}-{akhir}", t.chars().take(7).collect::<String>());
    let sebulan: Vec<BarisPengajuan> = baca_pengajuan(conn, None, &bulan(awal, "01"), &bulan(akhir, "31"))?
        .into_iter()
        .filter(|p| p.kelompok == "Reimburse")
        .collect();
    let ids: Vec<&str> = sebulan.iter().map(|p| p.id_pengajuan.as_str()).collect();
    let keputusan = baca_keputusan(conn, &ids)?;
    let mut hitung: Vec<(&str, &str, &str, i64)> = Vec::new();
    for p in &sebulan {
        let kep = keputusan.get(&p.id_pengajuan).map(Vec::as_slice).unwrap_or(&[]);
        let status = status_pengajuan(&p.sidik, kep);
        let nominal = p.nominal.unwrap_or(0);
        if status == "Menunggu" {
            hitung.push((&p.id_karyawan, &p.id_jenis, &p.tanggal_mulai, nominal));
        } else if status_berlaku(status) {
            hitung.push((&p.id_karyawan, &p.id_jenis, &p.tanggal_mulai, nominal_berlaku(nominal, keputusan_berlaku(&p.sidik, kep))));
        }
    }
    let batas: HashMap<String, i64> = jenis
        .iter()
        .filter_map(|j| j.batas_bulanan.map(|b| (j.id_jenis.clone(), b)))
        .collect();
    info.lewat_batas = lewat_batas(&hitung, &batas);
    Ok(info)
}

/// Daftar pengajuan + status + tanda (§17.3), dan semua jenis. Tanpa
/// `hr.request.view`, hanya klaim Reimburse yang dikembalikan (§19.5).
pub fn daftar(state: &DesktopState, filter: &Value, hanya_reimburse: bool) -> Result<Value, CommandError> {
    let conn = super::storage::database(&state.data_dir)?;
    let id_karyawan = payload_text(filter, "id_karyawan");
    let mulai = payload_text(filter, "dari").filter(|t| hari_kerja::tanggal_valid(t)).unwrap_or_else(|| "0000-01-01".into());
    let selesai = payload_text(filter, "sampai").filter(|t| hari_kerja::tanggal_valid(t)).unwrap_or_else(|| "9999-12-31".into());
    let mut baris = baca_pengajuan(&conn, id_karyawan.as_deref(), &mulai, &selesai)?;
    if hanya_reimburse {
        baris.retain(|p| p.kelompok == "Reimburse");
    }
    let ids: Vec<&str> = baris.iter().map(|p| p.id_pengajuan.as_str()).collect();
    let keputusan = baca_keputusan(&conn, &ids)?;
    let jenis = baca_jenis_semua(&conn)?;
    let info = info_klaim(&conn, &baris, &jenis)?;
    let nama: HashMap<String, String> = {
        let mut st = conn.prepare("SELECT id_unik, nama FROM master_data;").map_err(internal)?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(internal)?;
        rows.collect::<Result<_, _>>().map_err(internal)?
    };
    let (awal, akhir) = baris.iter().fold((None::<&str>, None::<&str>), |(a, b), p| {
        (
            Some(a.map_or(p.tanggal_mulai.as_str(), |x| x.min(p.tanggal_mulai.as_str()))),
            Some(b.map_or(p.tanggal_selesai.as_str(), |x| x.max(p.tanggal_selesai.as_str()))),
        )
    });
    let (awal, akhir) = (awal.unwrap_or("0000-01-01").to_owned(), akhir.unwrap_or("0000-01-01").to_owned());
    let jadwal = muat_jadwal(&conn)?;
    let kalender = muat_kalender(&conn, &awal, &akhir)?;
    let hadir = muat_hadir(&conn, &awal, &akhir)?;
    let kosong = Vec::new();
    let status: Vec<&str> = baris
        .iter()
        .map(|p| status_pengajuan(&p.sidik, keputusan.get(&p.id_pengajuan).unwrap_or(&kosong)))
        .collect();
    let aktif = |s: &str| s == "Menunggu" || status_berlaku(s);
    let aturan_lembur = baca_aturan_lembur(&conn)?;
    let mut spl_aktif: HashMap<&str, Vec<(String, i64)>> = HashMap::new();
    for (i, p) in baris.iter().enumerate() {
        if p.kelompok == "Lembur" && aktif(status[i]) {
            let menit = durasi_lembur(p.jam_mulai.as_deref().unwrap_or(""), p.jam_selesai.as_deref().unwrap_or("")).unwrap_or(0);
            spl_aktif.entry(p.id_karyawan.as_str()).or_default().push((p.tanggal_mulai.clone(), menit));
        }
    }
    let lewat_batas: HashMap<&str, HashSet<String>> = spl_aktif
        .iter()
        .map(|(id, spl)| (*id, lembur_lewat_batas(spl, aturan_lembur.maks_harian * 60, aturan_lembur.maks_mingguan * 60)))
        .collect();
    let mut hasil = Vec::with_capacity(baris.len());
    for (i, p) in baris.iter().enumerate() {
        let kep = keputusan.get(&p.id_pengajuan).unwrap_or(&kosong);
        let mut tanda = tanda_keputusan(&p.sidik, &p.diajukan_oleh, kep);
        if aktif(status[i])
            && baris
                .iter()
                .enumerate()
                .any(|(j, q)| j != i && aktif(status[j]) && bentrok_pengajuan(&p.ringkas(), &q.ringkas()))
        {
            tanda.push("bertumpuk");
        }
        if p.kelompok == "Lembur"
            && aktif(status[i])
            && lewat_batas.get(p.id_karyawan.as_str()).is_some_and(|t| t.contains(&p.tanggal_mulai))
        {
            tanda.push("lembur_lewat_batas");
        }
        let tidak_hadir = KELOMPOK_TIDAK_HADIR.contains(&p.kelompok.as_str());
        let wajib = jadwal
            .get(&p.id_karyawan)
            .filter(|_| tidak_hadir)
            .map(|j| tanggal_wajib(j, &kalender, &p.tanggal_mulai, &p.tanggal_selesai))
            .unwrap_or_default();
        if status_berlaku(status[i]) && !p.setengah_hari {
            if let Some(h) = hadir.get(&p.id_karyawan) {
                if wajib.iter().any(|t| h.contains(t)) {
                    tanda.push("hadir_saat_cuti");
                }
            }
        }
        let jenis_ini = jenis.iter().find(|j| j.id_jenis == p.id_jenis);
        let reimburse = p.kelompok == "Reimburse";
        let status_bayar_ini = info.status_bayar.get(&p.id_pengajuan).copied();
        let nominal_ini = p.nominal.map(|n| nominal_berlaku(n, keputusan_berlaku(&p.sidik, kep)));
        if reimburse {
            if aktif(status[i]) && info.lewat_batas.contains(&kunci_batas(&p.id_karyawan, &p.id_jenis, &p.tanggal_mulai)) {
                tanda.push("lewat_batas");
            }
            if info.ganda.contains(&p.id_pengajuan) {
                tanda.push("dibayar_ganda");
            }
            if !status_berlaku(status[i]) && status_bayar_ini == Some(STATUS_DIBAYAR) {
                tanda.push("dibayar_batal");
            }
        }
        hasil.push(json!({
            "pengajuan": p,
            "nominal_berlaku": if reimburse && status_berlaku(status[i]) { nominal_ini } else { None },
            "status_bayar": status_bayar_ini,
            "batas_bulanan": jenis_ini.and_then(|j| j.batas_bulanan),
            "nama_karyawan": nama.get(&p.id_karyawan),
            "nama_karyawan_tukar": p.id_karyawan_tukar.as_ref().and_then(|t| nama.get(t)),
            "menit_lembur": durasi_lembur(p.jam_mulai.as_deref().unwrap_or(""), p.jam_selesai.as_deref().unwrap_or("")).ok(),
            "nama_jenis": jenis_ini.map(|j| j.nama.clone()),
            "izin_pemutus": jenis_ini.map(|j| j.izin_pemutus.clone()).unwrap_or_else(|| IZIN_PEMUTUS_AKTIF.to_owned()),
            "wajib_dokumen": jenis_ini.is_some_and(|j| j.wajib_dokumen),
            "status": status[i],
            "tanda": tanda,
            "hari_kerja": wajib.len(),
            "sudah_diketahui": kep.iter().any(|k| k.jenis == "Diketahui"),
        }));
    }
    Ok(json!({
        "pengajuan": hasil,
        "jenis": jenis,
        "aturan_lembur": aturan_lembur,
        "mode_reimburse": baca_mode_reimburse(&conn)?,
    }))
}

/// Riwayat keputusan satu pengajuan. Tanpa `hr.request.view` hanya klaim
/// Reimburse (§19.5).
pub fn rincian(state: &DesktopState, id: &str, hanya_reimburse: bool) -> Result<Value, CommandError> {
    let conn = super::storage::database(&state.data_dir)?;
    if hanya_reimburse && !baca_satu_pengajuan(&conn, id)?.is_some_and(|p| p.kelompok == "Reimburse") {
        return Err(ditolak("Kamu hanya bisa melihat klaim reimbursement."));
    }
    Ok(json!({ "keputusan": riwayat_keputusan(&conn, id)? }))
}

/// Status bayar setiap penyesuaian `Diuangkan` (Q-62).
fn status_bayar_uang(conn: &Connection, penyesuaian: &[(Value, bool)]) -> Result<HashMap<String, &'static str>, CommandError> {
    let mut hasil = HashMap::new();
    if !penyesuaian.iter().any(|(b, _)| b["jenis"] == "Diuangkan") {
        return Ok(hasil);
    }
    let (pembayaran, baris) = muat_bayar(conn)?;
    for (b, _) in penyesuaian.iter().filter(|(b, _)| b["jenis"] == "Diuangkan") {
        if let Some(id) = b["id_penyesuaian"].as_str() {
            hasil.insert(id.to_owned(), status_bayar(id, &pembayaran, &baris, &[]));
        }
    }
    Ok(hasil)
}

fn baca_aturan(conn: &Connection) -> Result<AturanCuti, CommandError> {
    let mut st = conn
        .prepare("SELECT key, value FROM setting_gex_system WHERE key LIKE 'hr\\_cuti\\_%' ESCAPE '\\';")
        .map_err(internal)?;
    let peta = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(internal)?;
    Ok(AturanCuti::dari_peta(&peta))
}

/// Penyesuaian satu karyawan: (baris, dibatalkan).
fn baca_penyesuaian(conn: &Connection, id_karyawan: &str) -> Result<Vec<(Value, bool)>, CommandError> {
    let baris = hris::baris_json(
        conn,
        "SELECT * FROM hr_cuti_penyesuaian WHERE id_karyawan = ?1 ORDER BY periode, created_at, id_penyesuaian;",
        Some(id_karyawan),
    )?;
    let batal: HashSet<String> = baris
        .iter()
        .filter(|b| b["jenis"] == "Pembatalan")
        .filter_map(|b| b["id_ref"].as_str().map(str::to_owned))
        .collect();
    Ok(baris
        .into_iter()
        .filter(|b| b["jenis"] != "Pembatalan")
        .map(|b| {
            let dibatalkan = b["id_penyesuaian"].as_str().is_some_and(|id| batal.contains(id));
            (b, dibatalkan)
        })
        .collect())
}

/// Jatah per periode satu karyawan (§17.7).
fn hitung_jatah(conn: &Connection, id_karyawan: &str) -> Result<(AturanCuti, Option<String>, Vec<PeriodeCuti>, Vec<(Value, bool)>), CommandError> {
    let aturan = baca_aturan(conn)?;
    let masuk: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(tanggal_daftar), '') FROM master_data WHERE id_unik = ?1;",
            params![id_karyawan],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?
        .flatten();
    let berlaku: Vec<PengajuanBerlaku> = muat_berlaku(conn, "0000-01-01", "9999-12-31")?
        .into_iter()
        .filter(|p| p.id_karyawan == id_karyawan && p.potong_jatah)
        .collect();
    let mut terpakai: Vec<String> = Vec::new();
    if let (Some(awal), Some(akhir)) = (
        berlaku.iter().map(|p| p.tanggal_mulai.as_str()).min(),
        berlaku.iter().map(|p| p.tanggal_selesai.as_str()).max(),
    ) {
        let jadwal = jadwal_satu(conn, id_karyawan)?;
        let kalender = muat_kalender(conn, awal, akhir)?;
        let hadir = muat_hadir(conn, awal, akhir)?.remove(id_karyawan).unwrap_or_default();
        if let Some(j) = jadwal {
            let mut unik: HashSet<String> = HashSet::new();
            for p in &berlaku {
                for t in tanggal_wajib(&j, &kalender, &p.tanggal_mulai, &p.tanggal_selesai) {
                    if !hadir.contains(&t) {
                        unik.insert(t);
                    }
                }
            }
            terpakai = unik.into_iter().collect();
            terpakai.sort();
        }
    }
    let penyesuaian = baca_penyesuaian(conn, id_karyawan)?;
    let adj: Vec<(String, i64)> = penyesuaian
        .iter()
        .filter(|(_, batal)| !batal)
        .filter_map(|(b, _)| Some((b["periode"].as_str()?.to_owned(), b["hari"].as_i64()?)))
        .collect();
    let hari_ini = hris::hari_ini_wib(conn)?;
    let periode = periode_cuti(masuk.as_deref(), &aturan, &terpakai, &adj, &hari_ini);
    Ok((aturan, masuk, periode, penyesuaian))
}

/// Sisa cuti periode yang memuat `tanggal` dan upah harian pada tanggal itu:
/// dasar baris UPH Cuti saat karyawan keluar (§20.5). Cermin `sisaCutiKeluar`.
pub fn sisa_cuti_keluar(conn: &Connection, id_karyawan: &str, tanggal: &str) -> Result<(i64, i64), CommandError> {
    let (_, _, periode, _) = hitung_jatah(conn, id_karyawan)?;
    let sisa = periode
        .iter()
        .find(|p| !p.sebelum_berhak && p.mulai.as_str() <= tanggal && tanggal <= p.selesai.as_str())
        .map(|p| p.sisa.max(0))
        .unwrap_or(0);
    let gaji: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(salary_type, 'HOURLY'), COALESCE(daily_rate, 0), COALESCE(rate_per_hour, 0) FROM salary_configs
             WHERE id_karyawan = ?1 AND effective_date <= ?2 ORDER BY effective_date DESC LIMIT 1;",
            params![id_karyawan, tanggal],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(internal)?;
    let normal = jadwal_satu(conn, id_karyawan)?.map(|j| j.jam_normal_menit).unwrap_or(0);
    let harian = gaji.map(|(t, d, r)| upah_harian(&t, d, r, normal)).unwrap_or(0);
    Ok((sisa, harian))
}

pub fn jatah(state: &DesktopState, id_karyawan: &str) -> Result<Value, CommandError> {
    let conn = super::storage::database(&state.data_dir)?;
    let (aturan, masuk, periode, penyesuaian) = hitung_jatah(&conn, id_karyawan)?;
    let bayar = status_bayar_uang(&conn, &penyesuaian)?;
    Ok(json!({
        "aturan": aturan,
        "tanggal_masuk": masuk,
        "periode": periode,
        "penyesuaian": penyesuaian
            .into_iter()
            .map(|(b, batal)| {
                let status_bayar = b["id_penyesuaian"].as_str().and_then(|id| bayar.get(id)).copied();
                json!({ "baris": b, "dibatalkan": batal, "status_bayar": status_bayar })
            })
            .collect::<Vec<_>>(),
    }))
}

fn tulis_penyesuaian(
    tx: &Transaction<'_>,
    client_id: &str,
    nilai: (&str, &str, &str, &str, Option<&str>, i64, Option<i64>, &str, &str),
) -> Result<(), CommandError> {
    let (id, id_karyawan, periode, jenis, id_ref, hari, nominal, alasan, oleh) = nilai;
    tx.execute(
        INSERT_PENYESUAIAN_SQL,
        params![id, id_karyawan, periode, jenis, id_ref, hari, nominal, alasan, oleh, Option::<String>::None],
    )
    .map_err(internal)?;
    let baris = hris::satu_baris(tx, "SELECT * FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1;", id)?;
    sync::enqueue(tx, client_id, "hr-leave-adjustment", "create", id, &baris, None)?;
    Ok(())
}

/// Saldo awal atau koreksi jatah (`hr.leave.adjust`).
pub fn simpan_penyesuaian(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let (id_karyawan, periode, jenis, hari, alasan) = validasi_penyesuaian(draft).map_err(invalid)?;
    hris::dalam_transaksi(state, |tx, client_id| {
        let (_, _, daftar_periode, _) = hitung_jatah(tx, &id_karyawan)?;
        if !daftar_periode.iter().any(|p| p.mulai == periode) {
            return Err(invalid("Periode itu bukan periode cuti karyawan ini."));
        }
        let id = new_hex_id("cps-");
        tulis_penyesuaian(tx, client_id, (&id, &id_karyawan, &periode, &jenis, None, hari, None, &alasan, oleh))?;
        Ok(json!({ "sukses": true, "id_penyesuaian": id }))
    })
}

/// Batalkan penyesuaian dengan alasan (`hr.leave.adjust`), berid `batal-<id>`.
pub fn batal_penyesuaian(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id = payload_text(draft, "id_penyesuaian").ok_or_else(|| invalid("Penyesuaian tidak ditemukan."))?;
    let alasan = teks(draft, "alasan");
    if alasan.is_empty() {
        return Err(invalid("Alasan pembatalan wajib diisi."));
    }
    if panjang(&alasan) > MAKS_ALASAN {
        return Err(invalid(format!("Alasan maksimal {MAKS_ALASAN} karakter.")));
    }
    hris::dalam_transaksi(state, |tx, client_id| {
        let (id_karyawan, periode, jenis): (String, String, String) = tx
            .query_row(
                "SELECT id_karyawan, periode, jenis FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1;",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| invalid("Penyesuaian tidak ditemukan."))?;
        let id_batal = format!("batal-{id}");
        let sudah: bool = tx
            .query_row("SELECT EXISTS(SELECT 1 FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1);", params![id_batal], |r| r.get(0))
            .map_err(internal)?;
        if jenis == "Pembatalan" || sudah {
            return Err(invalid("Penyesuaian ini sudah dibatalkan."));
        }
        if jenis == "Diuangkan" {
            let (pembayaran, baris) = muat_bayar(tx)?;
            if status_bayar(&id, &pembayaran, &baris, &[]) == STATUS_DIBAYAR {
                return Err(invalid(PESAN_UANG_DIBAYAR));
            }
        }
        tulis_penyesuaian(tx, client_id, (&id_batal, &id_karyawan, &periode, "Pembatalan", Some(&id), 0, None, &alasan, oleh))?;
        Ok(json!({ "sukses": true, "id_penyesuaian": id_batal }))
    })
}

/// Catat sisa cuti periode yang sudah berakhir sebagai diuangkan (§17.7).
pub fn proses_akhir_periode(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_karyawan = payload_text(draft, "id_karyawan").ok_or_else(|| invalid("Pilih karyawan."))?;
    let periode = payload_text(draft, "periode").ok_or_else(|| invalid("Periode tidak valid."))?;
    hris::dalam_transaksi(state, |tx, client_id| {
        let (aturan, _, daftar_periode, _) = hitung_jatah(tx, &id_karyawan)?;
        if aturan.sisa != "diuangkan" {
            return Err(invalid("Sisa cuti tidak diatur untuk diuangkan."));
        }
        let hari_ini = hris::hari_ini_wib(tx)?;
        let p = daftar_periode
            .iter()
            .find(|p| p.mulai == periode && !p.sebelum_berhak)
            .ok_or_else(|| invalid("Periode itu bukan periode cuti karyawan ini."))?;
        if p.selesai.as_str() >= hari_ini.as_str() {
            return Err(invalid("Periode itu belum berakhir."));
        }
        let id = id_uang(&id_karyawan, &periode);
        let sudah: bool = tx
            .query_row("SELECT EXISTS(SELECT 1 FROM hr_cuti_penyesuaian WHERE id_penyesuaian = ?1);", params![id], |r| r.get(0))
            .map_err(internal)?;
        if sudah {
            return Err(invalid("Periode ini sudah diproses."));
        }
        if p.sisa <= 0 {
            return Err(invalid("Tidak ada sisa cuti untuk diuangkan."));
        }
        let gaji: (String, i64, i64) = tx
            .query_row(
                "SELECT COALESCE(salary_type, 'HOURLY'), COALESCE(daily_rate, 0), COALESCE(rate_per_hour, 0) FROM salary_configs
                 WHERE id_karyawan = ?1 AND effective_date <= ?2 ORDER BY effective_date DESC LIMIT 1;",
                params![id_karyawan, p.selesai],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(internal)?
            .ok_or_else(|| invalid("Karyawan ini belum punya pengaturan gaji."))?;
        let normal = jadwal_satu(tx, &id_karyawan)?.map(|j| j.jam_normal_menit).unwrap_or(0);
        let nominal = p.sisa * upah_harian(&gaji.0, gaji.1, gaji.2, normal);
        let alasan = format!("Sisa cuti periode {} s.d. {} diuangkan.", p.mulai, p.selesai);
        tulis_penyesuaian(tx, client_id, (&id, &id_karyawan, &periode, "Diuangkan", None, -p.sisa, Some(nominal), &alasan, oleh))?;
        Ok(json!({ "sukses": true, "id_penyesuaian": id, "hari": p.sisa, "nominal": nominal }))
    })
}

/// Periode berakhir yang belum diproses dan diuangkan yang belum dibayar,
/// untuk semua karyawan aktif (hanya mode `diuangkan`).
pub fn akhir_periode(state: &DesktopState) -> Result<Value, CommandError> {
    let conn = super::storage::database(&state.data_dir)?;
    let aturan = baca_aturan(&conn)?;
    let mut belum = Vec::new();
    let mut uang = Vec::new();
    if aturan.sisa == "diuangkan" {
        let hari_ini = hris::hari_ini_wib(&conn)?;
        let karyawan: Vec<(String, String)> = {
            let mut st = conn
                .prepare("SELECT id_unik, nama FROM master_data WHERE status_aktif = 'Aktif' ORDER BY nama;")
                .map_err(internal)?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(internal)?;
            rows.collect::<Result<_, _>>().map_err(internal)?
        };
        for (id, nama) in karyawan {
            let (_, _, periode, penyesuaian) = hitung_jatah(&conn, &id)?;
            for p in periode.iter().filter(|p| !p.sebelum_berhak && p.selesai < hari_ini && p.sisa > 0) {
                let kunci = id_uang(&id, &p.mulai);
                if !penyesuaian.iter().any(|(b, _)| b["id_penyesuaian"] == kunci.as_str()) {
                    belum.push(json!({ "id_karyawan": id, "nama": nama, "periode": p }));
                }
            }
            let bayar = status_bayar_uang(&conn, &penyesuaian)?;
            for (b, batal) in &penyesuaian {
                if b["jenis"] == "Diuangkan" && !batal {
                    let status_bayar = b["id_penyesuaian"].as_str().and_then(|id| bayar.get(id)).copied();
                    uang.push(json!({ "nama": nama, "baris": b, "status_bayar": status_bayar }));
                }
            }
        }
    }
    let aturan_lembur = baca_aturan_lembur(&conn)?;
    Ok(json!({
        "aturan": aturan,
        "aturan_lembur": aturan_lembur,
        "mode_reimburse": baca_mode_reimburse(&conn)?,
        "belum_diproses": belum,
        "diuangkan": uang,
    }))
}

/// Simpan aturan cuti dan lembur (`hr.org.manage`), pola `hris::simpan_pengaturan`.
pub fn simpan_aturan(state: &DesktopState, draft: &Value) -> Result<Value, CommandError> {
    let mut isian = validasi_aturan_cuti(draft).map_err(invalid)?;
    isian.extend(validasi_aturan_lembur(draft).map_err(invalid)?);
    isian.extend(validasi_aturan_reimburse(draft).map_err(invalid)?);
    hris::dalam_transaksi(state, |tx, client_id| {
        for (kunci, nilai) in &isian {
            tx.execute(
                "INSERT INTO setting_gex_system (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params![kunci, nilai],
            )
            .map_err(internal)?;
            tx.execute(
                "DELETE FROM desktop_sync_outbox WHERE domain = 'setting' AND entity_key = ?1
                   AND status IN ('pending', 'failed', 'conflict');",
                params![kunci],
            )
            .map_err(internal)?;
            sync::enqueue(tx, client_id, "setting", "update", kunci, &json!({ "key": kunci, "value": nilai }), None)?;
        }
        Ok(json!({ "sukses": true }))
    })
}

// ── Pembayaran terpisah reimbursement dan cuti diuangkan (§19.4) ───────────

fn enqueue_bayar_reimburse(tx: &Transaction<'_>, client_id: &str, id_bayar: &str) -> Result<(), CommandError> {
    let payload = json!({
        "bayar": hris::satu_baris(tx, "SELECT * FROM hr_reimburse_bayar WHERE id_bayar = ?1;", id_bayar)?,
        "baris": hris::baris_json(tx, "SELECT * FROM hr_reimburse_bayar_baris WHERE id_bayar = ?1 ORDER BY id_baris;", Some(id_bayar))?,
    });
    sync::enqueue(tx, client_id, "hr-reimburse-payment", "create", id_bayar, &payload, None)?;
    Ok(())
}

/// Cermin `catatBayarReimburse`: satu karyawan, klaim dan cuti diuangkan
/// miliknya yang Belum dibayar. Total = jumlah nominal berlaku saat dicatat.
pub fn catat_bayar_reimburse(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    hris::dalam_transaksi(state, |tx, client_id| {
        let valid = validasi_bayar_reimburse(draft, &hris::hari_ini_wib(tx)?).map_err(invalid)?;
        let klaim = muat_klaim(tx, "9999-12-31")?;
        let (pembayaran, baris) = muat_bayar(tx)?;
        let gaji = muat_gaji_reimburse(tx)?;
        let dibayar = periksa_bayar_reimburse(&valid, &klaim, &pembayaran, &baris, &gaji).map_err(invalid)?;
        let total: i64 = dibayar.iter().map(|k| k.nominal).sum();
        let id_bayar = new_hex_id("rbb-");
        tx.execute(
            CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
            params![id_bayar, "Bayar", Option::<String>::None, valid.id_karyawan, valid.tanggal, total, valid.keterangan, oleh, Option::<String>::None],
        )
        .map_err(internal)?;
        for k in &dibayar {
            tx.execute(
                CLOUD_INSERT_BARIS_REIMBURSE_SQL,
                params![id_baris_reimburse(&id_bayar, &k.id_klaim), id_bayar, k.sumber, k.id_klaim, k.nominal],
            )
            .map_err(internal)?;
        }
        enqueue_bayar_reimburse(tx, client_id, &id_bayar)?;
        Ok(json!({ "sukses": true, "id_bayar": id_bayar, "total": total }))
    })
}

/// Cermin `batalBayarReimburse`: baris `Pembatalan` berid `batal-<id_bayar>`
/// yang menyalin karyawan dan totalnya, bertanggal WIB hari ini.
pub fn batal_bayar_reimburse(state: &DesktopState, oleh: &str, draft: &Value) -> Result<Value, CommandError> {
    let id_bayar = payload_text(draft, "id_bayar").ok_or_else(|| invalid("Pembayaran tidak ditemukan."))?;
    let alasan = teks(draft, "alasan");
    if alasan.is_empty() {
        return Err(invalid("Alasan pembatalan wajib diisi."));
    }
    if panjang(&alasan) > MAKS_ALASAN {
        return Err(invalid(format!("Alasan maksimal {MAKS_ALASAN} karakter.")));
    }
    hris::dalam_transaksi(state, |tx, client_id| {
        let (pembayaran, _) = muat_bayar(tx)?;
        periksa_batal_bayar_reimburse(&pembayaran, &id_bayar).map_err(invalid)?;
        let asal = pembayaran.iter().find(|p| p.id_bayar == id_bayar).ok_or_else(CommandError::internal)?;
        let id = id_batal_reimburse(&id_bayar);
        tx.execute(
            CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
            params![id, "Pembatalan", id_bayar, asal.id_karyawan, hris::hari_ini_wib(tx)?, asal.total, alasan, oleh, Option::<String>::None],
        )
        .map_err(internal)?;
        enqueue_bayar_reimburse(tx, client_id, &id)?;
        Ok(json!({ "sukses": true, "id_bayar": id }))
    })
}

/// Cermin `ringkasanReimburse`: klaim Belum dibayar dan Dalam proses gaji, dan
/// riwayat pembayaran bertanggal `dari`..`sampai` beserta pembatalannya.
pub fn ringkasan_reimburse(state: &DesktopState, dari: &str, sampai: &str) -> Result<Value, CommandError> {
    let (dari, sampai) = (dari.trim(), sampai.trim());
    if !hari_kerja::tanggal_valid(dari) || !hari_kerja::tanggal_valid(sampai) || dari > sampai {
        return Err(invalid("Rentang tanggal tidak valid."));
    }
    let conn = super::storage::database(&state.data_dir)?;
    let nama: HashMap<String, String> = {
        let mut st = conn.prepare("SELECT id_unik, nama FROM master_data;").map_err(internal)?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(internal)?;
        rows.collect::<Result<_, _>>().map_err(internal)?
    };
    let klaim = muat_klaim(&conn, "9999-12-31")?;
    let (pembayaran, baris) = muat_bayar(&conn)?;
    let gaji = muat_gaji_reimburse(&conn)?;
    let mut belum = Vec::new();
    let mut proses_gaji = Vec::new();
    for k in &klaim {
        let item = json!({ "klaim": k, "nama": nama.get(&k.id_karyawan) });
        match status_bayar(&k.id_klaim, &pembayaran, &baris, &gaji) {
            STATUS_BELUM_DIBAYAR => belum.push(item),
            STATUS_PROSES_GAJI => proses_gaji.push(item),
            _ => {}
        }
    }
    let riwayat: Vec<Value> = pembayaran
        .iter()
        .filter(|p| p.jenis == "Bayar" && p.tanggal.as_str() >= dari && p.tanggal.as_str() <= sampai)
        .rev()
        .map(|p| {
            let batal = pembayaran
                .iter()
                .find(|x| x.jenis == "Pembatalan" && x.id_ref.as_deref() == Some(p.id_bayar.as_str()));
            let isi: Vec<Value> = baris
                .iter()
                .filter(|b| b.id_bayar == p.id_bayar)
                .map(|b| {
                    let keterangan = klaim.iter().find(|k| k.id_klaim == b.id_klaim).map(|k| k.keterangan.clone());
                    json!({ "baris": b, "keterangan": keterangan })
                })
                .collect();
            json!({ "bayar": p, "nama": nama.get(&p.id_karyawan), "batal": batal, "baris": isi })
        })
        .collect();
    Ok(json!({
        "mode": baca_mode_reimburse(&conn)?,
        "belum_dibayar": belum,
        "proses_gaji": proses_gaji,
        "riwayat": riwayat,
    }))
}

// ── Lampiran KHUSUS CLOUD (Q-51, pola `hr_dokumen_berkas`) ─────────────────

use super::turso::TursoClient;

pub const MAKS_LAMPIRAN: i64 = 5;

/// Pengaju, kelompok, dan pemutus jenis pengajuan di cloud; `None` bila
/// belum sampai di cloud.
const PENGAJU_CLOUD_SQL: &str = "SELECT p.diajukan_oleh, p.kelompok, COALESCE((SELECT j.izin_pemutus FROM hr_jenis_pengajuan j WHERE j.id_jenis = p.id_jenis), 'hr.request.decide') AS izin_pemutus FROM hr_pengajuan p WHERE p.id_pengajuan = ?1;";

async fn pengaju_cloud(turso: &TursoClient, id_pengajuan: &str) -> Result<Option<(String, String, String)>, CommandError> {
    Ok(hris::objek(turso, PENGAJU_CLOUD_SQL, vec![json!(id_pengajuan)])
        .await?
        .into_iter()
        .next()
        .map(|b| {
            let teks = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            (teks("diajukan_oleh"), teks("kelompok"), teks("izin_pemutus"))
        }))
}

/// Pengaju, pemegang `hr.request.decide`, atau pemegang pemutus jenisnya
/// (nota reimbursement, §19.5) yang mengubah lampiran.
fn boleh_ubah_lampiran(operator: &OperatorUser, pengaju: &str, izin_pemutus: &str) -> Result<(), CommandError> {
    if sama_orang(pengaju, &operator.username) || punya(operator, "hr.request.decide") || punya(operator, izin_pemutus) {
        Ok(())
    } else {
        Err(ditolak("Hanya pengaju atau pemutusnya yang bisa mengubah lampiran pengajuan ini."))
    }
}

/// Tanpa `hr.request.view`, lampiran hanya terbaca untuk klaim Reimburse.
async fn boleh_baca_lampiran(turso: &TursoClient, id_pengajuan: &str, hanya_reimburse: bool) -> Result<(), CommandError> {
    if hanya_reimburse && !pengaju_cloud(turso, id_pengajuan).await?.is_some_and(|(_, k, _)| k == "Reimburse") {
        return Err(ditolak("Kamu hanya bisa melihat nota reimbursement."));
    }
    Ok(())
}

pub async fn lampiran(turso: &TursoClient, id_pengajuan: &str, hanya_reimburse: bool) -> Result<Value, CommandError> {
    hris::siap(turso).await?;
    boleh_baca_lampiran(turso, id_pengajuan, hanya_reimburse).await?;
    let baris = hris::objek(
        turso,
        "SELECT id_berkas, urutan, nama_berkas, mime_type, diunggah_oleh, created_at FROM hr_pengajuan_berkas WHERE id_pengajuan = ?1 ORDER BY urutan;",
        vec![json!(id_pengajuan)],
    )
    .await?;
    Ok(json!({ "berkas": baris }))
}

pub async fn isi_lampiran(turso: &TursoClient, id_berkas: &str, hanya_reimburse: bool) -> Result<Value, CommandError> {
    hris::siap(turso).await?;
    let berkas = hris::objek(
        turso,
        "SELECT id_berkas, id_pengajuan, nama_berkas, mime_type, data_base64 FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
        vec![json!(id_berkas)],
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| invalid("Berkas tidak ditemukan."))?;
    let id_pengajuan = berkas.get("id_pengajuan").and_then(Value::as_str).unwrap_or_default();
    boleh_baca_lampiran(turso, id_pengajuan, hanya_reimburse).await?;
    Ok(json!(berkas))
}

pub async fn tambah_lampiran(turso: &TursoClient, operator: &OperatorUser, draft: &Value) -> Result<Value, CommandError> {
    let id_pengajuan = payload_text(draft, "id_pengajuan").ok_or_else(|| invalid("Pengajuan tidak ditemukan."))?;
    let mime = payload_text(draft, "mime_type").unwrap_or_default();
    let data = draft.get("data_base64").and_then(Value::as_str).unwrap_or("");
    hris::validasi_berkas(&mime, data).map_err(invalid)?;
    let nama_berkas = payload_text(draft, "nama_berkas").map(|n| n.chars().take(255).collect::<String>());
    hris::siap(turso).await?;
    let (pengaju, _, izin_pemutus) = pengaju_cloud(turso, &id_pengajuan)
        .await?
        .ok_or_else(|| invalid("Pengajuan belum sampai ke database. Sinkronkan dulu, lalu coba lagi."))?;
    boleh_ubah_lampiran(operator, &pengaju, &izin_pemutus)?;
    let terpakai: HashSet<i64> = hris::objek(
        turso,
        "SELECT urutan FROM hr_pengajuan_berkas WHERE id_pengajuan = ?1;",
        vec![json!(id_pengajuan)],
    )
    .await?
    .iter()
    .filter_map(|b| b.get("urutan").and_then(Value::as_i64))
    .collect();
    let urutan = (1..=MAKS_LAMPIRAN)
        .find(|u| !terpakai.contains(u))
        .ok_or_else(|| invalid(format!("Satu pengajuan maksimal {MAKS_LAMPIRAN} lampiran.")))?;
    let id = new_hex_id("pb-");
    turso
        .query_one(
            "INSERT INTO hr_pengajuan_berkas (id_berkas, id_pengajuan, urutan, nama_berkas, mime_type, data_base64, diunggah_oleh) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
            vec![json!(id), json!(id_pengajuan), json!(urutan), json!(nama_berkas), json!(mime), json!(data), json!(operator.username)],
        )
        .await
        .map_err(hris::tak_terhubung)?;
    Ok(json!({ "sukses": true, "id_berkas": id }))
}

pub async fn hapus_lampiran(turso: &TursoClient, operator: &OperatorUser, id_berkas: &str) -> Result<Value, CommandError> {
    hris::siap(turso).await?;
    let id_pengajuan = hris::objek(
        turso,
        "SELECT id_pengajuan FROM hr_pengajuan_berkas WHERE id_berkas = ?1;",
        vec![json!(id_berkas)],
    )
    .await?
    .into_iter()
    .next()
    .and_then(|b| b.get("id_pengajuan").and_then(Value::as_str).map(str::to_owned))
    .ok_or_else(|| invalid("Berkas tidak ditemukan."))?;
    let (pengaju, _, izin_pemutus) = pengaju_cloud(turso, &id_pengajuan).await?.unwrap_or_default();
    boleh_ubah_lampiran(operator, &pengaju, &izin_pemutus)?;
    turso
        .query_one("DELETE FROM hr_pengajuan_berkas WHERE id_berkas = ?1;", vec![json!(id_berkas)])
        .await
        .map_err(hris::tak_terhubung)?;
    Ok(json!({ "sukses": true }))
}

// ── Handler cloud (tidak pernah menolak karena aturan bisnis) ──────────────

fn angka01(row: &Value, kunci: &str) -> Option<i64> {
    row.get(kunci).and_then(Value::as_i64).filter(|n| *n == 0 || *n == 1)
}

/// `hr-request-type/save`: bentuk dan CHECK saja.
pub fn cloud_jenis_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = hris::id_dari(payload, "id_jenis", entity_key)?;
    let nama = hris::nama_master(&payload_text(payload, "nama")?).ok()?;
    let kelompok = payload_text(payload, "kelompok").filter(|k| {
        ["Cuti", "Izin", "Sakit", "Lembur", "Tukar Shift", "Dinas Luar", "Reimburse"].contains(&k.as_str())
    })?;
    let izin = payload_text(payload, "izin_pemutus")
        .filter(|i| i == "hr.request.decide" || i == "reimburse.decide")?;
    let dampak = payload_text(payload, "dampak_gaji").filter(|d| DAMPAK_GAJI.contains(&d.as_str()))?;
    let satuan = payload_text(payload, "satuan_maks").filter(|s| SATUAN_MAKS.contains(&s.as_str()))?;
    let potong = angka01(payload, "potong_jatah")?;
    if potong == 1 && kelompok != "Cuti" {
        return None;
    }
    let maks = match payload.get("maks_hari") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_i64().filter(|n| *n > 0)?),
    };
    // Perangkat v38 tidak mengenal `batas_bulanan`: kunci absen = pertahankan.
    let (batas, bawa_batas) = match payload.get("batas_bulanan") {
        None => (None, 0),
        Some(Value::Null) => (None, 1),
        Some(v) => (Some(v.as_i64().filter(|n| *n > 0)?), 1),
    };
    Some(vec![(
        UPSERT_JENIS_SQL,
        vec![
            json!(id),
            json!(nama),
            json!(kelompok),
            json!(izin),
            json!(angka01(payload, "boleh_urgent")?),
            json!(potong),
            json!(dampak),
            json!(maks),
            json!(satuan),
            json!(angka01(payload, "wajib_dokumen")?),
            json!(angka01(payload, "is_aktif")?),
            json!(payload_text(payload, "created_at")),
            json!(batas),
            json!(bawa_batas),
        ],
    )])
}

/// `hr-request/save`: selalu upsert; suntingan yang telat menggugurkan
/// keputusan lewat sidik, bukan ditolak.
pub fn cloud_pengajuan_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = hris::id_dari(payload, "id_pengajuan", entity_key)?;
    let kelompok = payload_text(payload, "kelompok").filter(|k| {
        ["Cuti", "Izin", "Sakit", "Lembur", "Tukar Shift", "Dinas Luar", "Reimburse"].contains(&k.as_str())
    })?;
    let dampak = payload_text(payload, "dampak_gaji").filter(|d| DAMPAK_GAJI.contains(&d.as_str()))?;
    let mulai = payload_text(payload, "tanggal_mulai").filter(|t| hari_kerja::tanggal_valid(t))?;
    let selesai = payload_text(payload, "tanggal_selesai").filter(|t| hari_kerja::tanggal_valid(t) && *t >= mulai)?;
    let setengah = angka01(payload, "setengah_hari")?;
    if setengah == 1 && (kelompok != "Izin" || mulai != selesai) {
        return None;
    }
    let potong = angka01(payload, "potong_jatah")?;
    // Isian fase 3 hanya untuk kelompoknya; bentuk salah = tanpa statement.
    let satu_tanggal = mulai == selesai;
    let (jam_mulai, jam_selesai) = if kelompok == "Lembur" {
        let a = payload_text(payload, "jam_mulai")?;
        let b = payload_text(payload, "jam_selesai")?;
        if !satu_tanggal || durasi_lembur(&a, &b).is_err() {
            return None;
        }
        (Some(a), Some(b))
    } else {
        (None, None)
    };
    let nominal = if kelompok == "Reimburse" {
        let n = payload.get("nominal").and_then(Value::as_i64).filter(|n| *n > 0)?;
        if !satu_tanggal {
            return None;
        }
        Some(n)
    } else {
        None
    };
    let (id_tukar, shift_asal, shift_tukar) = if kelompok == "Tukar Shift" {
        let tukar = payload_text(payload, "id_karyawan_tukar")?;
        let asal = payload.get("id_shift_asal").and_then(Value::as_i64)?;
        let lain = payload.get("id_shift_tukar").and_then(Value::as_i64)?;
        if !satu_tanggal || asal == lain {
            return None;
        }
        (Some(tukar), Some(asal), Some(lain))
    } else {
        (None, None, None)
    };
    Some(vec![(
        UPSERT_PENGAJUAN_SQL,
        vec![
            json!(id),
            json!(payload_text(payload, "id_karyawan")?),
            json!(payload_text(payload, "id_jenis")?),
            json!(kelompok),
            json!(potong),
            json!(dampak),
            json!(mulai),
            json!(selesai),
            json!(setengah),
            json!(payload_text(payload, "alasan")?),
            json!(payload_text(payload, "sidik")?),
            json!(payload_text(payload, "diajukan_oleh")?),
            json!(payload_text(payload, "waktu_perangkat")?),
            json!(payload_text(payload, "created_at")),
            json!(jam_mulai),
            json!(jam_selesai),
            json!(id_tukar),
            json!(shift_asal),
            json!(shift_tukar),
            json!(nominal),
        ],
    )])
}

/// `hr-request-decision/create`: append-only, kiriman ulang berhenti di PK.
pub fn cloud_keputusan_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = hris::id_dari(payload, "id_keputusan", entity_key)?;
    let jenis = payload_text(payload, "jenis").filter(|j| {
        ["Setujui", "Tolak", "Setujui Urgent", "Diketahui", "Batal"].contains(&j.as_str())
    })?;
    let nominal_disetujui = match payload.get("nominal_disetujui") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_i64().filter(|n| *n > 0)?),
    };
    Some(vec![(
        CLOUD_INSERT_KEPUTUSAN_SQL,
        vec![
            json!(id),
            json!(payload_text(payload, "id_pengajuan")?),
            json!(jenis),
            json!(payload_text(payload, "sidik")?),
            json!(payload_text(payload, "alasan")),
            json!(payload_text(payload, "oleh")?),
            json!(payload_text(payload, "waktu_perangkat")?),
            json!(payload_text(payload, "created_at")),
            json!(nominal_disetujui),
        ],
    )])
}

/// `hr-reimburse-payment/create`: append-only, kiriman ulang berhenti di PK.
/// Hanya bentuk dan CHECK; bayar ganda dari perangkat offline TIDAK ditolak
/// (outbox macet), melainkan menjadi tanda `dibayar_ganda`.
pub fn cloud_bayar_reimburse_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let row = payload.get("bayar")?;
    let id = hris::id_dari(row, "id_bayar", entity_key)?;
    let jenis = payload_text(row, "jenis").filter(|j| j == "Bayar" || j == "Pembatalan")?;
    let id_ref = payload_text(row, "id_ref");
    let tanggal = payload_text(row, "tanggal").filter(|t| hari_kerja::tanggal_valid(t))?;
    let total = row.get("total")?.as_i64().filter(|n| *n >= 0)?;
    let baris = match payload.get("baris") {
        None | Some(Value::Null) => &[][..],
        Some(nilai) => nilai.as_array()?.as_slice(),
    };
    let bentuk_sah = if jenis == "Bayar" {
        !baris.is_empty() && baris.len() <= MAKS_KLAIM_PER_BAYAR
    } else {
        id_ref.is_some() && baris.is_empty()
    };
    if !bentuk_sah {
        return None;
    }
    let mut statements = vec![(
        CLOUD_INSERT_BAYAR_REIMBURSE_SQL,
        vec![
            json!(id),
            json!(jenis),
            json!(id_ref),
            json!(payload_text(row, "id_karyawan")?),
            json!(tanggal),
            json!(total),
            json!(payload_text(row, "keterangan")),
            json!(payload_text(row, "dicatat_oleh")?),
            json!(payload_text(row, "created_at")),
        ],
    )];
    for b in baris {
        statements.push((
            CLOUD_INSERT_BARIS_REIMBURSE_SQL,
            vec![
                json!(payload_text(b, "id_baris")?),
                json!(id),
                json!(payload_text(b, "sumber").filter(|s| s == SUMBER_REIMBURSE || s == SUMBER_UANG)?),
                json!(payload_text(b, "id_klaim")?),
                json!(b.get("nominal")?.as_i64().filter(|n| *n >= 0)?),
            ],
        ));
    }
    Some(statements)
}

/// `hr-leave-adjustment/create`: append-only.
pub fn cloud_penyesuaian_statements(payload: &Value, entity_key: &str) -> Option<Vec<(&'static str, Vec<Value>)>> {
    let id = hris::id_dari(payload, "id_penyesuaian", entity_key)?;
    let jenis = payload_text(payload, "jenis").filter(|j| {
        ["Saldo Awal", "Koreksi", "Diuangkan", "Pembatalan"].contains(&j.as_str())
    })?;
    let periode = payload_text(payload, "periode").filter(|t| hari_kerja::tanggal_valid(t))?;
    let nominal = match payload.get("nominal") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_i64()?),
    };
    Some(vec![(
        INSERT_PENYESUAIAN_SQL,
        vec![
            json!(id),
            json!(payload_text(payload, "id_karyawan")?),
            json!(periode),
            json!(jenis),
            json!(payload_text(payload, "id_ref")),
            json!(payload.get("hari").and_then(Value::as_i64)?),
            json!(nominal),
            json!(payload_text(payload, "alasan")?),
            json!(payload_text(payload, "dicatat_oleh")?),
            json!(payload_text(payload, "created_at")),
        ],
    )])
}

#[cfg(test)]
mod tests_alur {
    use super::*;
    use crate::desktop::storage;

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

    /// Alur lokal + outbox, lalu payload outbox diterapkan ke database cloud
    /// (`TursoClient::local_file`) lewat handler cloud. Cermin tes Web.
    #[test]
    fn alur_lokal_outbox_cloud() {
        let (_dir, state) = state_uji();
        let conn = storage::database(&state.data_dir).expect("db");
        conn.execute_batch(
            "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit,
               istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
             VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');
             INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar) VALUES
               ('K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02'),
               ('K2', 'Budi', 'Gudang', 1, 'Aktif', '2024-01-02');",
        )
        .expect("data awal");
        let atasan = operator("atasan", &["hr.request.submit", "hr.request.urgent"], Some("K2"));
        let hrd = operator("hrd", &["hr.request.submit", "hr.request.decide"], None);

        // Sakit urgent Senin–Minggu: 5 hari kerja.
        let sakit = json!({"id_karyawan": "K1", "id_jenis": "jns-sakit", "tanggal_mulai": "2026-11-02",
                           "tanggal_selesai": "2026-11-08", "alasan": "Demam", "urgent": true});
        let hasil = simpan_pengajuan(&state, &atasan, &sakit).expect("ajukan");
        assert_eq!(hasil["hari_kerja"], 5);
        let id = hasil["id_pengajuan"].as_str().unwrap().to_owned();

        let mut diri = sakit.clone();
        diri["id_karyawan"] = json!("K2");
        assert_eq!(
            simpan_pengajuan(&state, &atasan, &diri).unwrap_err().message,
            "Pengajuan urgent untuk dirimu sendiri tidak bisa disetujui sendiri."
        );
        let izin = json!({"id_karyawan": "K1", "id_jenis": "jns-izin-dibayar", "tanggal_mulai": "2026-11-04",
                          "tanggal_selesai": "2026-11-04", "alasan": "Bank"});
        assert_eq!(
            simpan_pengajuan(&state, &hrd, &izin).unwrap_err().message,
            pesan_bertumpuk("2026-11-02", "2026-11-08")
        );
        let libur = json!({"id_karyawan": "K1", "id_jenis": "jns-izin-dibayar", "tanggal_mulai": "2026-11-14",
                           "tanggal_selesai": "2026-11-15", "alasan": "Sabtu"});
        assert_eq!(simpan_pengajuan(&state, &hrd, &libur).unwrap_err().message, PESAN_TANPA_HARI_KERJA);

        let d = daftar(&state, &json!({}), false).expect("daftar");
        assert_eq!(d["pengajuan"][0]["status"], "Disetujui (urgent)");
        assert_eq!(d["pengajuan"][0]["tanda"], json!(["perlu_diketahui"]));
        putuskan(&state, &hrd, &json!({"id_pengajuan": id, "aksi": "Diketahui"})).expect("diketahui");

        // A-3 dan A-4: Alfa dilewati, lima hari Dibayar = 5 hari / 2400 menit.
        assert!(pengaju_tanggal(&conn, "2026-11-03").unwrap().contains("K1"));
        assert!(!pengaju_tanggal(&conn, "2026-11-09").unwrap().contains("K1"));
        assert_eq!(cuti_dibayar(&conn, "2026-11-01", "2026-11-30").unwrap()["K1"], (5, 2400));

        let outbox: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT domain, entity_key, payload_json FROM desktop_sync_outbox ORDER BY rowid;")
                .unwrap();
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        assert_eq!(
            outbox.iter().map(|(d, k, _)| (d.as_str(), k.as_str())).collect::<Vec<_>>(),
            vec![
                ("hr-request", id.as_str()),
                ("hr-request-decision", format!("urgent-{id}").as_str()),
                ("hr-request-decision", format!("tahu-{id}").as_str()),
            ]
        );

        // Gaji periode itu sudah dibayar: membatalkan ditolak di perangkat.
        conn.execute_batch(
            "INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by, created_at, updated_at)
             VALUES ('run-1', 'k-1', '2026-11-01', '2026-11-30', 'PAID', 'hrd', '2026-12-01', '2026-12-01');",
        )
        .unwrap();
        assert_eq!(
            putuskan(&state, &hrd, &json!({"id_pengajuan": id, "aksi": "Batal", "alasan": "Masuk"}))
                .unwrap_err()
                .message,
            pesan_periode_dibayar("2026-11-01", "2026-11-30")
        );

        // Cloud: payload outbox apa adanya, `diterima_cloud` jam cloud.
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            let hub_dir = tempfile::tempdir().unwrap();
            let hub = hub_dir.path().join("sppg-hub.db");
            let client = TursoClient::local_file(
                url::Url::parse("https://hr-pengajuan.sppg.invalid").unwrap(),
                &hub,
                reqwest::Client::new(),
            );
            client.ensure_schema().await.expect("skema cloud");
            for (domain, key, payload) in &outbox {
                let payload: Value = serde_json::from_str(payload).unwrap();
                let statements = match domain.as_str() {
                    "hr-request" => cloud_pengajuan_statements(&payload, key),
                    _ => cloud_keputusan_statements(&payload, key),
                }
                .expect("payload sah");
                for (sql, args) in statements {
                    client.query_one(sql, args).await.expect("terapkan");
                }
            }
            let hub = Connection::open(&hub).unwrap();
            assert_eq!(muat_berlaku(&hub, "2026-11-05", "2026-11-05").unwrap().len(), 1);
            let tanpa_jam: i64 = hub
                .query_row("SELECT COUNT(*) FROM hr_pengajuan_keputusan WHERE diterima_cloud IS NULL;", [], |r| r.get(0))
                .unwrap();
            assert_eq!(tanpa_jam, 0);
            let jenis: i64 = hub.query_row("SELECT COUNT(*) FROM hr_jenis_pengajuan;", [], |r| r.get(0)).unwrap();
            assert_eq!(jenis as usize, jenis_bawaan().len());
            // Payload cacat tidak menghasilkan mutasi (menjadi konflik, bukan diterapkan).
            assert!(cloud_keputusan_statements(&json!({"id_keputusan": "x", "jenis": "Hapus"}), "x").is_none());
        });
    }

    /// Fase 3 (v38): tukar shift dan lembur lewat penulisan lokal + outbox,
    /// pembaca baru, dan handler cloud. Cermin "fase 3" di tes Web.
    #[test]
    fn alur_fase3_tukar_dan_lembur() {
        let (_dir, state) = state_uji();
        let conn = storage::database(&state.data_dir).expect("db");
        conn.execute_batch(
            "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit,
               istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
             VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5'),
                    (2, 2, 'Malam', '22:00', '06:00', 480, 60, 240, 120, 180, '1,2,3,4,5,6,7');
             INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar) VALUES
               ('K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02'),
               ('K2', 'Budi', 'Gudang', 2, 'Aktif', '2024-01-02'),
               ('K3', 'Cici', 'Gudang', 1, 'Aktif', '2024-01-02');",
        )
        .expect("data awal");
        let hrd = operator("hrd", &["hr.request.submit"], None);
        let pemutus = operator("hrd2", &["hr.request.decide"], Some("K3"));
        let setujui = |id: &str| {
            putuskan(&state, &pemutus, &json!({"id_pengajuan": id, "aksi": "Setujui"})).expect("setujui");
        };
        let ajukan = |draft: Value| -> String {
            simpan_pengajuan(&state, &hrd, &draft).expect("ajukan")["id_pengajuan"].as_str().unwrap().to_owned()
        };

        // Tukar shift K1 (Pagi) ⇄ K2 (Malam) pada Selasa 2026-11-03.
        let tukar = json!({"id_karyawan": "K1", "id_jenis": "jns-tukar-shift", "tanggal_mulai": "2026-11-03",
                           "tanggal_selesai": "2026-11-03", "alasan": "Acara keluarga", "id_karyawan_tukar": "K2"});
        let id_tukar = ajukan(tukar);
        assert!(muat_tukar(&conn, "2026-11-03", "2026-11-03").unwrap().is_empty(), "Menunggu belum berlaku");
        setujui(&id_tukar);
        let peta = muat_tukar(&conn, "2026-11-02", "2026-11-04").unwrap();
        assert_eq!(peta.get(&("K1".into(), "2026-11-03".into())), Some(&2));
        assert_eq!(peta.get(&("K2".into(), "2026-11-03".into())), Some(&1));
        assert_eq!(peta.len(), 2);
        // Tukar tidak menutup tanggal itu dari Alfa.
        assert!(pengaju_tanggal(&conn, "2026-11-03").unwrap().is_empty());
        // Karyawan kedua tidak bisa memutus tukar yang memuat dirinya.
        let k2 = operator("budi", &["hr.request.decide"], Some("K2"));
        let tukar2 = ajukan(json!({"id_karyawan": "K2", "id_jenis": "jns-tukar-shift", "tanggal_mulai": "2026-11-05",
                                   "tanggal_selesai": "2026-11-05", "alasan": "x", "id_karyawan_tukar": "K1"}));
        assert_eq!(
            putuskan(&state, &k2, &json!({"id_pengajuan": tukar2, "aksi": "Setujui"})).unwrap_err().message,
            "Pengajuan untuk dirimu sendiri harus diputus orang lain."
        );

        let gagal = |draft: Value| simpan_pengajuan(&state, &hrd, &draft).unwrap_err().message;
        assert_eq!(
            gagal(json!({"id_karyawan": "K1", "id_jenis": "jns-tukar-shift", "tanggal_mulai": "2026-11-04",
                         "tanggal_selesai": "2026-11-04", "alasan": "x", "id_karyawan_tukar": "K3"})),
            PESAN_TUKAR_SHIFT_SAMA
        );
        // Cuti K2 di tanggal tukar: bertumpuk lewat `id_karyawan_tukar`.
        assert_eq!(
            gagal(json!({"id_karyawan": "K2", "id_jenis": "jns-cuti-tahunan", "tanggal_mulai": "2026-11-03",
                         "tanggal_selesai": "2026-11-03", "alasan": "x"})),
            pesan_bertumpuk("2026-11-03", "2026-11-03")
        );
        conn.execute_batch(
            "INSERT INTO backup_karyawan (id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal, divisi_asal,
               id_shift_asal, id_karyawan_pengganti, nama_karyawan_pengganti, divisi_pengganti, id_shift_normal_pengganti,
               id_shift_backup, status_tugas, kode_operator, waktu_input)
             VALUES ('BCK-1', '2026-11-06', 'K3', 'Cici', 'Gudang', 1, 'K1', 'Ani', 'Gudang', 1, 1, 'Aktif', 'op', '2026-11-01');",
        )
        .unwrap();
        assert_eq!(
            gagal(json!({"id_karyawan": "K1", "id_jenis": "jns-tukar-shift", "tanggal_mulai": "2026-11-06",
                         "tanggal_selesai": "2026-11-06", "alasan": "x", "id_karyawan_tukar": "K2"})),
            PESAN_TUKAR_BACKUP
        );

        // Lembur: sah di hari libur mingguan (Sabtu), jam beririsan ditolak.
        let lembur = |tanggal: &str, a: &str, b: &str| {
            json!({"id_karyawan": "K1", "id_jenis": "jns-lembur", "tanggal_mulai": tanggal, "tanggal_selesai": tanggal,
                   "alasan": "Opname", "jam_mulai": a, "jam_selesai": b})
        };
        let id_spl = ajukan(lembur("2026-11-03", "17:00", "19:00"));
        setujui(&id_spl);
        assert_eq!(gagal(lembur("2026-11-03", "18:00", "20:00")), pesan_bertumpuk("2026-11-03", "2026-11-03"));
        ajukan(lembur("2026-11-03", "19:00", "20:00"));
        let id_sabtu = ajukan(lembur("2026-11-07", "08:00", "12:00"));
        setujui(&id_sabtu);
        assert_eq!(
            gagal(json!({"id_karyawan": "K1", "id_jenis": "jns-lembur", "tanggal_mulai": "2026-11-03",
                         "tanggal_selesai": "2026-11-04", "alasan": "x", "jam_mulai": "17:00", "jam_selesai": "19:00"})),
            "Lembur diajukan per tanggal kerja."
        );
        let spl = muat_spl(&conn, "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(spl.get(&("K1".into(), "2026-11-03".into())), Some(&120), "SPL Menunggu tidak dihitung");
        assert_eq!(spl.get(&("K1".into(), "2026-11-07".into())), Some(&240));

        // Rekap mode otomatis tidak memotong; mode spl memotong per tanggal.
        conn.execute_batch(
            "INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, status_kehadiran, status_absen, sumber,
               update_terakhir, jam_kerja, lembur, id_shift, bulan, tahun, id_sesi) VALUES
               ('2026-11-03', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 480, 180, 2, 'November', 2026, 's1'),
               ('2026-11-04', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 480, 30, 1, 'November', 2026, 's2'),
               ('2026-11-07', 'K1', 'Ani', 'Gudang', 'Hadir', 'Lengkap', 'Scanner', 'x', 300, 0, 1, 'November', 2026, 's3');",
        )
        .unwrap();
        let (mode, potong) = lembur_spl(&conn, "2026-11-01", "2026-11-30").unwrap();
        assert_eq!((mode.as_str(), potong.is_empty()), ("otomatis", true));
        conn.execute_batch("INSERT INTO setting_gex_system (key, value) VALUES ('hr_lembur_mode', 'spl');").unwrap();
        let (mode, potong) = lembur_spl(&conn, "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(mode, "spl");
        // 11-03: 180 − 120 = 60; 11-04: tanpa SPL 30; Sabtu: 300 jam kerja ≤ 240 SPL → 60 dari jam kerja.
        assert_eq!(potong["K1"], PotongLembur { lembur: 90, libur_total: 60, libur_jam_kerja: 60, tanpa_spl: 30 });

        let d = daftar(&state, &json!({}), false).expect("daftar");
        let baris = |id: &str| d["pengajuan"].as_array().unwrap().iter().find(|b| b["pengajuan"]["id_pengajuan"] == id).unwrap().clone();
        assert_eq!(baris(&id_tukar)["nama_karyawan_tukar"], "Budi");
        assert_eq!(baris(&id_tukar)["tanda"], json!([]));
        assert_eq!(baris(&id_spl)["menit_lembur"], 120);

        // Cloud: payload outbox apa adanya.
        let outbox: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT domain, entity_key, payload_json FROM desktop_sync_outbox WHERE domain LIKE 'hr-request%' ORDER BY rowid;")
                .unwrap();
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            let hub_dir = tempfile::tempdir().unwrap();
            let hub = hub_dir.path().join("sppg-hub.db");
            let client = TursoClient::local_file(
                url::Url::parse("https://hr-fase3.sppg.invalid").unwrap(),
                &hub,
                reqwest::Client::new(),
            );
            client.ensure_schema().await.expect("skema cloud");
            for (domain, key, payload) in &outbox {
                let payload: Value = serde_json::from_str(payload).unwrap();
                let statements = match domain.as_str() {
                    "hr-request" => cloud_pengajuan_statements(&payload, key),
                    _ => cloud_keputusan_statements(&payload, key),
                }
                .expect("payload sah");
                for (sql, args) in statements {
                    client.query_one(sql, args).await.expect("terapkan");
                }
            }
            let hub = Connection::open(&hub).unwrap();
            assert_eq!(muat_tukar(&hub, "2026-11-03", "2026-11-03").unwrap(), muat_tukar(&conn, "2026-11-03", "2026-11-03").unwrap());
            assert_eq!(muat_spl(&hub, "2026-11-01", "2026-11-30").unwrap(), spl);
            // Bentuk salah: tanpa statement (konflik), tidak pernah diterapkan.
            let cacat = json!({"id_pengajuan": "x", "id_karyawan": "K1", "id_jenis": "jns-lembur", "kelompok": "Lembur",
                               "potong_jatah": 0, "dampak_gaji": "Tidak Berpengaruh", "tanggal_mulai": "2026-11-03",
                               "tanggal_selesai": "2026-11-03", "setengah_hari": 0, "alasan": "x", "sidik": "s",
                               "diajukan_oleh": "hrd", "waktu_perangkat": "2026-11-01 00:00:00"});
            assert!(cloud_pengajuan_statements(&cacat, "x").is_none());
        });
    }

    /// Fase 4 (v39): klaim, nominal disetujui, pembayaran terpisah, kait gaji
    /// mode `gaji`, pemeriksaan PAID, dan handler cloud. Cermin "fase 4" Web.
    #[test]
    fn alur_fase4_reimburse() {
        let (_dir, state) = state_uji();
        let conn = storage::database(&state.data_dir).expect("db");
        conn.execute_batch(
            "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit,
               istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
             VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');
             INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar) VALUES
               ('K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02');",
        )
        .expect("data awal");
        let pengaju = operator("ani", &["hr.request.submit"], Some("K1"));
        let hrd = operator("hrd", &["hr.request.submit", "hr.request.decide"], None);
        let keuangan = operator("keu", &["reimburse.decide"], None);
        let klaim = |nominal: i64| {
            json!({"id_karyawan": "K1", "id_jenis": "jns-rmb-transport", "tanggal_mulai": "2026-01-05",
                   "tanggal_selesai": "2026-01-05", "alasan": "Taksi ke klien", "nominal": nominal})
        };
        let gagal = |op: &OperatorUser, draft: Value| simpan_pengajuan(&state, op, &draft).unwrap_err().message;
        assert_eq!(gagal(&pengaju, klaim(0)), PESAN_NOMINAL);
        let mut besok = klaim(1000);
        besok["tanggal_mulai"] = json!("2999-01-01");
        besok["tanggal_selesai"] = json!("2999-01-01");
        assert_eq!(gagal(&pengaju, besok), "Tanggal biaya tidak boleh setelah hari ini.");
        let id = simpan_pengajuan(&state, &pengaju, &klaim(100_000)).expect("ajukan")["id_pengajuan"]
            .as_str()
            .unwrap()
            .to_owned();
        // Cuti di tanggal yang sama tidak bertumpuk dengan klaim.
        let cuti = json!({"id_karyawan": "K1", "id_jenis": "jns-cuti-tahunan", "tanggal_mulai": "2026-01-05",
                          "tanggal_selesai": "2026-01-05", "alasan": "Mudik"});
        let id_cuti = simpan_pengajuan(&state, &pengaju, &cuti).expect("cuti tidak bertumpuk dengan klaim")["id_pengajuan"]
            .as_str()
            .unwrap()
            .to_owned();

        let putus = |op: &OperatorUser, d: Value| putuskan(&state, op, &d);
        assert_eq!(
            putus(&hrd, json!({"id_pengajuan": id, "aksi": "Setujui", "nominal_disetujui": 100_000})).unwrap_err().message,
            PESAN_IZIN_PUTUS
        );
        assert_eq!(
            putus(&keuangan, json!({"id_pengajuan": id, "aksi": "Setujui", "nominal_disetujui": 75_000})).unwrap_err().message,
            "Alasan wajib diisi bila nominal disetujui lebih kecil dari yang diajukan."
        );
        putus(&keuangan, json!({"id_pengajuan": id, "aksi": "Setujui", "nominal_disetujui": 75_000, "alasan": "Tarif wajar"}))
            .expect("setujui");

        let d = daftar(&state, &json!({}), true).expect("daftar keuangan");
        assert_eq!(d["pengajuan"].as_array().unwrap().len(), 1, "keuangan tidak melihat cuti");
        assert_eq!(d["pengajuan"][0]["nominal_berlaku"], 75_000);
        assert_eq!(d["pengajuan"][0]["status_bayar"], STATUS_BELUM_DIBAYAR);
        assert_eq!(d["mode_reimburse"], "terpisah");
        assert_eq!(rincian(&state, &id_cuti, true).unwrap_err().code, "DESKTOP_ACCESS_DENIED");
        assert!(rincian(&state, &id, true).is_ok());

        // Mode `terpisah`: gaji tidak berubah. Mode `gaji`: klaim ikut rekap.
        assert!(reimburse_gaji(&conn, "2026-01-31").unwrap().is_empty());
        simpan_aturan(&state, &json!({"hr_cuti_periode": "ulang_tahun_kerja", "hr_cuti_sisa": "hangus", "hr_cuti_hak": 12,
            "hr_cuti_syarat_bulan": 12, "hr_cuti_prorata": 0, "hr_cuti_bawa_maks": 6, "hr_cuti_bawa_bulan": 3,
            "hr_lembur_mode": "otomatis", "hr_lembur_maks_harian": 4, "hr_lembur_maks_mingguan": 18,
            "hr_reimburse_bayar": "gaji"}))
        .expect("aturan");
        assert!(reimburse_gaji(&conn, "2026-01-04").unwrap().is_empty(), "tanggal biaya sesudah akhir periode");
        assert_eq!(reimburse_gaji(&conn, "2026-01-31").unwrap()["K1"], vec![(id.clone(), 75_000)]);

        // PAID: nominal di proses gaji harus sama dengan nominal berlaku.
        assert!(periksa_reimburse_run(&conn, "run-1", &[(id.clone(), 75_000)]).is_ok());
        assert!(periksa_reimburse_run(&conn, "run-1", &[(id.clone(), 70_000)]).unwrap_err().message.contains("berubah"));

        // Pembayaran terpisah, lalu klaim tidak bisa dibayar atau dibatalkan lagi.
        let bayar = catat_bayar_reimburse(&state, "keu", &json!({"id_karyawan": "K1", "id_klaim": [id]})).expect("bayar");
        assert_eq!(bayar["total"], 75_000);
        assert!(catat_bayar_reimburse(&state, "keu", &json!({"id_karyawan": "K1", "id_klaim": [id]}))
            .unwrap_err()
            .message
            .contains("dibayar"));
        assert!(reimburse_gaji(&conn, "2026-01-31").unwrap().is_empty(), "sudah dibayar terpisah");
        assert!(periksa_reimburse_run(&conn, "run-1", &[(id.clone(), 75_000)]).unwrap_err().message.contains("sudah dibayar"));
        assert_eq!(
            putus(&keuangan, json!({"id_pengajuan": id, "aksi": "Batal", "alasan": "Salah"})).unwrap_err().message,
            PESAN_KLAIM_DIBAYAR
        );
        let id_bayar = bayar["id_bayar"].as_str().unwrap().to_owned();
        batal_bayar_reimburse(&state, "keu", &json!({"id_bayar": id_bayar, "alasan": "Salah karyawan"})).expect("batal bayar");
        assert_eq!(
            batal_bayar_reimburse(&state, "keu", &json!({"id_bayar": id_bayar, "alasan": "x"})).unwrap_err().message,
            "Pembayaran ini sudah dibatalkan."
        );
        let r = ringkasan_reimburse(&state, "2000-01-01", "2999-12-31").expect("ringkasan");
        assert_eq!(r["belum_dibayar"].as_array().unwrap().len(), 1);
        assert_eq!(r["riwayat"][0]["batal"]["id_bayar"], format!("batal-{id_bayar}"));

        // Cloud: payload outbox apa adanya.
        let outbox: Vec<(String, String, String)> = {
            let mut st = conn
                .prepare("SELECT domain, entity_key, payload_json FROM desktop_sync_outbox WHERE domain LIKE 'hr-%' ORDER BY rowid;")
                .unwrap();
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            rows.collect::<Result<_, _>>().unwrap()
        };
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            let hub_dir = tempfile::tempdir().unwrap();
            let hub = hub_dir.path().join("sppg-hub.db");
            let client = TursoClient::local_file(
                url::Url::parse("https://hr-fase4.sppg.invalid").unwrap(),
                &hub,
                reqwest::Client::new(),
            );
            client.ensure_schema().await.expect("skema cloud");
            for (domain, key, payload) in &outbox {
                let payload: Value = serde_json::from_str(payload).unwrap();
                let statements = match domain.as_str() {
                    "hr-request" => cloud_pengajuan_statements(&payload, key),
                    "hr-request-decision" => cloud_keputusan_statements(&payload, key),
                    _ => cloud_bayar_reimburse_statements(&payload, key),
                }
                .expect("payload sah");
                for (sql, args) in statements {
                    client.query_one(sql, args).await.expect("terapkan");
                }
            }
            let hub = Connection::open(&hub).unwrap();
            assert_eq!(muat_klaim(&hub, "9999-12-31").unwrap(), muat_klaim(&conn, "9999-12-31").unwrap());
            assert_eq!(muat_bayar(&hub).unwrap(), muat_bayar(&conn).unwrap());
            let jenis: i64 = hub
                .query_row("SELECT COUNT(*) FROM hr_jenis_pengajuan WHERE kelompok = 'Reimburse' AND izin_pemutus = 'reimburse.decide';", [], |r| r.get(0))
                .unwrap();
            assert_eq!(jenis, 5);
            // Kunci `batas_bulanan` absen (perangkat v38) = batas lama dipertahankan.
            hub.execute("UPDATE hr_jenis_pengajuan SET batas_bulanan = 500000 WHERE id_jenis = 'jns-rmb-makan';", []).unwrap();
            let lama = json!({"id_jenis": "jns-rmb-makan", "nama": "Reimburse Makan", "kelompok": "Reimburse",
                              "izin_pemutus": "reimburse.decide", "boleh_urgent": 0, "potong_jatah": 0,
                              "dampak_gaji": "Tidak Berpengaruh", "satuan_maks": "Hari Kerja", "wajib_dokumen": 1, "is_aktif": 1});
            for (sql, args) in cloud_jenis_statements(&lama, "jns-rmb-makan").unwrap() {
                client.query_one(sql, args).await.unwrap();
            }
            let batas: Option<i64> = hub
                .query_row("SELECT batas_bulanan FROM hr_jenis_pengajuan WHERE id_jenis = 'jns-rmb-makan';", [], |r| r.get(0))
                .unwrap();
            assert_eq!(batas, Some(500_000));
            // Bentuk salah: tanpa statement (konflik).
            assert!(cloud_bayar_reimburse_statements(&json!({"bayar": {"id_bayar": "x", "jenis": "Bayar", "id_karyawan": "K1",
                "tanggal": "2026-01-05", "total": 1, "dicatat_oleh": "keu"}, "baris": []}), "x").is_none());
        });
    }

    #[test]
    fn jatah_dan_penyesuaian() {
        let (_dir, state) = state_uji();
        let conn = storage::database(&state.data_dir).expect("db");
        conn.execute_batch(
            "INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit,
               istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
             VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');
             INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar)
             VALUES ('K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02');
             INSERT INTO setting_gex_system (key, value) VALUES ('hr_cuti_periode', 'kalender');",
        )
        .unwrap();
        let hrd = operator("hrd", &["hr.request.submit", "hr.request.decide"], None);
        let cuti = json!({"id_karyawan": "K1", "id_jenis": "jns-cuti-tahunan", "tanggal_mulai": "2026-03-02",
                          "tanggal_selesai": "2026-03-04", "alasan": "Mudik"});
        let id = simpan_pengajuan(&state, &hrd, &cuti).unwrap()["id_pengajuan"].as_str().unwrap().to_owned();
        // Menunggu belum memotong jatah.
        let j = jatah(&state, "K1").unwrap();
        let tahun_ini = j["periode"].as_array().unwrap().iter().find(|p| p["mulai"] == "2026-01-01").unwrap().clone();
        assert_eq!((tahun_ini["terpakai"].as_i64(), tahun_ini["sisa"].as_i64()), (Some(0), Some(12)));
        // Pengaju yang sama boleh memutus (Q-28), ditandai.
        putuskan(&state, &hrd, &json!({"id_pengajuan": id, "aksi": "Setujui"})).unwrap();
        let d = daftar(&state, &json!({"id_karyawan": "K1"}), false).unwrap();
        assert_eq!(d["pengajuan"][0]["tanda"], json!(["diputus_sendiri"]));
        simpan_penyesuaian(&state, "hrd", &json!({"id_karyawan": "K1", "periode": "2026-01-01", "jenis": "Saldo Awal",
                                                 "hari": -4, "alasan": "Dipakai sebelum aplikasi"})).unwrap();
        assert_eq!(
            simpan_penyesuaian(&state, "hrd", &json!({"id_karyawan": "K1", "periode": "2026-02-01", "jenis": "Koreksi",
                                                     "hari": 1, "alasan": "x"})).unwrap_err().message,
            "Periode itu bukan periode cuti karyawan ini."
        );
        let j = jatah(&state, "K1").unwrap();
        let p = j["periode"].as_array().unwrap().iter().find(|p| p["mulai"] == "2026-01-01").unwrap().clone();
        assert_eq!((p["terpakai"].as_i64(), p["penyesuaian"].as_i64(), p["sisa"].as_i64()), (Some(3), Some(-4), Some(5)));
        let id_adj = j["penyesuaian"][0]["baris"]["id_penyesuaian"].as_str().unwrap().to_owned();
        batal_penyesuaian(&state, "hrd", &json!({"id_penyesuaian": id_adj, "alasan": "Salah"})).unwrap();
        let p = jatah(&state, "K1").unwrap()["periode"].as_array().unwrap().iter().find(|p| p["mulai"] == "2026-01-01").unwrap().clone();
        assert_eq!(p["sisa"].as_i64(), Some(9));
        // Diuangkan hanya untuk mode diuangkan dan periode yang sudah berakhir.
        assert_eq!(
            proses_akhir_periode(&state, "hrd", &json!({"id_karyawan": "K1", "periode": "2025-01-02"})).unwrap_err().message,
            "Sisa cuti tidak diatur untuk diuangkan."
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kep(id: &str, jenis: &str, sidik: &str, oleh: &str, waktu: &str, cloud: Option<&str>) -> Keputusan {
        Keputusan {
            id_keputusan: id.into(),
            jenis: jenis.into(),
            sidik: sidik.into(),
            oleh: oleh.into(),
            waktu_perangkat: waktu.into(),
            diterima_cloud: cloud.map(str::to_owned),
            nominal_disetujui: None,
        }
    }

    // Vektor yang sama dengan `hr-pengajuan.test.ts`.
    #[test]
    fn sidik_vektor() {
        let isi = IsiPengajuan {
            id_karyawan: "K1",
            id_jenis: "jns-sakit",
            kelompok: "Sakit",
            potong_jatah: false,
            dampak_gaji: "Dibayar",
            tanggal_mulai: "2026-11-02",
            tanggal_selesai: "2026-11-03",
            setengah_hari: false,
            alasan: "Demam",
            jam_mulai: None,
            jam_selesai: None,
            id_karyawan_tukar: None,
            id_shift_asal: None,
            id_shift_tukar: None,
            nominal: None,
        };
        let kanonik = "K1\u{1f}jns-sakit\u{1f}Sakit\u{1f}0\u{1f}Dibayar\u{1f}2026-11-02\u{1f}2026-11-03\u{1f}0\u{1f}Demam";
        assert_eq!(sidik_pengajuan(&isi), hex::encode(Sha256::digest(kanonik.as_bytes())));
        assert_eq!(sidik_pengajuan(&isi).len(), 64);
    }

    #[test]
    fn status_dan_tanda_vektor() {
        // Menunggu
        assert_eq!(status_pengajuan("s1", &[]), "Menunggu");
        // Keputusan bersidik lama gugur.
        let gugur = [kep("a", "Setujui", "lama", "hrd", "2026-11-01 01:00:00", Some("2026-11-01 01:00:05"))];
        assert_eq!(status_pengajuan("s1", &gugur), "Menunggu");
        assert_eq!(tanda_keputusan("s1", "atasan", &gugur), vec!["keputusan_gugur"]);
        // Cloud lebih dulu menang atas yang masih tertunda, walau jam perangkatnya lebih awal.
        let ganda = [
            kep("b", "Tolak", "s1", "hrd2", "2026-11-01 00:00:00", None),
            kep("a", "Setujui", "s1", "hrd1", "2026-11-01 02:00:00", Some("2026-11-01 02:00:01")),
        ];
        assert_eq!(status_pengajuan("s1", &ganda), "Disetujui");
        assert_eq!(tanda_keputusan("s1", "atasan", &ganda), vec!["keputusan_ganda"]);
        // Urgent belum diketahui, diputus orang yang sama dengan pengaju.
        let urgent = [kep("urgent-p", "Setujui Urgent", "s1", "Atasan", "2026-11-01 00:00:00", None)];
        assert_eq!(status_pengajuan("s1", &urgent), "Disetujui (urgent)");
        assert_eq!(tanda_keputusan("s1", "atasan ", &urgent), vec!["perlu_diketahui"]);
        let sendiri = [kep("c", "Tolak", "s1", "HRD", "2026-11-01 00:00:00", None)];
        assert_eq!(tanda_keputusan("s1", "hrd", &sendiri), vec!["diputus_sendiri"]);
        let diketahui = [
            urgent[0].clone(),
            kep("tahu-p", "Diketahui", "s1", "hrd", "2026-11-01 03:00:00", None),
        ];
        assert_eq!(tanda_keputusan("s1", "hrd", &diketahui), Vec::<&str>::new());
        // Batal menang atas segalanya.
        let batal = [urgent[0].clone(), kep("batal-p", "Batal", "s1", "hrd", "2026-11-02 00:00:00", None)];
        assert_eq!(status_pengajuan("s1", &batal), "Dibatalkan");
        assert_eq!(tanda_keputusan("s1", "Atasan", &batal), Vec::<&str>::new());
    }

    #[test]
    fn aksi_vektor() {
        let k = |status: &str| KeadaanAksi {
            status: status.into(),
            boleh_putus: true,
            ..Default::default()
        };
        assert_eq!(periksa_aksi("Hapus", "", None, &k("Menunggu")).unwrap_err(), "Keputusan tidak dikenal.");
        assert!(periksa_aksi("Setujui", "", None, &k("Menunggu")).is_ok());
        assert_eq!(periksa_aksi("Tolak", " ", None, &k("Menunggu")).unwrap_err(), "Alasan penolakan wajib diisi.");
        assert_eq!(
            periksa_aksi("Setujui", "", None, &k("Disetujui")).unwrap_err(),
            "Pengajuan ini tidak lagi menunggu keputusan."
        );
        let mut tanpa_izin = k("Menunggu");
        tanpa_izin.boleh_putus = false;
        assert_eq!(periksa_aksi("Setujui", "", None, &tanpa_izin).unwrap_err(), PESAN_IZIN_PUTUS);
        let mut sendiri = k("Menunggu");
        sendiri.karyawan_sendiri = true;
        sendiri.superadmin = true;
        assert_eq!(periksa_aksi("Setujui", "", None, &sendiri).unwrap_err(), PESAN_DIRI_SENDIRI);
        assert_eq!(
            periksa_aksi("Diketahui", "", None, &k("Disetujui")).unwrap_err(),
            "Hanya pengajuan urgent yang belum diketahui yang bisa ditandai."
        );
        assert!(periksa_aksi("Diketahui", "", None, &k("Disetujui (urgent)")).is_ok());
        assert_eq!(periksa_aksi("Batal", "", None, &k("Menunggu")).unwrap_err(), "Alasan pembatalan wajib diisi.");
        assert_eq!(
            periksa_aksi("Batal", "Salah", None, &k("Menunggu")).unwrap_err(),
            "Hanya pengaju yang bisa membatalkan pengajuan yang masih menunggu."
        );
        let mut pengaju = k("Menunggu");
        pengaju.pengaju_sendiri = true;
        pengaju.boleh_putus = false;
        assert!(periksa_aksi("Batal", "Salah", None, &pengaju).is_ok());
        assert!(periksa_aksi("Batal", "Ternyata masuk", None, &k("Disetujui (urgent)")).is_ok());
        assert_eq!(
            periksa_aksi("Batal", "x", None, &k("Ditolak")).unwrap_err(),
            "Pengajuan yang ditolak atau dibatalkan tidak bisa dibatalkan lagi."
        );
        assert_eq!(
            periksa_aksi("Setujui", &"a".repeat(501), None, &k("Menunggu")).unwrap_err(),
            "Alasan maksimal 500 karakter."
        );
        assert_eq!(periksa_sunting("Disetujui", true, false).unwrap_err(), "Pengajuan yang sudah diputus tidak bisa disunting.");
        assert_eq!(periksa_sunting("Menunggu", false, false).unwrap_err(), "Hanya pengaju yang bisa menyunting pengajuan ini.");
        assert!(periksa_sunting("Menunggu", false, true).is_ok());
        assert!(periksa_urgent(true).is_err());
    }

    #[test]
    fn isian_vektor() {
        let dasar = json!({"id_karyawan": "K1", "id_jenis": "jns-izin-dibayar", "tanggal_mulai": "2026-11-02",
                           "tanggal_selesai": "2026-11-02", "setengah_hari": true, "alasan": "  Urusan bank  "});
        let sah = validasi_pengajuan(&dasar).unwrap();
        assert_eq!(sah.alasan, "Urusan bank");
        assert!(sah.setengah_hari && !sah.urgent);
        let salah = |ubah: Value| {
            let mut d = dasar.clone();
            for (k, v) in ubah.as_object().unwrap() {
                d[k] = v.clone();
            }
            validasi_pengajuan(&d).unwrap_err()
        };
        assert_eq!(salah(json!({"id_karyawan": ""})), "Pilih karyawan.");
        assert_eq!(salah(json!({"id_jenis": " "})), "Pilih jenis pengajuan.");
        assert_eq!(salah(json!({"tanggal_mulai": "2026-02-30"})), "Tanggal pengajuan tidak valid.");
        assert_eq!(
            salah(json!({"tanggal_mulai": "2026-11-03", "setengah_hari": false})),
            "Tanggal selesai tidak boleh sebelum tanggal mulai."
        );
        assert_eq!(
            salah(json!({"tanggal_mulai": "2025-11-01", "setengah_hari": false})),
            "Rentang pengajuan paling panjang 366 hari."
        );
        assert_eq!(salah(json!({"tanggal_selesai": "2026-11-03"})), "Setengah hari hanya untuk satu tanggal.");
        assert_eq!(salah(json!({"alasan": ""})), "Alasan wajib diisi.");

        let jenis = JenisPengajuan {
            id_jenis: "jns-cuti-menikah".into(),
            nama: "Cuti Menikah".into(),
            kelompok: "Cuti".into(),
            izin_pemutus: IZIN_PEMUTUS_AKTIF.into(),
            boleh_urgent: false,
            potong_jatah: false,
            dampak_gaji: "Dibayar".into(),
            maks_hari: Some(3),
            satuan_maks: "Hari Kerja".into(),
            wajib_dokumen: false,
            is_aktif: true,
            batas_bulanan: None,
        };
        assert_eq!(periksa_jenis(&sah, &jenis).unwrap_err(), "Setengah hari hanya untuk kelompok Izin.");
        let mut urgent = sah.clone();
        urgent.setengah_hari = false;
        urgent.urgent = true;
        assert_eq!(periksa_jenis(&urgent, &jenis).unwrap_err(), "Jenis pengajuan ini tidak boleh urgent.");
        assert!(periksa_maks(&jenis, 3, 5).is_ok());
        assert_eq!(periksa_maks(&jenis, 4, 4).unwrap_err(), "Cuti Menikah paling lama 3 hari kerja.");
        let mut kalender = jenis.clone();
        kalender.satuan_maks = "Hari Kalender".into();
        assert_eq!(periksa_maks(&kalender, 2, 4).unwrap_err(), "Cuti Menikah paling lama 3 hari kalender.");

        let j = validasi_jenis(&json!({"nama": " Cuti Khusus ", "kelompok": "Cuti", "dampak_gaji": "Dibayar",
                                       "maks_hari": 5, "potong_jatah": 1})).unwrap();
        assert_eq!((j.nama.as_str(), j.maks_hari, j.satuan_maks.as_str(), j.is_aktif), ("Cuti Khusus", Some(5), "Hari Kerja", true));
        assert_eq!(
            validasi_jenis(&json!({"nama": "Klaim", "kelompok": "Bonus", "dampak_gaji": "Dibayar"})).unwrap_err(),
            "Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, Dinas Luar, atau Reimburse."
        );
        assert_eq!(
            validasi_jenis(&json!({"nama": "X", "kelompok": "Izin", "dampak_gaji": "Dibayar", "potong_jatah": true})).unwrap_err(),
            "Hanya kelompok Cuti yang bisa memotong jatah cuti."
        );
        assert_eq!(
            validasi_jenis(&json!({"nama": "X", "kelompok": "Izin", "dampak_gaji": "Dibayar", "maks_hari": 0})).unwrap_err(),
            "Batas hari harus 1 sampai 366."
        );
    }

    #[test]
    fn hari_wajib_dan_cuti_dibayar_vektor() {
        // Senin–Jumat; 2026-11-04 (Rabu) libur, divisi Gudang di-whitelist.
        let jadwal = Jadwal {
            hari_masuk: vec![1, 2, 3, 4, 5],
            divisi: "Kantor".into(),
            kode_shift: Some(1),
            jam_normal_menit: 480,
        };
        let mut kalender = Kalender::default();
        kalender.libur.insert("2026-11-04".into());
        assert_eq!(
            tanggal_wajib(&jadwal, &kalender, "2026-11-01", "2026-11-08"),
            vec!["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]
        );
        kalender.whitelist.push(scanner::HolidayWhitelistEntry {
            id: "1".into(),
            scope_type: "DIVISI".into(),
            scope_value: "Kantor".into(),
            tanggal_libur: None,
            status_aktif: 1,
        });
        assert_eq!(tanggal_wajib(&jadwal, &kalender, "2026-11-04", "2026-11-04"), vec!["2026-11-04"]);

        let hadir: HashSet<String> = ["2026-11-03".to_owned(), "2026-11-05".to_owned()].into();
        let tanggal = vec![
            ("2026-11-02".to_owned(), false),
            ("2026-11-03".to_owned(), false),
            ("2026-11-05".to_owned(), true),
            ("2026-11-06".to_owned(), true),
            ("2026-11-06".to_owned(), false),
        ];
        // 02 penuh: +1 hari +480; 03 penuh tapi hadir: 0; 05 setengah hadir: +240;
        // 06 setengah + penuh = penuh: +1 hari +480.
        assert_eq!(hitung_cuti_dibayar(&tanggal, &hadir, 480), (2, 1200));
        assert_eq!(hitung_cuti_dibayar(&[("2026-11-09".into(), true)], &HashSet::new(), 481), (1, 240));
        assert_eq!(upah_harian("FLAT_DAILY", 150_000, 0, 480), 150_000);
        assert_eq!(upah_harian("HOURLY", 0, 25_001, 450), 187_508);
    }

    #[test]
    fn isian_penyesuaian_vektor() {
        let dasar = json!({"id_karyawan": "K1", "periode": "2026-01-01", "jenis": "Saldo Awal",
                           "hari": -4, "alasan": "Dipakai sebelum aplikasi"});
        assert!(validasi_penyesuaian(&dasar).is_ok());
        let salah = |kunci: &str, nilai: Value| {
            let mut d = dasar.clone();
            d[kunci] = nilai;
            validasi_penyesuaian(&d).unwrap_err()
        };
        assert_eq!(salah("hari", json!(0)), "Jumlah hari harus bilangan bulat selain 0, paling banyak 366.");
        assert_eq!(salah("jenis", json!("Diuangkan")), "Jenis penyesuaian harus Saldo Awal atau Koreksi.");
        assert_eq!(salah("periode", json!("x")), "Periode tidak valid.");
    }

    #[test]
    fn aturan_cuti_vektor() {
        let peta: HashMap<String, String> = [
            (KUNCI_CUTI_PERIODE, "kalender"),
            (KUNCI_CUTI_HAK, "61"),
            (KUNCI_CUTI_SISA, "dibawa"),
            (KUNCI_CUTI_BAWA_BULAN, " 2 "),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let a = AturanCuti::dari_peta(&peta);
        assert_eq!((a.periode.as_str(), a.hak, a.sisa.as_str(), a.bawa_bulan), ("kalender", 12, "dibawa", 2));
        let sah = validasi_aturan_cuti(&json!({"hr_cuti_periode": "kalender", "hr_cuti_sisa": "hangus", "hr_cuti_hak": 12,
            "hr_cuti_syarat_bulan": 12, "hr_cuti_prorata": 1, "hr_cuti_bawa_maks": 6, "hr_cuti_bawa_bulan": 3})).unwrap();
        assert_eq!(sah.len(), 7);
        assert_eq!(
            validasi_aturan_cuti(&json!({"hr_cuti_periode": "kalender", "hr_cuti_sisa": "hangus", "hr_cuti_hak": 12,
                "hr_cuti_syarat_bulan": 12, "hr_cuti_prorata": 1, "hr_cuti_bawa_maks": 6, "hr_cuti_bawa_bulan": 0})).unwrap_err(),
            "Batas pakai sisa dibawa harus 1 sampai 12."
        );
        assert_eq!(
            validasi_aturan_cuti(&json!({"hr_cuti_periode": "bulanan"})).unwrap_err(),
            "Periode cuti harus kalender atau ulang tahun kerja."
        );
    }

    #[test]
    fn jatah_ulang_tahun_kerja_dengan_bawaan() {
        let aturan = AturanCuti { sisa: "dibawa".into(), ..Default::default() };
        let terpakai: Vec<String> = ["2025-02-10", "2026-03-16", "2026-03-17", "2026-03-18", "2026-06-20"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let adj = vec![("2025-03-15".to_owned(), -2)];
        let p = periode_cuti(Some("2024-03-15"), &aturan, &terpakai, &adj, "2026-11-10");
        // Pemakaian sebelum berhak (2025-02-10) tampil di periode hak 0.
        assert_eq!((p[0].mulai.as_str(), p[0].selesai.as_str(), p[0].sebelum_berhak, p[0].sisa), ("2024-03-15", "2025-03-14", true, -1));
        // Periode 1: hak 12 − 2 koreksi = sisa 10, tidak membawa dari periode sebelum berhak.
        assert_eq!((p[1].mulai.as_str(), p[1].bawaan, p[1].penyesuaian, p[1].sisa), ("2025-03-15", 0, -2, 10));
        // Periode 2: bawaan min(10, 6) = 6, berlaku sampai 2026-06-14; 3 hari dipakai
        // di tiga bulan pertama, sisa bawaan 3 hangus; total pakai 4.
        // 12 + 6 − 3 − 4 = 11.
        assert_eq!(
            (p[2].mulai.as_str(), p[2].bawaan, p[2].bawaan_hangus, p[2].bawaan_sampai.as_deref(), p[2].terpakai, p[2].sisa),
            ("2026-03-15", 6, 3, Some("2026-06-14"), 4, 11)
        );
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn jatah_kalender_prorata() {
        let aturan = AturanCuti { periode: "kalender".into(), prorata: true, ..Default::default() };
        let p = periode_cuti(Some("2025-04-20"), &aturan, &["2026-05-04".into()], &[], "2026-11-10");
        // Berhak 2026-04-20: bulan penuh tersisa Mei–Des = 8 → ⌊12 × 8 / 12⌋ = 8.
        assert_eq!((p[0].mulai.as_str(), p[0].selesai.as_str(), p[0].hak, p[0].sisa), ("2026-04-20", "2026-12-31", 8, 7));
        assert_eq!(p.len(), 1);
        let tanpa = AturanCuti { periode: "kalender".into(), ..Default::default() };
        let q = periode_cuti(Some("2025-04-01"), &tanpa, &[], &[], "2027-01-05");
        assert_eq!(
            q.iter().map(|x| (x.mulai.as_str(), x.hak)).collect::<Vec<_>>(),
            vec![("2026-04-01", 12), ("2027-01-01", 12)]
        );
        assert!(periode_cuti(None, &tanpa, &[], &[], "2027-01-05").is_empty());
    }

    // ── Fase 3 (v38), vektor yang sama dengan `hr-pengajuan.test.ts` ───────

    #[test]
    fn fase3_durasi_lembur_dan_sidik() {
        assert_eq!(durasi_lembur("17:00", "19:30"), Ok(150));
        assert_eq!(durasi_lembur("22:00", "02:00"), Ok(240));
        assert_eq!(durasi_lembur("17:00", "17:00").unwrap_err(), "Jam mulai dan selesai lembur tidak boleh sama.");
        assert_eq!(durasi_lembur("7:00", "09:00").unwrap_err(), "Jam lembur harus berformat JJ:MM.");
        assert_eq!(durasi_lembur("24:00", "01:00").unwrap_err(), "Jam lembur harus berformat JJ:MM.");
        let isi = |kelompok: &'static str| IsiPengajuan {
            id_karyawan: "K1",
            id_jenis: "jns-x",
            kelompok,
            potong_jatah: false,
            dampak_gaji: "Tidak Berpengaruh",
            tanggal_mulai: "2026-11-02",
            tanggal_selesai: "2026-11-02",
            setengah_hari: false,
            alasan: "Opname",
            jam_mulai: Some("17:00"),
            jam_selesai: Some("19:00"),
            id_karyawan_tukar: Some("K2"),
            id_shift_asal: Some(1),
            id_shift_tukar: Some(2),
            nominal: None,
        };
        let awal = |k: &str| format!("K1\u{1f}jns-x\u{1f}{k}\u{1f}0\u{1f}Tidak Berpengaruh\u{1f}2026-11-02\u{1f}2026-11-02\u{1f}0\u{1f}Opname");
        let hash = |t: String| hex::encode(Sha256::digest(t.as_bytes()));
        assert_eq!(sidik_pengajuan(&isi("Lembur")), hash(format!("{}\u{1f}17:00\u{1f}19:00", awal("Lembur"))));
        assert_eq!(sidik_pengajuan(&isi("Tukar Shift")), hash(format!("{}\u{1f}K2\u{1f}1\u{1f}2", awal("Tukar Shift"))));
        assert_eq!(sidik_pengajuan(&isi("Dinas Luar")), hash(awal("Dinas Luar")));
    }

    #[test]
    fn fase3_bentrok_pengajuan() {
        let r = |kelompok: &'static str, id: &'static str, mulai: &'static str, selesai: &'static str| Ringkas {
            kelompok,
            id_karyawan: id,
            id_karyawan_tukar: None,
            tanggal_mulai: mulai,
            tanggal_selesai: selesai,
            setengah_hari: false,
            jam_mulai: None,
            jam_selesai: None,
        };
        let t = "2026-11-02";
        let lembur = |id: &'static str, a: &'static str, b: &'static str| Ringkas {
            jam_mulai: Some(a),
            jam_selesai: Some(b),
            ..r("Lembur", id, t, t)
        };
        let l1 = lembur("K1", "17:00", "19:00");
        assert!(bentrok_pengajuan(&l1, &lembur("K1", "18:30", "20:00")));
        assert!(!bentrok_pengajuan(&l1, &lembur("K1", "19:00", "21:00")));
        assert!(!bentrok_pengajuan(&l1, &lembur("K2", "17:00", "19:00")));
        assert!(bentrok_pengajuan(&l1, &r("Cuti", "K1", "2026-11-01", "2026-11-03")));
        assert!(!bentrok_pengajuan(&l1, &Ringkas { setengah_hari: true, ..r("Izin", "K1", t, t) }));
        let tukar = Ringkas { id_karyawan_tukar: Some("K1"), ..r("Tukar Shift", "K2", t, t) };
        assert!(!bentrok_pengajuan(&l1, &tukar));
        assert!(bentrok_pengajuan(&tukar, &r("Cuti", "K1", t, t)));
        assert!(!bentrok_pengajuan(&tukar, &r("Dinas Luar", "K3", t, t)));
        assert!(bentrok_pengajuan(&tukar, &Ringkas { id_karyawan_tukar: Some("K2"), ..r("Tukar Shift", "K3", t, t) }));
        assert!(!bentrok_pengajuan(&tukar, &Ringkas { id_karyawan_tukar: Some("K4"), ..r("Tukar Shift", "K3", t, t) }));
        assert!(!bentrok_pengajuan(&r("Cuti", "K1", t, t), &r("Cuti", "K2", t, t)));
        assert!(bentrok_pengajuan(&r("Dinas Luar", "K1", t, t), &r("Sakit", "K1", t, "2026-11-04")));
    }

    #[test]
    fn fase3_batas_lembur_dan_potongan_spl() {
        assert_eq!(senin_dari("2026-11-08").as_deref(), Some("2026-11-02"));
        assert_eq!(senin_dari("2026-11-09").as_deref(), Some("2026-11-09"));
        let spl: Vec<(String, i64)> = [
            ("2026-11-02", 180),
            ("2026-11-02", 90),
            ("2026-11-03", 60),
            ("2026-11-09", 240),
            ("2026-11-10", 240),
            ("2026-11-11", 200),
        ]
        .iter()
        .map(|(t, m)| ((*t).to_owned(), *m))
        .collect();
        let mut lewat: Vec<String> = lembur_lewat_batas(&spl, 240, 600).into_iter().collect();
        lewat.sort();
        assert_eq!(lewat, vec!["2026-11-02", "2026-11-09", "2026-11-10", "2026-11-11"]);
        let h = |lembur, libur_total, libur_jam_kerja, spl| HariLembur { lembur, libur_total, libur_jam_kerja, spl };
        assert_eq!(
            potong_lembur_spl(&[h(120, 0, 0, 90), h(60, 0, 0, 0), h(0, 600, 480, 0), h(0, 600, 480, 300), h(30, 0, 0, 120)]),
            PotongLembur { lembur: 90, libur_total: 900, libur_jam_kerja: 660, tanpa_spl: 660 }
        );
    }

    #[test]
    fn fase3_jenis_isian_dan_aturan_lembur() {
        let jenis = validasi_jenis(&json!({"nama": "Lembur Gudang", "kelompok": "Lembur", "dampak_gaji": "Dibayar", "maks_hari": 5})).unwrap();
        assert_eq!((jenis.dampak_gaji.as_str(), jenis.maks_hari), ("Tidak Berpengaruh", None));
        let j = |kelompok: &str| JenisPengajuan {
            id_jenis: "j".into(),
            nama: "J".into(),
            kelompok: kelompok.into(),
            izin_pemutus: "hr.request.decide".into(),
            boleh_urgent: true,
            potong_jatah: false,
            dampak_gaji: "Tidak Berpengaruh".into(),
            maks_hari: None,
            satuan_maks: "Hari Kerja".into(),
            wajib_dokumen: false,
            is_aktif: true,
            batas_bulanan: None,
        };
        let isian = |lain: Value| {
            let mut d = json!({"id_karyawan": "K1", "id_jenis": "j", "tanggal_mulai": "2026-11-02", "tanggal_selesai": "2026-11-02", "alasan": "x"});
            for (k, v) in lain.as_object().unwrap() {
                d[k] = v.clone();
            }
            validasi_pengajuan(&d).unwrap()
        };
        assert_eq!(
            periksa_jenis(&isian(json!({"tanggal_selesai": "2026-11-03", "jam_mulai": "17:00", "jam_selesai": "18:00"})), &j("Lembur")).unwrap_err(),
            "Lembur diajukan per tanggal kerja."
        );
        assert_eq!(periksa_jenis(&isian(json!({"jam_mulai": "17:00"})), &j("Lembur")).unwrap_err(), "Jam lembur harus berformat JJ:MM.");
        assert!(periksa_jenis(&isian(json!({"jam_mulai": "17:00", "jam_selesai": "18:00"})), &j("Lembur")).is_ok());
        assert_eq!(periksa_jenis(&isian(json!({})), &j("Tukar Shift")).unwrap_err(), "Pilih karyawan yang diajak bertukar.");
        assert_eq!(periksa_jenis(&isian(json!({"id_karyawan_tukar": "K1"})), &j("Tukar Shift")).unwrap_err(), "Tukar shift harus dengan karyawan lain.");
        assert_eq!(
            periksa_jenis(&isian(json!({"id_karyawan_tukar": "K2", "tanggal_selesai": "2026-11-03"})), &j("Tukar Shift")).unwrap_err(),
            "Tukar shift diajukan per tanggal."
        );
        assert!(periksa_jenis(&isian(json!({"id_karyawan_tukar": "K2"})), &j("Tukar Shift")).is_ok());

        assert_eq!(
            AturanLembur::dari_peta(&HashMap::new()),
            AturanLembur { mode: "otomatis".into(), maks_harian: 4, maks_mingguan: 18 }
        );
        let peta: HashMap<String, String> = [("hr_lembur_mode", "spl"), ("hr_lembur_maks_harian", "13")]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        assert_eq!(AturanLembur::dari_peta(&peta), AturanLembur { mode: "spl".into(), maks_harian: 4, maks_mingguan: 18 });
        assert_eq!(
            validasi_aturan_lembur(&json!({"hr_lembur_mode": "spl", "hr_lembur_maks_harian": 3, "hr_lembur_maks_mingguan": 20})).unwrap(),
            vec![
                ("hr_lembur_mode", "spl".to_owned()),
                ("hr_lembur_maks_harian", "3".to_owned()),
                ("hr_lembur_maks_mingguan", "20".to_owned())
            ]
        );
        assert_eq!(
            validasi_aturan_lembur(&json!({"hr_lembur_mode": "spl", "hr_lembur_maks_harian": 0, "hr_lembur_maks_mingguan": 20})).unwrap_err(),
            "Batas lembur harian harus 1 sampai 12 jam."
        );
        assert_eq!(validasi_aturan_lembur(&json!({"hr_lembur_mode": "x"})).unwrap_err(), "Mode lembur harus otomatis atau SPL.");
    }

    // ── Fase 4 (v39), vektor yang sama dengan `hr-pengajuan.test.ts` ───────

    #[test]
    fn fase4_sidik_bentrok_dan_nominal() {
        let isi = IsiPengajuan {
            id_karyawan: "K1",
            id_jenis: "jns-rmb-transport",
            kelompok: "Reimburse",
            potong_jatah: false,
            dampak_gaji: "Tidak Berpengaruh",
            tanggal_mulai: "2026-01-05",
            tanggal_selesai: "2026-01-05",
            setengah_hari: false,
            alasan: "Taksi",
            jam_mulai: None,
            jam_selesai: None,
            id_karyawan_tukar: None,
            id_shift_asal: None,
            id_shift_tukar: None,
            nominal: Some(150_000),
        };
        let kanonik = "K1\u{1f}jns-rmb-transport\u{1f}Reimburse\u{1f}0\u{1f}Tidak Berpengaruh\u{1f}2026-01-05\u{1f}2026-01-05\u{1f}0\u{1f}Taksi\u{1f}150000";
        assert_eq!(sidik_pengajuan(&isi), hex::encode(Sha256::digest(kanonik.as_bytes())));
        // Nominal hanya ikut sidik Reimburse: sidik kelompok lain tidak berubah.
        let cuti = IsiPengajuan { kelompok: "Cuti", ..isi.clone() };
        assert_eq!(sidik_pengajuan(&cuti), sidik_pengajuan(&IsiPengajuan { nominal: None, ..cuti.clone() }));

        let r = |kelompok: &'static str| Ringkas {
            kelompok,
            id_karyawan: "K1",
            id_karyawan_tukar: None,
            tanggal_mulai: "2026-01-05",
            tanggal_selesai: "2026-01-05",
            setengah_hari: false,
            jam_mulai: None,
            jam_selesai: None,
        };
        assert!(!bentrok_pengajuan(&r("Reimburse"), &r("Cuti")));
        assert!(!bentrok_pengajuan(&r("Lembur"), &r("Reimburse")));
        assert!(!bentrok_pengajuan(&r("Reimburse"), &r("Reimburse")));

        let k = |nominal: Option<i64>| Keputusan { nominal_disetujui: nominal, ..kep("a", "Setujui", "s", "keu", "2026-01-06 00:00:00", None) };
        assert_eq!(nominal_berlaku(100_000, None), 100_000);
        assert_eq!(nominal_berlaku(100_000, Some(&k(Some(60_000)))), 60_000);
        assert_eq!(nominal_berlaku(100_000, Some(&k(None))), 100_000);
    }

    #[test]
    fn fase4_aksi_nominal_disetujui() {
        let k = KeadaanAksi { status: "Menunggu".into(), boleh_putus: true, reimburse: true, nominal: 100_000, ..Default::default() };
        let salah_nominal = "Nominal disetujui harus 1 sampai Rp100.000.";
        assert_eq!(periksa_aksi("Setujui", "", None, &k).unwrap_err(), salah_nominal);
        assert_eq!(periksa_aksi("Setujui", "", Some(0), &k).unwrap_err(), salah_nominal);
        assert_eq!(periksa_aksi("Setujui", "", Some(100_001), &k).unwrap_err(), salah_nominal);
        assert_eq!(
            periksa_aksi("Setujui", " ", Some(60_000), &k).unwrap_err(),
            "Alasan wajib diisi bila nominal disetujui lebih kecil dari yang diajukan."
        );
        assert!(periksa_aksi("Setujui", "Tarif wajar", Some(60_000), &k).is_ok());
        assert!(periksa_aksi("Setujui", "", Some(100_000), &k).is_ok());
        let hanya_setujui = "Nominal disetujui hanya untuk menyetujui reimbursement.";
        assert_eq!(periksa_aksi("Tolak", "Tidak sah", Some(1), &k).unwrap_err(), hanya_setujui);
        let cuti = KeadaanAksi { reimburse: false, ..k.clone() };
        assert_eq!(periksa_aksi("Setujui", "", Some(1), &cuti).unwrap_err(), hanya_setujui);
        assert!(periksa_aksi("Setujui", "", None, &cuti).is_ok());
    }

    fn bayar(id: &str, jenis: &str, id_ref: Option<&str>) -> BayarReimburse {
        BayarReimburse {
            id_bayar: id.into(),
            jenis: jenis.into(),
            id_ref: id_ref.map(str::to_owned),
            id_karyawan: "K1".into(),
            tanggal: "2026-01-10".into(),
            total: 1,
            keterangan: None,
            dicatat_oleh: "keu".into(),
            created_at: "2026-01-10 00:00:00".into(),
        }
    }

    fn baris_bayar(id_bayar: &str, id_klaim: &str) -> BarisReimburse {
        BarisReimburse {
            id_baris: format!("{id_bayar}:{id_klaim}"),
            id_bayar: id_bayar.into(),
            sumber: "Reimburse".into(),
            id_klaim: id_klaim.into(),
            nominal: 1,
        }
    }

    fn gaji(id_run: &str, status: &str, id_klaim: &str, nominal: i64) -> GajiReimburse {
        GajiReimburse { id_run: id_run.into(), status: status.into(), id_klaim: id_klaim.into(), nominal }
    }

    #[test]
    fn fase4_status_bayar_dan_batas() {
        let pembayaran = [bayar("B1", "Bayar", None), bayar("B2", "Bayar", None), bayar("batal-B2", "Pembatalan", Some("B2"))];
        let baris = [baris_bayar("B1", "a"), baris_bayar("B2", "b")];
        let g = [gaji("R1", "PAID", "c", 10), gaji("R2", "DRAFT", "d", 10), gaji("R3", "SUBMITTED", "a", 10)];
        assert_eq!(status_bayar("a", &pembayaran, &baris, &g), STATUS_DIBAYAR);
        assert_eq!(status_bayar("b", &pembayaran, &baris, &g), STATUS_BELUM_DIBAYAR);
        assert_eq!(status_bayar("c", &pembayaran, &baris, &g), STATUS_DIBAYAR);
        assert_eq!(status_bayar("d", &pembayaran, &baris, &g), STATUS_PROSES_GAJI);
        assert_eq!(status_bayar("e", &pembayaran, &baris, &g), STATUS_BELUM_DIBAYAR);
        assert!(dibayar_ganda("a", &pembayaran, &baris, &g));
        assert!(!dibayar_ganda("c", &pembayaran, &baris, &g));
        assert_eq!(bayar_aktif_reimburse("a", &pembayaran, &baris), vec!["B1"]);

        let klaim = [
            ("K1", "J1", "2026-01-05", 300_000),
            ("K1", "J1", "2026-01-20", 250_000),
            ("K1", "J1", "2026-02-01", 100_000),
            ("K2", "J1", "2026-01-05", 500_000),
            ("K1", "J2", "2026-01-05", 999_999),
        ];
        let batas: HashMap<String, i64> = [("J1".to_owned(), 500_000)].into();
        let mut lewat: Vec<String> = lewat_batas(&klaim, &batas).into_iter().collect();
        lewat.sort();
        assert_eq!(lewat, vec!["K1|J1|2026-01"]);
        assert_eq!(kunci_batas("K1", "J1", "2026-01-31"), "K1|J1|2026-01");
    }

    #[test]
    fn fase4_bayar_terpisah_dan_payroll() {
        let hari_ini = "2026-01-15";
        let sah = |d: Value| validasi_bayar_reimburse(&d, hari_ini);
        assert_eq!(sah(json!({"id_klaim": ["a"]})).unwrap_err(), "Pilih karyawan.");
        assert_eq!(sah(json!({"id_karyawan": "K1", "id_klaim": []})).unwrap_err(), "Pilih klaim yang dibayar.");
        assert_eq!(sah(json!({"id_karyawan": "K1", "id_klaim": ["a", "a"]})).unwrap_err(), "Klaim yang sama terpilih dua kali.");
        assert_eq!(
            sah(json!({"id_karyawan": "K1", "id_klaim": ["a"], "tanggal": "2026-01-16"})).unwrap_err(),
            "Tanggal bayar tidak boleh setelah hari ini."
        );
        let v = sah(json!({"id_karyawan": "K1", "id_klaim": ["a", "uang:K1:2025-01-01"], "keterangan": " Transfer "})).unwrap();
        assert_eq!((v.tanggal.as_str(), v.keterangan.as_deref()), ("2026-01-15", Some("Transfer")));

        let klaim_ = |id: &str, karyawan: &str, sumber: &str, nominal: i64| Klaim {
            id_klaim: id.into(),
            sumber: sumber.into(),
            id_karyawan: karyawan.into(),
            tanggal: "2026-01-05".into(),
            nominal,
            keterangan: "x".into(),
        };
        let klaim = [
            klaim_("a", "K1", SUMBER_REIMBURSE, 75_000),
            klaim_("uang:K1:2025-01-01", "K1", SUMBER_UANG, 300_000),
            klaim_("b", "K2", SUMBER_REIMBURSE, 10),
            klaim_("d", "K1", SUMBER_REIMBURSE, 20),
        ];
        let g = [gaji("R2", "DRAFT", "d", 20)];
        let dipilih = periksa_bayar_reimburse(&v, &klaim, &[], &[], &g).unwrap();
        assert_eq!(dipilih.iter().map(|k| k.nominal).sum::<i64>(), 375_000);
        let pilih = |ids: &[&str]| BayarReimburseValid { id_klaim: ids.iter().map(|s| s.to_string()).collect(), ..v.clone() };
        assert_eq!(periksa_bayar_reimburse(&pilih(&["x"]), &klaim, &[], &[], &g).unwrap_err(), "Klaim tidak ditemukan atau belum disetujui.");
        assert_eq!(periksa_bayar_reimburse(&pilih(&["b"]), &klaim, &[], &[], &g).unwrap_err(), "Klaim itu bukan milik karyawan ini.");
        assert_eq!(
            periksa_bayar_reimburse(&pilih(&["d"]), &klaim, &[], &[], &g).unwrap_err(),
            "Klaim tanggal 2026-01-05 berstatus dalam proses gaji."
        );

        let pembayaran = [bayar("B1", "Bayar", None), bayar("batal-B1", "Pembatalan", Some("B1"))];
        assert_eq!(periksa_batal_bayar_reimburse(&pembayaran, "B9").unwrap_err(), "Pembayaran tidak ditemukan.");
        assert_eq!(periksa_batal_bayar_reimburse(&pembayaran, "B1").unwrap_err(), "Pembayaran ini sudah dibatalkan.");
        assert!(periksa_batal_bayar_reimburse(&pembayaran[..1], "B1").is_ok());

        let entri = |id: &str, n: i64| vec![(id.to_owned(), n)];
        let paid = [gaji("R1", "PAID", "a", 75_000)];
        assert!(periksa_reimburse_payroll("R1", &entri("a", 75_000), &klaim, &[], &[], &paid).is_ok());
        assert_eq!(
            periksa_reimburse_payroll("R1", &entri("x", 1), &klaim, &[], &[], &paid).unwrap_err(),
            "Klaim reimbursement x sudah tidak berlaku. Tolak proses gaji ini lalu buat ulang."
        );
        assert_eq!(
            periksa_reimburse_payroll("R1", &entri("uang:K1:2025-01-01", 300_000), &klaim, &[], &[], &paid).unwrap_err(),
            "Klaim reimbursement uang:K1:2025-01-01 sudah tidak berlaku. Tolak proses gaji ini lalu buat ulang."
        );
        assert_eq!(
            periksa_reimburse_payroll("R1", &entri("a", 70_000), &klaim, &[], &[], &paid).unwrap_err(),
            "Nominal klaim reimbursement tanggal 2026-01-05 berubah. Tolak proses gaji ini lalu buat ulang."
        );
        assert_eq!(
            periksa_reimburse_payroll("R9", &entri("a", 75_000), &klaim, &[], &[], &paid).unwrap_err(),
            "Klaim reimbursement tanggal 2026-01-05 sudah dibayar. Tolak proses gaji ini lalu buat ulang."
        );
    }

    #[test]
    fn fase4_jenis_isian_dan_aturan() {
        let j = validasi_jenis(&json!({"nama": "Reimburse Parkir", "kelompok": "Reimburse", "dampak_gaji": "Dibayar",
            "maks_hari": 3, "boleh_urgent": true, "izin_pemutus": "reimburse.decide", "batas_bulanan": 250000})).unwrap();
        assert_eq!(
            (j.dampak_gaji.as_str(), j.maks_hari, j.boleh_urgent, j.izin_pemutus.as_str(), j.batas_bulanan),
            ("Tidak Berpengaruh", None, false, "reimburse.decide", Some(250_000))
        );
        let cuti = validasi_jenis(&json!({"nama": "Cuti X", "kelompok": "Cuti", "dampak_gaji": "Dibayar", "batas_bulanan": 5})).unwrap();
        assert_eq!((cuti.izin_pemutus.as_str(), cuti.batas_bulanan), ("hr.request.decide", None));
        assert_eq!(
            validasi_jenis(&json!({"nama": "R", "kelompok": "Reimburse", "batas_bulanan": 0})).unwrap_err(),
            "Batas bulanan harus 1 sampai 1.000.000.000 rupiah."
        );
        assert_eq!(
            validasi_jenis(&json!({"nama": "R", "kelompok": "Reimburse", "izin_pemutus": "trip.pay"})).unwrap_err(),
            "Pemutus pengajuan tidak dikenal."
        );
        assert_eq!(validasi_jenis(&json!({"nama": "R", "kelompok": "Bonus"})).unwrap_err(), "Kelompok harus Cuti, Izin, Sakit, Lembur, Tukar Shift, Dinas Luar, atau Reimburse.");

        let isian = |lain: Value| {
            let mut d = json!({"id_karyawan": "K1", "id_jenis": "j", "tanggal_mulai": "2026-01-05", "tanggal_selesai": "2026-01-05", "alasan": "x"});
            for (k, v) in lain.as_object().unwrap() {
                d[k] = v.clone();
            }
            validasi_pengajuan(&d)
        };
        assert_eq!(isian(json!({"nominal": 1.5})).unwrap_err(), "Nominal harus bilangan bulat rupiah.");
        assert_eq!(isian(json!({"nominal": "100"})).unwrap_err(), "Nominal harus bilangan bulat rupiah.");
        let jenis = JenisPengajuan { kelompok: "Reimburse".into(), boleh_urgent: false, ..j.clone() };
        assert_eq!(periksa_jenis(&isian(json!({})).unwrap(), &jenis).unwrap_err(), PESAN_NOMINAL);
        assert_eq!(periksa_jenis(&isian(json!({"nominal": 1_000_000_001_i64})).unwrap(), &jenis).unwrap_err(), PESAN_NOMINAL);
        assert_eq!(
            periksa_jenis(&isian(json!({"nominal": 5, "tanggal_selesai": "2026-01-06"})).unwrap(), &jenis).unwrap_err(),
            "Reimburse diajukan per nota, satu tanggal biaya."
        );
        assert!(periksa_jenis(&isian(json!({"nominal": 5})).unwrap(), &jenis).is_ok());
        assert_eq!(periksa_jenis(&isian(json!({"nominal": 5, "urgent": true})).unwrap(), &jenis).unwrap_err(), "Jenis pengajuan ini tidak boleh urgent.");
        assert!(periksa_tanggal_biaya("2026-01-15", "2026-01-15").is_ok());
        assert_eq!(periksa_tanggal_biaya("2026-01-16", "2026-01-15").unwrap_err(), "Tanggal biaya tidak boleh setelah hari ini.");

        assert_eq!((mode_reimburse(None), mode_reimburse(Some(" gaji ")), mode_reimburse(Some("x"))), ("terpisah", "gaji", "terpisah"));
        assert_eq!(validasi_aturan_reimburse(&json!({})).unwrap(), vec![]);
        assert_eq!(validasi_aturan_reimburse(&json!({"hr_reimburse_bayar": "gaji"})).unwrap(), vec![("hr_reimburse_bayar", "gaji".to_owned())]);
        assert_eq!(
            validasi_aturan_reimburse(&json!({"hr_reimburse_bayar": "tunai"})).unwrap_err(),
            "Cara bayar reimbursement harus gaji atau terpisah."
        );
        let bawaan: Vec<&JenisBawaan> = jenis_bawaan().iter().filter(|j| j.kelompok == "Reimburse").collect();
        assert_eq!(bawaan.len(), 5);
        assert!(bawaan.iter().all(|j| j.pemutus() == "reimburse.decide" && j.wajib_dokumen && !j.boleh_urgent));
    }
}
