import type { NextRequest } from "next/server";
import { z } from "zod";
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
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { decide } from "@/lib/services/tutup-buku";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    idTutup: z.string().min(1).max(160),
    keputusan: z.enum(["pakai", "tolak"]),
    catatan: z.string().max(500),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "accounting.close");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pembukuan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await decide(
        getServerDatabase(),
        actor.username,
        parsed.data.idTutup,
        parsed.data.keputusan,
        parsed.data.catatan,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
