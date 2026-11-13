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
  rencanaTahun,
  rincianPelatihan,
  riwayatPelatihan,
  simpanPelatihan,
  simpanPeserta,
  simpanRencana,
  simpanSertifikat,
} = await import("./hr-pelatihan");
const { wibToday } = await import("./inventory");
const {
  JENIS_SERTIFIKAT,
  PESAN_PELATIHAN_BATAL,
  PESAN_PESERTA_BERSERTIFIKAT,
  PESAN_RENCANA_BATAL,
  PESAN_RENCANA_TAHUN,
  PESAN_RENCANA_TAHUN_TERKUNCI,
  PESAN_RENCANA_TERTAUT,
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

  // Fase 11 (v43). Padanan Rust: `rencana_cloud_pagu_dan_realisasi`, data
  // dan hasil sama. Tahun 2099 = semua Dijadwalkan (Terikat); pelatihan
  // sepanjang tahun berjalan = Berlangsung (Terpakai).
  test("rencana dan pagu: tautan, ringkasan, dan batal", async () => {
    await db.execute(
      "INSERT INTO hr_divisi (id_divisi, nama, is_aktif) VALUES ('div-1', 'Gudang', 1), ('div-2', 'Lama', 0);",
    );
    const pagu = (nominal: number, divisi: string | null) => ({
      aksi: "pagu",
      tahun: 2099,
      id_divisi: divisi,
      nominal,
    });
    const admin = { ...hrd, username: "admin" } as OperatorUser;

    await simpanRencana(db, hrd, pagu(1_000_000, "div-1"));
    await simpanRencana(db, admin, pagu(2_000_000, "div-1"));
    expect(
      await angka("SELECT COUNT(*) AS n FROM hr_pelatihan_anggaran;"),
    ).toBe(1);
    const baris = (
      await db.execute(
        "SELECT nominal, diubah_oleh FROM hr_pelatihan_anggaran WHERE id_anggaran = '2099:div-1';",
      )
    ).rows[0];
    expect([baris?.nominal, baris?.diubah_oleh]).toEqual([2_000_000, "admin"]);
    expect(await galat(simpanRencana(db, hrd, pagu(5, "div-2")))).toBe(
      "Divisi sudah nonaktif.",
    );
    expect(await galat(simpanRencana(db, hrd, pagu(5, "div-x")))).toBe(
      "Divisi tidak ditemukan.",
    );
    await db.execute(
      "INSERT INTO hr_pelatihan_anggaran (id_anggaran, tahun, id_divisi, nominal, dicatat_oleh) VALUES ('2099:div-2', 2099, 'div-2', 1, 'hrd');",
    );
    await simpanRencana(db, hrd, pagu(7, "div-2"));
    const hapus = { aksi: "hapus_pagu", tahun: 2099, id_divisi: "div-2" };
    await simpanRencana(db, hrd, hapus);
    expect(await galat(simpanRencana(db, hrd, hapus))).toBe(
      "Pagu tidak ditemukan.",
    );
    await simpanRencana(db, hrd, pagu(300_000, null));

    const rcn = String(
      (
        await simpanRencana(db, hrd, {
          tahun: 2099,
          nama: "K3 Gudang",
          id_divisi: "div-1",
          bulan: 3,
          peserta_rencana: 5,
          biaya_rencana: 1_500_000,
        })
      ).id_rencana,
    );
    const pelatihan = (isi: Record<string, unknown>) => ({
      nama: "K3",
      tanggal_mulai: "2099-03-01",
      tanggal_selesai: "2099-03-02",
      biaya: 1_800_000,
      ...isi,
    });
    expect(
      await galat(
        simpanPelatihan(
          db,
          hrd,
          pelatihan({ id_rencana: rcn, tanggal_mulai: "2098-12-30" }),
        ),
      ),
    ).toBe(PESAN_RENCANA_TAHUN);
    expect(
      await galat(simpanPelatihan(db, hrd, pelatihan({ id_rencana: "rcn-x" }))),
    ).toBe("Rencana tidak ditemukan.");
    const pltA = (
      await simpanPelatihan(db, hrd, pelatihan({ id_rencana: rcn }))
    ).id_pelatihan;
    expect(
      await galat(
        simpanPelatihan(
          db,
          hrd,
          pelatihan({
            id_pelatihan: pltA,
            id_rencana: rcn,
            tanggal_mulai: "2100-01-02",
            tanggal_selesai: "2100-01-02",
          }),
        ),
      ),
    ).toBe(PESAN_RENCANA_TAHUN);
    expect(
      await galat(
        simpanRencana(db, hrd, {
          id_rencana: rcn,
          tahun: 2100,
          nama: "K3 Gudang",
        }),
      ),
    ).toBe(PESAN_RENCANA_TAHUN_TERKUNCI);
    const pltB = (
      await simpanPelatihan(
        db,
        hrd,
        pelatihan({ nama: "Di luar rencana", biaya: 400_000 }),
      )
    ).id_pelatihan;
    const rinci = await rincianPelatihan(db, pltA);
    expect([rinci.rencana?.nama, rinci.rencana?.status]).toEqual([
      "K3 Gudang",
      "Dijadwalkan",
    ]);
    expect((await rincianPelatihan(db, pltB)).rencana).toBeNull();

    const kelompok = (
      r: Awaited<ReturnType<typeof rencanaTahun>>,
      kunci: string,
    ) => r.kelompok.find((k) => k.kunci === kunci);
    let ringkas = await rencanaTahun(db, 2099);
    const gudang = kelompok(ringkas, "div-1");
    expect([
      gudang?.pagu,
      gudang?.direncanakan,
      gudang?.terikat,
      gudang?.terpakai,
      gudang?.sisa,
      gudang?.tanda,
    ]).toEqual([2_000_000, 1_500_000, 1_800_000, 0, 200_000, []]);
    const umum = kelompok(ringkas, "umum");
    expect([umum?.pagu, umum?.terikat, umum?.sisa, umum?.tanda]).toEqual([
      300_000,
      400_000,
      -100_000,
      ["lewat_pagu"],
    ]);
    expect(ringkas.di_luar_rencana.realisasi).toBe(400_000);
    expect(ringkas.rencana[0]?.tanda).toEqual(["lewat_estimasi"]);
    expect(ringkas.total.sisa).toBe(100_000);

    await simpanPelatihan(db, hrd, {
      id_pelatihan: pltB,
      aksi: "batal",
      alasan: "Ditunda",
    });
    ringkas = await rencanaTahun(db, 2099);
    expect([
      kelompok(ringkas, "umum")?.terikat,
      kelompok(ringkas, "umum")?.tanda,
    ]).toEqual([0, []]);

    const tahunIni = Number((await wibToday(db)).slice(0, 4));
    await simpanPelatihan(db, hrd, {
      nama: "Sepanjang tahun",
      tanggal_mulai: `${tahunIni}-01-01`,
      tanggal_selesai: `${tahunIni}-12-31`,
      biaya: 250_000,
    });
    const berjalan = await rencanaTahun(db, null);
    expect(berjalan.tahun).toBe(tahunIni);
    const umumIni = kelompok(berjalan, "umum");
    // Pelatihan fase 7 di atas (tahun 2026, dibatalkan) tidak ikut dihitung.
    expect([
      umumIni?.terpakai,
      umumIni?.terikat,
      umumIni?.sisa,
      umumIni?.tanda,
    ]).toEqual([250_000, 0, null, ["tanpa_pagu"]]);

    // UBAH_PELATIHAN_SQL v42 (teks lama, tanpa kolom) mempertahankan tautan.
    await db.execute({
      sql: "UPDATE hr_pelatihan SET nama = ?2, penyelenggara = ?3, tanggal_mulai = ?4, tanggal_selesai = ?5, lokasi = ?6, biaya = ?7, keterangan = ?8, diubah_oleh = ?9, diubah_pada = datetime('now') WHERE id_pelatihan = ?1 AND dibatalkan_pada IS NULL;",
      args: [
        pltA,
        "K3 (v42)",
        null,
        "2099-03-01",
        "2099-03-02",
        null,
        1_800_000,
        null,
        "hrd-lama",
      ],
    });
    const tautan = (
      await db.execute({
        sql: "SELECT id_rencana FROM hr_pelatihan WHERE id_pelatihan = ?1;",
        args: [pltA],
      })
    ).rows[0]?.id_rencana;
    expect(tautan).toBe(rcn);

    const batal = { aksi: "batal", id_rencana: rcn, alasan: "Diganti" };
    expect(await galat(simpanRencana(db, hrd, batal))).toBe(
      PESAN_RENCANA_TERTAUT,
    );
    await simpanPelatihan(db, hrd, {
      id_pelatihan: pltA,
      aksi: "batal",
      alasan: "Ditunda",
    });
    await simpanRencana(db, hrd, batal);
    expect(await galat(simpanRencana(db, hrd, batal))).toBe(
      PESAN_RENCANA_BATAL,
    );
    expect(
      await galat(simpanPelatihan(db, hrd, pelatihan({ id_rencana: rcn }))),
    ).toBe(PESAN_RENCANA_BATAL);
    ringkas = await rencanaTahun(db, 2099);
    expect(ringkas.rencana[0]?.status).toBe("Dibatalkan");
    expect([
      kelompok(ringkas, "div-1")?.direncanakan,
      kelompok(ringkas, "div-1")?.terikat,
    ]).toEqual([0, 0]);
  });
});
