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
import { cancelPengajuan } from "@/lib/services/inventory-pengajuan";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    idPengajuan: z.string().min(1).max(160),
    alasan: z.string().max(2000),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "inventory.record");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pengajuan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await cancelPengajuan(
        getServerDatabase(),
        actor.username,
        parsed.data.idPengajuan,
        parsed.data.alasan,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
