import "server-only";

import { formatTanggalOperasional } from "@/lib/attendance/time-policy";
import { db, ensureDbInitialized } from "@/lib/db";

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

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  await ensureDbInitialized();

  const todayStr = formatTanggalOperasional(new Date());

  // 1. Total Karyawan Aktif
  const empRes = await db.execute(
    "SELECT COUNT(*) as count FROM master_data WHERE status_aktif = 'Aktif';",
  );
  const totalKaryawan = Number(empRes.rows[0]?.count || 0);

  // 2. Statistics Absensi Hari Ini
  const statsRes = await db.execute({
    sql: `
      SELECT 
        SUM(CASE WHEN status_kehadiran = 'Hadir' THEN 1 ELSE 0 END) as hadir,
        SUM(CASE WHEN menit_terlambat > 0 THEN 1 ELSE 0 END) as terlambat,
        SUM(CASE WHEN status_kehadiran IN ('Sakit', 'Izin', 'Dispen') THEN 1 ELSE 0 END) as sakit_izin,
        SUM(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END) as alfa
      FROM absensi_harian
      WHERE tanggal = ?;
    `,
    args: [todayStr],
  });

  const row = statsRes.rows[0] as Record<string, unknown>;
  const hadirHariIni = Number(row?.hadir || 0);
  const terlambatHariIni = Number(row?.terlambat || 0);
  const sakitIzinHariIni = Number(row?.sakit_izin || 0);
  const alfaHariIni = Number(row?.alfa || 0);

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

  let query = `
    SELECT 
      id_karyawan, nama, kelas_divisi as divisi,
      SUM(CASE WHEN status_kehadiran = 'Hadir' THEN 1 ELSE 0 END) as totalHadir,
      SUM(menit_terlambat) as totalTerlambat,
      SUM(CASE WHEN menit_terlambat > 0 THEN 1 ELSE 0 END) as frekuensiTelat,
      SUM(CASE WHEN status_kehadiran = 'Sakit' THEN 1 ELSE 0 END) as totalSakit,
      SUM(CASE WHEN status_kehadiran = 'Izin' THEN 1 ELSE 0 END) as totalIzin,
      SUM(CASE WHEN status_kehadiran = 'Dispen' THEN 1 ELSE 0 END) as totalDispen,
      SUM(CASE WHEN status_kehadiran = 'Alfa' THEN 1 ELSE 0 END) as totalAlfa,
      ROUND(SUM(jam_kerja) / 60.0, 1) as totalJamKerja,
      ROUND(SUM(lembur) / 60.0, 1) as totalLembur
    FROM absensi_harian
    WHERE bulan = ? AND tahun = ?
  `;
  const params: (string | number | boolean | null)[] = [bulanStr, tahunNum];

  if (filter?.divisi) {
    query += " AND kelas_divisi = ?";
    params.push(filter.divisi);
  }

  query += " GROUP BY id_karyawan ORDER BY nama ASC;";

  const res = await db.execute({ sql: query, args: params });

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

export async function getTopKaryawanTerajin(limit = 5) {
  await ensureDbInitialized();

  const res = await db.execute({
    sql: `
      SELECT 
        id_karyawan, nama, kelas_divisi as divisi,
        COUNT(*) as total_kehadiran,
        SUM(menit_terlambat) as total_telat
      FROM absensi_harian
      WHERE status_kehadiran = 'Hadir'
      GROUP BY id_karyawan
      ORDER BY total_kehadiran DESC, total_telat ASC
      LIMIT ?;
    `,
    args: [limit],
  });

  return res.rows as unknown as Record<string, unknown>[];
}
