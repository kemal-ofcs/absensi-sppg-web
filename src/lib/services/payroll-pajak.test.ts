import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-payroll-pajak-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { computePayrollRecap } = await import("./payroll-recap");
const { calculateEmployeePay } = await import("./payroll-calculator");
const P = await import("@/lib/validations/pajak");
const { TARIF_PAJAK_BAWAAN } = await import("@/lib/validations/tarif-bawaan");

// Data dan harapan yang SAMA dengan `tests_pajak` di `payroll/commands.rs`
// (§29.9 langkah 3), dijalankan pada skema Web.

const run = (id: string, mulai: string, akhir: string, status: string) => ({
  sql: `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by)
        VALUES (?1, ?1, ?2, ?3, ?4, 'uji');`,
  args: [id, mulai, akhir, status],
});

const item = (
  idRun: string,
  karyawan: string,
  gross: number,
  pph: number,
  snapshot: unknown,
) => ({
  sql: `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
          total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
          basic_salary, overtime_salary, gross_salary, pph21_amount, net_salary, breakdown_snapshot)
        VALUES (?1 || '-' || ?2, ?1, ?2, 'Uji', 'Umum', 0, 0, 0, 0, ?3, 0, ?3, ?4, ?3, ?5);`,
  args: [idRun, karyawan, gross, pph, JSON.stringify(snapshot)],
});

const snapshotBaru = (bruto: number, bpjs: unknown) => ({
  pajak: { bruto_pajak: bruto, status: "tetap" },
  bpjs_masa: { dasar_run: bruto },
  bpjs,
});

const JP_EMP = [
  {
    id: "bpjs_jp_emp",
    component_code: "JP_EMP",
    component_name: "JP",
    rate_percentage: 1,
    wage_cap: 11_086_300,
    effective_date: "2026-03-01",
  },
];

async function pembanding(karyawan: string, periodStart: string) {
  const hasil = await db.execute({
    sql: P.RUN_TAHUN_SQL,
    args: [periodStart],
  });
  return hasil.rows
    .filter((r) => String(r.id_karyawan) === karyawan)
    .map((r) => ({
      masa: String(r.masa),
      gross_salary: Number(r.gross_salary),
      pph21_amount: Number(r.pph21_amount),
      salary_type: String(r.salary_type),
      breakdown_snapshot: String(r.breakdown_snapshot),
    }));
}

/** Cermin `bayar` di tes Rust: gaji per jam `gross` = tarif × 160 jam. */
function bayar(
  gross: number,
  [periodStart, periodEnd]: [string, string],
  ptkpAwalTahun: string,
  keluarPada: string | null,
  ringkas: ReturnType<typeof P.ringkasPembanding>,
  bpjsRules: typeof JP_EMP,
) {
  return calculateEmployeePay(
    {
      idKaryawan: "K1",
      salaryType: "HOURLY",
      ratePerHour: gross / 160,
      dailyRate: 0,
      daysPresent: 20,
      regularMinutes: 9_600,
      overtimeMinutes: 0,
      holidayMinutes: 0,
      pajak: {
        periodStart,
        periodEnd,
        jenisPersonil: "Pegawai",
        ptkpAwalTahun,
        keluarPada,
        pembanding: ringkas,
      },
    },
    {
      overtimeTiers: [],
      holidayTiers: [],
      components: [],
      taxRules: [...TARIF_PAJAK_BAWAAN],
      bpjsRules,
    },
  );
}

beforeAll(async () => {
  await ensureDbInitialized();
  const jp = [{ code: "JP_EMP", nominal: 80_000 }];
  const jht = [{ code: "JHT_EMP", nominal: 100_000 }];
  const desember = Array.from({ length: 11 }, (_, i) => {
    const bulan = String(i + 1).padStart(2, "0");
    return [
      run(`D${bulan}`, `2026-${bulan}-01`, `2026-${bulan}-28`, "PAID"),
      item(
        `D${bulan}`,
        "K2",
        10_000_000,
        200_000,
        i === 0 ? { bpjs: jht } : snapshotBaru(10_000_000, jht),
      ),
    ];
  }).flat();
  await db.batch(
    [
      run("R1", "2026-01-01", "2026-01-15", "DRAFT"),
      item("R1", "K1", 8_000_000, 120_000, snapshotBaru(8_000_000, jp)),
      run("RX", "2026-01-01", "2026-01-15", "REJECTED"),
      item("RX", "K1", 8_000_000, 999_999, snapshotBaru(8_000_000, jp)),
      run("R0", "2025-12-01", "2025-12-31", "PAID"),
      item("R0", "K1", 8_000_000, 120_000, snapshotBaru(8_000_000, jp)),
      run("RF", "2026-02-01", "2026-02-28", "DRAFT"),
      item("RF", "K1", 8_000_000, 120_000, snapshotBaru(8_000_000, jp)),
      ...desember,
      `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif, jenis_personil, id_keluar, tanggal_selesai_aktif) VALUES
         ('K1', 'E1', 'Dua Run', 'Umum', 1, 'Aktif', 'Pegawai', NULL, NULL),
         ('K3', 'E3', 'Keluar', 'Umum', 1, 'Nonaktif', 'Kontrak', 'klr-1', '2026-08-20'),
         ('K4', 'E4', 'Baru', 'Umum', 1, 'Aktif', NULL, NULL, NULL),
         ('K5', 'E5', 'Selesai', 'Umum', 1, 'Aktif', 'Harian', NULL, '2026-08-20');`,
      `INSERT INTO salary_configs (id, id_karyawan, rate_per_hour, ptkp_status, effective_date, created_by) VALUES
         ('s0', 'K1', 0, 'TK/0', '2025-01-01', 'uji'),
         ('s1', 'K3', 1, 'K/1', '2025-06-01', 'uji'),
         ('s2', 'K3', 1, 'K/2', '2026-05-01', 'uji'),
         ('s3', 'K4', 1, 'TK/1', '2026-03-01', 'uji'),
         ('s4', 'K4', 1, 'K/0', '2026-07-01', 'uji');`,
    ],
    "write",
  );
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("PPh 21 dan BPJS per masa di jalur Web (cermin tests_pajak)", () => {
  test("dua run sebulan; REJECTED, tahun lalu, dan masa sesudahnya diabaikan", async () => {
    const items = await pembanding("K1", "2026-01-16");
    expect(items.length).toBe(1);
    const ringkas = P.ringkasPembanding(items, "2026-01", P.STATUS_TETAP);
    expect([ringkas.bruto_masa, ringkas.pph_masa, ringkas.run_masa]).toEqual([
      8_000_000, 120_000, 1,
    ]);
    const pay = bayar(
      8_000_000,
      ["2026-01-16", "2026-01-31"],
      "TK/0",
      null,
      ringkas,
      JP_EMP,
    );
    expect(pay.bpjsEmployee).toBe(30_863);
    expect(pay.pph21).toBe(1_000_000);
    expect([pay.pajak.bruto_masa, pay.pajak.tarif]).toEqual([16_000_000, 700]);
    expect(pay.net).toBe(8_000_000 - 30_863 - 1_000_000);
    expect(pay.pajak.tanda).toEqual([]);
  });

  test("masa Desember menghitung ulang setahun termasuk run lama", async () => {
    const ringkas = P.ringkasPembanding(
      await pembanding("K2", "2026-12-01"),
      "2026-12",
      P.STATUS_TETAP,
    );
    expect([ringkas.bruto_tahun, ringkas.masa_berbruto_lain]).toEqual([
      110_000_000, 11,
    ]);
    const p = bayar(
      10_000_000,
      ["2026-12-01", "2026-12-31"],
      "K/0",
      null,
      ringkas,
      [],
    ).pajak;
    expect(p.metode).toBe(P.METODE_PASAL_17_TERAKHIR);
    expect([p.biaya_jabatan, p.iuran_pensiun, p.pkp]).toEqual([
      6_000_000, 1_100_000, 54_400_000,
    ]);
    expect([p.pph_setahun, p.pph]).toEqual([2_720_000, 520_000]);
    expect(p.tanda).toEqual(["rumus_lama"]);
  });

  test("kolom konteks pajak dan karyawan keluar", async () => {
    const baca = async (id: string) => {
      const hasil = await db.execute({
        sql: `SELECT ${P.KOLOM_PAJAK_SQL} FROM master_data md WHERE md.id_unik = ?3;`,
        args: ["2026-08-01", "2026-08-31", id],
      });
      const r = hasil.rows[0];
      return [r?.jenis_personil, r?.keluar_pada, r?.ptkp_awal_tahun];
    };
    expect(await baca("K3")).toEqual(["Kontrak", "2026-08-20", "K/1"]);
    expect(await baca("K4")).toEqual([null, null, "TK/1"]);
    expect(await baca("K5")).toEqual(["Harian", null, "TK/0"]);

    const kosong = { ...P.PEMBANDING_KOSONG, bpjs_masa: {} };
    const agustus = bayar(
      17_500_000,
      ["2026-08-01", "2026-08-31"],
      "K/1",
      "2026-08-20",
      kosong,
      [],
    );
    expect(agustus.pajak.metode).toBe(P.METODE_PASAL_17_TERAKHIR);
    expect(agustus.pajak.ptkp).toBe(63_000_000);
    const juli = bayar(
      17_500_000,
      ["2026-07-01", "2026-07-31"],
      "K/1",
      "2026-08-20",
      kosong,
      [],
    );
    expect(juli.pajak.metode).toBe(P.METODE_TER_BULANAN);
  });

  test("computePayrollRecap memakai run pembanding dan menulis kunci pajak", async () => {
    // Tunjangan tetap 8.000.000 sebagai seluruh bruto; BPJS hanya JP_EMP.
    await db.batch(
      [
        "DELETE FROM bpjs_rules WHERE component_code <> 'JP_EMP';",
        `INSERT INTO payroll_components (id, name, category, calc_type, default_value, applies_to, is_active, dasar_bpjs)
         VALUES ('cmp-tetap', 'Tunjangan Tetap', 'ALLOWANCE', 'FIXED', 8000000, 'K1', 1, 1);`,
      ],
      "write",
    );
    const rekap = await computePayrollRecap(db, "2026-01-16", "2026-01-31");
    const baris = rekap.find((r) => r.id_karyawan === "K1");
    expect(baris?.est_gross_salary).toBe(8_000_000);
    expect(baris?.est_bpjs_employee).toBe(30_863);
    expect(baris?.est_pph21).toBe(1_000_000);
    expect(baris?.est_net_salary).toBe(8_000_000 - 30_863 - 1_000_000);
    expect(baris?.pajak.tanda).toEqual(["komponen_per_run"]);
    const snapshot = JSON.parse(baris?.breakdown_snapshot ?? "{}");
    expect(snapshot.pajak.bruto_masa).toBe(16_000_000);
    expect(snapshot.bpjs_masa).toEqual({
      dasar_run: 8_000_000,
      dasar_masa: 16_000_000,
      tanda: [],
    });
    expect(snapshot.tax.rate_percentage).toBe(7);
  });
});
