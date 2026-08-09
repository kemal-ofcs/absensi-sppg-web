import "server-only";

import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { isSameOriginRequest } from "@/lib/auth/request-origin";

export function isSameOriginMutation(request: Request) {
  return isSameOriginRequest(request);
}

export function assertSameOriginMutation(request: Request) {
  if (!isSameOriginMutation(request)) {
    throw new AuthorizationError("Origin tidak diizinkan.", 403);
  }
}

export function acceptsJson(request: Request) {
  return request.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("application/json");
}

export function getClientAddress(request: Request) {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}
