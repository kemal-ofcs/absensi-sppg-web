import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireWebSession } from "@/lib/server/auth/authorize";
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
import { hapusFotoLama } from "@/lib/services/driver";

export const runtime = "nodejs";

const bodySchema = z.object({}).strict();

/**
 * Cermin `desktop_trip_photo_cleanup`. Cukup sesi yang sah: masa simpan 90
 * hari adalah aturan tetap tanpa pilihan pengguna, dihitung jam database.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebSession(request);
    await ensureServerDatabaseInitialized();
    if (!bodySchema.safeParse(await readJsonBody(request)).success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan tidak valid." },
        400,
      );
    }
    return noStoreJson(await hapusFotoLama(getServerDatabase()));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
