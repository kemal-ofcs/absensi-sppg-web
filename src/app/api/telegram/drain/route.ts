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
import { drainTelegram } from "@/lib/services/telegram";

export const runtime = "nodejs";

const bodySchema = z.object({}).strict();

/**
 * Cermin `desktop_drain_telegram`. Cukup sesi yang sah: isi dan tujuan pesan
 * sepenuhnya diatur Superadmin, dan makin banyak sesi terbuka makin cepat
 * pesan terkirim.
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
    return noStoreJson(await drainTelegram(getServerDatabase()));
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
