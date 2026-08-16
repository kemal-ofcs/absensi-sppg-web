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

async function decompressDeflateRaw(
  compressed: Uint8Array,
): Promise<Uint8Array> {
  const blob = new Blob([compressed as unknown as BlobPart]);
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(blob.stream().pipeThrough(ds));
  const buffer = await stream.arrayBuffer();
  return new Uint8Array(buffer);
}

async function extractZipEntries(
  buffer: ArrayBuffer,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const textDecoder = new TextDecoder();

  // Locate End of Central Directory (EOCD) signature: 0x06054b50
  let eocdOffset = -1;
  const searchLimit = Math.max(0, buffer.byteLength - 65557);
  for (let i = buffer.byteLength - 22; i >= searchLimit; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Format file Excel (.xlsx) tidak valid atau file rusak.");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  let cdPos = cdOffset;
  for (let i = 0; i < totalEntries && cdPos + 46 <= buffer.byteLength; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) break;

    const compression = view.getUint16(cdPos + 10, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const name = textDecoder.decode(
      bytes.subarray(cdPos + 46, cdPos + 46 + nameLen),
    );

    if (
      name.endsWith(".xml") ||
      name.endsWith(".rels") ||
      name === "xl/sharedStrings.xml" ||
      name.startsWith("xl/worksheets/")
    ) {
      if (localHeaderOffset + 30 <= buffer.byteLength) {
        const localNameLen = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + compressedSize;

        if (dataEnd <= buffer.byteLength) {
          const rawData = bytes.subarray(dataStart, dataEnd);
          if (compression === 0) {
            entries.set(name, textDecoder.decode(rawData));
          } else if (compression === 8) {
            try {
              const decompressed = await decompressDeflateRaw(rawData);
              entries.set(name, textDecoder.decode(decompressed));
            } catch {
              // Non-fatal if unused file fails
            }
          }
        }
      }
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
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

function colLetterToIndex(colStr: string): number {
  let index = 0;
  for (let i = 0; i < colStr.length; i++) {
    index = index * 26 + (colStr.toUpperCase().charCodeAt(i) - 64);
  }
  return Math.max(0, index - 1);
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
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Ukuran file Excel maksimal 10 MB.");
  }

  const rows: string[][] = [];

  if (file.name.endsWith(".csv")) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const row: string[] = [];
      let inQuote = false;
      let cell = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
          row.push(cell.trim());
          cell = "";
        } else {
          cell += ch;
        }
      }
      row.push(cell.trim());
      if (row.some((c) => c !== "")) {
        rows.push(row);
      }
    }
  } else {
    const buffer = await file.arrayBuffer();
    const entries = await extractZipEntries(buffer);
    const sheetXml =
      entries.get("xl/worksheets/sheet1.xml") ||
      entries.get("xl/worksheets/sheet.xml");

    if (!sheetXml) {
      throw new Error(
        "File Excel tidak memiliki sheet1 atau format tidak valid.",
      );
    }

    const sharedStrings: string[] = [];
    const ssXml = entries.get("xl/sharedStrings.xml");
    const parser = new DOMParser();

    if (ssXml) {
      const ssDoc = parser.parseFromString(ssXml, "application/xml");
      const siElements = ssDoc.querySelectorAll("si");
      siElements.forEach((si) => {
        let text = "";
        const tElements = si.querySelectorAll("t");
        tElements.forEach((t) => {
          text += t.textContent || "";
        });
        sharedStrings.push(text.trim());
      });
    }

    const doc = parser.parseFromString(sheetXml, "application/xml");
    const rowElements = doc.querySelectorAll("row");

    rowElements.forEach((rowEl) => {
      const rowCells: string[] = [];
      const cElements = rowEl.querySelectorAll("c");

      cElements.forEach((cEl) => {
        const ref = cEl.getAttribute("r") || "";
        const colLetters = ref.replace(/[^a-zA-Z]/g, "");
        const colIdx = colLetters
          ? colLetterToIndex(colLetters)
          : rowCells.length;

        while (rowCells.length < colIdx) {
          rowCells.push("");
        }

        const type = cEl.getAttribute("t");
        let val = "";

        if (type === "inlineStr") {
          const tEl = cEl.querySelector("is t, t");
          val = tEl?.textContent?.trim() || "";
        } else if (type === "s") {
          const vEl = cEl.querySelector("v");
          const idx = vEl ? Number(vEl.textContent) : -1;
          val =
            idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : "";
        } else {
          const vEl = cEl.querySelector("v");
          val = vEl?.textContent?.trim() || "";
        }

        rowCells[colIdx] = val;
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
        `Baris ${i + 1}: ID (${draft.id_unik}) atau kode karyawan (${draft.kode_karyawan}) duplikat di file.`,
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
  const blob = new Blob([xlsxBytes as unknown as BlobPart], {
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
