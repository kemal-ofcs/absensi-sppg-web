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
import { rekapUpah } from "@/lib/services/driver";

export const runtime = "nodejs";

const bodySchema = z
  .object({ dari: z.string().max(10), sampai: z.string().max(10) })
  .strict();

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireAnyWebPermission(request, ["trip.view", "trip.pay"]);
    await ensureServerDatabaseInitialized();
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return noStoreJson(
        { sukses: false, pesan: "Permintaan perjalanan tidak valid." },
        400,
      );
    }
    return noStoreJson(
      await rekapUpah(
        getServerDatabase(),
        parsed.data.dari,
        parsed.data.sampai,
      ),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
