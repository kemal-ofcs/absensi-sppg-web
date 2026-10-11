import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  deleteAttendancePhoto,
  purgeAttendancePhotos,
} from "@/lib/server/operational/attendance-photo";

export const runtime = "nodejs";

interface PhotoDeleteBody {
  photoId?: unknown;
  /** Bila diisi, hapus massal foto yang lebih tua dari N hari. */
  olderThanDays?: unknown;
}

/**
 * Penghapusan foto bukti absensi.
 *
 * `attendance_photo.delete` masuk daftar mutasi sensitif: menghapus baris ini
 * menghilangkan satu-satunya bukti visual bahwa sebuah scan benar dilakukan
 * orang yang bersangkutan. Rekap kehadirannya sendiri tidak ikut terhapus.
 */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "attendance_photo.delete");
    const body = await readJsonBody<PhotoDeleteBody>(request);
    const database = getServerDatabase();

    if (typeof body.photoId === "string") {
      return noStoreJson(await deleteAttendancePhoto(database, body.photoId));
    }
    const days = Number(body.olderThanDays);
    if (!Number.isFinite(days)) {
      throw new ApiRequestError("Sertakan photoId atau olderThanDays.", 400);
    }
    return noStoreJson(await purgeAttendancePhotos(database, Math.trunc(days)));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
