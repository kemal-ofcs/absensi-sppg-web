import { describe, expect, test } from "bun:test";
import type { BarangInventaris, KolomInventaris } from "./inventory";
import {
  INVENTARIS_WORKBOOK_HEADERS,
  judulAsing,
  parseInventarisRows,
} from "./inventory-import";

const HARI_INI = "2026-10-21";

function barang(isi: Partial<BarangInventaris>): BarangInventaris {
  return {
    id_barang: "brg-1",
    kode_barang: "INV-0001",
    nama_barang: "Spidol",
    kategori: "ATK",
    tipe: "Habis Pakai",
    satuan: "pcs",
    bisa_expired: false,
    desimal: false,
    punya_mutasi: true,
    stok_minimum: 5,
    tempat_utama: "Gudang",
    catatan: "Lama",
    status_aktif: true,
    kode_ganda: false,
    stok_total: 10,
    stok_baik: 10,
    stok_menipis: false,
    posisi: [],
    dilacak_unit: false,
    atribut: {},
    ...isi,
  };
}

function sheet(...rows: Record<string, string>[]): string[][] {
  const headers = [...INVENTARIS_WORKBOOK_HEADERS];
  return [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
}

describe("parseInventarisRows", () => {
  test("barang baru tanpa kode membawa saldo awal di tempat utama", () => {
    const [row] = parseInventarisRows(
      sheet({
        "Nama barang": "Kertas A4",
        Tipe: "habis pakai",
        Satuan: "rim",
        "Tempat utama": "Gudang",
        "Saldo awal": "20",
      }),
      [],
      HARI_INI,
    );
    expect(row.baris).toBe(2);
    expect(row.draft.baru).toBe(true);
    expect(row.draft.barang.kode_barang).toBeNull();
    expect(row.draft.barang.tipe).toBe("Habis Pakai");
    expect(row.draft.saldo).toMatchObject({
      jenis: "Masuk",
      alasan: "Saldo Awal",
      jumlah: 20,
      tempat_tujuan: "Gudang",
      kondisi_tujuan: "Baik",
    });
  });

  test("saldo awal berformat Indonesia harus bulat; sel Angka bertitik desimal", () => {
    const baru = (saldo: string, selAngka: boolean[][] = []) =>
      parseInventarisRows(
        sheet({
          "Nama barang": "Beras",
          Tipe: "Habis Pakai",
          Satuan: "gram",
          "Tempat utama": "Gudang",
          "Saldo awal": saldo,
          "Stok minimum": "1.000",
        }),
        [],
        HARI_INI,
        [],
        selAngka,
      )[0].draft;
    expect(baru("10.000").saldo?.jumlah).toBe(10000);
    expect(baru("10.000,00").saldo?.jumlah).toBe(10000);
    expect(baru("1.000.000").saldo?.jumlah).toBe(1000000);
    expect(baru("15,0").saldo?.jumlah).toBe(15);
    expect(baru("10.000").barang.stok_minimum).toBe(1000);
    expect(() => baru("10,22")).toThrow("isi kolom Desimal dengan Ya");
    expect(() => baru("10.22")).toThrow("Saldo awal '10.22'");
    expect(() => baru("1.0000")).toThrow("Saldo awal '1.0000'");
    // Sel Angka Excel 10.5 berarti sepuluh setengah, bukan 105.
    const kolomSaldo = INVENTARIS_WORKBOOK_HEADERS.indexOf("Saldo awal");
    const sel = [
      [],
      Array.from({ length: kolomSaldo + 1 }, (_, i) => i === kolomSaldo),
    ];
    expect(() => baru("10.500", sel)).toThrow("Saldo awal '10.500'");
    expect(baru("10500", sel).saldo?.jumlah).toBe(10500);
  });

  test("kolom Desimal: koma diterima, Aset ditolak, barang bermutasi dipertahankan", () => {
    const [row] = parseInventarisRows(
      sheet({
        "Nama barang": "Beras",
        Tipe: "Habis Pakai",
        Satuan: "kg",
        Desimal: "ya",
        "Tempat utama": "Gudang",
        "Stok minimum": "2,5",
        "Saldo awal": "1.250,75",
      }),
      [],
      HARI_INI,
    );
    expect(row.draft.barang.desimal).toBe(true);
    expect(row.draft.barang.stok_minimum).toBe(250);
    expect(row.draft.saldo?.jumlah).toBe(125075);
    expect(() =>
      parseInventarisRows(
        sheet({
          "Nama barang": "Laptop",
          Tipe: "Aset",
          Satuan: "unit",
          Desimal: "Ya",
        }),
        [],
        HARI_INI,
      ),
    ).toThrow("Baris 2: Jumlah desimal hanya untuk barang Habis Pakai.");
    expect(() =>
      parseInventarisRows(
        sheet({
          "Nama barang": "Beras",
          Tipe: "Habis Pakai",
          Satuan: "kg",
          Desimal: "Kadang",
        }),
        [],
        HARI_INI,
      ),
    ).toThrow("Desimal 'Kadang' harus Ya atau Tidak.");
    expect(() =>
      parseInventarisRows(
        sheet({
          "Nama barang": "Beras",
          Tipe: "Habis Pakai",
          Satuan: "kg",
          Desimal: "Ya",
          "Saldo awal": "1,255",
        }),
        [],
        HARI_INI,
      ),
    ).toThrow("paling banyak 2 angka di belakang koma");

    // Barang lama bermutasi: Desimal di file berbeda → nilai lama dipertahankan.
    const [lama] = parseInventarisRows(
      sheet({
        Kode: "INV-0001",
        "Nama barang": "Spidol",
        Tipe: "Habis Pakai",
        Satuan: "pcs",
        Desimal: "Ya",
        "Stok minimum": "7",
      }),
      [barang({})],
      HARI_INI,
    );
    expect(lama.draft.desimalDiabaikan).toBe(true);
    expect(lama.draft.barang.desimal).toBe(false);
    expect(lama.draft.barang.stok_minimum).toBe(7);
    // Belum bermutasi: boleh diubah.
    const [bebas] = parseInventarisRows(
      sheet({
        Kode: "INV-0001",
        "Nama barang": "Spidol",
        Tipe: "Habis Pakai",
        Satuan: "pcs",
        Desimal: "Ya",
        "Stok minimum": "7",
      }),
      [barang({ punya_mutasi: false })],
      HARI_INI,
    );
    expect(bebas.draft.desimalDiabaikan).toBe(false);
    expect(bebas.draft.barang.stok_minimum).toBe(700);
  });

  test("kode yang sudah ada mengubah barang itu dan tidak menambah stok", () => {
    const [row] = parseInventarisRows(
      sheet({
        Kode: "inv-0001",
        "Nama barang": "Spidol Hitam",
        Tipe: "Habis Pakai",
        Satuan: "pcs",
        "Saldo awal": "50",
        "Tempat saldo": "Gudang",
      }),
      [barang({})],
      HARI_INI,
    );
    expect(row.draft.baru).toBe(false);
    expect(row.draft.barang.id_barang).toBe("brg-1");
    expect(row.draft.barang.nama_barang).toBe("Spidol Hitam");
    // Kolom ada tapi kosong: dikosongkan.
    expect(row.draft.barang.catatan).toBe("");
    expect(row.draft.saldo).toBeNull();
    expect(row.draft.saldoDiabaikan).toBe(true);
  });

  test("kolom yang tidak ada di judul mempertahankan nilai lama", () => {
    const [row] = parseInventarisRows(
      [
        ["Kode", "Nama barang"],
        ["INV-0001", "Spidol Biru"],
      ],
      [barang({ status_aktif: false })],
      HARI_INI,
    );
    expect(row.draft.barang).toMatchObject({
      nama_barang: "Spidol Biru",
      kategori: "ATK",
      satuan: "pcs",
      stok_minimum: 5,
      catatan: "Lama",
      status_aktif: false,
    });
  });

  test("kode ganda di database atau di file menolak seluruh berkas", () => {
    expect(() =>
      parseInventarisRows(
        sheet({
          Kode: "INV-0001",
          "Nama barang": "A",
          Tipe: "Aset",
          Satuan: "unit",
        }),
        [barang({}), barang({ id_barang: "brg-2" })],
        HARI_INI,
      ),
    ).toThrow("dipakai 2 barang");
    expect(() =>
      parseInventarisRows(
        sheet(
          { Kode: "X-1", "Nama barang": "A", Tipe: "Aset", Satuan: "unit" },
          { Kode: "x-1", "Nama barang": "B", Tipe: "Aset", Satuan: "unit" },
        ),
        [],
        HARI_INI,
      ),
    ).toThrow("Baris 3: Kode 'x-1' muncul dua kali");
  });

  test("tipe, angka, dan validasi barang ditolak dengan nomor baris", () => {
    expect(() =>
      parseInventarisRows(
        sheet({ "Nama barang": "A", Tipe: "Modal", Satuan: "unit" }),
        [],
        HARI_INI,
      ),
    ).toThrow("Baris 2: Tipe 'Modal'");
    expect(() =>
      parseInventarisRows(
        sheet({
          "Nama barang": "A",
          Tipe: "Aset",
          Satuan: "unit",
          "Stok minimum": "2.5",
        }),
        [],
        HARI_INI,
      ),
    ).toThrow("Stok minimum '2.5'");
    expect(() =>
      parseInventarisRows(
        sheet({ "Nama barang": "A", Tipe: "Aset" }),
        [],
        HARI_INI,
      ),
    ).toThrow("Baris 2: Satuan wajib diisi.");
  });

  test("saldo barang kedaluwarsa butuh tanggal; nomor seri Excel diterima", () => {
    const isi = {
      "Nama barang": "Paracetamol",
      Tipe: "Habis Pakai",
      Satuan: "strip",
      "Bisa kedaluwarsa": "Ya",
      "Saldo awal": "3",
      "Tempat saldo": "UKS",
    };
    expect(() => parseInventarisRows(sheet(isi), [], HARI_INI)).toThrow(
      "Tanggal kedaluwarsa wajib diisi",
    );
    const [row] = parseInventarisRows(
      sheet({ ...isi, "Tanggal kedaluwarsa": "46388" }),
      [],
      HARI_INI,
    );
    expect(row.draft.saldo?.tanggal_expired).toBe("2027-01-01");
  });

  test("baris kosong dilewati tanpa menggeser nomor baris", () => {
    const rows = parseInventarisRows(
      sheet(
        {},
        {
          "Nama barang": "Meja",
          Tipe: "Aset",
          Satuan: "unit",
          Kondisi: "rusak ringan",
          "Saldo awal": "1",
          "Tempat utama": "Kelas",
        },
      ),
      [],
      HARI_INI,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].baris).toBe(3);
    expect(rows[0].draft.saldo?.kondisi_tujuan).toBe("Rusak Ringan");
  });
});

const KOLOM: KolomInventaris[] = [
  {
    id_kolom: "kol-a1",
    nama: "Merek",
    tipe: "Teks",
    is_aktif: true,
    nama_ganda: false,
  },
  {
    id_kolom: "kol-b2",
    nama: "Berat (kg)",
    tipe: "Angka",
    is_aktif: true,
    nama_ganda: false,
  },
  {
    id_kolom: "kol-c3",
    nama: "Warna",
    tipe: "Teks",
    is_aktif: false,
    nama_ganda: false,
  },
];

describe("kolom tambahan di impor", () => {
  const judul = [
    "Kode",
    "Nama barang",
    "Tipe",
    "Satuan",
    "merek",
    "Berat  (kg)",
  ];

  test("teks, angka berformat Indonesia, dan sel Angka Excel", () => {
    const rows = parseInventarisRows(
      [
        judul,
        ["", "Timbangan", "Aset", "unit", " Camry ", "1.250,5"],
        ["", "Karung", "Aset", "unit", "", "1.234"],
      ],
      [],
      HARI_INI,
      KOLOM,
      [[], [], [false, false, false, false, false, true]],
    );
    expect(rows[0].draft.barang.atribut).toEqual({
      "kol-a1": "Camry",
      "kol-b2": "1250.5",
    });
    // Sel Angka: titik adalah desimal, bukan pemisah ribuan.
    expect(rows[1].draft.barang.atribut).toEqual({ "kol-b2": "1.234" });
  });

  test("titik desimal pada sel teks ditolak, tidak ditebak", () => {
    expect(() =>
      parseInventarisRows(
        [judul, ["", "Karung", "Aset", "unit", "", "2.5"]],
        [],
        HARI_INI,
        KOLOM,
      ),
    ).toThrow(
      "Baris 2: Berat (kg) '2.5' bukan angka. Pakai koma untuk desimal",
    );
  });

  test("judul absen dipertahankan, sel kosong dikosongkan, kolom nonaktif tidak disentuh", () => {
    const lama = barang({
      atribut: { "kol-a1": "Pilot", "kol-b2": "3", "kol-c3": "Merah" },
    });
    const [row] = parseInventarisRows(
      [
        ["Kode", "Nama barang", "Merek", "Warna"],
        ["INV-0001", "Spidol", "", "Biru"],
      ],
      [lama],
      HARI_INI,
      KOLOM,
    );
    expect(row.draft.barang.atribut).toEqual({
      "kol-b2": "3",
      "kol-c3": "Merah",
    });
  });

  test("dua kolom aktif bernama sama menolak berkas yang memuat judulnya", () => {
    const ganda: KolomInventaris[] = [
      ...KOLOM,
      {
        id_kolom: "kol-d4",
        nama: "MEREK",
        tipe: "Teks",
        is_aktif: true,
        nama_ganda: true,
      },
    ];
    expect(() =>
      parseInventarisRows(
        [judul, ["", "Spidol", "Aset", "unit", "Pilot", ""]],
        [],
        HARI_INI,
        ganda,
      ),
    ).toThrow("Kolom tambahan 'MEREK' ada dua");
  });

  test("judulAsing melaporkan kolom buatan sendiri dan kolom nonaktif", () => {
    expect(
      judulAsing(["No", "Kode", "nama barang", "Merek", "Warna", ""], KOLOM),
    ).toEqual(["No", "Warna"]);
  });
});
