import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-alfa-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { generateAlfaHarian, getAutoAlfaSetting, saveAutoAlfaSetting } =
  await import("./alfa-audit");
const { tambahHariLibur } = await import("./holiday");

beforeAll(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  await db.batch([
    "DELETE FROM tbl_hari_libur;",
    "DELETE FROM absensi_harian;",
    "DELETE FROM audit_absensi;",
    "DELETE FROM master_data;",
    "DELETE FROM setting_gex_system WHERE key = 'auto_alfa_aktif';",
    `INSERT INTO master_data (
      id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
      token_absensi, qr_code, status_qr
    ) VALUES 
    ('K001', 'EMP001', 'Budi Santoso', 'IT', 1, 'Aktif', 'T001', 'QR001', 'Aktif'),
    ('K002', 'EMP002', 'Siti Aminah', 'Finance', 1, 'Aktif', 'T002', 'QR002', 'Aktif'),
    ('K003', 'EMP003', 'Andi Nonaktif', 'HR', 1, 'Nonaktif', 'T003', 'QR003', 'Aktif');`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("Generate Alfa Harian & Setting Automation", () => {
  test("Auto Alfa Setting toggle dan nonaktif", async () => {
    // Default enabled
    const defaultSetting = await getAutoAlfaSetting();
    expect(defaultSetting).toBe(true);

    // Save disabled
    await saveAutoAlfaSetting(false);
    expect(await getAutoAlfaSetting()).toBe(false);

    // Generate alfa saat nonaktif -> mengembalikan status NONAKTIF
    const res = await generateAlfaHarian(new Date("2026-08-18T16:00:00+07:00"));
    expect(res.status).toBe("NONAKTIF");
    expect(res.jumlahAlfaDibuat).toBe(0);

    // Kembalikan ke aktif
    await saveAutoAlfaSetting(true);
    expect(await getAutoAlfaSetting()).toBe(true);
  });

  test("Generate Alfa dilewati pada Hari Libur Aktif", async () => {
    await saveAutoAlfaSetting(true);

    // Tambah hari libur 18 Agustus 2026
    await tambahHariLibur({
      tanggal: "2026-08-18",
      nama_libur: "Cuti Bersama",
      jenis_libur: "Cuti Bersama",
      status_aktif: 1,
    });

    const res = await generateAlfaHarian(new Date("2026-08-18T16:00:00+07:00"));
    expect(res.status).toBe("LIBUR");
    expect(res.jumlahAlfaDibuat).toBe(0);
  });

  test("Generate Alfa membuat entri Alfa untuk karyawan aktif setelah jam cutoff", async () => {
    await saveAutoAlfaSetting(true);

    // Pukul 16:00 (setelah jam pulang shift 1 15:00) pada hari kerja biasa (19 Agustus 2026)
    const res = await generateAlfaHarian(new Date("2026-08-19T16:00:00+07:00"));
    expect(res.status).toBe("SELESAI");
    expect(res.jumlahAlfaDibuat).toBe(2); // K001 & K002 aktif dibuatkan Alfa, K003 nonaktif di-skip

    // Verifikasi data di tabel absensi_harian
    const rows = await db.execute(
      "SELECT id_karyawan, status_kehadiran, status_absen, mode_tugas, sumber FROM absensi_harian WHERE tanggal = '2026-08-19';",
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows[0].status_kehadiran).toBe("Alfa");
    expect(rows.rows[0].status_absen).toBe("Tidak Hadir");
    expect(rows.rows[0].sumber).toBe("Generate Sistem");
    expect(rows.rows[0].mode_tugas).toBe("NORMAL");

    // Jalankan lagi di waktu yang sama -> jumlahSudahAda bertambah dan tidak membuat duplikat
    const res2 = await generateAlfaHarian(
      new Date("2026-08-19T16:30:00+07:00"),
    );
    expect(res2.jumlahAlfaDibuat).toBe(0);
    expect(res2.jumlahSudahAda).toBe(2);
  });
});
