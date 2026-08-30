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

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-audit-test-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { auditKualitasAbsensi } = await import("./attendance-audit");
const { tambahHariLibur } = await import("./holiday");

/** Shift 1: jendela masuk tutup 07:45 (07:00 + 15 + 30), scan pulang tutup 16:00 (15:00 + 60). */
const TANGGAL = "2026-08-19";

function waktu(jam: string) {
  return new Date(`${TANGGAL}T${jam}:00+07:00`);
}

beforeAll(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  await db.batch([
    "DELETE FROM tbl_hari_libur;",
    "DELETE FROM absensi_harian;",
    "DELETE FROM audit_absensi;",
    "DELETE FROM log_scan;",
    "DELETE FROM master_data;",
    "DELETE FROM tbl_shift;",
    `INSERT INTO tbl_shift (
      id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
      awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
      jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
      offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit,
      izinkan_multi_sesi
    ) VALUES
    (1, 1, 'Shift Pagi',      '07:00', '15:00', 60, 15, 30, 420, 60, 60, 240, 60, 120, 0),
    (3, 3, 'Shift Malam',     '22:00', '06:00', 60, 15, 30, 420, 60, 60, 240, 60, 120, 0),
    (9, 9, 'Shift Fleksibel', '00:00', '23:59',  0,  0,  0,   0,  0,  0,   0,  0,   0, 0);`,
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

async function seedAbsensi(fields: {
  id: string;
  nama: string;
  jamMasuk?: string;
  jamPulang?: string;
  statusKehadiran?: string;
  sumber?: string;
  menitTerlambat?: number;
  jamKerjaKurang?: number;
}) {
  await db.execute({
    sql: `INSERT INTO absensi_harian (
            tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
            status_kehadiran, status_absen, keterangan, sumber, update_terakhir,
            menit_terlambat, menit_datang_awal, jam_kerja, lembur, jam_kerja_kurang,
            id_shift, bulan, tahun, id_sesi, mode_tugas
          ) VALUES (?, ?, ?, 'IT', ?, ?, ?, 'Lengkap', '', ?, '2026-08-19 12:00:00',
                    ?, 0, 0, 0, ?, 1, 'Agustus', 2026, ?, 'NORMAL');`,
    args: [
      TANGGAL,
      fields.id,
      fields.nama,
      fields.jamMasuk ?? "",
      fields.jamPulang ?? "",
      fields.statusKehadiran ?? "Hadir",
      fields.sumber ?? "Scanner",
      fields.menitTerlambat ?? 0,
      fields.jamKerjaKurang ?? 0,
      `NORMAL-20260819-${fields.id}-1`,
    ],
  });
}

describe("Audit Kualitas Absensi", () => {
  test("menandai karyawan yang belum absen setelah jendela scan masuk tutup", async () => {
    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("09:00"));

    expect(hasil.ringkasan.wajibAbsen).toBe(2);
    expect(hasil.ringkasan.belumScanMasuk).toBe(2);
    expect(hasil.ringkasan.menungguJamAbsen).toBe(0);
    expect(hasil.ringkasan.skorKualitas).toBe(0);

    const temuan = hasil.temuan.filter(
      (item) => item.kategori === "Belum Scan Masuk",
    );
    expect(temuan.length).toBe(2);
    expect(temuan[0].keparahan).toBe("tinggi");
    expect(temuan[0].detail).toContain("07:45");
  });

  test("belum menyalahkan karyawan selagi jendela scan masuk masih terbuka", async () => {
    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("07:30"));

    expect(hasil.ringkasan.belumScanMasuk).toBe(0);
    expect(hasil.ringkasan.menungguJamAbsen).toBe(2);
    expect(hasil.ringkasan.karyawanBermasalah).toBe(0);
    expect(hasil.ringkasan.skorKualitas).toBe(100);
  });

  test("menandai sesi menggantung setelah jendela scan pulang tutup", async () => {
    await seedAbsensi({ id: "K001", nama: "Budi Santoso", jamMasuk: "07:02" });
    await seedAbsensi({
      id: "K002",
      nama: "Siti Aminah",
      jamMasuk: "07:05",
      jamPulang: "15:10",
    });

    // 16:30 — jendela scan pulang (16:00) sudah lewat.
    const lewat = await auditKualitasAbsensi(TANGGAL, waktu("16:30"));
    expect(lewat.ringkasan.belumScanPulang).toBe(1);
    expect(lewat.ringkasan.sedangBekerja).toBe(0);
    expect(lewat.ringkasan.hadir).toBe(2);
    expect(
      lewat.temuan.find((item) => item.kategori === "Belum Scan Pulang")
        ?.idKaryawan,
    ).toBe("K001");

    // 15:30 — masih dalam jendela scan pulang, belum jadi temuan.
    const masihBuka = await auditKualitasAbsensi(TANGGAL, waktu("15:30"));
    expect(masihBuka.ringkasan.belumScanPulang).toBe(0);
    expect(masihBuka.ringkasan.sedangBekerja).toBe(1);
  });

  test("menghitung scan yang perlu verifikasi dan yang ditolak", async () => {
    await seedAbsensi({ id: "K001", nama: "Budi Santoso", jamMasuk: "07:02" });
    await seedAbsensi({ id: "K002", nama: "Siti Aminah", jamMasuk: "07:05" });
    await db.batch([
      {
        sql: `INSERT INTO log_scan (timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data)
              VALUES ('2026-08-19 07:02:00', ?, '07:02', 'K001', 'Budi Santoso', 'IT', 'Masuk', 'Perlu Verifikasi', 'Scanner');`,
        args: [TANGGAL],
      },
      {
        sql: `INSERT INTO log_scan (timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama, divisi, jenis_scan, status_proses, sumber_data)
              VALUES ('2026-08-19 07:06:00', ?, '07:06', 'K002', 'Siti Aminah', 'Finance', 'Masuk', 'Ditolak', 'Scanner');`,
        args: [TANGGAL],
      },
    ]);

    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("09:00"));

    expect(hasil.ringkasan.perluVerifikasi).toBe(1);
    expect(hasil.ringkasan.scanDitolak).toBe(1);
    expect(hasil.ringkasan.karyawanBermasalah).toBe(2);
    expect(
      hasil.temuan.some((item) => item.kategori === "Perlu Verifikasi"),
    ).toBe(true);
    expect(hasil.temuan.some((item) => item.kategori === "Scan Ditolak")).toBe(
      true,
    );
  });

  test("Alfa, terlambat, jam kerja kurang, dan koreksi admin muncul sebagai temuan", async () => {
    await seedAbsensi({
      id: "K001",
      nama: "Budi Santoso",
      statusKehadiran: "Alfa",
      sumber: "Generate Sistem",
    });
    await seedAbsensi({
      id: "K002",
      nama: "Siti Aminah",
      jamMasuk: "08:10",
      jamPulang: "14:00",
      sumber: "Koreksi Admin",
      menitTerlambat: 40,
      jamKerjaKurang: 60,
    });

    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("17:00"));

    expect(hasil.ringkasan.alfa).toBe(1);
    expect(hasil.ringkasan.terlambat).toBe(1);
    expect(hasil.ringkasan.jamKerjaKurang).toBe(1);
    expect(hasil.ringkasan.koreksiAdmin).toBe(1);
    // Terlambat/jam kerja kurang berat rendah, jadi K002 tetap dihitung bersih.
    expect(hasil.ringkasan.karyawanBermasalah).toBe(1);
    expect(hasil.ringkasan.skorKualitas).toBe(50);

    // Temuan paling mendesak selalu di urutan pertama.
    expect(hasil.temuan[0].kategori).toBe("Alfa");
    expect(hasil.temuan[0].keparahan).toBe("tinggi");
  });

  test("hari libur aktif membuat tidak ada karyawan yang wajib absen", async () => {
    await tambahHariLibur({
      tanggal: TANGGAL,
      nama_libur: "Cuti Bersama",
      jenis_libur: "Cuti Bersama",
      status_aktif: 1,
    });

    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("17:00"));

    expect(hasil.hariLibur).toBe("Cuti Bersama");
    expect(hasil.ringkasan.wajibAbsen).toBe(0);
    expect(hasil.ringkasan.belumScanMasuk).toBe(0);
    expect(hasil.ringkasan.skorKualitas).toBe(100);
    expect(hasil.temuan.length).toBe(0);
  });

  test("shift fleksibel belum disalahkan selagi harinya masih berjalan", async () => {
    await db.execute(
      "UPDATE master_data SET id_shift = 9 WHERE id_unik = 'K001';",
    );
    await db.execute(
      "UPDATE master_data SET id_shift = 77 WHERE id_unik = 'K002';",
    );

    const hasil = await auditKualitasAbsensi(TANGGAL, waktu("17:00"));

    expect(hasil.ringkasan.fleksibel).toBe(1);
    expect(hasil.ringkasan.shiftTidakValid).toBe(1);
    // Shift fleksibel kini ikut wajib absen, tetapi pukul 17:00 karyawan masih
    // punya waktu sampai 23:59 sehingga belum boleh dihitung bermasalah.
    expect(hasil.ringkasan.wajibAbsen).toBe(1);
    expect(hasil.ringkasan.menungguJamAbsen).toBe(1);
    expect(hasil.ringkasan.belumScanMasuk).toBe(0);
    expect(
      hasil.temuan.find((item) => item.kategori === "Shift Tidak Valid")
        ?.idKaryawan,
    ).toBe("K002");
  });

  test("shift fleksibel yang tidak absen seharian jadi temuan setelah harinya lewat", async () => {
    await db.execute("UPDATE master_data SET id_shift = 9;");

    const hasil = await auditKualitasAbsensi(
      TANGGAL,
      new Date("2026-08-25T10:00:00+07:00"),
    );

    expect(hasil.ringkasan.fleksibel).toBe(2);
    expect(hasil.ringkasan.wajibAbsen).toBe(2);
    expect(hasil.ringkasan.tanpaData).toBe(2);
    expect(hasil.ringkasan.skorKualitas).toBe(0);
  });

  test("shift fleksibel yang lupa scan pulang tetap dilaporkan", async () => {
    await db.execute("UPDATE master_data SET id_shift = 9;");
    // Datang pukul 10:15 lalu tidak pernah scan pulang sampai harinya habis.
    await seedAbsensi({ id: "K001", nama: "Budi Santoso", jamMasuk: "10:15" });
    await seedAbsensi({
      id: "K002",
      nama: "Siti Aminah",
      jamMasuk: "13:40",
      jamPulang: "21:05",
    });

    const hasil = await auditKualitasAbsensi(
      TANGGAL,
      new Date("2026-08-25T10:00:00+07:00"),
    );

    expect(hasil.ringkasan.belumScanPulang).toBe(1);
    expect(hasil.ringkasan.sedangBekerja).toBe(0);
    // Jam bebas, jadi tidak ada keterlambatan yang dihitung.
    expect(hasil.ringkasan.terlambat).toBe(0);
    expect(
      hasil.temuan.find((item) => item.kategori === "Belum Scan Pulang")
        ?.idKaryawan,
    ).toBe("K001");
  });

  test("tanggal lampau tanpa baris absensi dilaporkan sebagai tanpa data", async () => {
    const hasil = await auditKualitasAbsensi(
      TANGGAL,
      new Date("2026-08-25T10:00:00+07:00"),
    );

    expect(hasil.ringkasan.tanpaData).toBe(2);
    expect(hasil.ringkasan.belumScanMasuk).toBe(0);
    expect(hasil.temuan[0].kategori).toBe("Tanpa Data Absensi");
  });

  // Shift malam (22:00-06:00) jendelanya melewati tengah malam, jadi seluruh
  // batas audit berada di garis waktu > 1440 relatif tanggal kerja.
  describe("shift malam", () => {
    beforeEach(async () => {
      await db.execute("UPDATE master_data SET id_shift = 3;");
    });

    test("belum scan masuk baru muncul setelah jendela masuk 22:45 lewat", async () => {
      // 22:30 — masih di dalam jendela (22:00 + 15 + 30).
      const masihBuka = await auditKualitasAbsensi(TANGGAL, waktu("22:30"));
      expect(masihBuka.ringkasan.menungguJamAbsen).toBe(2);
      expect(masihBuka.ringkasan.belumScanMasuk).toBe(0);

      const sudahTutup = await auditKualitasAbsensi(TANGGAL, waktu("23:00"));
      expect(sudahTutup.ringkasan.belumScanMasuk).toBe(2);
      expect(sudahTutup.temuan[0].detail).toContain("22:45");
    });

    test("masih dianggap bekerja sampai jendela pulang lintas hari tertutup", async () => {
      await seedAbsensi({
        id: "K001",
        nama: "Budi Santoso",
        jamMasuk: "22:05",
      });
      await seedAbsensi({
        id: "K002",
        nama: "Siti Aminah",
        jamMasuk: "22:10",
        jamPulang: "06:05",
      });

      // Jendela scan pulang tutup 06:00 H+1 + batas 60 + buffer 120 = 09:00 H+1.
      const pagiHariBerikutnya = await auditKualitasAbsensi(
        TANGGAL,
        new Date("2026-08-20T07:00:00+07:00"),
      );
      expect(pagiHariBerikutnya.ringkasan.sedangBekerja).toBe(1);
      expect(pagiHariBerikutnya.ringkasan.belumScanPulang).toBe(0);

      const setelahJendelaTutup = await auditKualitasAbsensi(
        TANGGAL,
        new Date("2026-08-20T10:00:00+07:00"),
      );
      expect(setelahJendelaTutup.ringkasan.belumScanPulang).toBe(1);
      expect(
        setelahJendelaTutup.temuan.find(
          (item) => item.kategori === "Belum Scan Pulang",
        )?.idKaryawan,
      ).toBe("K001");
    });

    test("tidak pernah dianggap fleksibel meski melintasi tengah malam", async () => {
      const hasil = await auditKualitasAbsensi(TANGGAL, waktu("23:00"));
      expect(hasil.ringkasan.fleksibel).toBe(0);
      expect(hasil.ringkasan.wajibAbsen).toBe(2);
    });
  });
});
