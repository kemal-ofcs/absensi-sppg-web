import { describe, expect, test } from "bun:test";
import type { AngkaExcel } from "@/lib/client/excel-export";
import type {
  BarangInventaris,
  DaftarInventaris,
  PosisiStok,
} from "@/lib/validations/inventory";
import { PRESET_LEMBAR_VALIDASI, presetRekapStok, susunEkspor } from "./ekspor";

function posisi(tempat: string, saldo: number): PosisiStok {
  return {
    tempat,
    kondisi: "Baik",
    id_batch: null,
    saldo,
    tanggal_expired: null,
    sisa_hari: null,
    status_kedaluwarsa: null,
    kode_unit: null,
    nomor_seri: null,
    catatan_unit: null,
  };
}

function barang(isi: Partial<BarangInventaris>): BarangInventaris {
  return {
    id_barang: "brg-1",
    kode_barang: "INV-0001",
    nama_barang: "Kursi",
    kategori: "Mebel",
    tipe: "Aset",
    satuan: "buah",
    bisa_expired: false,
    desimal: false,
    punya_mutasi: true,
    stok_minimum: 0,
    tempat_utama: null,
    catatan: null,
    status_aktif: true,
    kode_ganda: false,
    stok_total: 42,
    stok_baik: 42,
    stok_menipis: false,
    posisi: [posisi("Ruang Rapat", 30), posisi("Gudang", 12)],
    dilacak_unit: false,
    atribut: { "kol-1": "Jati" },
    ...isi,
  };
}

const data: DaftarInventaris = {
  barang: [],
  tempat: [],
  kategori: [],
  kode_prefix: [],
  hari_ini: "2026-10-22",
  nama_perusahaan: null,
  servis: [],
  belum_lunas: [],
  kolom: [
    {
      id_kolom: "kol-1",
      nama: "Bahan",
      tipe: "Teks",
      is_aktif: true,
      nama_ganda: false,
    },
  ],
};

const angka = (nilai: unknown) => (nilai as AngkaExcel).nilai;

describe("susunEkspor", () => {
  test("lembar validasi: satu baris per barang, kuantitas digabung, kolom manual kosong", () => {
    const hasil = susunEkspor(
      data,
      [
        barang({}),
        barang({ id_barang: "brg-2", nama_barang: "Meja", posisi: [] }),
      ],
      "",
      PRESET_LEMBAR_VALIDASI,
    );
    expect(hasil.headers).toEqual([
      "No",
      "Nama barang",
      "Satuan",
      "Kuantitas",
      "Sesuai",
      "Tidak sesuai",
      "Keterangan",
    ]);
    expect(hasil.rows).toHaveLength(2);
    expect(angka(hasil.rows[0]?.No)).toBe(1);
    expect(angka(hasil.rows[0]?.Kuantitas)).toBe(42);
    expect(hasil.rows[0]?.Sesuai).toBe("");
    // Barang tanpa stok tetap tercantum supaya fisiknya ikut dicek.
    expect(hasil.rows[1]?.["Nama barang"]).toBe("Meja");
    expect(angka(hasil.rows[1]?.Kuantitas)).toBe(0);
  });

  test("kolom per posisi memecah baris; filter tempat membuang posisi lain", () => {
    const rekap = susunEkspor(data, [barang({})], "", presetRekapStok(data));
    expect(rekap.headers).toContain("Bahan");
    expect(rekap.rows.map((row) => row.Tempat)).toEqual([
      "Ruang Rapat",
      "Gudang",
    ]);
    expect(rekap.rows[0]?.Bahan).toBe("Jati");

    const perRuang = susunEkspor(data, [barang({})], "gudang", {
      kolom: ["no", "nama", "kuantitas"],
      manual: [],
    });
    expect(perRuang.rows).toHaveLength(1);
    expect(angka(perRuang.rows[0]?.Kuantitas)).toBe(12);
  });

  test("barang desimal ditulis dalam satuannya", () => {
    const hasil = susunEkspor(
      data,
      [barang({ desimal: true, posisi: [posisi("Gudang", 1025)] })],
      "",
      { kolom: ["kuantitas"], manual: [] },
    );
    expect(angka(hasil.rows[0]?.Kuantitas)).toBe(10.25);
  });

  test("menolak tanpa kolom, judul manual kosong, dan judul kembar", () => {
    expect(() => susunEkspor(data, [], "", { kolom: [], manual: [] })).toThrow(
      "Pilih minimal satu kolom.",
    );
    expect(() =>
      susunEkspor(data, [], "", { kolom: ["nama"], manual: ["  "] }),
    ).toThrow("tidak boleh kosong");
    expect(() =>
      susunEkspor(data, [], "", { kolom: ["nama"], manual: ["nama barang"] }),
    ).toThrow("dipakai dua kali");
  });
});
