import { describe, expect, test } from "bun:test";
import { perubahanStok } from "./gaya";

const asal = { label: "Dapur · Baik", saldo: 100 };
const tujuan = { label: "Gudang · Baik", saldo: 20 };

describe("perubahanStok", () => {
  test("Keluar mengurangi posisi asal dan total", () => {
    expect(
      perubahanStok({
        jenis: "Keluar",
        jumlah: 30,
        stokTotal: 150,
        asal,
        tujuan: null,
      }),
    ).toEqual([
      { label: "Dapur · Baik", sebelum: 100, sesudah: 70 },
      { label: "Total semua tempat", sebelum: 150, sesudah: 120 },
    ]);
  });

  test("Masuk menambah tujuan dan total, tanpa posisi asal", () => {
    expect(
      perubahanStok({
        jenis: "Masuk",
        jumlah: 5,
        stokTotal: 150,
        asal,
        tujuan,
      }),
    ).toEqual([
      { label: "Gudang · Baik", sebelum: 20, sesudah: 25 },
      { label: "Total semua tempat", sebelum: 150, sesudah: 155 },
    ]);
  });

  test("Pindah menggeser dua posisi dan total tidak berubah", () => {
    expect(
      perubahanStok({
        jenis: "Pindah",
        jumlah: 10,
        stokTotal: 150,
        asal,
        tujuan,
      }),
    ).toEqual([
      { label: "Dapur · Baik", sebelum: 100, sesudah: 90 },
      { label: "Gudang · Baik", sebelum: 20, sesudah: 30 },
    ]);
  });

  test("Keluar melebihi stok tampil minus supaya bisa diperingatkan", () => {
    const hasil = perubahanStok({
      jenis: "Keluar",
      jumlah: 130,
      stokTotal: 150,
      asal,
      tujuan: null,
    });
    expect(hasil[0]?.sesudah).toBe(-30);
  });

  test("jumlah belum sah tidak menghasilkan pratinjau", () => {
    for (const jumlah of [null, 0, -1]) {
      expect(
        perubahanStok({
          jenis: "Keluar",
          jumlah,
          stokTotal: 150,
          asal,
          tujuan: null,
        }),
      ).toEqual([]);
    }
  });
});
