//! Notifikasi grup Telegram internal (schema v33).
//!
//! Kembar `validations/telegram.ts` + `services/telegram.ts`; aturan murninya
//! diuji dengan vektor yang sama di kedua bahasa. Bot hanya MENGIRIM: tidak ada
//! perintah atau tombol dari Telegram yang bisa mengubah data, karena itu akan
//! melewati login, 2FA, dan RBAC.
//!
//! Kejadian tidak dikaitkan ke setiap jalur simpan. Pengirim membaca datanya
//! langsung dari database yang dikonfigurasi (`SQL_*`) dan mencatatnya ke
//! `notifikasi_telegram` dengan id deterministik, jadi beberapa perangkat yang
//! berjalan bersamaan tidak pernah menggandakan pesan. Kedua tabelnya khusus
//! cloud: token bot tidak pernah tersalin ke perangkat.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    accounting::format_rupiah,
    driver::{penugasan, Laporan, Penugasan},
    hr_kinerja::{self, KeputusanKinerja},
    hris::{
        self, ingat_dokumen_sql, ingat_jam_sql, ingat_kontrak_dekat_sql, ingat_kontrak_jauh_sql,
        ingat_menunggu_sql, ingat_percobaan_sql,
    },
    inventory::format_jumlah,
    models::CommandError,
    turso::{Statement, TursoClient},
    tutup_buku::tanggal_tampil,
};

pub const BIDANG: [&str; 5] = ["inventaris", "keuangan", "pimpinan", "armada", "hrd"];
pub const KEJADIAN: [&str; 26] = [
    "pengajuan_baru",
    "pengajuan_putus",
    "stok_menipis",
    "kasbon_baru",
    "tutup_buku",
    "gaji_status",
    "buka_buku_pimpinan",
    "trip_kendala",
    "trip_selesai",
    "trip_tidak_jalan",
    "trip_dibatalkan",
    "trip_ganti_izin",
    "trip_lokasi_palsu",
    "hr_kontrak_akhir",
    "hr_percobaan_akhir",
    "hr_dokumen_kedaluwarsa",
    "hr_sp_berakhir",
    "hr_pengajuan_menunggu",
    "hr_urgent_belum_diketahui",
    "hr_ulang_tahun_kerja",
    "hr_kinerja_menunggu",
    "hr_kinerja_periode",
    "hr_pelamar_baru",
    "hr_lowongan_tutup",
    "hr_pengajuan_baru",
    "hr_pengajuan_diputus",
];

/// Grup tujuan setiap kejadian. Cermin `BIDANG_KEJADIAN`.
pub fn bidang_kejadian(kejadian: &str) -> Option<&'static str> {
    match kejadian {
        "pengajuan_baru" | "kasbon_baru" | "tutup_buku" => Some("keuangan"),
        "pengajuan_putus" | "stok_menipis" => Some("inventaris"),
        "gaji_status" | "buka_buku_pimpinan" => Some("pimpinan"),
        "trip_kendala" | "trip_selesai" | "trip_tidak_jalan" | "trip_dibatalkan"
        | "trip_ganti_izin" | "trip_lokasi_palsu" => Some("armada"),
        "hr_kontrak_akhir"
        | "hr_percobaan_akhir"
        | "hr_dokumen_kedaluwarsa"
        | "hr_sp_berakhir"
        | "hr_pengajuan_menunggu"
        | "hr_urgent_belum_diketahui"
        | "hr_ulang_tahun_kerja"
        | "hr_kinerja_menunggu"
        | "hr_kinerja_periode"
        | "hr_pelamar_baru"
        | "hr_lowongan_tutup"
        | "hr_pengajuan_baru"
        | "hr_pengajuan_diputus" => Some("hrd"),
        _ => None,
    }
}

fn label_bidang(bidang: &str) -> &'static str {
    match bidang {
        "keuangan" => "Keuangan",
        "pimpinan" => "Pimpinan",
        "armada" => "Armada",
        "hrd" => "HRD",
        _ => "Inventaris",
    }
}

const KUNCI_TOKEN: &str = "bot_token";
const KUNCI_AKTIF: &str = "aktif";
const KUNCI_AKTIF_SEJAK: &str = "aktif_sejak";
const JAM_RINGKASAN_STOK: i64 = 7;
const MAKS_BARIS_STOK: usize = 30;
const TELEGRAM_BATCH: i64 = 20;
const TELEGRAM_TIMEOUT: Duration = Duration::from_secs(15);
const TELEGRAM_THROTTLE: Duration = Duration::from_millis(1000);

// SQL di bawah DISALIN HARFIAH dari `validations/telegram.ts`.
const UPSERT_SETTING_SQL: &str = "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;";
const INSERT_ANTREAN_SQL: &str = "INSERT OR IGNORE INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan) VALUES (?, ?, ?);";

const SQL_PENGAJUAN_BARU: &str = "SELECT p.id_pengajuan, p.nomor, p.keperluan, p.cara_bayar,
       COALESCE(o.nama_operator, p.diajukan_oleh) AS pengaju,
       (SELECT COUNT(*) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS jumlah_baris,
       (SELECT COALESCE(SUM(CASE WHEN b.desimal = 1 THEN (b.jumlah * b.harga_satuan + 50) / 100 ELSE b.jumlah * b.harga_satuan END), 0) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = p.diajukan_oleh
WHERE p.created_at >= ? AND p.created_at >= datetime('now', '-7 days')
  AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-baru:' || p.id_pengajuan)
ORDER BY p.created_at
LIMIT 50;";

const SQL_PENGAJUAN_PUTUS: &str = "SELECT p.id_pengajuan, p.nomor, p.keperluan,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN 1 ELSE 0 END AS disetujui,
       COALESCE(o.nama_operator, p.disetujui_oleh, p.ditolak_oleh) AS pemutus,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN p.catatan_persetujuan ELSE p.alasan_tolak END AS catatan,
       (SELECT COALESCE(SUM(CASE WHEN b.desimal = 1 THEN (b.jumlah * b.harga_satuan + 50) / 100 ELSE b.jumlah * b.harga_satuan END), 0) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = COALESCE(p.disetujui_oleh, p.ditolak_oleh)
WHERE COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime(?, '+7 hours')
  AND COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-putus:' || p.id_pengajuan)
ORDER BY COALESCE(p.disetujui_pada, p.ditolak_pada)
LIMIT 50;";

const SQL_STOK_MENIPIS: &str = "SELECT kode_barang, nama_barang, satuan, desimal, stok_minimum, stok_baik FROM (
  SELECT b.kode_barang, b.nama_barang, b.satuan, b.desimal, b.stok_minimum,
         COALESCE((SELECT SUM(s.saldo) FROM inventory_saldo s WHERE s.id_barang = b.id_barang AND s.kondisi = 'Baik'), 0) AS stok_baik
  FROM inventory_barang b
  WHERE b.status_aktif = 1 AND b.dihapus_pada IS NULL AND b.stok_minimum > 0
) WHERE stok_baik < stok_minimum
ORDER BY nama_barang COLLATE NOCASE
-- batas: satu baris per barang aktif yang stoknya di bawah minimum
;";

const SQL_KASBON_BARU: &str = "SELECT k.id_pinjaman, k.pokok, k.cicilan, k.mulai_potong
FROM keu_pinjaman k
WHERE k.created_at >= ? AND k.created_at >= datetime('now', '-7 days')
  AND k.status = 'Diajukan'
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'kasbon:' || k.id_pinjaman)
ORDER BY k.created_at
LIMIT 50;";

const SQL_TUTUP_BUKU: &str = "SELECT t.id_tutup, t.sampai_tanggal, t.status, COALESCE(o.nama_operator, t.dibuat_oleh) AS oleh
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuat_oleh
WHERE t.created_at >= ? AND t.created_at >= datetime('now', '-7 days')
  AND t.status IN ('Aktif', 'Menunggu')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'tutup:' || t.id_tutup)
ORDER BY t.created_at
LIMIT 50;";

const SQL_BUKA_BUKU: &str = "SELECT t.id_tutup, t.sampai_tanggal, COALESCE(o.nama_operator, t.dibuka_oleh) AS oleh, t.alasan_buka
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuka_oleh
WHERE t.status = 'Dibuka'
  AND t.dibuka_pada >= datetime(?, '+7 hours') AND t.dibuka_pada >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ? || t.id_tutup)
ORDER BY t.dibuka_pada
LIMIT 50;";

const SQL_GAJI_STATUS: &str = "SELECT a.id, a.new_status, a.notes, r.period_start, r.period_end,
       r.total_employees, r.total_net_payout,
       COALESCE(o.nama_operator, a.performed_by) AS oleh
FROM payroll_audit_logs a
JOIN payroll_runs r ON r.id = a.payroll_run_id
LEFT JOIN master_operator o ON o.username = a.performed_by
WHERE a.action = 'TRANSITION_STATUS'
  AND a.new_status IN ('REVIEWED', 'APPROVED', 'PAID', 'REJECTED')
  AND datetime(a.created_at) >= datetime(?) AND datetime(a.created_at) >= datetime('now', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'gaji:' || a.id)
ORDER BY datetime(a.created_at), a.id
LIMIT 50;";

/// Awalan id pesan "buku dibuka kembali": satu pembukaan menjadi dua pesan,
/// ke Keuangan dan ke Pimpinan. Cermin `AWALAN_BUKA*`.
const AWALAN_BUKA: &str = "buka:";
const AWALAN_BUKA_PIMPINAN: &str = "buka-pimpinan:";

/// Laporan perjalanan (v34) disaring jam cloud `diterima_cloud` (UTC), bukan
/// jam perangkat: laporan offline yang telat sampai tetap dikirim selama sampai
/// di cloud dalam 7 hari. Parameter pertama = `aktif_sejak`. Cermin
/// `TELEGRAM_SQL_TRIP_*`; teksnya diperiksa sama oleh `telegram.test.ts`.
pub(crate) const SQL_TRIP_KENDALA: &str = "SELECT l.id_laporan, l.id_perjalanan, l.jenis, l.mode_ganti, l.jenis_kendala, l.terlambat_menit,
       l.nama_lokasi, l.keterangan, l.id_karyawan, l.id_karyawan_baru, l.id_kendaraan_baru, l.waktu_perangkat,
       p.nomor, p.id_karyawan AS awal_karyawan, p.id_kendaraan AS awal_kendaraan,
       datetime(l.waktu_perangkat, '+7 hours') AS waktu_wib,
       COALESCE(CAST(ROUND((julianday(l.diterima_cloud) - julianday(l.waktu_perangkat)) * 1440) AS INTEGER), 0) AS telat_menit,
       COALESCE(o.nama_operator, l.dilaporkan_oleh) AS oleh
FROM drv_laporan l
JOIN drv_perjalanan p ON p.id_perjalanan = l.id_perjalanan
LEFT JOIN master_operator o ON o.username = l.dilaporkan_oleh
WHERE l.diterima_cloud >= ? AND l.diterima_cloud >= datetime('now', '-7 days')
  AND l.jenis = 'Kendala'
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-kendala:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;";

/// Parameter: `aktif_sejak`, jenis laporan penutup, awalan id (`TRIP_TUTUP`).
pub(crate) const SQL_TRIP_TUTUP: &str = "SELECT l.id_laporan, l.id_perjalanan, l.jenis, l.mode_ganti, l.jenis_kendala, l.terlambat_menit,
       l.nama_lokasi, l.keterangan, l.id_karyawan, l.id_karyawan_baru, l.id_kendaraan_baru, l.waktu_perangkat,
       p.nomor, p.id_karyawan AS awal_karyawan, p.id_kendaraan AS awal_kendaraan,
       datetime(l.waktu_perangkat, '+7 hours') AS waktu_wib,
       COALESCE(CAST(ROUND((julianday(l.diterima_cloud) - julianday(l.waktu_perangkat)) * 1440) AS INTEGER), 0) AS telat_menit,
       COALESCE(o.nama_operator, l.dilaporkan_oleh) AS oleh
FROM drv_laporan l
JOIN drv_perjalanan p ON p.id_perjalanan = l.id_perjalanan
LEFT JOIN master_operator o ON o.username = l.dilaporkan_oleh
WHERE l.diterima_cloud >= ? AND l.diterima_cloud >= datetime('now', '-7 days')
  AND l.jenis = ?
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ? || l.id_perjalanan)
ORDER BY l.diterima_cloud, l.waktu_perangkat, l.id_laporan
LIMIT 50;";

pub(crate) const SQL_TRIP_GANTI_IZIN: &str = "SELECT l.id_laporan, l.id_perjalanan, l.jenis, l.mode_ganti, l.jenis_kendala, l.terlambat_menit,
       l.nama_lokasi, l.keterangan, l.id_karyawan, l.id_karyawan_baru, l.id_kendaraan_baru, l.waktu_perangkat,
       p.nomor, p.id_karyawan AS awal_karyawan, p.id_kendaraan AS awal_kendaraan,
       datetime(l.waktu_perangkat, '+7 hours') AS waktu_wib,
       COALESCE(CAST(ROUND((julianday(l.diterima_cloud) - julianday(l.waktu_perangkat)) * 1440) AS INTEGER), 0) AS telat_menit,
       COALESCE(o.nama_operator, l.dilaporkan_oleh) AS oleh
FROM drv_laporan l
JOIN drv_perjalanan p ON p.id_perjalanan = l.id_perjalanan
LEFT JOIN master_operator o ON o.username = l.dilaporkan_oleh
WHERE l.diterima_cloud >= ? AND l.diterima_cloud >= datetime('now', '-7 days')
  AND l.jenis IN ('Ganti Kendaraan', 'Ganti Driver') AND l.mode_ganti IN ('Darurat', 'Minta Izin')
  AND NOT EXISTS (SELECT 1 FROM drv_laporan k WHERE k.id_perjalanan = l.id_perjalanan AND k.jenis IN ('Disetujui', 'Ditolak') AND k.id_ref = l.id_laporan)
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-ganti:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;";

pub(crate) const SQL_TRIP_LOKASI_PALSU: &str = "SELECT l.id_laporan, l.id_perjalanan, l.jenis, l.mode_ganti, l.jenis_kendala, l.terlambat_menit,
       l.nama_lokasi, l.keterangan, l.id_karyawan, l.id_karyawan_baru, l.id_kendaraan_baru, l.waktu_perangkat,
       p.nomor, p.id_karyawan AS awal_karyawan, p.id_kendaraan AS awal_kendaraan,
       datetime(l.waktu_perangkat, '+7 hours') AS waktu_wib,
       COALESCE(CAST(ROUND((julianday(l.diterima_cloud) - julianday(l.waktu_perangkat)) * 1440) AS INTEGER), 0) AS telat_menit,
       COALESCE(o.nama_operator, l.dilaporkan_oleh) AS oleh
FROM drv_laporan l
JOIN drv_perjalanan p ON p.id_perjalanan = l.id_perjalanan
LEFT JOIN master_operator o ON o.username = l.dilaporkan_oleh
WHERE l.diterima_cloud >= ? AND l.diterima_cloud >= datetime('now', '-7 days')
  AND l.lokasi_palsu = 1
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-palsu:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;";

/// Laporan penutup surat jalan → (jenis, kejadian, awalan id). Satu pesan per
/// surat jalan: laporan penutup kembar dari dua perangkat offline berbagi id.
/// Cermin `TRIP_TUTUP`.
pub(crate) const TRIP_TUTUP: [(&str, &str, &str); 3] = [
    ("Selesai", "trip_selesai", "drv-selesai:"),
    ("Tidak Jalan", "trip_tidak_jalan", "drv-tidak-jalan:"),
    ("Dibatalkan", "trip_dibatalkan", "drv-batal:"),
];

/// Bahan `penugasan`: seluruh laporan satu surat jalan. Cermin
/// `TELEGRAM_SQL_TRIP_LAPORAN`.
pub(crate) const SQL_TRIP_LAPORAN: &str = "SELECT id_laporan, jenis, mode_ganti, id_ref, waktu_perangkat, id_karyawan_baru, id_kendaraan_baru FROM drv_laporan WHERE id_perjalanan = ?;";
pub(crate) const SQL_NAMA_PERSONIL: &str = "SELECT nama FROM master_data WHERE id_unik = ?;";
pub(crate) const SQL_LABEL_KENDARAAN: &str = "SELECT TRIM(COALESCE(j.nama, '') || ' ' || k.identitas) AS label FROM drv_kendaraan k LEFT JOIN drv_jenis_kendaraan j ON j.id_jenis = k.id_jenis WHERE k.id_kendaraan = ?;";

pub(crate) fn id_trip_kendala(id_laporan: &str) -> String {
    format!("drv-kendala:{id_laporan}")
}
pub(crate) fn id_trip_ganti_izin(id_laporan: &str) -> String {
    format!("drv-ganti:{id_laporan}")
}
pub(crate) fn id_trip_lokasi_palsu(id_laporan: &str) -> String {
    format!("drv-palsu:{id_laporan}")
}

const SQL_JAM_WIB: &str = concat!(
    "SELECT date('now', '+7 hours') AS tanggal, date('now', '+7 hours', '-1 day') AS kemarin, CAST(strftime('%H', 'now', '+7 hours') AS INTEGER) AS jam, ",
    ingat_jam_sql!(),
    " AS jam_hr;"
);

// ── Pengingat HR ke grup HRD (fase 8, prd-hris.md §23) ─────────────────────

// Angka kontrak, percobaan, dokumen, menunggu, dan jam HR dibaca SQL di bawah
// lewat fragmen `hris::ingat_*_sql!` (§24.3); jendela SP dan ulang tahun
// kerja tetap 7 hari di kode (cermin `HR_HARI_JENDELA`).

/// Parkir klaim (§23.2, Q-101). Cermin `KLAIM_PARKIR`: build sebelum fase 8
/// hanya mengambil dan membatalkan baris tanpa klaim berlaku, jadi baris
/// kejadian HR yang dimasukkan `INSERT_ANTREAN_PARKIR_SQL` tidak disentuhnya.
pub(crate) const KLAIM_PARKIR: &str = "gen:2";
const KLAIM_PARKIR_SAMPAI: &str = "9999-12-31 23:59:59";

// Predikat antrean `drain`, cermin `TELEGRAM_DRAIN_*_SQL`. Sama dengan v33
// ditambah `OR klaim_oleh = 'gen:2'`: baris parkir terlihat build ini, dan
// klaimnya tetap atomik karena UPDATE klaim mengganti `klaim_oleh`.
const DRAIN_PILIH_SQL: &str = "SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now') OR klaim_oleh = 'gen:2') ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;";
const DRAIN_BATAL_SQL: &str = "UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now') OR klaim_oleh = 'gen:2');";
const DRAIN_KLAIM_SQL: &str = "UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now') OR klaim_oleh = 'gen:2');";
const DRAIN_GAGAL_SQL: &str = "UPDATE notifikasi_telegram SET status = ?, attempt_count = ?, last_error = ?, klaim_oleh = ?, klaim_sampai = ? WHERE id_notifikasi = ? AND klaim_oleh = ?;";

/// Kejadian generasi parkir `gen:2` = semua kejadian bidang `hrd` (fase 8).
/// Cermin `diparkir`.
pub(crate) fn diparkir(kejadian: &str) -> bool {
    bidang_kejadian(kejadian) == Some("hrd")
}

/// Klaim baris setelah gagal kirim. Cermin `klaimSetelahGagal`: baris parkir
/// yang masih boleh dicoba ulang kembali diparkir, supaya build lama tetap
/// tidak bisa membatalkannya; selain itu klaim dikosongkan seperti v33.
pub(crate) fn klaim_setelah_gagal(kejadian: &str, status: &str) -> (Option<&'static str>, Option<&'static str>) {
    if status == "Menunggu" && diparkir(kejadian) {
        (Some(KLAIM_PARKIR), Some(KLAIM_PARKIR_SAMPAI))
    } else {
        (None, None)
    }
}

// Disalin harfiah dari `TELEGRAM_INSERT_ANTREAN_PARKIR_SQL` dan
// `TELEGRAM_SQL_HR_*` (`validations/telegram.ts`); teksnya diperiksa sama oleh
// `telegram.test.ts`. "Hari ini" = tanggal WIB jam database (aturan 19).
// Kolom yang tidak boleh terkirim (NIK, `hr_profil`, nominal, alasan, isi SP,
// nomor dokumen dan kontrak, data pelamar) tidak dibaca (Q-32).
pub(crate) const INSERT_ANTREAN_PARKIR_SQL: &str = "INSERT OR IGNORE INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan, klaim_oleh, klaim_sampai) VALUES (?, ?, ?, 'gen:2', '9999-12-31 23:59:59');";
pub(crate) const SQL_HR_KONTRAK: &str = concat!(
    "SELECT id_kontrak, tanggal_selesai, nama, jabatan, sisa, dekat FROM (
  SELECT k.id_kontrak, k.tanggal_selesai, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan,
         CAST(julianday(date(k.tanggal_selesai)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa, ",
    ingat_kontrak_jauh_sql!(),
    " AS jauh, ",
    ingat_kontrak_dekat_sql!(),
    " AS dekat
  FROM hr_kontrak k
  JOIN master_data m ON m.id_unik = k.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE k.jenis = 'PKWT' AND date(k.tanggal_selesai) IS NOT NULL
    AND k.jenis <> 'Pembatalan'
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak)
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak l WHERE l.id_karyawan = k.id_karyawan AND l.jenis <> 'Pembatalan'
      AND (l.tanggal_mulai > k.tanggal_mulai OR (l.tanggal_mulai = k.tanggal_mulai AND l.id_kontrak > k.id_kontrak))
      AND NOT EXISTS (SELECT 1 FROM hr_kontrak lb WHERE lb.id_kontrak = 'batal-' || l.id_kontrak))
) WHERE sisa BETWEEN 0 AND max(jauh, dekat)
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-kontrak:' || id_kontrak || CASE WHEN sisa <= dekat THEN ':dekat' ELSE ':jauh' END)
ORDER BY tanggal_selesai, id_kontrak
LIMIT 50;"
);
pub(crate) const SQL_HR_PERCOBAAN: &str = concat!(
    "SELECT id_kontrak, percobaan_selesai, nama, jabatan, sisa FROM (
  SELECT k.id_kontrak, k.percobaan_selesai, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan,
         CAST(julianday(date(k.percobaan_selesai)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
  FROM hr_kontrak k
  JOIN master_data m ON m.id_unik = k.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE date(k.percobaan_selesai) IS NOT NULL
    AND k.jenis <> 'Pembatalan'
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak)
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak l WHERE l.id_karyawan = k.id_karyawan AND l.jenis <> 'Pembatalan'
      AND (l.tanggal_mulai > k.tanggal_mulai OR (l.tanggal_mulai = k.tanggal_mulai AND l.id_kontrak > k.id_kontrak))
      AND NOT EXISTS (SELECT 1 FROM hr_kontrak lb WHERE lb.id_kontrak = 'batal-' || l.id_kontrak))
) WHERE sisa BETWEEN 0 AND ",
    ingat_percobaan_sql!(),
    "
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-coba:' || id_kontrak)
ORDER BY percobaan_selesai, id_kontrak
LIMIT 50;"
);
pub(crate) const SQL_HR_DOKUMEN: &str = concat!(
    "SELECT id_dokumen, jenis_dokumen, tanggal_kedaluwarsa, nama, jabatan, sisa FROM (
  SELECT d.id_dokumen, COALESCE(dj.nama, d.id_jenis) AS jenis_dokumen, d.tanggal_kedaluwarsa, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan,
         CAST(julianday(date(d.tanggal_kedaluwarsa)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
  FROM hr_dokumen d
  LEFT JOIN hr_dokumen_jenis dj ON dj.id_jenis = d.id_jenis
  JOIN master_data m ON m.id_unik = d.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE date(d.tanggal_kedaluwarsa) IS NOT NULL
) WHERE sisa BETWEEN 0 AND ",
    ingat_dokumen_sql!(),
    "
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-dok:' || id_dokumen || ':' || tanggal_kedaluwarsa)
ORDER BY tanggal_kedaluwarsa, id_dokumen
LIMIT 50;"
);
pub(crate) const SQL_HR_SP: &str = "SELECT s.id_sp, s.tingkat, s.berlaku_sampai, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan
FROM hr_sp s
JOIN master_data m ON m.id_unik = s.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE s.dicabut_pada IS NULL
  AND s.berlaku_sampai <= date('now', '+7 hours') AND s.berlaku_sampai >= date('now', '+7 hours', '-6 days')
  AND s.berlaku_sampai >= date(?, '+7 hours')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-sp:' || s.id_sp)
ORDER BY s.berlaku_sampai, s.id_sp
LIMIT 50;";
pub(crate) const SQL_HR_MENUNGGU: &str = concat!(
    "SELECT p.kelompok, COUNT(*) AS jumlah, date(MIN(p.created_at), '+7 hours') AS sejak, ",
    ingat_menunggu_sql!(),
    " AS hari
FROM hr_pengajuan p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif'
WHERE p.created_at <= datetime('now', '-' || ",
    ingat_menunggu_sql!(),
    " || ' days')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent'))
GROUP BY p.kelompok
ORDER BY p.kelompok;"
);
pub(crate) const SQL_HR_URGENT: &str = "SELECT COUNT(*) AS jumlah, date(MIN(p.created_at), '+7 hours') AS sejak
FROM hr_pengajuan p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif'
WHERE NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan d WHERE d.id_pengajuan = p.id_pengajuan AND d.jenis = 'Diketahui')
  AND (SELECT k.jenis FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY k.diterima_cloud IS NULL, k.diterima_cloud, k.waktu_perangkat, k.id_keputusan LIMIT 1) = 'Setujui Urgent';";
pub(crate) const SQL_HR_ULTAH: &str = "SELECT m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan,
       CAST(strftime('%Y', h.hari) AS INTEGER) - CAST(strftime('%Y', date(m.tanggal_daftar)) AS INTEGER) AS tahun
FROM (SELECT date('now', '+7 hours') AS hari) h
JOIN master_data m ON m.status_aktif = 'Aktif'
LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE date(m.tanggal_daftar) IS NOT NULL
  AND date(m.tanggal_daftar) < date(h.hari, 'start of year')
  AND (strftime('%m-%d', date(m.tanggal_daftar)) = strftime('%m-%d', h.hari)
    OR (strftime('%m-%d', date(m.tanggal_daftar)) = '02-29' AND strftime('%m-%d', h.hari) = '02-28' AND strftime('%m-%d', h.hari, '+1 day') = '03-01'))
ORDER BY m.nama COLLATE NOCASE, m.id_unik;";

// ── Kejadian HR fase 9 (prd-hris.md §24.4) ─────────────────────────────────

/// Jendela SP, ulang tahun kerja, dan periode kinerja berakhir, tetap di kode
/// (§24.3). Cermin `HR_HARI_JENDELA`.
pub(crate) const HR_HARI_JENDELA: i64 = 7;
/// Q-120 (b): pesan per pengajuan menyebut nama, kecuali Sakit. Cermin
/// `KELOMPOK_TANPA_NAMA`.
pub(crate) const KELOMPOK_TANPA_NAMA: &str = "Sakit";

// Disalin harfiah dari `TELEGRAM_SQL_HR_*` fase 9 (`validations/telegram.ts`);
// teksnya diperiksa sama oleh `telegram.test.ts`. Status kinerja dihitung
// `hr_kinerja::status_kinerja`, bukan SQL. Nilai akhir, predikat, alasan,
// nominal, dan data pelamar tidak dibaca (Q-32, Q-86, Q-117).
pub(crate) const SQL_HR_KINERJA_MENUNGGU: &str = "SELECT p.sidik,
       (SELECT date(MAX(a.diterima_cloud), '+7 hours') FROM hr_kinerja_keputusan a WHERE a.id_penilaian = p.id_penilaian AND a.jenis = 'Ajukan' AND a.sidik = p.sidik) AS sejak,
       json((SELECT json_group_array(json_object('id_keputusan', k.id_keputusan, 'jenis', k.jenis, 'sidik', k.sidik, 'oleh', k.oleh, 'waktu_perangkat', k.waktu_perangkat, 'diterima_cloud', k.diterima_cloud)) FROM hr_kinerja_keputusan k WHERE k.id_penilaian = p.id_penilaian)) AS keputusan
FROM hr_kinerja_penilaian p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif'
WHERE NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan b WHERE b.id_penilaian = p.id_penilaian AND b.jenis = 'Batal')
  AND EXISTS (SELECT 1 FROM hr_kinerja_keputusan a WHERE a.id_penilaian = p.id_penilaian AND a.jenis = 'Ajukan' AND a.sidik = p.sidik)
  AND NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan f WHERE f.id_penilaian = p.id_penilaian AND f.jenis = 'Final' AND f.sidik = p.sidik)
ORDER BY p.id_penilaian;";
pub(crate) const SQL_HR_KINERJA_PERIODE: &str = "SELECT m.id_unik, m.tanggal_daftar, m.tanggal_selesai_aktif,
       json((SELECT json_group_array(json_object('sidik', p.sidik, 'keputusan', json((SELECT json_group_array(json_object('id_keputusan', k.id_keputusan, 'jenis', k.jenis, 'sidik', k.sidik, 'oleh', k.oleh, 'waktu_perangkat', k.waktu_perangkat, 'diterima_cloud', k.diterima_cloud)) FROM hr_kinerja_keputusan k WHERE k.id_penilaian = p.id_penilaian)))) FROM hr_kinerja_penilaian p WHERE p.id_karyawan = m.id_unik AND p.id_ref IS NULL AND p.periode_jenis = ? AND p.periode_mulai = ? AND NOT EXISTS (SELECT 1 FROM hr_kinerja_keputusan b WHERE b.id_penilaian = p.id_penilaian AND b.jenis = 'Batal'))) AS penilaian
FROM master_data m
WHERE m.status_aktif = 'Aktif'
ORDER BY m.id_unik;";
pub(crate) const SQL_HR_PELAMAR_BARU: &str = "SELECT l.judul, COUNT(*) AS jumlah
FROM hr_pelamar p
JOIN hr_lowongan l ON l.id_lowongan = p.id_lowongan
WHERE p.created_at >= datetime(?1, '-1 day', '-7 hours') AND p.created_at < datetime(?1, '-7 hours')
GROUP BY l.id_lowongan, l.judul
ORDER BY l.judul COLLATE NOCASE, l.id_lowongan;";
pub(crate) const SQL_HR_LOWONGAN_TUTUP: &str = "SELECT l.id_lowongan, l.judul, l.tanggal_tutup, l.jumlah AS kuota,
       (SELECT COUNT(*) FROM hr_pelamar p WHERE p.id_lowongan = l.id_lowongan) AS pelamar,
       CAST(julianday(date(l.tanggal_tutup)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
FROM hr_lowongan l
WHERE l.ditutup_pada IS NULL AND l.tanggal_buka <= date('now', '+7 hours')
  AND l.tanggal_tutup BETWEEN date('now', '+7 hours') AND date('now', '+7 hours', '+3 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-lowongan:' || l.id_lowongan || ':' || l.tanggal_tutup)
ORDER BY l.tanggal_tutup, l.id_lowongan
LIMIT 50;";
pub(crate) const SQL_HR_PENGAJUAN_BARU: &str = "SELECT p.id_pengajuan, p.kelompok, p.tanggal_mulai, p.tanggal_selesai, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan
FROM hr_pengajuan p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE p.created_at >= ? AND p.created_at >= datetime('now', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent'))
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-ajuan:' || p.id_pengajuan)
ORDER BY p.created_at, p.id_pengajuan
LIMIT 50;";
/// Jenis periode kinerja yang berlaku; kosong atau rusak = bawaan
/// (`PengaturanKinerja::dari_peta`). Cermin `TELEGRAM_SQL_HR_KINERJA_JENIS`.
pub(crate) const SQL_HR_KINERJA_JENIS: &str = "SELECT value FROM setting_gex_system WHERE key = 'hr_kinerja_periode';";
pub(crate) const SQL_HR_PENGAJUAN_PUTUS: &str = "SELECT k.id_keputusan, k.jenis, p.kelompok, p.tanggal_mulai, p.tanggal_selesai, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, COALESCE(o.nama_operator, k.oleh) AS oleh
FROM hr_pengajuan_keputusan k
JOIN hr_pengajuan p ON p.id_pengajuan = k.id_pengajuan
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
LEFT JOIN master_operator o ON o.username = k.oleh
WHERE k.diterima_cloud >= ? AND k.diterima_cloud >= datetime('now', '-7 days')
  AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent')
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal')
  AND k.id_keputusan = (SELECT f.id_keputusan FROM hr_pengajuan_keputusan f WHERE f.id_pengajuan = p.id_pengajuan AND f.sidik = p.sidik AND f.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY f.diterima_cloud IS NULL, f.diterima_cloud, f.waktu_perangkat, f.id_keputusan LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'hr-putus:' || k.id_keputusan)
ORDER BY k.diterima_cloud, k.id_keputusan
LIMIT 50;";

/// Cermin `idHrKontrak`: tahap, bukan angkanya (Q-116). `:dekat` bila sisa ≤
/// `dekat`, selain itu `:jauh`; mengubah angka di tengah jendela tidak
/// melahirkan pesan kedua untuk tahap yang sama.
pub(crate) fn id_hr_kontrak(id_kontrak: &str, sisa: i64, dekat: i64) -> String {
    let tahap = if sisa <= dekat { "dekat" } else { "jauh" };
    format!("hr-kontrak:{id_kontrak}:{tahap}")
}
pub(crate) fn id_hr_percobaan(id_kontrak: &str) -> String {
    format!("hr-coba:{id_kontrak}")
}
/// Memuat tanggalnya: dokumen yang diperpanjang diingatkan lagi (Q-104).
pub(crate) fn id_hr_dokumen(id_dokumen: &str, tanggal_kedaluwarsa: &str) -> String {
    format!("hr-dok:{id_dokumen}:{tanggal_kedaluwarsa}")
}
pub(crate) fn id_hr_sp(id_sp: &str) -> String {
    format!("hr-sp:{id_sp}")
}
pub(crate) fn id_hr_menunggu(tanggal: &str) -> String {
    format!("hr-tunggu:{tanggal}")
}
pub(crate) fn id_hr_urgent(tanggal: &str) -> String {
    format!("hr-urgent:{tanggal}")
}
pub(crate) fn id_hr_ultah(tanggal: &str) -> String {
    format!("hr-ultah:{tanggal}")
}
pub(crate) fn id_hr_kinerja_tunggu(tanggal: &str) -> String {
    format!("hr-kinerja-tunggu:{tanggal}")
}
/// Sekali per periode (§24.4).
pub(crate) fn id_hr_kinerja_periode(periode_mulai: &str) -> String {
    format!("hr-kinerja-periode:{periode_mulai}")
}
pub(crate) fn id_hr_pelamar(tanggal: &str) -> String {
    format!("hr-pelamar:{tanggal}")
}
/// Memuat tanggalnya: tanggal tutup yang diundur diingatkan lagi.
pub(crate) fn id_hr_lowongan(id_lowongan: &str, tanggal_tutup: &str) -> String {
    format!("hr-lowongan:{id_lowongan}:{tanggal_tutup}")
}
pub(crate) fn id_hr_ajuan(id_pengajuan: &str) -> String {
    format!("hr-ajuan:{id_pengajuan}")
}
pub(crate) fn id_hr_putus(id_keputusan: &str) -> String {
    format!("hr-putus:{id_keputusan}")
}

// SQL kartu "Perlu perhatian" (§23.4), disalin harfiah dari
// `PERHATIAN_SQL_*` (`validations/telegram.ts`). Potongannya sama dengan SQL
// sumber Telegram di atas, jadi kartu dan grup HRD tidak bisa berbeda
// pendapat; bagian pengajuan memakai `SQL_HR_MENUNGGU`/`SQL_HR_URGENT`.
pub(crate) const PERHATIAN_SQL_KONTRAK: &str = concat!(
    "SELECT jenis, id_karyawan, nama, jabatan, tanggal, sisa FROM (
  SELECT 'PKWT' AS jenis, k.id_karyawan, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, k.tanggal_selesai AS tanggal, CAST(julianday(date(k.tanggal_selesai)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
  FROM hr_kontrak k
  JOIN master_data m ON m.id_unik = k.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE k.jenis = 'PKWT' AND date(k.tanggal_selesai) IS NOT NULL
    AND k.jenis <> 'Pembatalan'
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak)
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak l WHERE l.id_karyawan = k.id_karyawan AND l.jenis <> 'Pembatalan'
      AND (l.tanggal_mulai > k.tanggal_mulai OR (l.tanggal_mulai = k.tanggal_mulai AND l.id_kontrak > k.id_kontrak))
      AND NOT EXISTS (SELECT 1 FROM hr_kontrak lb WHERE lb.id_kontrak = 'batal-' || l.id_kontrak))
  UNION ALL
  SELECT 'Percobaan' AS jenis, k.id_karyawan, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, k.percobaan_selesai AS tanggal, CAST(julianday(date(k.percobaan_selesai)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
  FROM hr_kontrak k
  JOIN master_data m ON m.id_unik = k.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE date(k.percobaan_selesai) IS NOT NULL
    AND k.jenis <> 'Pembatalan'
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak)
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak l WHERE l.id_karyawan = k.id_karyawan AND l.jenis <> 'Pembatalan'
      AND (l.tanggal_mulai > k.tanggal_mulai OR (l.tanggal_mulai = k.tanggal_mulai AND l.id_kontrak > k.id_kontrak))
      AND NOT EXISTS (SELECT 1 FROM hr_kontrak lb WHERE lb.id_kontrak = 'batal-' || l.id_kontrak))
) WHERE (jenis = 'PKWT' AND sisa BETWEEN 0 AND max(",
    ingat_kontrak_jauh_sql!(),
    ", ",
    ingat_kontrak_dekat_sql!(),
    ")) OR (jenis = 'Percobaan' AND sisa BETWEEN 0 AND ",
    ingat_percobaan_sql!(),
    ")
ORDER BY sisa, nama COLLATE NOCASE, id_karyawan, jenis
LIMIT 200;"
);
pub(crate) const PERHATIAN_SQL_DOKUMEN: &str = concat!(
    "SELECT id_karyawan, nama, jabatan, jenis_dokumen, tanggal, sisa FROM (
  SELECT d.id_karyawan, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, COALESCE(dj.nama, d.id_jenis) AS jenis_dokumen, d.tanggal_kedaluwarsa AS tanggal, CAST(julianday(date(d.tanggal_kedaluwarsa)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
  FROM hr_dokumen d
  LEFT JOIN hr_dokumen_jenis dj ON dj.id_jenis = d.id_jenis
  JOIN master_data m ON m.id_unik = d.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
  WHERE date(d.tanggal_kedaluwarsa) IS NOT NULL
) WHERE sisa <= ",
    ingat_dokumen_sql!(),
    "
ORDER BY sisa, nama COLLATE NOCASE, id_karyawan
LIMIT 200;"
);
pub(crate) const PERHATIAN_SQL_SP: &str = "SELECT s.id_karyawan, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, s.tingkat, s.berlaku_sampai AS tanggal, CAST(julianday(date(s.berlaku_sampai)) - julianday(date('now', '+7 hours')) AS INTEGER) AS sisa
FROM hr_sp s
JOIN master_data m ON m.id_unik = s.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE s.dicabut_pada IS NULL AND s.tanggal <= date('now', '+7 hours')
  AND s.berlaku_sampai >= date('now', '+7 hours') AND s.berlaku_sampai <= date('now', '+7 hours', '+7 days')
ORDER BY s.berlaku_sampai, m.nama COLLATE NOCASE, s.id_sp
LIMIT 200;";
pub(crate) const PERHATIAN_SQL_ULTAH: &str = "WITH RECURSIVE h(hari, n) AS (SELECT date('now', '+7 hours'), 0 UNION ALL SELECT date(hari, '+1 day'), n + 1 FROM h WHERE n < 7)
SELECT m.id_unik AS id_karyawan, m.nama, COALESCE(j.nama, m.jabatan_status) AS jabatan, h.hari AS tanggal,
       CAST(strftime('%Y', h.hari) AS INTEGER) - CAST(strftime('%Y', date(m.tanggal_daftar)) AS INTEGER) AS tahun
FROM h
JOIN master_data m ON m.status_aktif = 'Aktif'
LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE date(m.tanggal_daftar) IS NOT NULL
  AND date(m.tanggal_daftar) < date(h.hari, 'start of year')
  AND (strftime('%m-%d', date(m.tanggal_daftar)) = strftime('%m-%d', h.hari)
    OR (strftime('%m-%d', date(m.tanggal_daftar)) = '02-29' AND strftime('%m-%d', h.hari) = '02-28' AND strftime('%m-%d', h.hari, '+1 day') = '03-01'))
ORDER BY h.hari, m.nama COLLATE NOCASE, m.id_unik
LIMIT 200;";

// ── Aturan murni ────────────────────────────────────────────────────────────

/// Cermin `tokenBotValid`: `<id bot>:<rahasia>` dari BotFather.
pub fn token_bot_valid(token: &str) -> bool {
    let Some((id, rahasia)) = token.split_once(':') else {
        return false;
    };
    (5..=15).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && (30..=60).contains(&rahasia.len())
        && rahasia
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Cermin `normalisasiChatId`. `Some("")` = grup belum diatur; `None` = bukan
/// id chat Telegram.
pub fn normalisasi_chat_id(raw: &str) -> Option<String> {
    let nilai = raw.trim();
    if nilai.is_empty() {
        return Some(String::new());
    }
    let digit = nilai.strip_prefix('-').unwrap_or(nilai);
    (!digit.is_empty() && digit.len() <= 20 && digit.bytes().all(|b| b.is_ascii_digit()))
        .then(|| nilai.to_owned())
}

/// Cermin `samarkanToken`: token bot ada di URL API, jadi pesan galat jaringan
/// bisa memuatnya.
pub fn samarkan_token(teks: &str, token: &str) -> String {
    if token.is_empty() {
        teks.to_owned()
    } else {
        teks.replace(token, "***")
    }
}

/// Cermin `potong`: dihitung per karakter, bukan byte.
pub fn potong(teks: &str, maks: usize) -> String {
    let teks = teks.trim();
    if teks.chars().count() <= maks {
        teks.to_owned()
    } else {
        format!("{}…", teks.chars().take(maks - 1).collect::<String>())
    }
}

/// Cermin `pesanPengajuanBaru`.
pub fn pesan_pengajuan_baru(
    nomor: &str,
    keperluan: &str,
    total: i64,
    jumlah_baris: i64,
    pengaju: &str,
    cara_bayar: &str,
) -> String {
    let mut baris = vec![
        format!("📦 Pengajuan pembelian baru: {nomor}"),
        format!("Keperluan: {}", potong(keperluan, 200)),
        format!("Total: {} ({jumlah_baris} barang)", format_rupiah(total)),
    ];
    if cara_bayar == "Cicilan" {
        baris.push("Cara bayar: Cicilan".to_owned());
    }
    baris.push(format!("Diajukan oleh: {pengaju}"));
    baris.push("Menunggu ACC di aplikasi.".to_owned());
    baris.join("\n")
}

/// Cermin `pesanPengajuanPutus`.
pub fn pesan_pengajuan_putus(
    nomor: &str,
    keperluan: &str,
    total: i64,
    disetujui: bool,
    pemutus: &str,
    catatan: &str,
) -> String {
    let mut baris = vec![
        if disetujui {
            format!("✅ Pengajuan {nomor} disetujui")
        } else {
            format!("❌ Pengajuan {nomor} ditolak")
        },
        format!("Keperluan: {}", potong(keperluan, 200)),
        format!("Total: {}", format_rupiah(total)),
        format!(
            "{} oleh: {pemutus}",
            if disetujui { "Disetujui" } else { "Ditolak" }
        ),
    ];
    if !catatan.trim().is_empty() {
        baris.push(format!(
            "{}: {}",
            if disetujui { "Catatan" } else { "Alasan" },
            potong(catatan, 300)
        ));
    }
    baris.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisStok {
    pub kode: String,
    pub nama: String,
    pub satuan: String,
    pub desimal: bool,
    pub stok: i64,
    pub minimum: i64,
}

/// Cermin `pesanStokMenipis`. Daftar kosong tidak menghasilkan pesan.
pub fn pesan_stok_menipis(daftar: &[BarisStok]) -> Option<String> {
    if daftar.is_empty() {
        return None;
    }
    let mut baris = vec![format!("⚠️ {} barang di bawah stok minimum", daftar.len())];
    for item in daftar.iter().take(MAKS_BARIS_STOK) {
        baris.push(format!(
            "• {} ({}): {} dari minimum {} {}",
            potong(&item.nama, 60),
            item.kode,
            format_jumlah(item.stok, item.desimal),
            format_jumlah(item.minimum, item.desimal),
            item.satuan
        ));
    }
    if daftar.len() > MAKS_BARIS_STOK {
        baris.push(format!(
            "dan {} barang lainnya.",
            daftar.len() - MAKS_BARIS_STOK
        ));
    }
    Some(baris.join("\n"))
}

const NAMA_BULAN: [&str; 12] = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September",
    "Oktober", "November", "Desember",
];

/// Cermin `labelBulan`: `2026-11` → `November 2026`; teks lain apa adanya.
pub fn label_bulan(periode: &str) -> String {
    let huruf: Vec<char> = periode.chars().collect();
    if huruf.len() == 7 && huruf[4] == '-' {
        let tahun: String = huruf[..4].iter().collect();
        let bulan: String = huruf[5..].iter().collect();
        if let (Ok(_), Ok(bulan)) = (tahun.parse::<u32>(), bulan.parse::<usize>()) {
            if (1..=12).contains(&bulan) {
                return format!("{} {tahun}", NAMA_BULAN[bulan - 1]);
            }
        }
    }
    periode.to_owned()
}

/// Cermin `TELEGRAM_BATAS_PERCOBAAN`.
const BATAS_PERCOBAAN: i64 = 3;

/// Status dan jumlah percobaan setelah gagal. Cermin `statusSetelahGagal`.
pub fn status_setelah_gagal(percobaan_sebelumnya: i64) -> (&'static str, i64) {
    let percobaan = percobaan_sebelumnya + 1;
    let status = if percobaan >= BATAS_PERCOBAAN {
        "Gagal"
    } else {
        "Menunggu"
    };
    (status, percobaan)
}

/// Cermin `pesanKasbonBaru`. Sengaja tanpa nama karyawan maupun pengaju.
pub fn pesan_kasbon_baru(pokok: i64, cicilan: i64, mulai_potong: &str) -> String {
    [
        "💰 Pengajuan kasbon baru".to_owned(),
        format!("Pokok: {}", format_rupiah(pokok)),
        format!(
            "Cicilan: {} per bulan, mulai potong gaji {}",
            format_rupiah(cicilan),
            label_bulan(mulai_potong)
        ),
        "Menunggu keputusan di aplikasi.".to_owned(),
    ]
    .join("\n")
}

/// Cermin `pesanTutupBuku`.
pub fn pesan_tutup_buku(sampai_tanggal: &str, oleh: &str, menunggu: bool) -> String {
    let mut baris = vec![
        format!("🔒 Buku ditutup sampai {}", tanggal_tampil(sampai_tanggal)),
        format!("Oleh: {oleh}"),
    ];
    if menunggu {
        baris.push("Bentrok dengan tutup buku lain, menunggu keputusan di aplikasi.".to_owned());
    }
    baris.join("\n")
}

/// Cermin `pesanBukaBuku`.
pub fn pesan_buka_buku(sampai_tanggal: &str, oleh: &str, alasan: &str) -> String {
    let mut baris = vec![
        format!(
            "🔓 Buku dibuka kembali (tutup sampai {})",
            tanggal_tampil(sampai_tanggal)
        ),
        format!("Oleh: {oleh}"),
    ];
    if !alasan.trim().is_empty() {
        baris.push(format!("Alasan: {}", potong(alasan, 300)));
    }
    baris.join("\n")
}

/// Cermin `permintaanKirim`. Teks polos, tanpa `parse_mode`: tanpa escape.
/// Cermin `MIN_PEGAWAI_NOMINAL_GAJI`: di bawahnya total bersih praktis sama
/// dengan gaji perorangan, jadi pesan hanya menyebut jumlah pegawai.
pub const MIN_PEGAWAI_NOMINAL_GAJI: i64 = 3;

/// Cermin `pesanGajiStatus`. Status di luar daftar tidak menghasilkan pesan.
/// Hanya jumlah pegawai dan total bersih (disembunyikan di bawah
/// `MIN_PEGAWAI_NOMINAL_GAJI`): tanpa nama, slip, potongan, kasbon.
pub fn pesan_gaji_status(
    status: &str,
    periode_awal: &str,
    periode_akhir: &str,
    pegawai: i64,
    total_bersih: i64,
    oleh: &str,
    catatan: &str,
) -> Option<String> {
    let frasa = match status {
        "REVIEWED" => "menunggu persetujuan",
        "APPROVED" => "disetujui",
        "PAID" => "sudah dibayar",
        "REJECTED" => "ditolak",
        _ => return None,
    };
    let mut baris = vec![
        format!(
            "💼 Proses gaji {}–{} {frasa}",
            tanggal_tampil(periode_awal),
            tanggal_tampil(periode_akhir)
        ),
        if pegawai < MIN_PEGAWAI_NOMINAL_GAJI {
            format!("{pegawai} pegawai")
        } else {
            format!(
                "{pegawai} pegawai · total bersih {}",
                format_rupiah(total_bersih)
            )
        },
        format!("Oleh: {oleh}"),
    ];
    if status == "REJECTED" && !catatan.trim().is_empty() {
        baris.push(format!("Alasan: {}", potong(catatan, 300)));
    }
    Some(baris.join("\n"))
}

/// Selisih jam cloud dan jam kejadian di atas ini ditandai terlambat (Q-38).
/// Cermin `MENIT_TERLAMBAT`.
pub const MENIT_TERLAMBAT: i64 = 30;

/// Cermin `IsiLaporanPerjalanan`. `waktu` = jam kejadian WIB
/// `YYYY-MM-DD HH:MM:SS`; `telat_menit` = jam cloud − jam kejadian. Koordinat,
/// foto, upah, dan muatan sengaja tidak pernah ikut (Q-37).
#[derive(Debug, Clone, Default)]
pub struct IsiLaporan<'a> {
    pub nomor: &'a str,
    pub driver: &'a str,
    pub kendaraan: &'a str,
    pub tempat: &'a str,
    pub keterangan: &'a str,
    pub waktu: &'a str,
    pub telat_menit: i64,
}

/// Cermin `waktuTampil`: `2026-10-14 08:05:09` → `14/10/2026 08:05:09 WIB`.
fn waktu_tampil(waktu: &str) -> String {
    let mut bagian = waktu.split(' ');
    let tanggal = bagian.next().unwrap_or("");
    match bagian.next().filter(|jam| !jam.is_empty()) {
        Some(jam) => format!("{} {jam} WIB", tanggal_tampil(tanggal)),
        None => waktu.to_owned(),
    }
}

fn baris_driver(isi: &IsiLaporan<'_>) -> String {
    if isi.kendaraan.is_empty() {
        format!("Driver: {}", isi.driver)
    } else {
        format!("Driver: {} · {}", isi.driver, isi.kendaraan)
    }
}

fn tutup_pesan(mut baris: Vec<String>, isi: &IsiLaporan<'_>) -> String {
    baris.push(format!("Waktu: {}", waktu_tampil(isi.waktu)));
    if isi.telat_menit > MENIT_TERLAMBAT {
        baris.push("Dikirim terlambat (offline).".to_owned());
    }
    baris.join("\n")
}

/// Cermin `pesanTripKendala`.
pub fn pesan_trip_kendala(
    isi: &IsiLaporan<'_>,
    jenis_kendala: &str,
    terlambat_menit: Option<i64>,
) -> String {
    let mut baris = vec![
        if jenis_kendala.is_empty() {
            format!("🚧 Kendala: {}", isi.nomor)
        } else {
            format!("🚧 Kendala {jenis_kendala}: {}", isi.nomor)
        },
        baris_driver(isi),
    ];
    if !isi.tempat.is_empty() {
        baris.push(format!("Tempat: {}", potong(isi.tempat, 100)));
    }
    if let Some(menit) = terlambat_menit.filter(|menit| *menit > 0) {
        baris.push(format!("Perkiraan terlambat: {menit} menit"));
    }
    if !isi.keterangan.is_empty() {
        baris.push(format!("Keterangan: {}", potong(isi.keterangan, 300)));
    }
    tutup_pesan(baris, isi)
}

/// Cermin `pesanTripTutup`. `oleh` = operator bila dicatat dispatcher, kosong
/// bila dari HP driver. Jenis di luar `TRIP_TUTUP` tidak menghasilkan pesan.
pub fn pesan_trip_tutup(isi: &IsiLaporan<'_>, jenis: &str, oleh: &str) -> Option<String> {
    let judul = match jenis {
        "Selesai" => format!("🏁 Surat jalan {} selesai", isi.nomor),
        "Tidak Jalan" => format!("⛔ Surat jalan {} tidak jalan", isi.nomor),
        "Dibatalkan" => format!("🛑 Surat jalan {} dibatalkan", isi.nomor),
        _ => return None,
    };
    let mut baris = vec![judul, baris_driver(isi)];
    if !isi.tempat.is_empty() {
        baris.push(format!("Tempat: {}", potong(isi.tempat, 100)));
    }
    if !oleh.is_empty() {
        baris.push(format!("Oleh: {oleh}"));
    }
    if !isi.keterangan.is_empty() {
        baris.push(format!(
            "{}: {}",
            if oleh.is_empty() { "Catatan" } else { "Alasan" },
            potong(isi.keterangan, 300)
        ));
    }
    Some(tutup_pesan(baris, isi))
}

/// Cermin `pesanTripGantiIzin`. `isi.driver` = pelapor (driver yang meminta);
/// `dari`/`ke` = driver atau kendaraan sebelum dan sesudah ganti.
pub fn pesan_trip_ganti_izin(
    isi: &IsiLaporan<'_>,
    ganti_driver: bool,
    darurat: bool,
    dari: &str,
    ke: &str,
) -> String {
    let objek = if ganti_driver { "driver" } else { "kendaraan" };
    let mut baris = vec![
        if darurat {
            format!("🔁 Ganti {objek} darurat: {}", isi.nomor)
        } else {
            format!("🔁 Minta izin ganti {objek}: {}", isi.nomor)
        },
        format!("Dari: {dari}"),
        format!("Ke: {ke}"),
        format!("Dilaporkan oleh: {}", isi.driver),
    ];
    if !isi.keterangan.is_empty() {
        baris.push(format!("Alasan: {}", potong(isi.keterangan, 300)));
    }
    baris.push(
        if darurat {
            "Sudah berlaku. Setujui atau tolak di aplikasi."
        } else {
            "Berlaku setelah disetujui di aplikasi."
        }
        .to_owned(),
    );
    tutup_pesan(baris, isi)
}

/// Cermin `pesanTripLokasiPalsu`. Ditulis sebagai tanda tinjau, bukan vonis.
pub fn pesan_trip_lokasi_palsu(isi: &IsiLaporan<'_>, jenis_laporan: &str) -> String {
    let laporan = if isi.tempat.is_empty() {
        format!("Laporan: {jenis_laporan}")
    } else {
        format!("Laporan: {jenis_laporan} · {}", potong(isi.tempat, 100))
    };
    tutup_pesan(
        vec![
            "⚠️ Perlu ditinjau: lokasi palsu terdeteksi".to_owned(),
            format!("Surat jalan: {}", isi.nomor),
            laporan,
            baris_driver(isi),
        ],
        isi,
    )
}

/// Cermin `sisaHari`.
pub fn sisa_hari(sisa: i64) -> String {
    if sisa <= 0 {
        "hari ini".to_owned()
    } else {
        format!("{sisa} hari lagi")
    }
}

fn baris_karyawan(nama: &str, jabatan: &str) -> String {
    if jabatan.is_empty() {
        format!("Karyawan: {}", potong(nama, 100))
    } else {
        format!("Karyawan: {} · {}", potong(nama, 100), potong(jabatan, 60))
    }
}

/// Cermin `pesanHrKontrakAkhir`. Tanpa nomor kontrak.
pub fn pesan_hr_kontrak_akhir(nama: &str, jabatan: &str, tanggal: &str, sisa: i64) -> String {
    [
        format!(
            "📄 Kontrak PKWT berakhir {} ({})",
            sisa_hari(sisa),
            tanggal_tampil(tanggal)
        ),
        baris_karyawan(nama, jabatan),
    ]
    .join("
")
}

/// Cermin `pesanHrPercobaanAkhir`.
pub fn pesan_hr_percobaan_akhir(nama: &str, jabatan: &str, tanggal: &str, sisa: i64) -> String {
    [
        format!(
            "⏳ Masa percobaan berakhir {} ({})",
            sisa_hari(sisa),
            tanggal_tampil(tanggal)
        ),
        baris_karyawan(nama, jabatan),
    ]
    .join("
")
}

/// Cermin `pesanHrDokumenKedaluwarsa`. Jenis ya, nomor tidak (Q-105).
pub fn pesan_hr_dokumen_kedaluwarsa(
    jenis_dokumen: &str,
    nama: &str,
    jabatan: &str,
    tanggal: &str,
    sisa: i64,
) -> String {
    [
        format!(
            "🪪 Dokumen {} kedaluwarsa {} ({})",
            potong(jenis_dokumen, 60),
            sisa_hari(sisa),
            tanggal_tampil(tanggal)
        ),
        baris_karyawan(nama, jabatan),
    ]
    .join("
")
}

/// Cermin `pesanHrSpBerakhir`. Tingkat ya, isi SP tidak (Q-105).
pub fn pesan_hr_sp_berakhir(tingkat: &str, nama: &str, jabatan: &str, tanggal: &str) -> String {
    [
        format!(
            "📋 Masa berlaku {tingkat} berakhir {}",
            tanggal_tampil(tanggal)
        ),
        baris_karyawan(nama, jabatan),
    ]
    .join("
")
}

/// Cermin `pesanHrPengajuanMenunggu`. Hitungan per kelompok, tanpa nama
/// (Q-108); daftar tanpa isi tidak menghasilkan pesan. `hari` = angka
/// `hr_ingat_menunggu` yang dipakai SQL-nya.
pub fn pesan_hr_pengajuan_menunggu(daftar: &[(String, i64)], sejak: &str, hari: i64) -> Option<String> {
    let total: i64 = daftar.iter().map(|(_, jumlah)| jumlah).sum();
    if total <= 0 {
        return None;
    }
    Some(
        [
            format!("📥 {total} pengajuan menunggu lebih dari {hari} hari"),
            daftar
                .iter()
                .map(|(kelompok, jumlah)| format!("{kelompok} {jumlah}"))
                .collect::<Vec<_>>()
                .join(", "),
            format!("Paling lama sejak {}", tanggal_tampil(sejak)),
        ]
        .join("
"),
    )
}

/// Cermin `pesanHrUrgentBelumDiketahui`. Nol tidak menghasilkan pesan.
pub fn pesan_hr_urgent_belum_diketahui(jumlah: i64, sejak: &str) -> Option<String> {
    (jumlah > 0).then(|| {
        [
            format!("⚡ {jumlah} pengajuan urgent belum diketahui HRD"),
            format!("Paling lama sejak {}", tanggal_tampil(sejak)),
        ]
        .join("
")
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarisUltah {
    pub nama: String,
    pub jabatan: String,
    pub tahun: i64,
}

/// Cermin `pesanHrUlangTahunKerja`: sampai `MAKS_BARIS_STOK` baris.
pub fn pesan_hr_ulang_tahun_kerja(daftar: &[BarisUltah]) -> Option<String> {
    if daftar.is_empty() {
        return None;
    }
    let mut baris = vec!["🎉 Ulang tahun kerja hari ini".to_owned()];
    for item in daftar.iter().take(MAKS_BARIS_STOK) {
        baris.push(if item.jabatan.is_empty() {
            format!("• {}, {} tahun", potong(&item.nama, 100), item.tahun)
        } else {
            format!(
                "• {} ({}), {} tahun",
                potong(&item.nama, 100),
                potong(&item.jabatan, 60),
                item.tahun
            )
        });
    }
    if daftar.len() > MAKS_BARIS_STOK {
        baris.push(format!("dan {} lainnya.", daftar.len() - MAKS_BARIS_STOK));
    }
    Some(baris.join("
"))
}

/// Cermin `periodeKinerjaBerakhir`: periode `jenis` yang berakhir 1–7 hari
/// sebelum `hari_ini` (§24.4), sebagai `(mulai, selesai)`.
pub fn periode_kinerja_berakhir(jenis: &str, hari_ini: &str) -> Option<(String, String)> {
    let awal = hr_kinerja::awal_periode(jenis, hari_ini)?;
    let jarak = hris::nomor_hari(hari_ini)? - hris::nomor_hari(&awal)?;
    if jarak >= HR_HARI_JENDELA {
        return None;
    }
    let sebelum = hris::tambah_bulan(&awal, -1)?;
    let mulai = hr_kinerja::awal_periode(jenis, &sebelum)?;
    hr_kinerja::periode_rentang(jenis, &mulai).ok()
}

/// Satu baris `SQL_HR_KINERJA_MENUNGGU`. Cermin `PenilaianTunggu`.
#[derive(Debug, Clone, PartialEq)]
pub struct PenilaianTunggu {
    pub sidik: String,
    pub sejak: String,
    pub keputusan: Vec<KeputusanKinerja>,
}

/// Cermin `ringkasKinerjaMenunggu`: jumlah berstatus Diajukan dan tanggal
/// `Ajukan` yang paling lama.
pub fn ringkas_kinerja_menunggu(daftar: &[PenilaianTunggu]) -> (i64, String) {
    let tunggu: Vec<&PenilaianTunggu> = daftar
        .iter()
        .filter(|p| hr_kinerja::status_kinerja(&p.sidik, &p.keputusan) == hr_kinerja::STATUS_DIAJUKAN)
        .collect();
    let sejak = tunggu.iter().map(|p| p.sejak.clone()).min().unwrap_or_default();
    (i64::try_from(tunggu.len()).unwrap_or(i64::MAX), sejak)
}

/// Penilaian akar satu karyawan di `SQL_HR_KINERJA_PERIODE`.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct PenilaianPeriode {
    pub sidik: String,
    pub keputusan: Vec<KeputusanKinerja>,
}

/// Satu baris `SQL_HR_KINERJA_PERIODE`. Cermin `KaryawanPeriode`.
#[derive(Debug, Clone, PartialEq)]
pub struct KaryawanPeriode {
    pub tanggal_daftar: Option<String>,
    pub tanggal_selesai_aktif: Option<String>,
    pub penilaian: Vec<PenilaianPeriode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RingkasPeriode {
    pub belum: i64,
    pub draf: i64,
    pub diajukan: i64,
}

/// Cermin `ringkasKinerjaPeriode`. Wajib dinilai = rentang aktifnya
/// beririsan dengan periode (Q-118). Per karyawan: ada Final = selesai, ada
/// Diajukan = diajukan, ada penilaian lain = draf, tanpa penilaian = belum.
pub fn ringkas_kinerja_periode(daftar: &[KaryawanPeriode], mulai: &str, selesai: &str) -> RingkasPeriode {
    let mut hasil = RingkasPeriode::default();
    for k in daftar {
        if hr_kinerja::rentang_aktif(mulai, selesai, k.tanggal_daftar.as_deref(), k.tanggal_selesai_aktif.as_deref()).is_none() {
            continue;
        }
        let status: Vec<&str> = k
            .penilaian
            .iter()
            .map(|p| hr_kinerja::status_kinerja(&p.sidik, &p.keputusan))
            .filter(|s| *s != hr_kinerja::STATUS_DIBATALKAN)
            .collect();
        if status.contains(&hr_kinerja::STATUS_FINAL) {
            continue;
        }
        if status.contains(&hr_kinerja::STATUS_DIAJUKAN) {
            hasil.diajukan += 1;
        } else if !status.is_empty() {
            hasil.draf += 1;
        } else {
            hasil.belum += 1;
        }
    }
    hasil
}

/// Cermin `pesanHrKinerjaMenunggu`. Hanya angka (Q-117).
pub fn pesan_hr_kinerja_menunggu(jumlah: i64, sejak: &str) -> Option<String> {
    if jumlah <= 0 {
        return None;
    }
    let mut baris = vec![format!("📊 {jumlah} penilaian kinerja menunggu Final")];
    if !sejak.is_empty() {
        baris.push(format!("Paling lama sejak {}", tanggal_tampil(sejak)));
    }
    Some(baris.join("\n"))
}

/// Cermin `pesanHrKinerjaPeriode`. Semua nol tidak menghasilkan pesan.
pub fn pesan_hr_kinerja_periode(jenis: &str, mulai: &str, selesai: &str, r: RingkasPeriode) -> Option<String> {
    (r.belum + r.draf + r.diajukan > 0).then(|| {
        format!(
            "📊 Periode {jenis} {} s.d. {} berakhir: {} belum dinilai, {} masih draf, {} diajukan",
            tanggal_tampil(mulai),
            tanggal_tampil(selesai),
            r.belum,
            r.draf,
            r.diajukan
        )
    })
}

/// Cermin `pesanHrPelamarBaru`: tanpa nama pelamar (Q-86).
pub fn pesan_hr_pelamar_baru(daftar: &[(String, i64)]) -> Option<String> {
    let total: i64 = daftar.iter().map(|(_, jumlah)| jumlah).sum();
    if total <= 0 {
        return None;
    }
    let mut baris = vec![format!("👥 {total} pelamar baru kemarin")];
    for (judul, jumlah) in daftar.iter().take(MAKS_BARIS_STOK) {
        baris.push(format!("• {}: {jumlah}", potong(judul, 100)));
    }
    if daftar.len() > MAKS_BARIS_STOK {
        baris.push(format!("dan {} lainnya.", daftar.len() - MAKS_BARIS_STOK));
    }
    Some(baris.join("\n"))
}

/// Cermin `pesanHrLowonganTutup`.
pub fn pesan_hr_lowongan_tutup(judul: &str, tanggal: &str, sisa: i64, pelamar: i64, kuota: i64) -> String {
    [
        format!(
            "📢 Lowongan {} tutup {} ({})",
            potong(judul, 100),
            sisa_hari(sisa),
            tanggal_tampil(tanggal)
        ),
        format!("Pelamar: {pelamar} · Kuota: {kuota}"),
    ]
    .join("\n")
}

/// Isi pesan per pengajuan (Q-120): tanpa alasan dan nominal. Cermin
/// `IsiPengajuanHr`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsiPengajuanHr {
    pub kelompok: String,
    pub nama: String,
    pub jabatan: String,
    pub mulai: String,
    pub selesai: String,
}

fn baris_tanggal_pengajuan(mulai: &str, selesai: &str) -> String {
    if mulai == selesai {
        format!("Tanggal: {}", tanggal_tampil(mulai))
    } else {
        format!("Tanggal: {} s.d. {}", tanggal_tampil(mulai), tanggal_tampil(selesai))
    }
}

/// Cermin `pesanHrPengajuanBaru`. Sakit tanpa nama (Q-120 (b)).
pub fn pesan_hr_pengajuan_baru(isi: &IsiPengajuanHr) -> String {
    let kelompok = potong(&isi.kelompok, 30);
    let mut baris = if isi.kelompok == KELOMPOK_TANPA_NAMA {
        vec![format!("📝 1 pengajuan {kelompok} baru")]
    } else {
        vec![format!("📝 Pengajuan {kelompok} baru"), baris_karyawan(&isi.nama, &isi.jabatan)]
    };
    baris.push(baris_tanggal_pengajuan(&isi.mulai, &isi.selesai));
    baris.join("\n")
}

/// Cermin `pesanHrPengajuanDiputus`. Pemutus ya, alasan tidak (Q-32).
pub fn pesan_hr_pengajuan_diputus(isi: &IsiPengajuanHr, jenis: &str, oleh: &str) -> String {
    let kelompok = potong(&isi.kelompok, 30);
    let tolak = jenis == "Tolak";
    let hasil = if tolak {
        "ditolak"
    } else if jenis == "Setujui Urgent" {
        "disetujui (urgent)"
    } else {
        "disetujui"
    };
    let ikon = if tolak { "❌" } else { "✅" };
    let mut baris = if isi.kelompok == KELOMPOK_TANPA_NAMA {
        vec![format!("{ikon} 1 pengajuan {kelompok} {hasil}")]
    } else {
        vec![format!("{ikon} Pengajuan {kelompok} {hasil}"), baris_karyawan(&isi.nama, &isi.jabatan)]
    };
    baris.push(baris_tanggal_pengajuan(&isi.mulai, &isi.selesai));
    baris.push(format!("Oleh: {}", potong(oleh, 100)));
    baris.join("\n")
}

pub fn permintaan_kirim(token: &str, chat_id: &str, teks: &str) -> (String, Value) {
    (
        format!("https://api.telegram.org/bot{token}/sendMessage"),
        json!({ "chat_id": chat_id, "text": teks, "disable_web_page_preview": true }),
    )
}

/// Cermin `galatTelegram`.
pub fn galat_telegram(status: u16, badan: &str) -> Option<String> {
    let data: Value = serde_json::from_str(badan).unwrap_or(Value::Null);
    if (200..300).contains(&status) && data.get("ok") == Some(&Value::Bool(true)) {
        return None;
    }
    let penjelasan = data
        .get("description")
        .and_then(Value::as_str)
        .filter(|teks| !teks.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("HTTP {status}"));
    Some(format!("Telegram: {penjelasan}"))
}

/// Cermin `grupDariUpdates`.
pub fn grup_dari_updates(respons: &Value) -> Vec<(String, String)> {
    let mut daftar: Vec<(String, String)> = Vec::new();
    let Some(hasil) = respons.get("result").and_then(Value::as_array) else {
        return daftar;
    };
    for update in hasil {
        for jenis in ["message", "edited_message", "my_chat_member", "chat_member"] {
            let Some(isi) = update.get(jenis).filter(|isi| isi.is_object()) else {
                continue;
            };
            let Some(chat) = isi.get("chat") else {
                continue;
            };
            let tipe = chat.get("type").and_then(Value::as_str);
            if tipe != Some("group") && tipe != Some("supergroup") {
                continue;
            }
            let Some(id) = chat.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let id = id.to_string();
            let status_baru = isi
                .get("new_chat_member")
                .and_then(|anggota| anggota.get("status"))
                .and_then(Value::as_str);
            let posisi = daftar.iter().position(|(ada, _)| *ada == id);
            if jenis == "my_chat_member" && matches!(status_baru, Some("left" | "kicked")) {
                if let Some(posisi) = posisi {
                    daftar.remove(posisi);
                }
                continue;
            }
            let judul = chat
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| id.clone());
            match posisi {
                Some(posisi) => daftar[posisi].1 = judul,
                None => daftar.push((id, judul)),
            }
        }
    }
    daftar
}

// ── I/O ─────────────────────────────────────────────────────────────────────

fn text(row: &HashMap<String, Value>, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn int(row: &HashMap<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(value)) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|n| n as i64))
            .unwrap_or(0),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

struct Pengaturan {
    nilai: HashMap<String, String>,
}

impl Pengaturan {
    fn get(&self, kunci: &str) -> &str {
        self.nilai.get(kunci).map(String::as_str).unwrap_or("")
    }
    fn aktif(&self) -> bool {
        self.get(KUNCI_AKTIF) == "1"
    }
    fn token(&self) -> &str {
        self.get(KUNCI_TOKEN)
    }
    fn grup(&self, bidang: &str) -> &str {
        self.get(&format!("grup:{bidang}"))
    }
    fn kirim(&self, kejadian: &str) -> bool {
        self.get(&format!("kirim:{kejadian}")) == "1"
    }
    /// Kejadian ini akan dikirim: sakelarnya menyala dan grupnya sudah diatur.
    fn siap(&self, kejadian: &str) -> bool {
        self.kirim(kejadian)
            && bidang_kejadian(kejadian).is_some_and(|bidang| !self.grup(bidang).is_empty())
    }
}

async fn baca_pengaturan(turso: &TursoClient) -> Result<Pengaturan, CommandError> {
    let rows = turso
        .query_one(
            "SELECT kunci, nilai FROM app_telegram_setting LIMIT 100;",
            vec![],
        )
        .await?
        .to_objects();
    Ok(Pengaturan {
        nilai: rows
            .iter()
            .map(|row| (text(row, "kunci"), text(row, "nilai")))
            .collect(),
    })
}

fn http_galat(error: reqwest::Error) -> String {
    format!("Telegram tidak dapat dihubungi: {}", error.without_url())
}

async fn kirim_pesan(
    http: &reqwest::Client,
    token: &str,
    chat_id: &str,
    teks: &str,
) -> Result<(), String> {
    let (url, body) = permintaan_kirim(token, chat_id, teks);
    let response = http
        .post(url)
        .json(&body)
        .timeout(TELEGRAM_TIMEOUT)
        .send()
        .await
        .map_err(http_galat)?;
    let status = response.status().as_u16();
    let badan = response.text().await.unwrap_or_default();
    match galat_telegram(status, &badan) {
        Some(galat) => Err(samarkan_token(&galat, token)),
        None => Ok(()),
    }
}

fn tidak_valid(pesan: &str) -> CommandError {
    CommandError::new("VALIDATION_ERROR", pesan)
}

/// Konfigurasi untuk kartu Pengaturan. Token TIDAK pernah dikembalikan: hanya
/// apakah ada dan empat karakter terakhirnya.
pub async fn get_config(turso: &TursoClient) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let pengaturan = baca_pengaturan(turso).await?;
    let token = pengaturan.token();
    let riwayat = turso
        .query_one(
            "SELECT id_notifikasi, kejadian, status, COALESCE(last_error, '') AS last_error, datetime(created_at, '+7 hours') AS dibuat, COALESCE(sent_at, '') AS sent_at FROM notifikasi_telegram ORDER BY created_at DESC, id_notifikasi DESC LIMIT 10;",
            vec![],
        )
        .await?
        .to_objects();
    let grup: serde_json::Map<String, Value> = BIDANG
        .iter()
        .map(|bidang| ((*bidang).to_owned(), json!(pengaturan.grup(bidang))))
        .collect();
    let kirim: serde_json::Map<String, Value> = KEJADIAN
        .iter()
        .map(|kejadian| ((*kejadian).to_owned(), json!(pengaturan.kirim(kejadian))))
        .collect();
    Ok(json!({
        "aktif": pengaturan.aktif(),
        "tokenTersimpan": !token.is_empty(),
        "tokenAkhir": token.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>(),
        "grup": grup,
        "kirim": kirim,
        "riwayat": riwayat.iter().map(|row| json!({
            "id": text(row, "id_notifikasi"),
            "kejadian": text(row, "kejadian"),
            "status": text(row, "status"),
            "galat": text(row, "last_error"),
            "dibuat": text(row, "dibuat"),
            "terkirim": text(row, "sent_at"),
        })).collect::<Vec<_>>(),
    }))
}

/// Draft tervalidasi: kunci sama persis dengan `TelegramConfigDraft`; kunci
/// asing atau yang hilang ditolak, bukan dianggap kosong.
struct Draft {
    aktif: bool,
    bot_token: String,
    grup: Vec<(&'static str, String)>,
    kirim: Vec<(&'static str, bool)>,
}

fn objek_persis<'a>(
    nilai: Option<&'a Value>,
    kunci: &[&str],
    nama: &str,
) -> Result<&'a serde_json::Map<String, Value>, CommandError> {
    let objek = nilai
        .and_then(Value::as_object)
        .ok_or_else(|| tidak_valid(&format!("Bagian '{nama}' wajib diisi.")))?;
    if objek.len() != kunci.len() || !kunci.iter().all(|k| objek.contains_key(*k)) {
        return Err(tidak_valid(&format!(
            "Bagian '{nama}' wajib berisi tepat: {}.",
            kunci.join(", ")
        )));
    }
    Ok(objek)
}

fn baca_draft(draft: &Value) -> Result<Draft, CommandError> {
    let akar = objek_persis(
        Some(draft),
        &["aktif", "botToken", "grup", "kirim"],
        "draft",
    )?;
    let aktif = akar["aktif"]
        .as_bool()
        .ok_or_else(|| tidak_valid("Nilai 'aktif' harus benar/salah."))?;
    let bot_token = akar["botToken"]
        .as_str()
        .ok_or_else(|| tidak_valid("Token bot harus berupa teks."))?
        .trim()
        .to_owned();
    if !bot_token.is_empty() && !token_bot_valid(&bot_token) {
        return Err(tidak_valid(
            "Token bot tidak valid. Salin utuh dari BotFather, contoh 123456789:AAH...",
        ));
    }
    let grup_objek = objek_persis(akar.get("grup"), &BIDANG, "grup")?;
    let mut grup = Vec::new();
    for bidang in BIDANG {
        let raw = grup_objek[bidang]
            .as_str()
            .ok_or_else(|| tidak_valid("Id grup harus berupa teks."))?;
        let id = normalisasi_chat_id(raw).ok_or_else(|| {
            tidak_valid(&format!(
                "Id grup {} tidak valid. Pakai tombol Cari grup.",
                label_bidang(bidang)
            ))
        })?;
        grup.push((bidang, id));
    }
    let kirim_objek = objek_persis(akar.get("kirim"), &KEJADIAN, "kirim")?;
    let mut kirim = Vec::new();
    for kejadian in KEJADIAN {
        let nyala = kirim_objek[kejadian]
            .as_bool()
            .ok_or_else(|| tidak_valid("Sakelar kejadian harus benar/salah."))?;
        kirim.push((kejadian, nyala));
    }
    Ok(Draft {
        aktif,
        bot_token,
        grup,
        kirim,
    })
}

pub async fn save_config(turso: &TursoClient, draft: &Value) -> Result<Value, CommandError> {
    let draft = baca_draft(draft)?;
    turso.ensure_schema_current().await?;
    let lama = baca_pengaturan(turso).await?;
    if draft.aktif && draft.bot_token.is_empty() && lama.token().is_empty() {
        return Err(tidak_valid(
            "Isi token bot lebih dulu sebelum mengaktifkan notifikasi Telegram.",
        ));
    }
    let setting = |kunci: &str, nilai: String| {
        Statement::new(UPSERT_SETTING_SQL, vec![json!(kunci), json!(nilai)])
    };
    let mut statements = vec![setting(
        KUNCI_AKTIF,
        if draft.aktif { "1" } else { "0" }.to_owned(),
    )];
    if !draft.bot_token.is_empty() {
        statements.push(setting(KUNCI_TOKEN, draft.bot_token.clone()));
    }
    // Kejadian sebelum Telegram dinyalakan tidak pernah dikirim.
    if draft.aktif && (!lama.aktif() || lama.get(KUNCI_AKTIF_SEJAK).is_empty()) {
        statements.push(Statement::new(
            "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, datetime('now'), datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;",
            vec![json!(KUNCI_AKTIF_SEJAK)],
        ));
    }
    for (bidang, id) in &draft.grup {
        statements.push(setting(&format!("grup:{bidang}"), id.clone()));
    }
    for (kejadian, nyala) in &draft.kirim {
        statements.push(setting(
            &format!("kirim:{kejadian}"),
            if *nyala { "1" } else { "0" }.to_owned(),
        ));
    }
    turso.execute_atomic(statements).await?;
    get_config(turso).await
}

async fn token_dipakai(turso: &TursoClient, dikirim: &str) -> Result<String, CommandError> {
    let dikirim = dikirim.trim();
    if !dikirim.is_empty() {
        if !token_bot_valid(dikirim) {
            return Err(tidak_valid("Token bot tidak valid."));
        }
        return Ok(dikirim.to_owned());
    }
    let pengaturan = baca_pengaturan(turso).await?;
    if pengaturan.token().is_empty() {
        return Err(tidak_valid("Isi token bot lebih dulu."));
    }
    Ok(pengaturan.token().to_owned())
}

/// Grup yang terlihat bot dalam 24 jam terakhir (`getUpdates`).
pub async fn find_groups(
    turso: &TursoClient,
    http: &reqwest::Client,
    bot_token: &str,
) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let token = token_dipakai(turso, bot_token).await?;
    let response = http
        .post(format!("https://api.telegram.org/bot{token}/getUpdates"))
        .json(&json!({}))
        .timeout(TELEGRAM_TIMEOUT)
        .send()
        .await
        .map_err(|error| CommandError::new("NETWORK_ERROR", http_galat(error)))?;
    let status = response.status().as_u16();
    let badan = response.text().await.unwrap_or_default();
    if let Some(galat) = galat_telegram(status, &badan) {
        return Err(CommandError::new(
            "TELEGRAM_ERROR",
            samarkan_token(&galat, &token),
        ));
    }
    let respons: Value = serde_json::from_str(&badan).unwrap_or(Value::Null);
    Ok(json!({
        "grup": grup_dari_updates(&respons)
            .into_iter()
            .map(|(id, judul)| json!({ "id": id, "judul": judul }))
            .collect::<Vec<_>>(),
    }))
}

/// Kirim pesan uji langsung, tanpa antrean, supaya hasilnya terlihat seketika.
pub async fn send_test(
    turso: &TursoClient,
    http: &reqwest::Client,
    draft: &Value,
) -> Result<Value, CommandError> {
    let akar = objek_persis(Some(draft), &["bidang", "chatId", "botToken"], "uji")?;
    let bidang = akar["bidang"].as_str().unwrap_or("");
    if !BIDANG.contains(&bidang) {
        return Err(tidak_valid("Bidang tidak dikenal."));
    }
    let chat_id = normalisasi_chat_id(akar["chatId"].as_str().unwrap_or(""))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| tidak_valid("Id grup belum diisi atau tidak valid."))?;
    turso.ensure_schema_current().await?;
    let token = token_dipakai(turso, akar["botToken"].as_str().unwrap_or("")).await?;
    let teks = format!(
        "Pesan uji notifikasi Telegram. Grup ini akan menerima notifikasi bidang {}.",
        label_bidang(bidang)
    );
    kirim_pesan(http, &token, &chat_id, &teks)
        .await
        .map_err(|galat| CommandError::new("TELEGRAM_ERROR", galat))?;
    Ok(json!({ "terkirim": true }))
}

fn hasil(sukses: bool, angka: [i64; 4], pesan: impl Into<String>) -> Value {
    let [diproses, terkirim, gagal, dibatalkan] = angka;
    json!({
        "sukses": sukses,
        "diproses": diproses,
        "terkirim": terkirim,
        "gagal": gagal,
        "dibatalkan": dibatalkan,
        "pesan": pesan.into(),
    })
}

async fn antrekan(
    turso: &TursoClient,
    id: &str,
    kejadian: &str,
    isi: &str,
) -> Result<(), CommandError> {
    turso
        .query_one(
            INSERT_ANTREAN_SQL,
            vec![json!(id), json!(kejadian), json!(isi)],
        )
        .await?;
    Ok(())
}

/// Kejadian HR masuk antrean dalam keadaan parkir (§23.2).
async fn antrekan_parkir(
    turso: &TursoClient,
    id: &str,
    kejadian: &str,
    isi: &str,
) -> Result<(), CommandError> {
    turso
        .query_one(
            INSERT_ANTREAN_PARKIR_SQL,
            vec![json!(id), json!(kejadian), json!(isi)],
        )
        .await?;
    Ok(())
}

/// Catat kejadian baru dari data ke antrean. Idempoten: id deterministik.
async fn catat_kejadian(turso: &TursoClient, pengaturan: &Pengaturan) -> Result<(), CommandError> {
    let sejak = pengaturan.get(KUNCI_AKTIF_SEJAK).to_owned();
    if sejak.is_empty() {
        return Ok(());
    }
    if pengaturan.siap("pengajuan_baru") {
        let rows = turso
            .query_one(SQL_PENGAJUAN_BARU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_pengajuan_baru(
                &text(&row, "nomor"),
                &text(&row, "keperluan"),
                int(&row, "total"),
                int(&row, "jumlah_baris"),
                &text(&row, "pengaju"),
                &text(&row, "cara_bayar"),
            );
            let id = format!("pgj-baru:{}", text(&row, "id_pengajuan"));
            antrekan(turso, &id, "pengajuan_baru", &isi).await?;
        }
    }
    if pengaturan.siap("pengajuan_putus") {
        let rows = turso
            .query_one(SQL_PENGAJUAN_PUTUS, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_pengajuan_putus(
                &text(&row, "nomor"),
                &text(&row, "keperluan"),
                int(&row, "total"),
                int(&row, "disetujui") == 1,
                &text(&row, "pemutus"),
                &text(&row, "catatan"),
            );
            let id = format!("pgj-putus:{}", text(&row, "id_pengajuan"));
            antrekan(turso, &id, "pengajuan_putus", &isi).await?;
        }
    }
    if pengaturan.siap("kasbon_baru") {
        let rows = turso
            .query_one(SQL_KASBON_BARU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_kasbon_baru(
                int(&row, "pokok"),
                int(&row, "cicilan"),
                &text(&row, "mulai_potong"),
            );
            let id = format!("kasbon:{}", text(&row, "id_pinjaman"));
            antrekan(turso, &id, "kasbon_baru", &isi).await?;
        }
    }
    if pengaturan.siap("tutup_buku") {
        let rows = turso
            .query_one(SQL_TUTUP_BUKU, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_tutup_buku(
                &text(&row, "sampai_tanggal"),
                &text(&row, "oleh"),
                text(&row, "status") == "Menunggu",
            );
            let id = format!("tutup:{}", text(&row, "id_tutup"));
            antrekan(turso, &id, "tutup_buku", &isi).await?;
        }
        catat_buka_buku(turso, &sejak, AWALAN_BUKA, "tutup_buku").await?;
    }
    if pengaturan.siap("buka_buku_pimpinan") {
        catat_buka_buku(turso, &sejak, AWALAN_BUKA_PIMPINAN, "buka_buku_pimpinan").await?;
    }
    if pengaturan.siap("gaji_status") {
        let rows = turso
            .query_one(SQL_GAJI_STATUS, vec![json!(sejak)])
            .await?
            .to_objects();
        for row in rows {
            let isi = pesan_gaji_status(
                &text(&row, "new_status"),
                &text(&row, "period_start"),
                &text(&row, "period_end"),
                int(&row, "total_employees"),
                int(&row, "total_net_payout"),
                &text(&row, "oleh"),
                &text(&row, "notes"),
            );
            if let Some(isi) = isi {
                let id = format!("gaji:{}", text(&row, "id"));
                antrekan(turso, &id, "gaji_status", &isi).await?;
            }
        }
    }
    catat_armada(turso, pengaturan, &sejak).await?;
    catat_pengajuan_hr(turso, pengaturan, &sejak).await?;
    catat_harian(turso, pengaturan).await
}

fn isi_pengajuan_hr(row: &HashMap<String, Value>) -> IsiPengajuanHr {
    IsiPengajuanHr {
        kelompok: text(row, "kelompok"),
        nama: text(row, "nama"),
        jabatan: text(row, "jabatan"),
        mulai: text(row, "tanggal_mulai"),
        selesai: text(row, "tanggal_selesai"),
    }
}

/// Kejadian per pengajuan HR ke grup HRD (§24.4, Q-120, Q-121), diparkir.
/// Cermin `catatPengajuanHr`. `sejak` = `aktif_sejak`; batas 7 hari jam cloud
/// dan id-nya diperiksa di SQL sumber.
async fn catat_pengajuan_hr(
    turso: &TursoClient,
    pengaturan: &Pengaturan,
    sejak: &str,
) -> Result<(), CommandError> {
    if pengaturan.siap("hr_pengajuan_baru") {
        for row in baris(turso, SQL_HR_PENGAJUAN_BARU, vec![json!(sejak)]).await? {
            let isi = pesan_hr_pengajuan_baru(&isi_pengajuan_hr(&row));
            let id = id_hr_ajuan(&text(&row, "id_pengajuan"));
            antrekan_parkir(turso, &id, "hr_pengajuan_baru", &isi).await?;
        }
    }
    if pengaturan.siap("hr_pengajuan_diputus") {
        for row in baris(turso, SQL_HR_PENGAJUAN_PUTUS, vec![json!(sejak)]).await? {
            let isi = pesan_hr_pengajuan_diputus(&isi_pengajuan_hr(&row), &text(&row, "jenis"), &text(&row, "oleh"));
            let id = id_hr_putus(&text(&row, "id_keputusan"));
            antrekan_parkir(turso, &id, "hr_pengajuan_diputus", &isi).await?;
        }
    }
    Ok(())
}

/// Driver dan kendaraan yang bertugas TEPAT SEBELUM laporan `row`, menurut
/// laporan ganti yang berlaku saat itu (keputusan yang datang belakangan tidak
/// dihitung). Cermin `tugasSebelum`.
async fn tugas_sebelum(
    turso: &TursoClient,
    row: &HashMap<String, Value>,
) -> Result<Penugasan, CommandError> {
    let semua = turso
        .query_one(SQL_TRIP_LAPORAN, vec![json!(text(row, "id_perjalanan"))])
        .await?
        .to_objects();
    let opsi = |baris: &HashMap<String, Value>, kunci: &str| {
        Some(text(baris, kunci)).filter(|nilai| !nilai.is_empty())
    };
    let milik: Vec<[Option<String>; 7]> = semua
        .iter()
        .map(|baris| {
            [
                "id_laporan",
                "jenis",
                "mode_ganti",
                "id_ref",
                "waktu_perangkat",
                "id_karyawan_baru",
                "id_kendaraan_baru",
            ]
            .map(|kunci| opsi(baris, kunci))
        })
        .collect();
    let sasaran = (text(row, "waktu_perangkat"), text(row, "id_laporan"));
    let laporan: Vec<Laporan<'_>> = milik
        .iter()
        .map(|[id, jenis, mode, id_ref, waktu, karyawan, kendaraan]| Laporan {
            id_laporan: id.as_deref().unwrap_or(""),
            jenis: jenis.as_deref().unwrap_or(""),
            mode_ganti: mode.as_deref(),
            id_ref: id_ref.as_deref(),
            waktu_perangkat: waktu.as_deref().unwrap_or(""),
            id_karyawan_baru: karyawan.as_deref(),
            id_kendaraan_baru: kendaraan.as_deref(),
            ..Default::default()
        })
        .filter(|l| (l.waktu_perangkat, l.id_laporan) < (sasaran.0.as_str(), sasaran.1.as_str()))
        .collect();
    Ok(penugasan(
        &text(row, "awal_karyawan"),
        &text(row, "awal_kendaraan"),
        &laporan,
    ))
}

/// Isi kolom pertama baris pertama `sql`, atau kosong.
async fn satu_teks(
    turso: &TursoClient,
    sql: &str,
    id: &str,
    kolom: &str,
) -> Result<String, CommandError> {
    if id.is_empty() {
        return Ok(String::new());
    }
    Ok(turso
        .query_one(sql, vec![json!(id)])
        .await?
        .to_objects()
        .first()
        .map(|baris| text(baris, kolom))
        .unwrap_or_default())
}

/// Nama personil; bila tidak ada di `master_data`, `cadangan`, lalu id-nya.
async fn nama_personil(
    turso: &TursoClient,
    id: &str,
    cadangan: &str,
) -> Result<String, CommandError> {
    let nama = satu_teks(turso, SQL_NAMA_PERSONIL, id, "nama").await?;
    let pilihan = [nama.as_str(), cadangan, id]
        .into_iter()
        .find(|nilai| !nilai.is_empty())
        .unwrap_or("-")
        .to_owned();
    Ok(pilihan)
}

/// `<jenis> <identitas>`; kendaraan yang tidak dikenal = id-nya.
async fn label_kendaraan(turso: &TursoClient, id: &str) -> Result<String, CommandError> {
    let label = satu_teks(turso, SQL_LABEL_KENDARAAN, id, "label").await?;
    Ok(if label.is_empty() { id.to_owned() } else { label })
}

/// Kejadian perjalanan (v34) ke grup Armada. Cermin `catatArmada`. Driver di
/// pesan = pelapor bila laporan dari HP driver, selain itu driver yang
/// bertugas; kendaraan = yang bertugas saat kejadian.
async fn catat_armada(
    turso: &TursoClient,
    pengaturan: &Pengaturan,
    sejak: &str,
) -> Result<(), CommandError> {
    let mut sumber: Vec<(&str, &str, Vec<Value>, String)> = Vec::new();
    if pengaturan.siap("trip_kendala") {
        sumber.push(("trip_kendala", SQL_TRIP_KENDALA, vec![json!(sejak)], String::new()));
    }
    for (jenis, kejadian, awalan) in TRIP_TUTUP {
        if pengaturan.siap(kejadian) {
            sumber.push((
                kejadian,
                SQL_TRIP_TUTUP,
                vec![json!(sejak), json!(jenis), json!(awalan)],
                awalan.to_owned(),
            ));
        }
    }
    if pengaturan.siap("trip_ganti_izin") {
        sumber.push(("trip_ganti_izin", SQL_TRIP_GANTI_IZIN, vec![json!(sejak)], String::new()));
    }
    if pengaturan.siap("trip_lokasi_palsu") {
        sumber.push(("trip_lokasi_palsu", SQL_TRIP_LOKASI_PALSU, vec![json!(sejak)], String::new()));
    }

    for (kejadian, sql, args, awalan) in sumber {
        let rows = turso.query_one(sql, args).await?.to_objects();
        for row in rows {
            let tugas = tugas_sebelum(turso, &row).await?;
            let pelapor = text(&row, "id_karyawan");
            let oleh = text(&row, "oleh");
            let driver = if pelapor.is_empty() {
                nama_personil(turso, &tugas.id_karyawan, "").await?
            } else {
                nama_personil(turso, &pelapor, &oleh).await?
            };
            let jenis = text(&row, "jenis");
            let ganti_driver = jenis == "Ganti Driver";
            let kendaraan = if kejadian == "trip_ganti_izin" {
                String::new()
            } else {
                label_kendaraan(turso, &tugas.id_kendaraan).await?
            };
            let (nomor, tempat, keterangan, waktu) = (
                text(&row, "nomor"),
                text(&row, "nama_lokasi"),
                text(&row, "keterangan"),
                text(&row, "waktu_wib"),
            );
            let isi = IsiLaporan {
                nomor: &nomor,
                driver: &driver,
                kendaraan: &kendaraan,
                tempat: &tempat,
                keterangan: &keterangan,
                waktu: &waktu,
                telat_menit: int(&row, "telat_menit"),
            };
            let id_laporan = text(&row, "id_laporan");
            let (id, pesan) = match kejadian {
                "trip_kendala" => (
                    id_trip_kendala(&id_laporan),
                    Some(pesan_trip_kendala(
                        &isi,
                        &text(&row, "jenis_kendala"),
                        Some(int(&row, "terlambat_menit")),
                    )),
                ),
                "trip_ganti_izin" => {
                    let (dari, ke) = if ganti_driver {
                        (
                            nama_personil(turso, &tugas.id_karyawan, "").await?,
                            nama_personil(turso, &text(&row, "id_karyawan_baru"), "").await?,
                        )
                    } else {
                        (
                            label_kendaraan(turso, &tugas.id_kendaraan).await?,
                            label_kendaraan(turso, &text(&row, "id_kendaraan_baru")).await?,
                        )
                    };
                    (
                        id_trip_ganti_izin(&id_laporan),
                        Some(pesan_trip_ganti_izin(
                            &isi,
                            ganti_driver,
                            text(&row, "mode_ganti") == "Darurat",
                            &dari,
                            &ke,
                        )),
                    )
                }
                "trip_lokasi_palsu" => (
                    id_trip_lokasi_palsu(&id_laporan),
                    Some(pesan_trip_lokasi_palsu(&isi, &jenis)),
                ),
                _ => (
                    format!("{awalan}{}", text(&row, "id_perjalanan")),
                    pesan_trip_tutup(&isi, &jenis, if pelapor.is_empty() { &oleh } else { "" }),
                ),
            };
            if let Some(pesan) = pesan {
                antrekan(turso, &id, kejadian, &pesan).await?;
            }
        }
    }
    Ok(())
}

/// Cermin `catatBukaBuku`: awalan id menentukan grup tujuannya.
async fn catat_buka_buku(
    turso: &TursoClient,
    sejak: &str,
    awalan: &str,
    kejadian: &str,
) -> Result<(), CommandError> {
    let rows = turso
        .query_one(SQL_BUKA_BUKU, vec![json!(sejak), json!(awalan)])
        .await?
        .to_objects();
    for row in rows {
        let isi = pesan_buka_buku(
            &text(&row, "sampai_tanggal"),
            &text(&row, "oleh"),
            &text(&row, "alasan_buka"),
        );
        let id = format!("{awalan}{}", text(&row, "id_tutup"));
        antrekan(turso, &id, kejadian, &isi).await?;
    }
    Ok(())
}

async fn belum_tercatat(turso: &TursoClient, id: &str) -> Result<bool, CommandError> {
    Ok(turso
        .query_one(
            "SELECT 1 AS ada FROM notifikasi_telegram WHERE id_notifikasi = ? LIMIT 1;",
            vec![json!(id)],
        )
        .await?
        .to_objects()
        .is_empty())
}

/// Cermin `catatHarian`: kejadian berbasis tanggal menurut jam WIB database.
/// Stok sekali per tanggal; pengingat HR lihat `catat_hrd`.
async fn catat_harian(turso: &TursoClient, pengaturan: &Pengaturan) -> Result<(), CommandError> {
    if !pengaturan.siap("stok_menipis") && !KEJADIAN.iter().any(|k| diparkir(k) && pengaturan.siap(k)) {
        return Ok(());
    }
    let jam = turso.query_one(SQL_JAM_WIB, vec![]).await?.to_objects();
    let Some(jam) = jam.first() else {
        return Ok(());
    };
    catat_harian_pada(
        turso,
        pengaturan,
        &text(jam, "tanggal"),
        int(jam, "jam"),
        int(jam, "jam_hr"),
    )
    .await
}

/// `tanggal`/`jam`/`jam_hr` dari `SQL_JAM_WIB`. Dipisah supaya batas jam bisa
/// diuji tanpa bergantung jam saat tes berjalan. Stok tetap mulai
/// `JAM_RINGKASAN_STOK`, pengingat HR mulai `hr_ingat_jam` (§24.3).
async fn catat_harian_pada(
    turso: &TursoClient,
    pengaturan: &Pengaturan,
    tanggal: &str,
    jam: i64,
    jam_hr: i64,
) -> Result<(), CommandError> {
    if jam >= JAM_RINGKASAN_STOK && pengaturan.siap("stok_menipis") {
        catat_stok(turso, tanggal).await?;
    }
    if jam >= jam_hr {
        catat_hrd(turso, pengaturan, tanggal).await?;
    }
    Ok(())
}

async fn catat_stok(turso: &TursoClient, tanggal: &str) -> Result<(), CommandError> {
    let id_stok = format!("stok:{tanggal}");
    if belum_tercatat(turso, &id_stok).await? {
        let daftar: Vec<BarisStok> = turso
            .query_one(SQL_STOK_MENIPIS, vec![])
            .await?
            .to_objects()
            .iter()
            .map(|row| BarisStok {
                kode: text(row, "kode_barang"),
                nama: text(row, "nama_barang"),
                satuan: text(row, "satuan"),
                desimal: int(row, "desimal") == 1,
                stok: int(row, "stok_baik"),
                minimum: int(row, "stok_minimum"),
            })
            .collect();
        if let Some(isi) = pesan_stok_menipis(&daftar) {
            antrekan(turso, &id_stok, "stok_menipis", &isi).await?;
        }
    }
    Ok(())
}

async fn baris(
    turso: &TursoClient,
    sql: &str,
    args: Vec<Value>,
) -> Result<Vec<HashMap<String, Value>>, CommandError> {
    Ok(turso.query_one(sql, args).await?.to_objects())
}

/// Pengingat HR ke grup HRD (§23.3). Cermin `catatHrd`. Pengingat per
/// karyawan memeriksa id-nya di SQL sumber (`NOT EXISTS`); tiga ringkasan
/// harian lewat `belum_tercatat` seperti stok. Semua masuk antrean diparkir.
async fn catat_hrd(
    turso: &TursoClient,
    pengaturan: &Pengaturan,
    tanggal: &str,
) -> Result<(), CommandError> {
    if pengaturan.siap("hr_kontrak_akhir") {
        for row in baris(turso, SQL_HR_KONTRAK, vec![]).await? {
            let sisa = int(&row, "sisa");
            let isi = pesan_hr_kontrak_akhir(
                &text(&row, "nama"),
                &text(&row, "jabatan"),
                &text(&row, "tanggal_selesai"),
                sisa,
            );
            let id = id_hr_kontrak(&text(&row, "id_kontrak"), sisa, int(&row, "dekat"));
            antrekan_parkir(turso, &id, "hr_kontrak_akhir", &isi).await?;
        }
    }
    if pengaturan.siap("hr_percobaan_akhir") {
        for row in baris(turso, SQL_HR_PERCOBAAN, vec![]).await? {
            let isi = pesan_hr_percobaan_akhir(
                &text(&row, "nama"),
                &text(&row, "jabatan"),
                &text(&row, "percobaan_selesai"),
                int(&row, "sisa"),
            );
            let id = id_hr_percobaan(&text(&row, "id_kontrak"));
            antrekan_parkir(turso, &id, "hr_percobaan_akhir", &isi).await?;
        }
    }
    if pengaturan.siap("hr_dokumen_kedaluwarsa") {
        for row in baris(turso, SQL_HR_DOKUMEN, vec![]).await? {
            let tanggal_kedaluwarsa = text(&row, "tanggal_kedaluwarsa");
            let isi = pesan_hr_dokumen_kedaluwarsa(
                &text(&row, "jenis_dokumen"),
                &text(&row, "nama"),
                &text(&row, "jabatan"),
                &tanggal_kedaluwarsa,
                int(&row, "sisa"),
            );
            let id = id_hr_dokumen(&text(&row, "id_dokumen"), &tanggal_kedaluwarsa);
            antrekan_parkir(turso, &id, "hr_dokumen_kedaluwarsa", &isi).await?;
        }
    }
    let sejak = pengaturan.get(KUNCI_AKTIF_SEJAK);
    if pengaturan.siap("hr_sp_berakhir") && !sejak.is_empty() {
        for row in baris(turso, SQL_HR_SP, vec![json!(sejak)]).await? {
            let isi = pesan_hr_sp_berakhir(
                &text(&row, "tingkat"),
                &text(&row, "nama"),
                &text(&row, "jabatan"),
                &text(&row, "berlaku_sampai"),
            );
            antrekan_parkir(turso, &id_hr_sp(&text(&row, "id_sp")), "hr_sp_berakhir", &isi).await?;
        }
    }

    let id = id_hr_menunggu(tanggal);
    if pengaturan.siap("hr_pengajuan_menunggu") && belum_tercatat(turso, &id).await? {
        let rows = baris(turso, SQL_HR_MENUNGGU, vec![]).await?;
        let daftar: Vec<(String, i64)> = rows
            .iter()
            .map(|row| (text(row, "kelompok"), int(row, "jumlah")))
            .collect();
        let paling_lama = rows.iter().map(|row| text(row, "sejak")).min().unwrap_or_default();
        let hari = rows.first().map(|row| int(row, "hari")).unwrap_or_default();
        if let Some(isi) = pesan_hr_pengajuan_menunggu(&daftar, &paling_lama, hari) {
            antrekan_parkir(turso, &id, "hr_pengajuan_menunggu", &isi).await?;
        }
    }
    let id = id_hr_urgent(tanggal);
    if pengaturan.siap("hr_urgent_belum_diketahui") && belum_tercatat(turso, &id).await? {
        let rows = baris(turso, SQL_HR_URGENT, vec![]).await?;
        if let Some(row) = rows.first() {
            if let Some(isi) = pesan_hr_urgent_belum_diketahui(int(row, "jumlah"), &text(row, "sejak")) {
                antrekan_parkir(turso, &id, "hr_urgent_belum_diketahui", &isi).await?;
            }
        }
    }
    let id = id_hr_ultah(tanggal);
    if pengaturan.siap("hr_ulang_tahun_kerja") && belum_tercatat(turso, &id).await? {
        let daftar: Vec<BarisUltah> = baris(turso, SQL_HR_ULTAH, vec![])
            .await?
            .iter()
            .map(|row| BarisUltah {
                nama: text(row, "nama"),
                jabatan: text(row, "jabatan"),
                tahun: int(row, "tahun"),
            })
            .collect();
        if let Some(isi) = pesan_hr_ulang_tahun_kerja(&daftar) {
            antrekan_parkir(turso, &id, "hr_ulang_tahun_kerja", &isi).await?;
        }
    }
    catat_kinerja_rekrutmen(turso, pengaturan, tanggal).await
}

/// Keputusan kinerja dari kolom JSON SQL sumber; JSON rusak = tanpa keputusan.
fn keputusan_json<T: serde::de::DeserializeOwned>(row: &HashMap<String, Value>, kunci: &str) -> Vec<T> {
    serde_json::from_str(&text(row, kunci)).unwrap_or_default()
}

/// Ringkasan "menunggu Final" dari cloud. Cermin `ringkasMenungguCloud`.
async fn ringkas_menunggu_cloud(turso: &TursoClient) -> Result<(i64, String), CommandError> {
    let daftar: Vec<PenilaianTunggu> = baris(turso, SQL_HR_KINERJA_MENUNGGU, vec![])
        .await?
        .iter()
        .map(|row| PenilaianTunggu {
            sidik: text(row, "sidik"),
            sejak: text(row, "sejak"),
            keputusan: keputusan_json(row, "keputusan"),
        })
        .collect();
    Ok(ringkas_kinerja_menunggu(&daftar))
}

/// Jenis periode kinerja yang berlaku di cloud; kosong atau rusak = bawaan.
/// Cermin `jenisPeriodeCloud`.
async fn jenis_periode_cloud(turso: &TursoClient) -> Result<String, CommandError> {
    let nilai = baris(turso, SQL_HR_KINERJA_JENIS, vec![])
        .await?
        .first()
        .map(|row| text(row, "value"))
        .unwrap_or_default();
    Ok(hr_kinerja::PengaturanKinerja::dari_peta(&HashMap::from([(hr_kinerja::KUNCI_PERIODE.to_owned(), nilai)])).periode)
}

/// Ringkasan satu periode dari cloud. Cermin `ringkasPeriodeCloud`.
async fn ringkas_periode_cloud(
    turso: &TursoClient,
    jenis: &str,
    mulai: &str,
    selesai: &str,
) -> Result<RingkasPeriode, CommandError> {
    let daftar: Vec<KaryawanPeriode> = baris(turso, SQL_HR_KINERJA_PERIODE, vec![json!(jenis), json!(mulai)])
        .await?
        .iter()
        .map(|row| KaryawanPeriode {
            tanggal_daftar: Some(text(row, "tanggal_daftar")).filter(|t| !t.is_empty()),
            tanggal_selesai_aktif: Some(text(row, "tanggal_selesai_aktif")).filter(|t| !t.is_empty()),
            penilaian: keputusan_json(row, "penilaian"),
        })
        .collect();
    Ok(ringkas_kinerja_periode(&daftar, mulai, selesai))
}

/// Kejadian kinerja dan rekrutmen berbasis tanggal (§24.4). Cermin
/// `catatKinerjaRekrutmen`. Kinerja hanya angka (Q-117), rekrutmen tanpa
/// data pelamar (Q-86). Ringkasan sekali per tanggal lewat `belum_tercatat`,
/// periode sekali per `periode_mulai`, lowongan diperiksa di SQL sumber.
async fn catat_kinerja_rekrutmen(
    turso: &TursoClient,
    pengaturan: &Pengaturan,
    tanggal: &str,
) -> Result<(), CommandError> {
    let id = id_hr_kinerja_tunggu(tanggal);
    if pengaturan.siap("hr_kinerja_menunggu") && belum_tercatat(turso, &id).await? {
        let (jumlah, sejak) = ringkas_menunggu_cloud(turso).await?;
        if let Some(isi) = pesan_hr_kinerja_menunggu(jumlah, &sejak) {
            antrekan_parkir(turso, &id, "hr_kinerja_menunggu", &isi).await?;
        }
    }
    if pengaturan.siap("hr_kinerja_periode") {
        let jenis = jenis_periode_cloud(turso).await?;
        if let Some((mulai, selesai)) = periode_kinerja_berakhir(&jenis, tanggal) {
            let id = id_hr_kinerja_periode(&mulai);
            if belum_tercatat(turso, &id).await? {
                let ringkas = ringkas_periode_cloud(turso, &jenis, &mulai, &selesai).await?;
                if let Some(isi) = pesan_hr_kinerja_periode(&jenis, &mulai, &selesai, ringkas) {
                    antrekan_parkir(turso, &id, "hr_kinerja_periode", &isi).await?;
                }
            }
        }
    }
    let id = id_hr_pelamar(tanggal);
    if pengaturan.siap("hr_pelamar_baru") && belum_tercatat(turso, &id).await? {
        let daftar: Vec<(String, i64)> = baris(turso, SQL_HR_PELAMAR_BARU, vec![json!(tanggal)])
            .await?
            .iter()
            .map(|row| (text(row, "judul"), int(row, "jumlah")))
            .collect();
        if let Some(isi) = pesan_hr_pelamar_baru(&daftar) {
            antrekan_parkir(turso, &id, "hr_pelamar_baru", &isi).await?;
        }
    }
    if pengaturan.siap("hr_lowongan_tutup") {
        for row in baris(turso, SQL_HR_LOWONGAN_TUTUP, vec![]).await? {
            let tutup = text(&row, "tanggal_tutup");
            let isi = pesan_hr_lowongan_tutup(
                &text(&row, "judul"),
                &tutup,
                int(&row, "sisa"),
                int(&row, "pelamar"),
                int(&row, "kuota"),
            );
            let id = id_hr_lowongan(&text(&row, "id_lowongan"), &tutup);
            antrekan_parkir(turso, &id, "hr_lowongan_tutup", &isi).await?;
        }
    }
    Ok(())
}

/// Satu siklus: catat kejadian baru, lalu kirim antrean `Menunggu`. Dipanggil
/// `AutoTelegramRunner` dari setiap sesi yang login; setiap baris diklaim
/// atomik (`klaim_oleh`/`klaim_sampai`) seperti antrean WA.
pub async fn drain(
    turso: &TursoClient,
    http: &reqwest::Client,
    sender_id: &str,
) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let pengaturan = baca_pengaturan(turso).await?;
    if !pengaturan.aktif() || pengaturan.token().is_empty() {
        return Ok(hasil(true, [0; 4], "Notifikasi Telegram belum aktif."));
    }
    let token = pengaturan.token().to_owned();

    turso
        .query_one(
            "DELETE FROM notifikasi_telegram WHERE status <> 'Menunggu' AND created_at < datetime('now', '-30 days');",
            vec![],
        )
        .await?;
    catat_kejadian(turso, &pengaturan).await?;

    let rows = turso
        .query_one(
            DRAIN_PILIH_SQL,
            vec![json!(TELEGRAM_BATCH)],
        )
        .await?
        .to_objects();

    let (mut terkirim, mut gagal, mut dibatalkan) = (0, 0, 0);
    for row in &rows {
        let id = text(row, "id_notifikasi");
        let kejadian = text(row, "kejadian");
        let chat_id = bidang_kejadian(&kejadian)
            .filter(|_| pengaturan.kirim(&kejadian))
            .map(|bidang| pengaturan.grup(bidang).to_owned())
            .filter(|chat_id| !chat_id.is_empty());
        let Some(chat_id) = chat_id else {
            let changed = turso
                .query_one(
                    DRAIN_BATAL_SQL,
                    vec![json!("Kejadian dimatikan atau grupnya belum diatur."), json!(id)],
                )
                .await?
                .rows_affected;
            dibatalkan += i64::from(changed > 0);
            continue;
        };

        let claimed = turso
            .query_one(
                DRAIN_KLAIM_SQL,
                vec![json!(sender_id), json!(id)],
            )
            .await?
            .rows_affected;
        if claimed == 0 {
            continue;
        }

        match kirim_pesan(http, &token, &chat_id, &text(row, "isi_pesan")).await {
            Ok(()) => {
                turso
                    .query_one(
                        "UPDATE notifikasi_telegram SET status = 'Terkirim', sent_at = datetime('now', '+7 hours'), last_error = NULL, klaim_oleh = NULL, klaim_sampai = NULL WHERE id_notifikasi = ? AND klaim_oleh = ?;",
                        vec![json!(id), json!(sender_id)],
                    )
                    .await?;
                terkirim += 1;
            }
            Err(error) => {
                let (status, attempts) = status_setelah_gagal(int(row, "attempt_count"));
                let (klaim_oleh, klaim_sampai) = klaim_setelah_gagal(&kejadian, status);
                turso
                    .query_one(
                        DRAIN_GAGAL_SQL,
                        vec![
                            json!(status),
                            json!(attempts),
                            json!(potong(&error, 500)),
                            json!(klaim_oleh),
                            json!(klaim_sampai),
                            json!(id),
                            json!(sender_id),
                        ],
                    )
                    .await?;
                gagal += 1;
            }
        }
        tokio::time::sleep(TELEGRAM_THROTTLE).await;
    }

    Ok(hasil(
        true,
        [
            i64::try_from(rows.len()).unwrap_or(i64::MAX),
            terkirim,
            gagal,
            dibatalkan,
        ],
        format!("{terkirim} terkirim, {gagal} gagal, {dibatalkan} dibatalkan."),
    ))
}

// ── Kartu "Perlu perhatian" di /hris (§23.4) ──────────────────────────────

/// Izin yang membuka kartu (salah satu). Cermin `IZIN_PERHATIAN`.
pub const IZIN_PERHATIAN: [&str; 9] = [
    "employees.view",
    "hr.document.view",
    "hr.warning.view",
    "hr.request.view",
    "reimburse.decide",
    "hr.recruit.view",
    "hr.recruit.manage",
    "hr.performance.view",
    "hr.performance.finalize",
];

/// Bagian kartu yang boleh dibaca sesi. Cermin `IzinPerhatian`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IzinPerhatian {
    pub kontrak: bool,
    pub dokumen: bool,
    pub sp: bool,
    pub pengajuan: bool,
    /// Tanpa `hr.request.view`: hanya hitungan Reimburse (§19.5).
    pub hanya_reimburse: bool,
    pub rekrutmen: bool,
    /// Hanya angka (Q-122), jadi `assess` tidak cukup.
    pub kinerja: bool,
}

/// Cermin `izinPerhatian`. Kontrak dan ulang tahun kerja = `employees.view`
/// (Q-112); izinnya sama dengan izin membaca datanya hari ini.
pub fn izin_perhatian(punya: impl Fn(&str) -> bool) -> IzinPerhatian {
    IzinPerhatian {
        kontrak: punya("employees.view"),
        dokumen: punya("hr.document.view"),
        sp: punya("hr.warning.view"),
        pengajuan: punya("hr.request.view") || punya("reimburse.decide"),
        hanya_reimburse: !punya("hr.request.view"),
        rekrutmen: punya("hr.recruit.view") || punya("hr.recruit.manage"),
        kinerja: punya("hr.performance.view") || punya("hr.performance.finalize"),
    }
}

/// Baris → objek JSON berisi kolom `teks` (string) dan `angka` (bilangan).
fn objek_kolom(rows: &[HashMap<String, Value>], teks: &[&str], angka: &[&str]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let mut objek = serde_json::Map::new();
                for kunci in teks {
                    objek.insert((*kunci).to_owned(), json!(text(row, kunci)));
                }
                for kunci in angka {
                    objek.insert((*kunci).to_owned(), json!(int(row, kunci)));
                }
                Value::Object(objek)
            })
            .collect(),
    )
}

/// Isi kartu "Perlu perhatian", dibaca dari cloud (Q-102). Cermin
/// `perhatianHr`. Bagian tanpa izin tidak dibaca sama sekali dan kuncinya
/// tidak ada di hasil.
pub async fn perhatian(turso: &TursoClient, izin: &IzinPerhatian) -> Result<Value, CommandError> {
    turso.ensure_schema_current().await?;
    let tanggal = baris(turso, SQL_JAM_WIB, vec![])
        .await?
        .first()
        .map(|row| text(row, "tanggal"))
        .unwrap_or_default();
    perhatian_pada(turso, izin, &tanggal).await
}

/// `tanggal` = tanggal WIB jam database. Dipisah supaya jendela periode
/// kinerja bisa diuji tanpa bergantung tanggal saat tes berjalan.
async fn perhatian_pada(turso: &TursoClient, izin: &IzinPerhatian, tanggal: &str) -> Result<Value, CommandError> {
    let mut hasil = serde_json::Map::new();
    if izin.kontrak {
        let rows = baris(turso, PERHATIAN_SQL_KONTRAK, vec![]).await?;
        hasil.insert(
            "kontrak".into(),
            objek_kolom(&rows, &["jenis", "id_karyawan", "nama", "jabatan", "tanggal"], &["sisa"]),
        );
        let rows = baris(turso, PERHATIAN_SQL_ULTAH, vec![]).await?;
        hasil.insert(
            "ulang_tahun".into(),
            objek_kolom(&rows, &["id_karyawan", "nama", "jabatan", "tanggal"], &["tahun"]),
        );
    }
    if izin.dokumen {
        let rows = baris(turso, PERHATIAN_SQL_DOKUMEN, vec![]).await?;
        hasil.insert(
            "dokumen".into(),
            objek_kolom(&rows, &["id_karyawan", "nama", "jabatan", "jenis_dokumen", "tanggal"], &["sisa"]),
        );
    }
    if izin.sp {
        let rows = baris(turso, PERHATIAN_SQL_SP, vec![]).await?;
        hasil.insert(
            "sp".into(),
            objek_kolom(&rows, &["id_karyawan", "nama", "jabatan", "tingkat", "tanggal"], &["sisa"]),
        );
    }
    if izin.pengajuan {
        let menunggu: Vec<HashMap<String, Value>> = baris(turso, SQL_HR_MENUNGGU, vec![])
            .await?
            .into_iter()
            .filter(|row| !izin.hanya_reimburse || text(row, "kelompok") == "Reimburse")
            .collect();
        let menunggu_sejak = menunggu.iter().map(|row| text(row, "sejak")).min().unwrap_or_default();
        // Reimburse tidak pernah urgent; pemegang `reimburse.decide` saja tidak
        // melihat hitungan kelompok lain.
        let urgent = if izin.hanya_reimburse {
            Vec::new()
        } else {
            baris(turso, SQL_HR_URGENT, vec![]).await?
        };
        let urgent_baris = urgent.first();
        hasil.insert(
            "pengajuan".into(),
            json!({
                "menunggu": objek_kolom(&menunggu, &["kelompok"], &["jumlah", "hari"]),
                "menunggu_sejak": menunggu_sejak,
                "urgent": urgent_baris.map(|row| int(row, "jumlah")).unwrap_or(0),
                "urgent_sejak": urgent_baris.map(|row| text(row, "sejak")).unwrap_or_default(),
            }),
        );
    }
    if izin.rekrutmen {
        let rows = baris(turso, super::hr_rekrutmen::PERHATIAN_REKRUTMEN_SQL, vec![]).await?;
        hasil.insert(
            "rekrutmen".into(),
            objek_kolom(&rows, &["id_lowongan", "judul", "tanggal_hapus"], &["jumlah"]),
        );
    }
    // Kinerja (§24.5, Q-122): hanya angka, dengan aturan yang sama dengan
    // kejadian Telegram `hr_kinerja_menunggu`/`hr_kinerja_periode`.
    if izin.kinerja {
        let (menunggu, menunggu_sejak) = ringkas_menunggu_cloud(turso).await?;
        let jenis = jenis_periode_cloud(turso).await?;
        let periode = match periode_kinerja_berakhir(&jenis, tanggal) {
            Some((mulai, selesai)) => {
                let r = ringkas_periode_cloud(turso, &jenis, &mulai, &selesai).await?;
                json!({
                    "jenis": jenis,
                    "mulai": mulai,
                    "selesai": selesai,
                    "belum": r.belum,
                    "draf": r.draf,
                    "diajukan": r.diajukan,
                })
            }
            None => Value::Null,
        };
        hasil.insert(
            "kinerja".into(),
            json!({ "menunggu": menunggu, "menunggu_sejak": menunggu_sejak, "periode": periode }),
        );
    }
    Ok(Value::Object(hasil))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn token_dan_chat_id() {
        assert!(token_bot_valid(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
        ));
        assert!(!token_bot_valid(
            "123456789AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
        ));
        assert!(!token_bot_valid("12:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"));
        assert!(!token_bot_valid("123456789:pendek"));
        assert!(!token_bot_valid(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PAL Dsaw0"
        ));

        assert_eq!(normalisasi_chat_id("  "), Some(String::new()));
        assert_eq!(
            normalisasi_chat_id(" -1001234567890 "),
            Some("-1001234567890".to_owned())
        );
        assert_eq!(normalisasi_chat_id("12345"), Some("12345".to_owned()));
        assert_eq!(normalisasi_chat_id("-"), None);
        assert_eq!(normalisasi_chat_id("https://t.me/+abc"), None);
        assert_eq!(normalisasi_chat_id("@grupku"), None);
    }

    #[test]
    fn samarkan_dan_potong() {
        assert_eq!(
            samarkan_token("gagal ke /bot123:ABC/sendMessage dan 123:ABC", "123:ABC"),
            "gagal ke /bot***/sendMessage dan ***"
        );
        assert_eq!(samarkan_token("apa adanya", ""), "apa adanya");
        assert_eq!(potong("  pendek  ", 10), "pendek");
        assert_eq!(potong("ééééé", 5), "ééééé");
        assert_eq!(potong("ééééééé", 5), "éééé…");
    }

    #[test]
    fn isi_pesan_pengajuan() {
        assert_eq!(
            pesan_pengajuan_baru("PB-2026-0012", "Alat tulis", 2_450_000, 6, "Sarpras", "Tunai"),
            "📦 Pengajuan pembelian baru: PB-2026-0012\nKeperluan: Alat tulis\nTotal: Rp2.450.000 (6 barang)\nDiajukan oleh: Sarpras\nMenunggu ACC di aplikasi."
        );
        assert_eq!(
            pesan_pengajuan_baru("PB-1", "Laptop", 9_000_000, 1, "Budi", "Cicilan"),
            "📦 Pengajuan pembelian baru: PB-1\nKeperluan: Laptop\nTotal: Rp9.000.000 (1 barang)\nCara bayar: Cicilan\nDiajukan oleh: Budi\nMenunggu ACC di aplikasi."
        );
        assert_eq!(
            pesan_pengajuan_putus("PB-1", "Laptop", 9_000_000, true, "Bendahara", ""),
            "✅ Pengajuan PB-1 disetujui\nKeperluan: Laptop\nTotal: Rp9.000.000\nDisetujui oleh: Bendahara"
        );
        assert_eq!(
            pesan_pengajuan_putus("PB-1", "Laptop", 9_000_000, false, "Bendahara", "Anggaran habis"),
            "❌ Pengajuan PB-1 ditolak\nKeperluan: Laptop\nTotal: Rp9.000.000\nDitolak oleh: Bendahara\nAlasan: Anggaran habis"
        );
    }

    #[test]
    fn isi_pesan_stok() {
        assert_eq!(pesan_stok_menipis(&[]), None);
        let barang = |i: usize| BarisStok {
            kode: format!("BRG-{i}"),
            nama: "Kertas A4".to_owned(),
            satuan: "rim".to_owned(),
            desimal: false,
            stok: 3,
            minimum: 10,
        };
        assert_eq!(
            pesan_stok_menipis(&[
                barang(1),
                BarisStok {
                    kode: "BRG-2".to_owned(),
                    nama: "Cairan pel".to_owned(),
                    satuan: "liter".to_owned(),
                    desimal: true,
                    stok: 150,
                    minimum: 500,
                },
            ]),
            Some("⚠️ 2 barang di bawah stok minimum\n• Kertas A4 (BRG-1): 3 dari minimum 10 rim\n• Cairan pel (BRG-2): 1,50 dari minimum 5 liter".to_owned())
        );
        let banyak: Vec<BarisStok> = (1..=32).map(barang).collect();
        let pesan = pesan_stok_menipis(&banyak).unwrap();
        assert!(pesan.starts_with("⚠️ 32 barang di bawah stok minimum\n"));
        assert!(
            pesan.ends_with("• Kertas A4 (BRG-30): 3 dari minimum 10 rim\ndan 2 barang lainnya.")
        );
    }

    #[test]
    fn permintaan_dan_galat() {
        let (url, body) = permintaan_kirim("1:A", "-100", "Halo");
        assert_eq!(url, "https://api.telegram.org/bot1:A/sendMessage");
        assert_eq!(
            body,
            json!({ "chat_id": "-100", "text": "Halo", "disable_web_page_preview": true })
        );
        assert_eq!(galat_telegram(200, r#"{"ok":true,"result":{}}"#), None);
        assert_eq!(
            galat_telegram(
                400,
                r#"{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}"#
            ),
            Some("Telegram: Bad Request: chat not found".to_owned())
        );
        assert_eq!(
            galat_telegram(502, "<html>"),
            Some("Telegram: HTTP 502".to_owned())
        );
        assert_eq!(
            galat_telegram(200, r#"{"ok":false}"#),
            Some("Telegram: HTTP 200".to_owned())
        );
    }

    #[test]
    fn grup_dari_get_updates() {
        let respons = json!({
            "ok": true,
            "result": [
                { "update_id": 1, "my_chat_member": {
                    "chat": { "id": -100111, "title": "Inventaris", "type": "supergroup" },
                    "new_chat_member": { "status": "member" } } },
                { "update_id": 2, "message": {
                    "chat": { "id": 555, "first_name": "Budi", "type": "private" }, "text": "/start" } },
                { "update_id": 3, "message": {
                    "chat": { "id": -222, "title": "Keuangan", "type": "group" }, "text": "/start" } },
                { "update_id": 4, "edited_message": {
                    "chat": { "id": -100111, "title": "Inventaris Kantor", "type": "supergroup" } } },
                { "update_id": 5, "my_chat_member": {
                    "chat": { "id": -333, "title": "Lama", "type": "group" },
                    "new_chat_member": { "status": "member" } } },
                { "update_id": 6, "my_chat_member": {
                    "chat": { "id": -333, "title": "Lama", "type": "group" },
                    "new_chat_member": { "status": "kicked" } } },
                { "update_id": 7, "message": { "chat": { "id": "-444", "type": "group" } } }
            ]
        });
        assert_eq!(
            grup_dari_updates(&respons),
            vec![
                ("-100111".to_owned(), "Inventaris Kantor".to_owned()),
                ("-222".to_owned(), "Keuangan".to_owned()),
            ]
        );
        assert!(grup_dari_updates(&json!({ "ok": false })).is_empty());
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn isi_pesan_keuangan() {
        assert_eq!(label_bulan("2026-01"), "Januari 2026");
        assert_eq!(label_bulan("2026-13"), "2026-13");
        assert_eq!(label_bulan(""), "");
        assert_eq!(status_setelah_gagal(0), ("Menunggu", 1));
        assert_eq!(status_setelah_gagal(1), ("Menunggu", 2));
        assert_eq!(status_setelah_gagal(2), ("Gagal", 3));
        assert_eq!(
            pesan_kasbon_baru(2_000_000, 500_000, "2026-12"),
            "💰 Pengajuan kasbon baru\nPokok: Rp2.000.000\nCicilan: Rp500.000 per bulan, mulai potong gaji Desember 2026\nMenunggu keputusan di aplikasi."
        );
        assert_eq!(
            pesan_tutup_buku("2026-09-30", "Bendahara", false),
            "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara"
        );
        assert_eq!(
            pesan_tutup_buku("2026-09-30", "Bendahara", true),
            "🔒 Buku ditutup sampai 30/09/2026\nOleh: Bendahara\nBentrok dengan tutup buku lain, menunggu keputusan di aplikasi."
        );
        assert_eq!(
            pesan_buka_buku("2026-09-30", "Kepala TU", "Salah input jurnal"),
            "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU\nAlasan: Salah input jurnal"
        );
        assert_eq!(
            pesan_buka_buku("2026-09-30", "Kepala TU", " "),
            "🔓 Buku dibuka kembali (tutup sampai 30/09/2026)\nOleh: Kepala TU"
        );
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn isi_pesan_gaji() {
        assert_eq!(
            pesan_gaji_status("REVIEWED", "2026-10-01", "2026-10-31", 42, 187_400_000, "Bendahara", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 menunggu persetujuan\n42 pegawai · total bersih Rp187.400.000\nOleh: Bendahara".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("PAID", "2026-09-26", "2026-10-25", 40, 150_000_000, "Bendahara", "transfer"),
            Some("💼 Proses gaji 26/09/2026–25/10/2026 sudah dibayar\n40 pegawai · total bersih Rp150.000.000\nOleh: Bendahara".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("REJECTED", "2026-10-01", "2026-10-31", 42, 187_400_000, "Direktur", "Lembur belum diverifikasi"),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 ditolak\n42 pegawai · total bersih Rp187.400.000\nOleh: Direktur\nAlasan: Lembur belum diverifikasi".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("SUBMITTED", "2026-10-01", "2026-10-31", 42, 1, "x", ""),
            None
        );
        assert_eq!(
            pesan_gaji_status("APPROVED", "2026-10-01", "2026-10-31", 2, 9_000_000, "Direktur", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n2 pegawai\nOleh: Direktur".to_owned())
        );
        assert_eq!(
            pesan_gaji_status("APPROVED", "2026-10-01", "2026-10-31", 3, 9_000_000, "Direktur", ""),
            Some("💼 Proses gaji 01/10/2026–31/10/2026 disetujui\n3 pegawai · total bersih Rp9.000.000\nOleh: Direktur".to_owned())
        );
    }

    #[test]
    fn pemetaan_kejadian() {
        assert_eq!(bidang_kejadian("pengajuan_baru"), Some("keuangan"));
        assert_eq!(bidang_kejadian("pengajuan_putus"), Some("inventaris"));
        assert_eq!(bidang_kejadian("stok_menipis"), Some("inventaris"));
        assert_eq!(bidang_kejadian("kasbon_baru"), Some("keuangan"));
        assert_eq!(bidang_kejadian("tutup_buku"), Some("keuangan"));
        assert_eq!(bidang_kejadian("gaji_status"), Some("pimpinan"));
        assert_eq!(bidang_kejadian("buka_buku_pimpinan"), Some("pimpinan"));
        assert_eq!(bidang_kejadian("gaji"), None);
        for kejadian in &KEJADIAN[7..13] {
            assert_eq!(bidang_kejadian(kejadian), Some("armada"));
        }
        for kejadian in &KEJADIAN[13..] {
            assert!(kejadian.starts_with("hr_"));
            assert_eq!(bidang_kejadian(kejadian), Some("hrd"));
        }
        assert_eq!(label_bidang("hrd"), "HRD");
        for (_, kejadian, _) in TRIP_TUTUP {
            assert!(KEJADIAN.contains(&kejadian));
        }
        assert_eq!(id_trip_kendala("lap-1"), "drv-kendala:lap-1");
        assert_eq!(id_trip_ganti_izin("lap-2"), "drv-ganti:lap-2");
        assert_eq!(id_trip_lokasi_palsu("lap-3"), "drv-palsu:lap-3");
        assert_eq!(id_hr_kontrak("ktr-1", 30, 7), "hr-kontrak:ktr-1:jauh");
        assert_eq!(id_hr_kontrak("ktr-1", 8, 7), "hr-kontrak:ktr-1:jauh");
        assert_eq!(id_hr_kontrak("ktr-1", 7, 7), "hr-kontrak:ktr-1:dekat");
        assert_eq!(id_hr_kontrak("ktr-1", 0, 7), "hr-kontrak:ktr-1:dekat");
        // Angka diubah: id tetap menurut tahap, bukan angkanya (Q-116).
        assert_eq!(id_hr_kontrak("ktr-1", 8, 10), "hr-kontrak:ktr-1:dekat");
        assert_eq!(id_hr_kontrak("ktr-1", 20, 3), "hr-kontrak:ktr-1:jauh");
        assert_eq!(id_hr_percobaan("ktr-1"), "hr-coba:ktr-1");
        assert_eq!(id_hr_dokumen("dok-1", "2026-12-12"), "hr-dok:dok-1:2026-12-12");
        assert_eq!(id_hr_sp("sp-1"), "hr-sp:sp-1");
        assert_eq!(id_hr_menunggu("2026-11-12"), "hr-tunggu:2026-11-12");
        assert_eq!(id_hr_urgent("2026-11-12"), "hr-urgent:2026-11-12");
        assert_eq!(id_hr_ultah("2026-11-12"), "hr-ultah:2026-11-12");
        assert_eq!(KEJADIAN.len(), 26);
        assert_eq!(id_hr_kinerja_tunggu("2026-11-12"), "hr-kinerja-tunggu:2026-11-12");
        assert_eq!(id_hr_kinerja_periode("2026-01-01"), "hr-kinerja-periode:2026-01-01");
        assert_eq!(id_hr_pelamar("2026-11-12"), "hr-pelamar:2026-11-12");
        assert_eq!(id_hr_lowongan("L4", "2026-11-14"), "hr-lowongan:L4:2026-11-14");
        assert_eq!(id_hr_ajuan("p1"), "hr-ajuan:p1");
        assert_eq!(id_hr_putus("q5"), "hr-putus:q5");
        assert!(INSERT_ANTREAN_PARKIR_SQL.contains(&format!("'{KLAIM_PARKIR}'")));
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts`.
    #[test]
    fn isi_pesan_perjalanan() {
        let isi = IsiLaporan {
            nomor: "SJ-2611-WAB12-001",
            driver: "Budi Santoso",
            kendaraan: "CDD B 1234 XYZ",
            tempat: "Tol Cikampek KM 57",
            keterangan: "Radiator bocor",
            waktu: "2026-11-09 14:32:05",
            telat_menit: 0,
        };
        assert_eq!(
            pesan_trip_kendala(&isi, "Kendaraan Rusak", Some(90)),
            "🚧 Kendala Kendaraan Rusak: SJ-2611-WAB12-001\nDriver: Budi Santoso · CDD B 1234 XYZ\nTempat: Tol Cikampek KM 57\nPerkiraan terlambat: 90 menit\nKeterangan: Radiator bocor\nWaktu: 09/11/2026 14:32:05 WIB"
        );
        let polos = IsiLaporan { kendaraan: "", tempat: "", keterangan: "", telat_menit: 31, ..isi.clone() };
        assert_eq!(
            pesan_trip_kendala(&polos, "", Some(0)),
            "🚧 Kendala: SJ-2611-WAB12-001\nDriver: Budi Santoso\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline)."
        );
        let tepat = IsiLaporan { telat_menit: 30, ..polos.clone() };
        assert!(!pesan_trip_kendala(&tepat, "Macet", None).contains("terlambat"));

        let selesai = IsiLaporan { tempat: "Gudang Cikarang 2", keterangan: "", ..isi.clone() };
        assert_eq!(
            pesan_trip_tutup(&selesai, "Selesai", ""),
            Some("🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nTempat: Gudang Cikarang 2\nWaktu: 09/11/2026 14:32:05 WIB".to_owned())
        );
        let tutup = IsiLaporan { tempat: "", keterangan: "HP driver mati", ..isi.clone() };
        assert_eq!(
            pesan_trip_tutup(&tutup, "Selesai", "Dispatcher 1"),
            Some("🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nOleh: Dispatcher 1\nAlasan: HP driver mati\nWaktu: 09/11/2026 14:32:05 WIB".to_owned())
        );
        let catatan = IsiLaporan { tempat: "", keterangan: "Diterima satpam", ..isi.clone() };
        assert_eq!(
            pesan_trip_tutup(&catatan, "Selesai", ""),
            Some("🏁 Surat jalan SJ-2611-WAB12-001 selesai\nDriver: Budi Santoso · CDD B 1234 XYZ\nCatatan: Diterima satpam\nWaktu: 09/11/2026 14:32:05 WIB".to_owned())
        );
        let batal = IsiLaporan { tempat: "", keterangan: "Pelanggan menunda", telat_menit: 45, ..isi.clone() };
        assert_eq!(
            pesan_trip_tutup(&batal, "Tidak Jalan", "Dispatcher 1"),
            Some("⛔ Surat jalan SJ-2611-WAB12-001 tidak jalan\nDriver: Budi Santoso · CDD B 1234 XYZ\nOleh: Dispatcher 1\nAlasan: Pelanggan menunda\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline).".to_owned())
        );
        assert_eq!(
            pesan_trip_tutup(&batal, "Dibatalkan", "Dispatcher 1").unwrap().lines().next(),
            Some("🛑 Surat jalan SJ-2611-WAB12-001 dibatalkan")
        );
        assert_eq!(pesan_trip_tutup(&batal, "Kendala", ""), None);

        let ganti = IsiLaporan { keterangan: "Mesin mati", ..isi.clone() };
        assert_eq!(
            pesan_trip_ganti_izin(&ganti, false, true, "CDD B 1234 XYZ", "CDE B 999 AA"),
            "🔁 Ganti kendaraan darurat: SJ-2611-WAB12-001\nDari: CDD B 1234 XYZ\nKe: CDE B 999 AA\nDilaporkan oleh: Budi Santoso\nAlasan: Mesin mati\nSudah berlaku. Setujui atau tolak di aplikasi.\nWaktu: 09/11/2026 14:32:05 WIB"
        );
        let izin = IsiLaporan { keterangan: "", driver: "Andi", ..isi.clone() };
        assert_eq!(
            pesan_trip_ganti_izin(&izin, true, false, "Budi Santoso", "Andi"),
            "🔁 Minta izin ganti driver: SJ-2611-WAB12-001\nDari: Budi Santoso\nKe: Andi\nDilaporkan oleh: Andi\nBerlaku setelah disetujui di aplikasi.\nWaktu: 09/11/2026 14:32:05 WIB"
        );

        assert_eq!(
            pesan_trip_lokasi_palsu(&selesai, "Tiba Bongkar"),
            "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-2611-WAB12-001\nLaporan: Tiba Bongkar · Gudang Cikarang 2\nDriver: Budi Santoso · CDD B 1234 XYZ\nWaktu: 09/11/2026 14:32:05 WIB"
        );
        assert_eq!(
            pesan_trip_lokasi_palsu(&polos, "Berangkat"),
            "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-2611-WAB12-001\nLaporan: Berangkat\nDriver: Budi Santoso\nWaktu: 09/11/2026 14:32:05 WIB\nDikirim terlambat (offline)."
        );
        assert_eq!(waktu_tampil(""), "");
        assert_eq!(waktu_tampil("2026-11-09"), "2026-11-09");
    }

    /// Cermin "kejadian armada" di `services/telegram.test.ts`, dengan data dan
    /// isi pesan yang sama, terhadap berkas SQLite sungguhan (tanpa HTTP).
    #[test]
    fn catat_armada_dari_data_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = TursoClient::local_file(
                reqwest::Url::parse("https://telegram-armada.sppg.invalid").expect("origin uji"),
                dir.path().join("hub.db"),
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("skema");
            let mut sql = vec![
                "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('aktif_sejak', datetime('now', '-1 hour'));".to_owned(),
                "INSERT OR IGNORE INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja) VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');".to_owned(),
                "INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif) VALUES ('d1', 'Budi', 'Armada', 1, 'Aktif'), ('d2', 'Andi', 'Armada', 1, 'Aktif');".to_owned(),
                "INSERT INTO drv_jenis_kendaraan (id_jenis, nama, tarif) VALUES ('j1', 'CDD', 100000), ('j2', 'CDE', 50000);".to_owned(),
                "INSERT INTO drv_kendaraan (id_kendaraan, id_jenis, identitas) VALUES ('v1', 'j1', 'B 1 A'), ('v2', 'j2', 'B 2 B');".to_owned(),
                "INSERT INTO drv_perjalanan (id_perjalanan, tanggal, seri, nomor_urut, nomor, id_karyawan, id_kendaraan, id_jenis, id_kategori, tarif_kendaraan, tarif_tujuan, dibuat_oleh)
                 VALUES ('t1', '2026-11-09', 'WEB', 1, 'SJ-1', 'd1', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher'),
                        ('t2', '2026-11-09', 'WEB', 2, 'SJ-2', 'd2', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher'),
                        ('t3', '2026-11-09', 'WEB', 3, 'SJ-3', 'd1', 'v1', 'j1', 'k1', 100000, 0, 'dispatcher');".to_owned(),
            ];
            for (kunci, nilai) in [
                ("bot_token", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"),
                ("aktif", "1"),
                ("grup:armada", "-444"),
            ] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('{kunci}', '{nilai}');"));
            }
            for kejadian in &KEJADIAN[7..13] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('kirim:{kejadian}', '1');"));
            }
            let lapor = "INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, waktu_perangkat, dilaporkan_oleh, diterima_cloud, id_karyawan, jenis_kendala, terlambat_menit, nama_lokasi, mode_ganti, id_kendaraan_baru, id_karyawan_baru, id_ref, keterangan, lokasi_palsu) VALUES";
            sql.push(format!("{lapor}
                ('l1', 't1', 'Berangkat', '2026-11-09 01:00:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
                ('l2', 't1', 'Kendala', '2026-11-09 02:00:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', 'Macet', 30, 'Tol Cikampek', NULL, NULL, NULL, NULL, NULL, NULL),
                ('l3', 't1', 'Ganti Kendaraan', '2026-11-09 03:00:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', NULL, NULL, NULL, 'Darurat', 'v2', NULL, NULL, 'Mesin mati', NULL),
                ('l4', 't1', 'Selesai', '2026-11-09 05:00:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', NULL, NULL, 'Gudang Cikarang', NULL, NULL, NULL, NULL, NULL, 1),
                ('l4b', 't1', 'Selesai', '2026-11-09 05:01:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
                ('l5', 't2', 'Tidak Jalan', datetime('now', '-2 minutes'), 'dispatcher', datetime('now', '-1 minute'), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Pelanggan menunda', NULL),
                ('l6', 't3', 'Ganti Driver', '2026-11-09 04:00:00', 'hp-driver', datetime('now', '-1 minute'), 'd1', NULL, NULL, NULL, 'Minta Izin', NULL, 'd2', NULL, NULL, NULL),
                ('l7', 't3', 'Disetujui', '2026-11-09 04:05:00', 'dispatcher', datetime('now', '-1 minute'), NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'l6', NULL, NULL),
                ('l8', 't3', 'Kendala', '2026-11-09 04:10:00', 'hp-driver', datetime('now', '-2 hours'), 'd2', 'Ban', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);"));
            turso
                .execute_atomic(sql.into_iter().map(|s| Statement::new(s, vec![])).collect())
                .await
                .expect("data uji");

            let pengaturan = baca_pengaturan(&turso).await.unwrap();
            catat_kejadian(&turso, &pengaturan).await.unwrap();
            catat_kejadian(&turso, &pengaturan).await.unwrap();
            let antrean: Vec<(String, String)> = turso
                .query_one(
                    "SELECT id_notifikasi, isi_pesan FROM notifikasi_telegram ORDER BY id_notifikasi;",
                    vec![],
                )
                .await
                .unwrap()
                .to_objects()
                .iter()
                .map(|row| (text(row, "id_notifikasi"), text(row, "isi_pesan")))
                .collect();
            let ids: Vec<&str> = antrean.iter().map(|(id, _)| id.as_str()).collect();
            assert_eq!(
                ids,
                ["drv-ganti:l3", "drv-kendala:l2", "drv-palsu:l4", "drv-selesai:t1", "drv-tidak-jalan:t2"]
            );
            let isi = |id: &str| antrean.iter().find(|(ada, _)| ada == id).unwrap().1.clone();
            assert_eq!(isi("drv-kendala:l2"), "🚧 Kendala Macet: SJ-1\nDriver: Budi · CDD B 1 A\nTempat: Tol Cikampek\nPerkiraan terlambat: 30 menit\nWaktu: 09/11/2026 09:00:00 WIB\nDikirim terlambat (offline).");
            assert_eq!(isi("drv-ganti:l3"), "🔁 Ganti kendaraan darurat: SJ-1\nDari: CDD B 1 A\nKe: CDE B 2 B\nDilaporkan oleh: Budi\nAlasan: Mesin mati\nSudah berlaku. Setujui atau tolak di aplikasi.\nWaktu: 09/11/2026 10:00:00 WIB\nDikirim terlambat (offline).");
            assert_eq!(isi("drv-selesai:t1"), "🏁 Surat jalan SJ-1 selesai\nDriver: Budi · CDE B 2 B\nTempat: Gudang Cikarang\nWaktu: 09/11/2026 12:00:00 WIB\nDikirim terlambat (offline).");
            assert_eq!(isi("drv-palsu:l4"), "⚠️ Perlu ditinjau: lokasi palsu terdeteksi\nSurat jalan: SJ-1\nLaporan: Selesai · Gudang Cikarang\nDriver: Budi · CDE B 2 B\nWaktu: 09/11/2026 12:00:00 WIB\nDikirim terlambat (offline).");
            let tidak_jalan = isi("drv-tidak-jalan:t2");
            assert!(tidak_jalan.starts_with("⛔ Surat jalan SJ-2 tidak jalan\nDriver: Andi · CDD B 1 A\nOleh: dispatcher\nAlasan: Pelanggan menunda\nWaktu: "));
            assert!(!tidak_jalan.contains("terlambat"));
        });
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts` ("isi pesan HRD").
    #[test]
    fn isi_pesan_hrd() {
        assert_eq!(sisa_hari(0), "hari ini");
        assert_eq!(sisa_hari(7), "7 hari lagi");
        assert_eq!(
            pesan_hr_kontrak_akhir("Budi Santoso", "Staf Gudang", "2026-12-12", 30),
            "📄 Kontrak PKWT berakhir 30 hari lagi (12/12/2026)\nKaryawan: Budi Santoso · Staf Gudang"
        );
        assert_eq!(
            pesan_hr_kontrak_akhir("Budi Santoso", "", "2026-11-12", 0),
            "📄 Kontrak PKWT berakhir hari ini (12/11/2026)\nKaryawan: Budi Santoso"
        );
        assert_eq!(
            pesan_hr_percobaan_akhir("Sari", "Kasir", "2026-11-15", 3),
            "⏳ Masa percobaan berakhir 3 hari lagi (15/11/2026)\nKaryawan: Sari · Kasir"
        );
        assert_eq!(
            pesan_hr_dokumen_kedaluwarsa("SIM B1", "Andi", "Driver", "2026-11-19", 7),
            "🪪 Dokumen SIM B1 kedaluwarsa 7 hari lagi (19/11/2026)\nKaryawan: Andi · Driver"
        );
        assert_eq!(
            pesan_hr_sp_berakhir("SP2", "Andi", "Driver", "2026-11-12"),
            "📋 Masa berlaku SP2 berakhir 12/11/2026\nKaryawan: Andi · Driver"
        );
        let kelompok = |nama: &str, jumlah: i64| (nama.to_owned(), jumlah);
        assert_eq!(
            pesan_hr_pengajuan_menunggu(
                &[kelompok("Cuti", 3), kelompok("Izin", 1), kelompok("Reimburse", 2)],
                "2026-11-08",
                2
            ),
            Some("📥 6 pengajuan menunggu lebih dari 2 hari\nCuti 3, Izin 1, Reimburse 2\nPaling lama sejak 08/11/2026".to_owned())
        );
        assert_eq!(
            pesan_hr_pengajuan_menunggu(&[kelompok("Cuti", 1)], "2026-11-01", 5),
            Some("📥 1 pengajuan menunggu lebih dari 5 hari\nCuti 1\nPaling lama sejak 01/11/2026".to_owned())
        );
        assert_eq!(pesan_hr_pengajuan_menunggu(&[], "2026-11-08", 2), None);
        assert_eq!(
            pesan_hr_urgent_belum_diketahui(2, "2026-11-10"),
            Some("⚡ 2 pengajuan urgent belum diketahui HRD\nPaling lama sejak 10/11/2026".to_owned())
        );
        assert_eq!(pesan_hr_urgent_belum_diketahui(0, "2026-11-10"), None);

        assert_eq!(pesan_hr_ulang_tahun_kerja(&[]), None);
        assert_eq!(
            pesan_hr_ulang_tahun_kerja(&[
                BarisUltah { nama: "Budi".to_owned(), jabatan: "Staf Gudang".to_owned(), tahun: 3 },
                BarisUltah { nama: "Sari".to_owned(), jabatan: String::new(), tahun: 1 },
            ]),
            Some("🎉 Ulang tahun kerja hari ini\n• Budi (Staf Gudang), 3 tahun\n• Sari, 1 tahun".to_owned())
        );
        let banyak: Vec<BarisUltah> = (1..=32)
            .map(|i| BarisUltah { nama: format!("Karyawan {i}"), jabatan: "Staf".to_owned(), tahun: 2 })
            .collect();
        let pesan = pesan_hr_ulang_tahun_kerja(&banyak).unwrap();
        assert!(pesan.starts_with("🎉 Ulang tahun kerja hari ini\n• Karyawan 1 (Staf), 2 tahun\n"));
        assert!(pesan.ends_with("• Karyawan 30 (Staf), 2 tahun\ndan 2 lainnya."));
    }

    fn kk(id: &str, jenis: &str, sidik: &str, diterima: &str) -> KeputusanKinerja {
        KeputusanKinerja {
            id_keputusan: id.to_owned(),
            jenis: jenis.to_owned(),
            sidik: sidik.to_owned(),
            oleh: "hrd".to_owned(),
            waktu_perangkat: "2026-11-01 00:00:00.000".to_owned(),
            diterima_cloud: Some(diterima.to_owned()),
            nilai_akhir: None,
            predikat: None,
        }
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts` ("periode kinerja
    // berakhir" dan "ringkas kinerja").
    #[test]
    fn ringkas_kinerja() {
        let smt = Some(("2026-01-01".to_owned(), "2026-06-30".to_owned()));
        assert_eq!(periode_kinerja_berakhir("Semester", "2026-07-01"), smt);
        assert_eq!(periode_kinerja_berakhir("Semester", "2026-07-07"), smt);
        assert_eq!(periode_kinerja_berakhir("Semester", "2026-07-08"), None);
        assert_eq!(periode_kinerja_berakhir("Semester", "2026-06-30"), None);
        assert_eq!(periode_kinerja_berakhir("Bulanan", "2026-03-01"), Some(("2026-02-01".to_owned(), "2026-02-28".to_owned())));
        assert_eq!(periode_kinerja_berakhir("Tahunan", "2027-01-03"), Some(("2026-01-01".to_owned(), "2026-12-31".to_owned())));
        assert_eq!(periode_kinerja_berakhir("Kuartal", "2026-01-05"), Some(("2025-10-01".to_owned(), "2025-12-31".to_owned())));
        assert_eq!(periode_kinerja_berakhir("Mingguan", "2026-07-01"), None);
        assert_eq!(periode_kinerja_berakhir("Semester", "bukan"), None);
        assert_eq!(HR_HARI_JENDELA, 7);

        let p = |sidik: &str, sejak: &str, keputusan: Vec<KeputusanKinerja>| PenilaianTunggu {
            sidik: sidik.to_owned(),
            sejak: sejak.to_owned(),
            keputusan,
        };
        let tunggu = [
            p("s1", "2026-11-05", vec![kk("a1", "Ajukan", "s1", "2026-11-05 03:00:00")]),
            p("s2", "2026-11-01", vec![kk("a2", "Ajukan", "s2", "2026-11-01 03:00:00"), kk("b2", "Kembalikan", "s2", "2026-11-01 04:00:00")]),
            p("s3", "2026-11-03", vec![kk("a3", "Ajukan", "s3", "2026-11-03 05:00:00"), kk("b3", "Kembalikan", "s3", "2026-11-03 04:00:00")]),
            p("s4", "2026-10-01", vec![kk("a4", "Ajukan", "s4", "2026-10-01 03:00:00"), kk("c4", "Batal", "s4", "2026-10-02 03:00:00")]),
        ];
        assert_eq!(ringkas_kinerja_menunggu(&tunggu), (2, "2026-11-03".to_owned()));
        assert_eq!(ringkas_kinerja_menunggu(&[]), (0, String::new()));

        let nilai = |sidik: &str, keputusan: Vec<KeputusanKinerja>| PenilaianPeriode { sidik: sidik.to_owned(), keputusan };
        let k = |daftar: Option<&str>, selesai: Option<&str>, penilaian: Vec<PenilaianPeriode>| KaryawanPeriode {
            tanggal_daftar: daftar.map(str::to_owned),
            tanggal_selesai_aktif: selesai.map(str::to_owned),
            penilaian,
        };
        let karyawan = [
            k(Some("2020-01-01"), None, vec![nilai("s1", vec![kk("f1", "Final", "s1", "2026-07-02 00:00:00")])]),
            k(None, None, vec![nilai("s2", vec![kk("a2", "Ajukan", "s2", "2026-07-02 00:00:00")])]),
            k(Some("2026-03-01"), None, vec![]),
            k(Some("2026-07-01"), None, vec![]),
            k(None, Some("2025-12-31"), vec![]),
            k(None, None, vec![nilai("s6", vec![kk("c6", "Batal", "s6", "2026-07-02 00:00:00")]), nilai("s6b", vec![])]),
            k(None, None, vec![nilai("s7", vec![kk("c7", "Batal", "s7", "2026-07-02 00:00:00")])]),
        ];
        assert_eq!(
            ringkas_kinerja_periode(&karyawan, "2026-01-01", "2026-06-30"),
            RingkasPeriode { belum: 2, draf: 1, diajukan: 1 }
        );
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts` ("isi pesan HRD fase 9").
    #[test]
    fn isi_pesan_hrd_fase9() {
        assert_eq!(
            pesan_hr_kinerja_menunggu(2, "2026-11-03"),
            Some("📊 2 penilaian kinerja menunggu Final\nPaling lama sejak 03/11/2026".to_owned())
        );
        assert_eq!(pesan_hr_kinerja_menunggu(1, ""), Some("📊 1 penilaian kinerja menunggu Final".to_owned()));
        assert_eq!(pesan_hr_kinerja_menunggu(0, "2026-11-03"), None);
        assert_eq!(
            pesan_hr_kinerja_periode("Semester", "2026-01-01", "2026-06-30", RingkasPeriode { belum: 2, draf: 1, diajukan: 1 }),
            Some("📊 Periode Semester 01/01/2026 s.d. 30/06/2026 berakhir: 2 belum dinilai, 1 masih draf, 1 diajukan".to_owned())
        );
        assert_eq!(pesan_hr_kinerja_periode("Semester", "2026-01-01", "2026-06-30", RingkasPeriode::default()), None);
        assert_eq!(
            pesan_hr_pelamar_baru(&[("Admin Gudang".to_owned(), 2), ("Sopir".to_owned(), 1)]),
            Some("👥 3 pelamar baru kemarin\n• Admin Gudang: 2\n• Sopir: 1".to_owned())
        );
        assert_eq!(pesan_hr_pelamar_baru(&[]), None);
        let banyak: Vec<(String, i64)> = (1..=32).map(|i| (format!("Lowongan {i}"), 1)).collect();
        let banyak = pesan_hr_pelamar_baru(&banyak).unwrap();
        assert!(banyak.starts_with("👥 32 pelamar baru kemarin\n• Lowongan 1: 1\n"));
        assert!(banyak.ends_with("• Lowongan 30: 1\ndan 2 lainnya."));
        assert_eq!(
            pesan_hr_lowongan_tutup("Admin Gudang", "2026-11-14", 2, 3, 2),
            "📢 Lowongan Admin Gudang tutup 2 hari lagi (14/11/2026)\nPelamar: 3 · Kuota: 2"
        );
        assert_eq!(
            pesan_hr_lowongan_tutup("Sopir", "2026-11-12", 0, 0, 1),
            "📢 Lowongan Sopir tutup hari ini (12/11/2026)\nPelamar: 0 · Kuota: 1"
        );

        let isi = |kelompok: &str, nama: &str, jabatan: &str, mulai: &str, selesai: &str| IsiPengajuanHr {
            kelompok: kelompok.to_owned(),
            nama: nama.to_owned(),
            jabatan: jabatan.to_owned(),
            mulai: mulai.to_owned(),
            selesai: selesai.to_owned(),
        };
        let cuti = isi("Cuti", "Budi", "Staf Gudang", "2026-12-01", "2026-12-03");
        let sakit = isi(KELOMPOK_TANPA_NAMA, "Sari", "Kasir", "2026-11-12", "2026-11-12");
        let izin = isi("Izin", "Budi", "", "2026-12-05", "2026-12-05");
        assert_eq!(
            pesan_hr_pengajuan_baru(&cuti),
            "📝 Pengajuan Cuti baru\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026 s.d. 03/12/2026"
        );
        assert_eq!(pesan_hr_pengajuan_baru(&sakit), "📝 1 pengajuan Sakit baru\nTanggal: 12/11/2026");
        assert_eq!(
            pesan_hr_pengajuan_diputus(&cuti, "Setujui", "HRD Satu"),
            "✅ Pengajuan Cuti disetujui\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026 s.d. 03/12/2026\nOleh: HRD Satu"
        );
        assert_eq!(
            pesan_hr_pengajuan_diputus(&izin, "Tolak", "hrd"),
            "❌ Pengajuan Izin ditolak\nKaryawan: Budi\nTanggal: 05/12/2026\nOleh: hrd"
        );
        assert_eq!(
            pesan_hr_pengajuan_diputus(&sakit, "Setujui Urgent", "atasan"),
            "✅ 1 pengajuan Sakit disetujui (urgent)\nTanggal: 12/11/2026\nOleh: atasan"
        );
        for pesan in [pesan_hr_pengajuan_baru(&sakit), pesan_hr_pengajuan_diputus(&sakit, "Tolak", "hrd")] {
            assert!(!pesan.contains("Sari") && !pesan.contains("Kasir"), "{pesan}");
        }
    }

    async fn ultah_pada(turso: &TursoClient, hari: &str) -> Vec<String> {
        let sql = SQL_HR_ULTAH.replace("date('now', '+7 hours')", &format!("'{hari}'"));
        turso
            .query_one(&sql, vec![])
            .await
            .unwrap()
            .to_objects()
            .iter()
            .map(|row| format!("{}|{}|{}", text(row, "nama"), text(row, "jabatan"), int(row, "tahun")))
            .collect()
    }

    /// Tujuh SQL sumber HR dijalankan terhadap skema cloud sungguhan (kolom
    /// yang salah eja langsung gagal), baris parkir lahir berklaim, dan aturan
    /// 29 Feb ulang tahun kerja diuji dengan "hari ini" diganti tanggal tetap.
    #[test]
    fn sql_sumber_hrd_sah_di_skema_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = TursoClient::local_file(
                reqwest::Url::parse("https://telegram-hrd.sppg.invalid").expect("origin uji"),
                dir.path().join("hub.db"),
                reqwest::Client::new(),
            );
            turso.ensure_schema().await.expect("skema");
            for (sql, args) in [
                (SQL_HR_KONTRAK, vec![]),
                (SQL_HR_PERCOBAAN, vec![]),
                (SQL_HR_DOKUMEN, vec![]),
                (SQL_HR_SP, vec![json!("2026-01-01 00:00:00")]),
                (SQL_HR_MENUNGGU, vec![]),
                (SQL_HR_URGENT, vec![]),
                (SQL_HR_ULTAH, vec![]),
                (SQL_HR_KINERJA_MENUNGGU, vec![]),
                (SQL_HR_KINERJA_PERIODE, vec![json!("Semester"), json!("2026-01-01")]),
                (SQL_HR_PELAMAR_BARU, vec![json!("2026-11-12")]),
                (SQL_HR_LOWONGAN_TUTUP, vec![]),
                (SQL_HR_PENGAJUAN_BARU, vec![json!("2026-01-01 00:00:00")]),
                (SQL_HR_PENGAJUAN_PUTUS, vec![json!("2026-01-01 00:00:00")]),
            ] {
                turso.query_one(sql, args).await.expect(sql);
            }
            turso
                .query_one(
                    INSERT_ANTREAN_PARKIR_SQL,
                    vec![json!("hr-sp:x"), json!("hr_sp_berakhir"), json!("isi")],
                )
                .await
                .expect("parkir");
            let parkir = turso
                .query_one(
                    "SELECT klaim_oleh, klaim_sampai, status FROM notifikasi_telegram WHERE id_notifikasi = 'hr-sp:x';",
                    vec![],
                )
                .await
                .unwrap()
                .to_objects();
            assert_eq!(text(&parkir[0], "klaim_oleh"), KLAIM_PARKIR);
            assert_eq!(text(&parkir[0], "klaim_sampai"), "9999-12-31 23:59:59");
            assert_eq!(text(&parkir[0], "status"), "Menunggu");

            let data = [
                "INSERT OR IGNORE INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja) VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');",
                "INSERT INTO hr_jabatan (id_jabatan, nama) VALUES ('jab-1', 'Staf Gudang');",
                "INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, jabatan_status) VALUES
                   ('k1', 'Budi', 'Gudang', 1, 'Aktif', '2024-02-29', 'jab-1', 'lama'),
                   ('k2', 'Sari', 'Kantor', 1, 'Aktif', '2020-02-28', NULL, 'Kasir'),
                   ('k3', 'Andi', 'Kantor', 1, 'Aktif', '2027-02-28', NULL, NULL),
                   ('k4', 'Dodi', 'Kantor', 1, 'Nonaktif', '2021-02-28', NULL, NULL),
                   ('k5', 'Eko', 'Kantor', 1, 'Aktif', 'bukan tanggal', NULL, NULL);",
            ];
            turso
                .execute_atomic(data.iter().map(|s| Statement::new(*s, vec![])).collect())
                .await
                .expect("data uji");
            assert_eq!(ultah_pada(&turso, "2027-02-28").await, ["Budi|Staf Gudang|3", "Sari|Kasir|7"]);
            // Andi masuk 2027-02-28: tahun yang sama tidak dihitung, tahun
            // berikutnya ulang tahun pertama.
            assert_eq!(ultah_pada(&turso, "2028-02-28").await, ["Andi||1", "Sari|Kasir|8"]);
            assert_eq!(ultah_pada(&turso, "2028-02-29").await, ["Budi|Staf Gudang|4"]);
            assert!(ultah_pada(&turso, "2027-03-01").await.is_empty());
        });
    }

    fn klien_uji(dir: &tempfile::TempDir, nama: &str) -> TursoClient {
        TursoClient::local_file(
            reqwest::Url::parse(&format!("https://{nama}.sppg.invalid")).expect("origin uji"),
            dir.path().join("hub.db"),
            reqwest::Client::new(),
        )
    }

    async fn antrean_uji(turso: &TursoClient) -> Vec<(String, String, String)> {
        turso
            .query_one(
                "SELECT id_notifikasi, isi_pesan, COALESCE(klaim_oleh, '') AS klaim_oleh FROM notifikasi_telegram ORDER BY id_notifikasi;",
                vec![],
            )
            .await
            .unwrap()
            .to_objects()
            .iter()
            .map(|row| (text(row, "id_notifikasi"), text(row, "isi_pesan"), text(row, "klaim_oleh")))
            .collect()
    }

    /// Data uji pengingat HR, relatif terhadap jam database (sama dengan
    /// "kejadian hrd" di `services/telegram.test.ts`).
    const DATA_HRD: &[&str] = &[
        "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('aktif_sejak', datetime('now', '-3 days'));",
        "INSERT OR IGNORE INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang, jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit, buffer_shift_malam_menit, offset_generate_alfa, hari_kerja) VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');",
        "INSERT INTO hr_jabatan (id_jabatan, nama) VALUES ('jab-1', 'Staf Gudang');",
        "INSERT INTO hr_dokumen_jenis (id_jenis, nama) VALUES ('dj-sim', 'SIM B1');",
        "INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, jabatan_status) VALUES
           ('k1', 'Budi', 'Gudang', 1, 'Aktif', date('now', '+7 hours', '-4 years'), 'jab-1', NULL),
           ('k2', 'Sari', 'Kantor', 1, 'Aktif', date('now', '+7 hours', '-8 years'), NULL, 'Kasir'),
           ('k3', 'Dodi', 'Kantor', 1, 'Nonaktif', date('now', '+7 hours', '-4 years'), NULL, NULL),
           ('k4', 'Andi', 'Kantor', 1, 'Aktif', date('now', '+7 hours'), NULL, NULL),
           ('k5', 'Eko', 'Kantor', 1, 'Aktif', date('now', '+7 hours', '-1 month'), NULL, NULL);",
        "INSERT INTO hr_profil (id_karyawan, nik) VALUES ('k1', '3201000000000001');",
        "INSERT INTO hr_kontrak (id_kontrak, id_karyawan, jenis, id_ref, nomor, tanggal_mulai, tanggal_selesai, percobaan_selesai, dicatat_oleh) VALUES
           ('c1', 'k1', 'PKWT', NULL, 'NOMOR-RAHASIA', '2026-01-01', date('now', '+7 hours', '+20 days'), NULL, 'hrd'),
           ('c2', 'k2', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+5 days'), date('now', '+7 hours', '+3 days'), 'hrd'),
           ('c3', 'k3', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+5 days'), NULL, 'hrd'),
           ('c4', 'k4', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+10 days'), NULL, 'hrd'),
           ('c4b', 'k4', 'PKWTT', NULL, NULL, '2026-02-01', NULL, NULL, 'hrd'),
           ('c5', 'k5', 'PKWT', NULL, NULL, '2026-01-01', date('now', '+7 hours', '+3 days'), date('now', '+7 hours', '+1 day'), 'hrd'),
           ('batal-c5', 'k5', 'Pembatalan', 'c5', NULL, '2026-01-01', NULL, NULL, 'hrd'),
           ('c6', 'k1', 'PKWT', NULL, NULL, '2025-01-01', date('now', '+7 hours', '+2 days'), NULL, 'hrd');",
        "INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, nomor, tanggal_kedaluwarsa, dicatat_oleh) VALUES
           ('d1', 'k1', 'dj-sim', 'B1-RAHASIA', date('now', '+7 hours', '+30 days'), 'hrd'),
           ('d2', 'k1', 'dj-sim', NULL, date('now', '+7 hours', '+31 days'), 'hrd'),
           ('d3', 'k3', 'dj-sim', NULL, date('now', '+7 hours', '+2 days'), 'hrd'),
           ('d4', 'k2', 'dj-sim', NULL, date('now', '+7 hours', '-1 day'), 'hrd');",
        "INSERT INTO hr_sp (id_sp, id_karyawan, tingkat, tanggal, masa_bulan, berlaku_sampai, pelanggaran, usulan_tingkat, penanda_nama, penanda_jabatan, dicatat_oleh, dicabut_pada) VALUES
           ('s1', 'k2', 'SP2', '2026-01-01', 6, date('now', '+7 hours'), 'Pelanggaran rahasia', 'SP2', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s2', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', datetime('now')),
           ('s3', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours', '-7 days'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s4', 'k1', 'SP1', '2026-01-01', 6, date('now', '+7 hours', '-5 days'), 'x', 'SP1', 'Direktur', 'Direktur', 'hrd', NULL),
           ('s5', 'k1', 'SP3', '2026-01-01', 6, date('now', '+7 hours', '-2 days'), 'x', 'SP3', 'Direktur', 'Direktur', 'hrd', NULL);",
        "INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, dampak_gaji, tanggal_mulai, tanggal_selesai, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, nominal) VALUES
           ('p1', 'k1', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's1', 'k1', '2026-11-01 00:00:00', datetime('now', '-3 days'), NULL),
           ('p2', 'k2', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's2', 'k2', '2026-11-01 00:00:00', datetime('now', '-4 days'), NULL),
           ('p3', 'k2', 'j', 'Reimburse', 'Tidak Berpengaruh', '2026-11-01', '2026-11-01', 'Alasan rahasia', 's3', 'k2', '2026-11-01 00:00:00', datetime('now', '-3 days'), 987654),
           ('p4', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's4', 'k1', '2026-11-01 00:00:00', datetime('now', '-1 day'), NULL),
           ('p5', 'k1', 'j', 'Sakit', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's5', 'k1', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p6', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's6', 'k1', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p7', 'k3', 'j', 'Cuti', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's7', 'k3', '2026-11-01 00:00:00', datetime('now', '-5 days'), NULL),
           ('p8', 'k2', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's8', 'k2', '2026-11-01 00:00:00', datetime('now', '-3 days'), NULL),
           ('p9', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's9', 'k1', '2026-11-01 00:00:00', datetime('now', '-1 day'), NULL),
           ('p10', 'k2', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's10', 'k2', '2026-11-01 00:00:00', datetime('now', '-6 days'), NULL),
           ('p11', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-01', '2026-12-01', 'Alasan rahasia', 's11', 'k1', '2026-11-01 00:00:00', datetime('now', '-6 days'), NULL);",
        "INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud) VALUES
           ('q5', 'p5', 'Setujui', 's5', NULL, 'hrd', '2026-11-01 01:00:00', datetime('now')),
           ('q6', 'p6', 'Batal', 's6', 'Alasan rahasia', 'k1', '2026-11-01 01:00:00', datetime('now')),
           ('q8', 'p8', 'Tolak', 'lama', 'Alasan rahasia', 'hrd', '2026-11-01 01:00:00', datetime('now')),
           ('q9', 'p9', 'Setujui Urgent', 's9', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q10', 'p10', 'Setujui Urgent', 's10', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q10b', 'p10', 'Diketahui', 's10', NULL, 'hrd', '2026-11-01 02:00:00', datetime('now')),
           ('q11', 'p11', 'Setujui Urgent', 's11', NULL, 'atasan', '2026-11-01 01:00:00', datetime('now')),
           ('q11b', 'p11', 'Batal', 's11', NULL, 'k1', '2026-11-01 02:00:00', datetime('now'));",
    ];

    /// Angka pengingat di `setting_gex_system` cloud (§24.3).
    async fn atur(turso: &TursoClient, kunci: &str, nilai: &str) {
        turso
            .query_one(
                "INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES (?, ?);",
                vec![json!(kunci), json!(nilai)],
            )
            .await
            .unwrap();
    }

    /// Cermin "kejadian hrd" di `services/telegram.test.ts`: data dan isi
    /// pesan yang sama, terhadap berkas SQLite sungguhan (tanpa HTTP).
    #[test]
    fn catat_hrd_dari_data_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-hrd-data");
            turso.ensure_schema().await.expect("skema");
            let mut sql: Vec<String> = DATA_HRD.iter().map(|s| (*s).to_owned()).collect();
            for (kunci, nilai) in [
                ("bot_token", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"),
                ("aktif", "1"),
                ("grup:hrd", "-555"),
            ] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('{kunci}', '{nilai}');"));
            }
            for kejadian in &KEJADIAN[13..20] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('kirim:{kejadian}', '1');"));
            }
            turso
                .execute_atomic(sql.into_iter().map(|s| Statement::new(s, vec![])).collect())
                .await
                .expect("data uji");
            let tanggal = baris(&turso, "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '+5 days') AS k2, date('now', '+7 hours', '+3 days') AS c2, date('now', '+7 hours', '+20 days') AS k1, date('now', '+7 hours', '+30 days') AS d1, date('now', '+7 hours', '+31 days') AS d2, date('now', '+7 hours', '-2 days') AS s5, date('now', '+7 hours', '-4 days') AS p2, date('now', '+7 hours', '-1 day') AS p9;", vec![])
                .await
                .unwrap()
                .remove(0);
            let t = |kunci: &str| text(&tanggal, kunci);
            let hari_ini = t("t");
            let pengaturan = baca_pengaturan(&turso).await.unwrap();

            // Sebelum 07.00 WIB tidak ada yang dicatat.
            // Jam HR bawaan 07.00 WIB dibaca dari database lewat `SQL_JAM_WIB`.
            let jam_hr = int(&baris(&turso, SQL_JAM_WIB, vec![]).await.unwrap()[0], "jam_hr");
            assert_eq!(jam_hr, 7);
            // Sebelum jam HR tidak ada yang dicatat.
            catat_harian_pada(&turso, &pengaturan, &hari_ini, 6, jam_hr).await.unwrap();
            assert!(antrean_uji(&turso).await.is_empty());

            catat_harian_pada(&turso, &pengaturan, &hari_ini, 7, jam_hr).await.unwrap();
            catat_harian_pada(&turso, &pengaturan, &hari_ini, 12, jam_hr).await.unwrap();
            let antrean = antrean_uji(&turso).await;
            let ids: Vec<&str> = antrean.iter().map(|(id, _, _)| id.as_str()).collect();
            let harap = [
                "hr-coba:c2".to_owned(),
                format!("hr-dok:d1:{}", t("d1")),
                "hr-kontrak:c1:jauh".to_owned(),
                "hr-kontrak:c2:dekat".to_owned(),
                "hr-sp:s1".to_owned(),
                "hr-sp:s5".to_owned(),
                format!("hr-tunggu:{hari_ini}"),
                format!("hr-ultah:{hari_ini}"),
                format!("hr-urgent:{hari_ini}"),
            ];
            assert_eq!(ids, harap.iter().map(String::as_str).collect::<Vec<_>>());
            assert!(antrean.iter().all(|(_, _, klaim)| klaim == KLAIM_PARKIR));
            let isi = |id: &str| antrean.iter().find(|(ada, _, _)| ada == id).unwrap().1.clone();
            assert_eq!(
                isi("hr-kontrak:c2:dekat"),
                format!("📄 Kontrak PKWT berakhir 5 hari lagi ({})\nKaryawan: Sari · Kasir", tanggal_tampil(&t("k2")))
            );
            assert_eq!(
                isi("hr-kontrak:c1:jauh"),
                format!("📄 Kontrak PKWT berakhir 20 hari lagi ({})\nKaryawan: Budi · Staf Gudang", tanggal_tampil(&t("k1")))
            );
            assert_eq!(
                isi("hr-coba:c2"),
                format!("⏳ Masa percobaan berakhir 3 hari lagi ({})\nKaryawan: Sari · Kasir", tanggal_tampil(&t("c2")))
            );
            assert_eq!(
                isi(&format!("hr-dok:d1:{}", t("d1"))),
                format!("🪪 Dokumen SIM B1 kedaluwarsa 30 hari lagi ({})\nKaryawan: Budi · Staf Gudang", tanggal_tampil(&t("d1")))
            );
            assert_eq!(
                isi("hr-sp:s1"),
                format!("📋 Masa berlaku SP2 berakhir {}\nKaryawan: Sari · Kasir", tanggal_tampil(&hari_ini))
            );
            assert_eq!(
                isi("hr-sp:s5"),
                format!("📋 Masa berlaku SP3 berakhir {}\nKaryawan: Budi · Staf Gudang", tanggal_tampil(&t("s5")))
            );
            assert_eq!(
                isi(&format!("hr-tunggu:{hari_ini}")),
                format!("📥 4 pengajuan menunggu lebih dari 2 hari\nCuti 2, Izin 1, Reimburse 1\nPaling lama sejak {}", tanggal_tampil(&t("p2")))
            );
            assert_eq!(
                isi(&format!("hr-urgent:{hari_ini}")),
                format!("⚡ 1 pengajuan urgent belum diketahui HRD\nPaling lama sejak {}", tanggal_tampil(&t("p9")))
            );
            assert_eq!(
                isi(&format!("hr-ultah:{hari_ini}")),
                "🎉 Ulang tahun kerja hari ini\n• Budi (Staf Gudang), 4 tahun\n• Sari (Kasir), 8 tahun"
            );
            // Q-32: tidak ada isi rahasia yang ikut.
            for (_, pesan, _) in &antrean {
                for rahasia in ["rahasia", "RAHASIA", "3201000000000001", "987654", "Dodi", "Eko"] {
                    assert!(!pesan.contains(rahasia), "{pesan}");
                }
            }

            // Dokumen diperpanjang: tanggal baru = id baru (Q-104).
            turso
                .query_one("UPDATE hr_dokumen SET tanggal_kedaluwarsa = date('now', '+7 hours', '+29 days') WHERE id_dokumen = 'd1';", vec![])
                .await
                .unwrap();
            catat_harian_pada(&turso, &pengaturan, &hari_ini, 8, jam_hr).await.unwrap();
            assert_eq!(antrean_uji(&turso).await.len(), harap.len() + 1);

            // Angka pengingat diubah (§24.3), lewat `setting_gex_system` cloud.
            // Jendela jauh 30 → 25 di tengah jendela: c1 (sisa 20) tetap tahap
            // `:jauh`, jadi tidak ada pesan kedua (Q-116).
            atur(&turso, "hr_ingat_kontrak_jauh", "25").await;
            catat_harian_pada(&turso, &pengaturan, &hari_ini, 8, jam_hr).await.unwrap();
            assert_eq!(antrean_uji(&turso).await.len(), harap.len() + 1);
            // Jendela dokumen diperbesar ke 31: d2 (sisa 31) kini tercatat.
            atur(&turso, "hr_ingat_dokumen", "31").await;
            catat_harian_pada(&turso, &pengaturan, &hari_ini, 8, jam_hr).await.unwrap();
            let ids: Vec<String> = antrean_uji(&turso).await.into_iter().map(|(id, _, _)| id).collect();
            assert_eq!(ids.len(), harap.len() + 2);
            assert!(ids.contains(&format!("hr-dok:d2:{}", t("d2"))));
            // Menunggu lebih dari 4 hari: hanya p2, dan pesannya memakai N = 4.
            atur(&turso, "hr_ingat_menunggu", "4").await;
            let rows = baris(&turso, SQL_HR_MENUNGGU, vec![]).await.unwrap();
            let daftar: Vec<(String, i64)> = rows.iter().map(|row| (text(row, "kelompok"), int(row, "jumlah"))).collect();
            assert_eq!(daftar, vec![("Cuti".to_owned(), 1)]);
            assert_eq!(
                pesan_hr_pengajuan_menunggu(&daftar, &text(&rows[0], "sejak"), int(&rows[0], "hari")),
                Some(format!("📥 1 pengajuan menunggu lebih dari 4 hari\nCuti 1\nPaling lama sejak {}", tanggal_tampil(&t("p2"))))
            );
            // Tersimpan rusak: dekat ≥ jauh = jendela jauh kosong, dekat tetap;
            // angka yang bukan bilangan = bawaan.
            atur(&turso, "hr_ingat_kontrak_jauh", "10").await;
            atur(&turso, "hr_ingat_kontrak_dekat", "25").await;
            let kontrak: Vec<String> = baris(&turso, SQL_HR_KONTRAK, vec![])
                .await
                .unwrap()
                .iter()
                .map(|row| id_hr_kontrak(&text(row, "id_kontrak"), int(row, "sisa"), int(row, "dekat")))
                .collect();
            assert_eq!(kontrak, vec!["hr-kontrak:c1:dekat".to_owned()]);
            atur(&turso, "hr_ingat_kontrak_dekat", "x").await;
            assert!(baris(&turso, SQL_HR_KONTRAK, vec![]).await.unwrap().is_empty());
            // Jam HR diubah ke 09.00: pukul 08 hanya stok (mati di tes ini).
            atur(&turso, "hr_ingat_jam", "9").await;
            let jam_hr = int(&baris(&turso, SQL_JAM_WIB, vec![]).await.unwrap()[0], "jam_hr");
            assert_eq!(jam_hr, 9);
            catat_harian_pada(&turso, &pengaturan, "2099-01-01", 8, jam_hr).await.unwrap();
            assert_eq!(antrean_uji(&turso).await.len(), harap.len() + 2);
            catat_harian_pada(&turso, &pengaturan, "2099-01-01", 9, jam_hr).await.unwrap();
            assert!(antrean_uji(&turso).await.len() > harap.len() + 2);
        });
    }

    async fn pilih(turso: &TursoClient, sql: &str) -> Vec<String> {
        baris(turso, sql, vec![json!(20)])
            .await
            .unwrap()
            .iter()
            .map(|row| text(row, "id_notifikasi"))
            .collect()
    }

    async fn ubah(turso: &TursoClient, sql: &str, args: Vec<Value>) -> u64 {
        turso.query_one(sql, args).await.unwrap().rows_affected
    }

    async fn keadaan_parkir(turso: &TursoClient) -> String {
        baris(turso, "SELECT status, attempt_count, COALESCE(klaim_oleh, '') AS klaim_oleh, COALESCE(klaim_sampai, '') AS klaim_sampai FROM notifikasi_telegram WHERE id_notifikasi = 'hr-sp:s1';", vec![])
            .await
            .unwrap()
            .iter()
            .map(|row| format!("{}|{}|{}|{}", text(row, "status"), int(row, "attempt_count"), text(row, "klaim_oleh"), text(row, "klaim_sampai")))
            .collect()
    }

    /// Jalur gagal `drain` apa adanya: status, lalu klaim menurut kejadian.
    async fn gagal_kirim(turso: &TursoClient, percobaan: i64, kejadian: &str, id: &str, oleh: &str) -> u64 {
        let (status, attempts) = status_setelah_gagal(percobaan);
        let (klaim_oleh, klaim_sampai) = klaim_setelah_gagal(kejadian, status);
        ubah(
            turso,
            DRAIN_GAGAL_SQL,
            vec![json!(status), json!(attempts), json!("galat"), json!(klaim_oleh), json!(klaim_sampai), json!(id), json!(oleh)],
        )
        .await
    }

    /// Teks v33 disalin apa adanya: build lama tidak memilih, mengklaim, atau
    /// membatalkan baris parkir; build ini memilihnya, dan gagal kirim yang
    /// masih boleh dicoba mengembalikannya ke parkir.
    #[test]
    fn baris_parkir_tidak_disentuh_predikat_lama() {
        const PILIH_V33: &str = "SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now')) ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;";
        const BATAL_V33: &str = "UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));";
        const KLAIM_V33: &str = "UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));";
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-parkir");
            turso.ensure_schema().await.expect("skema");
            antrekan_parkir(&turso, "hr-sp:s1", "hr_sp_berakhir", "isi hr").await.unwrap();
            antrekan(&turso, "stok:2026-11-12", "stok_menipis", "isi stok").await.unwrap();
            // Build lama: tidak terlihat, tidak bisa diklaim atau dibatalkan.
            assert_eq!(pilih(&turso, PILIH_V33).await, ["stok:2026-11-12"]);
            assert_eq!(ubah(&turso, KLAIM_V33, vec![json!("lama"), json!("hr-sp:s1")]).await, 0);
            assert_eq!(ubah(&turso, BATAL_V33, vec![json!("x"), json!("hr-sp:s1")]).await, 0);
            assert_eq!(keadaan_parkir(&turso).await, "Menunggu|0|gen:2|9999-12-31 23:59:59");

            // Build ini: terlihat dan diklaim atomik (klaim kedua kalah).
            assert_eq!(pilih(&turso, DRAIN_PILIH_SQL).await, ["hr-sp:s1", "stok:2026-11-12"]);
            assert_eq!(ubah(&turso, DRAIN_KLAIM_SQL, vec![json!("pc-1"), json!("hr-sp:s1")]).await, 1);
            assert_eq!(ubah(&turso, DRAIN_KLAIM_SQL, vec![json!("pc-2"), json!("hr-sp:s1")]).await, 0);

            // Gagal kirim yang masih boleh dicoba: kembali diparkir.
            assert_eq!(gagal_kirim(&turso, 0, "hr_sp_berakhir", "hr-sp:s1", "pc-1").await, 1);
            assert_eq!(keadaan_parkir(&turso).await, "Menunggu|1|gen:2|9999-12-31 23:59:59");
            assert_eq!(pilih(&turso, PILIH_V33).await, ["stok:2026-11-12"]);
            assert_eq!(ubah(&turso, BATAL_V33, vec![json!("x"), json!("hr-sp:s1")]).await, 0);

            // Batas percobaan: Gagal, klaim dikosongkan.
            assert_eq!(ubah(&turso, DRAIN_KLAIM_SQL, vec![json!("pc-1"), json!("hr-sp:s1")]).await, 1);
            assert_eq!(gagal_kirim(&turso, 2, "hr_sp_berakhir", "hr-sp:s1", "pc-1").await, 1);
            assert_eq!(keadaan_parkir(&turso).await, "Gagal|3||");

            // Kejadian lama tetap tidak diparkir.
            assert_eq!(ubah(&turso, DRAIN_KLAIM_SQL, vec![json!("pc-1"), json!("stok:2026-11-12")]).await, 1);
            assert_eq!(gagal_kirim(&turso, 0, "stok_menipis", "stok:2026-11-12", "pc-1").await, 1);
            assert_eq!(pilih(&turso, PILIH_V33).await, ["stok:2026-11-12"]);
            assert_eq!(klaim_setelah_gagal("stok_menipis", "Menunggu"), (None, None));
            assert_eq!(klaim_setelah_gagal("trip_kendala", "Menunggu"), (None, None));
            assert_eq!(klaim_setelah_gagal("hr_ulang_tahun_kerja", "Gagal"), (None, None));
            assert!(KEJADIAN.iter().filter(|k| diparkir(k)).eq(KEJADIAN[13..].iter()));
        });
    }

    /// Lowongan uji kartu rekrutmen: L1 ditutup hampir 12 bulan lalu (data
    /// pelamarnya dihapus dalam 30 hari), L2 baru ditutup, L3 masih dibuka.
    /// Sama dengan "perhatian" di `services/telegram.test.ts`.
    const DATA_REKRUTMEN: &[&str] = &[
        "INSERT INTO hr_lowongan (id_lowongan, judul, jumlah, tanggal_buka, ditutup_pada, dicatat_oleh) VALUES
           ('L1', 'Staf Gudang', 1, '2025-01-01', datetime('now', '-12 months', '+10 days'), 'hrd'),
           ('L2', 'Kasir', 1, '2025-01-01', datetime('now'), 'hrd'),
           ('L3', 'Driver', 1, '2025-01-01', NULL, 'hrd');",
        "INSERT INTO hr_pelamar (id_pelamar, id_lowongan, nama, tanggal_lamaran, id_karyawan, dicatat_oleh) VALUES
           ('pl1', 'L1', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl2', 'L1', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl3', 'L1', 'Pelamar Rahasia', '2025-01-02', 'k1', 'hrd'),
           ('pl4', 'L2', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd'),
           ('pl5', 'L3', 'Pelamar Rahasia', '2025-01-02', NULL, 'hrd');",
    ];

    /// Data uji kejadian HR fase 9 (dipakai bersama `DATA_HRD`). Cermin
    /// `DATA_HRD_FASE9` di `services/telegram.test.ts`.
    const DATA_HRD_FASE9: &[&str] = &[
        "INSERT INTO master_data (id_unik, nama, divisi, id_shift, status_aktif, tanggal_daftar, id_jabatan, jabatan_status) VALUES
           ('k6', 'Fajar', 'Kantor', 1, 'Aktif', '2020-01-01', NULL, NULL),
           ('k7', 'Gita', 'Kantor', 1, 'Aktif', '2020-01-01', NULL, NULL);",
        "INSERT INTO hr_lowongan (id_lowongan, judul, jumlah, tanggal_buka, tanggal_tutup, ditutup_pada, dicatat_oleh) VALUES
           ('L4', 'Admin Gudang', 2, date('now', '+7 hours', '-30 days'), date('now', '+7 hours', '+2 days'), NULL, 'hrd'),
           ('L5', 'Sopir', 1, date('now', '+7 hours', '-30 days'), date('now', '+7 hours', '+5 days'), NULL, 'hrd'),
           ('L6', 'Kurir', 1, date('now', '+7 hours', '-30 days'), date('now', '+7 hours', '+1 day'), datetime('now'), 'hrd');",
        "INSERT INTO hr_pelamar (id_pelamar, id_lowongan, nama, tanggal_lamaran, dicatat_oleh, created_at) VALUES
           ('pf1', 'L4', 'Pelamar Rahasia', '2026-11-01', 'hrd', datetime(date('now', '+7 hours', '-1 day'), '-7 hours', '+2 hours')),
           ('pf2', 'L4', 'Pelamar Rahasia', '2026-11-01', 'hrd', datetime(date('now', '+7 hours', '-1 day'), '-7 hours', '+23 hours')),
           ('pf3', 'L5', 'Pelamar Rahasia', '2026-11-01', 'hrd', datetime(date('now', '+7 hours', '-1 day'), '-7 hours')),
           ('pf4', 'L4', 'Pelamar Rahasia', '2026-11-01', 'hrd', datetime(date('now', '+7 hours'), '-7 hours')),
           ('pf5', 'L6', 'Pelamar Rahasia', '2026-11-01', 'hrd', datetime(date('now', '+7 hours', '-1 day'), '-7 hours', '-1 second'));",
        "INSERT INTO hr_kinerja_penilaian (id_penilaian, id_karyawan, id_ref, periode_jenis, periode_mulai, periode_selesai, id_template, template_nama, penilai_oleh, catatan, sidik, dibuat_oleh, waktu_perangkat) VALUES
           ('kp1', 'k1', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', 'Catatan rahasia', 's1', 'atasan', '2026-07-02 00:00:00'),
           ('kp2', 'k2', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's2', 'atasan', '2026-07-02 00:00:00'),
           ('kp3', 'k6', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's3', 'atasan', '2026-07-02 00:00:00'),
           ('kp4', 'k7', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's4', 'atasan', '2026-07-02 00:00:00'),
           ('kp5', 'k6', 'kp3', 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's5', 'atasan', '2026-07-02 00:00:00'),
           ('kp6', 'k3', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's6', 'atasan', '2026-07-02 00:00:00'),
           ('kp7', 'k5', NULL, 'Semester', '2026-01-01', '2026-06-30', 't', 'T', 'atasan', NULL, 's7', 'atasan', '2026-07-02 00:00:00');",
        "INSERT INTO hr_kinerja_keputusan (id_keputusan, id_penilaian, jenis, sidik, alasan, nilai_akhir, predikat, oleh, waktu_perangkat, diterima_cloud) VALUES
           ('kk1', 'kp1', 'Ajukan', 's1', NULL, NULL, NULL, 'atasan', '2026-07-03 00:00:00.000', datetime('now', '-3 days')),
           ('kk2a', 'kp2', 'Ajukan', 's2', NULL, NULL, NULL, 'atasan', '2026-07-03 00:00:00.000', datetime('now', '-5 days')),
           ('kk2b', 'kp2', 'Kembalikan', 's2', 'Alasan rahasia', NULL, NULL, 'hrd', '2026-07-03 00:00:01.000', datetime('now', '-4 days')),
           ('kk3', 'kp3', 'Final', 's3', NULL, 8750, 'Baik', 'hrd', '2026-07-03 00:00:00.000', datetime('now', '-10 days')),
           ('kk4', 'kp4', 'Batal', 's4', 'Alasan rahasia', NULL, NULL, 'hrd', '2026-07-03 00:00:00.000', datetime('now', '-10 days')),
           ('kk5', 'kp5', 'Ajukan', 's5', NULL, NULL, NULL, 'atasan', '2026-07-03 00:00:00.000', datetime('now', '-1 day')),
           ('kk6', 'kp6', 'Ajukan', 's6', NULL, NULL, NULL, 'atasan', '2026-07-03 00:00:00.000', datetime('now', '-2 days')),
           ('kk7', 'kp7', 'Ajukan', 'lama', NULL, NULL, NULL, 'atasan', '2026-07-03 00:00:00.000', datetime('now', '-2 days'));",
        "INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, dampak_gaji, tanggal_mulai, tanggal_selesai, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, nominal) VALUES
           ('p12', 'k2', 'j', 'Sakit', 'Dibayar', '2026-12-02', '2026-12-02', 'Alasan rahasia', 's12', 'k2', '2026-11-01 00:00:00', datetime('now', '-1 hour'), NULL);",
    ];

    /// Keputusan ganda (`q5b`), gugur (`q13`, sidik lama), dan di luar 7 hari
    /// (`q15`), serta pengajuan baru `p13` dan `p14` (8 hari). Cermin
    /// `DATA_HRD_FASE9_LANJUT` di `services/telegram.test.ts`.
    const DATA_HRD_FASE9_LANJUT: &[&str] = &[
        "INSERT INTO hr_pengajuan (id_pengajuan, id_karyawan, id_jenis, kelompok, dampak_gaji, tanggal_mulai, tanggal_selesai, alasan, sidik, diajukan_oleh, waktu_perangkat, created_at, nominal) VALUES
           ('p13', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-07', '2026-12-07', 'Alasan rahasia', 's13', 'k1', '2026-11-01 00:00:00', datetime('now'), NULL),
           ('p14', 'k1', 'j', 'Izin', 'Dibayar', '2026-12-08', '2026-12-08', 'Alasan rahasia', 's14', 'k1', '2026-11-01 00:00:00', datetime('now', '-8 days'), NULL),
           ('p15', 'k2', 'j', 'Cuti', 'Dibayar', '2026-12-09', '2026-12-09', 'Alasan rahasia', 's15', 'k2', '2026-11-01 00:00:00', datetime('now', '-2 days'), NULL);",
        "INSERT INTO hr_pengajuan_keputusan (id_keputusan, id_pengajuan, jenis, sidik, alasan, oleh, waktu_perangkat, diterima_cloud) VALUES
           ('q5b', 'p5', 'Setujui', 's5', NULL, 'hrd', '2026-11-01 03:00:00', datetime('now')),
           ('q13', 'p13', 'Setujui', 'lama', 'Alasan rahasia', 'hrd', '2026-11-01 03:00:00', datetime('now')),
           ('q15', 'p15', 'Setujui', 's15', NULL, 'hrd', '2026-11-01 03:00:00', datetime('now', '-8 days'));",
    ];

    /// Per pengajuan, lalu kejadian harian hari ini dan hari ke-3 sesudah
    /// semester 1 berakhir (ringkasan periode bawaan Semester).
    async fn catat_fase9(turso: &TursoClient, pengaturan: &Pengaturan, hari_ini: &str, jam_hr: i64) {
        catat_pengajuan_hr(turso, pengaturan, pengaturan.get(KUNCI_AKTIF_SEJAK)).await.unwrap();
        catat_harian_pada(turso, pengaturan, hari_ini, 12, jam_hr).await.unwrap();
        catat_harian_pada(turso, pengaturan, "2026-07-03", 12, jam_hr).await.unwrap();
    }

    /// Cermin "kejadian hrd fase 9" di `services/telegram.test.ts`: data dan
    /// isi pesan sama, terhadap berkas SQLite sungguhan (tanpa HTTP).
    #[test]
    fn catat_hrd_fase9_dari_data_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-hrd-fase9-catat");
            turso.ensure_schema().await.expect("skema");
            let mut sql: Vec<String> = DATA_HRD.iter().chain(DATA_HRD_FASE9).map(|s| (*s).to_owned()).collect();
            for (kunci, nilai) in [
                ("bot_token", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"),
                ("aktif", "1"),
                ("grup:hrd", "-555"),
            ] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('{kunci}', '{nilai}');"));
            }
            for kejadian in &KEJADIAN[20..] {
                sql.push(format!("INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('kirim:{kejadian}', '1');"));
            }
            turso
                .execute_atomic(sql.into_iter().map(|s| Statement::new(s, vec![])).collect())
                .await
                .expect("data uji");
            let t = baris(&turso, "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '-3 days') AS kk1, date('now', '+7 hours', '+2 days') AS l4;", vec![])
                .await
                .unwrap()
                .remove(0);
            let t = |kunci: &str| text(&t, kunci);
            let hari_ini = t("t");
            let jam_hr = int(&baris(&turso, SQL_JAM_WIB, vec![]).await.unwrap()[0], "jam_hr");
            let mut pengaturan = baca_pengaturan(&turso).await.unwrap();

            catat_fase9(&turso, &pengaturan, &hari_ini, jam_hr).await;
            let antrean = antrean_uji(&turso).await;
            let mut harap = vec![
                "hr-ajuan:p1".to_owned(),
                "hr-ajuan:p12".to_owned(),
                "hr-ajuan:p3".to_owned(),
                "hr-ajuan:p4".to_owned(),
                "hr-ajuan:p8".to_owned(),
                "hr-kinerja-periode:2026-01-01".to_owned(),
                "hr-kinerja-tunggu:2026-07-03".to_owned(),
                format!("hr-kinerja-tunggu:{hari_ini}"),
                format!("hr-lowongan:L4:{}", t("l4")),
                format!("hr-pelamar:{hari_ini}"),
                "hr-putus:q10".to_owned(),
                "hr-putus:q5".to_owned(),
                "hr-putus:q9".to_owned(),
            ];
            // Hari ini 1–7 hari sesudah akhir semester: periode itu ikut tercatat.
            if let Some((mulai, _)) = periode_kinerja_berakhir("Semester", &hari_ini) {
                if mulai != "2026-01-01" {
                    harap.push(id_hr_kinerja_periode(&mulai));
                }
            }
            harap.sort();
            assert_eq!(antrean.iter().map(|(id, _, _)| id.clone()).collect::<Vec<_>>(), harap);
            assert!(antrean.iter().all(|(_, _, klaim)| klaim == KLAIM_PARKIR));
            let isi = |id: &str| antrean.iter().find(|(ada, _, _)| ada == id).unwrap().1.clone();
            assert_eq!(isi("hr-ajuan:p1"), "📝 Pengajuan Cuti baru\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026");
            assert_eq!(isi("hr-ajuan:p12"), "📝 1 pengajuan Sakit baru\nTanggal: 02/12/2026");
            assert_eq!(isi("hr-putus:q5"), "✅ 1 pengajuan Sakit disetujui\nTanggal: 01/12/2026\nOleh: hrd");
            assert_eq!(
                isi("hr-putus:q9"),
                "✅ Pengajuan Izin disetujui (urgent)\nKaryawan: Budi · Staf Gudang\nTanggal: 01/12/2026\nOleh: atasan"
            );
            assert_eq!(
                isi(&format!("hr-kinerja-tunggu:{hari_ini}")),
                format!("📊 2 penilaian kinerja menunggu Final\nPaling lama sejak {}", tanggal_tampil(&t("kk1")))
            );
            assert_eq!(
                isi("hr-kinerja-periode:2026-01-01"),
                "📊 Periode Semester 01/01/2026 s.d. 30/06/2026 berakhir: 1 belum dinilai, 1 masih draf, 1 diajukan"
            );
            assert_eq!(isi(&format!("hr-pelamar:{hari_ini}")), "👥 3 pelamar baru kemarin\n• Admin Gudang: 2\n• Sopir: 1");
            assert_eq!(
                isi(&format!("hr-lowongan:L4:{}", t("l4"))),
                format!("📢 Lowongan Admin Gudang tutup 2 hari lagi ({})\nPelamar: 3 · Kuota: 2", tanggal_tampil(&t("l4")))
            );
            // Q-32, Q-86, Q-117, Q-120: tidak ada isi rahasia yang ikut.
            for (_, pesan, _) in &antrean {
                for rahasia in ["ahasia", "RAHASIA", "3201000000000001", "987654", "8750", "Baik", "Dodi"] {
                    assert!(!pesan.contains(rahasia), "{pesan}");
                }
            }
            assert!(!isi("hr-ajuan:p12").contains("Sari"));

            // Dicatat dua kali tidak menggandakan.
            catat_fase9(&turso, &pengaturan, &hari_ini, jam_hr).await;
            assert_eq!(antrean_uji(&turso).await.len(), harap.len());

            // Keputusan ganda, gugur, dan di luar 7 hari tidak dikirim; p13 baru.
            turso
                .execute_atomic(DATA_HRD_FASE9_LANJUT.iter().map(|s| Statement::new(*s, vec![])).collect())
                .await
                .expect("data lanjutan");
            catat_fase9(&turso, &pengaturan, &hari_ini, jam_hr).await;
            let ids1: Vec<String> = antrean_uji(&turso).await.into_iter().map(|(id, _, _)| id).collect();
            assert_eq!(ids1.iter().filter(|id| !harap.contains(id)).collect::<Vec<_>>(), ["hr-ajuan:p13"]);

            // `aktif_sejak` diundur 30 hari: p2 (4 hari) ikut, p14 (8 hari) tidak.
            turso
                .query_one(
                    "INSERT OR REPLACE INTO app_telegram_setting (kunci, nilai) VALUES ('aktif_sejak', datetime('now', '-30 days'));",
                    vec![],
                )
                .await
                .unwrap();
            pengaturan = baca_pengaturan(&turso).await.unwrap();
            catat_pengajuan_hr(&turso, &pengaturan, pengaturan.get(KUNCI_AKTIF_SEJAK)).await.unwrap();
            let ids2: Vec<String> = antrean_uji(&turso).await.into_iter().map(|(id, _, _)| id).collect();
            assert_eq!(ids2.iter().filter(|id| !ids1.contains(id)).collect::<Vec<_>>(), ["hr-ajuan:p2"]);
        });
    }

    /// Cermin "SQL sumber berjalan di skema cloud" di `services/telegram.test.ts`.
    #[test]
    fn sql_hrd_fase9_di_skema_cloud() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-hrd-fase9");
            turso.ensure_schema().await.expect("skema");
            turso
                .execute_atomic(
                    DATA_HRD
                        .iter()
                        .chain(DATA_HRD_FASE9)
                        .map(|s| Statement::new(*s, vec![]))
                        .collect(),
                )
                .await
                .expect("data uji");
            let t = baris(&turso, "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '-3 days') AS kk1, date('now', '+7 hours', '+2 days') AS l4;", vec![])
                .await
                .unwrap()
                .remove(0);
            let t = |kunci: &str| text(&t, kunci);
            let sejak = text(
                &baris(&turso, "SELECT nilai FROM app_telegram_setting WHERE kunci = 'aktif_sejak';", vec![]).await.unwrap()[0],
                "nilai",
            );
            let opsi = |row: &HashMap<String, Value>, kunci: &str| Some(text(row, kunci)).filter(|v| !v.is_empty());

            let tunggu: Vec<PenilaianTunggu> = baris(&turso, SQL_HR_KINERJA_MENUNGGU, vec![])
                .await
                .unwrap()
                .iter()
                .map(|row| PenilaianTunggu {
                    sidik: text(row, "sidik"),
                    sejak: text(row, "sejak"),
                    keputusan: serde_json::from_str(&text(row, "keputusan")).unwrap(),
                })
                .collect();
            assert_eq!(tunggu.iter().map(|p| p.sidik.as_str()).collect::<Vec<_>>(), ["s1", "s2", "s5"]);
            assert_eq!(ringkas_kinerja_menunggu(&tunggu), (2, t("kk1")));

            let periode: Vec<KaryawanPeriode> = baris(&turso, SQL_HR_KINERJA_PERIODE, vec![json!("Semester"), json!("2026-01-01")])
                .await
                .unwrap()
                .iter()
                .map(|row| KaryawanPeriode {
                    tanggal_daftar: opsi(row, "tanggal_daftar"),
                    tanggal_selesai_aktif: opsi(row, "tanggal_selesai_aktif"),
                    penilaian: serde_json::from_str(&text(row, "penilaian")).unwrap(),
                })
                .collect();
            assert_eq!(periode.len(), 6);
            assert_eq!(
                ringkas_kinerja_periode(&periode, "2026-01-01", "2026-06-30"),
                RingkasPeriode { belum: 1, draf: 1, diajukan: 1 }
            );

            let pelamar: Vec<(String, i64)> = baris(&turso, SQL_HR_PELAMAR_BARU, vec![json!(t("t"))])
                .await
                .unwrap()
                .iter()
                .map(|row| (text(row, "judul"), int(row, "jumlah")))
                .collect();
            assert_eq!(pelamar, vec![("Admin Gudang".to_owned(), 2), ("Sopir".to_owned(), 1)]);
            let tutup: Vec<(String, String, i64, i64, i64)> = baris(&turso, SQL_HR_LOWONGAN_TUTUP, vec![])
                .await
                .unwrap()
                .iter()
                .map(|row| (text(row, "id_lowongan"), text(row, "tanggal_tutup"), int(row, "kuota"), int(row, "pelamar"), int(row, "sisa")))
                .collect();
            assert_eq!(tutup, vec![("L4".to_owned(), t("l4"), 2, 3, 2)]);

            let isi = |row: &HashMap<String, Value>| IsiPengajuanHr {
                kelompok: text(row, "kelompok"),
                nama: text(row, "nama"),
                jabatan: text(row, "jabatan"),
                mulai: text(row, "tanggal_mulai"),
                selesai: text(row, "tanggal_selesai"),
            };
            let baru = baris(&turso, SQL_HR_PENGAJUAN_BARU, vec![json!(sejak)]).await.unwrap();
            assert_eq!(baru.iter().map(|row| text(row, "id_pengajuan")).collect::<Vec<_>>(), ["p1", "p3", "p8", "p4", "p12"]);
            assert_eq!(pesan_hr_pengajuan_baru(&isi(&baru[4])), "📝 1 pengajuan Sakit baru\nTanggal: 02/12/2026");
            let putus = baris(&turso, SQL_HR_PENGAJUAN_PUTUS, vec![json!(sejak)]).await.unwrap();
            assert_eq!(putus.iter().map(|row| text(row, "id_keputusan")).collect::<Vec<_>>(), ["q10", "q5", "q9"]);
            assert_eq!(
                pesan_hr_pengajuan_diputus(&isi(&putus[1]), &text(&putus[1], "jenis"), &text(&putus[1], "oleh")),
                "✅ 1 pengajuan Sakit disetujui\nTanggal: 01/12/2026\nOleh: hrd"
            );
            assert_eq!(
                pesan_hr_pengajuan_diputus(&isi(&putus[0]), &text(&putus[0], "jenis"), &text(&putus[0], "oleh")),
                "✅ Pengajuan Izin disetujui (urgent)\nKaryawan: Sari · Kasir\nTanggal: 01/12/2026\nOleh: atasan"
            );

            // Q-32, Q-86, Q-117: isi rahasia tidak terbaca sama sekali.
            let semua = format!("{tunggu:?}{periode:?}{baru:?}{putus:?}");
            for rahasia in ["ahasia", "8750", "Baik", "987654"] {
                assert!(!semua.contains(rahasia), "{rahasia}");
            }
        });
    }

    // Vektor yang sama diuji di `validations/telegram.test.ts` ("izin kartu perhatian").
    #[test]
    fn izin_kartu_perhatian() {
        let dari = |izin: &[&str]| {
            let izin: Vec<String> = izin.iter().map(|i| (*i).to_owned()).collect();
            izin_perhatian(|p| izin.iter().any(|i| i == p))
        };
        assert_eq!(
            dari(&["employees.view"]),
            IzinPerhatian { kontrak: true, hanya_reimburse: true, ..Default::default() }
        );
        assert_eq!(
            dari(&["reimburse.decide"]),
            IzinPerhatian { pengajuan: true, hanya_reimburse: true, ..Default::default() }
        );
        assert_eq!(
            dari(&["hr.request.view", "hr.recruit.manage", "hr.warning.view", "hr.document.view"]),
            IzinPerhatian { dokumen: true, sp: true, pengajuan: true, rekrutmen: true, ..Default::default() }
        );
        assert_eq!(
            izin_perhatian(|_| true),
            IzinPerhatian { kontrak: true, dokumen: true, sp: true, pengajuan: true, hanya_reimburse: false, rekrutmen: true, kinerja: true }
        );
        // Kinerja (Q-122): `view` atau `finalize`; `assess` saja tidak membuka.
        for izin in ["hr.performance.view", "hr.performance.finalize"] {
            assert_eq!(dari(&[izin]), IzinPerhatian { kinerja: true, hanya_reimburse: true, ..Default::default() });
        }
        assert_eq!(dari(&["hr.performance.assess"]), IzinPerhatian { hanya_reimburse: true, ..Default::default() });
        assert!(!IZIN_PERHATIAN.contains(&"hr.performance.assess"));
    }

    /// Cermin "perhatian kinerja" di `services/telegram.test.ts`: data dan
    /// hasil sama. Hanya angka; periode hanya 1–7 hari sesudah berakhir.
    #[test]
    fn perhatian_kinerja() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-perhatian-kinerja");
            turso.ensure_schema().await.expect("skema");
            turso
                .execute_atomic(
                    DATA_HRD
                        .iter()
                        .chain(DATA_HRD_FASE9)
                        .map(|s| Statement::new(*s, vec![]))
                        .collect(),
                )
                .await
                .expect("data uji");
            let kk1 = text(
                &baris(&turso, "SELECT date('now', '+7 hours', '-3 days') AS kk1;", vec![]).await.unwrap()[0],
                "kk1",
            );
            let semua = izin_perhatian(|_| true);
            let hasil = perhatian_pada(&turso, &semua, "2026-07-03").await.unwrap();
            assert_eq!(
                hasil["kinerja"],
                json!({
                    "menunggu": 2,
                    "menunggu_sejak": kk1,
                    "periode": { "jenis": "Semester", "mulai": "2026-01-01", "selesai": "2026-06-30", "belum": 1, "draf": 1, "diajukan": 1 },
                })
            );
            let teks = hasil["kinerja"].to_string();
            for nama in ["Budi", "Sari", "Fajar", "Gita", "8750", "Baik"] {
                assert!(!teks.contains(nama), "{nama}");
            }
            let nanti = perhatian_pada(&turso, &semua, "2026-11-12").await.unwrap();
            assert_eq!(nanti["kinerja"]["periode"], Value::Null);
            assert_eq!(nanti["kinerja"]["menunggu"], json!(2));

            let kunci = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            for izin in ["hr.performance.view", "hr.performance.finalize"] {
                let satu = perhatian_pada(&turso, &izin_perhatian(|p| p == izin), "2026-07-03").await.unwrap();
                assert_eq!(kunci(&satu), ["kinerja"], "{izin}");
            }
            let atasan = perhatian_pada(&turso, &izin_perhatian(|p| p == "hr.performance.assess"), "2026-07-03").await.unwrap();
            assert_eq!(atasan, json!({}));
        });
    }

    /// Cermin "perhatian" di `services/telegram.test.ts`: data dan hasil sama.
    #[test]
    fn perhatian_menurut_izin() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime uji");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("direktori sementara");
            let turso = klien_uji(&dir, "telegram-perhatian");
            turso.ensure_schema().await.expect("skema");
            turso
                .execute_atomic(
                    DATA_HRD
                        .iter()
                        .chain(DATA_REKRUTMEN)
                        .map(|s| Statement::new(*s, vec![]))
                        .collect(),
                )
                .await
                .expect("data uji");
            let t = baris(&turso, "SELECT date('now', '+7 hours') AS t, date('now', '+7 hours', '+5 days') AS k2, date('now', '+7 hours', '+3 days') AS c2, date('now', '+7 hours', '+20 days') AS k1, date('now', '+7 hours', '+30 days') AS d1, date('now', '+7 hours', '-1 day') AS d4, date('now', '+7 hours', '-4 days') AS p2, date('now', '+7 hours', '-1 day') AS p9, date('now', '+7 hours', '-3 days') AS p3;", vec![])
                .await
                .unwrap()
                .remove(0);
            let t = |kunci: &str| text(&t, kunci);

            let semua = perhatian(&turso, &izin_perhatian(|_| true)).await.unwrap();
            assert_eq!(
                semua["kontrak"],
                json!([
                    { "jenis": "Percobaan", "id_karyawan": "k2", "nama": "Sari", "jabatan": "Kasir", "tanggal": t("c2"), "sisa": 3 },
                    { "jenis": "PKWT", "id_karyawan": "k2", "nama": "Sari", "jabatan": "Kasir", "tanggal": t("k2"), "sisa": 5 },
                    { "jenis": "PKWT", "id_karyawan": "k1", "nama": "Budi", "jabatan": "Staf Gudang", "tanggal": t("k1"), "sisa": 20 },
                ])
            );
            assert_eq!(
                semua["dokumen"],
                json!([
                    { "id_karyawan": "k2", "nama": "Sari", "jabatan": "Kasir", "jenis_dokumen": "SIM B1", "tanggal": t("d4"), "sisa": -1 },
                    { "id_karyawan": "k1", "nama": "Budi", "jabatan": "Staf Gudang", "jenis_dokumen": "SIM B1", "tanggal": t("d1"), "sisa": 30 },
                ])
            );
            assert_eq!(
                semua["sp"],
                json!([{ "id_karyawan": "k2", "nama": "Sari", "jabatan": "Kasir", "tingkat": "SP2", "tanggal": t("t"), "sisa": 0 }])
            );
            assert_eq!(
                semua["pengajuan"],
                json!({
                    "menunggu": [
                        { "kelompok": "Cuti", "jumlah": 2, "hari": 2 },
                        { "kelompok": "Izin", "jumlah": 1, "hari": 2 },
                        { "kelompok": "Reimburse", "jumlah": 1, "hari": 2 },
                    ],
                    "menunggu_sejak": t("p2"),
                    "urgent": 1,
                    "urgent_sejak": t("p9"),
                })
            );
            assert_eq!(
                semua["ulang_tahun"],
                json!([
                    { "id_karyawan": "k1", "nama": "Budi", "jabatan": "Staf Gudang", "tanggal": t("t"), "tahun": 4 },
                    { "id_karyawan": "k2", "nama": "Sari", "jabatan": "Kasir", "tanggal": t("t"), "tahun": 8 },
                ])
            );
            let rekrutmen = semua["rekrutmen"].as_array().unwrap();
            assert_eq!(rekrutmen.len(), 1);
            assert_eq!(rekrutmen[0]["id_lowongan"], "L1");
            assert_eq!(rekrutmen[0]["judul"], "Staf Gudang");
            assert_eq!(rekrutmen[0]["jumlah"], 2);
            let hapus = rekrutmen[0]["tanggal_hapus"].as_str().unwrap();
            assert!(hapus > t("t").as_str() && hapus <= t("d1").as_str(), "{hapus}");
            assert!(!semua.to_string().contains("Rahasia"));

            // Tanpa izin: bagiannya tidak dibaca dan kuncinya tidak ada.
            let kunci = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            let reimburse = perhatian(&turso, &izin_perhatian(|p| p == "reimburse.decide")).await.unwrap();
            assert_eq!(kunci(&reimburse), ["pengajuan"]);
            assert_eq!(
                reimburse["pengajuan"],
                json!({
                    "menunggu": [{ "kelompok": "Reimburse", "jumlah": 1, "hari": 2 }],
                    "menunggu_sejak": t("p3"),
                    "urgent": 0,
                    "urgent_sejak": "",
                })
            );
            let karyawan = perhatian(&turso, &izin_perhatian(|p| p == "employees.view")).await.unwrap();
            assert_eq!(kunci(&karyawan), ["kontrak", "ulang_tahun"]);
            let sp = perhatian(&turso, &izin_perhatian(|p| p == "hr.warning.view")).await.unwrap();
            assert_eq!(kunci(&sp), ["sp"]);
            let kosong = perhatian(&turso, &IzinPerhatian::default()).await.unwrap();
            assert_eq!(kosong, json!({}));
        });
    }

    #[test]
    fn draft_wajib_lengkap() {
        let sah = json!({
            "aktif": true,
            "botToken": "",
            "grup": { "inventaris": "-100111", "keuangan": "", "pimpinan": "-100333", "armada": "-100444", "hrd": "-100555" },
            "kirim": {
                "pengajuan_baru": true, "pengajuan_putus": false, "stok_menipis": true,
                "kasbon_baru": true, "tutup_buku": false,
                "gaji_status": true, "buka_buku_pimpinan": false,
                "trip_kendala": true, "trip_selesai": false, "trip_tidak_jalan": true,
                "trip_dibatalkan": true, "trip_ganti_izin": true, "trip_lokasi_palsu": false,
                "hr_kontrak_akhir": true, "hr_percobaan_akhir": false, "hr_dokumen_kedaluwarsa": true,
                "hr_sp_berakhir": false, "hr_pengajuan_menunggu": true,
                "hr_urgent_belum_diketahui": false, "hr_ulang_tahun_kerja": true,
                "hr_kinerja_menunggu": false, "hr_kinerja_periode": true, "hr_pelamar_baru": false,
                "hr_lowongan_tutup": true, "hr_pengajuan_baru": false, "hr_pengajuan_diputus": true,
            },
        });
        let draft = baca_draft(&sah).unwrap();
        assert!(draft.aktif);
        assert_eq!(
            draft.grup,
            vec![
                ("inventaris", "-100111".to_owned()),
                ("keuangan", String::new()),
                ("pimpinan", "-100333".to_owned()),
                ("armada", "-100444".to_owned()),
                ("hrd", "-100555".to_owned())
            ]
        );
        assert_eq!(
            draft.kirim,
            vec![
                ("pengajuan_baru", true),
                ("pengajuan_putus", false),
                ("stok_menipis", true),
                ("kasbon_baru", true),
                ("tutup_buku", false),
                ("gaji_status", true),
                ("buka_buku_pimpinan", false),
                ("trip_kendala", true),
                ("trip_selesai", false),
                ("trip_tidak_jalan", true),
                ("trip_dibatalkan", true),
                ("trip_ganti_izin", true),
                ("trip_lokasi_palsu", false),
                ("hr_kontrak_akhir", true),
                ("hr_percobaan_akhir", false),
                ("hr_dokumen_kedaluwarsa", true),
                ("hr_sp_berakhir", false),
                ("hr_pengajuan_menunggu", true),
                ("hr_urgent_belum_diketahui", false),
                ("hr_ulang_tahun_kerja", true),
                ("hr_kinerja_menunggu", false),
                ("hr_kinerja_periode", true),
                ("hr_pelamar_baru", false),
                ("hr_lowongan_tutup", true),
                ("hr_pengajuan_baru", false),
                ("hr_pengajuan_diputus", true)
            ]
        );

        let mut asing = sah.clone();
        asing["is_active"] = json!(true);
        assert!(baca_draft(&asing).is_err());
        let mut tanpa_armada = sah.clone();
        tanpa_armada["grup"].as_object_mut().unwrap().remove("armada");
        assert!(baca_draft(&tanpa_armada).is_err());
        let mut tanpa_hrd = sah.clone();
        tanpa_hrd["kirim"].as_object_mut().unwrap().remove("hr_sp_berakhir");
        assert!(baca_draft(&tanpa_hrd).is_err());
        let mut kurang = sah.clone();
        kurang["kirim"]
            .as_object_mut()
            .unwrap()
            .remove("stok_menipis");
        assert!(baca_draft(&kurang).is_err());
        let mut grup_salah = sah.clone();
        grup_salah["grup"]["keuangan"] = json!("t.me/abc");
        assert!(baca_draft(&grup_salah).is_err());
        let mut token_salah = sah;
        token_salah["botToken"] = json!("bukan-token");
        assert!(baca_draft(&token_salah).is_err());
    }
}
