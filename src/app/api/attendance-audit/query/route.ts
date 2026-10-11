import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { auditKualitasAbsensi } from "@/lib/services/attendance-audit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "attendance_audit.view");
    await ensureServerDatabaseInitialized();

    const body = await readJsonBody<{ tanggal?: unknown }>(request);
    const tanggal =
      typeof body.tanggal === "string" && body.tanggal.trim()
        ? body.tanggal.trim()
        : undefined;

    return noStoreJson({ audit: await auditKualitasAbsensi(tanggal) });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
