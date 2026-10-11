import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { ensureServerDatabaseInitialized } from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { getDaftarIdCard } from "@/lib/services/idcard";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "employees.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    await ensureServerDatabaseInitialized();
    return noStoreJson({
      data: await getDaftarIdCard({
        status: typeof body.status === "string" ? body.status : undefined,
        search: typeof body.search === "string" ? body.search : undefined,
      }),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
