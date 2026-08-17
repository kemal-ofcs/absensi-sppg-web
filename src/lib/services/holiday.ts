import "server-only";

import type { Client } from "@libsql/client";
import { db, ensureDbInitialized } from "@/lib/db";

export interface HariLiburRecord {
  id_libur: number;
  tanggal: string; // YYYY-MM-DD
  nama_libur: string;
  jenis_libur: string; // Libur Nasional, Cuti Bersama, Libur Khusus
  keterangan: string | null;
  status_aktif: number; // 1 = Aktif, 0 = Nonaktif
}

export interface HariLiburInput {
  tanggal: string;
  nama_libur: string;
  jenis_libur?: string;
  keterangan?: string | null;
  status_aktif?: number | boolean;
}

export async function getDaftarHariLibur(
  client?: Client,
): Promise<HariLiburRecord[]> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const res = await targetDb.execute(
    "SELECT * FROM tbl_hari_libur ORDER BY tanggal DESC;",
  );
  return res.rows.map((row) => ({
    id_libur: Number(row.id_libur),
    tanggal: String(row.tanggal || ""),
    nama_libur: String(row.nama_libur || ""),
    jenis_libur: String(row.jenis_libur || "Libur Nasional"),
    keterangan: row.keterangan ? String(row.keterangan) : null,
    status_aktif: Number(row.status_aktif ?? 1),
  }));
}

export async function cekHariLiburAktif(
  tanggalStr: string,
  client?: Client,
): Promise<HariLiburRecord | null> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const normalized = tanggalStr.trim().split("T")[0];
  const res = await targetDb.execute({
    sql: "SELECT * FROM tbl_hari_libur WHERE tanggal = ? AND status_aktif = 1 LIMIT 1;",
    args: [normalized],
  });

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id_libur: Number(row.id_libur),
    tanggal: String(row.tanggal || ""),
    nama_libur: String(row.nama_libur || ""),
    jenis_libur: String(row.jenis_libur || "Libur Nasional"),
    keterangan: row.keterangan ? String(row.keterangan) : null,
    status_aktif: Number(row.status_aktif ?? 1),
  };
}

export async function tambahHariLibur(
  data: HariLiburInput,
  client?: Client,
): Promise<{ sukses: boolean; id_libur: number }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const tanggal = data.tanggal.trim().split("T")[0];
  const namaLibur = data.nama_libur.trim();
  if (!tanggal || !namaLibur) {
    throw new Error("Tanggal dan nama hari libur wajib diisi.");
  }

  const existing = await targetDb.execute({
    sql: "SELECT id_libur FROM tbl_hari_libur WHERE tanggal = ? LIMIT 1;",
    args: [tanggal],
  });
  if (existing.rows.length > 0) {
    throw new Error(
      `Tanggal libur ${tanggal} sudah terdaftar. Silakan edit jika ingin mengubahnya.`,
    );
  }

  const statusAktif =
    data.status_aktif === false || Number(data.status_aktif) === 0 ? 0 : 1;

  const res = await targetDb.execute({
    sql: `INSERT INTO tbl_hari_libur (
            tanggal, nama_libur, jenis_libur, keterangan, status_aktif
          ) VALUES (?, ?, ?, ?, ?);`,
    args: [
      tanggal,
      namaLibur,
      data.jenis_libur?.trim() || "Libur Nasional",
      data.keterangan?.trim() || null,
      statusAktif,
    ],
  });

  return { sukses: true, id_libur: Number(res.lastInsertRowid) };
}

export async function updateHariLibur(
  id_libur: number,
  data: Partial<HariLiburInput>,
  client?: Client,
): Promise<{ sukses: boolean }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  const updates: string[] = [];
  const args: (string | number | null)[] = [];

  if (data.tanggal !== undefined) {
    const tanggal = data.tanggal.trim().split("T")[0];
    const existing = await targetDb.execute({
      sql: "SELECT id_libur FROM tbl_hari_libur WHERE tanggal = ? AND id_libur != ? LIMIT 1;",
      args: [tanggal, id_libur],
    });
    if (existing.rows.length > 0) {
      throw new Error(`Tanggal libur ${tanggal} sudah digunakan data lain.`);
    }
    updates.push("tanggal = ?");
    args.push(tanggal);
  }

  if (data.nama_libur !== undefined) {
    updates.push("nama_libur = ?");
    args.push(data.nama_libur.trim());
  }

  if (data.jenis_libur !== undefined) {
    updates.push("jenis_libur = ?");
    args.push(data.jenis_libur.trim() || "Libur Nasional");
  }

  if (data.keterangan !== undefined) {
    updates.push("keterangan = ?");
    args.push(data.keterangan?.trim() || null);
  }

  if (data.status_aktif !== undefined) {
    updates.push("status_aktif = ?");
    args.push(
      data.status_aktif === false || Number(data.status_aktif) === 0 ? 0 : 1,
    );
  }

  if (updates.length === 0) return { sukses: true };

  args.push(id_libur);
  await targetDb.execute({
    sql: `UPDATE tbl_hari_libur SET ${updates.join(", ")} WHERE id_libur = ?;`,
    args,
  });

  return { sukses: true };
}

export async function hapusHariLibur(
  id_libur: number,
  client?: Client,
): Promise<{ sukses: boolean }> {
  const targetDb = client ?? db;
  if (!client) await ensureDbInitialized();
  await targetDb.execute({
    sql: "DELETE FROM tbl_hari_libur WHERE id_libur = ?;",
    args: [id_libur],
  });
  return { sukses: true };
}
