import { describe, expect, test } from "bun:test";
import {
  jalankanBerurutan,
  ringkasHasil,
  saringPersonil,
  tambahTerpilih,
} from "./aturanPilihPersonil";

const DAFTAR = [
  { id_unik: "K-01", nama: "Budi", divisi: "Gudang" },
  { id_unik: "K-02", nama: "Ani", divisi: "Gudang" },
  { id_unik: "P-01", nama: "Sari", kode_karyawan: "TU-7", divisi: "Kantor" },
  { id_unik: "P-02", nama: "Dodi", divisi: "Satpam" },
];

describe("aturanPilihPersonil", () => {
  test("cari nama, id, kode, dan divisi tanpa peka huruf", () => {
    const id = (kata: string) =>
      saringPersonil(DAFTAR, kata).map((row) => row.id_unik);
    expect(id("budi")).toEqual(["K-01"]);
    expect(id("p-0")).toEqual(["P-01", "P-02"]);
    expect(id("tu-7")).toEqual(["P-01"]);
    expect(id("GUDANG")).toEqual(["K-01", "K-02"]);
    expect(id("  ")).toEqual([]);
  });

  test("tambahTerpilih tanpa duplikat dan berhenti di batas", () => {
    expect(tambahTerpilih(["A"], ["A", "B", "C", "D"], 3)).toEqual({
      hasil: ["A", "B", "C"],
      terpotong: 1,
    });
  });

  test("jalankanBerurutan mengumpulkan gagal tanpa berhenti", async () => {
    const urutan: string[] = [];
    const progres: number[] = [];
    const hasil = await jalankanBerurutan(
      ["A", "B", "C"],
      async (id) => {
        urutan.push(id);
        if (id === "B") return { sukses: false, pesan: "sudah dikunci" };
        if (id === "C") throw new Error("putus");
        return { sukses: true, pesan: "ok" };
      },
      (selesai) => progres.push(selesai),
    );
    expect(urutan).toEqual(["A", "B", "C"]);
    expect(progres).toEqual([1, 2, 3]);
    expect(hasil.berhasil).toEqual(["A"]);
    expect(ringkasHasil(hasil, (id) => `N${id}`)).toBe(
      "1 berhasil, 2 gagal: NB (sudah dikunci); NC (putus)",
    );
    expect(ringkasHasil({ berhasil: ["A"], gagal: [] }, String)).toBe(
      "1 berhasil, 0 gagal.",
    );
  });
});
