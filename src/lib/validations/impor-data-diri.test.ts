import { describe, expect, test } from "bun:test";
import { KOLOM_KEUANGAN, KOLOM_PRIBADI } from "./hris";
import { gabungIsian, uraiDataDiri } from "./impor-data-diri";

const PEGAWAI = [
  { id_unik: "EMP_1", kode_karyawan: "K01", nama: "Ani" },
  { id_unik: "EMP_2", kode_karyawan: "K02", nama: "Budi" },
];
const SEMUA = { pribadi: true, keuangan: true };
const JUDUL = ["id_unik", "kode_karyawan", "nama", "nik", "agama", "bank"];

const tabel = (rows: string[][], angka: [number, number][] = []) => {
  const all = [JUDUL, ...rows];
  const selAngka = all.map((r) => r.map(() => false));
  for (const [r, c] of angka) selAngka[r][c] = true;
  return { rows: all, selAngka };
};

describe("uraiDataDiri", () => {
  test("cocok lewat id atau kode; baris tanpa isian dilewati", () => {
    const hasil = uraiDataDiri(
      tabel([
        ["EMP_1", "", "Ani", "3201234567890123", "Islam", ""],
        ["", "K02", "Budi", "", "", "BCA"],
        ["EMP_1", "K01", "Ani", "", "", ""],
      ]),
      PEGAWAI,
      SEMUA,
    );
    expect(hasil.baris).toEqual([
      {
        baris: 2,
        id_karyawan: "EMP_1",
        nama: "Ani",
        pribadi: { nik: "3201234567890123", agama: "Islam" },
        keuangan: null,
        galat: null,
      },
      {
        baris: 3,
        id_karyawan: "EMP_2",
        nama: "Budi",
        pribadi: null,
        keuangan: { bank: "BCA" },
        galat: null,
      },
    ]);
  });

  test("sel Angka di kolom nomor, isian tak sah, duplikat, dan karyawan asing jadi galat", () => {
    const hasil = uraiDataDiri(
      tabel(
        [
          ["EMP_1", "", "", "3201234567890120", "", ""],
          ["EMP_1", "", "", "", "Kepercayaan Lain", ""],
          ["EMP_X", "", "", "", "Islam", ""],
          ["K02", "K02", "", "", "Islam", ""],
          ["EMP_2", "", "", "", "Islam", ""],
        ],
        [[1, 3]],
      ),
      PEGAWAI,
      SEMUA,
    );
    const galat = hasil.baris.map((b) => [b.baris, b.galat]);
    expect(galat[0][1]).toContain("tersimpan sebagai Angka");
    expect(galat[1][1]).toBe("Agama tidak dikenal.");
    expect(galat[2][1]).toBe("Karyawan 'EMP_X' tidak ditemukan.");
    expect(galat[3]).toEqual([5, null]);
    expect(galat[4][1]).toBe("Karyawan ini sudah ada di baris 5.");
  });

  test("izin parsial mengabaikan kelompok lain dengan catatan", () => {
    const hasil = uraiDataDiri(
      tabel([["EMP_1", "", "", "", "Islam", "BCA"]]),
      PEGAWAI,
      { pribadi: false, keuangan: true },
    );
    expect(hasil.catatan).toHaveLength(1);
    expect(hasil.baris[0].pribadi).toBeNull();
    expect(hasil.baris[0].keuangan).toEqual({ bank: "BCA" });
  });

  test("tanpa kolom kunci ditolak", () => {
    expect(() =>
      uraiDataDiri(
        { rows: [["nama", "nik"]], selAngka: [[false, false]] },
        PEGAWAI,
        SEMUA,
      ),
    ).toThrow("id_unik");
  });
});

describe("gabungIsian", () => {
  test("sel berisi menimpa, sisanya nilai lama; kolom jejak tidak ikut", () => {
    const hasil = gabungIsian(
      KOLOM_PRIBADI,
      { nik: "3201234567890123", agama: "Islam", pribadi_diubah_oleh: "x" },
      { agama: "Kristen" },
    );
    expect(hasil.nik).toBe("3201234567890123");
    expect(hasil.agama).toBe("Kristen");
    expect(hasil.alamat_ktp).toBeNull();
    expect("pribadi_diubah_oleh" in hasil).toBe(false);
    expect(Object.keys(hasil)).toEqual([...KOLOM_PRIBADI]);
    expect(gabungIsian(KOLOM_KEUANGAN, {}, { bank: "BRI" }).bank).toBe("BRI");
  });
});
