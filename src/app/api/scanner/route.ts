import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { submitTerminalScan } from "@/lib/services/scanner";

export const runtime = "nodejs";

interface ScannerBody {
  qrContent?: unknown;
  lat?: unknown;
  lng?: unknown;
}

function coordinate(value: unknown) {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiRequestError("Koordinat scanner tidak valid.", 400);
  }
  return parsed;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "scanner.use");
    const body = await readJsonBody<ScannerBody>(request);
    const qrContent =
      typeof body.qrContent === "string" ? body.qrContent.trim() : "";
    if (!qrContent || qrContent.length > 512) {
      throw new ApiRequestError("Isi QR tidak valid.", 400);
    }
    await ensureServerDatabaseInitialized();
    const result = await submitTerminalScan(
      {
        qrContent,
        lat: coordinate(body.lat),
        lng: coordinate(body.lng),
        kodeOperator: actor.kode_operator,
        sumberData: "Scanner",
      },
      { actorOperatorId: actor.id },
    );
    return noStoreJson(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
