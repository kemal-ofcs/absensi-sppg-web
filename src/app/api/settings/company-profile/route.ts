import type { NextRequest } from "next/server";
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
import { recordOperationalChange } from "@/lib/server/operational/change-log";
import {
  getCompanyProfile,
  updateCompanyProfile,
} from "@/lib/services/company-profile";
import type { CompanyProfileInput } from "@/types/company-profile";

export const runtime = "nodejs";

async function prepare(request: NextRequest) {
  assertSameOriginMutation(request);
  const actor = await requireWebPermission(request, "settings.manage", true);
  await ensureServerDatabaseInitialized();
  return actor;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "settings.manage", false);
    await ensureServerDatabaseInitialized();
    const data = await getCompanyProfile();
    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = (await readJsonBody(
      request,
      25_165_824,
    )) as CompanyProfileInput;
    const data = await updateCompanyProfile(body);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "company-profile",
      entityKey: data.id,
      operation: "update",
      payload: data as unknown as Record<string, unknown>,
      actorOperatorId: actor.id,
    });
    return noStoreJson({ data, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
