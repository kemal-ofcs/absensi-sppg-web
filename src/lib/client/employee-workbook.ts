"use client";

import type { KaryawanInput } from "@/lib/gateways/employee";
import {
  firstValidationMessage,
  validateEmployeeDraft,
} from "@/lib/validations/stabilization";
import { type DownloadResult, saveFileWithPicker } from "./download";

const HEADERS = [
  "id_unik",
  "kode_karyawan",
  "nama",
  "divisi",
  "jabatan_status",
  "no_hp",
  "lp",
  "id_shift",
  "status_aktif",
  "tanggal_daftar",
  "catatan",
  "jenis_personil",
  "tanggal_mulai_aktif",
  "tanggal_selesai_aktif",
] as const;

// CRC-32 implementation
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

async function extractZipEntries(
  buffer: ArrayBuffer,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const textDecoder = new TextDecoder();
  let pos = 0;

  while (pos + 30 <= buffer.byteLength) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break;

    const compression = view.getUint16(pos + 8, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);

    const name = textDecoder.decode(
      bytes.subarray(pos + 30, pos + 30 + nameLen),
    );
    const dataStart = pos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd <= buffer.byteLength) {
      const rawData = bytes.subarray(dataStart, dataEnd);
      if (compression === 0) {
        entries.set(name, textDecoder.decode(rawData));
      } else if (compression === 8 && typeof DecompressionStream !== "undefined") {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          await writer.write(rawData);
          await writer.close();
          const response = new Response(ds.readable);
          const decompressed = await response.text();
          entries.set(name, decompressed);
        } catch {
          // ignore decompression error
        }
      }
    }

    pos = dataEnd;
  }

  return entries;
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

function createXlsxBuffer(
  headers: readonly string[],
  rows: Record<string, unknown>[],
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
    headers.forEach((header, colIdx) => {
      const cellRef = `${columnLetter(colIdx)}${rowNum}`;
      const rawVal = row[header];
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
    <sheet name="Karyawan" sheetId="1" r:id="rId1"/>
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

export async function readEmployeeWorkbook(
  file: File,
): Promise<KaryawanInput[]> {
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Ukuran file Excel maksimal 5 MB.");
  }

  let rows: string[][] = [];

  if (file.name.endsWith(".csv")) {
    const text = await file.text();
    rows = text
      .split(/\r?\n/)
      .map((line) =>
        line.split(",").map((c) => c.replace(/^"|"$/g, "").trim()),
      )
      .filter((r) => r.length > 0 && r.some((c) => c !== ""));
  } else {
    const buffer = await file.arrayBuffer();
    const entries = await extractZipEntries(buffer);
    const sheetXml = entries.get("xl/worksheets/sheet1.xml");

    if (!sheetXml) {
      throw new Error(
        "File Excel tidak memiliki sheet1 atau format tidak valid.",
      );
    }

    const sharedStrings: string[] = [];
    const ssXml = entries.get("xl/sharedStrings.xml");
    if (ssXml) {
      const match = ssXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g);
      if (match) {
        match.forEach((m) => {
          sharedStrings.push(
            m
              .replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">"),
          );
        });
      }
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(sheetXml, "application/xml");
    const rowElements = doc.querySelectorAll("row");

    rowElements.forEach((rowEl) => {
      const rowCells: string[] = [];
      const cElements = rowEl.querySelectorAll("c");
      cElements.forEach((cEl) => {
        const type = cEl.getAttribute("t");
        if (type === "inlineStr") {
          const tEl = cEl.querySelector("is t, t");
          rowCells.push(tEl?.textContent?.trim() || "");
        } else if (type === "s") {
          const vEl = cEl.querySelector("v");
          const idx = vEl ? Number(vEl.textContent) : -1;
          rowCells.push(
            idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : "",
          );
        } else {
          const vEl = cEl.querySelector("v");
          rowCells.push(vEl?.textContent?.trim() || "");
        }
      });
      if (rowCells.some((c) => c !== "")) {
        rows.push(rowCells);
      }
    });
  }

  if (rows.length < 2) {
    throw new Error("Tidak ada data karyawan yang ditemukan di file.");
  }

  const headings = new Map<string, number>();
  const headerRow = rows[0] || [];
  headerRow.forEach((h, idx) => {
    headings.set(h.toLowerCase().trim(), idx);
  });

  for (const required of [
    "id_unik",
    "kode_karyawan",
    "nama",
    "divisi",
    "id_shift",
  ]) {
    if (!headings.has(required)) {
      throw new Error(
        `Kolom wajib '${required}' tidak ditemukan di baris judul Excel.`,
      );
    }
  }

  const drafts: KaryawanInput[] = [];
  const ids = new Set<string>();
  const codes = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const val = (header: string) => {
      const colIdx = headings.get(header);
      return colIdx !== undefined && colIdx < row.length
        ? row[colIdx].trim()
        : "";
    };

    if (!val("id_unik") && !val("nama")) continue;

    const draft: KaryawanInput = {
      id_unik: val("id_unik"),
      kode_karyawan: val("kode_karyawan"),
      nama: val("nama"),
      divisi: val("divisi"),
      jabatan_status: val("jabatan_status") || "Staff",
      no_hp: val("no_hp"),
      lp: val("lp").toUpperCase() === "P" ? "P" : "L",
      id_shift: Number(val("id_shift")) || 1,
      status_aktif: val("status_aktif") === "Nonaktif" ? "Nonaktif" : "Aktif",
      tanggal_daftar: val("tanggal_daftar") || undefined,
      catatan: val("catatan"),
      jenis_personil: val("jenis_personil") || "Pegawai",
      tanggal_mulai_aktif: val("tanggal_mulai_aktif") || undefined,
      tanggal_selesai_aktif: val("tanggal_selesai_aktif") || undefined,
    };

    const message = firstValidationMessage(validateEmployeeDraft(draft));
    if (message) throw new Error(`Baris ${i + 1}: ${message}`);
    if (ids.has(draft.id_unik) || codes.has(draft.kode_karyawan)) {
      throw new Error(
        `Baris ${i + 1}: ID atau kode karyawan duplikat di file.`,
      );
    }
    ids.add(draft.id_unik);
    codes.add(draft.kode_karyawan);
    drafts.push(draft);
    if (drafts.length > 500) throw new Error("Maksimal 500 karyawan per file.");
  }

  if (drafts.length === 0) {
    throw new Error("Tidak ada data karyawan untuk diimpor.");
  }

  return drafts;
}

async function saveWorkbook(
  rows: Record<string, unknown>[],
  filename: string,
): Promise<DownloadResult> {
  const xlsxBytes = createXlsxBuffer(HEADERS, rows);
  const blob = new Blob([xlsxBytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return await saveFileWithPicker(blob, filename, {
    description: "Excel Spreadsheet (*.xlsx)",
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
        ".xlsx",
      ],
    },
  });
}

export function exportEmployees(rows: Record<string, unknown>[]) {
  return saveWorkbook(
    rows,
    `karyawan-${new Date().toLocaleDateString("en-CA")}.xlsx`,
  );
}

export function downloadEmployeeTemplate() {
  return saveWorkbook(
    [
      {
        id_unik: "EMP_0001",
        kode_karyawan: "K0001",
        nama: "Nama Karyawan",
        divisi: "SPPG Operational",
        jabatan_status: "Staff",
        no_hp: "08123456789",
        lp: "L",
        id_shift: 1,
        status_aktif: "Aktif",
        tanggal_daftar: new Date().toLocaleDateString("en-CA"),
        jenis_personil: "Pegawai",
      },
    ],
    "template-import-karyawan.xlsx",
  );
}
