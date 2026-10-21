/**
 * Pembaca berkas Excel (.xlsx) dan CSV, tanpa dependensi dan tanpa DOM.
 *
 * Dipakai impor karyawan dan impor barang inventaris. Penulisan berkas tetap di
 * `excel-export.ts`. XML dibaca dengan pencocokan pola, bukan `DOMParser`,
 * supaya seluruh jalur baca bisa diuji di `bun test` (Bun tidak punya DOM).
 * Berkas .xlsx dari Excel, LibreOffice, dan Google Sheets berbentuk XML yang
 * rapi; pola di sini hanya membaca elemen yang memang dipakai untuk isi sel.
 */

export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

export interface WorkbookTable {
  /** Baris yang semua selnya kosong dibuang. */
  rows: string[][];
  /**
   * Penanda sel bertipe Angka, sejajar dengan `rows`. Isi sel Angka selalu
   * bertitik desimal (`1.234` = satu koma dua tiga empat) apa pun pengaturan
   * regional Excel, sedangkan sel Teks dan CSV berisi ketikan apa adanya.
   */
  selAngka: boolean[][];
}

export async function readWorkbookRows(file: File): Promise<string[][]> {
  return (await readWorkbookTable(file)).rows;
}

export async function readWorkbookTable(file: File): Promise<WorkbookTable> {
  if (file.size > MAX_WORKBOOK_BYTES) {
    throw new Error("Ukuran file Excel maksimal 10 MB.");
  }
  if (file.name.toLowerCase().endsWith(".csv")) {
    return parseCsv(await file.text());
  }
  const entries = await extractZipEntries(await file.arrayBuffer());
  const sheetPath = firstSheetPath(entries);
  const sheetXml = sheetPath ? entries.get(sheetPath) : undefined;
  if (!sheetXml) {
    throw new Error(
      "File Excel tidak memiliki sheet atau formatnya tidak valid.",
    );
  }
  return parseSheet(
    sheetXml,
    parseSharedStrings(entries.get("xl/sharedStrings.xml") ?? ""),
  );
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * CSV dari Excel: "CSV UTF-8" diawali BOM (tanpa dibuang, judul kolom pertama
 * tidak dikenali), dan Excel berbahasa Indonesia memisahkan sel dengan titik
 * koma. Tanda kutip ganda di dalam sel ditulis `""`, dan sel berkutip boleh
 * memuat baris baru.
 */
export function parseCsv(raw: string): WorkbookTable {
  const text = raw.replace(/^﻿/, "");
  const pertama = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const pemisah =
    (pertama.match(/;/g)?.length ?? 0) > (pertama.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  const tutupBaris = () => {
    row.push(cell.trim());
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === pemisah) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      tutupBaris();
    } else {
      cell += ch;
    }
  }
  tutupBaris();
  return { rows, selAngka: rows.map((r) => r.map(() => false)) };
}

// ── XLSX ────────────────────────────────────────────────────────────────────

function decodeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,
    (_, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[
        entity as "lt"
      ];
    },
  );
}

function atribut(tag: string, nama: string): string | null {
  const match = new RegExp(`(?:^|\\s)${nama}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1] as string) : null;
}

/**
 * Isi teks sebuah `<si>` atau `<is>`: gabungan semua `<t>` (teks berformat
 * dipecah menjadi beberapa run), tanpa `<rPh>` — petunjuk baca fonetik yang
 * bukan bagian dari isi sel.
 */
function teksRun(xml: string): string {
  const tanpaFonetik = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const match of tanpaFonetik.matchAll(
    /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g,
  )) {
    text += decodeXml(match[1] as string);
  }
  return text;
}

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(
    (match) => teksRun(match[1] ?? "").trim(),
  );
}

/**
 * Berkas sheet pertama menurut urutan tab di `xl/workbook.xml`. Nama berkasnya
 * tidak selalu `sheet1.xml`: Google Sheets dan sheet yang diurutkan ulang
 * memakai nama lain, dan dulu berkas seperti itu ditolak.
 */
export function firstSheetPath(entries: Map<string, string>): string | null {
  const workbook = entries.get("xl/workbook.xml") ?? "";
  const rels = entries.get("xl/_rels/workbook.xml.rels") ?? "";
  const sheet = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const rid = sheet ? atribut(sheet, "r:id") : null;
  if (rid) {
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (atribut(match[0], "Id") !== rid) continue;
      const target = atribut(match[0], "Target");
      if (!target) break;
      const path = target.startsWith("/")
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, "")}`;
      if (entries.has(path)) return path;
    }
  }
  if (entries.has("xl/worksheets/sheet1.xml"))
    return "xl/worksheets/sheet1.xml";
  return (
    [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
      .sort()[0] ?? null
  );
}

function colLetterToIndex(colStr: string): number {
  let index = 0;
  for (const char of colStr.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

export function parseSheet(xml: string, shared: string[]): WorkbookTable {
  const rows: string[][] = [];
  const selAngka: boolean[][] = [];
  for (const rowMatch of xml.matchAll(
    /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g,
  )) {
    const cells: string[] = [];
    const angka: boolean[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const tag = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = atribut(tag, "r") ?? "";
      const letters = ref.replace(/[^a-zA-Z]/g, "");
      const colIdx = letters ? colLetterToIndex(letters) : cells.length;
      while (cells.length < colIdx) {
        cells.push("");
        angka.push(false);
      }
      const type = atribut(tag, "t");
      const v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      let val: string;
      if (type === "s") {
        val = shared[Number(v)] ?? "";
      } else if (type === "inlineStr") {
        val = teksRun(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      } else if (type === "b") {
        val = v === "" ? "" : v === "1" ? "TRUE" : "FALSE";
      } else {
        // `n` atau tanpa tipe = Angka; `str` (hasil rumus), `e` (galat
        // seperti #N/A), dan `d` (tanggal ISO) dibaca sebagai teks apa adanya.
        val = v;
      }
      val = val.trim();
      cells[colIdx] = val;
      angka[colIdx] = (type === null || type === "n") && val !== "";
    }
    if (cells.some((c) => c !== "")) {
      rows.push(cells);
      selAngka.push(angka);
    }
  }
  return { rows, selAngka };
}

async function decompressDeflateRaw(
  compressed: Uint8Array,
): Promise<Uint8Array> {
  const blob = new Blob([compressed as unknown as BlobPart]);
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(blob.stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

async function extractZipEntries(
  buffer: ArrayBuffer,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const textDecoder = new TextDecoder();

  // Cari tanda End of Central Directory (0x06054b50) dari belakang.
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
  let cdPos = view.getUint32(eocdOffset + 16, true);
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
      (name.endsWith(".xml") || name.endsWith(".rels")) &&
      localHeaderOffset + 30 <= buffer.byteLength
    ) {
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
            entries.set(
              name,
              textDecoder.decode(await decompressDeflateRaw(rawData)),
            );
          } catch {
            // Bagian yang rusak dilewati; bila itu sheet-nya, pemanggil
            // melaporkan sheet tidak ditemukan.
          }
        }
      }
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
