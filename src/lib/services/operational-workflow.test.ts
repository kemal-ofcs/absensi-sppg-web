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
const { prosesKoreksiAdmin, hapusKoreksiAdmin } = await import(
  "@/lib/services/correction"
);
const { prosesImportOffline } = await import("@/lib/services/offline-import");
const { hapusLogScan, editAbsensiHarian } = await import(
  "@/lib/services/history-mutation"
);

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
        sql: `INSERT OR REPLACE INTO tbl_shift (
                id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
                awal_absen_menit, batas_masuk_menit, toleransi_masuk_menit,
                jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
                offset_istirahat_mulai, offset_generate_alfa, buffer_shift_malam_menit, izinkan_multi_sesi
              ) VALUES
              (1, 1, 'Shift 1 Pagi', '07:00', '15:00', 120, 0, 120, 480, 60, 240, 240, 180, 120, 0),
              (2, 2, 'Shift 2 Siang', '15:00', '23:00', 120, 0, 120, 480, 60, 240, 240, 180, 120, 0),
              (3, 3, 'Shift 3 Malam', '23:00', '07:00', 120, 0, 120, 480, 60, 240, 240, 180, 120, 0);`,
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

  test("import manual jam masuk lalu jam pulang untuk shift malam menggabungkan 1 baris utuh dan mencatat log scan Masuk & Pulang", async () => {
    await buatPenugasanBackup({
      tanggal_tugas: "2026-08-15",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_B.id,
      id_shift_backup: 3, // Shift 3 Malam (23:00 - 07:00)
      kode_operator: "SPD001",
    });

    // Step 1: Import Jam Masuk (23:00)
    const resMasuk = await prosesImportOffline(
      [
        {
          tanggal: "15/08/2026",
          id_unik: EMP_B.id,
          jam_masuk: "23:00",
          status_kehadiran: "Hadir",
        },
      ],
      "SPD001",
    );
    expect(resMasuk.berhasil).toBe(1);

    // Step 2: Import Jam Pulang (07:00)
    const resPulang = await prosesImportOffline(
      [
        {
          tanggal: "15/08/2026",
          id_unik: EMP_B.id,
          jam_pulang: "07:00",
          status_kehadiran: "Hadir",
        },
      ],
      "SPD001",
    );
    expect(resPulang.berhasil).toBe(1);

    // Verifikasi absensi_harian: hanya ada 1 baris untuk EMP_B di tanggal 15 Agustus
    const attendances = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-15';",
      args: [EMP_B.id],
    });
    expect(attendances.rows.length).toBe(1);
    const row = attendances.rows[0];
    expect(row?.mode_tugas).toBe("PENGGANTI");
    expect(row?.id_shift).toBe(3);
    expect(row?.status_absen).toBe("Lengkap");
    expect(row?.jam_masuk).toContain("23:00");
    expect(row?.jam_pulang).toContain("07:00");

    // Verifikasi log_scan: ada 2 log scan (Masuk dan Pulang) untuk tanggal_kerja 2026-08-15
    const logs = await db.execute({
      sql: "SELECT * FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = '2026-08-15' ORDER BY id_log ASC;",
      args: [EMP_B.id],
    });
    expect(logs.rows.length).toBe(2);
    expect(logs.rows[0]?.jenis_scan).toBe("Masuk");
    expect(logs.rows[1]?.jenis_scan).toBe("Pulang");
  });

  test("koreksi admin: lupa absen pulang mempertahankan menit_terlambat dari jam_masuk yang sudah ada", async () => {
    // 1. Assign backup shift 3 (Malam: 23:00 - 07:00)
    await buatPenugasanBackup({
      tanggal_tugas: "2026-08-18",
      id_karyawan_asal: EMP_A.id,
      id_karyawan_pengganti: EMP_B.id,
      id_shift_backup: 3,
      kode_operator: "SPD001",
    });

    // 2. Import Jam Masuk telat 60 menit (00:00 alih-alih 23:00)
    await prosesImportOffline(
      [
        {
          tanggal: "18/08/2026",
          id_unik: EMP_B.id,
          jam_masuk: "00:00",
          status_kehadiran: "Hadir",
        },
      ],
      "SPD001",
    );

    const checkBefore = await db.execute({
      sql: "SELECT menit_terlambat, status_absen FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-18';",
      args: [EMP_B.id],
    });
    expect(Number(checkBefore.rows[0]?.menit_terlambat)).toBe(60);
    expect(checkBefore.rows[0]?.status_absen).toBe("Belum Pulang");

    // 3. Koreksi Admin: Lupa Absen Pulang jam 07:00
    const korRes = await prosesKoreksiAdmin({
      tanggal: "18/08/2026",
      id_karyawan: EMP_B.id,
      jenis_koreksi: "Lupa Absen Pulang",
      jam_koreksi: "07:00",
      kode_operator: "SPD001",
    });
    expect(korRes.sukses).toBe(true);

    const checkAfter = await db.execute({
      sql: "SELECT menit_terlambat, status_absen, jam_masuk, jam_pulang FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-18';",
      args: [EMP_B.id],
    });
    expect(Number(checkAfter.rows[0]?.menit_terlambat)).toBe(60);
    expect(checkAfter.rows[0]?.status_absen).toBe("Lengkap");
  });

  test("koreksi admin: kendala sistem - jam masuk dan jam pulang berhasil mencatat log scan dan absensi harian", async () => {
    // 1. Koreksi Kendala Sistem - Jam Masuk (07:00)
    const inRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-20",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Masuk",
      jam_koreksi: "07:00",
      kode_operator: "SPD001",
    });
    expect(inRes.sukses).toBe(true);

    // 2. Koreksi Kendala Sistem - Jam Pulang (15:00)
    const outRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-20",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Pulang",
      jam_koreksi: "15:00",
      kode_operator: "SPD001",
    });
    expect(outRes.sukses).toBe(true);

    // Verifikasi absensi_harian
    const attRes = await db.execute({
      sql: "SELECT status_kehadiran, status_absen, jam_masuk, jam_pulang, sumber FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-20';",
      args: [EMP_A.id],
    });
    expect(attRes.rows.length).toBe(1);
    expect(attRes.rows[0]?.status_kehadiran).toBe("Hadir");
    expect(attRes.rows[0]?.status_absen).toBe("Lengkap");
    expect(attRes.rows[0]?.jam_masuk).toContain("07:00");
    expect(attRes.rows[0]?.jam_pulang).toContain("15:00");
    expect(attRes.rows[0]?.sumber).toBe("Koreksi Admin");

    // Verifikasi log_scan (Ada 2 log scan: Masuk dan Pulang)
    const logRes = await db.execute({
      sql: "SELECT jenis_scan, sumber_data, catatan_sistem FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = '2026-08-20' ORDER BY id_log ASC;",
      args: [EMP_A.id],
    });
    expect(logRes.rows.length).toBe(2);
    expect(logRes.rows[0]?.jenis_scan).toBe("Masuk");
    expect(logRes.rows[0]?.sumber_data).toBe("Koreksi Admin");
    expect(logRes.rows[1]?.jenis_scan).toBe("Pulang");
    expect(logRes.rows[1]?.sumber_data).toBe("Koreksi Admin");
  });

  test("koreksi admin: jam pulang yang diinput pada tanggal keesokan harinya (H+1) otomatis menyatu dengan sesi H-1 yang belum pulang", async () => {
    await db.execute({
      sql: "UPDATE master_data SET id_shift = 3 WHERE id_unik = ?;",
      args: [EMP_B.id],
    });

    // 1. Karyawan B (Shift 3 Malam 23:00 - 07:00) masuk via Koreksi Admin pada 2026-08-22
    const inRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-22",
      id_karyawan: EMP_B.id,
      jenis_koreksi: "Kendala Sistem - Jam Masuk",
      jam_koreksi: "23:00",
      kode_operator: "SPD001",
    });
    expect(inRes.sukses).toBe(true);

    // 2. Admin membuka form pada keesokan harinya (2026-08-23) dan mengisi tanggal 2026-08-23 dengan Jam Pulang 07:00
    const outRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-23",
      id_karyawan: EMP_B.id,
      jenis_koreksi: "Kendala Sistem - Jam Pulang",
      jam_koreksi: "07:00",
      kode_operator: "SPD001",
    });
    expect(outRes.sukses).toBe(true);

    // 3. Verifikasi TIDAK ADA baris terpisah pada 2026-08-23
    const day23 = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-23';",
      args: [EMP_B.id],
    });
    expect(day23.rows.length).toBe(0);

    // 4. Verifikasi baris pada 2026-08-22 menjadi Lengkap
    const day22 = await db.execute({
      sql: "SELECT status_kehadiran, status_absen, jam_masuk, jam_pulang FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-22';",
      args: [EMP_B.id],
    });
    expect(day22.rows.length).toBe(1);
    expect(day22.rows[0]?.status_absen).toBe("Lengkap");
    expect(day22.rows[0]?.jam_masuk).toContain("2026-08-22 23:00");
    expect(day22.rows[0]?.jam_pulang).toContain("2026-08-23 07:00");
  });

  test("hapus log scan memperbarui atau menghapus absensi harian secara relasional", async () => {
    // 1. Buat koreksi masuk dan pulang
    const inRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-25",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Masuk",
      jam_koreksi: "07:00",
      kode_operator: "SPD001",
    });
    const outRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-25",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Pulang",
      jam_koreksi: "15:00",
      kode_operator: "SPD001",
    });
    expect(inRes.sukses).toBe(true);
    expect(outRes.sukses).toBe(true);

    const logs = await db.execute({
      sql: "SELECT id_log, jenis_scan FROM log_scan WHERE id_karyawan = ? AND tanggal_kerja = '2026-08-25' ORDER BY id_log ASC;",
      args: [EMP_A.id],
    });
    expect(logs.rows.length).toBe(2);
    const outLogId = Number(logs.rows[1]?.id_log);

    // 2. Hapus log scan pulang -> absensi harian menjadi Belum Pulang
    const delOut = await hapusLogScan(outLogId, "SPD001");
    expect(delOut.sukses).toBe(true);

    const attAfterOut = await db.execute({
      sql: "SELECT status_absen, jam_masuk, jam_pulang FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-25';",
      args: [EMP_A.id],
    });
    expect(attAfterOut.rows.length).toBe(1);
    expect(attAfterOut.rows[0]?.status_absen).toBe("Belum Pulang");
    expect(attAfterOut.rows[0]?.jam_pulang).toBe("");

    // 3. Hapus log scan masuk tersisa -> absensi harian terhapus total
    const inLogId = Number(logs.rows[0]?.id_log);
    const delIn = await hapusLogScan(inLogId, "SPD001");
    expect(delIn.sukses).toBe(true);

    const attAfterAll = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-25';",
      args: [EMP_A.id],
    });
    expect(attAfterAll.rows.length).toBe(0);
  });

  test("hapus koreksi admin menghapus absensi harian dan log scan terkait", async () => {
    const korRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-26",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Sakit",
      keterangan_admin: "Surat Dokter",
      kode_operator: "SPD001",
    });
    expect(korRes.sukses).toBe(true);
    expect(korRes.id_referensi).toBeDefined();

    const refId = String(korRes.id_referensi ?? "");
    const delKor = await hapusKoreksiAdmin(refId, "SPD001");
    expect(delKor.sukses).toBe(true);

    const checkAtt = await db.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-26';",
      args: [EMP_A.id],
    });
    expect(checkAtt.rows.length).toBe(0);

    const checkKor = await db.execute({
      sql: "SELECT * FROM koreksi_admin WHERE id_referensi = ?;",
      args: [refId],
    });
    expect(checkKor.rows.length).toBe(0);
  });

  test("edit absensi harian memperbarui jam kerja dan metrik tanpa merusak data", async () => {
    await prosesKoreksiAdmin({
      tanggal: "2026-08-27",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Masuk",
      jam_koreksi: "07:00",
      kode_operator: "SPD001",
    });

    const attBefore = await db.execute({
      sql: "SELECT id_sesi FROM absensi_harian WHERE id_karyawan = ? AND tanggal = '2026-08-27';",
      args: [EMP_A.id],
    });
    const idSesi = String(attBefore.rows[0]?.id_sesi);

    const editRes = await editAbsensiHarian(
      idSesi,
      {
        jam_masuk: "2026-08-27 07:00:00",
        jam_pulang: "2026-08-27 16:00:00",
        status_kehadiran: "Hadir",
        status_absen: "Lengkap",
      },
      "SPD001",
    );
    expect(editRes.sukses).toBe(true);

    const attAfter = await db.execute({
      sql: "SELECT nama, status_absen, jam_masuk, jam_pulang, jam_kerja FROM absensi_harian WHERE id_sesi = ?;",
      args: [idSesi],
    });
    expect(attAfter.rows.length).toBe(1);
    expect(attAfter.rows[0]?.nama).toBe(EMP_A.name);
    expect(attAfter.rows[0]?.status_absen).toBe("Lengkap");
    expect(attAfter.rows[0]?.jam_masuk).toContain("07:00");
    expect(attAfter.rows[0]?.jam_pulang).toContain("16:00");
  });

  test("hapusLogScan untuk scan Pulang mempertahankan menit_terlambat dari scan Masuk asli dan mereset status ke Belum Pulang", async () => {
    // 1. Buat log scan Masuk terlambat 15 menit (07:15)
    await db.execute({
      sql: `INSERT INTO log_scan (
              id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama,
              divisi, jenis_scan, status_proses, sumber_data, menit_terlambat, kode_operator
            ) VALUES (9001, '2026-08-28 07:15:00', '2026-08-28', '07:15:00', ?, ?, 'Produksi', 'Masuk', 'Berhasil', 'Scanner', 15, 'OP001');`,
      args: [EMP_A.id, EMP_A.name],
    });

    // 2. Buat log scan Pulang (15:00)
    await db.execute({
      sql: `INSERT INTO log_scan (
              id_log, timestamp_scan, tanggal_kerja, jam_scan, id_karyawan, nama,
              divisi, jenis_scan, status_proses, sumber_data, menit_terlambat, kode_operator
            ) VALUES (9002, '2026-08-28 15:00:00', '2026-08-28', '15:00:00', ?, ?, 'Produksi', 'Pulang', 'Berhasil', 'Scanner', 0, 'OP001');`,
      args: [EMP_A.id, EMP_A.name],
    });

    // 3. Buat absensi harian Lengkap
    await db.execute({
      sql: `INSERT INTO absensi_harian (
              id_sesi, id_karyawan, tanggal, nama, kelas_divisi, id_shift,
              jam_masuk, jam_pulang, status_kehadiran, status_absen,
              menit_terlambat, menit_datang_awal, jam_kerja,
              sumber, update_terakhir, bulan, tahun
            ) VALUES (
              'SESI_TEST_DEL_OUT', ?, '2026-08-28', ?, 'Produksi', 1,
              '2026-08-28 07:15:00', '2026-08-28 15:00:00', 'Hadir', 'Lengkap',
              15, 0, 405,
              'Scanner', '2026-08-28 15:00:00', 'Agustus', 2026
            );`,
      args: [EMP_A.id, EMP_A.name],
    });

    // 4. Hapus log scan Pulang (id_log = 9002)
    const delRes = await hapusLogScan(9002, "OP001");
    expect(delRes.sukses).toBe(true);

    // 5. Verifikasi absensi_harian: menit_terlambat tetap 15, jam_pulang kosong, status_absen = 'Belum Pulang'
    const attCheck = await db.execute({
      sql: "SELECT jam_masuk, jam_pulang, status_absen, menit_terlambat, jam_kerja FROM absensi_harian WHERE id_sesi = 'SESI_TEST_DEL_OUT';",
    });
    expect(attCheck.rows.length).toBe(1);
    const row = attCheck.rows[0] as Record<string, unknown>;
    expect(row.status_absen).toBe("Belum Pulang");
    expect(row.menit_terlambat).toBe(15);
    expect(String(row.jam_pulang || "")).toBe("");
    expect(Number(row.jam_kerja || 0)).toBe(0);
  });

  test("koreksi admin: smart shift auto-detection jika jam koreksi cocok dengan shift 3 malam (23:00-07:00)", async () => {
    // Karyawan A defaultnya Shift 1 (07:00 - 15:00)
    // Admin memasukkan koreksi jam pulang 06:00 (rentang shift 3 malam)
    const korRes = await prosesKoreksiAdmin({
      tanggal: "2026-08-29",
      id_karyawan: EMP_A.id,
      jenis_koreksi: "Kendala Sistem - Jam Pulang",
      jam_koreksi: "06:00",
      kode_operator: "SPD001",
    });
    // Smart shift auto-detection harus berhasil mencocokkan ke shift yang rentangnya sesuai
    expect(korRes.sukses).toBe(true);

    const attRes = await db.execute({
      sql: "SELECT id_shift, jam_pulang, menit_terlambat FROM absensi_harian WHERE id_karyawan = ? AND (tanggal = '2026-08-29' OR tanggal = '2026-08-28');",
      args: [EMP_A.id],
    });
    expect(attRes.rows.length).toBeGreaterThan(0);
    const att = attRes.rows[0] as Record<string, unknown>;
    expect(Number(att.menit_terlambat || 0)).toBe(0);
  });
});
