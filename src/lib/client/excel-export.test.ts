import { describe, expect, test } from "bun:test";
import { AngkaExcel, buildXlsxBuffer, buildXlsxWorkbook } from "./excel-export";
import { readWorkbookTable } from "./xlsx";

describe("buildXlsxBuffer", () => {
  test("AngkaExcel terbaca kembali sebagai sel Angka; nilai lain tetap teks", async () => {
    const bytes = buildXlsxBuffer(
      "Uji",
      ["Kode", "Saldo", "NIK"],
      [["BRG-1", new AngkaExcel(10.25), "0012"]],
    );
    const { rows, selAngka } = await readWorkbookTable(
      new File([bytes as unknown as BlobPart], "uji.xlsx"),
    );
    expect(rows[1]).toEqual(["BRG-1", "10.25", "0012"]);
    expect(selAngka[1]).toEqual([false, true, false]);
  });
});

describe("buildXlsxWorkbook", () => {
  test("beberapa sheet: sheet pertama terbaca, pane beku dan lebar tertulis", async () => {
    const bytes = buildXlsxWorkbook([
      {
        nama: "Rekap",
        headers: ["No", "Nama", "1 Sen"],
        rows: [[new AngkaExcel(1), "Ani", "H"]],
        lebar: [5, 30, 7],
        kolomBeku: 2,
      },
      { nama: "Detail", headers: ["Tanggal"], rows: [["2026-10-05"]] },
    ]);
    const { rows } = await readWorkbookTable(
      new File([bytes as unknown as BlobPart], "uji.xlsx"),
    );
    expect(rows).toEqual([
      ["No", "Nama", "1 Sen"],
      ["1", "Ani", "H"],
    ]);
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain('<sheet name="Detail" sheetId="2" r:id="rId2"/>');
    expect(xml).toContain('<pane xSplit="2" ySplit="1" topLeftCell="C2"');
    expect(xml).toContain('<col min="2" max="2" width="30" customWidth="1"/>');
  });
});
