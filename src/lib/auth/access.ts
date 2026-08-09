import type { PermissionKey } from "@/lib/rbac/catalog";

export type AppArea =
  | "home"
  | "scanner"
  | "dashboard"
  | "karyawan"
  | "shift"
  | "settings"
  | "operators"
  | "diagnostics";

export interface AccessSubject {
  isSuperadmin: boolean;
  permissions: readonly PermissionKey[];
}

const AREA_PERMISSION: Record<AppArea, PermissionKey> = {
  home: "home.view",
  scanner: "scanner.use",
  dashboard: "dashboard.view",
  karyawan: "employees.view",
  shift: "shifts.view",
  settings: "branding.manage",
  operators: "operators.view",
  diagnostics: "diagnostics.view",
};

export function hasPermission(
  subject: AccessSubject | null | undefined,
  permission: PermissionKey,
) {
  if (!subject) return false;
  return subject.isSuperadmin || subject.permissions.includes(permission);
}

export function canAccessArea(
  subject: AccessSubject | null | undefined,
  area: AppArea,
) {
  return hasPermission(subject, AREA_PERMISSION[area]);
}
