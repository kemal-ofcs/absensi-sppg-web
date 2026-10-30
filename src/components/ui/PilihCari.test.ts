import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { opsiDariAnak, pisahKelas, saringOpsi } from "./PilihCari";

const option = (value: string | number, ...isi: (string | number)[]) =>
  createElement("option", { key: String(value), value }, ...isi);

describe("opsiDariAnak", () => {
  test("membaca array, Fragment, nilai angka, dan teks berpotongan", () => {
    const opsi = opsiDariAnak([
      option("", "Pilih barang"),
      null,
      false,
      [option(7, "MJA", " ", "Meja")],
      createElement(Fragment, { key: "f" }, option("k", "Kursi")),
    ]);
    expect(opsi.map((item) => [item.value, item.label])).toEqual([
      ["", "Pilih barang"],
      ["7", "MJA Meja"],
      ["k", "Kursi"],
    ]);
  });

  test("tanpa prop value, nilainya teks seperti option asli", () => {
    const opsi = opsiDariAnak(createElement("option", null, "Baik"));
    expect(opsi[0]?.value).toBe("Baik");
  });
});

describe("saringOpsi", () => {
  const opsi = opsiDariAnak([
    option("1", "Tepung (TPG)"),
    option("2", "Meja Kantor (MJA)"),
    option("3", "Kursi Kantor (KRS)"),
  ]);

  test("kata kosong mengembalikan semua", () => {
    expect(saringOpsi(opsi, "  ")).toHaveLength(3);
  });

  test("tidak peka huruf besar dan urutan kata bebas", () => {
    expect(saringOpsi(opsi, "kantor MEJA").map((o) => o.value)).toEqual(["2"]);
    expect(saringOpsi(opsi, "kantor").map((o) => o.value)).toEqual(["2", "3"]);
    expect(saringOpsi(opsi, "semen")).toEqual([]);
  });
});

describe("pisahKelas", () => {
  test("margin dan lebar ke wadah, tampilan ke kotak isian", () => {
    expect(pisahKelas("w-full mt-1 px-3 bg-slate-800 sm:w-48")).toEqual({
      wadah: "w-full mt-1 sm:w-48",
      isian: "px-3 bg-slate-800",
    });
  });

  test("tanpa kelas lebar, wadah tetap selebar induknya", () => {
    expect(pisahKelas("app-input").wadah).toBe("w-full");
  });
});
