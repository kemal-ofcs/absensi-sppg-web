import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BATAS_PENGATURAN,
  bulanPenuhTerakhir,
  CLOUD_ORG_KARYAWAN_SQL,
  CLOUD_TEKS_KARYAWAN_SQL,
  DIVISI_KINI_SQL,
  dalamSiklusAtasan,
  divisiKini,
  HAPUS_DOKUMEN_SQL,
  INGAT_DOKUMEN_SQL,
  INGAT_JAM_SQL,
  INGAT_KONTRAK_DEKAT_SQL,
  INGAT_KONTRAK_JAUH_SQL,
  INGAT_MENUNGGU_SQL,
  INGAT_PERCOBAAN_SQL,
  INSERT_BERKAS_DOKUMEN_SQL,
  INSERT_KONTRAK_SQL,
  INSERT_NAMA_DIVISI_SQL,
  JENIS_DARI_KONTRAK_SQL,
  type Kontrak,
  kunciNama,
  MAKS_BERKAS_BASE64,
  MIGRASI_ORGANISASI_SQL,
  namaBentrok,
  namaMaster,
  nomorHari,
  nomorIdentitas,
  PANJANG_REKENING,
  PENGATURAN_KONTRAK_BAWAAN,
  PESAN_INGAT_KONTRAK,
  pengaturanDariPeta,
  periksaAtasan,
  SEED_JENIS_DOKUMEN_SQL,
  SELARASKAN_DIVISI_SQL,
  SELARASKAN_JABATAN_SQL,
  SIMPAN_DOKUMEN_SQL,
  statusKerja,
  tambahBulan,
  tandaKontrak,
  UPSERT_CABANG_SQL,
  UPSERT_DIVISI_SQL,
  UPSERT_JABATAN_SQL,
  validasiBerkas,
  validasiDokumen,
  validasiKeuangan,
  validasiKontrak,
  validasiPengaturan,
  validasiPribadi,
} from "./hris";

// Vektor yang sama diuji di `desktop/hris.rs` (modul `tests`).

const k = (
  id: string,
  jenis: string,
  mulai: string,
  selesai: string | null,
): Kontrak => ({
  id_kontrak: id,
  jenis,
  id_ref: null,
  tanggal_mulai: mulai,
  tanggal_selesai: selesai,
  percobaan_selesai: null,
});
const batal = (idRef: string): Kontrak => ({
  id_kontrak: `batal-${idRef}`,
  jenis: "Pembatalan",
  id_ref: idRef,
  tanggal_mulai: "2026-01-01",
  tanggal_selesai: null,
  percobaan_selesai: null,
});

describe("hris (cermin tes Rust)", () => {
  test("nomor identitas dan nama", () => {
    expect(nomorIdentitas("3201.0101-0101 0001", "NIK", [16])).toEqual({
      ok: true,
      nilai: "3201010101010001",
    });
    expect(nomorIdentitas("  ", "NIK", [16])).toEqual({
      ok: true,
      nilai: null,
    });
    expect(nomorIdentitas("12A4", "NIK", [16])).toEqual({
      ok: false,
      pesan: "NIK hanya boleh berisi angka.",
    });
    expect(nomorIdentitas("123", "NIK", [16])).toEqual({
      ok: false,
      pesan: "NIK harus 16 digit.",
    });
    expect(nomorIdentitas("12.345.678.9-012.345", "NPWP", [15, 16])).toEqual({
      ok: true,
      nilai: "123456789012345",
    });
    expect(nomorIdentitas("1234", "NPWP", [15, 16])).toEqual({
      ok: false,
      pesan: "NPWP harus 15 atau 16 digit.",
    });
    expect(nomorIdentitas("1234", "Nomor rekening", PANJANG_REKENING)).toEqual({
      ok: false,
      pesan: "Nomor rekening harus 5–20 digit.",
    });
    expect(namaMaster("  Gudang   Utama ")).toEqual({
      ok: true,
      nilai: "Gudang Utama",
    });
    expect(namaMaster(" ")).toEqual({ ok: false, pesan: "Nama wajib diisi." });
    expect(namaMaster("a".repeat(101))).toEqual({
      ok: false,
      pesan: "Nama maksimal 100 karakter.",
    });
    expect(kunciNama(" GUDANG  utama")).toBe("gudang utama");
    const lain = [
      ["d1", "Gudang"],
      ["d2", "Kantor"],
    ] as const;
    expect(namaBentrok("d2", "gudang", lain)).toBe(true);
    expect(namaBentrok("d1", "GUDANG", lain)).toBe(false);
    expect(namaBentrok(null, "Produksi", lain)).toBe(false);
  });

  test("profil pribadi dan keuangan", () => {
    const pribadi = validasiPribadi({
      nik: "3201010101010001",
      agama: "Islam",
      status_nikah: "Kawin",
      pendidikan: "S1",
      tanggal_lahir: "1990-02-28",
      darurat_hp: "0812-3456-7890",
      alamat_ktp: null,
    });
    expect(pribadi.ok).toBe(true);
    if (pribadi.ok) {
      expect(pribadi.nilai[0]).toBe("3201010101010001");
      expect(pribadi.nilai[11]).toBe("+6281234567890");
      expect(pribadi.nilai[6]).toBeNull();
    }
    expect(validasiPribadi({ agama: "Lain" })).toEqual({
      ok: false,
      pesan: "Agama tidak dikenal.",
    });
    expect(validasiPribadi({ tanggal_lahir: "1990-02-30" })).toEqual({
      ok: false,
      pesan: "Tanggal lahir tidak valid.",
    });
    expect(validasiPribadi({ gaji: "1" })).toEqual({
      ok: false,
      pesan: "Isian 'gaji' tidak dikenal.",
    });
    expect(validasiPribadi({ darurat_hp: "12" })).toEqual({
      ok: false,
      pesan: "Nomor HP kontak darurat tidak valid.",
    });
    const keuangan = validasiKeuangan({
      npwp: "12.345.678.9-012.345",
      no_rekening: "0123 4567 89",
    });
    expect(keuangan.ok && keuangan.nilai[3]).toBe("123456789012345");
    expect(keuangan.ok && keuangan.nilai[1]).toBe("0123456789");
    expect(validasiKeuangan({ nik: "1" })).toEqual({
      ok: false,
      pesan: "Isian 'nik' tidak dikenal.",
    });
  });

  test("validasi kontrak: kelengkapan", () => {
    const dasar = (
      jenis: string,
      selesai: string | null,
      coba: string | null,
    ) =>
      validasiKontrak({
        id_karyawan: "K1",
        jenis,
        tanggal_mulai: "2026-01-01",
        tanggal_selesai: selesai,
        percobaan_selesai: coba,
      });
    expect(dasar("PKWTT", null, "2026-03-31").ok).toBe(true);
    expect(dasar("PKWT", null, null)).toEqual({
      ok: false,
      pesan: "Kontrak PKWT dan Magang wajib punya tanggal selesai.",
    });
    expect(dasar("PKWTT", "2026-12-31", null)).toEqual({
      ok: false,
      pesan: "Kontrak PKWTT tidak punya tanggal selesai.",
    });
    expect(dasar("PKWT", "2025-12-31", null)).toEqual({
      ok: false,
      pesan: "Tanggal selesai tidak boleh sebelum tanggal mulai.",
    });
    expect(dasar("PKWT", "2026-12-31", "2026-02-01")).toEqual({
      ok: false,
      pesan: "Masa percobaan hanya untuk PKWTT.",
    });
    expect(dasar("Borongan", null, null)).toEqual({
      ok: false,
      pesan: "Jenis kontrak tidak dikenal.",
    });
    expect(dasar("Harian Lepas", null, null).ok).toBe(true);
  });

  test("status kerja", () => {
    let kontrak = [
      k("a", "PKWT", "2025-01-01", "2025-12-31"),
      k("b", "PKWT", "2026-01-01", "2026-06-30"),
      batal("b"),
    ];
    expect(statusKerja(kontrak, "2026-03-01").keadaan).toBe("Berakhir");
    expect(statusKerja(kontrak, "2025-06-01").keadaan).toBe("Berlaku");
    expect(statusKerja(kontrak, "2024-06-01").keadaan).toBe("Tanpa kontrak");
    const tetap = {
      ...k("c", "PKWTT", "2026-02-01", null),
      percobaan_selesai: "2026-04-30",
    };
    kontrak = [k("a", "PKWT", "2025-01-01", "2025-12-31"), tetap];
    const s = statusKerja(kontrak, "2026-03-01");
    expect([s.jenis, s.percobaan_sampai]).toEqual(["PKWTT", "2026-04-30"]);
    expect(statusKerja(kontrak, "2026-05-01").percobaan_sampai).toBeNull();
  });

  test("kalender dan tanda kontrak", () => {
    expect(tambahBulan("2026-01-31", 1)).toBe("2026-02-28");
    expect(tambahBulan("2024-01-31", 1)).toBe("2024-02-29");
    expect(tambahBulan("2026-03-15", -3)).toBe("2025-12-15");
    expect(nomorHari("1970-01-01")).toBe(0);
    expect(nomorHari("2026-11-10")).toBe(20_767);
    expect(bulanPenuhTerakhir("2026-03-10", 3)).toEqual([
      ["2025-12-01", "2025-12-31"],
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
    ]);
    const aturan = PENGATURAN_KONTRAK_BAWAAN;
    const coba = {
      ...k("c", "PKWTT", "2026-01-01", null),
      percobaan_selesai: "2026-04-02",
    };
    expect(tandaKontrak([coba], aturan, "2026-02-01", [])).toEqual([
      "percobaan_lewat",
    ]);
    expect(
      tandaKontrak(
        [{ ...coba, percobaan_selesai: "2026-04-01" }],
        aturan,
        "2026-02-01",
        [],
      ),
    ).toEqual([]);
    const pkwt = [
      k("p1", "PKWT", "2020-01-01", "2021-12-31"),
      k("p2", "PKWT", "2022-01-01", "2023-12-31"),
      k("p3", "PKWT", "2024-01-01", "2025-12-31"),
    ];
    expect(tandaKontrak(pkwt, aturan, "2025-06-01", [])).toEqual([
      "pkwt_lewat",
    ]);
    const putus = [pkwt[0], k("t", "PKWTT", "2022-01-01", null), pkwt[2]];
    expect(tandaKontrak(putus, aturan, "2025-06-01", [])).toEqual([]);
    const harian = [k("h", "Harian Lepas", "2025-01-01", null)];
    expect(tandaKontrak(harian, aturan, "2026-03-10", [21, 22, 21])).toEqual([
      "harian_perlu_pkwtt",
    ]);
    expect(tandaKontrak(harian, aturan, "2026-03-10", [21, 20, 25])).toEqual(
      [],
    );
    expect(tandaKontrak(harian, aturan, "2026-03-10", [25, 25])).toEqual([]);
  });

  test("pengaturan kontrak", () => {
    const p = pengaturanDariPeta({
      hr_pkwt_maks_bulan: "36",
      hr_harian_batas_hari: "99",
    });
    expect([p.hr_pkwt_maks_bulan, p.hr_harian_batas_hari]).toEqual([36, 21]);
    // Bawaan = draf sah; setiap kasus mengubah satu atau dua angka.
    const dengan = (ubah: Record<string, number> = {}) =>
      validasiPengaturan({ ...PENGATURAN_KONTRAK_BAWAAN, ...ubah });
    expect(dengan().ok).toBe(true);
    expect(dengan({ hr_percobaan_maks_bulan: 0 })).toEqual({
      ok: false,
      pesan: "Masa percobaan maksimal harus bilangan bulat 1–12.",
    });
    expect(dengan({ hr_pelamar_retensi_bulan: 61 })).toEqual({
      ok: false,
      pesan: "Masa simpan data pelamar (bulan) harus bilangan bulat 1–60.",
    });
    expect(
      pengaturanDariPeta({ hr_pelamar_retensi_bulan: "0" })
        .hr_pelamar_retensi_bulan,
    ).toBe(12);

    // Angka pengingat (§24.3): bawaan, diubah, batas, dan dekat < jauh.
    expect(PENGATURAN_KONTRAK_BAWAAN).toEqual({
      hr_percobaan_maks_bulan: 3,
      hr_pkwt_maks_bulan: 60,
      hr_harian_batas_hari: 21,
      hr_harian_batas_bulan: 3,
      hr_sp_masa_bulan: 6,
      hr_pelamar_retensi_bulan: 12,
      hr_ingat_kontrak_jauh: 30,
      hr_ingat_kontrak_dekat: 7,
      hr_ingat_percobaan: 7,
      hr_ingat_dokumen: 30,
      hr_ingat_menunggu: 2,
      hr_ingat_jam: 7,
    });
    const diubah = dengan({
      hr_ingat_kontrak_jauh: 14,
      hr_ingat_kontrak_dekat: 3,
      hr_ingat_jam: 0,
    });
    expect(diubah.ok && diubah.nilai.hr_ingat_kontrak_jauh).toBe(14);
    expect(diubah.ok && diubah.nilai.hr_ingat_jam).toBe(0);
    expect(dengan({ hr_ingat_kontrak_jauh: 7 })).toEqual({
      ok: false,
      pesan:
        "Pengingat pertama PKWT berakhir (hari sebelumnya) harus bilangan bulat 8–90.",
    });
    expect(dengan({ hr_ingat_jam: 24 })).toEqual({
      ok: false,
      pesan: "Jam mulai pengingat HR (WIB) harus bilangan bulat 0–23.",
    });
    expect(dengan({ hr_ingat_menunggu: 15 })).toEqual({
      ok: false,
      pesan:
        "Pengajuan dianggap lama menunggu (hari) harus bilangan bulat 1–14.",
    });
    const salahUrut = { ok: false as const, pesan: PESAN_INGAT_KONTRAK };
    expect(
      dengan({ hr_ingat_kontrak_jauh: 10, hr_ingat_kontrak_dekat: 10 }),
    ).toEqual(salahUrut);
    expect(
      dengan({ hr_ingat_kontrak_jauh: 10, hr_ingat_kontrak_dekat: 20 }),
    ).toEqual(salahUrut);
    expect(
      dengan({ hr_ingat_kontrak_jauh: 10, hr_ingat_kontrak_dekat: 9 }).ok,
    ).toBe(true);
    // Tersimpan rusak = bawaan per angka; aturan silang hanya saat disimpan.
    const p2 = pengaturanDariPeta({
      hr_ingat_kontrak_jauh: "x",
      hr_ingat_kontrak_dekat: " 20 ",
      hr_ingat_jam: "0",
      hr_ingat_menunggu: "-1",
    });
    expect([
      p2.hr_ingat_kontrak_jauh,
      p2.hr_ingat_kontrak_dekat,
      p2.hr_ingat_jam,
      p2.hr_ingat_menunggu,
    ]).toEqual([30, 20, 0, 2]);
  });

  // Cermin `fragmen_ingat_sql` (Rust): kosong, rusak, di luar batas = bawaan.
  test("fragmen SQL angka pengingat", () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE setting_gex_system (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    for (const [sql, kunci] of [
      [INGAT_KONTRAK_JAUH_SQL, "hr_ingat_kontrak_jauh"],
      [INGAT_KONTRAK_DEKAT_SQL, "hr_ingat_kontrak_dekat"],
      [INGAT_PERCOBAAN_SQL, "hr_ingat_percobaan"],
      [INGAT_DOKUMEN_SQL, "hr_ingat_dokumen"],
      [INGAT_MENUNGGU_SQL, "hr_ingat_menunggu"],
      [INGAT_JAM_SQL, "hr_ingat_jam"],
    ] as const) {
      const [, , min, maks] = BATAS_PENGATURAN.find(
        ([k]) => k === kunci,
      ) as readonly [string, string, number, number];
      const bawaan = PENGATURAN_KONTRAK_BAWAAN[kunci];
      expect(sql).toBe(
        `COALESCE((SELECT CAST(trim(value) AS INTEGER) FROM setting_gex_system WHERE key = '${kunci}' AND trim(value) <> '' AND trim(value) NOT GLOB '*[^0-9]*' AND CAST(trim(value) AS INTEGER) BETWEEN ${min} AND ${maks}), ${bawaan})`,
      );
      const baca = (nilai: string | null) => {
        db.run("DELETE FROM setting_gex_system;");
        if (nilai !== null) {
          db.run("INSERT INTO setting_gex_system VALUES (?, ?);", [
            kunci,
            nilai,
          ]);
        }
        const row = db.query(`SELECT ${sql} AS n;`).get() as { n: number };
        return row.n;
      };
      const tengah = Math.floor((min + maks) / 2);
      expect([
        baca(null),
        baca(` ${tengah} `),
        baca(String(min)),
        baca(String(maks)),
        baca(String(maks + 1)),
        baca("-1"),
        baca("7x"),
        baca(""),
      ]).toEqual([bawaan, tengah, min, maks, bawaan, bawaan, bawaan, bawaan]);
    }
    db.close();
  });

  test("atasan dan siklus", () => {
    const peta = new Map<string, string | null>([
      ["A", null],
      ["B", "A"],
      ["C", "B"],
    ]);
    expect(periksaAtasan("C", "A", peta)).toBeNull();
    expect(periksaAtasan("A", "A", peta)).toBe(
      "Atasan tidak boleh dirinya sendiri.",
    );
    expect(periksaAtasan("A", "C", peta)).toBe(
      "Pilihan atasan membentuk lingkaran atasan.",
    );
    expect(periksaAtasan("A", "Z", peta)).toBe("Atasan tidak ditemukan.");
    const siklus = new Map<string, string | null>([
      ["A", "B"],
      ["B", "A"],
      ["C", "A"],
    ]);
    expect(dalamSiklusAtasan(siklus)).toEqual(["A", "B"]);
  });

  test("berkas dan dokumen", () => {
    const pdf = btoa("%PDF-1.7 isi");
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0));
    expect(validasiBerkas("application/pdf", pdf)).toBeNull();
    expect(validasiBerkas("image/png", png)).toBeNull();
    expect(validasiBerkas("image/jpeg", pdf)).toBe(
      "Isi berkas tidak cocok dengan jenisnya.",
    );
    expect(validasiBerkas("image/bmp", pdf)).toBe(
      "Jenis berkas harus JPEG, PNG, WEBP, atau PDF.",
    );
    expect(validasiBerkas("application/pdf", "@@@@")).toBe(
      "Isi berkas tidak terbaca.",
    );
    expect(
      validasiBerkas("application/pdf", "A".repeat(MAKS_BERKAS_BASE64 + 4)),
    ).toBe("Berkas maksimal 1 MB.");
    expect(
      validasiDokumen({
        id_karyawan: "K1",
        id_jenis: "dok-ktp",
        tanggal_terbit: "2026-01-02",
        tanggal_kedaluwarsa: "2026-01-01",
      }),
    ).toEqual({
      ok: false,
      pesan: "Tanggal kedaluwarsa tidak boleh sebelum tanggal terbit.",
    });
    expect(validasiDokumen({ id_karyawan: "K1" })).toEqual({
      ok: false,
      pesan: "Jenis dokumen wajib dipilih.",
    });
  });

  test("divisiKini mengganti kolom", () => {
    expect(divisiKini("a.kelas_divisi").endsWith(", a.kelas_divisi)")).toBe(
      true,
    );
    expect(divisiKini("x")).not.toContain("{kolom}");
  });

  test("SQL disalin harfiah ke hris.rs (Desktop dan Mobile)", () => {
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hris.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hris.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const sql of [
        SEED_JENIS_DOKUMEN_SQL,
        ...MIGRASI_ORGANISASI_SQL,
        DIVISI_KINI_SQL,
        UPSERT_CABANG_SQL,
        UPSERT_DIVISI_SQL,
        INSERT_NAMA_DIVISI_SQL,
        UPSERT_JABATAN_SQL,
        ...SELARASKAN_DIVISI_SQL,
        ...SELARASKAN_JABATAN_SQL,
        ...CLOUD_ORG_KARYAWAN_SQL,
        ...CLOUD_TEKS_KARYAWAN_SQL,
        JENIS_DARI_KONTRAK_SQL,
        INSERT_KONTRAK_SQL,
        SIMPAN_DOKUMEN_SQL,
        INSERT_BERKAS_DOKUMEN_SQL,
        ...HAPUS_DOKUMEN_SQL,
        `"${INGAT_KONTRAK_JAUH_SQL}"`,
        `"${INGAT_KONTRAK_DEKAT_SQL}"`,
        `"${INGAT_PERCOBAAN_SQL}"`,
        `"${INGAT_DOKUMEN_SQL}"`,
        `"${INGAT_MENUNGGU_SQL}"`,
        `"${INGAT_JAM_SQL}"`,
        `"${PESAN_INGAT_KONTRAK}"`,
      ]) {
        expect(rust.includes(sql)).toBe(true);
      }
    }
  });
});
