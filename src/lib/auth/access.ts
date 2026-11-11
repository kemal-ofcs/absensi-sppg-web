import type { PermissionKey } from "@/lib/rbac/catalog";

export type AppArea =
  | "home"
  | "scanner"
  | "dashboard"
  | "history"
  | "karyawan"
  | "idcards"
  | "shift"
  | "holidays"
  | "operational"
  | "payroll"
  | "audit"
  | "settings"
  | "operators"
  | "password_reset"
  | "attendance_photo"
  | "face_template"
  | "inventaris"
  | "keuangan"
  | "kasbon"
  | "perjalanan"
  | "driver"
  | "hris"
  | "pengajuan"
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
  holidays: "holidays.view",
  payroll: "payroll.view",
  audit: "attendance_audit.view",
  settings: "branding.manage",
  operators: "operators.view",
  password_reset: "password_reset.view",
  attendance_photo: "attendance_photo.view",
  face_template: "face_template.view",
  inventaris: "inventory.view",
  keuangan: "accounting.view",
  kasbon: "loan.view",
  perjalanan: "trip.view",
  driver: "trip.report",
  // Tiap tab `/hris` memeriksa izinnya sendiri; backend memeriksa ulang.
  hris: "employees.view",
  pengajuan: "hr.request.view",
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
  // Pemegang `reimburse.decide` tanpa `hr.request.view` melihat klaim
  // Reimburse dan pembayarannya (§19.5); backend menyaring kelompoknya.
  // Penilai kinerja (`assess`/`view`) membuka tab Penilaian (§21.8).
  if (area === "pengajuan") {
    return (
      hasPermission(subject, "hr.request.view") ||
      hasPermission(subject, "reimburse.decide") ||
      hasPermission(subject, "hr.performance.assess") ||
      hasPermission(subject, "hr.performance.view")
    );
  }
  if (area === "operational") {
    return (
      hasPermission(subject, "corrections.view") ||
      hasPermission(subject, "backups.view")
    );
  }
  return hasPermission(subject, AREA_PERMISSION[area]);
}
