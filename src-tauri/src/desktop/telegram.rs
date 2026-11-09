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
    inventory::format_jumlah,
    models::CommandError,
    turso::{Statement, TursoClient},
    tutup_buku::tanggal_tampil,
};

pub const BIDANG: [&str; 4] = ["inventaris", "keuangan", "pimpinan", "armada"];
pub const KEJADIAN: [&str; 13] = [
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
];

/// Grup tujuan setiap kejadian. Cermin `BIDANG_KEJADIAN`.
pub fn bidang_kejadian(kejadian: &str) -> Option<&'static str> {
    match kejadian {
        "pengajuan_baru" | "kasbon_baru" | "tutup_buku" => Some("keuangan"),
        "pengajuan_putus" | "stok_menipis" => Some("inventaris"),
        "gaji_status" | "buka_buku_pimpinan" => Some("pimpinan"),
        "trip_kendala" | "trip_selesai" | "trip_tidak_jalan" | "trip_dibatalkan"
        | "trip_ganti_izin" | "trip_lokasi_palsu" => Some("armada"),
        _ => None,
    }
}

fn label_bidang(bidang: &str) -> &'static str {
    match bidang {
        "keuangan" => "Keuangan",
        "pimpinan" => "Pimpinan",
        "armada" => "Armada",
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

const SQL_JAM_WIB: &str = "SELECT date('now', '+7 hours') AS tanggal, date('now', '+7 hours', '-1 day') AS kemarin, CAST(strftime('%H', 'now', '+7 hours') AS INTEGER) AS jam;";

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
    catat_harian(turso, pengaturan).await
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

/// Cermin `catatHarian`: ringkasan sekali per tanggal, mulai 07.00 WIB.
async fn catat_harian(turso: &TursoClient, pengaturan: &Pengaturan) -> Result<(), CommandError> {
    if !pengaturan.siap("stok_menipis") {
        return Ok(());
    }
    let jam = turso.query_one(SQL_JAM_WIB, vec![]).await?.to_objects();
    let Some(jam) = jam.first() else {
        return Ok(());
    };
    if int(jam, "jam") < JAM_RINGKASAN_STOK {
        return Ok(());
    }

    let id_stok = format!("stok:{}", text(jam, "tanggal"));
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
            "SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now')) ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;",
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
                    "UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));",
                    vec![json!("Kejadian dimatikan atau grupnya belum diatur."), json!(id)],
                )
                .await?
                .rows_affected;
            dibatalkan += i64::from(changed > 0);
            continue;
        };

        let claimed = turso
            .query_one(
                "UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND (klaim_sampai IS NULL OR klaim_sampai < datetime('now'));",
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
                turso
                    .query_one(
                        "UPDATE notifikasi_telegram SET status = ?, attempt_count = ?, last_error = ?, klaim_oleh = NULL, klaim_sampai = NULL WHERE id_notifikasi = ? AND klaim_oleh = ?;",
                        vec![
                            json!(status),
                            json!(attempts),
                            json!(potong(&error, 500)),
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
        for kejadian in &KEJADIAN[7..] {
            assert_eq!(bidang_kejadian(kejadian), Some("armada"));
        }
        for (_, kejadian, _) in TRIP_TUTUP {
            assert!(KEJADIAN.contains(&kejadian));
        }
        assert_eq!(id_trip_kendala("lap-1"), "drv-kendala:lap-1");
        assert_eq!(id_trip_ganti_izin("lap-2"), "drv-ganti:lap-2");
        assert_eq!(id_trip_lokasi_palsu("lap-3"), "drv-palsu:lap-3");
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
            for kejadian in &KEJADIAN[7..] {
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

    #[test]
    fn draft_wajib_lengkap() {
        let sah = json!({
            "aktif": true,
            "botToken": "",
            "grup": { "inventaris": "-100111", "keuangan": "", "pimpinan": "-100333", "armada": "-100444" },
            "kirim": {
                "pengajuan_baru": true, "pengajuan_putus": false, "stok_menipis": true,
                "kasbon_baru": true, "tutup_buku": false,
                "gaji_status": true, "buka_buku_pimpinan": false,
                "trip_kendala": true, "trip_selesai": false, "trip_tidak_jalan": true,
                "trip_dibatalkan": true, "trip_ganti_izin": true, "trip_lokasi_palsu": false,
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
                ("armada", "-100444".to_owned())
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
                ("trip_lokasi_palsu", false)
            ]
        );

        let mut asing = sah.clone();
        asing["is_active"] = json!(true);
        assert!(baca_draft(&asing).is_err());
        let mut tanpa_armada = sah.clone();
        tanpa_armada["grup"].as_object_mut().unwrap().remove("armada");
        assert!(baca_draft(&tanpa_armada).is_err());
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
