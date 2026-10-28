import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAnyWebPermission } from "@/lib/server/auth/authorize";
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
import { fotoPenerimaan } from "@/lib/services/inventory-pengajuan";

export const runtime = "nodejs";

const bodySchema = z.object({ idFoto: z.string().min(1).max(200) }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    // Pengaju dari Inventaris, bendahara dari Keuangan.
    await requireAnyWebPermission(request, [
      "inventory.view",
      "accounting.view",
    ]);
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan foto tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await fotoPenerimaan(getServerDatabase(), parsed.data.idFoto),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
