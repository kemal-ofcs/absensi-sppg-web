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
import { listPengajuan } from "@/lib/services/inventory-pengajuan";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    dari: z.string().max(10),
    sampai: z.string().max(10),
  })
  .strict();

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
        { sukses: false, pesan: "Permintaan pengajuan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await listPengajuan(
        getServerDatabase(),
        parsed.data.dari,
        parsed.data.sampai,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
