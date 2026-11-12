import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorUser } from "@/lib/auth/operator-user";

mock.module("server-only", () => ({}));

const testDirectory = mkdtempSync(join(tmpdir(), "kos-hr-pelatihan-"));
process.env.TURSO_DATABASE_URL = `file:${join(testDirectory, "test.db")}`;

const { db, ensureDbInitialized } = await import("@/lib/db");
const { dokumen, hapusDokumen } = await import("./hris");
const {
  berkasSertifikat,
  daftarPelatihan,
  rincianPelatihan,
  riwayatPelatihan,
  simpanPelatihan,
  simpanPeserta,
  simpanSertifikat,
} = await import("./hr-pelatihan");
const {
  JENIS_SERTIFIKAT,
  PESAN_PELATIHAN_BATAL,
  PESAN_PESERTA_BERSERTIFIKAT,
  PESAN_SERTIFIKAT_NONAKTIF,
} = await import("@/lib/validations/hr-pelatihan");

// HRIS fase 7 (v42). Padanan Rust: `pelatihan_cloud_peserta_dan_sertifikat`
// (`hr_pelatihan.rs`).

const hrd = {
  id: 900,
  username: "hrd",
  isSuperadmin: false,
  permissions: ["hr.training.manage"],
} as unknown as OperatorUser;

const angka = async (sql: string) =>
  Number((await db.execute(sql)).rows[0]?.n ?? -1);
const galat = async (janji: Promise<unknown>) => {
  try {
    await janji;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("harus ditolak");
};

beforeAll(async () => {
  await ensureDbInitialized();
  await db.batch([
    `INSERT INTO master_data (id_unik, kode_karyawan, nama, divisi, id_shift, status_aktif) VALUES
       ('K1', 'E1', 'Ani', 'Gudang', 1, 'Aktif'), ('K2', 'E2', 'Budi', 'Gudang', 1, 'Nonaktif');`,
    "INSERT INTO hr_dokumen (id_dokumen, id_karyawan, id_jenis, dicatat_oleh) VALUES ('hd-ktp', 'K1', 'dok-ktp', 'hrd');",
    "INSERT INTO hr_dokumen_berkas (id_berkas, id_dokumen, urutan, mime_type, data_base64) VALUES ('hb-ktp', 'hd-ktp', 1, 'application/pdf', 'JVBERi0=');",
  ]);
});

afterAll(() => {
  try {
    db.close();
    rmSync(testDirectory, { recursive: true, force: true });
  } catch {}
});

describe("HRIS fase 7: pelatihan Web", () => {
  test("peserta, sertifikat lewat inti dokumen, dan batal", async () => {
    const id = (
      await simpanPelatihan(db, hrd, {
        nama: "K3 Dasar",
        tanggal_mulai: "2026-01-10",
        tanggal_selesai: "2026-01-11",
        biaya: 3_000_000,
      })
    ).id_pelatihan;
    expect((await daftarPelatihan(db, 2026)).pelatihan[0]?.status).toBe(
      "Selesai",
    );
    const peserta = (aksi: string, isi: Record<string, unknown>) => ({
      id_pelatihan: id,
      aksi,
      ...isi,
    });

    await simpanPeserta(
      db,
      hrd,
      peserta("tambah", { id_karyawan: ["K1", "K1"] }),
    );
    await simpanPeserta(db, hrd, peserta("tambah", { id_karyawan: ["K1"] }));
    expect(await angka("SELECT COUNT(*) AS n FROM hr_pelatihan_peserta;")).toBe(
      1,
    );
    expect(
      await galat(
        simpanPeserta(db, hrd, peserta("tambah", { id_karyawan: ["K2"] })),
      ),
    ).toBe("Budi tidak aktif dan tidak bisa menjadi peserta.");
    await simpanPeserta(
      db,
      hrd,
      peserta("hasil", { id_karyawan: "K1", hasil: "Lulus" }),
    );

    const pdf = btoa("%PDF-1.7 sertifikat");
    const idDok = (
      (await simpanSertifikat(
        db,
        hrd,
        peserta("simpan", {
          id_karyawan: "K1",
          nomor: "K3/001",
          tanggal_terbit: "2026-01-11",
          tanggal_kedaluwarsa: "2029-01-11",
          berkas: [
            {
              nama_berkas: "sertifikat.pdf",
              mime_type: "application/pdf",
              data_base64: pdf,
            },
          ],
        }),
      )) as { id_dokumen?: string }
    ).id_dokumen as string;
    const tampil = (
      (await dokumen(db, "K1")).dokumen as Record<string, unknown>[]
    ).find((d) => d.id_dokumen === idDok);
    expect([tampil?.id_jenis, tampil?.catatan]).toEqual([
      JENIS_SERTIFIKAT,
      "K3 Dasar",
    ]);
    const idBerkas = String(
      (tampil?.berkas as { id_berkas: string }[])[0]?.id_berkas,
    );
    expect((await berkasSertifikat(db, idBerkas)).data_base64).toBe(pdf);
    expect(await galat(berkasSertifikat(db, "hb-ktp"))).toBe(
      "Berkas tidak ditemukan.",
    );
    const rinci = await rincianPelatihan(db, id);
    expect(rinci.peserta[0]?.berkas.length).toBe(1);
    expect(
      (rinci.peserta[0] as Record<string, unknown> | undefined)
        ?.tanggal_kedaluwarsa,
    ).toBe("2029-01-11");

    const lepas = peserta("lepas", { id_karyawan: "K1" });
    expect(await galat(simpanPeserta(db, hrd, lepas))).toBe(
      PESAN_PESERTA_BERSERTIFIKAT,
    );
    await hapusDokumen(db, idDok);
    expect(
      await angka(
        "SELECT COUNT(*) AS n FROM hr_pelatihan_peserta WHERE id_dokumen IS NOT NULL;",
      ),
    ).toBe(0);
    expect(
      await angka(
        "SELECT COUNT(*) AS n FROM hr_dokumen_berkas WHERE id_dokumen <> 'hd-ktp';",
      ),
    ).toBe(0);

    await db.execute(
      "UPDATE hr_dokumen_jenis SET is_aktif = 0 WHERE id_jenis = 'dok-sertifikat';",
    );
    expect(
      await galat(
        simpanSertifikat(db, hrd, peserta("simpan", { id_karyawan: "K1" })),
      ),
    ).toBe(PESAN_SERTIFIKAT_NONAKTIF);
    expect((await riwayatPelatihan(db, "K1")).riwayat.length).toBe(1);
    await simpanPeserta(db, hrd, lepas);
    await simpanPeserta(db, hrd, peserta("tambah", { id_karyawan: ["K1"] }));

    await simpanPelatihan(db, hrd, {
      id_pelatihan: id,
      aksi: "batal",
      alasan: "Ditunda",
    });
    expect((await riwayatPelatihan(db, "K1")).riwayat.length).toBe(0);
    expect(await galat(simpanPeserta(db, hrd, lepas))).toBe(
      PESAN_PELATIHAN_BATAL,
    );
    expect(
      await galat(
        simpanPelatihan(db, hrd, {
          id_pelatihan: id,
          aksi: "batal",
          alasan: "x",
        }),
      ),
    ).toBe(PESAN_PELATIHAN_BATAL);
    expect((await daftarPelatihan(db, 2026)).pelatihan[0]?.status).toBe(
      "Dibatalkan",
    );
  });
});
