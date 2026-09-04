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
  getAppDisplayName,
  updateAppDisplayName,
} from "@/lib/services/app-setting";

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
    const data = await getAppDisplayName();
    return noStoreJson({ data });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const actor = await prepare(request);
    const body = (await readJsonBody(request)) as { appDisplayName?: string };
    const data = await updateAppDisplayName(body.appDisplayName ?? "");
    const revision = await recordOperationalChange(getServerDatabase(), {
      domain: "setting",
      entityKey: "app_display_name",
      operation: "update",
      payload: { key: "app_display_name", value: data },
      actorOperatorId: actor.id,
    });
    return noStoreJson({ data, revision });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
