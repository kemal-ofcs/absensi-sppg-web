import type { NextRequest } from "next/server";
import { apiError } from "@/lib/api/response";
import { auth } from "@/lib/auth/web/auth";
import {
  DESKTOP_LOOPBACK_ENV_TOKEN,
  DESKTOP_LOOPBACK_SESSION_COOKIE,
} from "@/lib/runtime/desktop-loopback-request";
import {
  DESKTOP_SYNC_REQUEST_HEADER,
  getDesktopSyncRejectionCode,
} from "@/lib/sync/security-policy";

function isEmbeddedDesktopRuntime() {
  return (
    process.env.HYBRID_STARTER_DESKTOP_RUNTIME === "embedded-local-web-server"
  );
}

function validateDesktopRequest(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const expectedToken = process.env[DESKTOP_LOOPBACK_ENV_TOKEN]?.trim() ?? "";
  const cookieToken =
    request.cookies.get(DESKTOP_LOOPBACK_SESSION_COOKIE)?.value.trim() ?? "";
  const code = getDesktopSyncRejectionCode({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    requestOrigin: requestUrl.origin,
    header: request.headers.get(DESKTOP_SYNC_REQUEST_HEADER),
    userAgent: request.headers.get("user-agent"),
    cookieToken,
    expectedToken,
  });
  if (!code) return null;

  const status = code === "SYNC_SESSION_INVALID" ? 401 : 403;
  return apiError(status === 401 ? "Unauthorized" : "Forbidden", status, code);
}

export async function authorizeSyncRequest(request: NextRequest) {
  if (isEmbeddedDesktopRuntime()) {
    const failure = validateDesktopRequest(request);
    return failure ?? { runtime: "desktop" as const };
  }

  const session = await auth();
  if (!session?.user) {
    return apiError("Unauthorized", 401, "UNAUTHORIZED");
  }
  return { runtime: "web" as const };
}
