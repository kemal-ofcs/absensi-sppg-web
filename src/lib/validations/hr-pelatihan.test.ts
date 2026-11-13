import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "./hr-pelatihan";
import {
  idAnggaran,
  idPeserta,
  JENIS_SERTIFIKAT,
  MAKS_PAGU,
  PESAN_PELATIHAN_BATAL,
  PESAN_PESERTA_BERSERTIFIKAT,
  PESAN_RENCANA_BATAL,
  PESAN_RENCANA_TAHUN,
  PESAN_RENCANA_TAHUN_TERKUNCI,
  PESAN_RENCANA_TERTAUT,
  PESAN_SERTIFIKAT_NONAKTIF,
  periksaRencanaPelatihan,
  periksaUbahRencana,
  ringkasAnggaran,
  statusPelatihan,
  statusRencana,
  validasiBatalPelatihan,
  validasiBatalRencana,
  validasiPagu,
  validasiPelatihan,
  validasiPeserta,
  validasiRencana,
} from "./hr-pelatihan";
import vektor from "./hr-pelatihan-anggaran.vektor.json";

// Vektor yang sama diuji di `desktop/hr_pelatihan.rs` (modul `tests`).

const HARI = "2026-11-12";
const gagal = (pesan: string) => ({ ok: false as const, pesan });

describe("hr-pelatihan (cermin tes Rust)", () => {
  test("pelatihan: validasi dan status", () => {
    const sah = validasiPelatihan({
      nama: " K3  Dasar ",
      tanggal_mulai: "2026-12-01",
      tanggal_selesai: "2026-12-02",
      biaya: 3_000_000,
    });
    expect(
      sah.ok && [
        sah.nilai.nama,
        sah.nilai.biaya,
        sah.nilai.lokasi,
        sah.nilai.id_rencana,
      ],
    ).toEqual(["K3 Dasar", 3_000_000, null, null]);
    const bertaut = validasiPelatihan({
      nama: "K3",
      tanggal_mulai: "2026-12-01",
      tanggal_selesai: "2026-12-01",
      id_rencana: " rcn-1 ",
    });
    expect(bertaut.ok && bertaut.nilai.id_rencana).toBe("rcn-1");
    const tanpaBiaya = validasiPelatihan({
      nama: "K3",
      tanggal_mulai: "2026-12-01",
      tanggal_selesai: "2026-12-01",
    });
    expect(tanpaBiaya.ok && tanpaBiaya.nilai.biaya).toBe(0);
    const dasar = (biaya: unknown, selesai: string) =>
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: selesai,
        biaya,
      });
    for (const biaya of [-1, 1.5, 1_000_000_001, "5000"]) {
      expect(dasar(biaya, "2026-12-01")).toEqual(
        gagal("Biaya harus bilangan bulat 0–1.000.000.000."),
      );
    }
    expect(dasar(0, "2026-11-30")).toEqual(
      gagal("Tanggal selesai tidak boleh sebelum tanggal mulai."),
    );
    expect(
      validasiPelatihan({
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: "2026-12-01",
      }),
    ).toEqual(gagal("Nama pelatihan wajib diisi."));
    expect(
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-02-30",
        tanggal_selesai: "2026-12-01",
      }),
    ).toEqual(gagal("Tanggal mulai tidak valid."));
    expect(
      validasiPelatihan({
        nama: "K3",
        tanggal_mulai: "2026-12-01",
        tanggal_selesai: "2026-12-01",
        lokasi: "a".repeat(101),
      }),
    ).toEqual(gagal("Lokasi maksimal 100 karakter."));

    expect(statusPelatihan("2026-11-13", "2026-11-14", false, HARI)).toBe(
      "Dijadwalkan",
    );
    expect(statusPelatihan("2026-11-12", "2026-11-12", false, HARI)).toBe(
      "Berlangsung",
    );
    expect(statusPelatihan("2026-11-10", "2026-11-11", false, HARI)).toBe(
      "Selesai",
    );
    expect(statusPelatihan("2026-11-10", "2026-11-11", true, HARI)).toBe(
      "Dibatalkan",
    );
  });

  test("peserta dan batal", () => {
    expect(idPeserta("plt-1", "EMP_A")).toBe("plt-1:EMP_A");
    expect(validasiPeserta({ id_karyawan: "EMP_A", hasil: "Lulus" })).toEqual({
      ok: true,
      nilai: { id_karyawan: "EMP_A", hasil: "Lulus", catatan: null },
    });
    expect(validasiPeserta({ id_karyawan: "EMP_A", hasil: "Gagal" })).toEqual(
      gagal("Hasil pelatihan tidak dikenal."),
    );
    expect(validasiPeserta({ hasil: "Lulus" })).toEqual(
      gagal("Karyawan wajib dipilih."),
    );
    expect(validasiBatalPelatihan({ alasan: " Ditunda " }, false)).toEqual({
      ok: true,
      nilai: "Ditunda",
    });
    expect(validasiBatalPelatihan({}, false)).toEqual(
      gagal("Alasan pembatalan wajib diisi."),
    );
    expect(validasiBatalPelatihan({ alasan: "x" }, true)).toEqual(
      gagal(PESAN_PELATIHAN_BATAL),
    );
  });

  test("rencana dan pagu: validasi", () => {
    expect(
      validasiRencana({
        tahun: 2026,
        nama: " K3  Gudang ",
        id_divisi: "div-a",
        bulan: 3,
        peserta_rencana: 10,
        biaya_rencana: 4_000_000,
        penyelenggara: " LSP ",
      }),
    ).toEqual({
      ok: true,
      nilai: {
        id_rencana: null,
        tahun: 2026,
        nama: "K3 Gudang",
        id_divisi: "div-a",
        bulan: 3,
        peserta_rencana: 10,
        biaya_rencana: 4_000_000,
        penyelenggara: "LSP",
        keterangan: null,
      },
    });
    const minimal = validasiRencana({
      tahun: 2027,
      nama: "Etika",
      bulan: null,
    });
    expect(
      minimal.ok && [
        minimal.nilai.id_divisi,
        minimal.nilai.bulan,
        minimal.nilai.peserta_rencana,
        minimal.nilai.biaya_rencana,
      ],
    ).toEqual([null, null, 0, 0]);
    const dasar = (kunci: string, nilai: unknown) =>
      validasiRencana({ tahun: 2026, nama: "K3", [kunci]: nilai });
    const kasus: [string, unknown, string][] = [
      ["tahun", 1999, "Tahun harus 2000–2100."],
      ["tahun", null, "Tahun harus 2000–2100."],
      ["tahun", "2026", "Tahun harus 2000–2100."],
      ["nama", "  ", "Nama rencana wajib diisi."],
      ["nama", "a".repeat(101), "Nama rencana maksimal 100 karakter."],
      ["bulan", 13, "Bulan harus 1–12."],
      ["bulan", 0, "Bulan harus 1–12."],
      [
        "peserta_rencana",
        10_000,
        "Jumlah peserta rencana harus bilangan bulat 0–9.999.",
      ],
      [
        "biaya_rencana",
        -1,
        "Estimasi biaya harus bilangan bulat 0–1.000.000.000.",
      ],
      [
        "biaya_rencana",
        2.5,
        "Estimasi biaya harus bilangan bulat 0–1.000.000.000.",
      ],
      ["keterangan", "a".repeat(2001), "Keterangan maksimal 2000 karakter."],
    ];
    for (const [kunci, nilai, pesan] of kasus) {
      expect(dasar(kunci, nilai)).toEqual(gagal(pesan));
    }

    expect(
      validasiPagu({ tahun: 2026, nominal: 0, catatan: " Belum dianggarkan " }),
    ).toEqual({
      ok: true,
      nilai: {
        tahun: 2026,
        id_divisi: null,
        nominal: 0,
        catatan: "Belum dianggarkan",
      },
    });
    const maks = validasiPagu({
      tahun: 2026,
      id_divisi: "div-a",
      nominal: MAKS_PAGU,
    });
    expect(maks.ok && maks.nilai.nominal).toBe(MAKS_PAGU);
    const pesanPagu = gagal("Pagu harus bilangan bulat 0–100.000.000.000.");
    expect(validasiPagu({ tahun: 2026 })).toEqual(pesanPagu);
    expect(validasiPagu({ tahun: 2026, nominal: MAKS_PAGU + 1 })).toEqual(
      pesanPagu,
    );
    expect(validasiPagu({ tahun: 2026, nominal: -5 })).toEqual(pesanPagu);
    expect(validasiPagu({ nominal: 5 })).toEqual(
      gagal("Tahun harus 2000–2100."),
    );
    expect(
      validasiPagu({ tahun: 2026, nominal: 5, catatan: "a".repeat(1001) }),
    ).toEqual(gagal("Catatan maksimal 1000 karakter."));
    expect(idAnggaran(2026, "div-a")).toBe("2026:div-a");
    expect(idAnggaran(2026, null)).toBe("2026:umum");
  });

  test("rencana: tautan, batal, dan status", () => {
    const lulus = { ok: true as const, nilai: null };
    expect(periksaRencanaPelatihan("2026-03-02", 2026, false)).toEqual(lulus);
    expect(periksaRencanaPelatihan("2027-01-05", 2026, false)).toEqual(
      gagal(PESAN_RENCANA_TAHUN),
    );
    expect(periksaRencanaPelatihan("2026-03-02", 2026, true)).toEqual(
      gagal(PESAN_RENCANA_BATAL),
    );
    expect(periksaUbahRencana(2026, 2026, false, 3)).toEqual(lulus);
    expect(periksaUbahRencana(2026, 2027, false, 0)).toEqual(lulus);
    expect(periksaUbahRencana(2026, 2027, false, 1)).toEqual(
      gagal(PESAN_RENCANA_TAHUN_TERKUNCI),
    );
    expect(periksaUbahRencana(2026, 2026, true, 0)).toEqual(
      gagal(PESAN_RENCANA_BATAL),
    );
    expect(validasiBatalRencana({ alasan: " Ditunda " }, false, 0)).toEqual({
      ok: true,
      nilai: "Ditunda",
    });
    expect(validasiBatalRencana({ alasan: "x" }, false, 1)).toEqual(
      gagal(PESAN_RENCANA_TERTAUT),
    );
    expect(validasiBatalRencana({ alasan: "x" }, true, 0)).toEqual(
      gagal(PESAN_RENCANA_BATAL),
    );
    expect(validasiBatalRencana({}, false, 0)).toEqual(
      gagal("Alasan pembatalan wajib diisi."),
    );

    const s = (
      dibatalkan: boolean,
      tahun: number,
      bulan: number | null,
      tertaut: string[],
    ) => statusRencana(dibatalkan, tahun, bulan, tertaut, HARI);
    expect(s(true, 2026, null, ["Selesai"])).toBe("Dibatalkan");
    expect(
      s(false, 2026, null, ["Dijadwalkan", "Selesai", "Berlangsung"]),
    ).toBe("Terlaksana");
    expect(s(false, 2026, null, ["Dijadwalkan", "Berlangsung"])).toBe(
      "Berlangsung",
    );
    expect(s(false, 2025, 1, ["Dijadwalkan"])).toBe("Dijadwalkan");
    expect(s(false, 2026, 10, ["Dibatalkan"])).toBe("Terlewat");
    expect(s(false, 2025, null, [])).toBe("Terlewat");
    expect(s(false, 2026, 11, [])).toBe("Belum dijadwalkan");
    expect(s(false, 2026, null, [])).toBe("Belum dijadwalkan");
    expect(s(false, 2027, 1, [])).toBe("Belum dijadwalkan");
  });

  test("ringkasAnggaran: vektor bersama hr-pelatihan-anggaran.vektor.json", () => {
    const hasil = ringkasAnggaran(
      vektor.pagu,
      vektor.rencana,
      vektor.pelatihan,
      vektor.tahun,
      vektor.hari_ini,
    );
    const harapan = vektor.harapan;
    expect(hasil.kelompok).toEqual(harapan.kelompok as typeof hasil.kelompok);
    expect(hasil.total).toEqual(harapan.total as typeof hasil.total);
    expect(hasil.di_luar_rencana).toEqual(harapan.di_luar_rencana);
    expect<unknown>(
      hasil.rencana.map((r) => ({
        id_rencana: r.id_rencana,
        status: r.status,
        realisasi: r.realisasi,
        jumlah_pelatihan: r.jumlah_pelatihan,
        peserta_aktual: r.peserta_aktual,
        tanda: r.tanda,
      })),
    ).toEqual(harapan.rencana);
    expect(hasil.rencana[0]?.pelatihan).toEqual(
      harapan.pelatihan_rcn_1 as P.PelatihanTertaut[],
    );
    expect(hasil.rencana[0]?.nama_divisi).toBe("Gudang");

    const kosong = ringkasAnggaran([], [], [], 2026, HARI);
    expect(kosong.kelompok).toHaveLength(1);
    expect(kosong.total).toEqual({
      pagu: null,
      direncanakan: 0,
      terikat: 0,
      terpakai: 0,
      sisa: null,
      tanda: [],
    });
  });

  test("SQL, pesan, dan konstanta disalin harfiah ke hr_pelatihan.rs (Desktop dan Mobile)", () => {
    let diperiksa = 0;
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_pelatihan.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_pelatihan.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      diperiksa++;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const teks of [
        `"${JENIS_SERTIFIKAT}"`,
        `"${PESAN_SERTIFIKAT_NONAKTIF}"`,
        `"${PESAN_PELATIHAN_BATAL}"`,
        PESAN_PESERTA_BERSERTIFIKAT,
        PESAN_RENCANA_TAHUN,
        PESAN_RENCANA_TERTAUT,
        `"${PESAN_RENCANA_BATAL}"`,
        PESAN_RENCANA_TAHUN_TERKUNCI,
        `"${P.KELOMPOK_UMUM}"`,
        `MAKS_PAGU: i64 = ${P.MAKS_PAGU.toLocaleString("en").replaceAll(",", "_")};`,
        `MAKS_PESERTA_RENCANA: i64 = ${P.MAKS_PESERTA_RENCANA.toLocaleString("en").replaceAll(",", "_")};`,
        `MAKS_CATATAN_PAGU: usize = ${P.MAKS_CATATAN_PAGU};`,
        P.PAGU_SQL,
        P.RENCANA_SQL,
        P.REALISASI_SQL,
        P.SIMPAN_PAGU_SQL,
        P.HAPUS_PAGU_SQL,
        P.RENCANA_SATU_SQL,
        P.TAUTAN_RENCANA_SQL,
        P.INSERT_RENCANA_SQL,
        P.UBAH_RENCANA_SQL,
        P.BATAL_RENCANA_SQL,
        P.DAFTAR_PELATIHAN_SQL,
        P.PESERTA_SQL,
        P.BERKAS_PESERTA_SQL,
        P.RIWAYAT_SQL,
        P.INSERT_PELATIHAN_SQL,
        P.UBAH_PELATIHAN_SQL,
        P.BATAL_PELATIHAN_SQL,
        P.TAMBAH_PESERTA_SQL,
        P.LEPAS_PESERTA_SQL,
        P.HASIL_PESERTA_SQL,
        P.TAUT_SERTIFIKAT_SQL,
        P.BERKAS_SERTIFIKAT_SQL,
      ]) {
        expect(rust).toContain(teks);
      }
    }
    expect(diperiksa).toBeGreaterThan(0);
  });
});
