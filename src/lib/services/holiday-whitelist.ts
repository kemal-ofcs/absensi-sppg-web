import "server-only";

import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { db, ensureDbInitialized } from "@/lib/db";
import {
  type HolidayWhitelistEntry,
  normalizeHolidayDate,
  normalizeScopeType,
  normalizeScopeValue,
} from "@/lib/validations/holiday-whitelist";

export type { HolidayWhitelistEntry } from "@/lib/validations/holiday-whitelist";

export interface HolidayWhitelistInput {
  scope_type: string;
  scope_value: string;
  tanggal_libur?: string | null;
  keterangan?: string | null;
  status_aktif?: number | boolean;
}

/**
 * Id whitelist dibuat KLIEN, bukan AUTOINCREMENT.
 *
 * Dua perangkat yang sedang offline sama-sama boleh menambah baris; kalau
 * kuncinya nomor urut, keduanya akan memakai angka yang sama lalu saling
 * menimpa begitu tersinkronisasi. UUID membuat keduanya hidup berdampingan.
 */
function newWhitelistId(): string {
  return `hlw-${randomUUID()}`;
}

function rowToEntry(row: Record<string, unknown>): HolidayWhitelistEntry {
  return {
    id: String(row.id ?? ""),
    scope_type: String(row.scope_type ?? ""),
    scope_value: String(row.scope_value ?? ""),
    tanggal_libur:
      row.tanggal_libur === null || row.tanggal_libur === undefined
        ? null
        : String(row.tanggal_libur),
    keterangan:
      row.keterangan === null || row.keterangan === undefined
        ? null
        : String(row.keterangan),
    status_aktif: Number(row.status_aktif ?? 1),
  };
}

export async function getHolidayWhitelist(
  client?: Client,
): Promise<HolidayWhitelistEntry[]> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const result = await targetDb.execute(
    `SELECT id, scope_type, scope_value, tanggal_libur, keterangan, status_aktif
     FROM hari_libur_whitelist
     ORDER BY scope_type ASC, scope_value ASC;`,
  );
  return result.rows.map((row) => rowToEntry(row as Record<string, unknown>));
}

/**
 * Menormalkan input dan menolak cakupan yang tidak sah.
 *
 * Normalisasi dilakukan DI SINI, bukan hanya saat penilaian, supaya "04" dan
 * "4" tidak pernah menjadi dua baris berbeda yang membingungkan admin.
 */
function normalizeInput(data: HolidayWhitelistInput) {
  const scopeType = normalizeScopeType(data.scope_type ?? "");
  if (scopeType === null) {
    throw new Error("Cakupan whitelist harus SHIFT atau DIVISI.");
  }
  const scopeValue = normalizeScopeValue(scopeType, data.scope_value ?? "");
  if (scopeValue === null) {
    throw new Error(
      scopeType === "SHIFT"
        ? "Kode Shift harus berupa angka positif."
        : "Nama Divisi wajib diisi.",
    );
  }

  const rawDate = data.tanggal_libur ?? null;
  const hasDate = rawDate !== null && String(rawDate).trim() !== "";
  const tanggalLibur = hasDate ? normalizeHolidayDate(rawDate) : null;
  if (hasDate && tanggalLibur === null) {
    throw new Error("Tanggal libur harus berformat YYYY-MM-DD.");
  }

  return {
    scopeType,
    scopeValue,
    tanggalLibur,
    keterangan:
      typeof data.keterangan === "string" && data.keterangan.trim() !== ""
        ? data.keterangan.trim()
        : null,
    statusAktif:
      data.status_aktif === false || Number(data.status_aktif) === 0 ? 0 : 1,
  };
}

/**
 * Cegah cakupan kembar di lapisan aplikasi.
 *
 * Sengaja BUKAN UNIQUE constraint di database: dua perangkat offline yang
 * mendaftarkan cakupan sama akan membuat push sync gagal PERMANEN kalau
 * databasenya menolak. Di sini penolakannya cukup memberi pesan ramah, dan
 * duplikat yang terlanjur lolos dari jalur offline tetap tidak berbahaya
 * karena penilaian whitelist bersifat OR.
 */
async function assertNoDuplicate(
  targetDb: Client,
  scopeType: string,
  scopeValue: string,
  tanggalLibur: string | null,
  exceptId: string | null,
) {
  const existing = await targetDb.execute({
    sql: `SELECT id, scope_value, tanggal_libur FROM hari_libur_whitelist
          WHERE scope_type = ?;`,
    args: [scopeType],
  });
  const target = scopeValue.trim().toLowerCase();
  for (const row of existing.rows) {
    if (exceptId !== null && String(row.id ?? "") === exceptId) continue;
    const value = String(row.scope_value ?? "")
      .trim()
      .toLowerCase();
    const rowDate = normalizeHolidayDate(
      row.tanggal_libur === null || row.tanggal_libur === undefined
        ? null
        : String(row.tanggal_libur),
    );
    if (value === target && rowDate === tanggalLibur) {
      throw new Error(
        `Cakupan ${scopeType} "${scopeValue}" sudah terdaftar pada whitelist.`,
      );
    }
  }
}

export async function tambahHolidayWhitelist(
  data: HolidayWhitelistInput,
  client?: Client,
): Promise<{ sukses: boolean; id: string }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const normalized = normalizeInput(data);
  await assertNoDuplicate(
    targetDb,
    normalized.scopeType,
    normalized.scopeValue,
    normalized.tanggalLibur,
    null,
  );

  const id = newWhitelistId();
  const now = new Date().toISOString();
  await targetDb.execute({
    sql: `INSERT INTO hari_libur_whitelist (
            id, scope_type, scope_value, tanggal_libur, keterangan,
            status_aktif, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    args: [
      id,
      normalized.scopeType,
      normalized.scopeValue,
      normalized.tanggalLibur,
      normalized.keterangan,
      normalized.statusAktif,
      now,
      now,
    ],
  });

  return { sukses: true, id };
}

export async function updateHolidayWhitelist(
  id: string,
  data: HolidayWhitelistInput,
  client?: Client,
): Promise<{ sukses: boolean }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const normalized = normalizeInput(data);
  await assertNoDuplicate(
    targetDb,
    normalized.scopeType,
    normalized.scopeValue,
    normalized.tanggalLibur,
    id,
  );

  await targetDb.execute({
    sql: `UPDATE hari_libur_whitelist SET
            scope_type = ?, scope_value = ?, tanggal_libur = ?,
            keterangan = ?, status_aktif = ?, updated_at = ?
          WHERE id = ?;`,
    args: [
      normalized.scopeType,
      normalized.scopeValue,
      normalized.tanggalLibur,
      normalized.keterangan,
      normalized.statusAktif,
      new Date().toISOString(),
      id,
    ],
  });

  return { sukses: true };
}

export async function hapusHolidayWhitelist(
  id: string,
  client?: Client,
): Promise<{ sukses: boolean }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  await targetDb.execute({
    sql: "DELETE FROM hari_libur_whitelist WHERE id = ?;",
    args: [id],
  });
  return { sukses: true };
}
