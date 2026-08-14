import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  processWebAttendanceScan,
  type ScanPayload,
} from "./attendance-processor";

let client: Client;
let testDirectory: string;

const EMPLOYEE = {
  id: "EMP_WEB_001",
  code: "KW001",
  token: "TOKEN-WEB-001",
};

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "sppg-attendance-web-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.execute("DROP TRIGGER IF EXISTS test_fail_attendance;");
  await client.batch(
    [
      "DELETE FROM sync_change_log;",
      "DELETE FROM log_scan;",
      "DELETE FROM absensi_harian;",
      "DELETE FROM backup_karyawan;",
      "DELETE FROM master_data;",
      {
        sql: `UPDATE tbl_shift SET awal_absen_menit = 60,
              batas_masuk_menit = 15, toleransi_masuk_menit = 30,
              jam_kerja_normal_menit = 420, istirahat_menit = 60,
              batas_pulang_menit = 120, offset_istirahat_mulai = 240,
              buffer_shift_malam_menit = 120 WHERE kode_shift IN (1, 2, 3);`,
        args: [],
      },
      {
        sql: "UPDATE setting_gex_system SET value = 'false' WHERE key = 'geofence_enabled';",
        args: [],
      },
      {
        sql: "UPDATE setting_gex_system SET value = '60' WHERE key = 'anti_double_scan_seconds';",
        args: [],
      },
      {
        sql: `INSERT INTO setting_gex_system (key, value)
              VALUES ('batas_multi_scan_menit', '5')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        args: [],
      },
    ],
    "write",
  );
  await insertEmployee();
});

afterAll(async () => {
  client.close();
  await Bun.sleep(50);
  try {
    rmSync(testDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EBUSY"
    ) {
      throw error;
    }
  }
});

async function insertEmployee(
  input: {
    id?: string;
    code?: string;
    token?: string;
    shift?: number;
    status?: string;
    name?: string;
  } = {},
) {
  await client.execute({
    sql: `INSERT INTO master_data (
            id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif,
            token_absensi, status_backup
          ) VALUES (?, ?, ?, 'Produksi', ?, ?, ?, 'NORMAL');`,
    args: [
      input.id ?? EMPLOYEE.id,
      input.code ?? EMPLOYEE.code,
      input.name ?? "Karyawan Web",
      input.shift ?? 1,
      input.status ?? "Aktif",
      input.token ?? EMPLOYEE.token,
    ],
  });
}

function jakarta(date: string, time: string) {
  return `${date}T${time}:00+07:00`;
}

async function scanAt(waktuScan: string, payload: Partial<ScanPayload> = {}) {
  return processWebAttendanceScan(
    client,
    {
      qrText: `${EMPLOYEE.id}|${EMPLOYEE.token}`,
      sumberScan: "Scanner",
      kodeOperator: "OP_WEB",
      ...payload,
    },
    { waktuScan, actorOperatorId: 1 },
  );
}

async function tableCount(
  table: "log_scan" | "absensi_harian" | "sync_change_log",
) {
  const result = await client.execute(
    `SELECT COUNT(*) AS count FROM ${table};`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe("integrasi Web mesin aturan scan", () => {
  test("scan masuk berhasil menulis LOG_SCAN dan ABSENSI_HARIAN dalam timezone Jakarta", async () => {
    const result = await scanAt(jakarta("2026-08-12", "06:30"));
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );
    const log = await client.execute("SELECT * FROM log_scan LIMIT 1;");

    expect(result).toMatchObject({
      sukses: true,
      status: "Berhasil",
      jenisScan: "Masuk",
      keterangan: "Datang Lebih Awal",
      menitDatangAwal: 30,
      revision: 1,
    });
    expect(attendance.rows[0]).toMatchObject({
      tanggal: "2026-08-12",
      jam_masuk: "2026-08-12 06:30:00",
      status_absen: "Belum Pulang",
      sumber: "Scanner",
    });
    expect(log.rows[0]).toMatchObject({
      tanggal_kerja: "2026-08-12",
      jam_scan: "06:30:00",
      status_proses: "Berhasil",
    });
  });

  test("scan waktu ditolak hanya menulis LOG_SCAN", async () => {
    const result = await scanAt(jakarta("2026-08-12", "05:59"));

    expect(result).toMatchObject({ sukses: false, status: "Ditolak" });
    expect(await tableCount("log_scan")).toBe(1);
    expect(await tableCount("absensi_harian")).toBe(0);
    const log = await client.execute("SELECT * FROM log_scan LIMIT 1;");
    expect(log.rows[0]).toMatchObject({
      jenis_scan: "Masuk Ditolak - Terlalu Awal",
      status_proses: "Ditolak",
    });
  });

  test("identitas yang diketahui tetap dilog saat token ditolak", async () => {
    const result = await scanAt(jakarta("2026-08-12", "07:00"), {
      qrText: `${EMPLOYEE.id}|TOKEN-SALAH`,
    });

    expect(result.sukses).toBe(false);
    expect(await tableCount("log_scan")).toBe(1);
    expect(await tableCount("absensi_harian")).toBe(0);
    const log = await client.execute("SELECT * FROM log_scan LIMIT 1;");
    expect(log.rows[0]?.id_karyawan).toBe(EMPLOYEE.id);
  });

  test("status nonaktif tetap ditolak dan dicatat tanpa membuat absensi", async () => {
    await client.execute({
      sql: "UPDATE master_data SET status_aktif = 'Nonaktif' WHERE id_unik = ?;",
      args: [EMPLOYEE.id],
    });

    const result = await scanAt(jakarta("2026-08-12", "07:00"));
    expect(result).toMatchObject({ sukses: false, status: "Ditolak" });
    expect(result.catatanSistem).toBe("Karyawan berstatus nonaktif");
    expect(await tableCount("log_scan")).toBe(1);
    expect(await tableCount("absensi_harian")).toBe(0);
  });

  test("cooldown scanner ditolak sebelum menjadi multi-scan", async () => {
    await scanAt(jakarta("2026-08-12", "07:00"));
    const result = await scanAt("2026-08-12T07:00:30+07:00");
    const attendance = await client.execute(
      "SELECT jam_pulang FROM absensi_harian LIMIT 1;",
    );

    expect(result).toMatchObject({
      sukses: false,
      status: "Ditolak",
      jenisScan: "Scan Ditolak",
    });
    expect(result.catatanSistem).toContain("masa cooldown");
    expect(attendance.rows[0]?.jam_pulang).toBe("");
  });

  test("scan kedua dalam batas multi-scan tidak menjadi pulang", async () => {
    await scanAt(jakarta("2026-08-12", "07:00"));
    const result = await scanAt(jakarta("2026-08-12", "07:03"));
    const attendance = await client.execute(
      "SELECT jam_pulang, status_absen FROM absensi_harian LIMIT 1;",
    );

    expect(result).toMatchObject({
      sukses: false,
      status: "Ditolak",
      jenisScan: "Multi Scan Ditolak",
    });
    expect(attendance.rows[0]).toMatchObject({
      jam_pulang: "",
      status_absen: "Belum Pulang",
    });
    expect(await tableCount("log_scan")).toBe(2);
  });

  test("pulang normal memperbarui satu sesi dan menghitung menit kerja", async () => {
    await scanAt(jakarta("2026-08-12", "07:00"));
    const result = await scanAt(jakarta("2026-08-12", "15:00"));
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );

    expect(result).toMatchObject({
      sukses: true,
      jenisScan: "Pulang",
      keterangan: "Pulang Normal",
      jamKerja: 420,
      lembur: 0,
      jamKerjaKurang: 0,
    });
    expect(await tableCount("absensi_harian")).toBe(1);
    expect(attendance.rows[0]).toMatchObject({
      jam_pulang: "2026-08-12 15:00:00",
      status_absen: "Lengkap",
      jam_kerja: 420,
    });
  });

  test("pulang tanpa masuk membuat Perlu Verifikasi", async () => {
    const result = await scanAt(jakarta("2026-08-12", "15:30"));
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );

    expect(result).toMatchObject({
      sukses: true,
      status: "Perlu Verifikasi",
      jenisScan: "Pulang",
    });
    expect(attendance.rows[0]).toMatchObject({
      jam_masuk: "",
      jam_pulang: "2026-08-12 15:30:00",
      status_absen: "Perlu Verifikasi",
    });
  });

  test("shift malam sebelum dan setelah tengah malam memakai satu tanggal kerja", async () => {
    await client.execute({
      sql: "UPDATE master_data SET id_shift = 3 WHERE id_unik = ?;",
      args: [EMPLOYEE.id],
    });
    const masuk = await scanAt(jakarta("2026-08-12", "23:00"));
    const pulang = await scanAt(jakarta("2026-08-13", "07:00"));
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );

    expect(masuk.idSesi).toBe(pulang.idSesi);
    expect(attendance.rows[0]).toMatchObject({
      tanggal: "2026-08-12",
      jam_masuk: "2026-08-12 23:00:00",
      jam_pulang: "2026-08-13 07:00:00",
      status_absen: "Lengkap",
    });
  });

  test("shift fleksibel menerima satu masuk dan satu pulang tanpa keterlambatan reguler", async () => {
    await client.execute({
      sql: "UPDATE master_data SET id_shift = 4 WHERE id_unik = ?;",
      args: [EMPLOYEE.id],
    });

    const masuk = await scanAt(jakarta("2026-08-12", "13:00"));
    const pulang = await scanAt(jakarta("2026-08-12", "17:00"));
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );

    expect(masuk).toMatchObject({
      sukses: true,
      jenisScan: "Masuk",
      keterangan: "Fleksibel",
      menitTerlambat: 0,
    });
    expect(pulang).toMatchObject({
      sukses: true,
      jenisScan: "Pulang",
      keterangan: "Fleksibel",
      jamKerja: 240,
      lembur: 0,
      jamKerjaKurang: 0,
    });
    expect(attendance.rows[0]).toMatchObject({
      status_absen: "Lengkap",
      jam_kerja: 240,
    });
  });
});

describe("guard dan konsistensi integrasi Web", () => {
  test("geofence tetap menolak, melog, dan tidak membuat absensi", async () => {
    await client.batch(
      [
        `INSERT INTO setting_gex_system (key, value) VALUES ('geofence_enabled', 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        `INSERT INTO setting_gex_system (key, value) VALUES ('lat_kantor', '-6.2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        `INSERT INTO setting_gex_system (key, value) VALUES ('lng_kantor', '106.8')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      ],
      "write",
    );

    const result = await scanAt(jakarta("2026-08-12", "07:00"));
    expect(result.sukses).toBe(false);
    expect(result.catatanSistem).toBe("GPS Tidak Terdeteksi");
    expect(await tableCount("log_scan")).toBe(1);
    expect(await tableCount("absensi_harian")).toBe(0);
  });

  test("Koreksi Admin tidak ditimpa scanner", async () => {
    const first = await scanAt(jakarta("2026-08-12", "07:00"));
    await client.execute({
      sql: `UPDATE absensi_harian SET sumber = 'Koreksi Admin',
            keterangan = 'Koreksi manual' WHERE id_sesi = ?;`,
      args: [first.idSesi ?? ""],
    });

    const result = await scanAt(jakarta("2026-08-12", "15:00"));
    const attendance = await client.execute({
      sql: "SELECT * FROM absensi_harian WHERE id_sesi = ?;",
      args: [first.idSesi ?? ""],
    });

    expect(result).toMatchObject({ sukses: false, status: "Ditolak" });
    expect(attendance.rows[0]).toMatchObject({
      sumber: "Koreksi Admin",
      keterangan: "Koreksi manual",
      jam_pulang: "",
    });
    expect(await tableCount("log_scan")).toBe(2);
  });

  test("penugasan backup memakai shift efektif dan ID referensi", async () => {
    await insertEmployee({
      id: "EMP_ASAL",
      code: "KW_ASAL",
      token: "TOKEN-ASAL",
      name: "Karyawan Asal",
    });
    await client.execute({
      sql: `INSERT INTO backup_karyawan (
              id_backup, tanggal_tugas, id_karyawan_asal, nama_karyawan_asal,
              divisi_asal, id_shift_asal, id_karyawan_pengganti,
              nama_karyawan_pengganti, divisi_pengganti,
              id_shift_normal_pengganti, id_shift_backup, alasan_backup,
              status_tugas, kode_operator, waktu_input
            ) VALUES (
              'BKP-WEB-01', '2026-08-12', 'EMP_ASAL', 'Karyawan Asal',
              'Produksi', 1, ?, 'Karyawan Web', 'Produksi', 1, 2,
              'Pengganti tes', 'Aktif', 'OP_WEB', '2026-08-12 06:00:00'
            );`,
      args: [EMPLOYEE.id],
    });

    const result = await scanAt(jakarta("2026-08-12", "15:00"));
    const log = await client.execute("SELECT * FROM log_scan LIMIT 1;");
    const attendance = await client.execute(
      "SELECT * FROM absensi_harian LIMIT 1;",
    );

    expect(result).toMatchObject({
      sukses: true,
      shiftEfektif: 2,
      modeTugas: "PENGGANTI",
      idSesi: `BKP-WEB-01-PENGGANTI-${EMPLOYEE.id}`,
    });
    expect(log.rows[0]?.id_referensi).toBe("BKP-WEB-01");
    expect(attendance.rows[0]).toMatchObject({
      id_shift: 2,
      id_backup: "BKP-WEB-01",
      id_karyawan_asal: "EMP_ASAL",
    });
  });

  test("kegagalan ABSENSI_HARIAN menggulung balik LOG_SCAN dan revision", async () => {
    await client.execute(`
      CREATE TRIGGER test_fail_attendance
      BEFORE INSERT ON absensi_harian
      BEGIN
        SELECT RAISE(ABORT, 'simulasi attendance gagal');
      END;
    `);

    await expect(scanAt(jakarta("2026-08-12", "07:00"))).rejects.toThrow(
      "simulasi attendance gagal",
    );
    expect(await tableCount("absensi_harian")).toBe(0);
    expect(await tableCount("log_scan")).toBe(0);
    expect(await tableCount("sync_change_log")).toBe(0);
  });
});
