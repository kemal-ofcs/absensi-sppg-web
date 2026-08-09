import "server-only";

import type { NextRequest } from "next/server";
import { assertActorPermission } from "@/lib/auth/permission-assertion";
import { WEB_SESSION_COOKIE } from "@/lib/auth/web-session";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { readWebSession } from "@/lib/server/auth/session";

export async function requireWebPermission(
  request: NextRequest,
  permission: PermissionKey,
  superadminOnly = false,
) {
  const token = request.cookies.get(WEB_SESSION_COOKIE)?.value ?? "";
  const actor = await readWebSession(token);
  return assertActorPermission(actor, permission, superadminOnly);
}
