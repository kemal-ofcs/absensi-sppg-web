import { apiError } from "@/lib/api/response";
import {
  checkAnyPermission,
  checkPermission,
  hasRole,
  type Permission,
  type Role,
} from "@/lib/auth/rbac";

type SessionLike =
  | {
      user?: unknown;
    }
  | null
  | undefined;

export function requireRole(session: SessionLike, roles: Role[]) {
  if (!session?.user) {
    return apiError("Unauthorized", 401);
  }
  if (!hasRole(session, roles)) {
    return apiError("Forbidden", 403);
  }
  return null;
}

export function requirePermission(
  session: SessionLike,
  permission: Permission,
) {
  if (!session?.user) {
    return apiError("Unauthorized", 401);
  }
  if (!checkPermission(session, permission)) {
    return apiError("Forbidden", 403);
  }
  return null;
}

export function requireAnyPermission(
  session: SessionLike,
  permissions: Permission[],
) {
  if (!session?.user) {
    return apiError("Unauthorized", 401);
  }
  if (!checkAnyPermission(session, permissions)) {
    return apiError("Forbidden", 403);
  }
  return null;
}
