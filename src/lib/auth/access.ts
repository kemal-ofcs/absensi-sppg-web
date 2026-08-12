import type { PermissionKey } from "@/lib/rbac/catalog";

export type AppArea =
  | "home"
  | "scanner"
  | "dashboard"
  | "history"
  | "karyawan"
  | "idcards"
  | "shift"
  | "operational"
  | "settings"
  | "operators"
  | "diagnostics";

export interface AccessSubject {
  isSuperadmin: boolean;
  permissions: readonly PermissionKey[];
}

const AREA_PERMISSION: Record<
  Exclude<AppArea, "operational">,
  PermissionKey
> = {
  home: "home.view",
  scanner: "scanner.use",
  dashboard: "dashboard.view",
  history: "dashboard.view",
  karyawan: "employees.view",
  idcards: "employees.manage",
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
  if (area === "operational") {
    return (
      hasPermission(subject, "corrections.view") ||
      hasPermission(subject, "backups.view")
    );
  }
  return hasPermission(subject, AREA_PERMISSION[area]);
}
