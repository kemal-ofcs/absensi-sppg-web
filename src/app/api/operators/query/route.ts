import type { NextRequest } from "next/server";
import { listOperators } from "@/lib/operators/operator-admin";
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
    await requireWebPermission(request, "operators.view", true);
    return noStoreJson({
      sukses: true,
      operators: await listOperators(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
