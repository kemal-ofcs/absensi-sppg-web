import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import {
  getScannerSafetySettings,
  updateScannerSafetySettings,
} from "@/lib/services/scanner-settings";
import {
  type ScannerSafetySettings,
  validateScannerSafetySettings,
} from "@/lib/validations/scanner-settings";

export const runtime = "nodejs";

async function prepare(request: NextRequest) {
  assertSameOriginMutation(request);
  const actor = await requireWebPermission(request, "branding.manage", true);
  await ensureServerDatabaseInitialized();
  return actor;
}

function parseSettings(value: unknown): ScannerSafetySettings {
  const input = (value ?? {}) as Record<string, unknown>;
  const settings: ScannerSafetySettings = {
    antiDoubleScanSeconds: Number(input.antiDoubleScanSeconds ?? 60),
    batasMultiScanMenit: Number(input.batasMultiScanMenit ?? 5),
  };
  const message = Object.values(validateScannerSafetySettings(settings))[0];
  if (message) throw new ApiRequestError(message, 400);
  return settings;
}

export async function POST(request: NextRequest) {
  try {
    await prepare(request);
    return noStoreJson({ data: await getScannerSafetySettings() });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const settings = parseSettings(await readJsonBody(request));
    const data = await updateScannerSafetySettings(settings);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "setting",
      entityKey: "scanner_safety",
      operation: "update",
      payload: data,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ data, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
