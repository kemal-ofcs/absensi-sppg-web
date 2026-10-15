import { describe, expect, test } from "bun:test";
import {
  tabelArusKas,
  tabelPosisi,
} from "@/components/keuangan/eksporKeuangan";

describe("tabel laporan keuangan", () => {
  const posisi = {
    sampai: "2026-10-14",
    aset: [{ id_akun: "akun-kas", kode: "1101", nama: "Kas", saldo: 900_000 }],
    kewajiban: [],
    ekuitas: [],
    laba_berjalan: 1_000_000,
    total_aset: 900_000,
    total_kewajiban: 0,
    total_ekuitas: 1_000_000,
    selisih: -100_000,
  };

  test("posisi timpang membawa peringatan, seimbang tidak", () => {
    expect(tabelPosisi(posisi).peringatan).toContain("tidak seimbang");
    expect(
      tabelPosisi({ ...posisi, total_aset: 1_000_000, selisih: 0 }).peringatan,
    ).toBeNull();
    expect(tabelPosisi(posisi).periode).toBe("Per 14/10/2026");
  });

  test("arus kas memisah kelompok masuk dan keluar", () => {
    const t = tabelArusKas({
      dari: "2026-10-01",
      sampai: "2026-10-31",
      akun_kas: [{ id_akun: "akun-kas", kode: "1101", nama: "Kas" }],
      saldo_awal: 100,
      kelompok: [
        {
          sumber: "Manual",
          label: "Jurnal umum",
          masuk: 600,
          keluar: 100,
          bersih: 500,
        },
        {
          sumber: "Payroll",
          label: "Pembayaran gaji",
          masuk: 0,
          keluar: 200,
          bersih: -200,
        },
      ],
      total_masuk: 600,
      total_keluar: 300,
      saldo_akhir: 400,
    });
    const label = t.baris.map((b) => b.label);
    expect(label.indexOf("Jurnal umum")).toBeLessThan(
      label.indexOf("Pengeluaran kas"),
    );
    expect(label.indexOf("Pembayaran gaji")).toBeGreaterThan(
      label.indexOf("Pengeluaran kas"),
    );
    expect(
      t.baris.find((b) => b.label === "Kenaikan (penurunan) kas")?.jumlah,
    ).toBe(300);
    // Kas keluar dalam kelompok yang sama mengurangi penerimaannya.
    expect(t.baris.filter((b) => b.label === "Jurnal umum")).toEqual([
      { jenis: "akun", label: "Jurnal umum", jumlah: 500 },
    ]);
  });
});
