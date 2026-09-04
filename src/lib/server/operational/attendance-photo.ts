import "server-only";

import type { Client } from "@libsql/client";
import {
  type AttendancePhotoEntry,
  type AttendancePhotoFilter,
  type AttendancePhotoImage,
  attendancePhotoLimit,
} from "@/lib/attendance/photo-history";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

/**
 * Daftar foto bukti absensi — tanpa isi fotonya.
 *
 * Query-nya sengaja dieja mirip `list_attendance_photos` di `turso.rs`: Web dan
 * Desktop/Mobile membaca tabel cloud yang sama, jadi urutan, filter, dan bentuk
 * balasannya harus sama supaya halaman peninjauan tidak berbeda antar platform.
 */
export async function listAttendancePhotos(
  client: Client,
  filter: AttendancePhotoFilter,
): Promise<AttendancePhotoEntry[]> {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  const start = (filter.tanggalMulai ?? "").trim();
  if (start) {
    conditions.push("tanggal_kerja >= ?");
    args.push(start);
  }
  const end = (filter.tanggalSelesai ?? "").trim();
  if (end) {
    conditions.push("tanggal_kerja <= ?");
    args.push(end);
  }
  const search = (filter.search ?? "").trim().slice(0, 60);
  if (search) {
    conditions.push(
      "(nama LIKE ? COLLATE NOCASE OR id_karyawan LIKE ? COLLATE NOCASE OR divisi LIKE ? COLLATE NOCASE OR kode_operator LIKE ? COLLATE NOCASE)",
    );
    for (let index = 0; index < 4; index += 1) args.push(`%${search}%`);
  }
  args.push(attendancePhotoLimit(filter.limit));

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await client.execute({
    sql: `SELECT
            id_foto, COALESCE(id_sesi, '') AS id_sesi, tanggal_kerja, id_karyawan,
            nama, COALESCE(divisi, '') AS divisi, jenis_scan, timestamp_scan,
            COALESCE(sumber_data, '') AS sumber_data,
            COALESCE(kode_operator, '') AS kode_operator,
            COALESCE(ip_perangkat, '') AS ip_perangkat,
            COALESCE(client_id, '') AS client_id,
            COALESCE(foto_mime, 'image/jpeg') AS foto_mime,
            LENGTH(COALESCE(foto_base64, '')) AS ukuran_base64,
            created_at
          FROM absensi_foto
          ${where}
          ORDER BY timestamp_scan DESC
          LIMIT ?;`,
    args,
  });

  return result.rows.map((row) => ({
    idFoto: text(row.id_foto),
    idSesi: text(row.id_sesi),
    tanggalKerja: text(row.tanggal_kerja),
    idKaryawan: text(row.id_karyawan),
    nama: text(row.nama),
    divisi: text(row.divisi),
    jenisScan: text(row.jenis_scan),
    timestampScan: text(row.timestamp_scan),
    sumberData: text(row.sumber_data),
    kodeOperator: text(row.kode_operator),
    ipPerangkat: text(row.ip_perangkat),
    clientId: text(row.client_id),
    fotoMime: text(row.foto_mime) || "image/jpeg",
    ukuranBase64: Number(row.ukuran_base64 ?? 0),
    createdAt: text(row.created_at),
  }));
}

export async function getAttendancePhoto(
  client: Client,
  photoId: string,
): Promise<AttendancePhotoImage> {
  const id = photoId.trim();
  if (!id || id.length > 200) {
    throw new Error("ID foto absensi tidak valid.");
  }
  const result = await client.execute({
    sql: "SELECT COALESCE(foto_mime, 'image/jpeg') AS foto_mime, COALESCE(foto_base64, '') AS foto_base64 FROM absensi_foto WHERE id_foto = ? LIMIT 1;",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new Error("Foto absensi tidak ditemukan.");
  const base64 = text(row.foto_base64).trim();
  if (!base64) throw new Error("Baris ini tidak menyimpan foto.");
  return { mime: text(row.foto_mime) || "image/jpeg", base64 };
}

export async function deleteAttendancePhoto(client: Client, photoId: string) {
  const id = photoId.trim();
  if (!id || id.length > 200) {
    throw new Error("ID foto absensi tidak valid.");
  }
  const result = await client.execute({
    sql: "DELETE FROM absensi_foto WHERE id_foto = ?;",
    args: [id],
  });
  if (Number(result.rowsAffected) === 0) {
    throw new Error("Foto tidak ditemukan atau sudah dihapus.");
  }
  return { sukses: true as const, deleted: 1 };
}

/**
 * Membersihkan foto yang lebih tua dari `days` hari.
 *
 * Hanya fotonya yang hilang; `log_scan` dan `absensi_harian` tetap utuh, jadi
 * rekap kehadiran tidak pernah ikut terhapus oleh retensi ini.
 */
export async function purgeAttendancePhotos(client: Client, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("Rentang hari pembersihan tidak valid.");
  }
  const result = await client.execute({
    sql: "DELETE FROM absensi_foto WHERE tanggal_kerja <= date('now', ?);",
    args: [`-${days} days`],
  });
  return { sukses: true as const, deleted: Number(result.rowsAffected ?? 0) };
}
