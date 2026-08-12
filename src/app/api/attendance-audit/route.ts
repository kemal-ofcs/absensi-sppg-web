import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import { jalankanAuditKualitasAbsensi } from "@/lib/services/alfa-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await requireWebPermission(request, "attendance_audit.view");
    await ensureServerDatabaseInitialized();
    const result = await jalankanAuditKualitasAbsensi();
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "system",
      entityKey: `alfa:${new Date().toISOString().slice(0, 10)}`,
      operation: "audit-alfa",
      payload: result.ringkasan,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ ...result, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
