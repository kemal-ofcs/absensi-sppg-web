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

const testDirectory = mkdtempSync(join(tmpdir(), "sppg-ops-workflow-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { buatPenugasanBackup } = await import("@/lib/services/backup");
const { prosesKoreksiAdmin } = await import("@/lib/services/correction");
const { prosesImportOffline } = await import("@/lib/services/offline-import");

const EMP_A = {
  id: "EMP_OPS_001",
  code: "KW_OPS_001",
  name: "Karyawan Asal Ops",
};

const EMP_B = {
  id: "EMP_OPS_002",
  code: "KW_OPS_002",
  name: "Karyawan Pengganti Ops",
};

beforeAll(async () => {
  await ensureDbInitialized();
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

beforeEach(async () => {
  await db.batch(
    [
      "DELETE FROM sync_change_log;",
      "DELETE FROM log_scan;",
      "DELETE FROM absensi_harian;",
      "DELETE FROM backup_karyawan;",
      "DELETE FROM koreksi_admin;",
      "DELETE FROM master_data;",
      "DELETE FROM master_operator;",
      {
        sql: `INSERT INTO master_data (
                id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
                token_absensi, status_backup
              ) VALUES 
              (?, ?, ?, 'Produksi', 1, 'Aktif', 'TOKEN-OPS-01', 'NORMAL'),
              (?, ?, ?, 'Produksi', 1, 'Aktif', 'TOKEN-OPS-02', 'NORMAL');`,
        args: [
          EMP_A.id,
          EMP_A.code,
          EMP_A.name,
          EMP_B.id,
          EMP_B.code,
          EMP_B.name,
        ],
      },
      {
        sql: `INSERT INTO master_operator (
                kode_operator, nama_operator, username, password_hash, role, status
              ) VALUES ('SPD001', 'Operator Test', 'spd001', 'unused', 'Operator', 'Aktif');`,
        args: [],
      },
      {
        sql: `UPDATE tbl_shift SET 
              awal_absen_menit = 120, batas_masuk_menit = 60, toleransi_masuk_menit = 15,
              jam_kerja_normal_menit = 480, istirahat_menit = 60, batas_pulang_menit = 240,
              offset_istirahat_mulai = 240, offset_generate_alfa = 180, buffer_shift_malam_menit = 120,
              izinkan_multi_sesi = 0 WHERE kode_shift IN (1, 2, 3) OR id_shift IN (1, 2, 3);`,
        args: [],
      },
    ],
    "write",
  );
});

describe("workflow operasional: penugasan backup karyawan", () => {
  test("berhasil membuat penugasan backup dengan normalisasi format tanggal", async () => {
    const res = await buatPenugasanBackup({
      tanggal_tugas: "15/08/2026",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_B.id,
      id_shift_backup: 2,
      alasan_backup: "Karyawan A sakit",
      kode_operator: "SPD001",
    });

    expect(res.sukses).toBe(true);
    expect(res.id_backup).toBeDefined();

    const check = await db.execute({
      sql: "SELECT * FROM backup_karyawan WHERE id_backup = ?;",
      args: [res.id_backup ?? ""],
    });
    expect(check.rows.length).toBe(1);
    expect(check.rows[0]?.tanggal_tugas).toBe("2026-08-15");
    expect(check.rows[0]?.id_shift_backup).toBe(2);
  });

  test("menolak penugasan backup jika karyawan asal dan pengganti sama", async () => {
    const res = await buatPenugasanBackup({
      tanggal_tugas: "2026-08-15",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_A.id,
      id_shift_backup: 2,
      kode_operator: "SPD001",
    });

    expect(res.sukses).toBe(false);
    expect(res.pesan).toContain("tidak boleh orang yang sama");
  });
});

describe("workflow operasional: koreksi admin & entri manual", () => {
  test("koreksi kehadiran non-hadir (Sakit) membuat record Tidak Hadir", async () => {
    const res = await prosesKoreksiAdmin({
      tanggal: "15/08/2026",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Sakit",
      keterangan_admin: "Surat dokter terlampir",
      kode_operator: "SPD001",
    });

    expect(res.sukses).toBe(true);

    const check = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-15';",
      args: [EMP_A.id],
    });
    expect(check.rows.length).toBe(1);
    expect(check.rows[0]?.status_kehadiran).toBe("Sakit");
    expect(check.rows[0]?.status_absen).toBe("Tidak Hadir");
    expect(check.rows[0]?.jam_kerja).toBe(0);
  });

  test("entri koreksi jam masuk dan pulang menghitung keterlambatan dan jam kerja", async () => {
    const resMasuk = await prosesKoreksiAdmin({
      tanggal: "2026-08-15",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Terlambat",
      jam_koreksi: "07:30",
      keterangan_admin: "Input koreksi masuk",
      kode_operator: "SPD001",
    });
    expect(resMasuk.sukses).toBe(true);

    const resPulang = await prosesKoreksiAdmin({
      tanggal: "2026-08-15",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Lupa Absen Pulang",
      jam_koreksi: "16:00",
      keterangan_admin: "Input koreksi pulang",
      kode_operator: "SPD001",
    });
    expect(resPulang.sukses).toBe(true);

    const check = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-15';",
      args: [EMP_A.id],
    });
    expect(check.rows.length).toBe(1);
    expect(check.rows[0]?.status_kehadiran).toBe("Hadir");
    expect(check.rows[0]?.status_absen).toBe("Lengkap");
  });

  test("entri koreksi jam karyawan pengganti otomatis memetakan ke sesi backup", async () => {
    await buatPenugasanBackup({
      tanggal_tugas: "2026-08-15",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_B.id,
      id_shift_backup: 2,
      kode_operator: "SPD001",
    });

    const res = await prosesKoreksiAdmin({
      tanggal: "2026-08-15",
      id_karyawan: EMP_B.id,
      jenis_koreksi: "Lupa Absen Masuk",
      jam_koreksi: "15:00",
      kode_operator: "SPD001",
    });

    expect(res.sukses).toBe(true);

    const check = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-15';",
      args: [EMP_B.id],
    });
    expect(check.rows.length).toBe(1);
    expect(check.rows[0]?.mode_tugas).toBe("PENGGANTI");
    expect(check.rows[0]?.id_shift).toBe(2);
    expect(check.rows[0]?.id_karyawan_asal).toBe(EMP_A.id);
  });
});

describe("workflow operasional: import offline / spreadsheet manual", () => {
  test("import spreadsheet menghasilkan 2 baris terpisah untuk shift normal dan shift backup", async () => {
    await buatPenugasanBackup({
      tanggal_tugas: "2026-08-15",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_B.id,
      id_shift_backup: 2,
      kode_operator: "SPD001",
    });

    const importRes = await prosesImportOffline(
      [
        {
          tanggal: "15/08/2026",
          id_unik: EMP_B.id,
          jam_masuk: "07:00",
          jam_pulang: "15:00",
          status_kehadiran: "Hadir",
        },
        {
          tanggal: "15/08/2026",
          id_unik: EMP_B.id,
          jam_masuk: "15:00",
          jam_pulang: "23:00",
          status_kehadiran: "Hadir",
        },
      ],
      "SPD001",
    );

    expect(importRes.berhasil).toBe(2);
    expect(importRes.gagal).toBe(0);

    const attendances = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-15' ORDER BY id_shift ASC;",
      args: [EMP_B.id],
    });

    expect(attendances.rows.length).toBe(2);

    expect(attendances.rows[0]?.id_shift).toBe(1);
    expect(attendances.rows[0]?.mode_tugas).toBe("NORMAL");

    expect(attendances.rows[1]?.id_shift).toBe(2);
    expect(attendances.rows[1]?.mode_tugas).toBe("PENGGANTI");
    expect(attendances.rows[1]?.id_karyawan_asal).toBe(EMP_A.id);
  });
});
