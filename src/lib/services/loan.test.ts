import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const {
  catatPembayaranPayrollTx,
  decideLoan,
  deferLoan,
  listLoans,
  payOffLoan,
  pinjamanAktif,
  saveLoan,
  undeferLoan,
} = await import("@/lib/services/loan");
const { trialBalance } = await import("@/lib/services/accounting");
const { computePayrollRecap } = await import("@/lib/services/payroll-recap");

// Berkas sungguhan, satu klien per berkas (pola `inventory.test.ts`).
let client: Client;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), "kos-loan-web-"));
  client = createClient({ url: `file:${join(testDirectory, "test.db")}` });
  await initDatabaseSchema(client);
  await client.batch(
    [
      `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
       VALUES ('K-01', 'K-01', 'Budi', 'TU', 1, 'Pegawai', 'Aktif');`,
      // Tunjangan tetap memberi gaji bruto tanpa perlu data absensi.
      `INSERT INTO payroll_components (id, name, category, calc_type, default_value, applies_to, is_active)
       VALUES ('tunj-tetap', 'Tunjangan Tetap', 'ALLOWANCE', 'FIXED', 5000000, 'ALL', 1);`,
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

async function saldo(akun: string): Promise<number> {
  const neraca = await trialBalance(client, "2099-12-31");
  expect(neraca.total_debit).toBe(neraca.total_kredit);
  const baris = neraca.items.find((item) => item.id_akun === akun);
  return baris ? baris.debit - baris.kredit : 0;
}

// Cermin `siklus_kasbon_dan_pembayaran_gaji` di `desktop/loan.rs`, ditambah
// rekap payroll Web yang memotong cicilannya.
describe("kasbon Web terhadap skema cloud asli", () => {
  test("ajukan, cair, potong gaji, bayar, tunda, lunas", async () => {
    // Regresi: tanpa kasbon, rekap tidak memotong apa pun.
    const [sebelum] = await computePayrollRecap(
      client,
      "2026-02-01",
      "2026-02-28",
    );
    expect(sebelum?.est_kasbon).toBe(0);
    expect(JSON.parse(String(sebelum?.breakdown_snapshot)).kasbon).toEqual([]);

    const { id_pinjaman: id } = await saveLoan(client, "bendahara", {
      id_karyawan: "K-01",
      pokok: 1_000_000,
      cicilan: 400_000,
      mulai_potong: "2026-01",
    });
    await expect(
      decideLoan(client, "kepala", id, "setujui", "akun-beban-gaji"),
    ).rejects.toThrow("Akun pembayaran harus akun aset yang aktif.");
    await decideLoan(client, "kepala", id, "setujui", "akun-bank");
    expect(await saldo("akun-piutang-karyawan")).toBe(1_000_000);
    expect(await saldo("akun-bank")).toBe(-1_000_000);

    // Rekap memotong cicilan TERAKHIR dan mencatatnya di rincian slip.
    const [baris] = await computePayrollRecap(
      client,
      "2026-02-01",
      "2026-02-28",
    );
    expect(baris?.est_kasbon).toBe(400_000);
    // Kasbon hanya menggeser potongan dan gaji bersih; gaji kotor, pajak,
    // dan BPJS tidak berubah sedikit pun.
    expect(baris?.est_gross_salary).toBe(sebelum?.est_gross_salary);
    expect(baris?.est_pph21).toBe(sebelum?.est_pph21);
    expect(baris?.est_bpjs_employee).toBe(sebelum?.est_bpjs_employee);
    expect(baris?.bpjs_company_total).toBe(sebelum?.bpjs_company_total);
    expect(baris?.est_total_deduction).toBe(
      (sebelum?.est_total_deduction ?? 0) + 400_000,
    );
    expect(baris?.est_net_salary).toBe(
      (sebelum?.est_net_salary ?? 0) - 400_000,
    );
    const breakdown = JSON.parse(String(baris?.breakdown_snapshot));
    expect(breakdown.kasbon).toEqual([
      { id_pinjaman: id, jumlah: 400_000, sebagian: false },
    ]);
    expect(
      breakdown.components.some(
        (item: { calc_type: string }) => item.calc_type === "KASBON",
      ),
    ).toBe(true);

    await client.batch(
      [
        {
          sql: `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status,
                  total_gross_payout, total_net_payout, total_employees, created_by, created_at, updated_at)
                VALUES ('PR-1', 'k1', '2026-02-01', '2026-02-28', 'DRAFT', ?, ?, 1, 'a', 'x', 'x');`,
          args: [baris?.est_gross_salary ?? 0, baris?.est_net_salary ?? 0],
        },
        {
          sql: `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
                  total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
                  basic_salary, overtime_salary, gross_salary, total_allowances, total_deductions,
                  bpjs_employee_total, bpjs_company_total, pph21_amount, net_salary,
                  breakdown_snapshot, created_at)
                VALUES ('PR-1-K-01', 'PR-1', 'K-01', 'Budi', 'TU', 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'x');`,
          args: [
            baris?.est_gross_salary ?? 0,
            baris?.est_total_allowance ?? 0,
            baris?.est_total_deduction ?? 0,
            baris?.est_bpjs_employee ?? 0,
            baris?.bpjs_company_total ?? 0,
            baris?.est_pph21 ?? 0,
            baris?.est_net_salary ?? 0,
            baris?.breakdown_snapshot ?? "{}",
          ],
        },
      ],
      "write",
    );

    // Draf yang belum dibayar mengurangi sisa efektif.
    await expect(
      payOffLoan(client, "bendahara", id, 700_000, null),
    ).rejects.toThrow("Jumlah pelunasan melebihi sisa pinjaman Rp600.000.");
    // Jatah Februari sudah habis oleh proses gaji Februari; Maret penuh lagi.
    expect((await pinjamanAktif(client, "2026-02")).size).toBe(0);
    const maret = (await pinjamanAktif(client, "2026-03")).get("K-01")?.[0];
    expect(maret?.sisa_efektif).toBe(600_000);
    expect(maret?.cicilan).toBe(400_000);

    const tx = await client.transaction("write");
    await tx.execute(
      "UPDATE payroll_runs SET status = 'PAID' WHERE id = 'PR-1';",
    );
    await catatPembayaranPayrollTx(tx, "PR-1", "akun-kas", "kepala");
    await catatPembayaranPayrollTx(tx, "PR-1", "akun-kas", "kepala");
    await tx.commit();
    tx.close();

    expect(await saldo("akun-piutang-karyawan")).toBe(600_000);
    expect(await saldo("akun-beban-gaji")).toBe(baris?.est_gross_salary ?? 0);
    expect(await saldo("akun-kas")).toBe(-(baris?.est_net_salary ?? 0));
    const { items } = await listLoans(client);
    expect(items[0]?.sisa).toBe(600_000);
    expect(items[0]?.potongan_tertunda).toBe(0);

    await expect(
      decideLoan(client, "kepala", id, "batalkan", null),
    ).rejects.toThrow("Pinjaman yang sudah diangsur tidak bisa dibatalkan.");

    await deferLoan(client, "bendahara", id, "2026-03", "Sakit");
    expect((await pinjamanAktif(client, "2026-03")).size).toBe(0);
    await undeferLoan(client, `tunda-${id}-2026-03`);
    expect((await pinjamanAktif(client, "2026-03")).size).toBe(1);

    await payOffLoan(client, "bendahara", id, 600_000, null);
    expect(await saldo("akun-piutang-karyawan")).toBe(0);
    expect((await pinjamanAktif(client, "2026-04")).size).toBe(0);
  });

  // Cermin `jatah_cicilan_per_bulan_lintas_proses_gaji` di `desktop/loan.rs`.
  test("cicilan adalah jatah per bulan lintas proses gaji", async () => {
    await client.execute(
      `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, jenis_personil, status_aktif)
       VALUES ('K-03', 'K-03', 'Dewi', 'Gudang', 1, 'Pegawai', 'Aktif');`,
    );
    const { id_pinjaman: id } = await saveLoan(client, "bendahara", {
      id_karyawan: "K-03",
      pokok: 2_000_000,
      cicilan: 500_000,
      mulai_potong: "2026-10",
    });
    await decideLoan(client, "kepala", id, "setujui", null);
    const cicilan = async (bulan: string) =>
      (await pinjamanAktif(client, bulan)).get("K-03")?.[0]?.cicilan;
    const proses = (idRun: string, mulai: string, jumlah: number) =>
      client.batch(
        [
          {
            sql: `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status,
                    total_gross_payout, total_net_payout, total_employees, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'DRAFT', 0, 0, 1, 'a', 'x', 'x');`,
            args: [idRun, idRun, mulai, mulai],
          },
          {
            sql: `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi,
                    total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour,
                    basic_salary, overtime_salary, gross_salary, total_allowances, total_deductions,
                    bpjs_employee_total, bpjs_company_total, pph21_amount, net_salary,
                    breakdown_snapshot, created_at)
                  VALUES (?, ?, 'K-03', 'Dewi', 'Gudang', 0, 0, 0, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, ?, 'x');`,
            args: [
              `${idRun}-K-03`,
              idRun,
              jumlah,
              JSON.stringify({ kasbon: [{ id_pinjaman: id, jumlah }] }),
            ],
          },
        ],
        "write",
      );

    expect(await cicilan("2026-10")).toBe(500_000);
    // Minggu pertama gaji kurang: baru terpotong 300.000.
    await proses("PR-W1", "2026-10-01", 300_000);
    expect(await cicilan("2026-10")).toBe(200_000);
    await proses("PR-W2", "2026-10-08", 200_000);
    expect(await cicilan("2026-10")).toBeUndefined();
    expect(await cicilan("2026-11")).toBe(500_000);

    // Proses yang ditolak mengembalikan jatahnya.
    await client.execute(
      "UPDATE payroll_runs SET status = 'REJECTED' WHERE id = 'PR-W2';",
    );
    expect(await cicilan("2026-10")).toBe(200_000);
  });
});
