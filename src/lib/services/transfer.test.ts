import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-transfer-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { berkasTransfer, pengaturanTransfer, simpanPengaturanTransfer } =
  await import("./transfer");
const {
  BANK_BAWAAN,
  PESAN_DEBET_NONAKTIF,
  PESAN_FORMAT_GANDA,
  PESAN_FORMAT_NONAKTIF,
  PESAN_REKENING_GANDA,
  PESAN_STATUS_RUN,
  pesanBankGanda,
} = await import("@/lib/validations/transfer");
const { isValidDate } = await import("@/lib/validations/inventory");

// HRIS fase 12, langkah 5 §27.8. Padanan Rust:
// `transfer_cloud_pengaturan_dan_baris` (`transfer.rs`), data dan hasil sama.

const superadmin = {
  id: 1,
  username: "super",
  isSuperadmin: true,
  permissions: [],
} as unknown as OperatorUser;

type Hasil = Record<string, unknown>;
const angka = async (sql: string) =>
  Number(Object.values((await db.execute(sql)).rows[0] ?? {})[0] ?? -1);
const teks = async (sql: string) =>
  String(Object.values((await db.execute(sql)).rows[0] ?? {})[0] ?? "");
const galat = async (janji: Promise<unknown>) => {
  try {
    await janji;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("harus ditolak");
};
const simpan = (
  jenis: "bank" | "rekening" | "format",
  id: string | null,
  draft: Record<string, unknown>,
) => simpanPengaturanTransfer(db, superadmin, jenis, id, draft);
const berkas = (
  run: string,
  rekening: string,
  format: string | null,
  catat: boolean,
) =>
  berkasTransfer(db, superadmin, {
    run_id: run,
    id_rekening: rekening,
    id_format: format,
    catat,
  });

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, jabatan_status, id_shift) VALUES
       ('K1', 'EMP-1', 'Ana', 'Gudang', 'Staff', 1), ('K2', 'EMP-2', 'Budi', 'Gudang', 'Staff', 1),
       ('K3', 'EMP-3', 'Citra', 'Gudang', 'Staff', 1), ('K4', 'EMP-4', 'Dedi', 'Gudang', 'Staff', 1);`,
    "UPDATE master_data SET id_keluar = 'klr-1' WHERE id_unik = 'K4';",
    `INSERT INTO hr_profil (id_karyawan, bank, no_rekening, nama_rekening) VALUES
       ('K1', 'Bank BCA', '1111111111', 'Ana'), ('K2', 'bca', '2222222222', 'Budi'),
       ('K4', 'Bank Mandiri', '4444444444', 'Siti');`,
    `INSERT INTO payroll_runs (id, idempotency_key, period_start, period_end, status, created_by) VALUES
       ('run-ok', 'k-ok', '2026-10-01', '2026-10-31', 'APPROVED', 'hrd'),
       ('run-draf', 'k-draf', '2026-10-01', '2026-10-31', 'DRAFT', 'hrd');`,
    ...(
      [
        ["K1", "Ana", 5_000_000],
        ["K2", "Budi", 4_000_000],
        ["K3", "Citra", 3_000_000],
        ["K4", "Dedi", 2_000_000],
      ] as const
    ).map(([id, nama, net], i) => ({
      sql: `INSERT INTO payroll_items (id, payroll_run_id, id_karyawan, nama_karyawan, divisi, total_regular_hours, total_overtime_hours, total_overtime_index, rate_per_hour, basic_salary, overtime_salary, gross_salary, net_salary, breakdown_snapshot)
            VALUES (?1, 'run-ok', ?2, ?3, 'Gudang', 0, 0, 0, 0, ?4, 0, ?4, ?4, '{}');`,
      args: [`pi-${i}`, id, nama, net],
    })),
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("transfer Web (cermin transfer_cloud_pengaturan_dan_baris)", () => {
  test("Pengaturan, ganti nama bank, baris transfer, dan jejak unduhan", async () => {
    // Bacaan cukup sesi: hanya bank aktif, tanpa rekening dan format.
    const awal = await pengaturanTransfer(db, false, false);
    expect(awal.bank.length).toBe(BANK_BAWAAN.length);
    expect([awal.rekening.length, awal.format.length]).toEqual([0, 0]);
    expect(Array.isArray(awal.bank[0]?.alias)).toBe(true);

    // Ganti nama bank: nama lama masuk alias (Q-176).
    await simpan("bank", "bnk-014", {
      nama: "PT BCA",
      kode: "014",
      alias: ["Bank BCA", "Bank Central Asia"],
    });
    expect(
      JSON.parse(
        await teks("SELECT alias FROM app_bank WHERE id_bank = 'bnk-014';"),
      ),
    ).toEqual(["Bank BCA", "Bank Central Asia", "BCA"]);
    expect(
      await teks("SELECT diubah_oleh FROM app_bank WHERE id_bank = 'bnk-014';"),
    ).toBe("super");
    expect(
      await galat(simpan("bank", null, { nama: "Baru", alias: ["bca"] })),
    ).toBe(pesanBankGanda("PT BCA"));
    expect(await galat(simpan("bank", "bnk-x", { nama: "X" }))).toBe(
      "Bank tidak ditemukan.",
    );
    expect(
      await galat(
        simpanPengaturanTransfer(db, superadmin, "kartu" as never, null, {}),
      ),
    ).toBe("Jenis pengaturan tidak dikenal.");
    const kecil = (await simpan("bank", null, { nama: "Bank Kecil" })).id;
    expect(kecil.startsWith("bnk-")).toBe(true);
    expect(
      await angka("SELECT COUNT(*) FROM app_bank WHERE is_bawaan = 0;"),
    ).toBe(1);

    // Rekening debet: nomor dirapikan, ganda ditolak, bank nonaktif ditolak.
    const rek = (
      await simpan("rekening", null, {
        id_bank: "bnk-014",
        no_rekening: "880 011 2233",
        nama_rekening: "PT Contoh",
      })
    ).id;
    expect(await teks("SELECT no_rekening FROM app_bank_rekening;")).toBe(
      "8800112233",
    );
    expect(
      await galat(
        simpan("rekening", null, {
          id_bank: "bnk-014",
          no_rekening: "8800112233",
          nama_rekening: "PT Contoh",
        }),
      ),
    ).toBe(PESAN_REKENING_GANDA);
    const rekKecil = (
      await simpan("rekening", null, {
        id_bank: kecil,
        no_rekening: "12345",
        nama_rekening: "PT Contoh",
      })
    ).id;
    await simpan("bank", null, { nama: "Bank Mati" });
    await db.execute(
      "UPDATE app_bank SET is_aktif = 0 WHERE nama IN ('Bank Mati', 'Bank Kecil');",
    );
    const mati = await teks(
      "SELECT id_bank FROM app_bank WHERE nama = 'Bank Mati';",
    );
    expect(
      await galat(
        simpan("rekening", null, {
          id_bank: mati,
          no_rekening: "99999",
          nama_rekening: "PT",
        }),
      ),
    ).toBe("Bank sudah nonaktif.");

    // Format: nama unik, validasi kembar, bank sasaran wajib ada.
    const kolom = [
      { isian: "kode_bank", judul: "Kode" },
      { isian: "no_rekening", judul: "Rek" },
      { isian: "nominal", judul: "Nominal" },
    ];
    const format = {
      nama: "BCA sesama",
      id_bank: "bnk-014",
      jenis: "csv",
      pemisah: ",",
      cakupan: "sesama",
      kolom,
    };
    const fmt = (await simpan("format", null, format)).id;
    expect(await galat(simpan("format", null, format))).toBe(
      PESAN_FORMAT_GANDA,
    );
    await simpan("format", fmt, format);
    expect(
      await galat(simpan("format", null, { nama: "X", jenis: "pdf", kolom })),
    ).toBe("Jenis berkas tidak dikenal.");
    expect(
      await galat(
        simpan("format", null, {
          nama: "Y",
          id_bank: "bnk-x",
          jenis: "xlsx",
          kolom,
        }),
      ),
    ).toBe("Bank tidak ditemukan.");
    expect(
      JSON.parse(await teks("SELECT kolom FROM app_bank_format;")),
    ).toHaveLength(3);

    // Cakupan bacaan: atur = semua, unduh = yang aktif saja.
    const atur = await pengaturanTransfer(db, true, false);
    expect(atur.bank.length).toBe(BANK_BAWAAN.length + 2);
    expect(atur.rekening.length).toBe(2);
    expect(Array.isArray(atur.format[0]?.kolom)).toBe(true);
    const unduh = await pengaturanTransfer(db, false, true);
    expect(unduh.rekening.length).toBe(1);
    expect(unduh.format.length).toBe(1);

    // Berkas: status run, rekening debet, format.
    expect(await galat(berkas("run-draf", rek, null, false))).toBe(
      PESAN_STATUS_RUN,
    );
    expect(await galat(berkas("run-x", rek, null, false))).toBe(
      "Proses gaji tidak ditemukan.",
    );
    expect(await galat(berkas("run-ok", rekKecil, null, false))).toBe(
      PESAN_DEBET_NONAKTIF,
    );
    expect(await galat(berkas("run-ok", rek, "fmt-x", false))).toBe(
      PESAN_FORMAT_NONAKTIF,
    );
    expect(
      await galat(
        berkasTransfer(db, superadmin, {
          run_id: "run-ok",
          id_rekening: rek,
          lain: 1,
        }),
      ),
    ).toBe("Isian 'lain' tidak dikenal.");

    const hasil = await berkas("run-ok", rek, fmt, false);
    const s = hasil.susunan;
    const nama = (daftar: { nama_karyawan: string }[]) =>
      daftar.map((r) => r.nama_karyawan);
    expect(nama(s.baris)).toEqual(["Ana", "Budi"]);
    expect(nama(s.manual)).toEqual(["Citra"]);
    expect(nama(s.luar_cakupan)).toEqual(["Dedi"]);
    expect(s.luar_cakupan[0]?.tanda).toEqual([
      "nama_berbeda",
      "karyawan_keluar",
    ]);
    expect([s.ringkasan.total, s.ringkasan.total_run]).toEqual([
      9_000_000, 14_000_000,
    ]);
    expect(s.rekening_debet).toBe("8800112233");
    expect(isValidDate(s.tanggal_efektif)).toBe(true);
    expect((hasil.format as Hasil).nama).toBe("BCA sesama");
    expect(await angka("SELECT COUNT(*) FROM payroll_audit_logs;")).toBe(0);

    // Unduhan dicatat; run tidak berubah; riwayat = unduhan sebelumnya.
    const pertama = await berkas("run-ok", rek, fmt, true);
    expect(pertama.riwayat).toHaveLength(0);
    const log = (
      await db.execute(
        "SELECT action, old_status, new_status, performed_by, notes FROM payroll_audit_logs;",
      )
    ).rows[0] as Hasil;
    expect([
      log.action,
      log.old_status,
      log.new_status,
      log.performed_by,
    ]).toEqual(["TRANSFER_EXPORT", "APPROVED", "APPROVED", "super"]);
    // Teks catatan sama persis dengan Rust (kunci urut abjad).
    expect(log.notes).toBe(
      `{"format":"BCA sesama","id_format":"${fmt}","id_rekening":"${rek}","jumlah_baris":2,"rekening_debet":"8800112233","tanggal_efektif":"${pertama.susunan.tanggal_efektif}","total":9000000}`,
    );
    expect(
      await teks("SELECT status FROM payroll_runs WHERE id = 'run-ok';"),
    ).toBe("APPROVED");
    await db.execute(
      "UPDATE payroll_runs SET status = 'PAID' WHERE id = 'run-ok';",
    );
    const kedua = await berkas("run-ok", rek, null, true);
    expect(kedua.riwayat).toHaveLength(1);
    expect(kedua.susunan.baris).toHaveLength(3);

    // Kolom rusak di database: format tidak bisa dipakai.
    await db.execute("UPDATE app_bank_format SET kolom = 'rusak';");
    expect(
      (await pengaturanTransfer(db, true, false)).format[0]?.kolom,
    ).toBeNull();
    expect(await galat(berkas("run-ok", rek, fmt, false))).toBe(
      PESAN_FORMAT_NONAKTIF,
    );
  });
});
