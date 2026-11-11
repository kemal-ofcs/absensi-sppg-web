import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALASAN_BAWAAN,
  akhirMasaSp,
  BATALKAN_SQL,
  BERLAKUKAN_SQL,
  type IsianRincian,
  KARYAWAN_REKAP_SQL,
  kelipatanUp,
  kelipatanUpmk,
  MAKS_PENGALI,
  type MasukanPesangon,
  masaKerjaBulan,
  PENGAJUAN_SESUDAH_SQL,
  PESAN_SUDAH_KELUAR,
  PESAN_SUPERADMIN_TERAKHIR,
  PINJAMAN_PERSONIL_SQL,
  periksaTingkat,
  periksaUpah,
  SEED_ALASAN_SQL,
  type SpRingkas,
  STATUS_AKTIF_KELUAR_SQL,
  statusKeluar,
  statusSp,
  susunRincian,
  TANGGAL_SELESAI_KELUAR_SQL,
  usulanPesangon,
  usulanTingkat,
  usulanUpahPokok,
  validasiAlasan,
  validasiKeluar,
  validasiSp,
} from "./hr-keluar";

// Vektor yang sama dengan `mod tests` di `desktop/hr_keluar.rs`.

const pesan = (hasil: { ok: boolean; pesan?: string }) =>
  hasil.ok ? null : hasil.pesan;

const sp = (
  tingkat: string,
  tanggal: string,
  berlaku_sampai: string,
  dicabut = false,
): SpRingkas => ({ tingkat, tanggal, berlaku_sampai, dicabut });

const masukan = (ubah: Partial<MasukanPesangon> = {}): MasukanPesangon => ({
  upah: 0,
  masa_kerja_mulai: null,
  tanggal_terakhir: "",
  pengali_up: 0,
  pengali_upmk: 0,
  uph: false,
  kompensasi_pkwt: false,
  uang_pisah: false,
  sisa_cuti: 0,
  upah_harian: 0,
  pkwt_mulai: null,
  ...ubah,
});

const dasarPesangon = masukan({
  upah: 5_000_000,
  masa_kerja_mulai: "2020-03-15",
  tanggal_terakhir: "2026-03-14",
  pengali_up: 50,
  pengali_upmk: 100,
  uph: true,
  sisa_cuti: 4,
  upah_harian: 200_000,
});

describe("hr-keluar", () => {
  test("teks SQL kembar dengan Rust", () => {
    for (const dir of ["desktop", "mobile"]) {
      const lokasi = [
        join(import.meta.dir, `../../../src-tauri/src/${dir}/hr_keluar.rs`),
        join(
          import.meta.dir,
          `../../../../mobile/src-tauri/src/${dir}/hr_keluar.rs`,
        ),
      ].find(existsSync);
      if (!lokasi) continue;
      const rust = readFileSync(lokasi, "utf8").replaceAll("\r\n", "\n");
      for (const sql of [
        SEED_ALASAN_SQL,
        PINJAMAN_PERSONIL_SQL,
        KARYAWAN_REKAP_SQL,
        STATUS_AKTIF_KELUAR_SQL,
        TANGGAL_SELESAI_KELUAR_SQL,
        PESAN_SUDAH_KELUAR,
        PENGAJUAN_SESUDAH_SQL,
        ...BERLAKUKAN_SQL,
        ...BATALKAN_SQL,
        PESAN_SUPERADMIN_TERAKHIR,
      ]) {
        expect(rust).toContain(sql);
      }
    }
  });

  test("masa dan status SP", () => {
    expect(akhirMasaSp("2026-01-10", 6)).toBe("2026-07-09");
    expect(akhirMasaSp("2026-08-31", 6)).toBe("2027-02-27");
    expect(statusSp("2026-01-10", "2026-07-09", false, "2026-07-09")).toBe(
      "Berlaku",
    );
    expect(statusSp("2026-01-10", "2026-07-09", false, "2026-07-10")).toBe(
      "Berakhir",
    );
    expect(statusSp("2026-01-10", "2026-07-09", true, "2026-03-01")).toBe(
      "Dicabut",
    );
  });

  test("eskalasi SP", () => {
    const hasil = (daftar: SpRingkas[], tanggal: string) => {
      const u = usulanTingkat(daftar, tanggal);
      return [u.tingkat, u.sp3_berlaku];
    };
    expect(hasil([], "2026-03-01")).toEqual(["SP1", false]);
    const satu = sp("SP1", "2026-01-10", "2026-07-09");
    expect(hasil([satu], "2026-03-01")).toEqual(["SP2", false]);
    expect(hasil([satu], "2026-08-01")).toEqual(["SP1", false]);
    expect(
      hasil([sp("SP1", "2026-01-10", "2026-07-09", true)], "2026-03-01"),
    ).toEqual(["SP1", false]);
    const dua = sp("SP2", "2026-02-01", "2026-07-31");
    expect(hasil([satu, dua], "2026-03-01")).toEqual(["SP3", false]);
    const tiga = sp("SP3", "2026-02-15", "2026-08-14");
    expect(hasil([satu, dua, tiga], "2026-03-01")).toEqual(["SP3", true]);
    expect(periksaTingkat("SP2", "SP2", null).ok).toBe(true);
    expect(pesan(periksaTingkat("SP1", "SP2", null))).toBe(
      "Tingkat berbeda dari usulan (SP2); alasannya wajib diisi.",
    );
    expect(periksaTingkat("SP1", "SP2", "Pelanggaran ringan").ok).toBe(true);
  });

  test("validasi SP", () => {
    const dasar = {
      id_karyawan: "K1",
      tingkat: "SP1",
      tanggal: "2026-03-01",
      pelanggaran: " Terlambat 5 kali ",
      penanda_nama: "Sari",
      penanda_jabatan: "HRD",
    };
    const sah = validasiSp(dasar, "2026-03-01");
    expect(sah.ok && sah.nilai.pelanggaran).toBe("Terlambat 5 kali");
    expect(sah.ok && sah.nilai.nomor).toBe(null);
    const ubah = (kunci: string, nilai: unknown) =>
      pesan(validasiSp({ ...dasar, [kunci]: nilai }, "2026-03-01"));
    expect(ubah("tingkat", "SP4")).toBe("Tingkat SP tidak dikenal.");
    expect(ubah("tanggal", "2026-03-02")).toBe(
      "Tanggal SP tidak boleh di masa depan.",
    );
    expect(ubah("pelanggaran", " ")).toBe("Pelanggaran wajib diisi.");
    expect(ubah("penanda_nama", null)).toBe("Nama penanda tangan wajib diisi.");
    expect(ubah("nomor", "x".repeat(101))).toBe(
      "Nomor surat maksimal 100 karakter.",
    );
  });

  test("status keluar", () => {
    expect(statusKeluar("2026-03-31", false, false, "2026-03-30")).toBe(
      "Dijadwalkan",
    );
    expect(statusKeluar("2026-03-31", false, false, "2026-03-31")).toBe(
      "Jatuh tempo",
    );
    expect(statusKeluar("2026-03-31", true, false, "2026-04-02")).toBe(
      "Berlaku",
    );
    expect(statusKeluar("2026-03-31", true, true, "2026-04-02")).toBe(
      "Dibatalkan",
    );
  });

  test("masa kerja dan kelipatan", () => {
    expect(masaKerjaBulan("2020-03-15", "2026-03-14")).toBe(72);
    expect(masaKerjaBulan("2020-03-15", "2026-03-13")).toBe(71);
    expect(masaKerjaBulan("2024-01-31", "2024-02-27")).toBe(0);
    expect(masaKerjaBulan("2024-01-31", "2024-02-28")).toBe(1);
    expect(masaKerjaBulan("2026-05-01", "2026-04-01")).toBe(0);
    expect([0, 1, 7, 8, 30].map(kelipatanUp)).toEqual([1, 2, 8, 9, 9]);
    expect([2, 3, 5, 6, 21, 23, 24].map(kelipatanUpmk)).toEqual([
      0, 2, 2, 3, 8, 8, 10,
    ]);
    expect(usulanUpahPokok("FLAT_DAILY", 150_000, 99)).toBe(4_500_000);
    expect(usulanUpahPokok("HOURLY", 99, 20_000)).toBe(3_460_000);
  });

  test("usulan pesangon", () => {
    const ringkas = (m: MasukanPesangon) =>
      usulanPesangon(m).map((u) => [u.komponen, u.usulan]);
    const hasil = usulanPesangon(dasarPesangon);
    expect(ringkas(dasarPesangon)).toEqual([
      ["UP", 17_500_000],
      ["UPMK", 15_000_000],
      ["UPH Cuti", 800_000],
      ["UPH Ongkos Pulang", 0],
      ["UPH Lainnya", 0],
      ["Lainnya", 0],
    ]);
    expect(hasil[0].dasar).toBe("Masa kerja 6 tahun: 7 × upah × 50%");
    expect(hasil[2].dasar).toBe("Sisa cuti 4 hari × upah harian");

    // PKWT 7 bulan, pembulatan setengah ke atas: 3.333.333 × 7 / 12.
    const pkwt = masukan({
      upah: 3_333_333,
      tanggal_terakhir: "2026-07-31",
      kompensasi_pkwt: true,
      uang_pisah: true,
      pkwt_mulai: "2026-01-01",
    });
    expect(ringkas(pkwt)).toEqual([
      ["UP", 0],
      ["UPMK", 0],
      ["Kompensasi PKWT", 1_944_444],
      ["Uang Pisah", 0],
      ["Lainnya", 0],
    ]);
    expect(usulanPesangon(pkwt)[0].dasar).toBe("Tanggal masuk kosong");
    expect(usulanPesangon(pkwt)[2].dasar).toBe("PKWT 7 bulan: upah × 7 / 12");

    // Pengali 175% atas upah ganjil: 1.234.567 × 2 × 175 / 100 = 4.320.984,5.
    const pensiun = usulanPesangon(
      masukan({
        upah: 1_234_567,
        masa_kerja_mulai: "2025-01-01",
        tanggal_terakhir: "2026-06-30",
        pengali_up: 175,
        pengali_upmk: 100,
      }),
    );
    expect(pensiun[0].usulan).toBe(4_320_985);
    expect(pensiun[1].usulan).toBe(0);
  });

  test("susun rincian", () => {
    const usulan = usulanPesangon(dasarPesangon);
    const apaAdanya = susunRincian(usulan, []);
    expect(apaAdanya.ok && apaAdanya.nilai.length).toBe(6);
    expect(
      apaAdanya.ok && [apaAdanya.nilai[0].nominal, apaAdanya.nilai[0].urutan],
    ).toEqual([17_500_000, 1]);
    const isi = (
      komponen: string,
      nominal: number,
      alasan_ubah: string | null,
    ): IsianRincian => ({ komponen, nominal, alasan_ubah });
    expect(pesan(susunRincian(usulan, [isi("UP", 20_000_000, null)]))).toBe(
      "Nominal UP berbeda dari usulan; alasannya wajib diisi.",
    );
    const diubah = susunRincian(usulan, [
      isi("UP", 20_000_000, "PKB"),
      isi("UPMK", 15_000_000, "x"),
    ]);
    expect(diubah.ok && diubah.nilai[0].alasan_ubah).toBe("PKB");
    expect(diubah.ok && diubah.nilai[1].alasan_ubah).toBe(null);
    expect(pesan(susunRincian(usulan, [isi("Uang Pisah", 1, "x")]))).toBe(
      "Komponen 'Uang Pisah' tidak berlaku untuk alasan ini.",
    );
  });

  test("validasi keluar", () => {
    const dasar = {
      id_karyawan: "K1",
      id_alasan: "klr-resign",
      tanggal_terakhir: "2026-03-31",
    };
    const sah = validasiKeluar(dasar);
    expect(
      sah.ok && [
        sah.nilai.upah_pokok,
        sah.nilai.tunjangan_tetap,
        sah.nilai.kartu_ditarik,
      ],
    ).toEqual([null, 0, false]);
    const ubah = (kunci: string, nilai: unknown) =>
      pesan(validasiKeluar({ ...dasar, [kunci]: nilai }));
    expect(ubah("tanggal_terakhir", "31-03-2026")).toBe(
      "Tanggal hari kerja terakhir tidak valid.",
    );
    expect(ubah("tanggal_pemberitahuan", "2026-04-01")).toBe(
      "Tanggal pemberitahuan tidak boleh sesudah hari kerja terakhir.",
    );
    expect(ubah("upah_pokok", -1)).toBe("Upah pokok tidak valid.");
    expect(ubah("upah_pokok", 1.5)).toBe("Upah pokok tidak valid.");
    expect(ubah("tunjangan_tetap", 1_000_000_001)).toBe(
      "Tunjangan tetap tidak valid.",
    );
    expect(ubah("rincian", [{ komponen: "Bonus", nominal: 1 }])).toBe(
      "Komponen rincian tidak dikenal.",
    );
    expect(
      ubah("rincian", [
        { komponen: "UP", nominal: 1 },
        { komponen: "UP", nominal: 2 },
      ]),
    ).toBe("Komponen UP tercantum dua kali.");
    expect(pesan(periksaUpah(1, 2, null))).toBe(
      "Upah pokok berbeda dari usulan; alasannya wajib diisi.",
    );
    expect(periksaUpah(2, 2, null).ok).toBe(true);
  });

  test("validasi alasan", () => {
    const sah = validasiAlasan({
      nama: " Mutasi ",
      pengali_up: 100,
      pengali_upmk: 0,
    });
    expect(
      sah.ok && [
        sah.nilai.nama,
        sah.nilai.uph,
        sah.nilai.kompensasi_pkwt,
        sah.nilai.is_aktif,
      ],
    ).toEqual(["Mutasi", true, false, true]);
    expect(
      pesan(validasiAlasan({ nama: "X", pengali_up: 1001, pengali_upmk: 0 })),
    ).toBe("Pengali UP harus bilangan bulat 0–1000 (persen).");
    expect(ALASAN_BAWAAN.length).toBe(8);
    expect(
      ALASAN_BAWAAN.every(
        (a) => a.pengali_up >= 0 && a.pengali_up <= MAKS_PENGALI,
      ),
    ).toBe(true);
  });
});
