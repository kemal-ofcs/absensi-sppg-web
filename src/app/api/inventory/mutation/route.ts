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
import { recordMutation } from "@/lib/services/inventory";
import { izinUntukAlasan } from "@/lib/validations/inventory";

export const runtime = "nodejs";

const bodySchema = z.object({ draft: z.unknown() }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan inventaris tidak valid." },
        400,
      );
    }
    // Izinnya ditentukan alasan: penghapusan stok menuntut `inventory.adjust`.
    // Cermin `desktop_inventory_record_mutation`.
    const draft = parsed.data.draft as { alasan?: unknown } | null;
    const alasan = typeof draft?.alasan === "string" ? draft.alasan : "";
    const actor = await requireWebPermission(request, izinUntukAlasan(alasan));
    await ensureServerDatabaseInitialized();
    return noStoreJson(
      await recordMutation(
        getServerDatabase(),
        actor.username,
        parsed.data.draft,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
