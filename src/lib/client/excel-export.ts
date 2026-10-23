"use client";

import { type DownloadResult, saveFileWithPicker } from "./download";

// CRC-32 implementation for zero-dependency zip creation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipFileEntry {
  name: string;
  data: Uint8Array;
}

function createZipArchive(files: ZipFileEntry[]): Uint8Array {
  const textEncoder = new TextEncoder();
  const fileRecords: {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }[] = [];

  let offset = 0;
  const parts: Uint8Array[] = [];

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    fileRecords.push({ nameBytes, data: file.data, crc, offset });
    parts.push(header);
    parts.push(file.data);
    offset += header.length + size;
  }

  const centralDirStart = offset;
  let centralDirSize = 0;

  for (const rec of fileRecords) {
    const cdHeader = new Uint8Array(46 + rec.nameBytes.length);
    const cdView = new DataView(cdHeader.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 20, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    cdView.setUint32(16, rec.crc, true);
    cdView.setUint32(20, rec.data.length, true);
    cdView.setUint32(24, rec.data.length, true);
    cdView.setUint16(28, rec.nameBytes.length, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint16(32, 0, true);
    cdView.setUint16(34, 0, true);
    cdView.setUint16(36, 0, true);
    cdView.setUint32(38, 0, true);
    cdView.setUint32(42, rec.offset, true);
    cdHeader.set(rec.nameBytes, 46);

    parts.push(cdHeader);
    centralDirSize += cdHeader.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, fileRecords.length, true);
  eocdView.setUint16(10, fileRecords.length, true);
  eocdView.setUint32(12, centralDirSize, true);
  eocdView.setUint32(16, centralDirStart, true);
  eocdView.setUint16(20, 0, true);
  parts.push(eocd);

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let cur = 0;
  for (const p of parts) {
    result.set(p, cur);
    cur += p.length;
  }
  return result;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(colIndex: number): string {
  let temp = colIndex;
  let letter = "";
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Sel bertipe Angka sungguhan: bisa dijumlah di Excel dan tampil mengikuti
 * bahasa Excel pembacanya. Opt-in, karena nilai lain sengaja ditulis sebagai
 * teks: NIK atau nomor HP yang kebetulan berupa angka akan kehilangan nol
 * depannya bila menjadi sel Angka.
 */
export class AngkaExcel {
  constructor(readonly nilai: number) {}
}

export type SelExcel =
  | string
  | number
  | boolean
  | AngkaExcel
  | null
  | undefined;

export function buildXlsxBuffer(
  sheetName: string,
  headers: string[],
  rows: SelExcel[][],
): Uint8Array {
  return buildXlsxWorkbook([{ nama: sheetName || "Sheet1", headers, rows }]);
}

export interface LembarXlsx {
  /** Maksimal 31 karakter, tanpa tanda kurung siku, titik dua, *, ?, atau garis miring. */
  nama: string;
  headers: readonly string[];
  rows: readonly (readonly SelExcel[])[];
  /** Lebar kolom dalam satuan karakter Excel, sejajar `headers`. */
  lebar?: readonly number[];
  /** Baris judul dan N kolom pertama tetap terlihat saat digulir. */
  kolomBeku?: number;
}

function lembarXml(lembar: LembarXlsx): string {
  const { headers, rows, lebar, kolomBeku } = lembar;
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`;

  if (kolomBeku !== undefined) {
    const sel = `${columnLetter(kolomBeku)}2`;
    const xSplit = kolomBeku > 0 ? ` xSplit="${kolomBeku}"` : "";
    const panel = kolomBeku > 0 ? "bottomRight" : "bottomLeft";
    xml += `<sheetViews><sheetView workbookViewId="0"><pane${xSplit} ySplit="1" topLeftCell="${sel}" activePane="${panel}" state="frozen"/><selection pane="${panel}" activeCell="${sel}" sqref="${sel}"/></sheetView></sheetViews>`;
  }
  if (lebar?.length) {
    xml += `<cols>${lebar
      .map(
        (w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`,
      )
      .join("")}</cols>`;
  }

  xml += `<sheetData><row r="1">`;
  headers.forEach((header, colIdx) => {
    const cellRef = `${columnLetter(colIdx)}1`;
    xml += `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(header)}</t></is></c>`;
  });
  xml += `</row>`;

  rows.forEach((row, rowIdx) => {
    const rowNum = rowIdx + 2;
    xml += `<row r="${rowNum}">`;
    headers.forEach((_, colIdx) => {
      const cellRef = `${columnLetter(colIdx)}${rowNum}`;
      const rawVal = row[colIdx];
      if (rawVal instanceof AngkaExcel && Number.isFinite(rawVal.nilai)) {
        xml += `<c r="${cellRef}"><v>${rawVal.nilai}</v></c>`;
        return;
      }
      const val = rawVal === null || rawVal === undefined ? "" : String(rawVal);
      xml += `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
    });
    xml += `</row>`;
  });

  return `${xml}</sheetData></worksheet>`;
}

/** Rakit berkas `.xlsx` berisi beberapa sheet, urut sesuai larik. */
export function buildXlsxWorkbook(lembar: readonly LembarXlsx[]): Uint8Array {
  const encoder = new TextEncoder();
  const nomor = lembar.map((_, i) => i + 1);

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${nomor.map((n) => `  <Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${nomor.map((n) => `  <Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join("")}
</Relationships>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${lembar.map((l, i) => `    <sheet name="${escapeXml(l.nama)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}
  </sheets>
</workbook>`;

  return createZipArchive([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml) },
    { name: "_rels/.rels", data: encoder.encode(relsXml) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(wbRelsXml) },
    { name: "xl/workbook.xml", data: encoder.encode(wbXml) },
    ...lembar.map((l, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(lembarXml(l)),
    })),
  ]);
}

export async function exportToExcel(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: SelExcel[][],
): Promise<DownloadResult> {
  const xlsxBytes = buildXlsxBuffer(sheetName, headers, rows);
  const blob = new Blob([xlsxBytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return saveFileWithPicker(
    blob,
    filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`,
    {
      description: "Spreadsheet Excel (.xlsx)",
      accept: {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
          ".xlsx",
        ],
      },
    },
  );
}

export async function exportToCsv(
  filename: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
): Promise<DownloadResult> {
  let csvText = `${headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(",")}\n`;
  for (const row of rows) {
    const formatted = row.map((val) => {
      if (val === null || val === undefined) return '""';
      if (typeof val === "number") return String(val);
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csvText += `${formatted.join(",")}\n`;
  }
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  return saveFileWithPicker(
    blob,
    filename.endsWith(".csv") ? filename : `${filename}.csv`,
    {
      description: "File CSV (.csv)",
      accept: {
        "text/csv": [".csv"],
      },
    },
  );
}
