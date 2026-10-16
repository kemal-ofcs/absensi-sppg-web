import { describe, expect, test } from "bun:test";
import {
  HARI_KERJA_SEMUA,
  hariIso,
  parseHariKerja,
  rentangTanggal,
  ringkasHariKerja,
  tanggalValid,
  validateHariKerja,
  validateLiburMassal,
  wajibMasuk,
} from "./hari-kerja";

// Vektor kembar `desktop/hari_kerja.rs`. Mengubah satu sisi berarti mengubah
// keduanya.

const galat = (hasil: { ok: boolean; error?: string }) =>
  hasil.ok ? null : hasil.error;

describe("hari kerja", () => {
  test("validasi", () => {
    expect(validateHariKerja([5, 1, 3])).toEqual({ ok: true, value: "1,3,5" });
    expect(validateHariKerja([1, 2, 3, 4, 5, 6, 7])).toEqual({
      ok: true,
      value: HARI_KERJA_SEMUA,
    });
    expect(galat(validateHariKerja([]))).toBe("Pilih minimal satu hari kerja.");
    expect(galat(validateHariKerja("1,2"))).toBe(
      "Pilih minimal satu hari kerja.",
    );
    for (const salah of [[0, 1], [1.5], ["1"]]) {
      expect(galat(validateHariKerja(salah))).toBe(
        "Hari kerja harus angka 1 (Senin) sampai 7 (Minggu).",
      );
    }
    expect(galat(validateHariKerja([2, 2]))).toBe(
      "Hari kerja tidak boleh ganda.",
    );
  });

  test("parse jatuh ke tujuh hari", () => {
    expect(parseHariKerja("1,2,3,4,5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseHariKerja(" 6 , 1 ")).toEqual([1, 6]);
    for (const rusak of [null, "", "1,8", "1,1"]) {
      expect(parseHariKerja(rusak)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  test("ringkasan untuk kartu shift", () => {
    expect(ringkasHariKerja([1, 2, 3, 4, 5, 6, 7])).toBe("Setiap hari");
    expect(ringkasHariKerja([1, 2, 3, 4, 5])).toBe("Senin s.d. Jumat");
    expect(ringkasHariKerja([1, 3, 5])).toBe("Senin, Rabu, Jumat");
    expect(ringkasHariKerja([6, 7])).toBe("Sabtu, Minggu");
  });

  test("hari ISO dan tanggal", () => {
    expect(hariIso("2026-10-15")).toBe(4);
    expect(hariIso("2026-10-18")).toBe(7);
    expect(hariIso("2026-10-19")).toBe(1);
    expect(hariIso("2024-02-29")).toBe(4);
    expect(hariIso("1999-12-31")).toBe(5);
    expect(hariIso("2026-02-29")).toBeNull();
    expect(hariIso("2026-1-05")).toBeNull();
    expect(hariIso("")).toBeNull();
    expect(tanggalValid("2028-02-29")).toBe(true);
    expect(tanggalValid("2026-13-01")).toBe(false);
  });

  test("wajib masuk", () => {
    const seninJumat = [1, 2, 3, 4, 5];
    const cek = (tanggal: string, libur: boolean, masukSaatLibur: boolean) =>
      wajibMasuk({ tanggal, hariMasuk: seninJumat, libur, masukSaatLibur });
    expect(cek("2026-10-17", false, false)).toBe(false);
    expect(cek("2026-10-16", false, false)).toBe(true);
    expect(cek("2026-10-16", true, false)).toBe(false);
    expect(cek("2026-10-16", true, true)).toBe(true);
    expect(cek("2026-10-18", true, true)).toBe(false);
    expect(cek("bukan", false, false)).toBe(true);
  });
});

describe("hari libur massal", () => {
  test("validasi", () => {
    const ok = validateLiburMassal([
      {
        tanggal: "2026-12-24",
        nama_libur: " Cuti Natal ",
        jenis_libur: "Cuti Bersama",
      },
      {
        tanggal: "2026-12-25",
        nama_libur: "Natal",
        jenis_libur: "Libur Nasional",
        keterangan: " SKB ",
      },
    ]);
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.value[0].nama_libur).toBe("Cuti Natal");
    expect(ok.value[0].keterangan).toBeNull();
    expect(ok.value[1].keterangan).toBe("SKB");

    const baris = (tanggal: string, nama: string, jenis = "Libur Khusus") => ({
      tanggal,
      nama_libur: nama,
      jenis_libur: jenis,
    });
    expect(galat(validateLiburMassal([]))).toBe(
      "Pilih minimal satu tanggal libur.",
    );
    expect(galat(validateLiburMassal(["x"]))).toBe(
      "Data hari libur tidak valid.",
    );
    expect(galat(validateLiburMassal([baris("2026-02-30", "A")]))).toBe(
      'Tanggal "2026-02-30" tidak valid.',
    );
    expect(
      galat(
        validateLiburMassal([
          baris("2026-01-01", "A"),
          baris("2026-01-01", "B"),
        ]),
      ),
    ).toBe("Tanggal 2026-01-01 tercantum dua kali.");
    expect(galat(validateLiburMassal([baris("2026-01-01", "  ")]))).toBe(
      "Nama libur 2026-01-01 wajib diisi, maksimal 120 karakter.",
    );
    expect(
      galat(validateLiburMassal([baris("2026-01-01", "A", "Libur Sekolah")])),
    ).toBe("Jenis libur 2026-01-01 tidak dikenal.");
    const banyak = rentangTanggal("2026-01-01", "2026-12-31").map((t) =>
      baris(t, "A"),
    );
    expect(galat(validateLiburMassal(banyak))).toBe(
      "Paling banyak 120 tanggal sekali simpan.",
    );
  });

  test("rentang tanggal", () => {
    expect(rentangTanggal("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(rentangTanggal("2026-05-05", "2026-05-05")).toEqual(["2026-05-05"]);
    expect(rentangTanggal("2026-05-06", "2026-05-05")).toEqual([]);
    expect(rentangTanggal("2026-02-30", "2026-03-02")).toEqual([]);
    // Lebih dari batas: berhenti satu di atas batas supaya validasi menolaknya.
    expect(rentangTanggal("2026-01-01", "2026-12-31")).toHaveLength(121);
  });
});
