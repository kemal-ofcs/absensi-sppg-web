import { AUTH_ROLES, type AuthRole } from "@/core/auth/roles";

export type Permission =
  | "users:read"
  | "users:write"
  | "sync:run"
  | "settings:manage";

export type Role = AuthRole;

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ["users:read", "users:write", "sync:run", "settings:manage"],
  admin: ["users:read", "users:write", "sync:run", "settings:manage"],
  manager: ["users:read", "sync:run"],
  staff: [],
  cashier: [],
  viewer: [],
};

export function getUserRole(user: unknown): Role | null {
  if (!user || typeof user !== "object") return null;
  const value = user as Record<string, unknown>;
  const nested =
    value.user && typeof value.user === "object"
      ? (value.user as Record<string, unknown>).role
      : undefined;
  const role = value.role ?? nested;
  return typeof role === "string" && AUTH_ROLES.includes(role as Role)
    ? (role as Role)
    : null;
}

export function hasPermission(role: Role, permission: Permission) {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function checkPermission(user: unknown, permission: Permission) {
  const role = getUserRole(user);
  return role ? hasPermission(role, permission) : false;
}

export function checkAnyPermission(user: unknown, permissions: Permission[]) {
  return permissions.some((permission) => checkPermission(user, permission));
}

export function hasRole(user: unknown, roles: Role[]) {
  const role = getUserRole(user);
  return role ? roles.includes(role) : false;
}
