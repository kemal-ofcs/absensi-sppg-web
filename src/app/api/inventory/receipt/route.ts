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
import { receivePengajuan } from "@/lib/services/inventory-pengajuan";
import { penerimaanDraftSchema } from "@/lib/validations/inventory-pengajuan";

export const runtime = "nodejs";

// Lima foto × 600.000 karakter base64 ditambah isian; tetap di bawah batas
// body 4,5 MB Vercel supaya penerimaan dan fotonya tersimpan dalam satu
// transaksi.
const MAKS_BODY_PENERIMAAN = 3_355_443;

const bodySchema = z.object({ draft: penerimaanDraftSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "inventory.record");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(
      await readJsonBody(request, MAKS_BODY_PENERIMAAN),
    );
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan penerimaan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await receivePengajuan(
        getServerDatabase(),
        actor.username,
        parsed.data.draft,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
