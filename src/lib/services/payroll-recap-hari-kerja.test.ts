import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const { computePayrollRecap } = await import("@/lib/services/payroll-recap");

// Berkas sungguhan, satu klien per berkas (pola `loan.test.ts`).
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-payroll-hari-kerja-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
  const absen = (tanggal: string, sesi: string) =>
    `INSERT INTO absensi_harian (tanggal, id_karyawan, nama, kelas_divisi, jam_masuk, jam_pulang,
       status_kehadiran, status_absen, sumber, update_terakhir, jam_kerja, lembur,
       id_shift, bulan, tahun, id_sesi, mode_tugas)
     VALUES ('${tanggal}', 'K-01', 'Budi', 'TU', '07:00', '16:00', 'Hadir', 'Tepat Waktu',
       'Scanner', 'x', 480, 60, 1, 'Oktober', 2026, '${sesi}', 'NORMAL');`;
  await client.batch(
    [
      `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
         jam_kerja_normal_menit, hari_kerja)
       VALUES (1, 1, 'Kantor', '07:00', '15:00', 480, '1,2,3,4,5');`,
      `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
       VALUES ('K-01', 'K-01', 'Budi', 'TU', 1, 'Pegawai', 'Aktif');`,
      `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, effective_date, created_by)
       VALUES ('sc-1', 'K-01', 10000, '2026-01-01', 'uji');`,
      // Jumat hari kerja, Sabtu di luar hari kerja shift.
      absen("2026-10-16", "S-JUMAT"),
      absen("2026-10-17", "S-SABTU"),
    ],
    "write",
  );
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

describe("rekap gaji dan libur mingguan shift", () => {
  test("jam di luar hari kerja shift masuk jam hari libur", async () => {
    const [baris] = await computePayrollRecap(
      client,
      "2026-10-01",
      "2026-10-31",
    );
    // Jumat: 8 jam reguler + 1 jam lembur. Sabtu: 9 jam seluruhnya hari libur.
    expect(baris?.total_regular_hours).toBe(8);
    expect(baris?.total_overtime_hours).toBe(1);
    expect(baris?.total_holiday_hours).toBe(9);
    // Jenjang HARI_LIBUR bawaan: 8 jam x2, jam ke-9 x3.
    expect(baris?.total_holiday_overtime_index).toBe(19);
  });

  test("tanpa jenjang HARI_LIBUR aktif dibayar seperti hari biasa", async () => {
    await client.execute(
      "UPDATE overtime_tier_rules SET is_active = 0 WHERE rule_type = 'HARI_LIBUR';",
    );
    try {
      const [baris] = await computePayrollRecap(
        client,
        "2026-10-01",
        "2026-10-31",
      );
      expect(baris?.total_regular_hours).toBe(16);
      expect(baris?.total_overtime_hours).toBe(2);
      expect(baris?.total_holiday_hours).toBe(0);
    } finally {
      await client.execute(
        "UPDATE overtime_tier_rules SET is_active = 1 WHERE rule_type = 'HARI_LIBUR';",
      );
    }
  });

  test("shift tujuh hari tidak punya libur mingguan", async () => {
    await client.execute(
      "UPDATE tbl_shift SET hari_kerja = '1,2,3,4,5,6,7' WHERE id_shift = 1;",
    );
    const [baris] = await computePayrollRecap(
      client,
      "2026-10-01",
      "2026-10-31",
    );
    expect(baris?.total_regular_hours).toBe(16);
    expect(baris?.total_holiday_hours).toBe(0);
  });
});
