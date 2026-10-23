import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const client: Client = createClient({ url: "file::memory:" });

// Layanan laporan memakai klien tingkat modul; mock ini mengarahkannya ke
// database sementara dengan skema cloud asli.
mock.module("@/lib/db", () => ({
  db: client,
  ensureDbInitialized: async () => {},
}));

const {
  getLaporanKehadiran,
  getRekapBulanan,
  getTopKaryawanTerajin,
  rekapPerTanggal,
} = await import("@/lib/services/report");

/**
 * IDENTIK dengan `FIXTURE_LAPORAN_KEHADIRAN` di `administration.rs`, dan angka
 * yang diharapkan juga sama: Web (TS) dan Desktop/Mobile (Rust) wajib
 * mengirim data laporan yang sama.
 *
 * Senin 2026-10-05: A dua sesi tepat waktu (dihitung sekali), B terlambat,
 * C Sakit, D Dispensasi, E Alfa. Selasa 2026-10-06: A sesi kedua terlambat,
 * F Dispen, G Alfa sistem + scan Hadir (Hadir menang), H Koreksi Admin
 * "Hadir" tanpa jam scan. Minggu 2026-10-04 di luar rentang. A aktif, B
 * nonaktif tetapi punya catatan, Z nonaktif tanpa catatan. Libur 8 Oktober
 * nonaktif; whitelist 1 November di luar rentang.
 */
const FIXTURE_LAPORAN_KEHADIRAN = `
INSERT INTO absensi_harian (
  tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
  status_kehadiran, status_absen, sumber, update_terakhir,
  menit_terlambat, id_shift, bulan, tahun, id_sesi
) VALUES
  ('2026-10-04', 'A', 'A', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-04 07:00:00', 0, 1, 'Oktober', 2026, 'a-04'),
  ('2026-10-05', 'A', 'A', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-05 07:00:00', 0, 1, 'Oktober', 2026, 'a-05-1'),
  ('2026-10-05', 'A', 'A', 'X', '', '15:00', 'Hadir', 'Pulang', 'Scanner', '2026-10-05 15:00:00', 0, 1, 'Oktober', 2026, 'a-05-2'),
  ('2026-10-05', 'B', 'B', 'X', '07:20', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-05 07:20:00', 20, 1, 'Oktober', 2026, 'b-05'),
  ('2026-10-05', 'C', 'C', 'X', '', '', 'Sakit', 'Izin', 'Koreksi Admin', '2026-10-05 08:00:00', 0, 1, 'Oktober', 2026, 'c-05'),
  ('2026-10-05', 'D', 'D', 'X', '', '', 'Dispensasi', 'Izin', 'Koreksi Admin', '2026-10-05 08:00:00', 0, 1, 'Oktober', 2026, 'd-05'),
  ('2026-10-05', 'E', 'E', 'X', '', '', 'Alfa', 'Alfa', 'Generate Sistem', '2026-10-05 23:00:00', 0, 1, 'Oktober', 2026, 'e-05'),
  ('2026-10-06', 'A', 'A', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-06 07:00:00', 0, 1, 'Oktober', 2026, 'a-06-1'),
  ('2026-10-06', 'A', 'A', 'X', '13:10', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-06 13:10:00', 10, 1, 'Oktober', 2026, 'a-06-2'),
  ('2026-10-06', 'F', 'F', 'X', '', '', 'Dispen', 'Izin', 'Koreksi Admin', '2026-10-06 08:00:00', 0, 1, 'Oktober', 2026, 'f-06'),
  ('2026-10-06', 'G', 'G', 'X', '', '', 'Alfa', 'Alfa', 'Generate Sistem', '2026-10-06 23:00:00', 0, 1, 'Oktober', 2026, 'g-06-1'),
  ('2026-10-06', 'G', 'G', 'X', '06:55', '', 'Hadir', 'Masuk', 'Scanner', '2026-10-06 06:55:00', 0, 1, 'Oktober', 2026, 'g-06-2'),
  ('2026-10-06', 'H', 'H', 'X', '', '', 'Hadir', 'Masuk', 'Koreksi Admin', '2026-10-06 09:00:00', 0, 1, 'Oktober', 2026, 'h-06');
INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
  ('A', 'K-A', 'Ani', 'X', 1, 'Aktif'),
  ('B', 'K-B', 'Budi', 'X', 1, 'Nonaktif'),
  ('Z', 'K-Z', 'Zaki', 'X', 1, 'Nonaktif');
INSERT INTO tbl_hari_libur (tanggal, nama_libur, status_aktif) VALUES
  ('2026-10-07', 'Libur Uji', 1),
  ('2026-10-08', 'Libur Nonaktif', 0);
INSERT INTO hari_libur_whitelist (id, scope_type, scope_value, tanggal_libur, keterangan, status_aktif) VALUES
  ('w-semua', 'DIVISI', 'X', NULL, NULL, 1),
  ('w-luar', 'SHIFT', '1', '2026-11-01', NULL, 1);
`;

/**
 * IDENTIK dengan `FIXTURE_TOP_KARYAWAN` di `administration.rs`. Hari ini (WIB):
 * T aktif dua sesi (sekali, 5 menit terlambat), U nonaktif hadir, C tanpa
 * data karyawan. Bulan dan tahun sengaja asing supaya rekap bulanan tidak
 * ikut membacanya.
 */
const FIXTURE_TOP_KARYAWAN = `
INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
  ('T', 'K-T', 'Tono', 'X', 1, 'Aktif'),
  ('U', 'K-U', 'Umi', 'X', 1, 'Nonaktif');
INSERT INTO absensi_harian (
  tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
  status_kehadiran, status_absen, sumber, update_terakhir,
  menit_terlambat, id_shift, bulan, tahun, id_sesi
) VALUES
  (date('now', '+7 hours'), 'T', 'Tono', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2000-01-01 07:00:00', 0, 1, 'X', 2000, 'top-t-1'),
  (date('now', '+7 hours'), 'T', 'Tono', 'X', '13:05', '', 'Hadir', 'Masuk', 'Scanner', '2000-01-01 13:05:00', 5, 1, 'X', 2000, 'top-t-2'),
  (date('now', '+7 hours'), 'U', 'Umi', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2000-01-01 07:00:00', 0, 1, 'X', 2000, 'top-u'),
  (date('now', '+7 hours'), 'C', 'C', 'X', '07:00', '', 'Hadir', 'Masuk', 'Scanner', '2000-01-01 07:00:00', 0, 1, 'X', 2000, 'top-c');
`;

beforeAll(async () => {
  await initDatabaseSchema(client);
  await client.executeMultiple(FIXTURE_LAPORAN_KEHADIRAN);
});

afterAll(() => client.close());

describe("data laporan kehadiran (jalur Web)", () => {
  const hari = (id: string, tanggal: string, n: number[]) => ({
    id,
    tanggal,
    hadir: n[0],
    telat: n[1],
    menit: n[1],
    sakit: n[2],
    izin: n[3],
    dispensasi: n[4],
    alfa: n[5],
  });

  test("sesi digabung per hari dan karyawan disaring, sama dengan Rust", async () => {
    const hasil = await getLaporanKehadiran("2026-10-05", "2026-10-08");
    expect(hasil.karyawan.map((k) => [k.id, k.aktif])).toEqual([
      ["A", 1],
      ["B", 0],
    ]);
    expect(hasil.hari).toEqual([
      hari("A", "2026-10-05", [1, 0, 0, 0, 0, 0]),
      hari("A", "2026-10-06", [1, 10, 0, 0, 0, 0]),
      hari("B", "2026-10-05", [1, 20, 0, 0, 0, 0]),
      hari("C", "2026-10-05", [0, 0, 1, 0, 0, 0]),
      hari("D", "2026-10-05", [0, 0, 0, 0, 1, 0]),
      hari("E", "2026-10-05", [0, 0, 0, 0, 0, 1]),
      hari("F", "2026-10-06", [0, 0, 0, 0, 1, 0]),
      hari("G", "2026-10-06", [1, 0, 0, 0, 0, 1]),
      hari("H", "2026-10-06", [1, 0, 0, 0, 0, 0]),
    ]);
    expect(hasil.libur).toEqual([{ tanggal: "2026-10-07", nama: "Libur Uji" }]);
    expect(hasil.whitelist.map((w) => w.id)).toEqual(["w-semua"]);
  });

  test("rentang yang tidak sah ditolak sebelum menyentuh database", async () => {
    await expect(
      getLaporanKehadiran("2026-10-01", "2027-01-01"),
    ).rejects.toThrow("Rentang laporan paling panjang 92 hari.");
  });
});

describe("rekap per tanggal: kartu KPI dan tren mingguan", () => {
  test("satu orang sekali per hari, sama dengan Rust", async () => {
    expect(await rekapPerTanggal("2026-10-05", "2026-10-11")).toEqual([
      {
        tanggal: "2026-10-05",
        tepat_waktu: 1,
        terlambat: 1,
        sakit_izin: 2,
        alfa: 1,
      },
      {
        tanggal: "2026-10-06",
        tepat_waktu: 2,
        terlambat: 1,
        sakit_izin: 1,
        alfa: 0,
      },
    ]);
  });
});

describe("rekap bulanan per karyawan", () => {
  // Urutan angka: hadir, menit telat, frekuensi telat, sakit, izin, dispen, alfa.
  const baris = (id: string, n: number[]) => ({
    idKaryawan: id,
    nama: id,
    divisi: "X",
    totalHadir: n[0],
    totalTerlambat: n[1],
    frekuensiTelat: n[2],
    totalSakit: n[3],
    totalIzin: n[4],
    totalDispen: n[5],
    totalAlfa: n[6],
    totalJamKerja: 0,
    totalLembur: 0,
  });

  test("dihitung per hari, bukan per sesi, sama dengan Rust", async () => {
    expect(await getRekapBulanan({ bulan: "Oktober", tahun: 2026 })).toEqual([
      baris("A", [3, 10, 1, 0, 0, 0, 0]),
      baris("B", [1, 20, 1, 0, 0, 0, 0]),
      baris("C", [0, 0, 0, 1, 0, 0, 0]),
      baris("D", [0, 0, 0, 0, 0, 1, 0]),
      baris("E", [0, 0, 0, 0, 0, 0, 1]),
      baris("F", [0, 0, 0, 0, 0, 1, 0]),
      baris("G", [1, 0, 0, 0, 0, 0, 0]),
      baris("H", [1, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(
      await getRekapBulanan({ bulan: "Oktober", tahun: 2026, divisi: "Y" }),
    ).toEqual([]);
  });
});

// Terakhir di berkas ini: menambah karyawan T dan U yang akan ikut terbaca
// oleh tes laporan bila dijalankan lebih dulu.
describe("leaderboard terajin", () => {
  test("hari hadir bulan berjalan, hanya karyawan aktif, sama dengan Rust", async () => {
    await client.executeMultiple(FIXTURE_TOP_KARYAWAN);
    const hasil = (await getTopKaryawanTerajin(50)).filter((row) =>
      ["T", "U"].includes(String(row.id_karyawan)),
    );
    expect(hasil.map((row) => ({ ...row }))).toEqual([
      {
        id_karyawan: "T",
        nama: "Tono",
        divisi: "X",
        total_kehadiran: 1,
        total_telat: 5,
      },
    ]);
  });
});
