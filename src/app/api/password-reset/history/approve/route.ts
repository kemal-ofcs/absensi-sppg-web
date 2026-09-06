import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { approvePasswordReset } from "@/lib/server/auth/password-reset";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

interface ApproveBody {
  requestId?: unknown;
}

/**
 * Persetujuan pemulihan password oleh peninjau manusia.
 *
 * Berbeda dari langkah-langkah di `/api/password-reset` yang sengaja terbuka
 * tanpa sesi, langkah ini menuntut izin: yang terjadi di sini adalah
 * menyerahkan kendali sebuah akun kepada orang yang berdiri di depan layar
 * setelah peninjau melihat foto wajahnya. `password_reset.approve` masuk
 * `SENSITIVE_MUTATION_PERMISSIONS`, jadi ia tidak ikut paket bawaan Admin.
 *
 * `POST`, bukan `GET`, sesuai aturan seluruh route handler di repo ini —
 * build Desktop/Mobile memakai `output: "export"` yang tidak bisa melayani
 * route handler `GET`.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "password_reset.approve");
    const body = await readJsonBody<ApproveBody>(request);
    const hasil = await approvePasswordReset(
      getServerDatabase(),
      actor.id,
      typeof body.requestId === "string" ? body.requestId : "",
    );
    // Tokennya hanya bisa dibaca SEKALI: database memegang hash-nya saja.
    // Layar peninjau wajib menampilkannya sampai ia menutupnya sendiri.
    return noStoreJson({ sukses: true, ...hasil });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
