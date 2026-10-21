import { describe, expect, test } from "bun:test";
import { readEmployeeWorkbook } from "./employee-workbook";

describe("readEmployeeWorkbook", () => {
  test("CSV dari Excel Indonesia: BOM, titik koma, ekstensi huruf besar", async () => {
    const csv =
      "﻿id_unik;kode_karyawan;nama;divisi;id_shift;lp\r\n" +
      'EMP_0001;K0001;"Budi ""Bud"" Santoso";Gudang;2;P\r\n';
    const drafts = await readEmployeeWorkbook(new File([csv], "KARYAWAN.CSV"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      id_unik: "EMP_0001",
      kode_karyawan: "K0001",
      nama: 'Budi "Bud" Santoso',
      divisi: "Gudang",
      id_shift: 2,
      lp: "P",
    });
  });

  test("kolom wajib yang hilang ditolak", async () => {
    await expect(
      readEmployeeWorkbook(new File(["id_unik,nama\nEMP_1,Budi"], "k.csv")),
    ).rejects.toThrow("Kolom wajib 'kode_karyawan' tidak ditemukan");
  });
});
