import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { generateAlfaHarian } from "@/lib/services/alfa-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    await requireWebPermission(request, "alfa.trigger");
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<{ simulatedTime?: unknown }>(request);
    const simulatedDate =
      typeof body.simulatedTime === "string" && body.simulatedTime.trim()
        ? new Date(body.simulatedTime)
        : undefined;

    const ringkasan = await generateAlfaHarian(simulatedDate);
    return noStoreJson({ ringkasan });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
