import "server-only";

import { formatTanggalOperasional } from "@/lib/attendance/time-policy";
import { db, ensureDbInitialized } from "@/lib/db";
import {
  type DataLaporanKehadiran,
  validateRentangLaporan,
} from "@/lib/validations/laporan-kehadiran";

export interface DashboardMetrics {
  totalKaryawan: number;
  hadirHariIni: number;
  terlambatHariIni: number;
  sakitIzinHariIni: number;
  alfaHariIni: number;
  persentaseKehadiran: number;
}

export interface RekapBulananItem {
  idKaryawan: string;
  nama: string;
  divisi: string;
  totalHadir: number;
  totalTerlambat: number; // Menit
  frekuensiTelat: number;
  totalSakit: number;
  totalIzin: number;
  totalDispen: number;
  totalAlfa: number;
  totalJamKerja: number; // Jam
  totalLembur: number; // Jam
}

/** Hitungan kehadiran satu tanggal; kategorinya saling lepas per orang. */
export interface RekapTanggal {
  tanggal: string;
  tepat_waktu: number;
  terlambat: number;
  sakit_izin: number;
  alfa: number;
}

export interface TrenMingguan {
  /** Senin pekan berjalan (WIB), dihitung SQLite, bukan jam perangkat. */
  mulai: string;
  hari_ini: string;
  /** Hanya tanggal yang punya data; tanggal lain berarti nol. */
  hari: RekapTanggal[];
}

/**
 * Satu karyawan dihitung SEKALI per tanggal walau punya beberapa sesi
 * (`izinkan_multi_sesi`); menghitung baris mentah menggandakannya. Hadir =
 * scan masuk yang bukan Alfa ATAU status Hadir/Terlambat. Terlambat bila SALAH
 * SATU sesi terlambat. Hadir menang atas Sakit/Izin/Dispen, yang menang atas
 * Alfa. Cermin persis `REKAP_PER_TANGGAL_SQL` di `administration.rs`; keduanya
 * diuji dengan fixture yang sama.
 */
export const REKAP_PER_TANGGAL_SQL = `
  SELECT tanggal,
    SUM(CASE WHEN hadir = 1 AND telat = 0 THEN 1 ELSE 0 END) AS tepat_waktu,
    SUM(CASE WHEN hadir = 1 AND telat > 0 THEN 1 ELSE 0 END) AS terlambat,
    SUM(CASE WHEN hadir = 0 AND sakit_izin = 1 THEN 1 ELSE 0 END) AS sakit_izin,
    SUM(CASE WHEN hadir = 0 AND sakit_izin = 0 AND alfa = 1 THEN 1 ELSE 0 END) AS alfa
  FROM (
    SELECT id_karyawan, tanggal,
      MAX(CASE
        WHEN (COALESCE(TRIM(jam_masuk), '') <> ''
              AND COALESCE(status_kehadiran, '') <> 'Alfa')
          OR status_kehadiran IN ('Hadir', 'Terlambat')
        THEN 1 ELSE 0 END) AS hadir,
      MAX(COALESCE(menit_terlambat, 0)) AS telat,
      MAX(CASE WHEN status_kehadiran IN ('Sakit', 'Izin', 'Dispen', 'Dispensasi')
        THEN 1 ELSE 0 END) AS sakit_izin,
      MAX(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END) AS alfa
    FROM absensi_harian
    WHERE tanggal BETWEEN ? AND ?
    GROUP BY id_karyawan, tanggal
  )
  GROUP BY tanggal
  ORDER BY tanggal;
`;

export async function rekapPerTanggal(
  mulai: string,
  selesai: string,
): Promise<RekapTanggal[]> {
  const result = await db.execute({
    sql: REKAP_PER_TANGGAL_SQL,
    args: [mulai, selesai],
  });
  return result.rows.map((row) => ({
    tanggal: String(row.tanggal),
    tepat_waktu: Number(row.tepat_waktu || 0),
    terlambat: Number(row.terlambat || 0),
    sakit_izin: Number(row.sakit_izin || 0),
    alfa: Number(row.alfa || 0),
  }));
}

export async function getTrenMingguan(): Promise<TrenMingguan> {
  await ensureDbInitialized();
  // `weekday 0` maju ke Minggu terdekat (hari ini bila sudah Minggu), lalu
  // mundur 6 hari ke Senin pekan yang sama.
  const pekan = await db.execute(`
    SELECT date('now', '+7 hours', 'weekday 0', '-6 days') AS mulai,
      date('now', '+7 hours', 'weekday 0') AS selesai,
      date('now', '+7 hours') AS hari_ini;
  `);
  const { mulai, selesai, hari_ini } = pekan.rows[0] as Record<string, unknown>;
  return {
    mulai: String(mulai),
    hari_ini: String(hari_ini),
    hari: await rekapPerTanggal(String(mulai), String(selesai)),
  };
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  await ensureDbInitialized();

  const todayStr = formatTanggalOperasional(new Date());

  // 1. Total Karyawan Aktif
  const empRes = await db.execute(
    "SELECT COUNT(*) as count FROM master_data WHERE status_aktif = 'Aktif';",
  );
  const totalKaryawan = Number(empRes.rows[0]?.count || 0);

  // 2. Statistik hari ini: rumus yang sama dengan tren mingguan, sehingga
  //    kartu KPI dan batang hari ini tidak pernah berselisih.
  const [hariIni] = await rekapPerTanggal(todayStr, todayStr);
  const terlambatHariIni = hariIni?.terlambat ?? 0;
  const hadirHariIni = (hariIni?.tepat_waktu ?? 0) + terlambatHariIni;
  const sakitIzinHariIni = hariIni?.sakit_izin ?? 0;
  const alfaHariIni = hariIni?.alfa ?? 0;

  const persentaseKehadiran =
    totalKaryawan > 0 ? Math.round((hadirHariIni / totalKaryawan) * 100) : 0;

  return {
    totalKaryawan,
    hadirHariIni,
    terlambatHariIni,
    sakitIzinHariIni,
    alfaHariIni,
    persentaseKehadiran,
  };
}

export async function getRekapHarian(filter?: {
  tanggal?: string;
  tanggal_mulai?: string;
  tanggal_selesai?: string;
  divisi?: string;
}) {
  await ensureDbInitialized();

  let query = `
    SELECT a.*, m.kode_karyawan, s.nama_shift, s.kode_shift
    FROM absensi_harian a
    LEFT JOIN master_data m ON a.id_karyawan = m.id_unik
    LEFT JOIN tbl_shift s ON a.id_shift = s.id_shift
  `;
  const params: (string | number | boolean | null)[] = [];

  if (filter?.tanggal_mulai && filter?.tanggal_selesai) {
    query += " WHERE a.tanggal >= ? AND a.tanggal <= ?";
    params.push(filter.tanggal_mulai, filter.tanggal_selesai);
  } else {
    const tanggalStr = filter?.tanggal || formatTanggalOperasional(new Date());
    query += " WHERE a.tanggal = ?";
    params.push(tanggalStr);
  }

  if (filter?.divisi) {
    query += " AND a.kelas_divisi = ?";
    params.push(filter.divisi);
  }

  query += " ORDER BY a.update_terakhir DESC, a.tanggal DESC, a.nama ASC;";

  const res = await db.execute({ sql: query, args: params });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function getRiwayatScan(filter?: {
  tanggal?: string;
  tanggal_mulai?: string;
  tanggal_selesai?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  await ensureDbInitialized();
  const search = filter?.search?.trim() || "";
  const limit = Math.min(500, Math.max(1, filter?.limit || 200));
  const offset = Math.max(0, filter?.offset || 0);

  let whereClause = "";
  const params: (string | number | boolean | null)[] = [];

  if (filter?.tanggal_mulai && filter?.tanggal_selesai) {
    whereClause = "tanggal_kerja >= ? AND tanggal_kerja <= ?";
    params.push(filter.tanggal_mulai, filter.tanggal_selesai);
  } else {
    const tanggal = filter?.tanggal || formatTanggalOperasional(new Date());
    whereClause = "tanggal_kerja = ?";
    params.push(tanggal);
  }

  params.push(
    search,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
    limit,
    offset,
  );

  const result = await db.execute({
    sql: `
      SELECT id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan,
        nama, divisi, jenis_scan, status_proses, sumber_data,
        catatan_sistem, keterangan, menit_terlambat, menit_datang_awal,
        id_referensi, kode_operator
      FROM log_scan
      WHERE ${whereClause}
        AND (? = '' OR nama LIKE ? OR id_karyawan LIKE ? OR divisi LIKE ? OR id_referensi LIKE ? OR kode_operator LIKE ?)
      ORDER BY timestamp_scan DESC, id_log DESC
      LIMIT ? OFFSET ?;
    `,
    args: params,
  });
  return result.rows as unknown as Record<string, unknown>[];
}

/**
 * Rekap satu bulan per karyawan, dihitung per HARI (bukan per baris sesi):
 * kategori satu hari mengikuti `REKAP_PER_TANGGAL_SQL` dan saling lepas
 * (Hadir > Sakit > Izin > Dispen > Alfa). Menit terlambat, jam kerja, dan
 * lembur dijumlah dari semua sesi. ?1 = nama bulan, ?2 = tahun, ?3 = divisi
 * ('' = semua). Cermin persis `REKAP_BULANAN_SQL` di `administration.rs`.
 */
export const REKAP_BULANAN_SQL = `
  SELECT id_karyawan, MAX(nama) AS nama, MAX(divisi) AS divisi,
    SUM(hadir) AS totalHadir,
    SUM(menit) AS totalTerlambat,
    SUM(CASE WHEN hadir = 1 AND telat > 0 THEN 1 ELSE 0 END) AS frekuensiTelat,
    SUM(CASE WHEN hadir = 0 AND sakit = 1 THEN 1 ELSE 0 END) AS totalSakit,
    SUM(CASE WHEN hadir = 0 AND sakit = 0 AND izin = 1 THEN 1 ELSE 0 END) AS totalIzin,
    SUM(CASE WHEN hadir = 0 AND sakit = 0 AND izin = 0 AND dispen = 1
      THEN 1 ELSE 0 END) AS totalDispen,
    SUM(CASE WHEN hadir = 0 AND sakit = 0 AND izin = 0 AND dispen = 0 AND alfa = 1
      THEN 1 ELSE 0 END) AS totalAlfa,
    ROUND(SUM(jam_kerja) / 60.0, 1) AS totalJamKerja,
    ROUND(SUM(lembur) / 60.0, 1) AS totalLembur
  FROM (
    SELECT id_karyawan, tanggal, MAX(nama) AS nama, MAX(kelas_divisi) AS divisi,
      MAX(CASE
        WHEN (COALESCE(TRIM(jam_masuk), '') <> ''
              AND COALESCE(status_kehadiran, '') <> 'Alfa')
          OR status_kehadiran IN ('Hadir', 'Terlambat')
        THEN 1 ELSE 0 END) AS hadir,
      MAX(COALESCE(menit_terlambat, 0)) AS telat,
      SUM(COALESCE(menit_terlambat, 0)) AS menit,
      MAX(CASE WHEN status_kehadiran = 'Sakit' THEN 1 ELSE 0 END) AS sakit,
      MAX(CASE WHEN status_kehadiran = 'Izin' THEN 1 ELSE 0 END) AS izin,
      MAX(CASE WHEN status_kehadiran IN ('Dispen', 'Dispensasi')
        THEN 1 ELSE 0 END) AS dispen,
      MAX(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END) AS alfa,
      SUM(COALESCE(jam_kerja, 0)) AS jam_kerja,
      SUM(COALESCE(lembur, 0)) AS lembur
    FROM absensi_harian
    WHERE bulan = ?1 AND tahun = ?2 AND (?3 = '' OR kelas_divisi = ?3)
    GROUP BY id_karyawan, tanggal
  )
  GROUP BY id_karyawan
  ORDER BY nama, id_karyawan;
`;

export async function getRekapBulanan(filter?: {
  bulan?: string; // Nama Bulan (e.g. "Agustus")
  tahun?: number;
  divisi?: string;
}): Promise<RekapBulananItem[]> {
  await ensureDbInitialized();

  const monthNames = [
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
  const operationalDate = formatTanggalOperasional(new Date());
  const operationalYear = Number(operationalDate.slice(0, 4));
  const operationalMonth = Number(operationalDate.slice(5, 7));
  const bulanStr =
    filter?.bulan || monthNames[operationalMonth - 1] || "Agustus";
  const tahunNum = filter?.tahun || operationalYear;

  const res = await db.execute({
    sql: REKAP_BULANAN_SQL,
    args: [bulanStr, tahunNum, filter?.divisi ?? ""],
  });

  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      idKaryawan: String(row.id_karyawan || ""),
      nama: String(row.nama || ""),
      divisi: String(row.divisi || ""),
      totalHadir: Number(row.totalHadir || 0),
      totalTerlambat: Number(row.totalTerlambat || 0),
      frekuensiTelat: Number(row.frekuensiTelat || 0),
      totalSakit: Number(row.totalSakit || 0),
      totalIzin: Number(row.totalIzin || 0),
      totalDispen: Number(row.totalDispen || 0),
      totalAlfa: Number(row.totalAlfa || 0),
      totalJamKerja: Number(row.totalJamKerja || 0),
      totalLembur: Number(row.totalLembur || 0),
    };
  });
}

/**
 * Data mentah laporan kehadiran; matriksnya disusun `susunLaporanKehadiran`.
 * Setiap kueri berbentuk satu kolom `json_object` dengan parameter ?1 = mulai
 * dan ?2 = selesai. Cermin persis `LAPORAN_KEHADIRAN_SQL` di
 * `administration.rs`, diuji dengan fixture yang sama.
 *
 * - karyawan: aktif, ditambah yang sudah nonaktif tetapi punya catatan di
 *   rentang itu.
 * - hari: satu baris per karyawan per tanggal, sehingga beberapa sesi absen
 *   di hari yang sama dihitung sekali. Hadir = scan masuk yang bukan Alfa ATAU
 *   status Hadir/Terlambat; terlambat bila salah satu sesi terlambat, dan
 *   menit terlambatnya dijumlah dari semua sesi.
 * - whitelist: yang berlaku untuk semua libur, atau tanggalnya di rentang.
 */
export const LAPORAN_KEHADIRAN_SQL = {
  karyawan: `
    SELECT json_object(
      'id', m.id_unik, 'kode', COALESCE(m.kode_karyawan, ''), 'nama', m.nama,
      'divisi', COALESCE(m.divisi, ''),
      'aktif', CASE WHEN m.status_aktif = 'Aktif' THEN 1 ELSE 0 END,
      'hari_kerja', sh.hari_kerja, 'kode_shift', sh.kode_shift)
    FROM master_data m LEFT JOIN tbl_shift sh ON sh.id_shift = m.id_shift
    WHERE m.status_aktif = 'Aktif'
      OR EXISTS (SELECT 1 FROM absensi_harian a WHERE a.id_karyawan = m.id_unik
        AND a.tanggal BETWEEN ?1 AND ?2)
    ORDER BY m.nama;
  `,
  hari: `
    SELECT json_object(
      'id', id_karyawan, 'tanggal', tanggal,
      'hadir', MAX(CASE
        WHEN (COALESCE(TRIM(jam_masuk), '') <> ''
              AND COALESCE(status_kehadiran, '') <> 'Alfa')
          OR status_kehadiran IN ('Hadir', 'Terlambat')
        THEN 1 ELSE 0 END),
      'telat', MAX(COALESCE(menit_terlambat, 0)),
      'menit', SUM(COALESCE(menit_terlambat, 0)),
      'sakit', MAX(CASE WHEN status_kehadiran = 'Sakit' THEN 1 ELSE 0 END),
      'izin', MAX(CASE WHEN status_kehadiran = 'Izin' THEN 1 ELSE 0 END),
      'dispensasi', MAX(CASE WHEN status_kehadiran IN ('Dispen', 'Dispensasi')
        THEN 1 ELSE 0 END),
      'alfa', MAX(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END))
    FROM absensi_harian
    WHERE tanggal BETWEEN ?1 AND ?2
    GROUP BY id_karyawan, tanggal
    ORDER BY id_karyawan, tanggal;
  `,
  libur: `
    SELECT json_object('tanggal', tanggal, 'nama', nama_libur)
    FROM tbl_hari_libur
    WHERE status_aktif = 1 AND tanggal BETWEEN ?1 AND ?2
    ORDER BY tanggal;
  `,
  whitelist: `
    SELECT json_object('id', id, 'scope_type', scope_type,
      'scope_value', scope_value, 'tanggal_libur', tanggal_libur,
      'keterangan', keterangan, 'status_aktif', status_aktif)
    FROM hari_libur_whitelist
    WHERE status_aktif = 1 AND (COALESCE(TRIM(tanggal_libur), '') = ''
      OR tanggal_libur BETWEEN ?1 AND ?2)
    ORDER BY id;
  `,
} as const;

export class RentangLaporanError extends Error {}

export async function getLaporanKehadiran(
  mulai: string,
  selesai: string,
): Promise<DataLaporanKehadiran> {
  const rentang = validateRentangLaporan(mulai, selesai);
  if (!rentang.ok) throw new RentangLaporanError(rentang.error);
  await ensureDbInitialized();

  const daftar = async <T>(sql: string): Promise<T[]> => {
    const result = await db.execute({ sql, args: [mulai, selesai] });
    return result.rows.map((row) => JSON.parse(String(row[0])) as T);
  };
  const hariIni = await db.execute(
    "SELECT date('now', '+7 hours') AS hari_ini;",
  );
  return {
    mulai,
    selesai,
    hari_ini: String(hariIni.rows[0]?.hari_ini),
    karyawan: await daftar(LAPORAN_KEHADIRAN_SQL.karyawan),
    hari: await daftar(LAPORAN_KEHADIRAN_SQL.hari),
    libur: await daftar(LAPORAN_KEHADIRAN_SQL.libur),
    whitelist: await daftar(LAPORAN_KEHADIRAN_SQL.whitelist),
  };
}

/**
 * Peringkat terajin bulan berjalan (WIB): jumlah HARI hadir per karyawan
 * aktif, seri dipecah oleh total menit terlambat terkecil. ?1 = batas baris.
 * Cermin persis `TOP_KARYAWAN_SQL` di `administration.rs`.
 */
export const TOP_KARYAWAN_SQL = `
  SELECT h.id_karyawan, MAX(h.nama) AS nama, MAX(h.divisi) AS divisi,
    COUNT(*) AS total_kehadiran, SUM(h.menit) AS total_telat
  FROM (
    SELECT id_karyawan, tanggal, MAX(nama) AS nama, MAX(kelas_divisi) AS divisi,
      MAX(CASE
        WHEN (COALESCE(TRIM(jam_masuk), '') <> ''
              AND COALESCE(status_kehadiran, '') <> 'Alfa')
          OR status_kehadiran IN ('Hadir', 'Terlambat')
        THEN 1 ELSE 0 END) AS hadir,
      SUM(COALESCE(menit_terlambat, 0)) AS menit
    FROM absensi_harian
    WHERE tanggal BETWEEN date('now', '+7 hours', 'start of month')
      AND date('now', '+7 hours')
    GROUP BY id_karyawan, tanggal
  ) h
  JOIN master_data m ON m.id_unik = h.id_karyawan AND m.status_aktif = 'Aktif'
  WHERE h.hadir = 1
  GROUP BY h.id_karyawan
  ORDER BY total_kehadiran DESC, total_telat ASC, nama ASC
  LIMIT ?1;
`;

export async function getTopKaryawanTerajin(limit = 5) {
  await ensureDbInitialized();
  const res = await db.execute({ sql: TOP_KARYAWAN_SQL, args: [limit] });
  return res.rows as unknown as Record<string, unknown>[];
}
