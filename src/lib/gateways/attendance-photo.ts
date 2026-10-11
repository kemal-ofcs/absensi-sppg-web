"use client";

import type {
  AttendancePhotoEntry,
  AttendancePhotoFilter,
  AttendancePhotoImage,
} from "@/lib/attendance/photo-history";
import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function normalizeEntry(value: JsonRecord): AttendancePhotoEntry {
  return {
    idFoto: text(value.idFoto ?? value.id_foto),
    idSesi: text(value.idSesi ?? value.id_sesi),
    tanggalKerja: text(value.tanggalKerja ?? value.tanggal_kerja),
    idKaryawan: text(value.idKaryawan ?? value.id_karyawan),
    nama: text(value.nama),
    divisi: text(value.divisi),
    jenisScan: text(value.jenisScan ?? value.jenis_scan),
    timestampScan: text(value.timestampScan ?? value.timestamp_scan),
    sumberData: text(value.sumberData ?? value.sumber_data),
    kodeOperator: text(value.kodeOperator ?? value.kode_operator),
    ipPerangkat: text(value.ipPerangkat ?? value.ip_perangkat),
    clientId: text(value.clientId ?? value.client_id),
    fotoMime: text(value.fotoMime ?? value.foto_mime) || "image/jpeg",
    ukuranBase64: Number(value.ukuranBase64 ?? value.ukuran_base64 ?? 0),
    createdAt: text(value.createdAt ?? value.created_at),
  };
}

/**
 * Foto bukti absensi.
 *
 * Desktop/Mobile membacanya LANGSUNG dari cloud, bukan dari SQLite lokal: foto
 * sengaja tidak ikut snapshot sync, jadi perangkat ini hanya menyimpan foto
 * hasil scannya sendiri. Meninjau bukti baru berguna kalau yang terlihat adalah
 * foto dari semua terminal.
 */
export async function getAttendancePhotos(filter: AttendancePhotoFilter = {}) {
  const payload = {
    tanggalMulai: filter.tanggalMulai ?? "",
    tanggalSelesai: filter.tanggalSelesai ?? "",
    search: filter.search ?? "",
    limit: filter.limit,
  };
  if (isDesktopRuntime()) {
    const response = record(
      await invokeDesktop("desktop_list_attendance_photos", payload),
    );
    const entries = response.entries;
    return (Array.isArray(entries) ? entries : []).map((item) =>
      normalizeEntry(record(item)),
    );
  }
  const response = await requestWebApi<{ entries: AttendancePhotoEntry[] }>(
    "/api/attendance-photos/query",
    "POST",
    payload,
  );
  return response.entries.map((item) =>
    normalizeEntry(item as unknown as JsonRecord),
  );
}

export async function getAttendancePhotoImage(
  photoId: string,
): Promise<AttendancePhotoImage> {
  if (isDesktopRuntime()) {
    const response = record(
      await invokeDesktop("desktop_get_attendance_photo", { photoId }),
    );
    const photo = record(response.photo);
    return {
      mime: text(photo.mime) || "image/jpeg",
      base64: text(photo.base64),
    };
  }
  const response = await requestWebApi<{ photo: AttendancePhotoImage }>(
    "/api/attendance-photos/query",
    "POST",
    { photoId },
  );
  return response.photo;
}

export async function deleteAttendancePhotoEntry(photoId: string) {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_delete_attendance_photo", { photoId });
    return { sukses: true as const };
  }
  await requestWebApi<{ sukses: true }>("/api/attendance-photos", "DELETE", {
    photoId,
  });
  return { sukses: true as const };
}

export async function purgeAttendancePhotoEntries(olderThanDays: number) {
  if (isDesktopRuntime()) {
    const response = record(
      await invokeDesktop("desktop_purge_attendance_photos", { olderThanDays }),
    );
    return { deleted: Number(response.deleted ?? 0) };
  }
  const response = await requestWebApi<{ deleted: number }>(
    "/api/attendance-photos",
    "DELETE",
    { olderThanDays },
  );
  return { deleted: Number(response.deleted ?? 0) };
}
