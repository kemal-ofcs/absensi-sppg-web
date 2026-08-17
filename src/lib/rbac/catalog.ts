export const PERMISSION_CATALOG = [
  { key: "home.view", name: "Lihat Home", group: "Utama" },
  { key: "scanner.use", name: "Gunakan QR Scanner", group: "Utama" },
  { key: "dashboard.view", name: "Lihat Dashboard", group: "Utama" },
  { key: "dashboard.export", name: "Export laporan", group: "Utama" },
  { key: "employees.view", name: "Lihat karyawan", group: "Manajemen" },
  { key: "employees.manage", name: "Kelola karyawan", group: "Manajemen" },
  { key: "shifts.view", name: "Lihat shift", group: "Manajemen" },
  { key: "shifts.manage", name: "Kelola shift", group: "Manajemen" },
  { key: "holidays.view", name: "Lihat hari libur", group: "Manajemen" },
  { key: "holidays.manage", name: "Kelola hari libur", group: "Manajemen" },
  {
    key: "corrections.view",
    name: "Lihat koreksi admin",
    group: "Operasional",
  },
  {
    key: "corrections.manage",
    name: "Kelola koreksi admin",
    group: "Operasional",
  },
  { key: "backups.view", name: "Lihat penugasan backup", group: "Operasional" },
  {
    key: "backups.manage",
    name: "Kelola penugasan backup",
    group: "Operasional",
  },
  {
    key: "alfa.trigger",
    name: "Jalankan Generate Alfa Manual",
    group: "Operasional",
  },
  {
    key: "attendance_audit.view",
    name: "Lihat audit absensi",
    group: "Operasional",
  },
  {
    key: "operational.edit",
    name: "Edit Data Operasional",
    group: "Operasional",
  },
  {
    key: "operational.delete",
    name: "Hapus Data Operasional",
    group: "Operasional",
  },
  {
    key: "history.edit",
    name: "Edit Riwayat Absensi",
    group: "Riwayat",
  },
  {
    key: "history.delete",
    name: "Hapus Riwayat Absensi",
    group: "Riwayat",
  },
  { key: "operators.view", name: "Lihat Master Operator", group: "Sistem" },
  { key: "operators.manage", name: "Kelola Master Operator", group: "Sistem" },
  { key: "roles.manage", name: "Kelola Role & Akses", group: "Sistem" },
  {
    key: "settings.manage",
    name: "Kelola Pengaturan Sistem & Auto Alfa",
    group: "Sistem",
  },
  {
    key: "branding.manage",
    name: "Kelola identitas aplikasi",
    group: "Sistem",
  },
  { key: "sync.view", name: "Lihat status sinkronisasi", group: "Sistem" },
  { key: "sync.retry", name: "Ulangi sinkronisasi", group: "Sistem" },
  { key: "diagnostics.view", name: "Lihat diagnostik", group: "Sistem" },
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

export const SUPERADMIN_ONLY_PERMISSIONS = new Set<PermissionKey>([
  "operators.view",
  "operators.manage",
  "roles.manage",
]);

export const SENSITIVE_MUTATION_PERMISSIONS = new Set<PermissionKey>([
  "history.edit",
  "history.delete",
  "operational.edit",
  "operational.delete",
]);

export const SYSTEM_ROLE_KEYS = [
  "superadmin",
  "admin",
  "operator",
  "scanner",
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<
  Exclude<SystemRoleKey, "superadmin">,
  readonly PermissionKey[]
> = {
  admin: PERMISSION_CATALOG.filter(
    ({ key }) =>
      !SUPERADMIN_ONLY_PERMISSIONS.has(key) &&
      key !== "diagnostics.view" &&
      !SENSITIVE_MUTATION_PERMISSIONS.has(key),
  ).map(({ key }) => key),
  operator: [
    "home.view",
    "scanner.use",
    "dashboard.view",
    "employees.view",
    "shifts.view",
    "sync.view",
  ],
  scanner: ["home.view", "scanner.use", "sync.view"],
};

export function normalizeRoleKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_CATALOG.some(({ key }) => key === value);
}
