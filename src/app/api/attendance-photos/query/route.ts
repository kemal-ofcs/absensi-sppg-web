import type { NextRequest } from "next/server";
import {
  type AttendancePhotoFilter,
  attendancePhotoLimit,
} from "@/lib/attendance/photo-history";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { isSameOriginMutation } from "@/lib/server/http/request-security";
import {
  getAttendancePhoto,
  listAttendancePhotos,
} from "@/lib/server/operational/attendance-photo";

export const runtime = "nodejs";

interface PhotoQueryBody {
  tanggalMulai?: unknown;
  tanggalSelesai?: unknown;
  search?: unknown;
  limit?: unknown;
  /** Bila diisi, balasan berupa satu foto, bukan daftar. */
  photoId?: unknown;
}

/**
 * Pembacaan foto bukti absensi.
 *
 * `POST`, bukan `GET`: build Desktop/Mobile memakai `output: "export"` yang
 * tidak dapat melayani route handler `GET`. Daftar dan foto berbagi satu
 * endpoint supaya penjaga izinnya cuma ada di satu tempat.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginMutation(request)) {
      return noStoreJson(
        { sukses: false, pesan: "Origin tidak diizinkan." },
        403,
      );
    }
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "attendance_photo.view");
    const body = await readJsonBody<PhotoQueryBody>(request);
    const database = getServerDatabase();

    if (typeof body.photoId === "string") {
      return noStoreJson({
        sukses: true,
        photo: await getAttendancePhoto(database, body.photoId),
      });
    }

    const filter: AttendancePhotoFilter = {
      tanggalMulai:
        typeof body.tanggalMulai === "string" ? body.tanggalMulai : "",
      tanggalSelesai:
        typeof body.tanggalSelesai === "string" ? body.tanggalSelesai : "",
      search: typeof body.search === "string" ? body.search : "",
      limit: attendancePhotoLimit(body.limit),
    };
    return noStoreJson({
      sukses: true,
      entries: await listAttendancePhotos(database, filter),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
