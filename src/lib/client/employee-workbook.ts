"use client";

import type { KaryawanInput } from "@/lib/gateways/employee";
import {
  firstValidationMessage,
  validateEmployeeDraft,
} from "@/lib/validations/stabilization";
import { downloadBlob } from "./download";

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

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleDateString("en-CA");
  if (typeof value === "object" && "text" in value) return String(value.text);
  return String(value).trim();
}

export async function readEmployeeWorkbook(
  file: File,
): Promise<KaryawanInput[]> {
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Ukuran file Excel maksimal 5 MB.");
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook tidak memiliki worksheet.");
  const headings = new Map<string, number>();
  sheet
    .getRow(1)
    .eachCell((cell, column) =>
      headings.set(cellText(cell.value).toLowerCase(), column),
    );
  for (const required of [
    "id_unik",
    "kode_karyawan",
    "nama",
    "divisi",
    "id_shift",
  ]) {
    if (!headings.has(required))
      throw new Error(`Kolom wajib '${required}' tidak ditemukan.`);
  }
  const drafts: KaryawanInput[] = [];
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const value = (header: string) => {
      const column = headings.get(header);
      return column ? cellText(row.getCell(column).value) : "";
    };
    if (!value("id_unik") && !value("nama")) continue;
    const draft: KaryawanInput = {
      id_unik: value("id_unik"),
      kode_karyawan: value("kode_karyawan"),
      nama: value("nama"),
      divisi: value("divisi"),
      jabatan_status: value("jabatan_status") || "Staff",
      no_hp: value("no_hp"),
      lp: value("lp").toUpperCase() === "P" ? "P" : "L",
      id_shift: Number(value("id_shift")),
      status_aktif: value("status_aktif") === "Nonaktif" ? "Nonaktif" : "Aktif",
      tanggal_daftar: value("tanggal_daftar") || undefined,
      catatan: value("catatan"),
      jenis_personil: value("jenis_personil") || "Pegawai",
      tanggal_mulai_aktif: value("tanggal_mulai_aktif") || undefined,
      tanggal_selesai_aktif: value("tanggal_selesai_aktif") || undefined,
    };
    const message = firstValidationMessage(validateEmployeeDraft(draft));
    if (message) throw new Error(`Baris ${rowNumber}: ${message}`);
    if (ids.has(draft.id_unik) || codes.has(draft.kode_karyawan)) {
      throw new Error(
        `Baris ${rowNumber}: ID atau kode karyawan duplikat di file.`,
      );
    }
    ids.add(draft.id_unik);
    codes.add(draft.kode_karyawan);
    drafts.push(draft);
    if (drafts.length > 500) throw new Error("Maksimal 500 karyawan per file.");
  }
  if (drafts.length === 0)
    throw new Error("Tidak ada data karyawan untuk diimpor.");
  return drafts;
}

async function saveWorkbook(rows: Record<string, unknown>[], filename: string) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Karyawan");
  sheet.addRow([...HEADERS]);
  for (const row of rows)
    sheet.addRow(HEADERS.map((header) => row[header] ?? ""));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `N${Math.max(1, sheet.rowCount)}` };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0369A1" },
  };
  sheet.columns.forEach((column) => {
    column.width = 20;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([new Uint8Array(buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
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
