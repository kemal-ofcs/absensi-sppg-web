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

export function buildXlsxBuffer(
  sheetName: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
): Uint8Array {
  const encoder = new TextEncoder();

  let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">`;

  headers.forEach((header, colIdx) => {
    const cellRef = `${columnLetter(colIdx)}1`;
    sheetXml += `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(header)}</t></is></c>`;
  });
  sheetXml += `</row>`;

  rows.forEach((row, rowIdx) => {
    const rowNum = rowIdx + 2;
    sheetXml += `<row r="${rowNum}">`;
    headers.forEach((_, colIdx) => {
      const cellRef = `${columnLetter(colIdx)}${rowNum}`;
      const rawVal = row[colIdx];
      const val = rawVal === null || rawVal === undefined ? "" : String(rawVal);
      sheetXml += `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
    });
    sheetXml += `</row>`;
  });

  sheetXml += `</sheetData></worksheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName || "Sheet1")}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  return createZipArchive([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml) },
    { name: "_rels/.rels", data: encoder.encode(relsXml) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(wbRelsXml) },
    { name: "xl/workbook.xml", data: encoder.encode(wbXml) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml) },
  ]);
}

export async function exportToExcel(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
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
