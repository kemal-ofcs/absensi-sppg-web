import type { NextRequest } from "next/server";
import { listRoles } from "@/lib/rbac/role-admin";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { getServerDatabase } from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { isSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginMutation(request)) {
      return noStoreJson(
        { sukses: false, pesan: "Origin tidak diizinkan." },
        403,
      );
    }
    await requireWebPermission(request, "roles.manage", true);
    return noStoreJson({
      sukses: true,
      roles: await listRoles(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
