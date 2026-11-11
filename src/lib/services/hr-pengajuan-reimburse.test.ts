import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-reimburse-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { computePayrollRecap } = await import("./payroll-recap");
const { catatPembayaranPayrollTx } = await import("./loan");
const {
  batalBayarReimburse,
  catatBayarReimburse,
  daftarPengajuan,
  periksaReimburseRun,
  putuskan,
  reimburseGaji,
  rincianPengajuan,
  ringkasanReimburse,
  simpanAturanCuti,
  simpanPengajuan,
} = await import("./hr-pengajuan");
const { PESAN_KLAIM_DIBAYAR, PESAN_NOMINAL } = await import(
  "@/lib/validations/hr-pengajuan"
);

// HRIS fase 4 (v39). Padanan Rust: `tests_alur::alur_fase4_reimburse`
// (`hr_pengajuan.rs`), data yang sama.

const aktor = (username: string, permissions: string[], id = 0): OperatorUser =>
  ({
    id,
    username,
    isSuperadmin: false,
    permissions,
  }) as unknown as OperatorUser;

const pengaju = aktor("ani", ["hr.request.submit"]);
const hrd = aktor("hrd", ["hr.request.submit", "hr.request.decide"]);
const keuangan = aktor("keu", ["reimburse.decide"]);
const klaim = (nominal: number) => ({
  id_karyawan: "K1",
  id_jenis: "jns-rmb-transport",
  tanggal_mulai: "2026-01-05",
  tanggal_selesai: "2026-01-05",
  alasan: "Taksi ke klien",
  nominal,
});

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO tbl_shift (id_shift, kode_shift, nama_shift, jam_masuk, jam_pulang,
       jam_kerja_normal_menit, istirahat_menit, batas_pulang_menit,
       buffer_shift_malam_menit, offset_generate_alfa, hari_kerja)
     VALUES (1, 1, 'Pagi', '07:00', '15:00', 480, 60, 240, 120, 180, '1,2,3,4,5');`,
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif, tanggal_daftar)
     VALUES ('K1', 'K1', 'Ani', 'Gudang', 1, 'Aktif', '2024-01-02');`,
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 4: reimbursement Web", () => {
  let id = "";

  test("klaim, nominal disetujui, dan daftar Keuangan", async () => {
    await expect(simpanPengajuan(db, pengaju, klaim(0))).rejects.toThrow(
      PESAN_NOMINAL,
    );
    await expect(
      simpanPengajuan(db, pengaju, {
        ...klaim(1000),
        tanggal_mulai: "2999-01-01",
        tanggal_selesai: "2999-01-01",
      }),
    ).rejects.toThrow("Tanggal biaya tidak boleh setelah hari ini.");
    id = (await simpanPengajuan(db, pengaju, klaim(100_000))).id_pengajuan;
    // Cuti di tanggal yang sama tidak bertumpuk dengan klaim.
    const idCuti = (
      await simpanPengajuan(db, pengaju, {
        id_karyawan: "K1",
        id_jenis: "jns-cuti-tahunan",
        tanggal_mulai: "2026-01-05",
        tanggal_selesai: "2026-01-05",
        alasan: "Mudik",
      })
    ).id_pengajuan;

    await expect(
      putuskan(db, hrd, {
        id_pengajuan: id,
        aksi: "Setujui",
        nominal_disetujui: 100_000,
      }),
    ).rejects.toThrow("Kamu tidak punya izin memutus jenis pengajuan ini.");
    await expect(
      putuskan(db, keuangan, {
        id_pengajuan: id,
        aksi: "Setujui",
        nominal_disetujui: 75_000,
      }),
    ).rejects.toThrow(
      "Alasan wajib diisi bila nominal disetujui lebih kecil dari yang diajukan.",
    );
    await putuskan(db, keuangan, {
      id_pengajuan: id,
      aksi: "Setujui",
      nominal_disetujui: 75_000,
      alasan: "Tarif wajar",
    });

    const d = await daftarPengajuan(db, {}, true);
    expect(d.pengajuan.length).toBe(1);
    expect(d.pengajuan[0]?.nominal_berlaku).toBe(75_000);
    expect(d.pengajuan[0]?.status_bayar).toBe("Belum dibayar");
    expect(d.mode_reimburse).toBe("terpisah");
    await expect(rincianPengajuan(db, idCuti, true)).rejects.toThrow(
      "Kamu hanya bisa melihat klaim reimbursement.",
    );
    expect((await rincianPengajuan(db, id, true)).keputusan.length).toBe(1);
  });

  test("mode gaji: rekap, PAID, dan jurnal beban reimbursement", async () => {
    expect((await reimburseGaji(db, "2026-01-31")).size).toBe(0);
    await simpanAturanCuti(db, {
      hr_cuti_periode: "ulang_tahun_kerja",
      hr_cuti_sisa: "hangus",
      hr_cuti_hak: 12,
      hr_cuti_syarat_bulan: 12,
      hr_cuti_prorata: 0,
      hr_cuti_bawa_maks: 6,
      hr_cuti_bawa_bulan: 3,
      hr_lembur_mode: "otomatis",
      hr_lembur_maks_harian: 4,
      hr_lembur_maks_mingguan: 18,
      hr_reimburse_bayar: "gaji",
    });
    expect((await reimburseGaji(db, "2026-01-04")).size).toBe(0);
    expect((await reimburseGaji(db, "2026-01-31")).get("K1")).toEqual([
      [id, 75_000],
    ]);
    const rekap = await computePayrollRecap(db, "2026-01-01", "2026-01-31");
    const baris = rekap.find((r) => r.id_karyawan === "K1");
    expect(baris?.est_reimburse).toBe(75_000);
    expect(JSON.parse(baris?.breakdown_snapshot ?? "{}").reimburse).toEqual([
      { id_pengajuan: id, nominal: 75_000 },
    ]);

    // Nominal di proses gaji harus sama dengan nominal berlaku.
    await periksaReimburseRun(db, "run-1", [[id, 75_000]]);
    await expect(
      periksaReimburseRun(db, "run-1", [[id, 70_000]]),
    ).rejects.toThrow("berubah");

    // Proses gaji PAID: jurnal `pay-<run>` mendebit Beban Reimbursement.
    await db.batch([
      `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by, created_at, updated_at)
       VALUES ('run-1', 'k-1', '2026-01-01', '2026-01-31', 'PAID', 'hrd', '2026-02-01', '2026-02-01');`,
      {
        sql: `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi, ptkp_status,
                total_regular_hours, total_overtime_hours, total_overtime_index, total_holiday_hours,
                total_holiday_overtime_index, rate_per_hour, basic_salary, overtime_salary, gross_salary,
                total_allowances, total_deductions, bpjs_employee_total, bpjs_company_total, pph21_amount,
                net_salary, breakdown_snapshot, created_at)
              VALUES ('run-1-K1', 'run-1', 'K1', 'Ani', 'Gudang', 'TK/0', 0, 0, 0, 0, 0, 0, 0, 0, 1000000,
                0, 0, 0, 0, 0, 1075000, ?, '2026-02-01');`,
        args: [
          JSON.stringify({
            reimburse: [{ id_pengajuan: id, nominal: 75_000 }],
          }),
        ],
      },
    ]);
    const tx = await db.transaction("write");
    try {
      await catatPembayaranPayrollTx(tx, "run-1", "akun-kas", "keu");
      await tx.commit();
    } finally {
      tx.close();
    }
    const jurnal = await db.execute(
      "SELECT id_akun, debit, kredit FROM keu_jurnal_baris WHERE id_jurnal = 'pay-run-1' ORDER BY urutan;",
    );
    expect(
      jurnal.rows.map((r) => [
        String(r.id_akun),
        Number(r.debit),
        Number(r.kredit),
      ]),
    ).toEqual([
      ["akun-beban-gaji", 1_000_000, 0],
      ["akun-beban-reimburse", 75_000, 0],
      ["akun-kas", 0, 1_075_000],
    ]);
    // Klaim sudah dibayar lewat gaji: tidak bisa dibayar terpisah.
    await expect(
      catatBayarReimburse(db, "keu", { id_karyawan: "K1", id_klaim: [id] }),
    ).rejects.toThrow("berstatus dibayar");
    await db.execute("UPDATE payroll_runs SET status = 'REJECTED';");
  });

  test("pembayaran terpisah dan pembatalannya", async () => {
    const bayar = await catatBayarReimburse(db, "keu", {
      id_karyawan: "K1",
      id_klaim: [id],
    });
    expect(bayar.total).toBe(75_000);
    expect((await reimburseGaji(db, "2026-01-31")).size).toBe(0);
    await expect(
      putuskan(db, keuangan, {
        id_pengajuan: id,
        aksi: "Batal",
        alasan: "Salah",
      }),
    ).rejects.toThrow(PESAN_KLAIM_DIBAYAR);
    await batalBayarReimburse(db, "keu", {
      id_bayar: bayar.id_bayar,
      alasan: "Salah karyawan",
    });
    await expect(
      batalBayarReimburse(db, "keu", { id_bayar: bayar.id_bayar, alasan: "x" }),
    ).rejects.toThrow("Pembayaran ini sudah dibatalkan.");
    const r = await ringkasanReimburse(db, {
      dari: "2000-01-01",
      sampai: "2999-12-31",
    });
    expect(r.belum_dibayar.length).toBe(1);
    expect(r.riwayat[0]?.batal?.id_bayar).toBe(`batal-${bayar.id_bayar}`);
  });
});
