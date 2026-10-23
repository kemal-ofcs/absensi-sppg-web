import { describe, expect, test } from "bun:test";
import {
  type DataLaporanKehadiran,
  type HariLaporan,
  susunLaporanKehadiran,
  validateRentangLaporan,
} from "./laporan-kehadiran";

describe("validateRentangLaporan", () => {
  // Vektor sama dengan `rentang_laporan_dibatasi_92_hari` di `administration.rs`.
  test.each([
    ["2026-10-01", "2026-10-01", null],
    ["2026-10-01", "2026-12-31", null],
    ["2026-10-01", "2027-01-01", "Rentang laporan paling panjang 92 hari."],
    [
      "2026-10-02",
      "2026-10-01",
      "Tanggal selesai tidak boleh sebelum tanggal mulai.",
    ],
    ["2026-02-30", "2026-03-01", "Tanggal laporan tidak valid."],
  ])("%s s.d. %s", (mulai, selesai, galat) => {
    const hasil = validateRentangLaporan(mulai, selesai);
    expect(hasil.ok ? null : hasil.error).toBe(galat);
  });
});

const hari = (
  id: string,
  tanggal: string,
  isi: Partial<HariLaporan>,
): HariLaporan => ({
  id,
  tanggal,
  hadir: 0,
  telat: 0,
  menit: 0,
  sakit: 0,
  izin: 0,
  dispensasi: 0,
  alfa: 0,
  ...isi,
});

const karyawan = { kode: "", aktif: 1, kode_shift: 1 };

/**
 * Senin 5 s.d. Minggu 11 Oktober 2026, hari ini Sabtu 10. Rabu 7 libur;
 * divisi Gudang masuk saat libur lewat whitelist. P1 kerja Senin-Jumat,
 * G1 Senin-Sabtu, K1 shift tanpa hari kerja tersimpan (tujuh hari).
 */
const DATA: DataLaporanKehadiran = {
  mulai: "2026-10-05",
  selesai: "2026-10-11",
  hari_ini: "2026-10-10",
  karyawan: [
    {
      ...karyawan,
      id: "P1",
      nama: "Putri",
      divisi: "Kantor",
      hari_kerja: "1,2,3,4,5",
    },
    { ...karyawan, id: "K1", nama: "Kiki", divisi: "Kantor", hari_kerja: null },
    {
      ...karyawan,
      id: "G1",
      nama: "Gita",
      divisi: "Gudang",
      hari_kerja: "1,2,3,4,5,6",
    },
  ],
  hari: [
    hari("P1", "2026-10-05", { hadir: 1 }),
    // Dua sesi terlambat (15 dan 5 menit): dihitung satu hari, 20 menit.
    hari("P1", "2026-10-06", { hadir: 1, telat: 15, menit: 20 }),
    hari("P1", "2026-10-08", { sakit: 1 }),
    hari("G1", "2026-10-05", { alfa: 1 }),
    hari("G1", "2026-10-06", { izin: 1 }),
    hari("G1", "2026-10-08", { dispensasi: 1 }),
    hari("G1", "2026-10-09", { hadir: 1, alfa: 1 }),
  ],
  libur: [{ tanggal: "2026-10-07", nama: "Libur Uji" }],
  whitelist: [
    {
      id: "w",
      scope_type: "DIVISI",
      scope_value: "Gudang",
      tanggal_libur: null,
      keterangan: null,
      status_aktif: 1,
    },
  ],
};

describe("susunLaporanKehadiran", () => {
  const { tanggal, baris } = susunLaporanKehadiran(DATA);

  test("tanggal inklusif, urut divisi lalu nama", () => {
    expect(tanggal).toHaveLength(7);
    expect(baris.map((b) => b.karyawan.id)).toEqual(["G1", "K1", "P1"]);
  });

  test("kode tiap sel: catatan, libur, libur mingguan, kosong, dan masa depan", () => {
    expect(baris.map((b) => b.sel.join(""))).toEqual([
      "AI-DH-",
      "--L---",
      "HTLS-M",
    ]);
    expect(baris.every((b) => b.sel[6] === "")).toBe(true);
  });

  test("total: terlambat ikut hadir, persen = hadir ÷ hari wajib masuk", () => {
    const [g1, k1, p1] = baris;
    expect(p1).toMatchObject({
      hadir: 2,
      terlambat: 1,
      menitTerlambat: 20,
      sakit: 1,
      tanpaData: 1,
      libur: 2,
      wajibMasuk: 4,
      persen: 50,
    });
    expect(g1).toMatchObject({
      hadir: 1,
      izin: 1,
      dispensasi: 1,
      alfa: 1,
      tanpaData: 2,
      libur: 0,
      wajibMasuk: 6,
      persen: 16.7,
    });
    expect(k1).toMatchObject({
      tanpaData: 5,
      libur: 1,
      wajibMasuk: 5,
      persen: 0,
    });
  });
});
