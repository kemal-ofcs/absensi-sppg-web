import { describe, expect, test } from "bun:test";
import { buildXlsxBuffer } from "./excel-export";
import {
  firstSheetPath,
  parseCsv,
  parseSharedStrings,
  parseSheet,
  readWorkbookTable,
} from "./xlsx";

describe("parseCsv", () => {
  test("BOM, pemisah titik koma, kutip ganda, dan baris baru dalam kutip", () => {
    const { rows, selAngka } = parseCsv(
      '﻿kode;nama;catatan\r\nA1;"Meja ""Jati""";"baris 1\nbaris 2"\r\n\r\n;;\r\nA2;Kursi;',
    );
    expect(rows).toEqual([
      ["kode", "nama", "catatan"],
      ["A1", 'Meja "Jati"', "baris 1\nbaris 2"],
      ["A2", "Kursi", ""],
    ]);
    expect(selAngka.flat().every((angka) => !angka)).toBe(true);
  });

  test("pemisah koma tetap dikenali", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseSheet", () => {
  const shared = parseSharedStrings(
    '<sst><si><t>Nama</t></si><si><r><t>Ka</t></r><r><t xml:space="preserve">rung </t></r><rPh><t>カ</t></rPh></si><si/></sst>',
  );

  test("shared string berformat digabung, teks fonetik dibuang", () => {
    expect(shared).toEqual(["Nama", "Karung", ""]);
  });

  test("tipe sel, kolom yang dilompati, entitas, dan penanda Angka", () => {
    const { rows, selAngka } = parseSheet(
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>A &amp; B</t></is></c></row>
        <row r="2"/>
        <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><f>A1*2</f><v>1.234</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="str"><v>teks</v></c><c r="E3" s="1"/></row>
      </sheetData></worksheet>`,
      shared,
    );
    expect(rows).toEqual([
      ["Nama", "", "A & B"],
      ["Karung", "1.234", "TRUE", "teks", ""],
    ]);
    expect(selAngka).toEqual([
      [false, false, false],
      [false, true, false, false, false],
    ]);
  });
});

describe("firstSheetPath", () => {
  test("mengikuti urutan tab di workbook.xml, bukan nama berkas", () => {
    const entries = new Map([
      [
        "xl/workbook.xml",
        '<workbook><sheets><sheet name="Barang" sheetId="2" r:id="rId7"/><sheet name="Lain" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ],
      [
        "xl/_rels/workbook.xml.rels",
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="/xl/worksheets/sheet7.xml"/></Relationships>',
      ],
      ["xl/worksheets/sheet1.xml", ""],
      ["xl/worksheets/sheet7.xml", ""],
    ]);
    expect(firstSheetPath(entries)).toBe("xl/worksheets/sheet7.xml");
  });

  test("tanpa workbook.xml jatuh ke sheet1 lalu sheet pertama", () => {
    expect(firstSheetPath(new Map([["xl/worksheets/sheet3.xml", ""]]))).toBe(
      "xl/worksheets/sheet3.xml",
    );
    expect(firstSheetPath(new Map())).toBeNull();
  });
});

describe("readWorkbookTable", () => {
  test("membaca kembali berkas yang ditulis excel-export", async () => {
    const bytes = buildXlsxBuffer(
      "Barang",
      ["Kode", "Nama"],
      [["A1", "Meja <Jati>"]],
    );
    const file = new File([bytes as unknown as BlobPart], "barang.XLSX");
    const { rows } = await readWorkbookTable(file);
    expect(rows).toEqual([
      ["Kode", "Nama"],
      ["A1", "Meja <Jati>"],
    ]);
  });

  test("berkas yang bukan zip ditolak dengan pesan jelas", async () => {
    const file = new File(["bukan excel"], "rusak.xlsx");
    await expect(readWorkbookTable(file)).rejects.toThrow(
      "Format file Excel (.xlsx) tidak valid atau file rusak.",
    );
  });
});
