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
    "DELETE FROM tbl_shift;",
    "DELETE FROM setting_gex_system WHERE key = 'auto_alfa_aktif';",
    // Shift 1  : cutoff Alfa = 15:00 + 60 (batas pulang) + 60 (offset) = 17:00
    // Shift 4  : cutoff Alfa = 09:40 + 5  (batas pulang) + 5  (offset) = 09:50
    //            kode_shift-nya 4 — dulu angka itu dianggap "fleksibel".
    // Shift 9  : benar-benar fleksibel (jam kerja normal 0 menit).
    `INSERT INTO tbl_shift (
      id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
      awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
      jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
      offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
      izinkan_multi_sesi
    ) VALUES
    (1, 1, 'Shift Pagi',       '07:00', '15:00', 60, 15, 30, 420, 60,  60, 240,  60, 120, 0),
    (4, 4, 'Shift Kode Empat', '07:00', '09:40', 60, 15,  0, 160, 60,   5, 240,   5, 120, 0),
    (9, 9, 'Shift Fleksibel',  '00:00', '23:59',  0,  0,  0,   0,  0,   0,   0,   0,   0, 0);`,
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

    // Pukul 17:30 — setelah cutoff shift 1 (pulang 15:00 + batas pulang 60 +
    // offset 60 = 17:00) pada hari kerja biasa (19 Agustus 2026).
    const res = await generateAlfaHarian(new Date("2026-08-19T17:30:00+07:00"));
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
      new Date("2026-08-19T17:45:00+07:00"),
    );
    expect(res2.jumlahAlfaDibuat).toBe(0);
    expect(res2.jumlahSudahAda).toBe(2);
  });

  test("shift ber-kode_shift 4 tetap di-generate (bukan dianggap fleksibel)", async () => {
    await saveAutoAlfaSetting(true);
    await db.execute(
      "UPDATE master_data SET id_shift = 4 WHERE id_unik = 'K001';",
    );

    // 09:50 = tepat cutoff shift 4 (pulang 09:40 + batas pulang 5 + offset 5).
    const res = await generateAlfaHarian(new Date("2026-08-19T09:50:00+07:00"));

    // K001 di shift 4 di-Alfa-kan; K002 masih di shift 1 yang cutoff-nya 17:00.
    expect(res.jumlahAlfaDibuat).toBe(1);
    expect(res.jumlahFleksibel).toBe(0);
    expect(res.jumlahBelumWaktunya).toBe(1);

    const rows = await db.execute(
      "SELECT id_karyawan, id_shift FROM absensi_harian WHERE tanggal = '2026-08-19';",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].id_karyawan).toBe("K001");
    expect(Number(rows.rows[0].id_shift)).toBe(4);
  });

  test("Alfa tidak dibuat selagi jendela scan pulang masih terbuka", async () => {
    await saveAutoAlfaSetting(true);
    await db.execute(
      "UPDATE master_data SET id_shift = 4 WHERE id_unik = 'K001';",
    );

    // 09:44 — jam pulang sudah lewat, tetapi batas pulang (09:45) belum.
    const res = await generateAlfaHarian(new Date("2026-08-19T09:44:00+07:00"));

    expect(res.jumlahAlfaDibuat).toBe(0);
    expect(res.jumlahBelumWaktunya).toBe(2);
  });

  test("shift fleksibel di-Alfa-kan untuk hari kemarin, bukan hari berjalan", async () => {
    await saveAutoAlfaSetting(true);
    await db.execute("UPDATE master_data SET id_shift = 9;");

    // Pukul 23:00 tanggal 19: hari itu belum habis, karyawan masih berhak absen
    // sampai 23:59. Yang dinilai adalah tanggal 18 yang sudah selesai.
    const res = await generateAlfaHarian(new Date("2026-08-19T23:00:00+07:00"));

    expect(res.jumlahFleksibel).toBe(2);
    expect(res.jumlahAlfaDibuat).toBe(2);

    const rows = await db.execute(
      "SELECT DISTINCT tanggal FROM absensi_harian;",
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].tanggal).toBe("2026-08-18");
  });

  test("shift fleksibel yang sudah absen kemarin tidak di-Alfa-kan", async () => {
    await saveAutoAlfaSetting(true);
    await db.execute("UPDATE master_data SET id_shift = 9;");
    await db.execute({
      sql: `INSERT INTO absensi_harian (
              tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
              status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
              menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
              id_shift, bulan, tahun, id_sesi, mode_tugas
            ) VALUES ('2026-08-18', 'K001', 'Karyawan Satu', 'IT', '11:20', '19:45',
                      'Hadir', 'Lengkap', '', 'Scanner', '2026-08-18 19:45:00',
                      0, 0, 0, 0, 0, 9, 'Agustus', 2026, ?, 'NORMAL');`,
      args: ["NORMAL-20260818-K001-9"],
    });

    const res = await generateAlfaHarian(new Date("2026-08-19T23:00:00+07:00"));

    expect(res.jumlahSudahAda).toBe(1);
    expect(res.jumlahAlfaDibuat).toBe(1);
  });

  test("karyawan dengan shift hilang dilewati dan dicatat ke audit", async () => {
    await saveAutoAlfaSetting(true);
    await db.execute(
      "UPDATE master_data SET id_shift = 77 WHERE id_unik = 'K001';",
    );

    const res = await generateAlfaHarian(new Date("2026-08-19T17:30:00+07:00"));

    expect(res.jumlahShiftTidakValid).toBe(1);
    expect(res.jumlahAlfaDibuat).toBe(1); // hanya K002 yang shift-nya valid

    const audit = await db.execute(
      "SELECT id_karyawan, jenis, status FROM audit_absensi WHERE jenis = 'Skip Generate Alfa';",
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].id_karyawan).toBe("K001");
    expect(audit.rows[0].status).toBe("Gagal");
  });
});
