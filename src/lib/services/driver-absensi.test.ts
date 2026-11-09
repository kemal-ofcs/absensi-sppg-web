import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-driver-absensi-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { generateAlfaHarian } = await import("./alfa-audit");
const { auditKualitasAbsensi } = await import("./attendance-audit");
const { computePayrollRecap } = await import("./payroll-recap");

// Vektor yang sama dengan `tests_absensi` di `desktop/driver.rs`: laporan
// perjalanan driver pada tanggal WIB D = bekerja pada D (PRD §7.4).

beforeAll(async () => {
  await ensureDbInitialized();
  const lapor = (id: string, karyawan: string | null, waktu: string) =>
    `INSERT INTO drv_laporan (id_laporan, id_perjalanan, jenis, waktu_perangkat,
       id_karyawan, dilaporkan_oleh)
     VALUES ('${id}', 'trp-1', 'Berangkat', '${waktu}',
       ${karyawan === null ? "NULL" : `'${karyawan}'`}, 'uji');`;
  await db.batch([
    `INSERT INTO tbl_shift (
       id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
       izinkan_multi_sesi
     ) VALUES (1, 1, 'Shift Pagi', '07:00', '15:00', 60, 15, 30, 420, 60, 60, 240, 60, 120, 0);`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
       ('K001', 'E1', 'Driver Pagi', 'Armada', 1, 'Aktif'),
       ('K002', 'E2', 'Tanpa Laporan', 'Armada', 1, 'Aktif'),
       ('K004', 'E4', 'Driver Subuh', 'Armada', 1, 'Aktif'),
       ('K005', 'E5', 'Lapor Kemarin', 'Armada', 1, 'Aktif');`,
    // 08:00 WIB tanggal 18.
    lapor("l1", "K001", "2026-08-18 01:00:00"),
    // Laporan dispatcher (id_karyawan kosong) tidak menghadirkan siapa pun.
    lapor("l2", null, "2026-08-18 02:00:00"),
    // 01:00 WIB tanggal 18: batas bawah tanggal WIB.
    lapor("l3", "K004", "2026-08-17 18:00:00"),
    // 23:59:59 WIB tanggal 17: belum tanggal 18.
    lapor("l4", "K005", "2026-08-17 16:59:59"),
    // Gaji harian K001: scan tanggal 17, laporan tanggal 17 (tidak dobel) dan
    // 18, serta laporan 1 September WIB yang di luar periode Agustus.
    lapor("l5", "K001", "2026-08-17 03:00:00"),
    lapor("l6", "K001", "2026-08-31 17:30:00"),
    `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
       status_kehadiran, status_absen, sumber, update_terakhir, jam_kerja, lembur,
       id_shift, bulan, tahun, id_sesi, mode_tugas)
     VALUES ('2026-08-17', 'K001', 'Driver Pagi', 'Armada', '07:00', '15:00', 'Hadir',
       'Tepat Waktu', 'Scanner', 'x', 420, 0, 1, 'Agustus', 2026, 'S-17', 'NORMAL');`,
    `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, effective_date, created_by,
       salary_type, daily_rate)
     VALUES ('sc-1', 'K001', 0, '2026-01-01', 'uji', 'FLAT_DAILY', 100000);`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("laporan perjalanan sebagai kehadiran driver", () => {
  test("audit absensi tidak menilai pelapor perjalanan", async () => {
    const hasil = await auditKualitasAbsensi(
      "2026-08-18",
      new Date("2026-08-18T18:00:00+07:00"),
      db,
    );
    // Empat personil aktif, dua melapor perjalanan tanggal 18 WIB.
    expect(hasil.ringkasan.wajibAbsen).toBe(2);
  });

  test("Generate Alfa melewati pelapor perjalanan", async () => {
    const hasil = await generateAlfaHarian(
      new Date("2026-08-18T18:00:00+07:00"),
      db,
    );
    expect(hasil.jumlahLaporPerjalanan).toBe(2);
    expect(hasil.jumlahAlfaDibuat).toBe(2);
    const alfa = await db.execute(
      "SELECT id_karyawan FROM absensi_harian WHERE status_kehadiran = 'Alfa' ORDER BY id_karyawan;",
    );
    expect(alfa.rows.map((r) => String(r.id_karyawan))).toEqual([
      "K002",
      "K005",
    ]);
  });

  test("hari hadir gaji harian = tanggal scan ∪ tanggal laporan", async () => {
    const rekap = await computePayrollRecap(db, "2026-08-01", "2026-08-31");
    const driver = rekap.find((baris) => baris.id_karyawan === "K001");
    expect(driver?.days_present).toBe(2);
  });
});
