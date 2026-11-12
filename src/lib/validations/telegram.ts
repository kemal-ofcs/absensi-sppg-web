/**
 * Notifikasi grup Telegram internal (schema v33): aturan murni.
 *
 * Kembar `desktop/telegram.rs`; setiap fungsi di sini diuji dengan vektor yang
 * sama di `telegram.test.ts` dan modul tes Rust-nya. Bot hanya MENGIRIM: tidak
 * ada perintah atau tombol dari Telegram yang bisa mengubah data, karena itu
 * akan melewati login, 2FA, dan RBAC.
 *
 * Kejadian tidak dikaitkan ke setiap jalur simpan. Pengirim membaca datanya
 * langsung (`TELEGRAM_SQL_*`) dan mencatatnya ke `notifikasi_telegram` dengan
 * id deterministik, jadi beberapa perangkat yang berjalan bersamaan tidak
 * pernah menggandakan pesan.
 */

import { formatRupiah } from "@/lib/validations/accounting";
import { formatJumlah } from "@/lib/validations/inventory";
import { tanggalTampil, waktuTampil } from "@/lib/validations/tutup-buku";

export const TELEGRAM_BIDANG = [
  "inventaris",
  "keuangan",
  "pimpinan",
  "armada",
  "hrd",
] as const;
export type BidangTelegram = (typeof TELEGRAM_BIDANG)[number];

export const TELEGRAM_KEJADIAN = [
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
] as const;
export type KejadianTelegram = (typeof TELEGRAM_KEJADIAN)[number];

/**
 * Grup tujuan setiap kejadian, ditetapkan di kode. Pengajuan baru ke Keuangan
 * karena merekalah yang meng-ACC; hasilnya ke Inventaris yang menunggu.
 */
export const BIDANG_KEJADIAN: Record<KejadianTelegram, BidangTelegram> = {
  pengajuan_baru: "keuangan",
  pengajuan_putus: "inventaris",
  stok_menipis: "inventaris",
  kasbon_baru: "keuangan",
  tutup_buku: "keuangan",
  gaji_status: "pimpinan",
  buka_buku_pimpinan: "pimpinan",
  trip_kendala: "armada",
  trip_selesai: "armada",
  trip_tidak_jalan: "armada",
  trip_dibatalkan: "armada",
  trip_ganti_izin: "armada",
  trip_lokasi_palsu: "armada",
  hr_kontrak_akhir: "hrd",
  hr_percobaan_akhir: "hrd",
  hr_dokumen_kedaluwarsa: "hrd",
  hr_sp_berakhir: "hrd",
  hr_pengajuan_menunggu: "hrd",
  hr_urgent_belum_diketahui: "hrd",
  hr_ulang_tahun_kerja: "hrd",
};

export const LABEL_BIDANG: Record<BidangTelegram, string> = {
  inventaris: "Inventaris",
  keuangan: "Keuangan",
  pimpinan: "Pimpinan",
  armada: "Armada",
  hrd: "HRD",
};

export const LABEL_KEJADIAN: Record<KejadianTelegram, string> = {
  pengajuan_baru: "Pengajuan pembelian baru",
  pengajuan_putus: "Pengajuan disetujui atau ditolak",
  stok_menipis: "Ringkasan stok di bawah minimum (sekali sehari)",
  kasbon_baru: "Pengajuan kasbon baru (tanpa nama karyawan)",
  tutup_buku: "Tutup buku dan buka kembali",
  gaji_status: "Status proses gaji (hanya jumlah pegawai dan total)",
  buka_buku_pimpinan: "Buku dibuka kembali",
  trip_kendala: "Kendala di perjalanan",
  trip_selesai: "Surat jalan selesai",
  trip_tidak_jalan: "Surat jalan tidak jalan",
  trip_dibatalkan: "Surat jalan dibatalkan",
  trip_ganti_izin: "Ganti kendaraan atau driver yang menunggu keputusan",
  trip_lokasi_palsu: "Lokasi palsu terdeteksi (perlu ditinjau)",
  hr_kontrak_akhir: "Kontrak PKWT akan berakhir (30 dan 7 hari sebelumnya)",
  hr_percobaan_akhir: "Masa percobaan akan berakhir (7 hari sebelumnya)",
  hr_dokumen_kedaluwarsa:
    "Dokumen karyawan akan kedaluwarsa (30 hari sebelumnya)",
  hr_sp_berakhir: "Masa berlaku surat peringatan berakhir",
  hr_pengajuan_menunggu:
    "Ringkasan pengajuan menunggu lebih dari 2 hari (tanpa nama, sekali sehari)",
  hr_urgent_belum_diketahui:
    "Ringkasan pengajuan urgent belum diketahui (tanpa nama, sekali sehari)",
  hr_ulang_tahun_kerja: "Ringkasan ulang tahun kerja (sekali sehari)",
};

/** Kunci `app_telegram_setting`. Cermin konstanta `KUNCI_*` di Rust. */
export const KUNCI_TOKEN = "bot_token";
export const KUNCI_AKTIF = "aktif";
export const KUNCI_AKTIF_SEJAK = "aktif_sejak";
export const kunciGrup = (bidang: BidangTelegram) => `grup:${bidang}`;
export const kunciKirim = (kejadian: KejadianTelegram) => `kirim:${kejadian}`;

/** Ringkasan stok dikirim mulai jam ini (WIB), sekali per tanggal. */
export const JAM_RINGKASAN_STOK = 7;
export const MAKS_BARIS_STOK = 30;
/** Baris antrean per siklus; batas Telegram ±20 pesan/menit per grup. */
export const TELEGRAM_BATCH = 20;
/** Pesan yang gagal dicoba ulang sampai sekian kali, lalu berstatus `Gagal`. */
export const TELEGRAM_BATAS_PERCOBAAN = 3;
export const TELEGRAM_RIWAYAT = 10;

export const TELEGRAM_UPSERT_SETTING_SQL =
  "INSERT INTO app_telegram_setting (kunci, nilai, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at;";

export const TELEGRAM_INSERT_ANTREAN_SQL =
  "INSERT OR IGNORE INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan) VALUES (?, ?, ?);";

/**
 * Nilai pengajuan = jumlah `nilai_baris` (barang desimal menyimpan jumlah ×100).
 * Kejadian yang terjadi sebelum Telegram diaktifkan (`?` = `aktif_sejak`, UTC)
 * atau lebih dari 7 hari lalu tidak dikirim: grup tidak dibanjiri pesan basi.
 */
const NILAI_PENGAJUAN_SQL = `(SELECT COALESCE(SUM(CASE WHEN b.desimal = 1 THEN (b.jumlah * b.harga_satuan + 50) / 100 ELSE b.jumlah * b.harga_satuan END), 0) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan)`;

export const TELEGRAM_SQL_PENGAJUAN_BARU = `SELECT p.id_pengajuan, p.nomor, p.keperluan, p.cara_bayar,
       COALESCE(o.nama_operator, p.diajukan_oleh) AS pengaju,
       (SELECT COUNT(*) FROM inventory_pengajuan_baris b WHERE b.id_pengajuan = p.id_pengajuan) AS jumlah_baris,
       ${NILAI_PENGAJUAN_SQL} AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = p.diajukan_oleh
WHERE p.created_at >= ? AND p.created_at >= datetime('now', '-7 days')
  AND p.disetujui_pada IS NULL AND p.ditolak_pada IS NULL AND p.dibatalkan_pada IS NULL
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-baru:' || p.id_pengajuan)
ORDER BY p.created_at
LIMIT 50;`;

/** `disetujui_pada`/`ditolak_pada` disimpan WIB, `aktif_sejak` UTC. */
export const TELEGRAM_SQL_PENGAJUAN_PUTUS = `SELECT p.id_pengajuan, p.nomor, p.keperluan,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN 1 ELSE 0 END AS disetujui,
       COALESCE(o.nama_operator, p.disetujui_oleh, p.ditolak_oleh) AS pemutus,
       CASE WHEN p.disetujui_pada IS NOT NULL THEN p.catatan_persetujuan ELSE p.alasan_tolak END AS catatan,
       ${NILAI_PENGAJUAN_SQL} AS total
FROM inventory_pengajuan p
LEFT JOIN master_operator o ON o.username = COALESCE(p.disetujui_oleh, p.ditolak_oleh)
WHERE COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime(?, '+7 hours')
  AND COALESCE(p.disetujui_pada, p.ditolak_pada) >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'pgj-putus:' || p.id_pengajuan)
ORDER BY COALESCE(p.disetujui_pada, p.ditolak_pada)
LIMIT 50;`;

/** Aturan `stokMenipis`: minimum di atas nol dan stok kondisi Baik di bawahnya. */
export const TELEGRAM_SQL_STOK_MENIPIS = `SELECT kode_barang, nama_barang, satuan, desimal, stok_minimum, stok_baik FROM (
  SELECT b.kode_barang, b.nama_barang, b.satuan, b.desimal, b.stok_minimum,
         COALESCE((SELECT SUM(s.saldo) FROM inventory_saldo s WHERE s.id_barang = b.id_barang AND s.kondisi = 'Baik'), 0) AS stok_baik
  FROM inventory_barang b
  WHERE b.status_aktif = 1 AND b.dihapus_pada IS NULL AND b.stok_minimum > 0
) WHERE stok_baik < stok_minimum
ORDER BY nama_barang COLLATE NOCASE
-- batas: satu baris per barang aktif yang stoknya di bawah minimum
;`;

/** Kasbon lahir `Diajukan`; yang sudah diputus sebelum terlihat tidak dikirim. */
export const TELEGRAM_SQL_KASBON_BARU = `SELECT k.id_pinjaman, k.pokok, k.cicilan, k.mulai_potong
FROM keu_pinjaman k
WHERE k.created_at >= ? AND k.created_at >= datetime('now', '-7 days')
  AND k.status = 'Diajukan'
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'kasbon:' || k.id_pinjaman)
ORDER BY k.created_at
LIMIT 50;`;

/** Tutup buku baru; `Menunggu` = bentrok dengan tutup buku perangkat lain. */
export const TELEGRAM_SQL_TUTUP_BUKU = `SELECT t.id_tutup, t.sampai_tanggal, t.status, COALESCE(o.nama_operator, t.dibuat_oleh) AS oleh
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuat_oleh
WHERE t.created_at >= ? AND t.created_at >= datetime('now', '-7 days')
  AND t.status IN ('Aktif', 'Menunggu')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'tutup:' || t.id_tutup)
ORDER BY t.created_at
LIMIT 50;`;

/**
 * `dibuka_pada` disimpan WIB, `aktif_sejak` UTC. Parameter kedua = awalan id
 * (`AWALAN_BUKA` ke Keuangan, `AWALAN_BUKA_PIMPINAN` ke Pimpinan): satu
 * pembukaan menjadi dua pesan berbeda id.
 */
export const TELEGRAM_SQL_BUKA_BUKU = `SELECT t.id_tutup, t.sampai_tanggal, COALESCE(o.nama_operator, t.dibuka_oleh) AS oleh, t.alasan_buka
FROM keu_tutup_buku t
LEFT JOIN master_operator o ON o.username = t.dibuka_oleh
WHERE t.status = 'Dibuka'
  AND t.dibuka_pada >= datetime(?, '+7 hours') AND t.dibuka_pada >= datetime('now', '+7 hours', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ? || t.id_tutup)
ORDER BY t.dibuka_pada
LIMIT 50;`;

/**
 * Perubahan status proses gaji dari `payroll_audit_logs` (satu baris = satu
 * pesan). Hanya angka agregat dari `payroll_runs`: rincian per pegawai tidak
 * pernah dibaca. Waktu log berformat ISO, jadi dinormalkan lewat `datetime()`.
 */
export const TELEGRAM_SQL_GAJI_STATUS = `SELECT a.id, a.new_status, a.notes, r.period_start, r.period_end,
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
LIMIT 50;`;

/**
 * Laporan perjalanan (v34) disaring jam cloud `diterima_cloud` (UTC), bukan jam
 * perangkat: laporan offline yang telat sampai tetap dikirim selama sampai di
 * cloud dalam 7 hari. `telat_menit` = jam cloud − jam kejadian di perangkat.
 * Laporan yang surat jalannya belum sampai di cloud menunggu siklus berikutnya.
 * Parameter pertama = `aktif_sejak`.
 */
const KOLOM_LAPORAN_SQL = `SELECT l.id_laporan, l.id_perjalanan, l.jenis, l.mode_ganti, l.jenis_kendala, l.terlambat_menit,
       l.nama_lokasi, l.keterangan, l.id_karyawan, l.id_karyawan_baru, l.id_kendaraan_baru, l.waktu_perangkat,
       p.nomor, p.id_karyawan AS awal_karyawan, p.id_kendaraan AS awal_kendaraan,
       datetime(l.waktu_perangkat, '+7 hours') AS waktu_wib,
       COALESCE(CAST(ROUND((julianday(l.diterima_cloud) - julianday(l.waktu_perangkat)) * 1440) AS INTEGER), 0) AS telat_menit,
       COALESCE(o.nama_operator, l.dilaporkan_oleh) AS oleh
FROM drv_laporan l
JOIN drv_perjalanan p ON p.id_perjalanan = l.id_perjalanan
LEFT JOIN master_operator o ON o.username = l.dilaporkan_oleh
WHERE l.diterima_cloud >= ? AND l.diterima_cloud >= datetime('now', '-7 days')`;

export const TELEGRAM_SQL_TRIP_KENDALA = `${KOLOM_LAPORAN_SQL}
  AND l.jenis = 'Kendala'
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-kendala:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;`;

/**
 * Parameter: `aktif_sejak`, jenis laporan penutup, awalan id. Satu pesan per
 * surat jalan: laporan penutup kembar dari dua perangkat offline berbagi id.
 */
export const TELEGRAM_SQL_TRIP_TUTUP = `${KOLOM_LAPORAN_SQL}
  AND l.jenis = ?
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ? || l.id_perjalanan)
ORDER BY l.diterima_cloud, l.waktu_perangkat, l.id_laporan
LIMIT 50;`;

/** Ganti dari driver yang belum diputuskan saat dibaca. */
export const TELEGRAM_SQL_TRIP_GANTI_IZIN = `${KOLOM_LAPORAN_SQL}
  AND l.jenis IN ('Ganti Kendaraan', 'Ganti Driver') AND l.mode_ganti IN ('Darurat', 'Minta Izin')
  AND NOT EXISTS (SELECT 1 FROM drv_laporan k WHERE k.id_perjalanan = l.id_perjalanan AND k.jenis IN ('Disetujui', 'Ditolak') AND k.id_ref = l.id_laporan)
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-ganti:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;`;

export const TELEGRAM_SQL_TRIP_LOKASI_PALSU = `${KOLOM_LAPORAN_SQL}
  AND l.lokasi_palsu = 1
  AND NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = 'drv-palsu:' || l.id_laporan)
ORDER BY l.diterima_cloud, l.id_laporan
LIMIT 50;`;

/** Bahan `penugasan`: seluruh laporan satu surat jalan. */
export const TELEGRAM_SQL_TRIP_LAPORAN =
  "SELECT id_laporan, jenis, mode_ganti, id_ref, waktu_perangkat, id_karyawan_baru, id_kendaraan_baru FROM drv_laporan WHERE id_perjalanan = ?;";
export const TELEGRAM_SQL_NAMA_PERSONIL =
  "SELECT nama FROM master_data WHERE id_unik = ?;";
export const TELEGRAM_SQL_LABEL_KENDARAAN =
  "SELECT TRIM(COALESCE(j.nama, '') || ' ' || k.identitas) AS label FROM drv_kendaraan k LEFT JOIN drv_jenis_kendaraan j ON j.id_jenis = k.id_jenis WHERE k.id_kendaraan = ?;";

export const TELEGRAM_SQL_JAM_WIB =
  "SELECT date('now', '+7 hours') AS tanggal, date('now', '+7 hours', '-1 day') AS kemarin, CAST(strftime('%H', 'now', '+7 hours') AS INTEGER) AS jam;";

// ── Pengingat HR ke grup HRD (fase 8, prd-hris.md §23) ─────────────────────

/** Jendela pengingat (§23.3, Q-106): tetap di kode, tidak bisa diatur. */
export const HR_HARI_JAUH = 30;
export const HR_HARI_DEKAT = 7;
export const HR_HARI_MENUNGGU = 2;

/**
 * Parkir klaim (§23.2, Q-101): baris kejadian HR lahir dengan klaim yang tidak
 * pernah kedaluwarsa, jadi build sebelum fase 8 (yang hanya mengambil dan
 * membatalkan baris tanpa klaim berlaku) tidak pernah menyentuhnya. Build fase
 * 8 mengenali `gen:2`; kejadian sesudahnya memakai `gen:3` dan seterusnya.
 */
export const KLAIM_PARKIR = "gen:2";
export const KLAIM_PARKIR_SAMPAI = "9999-12-31 23:59:59";
export const TELEGRAM_INSERT_ANTREAN_PARKIR_SQL = `INSERT OR IGNORE INTO notifikasi_telegram (id_notifikasi, kejadian, isi_pesan, klaim_oleh, klaim_sampai) VALUES (?, ?, ?, '${KLAIM_PARKIR}', '${KLAIM_PARKIR_SAMPAI}');`;

/**
 * Predikat antrean pengirim, cermin `DRAIN_*_SQL`. Sama dengan v33 ditambah
 * `OR klaim_oleh = 'gen:2'`: baris parkir terlihat build ini, dan klaimnya
 * tetap atomik karena UPDATE klaim mengganti `klaim_oleh`.
 */
const KLAIM_BEBAS_SQL = `(klaim_sampai IS NULL OR klaim_sampai < datetime('now') OR klaim_oleh = '${KLAIM_PARKIR}')`;
export const TELEGRAM_DRAIN_PILIH_SQL = `SELECT id_notifikasi, kejadian, isi_pesan, attempt_count FROM notifikasi_telegram WHERE status = 'Menunggu' AND ${KLAIM_BEBAS_SQL} ORDER BY created_at ASC, id_notifikasi ASC LIMIT ?;`;
export const TELEGRAM_DRAIN_BATAL_SQL = `UPDATE notifikasi_telegram SET status = 'Dibatalkan', last_error = ? WHERE id_notifikasi = ? AND status = 'Menunggu' AND ${KLAIM_BEBAS_SQL};`;
export const TELEGRAM_DRAIN_KLAIM_SQL = `UPDATE notifikasi_telegram SET klaim_oleh = ?, klaim_sampai = datetime('now', '+5 minutes') WHERE id_notifikasi = ? AND status = 'Menunggu' AND ${KLAIM_BEBAS_SQL};`;
export const TELEGRAM_DRAIN_GAGAL_SQL =
  "UPDATE notifikasi_telegram SET status = ?, attempt_count = ?, last_error = ?, klaim_oleh = ?, klaim_sampai = ? WHERE id_notifikasi = ? AND klaim_oleh = ?;";

/** Cermin `diparkir`: generasi `gen:2` = semua kejadian bidang `hrd`. */
export function diparkir(kejadian: string): boolean {
  return (
    (BIDANG_KEJADIAN as Record<string, BidangTelegram | undefined>)[
      kejadian
    ] === "hrd"
  );
}

/**
 * Cermin `klaim_setelah_gagal`: baris parkir yang masih boleh dicoba ulang
 * kembali diparkir, supaya build lama tetap tidak bisa membatalkannya; selain
 * itu klaim dikosongkan seperti v33.
 */
export function klaimSetelahGagal(
  kejadian: string,
  status: string,
): { klaimOleh: string | null; klaimSampai: string | null } {
  return status === "Menunggu" && diparkir(kejadian)
    ? { klaimOleh: KLAIM_PARKIR, klaimSampai: KLAIM_PARKIR_SAMPAI }
    : { klaimOleh: null, klaimSampai: null };
}

/**
 * Bagian bersama SQL sumber HR. "Hari ini" selalu tanggal WIB jam database
 * (aturan 19); karyawan hanya yang Aktif; jabatan = master jabatan, lalu teks
 * lama. Kolom yang tidak pernah boleh terkirim (NIK, `hr_profil`, nominal,
 * alasan, isi SP, nomor dokumen dan kontrak, data pelamar) tidak dibaca sama
 * sekali (Q-32).
 */
const HARI_INI_SQL = "date('now', '+7 hours')";
const KARYAWAN_SQL = (alias: string) =>
  `JOIN master_data m ON m.id_unik = ${alias}.id_karyawan AND m.status_aktif = 'Aktif' LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan`;
const JABATAN_SQL = "COALESCE(j.nama, m.jabatan_status) AS jabatan";
const SISA_SQL = (kolom: string) =>
  `CAST(julianday(date(${kolom})) - julianday(${HARI_INI_SQL}) AS INTEGER) AS sisa`;
/**
 * Kontrak `k` tidak dibatalkan dan merupakan kontrak terakhir karyawannya
 * (urutan `JENIS_DARI_KONTRAK_SQL`): yang sudah diperpanjang atau diangkat
 * tidak diingatkan (Q-110).
 */
const KONTRAK_TERAKHIR_SQL = `k.jenis <> 'Pembatalan'
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak b WHERE b.id_kontrak = 'batal-' || k.id_kontrak)
    AND NOT EXISTS (SELECT 1 FROM hr_kontrak l WHERE l.id_karyawan = k.id_karyawan AND l.jenis <> 'Pembatalan'
      AND (l.tanggal_mulai > k.tanggal_mulai OR (l.tanggal_mulai = k.tanggal_mulai AND l.id_kontrak > k.id_kontrak))
      AND NOT EXISTS (SELECT 1 FROM hr_kontrak lb WHERE lb.id_kontrak = 'batal-' || l.id_kontrak))`;
const BELUM_DIANTREKAN_SQL = (id: string) =>
  `NOT EXISTS (SELECT 1 FROM notifikasi_telegram n WHERE n.id_notifikasi = ${id})`;
const TANPA_BATAL_SQL =
  "NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan b WHERE b.id_pengajuan = p.id_pengajuan AND b.jenis = 'Batal')";

/** PKWT berakhir: sisa 8–30 hari = tahap `:30`, 0–7 hari = tahap `:7`. */
export const TELEGRAM_SQL_HR_KONTRAK = `SELECT id_kontrak, tanggal_selesai, nama, jabatan, sisa FROM (
  SELECT k.id_kontrak, k.tanggal_selesai, m.nama, ${JABATAN_SQL},
         ${SISA_SQL("k.tanggal_selesai")}
  FROM hr_kontrak k
  ${KARYAWAN_SQL("k")}
  WHERE k.jenis = 'PKWT' AND date(k.tanggal_selesai) IS NOT NULL
    AND ${KONTRAK_TERAKHIR_SQL}
) WHERE sisa BETWEEN 0 AND ${HR_HARI_JAUH}
  AND ${BELUM_DIANTREKAN_SQL(`'hr-kontrak:' || id_kontrak || CASE WHEN sisa <= ${HR_HARI_DEKAT} THEN ':${HR_HARI_DEKAT}' ELSE ':${HR_HARI_JAUH}' END`)}
ORDER BY tanggal_selesai, id_kontrak
LIMIT 50;`;

export const TELEGRAM_SQL_HR_PERCOBAAN = `SELECT id_kontrak, percobaan_selesai, nama, jabatan, sisa FROM (
  SELECT k.id_kontrak, k.percobaan_selesai, m.nama, ${JABATAN_SQL},
         ${SISA_SQL("k.percobaan_selesai")}
  FROM hr_kontrak k
  ${KARYAWAN_SQL("k")}
  WHERE date(k.percobaan_selesai) IS NOT NULL
    AND ${KONTRAK_TERAKHIR_SQL}
) WHERE sisa BETWEEN 0 AND ${HR_HARI_DEKAT}
  AND ${BELUM_DIANTREKAN_SQL("'hr-coba:' || id_kontrak")}
ORDER BY percobaan_selesai, id_kontrak
LIMIT 50;`;

/** Sertifikat pelatihan ikut: jenisnya `dok-sertifikat` (Q-97). */
export const TELEGRAM_SQL_HR_DOKUMEN = `SELECT id_dokumen, jenis_dokumen, tanggal_kedaluwarsa, nama, jabatan, sisa FROM (
  SELECT d.id_dokumen, COALESCE(dj.nama, d.id_jenis) AS jenis_dokumen, d.tanggal_kedaluwarsa, m.nama, ${JABATAN_SQL},
         ${SISA_SQL("d.tanggal_kedaluwarsa")}
  FROM hr_dokumen d
  LEFT JOIN hr_dokumen_jenis dj ON dj.id_jenis = d.id_jenis
  ${KARYAWAN_SQL("d")}
  WHERE date(d.tanggal_kedaluwarsa) IS NOT NULL
) WHERE sisa BETWEEN 0 AND ${HR_HARI_JAUH}
  AND ${BELUM_DIANTREKAN_SQL("'hr-dok:' || id_dokumen || ':' || tanggal_kedaluwarsa")}
ORDER BY tanggal_kedaluwarsa, id_dokumen
LIMIT 50;`;

/**
 * SP yang hari terakhir berlakunya hari ini sampai 6 hari lalu (Q-109) dan
 * tidak sebelum Telegram dinyalakan (`?` = `aktif_sejak`, UTC).
 */
export const TELEGRAM_SQL_HR_SP = `SELECT s.id_sp, s.tingkat, s.berlaku_sampai, m.nama, ${JABATAN_SQL}
FROM hr_sp s
${KARYAWAN_SQL("s")}
WHERE s.dicabut_pada IS NULL
  AND s.berlaku_sampai <= ${HARI_INI_SQL} AND s.berlaku_sampai >= date('now', '+7 hours', '-${HR_HARI_DEKAT - 1} days')
  AND s.berlaku_sampai >= date(?, '+7 hours')
  AND ${BELUM_DIANTREKAN_SQL("'hr-sp:' || s.id_sp")}
ORDER BY s.berlaku_sampai, s.id_sp
LIMIT 50;`;

/**
 * Pengajuan berstatus Menunggu (`statusPengajuan`: tanpa `Batal`, tanpa
 * keputusan final bersidik sekarang) yang diterima cloud lebih dari 2 × 24
 * jam lalu, dihitung per kelompok. Klaim Reimburse ikut (Q-107); tanpa nama
 * (Q-108). `sejak` = tanggal WIB yang paling lama.
 */
export const TELEGRAM_SQL_HR_MENUNGGU = `SELECT p.kelompok, COUNT(*) AS jumlah, date(MIN(p.created_at), '+7 hours') AS sejak
FROM hr_pengajuan p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif'
WHERE p.created_at <= datetime('now', '-${HR_HARI_MENUNGGU} days')
  AND ${TANPA_BATAL_SQL}
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent'))
GROUP BY p.kelompok
ORDER BY p.kelompok;`;

/** Tanda `perlu_diketahui`: keputusan berlaku `Setujui Urgent`, belum `Diketahui`. */
export const TELEGRAM_SQL_HR_URGENT = `SELECT COUNT(*) AS jumlah, date(MIN(p.created_at), '+7 hours') AS sejak
FROM hr_pengajuan p
JOIN master_data m ON m.id_unik = p.id_karyawan AND m.status_aktif = 'Aktif'
WHERE ${TANPA_BATAL_SQL}
  AND NOT EXISTS (SELECT 1 FROM hr_pengajuan_keputusan d WHERE d.id_pengajuan = p.id_pengajuan AND d.jenis = 'Diketahui')
  AND (SELECT k.jenis FROM hr_pengajuan_keputusan k WHERE k.id_pengajuan = p.id_pengajuan AND k.sidik = p.sidik AND k.jenis IN ('Setujui', 'Tolak', 'Setujui Urgent') ORDER BY k.diterima_cloud IS NULL, k.diterima_cloud, k.waktu_perangkat, k.id_keputusan LIMIT 1) = 'Setujui Urgent';`;

/**
 * Bulan-hari Tanggal Masuk = hari ini, tahun sebelumnya. 29 Feb jatuh di
 * 28 Feb pada tahun bukan kabisat (sama dengan `tambah_bulan`). Tanggal masuk
 * yang bukan tanggal sah dilewati.
 */
const TAHUN_KERJA_SQL =
  "CAST(strftime('%Y', h.hari) AS INTEGER) - CAST(strftime('%Y', date(m.tanggal_daftar)) AS INTEGER) AS tahun";
const ULTAH_SYARAT_SQL = `date(m.tanggal_daftar) IS NOT NULL
  AND date(m.tanggal_daftar) < date(h.hari, 'start of year')
  AND (strftime('%m-%d', date(m.tanggal_daftar)) = strftime('%m-%d', h.hari)
    OR (strftime('%m-%d', date(m.tanggal_daftar)) = '02-29' AND strftime('%m-%d', h.hari) = '02-28' AND strftime('%m-%d', h.hari, '+1 day') = '03-01'))`;
export const TELEGRAM_SQL_HR_ULTAH = `SELECT m.nama, ${JABATAN_SQL},
       ${TAHUN_KERJA_SQL}
FROM (SELECT ${HARI_INI_SQL} AS hari) h
JOIN master_data m ON m.status_aktif = 'Aktif'
LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE ${ULTAH_SYARAT_SQL}
ORDER BY m.nama COLLATE NOCASE, m.id_unik;`;

// ── Kartu "Perlu perhatian" di /hris (§23.4) ──────────────────────────────
// Potongan SQL yang sama dengan pengingat Telegram di atas, jadi kartu dan
// grup HRD tidak bisa berbeda pendapat. Kartu lebih lebar: dokumen yang sudah
// lewat, SP 7 hari sebelum berakhir, ulang tahun kerja 7 hari ke depan.
// Bagian pengajuan memakai `TELEGRAM_SQL_HR_MENUNGGU`/`_URGENT` apa adanya.

export const PERHATIAN_SQL_KONTRAK = `SELECT jenis, id_karyawan, nama, jabatan, tanggal, sisa FROM (
  SELECT 'PKWT' AS jenis, k.id_karyawan, m.nama, ${JABATAN_SQL}, k.tanggal_selesai AS tanggal, ${SISA_SQL("k.tanggal_selesai")}
  FROM hr_kontrak k
  ${KARYAWAN_SQL("k")}
  WHERE k.jenis = 'PKWT' AND date(k.tanggal_selesai) IS NOT NULL
    AND ${KONTRAK_TERAKHIR_SQL}
  UNION ALL
  SELECT 'Percobaan' AS jenis, k.id_karyawan, m.nama, ${JABATAN_SQL}, k.percobaan_selesai AS tanggal, ${SISA_SQL("k.percobaan_selesai")}
  FROM hr_kontrak k
  ${KARYAWAN_SQL("k")}
  WHERE date(k.percobaan_selesai) IS NOT NULL
    AND ${KONTRAK_TERAKHIR_SQL}
) WHERE (jenis = 'PKWT' AND sisa BETWEEN 0 AND ${HR_HARI_JAUH}) OR (jenis = 'Percobaan' AND sisa BETWEEN 0 AND ${HR_HARI_DEKAT})
ORDER BY sisa, nama COLLATE NOCASE, id_karyawan, jenis
LIMIT 200;`;

/** Termasuk dokumen yang sudah lewat (sisa negatif). */
export const PERHATIAN_SQL_DOKUMEN = `SELECT id_karyawan, nama, jabatan, jenis_dokumen, tanggal, sisa FROM (
  SELECT d.id_karyawan, m.nama, ${JABATAN_SQL}, COALESCE(dj.nama, d.id_jenis) AS jenis_dokumen, d.tanggal_kedaluwarsa AS tanggal, ${SISA_SQL("d.tanggal_kedaluwarsa")}
  FROM hr_dokumen d
  LEFT JOIN hr_dokumen_jenis dj ON dj.id_jenis = d.id_jenis
  ${KARYAWAN_SQL("d")}
  WHERE date(d.tanggal_kedaluwarsa) IS NOT NULL
) WHERE sisa <= ${HR_HARI_JAUH}
ORDER BY sisa, nama COLLATE NOCASE, id_karyawan
LIMIT 200;`;

/** SP yang masih Berlaku dan berakhir dalam 7 hari (Q-109). */
export const PERHATIAN_SQL_SP = `SELECT s.id_karyawan, m.nama, ${JABATAN_SQL}, s.tingkat, s.berlaku_sampai AS tanggal, ${SISA_SQL("s.berlaku_sampai")}
FROM hr_sp s
${KARYAWAN_SQL("s")}
WHERE s.dicabut_pada IS NULL AND s.tanggal <= ${HARI_INI_SQL}
  AND s.berlaku_sampai >= ${HARI_INI_SQL} AND s.berlaku_sampai <= date('now', '+7 hours', '+${HR_HARI_DEKAT} days')
ORDER BY s.berlaku_sampai, m.nama COLLATE NOCASE, s.id_sp
LIMIT 200;`;

/** Hari ini dan 7 hari ke depan; syarat tanggalnya sama dengan Telegram. */
export const PERHATIAN_SQL_ULTAH = `WITH RECURSIVE h(hari, n) AS (SELECT ${HARI_INI_SQL}, 0 UNION ALL SELECT date(hari, '+1 day'), n + 1 FROM h WHERE n < ${HR_HARI_DEKAT})
SELECT m.id_unik AS id_karyawan, m.nama, ${JABATAN_SQL}, h.hari AS tanggal,
       ${TAHUN_KERJA_SQL}
FROM h
JOIN master_data m ON m.status_aktif = 'Aktif'
LEFT JOIN hr_jabatan j ON j.id_jabatan = m.id_jabatan
WHERE ${ULTAH_SYARAT_SQL}
ORDER BY h.hari, m.nama COLLATE NOCASE, m.id_unik
LIMIT 200;`;

/**
 * Izin yang membuka kartu (salah satu). Cermin `IZIN_PERHATIAN`. Setiap
 * bagian disaring lagi per izin oleh `izinPerhatian` (aturan 10, 44).
 */
export const IZIN_PERHATIAN = [
  "employees.view",
  "hr.document.view",
  "hr.warning.view",
  "hr.request.view",
  "reimburse.decide",
  "hr.recruit.view",
  "hr.recruit.manage",
] as const;

export interface IzinPerhatian {
  kontrak: boolean;
  dokumen: boolean;
  sp: boolean;
  pengajuan: boolean;
  /** Tanpa `hr.request.view`: hanya hitungan Reimburse (§19.5). */
  hanyaReimburse: boolean;
  rekrutmen: boolean;
}

/**
 * Cermin `izin_perhatian`. Kontrak dan ulang tahun kerja = `employees.view`
 * (Q-112); izinnya sama dengan izin membaca datanya hari ini.
 */
export function izinPerhatian(
  punya: (izin: (typeof IZIN_PERHATIAN)[number]) => boolean,
): IzinPerhatian {
  return {
    kontrak: punya("employees.view"),
    dokumen: punya("hr.document.view"),
    sp: punya("hr.warning.view"),
    pengajuan: punya("hr.request.view") || punya("reimburse.decide"),
    hanyaReimburse: !punya("hr.request.view"),
    rekrutmen: punya("hr.recruit.view") || punya("hr.recruit.manage"),
  };
}

/** Bentuk hasil `desktop_hr_attention` / aksi `perhatian`. Bagian tanpa izin tidak ada. */
export interface PerhatianHr {
  kontrak?: {
    jenis: "PKWT" | "Percobaan";
    id_karyawan: string;
    nama: string;
    jabatan: string;
    tanggal: string;
    sisa: number;
  }[];
  dokumen?: {
    id_karyawan: string;
    nama: string;
    jabatan: string;
    jenis_dokumen: string;
    tanggal: string;
    sisa: number;
  }[];
  sp?: {
    id_karyawan: string;
    nama: string;
    jabatan: string;
    tingkat: string;
    tanggal: string;
    sisa: number;
  }[];
  pengajuan?: {
    menunggu: { kelompok: string; jumlah: number }[];
    menunggu_sejak: string;
    urgent: number;
    urgent_sejak: string;
  };
  ulang_tahun?: {
    id_karyawan: string;
    nama: string;
    jabatan: string;
    tanggal: string;
    tahun: number;
  }[];
  rekrutmen?: {
    id_lowongan: string;
    judul: string;
    jumlah: number;
    tanggal_hapus: string;
  }[];
}

/** Tahap pengingat kontrak menurut sisa hari: `:7` atau `:30`. */
export function idHrKontrak(idKontrak: string, sisa: number) {
  return `hr-kontrak:${idKontrak}:${sisa <= HR_HARI_DEKAT ? HR_HARI_DEKAT : HR_HARI_JAUH}`;
}
export function idHrPercobaan(idKontrak: string) {
  return `hr-coba:${idKontrak}`;
}
/** Memuat tanggalnya: dokumen yang diperpanjang diingatkan lagi (Q-104). */
export function idHrDokumen(idDokumen: string, tanggalKedaluwarsa: string) {
  return `hr-dok:${idDokumen}:${tanggalKedaluwarsa}`;
}
export function idHrSp(idSp: string) {
  return `hr-sp:${idSp}`;
}
export function idHrMenunggu(tanggal: string) {
  return `hr-tunggu:${tanggal}`;
}
export function idHrUrgent(tanggal: string) {
  return `hr-urgent:${tanggal}`;
}
export function idHrUltah(tanggal: string) {
  return `hr-ultah:${tanggal}`;
}

export function idPengajuanBaru(idPengajuan: string) {
  return `pgj-baru:${idPengajuan}`;
}
export function idPengajuanPutus(idPengajuan: string) {
  return `pgj-putus:${idPengajuan}`;
}
export function idStokMenipis(tanggal: string) {
  return `stok:${tanggal}`;
}
export function idKasbonBaru(idPinjaman: string) {
  return `kasbon:${idPinjaman}`;
}
export function idTutupBuku(idTutup: string) {
  return `tutup:${idTutup}`;
}
export const AWALAN_BUKA = "buka:";
export const AWALAN_BUKA_PIMPINAN = "buka-pimpinan:";
export function idGajiStatus(idLog: string) {
  return `gaji:${idLog}`;
}
export function idTripKendala(idLaporan: string) {
  return `drv-kendala:${idLaporan}`;
}
export function idTripGantiIzin(idLaporan: string) {
  return `drv-ganti:${idLaporan}`;
}
export function idTripLokasiPalsu(idLaporan: string) {
  return `drv-palsu:${idLaporan}`;
}

/** Laporan penutup surat jalan → kejadian dan awalan id (satu per surat jalan). */
export const TRIP_TUTUP: readonly {
  jenis: "Selesai" | "Tidak Jalan" | "Dibatalkan";
  kejadian: KejadianTelegram;
  awalan: string;
}[] = [
  { jenis: "Selesai", kejadian: "trip_selesai", awalan: "drv-selesai:" },
  {
    jenis: "Tidak Jalan",
    kejadian: "trip_tidak_jalan",
    awalan: "drv-tidak-jalan:",
  },
  { jenis: "Dibatalkan", kejadian: "trip_dibatalkan", awalan: "drv-batal:" },
];

/** Cermin `token_bot_valid`: `<id bot>:<rahasia>` dari BotFather. */
export function tokenBotValid(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token);
}

/**
 * Cermin `normalisasi_chat_id`. String kosong = grup belum diatur;
 * `null` = isinya bukan id chat Telegram.
 */
export function normalisasiChatId(raw: string): string | null {
  const nilai = raw.trim();
  if (nilai === "") return "";
  return /^-?\d{1,20}$/.test(nilai) ? nilai : null;
}

/**
 * Token bot ada di URL API Telegram, jadi pesan galat jaringan bisa memuatnya.
 * Cermin `samarkan_token`: setiap kemunculannya diganti sebelum disimpan atau
 * ditampilkan.
 */
export function samarkanToken(teks: string, token: string): string {
  return token === "" ? teks : teks.split(token).join("***");
}

/** Cermin `potong`: dihitung per karakter, bukan byte. */
export function potong(teks: string, maks: number): string {
  const karakter = Array.from(teks.trim());
  return karakter.length <= maks
    ? karakter.join("")
    : `${karakter.slice(0, maks - 1).join("")}…`;
}

export interface IsiPengajuanBaru {
  nomor: string;
  keperluan: string;
  total: number;
  jumlahBaris: number;
  pengaju: string;
  caraBayar: string;
}

/** Cermin `pesan_pengajuan_baru`. */
export function pesanPengajuanBaru(isi: IsiPengajuanBaru): string {
  const baris = [
    `📦 Pengajuan pembelian baru: ${isi.nomor}`,
    `Keperluan: ${potong(isi.keperluan, 200)}`,
    `Total: ${formatRupiah(isi.total)} (${isi.jumlahBaris} barang)`,
  ];
  if (isi.caraBayar === "Cicilan") baris.push("Cara bayar: Cicilan");
  baris.push(`Diajukan oleh: ${isi.pengaju}`, "Menunggu ACC di aplikasi.");
  return baris.join("\n");
}

export interface IsiPengajuanPutus {
  nomor: string;
  keperluan: string;
  total: number;
  disetujui: boolean;
  pemutus: string;
  catatan: string;
}

/** Cermin `pesan_pengajuan_putus`. */
export function pesanPengajuanPutus(isi: IsiPengajuanPutus): string {
  const baris = [
    isi.disetujui
      ? `✅ Pengajuan ${isi.nomor} disetujui`
      : `❌ Pengajuan ${isi.nomor} ditolak`,
    `Keperluan: ${potong(isi.keperluan, 200)}`,
    `Total: ${formatRupiah(isi.total)}`,
    `${isi.disetujui ? "Disetujui" : "Ditolak"} oleh: ${isi.pemutus}`,
  ];
  if (isi.catatan.trim() !== "") {
    baris.push(
      `${isi.disetujui ? "Catatan" : "Alasan"}: ${potong(isi.catatan, 300)}`,
    );
  }
  return baris.join("\n");
}

export interface BarisStokMenipis {
  kode: string;
  nama: string;
  satuan: string;
  desimal: boolean;
  stok: number;
  minimum: number;
}

/** Cermin `pesan_stok_menipis`. Daftar kosong tidak menghasilkan pesan. */
export function pesanStokMenipis(daftar: BarisStokMenipis[]): string | null {
  if (daftar.length === 0) return null;
  const baris = [`⚠️ ${daftar.length} barang di bawah stok minimum`];
  for (const item of daftar.slice(0, MAKS_BARIS_STOK)) {
    baris.push(
      `• ${potong(item.nama, 60)} (${item.kode}): ${formatJumlah(item.stok, item.desimal)} dari minimum ${formatJumlah(item.minimum, item.desimal)} ${item.satuan}`,
    );
  }
  if (daftar.length > MAKS_BARIS_STOK) {
    baris.push(`dan ${daftar.length - MAKS_BARIS_STOK} barang lainnya.`);
  }
  return baris.join("\n");
}

const NAMA_BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** Cermin `label_bulan`: `2026-11` → `November 2026`; teks lain apa adanya. */
export function labelBulan(periode: string): string {
  const cocok = /^(\d{4})-(\d{2})$/.exec(periode);
  const bulan = cocok ? Number(cocok[2]) : 0;
  return cocok && bulan >= 1 && bulan <= 12
    ? `${NAMA_BULAN[bulan - 1]} ${cocok[1]}`
    : periode;
}

/** Status dan jumlah percobaan setelah gagal. Cermin `status_setelah_gagal`. */
export function statusSetelahGagal(percobaanSebelumnya: number): {
  status: "Menunggu" | "Gagal";
  percobaan: number;
} {
  const percobaan = percobaanSebelumnya + 1;
  return {
    status: percobaan >= TELEGRAM_BATAS_PERCOBAAN ? "Gagal" : "Menunggu",
    percobaan,
  };
}

/** Cermin `pesan_kasbon_baru`. Sengaja tanpa nama karyawan maupun pengaju. */
export function pesanKasbonBaru(
  pokok: number,
  cicilan: number,
  mulaiPotong: string,
): string {
  return [
    "💰 Pengajuan kasbon baru",
    `Pokok: ${formatRupiah(pokok)}`,
    `Cicilan: ${formatRupiah(cicilan)} per bulan, mulai potong gaji ${labelBulan(mulaiPotong)}`,
    "Menunggu keputusan di aplikasi.",
  ].join("\n");
}

/** Cermin `pesan_tutup_buku`. */
export function pesanTutupBuku(
  sampaiTanggal: string,
  oleh: string,
  menunggu: boolean,
): string {
  const baris = [
    `🔒 Buku ditutup sampai ${tanggalTampil(sampaiTanggal)}`,
    `Oleh: ${oleh}`,
  ];
  if (menunggu) {
    baris.push(
      "Bentrok dengan tutup buku lain, menunggu keputusan di aplikasi.",
    );
  }
  return baris.join("\n");
}

/** Cermin `pesan_buka_buku`. */
export function pesanBukaBuku(
  sampaiTanggal: string,
  oleh: string,
  alasan: string,
): string {
  const baris = [
    `🔓 Buku dibuka kembali (tutup sampai ${tanggalTampil(sampaiTanggal)})`,
    `Oleh: ${oleh}`,
  ];
  if (alasan.trim() !== "") baris.push(`Alasan: ${potong(alasan, 300)}`);
  return baris.join("\n");
}

/**
 * Di bawah angka ini total bersih praktis sama dengan gaji perorangan, jadi
 * pesan hanya menyebut jumlah pegawai. Cermin `MIN_PEGAWAI_NOMINAL_GAJI`.
 */
export const MIN_PEGAWAI_NOMINAL_GAJI = 3;

const FRASA_STATUS_GAJI: Record<string, string> = {
  REVIEWED: "menunggu persetujuan",
  APPROVED: "disetujui",
  PAID: "sudah dibayar",
  REJECTED: "ditolak",
};

export interface IsiGajiStatus {
  status: string;
  periodeAwal: string;
  periodeAkhir: string;
  pegawai: number;
  totalBersih: number;
  oleh: string;
  catatan: string;
}

/**
 * Cermin `pesan_gaji_status`. Status di luar daftar tidak menghasilkan pesan.
 * Hanya jumlah pegawai dan total bersih (total disembunyikan bila pegawainya
 * kurang dari `MIN_PEGAWAI_NOMINAL_GAJI`): tanpa nama, slip, potongan, kasbon.
 */
export function pesanGajiStatus(isi: IsiGajiStatus): string | null {
  const frasa = FRASA_STATUS_GAJI[isi.status];
  if (!frasa) return null;
  const baris = [
    `💼 Proses gaji ${tanggalTampil(isi.periodeAwal)}–${tanggalTampil(isi.periodeAkhir)} ${frasa}`,
    isi.pegawai < MIN_PEGAWAI_NOMINAL_GAJI
      ? `${isi.pegawai} pegawai`
      : `${isi.pegawai} pegawai · total bersih ${formatRupiah(isi.totalBersih)}`,
    `Oleh: ${isi.oleh}`,
  ];
  if (isi.status === "REJECTED" && isi.catatan.trim() !== "") {
    baris.push(`Alasan: ${potong(isi.catatan, 300)}`);
  }
  return baris.join("\n");
}

/** Selisih jam cloud dan jam kejadian di atas ini ditandai terlambat (Q-38). */
export const MENIT_TERLAMBAT = 30;

/**
 * Isi bersama pesan perjalanan. `waktu` = jam kejadian WIB
 * `YYYY-MM-DD HH:MM:SS`; `telatMenit` = jam cloud − jam kejadian. Koordinat,
 * foto, upah, dan muatan sengaja tidak pernah ikut (Q-37).
 */
export interface IsiLaporanPerjalanan {
  nomor: string;
  driver: string;
  kendaraan: string;
  tempat: string;
  keterangan: string;
  waktu: string;
  telatMenit: number;
}

function barisDriver(isi: IsiLaporanPerjalanan) {
  return isi.kendaraan === ""
    ? `Driver: ${isi.driver}`
    : `Driver: ${isi.driver} · ${isi.kendaraan}`;
}

function tutupPesan(baris: string[], isi: IsiLaporanPerjalanan) {
  baris.push(`Waktu: ${waktuTampil(isi.waktu)}`);
  if (isi.telatMenit > MENIT_TERLAMBAT) {
    baris.push("Dikirim terlambat (offline).");
  }
  return baris.join("\n");
}

/** Cermin `pesan_trip_kendala`. */
export function pesanTripKendala(
  isi: IsiLaporanPerjalanan & {
    jenisKendala: string;
    terlambatMenit: number | null;
  },
): string {
  const baris = [
    isi.jenisKendala === ""
      ? `🚧 Kendala: ${isi.nomor}`
      : `🚧 Kendala ${isi.jenisKendala}: ${isi.nomor}`,
    barisDriver(isi),
  ];
  if (isi.tempat !== "") baris.push(`Tempat: ${potong(isi.tempat, 100)}`);
  if (isi.terlambatMenit !== null && isi.terlambatMenit > 0) {
    baris.push(`Perkiraan terlambat: ${isi.terlambatMenit} menit`);
  }
  if (isi.keterangan !== "") {
    baris.push(`Keterangan: ${potong(isi.keterangan, 300)}`);
  }
  return tutupPesan(baris, isi);
}

const JUDUL_TUTUP: Record<string, string> = {
  Selesai: "🏁 Surat jalan {nomor} selesai",
  "Tidak Jalan": "⛔ Surat jalan {nomor} tidak jalan",
  Dibatalkan: "🛑 Surat jalan {nomor} dibatalkan",
};

/**
 * Cermin `pesan_trip_tutup`. `oleh` = operator bila dicatat dispatcher, kosong
 * bila dari HP driver. Jenis di luar `TRIP_TUTUP` tidak menghasilkan pesan.
 */
export function pesanTripTutup(
  isi: IsiLaporanPerjalanan & { jenis: string; oleh: string },
): string | null {
  const judul = JUDUL_TUTUP[isi.jenis];
  if (!judul) return null;
  const baris = [judul.replace("{nomor}", isi.nomor), barisDriver(isi)];
  if (isi.tempat !== "") baris.push(`Tempat: ${potong(isi.tempat, 100)}`);
  if (isi.oleh !== "") baris.push(`Oleh: ${isi.oleh}`);
  if (isi.keterangan !== "") {
    baris.push(
      `${isi.oleh !== "" ? "Alasan" : "Catatan"}: ${potong(isi.keterangan, 300)}`,
    );
  }
  return tutupPesan(baris, isi);
}

/**
 * Cermin `pesan_trip_ganti_izin`. `driver` = pelapor (driver yang meminta);
 * `dari`/`ke` = driver atau kendaraan sebelum dan sesudah ganti.
 */
export function pesanTripGantiIzin(
  isi: IsiLaporanPerjalanan & {
    gantiDriver: boolean;
    darurat: boolean;
    dari: string;
    ke: string;
  },
): string {
  const objek = isi.gantiDriver ? "driver" : "kendaraan";
  const baris = [
    isi.darurat
      ? `🔁 Ganti ${objek} darurat: ${isi.nomor}`
      : `🔁 Minta izin ganti ${objek}: ${isi.nomor}`,
    `Dari: ${isi.dari}`,
    `Ke: ${isi.ke}`,
    `Dilaporkan oleh: ${isi.driver}`,
  ];
  if (isi.keterangan !== "") {
    baris.push(`Alasan: ${potong(isi.keterangan, 300)}`);
  }
  baris.push(
    isi.darurat
      ? "Sudah berlaku. Setujui atau tolak di aplikasi."
      : "Berlaku setelah disetujui di aplikasi.",
  );
  return tutupPesan(baris, isi);
}

/** Cermin `pesan_trip_lokasi_palsu`. Ditulis sebagai tanda tinjau, bukan vonis. */
export function pesanTripLokasiPalsu(
  isi: IsiLaporanPerjalanan & { jenisLaporan: string },
): string {
  return tutupPesan(
    [
      "⚠️ Perlu ditinjau: lokasi palsu terdeteksi",
      `Surat jalan: ${isi.nomor}`,
      isi.tempat === ""
        ? `Laporan: ${isi.jenisLaporan}`
        : `Laporan: ${isi.jenisLaporan} · ${potong(isi.tempat, 100)}`,
      barisDriver(isi),
    ],
    isi,
  );
}

/** Isi pengingat per karyawan. `tanggal` = `YYYY-MM-DD`, `sisa` = hari lagi. */
export interface IsiPengingatHr {
  nama: string;
  jabatan: string;
  tanggal: string;
  sisa: number;
}

/** Cermin `sisa_hari`. */
export function sisaHari(sisa: number): string {
  return sisa <= 0 ? "hari ini" : `${sisa} hari lagi`;
}

function barisKaryawan(nama: string, jabatan: string) {
  return jabatan === ""
    ? `Karyawan: ${potong(nama, 100)}`
    : `Karyawan: ${potong(nama, 100)} · ${potong(jabatan, 60)}`;
}

/** Cermin `pesan_hr_kontrak_akhir`. Tanpa nomor kontrak. */
export function pesanHrKontrakAkhir(isi: IsiPengingatHr): string {
  return [
    `📄 Kontrak PKWT berakhir ${sisaHari(isi.sisa)} (${tanggalTampil(isi.tanggal)})`,
    barisKaryawan(isi.nama, isi.jabatan),
  ].join("\n");
}

/** Cermin `pesan_hr_percobaan_akhir`. */
export function pesanHrPercobaanAkhir(isi: IsiPengingatHr): string {
  return [
    `⏳ Masa percobaan berakhir ${sisaHari(isi.sisa)} (${tanggalTampil(isi.tanggal)})`,
    barisKaryawan(isi.nama, isi.jabatan),
  ].join("\n");
}

/** Cermin `pesan_hr_dokumen_kedaluwarsa`. Jenis ya, nomor tidak (Q-105). */
export function pesanHrDokumenKedaluwarsa(
  isi: IsiPengingatHr & { jenisDokumen: string },
): string {
  return [
    `🪪 Dokumen ${potong(isi.jenisDokumen, 60)} kedaluwarsa ${sisaHari(isi.sisa)} (${tanggalTampil(isi.tanggal)})`,
    barisKaryawan(isi.nama, isi.jabatan),
  ].join("\n");
}

/** Cermin `pesan_hr_sp_berakhir`. Tingkat ya, isi SP tidak (Q-105). */
export function pesanHrSpBerakhir(isi: {
  tingkat: string;
  nama: string;
  jabatan: string;
  tanggal: string;
}): string {
  return [
    `📋 Masa berlaku ${isi.tingkat} berakhir ${tanggalTampil(isi.tanggal)}`,
    barisKaryawan(isi.nama, isi.jabatan),
  ].join("\n");
}

/**
 * Cermin `pesan_hr_pengajuan_menunggu`. Hitungan per kelompok, tanpa nama
 * (Q-108); daftar tanpa isi tidak menghasilkan pesan.
 */
export function pesanHrPengajuanMenunggu(
  daftar: { kelompok: string; jumlah: number }[],
  sejak: string,
): string | null {
  const total = daftar.reduce((jumlah, item) => jumlah + item.jumlah, 0);
  if (total <= 0) return null;
  return [
    `📥 ${total} pengajuan menunggu lebih dari ${HR_HARI_MENUNGGU} hari`,
    daftar.map((item) => `${item.kelompok} ${item.jumlah}`).join(", "),
    `Paling lama sejak ${tanggalTampil(sejak)}`,
  ].join("\n");
}

/** Cermin `pesan_hr_urgent_belum_diketahui`. Nol tidak menghasilkan pesan. */
export function pesanHrUrgentBelumDiketahui(
  jumlah: number,
  sejak: string,
): string | null {
  if (jumlah <= 0) return null;
  return [
    `⚡ ${jumlah} pengajuan urgent belum diketahui HRD`,
    `Paling lama sejak ${tanggalTampil(sejak)}`,
  ].join("\n");
}

/** Cermin `pesan_hr_ulang_tahun_kerja`: sampai `MAKS_BARIS_STOK` baris. */
export function pesanHrUlangTahunKerja(
  daftar: { nama: string; jabatan: string; tahun: number }[],
): string | null {
  if (daftar.length === 0) return null;
  const baris = ["🎉 Ulang tahun kerja hari ini"];
  for (const item of daftar.slice(0, MAKS_BARIS_STOK)) {
    baris.push(
      item.jabatan === ""
        ? `• ${potong(item.nama, 100)}, ${item.tahun} tahun`
        : `• ${potong(item.nama, 100)} (${potong(item.jabatan, 60)}), ${item.tahun} tahun`,
    );
  }
  if (daftar.length > MAKS_BARIS_STOK) {
    baris.push(`dan ${daftar.length - MAKS_BARIS_STOK} lainnya.`);
  }
  return baris.join("\n");
}

export interface PermintaanTelegram {
  url: string;
  body: Record<string, unknown>;
}

/** Cermin `permintaan_kirim`. Teks polos, tanpa `parse_mode`: tanpa escape. */
export function permintaanKirim(
  token: string,
  chatId: string,
  teks: string,
): PermintaanTelegram {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    body: { chat_id: chatId, text: teks, disable_web_page_preview: true },
  };
}

/**
 * Cermin `galat_telegram`: `null` bila Telegram menjawab `ok: true`, selain
 * itu penjelasan dari Telegram atau kode HTTP-nya.
 */
export function galatTelegram(status: number, badan: string): string | null {
  let data: unknown = null;
  try {
    data = JSON.parse(badan);
  } catch {
    data = null;
  }
  const objek =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (status >= 200 && status < 300 && objek.ok === true) return null;
  const penjelasan =
    typeof objek.description === "string" && objek.description !== ""
      ? objek.description
      : `HTTP ${status}`;
  return `Telegram: ${penjelasan}`;
}

export interface GrupTelegram {
  id: string;
  judul: string;
}

/**
 * Cermin `grup_dari_updates`: grup yang terlihat bot dari `getUpdates`, urut
 * kemunculan pertama, judul terakhir. Grup tempat bot sudah dikeluarkan dibuang.
 */
export function grupDariUpdates(respons: unknown): GrupTelegram[] {
  const daftar = new Map<string, string>();
  const hasil =
    respons && typeof respons === "object"
      ? (respons as Record<string, unknown>).result
      : null;
  if (!Array.isArray(hasil)) return [];
  for (const update of hasil) {
    if (!update || typeof update !== "object") continue;
    for (const jenis of [
      "message",
      "edited_message",
      "my_chat_member",
      "chat_member",
    ]) {
      const isi = (update as Record<string, unknown>)[jenis];
      if (!isi || typeof isi !== "object") continue;
      const chat = (isi as Record<string, unknown>).chat as
        | Record<string, unknown>
        | undefined;
      if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
        continue;
      }
      if (typeof chat.id !== "number" || !Number.isInteger(chat.id)) continue;
      const id = String(chat.id);
      const anggotaBaru = (isi as Record<string, unknown>).new_chat_member as
        | Record<string, unknown>
        | undefined;
      if (
        jenis === "my_chat_member" &&
        (anggotaBaru?.status === "left" || anggotaBaru?.status === "kicked")
      ) {
        daftar.delete(id);
        continue;
      }
      daftar.set(id, typeof chat.title === "string" ? chat.title : id);
    }
  }
  return [...daftar].map(([id, judul]) => ({ id, judul }));
}

export interface RiwayatTelegram {
  id: string;
  kejadian: string;
  status: string;
  galat: string;
  dibuat: string;
  terkirim: string;
}

/** Bentuk yang dikembalikan `get_telegram_config` / `getTelegramConfig`. */
export interface TelegramConfig {
  aktif: boolean;
  tokenTersimpan: boolean;
  tokenAkhir: string;
  grup: Record<BidangTelegram, string>;
  kirim: Record<KejadianTelegram, boolean>;
  riwayat: RiwayatTelegram[];
}

/** `botToken` kosong = pakai token yang tersimpan. */
export interface TelegramConfigDraft {
  aktif: boolean;
  botToken: string;
  grup: Record<BidangTelegram, string>;
  kirim: Record<KejadianTelegram, boolean>;
}

export interface TelegramDrainResult {
  sukses: boolean;
  diproses: number;
  terkirim: number;
  gagal: number;
  dibatalkan: number;
  pesan: string;
}
