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
  getIdCardTemplate,
  saveIdCardTemplate,
} from "@/lib/services/id-card-template";
import type { IdCardTemplateConfig } from "@/types/id-card";

export const runtime = "nodejs";

async function prepare(request: NextRequest) {
  assertSameOriginMutation(request);
  const actor = await requireWebPermission(request, "employees.manage", true);
  await ensureServerDatabaseInitialized();
  return actor;
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await requireWebPermission(request, "employees.manage", false);
    await ensureServerDatabaseInitialized();
    const body = (await readJsonBody(request).catch(() => ({}))) as {
      id?: string;
    };
    const data = await getIdCardTemplate(body.id || "default_template");
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
      20_971_520,
    )) as IdCardTemplateConfig;
    const data = await saveIdCardTemplate(body);
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "id-card-template",
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
