import { describe, expect, test } from "bun:test";
import { AngkaExcel, buildXlsxBuffer } from "./excel-export";
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
