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
import { reportCashflow } from "@/lib/services/accounting";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    dari: z.string().max(10),
    sampai: z.string().max(10),
    akunKas: z.array(z.string().max(200)).max(50),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "accounting.view");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pembukuan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await reportCashflow(
        getServerDatabase(),
        parsed.data.dari,
        parsed.data.sampai,
        parsed.data.akunKas,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
