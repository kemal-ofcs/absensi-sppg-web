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
import { deferLoan } from "@/lib/services/loan";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    idPinjaman: z.string().min(1).max(160),
    periode: z.string().max(7),
    alasan: z.string().max(500).nullish(),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "loan.manage");
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan pembukuan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await deferLoan(
        getServerDatabase(),
        actor.username,
        parsed.data.idPinjaman,
        parsed.data.periode,
        parsed.data.alasan ?? null,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
