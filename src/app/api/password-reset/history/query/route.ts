import type { NextRequest } from "next/server";
import {
  isResetHistoryStatus,
  type ResetHistoryFilter,
} from "@/lib/operators/password-reset-history";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  getPasswordResetPhoto,
  listPasswordResetHistory,
} from "@/lib/server/auth/password-reset-audit";
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

export const runtime = "nodejs";

interface HistoryQueryBody {
  status?: unknown;
  search?: unknown;
  limit?: unknown;
  /** Bila diisi, balasan berupa foto bukti satu permintaan, bukan daftar. */
  photoRequestId?: unknown;
}

/**
 * Pembacaan riwayat reset password.
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
    await requireWebPermission(request, "password_reset.view");
    const body = await readJsonBody<HistoryQueryBody>(request);
    const database = getServerDatabase();

    if (typeof body.photoRequestId === "string") {
      return noStoreJson({
        sukses: true,
        photo: await getPasswordResetPhoto(database, body.photoRequestId),
      });
    }

    const filter: ResetHistoryFilter = {
      status: isResetHistoryStatus(body.status) ? body.status : "SEMUA",
      search: typeof body.search === "string" ? body.search : "",
      limit: Number.isFinite(Number(body.limit))
        ? Number(body.limit)
        : undefined,
    };
    return noStoreJson({
      sukses: true,
      entries: await listPasswordResetHistory(database, filter),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
