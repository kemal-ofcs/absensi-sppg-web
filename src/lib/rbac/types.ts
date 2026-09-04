import type { PermissionKey } from "@/lib/rbac/catalog";

export interface RoleRecord {
  id: number;
  roleKey: string;
  name: string;
  description: string;
  isSystem: boolean;
  isSuperadmin: boolean;
  status: "Aktif" | "Nonaktif";
  /** Operator dengan role ini wajib mengaktifkan verifikasi dua langkah. */
  requireTotp: boolean;
  /** Setiap scan absensi oleh role ini wajib menyertakan foto bukti. */
  requireScanPhoto: boolean;
  /** Role ini hanya boleh melakukan scan dari alamat IP yang terdaftar. */
  requireScanIpAllowlist: boolean;
  operatorCount: number;
  permissions: PermissionKey[];
}

export interface RoleDraft {
  name: string;
  description?: string;
  status?: "Aktif" | "Nonaktif";
  requireTotp?: boolean;
  requireScanPhoto?: boolean;
  requireScanIpAllowlist?: boolean;
}
